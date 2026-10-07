// Self-check for the design adapter: `npm test` (node strips the types; no test framework).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildRace, SPEEDS } from './src/race.ts';
import { toSnapshot } from './src/toSnapshot.ts';
import { toViewModel } from './src/viewModel.ts';
import { createMockController } from './src/mock/controller.ts';
import { mockCharts, SCENARIOS, T1 } from './src/mock/data.ts';
import type { SourceUi, Snapshot } from './src/snapshot.ts';
import { raceSession, lap, raceData, at, ms } from './test/race-fixture.ts';

const ui = (extra: Partial<SourceUi> = {}): SourceUi => ({
  tab: 'telemetry', standKind: 'drivers', prefs: { speed: 1, names: true, drs: true, events: true }, reduced: false,
  pickOrder: [1, 11, 44], years: [2024], year: 2024, sessions: [{ value: '9', label: 'X · Race' }], sessionValue: '9',
  mapNote: '', error: null, standingsMsg: null, meetingShort: 'Test GP', ...extra,
});

const R = buildRace(raceSession, raceData, '#dim', 1);
R.t = ms(250);
const s = toSnapshot(R, ui());
assert.deepEqual(s.rows.map((r) => [r.d, r.gap, r.int, r.pit, r.out, r.tyre, r.age]), [
  [1, 'Leader', '', false, false, 'S', '2'], [11, '+1.2', 'PIT', true, false, 'H', '0'], [44, 'OUT', '', false, true, '–', ''],
]);
assert.deepEqual([s.lap, s.totalLaps, s.clock, s.status, s.statusLabel], ['3', '3', '0:03:10', 'green', 'Track clear']);
assert.deepEqual([s.weather.air, s.weather.track], ['25°', '40°']);
assert.equal(s.rows[0].fastest, true);
assert.equal(s.rows[0].lastLap, '1:30.000');
assert.deepEqual(s.rows[0].sectors.map((c) => c.c), ['none', 'none', 'none']);
assert.deepEqual(s.rc.map((r) => [r.n, r.flag, r.message]), [[3, 'sc', 'SAFETY CAR IN THIS LAP'], [2, 'sc', 'SAFETY CAR DEPLOYED'], [1, 'green', 'GREEN LIGHT']]);
assert.deepEqual(s.events.map((e) => [e.kind, e.left.toFixed(2), e.width.toFixed(2)]), [['sc', '14.44', '19.86']]);
assert.deepEqual([s.scrubMax, s.scrubVal], [277, 190]);
assert.deepEqual(s.stable.map((r) => r.d), [1, 11, 44]);
assert.deepEqual(s.session, { short: 'Test GP', circuit: 'X', name: 'Race' });
assert.deepEqual(s.rows.map((r) => r.name), ['Max Verstappen', 'PER', 'HAM']);
assert.deepEqual([s.speedValue, s.speeds[3], s.sourceLabel, s.buffering, s.noSession], ['3', { value: '3', label: '1×' }, 'OpenF1', true, false]);

// banners
R.t = ms(120);
assert.deepEqual(toSnapshot(R, ui()).banner, { kind: 'sc', title: 'Safety car', detail: 'Deployed lap 1 · DRS disabled' });
R.t = ms(152);
assert.ok(toSnapshot(R, ui()).banner!.detail.endsWith('· in this lap'));
R.t = ms(337);
const fin = toSnapshot(R, ui());
assert.deepEqual(fin.banner, { kind: 'chequered', title: 'Chequered flag', detail: 'VER wins' });
assert.equal(fin.finished, true);

// red flag and virtual safety car (copy is binding)
const withRc = (row: { date: string; category: string; flag?: string; scope?: string; message: string }) => {
  const r = buildRace(raceSession, { ...raceData, raceControl: [...raceData.raceControl, row] }, '#dim', 1);
  r.t = ms(250);
  return toSnapshot(r, ui());
};
const red = withRc({ date: at(200), category: 'Flag', flag: 'RED', scope: 'Track', message: 'RED FLAG' });
assert.deepEqual([red.status, red.statusLabel], ['red', 'Red flag']);
assert.deepEqual(red.banner, { kind: 'red', title: 'Red flag', detail: 'Session suspended · cars to the pit lane' });
assert.deepEqual(red.events.map((e) => e.kind), ['sc', 'red']);
const vsc = withRc({ date: at(200), category: 'SafetyCar', message: 'VIRTUAL SAFETY CAR DEPLOYED' });
assert.deepEqual([vsc.status, vsc.statusLabel], ['vsc', 'Virtual safety car']);
assert.deepEqual(vsc.banner, { kind: 'vsc', title: 'Virtual safety car', detail: 'Hold delta · DRS disabled' });

// no race / load failed
const none = toSnapshot(null, ui());
assert.equal(none.loading, true);
assert.deepEqual([none.rows, none.stable, none.rc, none.picker, none.standings], [[], [], [], [], []]);
assert.deepEqual(none.session, { short: '', circuit: '', name: '' });
assert.equal(none.clock, '0:00:00');
const failed = toSnapshot(null, ui({ error: 'OpenF1 returned 500' }));
assert.deepEqual([failed.stale, failed.loading], [true, false]);
assert.equal(failed.banner!.detail, 'OpenF1 returned 500 · showing data from 0:00:00');

// recent position change
const moved = buildRace(raceSession, {
  ...raceData,
  position: [...raceData.position, { driver_number: 11, date: at(248), position: 1 }, { driver_number: 1, date: at(248), position: 2 }],
}, '#dim', 1);
moved.t = ms(250);
assert.deepEqual(toSnapshot(moved, ui()).rows.map((r) => [r.d, r.changed]), [[11, true], [1, true], [44, false]]);
moved.t = ms(260);
assert.deepEqual(toSnapshot(moved, ui()).rows.map((r) => r.changed), [false, false, false]);

// unknown compound
const unk = buildRace(raceSession, { ...raceData, stints: raceData.stints.map((st) => ({ ...st, compound: 'UNKNOWN' })) }, '#dim', 1);
unk.t = ms(250);
assert.deepEqual(toSnapshot(unk, ui()).rows.map((r) => r.tyre), ['–', '–', '–']);

// sectors: purple = overall best, green = personal best, yellow = neither; the table shows '–' for missing
const sec = buildRace(raceSession, {
  ...raceData,
  laps: [
    lap(1, 1, 60, 90, { duration_sector_1: 30, duration_sector_2: 30.5, duration_sector_3: 29.5 }),
    lap(1, 2, 150, 92, { duration_sector_1: 30, duration_sector_2: 30, duration_sector_3: 61 }),
    lap(11, 1, 60, 95, { duration_sector_1: 28, duration_sector_2: 30, duration_sector_3: 34 }),
  ],
}, '#dim', 1);
sec.t = ms(250);
const ss = toSnapshot(sec, ui());
assert.deepEqual(ss.rows[0].sectors, [{ v: '30.000', c: 'green' }, { v: '30.000', c: 'purple' }, { v: '1:01.000', c: 'yellow' }]);
assert.deepEqual(ss.rows[2].sectors, [{ v: '', c: 'none' }, { v: '', c: 'none' }, { v: '', c: 'none' }]);
assert.deepEqual(ss.sectors.map((r) => [r.lap, r.time, r.s[0].v]), [['2', '1:32.000', '30.000'], ['1', '1:35.000', '28.000'], ['–', '–', '–']]);

// tyres, telemetry, legend, charts (only the active tab's chart is filled)
R.t = ms(250);
const lapsTab = toSnapshot(R, ui({ tab: 'laps' }));
assert.deepEqual(lapsTab.charts.laps.map((c) => c.label), ['VER', 'PER', 'HAM']);
assert.ok(lapsTab.charts.lapsY);
R.selected = new Set([11]);
const tel = toSnapshot(R, ui({ tab: 'laps' }));
assert.deepEqual(tel.tyres[1].bars.map((b) => [b.tyre, b.from, b.to, b.laps]), [['M', 1, 2, 2], ['H', 3, 3, 1]]);
assert.deepEqual(tel.telemetry.map((c) => [c.d, c.speed, c.gear, c.throttle, c.brake, c.drs, c.wearText, c.tyre]), [[11, '–', '–', 0, 0, false, 'Wear: after 3 laps', 'H']]);
assert.deepEqual(tel.legend, [{ d: 11, code: 'PER', colour: '#3671C6', dashed: false }]);
assert.deepEqual(tel.charts.laps.map((c) => [c.label, c.points.length]), [['PER', 2]]);
assert.deepEqual([tel.charts.positions, tel.charts.posMax], [[], 0]);
const pos = toSnapshot(R, ui({ tab: 'positions' }));
assert.deepEqual([pos.charts.laps, pos.charts.posMax, pos.charts.positions.map((c) => c.dim)], [[], 3, [true, false, true]]);
R.selected = new Set();
assert.deepEqual(toSnapshot(R, ui({ tab: 'fastest' })).fastestText, ['VER 1:30.000 (lap 2)', 'PER 1:31.000 (lap 2)']);

// standings
R.standings = {
  drivers: [{ driver_number: 1, points_start: 100 }, { driver_number: 44, points_start: 110 }, { driver_number: 11, points_start: 50 }],
  teams: [{ team_name: 'Red Bull', points_start: 150 }, { team_name: 'Mercedes', points_start: 120 }],
};
const st = toSnapshot(R, ui());
assert.deepEqual(st.standings.map((r) => [r.pos, r.label, r.total, r.gainLabel]), [[1, 'HAM', 125, '+15'], [2, 'Max Verstappen', 125, '+25'], [3, 'PER', 68, '+18']]);
assert.equal(st.standings[1].colour, '#3671C6');
assert.equal(st.standNote, 'Live: points before the race plus points for the running order now.');
const teams = toSnapshot(R, ui({ standKind: 'teams' }));
assert.deepEqual(teams.standings.map((r) => [r.label, r.colour, r.total]), [['Red Bull', '#3671C6', 193], ['Mercedes', '#dim', 135]]);

// qualifying
const quali = buildRace(
  { ...raceSession, session_name: 'Qualifying', session_type: 'Qualifying', date_start: at(0), date_end: at(400) },
  {
    ...raceData, intervals: [],
    laps: [lap(1, 1, 20, 70), lap(11, 1, 20, 71), lap(1, 2, 110, 75)],
    raceControl: [100, 200, 300].map((x) => ({ date: at(x), category: 'Flag', flag: 'CHEQUERED', message: 'CHEQUERED FLAG' })),
  },
  '#dim', 1,
);
quali.t = ms(150);
const q = toSnapshot(quali, ui());
assert.deepEqual([q.quali, q.practice, q.segment, q.rows[0].fastest], [true, false, 'Q2', false]);
assert.ok(!q.tabs.some((x) => x.id === 'positions'));
assert.deepEqual(q.standings, []);

// practice
const fp = buildRace({ ...raceSession, session_name: 'Practice 1', session_type: 'Practice' }, { ...raceData, intervals: [] }, '#dim', 1);
fp.t = fp.t1;
const p = toSnapshot(fp, ui());
assert.deepEqual([p.practice, p.quali, p.finished, p.banner, p.segment], [true, false, false, null, '']);
assert.equal(p.standNote, 'Standings are shown for races and sprints — pick one of those.');

console.log('adapter ok');

// ---- mock source: parity with the design-6e reference (golden generated once from the local reference) ----
const golden = JSON.parse(readFileSync(new URL('./test/golden-design6e.json', import.meta.url), 'utf8')) as Record<string, { snap: Record<string, unknown>; vm: unknown }>;
const labels = (o: { label: string }[]) => o.map((x) => x.label);
const mockRun = (scenario: string, selected: number[] = [4]) => {
  let last: Snapshot | undefined;
  const c = createMockController({ selected, onTick: (s) => { last = s; } });
  c.setScenario(scenario);
  return { c, snap: () => last as Snapshot };
};
assert.equal(SCENARIOS.length, 10);
for (const name of SCENARIOS) {
  const s = mockRun(name).snap();
  const got = { ...s, years: labels(s.years), sessions: labels(s.sessions) } as Record<string, unknown>;
  const want = golden[name].snap;
  for (const k of Object.keys(want)) assert.deepEqual(JSON.parse(JSON.stringify(got[k])), want[k], `${name}.${k}`);
}
{
  const s = mockRun('live').snap();
  assert.deepEqual([s.sourceLabel, s.practice, s.buffering, s.mapNote, s.fastestText], ['Mock data', false, false, '', []]);
  assert.equal(mockRun('loading').snap().mapNote, 'Loading timing data…');
  assert.equal(s.reduced, false); // node: no matchMedia
}

// ticking
{
  const { c } = mockRun('live');
  const t0 = c.state.t;
  c.tick(1);
  assert.equal(c.state.t, t0 + SPEEDS[c.state.speedIdx]);
  c.actions.setSpeed(4);
  c.tick(1);
  assert.equal(c.state.t, t0 + SPEEDS[3] + SPEEDS[4]);
  c.actions.scrub(T1 - 1);
  c.tick(5);
  assert.deepEqual([c.state.t, c.state.playing], [T1, false]);
}
for (const frozen of ['red-flag', 'feed-dropped', 'loading', 'no-session']) {
  const { c } = mockRun(frozen);
  const t0 = c.state.t;
  c.tick(1);
  assert.equal(c.state.t, t0, frozen);
}

// actions: selection semantics, tabs, standings, charts
{
  const { c, snap } = mockRun('live', [4, 81]);
  c.actions.select(1, false);
  assert.deepEqual([...c.state.selected], [1]);
  c.actions.select(44, true);
  c.actions.toggleDriver(1);
  c.actions.toggleDriver(44);
  c.actions.toggleDriver(44);
  assert.deepEqual([...c.state.selected], [44]);
  c.actions.setTab('laps');
  assert.equal(snap().tabs.find((t) => t.selected)?.id, 'laps');
  assert.ok(snap().charts.laps.length === 1 && snap().charts.lapsY !== null);
  c.actions.setTab('positions');
  assert.deepEqual([snap().charts.positions.length, snap().charts.posMax, snap().charts.positions.filter((x) => !x.dim).length], [20, 20, 1]);
  c.actions.setTab('fastest');
  assert.deepEqual(Object.values(snap().charts.fastest).map((x) => x[0].points.length), [101, 101, 101, 101]);
  c.actions.showStandings('teams');
  assert.equal(snap().standKind, 'teams');
  assert.equal(mockCharts({ ...c.state, loading: true }).fastest.speed.length, 0);
}

// fake load keeps the reference 900 ms delay; dispose cancels it
{
  let calls = 0;
  const probe = createMockController({ selected: [4], onTick: () => { calls++; } });
  probe.setScenario('live');
  probe.actions.setSession('Italian GP · Qualifying');
  assert.equal(probe.state.loading, true);
  probe.dispose();
  const before = calls;
  await new Promise((r) => setTimeout(r, 1000));
  assert.deepEqual([calls, probe.state.loading], [before, true]);
  const { c, snap } = mockRun('live');
  c.actions.setSession('Italian GP · Qualifying');
  await new Promise((r) => setTimeout(r, 1000));
  assert.deepEqual([snap().loading, snap().quali], [false, true]);
}

console.log('mock ok');

// ---- view model: parity with the reference renderVals() on every golden scenario ----
const norm = (v: unknown): unknown =>
  v === '#0A0A0B' ? 'var(--p-black-950)' : v === '#FFFFFF' ? 'var(--text-on-accent)'
  : Array.isArray(v) ? v.map(norm)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)])) : v;
const asOptions = (v: unknown) => (v as string[]).map((x) => ({ value: x, label: x }));
/** Project `got` onto the keys golden `want` carries (nested lists compare only those sub-keys); count compared leaves. */
function project(got: unknown, want: unknown, tally: { n: number }, path: string): unknown {
  if (Array.isArray(want)) {
    assert.ok(Array.isArray(got) && got.length === want.length, `${path} length`);
    return want.map((w, i) => project(got[i], w, tally, `${path}[${i}]`));
  }
  if (want && typeof want === 'object') {
    assert.ok(got && typeof got === 'object', path);
    return Object.fromEntries(Object.keys(want).map((k) => [k, project((got as Record<string, unknown>)[k], (want as Record<string, unknown>)[k], tally, `${path}.${k}`)]));
  }
  tally.n++;
  return got;
}
for (const name of SCENARIOS) {
  const vm = toViewModel(mockRun(name).snap()) as unknown as Record<string, unknown>;
  const want = norm(golden[name].vm) as Record<string, unknown>;
  want.years = asOptions(want.years);
  want.sessions = asOptions(want.sessions);
  want.lights = (want.lights as { bg: string }[]).map(({ bg }) => ({ bg }));
  for (const k of Object.keys(want)) {
    const tally = { n: 0 };
    assert.deepEqual(project(vm[k], want[k], tally, `${name}.${k}`), want[k], `${name}.${k}`);
    if (Array.isArray(want[k]) && (want[k] as unknown[]).length) assert.ok(tally.n > 0, `${name}.${k} compared nothing`);
  }
  assert.equal((want.tiles as unknown[]).length, 20, name);
}

// no race loaded: focus placeholders, no throw
{
  const e = toViewModel(toSnapshot(null, ui()));
  assert.equal(e.focus.posText, '–');
  assert.equal(e.focus.colour, 'transparent');
  assert.deepEqual(e.focus.sectors, [0, 1, 2].map(() => ({ v: '', fg: 'var(--text-tertiary)', mark: '', aria: 'no time' })));
  assert.deepEqual([e.hasAhead, e.noAhead, e.hasBehind, e.noBehind, e.hasFocusTele, e.noFocusTele], [false, true, false, true, false, true]);
  assert.deepEqual([e.tiles, e.ribbon], [[], []]);
}
// practice: bests use int, hero is the session name, tower title is Best laps
{
  const pv = toViewModel(p);
  assert.deepEqual([pv.towerTitle, pv.heroA, pv.heroB], ['Best laps', 'Practice 1', '']);
  assert.equal(pv.ribbonTicks[0].label, 'Leader');
}
// buffering, red band, fastest labels, reduced motion
{
  const live = mockRun('live').snap();
  assert.equal(toViewModel({ ...live, buffering: true }).chipText, 'Buffering · 1×');
  assert.equal(toViewModel({ ...live, buffering: true, playing: false }).chipText, 'Paused · 1×');
  assert.equal(toViewModel({ ...live, reduced: true }).ribbonMotion, 'none');
  assert.equal(toViewModel({ ...live, events: [{ kind: 'red', left: 1, width: 2, label: 'Red flag' }] }).events[0].bg, 'var(--status-red)');
  assert.deepEqual(toViewModel({ ...live, fastestText: ['A'] }).legend2.map((l) => l.code), ['A']);
  assert.equal(toViewModel(live).legend2[0].code, 'NOR');
}

console.log('viewModel ok');
