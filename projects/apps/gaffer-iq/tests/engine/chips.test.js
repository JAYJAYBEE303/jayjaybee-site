/**
 * tests/engine/chips.test.js
 * Wildcard and Free Hit timing (engine/chips.js) on a synthetic league.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { syntheticSeason, rawPlayer } from './synthetic-season.js';
import { buildScoreContext } from '../../js/engine/composite.js';
import { scoreWildcardTiming, scoreFreeHitTiming } from '../../js/engine/chips.js';
import { HORIZONS, SEASON_GWS } from '../../js/config.js';

/** GW36 of a season whose last three rounds are still to play. */
function lateSeason() {
  const fixtures = [36, 37, 38].flatMap(gw => [[gw, 1, 2], [gw, 3, 4], [gw, 5, 6]]);
  const season = syntheticSeason({ playedGws: 35, fixtures, players: [rawPlayer(1, 1, 'MID')] });
  return buildScoreContext(season, { currentGw: 36 });
}

test('Wildcard and Free Hit timing never weigh a gameweek after the season ends', () => {
  const ctx = lateSeason();
  const freeHit = scoreFreeHitTiming(HORIZONS.GW5, ctx);
  assert.ok(freeHit.candidates.every(c => c.gw <= SEASON_GWS), freeHit.candidates.map(c => c.gw).join());
  assert.ok(scoreWildcardTiming(HORIZONS.GW5, ctx).every(c => c.gw <= SEASON_GWS));
});
