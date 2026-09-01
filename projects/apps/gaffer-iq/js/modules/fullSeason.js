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

/** Rebuild the ribbon and rail from `_model`. */
function render() {
  if (!_model || !_ribbon) return;
  const cols = [];
  for (const g of _model.gameweeks) {
    cols.push(columnHTML(g));
    if (g.gw === CHIP_RESET_AFTER_GW) {
      cols.push('<span class="season-split" role="separator"'
        + ' aria-label="Chips reset after Gameweek 19"'
        + ' title="FPL chips reset after Gameweek 19"></span>');
    }
  }
  _ribbon.innerHTML = cols.join('');
}

function rebuild() {
  const season = store.getSeason();
  if (!season) return;
  // Same options matchup.js passes (js/modules/matchup.js buildCtx), so the
  // strip and the cards above it score from identical inputs.
  const ctx = buildScoreContext(season, {
    playerSummariesById: store.getAllPlayerSummaries(),
    leagueXg:            store.getLeagueXg(),
    leagueXgPrev:        store.getLeagueXgPrev(),
  });
  _model = buildSeasonModel(ctx, season, { skipPlayers: true });
  render();
}

function onDataReady() {
  if (store.getActiveModule() !== 'matchup') return;   // CONVENTIONS §8
  rebuild();
}

function onRouteChanged(module) {
  if (module !== 'matchup') return;
  if (store.isFresh()) rebuild();
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
