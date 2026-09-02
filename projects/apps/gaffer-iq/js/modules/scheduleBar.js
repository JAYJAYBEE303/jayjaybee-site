/**
 * js/modules/scheduleBar.js
 * Layer: module. Owns the DOM for the app-wide schedule context bar.
 * Side effects: DOM writes only. Reads from store; calls engine functions.
 *
 * Renders a one-line summary of which gameweeks in the next six are doubles or
 * blanks. It exists because the per-team fixture strip only appears in the
 * Ranker and the Matchup Analyser — the Dashboard, Transfer Planner and
 * Fixtures tabs render no strip at all, so without this they say nothing about
 * the shape of the schedule.
 *
 * Hidden entirely when the window is ordinary, which is most of the season: a
 * bar that always shows costs vertical space on every view for information that
 * is usually "nothing unusual". Emptiness from summariseGwIrregularities is the
 * signal to render nothing, not a reason to render an empty bar.
 *
 * See FEATURE_ENGINE.md §9.1.
 *
 * Subscriptions: data:ready
 */

import { store } from '../store.js';
import { summariseGwIrregularities } from '../engine/fixtures.js';

// How far ahead to look. Matches the longest horizon the app offers, so the bar
// never warns about a gameweek no view can currently show.
const WINDOW_GWS = 6;

let _root = null;

function render() {
  if (!_root) return;

  const season    = store.getSeason();
  // The window starts at the round still to be played, not FPL's is_current —
  // otherwise a bar whose whole job is to warn about what is COMING spends the
  // days between rounds warning about a gameweek already in the record books.
  const currentGw = store.getUpcomingGw();
  if (!season || currentGw === null) {
    _root.hidden = true;
    return;
  }

  const rows = summariseGwIrregularities(season, currentGw, WINDOW_GWS);
  if (rows.length === 0) {
    // Nothing to say — render nothing at all rather than an empty bar.
    _root.innerHTML = '';
    _root.hidden = true;
    return;
  }

  // Every value interpolated below is a number this module derived (a gameweek
  // id and two counts), never a name or any other upstream string, so there is
  // nothing here that needs escaping.
  const items = [];
  for (const r of rows) {
    if (r.doubleTeams > 0) {
      items.push(
        `<span class="schedule-bar__item">`
        + `<b class="schedule-bar__gw">GW${r.gw} · Double</b>`
        + `<span class="schedule-bar__detail">${r.doubleTeams} team${r.doubleTeams > 1 ? 's' : ''} play twice</span>`
        + `</span>`,
      );
    }
    if (r.blankTeams > 0) {
      items.push(
        `<span class="schedule-bar__item">`
        + `<b class="schedule-bar__gw">GW${r.gw} · Blank</b>`
        + `<span class="schedule-bar__detail">${r.blankTeams} team${r.blankTeams > 1 ? 's' : ''} idle</span>`
        + `</span>`,
      );
    }
  }

  _root.innerHTML = `<div class="schedule-bar__inner">${items.join('<span class="schedule-bar__sep"></span>')}</div>`;
  _root.hidden = false;
}

export function initScheduleBar() {
  _root = document.getElementById('schedule-bar');
  if (!_root) return;

  // No route:changed subscription: the bar is outside .app-main and shows on
  // every view, so it has nothing to re-render when the route changes.
  store.subscribe('data:ready', render);
  render();
}
