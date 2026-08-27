/**
 * tests/engine/normalise.test.js
 * Unit tests for engine/normalise.js. Pure-function tests only (CONVENTIONS §3.3).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normaliseFixture } from '../../js/engine/normalise.js';

test('normaliseFixture flags a provisional kickoff time', () => {
  // FPL sets provisional_start_time while a kickoff is unconfirmed — often the
  // precursor to a postponement, so it must survive normalisation.
  const f = normaliseFixture({
    id: 1, event: 24, team_h: 1, team_a: 2, provisional_start_time: true,
  });
  assert.equal(f.provisionalKickoff, true);
});

test('normaliseFixture treats a missing provisional flag as confirmed', () => {
  // Absent means confirmed, not unknown — FPL only sets the field when the
  // kickoff is actually in doubt.
  const f = normaliseFixture({ id: 1, event: 24, team_h: 1, team_a: 2 });
  assert.equal(f.provisionalKickoff, false);
});

test('normaliseFixture keeps a null event as a null gw', () => {
  // A postponed fixture awaiting a rearranged date. normaliseSeason routes
  // these into pendingFixtures; the guard that keeps them out of aggregation
  // keys off exactly this null.
  const f = normaliseFixture({ id: 1, event: null, team_h: 1, team_a: 2 });
  assert.equal(f.gw, null);
});
