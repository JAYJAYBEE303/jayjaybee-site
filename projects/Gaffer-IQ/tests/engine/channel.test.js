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
