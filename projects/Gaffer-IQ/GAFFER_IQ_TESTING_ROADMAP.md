# Gaffer IQ — Testing & Calibration Guide

> A practical reference for validating, testing, and tuning Gaffer IQ across the 2025/26 season. Follow this in order. Do not skip the pre-season checklist.

---

## Pre-Season Setup (Late July 2025)

The FPL API updates with new season data in late June / early July. Do this before GW1 deadline.

### Technical Checklist

Run through every item and tick it off before trusting any scores.

- [ ] All 20 teams load with correct names and fresh strength data
- [ ] Fixtures populate for all 38 GWs in the correct order
- [ ] Fixture picker shows upcoming games (not the off-season fallback showing old results)
- [ ] Horizon switcher shows correct upcoming opponents for This GW / Next 3 / Next 6
- [ ] Blank and double GWs render correctly in fixture strips (blank = grey cell, double = two cells)
- [ ] Player summaries lazy-load without console errors when clicking players in the Ranker
- [ ] Understat xG data loads — check `window.__store.getLeagueXg()` returns 20 teams with xG values
- [ ] Style Clash scores are no longer all showing `~` (estimated) — at least some should be data-backed
- [ ] Counter-matchup scores are no longer mostly estimated — player form data should be loading
- [ ] Calibration snapshot saves correctly — after loading, check `Object.keys(localStorage).filter(k => k.startsWith('gafferiq_calibration'))` returns at least one key
- [ ] FPL squad import works — enter your team ID and confirm your squad auto-populates
- [ ] Error banner shows a meaningful message if the proxy fails — not just a generic error
- [ ] Retry button successfully re-fetches data after an error
- [ ] `#calibration` view loads and shows GW1 snapshot after deadline passes

### Sanity Checks (run these before GW1 deadline)

Pick 3 obvious fixtures and verify the scores feel directionally correct:

| Fixture | Expected | Check |
|---|---|---|
| Top 6 team at home vs bottom 3 | GREAT or GOOD | [ ] |
| Bottom 3 team away at top 6 | BRUTAL or TOUGH | [ ] |
| Two mid-table teams | NEUTRAL both sides | [ ] |

If any of these are obviously wrong, check `config.js` weights before proceeding.

---

## GW-by-GW Testing Process

### Before Every Deadline

1. Open the Matchup Analyser
2. Screenshot or note the composite score and band for **every fixture** that GW
3. Note any fixtures where Gaffer IQ and FPL FDR strongly disagree — these are the interesting ones to watch
4. Save your squad in the Dashboard and note the captain recommendation
5. The calibration view saves automatically — confirm it has a snapshot for the current GW

### After Every GW Results

Score each fixture using this table:

| Predicted Band | Actual Outcome | Result |
|---|---|---|
| GREAT or GOOD | Team won, or scored 2+ goals | ✅ Correct |
| BRUTAL or TOUGH | Team lost, or kept a clean sheet | ✅ Correct |
| NEUTRAL | Any result | ⚠️ Partial — note but don't over-index |
| GREAT or GOOD | Team lost or failed to score | ❌ Wrong |
| BRUTAL or TOUGH | Team won convincingly | ❌ Wrong |

Track this in a simple note or spreadsheet:

| GW | Fixture | Predicted | Actual | Correct? | Notes |
|---|---|---|---|---|---|
| 1 | ARS vs MCI | GOOD / TOUGH | Won 2-0 | ✅ | — |

---

## What to Watch For (by Sub-Metric)

### Base Difficulty
Should be the most stable metric — rarely wildly wrong. If a team with clearly superior strength is scoring below 50 here, something is wrong with the normalisation.

**Flag if:** A clear top-6 team scores below 40 base difficulty at home vs a bottom-3 side.

### Counter-Matchup
Will be mostly estimated early in the season until player summaries are lazy-loaded. Scores should become more meaningful from GW3-4 onwards as you browse the Ranker and summaries cache.

**Flag if:** Counter-matchup scores are still all near 50 by GW5 — means player form isn't calculating correctly.

**Watch:** Does a high stVsCb score (70+) correlate with goals scored by that team's strikers? This is the core signal to validate.

### Team Form
Resets at the start of the season so GW1-3 scores will be low confidence. Should become meaningful by GW5-6.

**Flag if:** Form scores feel too extreme — a team on a 3-game winning run shouldn't be at 95, and a team on a 3-game losing run shouldn't be at 0. If you see extremes, `RECENCY_DECAY` may need tuning.

### Home/Away Split
Like form, early season data is thin. Treat home/away scores as estimated for the first 6 GWs at each venue.

**Flag if:** A team is consistently scoring 90+ or 0-10 at home/away — likely a normalisation ceiling/floor issue.

### Style Clash
Most speculative metric. Should show `~` (estimated) early season if Understat data hasn't updated yet. Check `window.__store.getLeagueXg()` after GW5 to confirm xG data is flowing.

**Flag if:** Style clash is still estimated for all teams by GW8 — means Understat fetch is broken, check the proxy logs.

### H2H History
Only 3% weight — barely affects the composite. Only flag if it's pointing in a wildly wrong direction for a fixture with a well-known H2H pattern (e.g. a fixture where one team has won the last 10 meetings).

---

## Calibration Schedule

| When | Action |
|---|---|
| Late July | Run technical checklist |
| GW1 deadline | Screenshot all predictions, let calibration save |
| After GW1 | First accuracy review — note obvious misses, don't tune yet |
| After GW3 | Second review — is there a pattern to the misses? |
| After GW5 | **First tuning session** — enough data to make one change confidently |
| After GW10 | Second tuning session |
| After GW20 (January) | Major review — half a season of data |

---

## Tuning config.js

**Rules before touching anything:**
- Tune one constant at a time
- Wait at least one GW between changes to isolate the effect
- Always document the change in `FEATURE_ENGINE.md` with a `// MODEL:` comment stating before/after values and why
- Commit the change with a message like: `perf(config): raise RECENCY_DECAY 0.85→0.90 — form was too punishing over short losing runs`

### Constants and When to Tune Them

#### `RECENCY_DECAY` (default: 0.85)
Controls how much recent results dominate form over older ones. Lower = more reactive, higher = smoother.

- **Raise toward 0.90** if form scores feel too extreme — a 3-game losing run shouldn't tank a team to near 0
- **Lower toward 0.80** if form feels too slow to react to obvious momentum shifts

#### `WEIGHTS.teamForm` (default: 0.20)
- **Raise** if form is consistently the best predictor of results
- **Lower** if form is often misleading (fluky results distorting it)

#### `WEIGHTS.counterMatchup` (default: 0.25)
- **Raise** if high counter-matchup scores reliably predict goals/blanks
- **Lower** if counter-matchup feels noisy and uncorrelated with actual player returns

#### `WEIGHTS.homeAway` (default: 0.15)
- **Raise** if venue is proving highly predictive in your accuracy log
- **Lower** if home advantage feels less pronounced than usual this season

#### `WEIGHTS.styleClash` (default: 0.12)
- Only tune once Understat data is confirmed flowing (not estimated)
- **Raise** if you notice stylistic mismatches consistently being under-scored
- **Lower** if style clash scores feel random and uncorrelated with results

#### `COUNTER_SENSITIVITY` (default: varies)
Controls how much a form gap between attacker and defender affects the pairing score.
- **Raise** if counter-matchup differences feel underweighted — scores clustering near 50
- **Lower** if scores are too extreme — a small form difference shouldn't produce a 20/80 split

#### `HORIZON_DECAY` (default: 0.9)
Controls how much near fixtures matter vs distant ones in multi-GW horizons.
- **Raise toward 1.0** if you want distant fixtures weighted more equally
- **Lower toward 0.8** if you want to prioritise the very next GW even more

---

## Red Flags — Fix Immediately

These indicate a bug, not a calibration issue:

- Any composite score showing as `NaN` or `undefined`
- Confidence showing as 0% for a fixture with full data
- The error banner appearing on every load without clearing
- Understat fetch blocking the main FPL data load (app stuck on loading)
- Fixture picker empty in-season (the off-season fallback should not activate when real fixtures exist)
- Counter-matchup pairings showing the same defender against every attacker
- H2H scores showing 0/100 asymmetry for the same fixture (both sides should reflect their own historical record)

---

## Key Console Commands

Run these in the browser console (F12) to verify state:

```js
// Confirm data loaded
window.__store.getTeams().length  // should return 20

// Confirm xG data flowing
window.__store.getLeagueXg()  // should return object with 20 teams

// Check calibration snapshots saved
Object.keys(localStorage).filter(k => k.startsWith('gafferiq_calibration'))

// Score a specific fixture manually
const teams = window.__store.getTeams();
const season = window.__store.getSeason();
const ctx = window.__engine.buildScoreContext(season);
const arsenal = teams.find(t => t.name === 'Arsenal');
const fixture = season.fixtures.find(f => f.homeTeamId === arsenal.id && !f.played);
window.__engine.scoreFixture(arsenal, fixture, ctx);

// Check horizon aggregation
const ctx = window.__engine.context();
const team = window.__store.getTeams()[0];
window.__engine.scoreOverHorizon(team, window.__horizons.GW6, ctx);
```

### Model checks (`window.__verify`)

Run these after **any** `config.js` weight change. `weights()` is a hard contract
check; the other three are directional sanity checks against live data.

```js
// Everything at once — returns true only if the weight sums are exact
window.__verify.all()

// Both weight tables must sum to exactly 1.00 (FEATURE_ENGINE.md §8.1, §10)
window.__verify.weights()

// Stacking penalty (§8.6): which fixtures have several secondary metrics
// stacking against them, and what the penalty costs each one.
window.__verify.stacking()

// Playing likelihood (§7.3 / §10): biggest downgrades and upgrades across the
// whole player pool vs the pre-PROJ_MINUTES three-term score.
window.__verify.playingLikelihood()

// Named players behind each counter-matchup pairing, for one fixture
// (defaults to the first fixture in ctx; pass a fixtureId to pick another).
window.__verify.pairingPlayers()
```

**Expected, and what to do if not:**
- `weights()` → both rows `pass: true`. If not, `config.js` is broken; the composite is silently mis-scaled. Fix before trusting any other number.
- `stacking()` → most team-fixtures show `penalty: 0` early in the season (metrics are estimated, so they're excluded by design). Penalties appearing on fixtures with `badMetrics: 0` would mean the pivot/estimated logic is wrong.
- `playingLikelihood()` → downgrades should be dominated by low-`playing` players and upgrades by high-`playing` ones. A player with `playing: 0` (injured/suspended) showing a positive delta means the `min()` in §7.3 is inverted.
- `pairingPlayers()` → real names once summaries are cached. All-empty arrays before you've browsed the Ranker is normal, not a bug (ICT/summary data loads lazily).

---

## End of Season Review

After GW38, do a full retrospective:

1. Export calibration data from `#calibration` view
2. Calculate overall accuracy % — what share of bands were directionally correct?
3. Which sub-metric had the highest correlation with actual results?
4. Which sub-metric was most often misleading?
5. Document findings in `FEATURE_ENGINE.md` and set `config.js` defaults for next season
6. Run the pre-season technical checklist again once new season fixtures drop

---

*Last updated: May 2026 — Gaffer IQ v1.0 (Phases 0–4 complete)*
