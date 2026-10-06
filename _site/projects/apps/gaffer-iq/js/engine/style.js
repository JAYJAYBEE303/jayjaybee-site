/**
 * js/engine/style.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 * Builds team style profiles and computes the style clash score between two teams.
 * See FEATURE_ENGINE.md §6.
 *
 * Phase 3A: when ctx.xgProfilesByTeamId is populated (Understat league xG is
 * loaded) the three axes — attackDirectness, defensiveHeight, tempo — come from
 * real per-game xG / xGA min-max normalised across all 20 PL teams. Without
 * Understat data the function falls back to the Phase 1 FPL-derivable proxies
 * (goals-for, clean-sheet rate, total goals per game), flagged estimated.
 *
 * Phase 3B: the clash itself no longer runs on those three axes. They measure
 * how GOOD a team is, and team quality is already priced into the composite
 * twice over (baseDifficulty 0.30, teamForm 0.16) — deriving a "style" verdict
 * from them mostly re-stated who the better side was. The clash now runs on
 * five quality-neutral axes built from Understat PPDA and deep completions
 * (pressIntensity, buildUpControl, territorialThreat, defensiveCompactness,
 * transitionDirectness), and its two sides are mirrored so a fixture's home and
 * away style scores total exactly 100. The xG axes stay on the profile for
 * display and for pre-3B callers.
 *
 * All outputs: 0–100, higher = favourable for the team being scored.
 */

import { STYLE_RULES, STYLE_ANCHORS, MIN_VENUE_GAMES } from '../config.js';
import { clamp, invert, normaliseLinear } from '../util.js';
import { canonicalClubKey } from './normalise.js';

// ─── §6.1  Style profile ─────────────────────────────────────────────────────

// Spread into any profile that has no PPDA/deep-completion inputs behind it.
// Explicit nulls, never 50: a neutral-looking number is indistinguishable from
// a genuine mid-table reading, and STYLE_RULES would happily multiply it into
// a confident-looking zero. hasStyleAxes is the single flag every consumer
// checks. See FEATURE_ENGINE.md §6.1.
const NO_STYLE_AXES = Object.freeze({
  hasStyleAxes:         false,
  pressIntensity:       null,
  buildUpControl:       null,
  territorialThreat:    null,
  defensiveCompactness: null,
  transitionDirectness: null,
});

/**
 * Build the league-wide xG-based style profile lookup from an Understat
 * league/EPL payload. Pure helper consumed by buildScoreContext so the
 * min-max normalisation runs once per ctx, not once per fixture.
 *
 * MODEL: using Understat xG — real underlying-numbers feed every axis. xGA is
 * inverted (higher xGA = leakier defence) so the defensiveHeight axis keeps
 * the "higher = better" convention universal across the engine (§1).
 *
 * @param {object} leagueXg          parsed Understat league/EPL JSON blocks
 * @param {object} teamsById         FPL team id → Team
 * @returns {Object<number,object>|null}  null when no team could be matched.
 */
export function buildXgProfilesByTeamId(leagueXg, teamsById) {
  if (!leagueXg || !leagueXg.teamsData) return null;

  const understatTeams = Object.values(leagueXg.teamsData);
  // Matched by NAME (canonicalClubKey, shared with buildPlTenure), never by
  // FPL's numeric team.id — ids are reassigned every season as clubs are
  // promoted/relegated (engine/normalise.js buildPlTenure's doc block), which
  // is exactly what silently broke the previous id-keyed UNDERSTAT_TEAM_SLUGS
  // table season over season. Index Understat's teams by canonical key once;
  // O(teams) not O(teams²).
  const understatByKey = {};
  for (const t of understatTeams) {
    if (t && t.title) understatByKey[canonicalClubKey(t.title)] = t;
  }
  const findUnderstatTeam = (team) => {
    for (const raw of [team.name, team.shortName]) {
      if (!raw) continue;
      const hit = understatByKey[canonicalClubKey(raw)];
      if (hit) return hit;
    }
    return null;
  };

  const rawByTeamId = {};
  for (const team of Object.values(teamsById)) {
    const up = findUnderstatTeam(team);
    if (!up || !Array.isArray(up.history) || up.history.length === 0) continue;

    let xgSum = 0;
    let xgaSum = 0;
    // Phase 3B style inputs. Accumulated separately from the xG-quality sums
    // above because they can be absent (older Understat seasons omit ppda /
    // deep) without invalidating the xG axes — see hasStyleInputs below.
    let npxgSum = 0;
    let deepSum = 0;
    let deepAllowedSum = 0;
    // PPDA is a RATIO of two counts. Aggregate the numerators and denominators
    // separately and divide once at the end — a mean of per-match ratios would
    // let a single low-possession match dominate the season figure.
    let ppdaAtt = 0, ppdaDef = 0;
    let ppdaAllowedAtt = 0, ppdaAllowedDef = 0;
    let styleRows = 0;

    for (const m of up.history) {
      xgSum  += parseFloat(m.xG)  || 0;
      xgaSum += parseFloat(m.xGA) || 0;
      // npxG (penalties stripped) drives the style axes: a penalty is a
      // restart, not evidence about how a team plays in open field.
      npxgSum += parseFloat(m.npxG) || 0;

      const ppda    = readPpdaPair(m.ppda);
      const allowed = readPpdaPair(m.ppda_allowed);
      const deep         = Number(m.deep);
      const deepAllowed  = Number(m.deep_allowed);
      if (ppda && allowed && Number.isFinite(deep) && Number.isFinite(deepAllowed)) {
        ppdaAtt        += ppda.att;
        ppdaDef        += ppda.def;
        ppdaAllowedAtt += allowed.att;
        ppdaAllowedDef += allowed.def;
        deepSum        += deep;
        deepAllowedSum += deepAllowed;
        styleRows      += 1;
      }
    }
    const games = up.history.length;

    // Every style axis needs all of ppda / ppda_allowed / deep / deep_allowed,
    // so they stand or fall together. Non-zero denominators are required too:
    // a team with zero recorded defensive actions would make PPDA infinite.
    const hasStyleInputs = styleRows > 0 && ppdaDef > 0 && ppdaAllowedDef > 0 && deepSum > 0;

    rawByTeamId[team.id] = {
      games,
      xgPerGame:    xgSum  / games,
      xgaPerGame:   xgaSum / games,
      tempoPerGame: (xgSum + xgaSum) / games,
      hasStyleInputs,
      // null (not 0) when unavailable — 0 is a legitimate reading for deep
      // completions and must not be confused with "no data". The min-max pass
      // below skips null teams entirely rather than dragging a floor down.
      ppda:                hasStyleInputs ? ppdaAtt / ppdaDef                : null,
      ppdaAllowed:         hasStyleInputs ? ppdaAllowedAtt / ppdaAllowedDef  : null,
      deepPerGame:         hasStyleInputs ? deepSum / styleRows              : null,
      deepAllowedPerGame:  hasStyleInputs ? deepAllowedSum / styleRows       : null,
      // Threat generated per final-third entry. High = gets dangerous without
      // needing sustained territory (transition/direct); low = needs many
      // entries to manufacture a chance (patient possession). Quality-neutral
      // by construction: it is a RATIO, so simply being good at football
      // raises numerator and denominator together.
      threatPerEntry:      hasStyleInputs ? (npxgSum / styleRows) / (deepSum / styleRows) : null,
      understatTitle: up.title,
    };
  }

  const raws = Object.values(rawByTeamId);
  if (raws.length === 0) return null;

  // Min-max across the 20 PL teams (or however many we matched) — FEATURE_ENGINE.md §1.
  let xgMin = raws[0].xgPerGame,    xgMax = raws[0].xgPerGame;
  let xgaMin = raws[0].xgaPerGame,  xgaMax = raws[0].xgaPerGame;
  let tMin = raws[0].tempoPerGame,  tMax = raws[0].tempoPerGame;
  for (const r of raws) {
    if (r.xgPerGame    < xgMin)  xgMin  = r.xgPerGame;
    if (r.xgPerGame    > xgMax)  xgMax  = r.xgPerGame;
    if (r.xgaPerGame   < xgaMin) xgaMin = r.xgaPerGame;
    if (r.xgaPerGame   > xgaMax) xgaMax = r.xgaPerGame;
    if (r.tempoPerGame < tMin)   tMin   = r.tempoPerGame;
    if (r.tempoPerGame > tMax)   tMax   = r.tempoPerGame;
  }

  // Style-axis ranges are taken over ONLY the teams that have style inputs, so
  // a partially-populated league doesn't skew the scale. When fewer than two
  // such teams exist there is no spread to normalise against and every style
  // axis is suppressed — normaliseLinear would return a flat 50 anyway, but
  // suppressing explicitly keeps `hasStyleAxes` honest rather than emitting
  // fifty-fifty numbers that look like real readings.
  const styleRaws = raws.filter(r => r.hasStyleInputs);
  const styleRanges = styleRaws.length >= 2
    ? {
        ppda:           minMaxOf(styleRaws, 'ppda'),
        ppdaAllowed:    minMaxOf(styleRaws, 'ppdaAllowed'),
        deep:           minMaxOf(styleRaws, 'deepPerGame'),
        deepAllowed:    minMaxOf(styleRaws, 'deepAllowedPerGame'),
        threatPerEntry: minMaxOf(styleRaws, 'threatPerEntry'),
      }
    : null;

  const profilesByTeamId = {};
  for (const [teamId, r] of Object.entries(rawByTeamId)) {
    const hasStyleAxes = Boolean(styleRanges) && r.hasStyleInputs;

    profilesByTeamId[teamId] = {
      // MODEL: using Understat xG — directness ≈ sustained scoring threat per game.
      attackDirectness: normaliseLinear(r.xgPerGame, xgMin, xgMax),
      // MODEL: using Understat xG — invert xGA so higher = stronger defensive resistance.
      defensiveHeight:  invert(normaliseLinear(r.xgaPerGame, xgaMin, xgaMax)),
      // MODEL: using Understat xG — combined xG involvement proxies match tempo.
      tempo:            normaliseLinear(r.tempoPerGame, tMin, tMax),

      // ─── Phase 3B style axes (STYLE_RULES consume only these) ───────────
      // Present as numbers only when hasStyleAxes; null otherwise so a caller
      // can never mistake a missing axis for a neutral one.
      hasStyleAxes,

      // MODEL: using Understat PPDA — passes the opponent completes per
      // defensive action we make. LOW ppda = we press hard, so invert to keep
      // the engine's universal higher-is-more convention (§1).
      pressIntensity: hasStyleAxes
        ? invert(normaliseLinear(r.ppda, styleRanges.ppda.min, styleRanges.ppda.max))
        : null,

      // MODEL: using Understat PPDA-allowed — passes WE complete per defensive
      // action the opponent makes. HIGH = opponents cannot disrupt our
      // build-up, i.e. we are press-resistant. Already higher-is-more.
      buildUpControl: hasStyleAxes
        ? normaliseLinear(r.ppdaAllowed, styleRanges.ppdaAllowed.min, styleRanges.ppdaAllowed.max)
        : null,

      // MODEL: using Understat deep completions — passes completed within ~20m
      // of the opponent goal. HIGH = we manufacture sustained territory rather
      // than living off transitions.
      territorialThreat: hasStyleAxes
        ? normaliseLinear(r.deepPerGame, styleRanges.deep.min, styleRanges.deep.max)
        : null,

      // MODEL: using Understat deep completions conceded — LOW = opponents
      // rarely get the ball into our danger zone at all, the signature of a
      // compact block. Inverted so higher = more compact.
      defensiveCompactness: hasStyleAxes
        ? invert(normaliseLinear(r.deepAllowedPerGame, styleRanges.deepAllowed.min, styleRanges.deepAllowed.max))
        : null,

      // MODEL: using npxG per deep completion — how much genuine threat each
      // final-third entry yields. HIGH = few entries, lots of danger, i.e. a
      // direct / transition side. LOW = needs sustained pressure to create.
      transitionDirectness: hasStyleAxes
        ? normaliseLinear(r.threatPerEntry, styleRanges.threatPerEntry.min, styleRanges.threatPerEntry.max)
        : null,

      games:            r.games,
      xgPerGame:        r.xgPerGame,
      xgaPerGame:       r.xgaPerGame,
      tempoPerGame:     r.tempoPerGame,
      // Raw style inputs surfaced for the matchup module's transparency
      // requirement (ARCHITECTURE.md §8) — null when unavailable.
      ppda:               r.ppda,
      ppdaAllowed:        r.ppdaAllowed,
      deepPerGame:        r.deepPerGame,
      deepAllowedPerGame: r.deepAllowedPerGame,
      threatPerEntry:     r.threatPerEntry,
      source:           'understat',
      understatTitle:   r.understatTitle,
    };
  }
  return profilesByTeamId;
}

/**
 * Read Understat's PPDA shape into {att, def}. Understat publishes it as an
 * object ({att, def}) on league/EPL, but the same field appears as a plain
 * pre-divided number on some season/endpoint variants — accept both rather
 * than silently zeroing an entire team's style profile on a shape change.
 *
 * @param {object|number|string} raw
 * @returns {{att: number, def: number}|null}  null when unusable.
 */
function readPpdaPair(raw) {
  if (raw && typeof raw === 'object') {
    const att = Number(raw.att);
    const def = Number(raw.def);
    if (!Number.isFinite(att) || !Number.isFinite(def) || def <= 0) return null;
    return { att, def };
  }
  // Pre-divided ratio: reconstruct as att/1 so the sum-then-divide aggregation
  // degrades to a plain mean of ratios rather than breaking outright.
  const ratio = Number(raw);
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  return { att: ratio, def: 1 };
}

/**
 * Min/max of one numeric field across the given raw profiles.
 * @param {object[]} rows
 * @param {string} key
 * @returns {{min: number, max: number}}
 */
function minMaxOf(rows, key) {
  let min = rows[0][key];
  let max = rows[0][key];
  for (const r of rows) {
    if (r[key] < min) min = r[key];
    if (r[key] > max) max = r[key];
  }
  return { min, max };
}

/**
 * Team style profile. Each axis is 0–100, higher = stronger on that dimension
 * for the team in question.
 *
 * QUALITY axes (xG-derived, retained for display and for callers that predate
 * Phase 3B — STYLE_RULES no longer consume these):
 *   attackDirectness — sustained scoring threat per game.
 *   defensiveHeight  — resistance to conceding chances (xGA inverted).
 *   tempo            — total xG / goals per game in the team's matches.
 *
 * STYLE axes (Phase 3B, PPDA/deep-completion derived — these are what a style
 * clash is actually computed from). Number when hasStyleAxes, else null:
 *   pressIntensity       — how high and hard the team presses (PPDA inverted).
 *   buildUpControl       — resistance to being pressed (PPDA-allowed).
 *   territorialThreat    — deep completions created per game.
 *   defensiveCompactness — deep completions conceded per game, inverted.
 *   transitionDirectness — npxG per deep completion: threat per entry.
 *
 * The split matters. The quality axes measure how GOOD a team is, which the
 * composite already prices in via baseDifficulty and teamForm; the style axes
 * measure how a team PLAYS, which nothing else in the engine captures. Only
 * the latter belongs in a clash calculation. See FEATURE_ENGINE.md §6.1.
 *
 * Data source: Understat when ctx.xgProfilesByTeamId is populated, otherwise
 * the Phase 1 FPL-derivable proxies — which carry no style axes at all
 * (hasStyleAxes: false), because goals and clean sheets say nothing about
 * pressing or territory.
 *
 * @param {Team} team
 * @param {object} ctx  { playedFixtures, xgProfilesByTeamId? }
 * @returns {{attackDirectness: number, defensiveHeight: number, tempo: number,
 *            hasStyleAxes: boolean, pressIntensity: number|null,
 *            buildUpControl: number|null, territorialThreat: number|null,
 *            defensiveCompactness: number|null, transitionDirectness: number|null,
 *            games: number, estimated: boolean, source: 'understat'|'fpl-proxy'}}
 */
export function calcStyleProfile(team, ctx) {
  const understatProfile = ctx.xgProfilesByTeamId?.[team.id];
  if (understatProfile) {
    // MODEL: using Understat xG — real underlying-numbers feed the three axes.
    // Estimated only when the team has too few matches to be reliable; the xG
    // numbers themselves are league-relative so the metric self-calibrates.
    return {
      ...understatProfile,
      estimated: understatProfile.games < MIN_VENUE_GAMES,
    };
  }

  // MODEL: using FPL proxy (no Understat data) — fall back to goals-for,
  // clean-sheet rate, and total-goals-per-game proxies as in Phase 1. Flagged
  // estimated so confidence drops everywhere this profile feeds the composite.
  const fixtures = (ctx.playedFixtures || []).filter(
    f => f.homeTeamId === team.id || f.awayTeamId === team.id,
  );

  if (fixtures.length === 0) {
    // MODEL: using FPL proxy (no Understat data) — no games either → neutral 50, flagged.
    return {
      attackDirectness: 50,
      defensiveHeight:  50,
      tempo:            50,
      ...NO_STYLE_AXES,
      games:            0,
      estimated:        true,
      source:           'fpl-proxy',
    };
  }

  let goalsFor = 0;
  let goalsAgainst = 0;
  let totalGoals = 0;
  let cleanSheets = 0;
  let counted = 0;
  for (const f of fixtures) {
    if (!f.result) continue;
    counted += 1;
    const isHome = f.homeTeamId === team.id;
    const gf = isHome ? f.result.homeGoals : f.result.awayGoals;
    const ga = isHome ? f.result.awayGoals : f.result.homeGoals;
    goalsFor     += gf;
    goalsAgainst += ga;
    totalGoals   += gf + ga;
    if (ga === 0) cleanSheets += 1;
  }

  if (counted === 0) {
    // MODEL: using FPL proxy (no Understat data) — no completed matches yet.
    return {
      attackDirectness: 50,
      defensiveHeight:  50,
      tempo:            50,
      ...NO_STYLE_AXES,
      games:            0,
      estimated:        true,
      source:           'fpl-proxy',
    };
  }

  const goalsPerGame      = goalsFor     / counted;
  const cleanSheetRate    = cleanSheets  / counted;
  const totalGoalsPerGame = totalGoals   / counted;

  const a = STYLE_ANCHORS;
  // MODEL: using FPL proxy (no Understat data) — anchors come from config STYLE_ANCHORS.
  return {
    attackDirectness: normaliseLinear(goalsPerGame,      a.attackDirectness.min, a.attackDirectness.max),
    defensiveHeight:  normaliseLinear(cleanSheetRate,    a.defensiveHeight.min,  a.defensiveHeight.max),
    tempo:            normaliseLinear(totalGoalsPerGame, a.tempo.min,            a.tempo.max),
    // No style axes on the proxy path: goals scored and clean sheets describe
    // outcomes, not method. Inferring a pressing profile from them would be
    // fabrication, so calcStyleClash returns a flagged neutral instead.
    ...NO_STYLE_AXES,
    games:            counted,
    // Thin sample still yields a profile, but flag it so confidence drops.
    // Proxy-derived profiles are always flagged at least until xG arrives.
    estimated:        true,
    source:           'fpl-proxy',
    // Surfaced for the matchup module's transparency requirement (ARCHITECTURE.md §8).
    goalsPerGame,
    cleanSheetRate,
    totalGoalsPerGame,
    goalsAgainst,
  };
}

// ─── §6.2  Style clash ────────────────────────────────────────────────────────

/**
 * Apply STYLE_RULES in one direction: how `profileA`'s way of playing fares
 * against `profileB`'s. Not exported — a one-directional delta is not a usable
 * score on its own (see calcStyleClash's mirroring step for why).
 *
 * MODEL: each rule is a SIGNED product of the two sides' deviations from the
 * neutral midpoint, so a style reads as an exposure rather than a switch. A
 * high press is worth something against a side that cannot play out and costs
 * something against a side that can, and both readings fall out of the same
 * term. The pre-Phase-3B version multiplied `Math.max(0, …)` of each deviation,
 * which discarded three of the four quadrants — including every case where one
 * team's strength is precisely the other team's weakness, which is the only
 * thing a style clash exists to find.
 *
 * @param {object} profileA  must have hasStyleAxes true
 * @param {object} profileB  must have hasStyleAxes true
 * @returns {{delta: number, terms: object[]}}
 *   delta: points to add to A's neutral 50, before mirroring.
 */
function applyStyleRules(profileA, profileB) {
  let delta = 0;
  const terms = [];

  for (const rule of STYLE_RULES) {
    // -1..+1 each: how far above (or below) the neutral midpoint each side
    // sits on the rule's relevant axis.
    const aDev = (profileA[rule.axisA] - 50) / 50;
    const bDev = (profileB[rule.axisB] - 50) / 50;
    const contribution = rule.sign * rule.magnitude * aDev * bDev;
    delta += contribution;
    terms.push({
      axisA: rule.axisA,
      axisB: rule.axisB,
      aDev,
      bDev,
      contribution,
    });
  }

  return { delta, terms };
}

/**
 * Style-clash score from team A's point of view, RELATIVE to team B — the two
 * sides of one fixture always total exactly 100.
 *
 * MODEL (mirroring): running the rules once, from A's side, gives an absolute
 * read that cannot be compared across a fixture. A's rules ask "does A's press
 * trouble B's build-up?"; B's rules ask a different question about different
 * axes, so the two independent reads do not complement each other — two
 * awkward-to-play-against sides both score well and the fixture looks good for
 * everyone. The fix is the engine's standing idiom, "derive, don't
 * independently compute" (§7.2 mirrored pairings, §8.7 relative composite):
 * compute BOTH directions and take the signed gap between them.
 *
 *   deltaOwn = rules applied A-against-B
 *   deltaOpp = rules applied B-against-A
 *   value    = clamp(0, 100, 50 + (deltaOwn − deltaOpp) / 2)
 *
 * Halving the gap is what puts the pair on a shared 100. calcStyleClash(B, A)
 * computes the identical pair in swapped order, so its value is always
 * 50 − (deltaOwn − deltaOpp) / 2, and `clamp(0,100,v) + clamp(0,100,100−v) ≡ 100`
 * for every real v — the totals hold exactly, including at the rails. Worked
 * example: raw reads of 50 and 80 become 35 and 65 — the 30-point gap between
 * the sides survives intact, it is only re-centred on 50.
 *
 * MODEL (neutral fallback): the score is forced to a flagged 50 unless BOTH
 * sides have real PPDA/deep-completion axes and enough matches behind them.
 * The FPL-proxy profile has no style axes at all, so on an Understat outage
 * every fixture returns a neutral 50 rather than a style verdict inferred from
 * goals — absence of information is not evidence (FEATURE_ENGINE.md §1 rule 3).
 * A flagged 50 also costs nothing in the composite: §8.6 skips estimated
 * metrics entirely and §8.3 drops confidence to match.
 *
 * @param {Team} teamA
 * @param {Team} teamB
 * @param {object} ctx
 * @returns {{value: number, estimated: boolean, profileA: object, profileB: object,
 *            clashDelta: number, opponentClashDelta: number, edge: number,
 *            terms: object[], opponentTerms: object[]}}
 *   value: 0–100, higher = favourable style clash for `teamA`; the same call
 *   with the teams swapped returns exactly 100 − this.
 *   See FEATURE_ENGINE.md §6.2.
 */
export function calcStyleClash(teamA, teamB, ctx) {
  const profileA = calcStyleProfile(teamA, ctx);
  const profileB = calcStyleProfile(teamB, ctx);

  const usable = profileA.hasStyleAxes && profileB.hasStyleAxes
    && !profileA.estimated && !profileB.estimated;

  if (!usable) {
    return {
      value:      50,
      estimated:  true,
      profileA,
      profileB,
      clashDelta:         0,
      opponentClashDelta: 0,
      edge:               0,
      terms:              [],
      opponentTerms:      [],
    };
  }

  const own = applyStyleRules(profileA, profileB);
  const opp = applyStyleRules(profileB, profileA);
  const edge = own.delta - opp.delta;

  return {
    value:     clamp(0, 100, 50 + edge / 2),
    estimated: false,
    profileA,
    profileB,
    clashDelta:         own.delta,
    opponentClashDelta: opp.delta,
    edge,
    terms:              own.terms,
    opponentTerms:      opp.terms,
  };
}
