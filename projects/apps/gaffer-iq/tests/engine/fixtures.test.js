/**
 * tests/engine/fixtures.test.js
 * Unit tests for engine/fixtures.js. Pure-function tests only (CONVENTIONS §3.3).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  groupPerGwSlots, pendingFixturesForTeam, summariseGwIrregularities,
} from '../../js/engine/fixtures.js';

// ─── groupPerGwSlots ─────────────────────────────────────────────────────────

test('groupPerGwSlots gives one slot per gameweek for a plain run', () => {
  const slots = groupPerGwSlots([
    { gw: 23, opponent: 'BUR', isBlank: false },
    { gw: 24, opponent: 'ARS', isBlank: false },
  ]);
  assert.equal(slots.length, 2);
  assert.equal(slots[0].fixtures.length, 1);
  assert.equal(slots[0].isDouble, false);
  assert.equal(slots[0].isBlank, false);
});

test('groupPerGwSlots folds a double into one slot holding two fixtures', () => {
  // The whole point: perGw carries two entries with the SAME gw, and the strip
  // must render them as one week rather than as two separate weeks.
  const slots = groupPerGwSlots([
    { gw: 24, opponent: 'EVE', isBlank: false },
    { gw: 24, opponent: 'SHU', isBlank: false },
    { gw: 25, opponent: 'ARS', isBlank: false },
  ]);
  assert.equal(slots.length, 2);
  assert.equal(slots[0].gw, 24);
  assert.equal(slots[0].fixtures.length, 2);
  assert.equal(slots[0].isDouble, true);
  assert.equal(slots[1].isDouble, false);
});

test('groupPerGwSlots marks a blank slot and keeps it in sequence', () => {
  const slots = groupPerGwSlots([
    { gw: 25, opponent: 'ARS', isBlank: false },
    { gw: 26, opponent: null,  isBlank: true  },
    { gw: 27, opponent: 'MCI', isBlank: false },
  ]);
  assert.equal(slots.length, 3);
  assert.equal(slots[1].isBlank, true);
  assert.equal(slots[1].isDouble, false);
});

test('groupPerGwSlots orders slots by gameweek regardless of input order', () => {
  // perGw is built in window order today, but the slot sequence is what the
  // strip renders left to right — it must not depend on that staying true.
  const slots = groupPerGwSlots([
    { gw: 27, isBlank: false }, { gw: 24, isBlank: false }, { gw: 24, isBlank: false },
  ]);
  assert.deepEqual(slots.map(s => s.gw), [24, 27]);
});

test('groupPerGwSlots returns an empty array for empty or missing input', () => {
  assert.deepEqual(groupPerGwSlots([]), []);
  assert.deepEqual(groupPerGwSlots(null), []);
  assert.deepEqual(groupPerGwSlots(undefined), []);
});

// ─── pendingFixturesForTeam ──────────────────────────────────────────────────

test('pendingFixturesForTeam returns nothing when the team has no postponements', () => {
  assert.deepEqual(pendingFixturesForTeam(1, { pendingFixturesByTeam: {} }), []);
});

test('pendingFixturesForTeam returns nothing when the index is absent', () => {
  // Defensive: a ctx built before this field existed must not throw.
  assert.deepEqual(pendingFixturesForTeam(1, {}), []);
  assert.deepEqual(pendingFixturesForTeam(1, null), []);
});

test('pendingFixturesForTeam returns the team postponed fixtures', () => {
  const f = { id: 9, gw: null, homeTeamId: 1, awayTeamId: 2 };
  const out = pendingFixturesForTeam(1, { pendingFixturesByTeam: { 1: [f] } });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 9);
});

// ─── summariseGwIrregularities ───────────────────────────────────────────────

test('summariseGwIrregularities returns nothing for an ordinary window', () => {
  // Two teams, one fixture each per gameweek. The context bar must stay hidden —
  // this is the common case for most of the season.
  const ctx = {
    fixtures: [
      { gw: 23, homeTeamId: 1, awayTeamId: 2 },
      { gw: 24, homeTeamId: 2, awayTeamId: 1 },
    ],
    teams: [{ id: 1 }, { id: 2 }],
  };
  assert.deepEqual(summariseGwIrregularities(ctx, 23, 2), []);
});

test('summariseGwIrregularities counts doubling and idle teams', () => {
  // GW24: team 1 plays twice, team 3 not at all, teams 2 and 4 once each.
  const ctx = {
    fixtures: [
      { gw: 24, homeTeamId: 1, awayTeamId: 2 },
      { gw: 24, homeTeamId: 1, awayTeamId: 4 },
    ],
    teams: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
  };
  const out = summariseGwIrregularities(ctx, 24, 1);
  assert.equal(out.length, 1);
  assert.equal(out[0].gw, 24);
  assert.equal(out[0].doubleTeams, 1);
  assert.equal(out[0].blankTeams, 1);
});

test('summariseGwIrregularities skips ordinary gameweeks inside a mixed window', () => {
  // Only the irregular gameweek is reported, so the bar never renders a row
  // that says "GW23 is normal".
  const ctx = {
    fixtures: [
      { gw: 23, homeTeamId: 1, awayTeamId: 2 },
      { gw: 24, homeTeamId: 1, awayTeamId: 2 },
      { gw: 24, homeTeamId: 1, awayTeamId: 2 },
    ],
    teams: [{ id: 1 }, { id: 2 }],
  };
  const out = summariseGwIrregularities(ctx, 23, 2);
  assert.equal(out.length, 1);
  assert.equal(out[0].gw, 24);
});

test('summariseGwIrregularities returns nothing without teams or a valid start', () => {
  assert.deepEqual(summariseGwIrregularities({ fixtures: [], teams: [] }, 1, 6), []);
  assert.deepEqual(summariseGwIrregularities({ fixtures: [], teams: [{ id: 1 }] }, null, 6), []);
});
