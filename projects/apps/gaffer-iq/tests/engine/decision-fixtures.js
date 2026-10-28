/**
 * tests/engine/decision-fixtures.js
 * Shared by the decision engine's tests (decision.test.js, robustness.test.js):
 * hand-built projections and engine inputs, so every expected figure can be
 * worked out on paper.
 *
 * The base squad: XI 4-4-2 - GK 1; DEF 3, 4, 5, 6; MID 8, 9, 10, 11; FWD 13,
 * 14 - worth 62, captain FWD 13 (9) for 71 in all; bench MID 12, FWD 15, DEF 7,
 * GK 2. Everyone plays and every player is £5.0m at his own club unless a test
 * says otherwise, so autosubs and club limits stay out of the way.
 */

import assert from 'node:assert/strict';

export const GW = 10;
export const GWS = 6;
export const MODES = ['now', 'longterm', 'future', 'funds', 'ceiling', 'structure'];

export const perGw = v => (Array.isArray(v) ? v : Array(GWS).fill(v));
export const close = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, message ?? `${actual} vs ${expected}`);

/**
 * A projection in buildProjections' shape. xip: xptsIfPlays, pz: pZero, fx:
 * fixtures, av: availability - each a constant or one value per GW.
 */
export function projectionOf({ id, position, team, price, xip, pz = 0, fx = 1, av = 1 }, from) {
  const [x, z, f, a] = [perGw(xip), perGw(pz), perGw(fx), perGw(av)];
  return {
    playerId: id, position, teamId: team, price: price / 10,
    gws: x.map((xIfP, k) => {
      const blank = f[k] === 0;
      const pZero = blank ? 1 : z[k];
      return {
        gw: from + k, fixtures: f[k], xpts: blank ? 0 : (1 - pZero) * xIfP,
        xptsIfPlays: blank ? 0 : xIfP, pZero, pStart: 1 - pZero, p60: 1 - pZero,
        p60Approx: true, pP90: null, estimated: false, availability: a[k], availabilitySource: 'status',
      };
    }),
  };
}

/**
 * Every projection given a draw spec (engine/ceiling.js): each player always
 * plays 60+ in a fixture of his own, nobody scores and nobody concedes, so his
 * draws are a fixed 2 (6 for a keeper or defender, 3 for a midfielder) -
 * unless `scoring` gives his club goals and him a share of them.
 */
export function withDraws(input, scoring = {}) {
  const terms = goal => ({ share: 1, goal, assist: 0, defcon: 0, yellow: 0, red: 0, bonus: 0 });
  const projections = new Map([...input.projections].map(([id, p]) => [id, { ...p, gws: p.gws.map(g => ({
    ...g,
    draw: {
      position: p.position, availability: 1, appear: 1, p60: 1, savesPerXga: 0,
      bonus: { goal: 0, assist: 0, cleanSheet: 0 },
      full: terms(scoring[id]?.share ?? 0), short: terms(0),
      sides: [{ fixtureId: id, teamId: id, opponentId: -id, goalsFor: scoring[id]?.goals ?? 0, goalsAgainst: 0, lambdaAgainst: 0 }],
    },
  })) }]));
  return { ...input, projections };
}

export const BASE = [
  { id: 1, position: 'GKP', xip: 4 }, { id: 2, position: 'GKP', xip: 2 },
  { id: 3, position: 'DEF', xip: 5 }, { id: 4, position: 'DEF', xip: 5 }, { id: 5, position: 'DEF', xip: 4 },
  { id: 6, position: 'DEF', xip: 3 }, { id: 7, position: 'DEF', xip: 1 },
  { id: 8, position: 'MID', xip: 8 }, { id: 9, position: 'MID', xip: 7 }, { id: 10, position: 'MID', xip: 6 },
  { id: 11, position: 'MID', xip: 5 }, { id: 12, position: 'MID', xip: 2.5 },
  { id: 13, position: 'FWD', xip: 9 }, { id: 14, position: 'FWD', xip: 6 }, { id: 15, position: 'FWD', xip: 2.2 },
];

const withDefaults = s => ({
  team: s.id, price: 50, ...s, purchase: s.purchase === undefined ? (s.price ?? 50) : s.purchase,
});

/**
 * An engine input: the base squad with `changes` merged in by id, plus
 * `candidates`. Prices and purchases in tenths; a purchase of null means no
 * ledger entry. Anything else overrides the input's defaults.
 */
export function scenario({ changes = [], candidates = [], planningGw = GW, ...input } = {}) {
  const byId = new Map(BASE.map(s => [s.id, s]));
  for (const c of changes) byId.set(c.id, { ...byId.get(c.id), ...c });
  const squad = [...byId.values()].map(withDefaults);
  const others = candidates.map(withDefaults);
  return {
    planningGw,
    squad: squad.map(s => ({ playerId: s.id, name: `P${s.id}`, position: s.position, teamId: s.team,
      priceTenths: s.price, purchaseTenths: s.purchase })),
    bankTenths: 0,
    freeTransfers: 1,
    chipPlan: {},
    chipsUsed: [],
    locks: new Set(),
    bans: new Set(),
    projections: new Map([...squad, ...others].map(s => [s.id, projectionOf(s, planningGw)])),
    candidates: others.map(s => ({ id: s.id, name: `P${s.id}`, position: s.position, teamId: s.team,
      price: s.price / 10 })),
    priceSignals: null,
    ...input,
  };
}

export const playerOf = (result, id) => result.players.find(p => p.playerId === id);
export const allBest = result => result.players.flatMap(p => MODES.map(m => p.best[m]).filter(Boolean));

