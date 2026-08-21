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

import { MIN_CHANNEL_SHOTS } from '../config.js';
import { canonicalClubKey } from './normalise.js';

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
