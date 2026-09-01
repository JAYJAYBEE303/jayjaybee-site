/**
 * tests/engine/season.test.js
 * Unit tests for engine/season.js. Pure-function tests only (CONVENTIONS §3.3).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGameweekMatchups, isLoadedWeek, attributePostponements, fillMatchupSlots,
  buildGameweekPlayers,
} from '../../js/engine/season.js';

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

// ─── isLoadedWeek ───────────────────────────────────────────────────────────

// A row as isLoadedWeek sees it: only `value` and `postponed` matter.
const row = (value, postponed = false) => ({ value, postponed });

test('isLoadedWeek is true once two matchups reach the great band', () => {
  // BANDS.great is the threshold; 90 and 80 clear it, 40 does not.
  assert.equal(isLoadedWeek([row(90), row(80), row(40)]), true);
});

test('isLoadedWeek is false when only one matchup reaches the great band', () => {
  // One blowout is an ordinary week with a good fixture in it, not a loaded one.
  assert.equal(isLoadedWeek([row(90), row(60), row(40)]), false);
});

test('isLoadedWeek does not count a postponed row toward the threshold', () => {
  // A postponed row carries value: null. It must neither count nor throw on
  // the comparison — the guard order in isLoadedWeek is what prevents both.
  assert.equal(isLoadedWeek([row(90), row(null, true), row(null, true)]), false);
});

// ─── attributePostponements ────────────────────────────────────────────────────

/** ctx whose scheduled fixtures pair up teams across the given gameweeks. */
function scheduleCtx(fixtures, teamIds) {
  const teamsById = {};
  for (const id of teamIds) teamsById[id] = { id };
  return { fixtures, teamsById };
}

test('attributePostponements places a pending tie in the week both clubs are blank', () => {
  // GW5: teams 1 and 2 have no fixture, everyone else plays. The pending 1v2
  // tie is the hole's obvious cause.
  const ctx = scheduleCtx([
    { id: 20, gw: 5, homeTeamId: 3, awayTeamId: 4 },
    { id: 21, gw: 6, homeTeamId: 1, awayTeamId: 3 },
    { id: 22, gw: 6, homeTeamId: 2, awayTeamId: 4 },
  ], [1, 2, 3, 4]);
  const pending = [{ id: 99, gw: null, homeTeamId: 1, awayTeamId: 2 }];
  const map = attributePostponements(pending, ctx);
  assert.deepEqual(map.get(5).map(f => f.id), [99]);
});

test('attributePostponements ignores a week where only one club is blank', () => {
  // Team 1 is blank in GW5 but team 2 plays, so the 1v2 tie cannot have been
  // removed from GW5.
  const ctx = scheduleCtx([
    { id: 20, gw: 5, homeTeamId: 2, awayTeamId: 3 },
    { id: 21, gw: 6, homeTeamId: 1, awayTeamId: 2 },
  ], [1, 2, 3]);
  const pending = [{ id: 99, gw: null, homeTeamId: 1, awayTeamId: 2 }];
  const map = attributePostponements(pending, ctx);
  assert.equal(map.has(5), false);
});

test('attributePostponements picks the earliest matching week', () => {
  // Both clubs are blank in GW5 and again in GW9. The postponement left its
  // hole at the original date; the rearranged date is always later.
  const ctx = scheduleCtx([
    { id: 20, gw: 5, homeTeamId: 3, awayTeamId: 4 },
    { id: 21, gw: 9, homeTeamId: 3, awayTeamId: 4 },
    { id: 22, gw: 6, homeTeamId: 1, awayTeamId: 2 },
  ], [1, 2, 3, 4]);
  const pending = [{ id: 99, gw: null, homeTeamId: 1, awayTeamId: 2 }];
  const map = attributePostponements(pending, ctx);
  assert.equal(map.has(5), true);
  assert.equal(map.has(9), false);
});

test('attributePostponements gives two ties in one week both slots', () => {
  const ctx = scheduleCtx([
    { id: 20, gw: 5, homeTeamId: 5, awayTeamId: 6 },
    { id: 21, gw: 6, homeTeamId: 1, awayTeamId: 5 },
    { id: 22, gw: 6, homeTeamId: 2, awayTeamId: 6 },
    { id: 23, gw: 6, homeTeamId: 3, awayTeamId: 5 },
    { id: 24, gw: 6, homeTeamId: 4, awayTeamId: 6 },
  ], [1, 2, 3, 4, 5, 6]);
  const pending = [
    { id: 98, gw: null, homeTeamId: 1, awayTeamId: 2 },
    { id: 99, gw: null, homeTeamId: 3, awayTeamId: 4 },
  ];
  const map = attributePostponements(pending, ctx);
  assert.deepEqual(map.get(5).map(f => f.id).sort(), [98, 99]);
});

test('attributePostponements returns an empty map when nothing is pending', () => {
  const ctx = scheduleCtx([{ id: 20, gw: 5, homeTeamId: 1, awayTeamId: 2 }], [1, 2]);
  assert.equal(attributePostponements([], ctx).size, 0);
});

test('attributePostponements ignores weeks with no fixtures at all', () => {
  // GW7 has no scheduled fixtures anywhere — an unplayed part of the season,
  // not a hole. Every club is "blank", which must not swallow every pending tie.
  const ctx = scheduleCtx([{ id: 20, gw: 5, homeTeamId: 1, awayTeamId: 2 }], [1, 2, 3, 4]);
  const pending = [{ id: 99, gw: null, homeTeamId: 3, awayTeamId: 4 }];
  const map = attributePostponements(pending, ctx);
  assert.equal(map.has(7), false);
});

// ─── fillMatchupSlots ──────────────────────────────────────────────────────────

const live = n => Array.from({ length: n }, (_, i) => ({
  fixtureId: 100 + i, value: 90 - i * 10, postponed: false,
}));
const pp = n => Array.from({ length: n }, (_, i) => ({
  id: 200 + i, homeTeamId: 1, awayTeamId: 2,
}));

test('fillMatchupSlots leaves a clean week untouched', () => {
  const out = fillMatchupSlots(live(3), []);
  assert.equal(out.length, 3);
  assert.equal(out.some(m => m.postponed), false);
  assert.deepEqual(out.map(m => m.value), [90, 80, 70]);
});

test('fillMatchupSlots puts one postponement in the LAST slot', () => {
  const out = fillMatchupSlots(live(3), pp(1));
  assert.equal(out.length, 3);
  assert.deepEqual(out.map(m => m.postponed), [false, false, true]);
  // Slot 1 keeps the week's genuine best fixture.
  assert.equal(out[0].value, 90);
});

test('fillMatchupSlots fills upward for two postponements', () => {
  const out = fillMatchupSlots(live(3), pp(2));
  assert.deepEqual(out.map(m => m.postponed), [false, true, true]);
  assert.equal(out[0].value, 90);
});

test('fillMatchupSlots keeps slot 1 live even with three postponements', () => {
  // Three would fill every slot; slot 1 is reserved for a real fixture
  // whenever one exists, because that is the whole point of the ordering.
  const out = fillMatchupSlots(live(3), pp(3));
  assert.deepEqual(out.map(m => m.postponed), [false, true, true]);
});

test('fillMatchupSlots allows an all-postponed week when nothing is live', () => {
  const out = fillMatchupSlots([], pp(2));
  assert.deepEqual(out.map(m => m.postponed), [true, true]);
});

test('fillMatchupSlots marks postponed rows as unscored', () => {
  const [row] = fillMatchupSlots([], pp(1));
  assert.equal(row.value, null);
  assert.equal(row.favouredId, null);
  assert.equal(row.homeId, 1);
  assert.equal(row.awayId, 2);
});

// ─── buildGameweekPlayers ──────────────────────────────────────────────────

function playerCtx(fixtures) {
  return {
    fixtures,
    teamsById: { 1: { id: 1 }, 2: { id: 2 } },
    playersByTeamId: {
      1: [
        { id: 11, teamId: 1, name: 'Alpha', position: 'FWD', price: 10 },
        { id: 12, teamId: 1, name: 'Bravo', position: 'MID', price: 8 },
      ],
      2: [{ id: 21, teamId: 2, name: 'Charlie', position: 'DEF', price: 5 }],
    },
  };
}
// Projection injection: every player scores its own id, so ordering is exact.
const projectFrom = table => (player, fixtureCount) =>
  ({ value: (table[player.id] ?? 0) * fixtureCount, estimated: false });

test('buildGameweekPlayers ranks the league for one gameweek', () => {
  const ctx = playerCtx([{ id: 30, gw: 5, homeTeamId: 1, awayTeamId: 2 }]);
  const out = buildGameweekPlayers(5, ctx, new Map(), {
    project: projectFrom({ 11: 9, 12: 4, 21: 6 }),
  });
  assert.deepEqual(out.map(p => p.playerId), [11, 21, 12]);
  assert.equal(out[0].points, 9);
});

test('buildGameweekPlayers excludes clubs with no fixture that week', () => {
  const ctx = playerCtx([{ id: 30, gw: 5, homeTeamId: 1, awayTeamId: 2 }]);
  ctx.fixtures.push({ id: 31, gw: 6, homeTeamId: 1, awayTeamId: 2 });
  ctx.playersByTeamId[3] = [{ id: 31, teamId: 3, name: 'Delta', position: 'MID', price: 6 }];
  ctx.teamsById[3] = { id: 3 };
  const out = buildGameweekPlayers(5, ctx, new Map(), {
    project: projectFrom({ 11: 9, 12: 4, 21: 6, 31: 100 }),
  });
  assert.equal(out.some(p => p.playerId === 31), false);
});

test('buildGameweekPlayers passes the fixture count through for a double', () => {
  const ctx = playerCtx([
    { id: 30, gw: 5, homeTeamId: 1, awayTeamId: 2 },
    { id: 31, gw: 5, homeTeamId: 1, awayTeamId: 2 },
  ]);
  const out = buildGameweekPlayers(5, ctx, new Map(), {
    project: projectFrom({ 11: 5, 12: 1, 21: 1 }),
  });
  // Team 1 plays twice, so its projection doubles; team 2 also plays twice.
  assert.equal(out[0].playerId, 11);
  assert.equal(out[0].points, 10);
});

test('buildGameweekPlayers caps at SEASON_TOP_PLAYERS', () => {
  const ctx = playerCtx([{ id: 30, gw: 5, homeTeamId: 1, awayTeamId: 2 }]);
  ctx.playersByTeamId[1].push(
    { id: 13, teamId: 1, name: 'E', position: 'MID', price: 5 },
    { id: 14, teamId: 1, name: 'F', position: 'MID', price: 5 },
    { id: 15, teamId: 1, name: 'G', position: 'MID', price: 5 },
    { id: 16, teamId: 1, name: 'H', position: 'MID', price: 5 },
  );
  const out = buildGameweekPlayers(5, ctx, new Map(), { project: projectFrom({}) });
  assert.equal(out.length, 5);
});

test('buildGameweekPlayers returns nothing for a gameweek with no fixtures', () => {
  const ctx = playerCtx([{ id: 30, gw: 5, homeTeamId: 1, awayTeamId: 2 }]);
  assert.deepEqual(buildGameweekPlayers(9, ctx, new Map(), { project: projectFrom({}) }), []);
});
