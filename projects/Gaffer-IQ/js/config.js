/**
 * js/config.js
 * Layer: config (pure constants). No logic, no DOM, no network.
 * Single source of truth for every tunable number in the engine.
 * See FEATURE_ENGINE.md for the meaning and rationale of each constant.
 * Tuning the model = editing this file only; formulas never contain literals.
 */

// ─── §2  Base fixture difficulty ─────────────────────────────────────────────

// Weights for attack vs defence edge components (must sum to 1).
export const W_ATTACK_EDGE = 0.5;
export const W_DEFENCE_EDGE = 0.5;

// Normalisation bounds for rawEdge across all fixtures.
// FPL strength integers sit roughly in the 1000–1400 band; re-calibrate after
// loading bootstrap data to fill 0–100 tightly.
export const EDGE_MIN = -400;
export const EDGE_MAX =  400;

// ─── §3  Home/away split performance ─────────────────────────────────────────

// Weights for points-per-game and goal-difference in the venue score (sum to 1).
export const W_PPG = 0.7;
export const W_GD  = 0.3;

// Below this many games at a given venue, blend the data-driven score with the
// FPL-strength prior so a 1-game sample doesn't dominate.
export const MIN_VENUE_GAMES = 4;

// ─── §4  Fixture history / head-to-head ──────────────────────────────────────

// Maximum prior meetings to include in the H2H calculation.
export const N_H2H = 4;

// ─── §5  Team form ────────────────────────────────────────────────────────────

// Rolling window (gameweeks) for team form.
export const FORM_WINDOW_GWS = 5;

// Exponential decay applied per gameweek back in the form window.
// 1.0 = flat average; lower = heavier recency weighting.
export const RECENCY_DECAY = 0.85;

// Weight of goal-difference overlay blended into rawForm.
export const W_FORM_GD = 0.2;

// Fallback league-average strength used in opponent-quality adjustment before
// bootstrap data has loaded. FPL priors cluster roughly 1000–1400.
export const LEAGUE_AVG_STRENGTH = 1150;

// ─── §6  Team style profiling ─────────────────────────────────────────────────

// Declarative interaction rules for calcStyleClash (engine/style.js).
// Each rule contributes (sign * magnitude) to clashDelta for team A.
//   sign +1 → A-high on axisA AND B-high on axisB favours A
//   sign -1 → same combination disfavours A
// See FEATURE_ENGINE.md §6.2. Extend this array in Phase 3 once real xG data
// replaces the Phase 1 proxy axes.
export const STYLE_RULES = [
  // High attackDirectness vs high defensiveHeight → A plays in behind B — favours A.
  { axisA: 'attackDirectness', axisB: 'defensiveHeight', sign:  1, magnitude: 15 },
  // B's high tempo drags a low-tempo A into an end-to-end game it dislikes.
  { axisA: 'tempo',            axisB: 'tempo',            sign: -1, magnitude: 10 },
];

// Anchors used to normalise the three Phase-1 style-profile axes from raw
// per-game values to 0–100. Tuned to typical PL distributions; replaced with
// real xG/pressing data in Phase 3 (FEATURE_ENGINE.md §6).
export const STYLE_ANCHORS = {
  attackDirectness: { min: 0.5, max: 2.5 },   // goals-for per game
  defensiveHeight:  { min: 0.0, max: 0.5 },   // clean-sheet rate
  tempo:            { min: 1.5, max: 3.5 },   // total goals per game (for + against)
};

// ─── §7.1  Player form ────────────────────────────────────────────────────────

// Rolling window (gameweeks) for player form.
export const PLAYER_FORM_GWS = 5;

// Weights for the three components of playerForm (must sum to 1).
export const W_RETURNS    = 0.5;   // per-90 actual returns
export const W_MINUTES    = 0.3;   // minutes security (nailed-on starter?)
export const W_UNDERLYING = 0.2;   // xG+xA underlying overlay

// Multiplier applied to a player's form score when flagged injured or doubtful.
// MODEL: a player who might not play is near-useless in FPL regardless of form.
export const AVAIL_PENALTY = 0.4;

// Position-relative anchors for normalising per-90 returns inside calcPlayerForm.
// MODEL: rough PL distributions — Phase 3 replaces these with position-relative
// league percentiles once xG/role data lands.
export const PLAYER_PER90_ANCHORS = {
  attack:  { min: 2, max: 10 },   // FWD/MID per-90 points: ~2 = poor, ~10 = elite
  defence: { min: 1, max:  7 },   // DEF/GKP per-90 points
};

// Position-relative anchors for the (xG + xA) per-90 overlay inside calcPlayerForm.
export const PLAYER_XG_ANCHORS = {
  attack:  { min: 0.1, max: 1.2 },
  defence: { min: 0.0, max: 0.5 },
};

// Season length in gameweeks. Used as the denominator in season-level fallbacks
// (e.g. minutesSecurity when per-GW history isn't loaded yet).
export const SEASON_GWS = 38;

// ─── §7.2  Position counter-matchup ──────────────────────────────────────────

// Scales the pairingEdge (form gap between attacking and defensive unit) into
// the 0–100 score centred at 50. Default: a 20-point form gap moves the score ±20.
export const COUNTER_SENSITIVITY = 1.0;

// Relative importance of each position pairing; normalised inside engine/counter.js.
// Used as the FALLBACK grouping (element_type only) when ICT data is missing for
// either side — engine flags the result estimated:true in that case.
export const PAIRING_WEIGHTS = {
  fwdVsCb:     1.0,   // strikers vs centre-backs — primary scoring threat
  wideMidVsFb: 0.6,   // wide mids / wingers vs full-backs
  camVsCbMid:  0.4,   // central attacking mids vs CBs + defensive mids
};

// Phase 3C refinement: role-based pairings, used by calcCounterMatchup whenever
// classifyRole succeeds (ICT data present). See FEATURE_ENGINE.md §7.2 and
// engine/counter.js. Weights mirror PAIRING_WEIGHTS' ordering of importance:
// the central scoring threat (ST/SS vs CB) carries the largest weight, the wide
// matchup is secondary, and the central-creative-vs-shield interaction is the
// smallest of the three.
export const ROLE_PAIRING_WEIGHTS = {
  stVsCb:    1.0,   // ST / SS (forwards) vs CBs — primary scoring threat
  wmVsFb:    0.6,   // wide MIDs / wingers vs full-backs — wide matchup
  cmVsCbDm:  0.5,   // CM / SS (central creative) vs CBs + defensive MIDs
};

// Classification thresholds for classifyRole(player) in engine/counter.js.
// MODEL: ratios of a player's own ICT components are season-stable; absolute
// totals grow through the season. Thresholds tuned to PL distributions — see
// FEATURE_ENGINE.md §7.2.
export const ROLE_CLASSIFY_THRESHOLDS = {
  // DEF: a fullback shows higher threat share than a centre-back because
  // FBs get into the final third and produce shots/crosses.
  defThreatShare: 0.30,
  // MID: a high threat share marks a wide attacker / SS-style mid.
  midWmThreatShare: 0.40,
  // MID: a DM is influence-led with low creativity (defensive/recovery work).
  midDmInfluenceShare: 0.40,
  midDmCreativityShareMax: 0.30,
  // FWD: a deep-lying forward / SS shows a higher creativity share than a pure ST.
  fwdSsCreativityShare: 0.30,
};

// Anchors for the counter-matchup fallback used when player-level form is missing
// (no element-summary loaded yet). Maps (team-A attack − team-B defence) from the
// FPL strength priors to a 0–100 pairing score, centred so the league-average gap
// lands near 50. Same scale family as EDGE_MIN/EDGE_MAX but tighter (strength
// priors compress for the average-team attack-vs-defence spread).
export const COUNTER_FALLBACK_EDGE = { min: -300, max: 300 };

// ─── §8  Composite matchup score ─────────────────────────────────────────────

// Weights for all sub-metrics. Must sum to 1.00.
// See FEATURE_ENGINE.md §8.1 for the rationale behind each weight.
// MODEL: styleClash weight raised from 0.07 to 0.12 — now backed by real
// Understat xG data (Phase 3A). baseDifficulty reduced from 0.30 to 0.25
// to compensate, keeping the total at 1.00 and leaving the dependable floor
// still the largest single weight.
export const WEIGHTS = {
  baseDifficulty: 0.25,   // strength priors — always available, the dependable floor
  counterMatchup: 0.25,   // the signature metric — position form mismatches
  teamForm:       0.20,   // recent trajectory, opponent-quality adjusted
  homeAway:       0.15,   // venue performance this season
  styleClash:     0.12,   // stylistic interaction — Understat xG-backed (Phase 3A)
  history:        0.03,   // H2H nudge — deliberately tiny; data is thin and weakly predictive
};

// Minimum weighted share of non-estimated sub-metrics before the UI renders
// a provisional indicator. Score is still produced; only the badge changes.
export const CONFIDENCE_FLOOR = 0.6;

// Band thresholds — lower bound of each band (inclusive).
// See FEATURE_ENGINE.md §8.4. CSS modifier classes must match these strings.
export const BANDS = {
  great:   85,
  good:    68,
  neutral: 46,
  tough:   30,
  brutal:   0,
};

// ─── §8 / ARCHITECTURE §9  Planning horizons ─────────────────────────────────

// The three horizons are a first-class, cross-cutting concept.
// The active horizon key is stored in store.js and changed by the horizon switcher.
export const HORIZONS = {
  GW1: { label: 'This GW',    gws: 1 },
  GW3: { label: 'Next 3 GWs', gws: 3 },
  GW6: { label: 'Next 6 GWs', gws: 6 },
};

// ─── §9  Horizon aggregation ──────────────────────────────────────────────────

// Exponential decay per GW offset within the horizon window (nearer = more weight).
// GW+0 → weight 1.0; GW+5 → weight ~0.59 at default.
export const HORIZON_DECAY = 0.9;

// How per-fixture scores are combined across a horizon.
// 'mean' | 'min' | 'blend' — see FEATURE_ENGINE.md §9.
export const AGG_METHOD = 'blend';

// Weights for the 'blend' aggregation (must sum to 1).
// W_MIN punishes a single brutal fixture hiding inside an otherwise green run.
export const W_MEAN = 0.75;
export const W_MIN  = 0.25;

// Score contribution of a blank GW (no fixture) for that team's assets.
// MODEL: a blank is mildly bad (zero return), not neutral — so not 50.
export const BLANK_GW_VALUE = 40;

// ─── §10  Player projection ───────────────────────────────────────────────────

// Weights for the three components of the player projection score (must sum to 1).
export const PROJ_FORM    = 0.45;   // player's own form and availability
export const PROJ_FIXTURE = 0.35;   // team's horizon fixture score
export const PROJ_COUNTER = 0.20;   // player's position counter-matchup edge

// ─── Phase 4-3  Chip planning ────────────────────────────────────────────────

// How many candidate GWs ahead of currentGw to evaluate for each chip.
// Higher = considers timing further out, but cost is roughly O(CHIP_PLAN_HORIZON
// × teams × WC_WINDOW) scoreFixture calls (cached per (team, fixture)).
export const CHIP_PLAN_HORIZON = 6;

// Wildcard activation buys into the next WC_WINDOW GWs of fixtures.
export const WC_WINDOW = 5;

// Mean horizon score is averaged across the top WC_TOP_TEAMS strongest sides
// when evaluating a Wildcard activation point — you wildcard *into* the
// teams whose fixtures look best, not the league average.
export const WC_TOP_TEAMS = 10;

// Number of teams averaged when evaluating Free Hit "best one-week fixtures"
// (smaller than WC_TOP_TEAMS — FH only fills one XI).
export const FH_TOP_TEAMS = 6;

// Points added to a Free Hit candidate GW's composite score per blanking team.
// MODEL: a blank GW with ≥ FH_BLANK_THRESHOLD teams missing is normally the
// canonical FH window; FH_BLANK_WEIGHT scales that signal alongside the
// strong-fixture-availability signal so the engine can recommend FH for
// either reason.
export const FH_BLANK_WEIGHT = 4;

// Threshold of blanking teams at which the engine reports a "blank GW"
// rationale rather than a "strong-fixture" rationale.
export const FH_BLANK_THRESHOLD = 6;

// Threshold for "worth Bench Boosting" — number of bench DGWs the engine
// considers a strong recommendation rather than a hold.
export const BB_MIN_DOUBLES = 2;

// ─── §11  Player Ranker performance ──────────────────────────────────────────

// Number of players scored per setTimeout(fn, 0) chunk in the async ranker.
// Lower = more yields (smoother UI, slower total); higher = fewer yields (faster).
// 700 players at 50/chunk = 14 chunks ≈ 14 yielded frames.
export const RANKER_CHUNK_SIZE = 50;

// ─── API / proxy ──────────────────────────────────────────────────────────────

// Proxy endpoint the frontend calls; the function forwards to FPL_BASE server-side.
export const PROXY_BASE = '/api/fpl';

// ─── Phase 3A — Understat (external xG) ──────────────────────────────────────

// Understat season slug to fetch single-team pages against. The proxy validates
// this against /^\d{4}$/ so any change here must remain four digits.
export const UNDERSTAT_SEASON = '2024';

// FPL team id → Understat URL slug. Understat slugs use underscores for spaces
// and the club's *full* name (e.g. 'Manchester_City', not 'Man City'). The id
// ordering follows FPL's alphabetical-by-full-name convention for 2024-25.
// MODEL: matching Understat → FPL by slug rather than free-text title avoids
// fuzzy-match failures around clubs whose FPL short name differs from their
// Understat title (Spurs ↔ Tottenham, Man Utd ↔ Manchester_United, etc.).
export const UNDERSTAT_TEAM_SLUGS = {
   1: 'Arsenal',
   2: 'Aston_Villa',
   3: 'Bournemouth',
   4: 'Brentford',
   5: 'Brighton',
   6: 'Chelsea',
   7: 'Crystal_Palace',
   8: 'Everton',
   9: 'Fulham',
  10: 'Ipswich',
  11: 'Leicester',
  12: 'Liverpool',
  13: 'Manchester_City',
  14: 'Manchester_United',
  15: 'Newcastle_United',
  16: 'Nottingham_Forest',
  17: 'Southampton',
  18: 'Tottenham',
  19: 'West_Ham',
  20: 'Wolverhampton_Wanderers',
};

// Cache TTL for the league-level Understat payload, in milliseconds.
// Understat refreshes daily at most; 1h is a safe ceiling for a session.
export const XG_TTL_MS = 60 * 60 * 1000;
