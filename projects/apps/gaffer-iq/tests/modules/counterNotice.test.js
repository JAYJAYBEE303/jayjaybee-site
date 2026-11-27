/**
 * tests/modules/counterNotice.test.js
 * js/modules/counterNotice.js: the red bar above the Matchup page's
 * Counter-matchups while its data source (Understat.com) is down.
 * Pure-function tests only (CONVENTIONS §3.3).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { counterNoticeHTML } from '../../js/modules/counterNotice.js';

// What main.js installs when the live-season Understat call fails
// (engine/fpl-league.js), and what a working call returns.
const STAND_IN = { synthetic: true, teamsData: {}, playersData: [], datesData: [] };
const REAL     = { teamsData: { 83: { title: 'Arsenal', history: [] } }, playersData: [], datesData: [] };

test('shows the bar while the live Understat payload is the FPL stand-in', () => {
  const html = counterNoticeHTML(STAND_IN);
  assert.match(html, /class="alert"/);
  assert.match(html, /Understat\.com/);
  assert.match(html, /A fix is being worked on/);
});

test('says the data is unavailable and names the source as down', () => {
  const text = counterNoticeHTML(STAND_IN).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(text, /Counter-matchup data is unavailable/);
  assert.match(text, /its source, Understat\.com, is down/);
});

test('shows the bar when there is no league payload at all', () => {
  assert.match(counterNoticeHTML(null), /class="alert"/);
});

test('shows nothing when Understat answered - the bar removes itself on recovery', () => {
  assert.equal(counterNoticeHTML(REAL), '');
});

test('shows nothing for a real but empty payload (season start is not an outage)', () => {
  assert.equal(counterNoticeHTML({ teamsData: [], playersData: [], datesData: [] }), '');
});

test('is announced as a note and its icon is hidden from assistive tech', () => {
  const html = counterNoticeHTML(STAND_IN);
  assert.match(html, /role="note"/);
  assert.match(html, /class="alert__i" aria-hidden="true"/);
});
