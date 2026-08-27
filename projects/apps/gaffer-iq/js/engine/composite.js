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
  HORIZON_DECAY, AGG_METHOD, W_MEAN, W_MIN, BLANK_GW_VALUE, DGW_UPLIFT,
  PROJ_FORM, PROJ_FIXTURE, PROJ_COUNTER, PROJ_MINUTES, EXPECTED_PTS_FIXTURE_SWING,
  RANK_ELITE_COUNT_BY_POS, RANK_STRONG_COUNT_BY_POS, RANK_TOP_PERCENTILE, RANK_BOTTOM_PERCENTILE,
  SEASON_GWS,
  PLAYTIME_PRIOR_MIN, PLAYTIME_PRIOR_MAX, PLAYTIME_BODY_SHARE,
} from '../config.js';
import { clamp, invert } from '../util.js';
import {
  calcBaseDifficulty, calcVenueEffect, calcFixtureHistory,
  buildRollingVenueStatsByTeamId,
} from './fixtures.js';
import {
  calcTeamForm, calcPlayerForm, calcPlayingLikelihood, calcPlaytimeSecurity,
  buildUnderstatPlayerLookup,
} from './form.js';
// calcStyleClash is no longer imported — styleClash was removed from WEIGHTS
// (config.js explains why). buildXgProfilesByTeamId stays: the xG profiles it
// builds are still consumed by engine/counter.js and displayed by the UI.
import { buildXgProfilesByTeamId } from './style.js';
import { buildUnderstatSlugsByTeamId, buildChannelProfilesByTeamId } from './channel.js';
import {
  calcCounterMatchup, calcCounterMatchupMirrored, calcCombinedCounterMatchup,
} from './counter.js';

/**
 * Build the assembly context every engine function consumes. Pure — derives
 * indices and aggregates from a Season plus an optional summary map, never
 * mutates either input.
 *
 * @param {Season} season   output of normaliseSeason
 * @param {object} [opts]
 * @param {object} [opts.playerSummariesById]  playerId → PlayerSummary (may be partial)
 * @param {object} [opts.leagueXg]             Understat league/EPL payload, current season (Phase 3A); null when unavailable
 * @param {object} [opts.leagueXgPrev]         Understat league/EPL payload, LAST season (Phase 3B) — feeds only
 *   calcHomeAwaySplit's rolling window (engine/fixtures.js); null when unavailable
 * @param {object[]} [opts.leagueXgHistory]    Understat league/EPL payloads for the seasons before those two
 *   (UNDERSTAT_HISTORY_SEASONS, config.js), newest first — feeds only the cross-season head-to-head
 *   window (engine/h2h.js); [] or absent when none loaded
 * @param {number} [opts.currentGw]            override; defaults to season.currentGw, then nextGw, then 1
 * @returns {object} ctx consumed by calcBase/HomeAway/Form/Style/Counter/FixtureHistory.
 *
 *   ctx shape:
 *     teamsById:                 Object<teamId, Team>           (passthrough)
 *     playersByTeamId:           Object<teamId, Player[]>       (derived)
 *     fixtures:                  Fixture[]                       (passthrough, sorted)
 *     playedFixtures:            Fixture[]                       (derived: f.played && f.result)
 *     playerSummariesById:       Object<playerId, PlayerSummary> (passthrough, possibly {})
 *     leagueXg:                  object | null                   (passthrough — Phase 3A)
 *     leagueXgPrev:              object | null                   (passthrough — Phase 3B)
 *     rollingVenueStatsByTeamId: object                           (derived — Phase 3B, calcHomeAwaySplit input)
 *     leagueXgHistory:           object[]                        (passthrough — Phase 4, cross-season H2H input)
 *     currentGw:                 number
 *     leagueAvgStrength:         number  (mean of team.strength.overall across the league)
 */
/**
 * Precompute everything engine/form.js's calcPlaytimeSecurity needs that is a
 * property of the POOL rather than of one player: how far into the season we
 * are, each player's price-derived role prior, and how crowded his club's
 * group at his position is.
 *
 * Done once per context because both are O(pool) aggregates — recomputing them
 * inside a per-player call would make the Ranker's full-pool render quadratic.
 *
 * @param {Player[]} players  the whole pool
 * @returns {{elapsedGws: number, playtimeByPlayerId: Object<number, {prior: number, crowding: number}>}}
 */
function buildPlaytimeContext(players) {
  const pool = players || [];

  // MODEL: elapsed gameweeks are derived from the DATA, not from a gameweek
  // counter. The most-played footballer in the league defines how many rounds
  // have actually been played, which stays honest through postponements,
  // blanks and doubles in a way currentGw does not — and needs no agreement
  // about whether currentGw means "in progress" or "last completed".
  let maxMinutes = 0;
  for (const p of pool) {
    const m = p?.totals?.minutes ?? 0;
    if (m > maxMinutes) maxMinutes = m;
  }
  const elapsedGws = Math.max(1, Math.round(maxMinutes / 90));

  // Price range per position, for the role prior. Position-relative because a
  // £5.5m defender and a £5.5m forward imply completely different roles.
  const priceRangeByPos = {};
  for (const p of pool) {
    const pos = p?.position;
    const price = p?.price ?? 0;
    if (!pos || !(price > 0)) continue;
    const r = (priceRangeByPos[pos] ||= { min: Infinity, max: -Infinity });
    if (price < r.min) r.min = price;
    if (price > r.max) r.max = price;
  }

  // Club + position groups, for crowding.
  const groups = {};
  for (const p of pool) {
    if (!p?.position || p.teamId == null) continue;
    (groups[`${p.teamId}|${p.position}`] ||= []).push(p);
  }

  const slotMinutes = elapsedGws * 90;
  const crowdingByGroup = {};
  for (const [key, members] of Object.entries(groups)) {
    const groupMinutes = members.reduce((sum, p) => sum + (p?.totals?.minutes ?? 0), 0);
    // Fractional count of starting slots this position occupies for this club:
    // a back four playing every minute totals four slots' worth of minutes.
    // Derived rather than assumed, so it follows a manager who switches to a
    // back three without anyone hard-coding a formation.
    const slots  = groupMinutes / slotMinutes;
    const bodies = members.filter(
      p => (p?.totals?.minutes ?? 0) >= PLAYTIME_BODY_SHARE * slotMinutes).length;
    // Below one slot there is nothing to be crowded out of — a group with no
    // minutes yet (preseason) must not read as infinitely contested.
    crowdingByGroup[key] = slots >= 1 ? (bodies / slots) : 1;
  }

  const playtimeByPlayerId = {};
  for (const p of pool) {
    if (!p?.id) continue;
    const r = priceRangeByPos[p.position];
    // Flat midpoint when a position has no spread to speak of, rather than a
    // division by zero.
    const span = r && r.max > r.min ? (r.max - r.min) : 0;
    const pct  = span > 0 ? clamp(0, 1, ((p.price ?? 0) - r.min) / span) : 0.5;
    playtimeByPlayerId[p.id] = {
      prior: PLAYTIME_PRIOR_MIN + (pct * (PLAYTIME_PRIOR_MAX - PLAYTIME_PRIOR_MIN)),
      crowding: crowdingByGroup[`${p.teamId}|${p.position}`] ?? 1,
    };
  }

  return { elapsedGws, playtimeByPlayerId };
}

export function buildScoreContext(season, opts = {}) {
  if (!season || !season.teamsById) {
    throw new TypeError('buildScoreContext: season (from normaliseSeason) is required');
  }

  const playedFixtures = (season.fixtures || []).filter(f => f.played && f.result);

  // Pool-wide aggregates for the playtime model (FEATURE_ENGINE.md §7.3b).
  // elapsedGws is also what fixes calcPlayerForm's minutesSecurity — see the
  // MODEL note in engine/form.js's fallbackPlayerForm.
  const { elapsedGws, playtimeByPlayerId } = buildPlaytimeContext(season.players);

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

  // Channel tier: the per-team Understat `statistics` block, fetched eagerly
  // for every team at startup (js/main.js prefetchAllTeamXg). {} only until
  // that boot-time fetch resolves, in which case calcCounterMatchup degrades
  // to the role tier — see the design spec §8 for why the tier is chosen by
  // data availability rather than by which module is asking.
  const teamXgBySlug = opts.teamXgBySlug ?? null;
  const channelProfilesByTeamId = buildChannelProfilesByTeamId(
    teamXgBySlug,
    buildUnderstatSlugsByTeamId(leagueXg, season.teamsById),
  );

  // Phase 3B: precompute calcHomeAwaySplit's rolling cross-season window once
  // per ctx, same idiom as xgProfilesByTeamId above — never recomputed per
  // fixture. leagueXgPrev (last season) exists ONLY to feed this; nothing
  // else in the engine reads it. Always call — buildRollingVenueStatsByTeamId
  // itself degrades to {} when both payloads are null/absent, and
  // calcHomeAwaySplit already falls back to FPL fixtures for anything missing
  // here, so there is no "skip when unavailable" branch needed.
  const leagueXgPrev = opts.leagueXgPrev ?? null;
  const rollingVenueStatsByTeamId =
    buildRollingVenueStatsByTeamId(leagueXg, leagueXgPrev, season.teamsById);

  // Phase 4: the older Understat payloads — passthrough only, read exclusively
  // by the cross-season head-to-head collector (engine/h2h.js) alongside
  // leagueXg/leagueXgPrev above. Nothing else touches these.
  const leagueXgHistory = opts.leagueXgHistory ?? [];

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
    channelProfilesByTeamId,
    // Phase 3B — last season's Understat payload, and the rolling venue stats
    // derived from it plus leagueXg. See buildRollingVenueStatsByTeamId
    // (engine/fixtures.js) and FEATURE_ENGINE.md §3.1.
    leagueXgPrev,
    rollingVenueStatsByTeamId,
    // Phase 4 — the older Understat payloads, see above and §4.
    leagueXgHistory,
    currentGw:           opts.currentGw ?? season.currentGw ?? season.nextGw ?? 1,
    leagueAvgStrength,
    // Gameweeks actually played, derived from the pool's minutes rather than a
    // counter — see buildPlaytimeContext.
    elapsedGws:          opts.elapsedGws ?? elapsedGws,
    playtimeByPlayerId,
  };
}

/**
 * Map a 0–100 value onto its band string. Thresholds come from config (BANDS);
 * never inline a literal here — CSS modifier classes (.score-pill--great etc.)
 * key off this string, so the colour mapping stays single-sourced.
 *
 * Rounds BEFORE comparing against BANDS — every UI surface displays
 * Math.round(value), so banding the raw unrounded value could label a
 * displayed "40" as 'tough' whenever the true value was e.g. 39.6 (< the
 * neutral threshold pre-rounding, but rounds up to display as 40). Rounding
 * here keeps the label always consistent with the number the user actually
 * sees, at every boundary.
 */
function bandFromValue(value) {
  const rounded = Math.round(value);
  if (rounded >= BANDS.great)   return 'great';
  if (rounded >= BANDS.good)    return 'good';
  if (rounded >= BANDS.neutral) return 'neutral';
  if (rounded >= BANDS.tough)   return 'tough';
  return 'brutal';
}

// ─── §8.6  Stacking penalty ───────────────────────────────────────────────────

// The secondary metrics that can stack against a team. baseDifficulty is
// deliberately absent: it is the reading the resilience is measured RELATIVE TO,
// not one of the things that can pile up against it. Kept here rather than in
// config.js because it is structural (which metrics are secondary), not a
// tunable — same call as ROLE_ATTACK_GROUPS in counter.js.
const STACK_METRICS = ['counterMatchup', 'teamForm', 'history', 'homeAway'];

/**
 * How much of a sub-metric's weight it has actually earned, 0–1.
 *
 * MODEL: `estimated` and `maturity` answer different questions and both are
 * needed. `estimated` means "this reading is a fallback, don't use it" and
 * always wins. `maturity` means "this reading is real, but built on N% of the
 * evidence it eventually will be" — a distinction that did not exist before
 * 2026-08-21, when every metric was all-or-nothing. Conflating them would
 * force a choice between throwing away an early-season signal entirely and
 * letting three matches of data swing a fixture as hard as thirty.
 *
 * A metric that reports no `maturity` is binary exactly as before: 1 when
 * usable, 0 when estimated. counterMatchup (engine/channel.js) and teamForm
 * (engine/form.js) both report partial values; the mechanism is general — any
 * metric can opt in by returning a `maturity` field, with no change needed here.
 *
 * @param {{estimated?: boolean, maturity?: number}|null} metric
 * @returns {number}  0–1. Higher = more of its configured weight applies.
 */
export function metricMaturity(metric) {
  if (!metric || metric.estimated) return 0;
  if (typeof metric.maturity !== 'number' || Number.isNaN(metric.maturity)) {
    return metric.maturity === undefined ? 1 : 0;
  }
  return clamp(0, 1, metric.maturity);
}

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
 * MODEL: an immature metric is weighed by what it has actually EARNED
 * (weight × maturity), the same quantity the composite sum uses. Counting a
 * one-game form reading at its full 15% here while the sum counted 3% would let
 * evidence the score barely trusts drive a penalty at full force — the exact
 * asymmetry the maturity ramp exists to remove. A metric reporting no maturity
 * is unchanged (metricMaturity treats it as 1).
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
    const earned = m.weight * metricMaturity(m);
    if (earned === 0) continue;
    consideredWeight += earned;
    if (m.value >= STACK_PIVOT) continue;
    countUnfavourable++;
    // Normalised severity: 0 at the pivot, 1 at a floored-zero metric.
    shortfallWeighted += earned * ((STACK_PIVOT - m.value) / STACK_PIVOT);
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
  // §3 (Phase 4): venue effect is fixture-level, not single-team — both sides'
  // venue sensitivity feed a shared home boost / away penalty (calcVenueEffect,
  // engine/fixtures.js). `venue` here is `team`'s own 0-100 read of that shared
  // effect (50 + boost when team is home, 50 + penalty when away), reshaped to
  // the same {value, estimated, gamesAtVenue} contract every other sub-metric
  // and STACK_METRICS/confidence below already expect.
  const venueEffect = isHome
    ? calcVenueEffect(team, opponent, ctx)
    : calcVenueEffect(opponent, team, ctx);
  const venue = {
    value:        clamp(0, 100, 50 + (isHome ? venueEffect.homeBoost : venueEffect.awayPenalty)),
    estimated:    venueEffect.estimated,
    gamesAtVenue: isHome ? venueEffect.homeBase.homeGames : venueEffect.awayBase.awayGames,
    // Transparency fields (ARCHITECTURE.md §12 rule 6) — this team's own
    // standalone venue-sensitivity read, not the combined fixture effect.
    ownSplit: isHome ? venueEffect.homeBase : venueEffect.awayBase,
    combinedMagnitude: venueEffect.combinedMagnitude,
  };
  const form    = calcTeamForm(team, ctx);
  // Counter-Matchup blends BOTH pairings so a team's own defensive quality
  // against this opponent's attack earns direct credit on its own composite,
  // not just an indirect one via the opponent's raw score in §8.7. See
  // calcCombinedCounterMatchup (engine/counter.js) and FEATURE_ENGINE.md §7.2.
  const attackingCounter = calcCounterMatchup(team, opponent, ctx);
  const defendingCounter = calcCounterMatchupMirrored(calcCounterMatchup(opponent, team, ctx));
  const counter = calcCombinedCounterMatchup(attackingCounter, defendingCounter);
  // const style = calcStyleClash(team, opponent, ctx);   // styleClash removed
  const history = calcFixtureHistory(team.id, opponentId, ctx);

  // MODEL: confidence = MATURITY-weighted share of usable sub-metrics.
  // Computed BEFORE linearValue below because linearValue divides by it (§8.3).
  //
  // Revised 2026-08-21 from an all-or-nothing sum to a continuous one. A metric
  // whose evidence is thin but real now contributes proportionally rather than
  // being discarded — see metricMaturity below for why that is not the same
  // thing as `estimated`.
  const mBase    = metricMaturity(base);
  const mCounter = metricMaturity(counter);
  const mForm    = metricMaturity(form);
  const mHistory = metricMaturity(history);
  const mVenue   = metricMaturity(venue);
  // const mStyle = metricMaturity(style);                // styleClash removed

  const confidence =
      WEIGHTS.baseDifficulty * mBase
    + WEIGHTS.counterMatchup * mCounter
    + WEIGHTS.teamForm       * mForm
    + WEIGHTS.history        * mHistory
    + WEIGHTS.homeAway       * mVenue;

  // Weighted blend — every sub-metric is already 0–100, higher = better for `team`.
  // WEIGHTS sums to 1.00 (config.js / FEATURE_ENGINE.md §8.1).
  //
  // baseDifficulty is the ONE exception to the higher-is-better rule: it is
  // stored as the opponent's strength (higher = harder) because the UI shows it
  // that way, so it is inverted here before weighting. Removing this invert()
  // would make facing Man City *raise* a team's score. See FEATURE_ENGINE.md §2.
  //
  // MODEL: estimated sub-metrics are EXCLUDED from the sum, and the remaining
  // (non-estimated) weights are re-normalised so they cover the full 0–1 range
  // — an unreliable reading no longer dilutes the score at full weight, it
  // simply doesn't count. `confidence` above IS that re-normalisation
  // denominator: baseDifficulty is never estimated (§8.1), so confidence is
  // always > 0 and this never divides by zero. See §8.3.
  // term() guards the zero case explicitly: a metric at maturity 0 may carry a
  // null value (a blank channel counter does), and null would otherwise ride
  // through the arithmetic as a 0 rather than being genuinely absent.
  const term = (weight, maturity, value) =>
    (maturity === 0 || typeof value !== 'number' ? 0 : weight * maturity * value);

  const rawWeightedSum =
      term(WEIGHTS.baseDifficulty, mBase,    invert(base.value))
    + term(WEIGHTS.counterMatchup, mCounter, counter.value)
    + term(WEIGHTS.teamForm,       mForm,    form.value)
    + term(WEIGHTS.history,        mHistory, history.value)
    + term(WEIGHTS.homeAway,       mVenue,   venue.value);
  const linearValue = confidence > 0 ? rawWeightedSum / confidence : 50;

  // §8.6 conditional term. Built from the same sub-metric shapes the breakdown
  // below reports, so it needs their { value, weight, estimated } triples — hence
  // the small intermediate object rather than reading the breakdown after the fact.
  const stack = calcStackingPenalty({
    counterMatchup: { value: counter.value, weight: WEIGHTS.counterMatchup, estimated: counter.estimated, maturity: mCounter },
    teamForm:       { value: form.value,    weight: WEIGHTS.teamForm,       estimated: form.estimated, maturity: mForm },
    history:        { value: history.value, weight: WEIGHTS.history,        estimated: history.estimated },
    homeAway:       { value: venue.value,   weight: WEIGHTS.homeAway,       estimated: venue.estimated },
  });

  const value = clamp(0, 100, linearValue - stack.penalty);

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
        // Reported as stored — higher = harder. The composite above consumes
        // invert(base.value); the UI wants this one.
        value:     base.value,
        weight:    WEIGHTS.baseDifficulty,
        estimated: base.estimated,
        fdr:        base.fdr,         // FPL's own 1–5 for this side, or null
        fdrMissing: base.fdrMissing,  // true when FPL published no rating at all
      },
      counterMatchup: {
        value:     counter.value,
        weight:    WEIGHTS.counterMatchup,
        estimated: counter.estimated,
        pairings:  counter.pairings,
        // Unblended inputs so the UI can explain the blend (ARCHITECTURE.md §12
        // rule 6) — attackingValue: this team's attack vs the opponent's
        // defence; defendingValue: this team's defence vs the opponent's attack.
        attackingValue: counter.attackingValue,
        defendingValue: counter.defendingValue,
        mode:           counter.mode,
        // 0–1 share of this metric's configured weight that actually applied.
        // 0 = no Understat data yet; 1 = fully mature profile on both sides.
        maturity:       mCounter,
        effectiveWeight: WEIGHTS.counterMatchup * mCounter,
      },
      teamForm: {
        value:     form.value,
        weight:    WEIGHTS.teamForm,
        estimated: form.estimated,
        trend:     form.trend,
        games:     form.games,
        // 0–1 share of this metric's configured weight that actually applied.
        // FORM_WINDOW_GWS games = a full window = 1. See engine/form.js.
        maturity:  mForm,
        effectiveWeight: WEIGHTS.teamForm * mForm,
      },
      history: {
        value:      history.value,
        weight:     WEIGHTS.history,
        estimated:  history.estimated,
        meetings:   history.meetings,
        pointsForA: history.pointsForA,
      },
      homeAway: {
        value:        venue.value,
        weight:       WEIGHTS.homeAway,
        estimated:    venue.estimated,
        gamesAtVenue: venue.gamesAtVenue,
        // §3 (Phase 4) — this team's own home/away PPG split, and the shared
        // fixture-level magnitude it was blended with, so the UI can explain
        // WHY this venue reading is what it is (ARCHITECTURE.md §12 rule 6).
        homePPG:           venue.ownSplit.homePPG,
        awayPPG:           venue.ownSplit.awayPPG,
        rawSplit:          venue.ownSplit.rawSplit,
        sign:              venue.ownSplit.sign,
        combinedMagnitude: venue.combinedMagnitude,
      },
      // styleClash: removed from the breakdown along with its weight. Restoring
      // it means uncommenting the four sites above, this block, its WEIGHTS
      // entry and its STACK_METRICS entry — engine/style.js itself is untouched.
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
/**
 * Lift a gameweek's value for each fixture beyond the first.
 *
 * MODEL: FEATURE_ENGINE.md §9. Applied to a per-GW value AFTER that gameweek's
 * fixtures have been collapsed to a mean — never to an individual fixture
 * score, and never more than once per gameweek. Asymptotic toward 100 so the
 * band scale cannot overflow.
 *
 * @param {number} gwValue      the gameweek's collapsed 0–100 value
 * @param {number} fixtureCount how many fixtures the team plays that gameweek
 * @returns {number}
 */
export function applyDgwUplift(gwValue, fixtureCount) {
  // 0 fixtures means the caller has already substituted BLANK_GW_VALUE, and 1
  // is the ordinary case. Guarding both here rather than at the call site keeps
  // the function total: a negative (n − 1) would otherwise DEDUCT from a blank,
  // which is not the model — a blank is already priced by BLANK_GW_VALUE.
  if (fixtureCount <= 1) return gwValue;
  return gwValue + (100 - gwValue) * DGW_UPLIFT * (fixtureCount - 1);
}

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
 * Real points-scale projection used for captaincy / Triple Captain decisions:
 * how many FPL points is this player actually expected to score next,
 * scaled by how good his next fixture is and how likely he is to start?
 *
 * This is deliberately NOT `scorePlayer`'s 0–100 `value` — that composite is a
 * normalised quality score (FEATURE_ENGINE.md §10) meant for comparing players
 * WITHIN a position, so a defender in great form with an easy fixture can
 * outscore a middling forward even though the forward's actual point ceiling
 * is far higher. `expectedPoints` stays on the real points scale (from
 * `avgPointsPerGw`, which already reflects each position's true scoring
 * ceiling — forwards/mids naturally average more than defenders) so captaincy
 * picks the player predicted to score the most points, full stop, regardless
 * of position or price. See FEATURE_ENGINE.md §10.2.
 *
 * @param {{value: number, estimated: boolean}} avgPointsPerGw
 * @param {{value: number}} nextFixtureScore  0–100, fixture+counter blend
 * @param {{value: number, estimated: boolean}} playing  0–100 playing likelihood
 * @returns {{value: number, estimated: boolean}}
 *   value: expected FPL points for the upcoming game (real points scale, not 0–100).
 */
export function calcExpectedPoints(avgPointsPerGw, nextFixtureScore, playing) {
  const fixtureMultiplier = 1 + EXPECTED_PTS_FIXTURE_SWING * ((nextFixtureScore.value - 50) / 50);
  const minutesMultiplier = playing.value / 100;
  return {
    value:     avgPointsPerGw.value * fixtureMultiplier * minutesMultiplier,
    estimated: avgPointsPerGw.estimated || playing.estimated,
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
 *             costPerPoint: number|null, nextFixtureScore: {value:number, estimated:boolean},
 *             expectedPoints: {value:number, estimated:boolean} }}
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
 *   expectedPoints: real points-scale captaincy/TC projection (avgPointsPerGw
 *   scaled by nextFixtureScore and playing likelihood) — NOT the same axis as
 *   `value`; see calcExpectedPoints above and FEATURE_ENGINE.md §10.2.
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
      expectedPoints: calcExpectedPoints(avgPointsPerGw, { value: 50 }, { value: 50, estimated: true }),
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
  // §7.3b — the richer squad-context model behind the Ranker's Playtime column.
  // Deliberately NOT folded into `value` below: PROJ_MINUTES already carries a
  // minutes term through calcPlayingLikelihood, and adding a second would
  // double-count playing time in the composite. This is a display metric that
  // travels with the score, not a fourth weighted input.
  const playtime       = calcPlaytimeSecurity(player, ctx);

  const value = clamp(0, 100,
    (PROJ_FORM    * formResult.value)
  + (PROJ_FIXTURE * horizonResult.value)
  + (PROJ_COUNTER * counterEdge.value)
  + (PROJ_MINUTES * playing.value),
  );

  // Fixture + counter only (excludes form) — "is his NEXT FIXTURE good", not
  // "is he in form". Re-normalised over just these two weights since PROJ_FORM
  // is dropped from the blend. Reused below by expectedPoints so both metrics
  // agree on what "a good fixture" means.
  const nextFixtureScore = {
    value: clamp(0, 100,
      ((PROJ_FIXTURE * horizonResult.value) + (PROJ_COUNTER * counterEdge.value))
      / (PROJ_FIXTURE + PROJ_COUNTER)),
    estimated: counterEdge.estimated,
  };

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
      // Squad-context playtime read (§7.3b). Carries its own band/label so the
      // Ranker never re-derives the mapping, and its sub-terms so the UI can
      // explain WHY a player scores low: crowded out, benched, or unavailable.
      playtime,
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
    nextFixtureScore,
    expectedPoints: calcExpectedPoints(avgPointsPerGw, nextFixtureScore, playing),
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
 * Classify a player into a rank tier. This is a SEPARATE axis from
 * `score.band` (§8.4): band classifies a score against the fixed 0–100
 * scale; tier classifies a player against the CURRENT POOL, so a strong pick
 * still stands out even in a season where absolute scores run low (or vice
 * versa). Every player gets a tier now (see below) — this fully supersedes
 * `score.band`'s colour for wherever a rank tier is rendered; `null` is only
 * a defensive fallback for a malformed/empty pool, not a normal outcome.
 * See FEATURE_ENGINE.md §13.
 *
 * Precedence (most to least specific), each tier evaluated in order and the
 * first match wins:
 *   1. 'positionElite'    — positionIndex < RANK_ELITE_COUNT_BY_POS[position]
 *   2. 'positionStrong'   — positionIndex < RANK_STRONG_COUNT_BY_POS[position]
 *   3. 'topPercentile'    — index < poolSize * RANK_TOP_PERCENTILE
 *   4. 'bottomPercentile' — index >= poolSize * (1 - RANK_BOTTOM_PERCENTILE)
 *   5. 'midPercentile'    — everyone else
 * A position-elite player is always also position-strong (the elite count is
 * always ≤ the strong count for every position) — elite is checked first
 * specifically because it is the more exclusive, "definitely worth squad
 * consideration" signal, and would otherwise be silently absorbed into the
 * wider tier.
 *
 * MODEL: the two green "worth considering" tiers are PER-POSITION —
 * `positionIndex` is this player's 0-based rank among players of their OWN
 * position only, not the whole pool. A pool-wide ranking systematically
 * buried Forwards (fewer of them, and not reliably higher-scoring) under
 * cheap Defenders that post a similar composite score — ranking each
 * position against its own peers is what actually surfaces good picks per
 * position, which is the point of the feature. `topPercentile` and
 * `bottomPercentile` stay pool-wide by contrast: there's no equivalent
 * "hidden gem" concern to correct for outside the green tiers, just "clearing
 * a bar" either way.
 *
 * MODEL: `topPercentile` and `bottomPercentile` can overlap the green tiers'
 * rank range for a thin position (e.g. GKP's top 8 already covers more than
 * 25% of all goalkeepers) — harmless, since green is checked first and always
 * wins; `topPercentile` only actually shows (grey) for positions/pool shapes
 * where the pool-wide top-25% cutoff reaches deeper than that position's own
 * green cutoff.
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
 * @returns {'positionElite'|'positionStrong'|'topPercentile'|'bottomPercentile'|'midPercentile'|null}
 */
export function calcRankTier(index, poolSize, positionIndex, position) {
  const eliteCount  = RANK_ELITE_COUNT_BY_POS[position]  ?? 0;
  const strongCount = RANK_STRONG_COUNT_BY_POS[position] ?? 0;
  if (positionIndex < eliteCount)  return 'positionElite';
  if (positionIndex < strongCount) return 'positionStrong';
  if (poolSize <= 0 || index < 0 || index >= poolSize) return null;
  if (index < poolSize * RANK_TOP_PERCENTILE)           return 'topPercentile';
  if (index >= poolSize * (1 - RANK_BOTTOM_PERCENTILE)) return 'bottomPercentile';
  return 'midPercentile';
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
