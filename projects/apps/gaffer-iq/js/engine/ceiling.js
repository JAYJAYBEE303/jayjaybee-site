/**
 * js/engine/ceiling.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 * Ceiling's upper tail (brief §6 mode 5; docs/decision-engine-plan.md,
 * Phase 7b): Monte Carlo draws of a gameweek's FPL points from the points
 * model's own parts (engine/points.js), and a fielded squad's score quantile
 * over them.
 *
 * Each fixture's goals for each side are Poisson counts at the side's
 * expected goals, drawn once and shared: a player's goals and assists are
 * thinned from his team's goals by his shares, his clean sheet and goals
 * conceded follow the goals his team concedes while he is on. So teammates
 * rise and fall together, and a stack's upside is counted. His minutes come
 * from the minutes model (picked, then 60+ or not); saves are Poisson, his
 * defensive contributions, cards and bonus as the mean model reads them.
 * The draws average his projected points (tests/engine/ceiling.test.js).
 * MODEL: teammates' goals and assists are thinned from their team's goals
 * independently, so in a draw they can add up to more than it scored (and a
 * player can score and assist the same goal): a slight overstatement of a
 * stack's upside. A double's rotation haircut lowers each fixture's chance
 * of being picked, which keeps the mean but makes playing at all a little
 * less likely than pZero says (0.979 against 0.990 at a 0.9 chance a game).
 *
 * Every player and every side has its own stream of draws, seeded by name,
 * so every swap is scored on the same draws (common random numbers) and a
 * re-run with a different shortlist draws the same points again.
 */

import { CAPTAIN_MULTIPLIER, FPL_SCORING, MATCH_MINUTES, XI_FORMATION_MIN } from '../config.js';
import { clamp, negativeBinomialTail, seededRandom, streamSeed } from '../util.js';

const OUTFIELD = ['DEF', 'MID', 'FWD'];

/**
 * What a player's gameweek is drawn from: built by projections.js for every
 * gameweek of a points-model projection, a blank's with no sides.
 *
 * @param {object} rates   his PointsRates (engine/points.js playerRates)
 * @param {Array<{fixtureId, teamId, opponentId, lambdaFor, lambdaAgainst}>} sides  his club's fixtures that week
 * @param {object} model   DECISION_ENGINE.pointsModel
 * @param {{availability: number, appear: number, p60: number, haircut: number}} minutes
 *   his availability (shared by a double's fixtures), his chance of being
 *   picked for a fixture, of 60 minutes once he is, and a double's rotation haircut
 * @returns {object}
 */
export function drawSpec(rates, sides, model, { availability, appear, p60, haircut }, rules = FPL_SCORING) {
  const { position } = rates;
  const threshold = rules.defensiveContribution?.threshold[position];
  const terms = minutes => {
    const share = minutes / MATCH_MINUTES;
    return {
      share,
      goal: rates.goalShare * share,
      assist: (model.assistsPerXa / model.goalsPerXg) * rates.assistShare * share,
      defcon: threshold ? negativeBinomialTail(rates.defconPer90 * share, model.defconDispersion, threshold) : 0,
      yellow: rates.yellowsPer90 * share,
      red: rates.redsPer90 * share,
      bonus: (model.bonus[position].base + rates.bonusResidualPer90) * share,
    };
  };
  return {
    position, availability, appear: appear * haircut, p60, savesPerXga: rates.savesPerXga,
    bonus: model.bonus[position],
    full: terms(model.minutesIfFull),
    short: terms(model.minutesIfShort),
    sides: sides.map(s => ({
      fixtureId: s.fixtureId, teamId: s.teamId, opponentId: s.opponentId,
      goalsFor: model.goalsPerXg * s.lambdaFor, goalsAgainst: model.goalsPerXg * s.lambdaAgainst,
      lambdaAgainst: s.lambdaAgainst,
    })),
  };
}

/**
 * Draws of gameweek `gw` for the players `ids`.
 *
 * @param {Map} projections  buildProjections output
 * @returns {{points: Map<number, Float64Array>, played: Map<number, Uint8Array>}|null}
 *   null when a player has nothing to draw from (the v1 basis)
 */
export function drawGameweek(projections, gw, ids, { draws, seed }, rules = FPL_SCORING) {
  const specs = ids.map(id => projections.get(id)?.gws.find(g => g.gw === gw)?.draw ?? null);
  if (specs.some(s => !s)) return null;

  const teamGoals = new Map();
  const goalsOf = (fixtureId, teamId, mean) => {
    const key = `${fixtureId}|${teamId}`;
    if (!teamGoals.has(key)) {
      const random = seededRandom(streamSeed(seed, 'side', fixtureId, teamId));
      teamGoals.set(key, Int32Array.from({ length: draws }, () => poisson(mean, random)));
    }
    return teamGoals.get(key);
  };

  const points = new Map();
  const played = new Map();
  ids.forEach((id, i) => {
    const spec = specs[i];
    const random = seededRandom(streamSeed(seed, 'player', id, gw));
    const sides = spec.sides.map(s => ({ ...s, for: goalsOf(s.fixtureId, s.teamId, s.goalsFor),
      against: goalsOf(s.fixtureId, s.opponentId, s.goalsAgainst) }));
    const pts = new Float64Array(draws);
    const on = new Uint8Array(draws);
    for (let j = 0; j < draws; j++) {
      if (random() >= spec.availability) continue;
      for (const side of sides) {
        if (random() >= spec.appear) continue;
        on[j] = 1;
        pts[j] += fixtureDraw(spec, side, j, random, rules);
      }
    }
    points.set(id, pts);
    played.set(id, on);
  });
  return { points, played };
}

/** One fixture's points for a player who is on: the mean model's parts (engine/points.js), drawn. */
function fixtureDraw(spec, side, j, random, rules) {
  const { position } = spec;
  const full = random() < spec.p60;
  const t = full ? spec.full : spec.short;
  const goals = binomial(side.for[j], t.goal, random);
  const assists = binomial(side.for[j], t.assist, random);
  const concededOn = binomial(side.against[j], t.share, random);
  const cleanSheet = full && concededOn === 0 ? 1 : 0;
  const saves = position === 'GKP' ? poisson(spec.savesPerXga * side.lambdaAgainst * t.share, random) : 0;
  const defcon = random() < t.defcon ? 1 : 0;
  const yellow = random() < t.yellow ? 1 : 0;
  const red = random() < t.red ? 1 : 0;
  // Bonus is the mean model's linear form on the draw, lifted by what the mean
  // model's floor adds to its mean (engine/points.js floors the mean, not each
  // match), so the draws keep its expectation.
  const expected = t.bonus + (spec.bonus.goal * side.goalsFor * Math.min(1, t.goal))
    + (spec.bonus.assist * side.goalsFor * Math.min(1, t.assist))
    + (full ? spec.bonus.cleanSheet * Math.exp(-side.goalsAgainst * Math.min(1, t.share)) : 0);
  const bonus = t.bonus + (spec.bonus.goal * goals) + (spec.bonus.assist * assists)
    + (spec.bonus.cleanSheet * cleanSheet) + Math.max(0, -expected);
  return (full ? rules.appearance.full : rules.appearance.short)
    + (rules.goal[position] * goals) + (rules.assist * assists) + (rules.cleanSheet[position] * cleanSheet)
    + (rules.conceded.positions.includes(position) ? rules.conceded.points * Math.floor(concededOn / rules.conceded.per) : 0)
    + (rules.saves.points * Math.floor(saves / rules.saves.per))
    + (defcon ? rules.defensiveContribution.points : 0)
    + bonus + (rules.yellow * yellow) + (rules.red * red);
}

/**
 * The quantile q of a fielded squad's score over the draws: its XI, FPL's
 * autosubs for a starter with no minutes (team-sheet order, the formation
 * minimums, the reserve keeper only for the keeper, each sub once), and the
 * captain's points `multiplier` times - the vice's when the captain did not
 * play. Under Bench Boost every one of the fifteen counts, and no sub is needed.
 *
 * @param {{xi: number[], bench: number[], captainId: number|null, viceId: number|null}} lineup
 * @param {Map<number, string>} positions
 * @param {{points: Map, played: Map}} sample   drawGameweek output covering the lineup
 */
export function squadQuantile(lineup, positions, sample, q, { multiplier = CAPTAIN_MULTIPLIER, benchBoost = false } = {}) {
  const { xi, bench, captainId, viceId } = lineup;
  const draws = sample.points.get(xi[0]).length;
  const totals = new Float64Array(draws);
  const ptsOf = (id, j) => sample.points.get(id)[j];
  const playedOf = (id, j) => sample.played.get(id)[j] === 1;
  const everyone = [...xi, ...bench];
  for (let j = 0; j < draws; j++) {
    let team = benchBoost ? everyone : xi;
    if (!benchBoost && !xi.every(id => playedOf(id, j))) team = fielded(xi, bench, positions, id => playedOf(id, j));
    let total = 0;
    for (const id of team) total += ptsOf(id, j);
    const armband = captainId !== null && playedOf(captainId, j) ? captainId
      : (viceId !== null && playedOf(viceId, j) ? viceId : null);
    if (armband !== null) total += (multiplier - 1) * ptsOf(armband, j);
    totals[j] = total;
  }
  return quantile(totals, q);
}

/** The XI after autosubs, for one draw. */
function fielded(xi, bench, positions, played) {
  const team = [...xi];
  const keeper = team.findIndex(id => positions.get(id) === 'GKP');
  const reserve = bench.find(id => positions.get(id) === 'GKP');
  if (keeper >= 0 && !played(team[keeper]) && reserve !== undefined && played(reserve)) team[keeper] = reserve;
  const counts = Object.fromEntries(OUTFIELD.map(p => [p, team.filter(id => positions.get(id) === p).length]));
  const used = new Set();
  for (const position of OUTFIELD) {
    team.forEach((id, i) => {
      if (positions.get(id) !== position || played(id)) return;
      const sub = bench.find(b => {
        const to = positions.get(b);
        if (to === 'GKP' || used.has(b) || !played(b)) return false;
        const after = { ...counts, [position]: counts[position] - 1 };
        after[to] += 1;
        return OUTFIELD.every(p => after[p] >= XI_FORMATION_MIN[p]);
      });
      if (sub === undefined) return;
      team[i] = sub;
      used.add(sub);
      counts[position] -= 1;
      counts[positions.get(sub)] += 1;
    });
  }
  return team;
}

/** The value at quantile q of `values` (nearest rank). */
export function quantile(values, q) {
  const sorted = Float64Array.from(values).sort();
  return sorted[clamp(0, sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
}

/** A Poisson count (Knuth's product of uniforms). */
function poisson(mean, random) {
  if (!(mean > 0)) return 0;
  const floor = Math.exp(-mean);
  let k = 0;
  let product = random();
  while (product > floor) {
    k += 1;
    product *= random();
  }
  return k;
}

/** A binomial count: n trials of chance p (at most 1). */
function binomial(n, p, random) {
  const chance = Math.min(1, p);
  let k = 0;
  for (let i = 0; i < n; i++) if (random() < chance) k += 1;
  return k;
}
