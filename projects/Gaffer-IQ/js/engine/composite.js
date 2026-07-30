/**
 * js/engine/composite.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 * Combines every sub-metric into the composite matchup score (CompositeScore),
 * and aggregates across horizon windows (scoreOverHorizon) and per player
 * (scorePlayer). See FEATURE_ENGINE.md §8, §9, §10.
 * Output: 0–100, higher = better fixture/run/player form. Direction: higher = better.
 */

import {
  WEIGHTS, BANDS, CONFIDENCE_FLOOR, LEAGUE_AVG_STRENGTH,
  STACK_PIVOT, STACK_CURVE, STACK_MAX_PENALTY, RELATIVE_EDGE_SENSITIVITY,
  HORIZON_DECAY, AGG_METHOD, W_MEAN, W_MIN, BLANK_GW_VALUE,
  PROJ_FORM, PROJ_FIXTURE, PROJ_COUNTER, PROJ_MINUTES,
  RANK_ELITE_COUNT_BY_POS, RANK_STRONG_COUNT_BY_POS, RANK_BOTTOM_PERCENTILE,
  SEASON_GWS,
} from '../config.js';
import { clamp, invert } from '../util.js';
import {
  calcBaseDifficulty, calcHomeAwaySplit, calcFixtureHistory,
} from './fixtures.js';
import {
  calcTeamForm, calcPlayerForm, calcPlayingLikelihood, buildUnderstatPlayerLookup,
} from './form.js';
import { calcStyleClash, buildXgProfilesByTeamId } from './style.js';
import { calcCounterMatchup } from './counter.js';

/**
 * Build the assembly context every engine function consumes. Pure — derives
 * indices and aggregates from a Season plus an optional summary map, never
 * mutates either input.
 *
 * @param {Season} season   output of normaliseSeason
 * @param {object} [opts]
 * @param {object} [opts.playerSummariesById]  playerId → PlayerSummary (may be partial)
 * @param {object} [opts.leagueXg]             Understat league/EPL payload (Phase 3A); null when unavailable
 * @param {number} [opts.currentGw]            override; defaults to season.currentGw, then nextGw, then 1
 * @returns {object} ctx consumed by calcBase/HomeAway/Form/Style/Counter/FixtureHistory.
 *
 *   ctx shape:
 *     teamsById:           Object<teamId, Team>           (passthrough)
 *     playersByTeamId:     Object<teamId, Player[]>       (derived)
 *     fixtures:            Fixture[]                       (passthrough, sorted)
 *     playedFixtures:      Fixture[]                       (derived: f.played && f.result)
 *     playerSummariesById: Object<playerId, PlayerSummary> (passthrough, possibly {})
 *     leagueXg:            object | null                   (passthrough — Phase 3A)
 *     currentGw:           number
 *     leagueAvgStrength:   number  (mean of team.strength.overall across the league)
 */
export function buildScoreContext(season, opts = {}) {
  if (!season || !season.teamsById) {
    throw new TypeError('buildScoreContext: season (from normaliseSeason) is required');
  }

  const playedFixtures = (season.fixtures || []).filter(f => f.played && f.result);

  const playersByTeamId = {};
  for (const p of (season.players || [])) {
    (playersByTeamId[p.teamId] ||= []).push(p);
  }

  const overallStrengths = Object.values(season.teamsById)
    .map(t => t.strength?.overall ?? 0)
    .filter(v => v > 0);
  const leagueAvgStrength = overallStrengths.length
    ? overallStrengths.reduce((a, b) => a + b, 0) / overallStrengths.length
    : LEAGUE_AVG_STRENGTH;

  // Phase 3A: precompute the league-wide xG-based style profile lookup once
  // so calcStyleProfile doesn't repeat min-max normalisation per fixture. Pure
  // — returns null when Understat data is unavailable, in which case style.js
  // falls back to its Phase 1 proxies.
  const leagueXg = opts.leagueXg ?? null;
  const xgProfilesByTeamId = leagueXg
    ? buildXgProfilesByTeamId(leagueXg, season.teamsById)
    : null;
  // Phase 3A: build the Understat playersData lookup once per ctx so
  // calcPlayerForm gets an O(1) name match instead of an O(N) scan per player.
  const understatPlayersByName = leagueXg
    ? buildUnderstatPlayerLookup(leagueXg)
    : null;

  return {
    teamsById:           season.teamsById,
    playersByTeamId,
    fixtures:            season.fixtures || [],
    playedFixtures,
    playerSummariesById: opts.playerSummariesById || {},
    // Phase 3A — Understat league payload (null when fetch failed or not yet
    // loaded). style.js and form.js consult it for real xG inputs and fall
    // back to FPL-derived proxies when absent.
    leagueXg,
    xgProfilesByTeamId,
    understatPlayersByName,
    currentGw:           opts.currentGw ?? season.currentGw ?? season.nextGw ?? 1,
    leagueAvgStrength,
  };
}

/**
 * Map a 0–100 value onto its band string. Thresholds come from config (BANDS);
 * never inline a literal here — CSS modifier classes (.score-pill--great etc.)
 * key off this string, so the colour mapping stays single-sourced.
 */
function bandFromValue(value) {
  if (value >= BANDS.great)   return 'great';
  if (value >= BANDS.good)    return 'good';
  if (value >= BANDS.neutral) return 'neutral';
  if (value >= BANDS.tough)   return 'tough';
  return 'brutal';
}

// ─── §8.6  Stacking penalty ───────────────────────────────────────────────────

// The secondary metrics that can stack against a team. baseDifficulty is
// deliberately absent: it is the reading the resilience is measured RELATIVE TO,
// not one of the things that can pile up against it. Kept here rather than in
// config.js because it is structural (which metrics are secondary), not a
// tunable — same call as ROLE_ATTACK_GROUPS in counter.js.
const STACK_METRICS = ['counterMatchup', 'teamForm', 'homeAway', 'styleClash', 'history'];

/**
 * How much to deduct from a fixture's weighted composite because MULTIPLE
 * secondary metrics are simultaneously unfavourable.
 *
 * MODEL: the plain weighted sum degrades linearly — the first poor secondary
 * metric costs a favourite as much as the third does. Real fixtures don't work
 * that way: a side facing a weak opponent still has a good chance if only one
 * thing is against them, but genuinely loses it when a poor venue record, poor
 * form AND a losing counter-matchup arrive together. Each metric's shortfall
 * below STACK_PIVOT is weight-averaged into a 0–1 stackIndex, then raised to
 * STACK_CURVE, so one dip barely registers while three compound sharply.
 * Same shape as calcTenurePenalty (§2.1), deliberately — the engine keeps one
 * idiom for "punish genuine stacking, not incidental single dips".
 *
 * MODEL: estimated sub-metrics are excluded entirely and the remaining weights
 * re-normalised. FEATURE_ENGINE.md §1 rule 3 — absence of information is not
 * evidence of a bad fixture, so a data gap must never manufacture a penalty.
 * With STACK_PIVOT below 50, a metric sitting on its neutral-50 fallback also
 * contributes nothing even if it is somehow flagged non-estimated.
 *
 * @param {object} breakdown  scoreFixture's breakdown, pre-penalty
 * @returns {{penalty: number, stackIndex: number, countUnfavourable: number,
 *            consideredWeight: number}}
 *   penalty: 0–STACK_MAX_PENALTY, points to SUBTRACT from the composite.
 *   See FEATURE_ENGINE.md §8.6.
 */
function calcStackingPenalty(breakdown) {
  let shortfallWeighted = 0;
  let consideredWeight  = 0;
  let countUnfavourable = 0;

  for (const key of STACK_METRICS) {
    const m = breakdown[key];
    // A data gap is not evidence of badness — skip without counting its weight.
    if (!m || m.estimated) continue;
    consideredWeight += m.weight;
    if (m.value >= STACK_PIVOT) continue;
    countUnfavourable++;
    // Normalised severity: 0 at the pivot, 1 at a floored-zero metric.
    shortfallWeighted += m.weight * ((STACK_PIVOT - m.value) / STACK_PIVOT);
  }

  if (consideredWeight === 0) {
    return { penalty: 0, stackIndex: 0, countUnfavourable: 0, consideredWeight: 0 };
  }

  const stackIndex = clamp(0, 1, shortfallWeighted / consideredWeight);
  return {
    penalty: STACK_MAX_PENALTY * (stackIndex ** STACK_CURVE),
    stackIndex,
    countUnfavourable,
    consideredWeight,
  };
}

/**
 * Compute team's INDEPENDENT (pre-relative) fixture composite — every existing
 * sub-metric, weighted-summed with `WEIGHTS`, less the §8.6 stacking penalty.
 * This is exactly what `scoreFixture`'s `value` meant before §8.7: an absolute
 * 0–100 read of `team`'s own metrics against `opponent`, with NO comparison to
 * `opponent`'s own independent read. scoreFixture calls this once per side of
 * the same fixture and derives the final, relative value from the pair — see
 * scoreFixture's own doc block for why.
 *
 * Not exported: an absolute fixture read is not itself a useful public value
 * post-§8.7 (see the trace in FEATURE_ENGINE.md §8.7 for why two independent
 * absolute reads don't sum to 100) — only the derived relative value is.
 *
 * @param {Team} team       team whose perspective this reads from
 * @param {Team} opponent
 * @param {Fixture} fixture
 * @param {boolean} isHome  true if `team` is the home side
 * @param {object} ctx      output of buildScoreContext
 * @returns {{value: number, band: string, confidence: number, provisional: boolean,
 *            stacking: object, breakdown: object}}
 *   value: 0–100, higher = better for `team`, BEFORE the relative step.
 */
function computeRawFixtureScore(team, opponent, fixture, isHome, ctx) {
  const opponentId = opponent.id;

  // team's own FDR for this fixture — the fallback calcBaseDifficulty uses
  // when FPL's granular strength fields aren't published yet (see fixtures.js).
  const fdrForTeam = isHome ? fixture.fplDifficulty?.home : fixture.fplDifficulty?.away;
  const base    = calcBaseDifficulty(team, opponent, isHome, fdrForTeam);
  const venue   = calcHomeAwaySplit(team, isHome, ctx);
  const form    = calcTeamForm(team, ctx);
  const counter = calcCounterMatchup(team, opponent, ctx);
  const style   = calcStyleClash(team, opponent, ctx);
  const history = calcFixtureHistory(team.id, opponentId, ctx);

  // Weighted blend — every sub-metric is already 0–100, higher = better for `team`.
  // WEIGHTS sums to 1.00 (config.js / FEATURE_ENGINE.md §8.1), so no re-normalisation.
  //
  // baseDifficulty is the ONE exception to the higher-is-better rule: it is
  // stored as the opponent's strength (higher = harder) because the UI shows it
  // that way, so it is inverted here before weighting. Removing this invert()
  // would make facing Man City *raise* a team's score. See FEATURE_ENGINE.md §2.
  const linearValue =
      (WEIGHTS.baseDifficulty * invert(base.value))
    + (WEIGHTS.counterMatchup * counter.value)
    + (WEIGHTS.teamForm       * form.value)
    + (WEIGHTS.homeAway       * venue.value)
    + (WEIGHTS.styleClash     * style.value)
    + (WEIGHTS.history        * history.value);

  // §8.6 conditional term. Built from the same sub-metric shapes the breakdown
  // below reports, so it needs their { value, weight, estimated } triples — hence
  // the small intermediate object rather than reading the breakdown after the fact.
  const stack = calcStackingPenalty({
    counterMatchup: { value: counter.value, weight: WEIGHTS.counterMatchup, estimated: counter.estimated },
    teamForm:       { value: form.value,    weight: WEIGHTS.teamForm,       estimated: form.estimated },
    homeAway:       { value: venue.value,   weight: WEIGHTS.homeAway,       estimated: venue.estimated },
    styleClash:     { value: style.value,   weight: WEIGHTS.styleClash,     estimated: style.estimated },
    history:        { value: history.value, weight: WEIGHTS.history,        estimated: history.estimated },
  });

  const value = clamp(0, 100, linearValue - stack.penalty);

  // MODEL: confidence = weighted share of non-estimated sub-metrics. Estimated
  // metrics still contribute their (fallback) value to `value` so the weights
  // continue to sum to 1; they only lower confidence here. See §8.3.
  const confidence =
      (base.estimated    ? 0 : WEIGHTS.baseDifficulty)
    + (counter.estimated ? 0 : WEIGHTS.counterMatchup)
    + (form.estimated    ? 0 : WEIGHTS.teamForm)
    + (venue.estimated   ? 0 : WEIGHTS.homeAway)
    + (style.estimated   ? 0 : WEIGHTS.styleClash)
    + (history.estimated ? 0 : WEIGHTS.history);

  return {
    value,
    band:         bandFromValue(value),
    confidence,
    provisional:  confidence < CONFIDENCE_FLOOR,
    // §8.6 — the conditional adjustment, exposed so the UI can explain any gap
    // between the weighted sum and this raw value. Sits alongside `breakdown`
    // rather than inside it because it is an adjustment ACROSS sub-metrics, not
    // a sub-metric of its own (it has no weight in WEIGHTS).
    stacking: {
      linearValue,                                    // weighted sum before the penalty
      penalty:           stack.penalty,               // points deducted
      stackIndex:        stack.stackIndex,            // 0–1 severity-weighted share
      countUnfavourable: stack.countUnfavourable,     // how many secondaries below the pivot
      consideredWeight:  stack.consideredWeight,      // non-estimated secondary weight in play
      pivot:             STACK_PIVOT,
    },
    breakdown: {
      baseDifficulty: {
        // Reported as stored — the opponent's strength, higher = harder. The
        // composite above consumes invert(base.value); the UI wants this one.
        value:     base.value,
        weight:    WEIGHTS.baseDifficulty,
        estimated: base.estimated,
        strengthScore: base.strengthScore,   // before any tenure deduction
        tenurePenalty: base.tenurePenalty,   // points deducted for thin PL history
        tenureRatio:   base.tenureRatio,     // 0–1, opponent's recency-weighted tenure
        usedFdrFallback: base.usedFdrFallback, // true when FPL's own FDR substituted for unpublished strength data
      },
      counterMatchup: {
        value:     counter.value,
        weight:    WEIGHTS.counterMatchup,
        estimated: counter.estimated,
        pairings:  counter.pairings,
      },
      teamForm: {
        value:     form.value,
        weight:    WEIGHTS.teamForm,
        estimated: form.estimated,
        trend:     form.trend,
        games:     form.games,
      },
      homeAway: {
        value:        venue.value,
        weight:       WEIGHTS.homeAway,
        estimated:    venue.estimated,
        gamesAtVenue: venue.gamesAtVenue,
      },
      styleClash: {
        value:      style.value,
        weight:     WEIGHTS.styleClash,
        estimated:  style.estimated,
        profileA:   style.profileA,
        profileB:   style.profileB,
        clashDelta: style.clashDelta,
      },
      history: {
        value:      history.value,
        weight:     WEIGHTS.history,
        estimated:  history.estimated,
        meetings:   history.meetings,
        pointsForA: history.pointsForA,
      },
    },
  };
}

/**
 * Score a single fixture from ONE team's perspective — RELATIVE to the same
 * fixture's other team, so the two teams' totals are guaranteed to sum to
 * exactly 100 (§8.7).
 *
 * MODEL (§8.7): every sub-metric above is computed independently per team
 * against a fixed scale, so two independent computeRawFixtureScore reads for
 * the same fixture do NOT sum to 100 in general (two strong teams both read as
 * "facing a tough opponent" and both get punished for it; two weak teams both
 * read as "facing a soft opponent" and both get rewarded). This function fixes
 * that by computing BOTH sides' raw reads and deriving the final value from
 * their signed difference — "derive, don't independently compute", the same
 * principle §7.2's mirrored counter pairings already use:
 *
 *   edge  = rawOwn − rawOpponent
 *   value = clamp(0, 100, 50 + edge * RELATIVE_EDGE_SENSITIVITY)
 *
 * scoreFixture(opponent, fixture, ctx) computes the identical (rawOwn,
 * rawOpponent) pair in swapped order, so its value is ALWAYS
 * clamp(0, 100, 50 − edge * RELATIVE_EDGE_SENSITIVITY) — literally 100 minus
 * this value before clamping. `clamp(0,100,v) + clamp(0,100,100−v) ≡ 100` for
 * every real `v` (trivial by cases on the three clamp regions), so the two
 * teams' totals sum to exactly 100 BY CONSTRUCTION, not by coincidence —
 * verified for the full input range in FEATURE_ENGINE.md §8.7.
 *
 * This does NOT flatten every fixture toward 50/50: a genuine strength gap
 * (e.g. a promoted side's low, tenure-uninflated baseDifficulty reading against
 * an established side's high one) still produces a large edge and therefore a
 * lopsided split — it just now sums to 100 rather than landing wherever two
 * unrelated absolute reads happen to fall. See the worked examples in
 * FEATURE_ENGINE.md §8.7.
 *
 * Asymmetric perspective, symmetric total: scoreFixture(home, fixture, ctx) and
 * scoreFixture(away, fixture, ctx) still read differently per side (venue, form,
 * counter-matchup are each team's own) — only their TOTALS are now complementary.
 *
 * @param {Team} team       team whose perspective we score from
 * @param {Fixture} fixture
 * @param {object} ctx      output of buildScoreContext
 * @returns {CompositeScore}
 *   value: 0–100, higher = easier/better fixture for `team`. Direction: higher = better.
 *   band: 'great' | 'good' | 'neutral' | 'tough' | 'brutal' (see BANDS in config).
 *   confidence: 0–1; the WEAKER (min) of the two sides' own confidence — the
 *     final value depends on both raw reads, so it can only be as trustworthy
 *     as the less-certain of the two.
 *   provisional: true when confidence < CONFIDENCE_FLOOR — UI hatches/greys the score.
 *   breakdown: `team`'s own per sub-metric { value, weight, estimated, ...extras }
 *     — unchanged in meaning; still explains `team`'s own raw read.
 *   relative: the new §8.7 adjustment — { ownRawValue, opponentRawValue, edge,
 *     sensitivity } — explains how the final value was derived from the pair.
 *   See ARCHITECTURE.md §8 and FEATURE_ENGINE.md §8, §8.7 for the contract.
 */
export function scoreFixture(team, fixture, ctx) {
  if (!team || !fixture) {
    throw new TypeError('scoreFixture: both team and fixture are required');
  }
  if (!ctx || !ctx.teamsById) {
    throw new TypeError('scoreFixture: ctx (from buildScoreContext) is required');
  }
  const isHome = fixture.homeTeamId === team.id;
  const isAway = fixture.awayTeamId === team.id;
  if (!isHome && !isAway) {
    throw new TypeError(
      `scoreFixture: team ${team.id} is not in fixture ${fixture.id} ` +
      `(home=${fixture.homeTeamId}, away=${fixture.awayTeamId})`,
    );
  }
  const opponentId = isHome ? fixture.awayTeamId : fixture.homeTeamId;
  const opponent = ctx.teamsById[opponentId];
  if (!opponent) {
    throw new TypeError(`scoreFixture: opponent team ${opponentId} missing from ctx`);
  }

  const own = computeRawFixtureScore(team, opponent, fixture, isHome, ctx);
  const opp = computeRawFixtureScore(opponent, team, fixture, !isHome, ctx);

  const edge  = own.value - opp.value;
  const value = clamp(0, 100, 50 + (edge * RELATIVE_EDGE_SENSITIVITY));

  // MODEL: min(), not own.confidence alone — the final value is a function of
  // BOTH raw reads, so if either side rests on heavily estimated data the
  // relative result is only as trustworthy as the weaker of the two.
  const confidence = Math.min(own.confidence, opp.confidence);

  return {
    value,
    band:         bandFromValue(value),
    confidence,
    provisional:  confidence < CONFIDENCE_FLOOR,
    stacking:     own.stacking,
    breakdown:    own.breakdown,
    // §8.7 — explains the relative step itself, alongside (not inside)
    // `breakdown`, since it's an adjustment ACROSS the two teams' totals,
    // not a sub-metric of `team`'s own.
    relative: {
      ownRawValue:      own.value,       // team's pre-relative composite (old 'value')
      opponentRawValue: opp.value,       // opponent's own pre-relative composite
      edge,                              // signed difference driving the split
      sensitivity:      RELATIVE_EDGE_SENSITIVITY,
    },
  };
}

// ─── §9  Horizon aggregation ──────────────────────────────────────────────────

/**
 * Internal: collect fixtures for `team` whose GW falls in `gwSet`.
 * Returns Map<gw, Fixture[]>. Double GWs produce two entries under the same key.
 */
function fixturesForTeamInWindow(team, gwSet, ctx) {
  const byGw = new Map();
  for (const f of ctx.fixtures) {
    if (f.gw === null) continue;
    if (!gwSet.has(f.gw)) continue;
    if (f.homeTeamId !== team.id && f.awayTeamId !== team.id) continue;
    const list = byGw.get(f.gw) ?? [];
    list.push(f);
    byGw.set(f.gw, list);
  }
  return byGw;
}

/**
 * Internal: position-specific counter-matchup edge for a player, aggregated
 * over the horizon window with the same GW-distance decay as scoreOverHorizon.
 * Blank GWs contribute BLANK_GW_VALUE so the weighting stays consistent.
 *
 *  FWD     → fwdVsCb pairing (striker vs centre-backs)
 *  MID     → mean(wideMidVsFb, camVsCbMid)
 *  DEF/GKP → 100 − opponent's counter score (how well this defence resists)
 *
 * See FEATURE_ENGINE.md §10 (playerCounterEdge).
 */
function calcPlayerCounterEdge(player, gwWindow, teamFixturesByGw, ctx) {
  const team = ctx.teamsById[player.teamId];
  if (!team) return { value: 50, estimated: true };

  let wSum   = 0;
  let wTotal = 0;
  let anyEstimated = false;

  for (let i = 0; i < gwWindow.length; i++) {
    const gw       = gwWindow[i];
    const w        = Math.pow(HORIZON_DECAY, i);
    const fixtures = teamFixturesByGw.get(gw) ?? [];

    if (fixtures.length === 0) {
      // MODEL: blank GW counts the same penalty as in scoreOverHorizon.
      wSum   += BLANK_GW_VALUE * w;
      wTotal += w;
      continue;
    }

    for (const f of fixtures) {
      const isHome   = f.homeTeamId === team.id;
      const oppId    = isHome ? f.awayTeamId : f.homeTeamId;
      const opponent = ctx.teamsById[oppId];
      if (!opponent) { wSum += 50 * w; wTotal += w; continue; }

      let edgeValue;
      let estimated = false;

      if (player.position === 'FWD') {
        const cm  = calcCounterMatchup(team, opponent, ctx);
        edgeValue = cm.pairings.fwdVsCb?.value ?? 50;
        estimated = cm.pairings.fwdVsCb?.estimated ?? true;
      } else if (player.position === 'MID') {
        const cm  = calcCounterMatchup(team, opponent, ctx);
        const wm  = cm.pairings.wideMidVsFb?.value ?? 50;
        const cam = cm.pairings.camVsCbMid?.value  ?? 50;
        edgeValue = (wm + cam) / 2;
        estimated = (cm.pairings.wideMidVsFb?.estimated ?? true)
                 || (cm.pairings.camVsCbMid?.estimated  ?? true);
      } else {
        // DEF/GKP: invert opponent's attack score — higher = their attack is weak vs this defence.
        // MODEL: a defender's counter edge is determined by how poorly the opponent attacks.
        const oppCm = calcCounterMatchup(opponent, team, ctx);
        edgeValue   = 100 - oppCm.value;
        estimated   = oppCm.estimated;
      }

      if (estimated) anyEstimated = true;
      wSum   += edgeValue * w;
      wTotal += w;
    }
  }

  return {
    value:     wTotal === 0 ? 50 : clamp(0, 100, wSum / wTotal),
    estimated: anyEstimated || wTotal === 0,
  };
}

/**
 * Aggregate a team's composite scores across a horizon window.
 * Handles blank GWs (no fixture → BLANK_GW_VALUE, never silently skipped) and
 * double GWs (both fixtures scored and included, naturally boosting the score).
 * Applies HORIZON_DECAY weighting and AGG_METHOD blending from config.
 *
 * Pure: no DOM, no fetch, no store mutation — all inputs are parameters.
 *
 * @param {Team}   team
 * @param {{label: string, gws: number}} horizon  e.g. HORIZONS.GW3
 * @param {object} ctx   output of buildScoreContext
 * @returns {object}  CompositeScore shape + perGw strip
 *   value: 0–100, higher = better fixture run for `team`. Direction: higher = better.
 *   perGw: [{gw, value, band, opponent, venue, isBlank}] one entry per scored slot;
 *     DGWs produce two entries for the same gw, blanks one with isBlank: true.
 *   See FEATURE_ENGINE.md §9.
 */
export function scoreOverHorizon(team, horizon, ctx) {
  if (!team || !horizon || !ctx || !ctx.teamsById) {
    throw new TypeError('scoreOverHorizon: team, horizon, and ctx are required');
  }

  const numGws   = horizon.gws;
  const startGw  = ctx.currentGw;
  const gwWindow = Array.from({ length: numGws }, (_, i) => startGw + i);
  const gwSet    = new Set(gwWindow);

  const teamFixturesByGw = fixturesForTeamInWindow(team, gwSet, ctx);

  const entries = [];  // { gwOffset, value, fixtureScore | null }
  const perGw   = [];  // public per-GW strip array

  for (let i = 0; i < gwWindow.length; i++) {
    const gw       = gwWindow[i];
    const gwOffset = i;  // 0 = nearest, matches HORIZON_DECAY exponent
    const fixtures = teamFixturesByGw.get(gw) ?? [];

    if (fixtures.length === 0) {
      // MODEL: blank GW — BLANK_GW_VALUE (40) reflects zero return for assets;
      // mildly bad rather than neutral, never silently skipped. FEATURE_ENGINE.md §9.
      entries.push({ gwOffset, value: BLANK_GW_VALUE, fixtureScore: null });
      perGw.push({
        gw, value: BLANK_GW_VALUE, band: bandFromValue(BLANK_GW_VALUE),
        opponent: null, venue: null, isBlank: true,
      });
    } else {
      for (const f of fixtures) {
        const score  = scoreFixture(team, f, ctx);
        const isHome = f.homeTeamId === team.id;
        const oppId  = isHome ? f.awayTeamId : f.homeTeamId;
        const opp    = ctx.teamsById[oppId];
        entries.push({ gwOffset, value: score.value, fixtureScore: score });
        perGw.push({
          gw,
          value:       score.value,
          band:        score.band,
          opponent:    opp?.shortName ?? null,
          venue:       isHome ? 'H' : 'A',
          isBlank:     false,
          provisional: score.provisional,
        });
      }
    }
  }

  if (entries.length === 0) {
    return {
      value: 50, band: bandFromValue(50), confidence: 1, provisional: false, perGw: [],
      breakdown: { aggregateMean: 50, aggregateMin: 50, aggMethod: AGG_METHOD, numGws, numBlanks: 0 },
    };
  }

  // Weighted mean with GW-distance decay; nearer GWs have more weight.
  let wSum   = 0;
  let wTotal = 0;
  let minVal = 100;

  for (const e of entries) {
    const w = Math.pow(HORIZON_DECAY, e.gwOffset);
    wSum   += e.value * w;
    wTotal += w;
    if (e.value < minVal) minVal = e.value;
  }

  const aggregateMean = wTotal === 0 ? 50 : wSum / wTotal;
  const aggregateMin  = minVal;

  let rawValue;
  if (AGG_METHOD === 'mean') {
    rawValue = aggregateMean;
  } else if (AGG_METHOD === 'min') {
    rawValue = aggregateMin;
  } else {
    // 'blend' (default): rewards a good run but punishes a single brutal fixture.
    // W_MIN * aggregateMin surfaces fixture traps hiding in a green sequence.
    rawValue = (W_MEAN * aggregateMean) + (W_MIN * aggregateMin);
  }

  const value = clamp(0, 100, rawValue);

  const scoredEntries = entries.filter(e => e.fixtureScore !== null);
  const avgConfidence = scoredEntries.length === 0 ? 0.5
    : scoredEntries.reduce((s, e) => s + (e.fixtureScore.confidence ?? 0), 0) / scoredEntries.length;
  const numBlanks = entries.length - scoredEntries.length;

  return {
    value,
    band:        bandFromValue(value),
    confidence:  avgConfidence,
    provisional: avgConfidence < CONFIDENCE_FLOOR,
    perGw,
    breakdown: {
      aggregateMean,
      aggregateMin,
      aggMethod:  AGG_METHOD,
      numGws,
      numBlanks,
    },
  };
}

// ─── §10  Player projection ───────────────────────────────────────────────────

/**
 * Average FPL points per gameweek THIS season. Prefers real per-GW history
 * (already lazily loaded via a player-summary fetch — never bulk-fetched, see
 * ARCHITECTURE.md §3 rule 7): FPL's history payload has one entry per elapsed
 * gameweek regardless of whether the player featured (0 minutes/0 points for
 * a blank week), so totalPoints / history.length is already a true weekly
 * average. Falls back to season totals ÷ elapsed gameweeks when no summary
 * is loaded, flagged estimated. Pre-season (`elapsedGws <= 0`), this is
 * genuinely 0 for every player — real, not a bug. See `calcLastSeasonAvgPointsPerGw`
 * for the explicit, user-toggled "show last season instead" view (Ranker
 * only) rather than any automatic substitution here.
 *
 * MODEL: the fallback divides by gameweeks ELAPSED THIS SEASON
 * (ctx.playedFixtures, deduplicated by gw), not by games the player actually
 * appeared in. A player who scored 10 points in GW1 and then missed GW2-4
 * averages 10/4 = 2.5, not 10/1 = 10 — a non-playing week counts as a
 * (correctly zero-contributing) week, exactly like the real per-GW-history
 * branch above already does. Dividing by games played instead would make
 * fringe/rotation players who had one big week look like elite performers.
 *
 * Pure: depends only on `player` and ctx (playerSummariesById, playedFixtures
 * — both already part of every ctx built by buildScoreContext) — no new
 * network access.
 *
 * @param {Player} player
 * @param {object} ctx
 * @returns {{value: number, estimated: boolean}}
 *   value: average points per GW. estimated: true when derived from season
 *   totals rather than real per-GW history.
 */
export function calcAvgPointsPerGw(player, ctx) {
  const summary = ctx.playerSummariesById?.[player.id];
  const history  = summary?.history;
  if (history && history.length > 0) {
    const totalPoints = history.reduce((s, g) => s + (g.points || 0), 0);
    return { value: totalPoints / history.length, estimated: false };
  }

  const points      = player.totals?.points ?? 0;
  const elapsedGws  = new Set((ctx.playedFixtures || []).map(f => f.gw)).size;
  if (elapsedGws <= 0) return { value: 0, estimated: true };
  return { value: points / elapsedGws, estimated: true };
}

/**
 * Average points per GW from the player's most recent PAST season (not this
 * season). Powers the Ranker's explicit "Last Season" Avg Pts/GW toggle
 * (FEATURE_ENGINE.md §10.1) — a deliberate, user-triggered alternative VIEW,
 * not an automatic fallback baked into `calcAvgPointsPerGw` above. Kept as a
 * fully separate function so the ordinary current-season metric never
 * silently substitutes anything: callers choose explicitly which one to show.
 *
 * MODEL: divides by the fixed SEASON_GWS (config.js, 38), not by games that
 * player actually appeared in that past season — same reasoning as the
 * current-season fallback above (a fringe player's one good stretch
 * shouldn't read as elite sustained output).
 *
 * Sourced from `historyPast` (`normalisePlayerSummary` — the SAME lazily-
 * loaded `element-summary` fetch that already provides current-season
 * `history[]`; no new endpoint, no new fetch shape). Returns `null` when this
 * player's summary hasn't been loaded yet (caller should render a loading
 * state, not a definitive dash) or when it's loaded but genuinely carries no
 * past seasons (caller should then render a definitive "no data" dash).
 *
 * Pure: depends only on `player.id` and `ctx.playerSummariesById` — no
 * network access itself; the Ranker is responsible for triggering the lazy
 * load beforehand (see `ensurePlayerSummary` / the chunked bulk loader).
 *
 * @param {Player} player
 * @param {object} ctx
 * @returns {{value: number, seasonName: string}|null}
 *   null: summary not loaded yet, OR loaded with no past-season history.
 *   Callers distinguish the two by checking whether the summary itself
 *   exists (`ctx.playerSummariesById[player.id]`).
 */
export function calcLastSeasonAvgPointsPerGw(player, ctx) {
  const summary = ctx.playerSummariesById?.[player.id];
  const historyPast = summary?.historyPast;
  if (!historyPast || historyPast.length === 0) return null;

  const lastSeason = historyPast.reduce(
    (latest, s) => (!latest || s.seasonName > latest.seasonName) ? s : latest,
    null,
  );
  if (!lastSeason) return null;

  return {
    value:      lastSeason.points / SEASON_GWS,
    seasonName: lastSeason.seasonName,
  };
}

/**
 * Player projection over a horizon: blends player form, team fixture quality,
 * and position-specific counter-matchup edge. See FEATURE_ENGINE.md §10.
 *
 * @param {Player}  player
 * @param {{label: string, gws: number}} horizon
 * @param {object}  ctx   output of buildScoreContext
 * @returns {{ value: number, band: string, perGw: Array, breakdown: object,
 *             valueScore: number, avgPointsPerGw: {value:number, estimated:boolean},
 *             costPerPoint: number|null, nextFixtureScore: {value:number, estimated:boolean} }}
 *   value: 0–100, higher = better projected value. Direction: higher = better.
 *   valueScore: value / price — points-per-million proxy for budget-aware ranking.
 *   costPerPoint: price / avgPointsPerGw — money spent per point, the INVERSE
 *   ratio direction from valueScore. Never merge these: valueScore answers
 *   "how much projected score do I get per pound", costPerPoint answers "how
 *   much does each point actually cost". null when avgPointsPerGw is 0 (never
 *   NaN/Infinity — a player with no scoring record has no meaningful cost).
 *   nextFixtureScore: 0–100 blend of just fixture + counter (excludes form),
 *   answering "how favourable is this player's next fixture", derived from the
 *   SAME horizonResult/counterEdge already computed below — not a new metric.
 *   See FEATURE_ENGINE.md §10.
 */
export function scorePlayer(player, horizon, ctx) {
  if (!player || !horizon || !ctx) {
    throw new TypeError('scorePlayer: player, horizon, and ctx are required');
  }

  const team = ctx.teamsById[player.teamId];
  if (!team) {
    const avgPointsPerGw = calcAvgPointsPerGw(player, ctx);
    return {
      value: 50, band: bandFromValue(50), perGw: [],
      breakdown: {
        form:    { value: 50, weight: PROJ_FORM,    estimated: true },
        fixture: { value: 50, weight: PROJ_FIXTURE, estimated: true },
        counter: { value: 50, weight: PROJ_COUNTER, estimated: true },
        minutes: { value: 50, weight: PROJ_MINUTES, estimated: true },
      },
      valueScore: player.price > 0 ? 50 / player.price : 0,
      avgPointsPerGw,
      costPerPoint: (player.price > 0 && avgPointsPerGw.value > 0)
        ? player.price / avgPointsPerGw.value : null,
      nextFixtureScore: { value: 50, estimated: true },
    };
  }

  const formResult    = calcPlayerForm(player, ctx);
  const horizonResult = scoreOverHorizon(team, horizon, ctx);

  // Re-derive the same window used by scoreOverHorizon so the counter edge is consistent.
  const numGws   = horizon.gws;
  const startGw  = ctx.currentGw;
  const gwWindow = Array.from({ length: numGws }, (_, i) => startGw + i);
  const gwSet    = new Set(gwWindow);
  const teamFixturesByGw = fixturesForTeamInWindow(team, gwSet, ctx);

  const counterEdge    = calcPlayerCounterEdge(player, gwWindow, teamFixturesByGw, ctx);
  const avgPointsPerGw = calcAvgPointsPerGw(player, ctx);
  // §7.3 — reuses formResult so minutesSecurity isn't recomputed.
  const playing        = calcPlayingLikelihood(player, formResult);

  const value = clamp(0, 100,
    (PROJ_FORM    * formResult.value)
  + (PROJ_FIXTURE * horizonResult.value)
  + (PROJ_COUNTER * counterEdge.value)
  + (PROJ_MINUTES * playing.value),
  );

  return {
    value,
    band:  bandFromValue(value),
    perGw: horizonResult.perGw,
    breakdown: {
      form: {
        value:           formResult.value,
        weight:          PROJ_FORM,
        estimated:       formResult.estimated,
        // minutesSecurity exposed here so callers (e.g. ranker) do not need to
        // re-call calcPlayerForm — avoids doubling the work per player row.
        minutesSecurity: formResult.minutesSecurity ?? null,
      },
      fixture: { value: horizonResult.value, weight: PROJ_FIXTURE, estimated: false },
      counter: { value: counterEdge.value,   weight: PROJ_COUNTER, estimated: counterEdge.estimated },
      minutes: {
        value:              playing.value,
        weight:             PROJ_MINUTES,
        estimated:          playing.estimated,
        // Both halves exposed so the UI can say WHY a player scores low here:
        // benched (low startShare) reads differently from injured (low availability).
        startShare:         playing.startShare,
        availability:       playing.availability,
        availabilitySource: playing.availabilitySource,
      },
    },
    valueScore: player.price > 0 ? value / player.price : 0,
    avgPointsPerGw,
    costPerPoint: (player.price > 0 && avgPointsPerGw.value > 0)
      ? player.price / avgPointsPerGw.value : null,
    // Fixture + counter only (excludes form) — "is his NEXT FIXTURE good",
    // not "is he in form". Re-normalised over just these two weights since
    // PROJ_FORM is dropped from the blend. Reuses horizonResult/counterEdge
    // computed above; not a new independent calculation.
    nextFixtureScore: {
      value: clamp(0, 100,
        ((PROJ_FIXTURE * horizonResult.value) + (PROJ_COUNTER * counterEdge.value))
        / (PROJ_FIXTURE + PROJ_COUNTER)),
      estimated: counterEdge.estimated,
    },
  };
}

// ─── rankPlayers ──────────────────────────────────────────────────────────────

/**
 * Score every player over a horizon and return them sorted by projected value
 * descending. Pure — no DOM, no network, no store access.
 * Consumed by modules/ranker.js as the primary entry point for bulk scoring.
 *
 * @param {Player[]} players
 * @param {{label: string, gws: number}} horizon
 * @param {object} ctx  output of buildScoreContext
 * @returns {{ player: Player, score: object }[]}  sorted descending by score.value
 */
export function rankPlayers(players, horizon, ctx) {
  if (!Array.isArray(players) || !horizon || !ctx) {
    throw new TypeError('rankPlayers: players, horizon, and ctx are required');
  }
  return players
    .map(p => ({ player: p, score: scorePlayer(p, horizon, ctx) }))
    .sort((a, b) => b.score.value - a.score.value);
}

// ─── Rank-relative colouring ──────────────────────────────────────────────────

/**
 * Classify a player into a rank tier, or null if they don't fall into any
 * standout tier. This is a SEPARATE axis from `score.band` (§8.4): band
 * classifies a score against the fixed 0–100 scale; tier classifies a player
 * against the CURRENT POOL, so a strong pick still stands out even in a
 * season where absolute scores run low (or vice versa). Only the standout
 * tiers get a colour override — everyone else keeps their existing band
 * colour. See FEATURE_ENGINE.md §13.
 *
 * Precedence (most to least specific), each tier evaluated in order and the
 * first match wins:
 *   1. 'positionElite'    — positionIndex < RANK_ELITE_COUNT_BY_POS[position]
 *   2. 'positionStrong'   — positionIndex < RANK_STRONG_COUNT_BY_POS[position]
 *   3. 'bottomPercentile' — index >= poolSize * (1 - RANK_BOTTOM_PERCENTILE)
 * A position-elite player is always also position-strong (the elite count is
 * always ≤ the strong count for every position) — elite is checked first
 * specifically because it is the more exclusive, "definitely worth squad
 * consideration" signal, and would otherwise be silently absorbed into the
 * wider tier.
 *
 * MODEL: the two "worth considering" tiers are PER-POSITION — `positionIndex`
 * is this player's 0-based rank among players of their OWN position only, not
 * the whole pool. A pool-wide ranking systematically buried Forwards (fewer
 * of them, and not reliably higher-scoring) under cheap Defenders that post a
 * similar composite score — ranking each position against its own peers is
 * what actually surfaces good picks per position, which is the point of the
 * feature. `bottomPercentile` stays pool-wide by contrast: there's no
 * equivalent "hidden gem" concern to correct for at the bottom.
 *
 * MODEL: tier names describe their ROLE (mirroring the RANK_* config constant
 * names), not the current threshold numbers — those are tunable
 * (FEATURE_ENGINE.md §13), and a name baked to a specific figure would
 * silently go stale the next time any of them are retuned.
 *
 * @param {number} index          0-based rank in the whole sorted pool (0 = best)
 * @param {number} poolSize       total size of the pool `index` was ranked within
 * @param {number} positionIndex  0-based rank among players of the SAME position only
 * @param {string} position       the player's position (GKP/DEF/MID/FWD)
 * @returns {'positionElite'|'positionStrong'|'bottomPercentile'|null}
 */
export function calcRankTier(index, poolSize, positionIndex, position) {
  const eliteCount  = RANK_ELITE_COUNT_BY_POS[position]  ?? 0;
  const strongCount = RANK_STRONG_COUNT_BY_POS[position] ?? 0;
  if (positionIndex < eliteCount)  return 'positionElite';
  if (positionIndex < strongCount) return 'positionStrong';
  if (poolSize > 0 && index >= 0 && index < poolSize
      && index >= poolSize * (1 - RANK_BOTTOM_PERCENTILE)) return 'bottomPercentile';
  return null;
}

/**
 * Attach a `rankTier` to every entry of an already-sorted (descending by
 * value) scored-player array — the shape `rankPlayers` returns, or any
 * caller's own equivalent (e.g. modules/ranker.js's chunked `_rows`, which
 * carries the same { player, score, ... } shape plus extra fields that pass
 * through unchanged). Pure: returns a new array, never mutates the input.
 *
 * Derives each player's per-position rank in a single pass: since `sortedRows`
 * is already sorted descending pool-wide, counting occurrences of each
 * position as we go — advancing that position's counter only when we meet
 * another player of it — reproduces the same descending order restricted to
 * one position, without a second sort.
 *
 * @param {{player: Player, score: object}[]} sortedRows
 * @returns {{player: Player, score: object, rankTier: string|null}[]}
 */
export function attachRankTiers(sortedRows) {
  const poolSize = sortedRows.length;
  const positionCounts = {};
  return sortedRows.map((row, index) => {
    const position = row.player?.position;
    const positionIndex = positionCounts[position] ?? 0;
    positionCounts[position] = positionIndex + 1;
    return {
      ...row,
      rankTier: calcRankTier(index, poolSize, positionIndex, position),
    };
  });
}
