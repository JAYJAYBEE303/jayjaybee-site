import { toMs, byDriver, lastAt, sampleAt, lapOutline, formatGap, formatClock } from './replay.js';

const API = 'https://api.openf1.org/v1/';
const CHUNK = 5 * 60e3; // location data is fetched in 5-minute windows
const PAD = 2e3; // windows overlap so interpolation never gaps at a boundary
const SPEEDS = [0.5, 1, 2, 4, 8, 16, 32, 64];
const FIRST_SEASON = 2023; // OpenF1 history starts here

const $ = (id) => document.getElementById(id);
const ui = {
  year: $('year'), race: $('race'), map: $('map'), status: $('status'),
  lap: $('lap'), clock: $('clock'), board: $('board'), rc: $('rc'),
  play: $('play'), scrub: $('scrub'), speed: $('speed'), labels: $('labels'),
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
    const [drivers, laps, position, stints, intervals, raceControl] = await Promise.all([
      api(`drivers?${k}`), api(`laps?${k}`), api(`position?${k}`),
      api(`stints?${k}`), api(`intervals?${k}`), api(`race_control?${k}`),
    ]);
    if (id !== loadId) return;

    const lapsBy = byDriver(laps, 'date_start');
    const lap1 = laps.filter((l) => l.lap_number === 1 && l.date_start).map((l) => toMs(l.date_start));
    const lapEnds = laps.filter((l) => l.date_start && l.lap_duration).map((l) => toMs(l.date_start) + l.lap_duration * 1000);
    const t0 = lap1.length ? Math.min(...lap1) : toMs(session.date_start);
    const t1 = lapEnds.length ? Math.max(...lapEnds) : toMs(session.date_end);

    S = {
      session, t0, t1, t: t0, playing: false,
      drivers: new Map(drivers.map((d) => [d.driver_number, {
        code: d.name_acronym ?? String(d.driver_number),
        colour: /^[0-9a-f]{6}$/i.test(d.team_colour ?? '') ? `#${d.team_colour}` : color('--text-dim'),
      }])),
      laps: lapsBy,
      totalLaps: Math.max(0, ...laps.map((l) => l.lap_number)),
      pos: byDriver(position),
      ints: byDriver(intervals),
      stints: Map.groupBy(stints, (s) => s.driver_number),
      rc: raceControl.map((r) => ({ ...r, t: toMs(r.date) })).sort((a, b) => a.t - b.t),
      chunks: Array.from({ length: Math.max(1, Math.ceil((t1 - t0) / CHUNK)) }),
      outline: null,
      view: null,
    };
    ui.scrub.max = Math.round((t1 - t0) / 1000);
    ui.scrub.value = 0;
    renderBoard();
    loadChunks(id);
  } catch (err) {
    if (id === loadId) setStatus(`Couldn't load this race (${err.message}). Try again shortly.`);
  }
}

const chunkIndex = (t) => Math.min(S.chunks.length - 1, Math.max(0, Math.floor((t - S.t0) / CHUNK)));

// Fetch location windows, always preferring the one at (or just after) the playhead.
async function loadChunks(id) {
  for (;;) {
    let i = S.chunks.findIndex((c, j) => !c && j >= chunkIndex(S.t));
    if (i < 0) i = S.chunks.findIndex((c) => !c);
    if (i < 0) return;
    S.chunks[i] = 'loading';
    const from = new Date(S.t0 + i * CHUNK - PAD).toISOString();
    const to = new Date(S.t0 + (i + 1) * CHUNK + PAD).toISOString();
    let rows;
    try {
      rows = await api(`location?session_key=${S.session.session_key}&date>${from}&date<${to}`);
    } catch (err) {
      if (id === loadId) { S.chunks[i] = undefined; setStatus(`Couldn't load car positions (${err.message}).`); }
      return;
    }
    if (id !== loadId) return;
    // (0, 0) is OpenF1's "no fix" placeholder.
    S.chunks[i] = byDriver(rows.filter((r) => r.x || r.y), 'date', (r) => ({ x: r.x, y: r.y }));
    if (!S.outline) {
      const pts = lapOutline(S.chunks[i], S.laps);
      if (pts.length > 10) { S.outline = pts; fitView(); }
    }
  }
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

  ctx.lineJoin = ctx.lineCap = 'round';
  ctx.beginPath();
  S.outline.forEach((p, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, ...S.view(p)));
  ctx.strokeStyle = color('--track');
  ctx.lineWidth = 12;
  ctx.stroke();
  ctx.strokeStyle = color('--track-line');
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.font = `500 11px ${color('--font-data')}`;
  ctx.textBaseline = 'middle';
  for (const d of order().reverse()) { // leader drawn last, on top
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

function renderBoard() {
  const rows = order().map((d, i) => {
    const car = S.drivers.get(d);
    const lap = driverLap(d);
    const stint = S.stints.get(d)?.find((s) => s.lap_start <= lap && lap <= (s.lap_end ?? Infinity));
    const compound = stint?.compound ?? '';
    const li = document.createElement('li');
    const team = span('team', '');
    team.style.background = car.colour;
    li.append(
      span('pos', i + 1), team, span('code', car.code),
      span('gap', i ? formatGap(lastAt(S.ints.get(d), S.t)?.gap_to_leader) : 'Leader'),
      span(`tyre tyre-${compound.toLowerCase() || 'unknown'}`, compound[0] ?? '–'),
    );
    if (stint) li.lastChild.title = compound;
    return li;
  });
  ui.board.replaceChildren(...rows);

  const leader = order()[0];
  ui.lap.textContent = `Lap ${Math.min(driverLap(leader), S.totalLaps || Infinity)} / ${S.totalLaps || '–'}`;
  ui.clock.textContent = formatClock(S.t - S.t0);
  const msg = lastAt(S.rc, S.t);
  ui.rc.textContent = msg?.message ?? '';
  ui.rc.dataset.flag = msg?.category === 'SafetyCar' ? 'sc' : (msg?.flag ?? '').toLowerCase().replace(/\s+/g, '-');
  if (S.playing) ui.scrub.value = Math.round((S.t - S.t0) / 1000);
}

function setStatus(text) {
  ui.status.textContent = text;
  ui.status.hidden = !text;
}

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
    if (now - lastBoard > 250) { renderBoard(); lastBoard = now; }
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

document.addEventListener('keydown', (e) => {
  if (!S || e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey) return;
  const speedIdx = SPEEDS.indexOf(Number(ui.speed.value));
  const keys = {
    ' ': () => setPlaying(!S.playing),
    ArrowLeft: () => seek(S.t - 10e3),
    ArrowRight: () => seek(S.t + 10e3),
    ArrowUp: () => setSpeed(speedIdx + 1),
    ArrowDown: () => setSpeed(speedIdx - 1),
    r: () => seek(S.t0),
    l: () => (ui.labels.checked = !ui.labels.checked),
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
