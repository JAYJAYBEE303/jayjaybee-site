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
