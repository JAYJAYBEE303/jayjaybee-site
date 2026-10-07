import {
  toMs, byDriver, lastAt, indexAt, sampleAt, lapOutline, formatGap, formatClock,
  timed, trackStatusTimeline, periods, cumulative, pointAhead, drsRuns, tyreAge,
  lapsDone, sectorBests, stintBars, formatLap,
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
  events: $('events'), help: $('help'), helpBtn: $('help-btn'),
  picker: $('picker'), telemetry: $('telemetry'), lapsChart: $('laps-chart'), lapsLegend: $('laps-legend'),
  posChart: $('positions-chart'), sectors: $('sectors'), tyres: $('tyres'), tip: $('tip'),
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

async function api(path) {
  for (let attempt = 0; ; attempt++) {
    const wait = nextSlot - Date.now();
    // ponytail: fixed spacing keeps us under OpenF1's free-tier burst limit; 429s back off below.
    nextSlot = Math.max(nextSlot, Date.now()) + 400;
    if (wait > 0) await sleep(wait);
    const res = await fetch(API + path);
    if (res.ok) return res.json();
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

let sessions = []; // finished races of the selected season

async function loadSeason(year, pickKey) {
  ui.race.replaceChildren(option('', 'Loading…'));
  const now = Date.now();
  sessions = (await api(`sessions?year=${year}&session_type=Race`))
    .filter((s) => toMs(s.date_end) < now)
    .sort((a, b) => toMs(a.date_start) - toMs(b.date_start));
  if (!sessions.length) {
    ui.race.replaceChildren(option('', 'No finished races'));
    return;
  }
  ui.race.replaceChildren(...sessions.map((s) => {
    const day = new Date(s.date_start).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    return option(s.session_key, `${day} · ${s.location} · ${s.session_name}`);
  }));
  ui.race.value = String(pickKey ?? sessions.at(-1).session_key);
  if (!ui.race.value) ui.race.value = String(sessions.at(-1).session_key);
  loadRace(sessions.find((s) => String(s.session_key) === ui.race.value));
}

// ---- Loading a race ---------------------------------------------------------
async function loadRace(session) {
  const id = ++loadId;
  S = null;
  history.replaceState(null, '', `?session=${session.session_key}`);
  setStatus('Loading race data…');
  const k = `session_key=${session.session_key}`;
  try {
    const [drivers, laps, position, stints, intervals, raceControl, weather, pit] = await Promise.all([
      api(`drivers?${k}`), api(`laps?${k}`), api(`position?${k}`), api(`stints?${k}`),
      api(`intervals?${k}`), api(`race_control?${k}`), api(`weather?${k}`), api(`pit?${k}`),
    ]);
    if (id !== loadId) return;

    const lapsBy = byDriver(laps, 'date_start');
    const lap1 = laps.filter((l) => l.lap_number === 1 && l.date_start).map((l) => toMs(l.date_start));
    const lapEnd = (l) => toMs(l.date_start) + (l.lap_duration ?? 0) * 1000;
    const dated = laps.filter((l) => l.date_start);
    const t0 = lap1.length ? Math.min(...lap1) : toMs(session.date_start);
    const t1 = dated.length ? Math.max(...dated.map(lapEnd)) : toMs(session.date_end);
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
        colour: /^[0-9a-f]{6}$/i.test(d.team_colour ?? '') ? `#${d.team_colour}` : color('--text-dim'),
      }])),
      laps: lapsBy,
      totalLaps,
      chequer: finals.length ? Math.min(...finals) : t1,
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
    };
    ui.scrub.max = Math.round((t1 - t0) / 1000);
    ui.scrub.value = 0;
    buildPicker();
    renderEvents();
    renderBoard();
    loadChunks(id);
    loadDrs(id, session);
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
function fitView() {
  if (!S?.outline) return;
  const w = ui.map.clientWidth, h = ui.map.clientHeight, pad = 32;
  const xs = S.outline.map((p) => p.x), ys = S.outline.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const scale = Math.min((w - pad * 2) / (maxX - minX || 1), (h - pad * 2) / (maxY - minY || 1));
  const ox = (w - (maxX - minX) * scale) / 2, oy = (h - (maxY - minY) * scale) / 2;
  // World y points up, screen y points down.
  S.view = (p) => [ox + (p.x - minX) * scale, oy + (maxY - p.y) * scale];
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

const driverLap = (d) => lastAt(S.laps.get(d), S.t)?.lap_number ?? 1;

function span(cls, text) {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text;
  return s;
}

const flagOf = (r) => (r.category === 'SafetyCar' ? 'sc' : (r.flag ?? '').toLowerCase().replace(/\s+/g, '-'));

function renderBoard() {
  const ranked = order();
  const rows = ranked.map((d, i) => {
    const car = S.drivers.get(d);
    const lap = driverLap(d);
    const stint = S.stints.get(d)?.find((s) => s.lap_start <= lap && lap <= (s.lap_end ?? Infinity));
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
      span('gap', out ? 'OUT' : i ? formatGap(iv?.gap_to_leader) : 'Leader'),
      span('int', inPit ? 'PIT' : i && !out ? formatGap(iv?.interval) : ''),
      tyre, span('age', stint ? tyreAge(stint, lap) : ''),
    );
    return li;
  });
  ui.board.replaceChildren(...rows);

  ui.lap.textContent = `Lap ${Math.min(driverLap(ranked[0]), S.totalLaps || Infinity)} / ${S.totalLaps || '–'}`;
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
      item.append(span('rc-time', formatClock(r.t - S.t0)), ` ${r.message ?? ''}`);
      return item;
    }));
  }
  if (S.playing) ui.scrub.value = Math.round((S.t - S.t0) / 1000);
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
    );
    return li;
  }));
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
function lineChart(canvas, series, { invert = false, yDomain, yFmt = String } = {}) {
  const dpr = devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const c = canvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.font = `11px ${color('--font-data')}`;
  c.fillStyle = color('--text-dim');
  const pts = series.flatMap((s) => s.points);
  if (!pts.length) { c.fillText('No finished laps yet.', 8, 16); ui.tip.hidden = true; return; }

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
  c.fillText(`Lap ${x0}`, L, h - B + 6);
  c.textAlign = 'right';
  c.fillText(`Lap ${x1}`, w - R, h - B + 6);
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
  const lap = hv && Math.round(x0 + ((hv.x - L) / (pw || 1)) * (x1 - x0));
  if (!hv || lap < x0 || lap > x1) { ui.tip.hidden = true; return; }
  c.strokeStyle = color('--text-dim');
  c.lineWidth = 1;
  c.beginPath(); c.moveTo(sx(lap), T); c.lineTo(sx(lap), T + ph); c.stroke();
  const rows = series.filter((s) => !s.dim)
    .map((s) => [s.label, s.points.find((p) => p.x === lap)])
    .filter(([, p]) => p)
    .sort((a, b) => a[1].y - b[1].y)
    .map(([label, p]) => `${label.padEnd(4)} ${yFmt(p.y)}`);
  ui.tip.textContent = [`Lap ${lap}`, ...rows].join('\n');
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
  ui.lapsLegend.replaceChildren(...series.map((s) => {
    const item = span('', '');
    const line = document.createElement('i');
    line.className = s.dashed ? 'dashed' : '';
    line.style.borderColor = s.colour;
    item.append(line, s.label);
    return item;
  }));
  lineChart(ui.lapsChart, series, { yDomain, yFmt: formatLap });
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
  ({ telemetry: renderTelemetry, laps: renderLaps, positions: renderPositions, sectors: renderSectors, tyres: renderTyres })[tab]();
}

for (const b of ui.tabs) {
  b.addEventListener('click', () => {
    tab = b.dataset.tab;
    for (const o of ui.tabs) {
      o.setAttribute('aria-selected', String(o === b));
      $(o.getAttribute('aria-controls')).hidden = o !== b;
    }
    ui.tip.hidden = true;
    renderInsights();
  });
}

for (const cv of [ui.lapsChart, ui.posChart]) {
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
    if (now - lastBoard > 250) { renderBoard(); renderInsights(); lastBoard = now; }
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
  ui.scrub.value = Math.round((S.t - S.t0) / 1000);
  renderBoard();
}

function setSpeed(i) {
  const idx = Math.min(SPEEDS.length - 1, Math.max(0, i));
  ui.speed.value = SPEEDS[idx];
  if (S) S.speed = SPEEDS[idx];
}

ui.speed.replaceChildren(...SPEEDS.map((s) => option(s, `${s}×`)));
ui.speed.value = 1;
ui.speed.addEventListener('change', () => S && (S.speed = Number(ui.speed.value)));
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
  };
  const fn = keys[e.key] ?? keys[e.key.toLowerCase()];
  if (fn) { e.preventDefault(); fn(); }
});

// ---- Boot -------------------------------------------------------------------
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
