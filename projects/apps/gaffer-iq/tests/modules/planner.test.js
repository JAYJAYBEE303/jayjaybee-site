/**
 * tests/modules/planner.test.js
 * Pure-function tests only (CONVENTIONS §3.3): the planner's settings, the
 * engine input it builds from the store's data, and the sell/hold sort. No DOM
 * and no store involvement.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveSettings, chipsUsedList, decisionSquad, gwTableFor, sortSellHold,
} from '../../js/modules/planner.js';

const NONE_USED = { wildcard: [false, false], freehit: [false, false],
  benchboost: [false, false], triplecaptain: [false, false] };

/** A ledger as squadImport.js saves it: GW1-3 played, a Wildcard in GW3. */
const LEDGER = {
  teamId: 7, importedAt: 1000, squadGw: 3, bankTenths: 15, purchasesTenths: { 10: 75 },
  history: { gws: [{ gw: 1, transfers: 0 }, { gw: 2, transfers: 0 }, { gw: 3, transfers: 4 }],
    chips: [{ chip: 'wildcard', gw: 3 }] },
};

// ─── Settings ────────────────────────────────────────────────────────────────

test('with no import the plan starts from an empty bank, one free transfer and no chips used', () => {
  assert.deepEqual(resolveSettings(null, null, 4),
    { bankTenths: 0, freeTransfers: 1, chipPlan: {}, used: NONE_USED });
});

test('an import supplies the bank, the free transfers banked for the planning GW and the chips played', () => {
  // GW1 leaves one, GW2 rolls it to two, the GW3 Wildcard freezes the count.
  const settings = resolveSettings(LEDGER, null, 4);
  assert.equal(settings.bankTenths, 15);
  assert.equal(settings.freeTransfers, 2);
  assert.deepEqual(settings.used, { ...NONE_USED, wildcard: [true, false] });
});

test('before the first deadline transfers are unlimited, so nothing is charged for one', () => {
  const ledger = { ...LEDGER, history: { gws: [], chips: [] } };
  assert.equal(resolveSettings(ledger, null, 1).freeTransfers, 5);
  // No history at all (its fetch failed) is not the same thing.
  assert.equal(resolveSettings({ ...LEDGER, history: null }, null, 4).freeTransfers, 1);
});

test('your bank and free transfers stand for the import and planning GW you set them for', () => {
  const saved = { importedAt: 1000, planningGw: 4, bankTenths: 3, freeTransfers: 0,
    chipPlan: { 6: 'benchboost' }, used: { ...NONE_USED, freehit: [true, false] } };
  const same = resolveSettings(LEDGER, saved, 4);
  assert.equal(same.bankTenths, 3);
  assert.equal(same.freeTransfers, 0);
  assert.deepEqual(same.chipPlan, { 6: 'benchboost' });
  assert.deepEqual(same.used, { ...NONE_USED, freehit: [true, false] });

  // A GW on, the import's figures are derived again; the chip plan and the
  // chips you marked stay.
  const later = resolveSettings(LEDGER, saved, 5);
  assert.equal(later.bankTenths, 15);
  assert.equal(later.freeTransfers, 2);
  assert.deepEqual(later.chipPlan, { 6: 'benchboost' });
  assert.deepEqual(later.used, { ...NONE_USED, freehit: [true, false] });

  // A new import replaces everything it knows about.
  const reimported = resolveSettings({ ...LEDGER, importedAt: 2000 }, saved, 4);
  assert.equal(reimported.bankTenths, 15);
  assert.deepEqual(reimported.used, { ...NONE_USED, wildcard: [true, false] });
  assert.deepEqual(reimported.chipPlan, { 6: 'benchboost' });
});

test('a chip used in a half reaches the engine as one entry for that half', () => {
  const used = { ...NONE_USED, wildcard: [true, false], benchboost: [true, true] };
  assert.deepEqual(chipsUsedList(used), [
    { chip: 'wildcard', gw: 1 }, { chip: 'benchboost', gw: 1 }, { chip: 'benchboost', gw: 20 },
  ]);
});

// ─── Engine input ────────────────────────────────────────────────────────────

test('the engine squad is priced in tenths, with no purchase price where the ledger has none', () => {
  const players = [
    { id: 10, name: 'Saka', position: 'MID', teamId: 1, price: 10.1 },
    { id: 11, name: 'Raya', position: 'GKP', teamId: 1, price: 5.6 },
  ];
  assert.deepEqual(decisionSquad(players, { 10: 75 }), [
    { playerId: 10, name: 'Saka', position: 'MID', teamId: 1, priceTenths: 101, purchaseTenths: 75 },
    { playerId: 11, name: 'Raya', position: 'GKP', teamId: 1, priceTenths: 56, purchaseTenths: null },
  ]);
});

test('the minutes table is used only when it holds every finished GW before the planning GW', () => {
  const events = [{ id: 1, complete: true }, { id: 2, complete: true }, { id: 3, complete: false }];
  const tables = [{ gw: 1, players: [] }, { gw: 2, players: [] }];
  assert.equal(gwTableFor(tables, events, 3), tables);
  assert.equal(gwTableFor(tables.slice(1), events, 3), null, 'GW1 missing');
  assert.equal(gwTableFor([], events, 3), null);
  assert.equal(gwTableFor([], [], 1), null, 'nothing played yet');
});

// ─── Sell / hold table ───────────────────────────────────────────────────────

test('the sell/hold table sorts either way with players who have no figure last', () => {
  const rows = [
    { name: 'B', out: null }, { name: 'A', out: 1.5 }, { name: 'C', out: -2 }, { name: 'D', out: 1.5 },
  ];
  assert.deepEqual(sortSellHold(rows, 'out', true).map(r => r.name), ['A', 'D', 'C', 'B']);
  assert.deepEqual(sortSellHold(rows, 'out', false).map(r => r.name), ['C', 'A', 'D', 'B']);
  assert.deepEqual(sortSellHold(rows, 'name', false).map(r => r.name), ['A', 'B', 'C', 'D']);
});
