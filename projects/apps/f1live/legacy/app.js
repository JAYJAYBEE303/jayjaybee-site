import {
  toMs, byDriver, lastAt, indexAt, sampleAt, lapOutline, formatGap, formatClock,
  timed, trackStatusTimeline, periods, cumulative, pointAhead, drsRuns, tyreAge,
  lapsDone, sectorBests, stintBars, formatLap, bestLap, lapTrace, liveStandings, rotator, tyreWear,
} from './replay.js';

const API = 'https://api.openf1.org/v1/';
const CHUNK = 5 * 60e3; // location data is fetched in 5-minute windows
const PAD = 2e3; // windows overlap so interpolation never gaps at a boundary
const SPEEDS = [0.1, 0.2, 0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256];
const SC_LEAD = 0.1; // simulated safety car runs ~10 % of a lap ahead of the leader
const FADE = 3e3; // safety car fade in/out
const FIRST_SEASON = 2023; // OpenF1 history starts here

const $ = (id) => document.getElementById(id);
const ui = {
  year: $('year'), race: $('race'), map: $('map'), status: $('status'),
  lap: $('lap'), clock: $('clock'), board: $('board'), rc: $('rc'), weather: $('weather'),
  play: $('play'), scrub: $('scrub'), speed: $('speed'), labels: $('labels'), drs: $('drs'),
  events: $('events'), help: $('help'), helpBtn: $('help-btn'), clearCache: $('clear-cache'),
  standings: $('standings'), standingsBtn: $('standings-btn'), standingsTitle: $('standings-title'),
  standingsBody: $('standings-body'), standingsNote: $('standings-note'),
  standingsKinds: [...document.querySelectorAll('[data-kind]')],
  picker: $('picker'), telemetry: $('telemetry'), lapsChart: $('laps-chart'), lapsLegend: $('laps-legend'),
  posChart: $('positions-chart'), sectors: $('sectors'), tyres: $('tyres'), tip: $('tip'),
  fastLegend: $('fastest-legend'), fastSpeed: $('fastest-speed'), fastThrottle: $('fastest-throttle'),
  fastBrake: $('fastest-brake'), fastGear: $('fastest-gear'),
  tabs: [...document.querySelectorAll('[role="tab"]')],
};
const ctx = ui.map.getContext('2d');
const css = getComputedStyle(document.documentElement);
const color = (name) => css.getPropertyValue(name).trim();

let S = null; // state of the loaded race
let loadId = 0; // bumps on every race switch so stale loaders stop

// ---- OpenF1 fetch, throttled ------------------------------------------------
let nextSlot = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Finished sessions don't change, so per-session responses are kept in the Cache API.
// ponytail: no expiry; "Clear saved data" in the help dialog empties it.
const CACHE = 'openf1-v1';
const openCache = () => globalThis.caches?.open(CACHE).catch(() => null) ?? Promise.resolve(null);

async function api(path) {
  const cache = path.includes('session_key=') ? await openCache() : null;
  const hit = await cache?.match(API + path);
  if (hit) return hit.json();
  for (let attempt = 0; ; attempt++) {
    const wait = nextSlot - Date.now();
    // ponytail: fixed spacing keeps us under OpenF1's free-tier burst limit; 429s back off below.
    nextSlot = Math.max(nextSlot, Date.now()) + 400;
    if (wait > 0) await sleep(wait);
    const res = await fetch(API + path);
    if (res.ok) {
      cache?.put(API + path, res.clone()).catch(() => {}); // full storage: just don't cache
      return res.json();
    }
    if (res.status === 404) return []; // OpenF1 answers "no results" with 404
    if (res.status !== 429 || attempt >= 5) throw new Error(`OpenF1 returned ${res.status}`);
    await sleep(2000 * (attempt + 1));
  }
}

// ---- Race picker ------------------------------------------------------------
function option(value, text) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = text;
  return o;
}

// Session names offered in the picker (testing days and anything else are left out).
const KINDS = ['Practice 1', 'Practice 2', 'Practice 3', 'Sprint Shootout', 'Sprint Qualifying', 'Qualifying', 'Sprint', 'Race'];
let sessions = []; // finished sessions of the selected season

async function loadSeason(year, pickKey) {
  ui.race.replaceChildren(option('', 'Loading…'));
  const now = Date.now();
  sessions = (await api(`sessions?year=${year}`))
    .filter((s) => KINDS.includes(s.session_name) && toMs(s.date_end) < now)
    .sort((a, b) => toMs(a.date_start) - toMs(b.date_start));
  if (!sessions.length) {
    ui.race.replaceChildren(option('', 'No finished sessions'));
    return;
  }
  ui.race.replaceChildren(...[...Map.groupBy(sessions, (s) => s.meeting_key).values()].map((list) => {
    const group = document.createElement('optgroup');
    const day = new Date(list[0].date_start).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    group.label = `${day} · ${list[0].location}`;
    group.append(...list.map((s) => option(s.session_key, s.session_name)));
    return group;
  }));
  const latest = sessions.findLast((s) => s.session_name === 'Race') ?? sessions.at(-1);
  ui.race.value = String(pickKey ?? latest.session_key);
  if (!ui.race.value) ui.race.value = String(latest.session_key);
  loadRace(sessions.find((s) => String(s.session_key) === ui.race.value));
}

// ---- Loading a race ---------------------------------------------------------
async function loadRace(session) {
  const id = ++loadId;
  S = null;
  history.replaceState(null, '', `?session=${session.session_key}`);
  setStatus('Loading session…');
  const k = `session_key=${session.session_key}`;
  const isRace = session.session_type === 'Race'; // includes sprints
  try {
    const [drivers, laps, position, stints, intervals, raceControl, weather, pit] = await Promise.all([
      api(`drivers?${k}`), api(`laps?${k}`), api(`position?${k}`), api(`stints?${k}`),
      isRace ? api(`intervals?${k}`) : [], api(`race_control?${k}`), api(`weather?${k}`), api(`pit?${k}`),
    ]);
    if (id !== loadId) return;

    const lapsBy = byDriver(laps, 'date_start');
    const lap1 = laps.filter((l) => l.lap_number === 1 && l.date_start).map((l) => toMs(l.date_start));
    const lapEnd = (l) => toMs(l.date_start) + (l.lap_duration ?? 0) * 1000;
    const dated = laps.filter((l) => l.date_start);
    // Races run from lights-out to the last finisher; other sessions use their whole window.
    const t0 = isRace && lap1.length ? Math.min(...lap1) : toMs(session.date_start);
    const t1 = isRace && dated.length ? Math.max(...dated.map(lapEnd)) : Math.max(toMs(session.date_end), ...dated.map(lapEnd));
    const totalLaps = Math.max(0, ...laps.map((l) => l.lap_number));

    // Leader's start of each lap = earliest start of that lap number by anyone.
    const leaderStarts = new Map();
    for (const l of dated) leaderStarts.set(l.lap_number, Math.min(leaderStarts.get(l.lap_number) ?? Infinity, toMs(l.date_start)));
    const finals = dated.filter((l) => l.lap_number === totalLaps).map(lapEnd);
    const lastEnd = new Map();
    for (const l of dated) lastEnd.set(l.driver_number, Math.max(lastEnd.get(l.driver_number) ?? 0, lapEnd(l)));
    const rc = timed(raceControl);
    const status = trackStatusTimeline(rc, [...leaderStarts.values()].sort((a, b) => a - b));

    S = {
      session, t0, t1, t: t0, playing: false, speed: Number(ui.speed.value),
      drivers: new Map(drivers.map((d) => [d.driver_number, {
        code: d.name_acronym ?? String(d.driver_number),
        team: d.team_name,
        colour: /^[0-9a-f]{6}$/i.test(d.team_colour ?? '') ? `#${d.team_colour}` : color('--text-dim'),
      }])),
      laps: lapsBy,
      totalLaps,
      isRace,
      quali: session.session_type === 'Qualifying',
      // Qualifying segment boundaries: every chequered flag but the last one.
      bounds: isRace ? [] : rc.filter((r) => r.flag === 'CHEQUERED').map((r) => r.t).slice(0, -1),
      chequer: isRace ? (finals.length ? Math.min(...finals) : t1) : -Infinity, // -Infinity: no OUT outside races
      lastEnd,
      pos: byDriver(position),
      ints: byDriver(intervals),
      stints: Map.groupBy(stints, (s) => s.driver_number),
      pits: Map.groupBy(timed(pit), (p) => p.driver_number),
      weather: timed(weather),
      rc,
      rcShown: -2, // race-control index last rendered
      status,
      periods: { sc: periods(status, 'sc', t1), vsc: periods(status, 'vsc', t1), red: periods(status, 'red', t1) },
      chunks: Array.from({ length: Math.max(1, Math.ceil((t1 - t0) / CHUNK)) }),
      outline: null,
      cum: null,
      view: null,
      drs: null,
      selected: new Set(), // driver numbers picked for telemetry/charts
      car: new Map(), // `${driver}:${window}` -> car_data rows | 'loading'
      traces: new Map(), // `${driver}:${lap}` -> lapTrace points | 'loading'
    };
    ui.tabs.find((b) => b.dataset.tab === 'positions').hidden = !isRace;
    if (!isRace && tab === 'positions') selectTab('telemetry');
    ui.scrub.max = Math.round((t1 - t0) / 1000);
    syncScrub();
    buildPicker();
    renderEvents();
    renderBoard();
    loadChunks(id);
    loadDrs(id, session);
    loadRotation(id, session);
  } catch (err) {
    if (id === loadId) setStatus(`Couldn't load this race (${err.message}). Try again shortly.`);
  }
}

// Date filter for fetch window i (padded so interpolation never gaps at a boundary).
const windowQuery = (i) => `date>${new Date(S.t0 + i * CHUNK - PAD).toISOString()}`
  + `&date<${new Date(S.t0 + (i + 1) * CHUNK + PAD).toISOString()}`;

const chunkIndex = (t) => Math.min(S.chunks.length - 1, Math.max(0, Math.floor((t - S.t0) / CHUNK)));

// Fetch location windows, always preferring the one at (or just after) the playhead.
async function loadChunks(id) {
  for (;;) {
    let i = S.chunks.findIndex((c, j) => !c && j >= chunkIndex(S.t));
    if (i < 0) i = S.chunks.findIndex((c) => !c);
    if (i < 0) return;
    S.chunks[i] = 'loading';
    let rows;
    try {
      rows = await api(`location?session_key=${S.session.session_key}&${windowQuery(i)}`);
    } catch (err) {
      if (id === loadId) { S.chunks[i] = undefined; setStatus(`Couldn't load car positions (${err.message}).`); }
      return;
    }
    if (id !== loadId) return;
    // (0, 0) is OpenF1's "no fix" placeholder.
    S.chunks[i] = byDriver(rows.filter((r) => r.x || r.y), 'date', (r) => ({ x: r.x, y: r.y }));
    if (!S.outline) {
      const pts = lapOutline(S.chunks[i], S.laps);
      if (pts.length > 10) { S.outline = pts; S.cum = cumulative(pts); fitView(); }
    }
  }
}

// DRS zones from the meeting's fastest qualifying lap. Optional: any failure just means no layer.
async function loadDrs(id, session) {
  try {
    const [q] = await api(`sessions?meeting_key=${session.meeting_key}&session_name=Qualifying`);
    if (!q) return;
    const laps = (await api(`laps?session_key=${q.session_key}`)).filter((l) => l.lap_duration && l.date_start);
    if (!laps.length) return;
    const best = laps.reduce((a, b) => (b.lap_duration < a.lap_duration ? b : a));
    const from = toMs(best.date_start), to = from + best.lap_duration * 1000;
    const win = `session_key=${q.session_key}&driver_number=${best.driver_number}`
      + `&date>${new Date(from).toISOString()}&date<${new Date(to).toISOString()}`;
    const [loc, car] = await Promise.all([api(`location?${win}`), api(`car_data?${win}`)]);
    if (id !== loadId) return;
    S.drs = drsRuns(timed(loc.filter((r) => r.x || r.y)), timed(car));
  } catch {
    // no DRS layer
  }
}

// SC / VSC / red-flag spans as coloured segments under the scrubber.
function renderEvents() {
  const span = S.t1 - S.t0 || 1;
  ui.events.replaceChildren(...Object.entries(S.periods).flatMap(([kind, list]) => list.map((p) => {
    const start = Math.max(p.start, S.t0), end = Math.min(p.end, S.t1);
    const seg = document.createElement('div');
    seg.dataset.status = kind;
    seg.title = kind.toUpperCase();
    seg.style.left = `${((start - S.t0) / span) * 100}%`;
    seg.style.width = `${(Math.max(0, end - start) / span) * 100}%`;
    return seg;
  })));
}

// ---- Drawing ----------------------------------------------------------------
// Circuit rotation (degrees) as used by broadcast maps; FastF1's source. Optional.
async function loadRotation(id, session) {
  try {
    const res = await fetch(`https://api.multiviewer.app/api/v1/circuits/${session.circuit_key}/${session.year}`);
    if (!res.ok) return;
    const { rotation } = await res.json();
    if (id !== loadId || typeof rotation !== 'number') return;
    S.rot = rotation;
    fitView();
  } catch {
    // blocked or offline: map stays unrotated
  }
}

function fitView() {
  if (!S?.outline) return;
  const w = ui.map.clientWidth, h = ui.map.clientHeight, pad = 32;
  const turn = rotator(S.rot ?? 0);
  const pts = S.outline.map(turn);
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const scale = Math.min((w - pad * 2) / (maxX - minX || 1), (h - pad * 2) / (maxY - minY || 1));
  const ox = (w - (maxX - minX) * scale) / 2, oy = (h - (maxY - minY) * scale) / 2;
  // World y points up, screen y points down.
  S.view = (p) => {
    const q = turn(p);
    return [ox + (q.x - minX) * scale, oy + (maxY - q.y) * scale];
  };
}

function path(points) {
  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, ...S.view(p)));
}

function carAt(d) {
  const chunk = S.chunks[chunkIndex(S.t)];
  return chunk instanceof Map ? sampleAt(chunk.get(d), S.t) : null;
}

function draw() {
  const dpr = devicePixelRatio || 1, w = ui.map.clientWidth, h = ui.map.clientHeight;
  if (ui.map.width !== Math.round(w * dpr) || ui.map.height !== Math.round(h * dpr)) {
    ui.map.width = Math.round(w * dpr);
    ui.map.height = Math.round(h * dpr);
    fitView();
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!S?.view) return;

  const status = lastAt(S.status, S.t)?.status ?? 'green';
  ctx.lineJoin = ctx.lineCap = 'round';
  path(S.outline);
  ctx.strokeStyle = color(status === 'green' ? '--track' : `--track-${status}`);
  ctx.lineWidth = 12;
  ctx.stroke();
  ctx.strokeStyle = color('--track-line');
  ctx.lineWidth = 1;
  ctx.stroke();

  if (S.drs && ui.drs.checked) {
    ctx.strokeStyle = color('--drs');
    ctx.lineWidth = 4;
    for (const run of S.drs) { path(run); ctx.stroke(); }
  }

  ctx.font = `500 11px ${color('--font-data')}`;
  ctx.textBaseline = 'middle';
  const ranked = order();

  const sc = S.periods.sc.find((p) => S.t >= p.start && S.t <= p.end);
  const leader = sc && S.cum && carAt(ranked[0]);
  if (leader) {
    const [x, y] = S.view(pointAhead(S.outline, S.cum, leader, SC_LEAD));
    ctx.globalAlpha = Math.max(0, Math.min(1, (S.t - sc.start) / FADE, (sc.end - S.t) / FADE));
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.fillStyle = color('--sc');
    ctx.fill();
    ctx.fillText('SC', x + 11, y);
    ctx.globalAlpha = 1;
  }

  for (const d of ranked.reverse()) { // leader drawn last, on top
    const p = carAt(d);
    if (!p) continue;
    const [x, y] = S.view(p);
    const car = S.drivers.get(d);
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fillStyle = car.colour;
    ctx.fill();
    ctx.strokeStyle = color('--bg');
    ctx.lineWidth = 1.5;
    ctx.stroke();
    if (S.selected.has(d)) {
      ctx.beginPath();
      ctx.arc(x, y, 9.5, 0, Math.PI * 2);
      ctx.strokeStyle = color('--text');
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    if (ui.labels.checked) {
      ctx.fillStyle = color('--text');
      ctx.fillText(car.code, x + 9, y);
    }
  }
}

// ---- Leaderboard + readouts -------------------------------------------------
function order() {
  return [...S.drivers.keys()].sort((a, b) =>
    (lastAt(S.pos.get(a), S.t)?.position ?? 99) - (lastAt(S.pos.get(b), S.t)?.position ?? 99));
}

const stintOf = (d, lap) => S.stints.get(d)?.find((s) => s.lap_start <= lap && lap <= (s.lap_end ?? Infinity));
const driverLap = (d) => lastAt(S.laps.get(d), S.t)?.lap_number ?? 1;

function span(cls, text) {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text;
  return s;
}

const flagOf = (r) => (r.category === 'SafetyCar' ? 'sc' : (r.flag ?? '').toLowerCase().replace(/\s+/g, '-'));

const segment = () => S.bounds.filter((b) => b < S.t).length; // 0-based
const segLabel = (k) => `${S.session.session_name.startsWith('Sprint') ? 'SQ' : 'Q'}${k + 1}`;

// Non-race sessions: each driver's best lap in the latest segment they ran in.
function sessionBests(ranked) {
  const seg = segment(), edges = [-Infinity, ...S.bounds, Infinity];
  const out = new Map();
  for (const d of ranked) {
    for (let k = seg; k >= 0; k--) {
      const lap = bestLap(S.laps.get(d), S.t, edges[k], edges[k + 1]);
      if (lap) { out.set(d, { lap, seg: k }); break; }
    }
  }
  const fastest = Math.min(...[...out.values()].filter((b) => b.seg === seg).map((b) => b.lap.lap_duration));
  return { out, seg, fastest };
}

function renderBoard() {
  const ranked = order();
  const bests = S.isRace ? null : sessionBests(ranked);
  const rows = ranked.map((d, i) => {
    const car = S.drivers.get(d);
    const lap = driverLap(d);
    const stint = stintOf(d, lap);
    const compound = stint?.compound ?? '';
    const end = S.lastEnd.get(d) ?? Infinity;
    const out = end < S.chequer - 30e3 && S.t > end + 30e3;
    const inPit = S.pits.get(d)?.some((p) => S.t >= p.t && S.t <= p.t + (p.pit_duration ?? 20) * 1000);
    const iv = lastAt(S.ints.get(d), S.t);

    const li = document.createElement('li');
    li.dataset.driver = d;
    li.classList.toggle('out', out);
    li.classList.toggle('selected', S.selected.has(d));
    const team = span('team', '');
    team.style.background = car.colour;
    const tyre = span(`tyre tyre-${compound.toLowerCase() || 'unknown'}`, compound[0] ?? '–');
    if (stint) tyre.title = compound;
    li.append(
      span('pos', i + 1), team, span('code', car.code),
      ...(S.isRace ? [
        span('gap', out ? 'OUT' : i ? formatGap(iv?.gap_to_leader) : 'Leader'),
        span('int', inPit ? 'PIT' : i && !out ? formatGap(iv?.interval) : ''),
      ] : sessionCells(bests, d, inPit)),
      tyre, span('age', stint ? tyreAge(stint, lap) : ''),
    );
    return li;
  });
  ui.board.replaceChildren(...rows);

  ui.lap.textContent = S.isRace
    ? `Lap ${Math.min(driverLap(ranked[0]), S.totalLaps || Infinity)} / ${S.totalLaps || '–'}`
    : S.quali ? segLabel(segment()) : S.session.session_name;
  ui.clock.textContent = formatClock(S.t - S.t0);

  const w = lastAt(S.weather, S.t);
  ui.weather.textContent = w
    ? `Air ${w.air_temperature}° · Track ${w.track_temperature}° · Hum ${w.humidity}% · Wind ${w.wind_speed} m/s · ${w.rainfall ? 'Rain' : 'Dry'}`
    : '';

  // Race-control feed, newest first; only rebuilt when the visible count changes (also on rewind).
  const idx = indexAt(S.rc, S.t);
  if (idx !== S.rcShown) {
    S.rcShown = idx;
    ui.rc.replaceChildren(...S.rc.slice(Math.max(0, idx - 49), idx + 1).reverse().map((r) => {
      const item = document.createElement('li');
      item.dataset.flag = flagOf(r);
      item.append(span('rc-time', r.t < S.t0 ? 'Pre-start' : formatClock(r.t - S.t0)), ` ${r.message ?? ''}`);
      return item;
    }));
  }
  if (S.playing) syncScrub();
}

// Best-lap cells: time in the driver's latest segment; delta to the fastest in the current
// segment, or the segment label (e.g. Q1) when their time comes from an earlier one.
function sessionCells({ out, seg, fastest }, d, inPit) {
  const b = out.get(d);
  if (!b) return [span('gap', ''), span('int', inPit ? 'PIT' : '')];
  const dur = b.lap.lap_duration;
  const delta = b.seg < seg ? (S.quali ? segLabel(b.seg) : '') : dur === fastest ? '' : `+${(dur - fastest).toFixed(3)}`;
  return [span('gap', formatLap(dur, 3)), span('int', inPit ? 'PIT' : delta)];
}

// Scrubber position + its filled part (--fill drives the WebKit track gradient).
function syncScrub() {
  const v = Math.round((S.t - S.t0) / 1000);
  ui.scrub.value = v;
  ui.scrub.style.setProperty('--fill', `${(v / (Number(ui.scrub.max) || 1)) * 100}%`);
}

function setStatus(text) {
  ui.status.textContent = text;
  ui.status.hidden = !text;
}

// ---- Insights ---------------------------------------------------------------
// Every panel shows only what has happened by the playhead S.t.
let tab = 'telemetry';
const hover = new Map(); // chart canvas -> pointer { x, cx, cy } while over it

function buildPicker() {
  ui.picker.replaceChildren(...order().map((d) => {
    const car = S.drivers.get(d);
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = d;
    const sw = span('swatch', '');
    sw.style.background = car.colour;
    label.append(box, sw, car.code);
    return label;
  }));
}

function syncPicker() {
  for (const box of ui.picker.querySelectorAll('input')) box.checked = S.selected.has(Number(box.value));
}

// car_data sample at the playhead; fetched per driver per window on first ask.
function carData(d) {
  const i = chunkIndex(S.t), key = `${d}:${i}`;
  const rows = S.car.get(key);
  if (rows === undefined) {
    S.car.set(key, 'loading');
    const id = loadId;
    api(`car_data?session_key=${S.session.session_key}&driver_number=${d}&${windowQuery(i)}`)
      .then((r) => id === loadId && S.car.set(key, timed(r)))
      .catch(() => id === loadId && S.car.set(key, [])); // cache the failure: no retry loop
    return null;
  }
  return Array.isArray(rows) ? lastAt(rows, S.t) : null;
}

function meter(cls, value) {
  const pct = Math.min(100, Math.max(0, value ?? 0));
  const track = span(`bar-track ${cls}`, '');
  const fill = span('bar-fill', '');
  fill.style.width = `${pct}%`;
  track.title = `${cls} ${Math.round(pct)}%`;
  track.append(fill);
  return track;
}

function renderTelemetry() {
  ui.telemetry.replaceChildren(...[...S.selected].map((d) => {
    const car = S.drivers.get(d), c = carData(d);
    const li = document.createElement('li');
    const sw = span('swatch', '');
    sw.style.background = car.colour;
    li.append(
      sw, span('code', car.code),
      span('speed', c ? `${c.speed} km/h` : '…'), span('gear', c ? `G${c.n_gear}` : ''),
      meter('throttle', c?.throttle), meter('brake', c?.brake),
      span(`drs-badge${(c?.drs ?? 0) >= 10 ? ' on' : ''}`, 'DRS'),
      ...wearCells(d),
    );
    return li;
  }));
}

// Measured tyre wear on the current stint (port of the original's degradation model, option B).
const WEAR_FULL_S = 2; // time lost vs new tyres at which the bar is full / red
function wearCells(d) {
  const lap = driverLap(d), stint = stintOf(d, lap);
  const wear = stint && tyreWear(S.laps.get(d), stint, S.t);
  if (!wear) return [span('wear', 'Wear: after 3 laps'), span('', '')];
  const loss = Math.max(0, wear.rate) * tyreAge(stint, lap);
  const pct = Math.min(100, (loss / WEAR_FULL_S) * 100);
  const bar = meter('wear', pct);
  bar.title = `${loss.toFixed(1)} s lost vs new tyres (${wear.n} laps measured)`;
  bar.firstChild.style.setProperty('--wear', `${pct}%`);
  const sign = wear.rate >= 0 ? '+' : '';
  return [span('wear', `Wear ${sign}${wear.rate.toFixed(2)} s/lap · ~${loss.toFixed(1)} s lost`), bar];
}

// Series for drivers; a teammate (same team colour as an earlier series) gets a dashed line.
function seriesFor(ids, pointsOf) {
  const seen = new Set();
  return ids.map((d) => {
    const car = S.drivers.get(d);
    const dashed = seen.has(car.colour);
    seen.add(car.colour);
    return { label: car.code, colour: car.colour, dashed, dim: S.selected.size > 0 && !S.selected.has(d), points: pointsOf(d) };
  });
}

// Line chart by lap: series [{ label, colour, dashed, dim, points: [{ x: lap, y }] }].
// invert puts low y at the top (positions). Hover draws a crosshair and fills #tip.
// xFmt labels x; discrete (lap numbers) snaps hover to whole x, otherwise nearest point per series.
function lineChart(canvas, series, { invert = false, yDomain, yFmt = String, xFmt = (x) => `Lap ${x}`, discrete = true } = {}) {
  const dpr = devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const c = canvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.font = `11px ${color('--font-data')}`;
  c.fillStyle = color('--text-dim');
  const pts = series.flatMap((s) => s.points);
  if (!pts.length) { c.fillText('No finished laps yet.', 8, 16); return; }

  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const [y0, y1] = yDomain ?? [Math.min(...ys), Math.max(...ys)];
  const L = 52, R = 12, T = 10, B = 22, pw = w - L - R, ph = h - T - B;
  const sx = (x) => L + ((x - x0) / (x1 - x0 || 1)) * pw;
  const sy = (y) => T + ((invert ? y - y0 : y1 - y) / (y1 - y0 || 1)) * ph;

  c.strokeStyle = color('--border');
  c.lineWidth = 1;
  c.textBaseline = 'middle';
  for (let k = 0; k <= 4; k++) {
    const v = y0 + ((y1 - y0) * k) / 4, y = sy(v);
    c.beginPath(); c.moveTo(L, y); c.lineTo(w - R, y); c.stroke();
    c.fillText(yFmt(v), 4, y);
  }
  c.textBaseline = 'top';
  c.fillText(xFmt(x0), L, h - B + 6);
  c.textAlign = 'right';
  c.fillText(xFmt(x1), w - R, h - B + 6);
  c.textAlign = 'left';

  c.save();
  c.beginPath(); c.rect(L, T, pw, ph); c.clip();
  c.lineWidth = 2;
  c.lineJoin = 'round';
  for (const s of [...series].sort((a, b) => b.dim - a.dim)) { // dimmed lines underneath
    c.globalAlpha = s.dim ? 0.2 : 1;
    c.setLineDash(s.dashed ? [5, 4] : []);
    c.strokeStyle = s.colour;
    c.beginPath();
    s.points.forEach((p, i) => (i ? c.lineTo : c.moveTo).call(c, sx(p.x), sy(p.y)));
    c.stroke();
  }
  c.restore();

  const hv = hover.get(canvas);
  if (!hv) return; // other charts may own the tooltip
  const xv = x0 + ((hv.x - L) / (pw || 1)) * (x1 - x0);
  const at = discrete ? Math.round(xv) : xv;
  if (at < x0 || at > x1) { ui.tip.hidden = true; return; }
  c.strokeStyle = color('--text-dim');
  c.lineWidth = 1;
  c.beginPath(); c.moveTo(sx(at), T); c.lineTo(sx(at), T + ph); c.stroke();
  const nearest = (ps) => ps.reduce((m, p) => (!m || Math.abs(p.x - at) < Math.abs(m.x - at) ? p : m), null);
  const rows = series.filter((s) => !s.dim)
    .map((s) => [s.label, discrete ? s.points.find((p) => p.x === at) : nearest(s.points)])
    .filter(([, p]) => p)
    .sort((a, b) => a[1].y - b[1].y)
    .map(([label, p]) => `${label.padEnd(4)} ${yFmt(p.y)}`);
  ui.tip.textContent = [xFmt(discrete ? at : Math.round(at)), ...rows].join('\n');
  ui.tip.hidden = false;
  ui.tip.style.left = `${Math.min(hv.cx + 14, innerWidth - ui.tip.offsetWidth - 8)}px`;
  ui.tip.style.top = `${hv.cy + 14}px`;
}

function renderLaps() {
  const ids = S.selected.size ? [...S.selected] : order().slice(0, 3);
  const series = seriesFor(ids, (d) => lapsDone(S.laps.get(d), S.t).map((l) => ({ x: l.lap_number, y: l.lap_duration })))
    .map((s) => ({ ...s, dim: false }));
  const ys = series.flatMap((s) => s.points.map((p) => p.y)).sort((a, b) => a - b);
  // Clip pit and SC laps so racing laps aren't flattened.
  const yDomain = ys.length ? [ys[0], Math.min(ys.at(-1), ys[Math.floor(ys.length / 2)] * 1.12)] : undefined;
  renderLegend(ui.lapsLegend, series);
  lineChart(ui.lapsChart, series, { yDomain, yFmt: formatLap });
}

function renderLegend(el, series, text = (s) => s.label) {
  el.replaceChildren(...series.map((s) => {
    const item = span('', '');
    const line = document.createElement('i');
    line.className = s.dashed ? 'dashed' : '';
    line.style.borderColor = s.colour;
    item.append(line, text(s));
    return item;
  }));
}

// Distance trace of a driver's fastest lap finished by the playhead; fetched once per lap.
function fastestTrace(d) {
  const lap = bestLap(S.laps.get(d), S.t);
  if (!lap) return { lap, points: [] };
  const key = `${d}:${lap.lap_number}`, hit = S.traces.get(key);
  if (hit === undefined) {
    S.traces.set(key, 'loading');
    const id = loadId;
    const win = `session_key=${S.session.session_key}&driver_number=${d}`
      + `&date>${new Date(lap.t).toISOString()}&date<${new Date(lap.t + lap.lap_duration * 1000).toISOString()}`;
    Promise.all([api(`location?${win}`), api(`car_data?${win}`)])
      .then(([loc, car]) => id === loadId && S.traces.set(key, lapTrace(timed(loc.filter((r) => r.x || r.y)), timed(car))))
      .catch(() => id === loadId && S.traces.set(key, [])); // cache the failure: no retry loop
  }
  return { lap, points: Array.isArray(hit) ? hit : [] };
}

// Port of the qualifying screen's telemetry: speed / throttle / brake / gear over lap distance.
function renderFastest() {
  const ids = S.selected.size ? [...S.selected] : order().slice(0, 2);
  const traces = ids.map(fastestTrace);
  const base = seriesFor(ids, () => []).map((s) => ({ ...s, dim: false }));
  renderLegend(ui.fastLegend, base, (s) => {
    const lap = traces[base.indexOf(s)].lap;
    return lap ? `${s.label} ${formatLap(lap.lap_duration, 3)} (lap ${lap.lap_number})` : `${s.label} –`;
  });
  const chart = (canvas, key, opts) => lineChart(
    canvas,
    base.map((s, i) => ({ ...s, points: traces[i].points.map((p) => ({ x: p.x, y: p[key] })) })),
    { xFmt: (x) => `${Math.round(x)}% of lap`, discrete: false, ...opts },
  );
  chart(ui.fastSpeed, 'speed', { yFmt: (v) => `${Math.round(v)}` });
  chart(ui.fastThrottle, 'throttle', { yDomain: [0, 100], yFmt: (v) => `${Math.round(v)}%` });
  chart(ui.fastBrake, 'brake', { yDomain: [0, 100], yFmt: (v) => `${Math.round(v)}%` });
  chart(ui.fastGear, 'gear', { yDomain: [0, 8], yFmt: (v) => `G${Math.round(v)}` });
}

function renderPositions() {
  const series = seriesFor(order(), (d) => lapsDone(S.laps.get(d), S.t)
    .map((l) => ({ x: l.lap_number, y: lastAt(S.pos.get(d), l.t + l.lap_duration * 1000)?.position }))
    .filter((p) => p.y));
  lineChart(ui.posChart, series, { invert: true, yDomain: [1, S.drivers.size], yFmt: (v) => `P${Math.round(v)}` });
}

function renderSectors() {
  const { overall, personal } = sectorBests(S.laps, S.t);
  const cell = (text, cls = '') => {
    const td = document.createElement('td');
    td.textContent = text;
    td.className = cls;
    return td;
  };
  ui.sectors.replaceChildren(...order().map((d, i) => {
    const last = lapsDone(S.laps.get(d), S.t).at(-1);
    const secs = [last?.duration_sector_1, last?.duration_sector_2, last?.duration_sector_3];
    const tr = document.createElement('tr');
    tr.append(
      cell(i + 1), cell(S.drivers.get(d).code), cell(last?.lap_number ?? ''),
      ...secs.map((s, k) => cell(s ? s.toFixed(3) : '', !s ? '' : s <= overall[k] ? 'ob' : s <= personal.get(d)[k] ? 'pb' : '')),
      cell(last ? formatLap(last.lap_duration) : ''),
    );
    return tr;
  }));
}

function renderTyres() {
  const total = S.totalLaps || 1;
  ui.tyres.replaceChildren(...order().map((d) => {
    const track = span('stint-track', '');
    for (const b of stintBars(S.stints.get(d), driverLap(d))) {
      const seg = span(`tyre-${b.compound.toLowerCase() || 'unknown'}`, b.compound[0] ?? '');
      seg.style.left = `${((b.from - 1) / total) * 100}%`;
      seg.style.width = `${((b.to - b.from + 1) / total) * 100}%`;
      seg.title = `${b.compound || 'Unknown'} · laps ${b.from}–${b.to}`;
      track.append(seg);
    }
    const li = document.createElement('li');
    li.append(span('code', S.drivers.get(d).code), track);
    return li;
  }));
}

function renderInsights() {
  if (!S) return;
  ({
    telemetry: renderTelemetry, laps: renderLaps, positions: renderPositions,
    sectors: renderSectors, tyres: renderTyres, fastest: renderFastest,
  })[tab]();
}

function selectTab(name) {
  tab = name;
  for (const o of ui.tabs) {
    o.setAttribute('aria-selected', String(o.dataset.tab === name));
    $(o.getAttribute('aria-controls')).hidden = o.dataset.tab !== name;
  }
  ui.tip.hidden = true;
  renderInsights();
}

for (const b of ui.tabs) b.addEventListener('click', () => selectTab(b.dataset.tab));

for (const cv of document.querySelectorAll('canvas.chart')) {
  cv.addEventListener('pointermove', (e) => {
    hover.set(cv, { x: e.offsetX, cx: e.clientX, cy: e.clientY });
    renderInsights();
  });
  cv.addEventListener('pointerleave', () => { hover.delete(cv); ui.tip.hidden = true; });
}

ui.picker.addEventListener('change', (e) => {
  if (!S) return;
  const d = Number(e.target.value);
  if (e.target.checked) S.selected.add(d); else S.selected.delete(d);
  renderBoard();
  renderInsights();
});

// Leaderboard rows rebuild every 250 ms, so use pointerdown (a click can straddle a rebuild).
// Click = just this driver (again = clear); shift-click = add/remove.
ui.board.addEventListener('pointerdown', (e) => {
  const li = e.target.closest('li[data-driver]');
  if (!li || !S) return;
  const d = Number(li.dataset.driver);
  if (e.shiftKey) {
    if (S.selected.has(d)) S.selected.delete(d); else S.selected.add(d);
  } else {
    S.selected = new Set(S.selected.size === 1 && S.selected.has(d) ? [] : [d]);
  }
  syncPicker();
  renderBoard();
  renderInsights();
});

// ---- Loop -------------------------------------------------------------------
let last = performance.now(), lastBoard = 0;
function frame(now) {
  if (S) {
    const ready = S.chunks[chunkIndex(S.t)] instanceof Map;
    if (S.playing && ready) S.t = Math.min(S.t1, S.t + (now - last) * S.speed);
    if (S.playing && S.t >= S.t1) setPlaying(false);
    if (!S.outline) setStatus('Loading track…');
    else if (!ready) setStatus('Buffering car positions…');
    else setStatus('');
    if (now - lastBoard > 250) {
      renderBoard();
      renderInsights();
      if (ui.standings.open) renderStandings();
      lastBoard = now;
    }
  }
  last = now;
  draw();
  requestAnimationFrame(frame);
}

// ---- Controls ---------------------------------------------------------------
function setPlaying(on) {
  if (!S) return;
  if (on && S.t >= S.t1) S.t = S.t0;
  S.playing = on;
  ui.play.textContent = on ? '❚❚' : '▶';
  ui.play.setAttribute('aria-label', on ? 'Pause' : 'Play');
}

function seek(t) {
  if (!S) return;
  S.t = Math.min(S.t1, Math.max(S.t0, t));
  syncScrub();
  renderBoard();
}

function setSpeed(i) {
  const idx = Math.min(SPEEDS.length - 1, Math.max(0, i));
  ui.speed.value = SPEEDS[idx];
  if (S) S.speed = SPEEDS[idx];
}

ui.speed.replaceChildren(...SPEEDS.map((s) => option(s, `${s}×`)));
ui.speed.value = 1;
ui.speed.addEventListener('change', () => { if (S) S.speed = Number(ui.speed.value); savePrefs(); });
ui.labels.addEventListener('change', savePrefs);
ui.drs.addEventListener('change', savePrefs);
ui.standingsBtn.addEventListener('click', () => showStandings('drivers'));
for (const b of ui.standingsKinds) b.addEventListener('click', () => showStandings(b.dataset.kind));
ui.clearCache.addEventListener('click', async () => {
  await globalThis.caches?.delete(CACHE).catch(() => {});
  ui.clearCache.textContent = 'Saved data cleared';
});
ui.play.addEventListener('click', () => setPlaying(!S?.playing));
ui.scrub.addEventListener('input', () => S && seek(S.t0 + Number(ui.scrub.value) * 1000));
ui.year.addEventListener('change', () => loadSeason(ui.year.value));
ui.race.addEventListener('change', () => {
  const s = sessions.find((x) => String(x.session_key) === ui.race.value);
  if (s) loadRace(s);
});

const toggleHelp = () => (ui.help.open ? ui.help.close() : ui.help.showModal());
ui.helpBtn.addEventListener('click', toggleHelp);

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest('button') && (e.key === ' ' || e.key === 'Enter')) return; // let the button act
  if (e.key.toLowerCase() === 'h') { e.preventDefault(); toggleHelp(); return; }
  if (!S || ui.help.open) return;
  const speedIdx = SPEEDS.indexOf(Number(ui.speed.value));
  const keys = {
    ' ': () => setPlaying(!S.playing),
    ArrowLeft: () => seek(S.t - 10e3),
    ArrowRight: () => seek(S.t + 10e3),
    ',': () => seek(S.t - 1e3),
    '.': () => seek(S.t + 1e3),
    ArrowUp: () => setSpeed(speedIdx + 1),
    ArrowDown: () => setSpeed(speedIdx - 1),
    r: () => seek(S.t0),
    l: () => (ui.labels.checked = !ui.labels.checked),
    d: () => (ui.drs.checked = !ui.drs.checked),
    b: () => (ui.events.hidden = !ui.events.hidden),
    c: () => showStandings('drivers'),
    a: () => showStandings('teams'),
  };
  const fn = keys[e.key] ?? keys[e.key.toLowerCase()];
  if (fn) { e.preventDefault(); fn(); savePrefs(); }
});

// ---- Standings ----------------------------------------------------------------
const RACE_PTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
const SPRINT_PTS = [8, 7, 6, 5, 4, 3, 2, 1];
let standingsKind = 'drivers';

// Championship before this session plus points for the running order at the playhead.
async function showStandings(kind) {
  if (!S) return;
  standingsKind = kind;
  for (const b of ui.standingsKinds) b.setAttribute('aria-pressed', String(b.dataset.kind === kind));
  if (!ui.standings.open) ui.standings.showModal();
  if (!S.standings && S.isRace) {
    const k = `session_key=${S.session.session_key}`, mine = S;
    ui.standingsNote.textContent = 'Loading…';
    try {
      const [drivers, teams] = await Promise.all([api(`championship_drivers?${k}`), api(`championship_teams?${k}`)]);
      if (mine !== S) return;
      S.standings = { drivers, teams };
    } catch (err) {
      if (mine === S) ui.standingsNote.textContent = `Couldn't load standings (${err.message}).`;
      return;
    }
  }
  renderStandings();
}

function renderStandings() {
  if (!S) return;
  if (S.isRace && !S.standings) return; // still loading
  const { drivers, teams } = S.standings ?? { drivers: [], teams: [] };
  ui.standingsTitle.textContent = standingsKind === 'drivers' ? "Drivers' championship" : "Constructors' championship";
  const list = standingsKind === 'drivers' ? drivers : teams;
  if (!S.isRace || !list.length) {
    ui.standingsBody.replaceChildren();
    ui.standingsNote.textContent = S.isRace ? 'No standings published for this session.' : 'Standings are shown for races and sprints — pick one of those.';
    return;
  }
  const pts = S.session.session_name === 'Sprint' ? SPRINT_PTS : RACE_PTS;
  const byDriver = new Map(order().map((d, i) => [d, pts[i] ?? 0]));
  const gained = new Map();
  if (standingsKind === 'drivers') for (const [d, p] of byDriver) gained.set(d, p);
  else for (const [d, p] of byDriver) { const t = S.drivers.get(d)?.team; gained.set(t, (gained.get(t) ?? 0) + p); }
  const rows = list.map((r) => standingsKind === 'drivers'
    ? { key: r.driver_number, label: S.drivers.get(r.driver_number)?.code ?? `#${r.driver_number}`, start: r.points_start ?? 0 }
    : { key: r.team_name, label: r.team_name ?? '–', start: r.points_start ?? 0 });
  const cell = (text) => { const td = document.createElement('td'); td.textContent = text; return td; };
  ui.standingsBody.replaceChildren(...liveStandings(rows, gained).map((r, i) => {
    const tr = document.createElement('tr');
    tr.append(cell(i + 1), cell(r.label), cell(r.total), cell(r.gain ? `+${r.gain}` : ''));
    return tr;
  }));
  ui.standingsNote.textContent = 'Live: standings before this session plus points for the current running order.';
}

// ---- Preferences --------------------------------------------------------------
const PREFS = 'f1live.prefs';

function savePrefs() {
  try {
    localStorage.setItem(PREFS, JSON.stringify({
      speed: Number(ui.speed.value), names: ui.labels.checked, drs: ui.drs.checked, events: !ui.events.hidden,
    }));
  } catch {
    // storage blocked: preferences just aren't remembered
  }
}

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS) ?? '{}') ?? {};
    if (SPEEDS.includes(p.speed)) ui.speed.value = p.speed;
    if (typeof p.names === 'boolean') ui.labels.checked = p.names;
    if (typeof p.drs === 'boolean') ui.drs.checked = p.drs;
    if (typeof p.events === 'boolean') ui.events.hidden = !p.events;
  } catch {
    // corrupt or blocked storage: keep defaults
  }
}

// ---- Boot -------------------------------------------------------------------
loadPrefs();
const thisYear = new Date().getFullYear();
for (let y = thisYear; y >= FIRST_SEASON; y--) ui.year.append(option(y, y));

(async () => {
  const key = new URLSearchParams(location.search).get('session');
  try {
    const [s] = key ? await api(`sessions?session_key=${encodeURIComponent(key)}`) : [];
    ui.year.value = s ? s.year : thisYear;
    await loadSeason(ui.year.value, s?.session_key);
    // Early in a season there may be nothing finished yet — fall back a year.
    if (!ui.race.value && ui.year.value == thisYear) { ui.year.value = thisYear - 1; await loadSeason(thisYear - 1); }
  } catch (err) {
    setStatus(`Couldn't reach OpenF1 (${err.message}).`);
  }
})();

requestAnimationFrame(frame);
