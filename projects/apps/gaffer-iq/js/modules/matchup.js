/**
 * js/modules/matchup.js
 * Layer: module. Owns the DOM for the Matchup Analyser view.
 * Side effects: DOM writes only. Reads from store; calls engine functions.
 * Renders one fixture from both teams' perspectives — the full CompositeScore
 * breakdown, counter-matchup pairings, confidence, official FPL FDR comparison
 * and each side's 10-gameweek outlook.
 * No analytical logic lives here — all scoring delegated to engine/composite.js.
 * See ARCHITECTURE.md §10, FEATURE_ENGINE.md §11, ROADMAP.md Phase 1C.
 *
 * Presentation ported from the design export's FINAL - Matchup.html
 * ("Draft D · Composite"); styles in css/matchup.css. The page is a command
 * bar (fixture + team drawers), a "read it as" strip, the score tape, then
 * three sections — Why (breakdown), Detail (counter donuts), Horizon (outlook).
 * The Full Season strip below it belongs to js/modules/fullSeason.js and is
 * not touched from here.
 *
 * Subscriptions: data:ready, route:changed, player:selected
 * Renders only while on screen: data:ready does the cheap bookkeeping
 * unconditionally, then defers the expensive work to route:changed when
 * this module is hidden. See CONVENTIONS.md §8.
 */

import { store } from '../store.js';
import {
  HORIZONS, WEIGHTS, FORM_WINDOW_GWS, CHANNEL_MATURITY_FULL_MATCHES,
  H2H_MEETING_WINDOW, CHIP_RESET_AFTER_GW, BANDS_V2,
} from '../config.js';
import {
  buildScoreContext, scoreFixture, scoreOverHorizon, bandFromValue,
} from '../engine/composite.js';
import {
  calcIndividualDuels, calcCounterMatchupMirrored, duelsForPairing,
} from '../engine/counter.js';
import { groupPerGwSlots, pendingFixturesForTeam } from '../engine/fixtures.js';
import { invert, clamp } from '../util.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const METRIC_LABELS = {
  // Suffixed — the ONE row where a high number means a tougher opponent, not a
  // better fixture (see the label's title= tooltip and buildBreakdownRows()).
  baseDifficulty: 'Base FPL Difficulty',
  counterMatchup: 'Counter-Matchup',
  teamForm:       'Team Form',
  history:        'H2H History',
  homeAway:       'Home/Away Split',
  // styleClash:  'Style Clash',   // removed — see WEIGHTS in config.js.
  //   METRIC_ORDER derives from these keys, so dropping the label drops the row.
};

// Tiebreak for metrics on equal weight (teamForm and history are both 0.15).
// Read as "which is more worth reading first", and only ever consulted when
// WEIGHTS cannot separate two rows.
const METRIC_TIEBREAK = [
  'baseDifficulty', 'counterMatchup', 'teamForm', 'history', 'homeAway',
];

// Heaviest metric first. DERIVED from WEIGHTS rather than written out, so a
// reweighting in config.js reorders the card automatically — the previous
// hand-maintained list had already drifted (homeAway at 5% sat above styleClash
// at 10%, back when that metric existed), which is exactly the failure this
// removes.
const METRIC_ORDER = Object.keys(METRIC_LABELS).sort((a, b) =>
  (WEIGHTS[b] - WEIGHTS[a])
  || (METRIC_TIEBREAK.indexOf(a) - METRIC_TIEBREAK.indexOf(b)));

// How many gameweeks the Outlook strip at the foot of each card covers.
//
// FIXED HERE rather than read from store.getActiveHorizon(), which the rest of
// the app plans against. Those are two different questions. The active horizon
// prices players in the Ranker and Planner, so its length is a scoring
// decision; this strip just shows a team's run of fixtures, where a longer
// window is only more to look at. Widening the shared horizon to reach 10
// weeks here would silently rescore every player in two other modules.
//
// The strip wraps (.pgw-strip is flex-wrap), so a card too narrow for ten
// slots on one line gets two lines rather than a clipped run.
const MATCHUP_OUTLOOK_HORIZON = HORIZONS.GW10;

// Metrics whose weight ramps up with evidence, and the matches each needs
// before it carries its full configured weight. The breakdown shows an "n/N"
// counter against these until they get there.
//
// Both are now a literal count of matches played, so both counters tick exactly
// once per match. counterMatchup's used to be a shot count expressed as a
// match-equivalent, which meant it could move by 0 or 2 in a week and needed a
// caveat to read correctly — see CHANNEL_MATURITY_FULL_MATCHES in config.js.
const MATURITY_THRESHOLDS = {
  teamForm:       FORM_WINDOW_GWS,
  counterMatchup: CHANNEL_MATURITY_FULL_MATCHES,
};

// Plain-English meaning of each breakdown metric, for the "i" popup beside its
// row. Says what the number describes about an actual match, and names the
// input it is read off — enough for a reader meeting the row for the first
// time to know what they are looking at, without restating the arithmetic.
//
// Every count in the copy is interpolated from config rather than written out:
// the two ramping metrics quote MATURITY_THRESHOLDS (which is why this is
// declared after it) and H2H quotes H2H_MEETING_WINDOW. Those numbers have
// been retuned before, and a sentence that repeats one by hand is a sentence
// that will eventually contradict the n/N counter on its own row.
const METRIC_MEANINGS = {
  baseDifficulty:
    "How strong this opponent is as a side, the way you'd size them up from "
    + 'the league table before kick-off. Fetched by FPL base difficulty value, '
    + 'used as a baseline.',
  counterMatchup:
    'Whether the way this team prefers to attack is the same way this '
    + 'particular opponent tends to concede, and vice-versa. Calculations '
    + 'shown with below attacking/defending counters, requires minimum '
    + `${MATURITY_THRESHOLDS.counterMatchup} games to reach full maturity.`,
  teamForm:
    'How well the team has actually been playing in its recent matches '
    + 'relative to the strength of the sides faced (e.g. W/A strong sides & '
    + 'L/A weak sides count more than W/A weak sides & L/A strong sides). '
    + `Requires minimum ${MATURITY_THRESHOLDS.teamForm} games to reach full `
    + 'maturity.',
  history:
    'Head to head history. Calculated by the percentage of the total possible '
    + `points won over the last ${H2H_MEETING_WINDOW} meetings.`,
  // One text for both venues: the sentence describes the DIFFERENCE between
  // the two sides' home/away records, which reads the same way from either
  // card. The popup's title still says "Home Advantage" or "Away
  // Disadvantage", so which side is being described stays clear.
  homeAway:
    "The home/away split difference compared with the opposite team's. This "
    + "metric is low weight as it's not a defining factor unless a matchup is "
    + 'relatively close.',
};

// Attacking pairing labels. Covers both the role-mode keys (stVsCb/wmVsFb/
// cmVsCbDm — Phase 3C, active whenever ICT data is available) and the
// element-fallback keys (fwdVsCb/wideMidVsFb/camVsCbMid — Phase 1, active
// when it isn't). Previously only the fallback keys were mapped, so the
// role-mode pairings (the common case) silently rendered raw camelCase keys.
const PAIRING_LABELS = {
  stVsCb:      'ST vs CB',
  wmVsFb:      'Wingers vs Fullbacks',
  cmVsCbDm:    'CAM vs CDM',
  fwdVsCb:     'FWD vs CB',
  wideMidVsFb: 'Wide MID vs FB',
  camVsCbMid:  'CAM vs CB+DM',
  // Channel tier (engine/channel.js). These are threat-profile axes rather
  // than position pairings, so they read as phases of play, not matchups.
  setPieceThreat: 'Set Pieces',
  wideTransition: 'Transition Speed',
  boxThreat:      'Box Occupation',
};

// Defending mirror of PAIRING_LABELS — same units, defender-first phrasing.
// Keys must match MIRRORED_PAIRING_KEYS in engine/counter.js.
/**
 * The PHASE OF PLAY each channel axis describes, as a noun phrase that reads
 * naturally mid-sentence in the "i" panel's explanation.
 *
 * Keyed by both the attacking and the defending key for the same axis, mapping
 * to the SAME phrase: a set piece is a set piece whichever end you read it
 * from. Using the row's own label instead produced "of the xG this team
 * concedes comes through set-piece defence", which is circular — the phase is
 * set pieces, "defence" is the perspective, and the sentence already supplies
 * the perspective.
 */
const CHANNEL_PHASE_NOUN = {
  setPieceThreat:    'set pieces',
  wideTransition:    'fast transitions',
  boxThreat:         'chances inside the box',
  setPieceDefence:   'set pieces',
  transitionDefence: 'fast transitions',
  boxDefence:        'chances inside the box',
};

const DEFENDING_PAIRING_LABELS = {
  cbVsSt:      'CB vs ST',
  fbVsWm:      'Fullbacks vs Wingers',
  cbDmVsCm:    'CDM vs CAM',
  cbVsFwd:     'CB vs FWD',
  fbVsWideMid: 'FB vs Wide MID',
  cbMidVsCam:  'CB+DM vs CAM',
  setPieceDefence:   'Set-Piece Defence',
  transitionDefence: 'Transition Defence',
  boxDefence:        'Box Defence',
};


// Short phase name for each counter row's header ("Set pieces", "Transition"),
// keyed by the ATTACKING pairing key. A key with no entry (the retired
// position tier) falls back to its full PAIRING_LABELS name.
const PAIRING_SHORT = {
  setPieceThreat: 'Set pieces',
  wideTransition: 'Transition',
  boxThreat:      'Box',
};

const BAND_LABEL = {
  excellent: 'Excellent', great: 'Great', good: 'Good', neutral: 'Neutral',
  tough: 'Tough', brutal: 'Brutal', extreme: 'Extreme',
};

/**
 * Band ranges for the score popover, written from BANDS_V2 rather than out by
 * hand — the thresholds have been retuned before (CONVENTIONS.md §5.2).
 */
function bandRangesText() {
  const order = ['excellent', 'great', 'good', 'neutral', 'tough', 'brutal', 'extreme'];
  return order.map((b, i) => {
    const lo = BANDS_V2[b];
    if (i === 0) return `${BAND_LABEL[b]} ${lo}+`;
    const hi = BANDS_V2[order[i - 1]] - 1;
    return `${BAND_LABEL[b]} ${lo}–${hi}`;
  }).join(', ');
}

// Fixed copy for the "i" popovers that aren't a score factor or a counter
// (those carry the app's own METRIC_MEANINGS / pairing explainers instead).
const INFO_COPY = {
  score: {
    kicker: 'Headline',
    title: 'Gaffer IQ Score',
    body: () => 'One 0–100 score per side: higher is a better fixture for that side’s FPL '
      + `assets. Always shown with its band — ${bandRangesText()}. A dashed outline `
      + 'marks a low-confidence score.',
  },
  fdr: {
    kicker: 'Benchmark',
    title: 'FPL Fixture Difficulty',
    body: () => 'The official FPL rating, 1 (easiest) to 5 (hardest). Shown as the benchmark '
      + 'the Gaffer IQ score replaces — it feeds the score as Base FPL Difficulty.',
  },
  conf: {
    kicker: 'Certainty',
    title: 'Confidence',
    body: () => 'How much data sits behind this score. It is not a win probability — the '
      + 'model isn’t calibrated yet, so treat it as a data-coverage read.',
  },
  outlook: {
    kicker: 'Horizon',
    title: 'Next 10 GWs Outlook',
    body: () => 'The side’s Gaffer IQ score for each of its next ten gameweeks, with the '
      + 'app’s own summary score and band. Hover or focus a chip for opponent and '
      + 'gameweek; select one to open that fixture. ∅ is a blank gameweek, a pair of '
      + 'chips a double.',
  },
  donut: {
    kicker: 'How to read',
    title: 'Counter donuts',
    body: () => 'Each ring is one attack/defence pair, and every pair splits 100. The green '
      + 'arc is the attacking side’s share — it always starts at 12 o’clock and runs '
      + 'anticlockwise, on the attack side of the ring. The red arc is the defending '
      + 'side’s share, on the defence side. Whichever share is larger is drawn thicker. '
      + 'Green and red mean attack and defence here, not good and bad. The centre tag '
      + 'names the larger share.',
  },
};

// ─── Module-level state ───────────────────────────────────────────────────────

let _root = null;       // [data-module="matchup"]
let _el = {};           // the .mx containers: cmd, top, tape, main, drawer, scrim, pop, tip
let _selectedFixtureId = null;
let _leadTeamId = null; // which side leads the counters and outlook (the design's "team")
let _navGroups = [];    // [{ gw, fixtures }] the fixture drawer pages through
let _navIndex  = 0;     // index into _navGroups the fixture drawer is showing
let _teams     = [];    // all teams, alphabetical by name
let _descending = false; // off-season fallback: recent played fixtures, latest first
let _drawer = null;     // null | 'fx' | 'team'
let _lastDrawer = null;
let _drawerTeamId = null; // team drawer: null = the team list, else that team's season
let _pendingRender = false;     // data changed while off screen — render on activation
let _hasRendered = false;       // the first real render plays the full load sequence
let _prev = {};                 // data-key → data-sig from the last render (what re-animates)
const _info = new Map();        // "i" id → popover content, rebuilt every render
let _popBtn = null;             // the "i" whose popover is open
let _timers = [];

const RM = window.matchMedia('(prefers-reduced-motion: reduce)');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Is every input to `team`'s score for this fixture in yet?
 *
 * A CompositeScore blends counter-matchup, which cannot be computed until BOTH
 * teams' Understat payloads have landed in the boot-time prefetch — so a score
 * shown before then is provisional and will rewrite itself when they do. This
 * is the test behind every skeleton on this page: both sides of the fixture,
 * not just the card's own team, because the metric reads the pairing.
 *
 * @param {Fixture} fixture
 * @returns {boolean}
 */
function fixtureScoreSettled(fixture) {
  if (!fixture) return false;
  return store.isTeamScoreSettled(fixture.homeTeamId)
      && store.isTeamScoreSettled(fixture.awayTeamId);
}

/**
 * Is one scoreOverHorizon perGw entry's score final?
 *
 * The entry names its opponent only by short name, so the fixture behind it is
 * re-derived through findFixtureId — the same resolution the strip already
 * does to make its cells clickable. An entry whose fixture cannot be resolved
 * is treated as settled: there is no team pair to wait on, so a skeleton there
 * would never clear.
 *
 * @param {Team} team   the team the strip belongs to
 * @param {object} entry  one perGw entry
 * @returns {boolean}
 */
function perGwEntrySettled(team, entry) {
  const fixtureId = findFixtureId(team, entry);
  if (fixtureId === null) return true;
  return fixtureScoreSettled(store.getFixture(fixtureId));
}

/** Safe HTML escape for any dynamic string injected via innerHTML. */
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Build a fresh score context from the current store state.
 * Passes all cached player summaries so calcPlayerForm uses real per-GW data
 * for any player whose element-summary has been lazily loaded.
 */
function buildCtx() {
  const season = store.getSeason();
  if (!season) return null;
  return buildScoreContext(season, {
    playerSummariesById: store.getAllPlayerSummaries(),
    leagueXg: store.getLeagueXg(),
    leagueXgPrev: store.getLeagueXgPrev(),
    leagueXgHistory: store.getLeagueXgHistory(),
    teamXgBySlug: store.getAllTeamXg(),
    currentGw: store.getUpcomingGw() ?? store.getCurrentGw() ?? 1,
  });
}

/** Upcoming (unplayed) fixtures with a real GW assigned, sorted by GW then kickoff. */
function getUpcomingFixtures() {
  return store.getFixtures().filter(f => !f.played && f.gw !== null);
}

/**
 * Off-season fallback: the most recent `limit` played fixtures, GW descending.
 * Used when no upcoming fixtures exist (e.g. between seasons).
 */
function getRecentPlayedFixtures(limit = 20) {
  return store.getFixtures()
    .filter(f => f.played && f.gw !== null)
    .sort((a, b) => b.gw - a.gw || (b.kickoff || '').localeCompare(a.kickoff || ''))
    .slice(0, limit);
}

/**
 * Group a fixture array by GW.
 * @param {Fixture[]} fixtures
 * @param {{ descending?: boolean }} [opts]  descending=true for off-season played list
 * @returns {{ gw: number, fixtures: Fixture[] }[]}
 */
function groupByGw(fixtures, { descending = false } = {}) {
  const map = new Map();
  for (const f of fixtures) {
    const list = map.get(f.gw) ?? [];
    list.push(f);
    map.set(f.gw, list);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => descending ? b - a : a - b)
    .map(([gw, fixturesInGw]) => ({ gw, fixtures: fixturesInGw }));
}

/**
 * Do two gameweeks sit on opposite sides of the chip reset?
 *
 * Asked of ADJACENT ROWS rather than looked up per gameweek, which is what
 * makes it hold for a team with no fixture in GW19 or GW20: the hairline lands
 * between whichever two weeks actually straddle the boundary. It is also
 * direction-agnostic, so it works just as well on the off-season list, which
 * runs latest-first.
 *
 * @param {number} a  the previous row's gameweek
 * @param {number} b  this row's gameweek
 */
function crossesChipReset(a, b) {
  return (a <= CHIP_RESET_AFTER_GW) !== (b <= CHIP_RESET_AFTER_GW);
}

/**
 * Resolve the real fixture id behind one scoreOverHorizon perGw entry, so the
 * strip cell can be clicked through to the full Matchup Analyser breakdown.
 * scoreOverHorizon (engine/composite.js) doesn't carry a fixture id on perGw
 * entries — only gw/opponent shortName/venue — so it's re-derived here from
 * the store rather than touching the engine. Matches on gw + venue + opponent
 * shortName, which is sufficient to disambiguate DGW's two same-gw fixtures
 * (a team can't face the same opponent twice in one gw).
 * @param {Team} team
 * @param {object} entry  one non-blank perGw entry
 * @returns {number|null}
 */
function findFixtureId(team, entry) {
  if (entry.isBlank || !entry.opponent) return null;
  const isHome = entry.venue === 'H';
  const match = store.getFixtures().find(f => {
    if (f.gw !== entry.gw) return false;
    const teamId = isHome ? f.homeTeamId : f.awayTeamId;
    const oppId  = isHome ? f.awayTeamId : f.homeTeamId;
    if (teamId !== team.id) return false;
    return store.getTeam(oppId)?.shortName === entry.opponent;
  });
  return match ? match.id : null;
}

// ─── Copy: tooltips and explainers (unchanged wording) ────────────────────────

/**
 * Tooltip for the Counter-Matchup breakdown row. Explains the attack/defence
 * blend and, while the channel profiles are still filling in, why the row is
 * carrying less than its configured 20%.
 *
 * @param {object} m  breakdown.counterMatchup
 * @returns {string}  plain text, escaped by the caller
 */
function counterMatchupTooltip(m) {
  if (typeof m.value !== 'number') {
    return 'No Understat shot data published for these teams yet, so this metric '
         + 'is not scoring and contributes nothing to the total. The rows below '
         + 'will fill in once matches have been played.';
  }
  const blend = `Blend of Attacking Counters (${Math.round(m.attackingValue)} — this team's `
    + `attack vs the opponent's defence) and Defending Counters (${Math.round(m.defendingValue)} `
    + `— this team's defence vs the opponent's attack). See the sections below for the `
    + `pairing-level detail.`;
  const maturity = m.maturity ?? 1;
  if (maturity >= 1) return blend;
  return `${blend} Built on ${Math.round(maturity * 100)}% of a full season's shot data, `
    + `so it currently carries ${Math.round((m.effectiveWeight ?? m.weight) * 100)}% of the `
    + `score rather than its full ${Math.round(m.weight * 100)}%.`;
}

/**
 * Progress toward a ramping metric's full weight, or null when there is none to
 * show — either the metric doesn't ramp, or it has already arrived.
 *
 * Derived from `maturity` rather than from a raw game count, so the counter and
 * the weight the engine actually applied can never disagree: both read the same
 * number.
 *
 * Both ramps now count matches, so `maturity * total` lands on a whole number
 * and the rounding is exact rather than approximate. It is kept as `round`
 * rather than `floor` because floating-point division leaves values like
 * 0.8 * 5 = 4.000000000000001 and 3/5 * 5 = 2.9999999999999996 — floor turns
 * the second into 2. The clamp to `total - 1` guards the top: a metric at 96%
 * must not round up to "10/10" and claim a completeness it has not reached.
 * That display is unreachable anyway, since `maturity >= 1` hides the counter.
 *
 * @param {string} key
 * @param {object} m  the breakdown entry
 * @returns {{done: number, total: number}|null}
 */
function maturityProgress(key, m) {
  const total = MATURITY_THRESHOLDS[key];
  if (!total) return null;

  // A metric with no maturity field is binary and already at full weight
  // (metricMaturity, engine/composite.js) — nothing to count toward.
  const maturity = typeof m.maturity === 'number' ? clamp(0, 1, m.maturity) : 1;
  if (maturity >= 1) return null;

  return { done: Math.min(total - 1, Math.round(maturity * total)), total };
}

/** Tooltip for the maturity counter, in the unit that metric actually ramps on. */
function maturityTooltip(key, m, progress) {
  const applied = Math.round((m.effectiveWeight ?? m.weight) * 100);
  const full    = Math.round(m.weight * 100);
  const tail = `Carrying ${applied}% of the score so far rather than its full ${full}%; `
    + `the ${full}% on the right is what it builds to, not what it is applying now.`;

  return key === 'teamForm'
    ? `${progress.done} of the ${progress.total} matches this metric reads once the season is `
      + `under way. ${tail}`
    : `${progress.done} of the ${progress.total} matches this metric needs for full confidence. `
      + `It reads BOTH teams, so this counts whichever side has played fewer — a team several `
      + `matches in still waits on a newly promoted opponent. ${tail}`;
}

/**
 * Tooltip for the Home Advantage / Away Disadvantage breakdown row. Names the
 * actual PPG split behind the number, since the displayed value is now a
 * fixture-level modifier (both teams' venue sensitivity combined) rather than
 * a standalone read of this team alone — see engine/fixtures.js
 * calcVenueStrengthModifier.
 *
 * @param {object} m       breakdown.homeAway
 * @param {'Home'|'Away'} venue
 * @returns {string}       plain text; the caller escapes it.
 */
function homeAwayTooltip(m, venue) {
  if (m.estimated) {
    return 'Not enough games at one or both venues this season for either team '
      + 'to read a reliable home/away split, so this sits at a neutral 50 and '
      + 'does not affect the score.';
  }
  const own = venue === 'Home'
    ? `This team: ${m.homePPG.toFixed(2)} PPG at home vs ${m.awayPPG.toFixed(2)} PPG away.`
    : `This team: ${m.awayPPG.toFixed(2)} PPG away vs ${m.homePPG.toFixed(2)} PPG at home.`;
  return `${own} Combined with the opponent's own split, whichever team shows the bigger `
    + `home/away gap swings this row — home always gets a boost, away always a matching `
    + `penalty, sized by how much venue has mattered for these two teams this season.`;
}

// Plain-English name for each style rule, keyed by the rule's two axes. Kept
// beside the renderer rather than in config.js for the same reason
// PAIRING_LABELS lives here: config holds the model, the module holds the
// wording. A rule with no entry falls back to its raw axis names, so adding a
// STYLE_RULE without touching this map degrades to something readable rather
// than rendering "undefined".
const STYLE_RULE_LABELS = {
  'pressIntensity|buildUpControl':          'press vs their build-up',
  'transitionDirectness|pressIntensity':    'directness vs their press height',
  'territorialThreat|defensiveCompactness': 'territory vs their compactness',
};

// styleClash was removed from WEIGHTS (see config.js), so this tooltip has no
// row to attach to. Kept commented rather than deleted: restoring the metric
// means uncommenting this, its METRIC_LABELS entry and the branch in
// buildBreakdownRows.
// /**
//  * Tooltip for the Style Clash breakdown row. Names the rules that actually
//  * moved the number and in which direction, so a user can tell a genuine
//  * stylistic edge from a rounding artefact.
//  *
//  * @param {object} m  breakdown.styleClash
//  * @returns {string}  plain text; the caller escapes it.
//  */
// function styleClashTooltip(m) {
//   if (m.estimated) {
//     return 'Not enough style data for both teams — Understat pressing and '
//       + 'territory numbers are needed for this metric, so it sits at a neutral '
//       + '50 and does not affect the score.';
//   }
//
//   // Biggest movers first; anything under half a point is noise, not a story.
//   const movers = (m.terms || [])
//     .filter(t => Math.abs(t.contribution) >= 0.5)
//     .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
//     .map(t => {
//       const label = STYLE_RULE_LABELS[`${t.axisA}|${t.axisB}`] || `${t.axisA} vs ${t.axisB}`;
//       return `${t.contribution > 0 ? '+' : '−'} ${label}`;
//     });
//
//   const head = 'How these two teams play against each other, scored so the '
//     + 'home and away numbers always total 100.';
//   return movers.length
//     ? `${head} Main factors for this team: ${movers.join(', ')}.`
//     : `${head} No strong stylistic pull either way in this fixture.`;
// }

/**
 * Plain-language explanation of one counter pairing: what the score is, what
 * each of the two percentages measures, and how far into the season the read
 * is. Rendered at the top of the "i" panel, above the named players.
 *
 * WHY THIS EXISTS: the panel used to open straight onto the player list, so
 * the "i" answered "who is involved" but never "what am I looking at" — the
 * score and the two percentages beside it were undocumented anywhere in the
 * UI, which made them read as arbitrary.
 *
 * DELIBERATELY DESCRIPTIVE, NOT DIRECTIONAL. This says what each percentage
 * MEASURES and leaves it there; it does not tell the reader which way a high
 * score should be read. That is not an oversight. `calcChannelCounter` scores
 * an axis as `attackShare - concedeShare`, which rises as the opponent
 * concedes LESS through a channel — the reverse of the "my strength meets
 * their weakness" reading the model comment describes. Until that is settled,
 * an explanation asserting a direction would be documenting behaviour the
 * engine does not have. The two shares themselves are exactly what they say,
 * so those are safe to explain in full.
 *
 * @param {object} p            the pairing (channel tier: attackShare/concedeShare)
 * @param {string} key          pairing key, for CHANNEL_PHASE_NOUN
 * @param {'attacking'|'defending'} perspective
 * @param {boolean} isChannel   channel tier (shares) vs retired position tier
 * @param {boolean} hasValue    false when Understat has not published yet
 */
function buildPairingExplainer(p, key, perspective, isChannel, hasValue) {
  if (!hasValue) {
    return `<p class="counter-pairing-info__note">`
         + `No Understat data for this axis yet — the row fills in once the`
         + ` season's shot data covers it. It contributes nothing to the score`
         + ` until then.</p>`;
  }
  if (!isChannel) return '';   // retired position tier — no shares to explain

  // Whose share is whose depends on which section the row sits in: an
  // Attacking Counters row is this team attacking, a Defending Counters row is
  // this team defending against the opponent's attack.
  const atkPct = `${Math.round(p.attackShare * 100)}%`;
  const defPct = `${Math.round(p.concedeShare * 100)}%`;
  const phase  = esc(CHANNEL_PHASE_NOUN[key] ?? 'this phase of play');
  const rows = perspective === 'defending'
    ? [
        [`Def ${defPct}`, `of the xG <strong>this team concedes</strong> comes from ${phase}.`],
        [`Atk ${atkPct}`, `of the xG <strong>the opponent creates</strong> comes the same way.`],
      ]
    : [
        [`Atk ${atkPct}`, `of the xG <strong>this team creates</strong> comes from ${phase}.`],
        [`Def ${defPct}`, `of the xG <strong>the opponent concedes</strong> comes the same way.`],
      ];

  const personnelNote = (typeof p.personnel === 'number' && p.personnel !== 1)
    ? `<li><span class="counter-pairing-info__term">Availability</span>`
      + `<span>The attacking share is scaled to <strong>${Math.round(p.personnel * 100)}%</strong>`
      + ` to reflect who is actually fit for this fixture.</span></li>`
    : '';

  return `
    <div class="counter-pairing-info__explain">
      <p class="counter-pairing-info__note">
        Both figures are <strong>shares of a team's own xG</strong> —
        <em>expected goals</em>, which rates every shot from 0 to 1 by how likely
        it was to be scored, whether or not it went in. Shares, not volumes:
        they describe <em>how</em> a side scores and concedes, not how much.
      </p>
      <ul class="counter-pairing-info__terms">
        ${rows.map(([term, text]) =>
          `<li><span class="counter-pairing-info__term">${term}</span><span>${text}</span></li>`).join('')}
        ${personnelNote}
      </ul>
      <p class="counter-pairing-info__note">
        The <strong>score</strong> compares those two shares against the spread
        seen across the league on this axis. It is one input to Counter-Matchup,
        which carries ${Math.round(WEIGHTS.counterMatchup * 100)}% of the fixture
        score at full maturity — see the counter beside that row for how much of
        that it has earned so far.
      </p>
    </div>`.trim();
}

/**
 * List the named players behind one pairing, as .individual-duel rows.
 *
 * These panels are now the ONLY place duels are rendered. There used to be a
 * separate "Individual Duels" disclosure at the foot of each card listing the
 * same players again, detached from the pairing that produced them; it was
 * removed because a flat top-N list says nothing the reader can act on once
 * every pairing already names its own players in context.
 *
 * Renders NOTHING when there are no duels to show — see the note at the guard
 * below. Duels are empty whenever player summaries or ICT data haven't loaded
 * (pre-season, or before the user has browsed the Ranker), which is the common
 * case and a normal condition, not an error worth announcing.
 *
 * @param {Array} duels                 calcIndividualDuels result, attacking side
 * @param {string} pairingKey
 * @param {'attacking'|'defending'} perspective  controls which side leads the row
 */
function buildPairingPlayers(duels, pairingKey, perspective) {
  const matched = duelsForPairing(duels, pairingKey);

  // Nothing at all when there are no players to name. This used to render a
  // "not loaded yet — open some players in the Ranker" line, which appeared in
  // EVERY panel (duels need lazily-fetched player summaries, so the common case
  // is empty) and read as a warning about the score. It is not one: the pairing
  // score is computed from team-level shot data and does not use duels at all.
  // A permanent notice about an optional extra was pure noise, so the section
  // is simply absent until it has something to show.
  if (matched.length === 0) return '';

  return matched.map(d => {
    const atkForm = Math.round(d.attacker.formValue);
    const defForm = Math.round(d.defender.formValue);
    // Defending sections lead with the defender, matching the score row above it.
    const first  = perspective === 'defending' ? d.defender : d.attacker;
    const second = perspective === 'defending' ? d.attacker : d.defender;
    const firstForm  = perspective === 'defending' ? defForm : atkForm;
    const secondForm = perspective === 'defending' ? atkForm : defForm;

    return `
      <div class="individual-duel">
        <span class="individual-duel__attacker">
          ${esc(first.name)}
          <span class="individual-duel__role">${esc(first.role)}</span>
          <span class="individual-duel__form">${firstForm}</span>
        </span>
        <span class="individual-duel__vs">vs</span>
        <span class="individual-duel__defender">
          ${esc(second.name)}
          <span class="individual-duel__role">${esc(second.role)}</span>
          <span class="individual-duel__form">${secondForm}</span>
        </span>
        ${chip(d.duelScore, { size: 'sm' })}
      </div>
    `.trim();
  }).join('');
}


// ─── Markup primitives ────────────────────────────────────────────────────────

/** Team crest: the FPL badge inside a ring, its short name as the fallback if the badge 404s. */
function crest(team, size = 24) {
  return `<span class="crest crest--${size}" aria-hidden="true">`
    + `<img src="${esc(team.badgeUrl)}" alt="" loading="lazy"`
    + ` onload="this.parentNode.classList.add('crest--img')" onerror="this.remove()">`
    + `<span class="crest__c">${esc(team.shortName)}</span></span>`;
}

/** The same badge as SVG, for the oversized tape backdrop where the 70px PNG would blur. */
function badgeSvg(team) {
  return String(team.badgeUrl).replace('/badges/70/', '/badges/').replace(/\.png$/, '.svg');
}

/**
 * A score chip. `pending` withholds the value (still settling) but keeps the
 * footprint; `est` is CompositeScore.provisional — a final but thin read.
 */
function chip(value, o = {}) {
  const tag = o.tag || 'span';
  const pending = Boolean(o.pending);
  const hasValue = typeof value === 'number';
  const band = pending || !hasValue ? 'none' : (o.band || bandFromValue(value));
  const cls = ['chip', o.size ? `chip--${o.size}` : '', o.cls || '',
    pending ? 'is-pending' : '', (!pending && o.est) ? 'is-est' : ''].filter(Boolean).join(' ');
  const text = pending ? '00' : (o.text ?? (hasValue ? Math.round(value) : '—'));
  const label = o.aria ?? (pending ? 'Still calculating'
    : hasValue ? `${Math.round(value)} ${BAND_LABEL[band] ?? ''}` : 'No data');
  return `<${tag} class="${cls}" data-band="${band}"${tag === 'button' ? ' type="button"' : ''}`
    + `${o.tip ? ` data-tip="${esc(o.tip)}"` : ''}${o.attrs || ''}`
    + `${label ? ` aria-label="${esc(label)}"` : ''}>${esc(String(text))}</${tag}>`;
}

/** Fixed-width digits so a count-up never reflows the tape. */
function digits(v) {
  return String(v).split('').map(c => `<span class="fd" aria-hidden="true">${esc(c)}</span>`).join('');
}

/**
 * Register a popover and return its "i" button. Content is rebuilt every
 * render, so an open popover can never describe a fixture no longer shown.
 * @param {string} id
 * @param {{kicker:string, title:string, body:string, ctx?:string, weightKey?:string}} content
 *   `body` and `ctx` are HTML (callers escape).
 * @param {string} label  accessible name tail: "About <label>"
 */
function infoButton(id, content, label) {
  _info.set(id, content);
  return `<button type="button" class="ib" data-info="${esc(id)}" aria-expanded="false"`
    + ` aria-label="About ${esc(label || content.title)}">i</button>`;
}

function sec(id, kicker, title, meta, body) {
  return `<section class="pn" id="mx-${id}" data-rv><header class="ph"><span class="lbl">${kicker}</span>`
    + `<h2 class="ph__t">${title}</h2>${meta ? `<span class="ph__m">${meta}</span>` : ''}</header>${body}</section>`;
}

// ─── Scoring (engine calls only) ──────────────────────────────────────────────

/**
 * Score the selected fixture for both teams. Exactly the engine calls the
 * page has always made — this only gathers them into one object for the
 * renderers below.
 * @returns {object|null}
 */
function computeMatch(fixture, ctx) {
  const homeTeam = store.getTeam(fixture.homeTeamId);
  const awayTeam = store.getTeam(fixture.awayTeamId);
  if (!homeTeam || !awayTeam) return null;

  const horizon = MATCHUP_OUTLOOK_HORIZON;
  const homeScore = scoreFixture(homeTeam, fixture, ctx);
  const awayScore = scoreFixture(awayTeam, fixture, ctx);

  // Per-team individual duels. Each call scores team A's attackers against
  // team B's likely defenders — asymmetric, mirrors calcCounterMatchup. Empty
  // when player summaries / ICT data aren't sufficient.
  const homeDuels = calcIndividualDuels(homeTeam, awayTeam, ctx);
  const awayDuels = calcIndividualDuels(awayTeam, homeTeam, ctx);

  // Defending counters: the SAME attack-vs-defence pairing as the other side's
  // attacking counters, re-read from the defending side (100 - value, by
  // construction — see calcCounterMatchupMirrored). Home's defence faced
  // away's attack, so home's mirror comes from awayScore's pairings.
  const homeDefending = calcCounterMatchupMirrored(awayScore.breakdown.counterMatchup);
  const awayDefending = calcCounterMatchupMirrored(homeScore.breakdown.counterMatchup);

  const side = (team, venue, score, fdr, duels, defending) => {
    const outlook = scoreOverHorizon(team, horizon, ctx);
    // The aggregate reads EVERY gameweek in the window, so it is only final
    // once every opponent across it has settled — stricter than this fixture.
    const outlookSettled = outlook.perGw.every(e => e.isBlank || perGwEntrySettled(team, e));
    return { team, venue, score, fdr, duels, defending, outlook, outlookSettled };
  };

  return {
    fixture,
    horizon,
    // One flag for both sides: the counter-matchup metric is a pairing, so the
    // two sides settle together or not at all. Everything downstream of it is
    // skeletoned until then rather than printed and quietly rewritten.
    settled: fixtureScoreSettled(fixture),
    home: side(homeTeam, 'Home', homeScore, fixture.fplDifficulty.home, homeDuels, homeDefending),
    away: side(awayTeam, 'Away', awayScore, fixture.fplDifficulty.away, awayDuels, awayDefending),
  };
}

/** Is `teamId` the side that leads the counters and outlook? */
function awayLeads(m) { return _leadTeamId === m.away.team.id; }

// ─── Render: command bar ──────────────────────────────────────────────────────

function renderCmd(m) {
  if (!m) { _el.cmd.innerHTML = ''; return; }
  const { home, away } = m;
  const lead = awayLeads(m) ? away.team : home.team;
  _el.cmd.innerHTML = `
    <button type="button" class="cbtn cbtn--fx" data-open="fx" aria-haspopup="dialog" aria-expanded="${_drawer === 'fx'}">
      <span class="lbl">Fixture</span>
      <span class="cbtn__fx">${crest(home.team, 20)}${esc(home.team.shortName)} <i>v</i> ${esc(away.team.shortName)}${crest(away.team, 20)}</span>
      <span class="cbtn__car" aria-hidden="true">▾</span>
    </button>
    <button type="button" class="cbtn" data-open="team" aria-haspopup="dialog" aria-expanded="${_drawer === 'team'}">
      <span class="lbl">Team</span>${crest(lead, 20)}${esc(lead.name)}<span class="cbtn__car" aria-hidden="true">▾</span>
    </button>
    <span class="cmd__sp"></span>
    <span class="cmd__hint"><kbd>F</kbd> fixtures <kbd>T</kbd> teams</span>`;
}

// ─── Render: "read it as" ─────────────────────────────────────────────────────

function frameHTML(m) {
  const { home, away, settled } = m;
  const sides = [home, away];
  const two = fn => `<div class="role__v">${sides.map(s =>
    `<div class="rv"><span class="rv__t">${crest(s.team, 18)}${esc(s.team.name)}</span>${fn(s)}</div>`).join('')}</div>`;
  const pips = n => `<span class="pips" aria-hidden="true">${[1, 2, 3, 4, 5].map(i =>
    `<i${i <= n ? ' class="on"' : ''}></i>`).join('')}</span>`;
  const conf = s => Math.round(s.score.confidence * 100);

  const scoreCtx = settled
    ? sides.map(s => `${esc(s.team.name)} ${Math.round(s.score.value)} — ${BAND_LABEL[bandFromValue(s.score.value)]}`
      + `${s.score.provisional ? ' (low confidence)' : ''}`).join(' · ')
    : 'Still calculating — waiting on this fixture’s counter-matchup data.';
  const fdrCtx = sides.map(s => `${esc(s.team.name)} ${s.fdr} / 5`).join(' · ');
  const confCtx = settled ? sides.map(s => `${esc(s.team.name)} ${conf(s)}%`).join(' · ') : 'Still calculating.';

  return `<section class="frame" id="mx-frame" data-rv aria-labelledby="mx-frame-t">
    <div class="frame__k"><span class="lbl">Read it as</span><h2 class="frame__t" id="mx-frame-t">Three numbers, three jobs</h2></div>
    <div class="role"><div class="role__h"><span class="lbl">Headline</span><em>Gaffer IQ score — the answer</em>${
      infoButton('frame-score', { ...copy('score'), ctx: `<p>${scoreCtx}</p>` }, 'the Gaffer IQ score')}</div>${
      two(s => {
        if (!settled) return `<span class="rv__n">${chip(null, { size: 'lg', pending: true })}<span class="bandname sk-t">Settling</span></span>`;
        const b = bandFromValue(s.score.value);
        return `<span class="rv__n">${chip(s.score.value, { size: 'lg', est: s.score.provisional })}<span class="bandname" data-band="${b}">${BAND_LABEL[b]}</span></span>`;
      })}</div>
    <div class="role"><div class="role__h"><span class="lbl">Benchmark</span><em>Official FPL FDR — what it replaces</em>${
      infoButton('frame-fdr', { ...copy('fdr'), ctx: `<p>${fdrCtx}</p>` }, 'FPL fixture difficulty')}</div>${
      two(s => (typeof s.fdr === 'number'
        ? `<span class="rv__n">${s.fdr}<small>/ 5</small>${pips(s.fdr)}</span>`
        : '<span class="rv__n"><span class="nodata">No data</span></span>'))}</div>
    <div class="role"><div class="role__h"><span class="lbl">Certainty</span><em>Confidence — data behind it</em>${
      infoButton('frame-conf', { ...copy('conf'), ctx: `<p>${confCtx}</p>` }, 'confidence')}</div>${
      two(s => (settled
        ? `<span class="rv__n">${conf(s)}%<span class="meter${s.score.provisional ? ' is-low' : ''}" aria-hidden="true"><i style="--v:${conf(s) / 100}"></i></span></span>`
        : '<span class="rv__n"><span class="sk-t">00%</span></span>'))}</div>
  </section>`;
}

/** INFO_COPY entry with its body resolved. */
function copy(key) {
  const c = INFO_COPY[key];
  return { kicker: c.kicker, title: c.title, body: esc(c.body()) };
}

// ─── Render: tape ─────────────────────────────────────────────────────────────

const PITCH = '<svg class="tape__pitch" viewBox="0 0 1440 400" preserveAspectRatio="xMidYMid slice" aria-hidden="true">'
  + '<line x1="720" y1="0" x2="720" y2="400"/><circle cx="720" cy="200" r="110"/>'
  + '<circle class="tape__spot" cx="720" cy="200" r="3"/><rect x="-1" y="60" width="150" height="280"/>'
  + '<rect x="1291" y="60" width="150" height="280"/></svg>';

function sideHTML(s, cls, k, edge, settled) {
  const v = Math.round(s.score.value);
  const b = settled ? bandFromValue(s.score.value) : 'none';
  const scoreHTML = settled
    ? `<span class="numw${s.score.provisional ? ' is-est' : ''}" style="min-width:${String(v).length * 0.54}em">`
      + `<span class="num num__o" aria-hidden="true">${digits(v)}</span>`
      + `<span class="num" data-flap="${v}" data-key="s-${k}" data-sig="${s.team.id}-${v}" aria-label="${v}">${digits(v)}</span></span>`
    : '<span class="numw"><span class="num sk-t" aria-label="Still calculating">00</span></span>';
  const slab = settled
    ? `<span class="slab" data-rv data-late><span class="bandname">${BAND_LABEL[b]}</span>${
      infoButton(`tape-${k}`, { ...copy('score'), ctx: `<p>${esc(s.team.name)} ${v} — ${BAND_LABEL[b]}${s.score.provisional ? ' (low confidence)' : ''}</p>` }, 'the Gaffer IQ score')}</span>`
    : '<span class="slab" data-rv data-late><span class="bandname sk-t">Settling</span></span>';
  return `<div class="side ${cls}" data-band="${b}"${edge ? ' data-edge' : ''} data-rv>`
    + `<span class="side__bg" aria-hidden="true" style="--bg:url('${esc(badgeSvg(s.team))}')"></span>`
    + `<div class="side__info"><div class="side__team"><h2 class="side__name">${esc(s.team.name)}</h2>`
    + `<span class="venue">${s.venue}</span></div></div>`
    + `<div class="score">${scoreHTML}${slab}</div></div>`;
}

function tapeHTML(m) {
  const { home, away, settled, fixture } = m;
  const hs = Math.round(home.score.value), as = Math.round(away.score.value);
  const eH = settled && hs > as, eA = settled && as > hs;
  const lead = eH ? home.team : eA ? away.team : null;
  let verdict;
  if (!settled) verdict = '<span class="verdict__t sk-t">Settling the verdict</span>';
  else if (lead) {
    verdict = `<span class="edge${eA ? ' edge--r' : ''}">Edge</span><span class="verdict__t">${esc(lead.name)} have the edge</span>`
      + `<span class="verdict__s">${hs} ${BAND_LABEL[bandFromValue(hs)]} against ${as} ${BAND_LABEL[bandFromValue(as)]}</span>`;
  } else verdict = '<span class="verdict__t">Level</span>';
  return PITCH + sideHTML(home, 'side--h', 'h', eH, settled)
    + `<div class="axis"><span class="lbl">GW${esc(String(fixture.gw ?? '—'))}</span><span class="v">v</span></div>`
    + sideHTML(away, 'side--a', 'a', eA, settled)
    + `<p class="verdict" data-rv data-late>${verdict}</p>`;
}

// ─── Render: breakdown (Why) ──────────────────────────────────────────────────

function bar(v, rtl, i, key, est) {
  const z = v === 0;
  return `<div class="bar${rtl ? ' bar--rtl' : ''}${z ? ' bar--zero' : ''}${est ? ' is-est' : ''}"`
    + ` data-key="${key}" data-sig="${v}" style="--d:${i * 55}ms"${z ? ' title="Computed zero"' : ''}>`
    + `<i style="--v:${v / 100}"></i></div>`;
}

/**
 * One side's cell pair for a breakdown row: the value and the bar.
 * baseDifficulty is STORED as the opponent's strength (higher = harder), so it
 * is banded on invert(value) — colour then means the same on every row:
 * green = good for this team. The displayed number is untouched.
 */
function metricCells(key, mm, pending, side, i) {
  const hasValue = !pending && typeof mm.value === 'number';
  const val = hasValue ? Math.round(mm.value) : null;
  const band = !hasValue ? 'none' : key === 'baseDifficulty' ? bandFromValue(invert(mm.value)) : bandFromValue(val);
  const est = !pending && mm.estimated;
  const progress = pending ? null : maturityProgress(key, mm);
  const small = progress
    ? `<small title="${esc(maturityTooltip(key, mm, progress))}">${progress.done}/${progress.total}</small>` : '';
  const a = side === 'a';
  const valueCls = `mir__v${a ? ' mir__v--a' : ''}${est ? ' is-est' : ''}`;
  const value = pending
    ? `<span class="${valueCls}" aria-busy="true"><span class="sk-t">00</span></span>`
    : `<span class="${valueCls}" data-band="${band}">${hasValue ? val : '<span class="nodata">No data</span>'}${small}</span>`;
  const barCell = pending
    ? `<div class="mir__${a ? 'ab' : 'hb'}"><span class="sk" style="height:10px"></span></div>`
    : `<div class="mir__${a ? 'ab' : 'hb'}" data-band="${band}">${hasValue ? bar(val, !a, i, `b-${key}-${side}`, est) : ''}</div>`;
  return { value, barCell };
}

function breakdownHTML(m) {
  const { home, away, settled } = m;
  const rows = METRIC_ORDER.map((key, i) => {
    const hm = home.score.breakdown[key];
    const am = away.score.breakdown[key];
    const pending = !settled && key === 'counterMatchup';
    const h = metricCells(key, hm, pending, 'h', i);
    const a = metricCells(key, am, pending, 'a', i);
    const name = key === 'homeAway' ? 'Home / Away' : METRIC_LABELS[key];
    const fmt = mm => (pending ? 'settling' : typeof mm.value === 'number' ? Math.round(mm.value) : 'no data');

    // Context lines: this fixture's two readings plus the per-side notes the
    // old card carried as hover titles — nothing dropped, just moved here.
    const ctx = [`<p><b>${esc(home.team.name)}</b> ${fmt(hm)} · <b>${esc(away.team.name)}</b> ${fmt(am)}</p>`];
    if (key === 'baseDifficulty') {
      ctx.push('<p>Shows the OPPONENT’s strength — a high number means a tougher opponent for this '
        + 'team. The bar colour reflects how good this fixture is for this team, same as every other row.</p>');
    }
    if (key === 'counterMatchup' && !pending) {
      ctx.push(`<p><b>${esc(home.team.name)}:</b> ${esc(counterMatchupTooltip(hm))}</p>`,
        `<p><b>${esc(away.team.name)}:</b> ${esc(counterMatchupTooltip(am))}</p>`);
    }
    if (key === 'homeAway') {
      ctx.push(`<p><b>${esc(home.team.name)} — Home Advantage:</b> ${esc(homeAwayTooltip(hm, 'Home'))}</p>`,
        `<p><b>${esc(away.team.name)} — Away Disadvantage:</b> ${esc(homeAwayTooltip(am, 'Away'))}</p>`);
    }
    for (const [s, mm] of [[home, hm], [away, am]]) {
      const pr = pending ? null : maturityProgress(key, mm);
      if (pr) ctx.push(`<p><b>${esc(s.team.name)} ${pr.done}/${pr.total}:</b> ${esc(maturityTooltip(key, mm, pr))}</p>`);
    }
    const title = key === 'homeAway' ? 'Home Advantage / Away Disadvantage' : METRIC_LABELS[key];
    const pct = Math.round(hm.weight * 100);
    const ib = infoButton(`m-${key}`, {
      kicker: `Score factor · ${pct}%`, title, body: esc(METRIC_MEANINGS[key] ?? ''),
      ctx: ctx.join(''), weightKey: key,
    }, title);

    return `<div class="mir__r"${pending ? ' aria-busy="true"' : ''}>${h.value}${h.barCell}`
      + `<div class="mir__c"><span class="mir__n">${esc(name)}</span><span class="wt">${pct}%</span>`
      + `${key === 'baseDifficulty' ? '<span class="dir">higher = harder</span>' : ''}${ib}</div>`
      + `${a.barCell}${a.value}</div>`;
  }).join('');

  return sec('why', 'Why', 'Score breakdown',
    `<span class="side-key"><b>‹ ${esc(home.team.name)}</b> · bars grow out from the halfway line · <b>${esc(away.team.name)} ›</b></span>`,
    `<div class="mir">${rows}</div>`
    + '<div class="legend">'
    + '<span><span class="bar bar--zero is-on" data-band="brutal"><i style="--v:0"></i></span><b>0</b> computed zero — empty bar, origin marked</span>'
    + '<span><span class="nodata">No data</span> factor couldn’t be computed — no bar drawn</span>'
    + '<span><span class="bar is-est is-on" data-band="neutral"><i style="--v:.6"></i></span>dashed = estimated (fallback input)</span>'
    + '<span>Base FPL Difficulty runs the other way: its bar is coloured by how easy that makes the fixture.</span>'
    + '</div>');
}

// ─── Render: counters (Detail) ────────────────────────────────────────────────

const R = 46, C = 2 * Math.PI * R, GP = 3.4;

/**
 * One attack/defence donut. a + d = 100 by construction (the defending value
 * is the mirror of the attacking one). `state` 'pending' draws an empty ring
 * while the pairing settles; 'missing' a dashed ring with `tag` in the centre.
 */
function ring(a, d, label, state = 'live', tag = 'NO DATA') {
  let s = `<svg class="dn__ring" viewBox="0 0 120 120" role="img" aria-label="${esc(label)}">`;
  if (state === 'pending') return `${s}<circle cx="60" cy="60" r="${R}" class="dn__pend"/></svg>`;
  if (state === 'missing') {
    return `${s}<circle cx="60" cy="60" r="${R}" class="dn__miss"/><text x="60" y="64" class="dn__tag dn__tag--m">${esc(tag)}</text></svg>`;
  }
  const both = a > 0 && d > 0, A = a / 100 * C, h = both ? GP / 2 : 0;
  const al = Math.max(0, A - 2 * h), dl = Math.max(0, C - A - 2 * h);
  const ar = -90 + h / C * 360, dr = -90 + (A + h) / C * 360;
  const lead = a > d ? 'ATK' : d > a ? 'DEF' : 'EVEN';
  const wa = a > d ? ' dn__arc--big' : a === d ? ' dn__arc--even' : '';
  const wd = d > a ? ' dn__arc--big' : a === d ? ' dn__arc--even' : '';
  s += '<g transform="matrix(-1 0 0 1 120 0)">';
  if (a > 0) s += `<circle cx="60" cy="60" r="${R}" class="dn__arc dn__arc--a${wa}" transform="rotate(${ar.toFixed(2)} 60 60)" style="stroke-dasharray:${al.toFixed(2)} ${C.toFixed(2)};--len:${al.toFixed(2)}"/>`;
  if (d > 0) s += `<circle cx="60" cy="60" r="${R}" class="dn__arc dn__arc--d${wd}" transform="rotate(${dr.toFixed(2)} 60 60)" style="stroke-dasharray:${dl.toFixed(2)} ${C.toFixed(2)};--len:${dl.toFixed(2)}"/>`;
  s += '</g>';
  if (a === 0) s += `<line x1="60" y1="${60 - R - 10}" x2="60" y2="${60 - R + 10}" class="dn__zero"/>`;
  return `${s}<text x="60" y="66" class="dn__tag">${lead}</text></svg>`;
}

function donutKey() {
  const mini = (a, d, label, state) => `<span class="dmini is-on">${ring(a, d, label, state)}</span>`;
  return '<div class="dkey" role="note" aria-label="Donut key">'
    + '<span><svg class="dkey__sw" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 4a12 12 0 0 0 -12 12" class="dkey__a"/></svg><span><b>Green</b> = attack share</span></span>'
    + '<span><svg class="dkey__sw" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 4a12 12 0 0 1 12 12" class="dkey__d"/></svg><span><b>Red</b> = defence share</span></span>'
    + '<span class="dkey__no">Not good/bad</span><span>Thicker arc = larger share</span>'
    + `<span class="dkey__ex">${mini(0, 100, 'Example: real zero — full red ring, tick at 12 o’clock')}Real 0 — full red, tick at 12</span>`
    + `<span class="dkey__ex">${mini(null, null, 'Example: no data — dashed ring', 'missing')}No data — dashed ring</span></div>`;
}

/** "Atk 24% / Def 32%" — the two inputs as the old card's detail line showed them. */
function pairingIO(p, perspective) {
  const isChannel = p.attackShare !== undefined;
  const asPct = v => (typeof v === 'number' ? `${Math.round(v * 100)}%` : '—');
  const asScore = v => (typeof v === 'number' ? String(Math.round(v)) : '—');
  const atk = isChannel ? asPct(p.attackShare) : asScore(p.attackForm);
  const def = isChannel ? asPct(p.concedeShare) : asScore(p.defenceForm);
  return perspective === 'defending' ? `Def ${def} / Atk ${atk}` : `Atk ${atk} / Def ${def}`;
}

/** One donut row: A's attack on `key` against D's mirrored defence `dKey`. */
function donutRow(A, D, key, p, dKey, dp, i, settled) {
  const hasValue = typeof p.value === 'number';
  const usable = hasValue && !p.estimated;
  const a = usable ? Math.round(p.value) : null;
  const d = usable ? 100 - a : null;
  const aLabel = PAIRING_LABELS[key] ?? key;
  const dLabel = DEFENDING_PAIRING_LABELS[dKey] ?? dKey;
  const head = PAIRING_SHORT[key] ?? aLabel;
  const shown = v => (!settled ? 'settling' : !hasValue ? '—' : p.estimated ? 'N/A' : v);
  const state = !settled ? 'pending' : usable ? 'live' : 'missing';
  const label = !settled ? `${head}: still calculating`
    : !usable ? `${head}: no data for ${A.team.name} attack against ${D.team.name} defence`
    : `${head} split of 100: ${A.team.name} attack ${a}, ${D.team.name} defence ${d}.${a === d ? '' : ` Larger share: ${a > d ? 'attack' : 'defence'}.`}`;
  const isChannel = p.attackShare !== undefined;
  const ctx = `<p><b>${esc(A.team.name)}</b> ${esc(aLabel)} ${shown(a)} · <b>${esc(D.team.name)}</b> ${esc(dLabel)} ${shown(d)}</p>`;
  const ibA = infoButton(`c-${A.team.id}-${key}`, {
    kicker: 'Attacking counter', title: aLabel, ctx,
    body: buildPairingExplainer(p, key, 'attacking', isChannel, hasValue) + buildPairingPlayers(A.duels, key, 'attacking'),
  }, aLabel);
  const ibD = infoButton(`c-${D.team.id}-${dKey}`, {
    kicker: 'Defending counter', title: dLabel, ctx,
    body: buildPairingExplainer(dp, dKey, 'defending', isChannel, typeof dp.value === 'number')
      + buildPairingPlayers(A.duels, dKey, 'defending'),
  }, dLabel);
  const val = v => (settled
    ? `<b class="dn__v" aria-hidden="true">${shown(v)}</b>`
    : '<b class="dn__v sk-t" aria-hidden="true">00</b>');
  return `<div class="dn" data-key="d-${A.team.id}-${key}" data-sig="${settled ? `${a}/${d}` : 'p'}" style="--d:${i * 60}ms"${settled ? '' : ' aria-busy="true"'}>`
    + `<div class="dn__h"><span>${esc(head)}</span>${ibA}</div>`
    + `<div class="dn__s dn__s--a${usable && a > d ? ' is-big' : ''}"><span class="dn__r">Atk · ${esc(A.team.shortName)}</span>${val(a)}`
    + `<span class="dn__m">${esc(aLabel)}</span><span class="dn__io">${settled ? esc(pairingIO(p, 'attacking')) : '<span class="sk-t">Atk 00% / Def 00%</span>'}</span></div>`
    + ring(a, d, label, state, hasValue && p.estimated ? 'N/A' : 'NO DATA')
    + `<div class="dn__s dn__s--d${usable && d > a ? ' is-big' : ''}"><span class="dn__r">Def · ${esc(D.team.shortName)}</span>${val(d)}`
    + `<span class="dn__m">${ibD}${esc(dLabel)}</span><span class="dn__io">${settled ? esc(pairingIO(dp, 'defending')) : '<span class="sk-t">Def 00% / Atk 00%</span>'}</span></div></div>`;
}

/** A's attack v D's defence: A's attacking pairings zipped with D's mirrored ones. */
function counterBlock(A, D, i0, settled) {
  const atk = Object.entries(A.score.breakdown.counterMatchup.pairings ?? {});
  const def = Object.entries(D.defending.pairings ?? {});
  return `<div><h3 class="ctr__h">${crest(A.team, 24)}${esc(A.team.name)} attack <i>v</i> ${esc(D.team.name)} defence${crest(D.team, 24)}</h3>`
    + atk.map(([key, p], i) => {
      const [dKey, dp] = def[i] ?? [`${key}Mirrored`, { ...p, value: null }];
      return donutRow(A, D, key, p, dKey, dp, i0 + i, settled);
    }).join('') + '</div>';
}

function countersHTML(m) {
  const { home, away, settled } = m;
  const any = Object.keys(home.score.breakdown.counterMatchup.pairings ?? {}).length > 0;
  const body = !any
    ? '<div class="state"><h3 class="state__t">No counters for this fixture</h3><p>Counter-matchups need shot data for both sides, and there isn’t enough logged yet. Nothing is drawn rather than a guess.</p></div>'
    : donutKey() + '<div class="ctr">' + (awayLeads(m)
      ? counterBlock(away, home, 0, settled) + counterBlock(home, away, 3, settled)
      : counterBlock(home, away, 0, settled) + counterBlock(away, home, 3, settled)) + '</div>';
  return sec('detail', 'Detail', 'Counter-matchups',
    `Each attack/defence pair splits 100 ${infoButton('donut', copy('donut'), 'how to read the donuts')}`, body);
}

// ─── Render: outlook (Horizon) ────────────────────────────────────────────────

/** Tooltip text for one outlook entry — the old strip cell's title, unchanged in substance. */
function entryLabel(e) {
  if (e.isBlank) return `GW${e.gw} — blank (no fixture)`;
  return `GW${e.gw} · ${e.opponent ?? ''} (${e.venue ?? ''}) · ${Math.round(e.value)} ${BAND_LABEL[bandFromValue(e.value)]}`
    + `${e.provisional ? ' (low confidence)' : ''}${e.provisionalKickoff ? ' — kickoff TBC' : ''}`;
}

function outlookHTML(m) {
  const { home, away, fixture, horizon } = m;
  const lead = awayLeads(m) ? [away, home] : [home, away];
  const slotsOf = s => groupPerGwSlots(s.outlook.perGw);
  const gws = [...new Set([...slotsOf(home), ...slotsOf(away)].map(sl => sl.gw))].sort((a, b) => a - b);

  const head = '<span class="ol__corner"></span>' + gws.map(g =>
    `<span class="ol__gw"${g === fixture.gw ? ' aria-current="true"' : ''} aria-hidden="true">${g}</span>`).join('');

  const row = s => {
    const team = s.team;
    const slots = new Map(slotsOf(s).map(sl => [sl.gw, sl]));
    const b = s.outlookSettled ? bandFromValue(s.outlook.value) : null;
    const pend = pendingFixturesForTeam(team.id, store.getSeason());
    const tbd = pend.length
      ? `<span class="ol__tbd" title="${pend.length} postponed fixture${pend.length > 1 ? 's' : ''} awaiting a rearranged date">+${pend.length} TBD</span>` : '';
    const summary = s.outlookSettled
      ? `${chip(s.outlook.value, { size: 'lg' })}<span class="bandname" data-band="${b}">${BAND_LABEL[b]}</span>`
      : `${chip(null, { size: 'lg', pending: true })}<span class="bandname sk-t">Settling</span>`;
    const cells = gws.map(gw => {
      const sl = slots.get(gw);
      if (!sl) return '<li class="ol__slot"></li>';
      return `<li class="ol__slot">${sl.fixtures.map((e, i) => {
        const fixtureId = findFixtureId(team, e);
        const key = `o-${team.id}-${gw}-${i}`;
        if (e.isBlank) {
          return chip(null, { cls: 'oc', text: '∅', tip: entryLabel(e), aria: entryLabel(e),
            attrs: ` data-rv data-static data-key="${key}" data-sig="blank" tabindex="-1"` });
        }
        const idAttr = fixtureId !== null ? ` data-fixture-id="${fixtureId}" data-team-id="${team.id}"` : ' data-static';
        const cur = fixtureId === fixture.id ? ' aria-current="true"' : '';
        // Per cell, not per strip: the gameweeks that ARE final stay readable
        // while the rest fill in. The cell stays clickable — only the value is withheld.
        if (fixtureId !== null && !fixtureScoreSettled(store.getFixture(fixtureId))) {
          const tip = `GW${e.gw} ${e.opponent ?? ''} (${e.venue ?? ''}) — still calculating`;
          return chip(null, { tag: 'button', cls: 'oc', pending: true, tip, aria: tip,
            attrs: `${idAttr}${cur} data-rv data-key="${key}" data-sig="p" tabindex="-1"` });
        }
        return chip(e.value, { tag: fixtureId !== null ? 'button' : 'span',
          cls: `oc${e.provisionalKickoff ? ' is-tbc' : ''}`, est: e.provisional,
          tip: entryLabel(e), aria: entryLabel(e),
          attrs: `${idAttr}${cur} data-rv data-key="${key}" data-sig="${Math.round(e.value)}" tabindex="-1"` });
      }).join('')}</li>`;
    }).join('');
    return `<div class="ol__team">${crest(team, 24)}${esc(team.shortName)}${tbd}${summary}</div>`
      + `<ul class="ol__chips" aria-label="${esc(team.name)}, ${esc(horizon.label.toLowerCase())} — arrow keys to move">${cells}</ul>`;
  };

  return sec('horizon', 'Horizon', `${esc(horizon.label)} outlook`,
    `Outlined chip = this fixture · hover or focus for opponent ${infoButton('outlook', copy('outlook'), 'the outlook')}`,
    `<div class="ol" style="--cols:${gws.length}">${head}${row(lead[0])}${row(lead[1])}</div>`);
}

// ─── Render: page states ──────────────────────────────────────────────────────

function renderLoading() {
  renderCmd(null);
  const skRow = '<div class="mir__r"><span class="sk" style="height:14px"></span><span class="sk" style="height:10px"></span><span class="sk" style="height:14px"></span><span class="sk" style="height:10px"></span><span class="sk" style="height:14px"></span></div>';
  _el.top.innerHTML = '<section class="frame" aria-busy="true"><div class="frame__k"><span class="sk" style="width:90px;height:11px"></span><span class="sk" style="width:160px;height:20px"></span></div>'
    + [1, 2, 3].map(() => '<div class="role"><span class="sk" style="width:70%;height:12px"></span><span class="sk" style="height:32px"></span></div>').join('') + '</section>';
  _el.tape.setAttribute('aria-busy', 'true');
  _el.tape.innerHTML = PITCH + ['', ' side--a'].map(c => `<div class="side${c}"><div class="side__info"><span class="sk mx-sk-name"></span></div><div class="score"><span class="sk mx-sk-score"></span></div></div>`).join('<div class="axis"></div>');
  _el.main.innerHTML = ['Why', 'Detail', 'Horizon'].map(k =>
    `<section class="pn" aria-busy="true"><header class="ph"><span class="lbl">${k}</span><span class="sk" style="width:200px;height:22px"></span></header>${skRow}${skRow}${skRow}</section>`).join('');
}

/** A verdict the reader should act on ("No fixtures found"), in place of the tape. */
function showStatus(msg) {
  renderCmd(null);
  _el.top.innerHTML = '';
  _el.main.innerHTML = '';
  _el.tape.removeAttribute('aria-busy');
  _el.tape.innerHTML = `<div class="state" style="grid-column:1/-1;justify-self:center"><h2 class="state__t">${esc(msg)}</h2></div>`;
}

// ─── Render: whole page + choreography ────────────────────────────────────────

function later(fn, ms) {
  if (RM.matches || !ms) { fn(); return; }
  _timers.push(setTimeout(fn, ms));
}

function reveal(els, start, step = 0) {
  Array.from(els).forEach((el, i) => later(() => el.classList.add('in', 'is-on'), start + i * step));
}

/** Only what changed since the last render re-animates; the rest lands in place. */
function settleIn(sel, start, step) {
  const els = Array.from(_root.querySelectorAll(sel)).filter((e) => {
    const k = e.dataset.key;
    if (k && _prev[k] === e.dataset.sig) { e.classList.add('in', 'is-on'); return false; }
    return true;
  });
  reveal(els, start, step);
}

function remember() {
  _prev = {};
  _root.querySelectorAll('.mx [data-key]').forEach((e) => { _prev[e.dataset.key] = e.dataset.sig; });
}

/** 0 → score count-up, power2.out; the outline numeral tracks every frame. */
function countUp(n, to, delay, dur) {
  const o = n.parentNode.querySelector('.num__o');
  let last = -1;
  const set = (v) => { if (v === last) return; last = v; const h = digits(v); n.innerHTML = h; if (o) o.innerHTML = h; };
  set(0);
  later(() => {
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur), k = 1 - (1 - p) * (1 - p);
      set(Math.round(to * k));
      if (p < 1) requestAnimationFrame(step);
    };
    step(t0);
  }, delay);
}

function play(mode) {
  const q = sel => _root.querySelectorAll(sel);
  const sw = mode === 'switch';
  if (sw) q('#mx-frame, #mx-tape [data-rv], #mx-main .pn').forEach(e => e.classList.add('in'));
  else { reveal(q('#mx-frame'), 0); reveal(q('#mx-tape .side'), 60, 90); }
  q('#mx-tape [data-flap]').forEach((n, i) => {
    if (RM.matches || _prev[n.dataset.key] === n.dataset.sig) return;
    countUp(n, Number(n.dataset.flap), (sw ? 0 : 200) + i * 120, sw ? 700 : 1000);
  });
  if (!sw) { reveal(q('#mx-tape [data-late]'), 880, 60); reveal(q('#mx-main .pn'), 960, 140); }
  else q('#mx-tape [data-late]').forEach(e => e.classList.add('in'));
  settleIn('#mx-main .mir .bar', sw ? 120 : 1000, 0);
  settleIn('#mx-main .dn', sw ? 220 : 1120, 0);
  settleIn('#mx-main .oc', sw ? 380 : 1560, 18);
}

/**
 * Score the selected fixture and render the whole page. `mode` 'load' plays
 * the full entrance; 'switch' (a new fixture, or data settling) re-animates
 * only what changed.
 */
function renderMatchup(mode = 'switch') {
  _timers.forEach(clearTimeout);
  _timers = [];
  closePop(true);
  _info.clear();

  const ctx = buildCtx();
  if (!ctx || !_selectedFixtureId) { renderLoading(); return; }
  const fixture = store.getFixture(_selectedFixtureId);
  if (!fixture) { showStatus('Fixture not found.'); return; }
  const m = computeMatch(fixture, ctx);
  if (!m) { showStatus('Team data unavailable.'); return; }
  if (_leadTeamId !== m.home.team.id && _leadTeamId !== m.away.team.id) _leadTeamId = m.home.team.id;

  renderCmd(m);
  _el.top.innerHTML = frameHTML(m);
  _el.tape.innerHTML = tapeHTML(m);
  if (m.settled) _el.tape.removeAttribute('aria-busy');
  else _el.tape.setAttribute('aria-busy', 'true');
  _el.main.innerHTML = breakdownHTML(m) + countersHTML(m) + outlookHTML(m)
    + '<p class="foot">Confidence is data coverage, not a win probability — the model isn’t calibrated yet.</p>';
  _el.main.querySelectorAll('.ol__chips').forEach(u => roving(u, '.oc'));

  const first = !_hasRendered;
  _hasRendered = true;
  if (first) _prev = {};
  play(first && mode !== 'static' ? 'load' : 'switch');
  remember();
  if (_drawer) refreshDrawer();
}

// ─── Keyboard: roving focus within a strip / list ─────────────────────────────

function ensureVisible(box, it) {
  const r = it.getBoundingClientRect(), b = box.getBoundingClientRect();
  if (r.top < b.top) box.scrollTop -= b.top - r.top + 8;
  else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom + 8;
}

/** One tab stop per strip; arrows / Home / End move within it. */
function roving(box, sel) {
  const items = Array.from(box.querySelectorAll(sel));
  if (!items.length) return;
  let start = items.findIndex(x => x.matches('[aria-current=true]'));
  if (start < 0) start = 0;
  items.forEach((x, i) => { x.tabIndex = i === start ? 0 : -1; });
  box.addEventListener('keydown', (e) => {
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    let n = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = i + 1;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = i - 1;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = items.length - 1;
    if (n === null) return;
    e.preventDefault();
    n = (n + items.length) % items.length;
    items[i].tabIndex = -1;
    items[n].tabIndex = 0;
    items[n].focus();
    ensureVisible(box, items[n]);
  });
}

// ─── Popover (desktop) / bottom sheet (≤640px) ────────────────────────────────

function weightsStrip(key) {
  const pct = Math.round(WEIGHTS[key] * 100);
  return `<div><div class="lbl pop__wl">Weight in the score · ${pct}%</div><div class="wts" aria-hidden="true">${
    METRIC_ORDER.map(k => `<span style="flex:${WEIGHTS[k]}"${k === key ? ' aria-current="true"' : ''}>${Math.round(WEIGHTS[k] * 100)}%</span>`).join('')}</div></div>`;
}

function placePop() {
  if (!_popBtn || _el.pop.classList.contains('pop--sheet')) return;
  const r = _popBtn.getBoundingClientRect(), pw = _el.pop.offsetWidth, ph = _el.pop.offsetHeight;
  const l = Math.min(Math.max(12, r.left + r.width / 2 - pw / 2), innerWidth - pw - 12);
  let t = r.bottom + 10;
  if (t + ph > innerHeight - 12) t = Math.max(12, r.top - ph - 10);
  _el.pop.style.left = `${l}px`;
  _el.pop.style.top = `${t}px`;
}

function openPop(btn) {
  if (_popBtn === btn) { closePop(); return; }
  if (_popBtn) closePop(true);
  const d = _info.get(btn.dataset.info);
  if (!d) return;
  _popBtn = btn;
  btn.setAttribute('aria-expanded', 'true');
  _el.pop.innerHTML = `<div class="lbl">${esc(d.kicker)}</div><h3 class="pop__t" id="mx-pop-t">${esc(d.title)}</h3>`
    + `<div class="pop__b">${d.body}</div>${d.weightKey ? weightsStrip(d.weightKey) : ''}`
    + `${d.ctx ? `<div class="pop__ctx">${d.ctx}</div>` : ''}`
    + '<button type="button" class="btn pop__x">Close <span class="lbl">Esc</span></button>';
  const sheet = innerWidth <= 640;
  _el.pop.classList.toggle('pop--sheet', sheet);
  _el.scrim.classList.toggle('is-on', sheet);
  placePop();
  requestAnimationFrame(() => {
    _el.pop.classList.add('is-open');
    _el.pop.querySelector('.pop__x').focus({ preventScroll: true });
  });
  // The pane has no render loop in some harnesses; don't make open depend on it.
  setTimeout(() => _el.pop.classList.add('is-open'), 50);
}

function closePop(silent) {
  if (!_popBtn) return;
  const b = _popBtn;
  _popBtn = null;
  b.setAttribute('aria-expanded', 'false');
  _el.pop.classList.remove('is-open');
  if (!_drawer) _el.scrim.classList.remove('is-on');
  if (!silent && document.contains(b)) b.focus({ preventScroll: true });
}

function showTip(t) {
  const tip = _el.tip;
  tip.textContent = t.dataset.tip;
  tip.classList.add('is-on');
  const r = t.getBoundingClientRect(), w = tip.offsetWidth;
  tip.style.left = `${Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8)}px`;
  tip.style.top = `${Math.max(8, r.top - tip.offsetHeight - 8)}px`;
  t.setAttribute('aria-describedby', 'mx-tip');
}

function hideTip(t) {
  _el.tip.classList.remove('is-on');
  if (t) t.removeAttribute('aria-describedby');
}

// ─── Drawers: fixtures (by gameweek) and teams (each team's season) ───────────

/** One fixture's score chip for `team` — skeleton while either side's payload is in flight. */
function fixtureChip(team, fixture, ctx) {
  if (!ctx) return chip(null, { pending: true, aria: '' });
  // Per FIXTURE, not per side: counter-matchup reads both sides, so one team's
  // payload in flight leaves BOTH chips provisional.
  if (!fixtureScoreSettled(fixture)) return chip(null, { pending: true, aria: '' });
  const score = scoreFixture(team, fixture, ctx);
  return chip(score.value, { est: score.provisional, aria: '' });
}

function fixtureDrawerHTML(ctx) {
  const group = _navGroups[_navIndex];
  const first = _navIndex === 0, last = _navIndex === _navGroups.length - 1;
  const rows = (group?.fixtures ?? []).map((f) => {
    const home = store.getTeam(f.homeTeamId), away = store.getTeam(f.awayTeamId);
    if (!home || !away) return '';
    return `<button type="button" class="dfx" data-fixture-id="${f.id}" aria-current="${f.id === _selectedFixtureId}"`
      + ` aria-label="${esc(`${home.name} v ${away.name}`)}">${fixtureChip(home, f, ctx)}<span>${esc(home.shortName)}</span>`
      + `<i>v</i><span>${esc(away.shortName)}</span>${fixtureChip(away, f, ctx)}</button>`;
  }).join('');
  return `<div class="drawer__h">
      <button type="button" class="step" data-gw="prev" aria-label="Previous gameweek"${first ? ' data-off disabled' : ''}>‹</button>
      <h2 id="mx-drawer-t">GW${esc(String(group?.gw ?? '—'))} fixtures</h2>
      <button type="button" class="step" data-gw="next" aria-label="Next gameweek"${last ? ' data-off disabled' : ''}>›</button>
      <button type="button" class="btn" data-close>Close</button>
    </div>
    <div class="drawer__b" id="mx-dlist">${rows}</div>
    <p class="drawer__f">‹ › change gameweek · arrow keys move · Enter selects · Esc closes</p>`;
}

/** The team's fixtures for the drawer: all remaining (or, off-season, all played, latest first). */
function teamFixtures(team) {
  const own = store.getFixtures().filter(f => (f.homeTeamId === team.id || f.awayTeamId === team.id) && f.gw !== null);
  return _descending
    ? own.filter(f => f.played).sort((a, b) => b.gw - a.gw || (b.kickoff || '').localeCompare(a.kickoff || ''))
    : own.filter(f => !f.played).sort((a, b) => a.gw - b.gw || (a.kickoff || '').localeCompare(b.kickoff || ''));
}

function teamDrawerHTML(ctx) {
  if (_drawerTeamId === null) {
    const gw = _navGroups[_navIndex]?.gw;
    const rows = _teams.map((t) => {
      const f = teamFixtures(t).find(x => x.gw === gw) ?? teamFixtures(t)[0];
      let next = '<span class="dtm__o">no fixtures</span>', ch = '';
      if (f) {
        const isHome = f.homeTeamId === t.id;
        const opp = store.getTeam(isHome ? f.awayTeamId : f.homeTeamId);
        next = `<span class="dtm__o">GW${f.gw} v ${esc(opp?.shortName ?? '')} <i>${isHome ? 'H' : 'A'}</i></span>`;
        ch = fixtureChip(t, f, ctx);
      }
      return `<button type="button" class="dtm" data-team="${t.id}" aria-current="${t.id === _leadTeamId}"`
        + ` aria-label="${esc(`${t.name} — show its fixtures`)}">${crest(t, 24)}<span>${esc(t.name)}</span>${next}${ch}</button>`;
    }).join('');
    return `<div class="drawer__h"><h2 id="mx-drawer-t">Teams</h2><button type="button" class="btn" data-close>Close</button></div>
      <div class="drawer__b" id="mx-dlist">${rows}</div>
      <p class="drawer__f">Pick a team for its ${_descending ? 'played' : 'remaining'} fixtures · arrows move · Esc closes</p>`;
  }

  const team = _teams.find(t => t.id === _drawerTeamId);
  const rows = [];
  let prevGw = null;
  for (const f of teamFixtures(team)) {
    const isHome = f.homeTeamId === team.id;
    const opp = store.getTeam(isHome ? f.awayTeamId : f.homeTeamId);
    if (!opp) continue;
    if (prevGw !== null && crossesChipReset(prevGw, f.gw)) {
      rows.push(`<p class="dsep" role="separator" aria-label="Chips reset after Gameweek ${CHIP_RESET_AFTER_GW}" title="FPL chips reset after Gameweek ${CHIP_RESET_AFTER_GW}">Chips reset</p>`);
    }
    rows.push(`<button type="button" class="dtm" data-fixture-id="${f.id}" data-team-id="${team.id}" aria-current="${f.id === _selectedFixtureId}"`
      + ` aria-label="${esc(`${team.name} v ${opp.name}, ${isHome ? 'Home' : 'Away'}, Gameweek ${f.gw}`)}">`
      + `${crest(opp, 24)}<span>v ${esc(opp.name)}</span><span class="dtm__o"><i>${isHome ? 'H' : 'A'}</i></span>`
      + `<span class="dtm__gw">GW${f.gw}</span>${fixtureChip(team, f, ctx)}</button>`);
    prevGw = f.gw;
  }
  return `<div class="drawer__h">
      <button type="button" class="step" data-tstep="-1" aria-label="Previous team">‹</button>
      <h2 id="mx-drawer-t">${crest(team, 24)}${esc(team.name)}</h2>
      <button type="button" class="step" data-tstep="1" aria-label="Next team">›</button>
      <button type="button" class="btn" data-teams>All teams</button>
      <button type="button" class="btn" data-close>Close</button>
    </div>
    <div class="drawer__b" id="mx-dlist">${rows.join('')}</div>
    <p class="drawer__f">${_descending ? 'Played fixtures, latest first' : 'Every remaining fixture'} · arrows move · Esc closes</p>`;
}

function refreshDrawer(focusList = false) {
  const ctx = buildCtx();
  const d = _el.drawer;
  const keepScroll = d.querySelector('#mx-dlist')?.scrollTop ?? 0;
  d.innerHTML = _drawer === 'fx' ? fixtureDrawerHTML(ctx) : teamDrawerHTML(ctx);
  const list = d.querySelector('#mx-dlist');
  roving(list, '.dfx, .dtm');
  if (focusList) {
    const c = list.querySelector('[tabindex="0"]') ?? d.querySelector('[data-close]');
    setTimeout(() => { c.focus({ preventScroll: true }); if (list.contains(c)) ensureVisible(list, c); }, 30);
  } else list.scrollTop = keepScroll;
}

function openDrawer(which) {
  closePop(true);
  _drawer = which;
  _lastDrawer = which;
  if (which === 'team') _drawerTeamId = null;
  refreshDrawer(true);
  _el.drawer.classList.add('is-open');
  _el.scrim.classList.add('is-on');
  _el.cmd.querySelector(`[data-open="${which}"]`)?.setAttribute('aria-expanded', 'true');
}

function closeDrawer(refocus = true) {
  if (!_drawer) return;
  const w = _drawer;
  _drawer = null;
  _el.drawer.classList.remove('is-open');
  _el.scrim.classList.remove('is-on');
  const t = _el.cmd.querySelector(`[data-open="${w}"]`);
  t?.setAttribute('aria-expanded', 'false');
  if (refocus) t?.focus({ preventScroll: true });
}

// ─── Selection ────────────────────────────────────────────────────────────────

/** Point the fixture drawer at the gameweek group holding `fixtureId`, if listed. */
function syncNavIndex(fixtureId) {
  const idx = _navGroups.findIndex(g => g.fixtures.some(f => f.id === fixtureId));
  if (idx >= 0) _navIndex = idx;
}

/**
 * Select a fixture. `leadTeamId` names the side that leads the page (a team
 * drawer pick or an outlook chip); otherwise the current lead stays if it is
 * in the new fixture, else home leads.
 */
function selectFixture(fixtureId, leadTeamId = null) {
  const f = store.getFixture(fixtureId);
  if (!f) return;
  const w = _drawer || _lastDrawer;
  const prevLead = _leadTeamId;
  _leadTeamId = leadTeamId
    ?? (_leadTeamId === f.homeTeamId || _leadTeamId === f.awayTeamId ? _leadTeamId : f.homeTeamId);
  closeDrawer(false);
  if (fixtureId === _selectedFixtureId && prevLead === _leadTeamId) {
    _el.cmd.querySelector(`[data-open="${w || 'fx'}"]`)?.focus({ preventScroll: true });
    return;
  }
  _selectedFixtureId = fixtureId;
  syncNavIndex(fixtureId);
  renderMatchup('switch');
  _el.cmd.querySelector(`[data-open="${w || 'fx'}"]`)?.focus({ preventScroll: true });
}

// ─── Event handlers ───────────────────────────────────────────────────────────

function onDataReady() {
  let fixtures = getUpcomingFixtures();
  let descending = false;

  if (fixtures.length === 0) {
    // Off-season fallback: no unplayed fixtures exist, show recent played ones.
    fixtures = getRecentPlayedFixtures(20);
    descending = true;
  }

  if (fixtures.length === 0) {
    showStatus('No fixtures found.');
    return;
  }

  // Default to the first fixture in the list (nearest upcoming, or most recent played).
  if (!_selectedFixtureId || !store.getFixture(_selectedFixtureId)) {
    _selectedFixtureId = fixtures[0].id;
  }

  // Cheap bookkeeping always; the render only while on screen (CONVENTIONS.md §8).
  _navGroups = groupByGw(fixtures, { descending });
  _descending = descending;
  _teams = store.getTeams().slice().sort((a, b) => a.name.localeCompare(b.name));
  syncNavIndex(_selectedFixtureId);

  if (store.getActiveModule() !== 'matchup') {
    _pendingRender = true;
    return;
  }
  _pendingRender = false;
  renderMatchup('load');
}

/**
 * Flush a render deferred while off screen, once Matchup is shown. Leaving
 * the page closes any drawer or popover so it doesn't reopen stale.
 */
function onRouteChanged(module) {
  if (module !== 'matchup') { closeDrawer(false); closePop(true); hideTip(); return; }
  if (!_pendingRender) return;
  _pendingRender = false;
  onDataReady();
}

/**
 * Handle a player:selected event emitted by the Ranker when the user clicks a
 * player row to drill into its matchup breakdown.
 */
function onPlayerSelected({ fixtureId }) {
  if (!store.isFresh() || !fixtureId) return;
  _selectedFixtureId = fixtureId;
  syncNavIndex(fixtureId);
  renderMatchup('switch');
}

function onClick(e) {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  const info = t.closest('.mx [data-info]');
  if (info) { e.preventDefault(); openPop(info); return; }
  if (t.closest('.pop__x')) { closePop(); return; }
  if (_popBtn && !_el.pop.contains(t)) closePop(true);
  if (!_root.contains(t)) return;

  let x;
  if ((x = t.closest('[data-open]'))) { openDrawer(x.dataset.open); return; }
  if (t.closest('[data-close]') || t === _el.scrim) { closeDrawer(); return; }
  if ((x = t.closest('[data-gw]'))) {
    _navIndex = clamp(0, _navGroups.length - 1, _navIndex + (x.dataset.gw === 'next' ? 1 : -1));
    refreshDrawer(true);
    return;
  }
  if (t.closest('[data-teams]')) { _drawerTeamId = null; refreshDrawer(true); return; }
  if ((x = t.closest('[data-tstep]'))) {
    const i = _teams.findIndex(tm => tm.id === _drawerTeamId);
    _drawerTeamId = _teams[(i + Number(x.dataset.tstep) + _teams.length) % _teams.length].id;
    refreshDrawer(true);
    return;
  }
  if ((x = t.closest('.dtm[data-team]'))) { _drawerTeamId = Number(x.dataset.team); refreshDrawer(true); return; }
  if ((x = t.closest('[data-fixture-id]'))) {
    selectFixture(Number(x.dataset.fixtureId), x.dataset.teamId ? Number(x.dataset.teamId) : null);
  }
}

function onKeydown(e) {
  if (store.getActiveModule() !== 'matchup') return;
  if (e.key === 'Escape') {
    if (_popBtn) { e.preventDefault(); closePop(); return; }
    if (_drawer) { e.preventDefault(); closeDrawer(); return; }
  }
  // Keep Tab inside an open drawer / sheet.
  if (e.key === 'Tab' && _popBtn && _el.pop.classList.contains('pop--sheet')) {
    e.preventDefault();
    _el.pop.querySelector('.pop__x').focus();
    return;
  }
  if (e.key === 'Tab' && _drawer) {
    const f = Array.from(_el.drawer.querySelectorAll('button')).filter(b => b.offsetParent && b.tabIndex >= 0 && !b.disabled);
    if (!f.length) return;
    const a = f[0], z = f[f.length - 1];
    if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
    else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey || _drawer || _popBtn) return;
  if (e.target.matches?.('input, textarea, select, [contenteditable]')) return;
  const k = e.key.toLowerCase();
  if (k === 'f') { e.preventDefault(); openDrawer('fx'); }
  else if (k === 't') { e.preventDefault(); openDrawer('team'); }
}

// ─── Public init ─────────────────────────────────────────────────────────────

/**
 * Initialise the matchup module. Called once from main.js on bootstrap.
 * Caches DOM references, registers store subscriptions, and triggers an
 * immediate render if the season is already in memory (hydrated from cache).
 */
export function initMatchup() {
  _root = document.querySelector('[data-module="matchup"]');
  const $ = id => _root.querySelector(`#mx-${id}`);
  _el = {
    cmd: $('cmd'), top: $('top'), tape: $('tape'), main: $('main'),
    drawer: $('drawer'), scrim: $('scrim'), pop: $('pop'), tip: $('tip'),
  };

  store.subscribe('data:ready',      onDataReady);
  store.subscribe('route:changed',   onRouteChanged);
  store.subscribe('player:selected', onPlayerSelected);

  // Delegated once: every container's contents are rebuilt on each render.
  document.addEventListener('click', onClick);
  document.addEventListener('keydown', onKeydown);
  _root.addEventListener('pointerover', (e) => { const t = e.target.closest?.('[data-tip]'); if (t) showTip(t); });
  _root.addEventListener('pointerout', (e) => { const t = e.target.closest?.('[data-tip]'); if (t && !t.contains(e.relatedTarget)) hideTip(t); });
  _root.addEventListener('focusin', (e) => { const t = e.target.closest?.('[data-tip]'); if (t) showTip(t); else hideTip(); });
  addEventListener('scroll', () => { placePop(); hideTip(); }, { passive: true });
  addEventListener('resize', () => closePop(true));

  // Defensive: if data is already fresh (sessionStorage hydration) trigger now,
  // since data:ready was emitted before this subscription was registered.
  if (store.isFresh()) onDataReady();
}
