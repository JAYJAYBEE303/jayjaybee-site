/**
 * tests/engine/normalise.test.js
 * Unit tests for engine/normalise.js. Pure-function tests only (CONVENTIONS §3.3).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normaliseFixture, deriveUpcomingGw, deriveEventCompletion,
  normaliseGwStat, normaliseEntryPicks, normaliseEntryTransfers, normaliseEntryHistory,
  normaliseLiveGw, buildBootstrapSnapshot,
} from '../../js/engine/normalise.js';

test('normaliseFixture flags a provisional kickoff time', () => {
  // FPL sets provisional_start_time while a kickoff is unconfirmed - often the
  // precursor to a postponement, so it must survive normalisation.
  const f = normaliseFixture({
    id: 1, event: 24, team_h: 1, team_a: 2, provisional_start_time: true,
  });
  assert.equal(f.provisionalKickoff, true);
});

test('normaliseFixture treats a missing provisional flag as confirmed', () => {
  // Absent means confirmed, not unknown - FPL only sets the field when the
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

// ─── deriveUpcomingGw ─────────────────────────────────────────────────────────

test('deriveUpcomingGw moves past a current gameweek that has finished', () => {
  // THE DEFECT. FPL keeps is_current on a round from its own deadline until
  // the NEXT round's deadline, so for the days between a Sunday full-time and
  // the following Friday, is_current names a gameweek in which every match has
  // been played. Forward-looking views anchored on it (Ranker horizon, Full
  // Season strip) therefore offered a finished round as the next matchup.
  const events = [
    { id: 1, finished: true,  isCurrent: false, isNext: false },
    { id: 2, finished: true,  isCurrent: true,  isNext: false },
    { id: 3, finished: false, isCurrent: false, isNext: true  },
  ];
  assert.equal(deriveUpcomingGw(events), 3);
});

test('deriveUpcomingGw stays on a current gameweek still being played', () => {
  // Mid-round the current gameweek IS the upcoming one - there is football
  // left in it, and its remaining fixtures still belong in a horizon.
  const events = [
    { id: 2, finished: false, isCurrent: true, isNext: false },
    { id: 3, finished: false, isCurrent: false, isNext: true },
  ];
  assert.equal(deriveUpcomingGw(events), 2);
});

test('deriveUpcomingGw uses the next gameweek before the season starts', () => {
  // Pre-season: FPL flags no current round at all.
  const events = [
    { id: 1, finished: false, isCurrent: false, isNext: true },
  ];
  assert.equal(deriveUpcomingGw(events), 1);
});

test('deriveUpcomingGw steps past the last finished gameweek of the season', () => {
  // After GW38 is_next is null, and answering 38 would present a completed
  // season as still to come. One past the end is the honest answer: every
  // gameweek reads as played and every horizon comes back empty.
  const events = [
    { id: 38, finished: true, isCurrent: true, isNext: false },
  ];
  assert.equal(deriveUpcomingGw(events), 39);
});

test('deriveUpcomingGw falls back to gameweek 1 with no events at all', () => {
  assert.equal(deriveUpcomingGw([]), 1);
});

// ─── deriveEventCompletion ────────────────────────────────────────────────────

test('deriveEventCompletion marks a round complete once every match has been played', () => {
  // THE DEFECT. FPL's event.finished waits for BONUS CONFIRMATION, not full
  // time - on 2026-09-07 all ten GW3 matches read finished_provisional with
  // event 3 still finished:false. The rails, which read fixture-level `played`,
  // had already moved to GW4 while the Full Season strip and the Outlook
  // window, anchored on the event flag, were still offering GW3.
  const events   = [{ id: 3, finished: false, isCurrent: true, isNext: false }];
  const fixtures = [
    { id: 1, gw: 3, played: true },
    { id: 2, gw: 3, played: true },
  ];
  assert.deepEqual(deriveEventCompletion(events, fixtures), [
    { id: 3, finished: false, isCurrent: true, isNext: false, complete: true },
  ]);
});

test('deriveEventCompletion leaves a round with football still to come incomplete', () => {
  const events   = [{ id: 3, finished: false, isCurrent: true, isNext: false }];
  const fixtures = [
    { id: 1, gw: 3, played: true },
    { id: 2, gw: 3, played: false },
  ];
  assert.equal(deriveEventCompletion(events, fixtures)[0].complete, false);
});

test('deriveEventCompletion ignores postponed fixtures with no gameweek', () => {
  // gw === null is a fixture awaiting a rearranged date. It is not a pending
  // result for any round, so it must not hold one open.
  const events   = [{ id: 3, finished: false, isCurrent: true, isNext: false }];
  const fixtures = [
    { id: 1, gw: 3,    played: true },
    { id: 2, gw: null, played: false },
  ];
  assert.equal(deriveEventCompletion(events, fixtures)[0].complete, true);
});

test('deriveEventCompletion falls back to the raw flag for a round with no fixtures', () => {
  // An empty every() is true, which would report a round nobody has played as
  // finished - e.g. before the fixtures payload lands.
  const events = [
    { id: 3, finished: false, isCurrent: true,  isNext: false },
    { id: 2, finished: true,  isCurrent: false, isNext: false },
  ];
  const done = deriveEventCompletion(events, []);
  assert.equal(done[0].complete, false);
  assert.equal(done[1].complete, true);
});

test('deriveUpcomingGw moves past a current gameweek whose matches are all played', () => {
  // The event flag says otherwise; the fixtures are the authority.
  const events = deriveEventCompletion(
    [
      { id: 3, finished: false, isCurrent: true,  isNext: false },
      { id: 4, finished: false, isCurrent: false, isNext: true  },
    ],
    [{ id: 1, gw: 3, played: true }, { id: 2, gw: 4, played: false }],
  );
  assert.equal(deriveUpcomingGw(events), 4);
});

// ─── Entry payloads for the decision engine (Phase 1) ────────────────────────

const RAW_PICKS = {
  active_chip: null,
  automatic_subs: [],
  entry_history: {
    event: 7, points: 58, total_points: 412, rank: 1234, rank_sort: 1240,
    overall_rank: 99999, percentile_rank: 10, bank: 15, value: 1012,
    event_transfers: 1, event_transfers_cost: 0, points_on_bench: 6,
  },
  picks: [
    { element: 11, position: 1,  multiplier: 1, is_captain: false, is_vice_captain: false, element_type: 1 },
    { element: 22, position: 7,  multiplier: 2, is_captain: true,  is_vice_captain: false, element_type: 3 },
    { element: 33, position: 12, multiplier: 0, is_captain: false, is_vice_captain: true,  element_type: 2 },
  ],
};

test('normaliseEntryPicks maps picks, armbands and the bank', () => {
  const result = normaliseEntryPicks(RAW_PICKS);
  assert.equal(result.bankTenths, 15);
  assert.equal(result.activeChip, null);
  assert.deepEqual(result.picks, [
    { playerId: 11, slot: 1,  isCaptain: false, isViceCaptain: false },
    { playerId: 22, slot: 7,  isCaptain: true,  isViceCaptain: false },
    { playerId: 33, slot: 12, isCaptain: false, isViceCaptain: true },
  ]);
});

test('normaliseEntryPicks names the active chip in the app\'s own chip ids', () => {
  const chipOf = name => normaliseEntryPicks({ ...RAW_PICKS, active_chip: name }).activeChip;
  assert.equal(chipOf('freehit'), 'freehit');
  assert.equal(chipOf('wildcard'), 'wildcard');
  assert.equal(chipOf('bboost'), 'benchboost');
  assert.equal(chipOf('3xc'), 'triplecaptain');
  // A chip this app does not model (the 2024/25 assistant manager) is no chip.
  assert.equal(chipOf('manager'), null);
});

test('normaliseEntryTransfers maps each transfer with prices in tenths', () => {
  const result = normaliseEntryTransfers([
    { element_in: 5, element_in_cost: 62, element_out: 9, element_out_cost: 58,
      entry: 123, event: 4, time: '2026-09-12T10:00:00.000000Z' },
  ]);
  assert.deepEqual(result, [
    { inId: 5, inCostTenths: 62, outId: 9, outCostTenths: 58, gw: 4,
      time: '2026-09-12T10:00:00.000000Z' },
  ]);
});

test('normaliseEntryTransfers treats a missing payload as no transfers', () => {
  assert.deepEqual(normaliseEntryTransfers(null), []);
});

test('normaliseEntryHistory maps gameweeks and the chips played', () => {
  const result = normaliseEntryHistory({
    current: [
      { event: 1, points: 60, total_points: 60, rank: 1, rank_sort: 1, overall_rank: 1,
        percentile_rank: 1, bank: 5, value: 1000, event_transfers: 0,
        event_transfers_cost: 0, points_on_bench: 4 },
      { event: 2, points: 50, total_points: 110, rank: 1, rank_sort: 1, overall_rank: 1,
        percentile_rank: 1, bank: 0, value: 1003, event_transfers: 3,
        event_transfers_cost: 8, points_on_bench: 2 },
    ],
    past: [],
    chips: [
      { name: 'wildcard', time: '2026-08-29T09:00:00Z', event: 3 },
      { name: '3xc', time: '2026-09-20T09:00:00Z', event: 5 },
      { name: 'manager', time: '2026-09-27T09:00:00Z', event: 6 },
    ],
  });
  assert.deepEqual(result.gws, [
    { gw: 1, transfers: 0, transfersCost: 0, bankTenths: 5 },
    { gw: 2, transfers: 3, transfersCost: 8, bankTenths: 0 },
  ]);
  assert.deepEqual(result.chips, [
    { chip: 'wildcard', gw: 3 },
    { chip: 'triplecaptain', gw: 5 },
  ]);
});

test('normaliseLiveGw keeps minutes, points and starts for every player', () => {
  const result = normaliseLiveGw({
    elements: [
      { id: 7, stats: { minutes: 90, goals_scored: 1, total_points: 9, starts: 1, bonus: 2 }, explain: [] },
      { id: 8, stats: { minutes: 0, goals_scored: 0, total_points: 0, starts: 0, bonus: 0 }, explain: [] },
    ],
  });
  assert.deepEqual(result, [
    { playerId: 7, minutes: 90, points: 9, starts: 1 },
    { playerId: 8, minutes: 0, points: 0, starts: 0 },
  ]);
});

test('normaliseLiveGw marks starts unknown when the payload does not carry them', () => {
  const [row] = normaliseLiveGw({ elements: [{ id: 7, stats: { minutes: 30, total_points: 2 } }] });
  assert.equal(row.starts, null);
});

test('normaliseGwStat keeps the player\'s price for that gameweek in tenths', () => {
  const stat = normaliseGwStat({ round: 3, fixture: 21, opponent_team: 4, was_home: true,
    minutes: 90, total_points: 6, value: 57 });
  assert.equal(stat.priceTenths, 57);
});

// ─── Point-in-time bootstrap snapshot ────────────────────────────────────────

const RAW_ELEMENT = {
  id: 7, web_name: 'Saka', first_name: 'Bukayo', second_name: 'Saka', photo: '223340.jpg',
  code: 223340, team: 1, team_code: 3, element_type: 3,
  status: 'd', news: 'Hamstring - 75% chance of playing', news_added: '2026-10-15T18:00:00Z',
  chance_of_playing_next_round: 75, chance_of_playing_this_round: 75,
  now_cost: 102, cost_change_event: 1, cost_change_event_fall: -1, cost_change_start: 2,
  selected_by_percent: '41.2', transfers_in: 900000, transfers_out: 400000,
  transfers_in_event: 52000, transfers_out_event: 61000, form: '6.1', ep_next: '5.4',
  ep_this: '5.0', event_points: 7, total_points: 61, minutes: 610, starts: 7,
};

/** Test utility: read one archived value back out of the columnar record. */
function archived(record, playerId, field) {
  const row = record.rows.find(r => r[record.fields.indexOf('id')] === playerId);
  return row?.[record.fields.indexOf(field)];
}

const RAW_EVENTS = [
  { id: 8, name: 'Gameweek 8', deadline_time: '2026-10-17T17:30:00Z', finished: false,
    data_checked: false, is_current: false, is_next: true, is_previous: false,
    average_entry_score: 0 },
];

test('buildBootstrapSnapshot keeps the availability, price and transfer fields of every player', () => {
  const record = buildBootstrapSnapshot({ elements: [RAW_ELEMENT], events: RAW_EVENTS },
    { capturedAt: 1000, fetchedAt: 900 });
  assert.equal(archived(record, 7, 'status'), 'd');
  assert.equal(archived(record, 7, 'news'), 'Hamstring - 75% chance of playing');
  assert.equal(archived(record, 7, 'chance_of_playing_next_round'), 75);
  assert.equal(archived(record, 7, 'now_cost'), 102);
  assert.equal(archived(record, 7, 'cost_change_event'), 1);
  assert.equal(archived(record, 7, 'transfers_in_event'), 52000);
  assert.equal(archived(record, 7, 'selected_by_percent'), '41.2');
  assert.equal(archived(record, 7, 'ep_next'), '5.4');
});

test('buildBootstrapSnapshot archives an element field it has never seen', () => {
  // The 2026/27 price-change predictor fields are undocumented: whatever FPL
  // calls them, they must be in the record from the first capture on, because
  // point-in-time data cannot be backfilled.
  const record = buildBootstrapSnapshot(
    { elements: [{ ...RAW_ELEMENT, price_change_progress: 87 }], events: RAW_EVENTS },
    { capturedAt: 1000, fetchedAt: 900 });
  assert.equal(archived(record, 7, 'price_change_progress'), 87);
});

test('buildBootstrapSnapshot leaves out static fields such as names and photos', () => {
  const record = buildBootstrapSnapshot({ elements: [RAW_ELEMENT], events: RAW_EVENTS },
    { capturedAt: 1000, fetchedAt: 900 });
  assert.equal(record.fields.includes('photo'), false);
  assert.equal(record.fields.includes('web_name'), false);
});

test('buildBootstrapSnapshot stamps both times and keeps the gameweek calendar', () => {
  const record = buildBootstrapSnapshot({ elements: [RAW_ELEMENT], events: RAW_EVENTS },
    { capturedAt: 1000, fetchedAt: 900 });
  assert.equal(record.capturedAt, 1000);
  assert.equal(record.fetchedAt, 900);
  assert.deepEqual(record.events, [
    { id: 8, deadline_time: '2026-10-17T17:30:00Z', finished: false, data_checked: false,
      is_current: false, is_next: true },
  ]);
});
