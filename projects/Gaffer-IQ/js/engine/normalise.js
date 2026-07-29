/**
 * js/engine/normalise.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 * Transforms raw FPL API payloads into the clean internal models defined in
 * ARCHITECTURE.md §8 (Team, Player, Fixture, plus per-GW player stats).
 * This is the ONLY file in the codebase that may reference raw FPL field
 * names (element_type, team_h_difficulty, web_name, etc.). Everything
 * downstream speaks the internal model. A schema drift upstream breaks
 * exactly one file: this one.
 */

import {
  PL_SEASONS, PL_TENURE_LOOKBACK, TEAM_NAME_ALIASES, TENURE_RECENCY_DECAY,
} from '../config.js';

// element_type id → internal position code. FPL uses 1=GKP, 2=DEF, 3=MID, 4=FWD.
const POSITION_BY_ELEMENT_TYPE = {
  1: 'GKP',
  2: 'DEF',
  3: 'MID',
  4: 'FWD',
};

// FPL status code → internal status string. The full set per FPL: a=available,
// d=doubtful, i=injured, s=suspended, n=not in squad, u=unavailable.
const STATUS_MAP = {
  a: 'available',
  d: 'doubtful',
  i: 'injured',
  s: 'suspended',
  n: 'unavailable',
  u: 'unavailable',
};

// ─── Premier League tenure ───────────────────────────────────────────────────
// Derives how much recent top-flight history a club has, from the static
// PL_SEASONS table in config.js. See FEATURE_ENGINE.md §2.1.

/** Collapses a club name or short code to a comparable key: 'Nott'm Forest' → 'nottmforest'. */
function normaliseClubKey(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Season labels newest-first, capped at the configured lookback. Sorted
// explicitly rather than trusting object key order, so a reordered PL_SEASONS
// literal can never silently change every club's tenure.
const SEASONS_NEWEST_FIRST = Object.keys(PL_SEASONS)
  .sort()
  .reverse()
  .slice(0, PL_TENURE_LOOKBACK);

// club key → Set of "seasons ago" indices (0 = most recent season in the table).
const PL_PRESENCE_BY_CLUB = (() => {
  const out = {};
  SEASONS_NEWEST_FIRST.forEach((label, seasonsAgo) => {
    for (const club of PL_SEASONS[label]) {
      (out[normaliseClubKey(club)] ||= new Set()).add(seasonsAgo);
    }
  });
  return out;
})();

// Alias key → canonical club key, both normalised.
const CANONICAL_BY_ALIAS = (() => {
  const out = {};
  for (const [alias, canonical] of Object.entries(TEAM_NAME_ALIASES)) {
    out[normaliseClubKey(alias)] = normaliseClubKey(canonical);
  }
  return out;
})();

// Denominator for the recency-weighted ratio: an ever-present club's total.
const TENURE_TOTAL_WEIGHT = SEASONS_NEWEST_FIRST
  .reduce((sum, _label, seasonsAgo) => sum + (TENURE_RECENCY_DECAY ** seasonsAgo), 0);

/**
 * Recency-weighted Premier League tenure for a club, matched by name then short
 * name (never by FPL team id — ids are reassigned as clubs are promoted and
 * relegated, so an id join silently mismatches exactly the clubs this measures).
 *
 * MODEL: recent seasons dominate. A club relegated last season loses the full
 * weight of the newest season; one that missed a season eight years ago loses
 * only TENURE_RECENCY_DECAY^8 of it.
 *
 * @param {string} name       club name as FPL reports it
 * @param {string} shortName  FPL short code, used as the fallback join key
 * @returns {{seasons: number, lookback: number, ratio: number, matched: boolean}}
 *   ratio: 0–1, 1 = present in every season of the lookback.
 *   matched: false when the club appears nowhere in PL_SEASONS. That covers both
 *   a genuine newcomer and a join failure; both correctly yield ratio 0, so the
 *   ambiguity has no behavioural consequence.
 */
export function buildPlTenure(name, shortName) {
  let clubKey = null;
  for (const candidate of [normaliseClubKey(name), normaliseClubKey(shortName)]) {
    if (!candidate) continue;
    const resolved = CANONICAL_BY_ALIAS[candidate] ?? candidate;
    if (PL_PRESENCE_BY_CLUB[resolved]) {
      clubKey = resolved;
      break;
    }
  }

  if (!clubKey) {
    return { seasons: 0, lookback: SEASONS_NEWEST_FIRST.length, ratio: 0, matched: false };
  }

  const seasonsAgoPresent = PL_PRESENCE_BY_CLUB[clubKey];
  let weighted = 0;
  for (const seasonsAgo of seasonsAgoPresent) {
    weighted += TENURE_RECENCY_DECAY ** seasonsAgo;
  }

  return {
    seasons:  seasonsAgoPresent.size,
    lookback: SEASONS_NEWEST_FIRST.length,
    ratio:    TENURE_TOTAL_WEIGHT === 0 ? 0 : weighted / TENURE_TOTAL_WEIGHT,
    matched:  true,
  };
}

/**
 * @param {object} raw  one entry from bootstrap-static.teams[]
 * @returns {Team}      internal Team — see ARCHITECTURE.md §8
 */
export function normaliseTeam(raw) {
  return {
    id: raw.id,
    name: raw.name,
    shortName: raw.short_name,
    strength: {
      overall:      raw.strength,
      overallHome:  raw.strength_overall_home,
      overallAway:  raw.strength_overall_away,
      attackHome:   raw.strength_attack_home,
      attackAway:   raw.strength_attack_away,
      defenceHome:  raw.strength_defence_home,
      defenceAway:  raw.strength_defence_away,
    },
    // Recency-weighted top-flight history — drives the promoted-team penalty in
    // engine/fixtures.js → calcBaseDifficulty. See FEATURE_ENGINE.md §2.1.
    plTenure: buildPlTenure(raw.name, raw.short_name),
    fixtures: [],   // fixture ids, populated by normaliseSeason
    form:  null,    // filled by engine/form.js
    style: null,    // filled by engine/style.js
  };
}

/**
 * @param {object} raw  one entry from bootstrap-static.elements[]
 * @returns {Player}    internal Player — see ARCHITECTURE.md §8
 */
export function normalisePlayer(raw) {
  return {
    id: raw.id,
    name: raw.web_name,
    fullName: `${raw.first_name || ''} ${raw.second_name || ''}`.trim(),
    teamId: raw.team,
    position: POSITION_BY_ELEMENT_TYPE[raw.element_type] || 'UNK',
    // now_cost is in tenths of millions (e.g. 75 → £7.5m).
    price: raw.now_cost / 10,
    ownership: parseFloat(raw.selected_by_percent) || 0,
    status: STATUS_MAP[raw.status] || 'available',
    statusNote: raw.news || null,
    // FPL's own forward-looking playing chance (0–100), set from press-conference
    // news. null for most players because FPL populates it only when there IS
    // news — so null means "no doubt reported", NOT "no data". Consumed by
    // engine/form.js → calcPlayingLikelihood, which falls back to STATUS_PLAY_CHANCE.
    chanceOfPlayingNext: typeof raw.chance_of_playing_next_round === 'number'
      ? raw.chance_of_playing_next_round
      : null,
    totals: {
      points:      raw.total_points || 0,
      minutes:     raw.minutes || 0,
      goals:       raw.goals_scored || 0,
      assists:     raw.assists || 0,
      xG:          parseFloat(raw.expected_goals)   || 0,
      xA:          parseFloat(raw.expected_assists) || 0,
      cleanSheets: raw.clean_sheets || 0,
    },
    // FPL ICT index components (season totals as decimal strings upstream).
    // Used by engine/counter.js → classifyRole to refine raw element_type
    // groupings into roles (CB vs FB, DM vs CM vs WM, ST vs SS).
    ict: {
      influence:  parseFloat(raw.influence)  || 0,
      creativity: parseFloat(raw.creativity) || 0,
      threat:     parseFloat(raw.threat)     || 0,
    },
    // In-GW transfer counts — used by engine/prices.js for price change prediction.
    // Phase 4-4: present in bootstrap-static.elements[]; zero-safe.
    transfersInEvent:  raw.transfers_in_event  || 0,
    transfersOutEvent: raw.transfers_out_event || 0,
    history: null,   // populated lazily by normalisePlayerSummary
    form:    null,   // filled by engine/form.js
  };
}

/**
 * @param {object} raw  one entry from fixtures[]
 * @returns {Fixture}   internal Fixture — see ARCHITECTURE.md §8
 */
export function normaliseFixture(raw) {
  const played = Boolean(raw.finished);
  return {
    id: raw.id,
    gw: raw.event,                  // null for unscheduled fixtures (rare)
    kickoff: raw.kickoff_time,       // ISO string; engine never reformats
    homeTeamId: raw.team_h,
    awayTeamId: raw.team_a,
    played,
    result: played
      ? { homeGoals: raw.team_h_score, awayGoals: raw.team_a_score }
      : null,
    fplDifficulty: {                 // the official 1–5 FDR Gaffer IQ replaces
      home: raw.team_h_difficulty,
      away: raw.team_a_difficulty,
    },
    gafferScore: null,               // filled by engine/composite.js
  };
}

/**
 * @param {object} raw  one entry from element-summary.history[]
 * @returns {GwStat}    per-GW stat for a player
 */
export function normaliseGwStat(raw) {
  return {
    gw: raw.round,
    fixtureId: raw.fixture,
    opponentTeamId: raw.opponent_team,
    isHome: Boolean(raw.was_home),
    minutes:       raw.minutes || 0,
    points:        raw.total_points || 0,
    goals:         raw.goals_scored || 0,
    assists:       raw.assists || 0,
    xG:            parseFloat(raw.expected_goals)   || 0,
    xA:            parseFloat(raw.expected_assists) || 0,
    cleanSheet:    Boolean(raw.clean_sheets),
    goalsConceded: raw.goals_conceded || 0,
    saves:         raw.saves || 0,
    bonus:         raw.bonus || 0,
    yellowCards:   raw.yellow_cards || 0,
    redCards:      raw.red_cards || 0,
  };
}

/**
 * Normalises a single element-summary payload — a player's history and upcoming fixtures.
 * @param {object} raw  the full element-summary/{id}/ response
 * @returns {PlayerSummary}  { history, historyPast, upcoming }
 */
export function normalisePlayerSummary(raw) {
  return {
    history: (raw.history || []).map(normaliseGwStat),
    historyPast: (raw.history_past || []).map(s => ({
      seasonName: s.season_name,
      points:     s.total_points || 0,
      minutes:    s.minutes || 0,
    })),
    upcoming: (raw.fixtures || []).map(f => ({
      id: f.id,
      gw: f.event,
      kickoff: f.kickoff_time,
      isHome: Boolean(f.is_home),
      opponentTeamId: f.is_home ? f.team_a : f.team_h,
      fplDifficulty: f.difficulty,
    })),
  };
}

/**
 * Composes the full normalised season from the two static payloads.
 * Pure — does not mutate inputs; constructs fresh objects throughout.
 * @param {object}   rawBootstrap   bootstrap-static/ response
 * @param {object[]} rawFixtures    fixtures/ response (raw array)
 * @returns {Season}  { teams, teamsById, players, playersById,
 *                      fixtures, fixturesById, positions, events,
 *                      currentGw, nextGw }
 */
export function normaliseSeason(rawBootstrap, rawFixtures) {
  if (!rawBootstrap || !Array.isArray(rawBootstrap.teams)) {
    throw new TypeError('normaliseSeason: bootstrap payload missing teams[]');
  }
  if (!Array.isArray(rawBootstrap.elements)) {
    throw new TypeError('normaliseSeason: bootstrap payload missing elements[]');
  }
  if (!Array.isArray(rawFixtures)) {
    throw new TypeError('normaliseSeason: fixtures must be an array');
  }

  const teamsRaw = rawBootstrap.teams.map(normaliseTeam);
  const players  = rawBootstrap.elements.map(normalisePlayer);
  const fixtures = rawFixtures.map(normaliseFixture);

  // Build per-team fixture id lists without mutating the inputs.
  // Fixtures sort by GW first, then kickoff, so each team's `fixtures` array
  // is in chronological order — what downstream horizon code expects.
  const sortedFixtures = fixtures.slice().sort((a, b) => {
    const gwA = a.gw ?? 999;
    const gwB = b.gw ?? 999;
    if (gwA !== gwB) return gwA - gwB;
    return (a.kickoff || '').localeCompare(b.kickoff || '');
  });

  const fixtureIdsByTeam = {};
  for (const f of sortedFixtures) {
    (fixtureIdsByTeam[f.homeTeamId] ||= []).push(f.id);
    (fixtureIdsByTeam[f.awayTeamId] ||= []).push(f.id);
  }
  const teams = teamsRaw.map(t => ({ ...t, fixtures: fixtureIdsByTeam[t.id] || [] }));

  const positions = (rawBootstrap.element_types || []).map(et => ({
    id:   et.id,
    code: et.singular_name_short,
    name: et.singular_name,
  }));

  const events = (rawBootstrap.events || []).map(e => ({
    id:           e.id,
    deadline:     e.deadline_time,
    finished:     Boolean(e.finished),
    // data_checked becomes true once FPL has processed at least one fixture's
    // live data — used by dashboard.js to distinguish "live" from "pre-deadline".
    dataChecked:  Boolean(e.data_checked),
    isCurrent:    Boolean(e.is_current),
    isNext:       Boolean(e.is_next),
    averageScore: e.average_entry_score || 0,
  }));

  const teamsById    = Object.fromEntries(teams.map(t => [t.id, t]));
  const playersById  = Object.fromEntries(players.map(p => [p.id, p]));
  const fixturesById = Object.fromEntries(sortedFixtures.map(f => [f.id, f]));

  const currentGw = events.find(e => e.isCurrent)?.id ?? null;
  const nextGw    = events.find(e => e.isNext)?.id    ?? null;

  return {
    teams, teamsById,
    players, playersById,
    fixtures: sortedFixtures, fixturesById,
    positions, events,
    currentGw, nextGw,
  };
}
