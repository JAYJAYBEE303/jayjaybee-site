/**
 * js/engine/channel.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 * Builds Understat channel profiles (set-piece / box / transition threat and
 * vulnerability shares) and scores the channel counter-matchup between two
 * teams. See FEATURE_ENGINE.md §7.2 and the design spec
 * docs/superpowers/specs/2026-08-20-understat-channel-counters-design.md.
 *
 * All outputs: 0–100, higher = favourable for the team being scored.
 */

import { canonicalClubKey } from './normalise.js';

/**
 * Map FPL team id → Understat URL slug, derived from the league payload that
 * is already loaded rather than a hardcoded table.
 *
 * MODEL: matched by NAME via canonicalClubKey, never by Understat's numeric
 * team id — FPL reassigns ids every season as clubs are promoted and
 * relegated, which is exactly what silently broke the previous id-keyed
 * UNDERSTAT_TEAM_SLUGS table (see engine/style.js buildXgProfilesByTeamId).
 * The slug is Understat's own convention: the team title with spaces replaced
 * by underscores.
 *
 * @param {object|null} leagueXg   parsed Understat league/EPL payload
 * @param {Object<number,Team>} teamsById
 * @returns {Object<number,string>}  {} when no payload or no match.
 */
export function buildUnderstatSlugsByTeamId(leagueXg, teamsById) {
  if (!leagueXg || !leagueXg.teamsData) return {};

  const titleByKey = {};
  for (const t of Object.values(leagueXg.teamsData)) {
    if (t && t.title) titleByKey[canonicalClubKey(t.title)] = t.title;
  }

  const out = {};
  for (const team of Object.values(teamsById || {})) {
    for (const raw of [team.name, team.shortName]) {
      if (!raw) continue;
      const title = titleByKey[canonicalClubKey(raw)];
      if (title) {
        out[team.id] = title.replace(/ /g, '_');
        break;
      }
    }
  }
  return out;
}
