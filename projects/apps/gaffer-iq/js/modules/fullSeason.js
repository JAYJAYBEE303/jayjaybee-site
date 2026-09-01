/**
 * js/modules/fullSeason.js
 * Layer: module. Owns the DOM for the Full Season strip on the Matchup page.
 * Side effects: DOM writes only. Reads from store; calls engine/season.js.
 * No analytical logic lives here — every number comes from engine/season.js
 * (ARCHITECTURE.md §3 hard rule 2).
 *
 * Subscriptions: data:ready, route:changed
 * Renders only while on screen (CONVENTIONS.md §8).
 * See docs/superpowers/specs/2026-09-01-full-season-strip-design.md.
 */

import { store } from '../store.js';
import { CHIP_RESET_AFTER_GW, SEASON_COL_W, SEASON_COL_WIDE } from '../config.js';
import { buildScoreContext } from '../engine/composite.js';
import { buildSeasonModel } from '../engine/season.js';

let _root = null, _ribbon = null, _rail = null;
let _model = null;

/** Safe HTML escape for any dynamic string injected via innerHTML. */
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** One collapsed column: number, three tiles, five dots. */
function columnHTML(g) {
  if (g.played) {
    return `<div class="season-gw season-gw--past" data-gw="${g.gw}">`
         + `<span class="season-gw__n">${g.gw}</span></div>`;
  }
  // Tile is the BAND TINT alone — no club swatches. The prototype drew two
  // colour chips per tile from a hard-coded palette, but a normalised Team
  // carries no club colour (only name, shortName, code, badgeUrl), and a 70px
  // badge shrunk to 9px is mud. Spec §9 asks the tile to encode one-sidedness,
  // which the tint does on its own; the clubs are named in the panel.
  const tiles = g.matchups.map(m => {
    const cls = m.postponed ? 'season-gw__tile season-gw__tile--postponed'
      : `season-gw__tile season-gw__tile--${esc(m.band)}${m.isDouble ? ' season-gw__tile--double' : ''}`;
    return `<span class="${cls}"></span>`;
  }).join('');
  const dots = (g.players ?? []).map(() => '<i class="season-gw__dot"></i>').join('');
  return `<div class="season-gw${g.loaded ? ' season-gw--hot' : ''}" data-gw="${g.gw}"
               role="button" tabindex="0" aria-expanded="false"
               aria-label="Gameweek ${g.gw}">
      <span class="season-gw__n">${g.gw}</span>
      <span class="season-gw__summary">${tiles}<span class="season-gw__dots">${dots}</span></span>
      <span class="season-gw__body"></span>
    </div>`;
}

const CHIP_CLASS = {
  wildcard:      'season-rail__cell--wildcard',
  freehit:       'season-rail__cell--freehit',
  triplecaptain: 'season-rail__cell--triplecaptain',
};

/**
 * The chip rail: one cell per gameweek, mirroring the ribbon's widths and gap
 * exactly, so a band's left edge IS its gameweek's left edge.
 *
 * Consecutive weeks of one chip are CONJOINED — bridged across the flex gap by
 * an overlay (see .season-rail__cell--bridge::after), never by a negative
 * margin. A negative margin consumes layout width and drifts every later cell
 * leftward: 32px of accumulated error by GW38 when the prototype tried it.
 *
 * Safe to call twice (Task 11 repaints after its background player pass) —
 * innerHTML replacement below always fully replaces the previous rail rather
 * than appending or double-applying state.
 */
function renderRail() {
  if (!_rail || !_model) return;
  const chipAt = gw => _model.chipWindows.find(w => gw >= w.from && gw <= w.to);
  const cells = [];
  for (const g of _model.gameweeks) {
    const w = chipAt(g.gw);
    const cls = ['season-rail__cell'];
    if (g.played) cls.push('season-rail__cell--past');
    if (w) {
      cls.push(CHIP_CLASS[w.chip]);
      if (g.gw === w.from) cls.push('season-rail__cell--head');
      // A run cannot bridge the reset: a chip window may not straddle GW19.
      const continues = g.gw !== CHIP_RESET_AFTER_GW && chipAt(g.gw + 1) === w;
      cls.push(continues ? 'season-rail__cell--bridge' : 'season-rail__cell--tail');
    }
    cells.push(`<span class="${cls.join(' ')}" data-gw="${g.gw}"></span>`);
    if (g.gw === CHIP_RESET_AFTER_GW) cells.push('<span class="season-rail__split"></span>');
  }
  _rail.innerHTML = cells.join('');
}

/** Static legend. Every graphic on the strip is named here. */
function renderKey() {
  const key = _root?.querySelector('.season-key');
  if (!key) return;
  const group = (title, items) =>
    `<div class="season-key__group"><span class="season-key__heading">${title}</span>`
    + items.map(([cls, label]) =>
      `<span class="season-key__item"><i class="season-key__swatch ${cls}"></i>${label}</span>`).join('')
    + '</div>';
  key.innerHTML = [
    group('Matchup one-sidedness', [
      ['season-key__swatch--great', 'Heavily favoured'],
      ['season-key__swatch--good',  'Favoured'],
      ['season-key__swatch--even',  'Even'],
    ]),
    group('Schedule', [
      ['season-key__swatch--double',    'Double gameweek'],
      ['season-key__swatch--postponed', 'Postponed fixture'],
      ['season-key__swatch--split',     'Chip reset (after GW19)'],
    ]),
    group('Players', [
      ['season-key__swatch--player',   "In the week's top five"],
      ['season-key__swatch--standout', 'Standout — captaincy shout'],
      ['season-key__swatch--favoured', 'Favoured side of a matchup'],
    ]),
    group('Chip windows', [
      ['season-key__swatch--wildcard',      'Wildcard'],
      ['season-key__swatch--triplecaptain', 'Triple Captain'],
      ['season-key__swatch--freehit',       'Free Hit'],
    ]),
    group('Week strength', [
      ['season-key__swatch--loaded', 'Loaded — several one-sided ties'],
    ]),
  ].join('');
}

/** Rebuild the ribbon, rail and key from `_model`. */
function render() {
  if (!_model || !_ribbon) return;
  const cols = [];
  for (const g of _model.gameweeks) {
    cols.push(columnHTML(g));
    if (g.gw === CHIP_RESET_AFTER_GW) {
      cols.push('<span class="season-split" role="separator"'
        + ' aria-orientation="vertical"'
        + ' aria-label="Chips reset after Gameweek 19"'
        + ' title="FPL chips reset after Gameweek 19"></span>');
    }
  }
  _ribbon.innerHTML = cols.join('');
  renderRail();
  renderKey();
}

function rebuild() {
  const season = store.getSeason();
  if (!season) return;
  // Exactly matchup.js's buildCtx() option set (js/modules/matchup.js), so the
  // strip scores every fixture from the SAME inputs as the cards above it —
  // omitting teamXgBySlug/leagueXgHistory degrades the counter-matchup and
  // history sub-metrics, which can band (and colour) a tile differently than
  // the card for the same fixture.
  const ctx = buildScoreContext(season, {
    playerSummariesById: store.getAllPlayerSummaries(),
    leagueXg:            store.getLeagueXg(),
    leagueXgPrev:        store.getLeagueXgPrev(),
    leagueXgHistory:     store.getLeagueXgHistory(),
    teamXgBySlug:        store.getAllTeamXg(),
    currentGw:           store.getCurrentGw() ?? store.getNextGw() ?? 1,
  });
  _model = buildSeasonModel(ctx, season, { skipPlayers: true });
  render();
}

let _pendingRender = false;   // data changed while off screen — render on activation

function onDataReady() {
  // Rebuilding scores all 38 gameweeks — expensive. Defer it when hidden,
  // same idiom as matchup.js/dashboard.js/fixtures.js/planner.js (CONVENTIONS §8).
  if (store.getActiveModule() !== 'matchup') {
    _pendingRender = true;
    return;
  }
  _pendingRender = false;
  rebuild();
}

/** Flush a render deferred while off screen, once Matchup is shown. */
function onRouteChanged(module) {
  if (module !== 'matchup' || !_pendingRender) return;
  _pendingRender = false;
  rebuild();
}

/** Initialise the strip. Called once from main.js on bootstrap. */
export function initFullSeason() {
  _root = document.querySelector('.season-strip');
  if (!_root) return;
  _ribbon = _root.querySelector('.season-ribbon');
  _rail   = _root.querySelector('.season-rail');

  // Ribbon column geometry lives in js/config.js (SEASON_COL_W / SEASON_COL_WIDE)
  // so the JS and CSS never disagree about a pixel value — css/components.css
  // reads these back via var(--season-col-w) / var(--season-col-wide) instead
  // of hard-coding either number.
  _root.style.setProperty('--season-col-w', `${SEASON_COL_W}px`);
  _root.style.setProperty('--season-col-wide', `${SEASON_COL_WIDE}px`);

  store.subscribe('data:ready',    onDataReady);
  store.subscribe('route:changed', onRouteChanged);

  if (store.isFresh()) onDataReady();
}
