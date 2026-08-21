/**
 * tests/engine/channel.test.js
 * Unit tests for engine/channel.js. Pure-function tests only (CONVENTIONS §3.3).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildUnderstatSlugsByTeamId } from '../../js/engine/channel.js';

const leagueXg = { teamsData: {
  83:  { id: '83',  title: 'Arsenal' },
  88:  { id: '88',  title: 'Manchester City' },
  229: { id: '229', title: 'Wolverhampton Wanderers' },
} };

const teamsById = {
  1:  { id: 1,  name: 'Arsenal',   shortName: 'ARS' },
  13: { id: 13, name: 'Man City',  shortName: 'MCI' },
  20: { id: 20, name: 'Wolves',    shortName: 'WOL' },
};

test('buildUnderstatSlugsByTeamId maps FPL ids to Understat slugs', () => {
  const out = buildUnderstatSlugsByTeamId(leagueXg, teamsById);
  assert.equal(out[1], 'Arsenal');
});

test('buildUnderstatSlugsByTeamId converts spaces to underscores', () => {
  const out = buildUnderstatSlugsByTeamId(leagueXg, teamsById);
  assert.equal(out[13], 'Manchester_City');
  assert.equal(out[20], 'Wolverhampton_Wanderers');
});

test('buildUnderstatSlugsByTeamId returns {} without a league payload', () => {
  assert.deepEqual(buildUnderstatSlugsByTeamId(null, teamsById), {});
});

test('buildUnderstatSlugsByTeamId omits teams it cannot match', () => {
  const out = buildUnderstatSlugsByTeamId(leagueXg, { 9: { id: 9, name: 'Some New Club', shortName: 'SNC' } });
  assert.equal(out[9], undefined);
});

import { buildChannelProfile } from '../../js/engine/channel.js';

// Shaped like a real getTeamData statistics block, with round numbers.
const statistics = {
  situation: {
    OpenPlay:       { shots: 300, goals: 30, xG: 30, against: { shots: 200, goals: 20, xG: 24 } },
    FromCorner:     { shots: 60,  goals: 6,  xG: 6,  against: { shots: 40,  goals: 4,  xG: 4  } },
    SetPiece:       { shots: 30,  goals: 3,  xG: 3,  against: { shots: 20,  goals: 2,  xG: 2  } },
    DirectFreekick: { shots: 10,  goals: 1,  xG: 1,  against: { shots: 10,  goals: 1,  xG: 2  } },
    Penalty:        { shots: 8,   goals: 6,  xG: 6,  against: { shots: 4,   goals: 3,  xG: 3  } },
  },
  shotZone: {
    ownGoals:        { shots: 2,   goals: 2,  xG: 2,  against: { shots: 1,   goals: 1,  xG: 1  } },
    shotOboxTotal:   { shots: 100, goals: 2,  xG: 4,  against: { shots: 80,  goals: 2,  xG: 3  } },
    shotPenaltyArea: { shots: 250, goals: 25, xG: 30, against: { shots: 150, goals: 15, xG: 21 } },
    shotSixYardBox:  { shots: 40,  goals: 12, xG: 6,  against: { shots: 30,  goals: 9,  xG: 6  } },
  },
  attackSpeed: {
    Normal:   { shots: 200, goals: 20, xG: 24, against: { shots: 150, goals: 15, xG: 18 } },
    Standard: { shots: 100, goals: 10, xG: 12, against: { shots: 80,  goals: 8,  xG: 9  } },
    Slow:     { shots: 50,  goals: 5,  xG: 6,  against: { shots: 40,  goals: 4,  xG: 5  } },
    Fast:     { shots: 30,  goals: 4,  xG: 6,  against: { shots: 20,  goals: 3,  xG: 8  } },
  },
};

test('buildChannelProfile computes set-piece share excluding penalties', () => {
  const p = buildChannelProfile(statistics);
  // dead ball xG for = 6+3+1 = 10; open play = 30; total = 40 → 0.25
  assert.ok(Math.abs(p.setPieceThreat.for - 0.25) < 1e-9);
  // against: 4+2+2 = 8; open play 24; total 32 → 0.25
  assert.ok(Math.abs(p.setPieceThreat.against - 0.25) < 1e-9);
});

test('buildChannelProfile computes box share excluding own goals', () => {
  const p = buildChannelProfile(statistics);
  // box xG for = 30+6 = 36; obox = 4; total 40 → 0.90
  assert.ok(Math.abs(p.boxThreat.for - 0.90) < 1e-9);
  // against: 21+6 = 27; obox 3; total 30 → 0.90
  assert.ok(Math.abs(p.boxThreat.against - 0.90) < 1e-9);
});

test('buildChannelProfile computes fast share over all attack speeds', () => {
  const p = buildChannelProfile(statistics);
  // fast 6 of (24+12+6+6) = 48 → 0.125
  assert.ok(Math.abs(p.wideTransition.for - 0.125) < 1e-9);
  // against: 8 of (18+9+5+8) = 40 → 0.20
  assert.ok(Math.abs(p.wideTransition.against - 0.20) < 1e-9);
});

test('buildChannelProfile reports hasChannelAxes true above the shot floor', () => {
  assert.equal(buildChannelProfile(statistics).hasChannelAxes, true);
});

test('buildChannelProfile nulls every axis below MIN_CHANNEL_SHOTS', () => {
  const thin = JSON.parse(JSON.stringify(statistics));
  thin.situation.OpenPlay.shots = 20;
  thin.situation.FromCorner.shots = 5;
  thin.situation.SetPiece.shots = 2;
  thin.situation.DirectFreekick.shots = 1;
  const p = buildChannelProfile(thin);
  assert.equal(p.hasChannelAxes, false);
  assert.equal(p.setPieceThreat.for, null);
  assert.equal(p.boxThreat.for, null);
  assert.equal(p.wideTransition.for, null);
});

test('buildChannelProfile handles a missing statistics block', () => {
  const p = buildChannelProfile(null);
  assert.equal(p.hasChannelAxes, false);
  assert.equal(p.setPieceThreat.against, null);
});

test('buildChannelProfile handles a partial statistics block without throwing', () => {
  const p = buildChannelProfile({ situation: statistics.situation });
  assert.equal(p.hasChannelAxes, false);
});

import { buildChannelProfilesByTeamId } from '../../js/engine/channel.js';

test('buildChannelProfilesByTeamId keys profiles by FPL team id', () => {
  const out = buildChannelProfilesByTeamId({ Arsenal: { statistics } }, { 1: 'Arsenal' });
  assert.equal(out[1].hasChannelAxes, true);
  assert.ok(Math.abs(out[1].setPieceThreat.for - 0.25) < 1e-9);
});

test('buildChannelProfilesByTeamId omits teams with no cached payload', () => {
  const out = buildChannelProfilesByTeamId({ Arsenal: { statistics } }, { 1: 'Arsenal', 2: 'Liverpool' });
  assert.equal(out[2], undefined);
});

test('buildChannelProfilesByTeamId omits teams whose profile is below the shot floor', () => {
  const thin = JSON.parse(JSON.stringify(statistics));
  thin.situation.OpenPlay.shots = 10;
  thin.situation.FromCorner.shots = 2;
  thin.situation.SetPiece.shots = 1;
  thin.situation.DirectFreekick.shots = 0;
  const out = buildChannelProfilesByTeamId({ Leeds: { statistics: thin } }, { 3: 'Leeds' });
  assert.equal(out[3], undefined);
});

test('buildChannelProfilesByTeamId returns {} for empty inputs', () => {
  assert.deepEqual(buildChannelProfilesByTeamId(null, null), {});
  assert.deepEqual(buildChannelProfilesByTeamId({}, {}), {});
});

import { calcChannelCounter } from '../../js/engine/channel.js';

const teamA = { id: 1, name: 'A' };
const teamB = { id: 2, name: 'B' };

// A leans on set pieces (0.35 vs league 0.256); B is unusually good at
// defending them (0.18 vs league 0.252). A should win that axis heavily.
const profileA = {
  hasChannelAxes: true, shots: 500,
  setPieceThreat: { for: 0.35, against: 0.25 },
  wideTransition: { for: 0.08, against: 0.09 },
  boxThreat:      { for: 0.91, against: 0.91 },
};
const profileB = {
  hasChannelAxes: true, shots: 500,
  setPieceThreat: { for: 0.22, against: 0.18 },
  wideTransition: { for: 0.09, against: 0.08 },
  boxThreat:      { for: 0.90, against: 0.91 },
};
const ctxAB = { channelProfilesByTeamId: { 1: profileA, 2: profileB } };

test('calcChannelCounter scores an axis off attackShare minus concedeShare', () => {
  const out = calcChannelCounter(teamA, teamB, ctxAB);
  // edge = 0.35 − 0.18 = 0.17; z = 0.17/0.0690 = 2.464; 50 + 2.464*14 = 84.5
  assert.ok(Math.abs(out.pairings.setPieceThreat.value - 84.50) < 0.5);
});

test('calcChannelCounter aggregates axes by CHANNEL_WEIGHTS', () => {
  const out = calcChannelCounter(teamA, teamB, ctxAB);
  assert.ok(out.value > 50 && out.value <= 100);
  assert.equal(out.mode, 'channel');
});

test('calcChannelCounter is asymmetric', () => {
  const ab = calcChannelCounter(teamA, teamB, ctxAB).value;
  const ba = calcChannelCounter(teamB, teamA, ctxAB).value;
  assert.notEqual(Math.round(ab), Math.round(ba));
});

test('calcChannelCounter clamps into 0-100 on an extreme mismatch', () => {
  const extremeA = { ...profileA, setPieceThreat: { for: 0.90, against: 0.25 } };
  const out = calcChannelCounter(teamA, teamB, { channelProfilesByTeamId: { 1: extremeA, 2: profileB } });
  assert.ok(out.pairings.setPieceThreat.value <= 100);
  assert.ok(out.value <= 100);
});

test('calcChannelCounter returns null when either team has no profile', () => {
  assert.equal(calcChannelCounter(teamA, teamB, { channelProfilesByTeamId: { 1: profileA } }), null);
  assert.equal(calcChannelCounter(teamA, teamB, { channelProfilesByTeamId: {} }), null);
  assert.equal(calcChannelCounter(teamA, teamB, {}), null);
});

test('calcChannelCounter reports estimated false when both profiles are real', () => {
  assert.equal(calcChannelCounter(teamA, teamB, ctxAB).estimated, false);
});

import { channelPersonnelFactor } from '../../js/engine/channel.js';

const squad = [
  { id: 1, position: 'FWD', fullName: 'Big Striker',  totals: { minutes: 2700 }, chanceOfPlayingNext: 100 },
  { id: 2, position: 'FWD', fullName: 'Backup',       totals: { minutes: 300  }, chanceOfPlayingNext: 100 },
  { id: 3, position: 'MID', fullName: 'Winger',       totals: { minutes: 2700 }, chanceOfPlayingNext: 100 },
];
const roles = { 1: 'ST', 2: 'ST', 3: 'WM' };
const chainCtx = { understatPlayersByName: {
  'big striker': { time: '2700', xGChain: '24',    xGBuildup: '5',   xA: '2',    npxG: '12' },
  'backup':      { time: '300',  xGChain: '0.666', xGBuildup: '0.2', xA: '0.05', npxG: '0.3' },
  'winger':      { time: '2700', xGChain: '18',    xGBuildup: '6',   xA: '6',    npxG: '6'  },
} };

test('channelPersonnelFactor is 1.0 when the unit is fully available', () => {
  const f = channelPersonnelFactor(squad, roles, 'boxThreat', chainCtx);
  assert.ok(Math.abs(f - 1) < 1e-9);
});

test('channelPersonnelFactor drops when the unit leader is ruled out', () => {
  const injured = squad.map(p => p.id === 1 ? { ...p, chanceOfPlayingNext: 0 } : p);
  const f = channelPersonnelFactor(injured, roles, 'boxThreat', chainCtx);
  assert.ok(f < 1, `expected a penalty, got ${f}`);
  assert.ok(f >= 0.80, 'must not exceed the configured floor');
});

test('channelPersonnelFactor clamps to the configured bounds', () => {
  const injured = squad.map(p => p.id === 1 ? { ...p, chanceOfPlayingNext: 0 } : p);
  assert.ok(channelPersonnelFactor(injured, roles, 'boxThreat', chainCtx) >= 0.80);
  assert.ok(channelPersonnelFactor(squad,   roles, 'boxThreat', chainCtx) <= 1.20);
});

test('channelPersonnelFactor is a neutral 1.0 when no unit player is matched', () => {
  assert.equal(channelPersonnelFactor(squad, roles, 'boxThreat', { understatPlayersByName: {} }), 1);
});

test('channelPersonnelFactor is a neutral 1.0 when the unit is empty', () => {
  assert.equal(channelPersonnelFactor(squad, {}, 'boxThreat', chainCtx), 1);
});
