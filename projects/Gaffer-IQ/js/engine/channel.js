/**
 * js/engine/channel.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 * Builds Understat channel profiles (set-piece / box / transition threat and
 * vulnerability shares) and scores the channel counter-matchup between two
 * teams. See FEATURE_ENGINE.md §7.2 and the design spec
 * docs/superpowers/specs/2026-08-20-understat-channel-counters-design.md.
 *
 * All outputs: 0–100, higher = favourable for the team being scored.
 */

import {
  MIN_CHANNEL_SHOTS, CHANNEL_WEIGHTS, CHANNEL_AXIS_POOLED_SD, CHANNEL_SENSITIVITY,
  CHANNEL_ROLE_AXES, CHANNEL_PERSONNEL_MIN, CHANNEL_PERSONNEL_MAX,
} from '../config.js';
import { clamp } from '../util.js';
import { canonicalClubKey } from './normalise.js';
// Circular by design: counter.js imports calcChannelCounter from here. ES
// modules resolve this correctly because every binding involved is a hoisted
// `function` declaration, bound at call time rather than module-evaluation
// time. If any of them is ever converted to `const fn = () => …` the cycle
// breaks — keep them as `function` declarations.
import { buildRoleSignature, classifyRole } from './counter.js';

/**
 * Map FPL team id → Understat URL slug, derived from the league payload that
 * is already loaded rather than a hardcoded table.
 *
 * MODEL: matched by NAME via canonicalClubKey, never by Understat's numeric
 * team id — FPL reassigns ids every season as clubs are promoted and
 * relegated, which is exactly what silently broke the previous id-keyed
 * UNDERSTAT_TEAM_SLUGS table (see engine/style.js buildXgProfilesByTeamId).
 * The slug is Understat's own convention: the team title with spaces replaced
 * by underscores.
 *
 * @param {object|null} leagueXg   parsed Understat league/EPL payload
 * @param {Object<number,Team>} teamsById
 * @returns {Object<number,string>}  {} when no payload or no match.
 */
export function buildUnderstatSlugsByTeamId(leagueXg, teamsById) {
  if (!leagueXg || !leagueXg.teamsData) return {};

  const titleByKey = {};
  for (const t of Object.values(leagueXg.teamsData)) {
    if (t && t.title) titleByKey[canonicalClubKey(t.title)] = t.title;
  }

  const out = {};
  for (const team of Object.values(teamsById || {})) {
    for (const raw of [team.name, team.shortName]) {
      if (!raw) continue;
      const title = titleByKey[canonicalClubKey(raw)];
      if (title) {
        out[team.id] = title.replace(/ /g, '_');
        break;
      }
    }
  }
  return out;
}

// Every axis value is null rather than a neutral number when the inputs are
// absent. MODEL: a neutral-looking 0.5 is indistinguishable from a genuine
// mid-table reading, and the scoring below would multiply it into a
// confident-looking edge. hasChannelAxes is the single flag every consumer
// checks — same policy as NO_STYLE_AXES in engine/style.js.
const NO_CHANNEL_AXES = Object.freeze({
  hasChannelAxes: false,
  setPieceThreat: Object.freeze({ for: null, against: null }),
  wideTransition: Object.freeze({ for: null, against: null }),
  boxThreat:      Object.freeze({ for: null, against: null }),
  shots: 0,
});

/** Internal: read one side's xG from a statistics bucket. */
function bucketXg(bucket, side) {
  if (!bucket) return 0;
  const v = side === 'for' ? bucket.xG : bucket.against?.xG;
  return typeof v === 'number' ? v : (parseFloat(v) || 0);
}

/** Internal: sum one side's xG across several named buckets. */
function sumXg(group, keys, side) {
  let total = 0;
  for (const k of keys) total += bucketXg(group?.[k], side);
  return total;
}

/** Internal: share of `part` in `part + rest`, or null when the base is empty. */
function share(part, rest) {
  const base = part + rest;
  return base > 0 ? part / base : null;
}

/**
 * Build the three-axis channel profile for one team from its Understat
 * `statistics` block.
 *
 * MODEL: penalties are excluded from the set-piece denominator — a penalty is
 * a restart, not evidence about how a team plays in open field. Same reasoning
 * as the npxG choice in engine/style.js. Own goals are excluded from the shot
 * zone denominator for the same reason.
 *
 * MODEL: the shares are not perfectly quality-neutral. Across the 2025 league,
 * corr(boxShare_for, npxG_for) = +0.408 and corr(setPieceShare_for, npxG_for)
 * = −0.370 — better teams take more of their shots inside the box and rely
 * less on dead balls. At |r| ≤ 0.46 that is ~20% shared variance, far better
 * than raw totals but not zero, and CHANNEL_WEIGHTS leans away from the most
 * confounded axis accordingly.
 *
 * @param {object|null} statistics  the `statistics` block from a getTeamData
 *                                  payload (store.getTeamXg(slug).statistics)
 * @returns {{setPieceThreat: {for: number|null, against: number|null},
 *            wideTransition: {for: number|null, against: number|null},
 *            boxThreat: {for: number|null, against: number|null},
 *            shots: number, hasChannelAxes: boolean}}
 *          Axis values are 0–1 SHARES, not 0–100 scores. Direction is
 *          descriptive, not evaluative: a high setPieceThreat.for means a team
 *          leans on dead balls, which is neither good nor bad on its own.
 */
export function buildChannelProfile(statistics) {
  const sit = statistics?.situation;
  const sz  = statistics?.shotZone;
  const asp = statistics?.attackSpeed;
  if (!sit || !sz || !asp) return NO_CHANNEL_AXES;

  const DEAD = ['FromCorner', 'SetPiece', 'DirectFreekick'];
  const BOX  = ['shotSixYardBox', 'shotPenaltyArea'];

  // Sample-size guard reads SHOTS (a count), not xG (a sum of probabilities).
  let shots = 0;
  for (const k of ['OpenPlay', ...DEAD]) {
    const b = sit[k];
    if (b) shots += (typeof b.shots === 'number' ? b.shots : parseFloat(b.shots) || 0);
  }
  if (shots < MIN_CHANNEL_SHOTS) return { ...NO_CHANNEL_AXES, shots };

  const axis = (side) => ({
    setPiece: share(sumXg(sit, DEAD, side), bucketXg(sit.OpenPlay, side)),
    box:      share(sumXg(sz, BOX, side),   bucketXg(sz.shotOboxTotal, side)),
    fast:     share(bucketXg(asp.Fast, side),
                    ['Normal', 'Standard', 'Slow'].reduce((t, k) => t + bucketXg(asp[k], side), 0)),
  });

  const f = axis('for');
  const a = axis('against');

  return {
    hasChannelAxes: true,
    shots,
    setPieceThreat: { for: f.setPiece, against: a.setPiece },
    wideTransition: { for: f.fast,     against: a.fast },
    boxThreat:      { for: f.box,      against: a.box },
  };
}

/**
 * Build the FPL-team-id-keyed channel profile lookup. Pure helper consumed
 * once per ctx by buildScoreContext, same idiom as buildXgProfilesByTeamId in
 * engine/style.js, so the share arithmetic never repeats per fixture.
 *
 * MODEL: teams whose profile came back below MIN_CHANNEL_SHOTS are OMITTED
 * rather than included with null axes. Presence in this map is exactly the
 * condition calcChannelCounter tests for, so an unusable profile and an absent
 * one behave identically and there is only one degradation path to reason about.
 *
 * @param {Object<string,object>|null} teamXgBySlug   store.getAllTeamXg()
 * @param {Object<number,string>|null} slugsByTeamId  buildUnderstatSlugsByTeamId()
 * @returns {Object<number,object>}  FPL team id → channel profile. {} when empty.
 */
export function buildChannelProfilesByTeamId(teamXgBySlug, slugsByTeamId) {
  if (!teamXgBySlug || !slugsByTeamId) return {};

  const out = {};
  for (const [teamId, slug] of Object.entries(slugsByTeamId)) {
    const payload = teamXgBySlug[slug];
    if (!payload) continue;
    const profile = buildChannelProfile(payload.statistics);
    if (profile.hasChannelAxes) out[teamId] = profile;
  }
  return out;
}

/**
 * Channel counter-matchup: team A's threat profile against team B's
 * conceding profile, axis by axis.
 *
 * Asymmetric by design, exactly like calcCounterMatchup — A's attack against
 * B's defence is a different number from B's attack against A's defence.
 *
 * MODEL: the league baseline cancels out of the edge. Every team's xG-for in
 * an axis is another team's xG-against, so league-mean-for equals
 * league-mean-against to within 0.004 on all three axes (2025, n=20).
 * Subtracting the two shares therefore removes the baseline automatically —
 * which is what makes a two-teams-at-a-time fetch viable, since no league-wide
 * sweep is needed to centre the score.
 *
 * MODEL: each edge is z-scored by its OWN pooled SD before scaling. The axes
 * have very different natural spreads (set-piece share ranges 0.170–0.370
 * across the league, box share only 0.884–0.937), so a single shared
 * sensitivity would let the widest axis dominate purely by units.
 *
 * @param {Team} teamA
 * @param {Team} teamB
 * @param {object} ctx  must contain { channelProfilesByTeamId }
 * @returns {{value: number, estimated: boolean, pairings: Object,
 *            mode: 'channel'} | null}
 *          0–100, higher = better for teamA. null when either team has no
 *          usable profile — the caller falls through to the role tier.
 */
export function calcChannelCounter(teamA, teamB, ctx) {
  const profiles = ctx?.channelProfilesByTeamId;
  const a = profiles?.[teamA?.id];
  const b = profiles?.[teamB?.id];
  if (!a?.hasChannelAxes || !b?.hasChannelAxes) return null;

  // Roles for A only — the factor scales A's attacking share, and B's
  // conceding share needs no personnel read.
  const rolesA = {};
  for (const p of ctx.playersByTeamId?.[teamA.id] || []) {
    const role = classifyRole(p, ctx);
    if (role) rolesA[p.id] = role;
  }

  const pairings = {};
  let weightedSum = 0;
  let totalWeight = 0;

  for (const key of Object.keys(CHANNEL_WEIGHTS)) {
    const attackShare  = a[key]?.for;
    const concedeShare = b[key]?.against;
    // Guarded even though hasChannelAxes implies both are numbers — a future
    // axis added to CHANNEL_WEIGHTS but not to buildChannelProfile would
    // otherwise silently score NaN.
    if (typeof attackShare !== 'number' || typeof concedeShare !== 'number') continue;

    const personnel = channelPersonnelFactor(
      ctx.playersByTeamId?.[teamA.id] || [], rolesA, key, ctx,
    );
    // MODEL: the factor scales the ATTACKING share only. B's conceding profile
    // describes how B leaks, which this week's availability in A's squad
    // cannot change.
    const edge = (attackShare * personnel) - concedeShare;
    const value = clamp(0, 100, 50 + (edge / CHANNEL_AXIS_POOLED_SD[key]) * CHANNEL_SENSITIVITY);
    const weight = CHANNEL_WEIGHTS[key];

    pairings[key] = { value, weight, estimated: false, attackShare, concedeShare, personnel };
    weightedSum += value * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) return null;

  return {
    value: clamp(0, 100, weightedSum / totalWeight),
    estimated: false,
    pairings,
    mode: 'channel',
  };
}

/**
 * How much of an axis's usual chain contribution is actually available this
 * week, as a multiplier on that axis's attacking share.
 *
 * MODEL: self-normalising — availability-weighted chain over total chain for
 * the SAME unit. No league constant is needed, and a team whose whole unit is
 * fit scores exactly 1.0 regardless of how good that unit is, so the factor
 * corrects for availability without smuggling in a second quality term.
 *
 * @param {Player[]} players            the team's squad
 * @param {Object<number,string>} roles playerId → role, from classifyTeamRoles
 * @param {string} axisKey              a key of CHANNEL_ROLE_AXES
 * @param {object} ctx                  buildScoreContext result
 * @returns {number}  CHANNEL_PERSONNEL_MIN–MAX; exactly 1 when there is not
 *                    enough data to judge. Direction: higher = more of the
 *                    unit available.
 */
export function channelPersonnelFactor(players, roles, axisKey, ctx) {
  const wanted = CHANNEL_ROLE_AXES[axisKey];
  const lookup = ctx?.understatPlayersByName;
  if (!wanted || !lookup || !players) return 1;

  let availableChain = 0;
  let totalChain = 0;
  for (const p of players) {
    if (!wanted.includes(roles?.[p.id])) continue;
    const key = (p.fullName || '').toLowerCase().trim();
    const sig = key ? buildRoleSignature(lookup[key]) : null;
    if (!sig) continue;

    const minutes = p.totals?.minutes ?? 0;
    const seasonChain = sig.chain90 * (minutes / 90);
    totalChain += seasonChain;

    // chanceOfPlayingNext is null for most players — FPL populates it only
    // when there is news, so null means "no doubt reported" (FEATURE_ENGINE
    // §7.3), never "no data".
    const availability = (p.chanceOfPlayingNext ?? 100) / 100;
    availableChain += seasonChain * availability;
  }

  if (totalChain <= 0) return 1;
  return clamp(CHANNEL_PERSONNEL_MIN, CHANNEL_PERSONNEL_MAX, availableChain / totalChain);
}
