/**
 * js/modules/counterNotice.js
 * Layer: module helper (pure). No DOM, no store access - the caller passes the
 * payload in, so it is unit-testable (CONVENTIONS §3.3).
 *
 * The bright-red bar above the Matchup page's Counter-matchups while the data
 * behind them is unavailable. The counter reads Understat's per-team shot data
 * (engine/channel.js) and has no other source, so when Understat.com is down the
 * section can only draw blanks - this says why, instead of leaving a silent gap.
 *
 * Driven by DATA STATE, not a flag, so it removes itself on recovery: main.js
 * installs the FPL-derived stand-in (`synthetic: true`, engine/fpl-league.js) only
 * when the live-season Understat call FAILED. A real payload - including an empty
 * one at the start of a season, which is not an outage - shows nothing.
 *
 * Styled by `.alert` in css/matchup.css.
 */

/**
 * @param {object|null} leagueXg  store.getLeagueXg(): the live-season league payload
 * @returns {string}  the bar's HTML, or '' when Understat answered
 */
export function counterNoticeHTML(leagueXg) {
  if (leagueXg && !leagueXg.synthetic) return '';
  return '<div class="alert" role="note">'
    + '<span class="alert__i" aria-hidden="true">!</span>'
    + '<p><b>Counter-matchup data is unavailable</b> - its source, Understat.com, is down. A fix is being worked on.</p>'
    + '</div>';
}
