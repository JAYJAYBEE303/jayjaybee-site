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

// ─── §7.2  Position counter-matchup ──────────────────────────────────────────

// Scales the pairingEdge (form gap between attacking and defensive unit) into
// the 0–100 score centred at 50. Default: a 20-point form gap moves the score ±20.
export const COUNTER_SENSITIVITY = 1.0;

// Relative importance of each position pairing; normalised inside engine/counter.js.
export const PAIRING_WEIGHTS = {
  fwdVsCb:     1.0,   // strikers vs centre-backs — primary scoring threat
  wideMidVsFb: 0.6,   // wide mids / wingers vs full-backs
  camVsCbMid:  0.4,   // central attacking mids vs CBs + defensive mids
};

// ─── §8  Composite matchup score ─────────────────────────────────────────────

// Weights for all sub-metrics. Must sum to 1.00.
// See FEATURE_ENGINE.md §8.1 for the rationale behind each weight.
export const WEIGHTS = {
  baseDifficulty: 0.30,   // strength priors — always available, the dependable floor
  counterMatchup: 0.25,   // the signature metric — position form mismatches
  teamForm:       0.20,   // recent trajectory, opponent-quality adjusted
  homeAway:       0.15,   // venue performance this season
  styleClash:     0.07,   // stylistic interaction (proxied in Phase 1; raise in Phase 3)
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

// ─── API / proxy ──────────────────────────────────────────────────────────────

// Proxy endpoint the frontend calls; the function forwards to FPL_BASE server-side.
export const PROXY_BASE = '/api/fpl';
