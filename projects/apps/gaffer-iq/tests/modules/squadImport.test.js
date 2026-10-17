/**
 * tests/modules/squadImport.test.js
 * Squad import for the decision engine (plan Phase 1): the real squad and bank
 * even in a Free Hit week, a purchase price for every player, and an import
 * that still works when the ledger endpoints do not. The network is replaced by
 * fetchers returning hand-built payloads in FPL's real shapes.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { store } from '../../js/store.js';
import { fetchAndMapSquad, loadLedger } from '../../js/squadImport.js';

// ─── Test utilities ──────────────────────────────────────────────────────────

/** Node has no localStorage; a Map-backed stand-in with the same three calls. */
function installLocalStorage() {
  const data = new Map();
  globalThis.localStorage = {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: key => { data.delete(key); },
  };
}

const PLAYERS = [
  { id: 11, name: 'Keeper',  position: 'GKP', teamId: 1, price: 5.0, costChangeStart: 2 },
  { id: 22, name: 'Mid',     position: 'MID', teamId: 2, price: 6.4, costChangeStart: 1 },
  { id: 33, name: 'Def',     position: 'DEF', teamId: 3, price: 4.5, costChangeStart: 0 },
  { id: 44, name: 'Freehit', position: 'MID', teamId: 4, price: 8.0, costChangeStart: 0 },
];

function rawPicks(elements, { activeChip = null, bank = 0, gw = 7 } = {}) {
  return {
    active_chip: activeChip,
    automatic_subs: [],
    entry_history: {
      event: gw, points: 50, total_points: 400, rank: 1, rank_sort: 1, overall_rank: 1,
      percentile_rank: 1, bank, value: 1000, event_transfers: 0, event_transfers_cost: 0,
      points_on_bench: 0,
    },
    picks: elements.map((element, i) => ({
      element, position: i + 1, multiplier: i === 0 ? 2 : 1,
      is_captain: i === 0, is_vice_captain: i === 1, element_type: 3,
    })),
  };
}

function rawHistory(firstGw, lastGw) {
  const current = [];
  for (let gw = firstGw; gw <= lastGw; gw++) {
    current.push({ event: gw, points: 50, total_points: 50 * gw, rank: 1, rank_sort: 1,
      overall_rank: 1, percentile_rank: 1, bank: 0, value: 1000, event_transfers: 0,
      event_transfers_cost: 0, points_on_bench: 0 });
  }
  return { current, past: [], chips: [] };
}

const rawTransfer = (elementIn, cost, gw) => ({
  element_in: elementIn, element_in_cost: cost, element_out: 99, element_out_cost: 40,
  entry: 123, event: gw, time: `2026-09-0${gw}T10:00:00Z`,
});

/** Fetchers with the real signatures; records which gameweeks and players were asked for. */
function fakeFetchers({ picksByGw, transfers = [], history = rawHistory(1, 7), summaries = {} }) {
  const calls = { picks: [], summary: [] };
  const answer = value => (typeof value === 'function' ? value() : value);
  return {
    calls,
    fetchers: {
      picks:     async (teamId, gw) => { calls.picks.push(gw); return picksByGw[gw]; },
      info:      async teamId => ({ id: teamId, name: 'Test XI', started_event: 1 }),
      transfers: async () => answer(transfers),
      history:   async () => answer(history),
      summary:   async playerId => { calls.summary.push(playerId); return summaries[playerId]; },
    },
  };
}

beforeEach(() => {
  installLocalStorage();
  store.setSeason({ players: PLAYERS, playersById: Object.fromEntries(PLAYERS.map(p => [p.id, p])) });
});

// ─── The squad and bank ──────────────────────────────────────────────────────

test('fetchAndMapSquad imports the squad and bank of the gameweek asked for', async () => {
  const { fetchers } = fakeFetchers({ picksByGw: { 7: rawPicks([11, 22, 33], { bank: 15 }) } });
  const result = await fetchAndMapSquad(123, 7, fetchers);
  assert.deepEqual(result.playerIds, [11, 22, 33]);
  assert.equal(result.bankTenths, 15);
  assert.equal(result.squadGw, 7);
});

test('fetchAndMapSquad imports the squad from the week before a Free Hit', async () => {
  // During a Free Hit week the picks are the temporary squad; the real squad,
  // and its bank, are the ones the week before.
  const { fetchers, calls } = fakeFetchers({ picksByGw: {
    7: rawPicks([11, 44, 33], { activeChip: 'freehit', bank: 0 }),
    6: rawPicks([11, 22, 33], { bank: 23, gw: 6 }),
  } });
  const result = await fetchAndMapSquad(123, 7, fetchers);
  assert.deepEqual(calls.picks, [7, 6]);
  assert.deepEqual(result.playerIds, [11, 22, 33]);
  assert.equal(result.bankTenths, 23);
  assert.equal(result.squadGw, 6);
});

// ─── The purchase-price ledger ───────────────────────────────────────────────

test('fetchAndMapSquad prices each player at what was paid for him', async () => {
  // 22 and 33 were bought by transfer; 11 has been owned since GW1, so he cost
  // his start-of-season price: £5.0m now, up £0.2m since the start -> £4.8m.
  const { fetchers, calls } = fakeFetchers({
    picksByGw: { 7: rawPicks([11, 22, 33]) },
    transfers: [rawTransfer(22, 62, 3), rawTransfer(33, 45, 5)],
  });
  const result = await fetchAndMapSquad(123, 7, fetchers);
  assert.deepEqual(result.purchasesTenths, { 11: 48, 22: 62, 33: 45 });
  assert.deepEqual(calls.summary, []);
});

test('fetchAndMapSquad prices a late starter\'s original players from the week the squad was built', async () => {
  // This manager's first gameweek was GW5: player 11 cost what he cost then.
  const { fetchers, calls } = fakeFetchers({
    picksByGw: { 7: rawPicks([11, 22, 33]) },
    transfers: [rawTransfer(22, 62, 6), rawTransfer(33, 45, 6)],
    history: rawHistory(5, 7),
    summaries: { 11: {
      history: [
        { round: 4, fixture: 31, opponent_team: 2, was_home: true, minutes: 90, total_points: 2, value: 47 },
        { round: 5, fixture: 41, opponent_team: 3, was_home: false, minutes: 90, total_points: 6, value: 49 },
      ],
      history_past: [],
      fixtures: [],
    } },
  });
  const result = await fetchAndMapSquad(123, 7, fetchers);
  assert.deepEqual(calls.summary, [11]);
  assert.deepEqual(result.purchasesTenths, { 11: 49, 22: 62, 33: 45 });
});

test('fetchAndMapSquad still imports the squad when the ledger endpoints fail', async t => {
  t.mock.method(console, 'warn', () => {});
  const fail = () => { throw new Error('Proxy 400 - path not allowed'); };
  const { fetchers } = fakeFetchers({
    picksByGw: { 7: rawPicks([11, 22, 33], { bank: 15 }) },
    transfers: fail,
    history: fail,
  });
  const result = await fetchAndMapSquad(123, 7, fetchers);
  assert.deepEqual(result.playerIds, [11, 22, 33]);
  assert.equal(result.bankTenths, 15);
  // Without the transfer list nobody's purchase price is known; every player
  // then falls back to his current price, flagged estimated, downstream.
  assert.deepEqual(result.purchasesTenths, {});
  assert.equal(result.history, null);
});

test('fetchAndMapSquad saves the ledger so it survives a reload', async () => {
  const { fetchers } = fakeFetchers({
    picksByGw: { 7: rawPicks([11, 22, 33], { bank: 15 }) },
    transfers: [rawTransfer(22, 62, 3), rawTransfer(33, 45, 5)],
  });
  await fetchAndMapSquad(123, 7, fetchers);
  const saved = loadLedger();
  assert.equal(saved.teamId, 123);
  assert.equal(saved.bankTenths, 15);
  assert.deepEqual(saved.purchasesTenths, { 11: 48, 22: 62, 33: 45 });
  assert.deepEqual(saved.history.gws.map(g => g.gw), [1, 2, 3, 4, 5, 6, 7]);
});
