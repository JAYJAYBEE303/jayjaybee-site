/**
 * tests/engine/ledger.test.js
 * Unit tests for engine/ledger.js. Pure-function tests only (CONVENTIONS §3.3).
 * Inputs are the normalised entry payloads (engine/normalise.js); money is in
 * integer tenths of a million.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPurchaseLedger, deriveFreeTransfers } from '../../js/engine/ledger.js';

const buy = (inId, inCostTenths, gw, time = `2026-08-${10 + gw}T10:00:00Z`) =>
  ({ inId, inCostTenths, outId: 999, outCostTenths: 40, gw, time });
const sell = (outId, gw) =>
  ({ inId: 998, inCostTenths: 40, outId, outCostTenths: 50, gw, time: `2026-08-${10 + gw}T11:00:00Z` });
const noInitialPrice = () => null;

// ─── buildPurchaseLedger ─────────────────────────────────────────────────────

test('buildPurchaseLedger prices a bought player at what he cost', () => {
  const ledger = buildPurchaseLedger([buy(5, 62, 4)], [5], noInitialPrice);
  assert.equal(ledger.get(5), 62);
});

test('buildPurchaseLedger uses the latest purchase of a player bought twice', () => {
  // Bought at £6.0m, sold, bought back at £6.5m - he cost £6.5m. Listed out of
  // order on purpose: the endpoint's ordering is not part of its contract.
  const ledger = buildPurchaseLedger([buy(5, 65, 8), buy(5, 60, 3), sell(5, 6)], [5], noInitialPrice);
  assert.equal(ledger.get(5), 65);
});

test('buildPurchaseLedger prices a player held from the start at his starting price', () => {
  const ledger = buildPurchaseLedger([], [7], id => (id === 7 ? 80 : null));
  assert.equal(ledger.get(7), 80);
});

test('buildPurchaseLedger leaves out a player whose purchase price is unknown', () => {
  const ledger = buildPurchaseLedger([], [7], noInitialPrice);
  assert.equal(ledger.has(7), false);
});

test('buildPurchaseLedger ignores players no longer in the squad', () => {
  const ledger = buildPurchaseLedger([buy(9, 70, 2), sell(9, 5)], [7], id => (id === 7 ? 80 : null));
  assert.deepEqual([...ledger.keys()], [7]);
});

test('buildPurchaseLedger does not reprice the squad a Free Hit week reverts to', () => {
  // Free Hit in GW10 sold the starting-squad player 7 for player 12; at the end
  // of the week the squad reverted, so 7 is still owned at his starting price.
  const transfers = [sell(7, 10), buy(12, 75, 10)];
  const ledger = buildPurchaseLedger(transfers, [7], id => (id === 7 ? 80 : null));
  assert.equal(ledger.get(7), 80);
});

// ─── deriveFreeTransfers ─────────────────────────────────────────────────────

const history = (rows, chips = []) => ({
  gws: rows.map(([gw, transfers]) => ({ gw, transfers, transfersCost: 0, bankTenths: 0 })),
  chips,
});

test('deriveFreeTransfers gives one free transfer after the first gameweek', () => {
  assert.equal(deriveFreeTransfers(history([[1, 0]]), 2), 1);
});

test('deriveFreeTransfers banks an unused free transfer', () => {
  assert.equal(deriveFreeTransfers(history([[1, 0], [2, 0]]), 3), 2);
});

test('deriveFreeTransfers caps banked free transfers at five', () => {
  const rows = [1, 2, 3, 4, 5, 6, 7, 8].map(gw => [gw, 0]);
  assert.equal(deriveFreeTransfers(history(rows), 9), 5);
});

test('deriveFreeTransfers spends free transfers before banking the next', () => {
  assert.equal(deriveFreeTransfers(history([[1, 0], [2, 0], [3, 2]]), 4), 1);
});

test('deriveFreeTransfers never drops below one after taking a hit', () => {
  assert.equal(deriveFreeTransfers(history([[1, 0], [2, 3]]), 3), 1);
});

test('deriveFreeTransfers freezes free transfers through a Wildcard week', () => {
  const rows = [[1, 0], [2, 0], [3, 9], [4, 0]];
  assert.equal(deriveFreeTransfers(history(rows, [{ chip: 'wildcard', gw: 3 }]), 5), 3);
});

test('deriveFreeTransfers freezes free transfers through a Free Hit week', () => {
  const rows = [[1, 0], [2, 0], [3, 9], [4, 0]];
  assert.equal(deriveFreeTransfers(history(rows, [{ chip: 'freehit', gw: 3 }]), 5), 3);
});

test('deriveFreeTransfers ignores a Bench Boost week', () => {
  const rows = [[1, 0], [2, 0], [3, 1]];
  assert.equal(deriveFreeTransfers(history(rows, [{ chip: 'benchboost', gw: 3 }]), 4), 2);
});

test('deriveFreeTransfers counts the live gameweek when planning the next one', () => {
  // GW4 is being played, so the planner plans GW5: GW4's roll-over is banked.
  const rows = [[1, 0], [2, 0], [3, 0], [4, 0]];
  assert.equal(deriveFreeTransfers(history(rows), 5), 4);
});

test('deriveFreeTransfers ignores gameweeks from the planning gameweek on', () => {
  const rows = [[1, 0], [2, 0], [3, 0], [4, 0], [5, 0]];
  assert.equal(deriveFreeTransfers(history(rows), 4), 3);
});

test('deriveFreeTransfers reads gameweeks in order whatever order they arrive in', () => {
  assert.equal(deriveFreeTransfers(history([[3, 2], [1, 0], [2, 0]]), 4), 1);
});

test('deriveFreeTransfers returns null before the first deadline has passed', () => {
  // A new squad's first deadline has unlimited transfers: there is no count yet.
  assert.equal(deriveFreeTransfers(history([]), 1), null);
});
