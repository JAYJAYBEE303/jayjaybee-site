/**
 * js/engine/fpl-league.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 *
 * A STAND-IN for the live season's Understat league payload, built from the FPL
 * data already in the store. main.js installs it only when the Understat call
 * for UNDERSTAT_SEASON fails, so engine/h2h.js (this season's meetings),
 * engine/fixtures.js (the venue window's current-season tail) and
 * engine/form.js (player xG overlay) keep working through an Understat outage
 * with no change of their own. If Understat is up, its real payload wins.
 *
 * It is deliberately NOT a fake Understat:
 *   - `synthetic: true`. engine/channel.js buildUnderstatSlugsByTeamId returns {}
 *     for it, so no team/{slug} request is ever made on its strength.
 *   - No `id` on any `datesData` row. findUnderstatMatchId skips id-less rows,
 *     so an FPL fixture id can never be sent to match/{id} (which, were Understat
 *     back, would fetch a DIFFERENT match).
 *   - No xG on results (team form falls back to goal difference per match), no
 *     PPDA/deep, no xGChain/xGBuildup (roles fall back to ICT; the channel
 *     personnel factor to 1).
 *
 * `playersData` carries FPL's own season totals. calcPlayerForm will label that
 * xgSource 'understat'; the label has no reader outside engine/form.js.
 *
 * See docs/superpowers/specs/2026-11-26-understat-compat-layer-design.md.
 */

/** ISO kickoff -> Understat's 'YYYY-MM-DD HH:MM:SS' (UTC, no zone suffix). */
function toUnderstatDatetime(iso) {
  return new Date(iso).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * @param {object} season  normaliseSeason output ({ teams, teamsById, players, fixtures })
 * @returns {{synthetic: true,
 *   teamsData: Object<string, {id: string, title: string,
 *     history: {date: string, h_a: 'h'|'a', scored: number, missed: number}[]}>,
 *   playersData: {player_name: string, time: number, xG: number, xA: number}[],
 *   datesData: {isResult: true, datetime: string, h: {title: string},
 *     a: {title: string}, goals: {h: number, a: number}}[]}}
 */
export function buildFplLeaguePayload(season) {
  const teamsById = season?.teamsById ?? {};

  const teamsData = {};
  for (const team of season?.teams ?? []) {
    teamsData[team.id] = { id: String(team.id), title: team.name, history: [] };
  }

  // `played` is "the match has been played" (normalise.js); a live match has a
  // running `result` but is not a result yet.
  const played = (season?.fixtures ?? [])
    .filter(f => f.played && f.kickoff
      && teamsById[f.homeTeamId] && teamsById[f.awayTeamId]
      && Number.isFinite(f.result?.homeGoals) && Number.isFinite(f.result?.awayGoals))
    .map(f => ({ ...f, datetime: toUnderstatDatetime(f.kickoff) }))
    .sort((x, y) => x.datetime.localeCompare(y.datetime));

  const datesData = [];
  for (const f of played) {
    const { homeGoals: hg, awayGoals: ag } = f.result;
    datesData.push({
      isResult: true,
      datetime: f.datetime,
      h: { title: teamsById[f.homeTeamId].name },
      a: { title: teamsById[f.awayTeamId].name },
      goals: { h: hg, a: ag },
    });
    teamsData[f.homeTeamId].history.push({ date: f.datetime, h_a: 'h', scored: hg, missed: ag });
    teamsData[f.awayTeamId].history.push({ date: f.datetime, h_a: 'a', scored: ag, missed: hg });
  }

  const playersData = (season?.players ?? [])
    .filter(p => (p.totals?.minutes ?? 0) > 0)
    .map(p => ({
      player_name: p.fullName,
      time: p.totals.minutes,
      xG: p.totals.xG,
      xA: p.totals.xA,
    }));

  return { synthetic: true, teamsData, playersData, datesData };
}
