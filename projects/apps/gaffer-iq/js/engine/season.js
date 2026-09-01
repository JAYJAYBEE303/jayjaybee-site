/**
 * js/engine/season.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 * Builds the whole-season model behind the Matchup page's Full Season strip:
 * per-gameweek matchups, per-gameweek player projections, schedule
 * irregularities and chip windows.
 * See docs/superpowers/specs/2026-09-01-full-season-strip-design.md.
 */

import {
  SEASON_TOP_MATCHUPS, SEASON_TOP_PLAYERS, SEASON_LOADED_MIN_GREAT, BANDS,
  CHIP_RESET_AFTER_GW, WC_WINDOW,
} from '../config.js';
import { scoreFixture, calcAvgPointsPerGw, calcExpectedPoints } from './composite.js';
import { calcPlayerForm, calcPlayingLikelihood } from './form.js';

/** Premier League seasons are 38 gameweeks. */
export const LAST_GW = 38;

/**
 * The top matchups of one gameweek.
 *
 * A fixture carries TWO composite scores, one per side. The matchup's score is
 * the higher of them and the side that produced it is the favoured side — so
 * the UI's "which team does this fixture favour" ring falls out of the same
 * calculation rather than needing a second rule.
 *
 * @param {number} gw
 * @param {object} ctx   from buildScoreContext
 * @param {{score?: Function}} [opts]  scoreFixture injection point, for tests
 * @returns {Array<object>}  at most SEASON_TOP_MATCHUPS, value descending
 */
export function buildGameweekMatchups(gw, ctx, opts = {}) {
  const score = opts.score ?? scoreFixture;
  const fixtures = (ctx.fixtures || []).filter(f => f.gw === gw);

  // A team playing twice this week makes every fixture it appears in a double.
  const counts = new Map();
  for (const f of fixtures) {
    counts.set(f.homeTeamId, (counts.get(f.homeTeamId) ?? 0) + 1);
    counts.set(f.awayTeamId, (counts.get(f.awayTeamId) ?? 0) + 1);
  }

  const rows = [];
  for (const f of fixtures) {
    const home = ctx.teamsById[f.homeTeamId];
    const away = ctx.teamsById[f.awayTeamId];
    if (!home || !away) continue;
    const h = score(home, f, ctx);
    const a = score(away, f, ctx);
    const homeLeads = h.value >= a.value;
    const best = homeLeads ? h : a;
    rows.push({
      fixtureId:  f.id,
      homeId:     f.homeTeamId,
      awayId:     f.awayTeamId,
      favouredId: homeLeads ? f.homeTeamId : f.awayTeamId,
      value:      best.value,
      band:       best.band,
      isDouble:   (counts.get(f.homeTeamId) > 1) || (counts.get(f.awayTeamId) > 1),
      postponed:  false,
    });
  }

  return rows.sort((x, y) => y.value - x.value).slice(0, SEASON_TOP_MATCHUPS);
}

/**
 * Is this a week worth waiting for? True once SEASON_LOADED_MIN_GREAT of the
 * week's top matchups reach the `great` band. One blowout is an ordinary week
 * with a good fixture in it; several together is a different thing.
 *
 * @param {Array<object>} matchups  buildGameweekMatchups output
 */
export function isLoadedWeek(matchups) {
  return matchups.filter(m => !m.postponed && m.value >= BANDS.great).length
    >= SEASON_LOADED_MIN_GREAT;
}

/**
 * Infer which gameweek each postponed fixture was taken out of.
 *
 * WHY THIS IS AN INFERENCE. FPL sets `event: null` on a postponed fixture and
 * does not retain the gameweek it was scheduled for, so the answer is not in
 * the feed. What IS observable is the hole it left: two clubs with no fixture
 * in a week the rest of the league plays. A pending tie between exactly those
 * two clubs is the obvious cause.
 *
 * DISPLAY-ONLY. Nothing here feeds a score, and ARCHITECTURE.md §9's rule that
 * gameweek aggregation must skip `gw === null` fixtures is untouched. The UI
 * states that the attribution is inferred, so a wrong guess reads as a guess.
 *
 * Earliest match wins: a rearranged date is always later than the hole.
 * A gameweek with NO scheduled fixtures at all is skipped — that is an unplayed
 * stretch of the season, not a hole, and every club is trivially "blank" in it.
 *
 * @param {Array<object>} pending  fixtures with gw === null
 * @param {object} ctx             from buildScoreContext
 * @returns {Map<number, Array<object>>}  gameweek → fixtures attributed to it
 */
export function attributePostponements(pending, ctx) {
  const out = new Map();
  if (!pending || pending.length === 0) return out;

  // Which clubs play in each gameweek that has any fixtures at all.
  const playingByGw = new Map();
  for (const f of (ctx.fixtures || [])) {
    if (typeof f.gw !== 'number') continue;
    let set = playingByGw.get(f.gw);
    if (!set) playingByGw.set(f.gw, set = new Set());
    set.add(f.homeTeamId);
    set.add(f.awayTeamId);
  }

  const gws = [...playingByGw.keys()].sort((a, b) => a - b);
  for (const f of pending) {
    for (const gw of gws) {
      const playing = playingByGw.get(gw);
      if (playing.has(f.homeTeamId) || playing.has(f.awayTeamId)) continue;
      let list = out.get(gw);
      if (!list) out.set(gw, list = []);
      list.push(f);
      break;                       // earliest match only
    }
  }
  return out;
}

/**
 * Lay a gameweek's rows out, postponements filling FROM THE BOTTOM.
 *
 * Slot 1 always holds the week's genuine best fixture whenever one exists, no
 * matter how much of the schedule has fallen over. Two postponements therefore
 * read as "one real fixture left to plan around", which is the signal worth
 * acting on — where sorting them in among the live rows would just look like a
 * thin week.
 *
 * @param {Array<object>} liveRows   buildGameweekMatchups output, descending
 * @param {Array<object>} postponed  fixtures attributed to this gameweek
 * @returns {Array<object>}  at most SEASON_TOP_MATCHUPS rows
 */
export function fillMatchupSlots(liveRows, postponed) {
  const total = Math.min(SEASON_TOP_MATCHUPS, liveRows.length + postponed.length);
  const slots = new Array(total).fill(null);

  // Reserve slot 0 for a live fixture whenever there is one to put there, then
  // fill postponements upward from the bottom of what remains.
  const reserved = liveRows.length > 0 ? 1 : 0;
  const room     = total - reserved;
  const ppShown  = Math.min(postponed.length, room);

  for (let i = 0; i < ppShown; i++) {
    const f = postponed[i];
    slots[total - 1 - i] = {
      fixtureId:  f.id,
      homeId:     f.homeTeamId,
      awayId:     f.awayTeamId,
      favouredId: null,
      value:      null,
      band:       'neutral',
      isDouble:   false,
      postponed:  true,
    };
  }

  let next = 0;
  for (let i = 0; i < total; i++) {
    if (!slots[i]) slots[i] = liveRows[next++] ?? null;
  }
  return slots.filter(Boolean);
}

/**
 * Player form for the whole pool, computed ONCE.
 *
 * This is what makes 38 gameweeks of league-wide ranking affordable:
 * calcPlayerForm reads a player's history and the league context, neither of
 * which depends on which gameweek you are asking about. Only the cheap
 * per-gameweek fixture read repeats.
 *
 * @param {object} ctx
 * @returns {Map<number, object>} player id → PlayerForm
 */
export function buildPlayerFormCache(ctx) {
  const cache = new Map();
  for (const list of Object.values(ctx.playersByTeamId || {})) {
    for (const p of list) cache.set(p.id, calcPlayerForm(p, ctx));
  }
  return cache;
}

/**
 * The players most worth owning for ONE gameweek, league-wide.
 *
 * Deliberately not squad-aware: the strip is a season guide that has to work
 * before anyone has imported a team.
 *
 * @param {number} gw
 * @param {object} ctx
 * @param {Map<number, object>} formCache  from buildPlayerFormCache
 * @param {{project?: Function}} [opts]    projection injection point, for tests
 * @returns {Array<object>}  at most SEASON_TOP_PLAYERS, points descending
 */
export function buildGameweekPlayers(gw, ctx, formCache, opts = {}) {
  const fixtures = (ctx.fixtures || []).filter(f => f.gw === gw);
  if (fixtures.length === 0) return [];

  // How many games each club plays this week, and its best fixture score.
  // The fixture scores are only needed by the real projection, so they are
  // skipped entirely when a test injects `project`.
  const counts = new Map();
  const bestFixture = new Map();
  for (const f of fixtures) {
    for (const teamId of [f.homeTeamId, f.awayTeamId]) {
      counts.set(teamId, (counts.get(teamId) ?? 0) + 1);
      const team = ctx.teamsById[teamId];
      if (!team || opts.project) continue;
      const s = scoreFixture(team, f, ctx);
      const prev = bestFixture.get(teamId);
      if (!prev || s.value > prev.value) bestFixture.set(teamId, s);
    }
  }

  const project = opts.project ?? ((player, fixtureCount) => {
    const form    = formCache.get(player.id) ?? calcPlayerForm(player, ctx);
    const playing = calcPlayingLikelihood(player, form);
    const avg     = calcAvgPointsPerGw(player, ctx);
    const fx      = bestFixture.get(player.teamId) ?? { value: 50 };
    return calcExpectedPoints(avg, fx, playing, fixtureCount);
  });

  const rows = [];
  for (const [teamId, list] of Object.entries(ctx.playersByTeamId || {})) {
    const count = counts.get(Number(teamId));
    if (!count) continue;                       // club is blank this week
    for (const p of list) {
      const proj = project(p, count);
      rows.push({
        playerId: p.id,
        name:     p.name,
        position: p.position,
        teamId:   p.teamId,
        price:    p.price,
        points:   proj.value,
      });
    }
  }

  return rows.sort((a, b) => b.points - a.points).slice(0, SEASON_TOP_PLAYERS);
}

/**
 * The best gameweek to play each chip, in each half of the season.
 *
 * EACH HALF IS SEARCHED SEPARATELY, which is also the mechanism that stops a
 * window straddling the GW19 reset: a run that would cross it is simply never a
 * candidate in either half. FPL reissues every chip after GW19, so a window
 * spanning it would be advice you cannot take.
 *
 * SQUAD-AGNOSTIC. Triple Captain reads the best available captain in the league
 * that week rather than a player you own, and Bench Boost is absent entirely —
 * a bench you do not own carries no information. This is what lets the strip
 * work on a first visit.
 *
 * @param {Array<object>} gwStats  one entry per gameweek:
 *   { gw, matchupTotal, blankCount, bestPlayerPoints }
 * @param {{wcWindow?: number}} [opts]
 * @returns {Array<object>}  { chip, from, to, half }
 */
export function buildChipWindows(gwStats, opts = {}) {
  const wcWindow = opts.wcWindow ?? WC_WINDOW;
  const halves = [
    { half: 1, rows: gwStats.filter(s => s.gw <= CHIP_RESET_AFTER_GW) },
    { half: 2, rows: gwStats.filter(s => s.gw >  CHIP_RESET_AFTER_GW) },
  ];

  const out = [];
  for (const { half, rows } of halves) {
    if (rows.length === 0) continue;

    // Wildcard — the best run of wcWindow consecutive weeks by fixture quality.
    // Runs must sit wholly inside the half, so they cannot cross the reset.
    let bestSum = -Infinity, bestStart = null;
    for (let i = 0; i + wcWindow <= rows.length; i++) {
      const slice = rows.slice(i, i + wcWindow);
      // Only contiguous gameweeks form a run.
      if (slice[slice.length - 1].gw - slice[0].gw !== wcWindow - 1) continue;
      const sum = slice.reduce((a, s) => a + s.matchupTotal, 0);
      if (sum > bestSum) { bestSum = sum; bestStart = slice[0].gw; }
    }
    if (bestStart !== null) {
      out.push({ chip: 'wildcard', from: bestStart, to: bestStart + wcWindow - 1, half });
    }

    // Free Hit — the single most damaged week: the one where the squad you own
    // is least able to field an XI, so renting a different one pays.
    const fh = rows.reduce((best, s) => (s.blankCount > best.blankCount ? s : best), rows[0]);
    out.push({ chip: 'freehit', from: fh.gw, to: fh.gw, half });

    // Triple Captain — the single best captain week available anywhere.
    const tc = rows.reduce((best, s) =>
      (s.bestPlayerPoints > best.bestPlayerPoints ? s : best), rows[0]);
    out.push({ chip: 'triplecaptain', from: tc.gw, to: tc.gw, half });
  }
  return out;
}

/**
 * Plain-English note for one gameweek. The panel shows this under its rows.
 * Postponement wording says the attribution is INFERRED, because it is — see
 * attributePostponements.
 */
function gameweekNote(ppCount, isDouble, loaded) {
  if (ppCount > 1) {
    return `${ppCount} fixtures look postponed out of this week — only one matchup `
         + `left to plan around. Inferred from the clubs left without a game.`;
  }
  if (ppCount === 1) {
    return 'A fixture looks postponed out of this week and will be rearranged later. '
         + 'Inferred from the clubs left without a game.';
  }
  if (isDouble) return 'Double gameweek. The strongest captaincy week of this stretch.';
  if (loaded)   return 'Several heavily one-sided fixtures land together here.';
  return 'An ordinary week — nothing worth holding a transfer for.';
}

/**
 * The whole-season model behind the Full Season strip.
 *
 * Players are the expensive half and are LEFT NULL here. The module fills them
 * in per gameweek from a chunked background pass (see modules/fullSeason.js),
 * so the ribbon can paint from fixtures alone without waiting on ~700 form
 * computations. `skipPlayers` is that path; it is also what the unit tests use.
 *
 * @param {object} ctx      from buildScoreContext
 * @param {object} season   from normaliseSeason — read for pendingFixtures
 * @param {{skipPlayers?: boolean}} [opts]
 * @returns {object} SeasonModel
 */
export function buildSeasonModel(ctx, season, opts = {}) {
  const pending  = season?.pendingFixtures ?? [];
  const ppByGw   = attributePostponements(pending, ctx);
  const currentGw = ctx.currentGw ?? 1;
  const teamCount = Object.keys(ctx.teamsById || {}).length;
  const formCache = opts.skipPlayers ? null : buildPlayerFormCache(ctx);

  const gameweeks = [];
  const gwStats   = [];
  for (let gw = 1; gw <= LAST_GW; gw++) {
    const fixtures = (ctx.fixtures || []).filter(f => f.gw === gw);
    const live     = buildGameweekMatchups(gw, ctx, opts);
    const pp       = ppByGw.get(gw) ?? [];
    const matchups = fillMatchupSlots(live, pp);
    const loaded   = isLoadedWeek(matchups);
    const playing  = new Set();
    for (const f of fixtures) { playing.add(f.homeTeamId); playing.add(f.awayTeamId); }
    const blankCount = fixtures.length === 0 ? 0 : Math.max(0, teamCount - playing.size);
    const players  = opts.skipPlayers ? null : buildGameweekPlayers(gw, ctx, formCache, opts);

    gameweeks.push({
      gw,
      played: gw < currentGw,
      matchups,
      loaded,
      blankCount,
      players,
      note: gameweekNote(pp.length, matchups.some(m => m.isDouble), loaded),
    });
    gwStats.push({
      gw,
      matchupTotal: matchups.reduce((a, m) => a + (m.value ?? 0), 0),
      blankCount,
      bestPlayerPoints: players?.[0]?.points ?? 0,
    });
  }

  return { gameweeks, chipWindows: buildChipWindows(gwStats), currentGw };
}
