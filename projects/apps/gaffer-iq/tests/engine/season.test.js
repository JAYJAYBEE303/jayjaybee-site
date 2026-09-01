/**
 * tests/engine/season.test.js
 * Unit tests for engine/season.js. Pure-function tests only (CONVENTIONS §3.3).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildGameweekMatchups } from '../../js/engine/season.js';

/**
 * Minimal ctx double. buildGameweekMatchups only reads `fixtures` and
 * `teamsById`, and takes scoreFixture by injection so these tests never depend
 * on the real composite model.
 */
function ctxWith(fixtures, teamIds = [1, 2, 3, 4, 5, 6]) {
  const teamsById = {};
  for (const id of teamIds) teamsById[id] = { id, name: `T${id}`, shortName: `T${id}` };
  return { fixtures, teamsById };
}

// Scores a fixture by a lookup keyed "fixtureId:teamId", so each test states
// exactly which side is favoured and by how much.
function scorerFrom(table) {
  return (team, fixture) => ({ value: table[`${fixture.id}:${team.id}`] ?? 50, band: 'neutral' });
}

test('buildGameweekMatchups scores both sides and keeps the higher one', () => {
  const ctx = ctxWith([{ id: 10, gw: 5, homeTeamId: 1, awayTeamId: 2 }]);
  const score = scorerFrom({ '10:1': 82, '10:2': 18 });
  const [m] = buildGameweekMatchups(5, ctx, { score });
  assert.equal(m.value, 82);
  assert.equal(m.favouredId, 1);
});

test('buildGameweekMatchups favours the away side when it scores higher', () => {
  const ctx = ctxWith([{ id: 10, gw: 5, homeTeamId: 1, awayTeamId: 2 }]);
  const score = scorerFrom({ '10:1': 31, '10:2': 77 });
  const [m] = buildGameweekMatchups(5, ctx, { score });
  assert.equal(m.value, 77);
  assert.equal(m.favouredId, 2);
});

test('buildGameweekMatchups returns the top three, descending', () => {
  const ctx = ctxWith([
    { id: 10, gw: 5, homeTeamId: 1, awayTeamId: 2 },
    { id: 11, gw: 5, homeTeamId: 3, awayTeamId: 4 },
    { id: 12, gw: 5, homeTeamId: 5, awayTeamId: 6 },
    { id: 13, gw: 5, homeTeamId: 2, awayTeamId: 3 },
  ]);
  const score = scorerFrom({ '10:1': 60, '11:3': 90, '12:5': 75, '13:2': 40 });
  const out = buildGameweekMatchups(5, ctx, { score });
  assert.equal(out.length, 3);
  assert.deepEqual(out.map(m => m.value), [90, 75, 60]);
});

test('buildGameweekMatchups ignores other gameweeks and unscheduled fixtures', () => {
  const ctx = ctxWith([
    { id: 10, gw: 5, homeTeamId: 1, awayTeamId: 2 },
    { id: 11, gw: 6, homeTeamId: 3, awayTeamId: 4 },
    { id: 12, gw: null, homeTeamId: 5, awayTeamId: 6 },
  ]);
  const out = buildGameweekMatchups(5, ctx, { score: scorerFrom({}) });
  assert.equal(out.length, 1);
  assert.equal(out[0].fixtureId, 10);
});

test('buildGameweekMatchups flags a fixture whose team plays twice that week', () => {
  const ctx = ctxWith([
    { id: 10, gw: 5, homeTeamId: 1, awayTeamId: 2 },
    { id: 11, gw: 5, homeTeamId: 1, awayTeamId: 3 },
  ]);
  const out = buildGameweekMatchups(5, ctx, { score: scorerFrom({}) });
  assert.equal(out.every(m => m.isDouble), true);
});

test('buildGameweekMatchups leaves a single-fixture week unflagged', () => {
  const ctx = ctxWith([{ id: 10, gw: 5, homeTeamId: 1, awayTeamId: 2 }]);
  const [m] = buildGameweekMatchups(5, ctx, { score: scorerFrom({}) });
  assert.equal(m.isDouble, false);
});
