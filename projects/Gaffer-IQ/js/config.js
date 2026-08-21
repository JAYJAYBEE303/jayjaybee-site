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
// MODEL: an explicit alias table beats fuzzy matching, which fails exactly on
// the clubs whose short name diverges most from their full name (Spurs ↔
// Tottenham, Man Utd ↔ Manchester United). Also the join key for matching
// Understat teams by name (engine/style.js, via canonicalClubKey below) —
// same table, same resolver, both call sites need the exact same aliases.
export const TEAM_NAME_ALIASES = {
  // FPL `name` short forms
  'man city':        'Manchester City',
  'man utd':         'Manchester United',
  'spurs':           'Tottenham Hotspur',
  // Understat's team.title uses this short form (not 'Spurs') — verified live
  // against getLeagueData/EPL/2025.
  'tottenham':       'Tottenham Hotspur',
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
// Still consulted for other venue-aware reads; calcHomeAwaySplit itself no
// longer uses W_GD (see below) — it compares home vs away PPG only.
export const W_PPG = 0.7;
export const W_GD  = 0.3;

// Below this many games at EITHER venue, calcHomeAwaySplit returns a flat
// neutral 50, flagged estimated: true. This is a hard cutoff, not a blend —
// correcting a stale comment here that previously claimed a blend with the
// FPL-strength prior; no such blend exists anywhere in this file. The hard
// cutoff matches every other thin-sample guard in the engine (calcTeamForm,
// calcFixtureHistory: "< 2 meetings → neutral 50, flagged").
export const MIN_VENUE_GAMES = 4;

// How many of a team's most recent PL matches calcHomeAwaySplit's rolling
// window covers — a full season's worth, so it reads as "this season, topped
// up with last season's tail" for most of the year rather than resetting to
// nothing every August. Sourced from Understat (real cross-season match
// history: h_a, scored, missed, date — see engine/fixtures.js), NOT
// ctx.playedFixtures, which only ever holds the current season. Falls back to
// current-season-only (the FPL-fixtures path) when Understat data is
// unavailable for a team (promoted sides, or an Understat outage).
export const VENUE_ROLLING_GAMES = 38;

// Scales calcVenueEffect's combined home/away-sensitivity magnitude (0-100)
// into a composite-scale boost/penalty. At the ceiling (both teams maximally
// venue-sensitive, combinedMagnitude=100) this caps the swing at 50 points on
// either side of the neutral 50 that calcVenueEffect's boost/penalty is
// applied against — i.e. the full 0-100 range is reachable.
// MODEL: doubled 0.25 -> 0.5. In practice combinedMagnitude rarely nears the
// ceiling, so observed values were clustering in ~50-75 (home) / ~25-50
// (away) — the metric read as "always mild" even when it was near its own
// max. Doubling stretches that observed range out to the full 0-100 (e.g. an
// old reading of 68 becomes 86) without changing what drives it — this stays
// a linear rescale, and homeAway is still only WEIGHTS.homeAway (0.10) of
// the composite, so the wider spread doesn't change how much it can swing
// the final score, just how clearly it reads on the card.
export const W_VENUE_EFFECT = 0.5;

// ─── §4  Fixture history / head-to-head ──────────────────────────────────────

// Maximum prior meetings to include in the H2H calculation. Sourced from
// cross-season Understat fixture lists (UNDERSTAT_SEASON/PREV/PREV2/PREV3
// below — see engine/fixtures.js calcFixtureHistory), falling back to
// this-season FPL fixtures when Understat has no match for either team. Two
// teams meet twice a season, so 4 seasons of Understat data realistically
// caps out around 8 meetings — N_H2H=8 reflects that ceiling rather than
// promising a depth the data can't reach.
export const N_H2H = 8;

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
//
// Each rule contributes  sign * magnitude * aDev * bDev  to team A's style
// delta, where aDev = (A[axisA] - 50) / 50 and bDev = (B[axisB] - 50) / 50,
// each in -1..+1. The product is SIGNED — all four quadrants are meaningful,
// which is the whole point: a style is not merely "active or not", it is an
// exposure that cuts both ways. A high press is an asset against a side that
// cannot play out and a liability against one that can, and only a signed
// product can say both. (The pre-Phase-3B rules used a co-activation product
// clamped at zero, which could only ever express "both teams high on their
// axis" and silently discarded every mismatch — the exact situations a style
// clash is supposed to detect.)
//
// AXES ARE STYLE, NOT QUALITY. Every axis below is deliberately chosen to be
// roughly orthogonal to how *good* a team is: a mid-table side can press as
// hard as a title contender. Quality already enters the composite through
// baseDifficulty (0.30) and teamForm (0.16) — a style rule built on xG-quality
// axes would just re-weight team strength under a different name.
//
// See FEATURE_ENGINE.md §6.2 for the per-quadrant reading of each rule.
export const STYLE_RULES = [
  // A presses high; B's ability to play out from the back decides whether that
  // press is a weapon or a liability.
  //   A presses / B poor under pressure  → turnovers in dangerous areas   (+)
  //   A presses / B press-resistant      → the press is played through    (−)
  //   A sits off / B press-resistant     → the standard way to smother a
  //                                        possession side                (+)
  //   A sits off / B poor under pressure → A declines the obvious route
  //                                        to hurt them                   (−)
  { axisA: 'pressIntensity', axisB: 'buildUpControl', sign: -1, magnitude: 12 },

  // A plays direct / in transition; B's press height sets how much grass sits
  // behind B's defensive line. A high press is mechanically a high line — you
  // cannot press the ball 60 yards from your own goal with a deep block.
  //   A direct / B high press → the ball in behind, the classic counter   (+)
  //   A direct / B deep block → direct balls into a packed penalty area   (−)
  //   A patient / B high press → A gets pinned trying to play out          (−)
  //   A patient / B deep block → no press to beat, A builds freely         (+)
  { axisA: 'transitionDirectness', axisB: 'pressIntensity', sign: 1, magnitude: 10 },

  // A relies on sustained territory; B's compactness near its own box decides
  // whether that territory converts into real chances.
  //   A territorial / B compact → possession without penetration          (−)
  //   A territorial / B open    → repeatedly played through               (+)
  //   A not territorial / B compact → B's main defensive strength is idle  (+)
  //   A not territorial / B open    → A cannot exploit the openness        (−)
  { axisA: 'territorialThreat', axisB: 'defensiveCompactness', sign: -1, magnitude: 8 },
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

// Classification thresholds for classifyRoleFromSignature(position, sig) in
// engine/counter.js — the Understat-chain replacement for the ICT-share
// thresholds above (which remain as the per-player fallback).
//
// MODEL: derived from the 2025 season, 139 DEF / 153 MID / 24 FWD with at
// least 900 minutes. Spot-checked groups: FB = Robertson, Muñoz, Bradley,
// Dalot, Wan-Bissaka, Spence; DM = Xhaka, Ward-Prowse, Baleba, Ampadu;
// WM = Saka, Gordon, Mbeumo, Semenyo; SS = Welbeck, Solanke, Delap.
// See the design spec §4 for the full derivation.
export const ROLE_SIGNATURE_THRESHOLDS = {
  // DEF: a fullback is BOTH shallower than a centre-back (more final-third
  // involvement) AND a creator rather than a finisher. Both conditions are
  // required — a set-piece CB satisfies the first alone.
  defFbBuildupShareMax: 0.82,
  defFbCreateBiasMin:   0.50,
  // MID: a winger / inside-forward is a primary shot threat. Tested first
  // because it is the most decisive signal.
  midWmNpxg90Min:       0.22,
  // MID: a #6 is almost pure build-up.
  midDmBuildupShareMin: 0.78,
  // FWD: a shadow striker drops into pockets, so more of their involvement
  // sits before the final action than an out-and-out striker's.
  fwdSsBuildupShareMin: 0.30,
};

// Minimum evidence before a chain signature is trusted over the ICT fallback.
// MODEL: the thresholds above were derived on 900+ minute players; 450 (five
// full matches) is the in-season floor at which the ratios have stabilised
// enough to beat ICT. Below either bar, classifyRole falls back.
export const ROLE_SIGNATURE_MIN_MINUTES = 450;
export const ROLE_SIGNATURE_MIN_CHAIN   = 0.5;

// Share of a team's outfield MINUTES that must be covered by a chain signature
// before the role grouping is treated as fully data-backed.
// MODEL: replaces Phase 3C's fail-closed 90% player-count bar. That bar existed
// because mixing refined and unrefined players understates whichever side has
// worse coverage — but that reasoning applies to mixing TAXONOMIES, and chain
// and ICT emit the same eight labels from different evidence. Minutes-weighted
// rather than headcount so a fringe squad player can't drag a team below the
// bar. Below this share the roles are still used, just flagged estimated.
export const ROLE_CHAIN_COVERAGE_MIN = 0.75;

// Anchors for the counter-matchup fallback used when player-level form is missing
// (no element-summary loaded yet). Maps (team-A attack − team-B defence) from the
// FPL strength priors to a 0–100 pairing score, centred so the league-average gap
// lands near 50. Same scale family as OPP_STRENGTH_MIN/MAX but tighter (strength
// priors compress for the average-team attack-vs-defence spread).
export const COUNTER_FALLBACK_EDGE = { min: -300, max: 300 };

// Anchors mapping a unit's minutes-weighted mean xGChain per 90 onto 0–100,
// so the chain read of an attacking unit is on the same scale as the
// calcPlayerForm read it replaces.
// MODEL: 2025 season per-90 chain distribution — defenders p10 0.165 / p90
// 0.503, midfielders p10 0.272 / p90 0.751, forwards p10 0.358 / p90 0.783.
// A single pair of anchors spanning 0.15–0.80 covers every attacking unit
// without needing per-role scales; units below 0.15 are fringe-squad noise.
export const CHAIN_UNIT_ANCHORS = { min: 0.15, max: 0.80 };

// How the combined Counter-Matchup score (engine/counter.js →
// calcCombinedCounterMatchup) blends a team's Attacking Counters (its attack
// vs the opponent's defence) with its Defending Counters (its defence vs the
// opponent's attack, via calcCounterMatchupMirrored). MODEL: even 50/50 split
// — a team's counter-matchup quality is exactly as much about resisting the
// opponent's attack as it is about beating their defence, and neither one is
// a more "primary" read than the other. Must sum to 1.00. See FEATURE_ENGINE.md §7.2.
export const COUNTER_ATTACK_WEIGHT  = 0.5;
export const COUNTER_DEFENCE_WEIGHT = 0.5;

// ─── Channel counter-matchup (Understat team statistics) ────────────────────
// Three INDEPENDENT partitions of the same shots — not one partition of
// threat. An open-play axis is deliberately absent: openPlayShare is
// identically 1 − setPieceShare, so it carries no extra information.
//
// MODEL: measured across all 20 clubs, 2025 season. Largest pairwise
// correlation among attacking profiles is corr(box, fast) = +0.334; among
// defensive profiles corr(setPiece, fast) = −0.161. The axes are
// near-independent, so none needs collapsing into another.

// Pooled standard deviation of (attacking share − conceding share) per axis,
// used to z-score each edge so all three contribute on a common scale.
// MODEL: sqrt(sd_for² + sd_against²) from the 2025 league distribution —
// setPiece 0.0555/0.0410, box 0.0170/0.0091, fast 0.0229/0.0263.
export const CHANNEL_AXIS_POOLED_SD = {
  setPieceThreat: 0.0690,
  wideTransition: 0.0348,
  boxThreat:      0.0193,
};

// MODEL: weighted by discriminating power and novelty, not intuition.
// setPiece has the widest league spread (0.170–0.370) and is the ONLY axis on
// which the composite currently carries no signal at all. box has the
// narrowest spread (0.884–0.937) and the strongest residual quality confound
// (corr with npxG volume +0.408), so it is weighted least.
export const CHANNEL_WEIGHTS = {
  setPieceThreat: 0.50,
  wideTransition: 0.30,
  boxThreat:      0.20,
};

// Points per pooled standard deviation of axis edge.
// MODEL: 14 puts a 2-SD mismatch at ±28 points, comparable to the spread
// COUNTER_SENSITIVITY produces on the role tier.
export const CHANNEL_SENSITIVITY = 14;

// Minimum shots in a team's situation partition before its channel profile is
// trusted. MODEL: a PL side takes ~13 shots a game, so 120 is roughly nine
// matches — the point at which the set-piece share (the thinnest bucket, ~25%
// of shots) stops being dominated by sampling noise.
export const MIN_CHANNEL_SHOTS = 120;

// ─── §8  Composite matchup score ─────────────────────────────────────────────

// Weights for all sub-metrics. Must sum to 1.00.
// See FEATURE_ENGINE.md §8.1 for the rationale behind each weight.
// MODEL: styleClash weight raised from 0.07 to 0.12 — now backed by real
// Understat xG data (Phase 3A).
// MODEL: baseDifficulty raised 0.25 → 0.33. Opponent quality is the single most
// dependable signal available (never estimated, present from day one), and the
// composite was under-weighting it relative to how much it actually decides
// results. The other five weights were scaled down proportionally (×0.67/0.75)
// so the total still lands on exactly 1.00 and their relative ordering is
// unchanged. Pairs with the stacking penalty below: a bigger base weight alone
// would make a favourite's score nearly immovable, which is why the conditional
// term exists. See FEATURE_ENGINE.md §8.1.
// MODEL: counterMatchup raised 0.22 → 0.28. It used to reflect ONLY a team's
// attack vs the opponent's defence — a team's own defensive quality against
// THIS opponent's attack earned no direct credit on its own card, only an
// indirect, heavily-diluted one via the opponent's raw score in the §8.7
// relative step. Now that the metric blends both pairings (§7.2), it carries
// twice the underlying signal it used to, so its weight was raised to match —
// otherwise a genuinely elite defence (e.g. a title-contender with a merely
// "mid" attack) would still barely register on its own composite. The other
// four non-baseDifficulty weights were trimmed to compensate (baseDifficulty
// itself also trimmed slightly), preserving relative ordering, so the total
// still lands on exactly 1.00. See FEATURE_ENGINE.md §7.2 and §8.1.
// MODEL: rebalanced again — counterMatchup 0.28→0.20, history 0.03→0.15
// (raised to parity with teamForm now that §4's calcFixtureHistory draws on
// real cross-season Understat data instead of this-season-only FPL fixtures
// — no longer thin enough to justify a token weight), homeAway 0.13→0.10.
// baseDifficulty/styleClash unchanged. Still sums to 1.00. See FEATURE_ENGINE.md §8.1.
// MODEL: homeAway 0.10→0.05, baseDifficulty 0.30→0.35. The freed 5 points
// moved straight onto baseDifficulty rather than being spread around — it's
// the one weight that's never estimated (§8.3), so it's the safest place to
// bank a cut from a metric that was reading noisier than the others wanted
// it to be. Still sums to 1.00. See FEATURE_ENGINE.md §8.1.
export const WEIGHTS = {
  baseDifficulty: 0.35,   // strength priors — always available, the dependable floor
  counterMatchup: 0.20,   // attacking AND defending pairings blended (§7.2)
  teamForm:       0.15,   // recent trajectory, opponent-quality adjusted
  history:        0.15,   // H2H nudge — raised now that it draws on real cross-season data (§4)
  homeAway:       0.05,   // venue performance this season
  styleClash:     0.10,   // stylistic interaction — Understat xG-backed (Phase 3A)
};

// ─── §8.6  Stacking penalty (conditional interaction across sub-metrics) ─────

// MODEL: a plain weighted sum degrades LINEARLY — the first poor secondary
// metric costs a favourite exactly as much as the third does. Real fixtures do
// not behave that way. A side facing a weak opponent still has a good chance if
// only one thing is against them; they genuinely lose that chance when a poor
// venue record, poor form AND a losing counter-matchup arrive together. These
// three constants encode that asymmetry so the composite stays resilient to a
// single dip but tips sharply once several stack up.
// See FEATURE_ENGINE.md §8.6.

// Value a secondary metric must fall BELOW before it counts as unfavourable.
// MODEL: deliberately under 50, because every estimated sub-metric falls back to
// exactly 50 (§8.3). A pivot at or above 50 would penalise the entire league
// whenever data is thin — which is most of pre-season.
export const STACK_PIVOT = 45;

// Exponent applied to the 0–1 stack index before scaling by STACK_MAX_PENALTY.
// MODEL: the exponent IS the mechanism. Above 1 it makes the punishment curve
// rather than ramp, so one unfavourable metric barely registers while three
// compound sharply. 2.0 gives a ~9.8x penalty ratio between the three-bad and
// one-bad cases. Same exponent and same reasoning as TENURE_CURVE (§2.1) —
// the engine keeps one idiom for "punish genuine stacking, not single dips".
// Lower toward 1.0 to make secondary metrics bite earlier and more linearly.
export const STACK_CURVE = 2.0;

// Maximum points deductible, reached only when every non-estimated secondary
// metric sits at 0. MODEL: sized to move a score a full band or more in a
// genuine collapse while leaving mild, widespread mediocrity almost free —
// all five secondaries at 40 (just under the pivot) costs ~0.6 points.
export const STACK_MAX_PENALTY = 45;

// ─── §8.7  Relative (zero-sum) composite ─────────────────────────────────────

// MODEL: every sub-metric above (baseDifficulty, teamForm, homeAway, styleClash,
// counterMatchup, history) is computed independently per team against a fixed
// scale — nothing compares team A's read to team B's. Two strong teams both
// read as "facing a tough opponent" and both get punished for it; two weak
// teams both read as "facing a soft opponent" and both get rewarded — despite
// neither pairing having a real edge. scoreFixture corrects this in one final
// step: each team's pre-relative composite (everything above, unchanged) is
// compared against the SAME fixture's opponent read, and the final value is
// derived from their signed difference so the two teams' totals are guaranteed
// to sum to exactly 100 — see FEATURE_ENGINE.md §8.7.
//
// MODEL: 0.5 is not an arbitrary softening constant — at exactly 0.5, a raw
// edge spanning the full possible range (-100 to +100, i.e. one side reads 100
// and the other 0) maps to the full output range (0 to 100) with the clamp
// never engaging before the mathematical extremes. Raising this above 0.5
// would make smaller real edges reach the 0/100 boundary sooner (a harsher,
// more binary read of any given gap); it does not change the zero-sum
// guarantee itself, which holds at any value via clamp(v)+clamp(100-v)≡100.
export const RELATIVE_EDGE_SENSITIVITY = 0.5;

// Minimum weighted share of non-estimated sub-metrics before the UI renders
// a provisional indicator. Score is still produced; only the badge changes.
// MODEL: lowered 0.6 -> 0.5 — the provisional/hatched styling (matchup card,
// score pill, perGw strip cells) should read as "less than half the score is
// confident data", not trip at a stricter bar than that.
export const CONFIDENCE_FLOOR = 0.5;

// Band thresholds — lower bound of each band (inclusive).
// See FEATURE_ENGINE.md §8.4. CSS modifier classes must match these strings.
export const BANDS = {
  great:   75,
  good:    60,
  neutral: 41,
  tough:   26,
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

// Weights for the four components of the player projection score (must sum to 1).
// MODEL: PROJ_MINUTES added as a first-class input because minutes-security was
// previously reaching the composite only indirectly, via W_MINUTES inside
// calcPlayerForm — worth just 0.45 × 0.30 ≈ 13.5% of the score, which was not
// enough leverage to stop a high-per-90 rotation risk out-ranking a nailed
// starter. The three existing weights were scaled down proportionally (×0.80)
// to make room, so the total still lands on exactly 1.00.
// MODEL: this deliberately DOUBLE-COUNTS minutes (W_MINUTES inside form, plus
// this term), taking total minutes influence to roughly 33%. That is intended,
// not an oversight: minutes matter twice over in FPL — once as evidence a player
// is actually performing, and again as the probability he starts at all. Reducing
// W_MINUTES to compensate was rejected because calcPlayerForm also feeds
// counter.js's unit-form reads and the Individual Duels, so it would silently
// move counter-matchup numbers too. See FEATURE_ENGINE.md §10.
export const PROJ_FORM    = 0.36;   // player's own form and availability
export const PROJ_FIXTURE = 0.28;   // team's horizon fixture score
export const PROJ_COUNTER = 0.16;   // player's position counter-matchup edge
export const PROJ_MINUTES = 0.20;   // playing likelihood — will he actually start?

// How far `expectedPoints` (a real points-scale captaincy/TC projection,
// FEATURE_ENGINE.md §10) swings avgPointsPerGw based on next-fixture quality.
// MODEL: nextFixtureScore of 50 (neutral) applies a ×1.0 multiplier; 100 (best
// possible fixture) applies ×(1 + EXPECTED_PTS_FIXTURE_SWING); 0 (worst) applies
// ×(1 − EXPECTED_PTS_FIXTURE_SWING). 0.5 was chosen so a great/awful fixture can
// meaningfully swing the pick without ever driving the multiplier negative.
export const EXPECTED_PTS_FIXTURE_SWING = 0.5;

// Fallback playing-chance percentage per internal status string, used by
// calcPlayingLikelihood ONLY when FPL's own chance_of_playing_next_round is
// null (which is the normal case — FPL populates it only when there is news).
// MODEL: 'doubtful' sits at the midpoint because FPL's own scale for a flagged
// player is 25/50/75; when it declines to give a number, halfway is the honest
// read. Suspended and injured are hard zeros — they cannot start.
export const STATUS_PLAY_CHANCE = {
  available:   100,
  doubtful:     50,
  injured:       0,
  suspended:     0,
  unavailable:   0,
};

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

// Number of player-summary FETCHES (real network requests, not synchronous
// scoring) run concurrently per chunk when the Ranker's "Last Season" Avg
// Pts/GW toggle triggers a full-pool load. Deliberately smaller than
// RANKER_CHUNK_SIZE — these hit the FPL API through the proxy, not just CPU —
// so a lower concurrency is more considerate to the upstream API even though
// this is now an explicit, user-triggered action rather than an on-load fetch.
// See FEATURE_ENGINE.md §10.1.
export const SUMMARY_FETCH_CHUNK_SIZE = 20;

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

// ─── Phase 3A/3B — Understat (external xG) ───────────────────────────────────

// Understat season year, both start-year label (e.g. '2026' = the 2026/27
// season) and REQUIRED on every Understat proxy call — confirmed live
// (2026-07-31) that Understat's real endpoints 404 without an explicit
// season, there is no "current season" default to omit it and fall back to.
// Bump both of these every close season (this file has no automatic
// "current season" derivation — same manual-maintenance category as
// PL_SEASONS above, which needs the same yearly addition).
export const UNDERSTAT_SEASON       = '2026';  // this season (2026/27)
export const UNDERSTAT_PREV_SEASON  = '2025';  // last completed season (2025/26)
// Two further seasons back, fetched ONLY to deepen calcFixtureHistory's
// cross-season H2H window (N_H2H=8 above) — nothing else in the engine reads
// them. calcHomeAwaySplit's rolling window intentionally stays on the two
// seasons above (VENUE_ROLLING_GAMES=38 already covers close to a season).
export const UNDERSTAT_PREV2_SEASON = '2024';  // two seasons ago (2024/25)
export const UNDERSTAT_PREV3_SEASON = '2023';  // three seasons ago (2023/24)
// FPL team id -> Understat slug tables were removed here (Phase 3B): FPL's
// numeric team.id is REASSIGNED every season as clubs are promoted/relegated
// (see engine/normalise.js buildPlTenure's identical warning), so an id-keyed
// table drifts out of correctness every summer with no error to catch it —
// confirmed as the actual live cause of every Understat team lookup silently
// missing before this fix. Understat teams are now matched by NAME via
// canonicalClubKey (engine/normalise.js), the same TEAM_NAME_ALIASES-backed
// resolver buildPlTenure already used correctly. See engine/style.js.

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

// ─── Rank-relative player colouring (Ranker / Planner / Dashboard) ───────────

// MODEL: this is a SEPARATE colouring axis from BANDS (§8.4) — BANDS classifies
// a score against the fixed 0–100 scale; these tiers classify a player against
// the CURRENT POOL, so "worth strongly considering" pops out regardless of how
// the absolute scale happens to be distributed this season. Precedence, most
// to least specific: RANK_ELITE_COUNT_BY_POS > RANK_STRONG_COUNT_BY_POS >
// RANK_BOTTOM_PERCENTILE. A player outside all three keeps their existing
// BANDS colour — this system only overrides colour for the standout tiers,
// not the unremarkable middle. See FEATURE_ENGINE.md §13.

// MODEL: the two "worth considering" tiers are PER-POSITION fixed counts, not
// pool-wide — a pool-wide count/percentile systematically buried Forwards (few
// slots, expensive, ~50 in the game) under cheap Defenders (many slots, ~100+
// in the game) that post a similar composite score. Ranking each position
// against its own peers, not the other three positions, is what actually
// surfaces "good picks I might be missing" per position — which is the point
// of the feature. GKP/FWD get their own (smaller) counts because there are
// far fewer of them in a valid squad (2 and 3 respectively, vs 5 for DEF/MID).
export const RANK_ELITE_COUNT_BY_POS  = { GKP: 2, DEF: 5,  MID: 5,  FWD: 3 };
export const RANK_STRONG_COUNT_BY_POS = { GKP: 8, DEF: 20, MID: 20, FWD: 12 };

// Fraction of the pool, counted from the top, considered comfortably good
// enough to flag neutral/grey even without qualifying for a position-based
// green tier above. POOL-WIDE like RANK_BOTTOM_PERCENTILE below, for the same
// reason: this is just "clearing a bar", not a per-position "hidden gem" check.
export const RANK_TOP_PERCENTILE = 0.25;

// Fraction of the pool, counted from the bottom, considered weak enough to
// flag red. Deliberately still POOL-WIDE (not per-position) — unlike the two
// green tiers above, there's no "hidden gem" concern to correct for at the
// bottom; a weak player is weak regardless of what position he shares the
// flag with. Everyone between RANK_TOP_PERCENTILE and here (and outside both
// green tiers) falls into the middle "yellow" tier — see FEATURE_ENGINE.md §13.
export const RANK_BOTTOM_PERCENTILE = 0.40;
