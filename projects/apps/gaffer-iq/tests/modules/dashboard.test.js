/**
 * tests/modules/dashboard.test.js
 * Pure-function tests only (CONVENTIONS §3.3) — buildFixtureContextLabel takes
 * a score and returns a string, with no DOM or store involvement.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildFixtureContextLabel } from '../../js/modules/dashboard.js';

test('buildFixtureContextLabel names a single fixture', () => {
  const label = buildFixtureContextLabel({ perGw: [
    { gw: 24, opponent: 'ARS', venue: 'H', isBlank: false },
  ] });
  assert.equal(label, 'GW24 vs ARS (H)');
});

test('buildFixtureContextLabel names BOTH fixtures of a double', () => {
  // The defect: this read perGw[0] and silently dropped the second fixture, so
  // the line a user opens to sanity-check a captaincy pick told half the truth
  // on exactly the gameweek where captaincy matters most.
  const label = buildFixtureContextLabel({ perGw: [
    { gw: 24, opponent: 'EVE', venue: 'H', isBlank: false },
    { gw: 24, opponent: 'SHU', venue: 'A', isBlank: false },
  ] });
  assert.equal(label, 'GW24 (double) vs EVE (H), SHU (A)');
});

test('buildFixtureContextLabel marks a blank gameweek', () => {
  const label = buildFixtureContextLabel({ perGw: [
    { gw: 26, opponent: null, venue: null, isBlank: true },
  ] });
  assert.equal(label, 'GW26 — Blank');
});

test('buildFixtureContextLabel falls back when there is no fixture data', () => {
  // A team with no ctx entry — must not throw, and must not claim a gameweek
  // it does not know about.
  assert.equal(typeof buildFixtureContextLabel({ perGw: [] }), 'string');
  assert.equal(typeof buildFixtureContextLabel({}), 'string');
  assert.equal(typeof buildFixtureContextLabel(null), 'string');
});
