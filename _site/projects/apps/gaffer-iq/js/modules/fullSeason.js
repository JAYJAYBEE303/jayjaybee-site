/**
 * js/modules/fullSeason.js
 * Layer: module. Owns the DOM for the Full Season strip on the Matchup page.
 * Side effects: DOM writes only. Reads from store; calls engine/season.js.
 * No analytical logic lives here — every number comes from engine/season.js
 * (ARCHITECTURE.md §3 hard rule 2).
 *
 * Subscriptions: data:ready, route:changed
 * Renders only while on screen (CONVENTIONS.md §8).
 *
 * UI is the "Refine" (R2) redesign: two halves split at the chip reset, one
 * <button> cell per gameweek, chip-window lanes under each half, and a
 * click-to-pin detail popover the cell morphs into. The data pipeline below
 * (rebuild → skeleton → runPlayerPass → reveal) is unchanged from the strip it
 * replaced; only the render and interaction layer is new.
 */

import { store } from '../store.js';
import {
  CHIP_RESET_AFTER_GW, SEASON_TOP_MATCHUPS, SEASON_STANDOUT_PLAYERS, SEASON_TOP_PLAYERS,
} from '../config.js';
import { buildScoreContext, bandFromValue } from '../engine/composite.js';
import {
  buildSeasonModel, buildPlayerFormCache, buildGameweekPlayers, recomputeChipWindows,
} from '../engine/season.js';

/* ─── Display vocabulary (presentation only — no thresholds live here) ───── */

/** Rank drives the tile's rank-rule length (css: --lv) and "best band" pick. */
const RANK = { excellent: 6, great: 5, good: 4, neutral: 3, tough: 2, brutal: 1, extreme: 1 };
const BAND_LABEL = {
  excellent: 'Excellent', great: 'Great', good: 'Good', neutral: 'Neutral',
  tough: 'Tough', brutal: 'Brutal', extreme: 'Extreme',
};
const BAND_ABBR = {
  excellent: 'Exc', great: 'Grt', good: 'Gd', neutral: 'Neu',
  tough: 'Tgh', brutal: 'Brt', extreme: 'Ext',
};
/** Lane order. Bench Boost (lane 4 in the design) is not computed by
 *  engine/season.js, so its lane stays hidden until it has a rule. */
const LANES = ['wildcard', 'freehit', 'triplecaptain'];
const CHIP_LABEL = { wildcard: 'Wildcard', freehit: 'Free Hit', triplecaptain: 'Triple Captain' };

/* Motion — WAAPI can't read var(), so the eases live here; colours/shadows are
   read from the css tokens at animation time (tok()). */
const RM = matchMedia('(prefers-reduced-motion: reduce)');
const SHEET_MQ = matchMedia('(max-width: 640px)');
const EASE_OUT    = 'cubic-bezier(.2,.7,.2,1)';
const EASE_WEIGHT = 'cubic-bezier(.65,0,.25,1)';
const EASE_SHEET  = 'cubic-bezier(.16,1,.3,1)';
const EASE_MORPH  = 'cubic-bezier(.5,0,.15,1)';
const EASE_CLOSE  = 'cubic-bezier(.4,0,.2,1)';
const SWEEP_MS = 1000;
const OPEN_MS = 520;
const CLOSE_MS = 340;

let _root = null, _body = null, _halves = null;
let _model = null;
/** 'idle' (no data yet) | 'loading' | 'live' | 'empty' | 'error' */
let _view = 'idle';
let _focusGw = null;

/** Safe HTML escape for any dynamic string injected via innerHTML. */
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const tok = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/* ─── Model reads ──────────────────────────────────────────────────────────── */

/** Current GW = the first upcoming week (buildSeasonModel's own currentGw). */
const isCurrent = g => !g.played && g.gw === _model.currentGw;
const chipsAt = gw => _model.chipWindows.filter(w => gw >= w.from && gw <= w.to);
const windowLabel = w =>
  `${CHIP_LABEL[w.chip] ?? w.chip} GW${w.from}${w.to !== w.from ? `–${w.to}` : ''}`;

/** Matchups arrive value-descending with postponements filled from the
 *  bottom, so the first live row is the best — but don't rely on order. */
function bestBand(g) {
  let best = null;
  for (const m of g.matchups) {
    if (m.postponed) continue;
    const b = bandFromValue(m.value);
    if (!best || RANK[b] > RANK[best]) best = b;
  }
  return best;
}

function cellLabel(g) {
  const s = `Gameweek ${g.gw}`;
  if (g.played) return `${s}, played`;
  const cur = isCurrent(g) ? ', current' : '';
  if (!g.matchups.length) return `${s}${cur}, no data`;
  const names = g.matchups.map(m => m.postponed ? 'Postponed' : BAND_LABEL[bandFromValue(m.value)]);
  let out = `${s}${cur}. Top matchups: ${names.join(', ')}.`;
  const pp = g.matchups.filter(m => m.postponed).length;
  if (pp === 1) out += ' One fixture postponed.';
  else if (pp > 1) out += ` ${pp} fixtures postponed.`;
  if (g.matchups.some(m => m.isDouble)) out += ' Double gameweek.';
  if (g.loaded) out += ' Loaded week.';
  for (const w of chipsAt(g.gw)) out += ` ${CHIP_LABEL[w.chip] ?? w.chip} window.`;
  return out;
}

/* ─── Strip markup ─────────────────────────────────────────────────────────── */

function tileHTML(m) {
  if (!m) return '<span class="season-tile season-tile--miss"></span>';
  if (m.postponed) return '<span class="season-tile season-tile--pp"></span>';
  return `<span class="season-tile" data-band="${esc(bandFromValue(m.value))}"><i></i></span>`;
}

/** One dot per top player; the first SEASON_STANDOUT_PLAYERS filled. `?? []`
 *  covers a week whose player computation threw (runPlayerPass reveals anyway). */
function dotsHTML(players) {
  return (players ?? [])
    .map((p, i) => `<i class="season-dot${i < SEASON_STANDOUT_PLAYERS ? ' season-dot--s' : ''}"></i>`)
    .join('');
}

function cellHTML(g) {
  const cur = isCurrent(g);
  const cls = ['season-cell'];
  if (g.played) cls.push('season-cell--past');
  else if (g.loaded) cls.push('season-cell--hot');
  if (cur) cls.push('season-cell--cur');

  let inner = `<span class="season-cell__n">${g.gw}</span>`;
  if (cur) inner = '<span class="season-cell__now" aria-hidden="true">Now</span>' + inner;
  if (!g.played) {
    const b = bestBand(g);
    inner += b
      ? `<span class="season-cell__band" data-band="${b}">${BAND_ABBR[b]}</span>`
      : '<span class="season-cell__band">—</span>';
    // Always SEASON_TOP_MATCHUPS tiles so every cell keeps one footprint; an
    // absent slot is drawn as "no data", never guessed.
    for (let k = 0; k < SEASON_TOP_MATCHUPS; k++) inner += tileHTML(g.matchups[k]);
    inner += `<span class="season-dots">${dotsHTML(g.players)}</span>`;
  }
  return `<button type="button" class="${cls.join(' ')}" data-gw="${g.gw}" tabindex="-1"`
    + ` aria-pressed="false" aria-label="${esc(cellLabel(g))}">${inner}</button>`;
}

/**
 * The same cell before the strip has anything final to say. The WHOLE strip
 * waits for all 38 weeks (CONVENTIONS.md §5.4 "withhold orderings, not just
 * numbers": the standout dots and chip windows rank across weeks), so loading
 * cells carry the GW number — the column's identity — and nothing else real.
 */
function skeletonCellHTML(g) {
  const n = `<span class="season-cell__n">${g.gw}</span>`;
  if (g.played) return `<div class="season-cell season-cell--past">${n}</div>`;
  const tiles = '<span class="season-tile skeleton"></span>'.repeat(SEASON_TOP_MATCHUPS);
  return `<div class="season-cell season-cell--pending">${n}`
    + `<span class="season-cell__band skeleton">Grt</span>${tiles}</div>`;
}

function lanesHTML(from, to) {
  const bars = _model.chipWindows
    .filter(w => LANES.includes(w.chip) && w.from >= from && w.from <= to)
    .map(w => `<span class="season-lane season-lane--${w.chip}"`
      + ` style="grid-row:${LANES.indexOf(w.chip) + 1};grid-column:${w.from - from + 1} / ${Math.min(w.to, to) - from + 2}"`
      + ` title="${esc(windowLabel(w))}"></span>`)
    .join('');
  return bars;
}

function lanesText(from, to) {
  const list = _model.chipWindows.filter(w => w.from >= from && w.from <= to);
  return list.length
    ? `Chip windows: ${list.map(windowLabel).join(' · ')}`
    : 'No chip windows in this half';
}

/** Played weeks take 0.6 of an upcoming week's width, so every live cell in
 *  both halves stays the same width (design: 17fr / 19fr at five played). */
const colsOf = gs => gs.map(g => g.played ? 'minmax(0,.6fr)' : 'minmax(0,1fr)').join(' ');
const unitsOf = gs => gs.reduce((s, g) => s + (g.played ? 0.6 : 1), 0).toFixed(1);

function halfHTML(gs, note) {
  const from = gs[0].gw, to = gs[gs.length - 1].gw;
  const live = _view === 'live';
  const cols = `--season-cols:${colsOf(gs)}`;
  return '<div class="season-half">'
    + `<div class="season-half__head"><span class="season-half__title">GW${from}–${to}</span>`
    + (note ? `<span class="season-half__note">${note}</span>` : '') + '</div>'
    + `<div class="season-grid" style="${cols}">${gs.map(live ? cellHTML : skeletonCellHTML).join('')}</div>`
    + (live
      ? `<div class="season-grid season-lanes" style="${cols}" aria-hidden="true">${lanesHTML(from, to)}</div>`
        + `<p class="season-lanes-text">${esc(lanesText(from, to))}</p>`
      : '')
    + '</div>';
}

/** Static key — every mark on the strip is named here. */
function keyHTML() {
  const item = (sw, text) => `<span class="season-key__item"><span class="season-key__sw">${sw}</span>${text}</span>`;
  const row = (label, items) =>
    `<span class="season-key__lbl">${label}</span><span class="season-key__row">${items.join('')}</span>`;
  const bands = ['excellent', 'great', 'good', 'neutral']
    .map(b => item(`<span class="season-tile" data-band="${b}"><i></i></span>`, `<b>${BAND_LABEL[b]}</b>`));
  return '<div class="season-key" role="note" aria-label="Key">'
    + row('Bands', [
      ...bands,
      item('<span class="season-tile season-tile--pp"></span>', '<b>Postponed</b>'),
      item('<span class="season-tile season-tile--miss"></span>', 'No data'),
    ])
    + row('Marks', [
      item('<span class="season-dots"><i class="season-dot season-dot--s"></i><i class="season-dot"></i></span>',
        'Standout · top five'),
      item('<span class="season-tag">×2</span>', 'Double'),
      item('<span class="season-key__hot"></span>', 'Loaded'),
      '<span class="season-key__item season-key__note">Bar length = band, so tiles read in order without colour</span>',
    ])
    + row('Chip lanes', LANES.map((c, i) =>
      item(`<span class="season-lane season-lane--${c}"></span>`, `${i + 1} · ${CHIP_LABEL[c]}`)))
    + '</div>';
}

const STATE_EMPTY = '<div class="season-state"><h3 class="season-state__t">No season to show yet</h3>'
  + '<p>FPL hasn’t published this season’s fixtures. The strip fills in once gameweeks are scheduled.</p></div>';
const STATE_ERROR = '<div class="season-state season-state--err" role="alert">'
  + '<h3 class="season-state__t">Full season didn’t load</h3>'
  + '<p>The rest of the matchup loaded; the season model didn’t. Nothing is shown rather than a partial season.</p>'
  + '<button type="button" class="season-btn" data-retry>Retry</button></div>';

function render() {
  if (!_body) return;
  forceClose();
  _halves = null;
  if (_view === 'idle') return;
  if (_view === 'empty') { _body.innerHTML = STATE_EMPTY; return; }
  if (_view === 'error') { _body.innerHTML = STATE_ERROR; return; }

  const live = _view === 'live';
  const a = _model.gameweeks.slice(0, CHIP_RESET_AFTER_GW);
  const b = _model.gameweeks.slice(CHIP_RESET_AFTER_GW);
  const attrs = live
    ? 'role="toolbar" aria-label="Full season, gameweeks 1 to 38. Arrow keys move, Page Up and Page Down jump 10, Enter opens detail"'
    : 'role="group" aria-label="Full season, still calculating" aria-busy="true"';
  _body.innerHTML = keyHTML()
    + `<div class="season-halves" ${attrs} style="--season-halves:minmax(0,${unitsOf(a)}fr) minmax(0,${unitsOf(b)}fr)">`
    + halfHTML(a, `Chips reset after GW${CHIP_RESET_AFTER_GW}`)
    + halfHTML(b, '')
    + '</div>';
  _halves = _body.querySelector('.season-halves');
  if (!live) return;

  // Roving tabindex: one tab stop, landing on the last-focused or current week.
  const list = cells();
  const start = list.find(c => +c.dataset.gw === _focusGw)
    ?? list.find(c => c.classList.contains('season-cell--cur'))
    ?? list[0];
  if (start) start.tabIndex = 0;
  sweep();
}

/* ─── Motion: load sweep ───────────────────────────────────────────────────── */

/** Cells resolve left to right, the whole strip in ~SWEEP_MS, then NOW settles. */
function sweep() {
  if (RM.matches || !_halves) return;
  const list = [..._halves.querySelectorAll('.season-cell')];
  const step = list.length > 1 ? (SWEEP_MS - 260) / (list.length - 1) : 0;
  list.forEach((el, i) => el.animate(
    [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }],
    { duration: 260, delay: Math.round(i * step), easing: EASE_OUT, fill: 'backwards' }));
  _halves.querySelector('.season-cell__now')?.animate(
    [{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }],
    { duration: 420, delay: SWEEP_MS, easing: EASE_WEIGHT, fill: 'backwards' });
}

/* ─── Popover / sheet ──────────────────────────────────────────────────────── */

let _pop = null, _scrim = null, _openGw = null, _lastGw = null;

const cells = () => (_halves ? [..._halves.querySelectorAll('button.season-cell')] : []);
const cellFor = gw => _halves?.querySelector(`button.season-cell[data-gw="${gw}"]`) ?? null;

function ensurePop() {
  if (_pop) return;
  _scrim = document.createElement('div');
  _scrim.className = 'season-pop-scrim';
  _pop = document.createElement('div');
  _pop.className = 'season-pop';
  _pop.setAttribute('role', 'dialog');
  _pop.setAttribute('aria-labelledby', 'season-pop-t');
  // Fixed to body, not inside .module-view — onRouteChanged closes it so it
  // can't float over another page.
  document.body.append(_scrim, _pop);
  _pop.addEventListener('click', e => { if (e.target.closest('.season-pop__x')) closePop(true); });
}

function crestHTML(team) {
  const img = team?.badgeUrl
    ? `<img src="${esc(team.badgeUrl)}" alt="" loading="lazy" onerror="this.remove()">`
    : '';
  return `<span class="season-crest" aria-hidden="true">${img}</span>`;
}

function sideHTML(id, fav) {
  const team = store.getTeam(id);
  const code = esc(team?.shortName ?? '?');
  return {
    crest: crestHTML(team),
    code: fav
      ? `<span class="season-pop__fav">${code}<span class="season-sr"> (favoured)</span></span>`
      : `<span>${code}</span>`,
  };
}

function matchRowHTML(m) {
  const h = sideHTML(m.homeId, !m.postponed && m.favouredId === m.homeId);
  const a = sideHTML(m.awayId, !m.postponed && m.favouredId === m.awayId);
  const teams = `<span class="season-pop__m">${h.crest}${h.code}<i>v</i>${a.code}${a.crest}`
    + `${m.isDouble ? '<span class="season-tag">×2</span>' : ''}</span>`;
  if (m.postponed) {
    return `<div class="season-pop__r">${teams}<span class="season-pop__s">`
      + '<span class="season-tile season-tile--pp"></span><span class="season-tag season-tag--pp">P–P</span>'
      + '<span class="season-bn season-bn--muted">Postponed</span></span></div>';
  }
  const b = esc(bandFromValue(m.value));
  return `<div class="season-pop__r">${teams}<span class="season-pop__s">`
    + `<span class="season-chip" data-band="${b}">${Math.round(m.value)}</span>`
    + `<span class="season-bn" data-band="${b}">${BAND_LABEL[b] ?? b}</span></span></div>`;
}

function playerRowHTML(p, i) {
  const s = i < SEASON_STANDOUT_PLAYERS;
  return `<div class="season-pop__p${s ? ' is-standout' : ''}">`
    + `<span class="season-pop__pos">${esc(p.position)}</span>`
    + `<span class="season-pop__nm">${esc(p.name)}${s ? ' <span class="season-tag">Standout</span>' : ''}</span>`
    + `<span class="season-pop__pr">£${p.price.toFixed(1)}m</span>`
    + `<b>${p.points.toFixed(1)}</b></div>`;
}

/** Backstop for a week whose player computation threw — see runPlayerPass. */
function skeletonPlayerRowsHTML() {
  return Array.from({ length: SEASON_TOP_PLAYERS }, () =>
    '<div class="season-pop__p" aria-hidden="true">'
    + '<span class="season-pop__pos skeleton">MID</span><span class="season-pop__nm skeleton">Player name</span>'
    + '<span class="season-pop__pr skeleton">£0.0m</span><b class="skeleton">0.0</b></div>').join('');
}

function popHTML(g) {
  const tags = [
    isCurrent(g) && 'Current',
    g.played ? 'Played' : g.matchups.length ? 'Upcoming' : 'No data',
    !g.played && g.loaded && 'Loaded',
  ].filter(Boolean).join(' · ');
  let h = `<div class="season-pop__t" id="season-pop-t">GW ${g.gw}<small>${tags}</small></div>`;
  if (g.played) {
    return h + '<p class="season-pop__note">Played. The strip keeps played weeks as numbers only — results live on Fixtures.</p>';
  }
  if (!g.matchups.length) {
    return h + '<p class="season-pop__note">No fixtures scheduled for this week yet. Nothing is drawn rather than a guess.</p>';
  }
  const known = Array.isArray(g.players);
  h += '<div class="season-pop__lbl">Top matchups</div>'
    + `<div class="season-pop__rows">${g.matchups.map(matchRowHTML).join('')}</div>`
    + '<div class="season-pop__lbl">Must-have players</div>'
    + `<div class="season-pop__rows"${known ? '' : ' aria-busy="true"'}>`
    + `${known ? g.players.map(playerRowHTML).join('') : skeletonPlayerRowsHTML()}</div>`;
  const cws = chipsAt(g.gw);
  if (cws.length) {
    h += `<div class="season-pop__cws">${cws.map(w =>
      `<span class="season-cw season-cw--${esc(w.chip)}">${esc(windowLabel(w))}</span>`).join('')}</div>`;
  }
  return h + `<p class="season-pop__note">${esc(g.note)}</p>`;
}

/** Centred above the cell, flipped below when there's no room, 12px inside
 *  the viewport. clientWidth/Height, not inner*: they exclude scrollbars. */
function placePop(cell) {
  if (!cell || _pop.classList.contains('season-pop--sheet')) return;
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  const r = cell.getBoundingClientRect(), pw = _pop.offsetWidth, ph = _pop.offsetHeight;
  const left = Math.min(Math.max(12, r.left + r.width / 2 - pw / 2), vw - pw - 12);
  let top = r.top - ph - 10;
  if (top < 12) top = Math.min(vh - ph - 12, r.bottom + 10);
  _pop.style.left = `${left}px`;
  _pop.style.top = `${Math.max(12, top)}px`;
}

function setPressed(gw) {
  for (const c of cells()) c.setAttribute('aria-pressed', String(+c.dataset.gw === gw));
}

function stagger(base, dx = 0) {
  _pop.querySelectorAll(
    '.season-pop__t, .season-pop__lbl, .season-pop__r, .season-pop__p, .season-pop__cws, .season-pop__note, .season-pop__x',
  ).forEach((el, i) => el.animate(
    [{ opacity: 0, transform: `translate(${dx}px, ${dx ? 0 : 8}px)` }, { opacity: 1, transform: 'none' }],
    { duration: 320, delay: base + i * 32, easing: EASE_SHEET, fill: 'backwards' }));
}

const rectKf = r => ({ left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });

/**
 * Shared-element morph: a fixed box copies the cell's rect and look and grows
 * to the popover's rect (or the reverse). Animates left/top/width/height, not
 * scale, so border and radius stay crisp; fixed, so nothing reflows.
 */
function morph(cell, from, to, toPanel) {
  const box = document.createElement('div');
  box.className = 'season-morph';
  box.setAttribute('aria-hidden', 'true');
  const clone = cell.cloneNode(true);
  clone.removeAttribute('aria-label');
  clone.style.width = `${cell.offsetWidth}px`;
  clone.style.height = `${cell.offsetHeight}px`;
  box.appendChild(clone);
  document.body.appendChild(box);

  const accent = tok('--color-accent');
  const cellLook = { backgroundColor: getComputedStyle(cell).backgroundColor, borderColor: accent, boxShadow: '0 0 0 transparent' };
  const panelLook = { backgroundColor: tok('--color-surface-raised'), borderColor: accent, boxShadow: tok('--season-shadow-pop') };
  const dur = toPanel ? OPEN_MS : CLOSE_MS;
  const frames = toPanel
    ? [
      { ...rectKf(from), ...cellLook },
      { ...rectKf({ left: from.left, top: from.top - 6, width: from.width, height: from.height }),
        ...cellLook, boxShadow: tok('--season-shadow-lift'), offset: 0.14 },
      { ...rectKf(to), ...panelLook },
    ]
    : [{ ...rectKf(from), ...panelLook }, { ...rectKf(to), ...cellLook }];
  box.animate(frames, { duration: dur, easing: toPanel ? EASE_MORPH : EASE_CLOSE, fill: 'forwards' })
    .onfinish = () => box.remove();
  clone.animate(toPanel
    ? [{ opacity: 1 }, { opacity: 1, offset: 0.12 }, { opacity: 0, offset: 0.45 }, { opacity: 0 }]
    : [{ opacity: 0 }, { opacity: 0, offset: 0.55 }, { opacity: 1 }], { duration: dur, fill: 'forwards' });
  // The real cell hides for the duration and fades back at the end.
  cell.animate([{ opacity: 0 }, { opacity: 0, offset: 0.9 }, { opacity: 1 }], { duration: dur + (toPanel ? 80 : 0) });
}

/** Selection ring: travels between cells; fades in from scale 1.15 on first show. */
function ring(cell, animate = true) {
  if (!_halves) return;
  let r = _halves.querySelector('.season-ring');
  if (!cell) {
    if (r?._on) {
      r._on = false;
      if (RM.matches) r.style.opacity = '0';
      else r.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' });
    }
    return;
  }
  if (!r) {
    r = document.createElement('span');
    r.className = 'season-ring';
    r.setAttribute('aria-hidden', 'true');
    _halves.appendChild(r);
  }
  const hb = _halves.getBoundingClientRect(), cb = cell.getBoundingClientRect();
  const x = cb.left - hb.left, y = cb.top - hb.top, from = r._on ? r._xy : null;
  r.getAnimations().forEach(a => a.cancel());
  r.style.width = `${cb.width}px`;
  r.style.height = `${cb.height}px`;
  r.style.transform = `translate(${x}px, ${y}px)`;
  r.style.opacity = '1';
  if (animate && !RM.matches) {
    if (from) {
      r.animate([{ transform: `translate(${from[0]}px, ${from[1]}px)` }, { transform: `translate(${x}px, ${y}px)` }],
        { duration: 440, easing: EASE_WEIGHT });
    } else {
      r.animate([{ opacity: 0, transform: `translate(${x}px, ${y}px) scale(1.15)` }, { opacity: 1, transform: `translate(${x}px, ${y}px)` }],
        { duration: 260, easing: EASE_SHEET });
    }
  }
  r._on = true;
  r._xy = [x, y];
}

function openPop(cell) {
  ensurePop();
  const gw = +cell.dataset.gw;
  const g = _model.gameweeks[gw - 1];
  const was = _openGw !== null;
  const prev = was ? _pop.getBoundingClientRect() : null;

  _pop.getAnimations().forEach(a => a.cancel());
  _pop.innerHTML = popHTML(g)
    + '<button type="button" class="season-btn season-pop__x">Close <kbd class="season-kbd">Esc</kbd></button>';
  const sheet = SHEET_MQ.matches;
  _pop.classList.toggle('season-pop--sheet', sheet);
  _scrim.classList.toggle('is-on', sheet);
  _pop.classList.add('is-open');
  placePop(cell);
  _openGw = gw;
  setPressed(gw);
  if (sheet) _pop.querySelector('.season-pop__x').focus({ preventScroll: true });

  if (!RM.matches) {
    if (sheet) {
      _pop.animate([{ transform: 'translateY(100%)' }, { transform: 'none' }], { duration: 380, easing: EASE_SHEET });
      stagger(140);
    } else if (was) {
      // Week switch: glide from the old spot; contents slide in from the
      // direction of travel (earlier ← / later →).
      const now = _pop.getBoundingClientRect();
      _pop.animate([{ transform: `translate(${prev.left - now.left}px, ${prev.top - now.top}px)` }, { transform: 'none' }],
        { duration: 420, easing: EASE_WEIGHT });
      stagger(60, gw > (_lastGw ?? gw) ? 14 : -14);
    } else {
      morph(cell, cell.getBoundingClientRect(), _pop.getBoundingClientRect(), true);
      _pop.animate([{ opacity: 0 }, { opacity: 0, offset: 0.97 }, { opacity: 1 }], { duration: OPEN_MS });
      stagger(OPEN_MS - 40);
    }
  }
  ring(cell);
  _lastGw = gw;
}

function hidePop() {
  if (!_pop) return;
  _pop.classList.remove('is-open', 'season-pop--sheet');
  _scrim.classList.remove('is-on');
  _pop.getAnimations({ subtree: true }).forEach(a => a.cancel());
}

function closePop(refocus) {
  if (_openGw === null) return;
  const cell = cellFor(_openGw);
  _openGw = null;
  setPressed(null);
  ring(null);
  const sheet = _pop.classList.contains('season-pop--sheet');

  if (RM.matches || !cell) hidePop();
  else if (sheet) {
    _pop.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, fill: 'forwards' })
      .onfinish = () => { if (_openGw === null) hidePop(); };
  } else {
    // Contents fade (90ms), then the box shrinks back into the cell.
    for (const k of _pop.children) k.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 90, fill: 'forwards' });
    setTimeout(() => {
      if (_openGw !== null) return;          // reopened meanwhile — leave it
      const P = _pop.getBoundingClientRect();
      hidePop();
      if (document.contains(cell)) morph(cell, P, cell.getBoundingClientRect(), false);
    }, 90);
  }
  if (refocus && cell) cell.focus({ preventScroll: true });
}

/** Instant close with no animation — used when the DOM underneath is about to
 *  be replaced (render) or the page is navigated away from. */
function forceClose() {
  _openGw = null;
  hidePop();
  document.querySelectorAll('.season-morph').forEach(el => el.remove());
}

/* ─── Interaction ──────────────────────────────────────────────────────────── */

function setRoving(cell) {
  for (const c of cells()) c.tabIndex = c === cell ? 0 : -1;
  _focusGw = +cell.dataset.gw;
}

function onBodyClick(e) {
  if (e.target.closest('[data-retry]')) { rebuild(); return; }
  const cell = e.target.closest('button.season-cell');
  if (!cell || _view !== 'live') return;
  setRoving(cell);
  if (_openGw === +cell.dataset.gw) closePop(false);
  else openPop(cell);
}

/** Arrows ±1, PageUp/Down ±10, Home/End. Move focus only — never open. */
function onBodyKeydown(e) {
  const cell = e.target.closest?.('button.season-cell');
  if (!cell) return;
  const list = cells();
  const i = list.indexOf(cell);
  const step = {
    ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, PageDown: 10, PageUp: -10,
  }[e.key];
  let n;
  if (step !== undefined) n = i + step;
  else if (e.key === 'Home') n = 0;
  else if (e.key === 'End') n = list.length - 1;
  else return;
  e.preventDefault();
  const next = list[Math.max(0, Math.min(list.length - 1, n))];
  setRoving(next);
  next.focus();
}

function onDocKeydown(e) {
  if (e.key === 'Escape' && _openGw !== null) { e.preventDefault(); closePop(true); }
}

/** Click outside the strip and the popover closes it. */
function onDocPointerdown(e) {
  if (_openGw === null) return;
  if (_pop.contains(e.target) || _halves?.contains(e.target)) return;
  closePop(false);
}

function onViewportChange() {
  if (_openGw === null) return;
  const cell = cellFor(_openGw);
  placePop(cell);
  ring(cell, false);
}

/* ─── Data pipeline (unchanged) ────────────────────────────────────────────── */

let _passId = 0;

/**
 * Fill in every gameweek's top five, one week per macrotask, then reveal the
 * whole strip at once. `_passId` abandons an in-flight pass when the data
 * refreshes underneath it; the finally block checks ownership so a superseded
 * pass never reveals on a newer pass's behalf.
 */
async function runPlayerPass(ctx) {
  const my = ++_passId;
  try {
    const formCache = buildPlayerFormCache(ctx);
    for (const g of _model.gameweeks) {
      if (my !== _passId) return;                 // superseded
      g.players = buildGameweekPlayers(g.gw, ctx, formCache);
      await new Promise(r => setTimeout(r, 0));   // yield a frame
    }
    if (my !== _passId) return;
    // First computed before players existed (pins Triple Captain to each
    // half's opening week) — recompute for real before the one reveal.
    _model.chipWindows = recomputeChipWindows(_model);
  } finally {
    // Reveal even if a week threw; a strip shimmering forever is worse than
    // one with a gap (popHTML falls back to skeleton rows for that week).
    if (my === _passId) { _view = 'live'; render(); }
  }
}

function rebuild() {
  const season = store.getSeason();
  if (!season) return;
  let ctx;
  try {
    // Exactly matchup.js's buildCtx() option set, so the strip scores every
    // fixture from the SAME inputs as the cards above it.
    ctx = buildScoreContext(season, {
      playerSummariesById: store.getAllPlayerSummaries(),
      leagueXg:            store.getLeagueXg(),
      leagueXgPrev:        store.getLeagueXgPrev(),
      leagueXgHistory:     store.getLeagueXgHistory(),
      teamXgBySlug:        store.getAllTeamXg(),
      currentGw:           store.getUpcomingGw() ?? store.getCurrentGw() ?? 1,
    });
    _model = buildSeasonModel(ctx, season, { skipPlayers: true });
  } catch (err) {
    console.error('[fullSeason] season model failed', err);
    _passId++;                                    // orphan any in-flight pass
    _model = null;
    _view = 'error';
    render();
    return;
  }
  if (!_model.gameweeks.some(g => g.matchups.length)) {
    _passId++;
    _view = 'empty';
    render();
    return;
  }
  _view = 'loading';
  render();
  runPlayerPass(ctx);
}

let _pendingRender = false;   // data changed while off screen — render on activation

function onDataReady() {
  // Rebuilding scores all 38 gameweeks — expensive. Defer it when hidden
  // (CONVENTIONS §8).
  if (store.getActiveModule() !== 'matchup') {
    _pendingRender = true;
    return;
  }
  _pendingRender = false;
  rebuild();
}

function onRouteChanged(module) {
  if (module !== 'matchup') { forceClose(); return; }
  if (!_pendingRender) return;
  _pendingRender = false;
  rebuild();
}

/** Initialise the strip. Called once from main.js on bootstrap. */
export function initFullSeason() {
  _root = document.querySelector('.season-strip');
  if (!_root) return;
  _body = _root.querySelector('.season-strip__body');
  _root.querySelector('.season-strip__nojs')?.remove();

  store.subscribe('data:ready',    onDataReady);
  store.subscribe('route:changed', onRouteChanged);

  _body.addEventListener('click', onBodyClick);
  _body.addEventListener('keydown', onBodyKeydown);
  document.addEventListener('keydown', onDocKeydown);
  document.addEventListener('pointerdown', onDocPointerdown);
  addEventListener('scroll', onViewportChange, { passive: true });
  addEventListener('resize', onViewportChange, { passive: true });

  if (store.isFresh()) onDataReady();
}
