/**
 * js/config.js
 * Layer: config (pure constants). No logic, no DOM, no network.
 * Single source of truth for every tunable number in the engine.
 * See FEATURE_ENGINE.md for the meaning and rationale of each constant.
 * Tuning the model = editing this file only; formulas never contain literals.
 */

// ─── §2  Base fixture difficulty ─────────────────────────────────────────────

// MODEL: base difficulty reads the OPPONENT's absolute strength, not the edge
// between the two sides. A strong club therefore posts the same high number in
// whoever's box it appears in — Man City are a hard fixture for Wolves and for
// Arsenal alike. See FEATURE_ENGINE.md §2.
//
// DIRECTION EXCEPTION: this is the one metric stored as "higher = HARDER for
// the team being scored", because the UI surfaces it directly as the opponent's
// strength. Every other sub-metric follows §1 rule 2 (higher = better for the
// team). engine/composite.js inverts this value before weighting it, so the
// composite still sees a higher-is-better number. Do not remove that invert().

// Weights for the opponent's attacking and defensive strength (must sum to 1).
export const W_OPP_ATTACK  = 0.5;
export const W_OPP_DEFENCE = 0.5;

// Normalisation bounds for the opponent's raw strength. FPL's strength_* fields
// sit roughly in the 1000–1400 band; re-calibrate once a season's spread is known.
export const OPP_STRENGTH_MIN = 1000;
export const OPP_STRENGTH_MAX = 1400;

// FDR fallback (bugfix, confirmed live 2026/27 preseason): FPL sometimes leaves
// strength_attack_home/away and strength_defence_home/away at 0 for every team
// — seen before FPL has calculated the granular attack/defence breakdown —
// while strength_overall_home/away and the fixture's own FDR
// (team_h_difficulty/team_a_difficulty) ARE already populated. A real strength
// int never reads 0 (FPL's scale runs ~1000-1400), so calcBaseDifficulty
// treats "both fields exactly 0" as "not yet published" and substitutes the
// team's own FPL FDR for that fixture via this lookup instead of letting
// normaliseLinear floor a missing input at 0 (which reads as "impossibly easy"
// once inverted). Same direction as the granular calc: higher = HARDER.
export const FDR_FALLBACK_VALUES = { 1: 10, 2: 30, 3: 50, 4: 70, 5: 90 };

// ─── §2.1  Premier League tenure (promoted-team awareness) ───────────────────

// How many seasons of top-flight history to consider. 15 covers 2011/12–2025/26.
export const PL_TENURE_LOOKBACK = 15;

// Per-season decay applied when weighting a club's PL presence, newest first.
// MODEL: a relegation last season says far more about a squad's current level
// than an absence eight years ago, so presence is recency-weighted rather than
// a flat count. 0.85 ⇒ the most recent season carries ~4.5x the weight of one
// eight seasons back.
export const TENURE_RECENCY_DECAY = 0.85;

// Maximum points deducted from an opponent's strength reading when that
// opponent has no recent top-flight history at all.
export const TENURE_MAX_PENALTY = 40;

// Exponent applied to the tenure deficit before scaling by TENURE_MAX_PENALTY.
// MODEL: makes the punishment curve, not ramp. A club with several consecutive
// recent PL seasons is established in practice even if it was in the Championship
// a decade ago — at 2.0 a 0.29 deficit (e.g. five straight seasons up) costs ~3
// points rather than ~12, while a genuine newcomer still takes the full 40.
// Raise toward 3.0 to spare part-tenured clubs further; 1.0 = linear.
export const TENURE_CURVE = 2.0;

// Hard lower bound for a tenure-penalised reading. The penalty can never drag a
// score below this, and never RAISES a score that already sits under it.
export const TENURE_FLOOR = 20;

// Clubs that contested each Premier League season, newest first. Used to derive
// a club's recency-weighted tenure — see engine/normalise.js → buildPlTenure.
// MODEL: keyed by club name rather than FPL team id, because ids are reassigned
// each season as clubs go up and down. Names are matched through
// TEAM_NAME_ALIASES so FPL's short forms ("Spurs", "Nott'm Forest") resolve.
// A club absent from every season here scores zero tenure — which is the
// correct reading for a genuine newcomer.
export const PL_SEASONS = {
  '2025/26': ['Arsenal', 'Aston Villa', 'Bournemouth', 'Brentford', 'Brighton & Hove Albion',
              'Burnley', 'Chelsea', 'Crystal Palace', 'Everton', 'Fulham', 'Leeds United',
              'Liverpool', 'Manchester City', 'Manchester United', 'Newcastle United',
              'Nottingham Forest', 'Sunderland', 'Tottenham Hotspur', 'West Ham United',
              'Wolverhampton Wanderers'],
  '2024/25': ['Arsenal', 'Aston Villa', 'Bournemouth', 'Brentford', 'Brighton & Hove Albion',
              'Chelsea', 'Crystal Palace', 'Everton', 'Fulham', 'Ipswich Town', 'Leicester City',
              'Liverpool', 'Manchester City', 'Manchester United', 'Newcastle United',
              'Nottingham Forest', 'Southampton', 'Tottenham Hotspur', 'West Ham United',
              'Wolverhampton Wanderers'],
  '2023/24': ['Arsenal', 'Aston Villa', 'Bournemouth', 'Brentford', 'Brighton & Hove Albion',
              'Burnley', 'Chelsea', 'Crystal Palace', 'Everton', 'Fulham', 'Liverpool',
              'Luton Town', 'Manchester City', 'Manchester United', 'Newcastle United',
              'Nottingham Forest', 'Sheffield United', 'Tottenham Hotspur', 'West Ham United',
              'Wolverhampton Wanderers'],
  '2022/23': ['Arsenal', 'Aston Villa', 'Bournemouth', 'Brentford', 'Brighton & Hove Albion',
              'Chelsea', 'Crystal Palace', 'Everton', 'Fulham', 'Leeds United', 'Leicester City',
              'Liverpool', 'Manchester City', 'Manchester United', 'Newcastle United',
              'Nottingham Forest', 'Southampton', 'Tottenham Hotspur', 'West Ham United',
              'Wolverhampton Wanderers'],
  '2021/22': ['Arsenal', 'Aston Villa', 'Brentford', 'Brighton & Hove Albion', 'Burnley',
              'Chelsea', 'Crystal Palace', 'Everton', 'Leeds United', 'Leicester City',
              'Liverpool', 'Manchester City', 'Manchester United', 'Newcastle United',
              'Norwich City', 'Southampton', 'Tottenham Hotspur', 'Watford', 'West Ham United',
              'Wolverhampton Wanderers'],
  '2020/21': ['Arsenal', 'Aston Villa', 'Brighton & Hove Albion', 'Burnley', 'Chelsea',
              'Crystal Palace', 'Everton', 'Fulham', 'Leeds United', 'Leicester City',
              'Liverpool', 'Manchester City', 'Manchester United', 'Newcastle United',
              'Sheffield United', 'Southampton', 'Tottenham Hotspur', 'West Bromwich Albion',
              'West Ham United', 'Wolverhampton Wanderers'],
  '2019/20': ['Arsenal', 'Aston Villa', 'Bournemouth', 'Brighton & Hove Albion', 'Burnley',
              'Chelsea', 'Crystal Palace', 'Everton', 'Leicester City', 'Liverpool',
              'Manchester City', 'Manchester United', 'Newcastle United', 'Norwich City',
              'Sheffield United', 'Southampton', 'Tottenham Hotspur', 'Watford',
              'West Ham United', 'Wolverhampton Wanderers'],
  '2018/19': ['Arsenal', 'Bournemouth', 'Brighton & Hove Albion', 'Burnley', 'Cardiff City',
              'Chelsea', 'Crystal Palace', 'Everton', 'Fulham', 'Huddersfield Town',
              'Leicester City', 'Liverpool', 'Manchester City', 'Manchester United',
              'Newcastle United', 'Southampton', 'Tottenham Hotspur', 'Watford',
              'West Ham United', 'Wolverhampton Wanderers'],
  '2017/18': ['Arsenal', 'Bournemouth', 'Brighton & Hove Albion', 'Burnley', 'Chelsea',
              'Crystal Palace', 'Everton', 'Huddersfield Town', 'Leicester City', 'Liverpool',
              'Manchester City', 'Manchester United', 'Newcastle United', 'Southampton',
              'Stoke City', 'Swansea City', 'Tottenham Hotspur', 'Watford',
              'West Bromwich Albion', 'West Ham United'],
  '2016/17': ['Arsenal', 'Bournemouth', 'Burnley', 'Chelsea', 'Crystal Palace', 'Everton',
              'Hull City', 'Leicester City', 'Liverpool', 'Manchester City',
              'Manchester United', 'Middlesbrough', 'Southampton', 'Stoke City', 'Sunderland',
              'Swansea City', 'Tottenham Hotspur', 'Watford', 'West Bromwich Albion',
              'West Ham United'],
  '2015/16': ['Arsenal', 'Aston Villa', 'Bournemouth', 'Chelsea', 'Crystal Palace', 'Everton',
              'Leicester City', 'Liverpool', 'Manchester City', 'Manchester United',
              'Newcastle United', 'Norwich City', 'Southampton', 'Stoke City', 'Sunderland',
              'Swansea City', 'Tottenham Hotspur', 'Watford', 'West Bromwich Albion',
              'West Ham United'],
  '2014/15': ['Arsenal', 'Aston Villa', 'Burnley', 'Chelsea', 'Crystal Palace', 'Everton',
              'Hull City', 'Leicester City', 'Liverpool', 'Manchester City',
              'Manchester United', 'Newcastle United', 'Queens Park Rangers', 'Southampton',
              'Stoke City', 'Sunderland', 'Swansea City', 'Tottenham Hotspur',
              'West Bromwich Albion', 'West Ham United'],
  '2013/14': ['Arsenal', 'Aston Villa', 'Cardiff City', 'Chelsea', 'Crystal Palace', 'Everton',
              'Fulham', 'Hull City', 'Liverpool', 'Manchester City', 'Manchester United',
              'Newcastle United', 'Norwich City', 'Southampton', 'Stoke City', 'Sunderland',
              'Swansea City', 'Tottenham Hotspur', 'West Bromwich Albion', 'West Ham United'],
  '2012/13': ['Arsenal', 'Aston Villa', 'Chelsea', 'Everton', 'Fulham', 'Liverpool',
              'Manchester City', 'Manchester United', 'Newcastle United', 'Norwich City',
              'Queens Park Rangers', 'Reading', 'Southampton', 'Stoke City', 'Sunderland',
              'Swansea City', 'Tottenham Hotspur', 'West Bromwich Albion', 'West Ham United',
              'Wigan Athletic'],
  '2011/12': ['Arsenal', 'Aston Villa', 'Blackburn Rovers', 'Bolton Wanderers', 'Chelsea',
              'Everton', 'Fulham', 'Liverpool', 'Manchester City', 'Manchester United',
              'Newcastle United', 'Norwich City', 'Queens Park Rangers', 'Stoke City',
              'Sunderland', 'Swansea City', 'Tottenham Hotspur', 'West Bromwich Albion',
              'Wigan Athletic', 'Wolverhampton Wanderers'],
};

// FPL name / short-name variants → the canonical club name used in PL_SEASONS.
// Keys are compared after normalisation (lowercased, non-alphanumerics stripped),
// so "Nott'm Forest", "nottm forest" and "NFO" all resolve to the same entry.
// MODEL: same reasoning as UNDERSTAT_TEAM_SLUGS — an explicit alias table beats
// fuzzy matching, which fails exactly on the clubs whose FPL short name diverges
// most from their full name (Spurs ↔ Tottenham, Man Utd ↔ Manchester United).
export const TEAM_NAME_ALIASES = {
  // FPL `name` short forms
  'man city':        'Manchester City',
  'man utd':         'Manchester United',
  'spurs':           'Tottenham Hotspur',
  'nottm forest':    'Nottingham Forest',
  'newcastle':       'Newcastle United',
  'brighton':        'Brighton & Hove Albion',
  'leeds':           'Leeds United',
  'leicester':       'Leicester City',
  'norwich':         'Norwich City',
  'ipswich':         'Ipswich Town',
  'luton':           'Luton Town',
  'hull':            'Hull City',
  'cardiff':         'Cardiff City',
  'stoke':           'Stoke City',
  'swansea':         'Swansea City',
  'west brom':       'West Bromwich Albion',
  'west ham':        'West Ham United',
  'wolves':          'Wolverhampton Wanderers',
  'sheffield utd':   'Sheffield United',
  'qpr':             'Queens Park Rangers',
  'huddersfield':    'Huddersfield Town',
  'blackburn':       'Blackburn Rovers',
  'bolton':          'Bolton Wanderers',
  'wigan':           'Wigan Athletic',
  // FPL `shortName` codes — the fallback join key
  'mci': 'Manchester City',        'mun': 'Manchester United',
  'tot': 'Tottenham Hotspur',      'nfo': 'Nottingham Forest',
  'new': 'Newcastle United',       'bha': 'Brighton & Hove Albion',
  'lee': 'Leeds United',           'lei': 'Leicester City',
  'nor': 'Norwich City',           'ips': 'Ipswich Town',
  'lut': 'Luton Town',             'hul': 'Hull City',
  'car': 'Cardiff City',           'stk': 'Stoke City',
  'swa': 'Swansea City',           'wba': 'West Bromwich Albion',
  'whu': 'West Ham United',        'wol': 'Wolverhampton Wanderers',
  'shu': 'Sheffield United',       'qpr': 'Queens Park Rangers',
  'hud': 'Huddersfield Town',      'blb': 'Blackburn Rovers',
  'bol': 'Bolton Wanderers',       'wig': 'Wigan Athletic',
  'ars': 'Arsenal',                'avl': 'Aston Villa',
  'bou': 'Bournemouth',            'bre': 'Brentford',
  'bur': 'Burnley',                'che': 'Chelsea',
  'cry': 'Crystal Palace',         'eve': 'Everton',
  'ful': 'Fulham',                 'liv': 'Liverpool',
  'sou': 'Southampton',            'sun': 'Sunderland',
  'wat': 'Watford',                'mid': 'Middlesbrough',
  'rea': 'Reading',
};

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
// lands near 50. Same scale family as OPP_STRENGTH_MIN/MAX but tighter (strength
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

// Ranker price filter (Phase 5A): a single "maximum price" threshold selector,
// generated from this range rather than hardcoded <option> strings. Each value
// means "show players priced at or below this" — "All Prices" (handled
// separately in ranker.js, not part of this range) stays unrestricted, which
// already includes anyone below PRICE_FILTER_MIN too.
export const PRICE_FILTER_MIN  = 4.0;
export const PRICE_FILTER_MAX  = 10.0;
export const PRICE_FILTER_STEP = 0.5;

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

// ─── Phase 4-4  Price change prediction ──────────────────────────────────────

// Minimum combined in+out transfer activity this GW before the signal is trusted.
// Below this threshold the engine returns direction:'stable' with zero confidence.
// MODEL: very early in a GW (first hour) activity is too thin to read reliably.
export const PRICE_MIN_ACTIVITY = 5000;

// Total transfer activity at which confidence reaches its maximum (still gated
// by how one-sided the net flow is). Typical busy GW peaks 100k–500k per player.
export const PRICE_ACTIVITY_SCALE = 100000;

// Minimum price-change confidence (0–1) for the "Buy now" flag in the planner.
// Below this the signal is too weak to recommend urgency.
export const PRICE_BUY_NOW_CONFIDENCE = 0.5;

// Minimum player projection score (0–100) required alongside high price-rise
// confidence for the "Buy now" badge. Guards against flagging a rising player
// who has a brutal upcoming fixture run.
export const PRICE_BUY_NOW_SCORE_MIN = 55;
