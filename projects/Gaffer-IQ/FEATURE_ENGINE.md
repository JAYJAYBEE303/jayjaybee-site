# FEATURE_ENGINE.md

> **The analytical brain of Gaffer IQ.** This is the most important document in the project. It specifies every metric, every formula, every weight, and how they combine into the composite matchup score that the entire app is built on.
>
> Everything here is implemented as **pure functions** under `js/engine/` (see `ARCHITECTURE.md` §3, §8 and `CONVENTIONS.md` §3.3). Every tunable number named in this document lives in `js/config.js` — the formulas reference constants, never literals.
>
> **Reading order:** §1 conventions → §2–§7 individual metrics → §8 the composite → §9 horizon aggregation → §10 outputs → §11 how each module consumes it.

---

## 1. Universal conventions for all metrics

These rules make the metrics composable. Violating any of them silently corrupts the composite.

1. **Scale.** Every metric is normalised to **0–100**.
2. **Direction.** **Higher is always better *for the team being scored*.** A fixture score of 90 = a great fixture for *this* team; 10 = brutal. Team form 80 = in great form. Counter-matchup 75 = this team's attack is well-matched against the opponent's defence. Never let a metric default to "higher = harder"; if a raw input is naturally inverted (e.g. opponent strength), invert it during normalisation and leave a `// MODEL:` comment.
   - **One documented exception: `baseDifficulty` (§2).** It is stored as the opponent's strength (higher = harder) because the UI surfaces that number directly, and `engine/composite.js` inverts it at the weighting step. This is the *only* metric permitted to break this rule, and it is inverted exactly once, at that one boundary. Do not add another.
3. **Neutral point = 50.** Missing/blank inputs fall back to 50 (genuinely neutral), never 0. Absence of information is not evidence of a hard fixture.
4. **Perspective.** Almost everything is computed *from one team's point of view against a specific opponent in a specific fixture*. A fixture produces **two** scores — one per side — which are not simply complements of each other (home/away, form, and counter-matchups are asymmetric).
5. **Explainability.** Every metric returns enough to populate `CompositeScore.breakdown`. If a value used a fallback, flag `estimated: true`.
6. **Normalisation method.** Unless stated otherwise, raw values are normalised across the **current league population** using min–max with clamping to [0,100], then optionally re-centred. Use league-relative normalisation (not absolute thresholds) so the model self-calibrates as the season's data shifts. Min–max bounds are computed over all 20 teams (for team metrics) or all players in a position (for player metrics).

```
normaliseLinear(x, min, max) = clamp(0, 100, ((x - min) / (max - min)) * 100)
invert(score)               = 100 - score
```

---

## 2. Base fixture difficulty (`engine/fixtures.js → calcBaseDifficulty`)

**Purpose:** Replace the FPL app's blunt 1–5 FDR with a continuous, strength-aware base difficulty, *before* form/style/counter adjustments.

**Inputs (from FPL `bootstrap-static` → `teams[]`):** the **opponent's** `strength_attack_home/away` and `strength_defence_home/away`. These are FPL's own integer priors (~1000–1400 range) and are a reasonable, always-available starting point.

> **⚠ DIRECTION EXCEPTION — read this before touching the formula.**
> Base difficulty is the **one** metric in the engine stored as **higher = HARDER for the team being scored**, contrary to §1 rule 2. It is stored that way because the Matchup Analyser surfaces it directly as "how tough is this opponent", and that is the reading the project owner wants on screen.
> `engine/composite.js` therefore applies `invert()` to this value before weighting it, so the composite still consumes a higher-is-better number. **Removing that `invert()` would make facing Man City raise a team's score.** Every other sub-metric follows §1 rule 2 unchanged.
>
> **This exception has a second consequence, found by Phase-2 audit: rendering must invert it too, separately from scoring.** `modules/matchup.js`'s breakdown row colours every metric by feeding its stored value into `bandFromValue()`, which assumes higher = better. For five of six rows that's correct as stored. For `baseDifficulty` it is **not** — a brutal fixture (strong opponent, high stored value) would band as `'great'` (green) if rendered raw. `buildBreakdownRows()` therefore calls `bandFromValue(invert(m.value))` for this one row only, while the **displayed number stays uninverted** (the opponent-strength reading is what's meant to be shown). Any future consumer of `breakdown.baseDifficulty.value` for colouring/banding — not just for display — must invert first. Consumers that only read the top-level composite `score.value`/`score.band` (ranker, dashboard, planner) are unaffected; they already receive the correctly-inverted composite.

**Model:** base difficulty is an **absolute read of the opponent**, not a relative edge between the two sides. A strong club posts the same high number in whoever's box it appears in — Man City are a hard fixture for Wolves and for Arsenal alike (~80 either way). Two weak sides meeting produces a low number on both sides of the tie; two strong sides produce a high number on both.

**Formula (scoring TEAM A at home vs TEAM B):**
```
# Read B at the venue B will actually play at.
oppThreat = B.strength_attack_away        # B attacking when away at A
oppResist = B.strength_defence_away       # B defending when away at A

rawStrength   = (W_OPP_ATTACK * oppThreat) + (W_OPP_DEFENCE * oppResist)
strengthScore = normaliseLinear(rawStrength, OPP_STRENGTH_MIN, OPP_STRENGTH_MAX)

# §2.1 tenure deduction — only ever lowers, never raises.
baseDifficulty = min(strengthScore, max(TENURE_FLOOR, strengthScore - tenurePenalty(B)))
# 0–100, higher = HARDER for A
```
- `W_OPP_ATTACK`, `W_OPP_DEFENCE` default **0.5 / 0.5** in `config.js`.
- `OPP_STRENGTH_MIN`/`OPP_STRENGTH_MAX` default **1000 / 1400**, the observed band of FPL's strength integers.
- The opponent is read at *their* venue — away strengths for an away side. §3 layers a separate, data-driven home/away adjustment on top.

**Fallback:** strengths are always present in bootstrap, so this metric never needs a fallback. It is the floor the whole model stands on.

---

## 2.1 Premier League tenure (`engine/fixtures.js → calcTenurePenalty`)

**Purpose:** FPL's `strength_*` priors systematically over-rate newly promoted sides — the numbers are seeded, not earned, so a club with no top-flight history can arrive rated close to an established mid-table side. Tenure corrects that, so a promoted opponent reads as the soft fixture it usually is.

**Inputs:** `PL_SEASONS` in `config.js` — a static table of which clubs contested each of the last `PL_TENURE_LOOKBACK` (default **15**) seasons, newest first.

**Join:** by club **name**, falling back to **short name**, resolved through `TEAM_NAME_ALIASES`. Both sides are normalised (lowercased, non-alphanumerics stripped) so `Nott'm Forest`, `nottm forest` and `NFO` all reach the same entry.
- **MODEL:** never join by FPL team id. Ids are reassigned each season as clubs go up and down, so an id join silently mismatches exactly the promoted and relegated clubs this metric exists to measure.

**Formula:**
```
seasonsAgo    = 0 for the most recent season in the table, 1 for the one before, …
recencyWeight = TENURE_RECENCY_DECAY ^ seasonsAgo          # default 0.85
tenureRatio   = Σ(present(s) * recencyWeight(s)) / Σ recencyWeight(s)    # 0–1
deficit       = 1 - tenureRatio
tenurePenalty = TENURE_MAX_PENALTY * (deficit ^ TENURE_CURVE)            # 0–40
```
- **MODEL:** presence is **recency-weighted, not counted**. A relegation last season says far more about a squad's current level than an absence eight years ago — at the default decay the newest season carries ~4.5× the weight of one eight seasons back.
- **MODEL:** `TENURE_CURVE` (default **2.0**) makes the punishment *curve* rather than ramp, so this stays a promoted-team rule instead of a tax on anyone who was ever in the Championship. Measured effect: Crystal Palace (13/15 seasons) **0.05 pts**, Brentford (5/15, all consecutive and recent) **6.10 pts**, a club never in the PL **40 pts**. A linear deficit gave Brentford ~12, which was wrong — five straight seasons up is established in practice.
- `TENURE_MAX_PENALTY` (default **40**) with `TENURE_FLOOR` (default **20**): a club with no recent top-flight history at all bottoms out at 20, not a token nudge. The `min()` in §2 guarantees the floor can never *raise* a club FPL already rates below it.
- An ever-present club scores `tenureRatio = 1` → penalty **0**. Established sides are therefore provably unaffected by this rule: the deduction is exactly zero, not merely small.
- A club absent from every season in the table scores 0 — the correct reading for a genuine newcomer, and the same reading a join failure would produce, so the two need not be distinguished.

**Direction of effect:** tenure is a **pure punishment on the opponent's reading**. It lowers the number shown in the *other* team's box — Coventry's thin history makes Arsenal's box read low (easy fixture), while Coventry's own box still shows Arsenal's full strength (hard fixture). The established side's own numbers are never touched.

**Estimated flag:** a low tenure reading is a **known fact, not missing data**, so `calcBaseDifficulty` keeps `estimated: false` throughout and confidence is unaffected. Only genuinely absent inputs set `estimated` (§8.3).

---

## 3. Home/away split performance (`engine/fixtures.js → calcHomeAwaySplit`)

**Purpose:** Capture that teams perform very differently by venue, beyond FPL's static home/away strength integers. A team may be a fortress at home and feeble away in *actual results* this season.

**Inputs:** this season's played `fixtures[]` (results) and, for depth, player `history[]` venue splits. Computed per team:
```
homePPG  = points won per home game this season       # 3 win / 1 draw / 0 loss
awayPPG  = points won per away game this season
homeGD   = goal difference per home game
awayGD   = goal difference per away game
```

**Formula (for TEAM A playing at its relevant venue in this fixture):**
```
venue = (A is home) ? 'home' : 'away'
venuePPG = venue == 'home' ? homePPG : awayPPG
venueGD  = venue == 'home' ? homeGD  : awayGD

rawVenue = (W_PPG * venuePPG) + (W_GD * venueGD)
homeAwayScore = normaliseLinear(rawVenue, across all teams' venue values)
```
- `W_PPG` / `W_GD` default **0.7 / 0.3** in `config.js`.
- **MODEL:** early season (fewer than `MIN_VENUE_GAMES`, default 4, games at that venue) → blend with `baseDifficulty`'s venue component using a confidence weight that scales with games played, so a 1-game sample doesn't dominate. Below the minimum, lean on the FPL strength prior; flag `estimated: true`.

---

## 4. Fixture history / head-to-head (`engine/fixtures.js → calcFixtureHistory`)

**Purpose:** A small, deliberately low-weight nudge for persistent matchup patterns ("Team A always struggles at Team B").

**Inputs:** `element-summary` → `history_past` aggregated to club level where available, plus this season's reverse fixture if played. Realistically the FPL API gives limited clean H2H, so this is a **minor** factor by design.

**Formula:**
```
h2h = last N_H2H meetings (default 4, fewer if unavailable)
A_points = points A took across those meetings (3/1/0)
historyScore = normaliseLinear(A_points / (3 * count), 0, 1) * 100
```
- **MODEL:** if fewer than 2 prior meetings exist (promoted teams, etc.), return **50** and flag `estimated: true`. This factor has the lowest weight in §8 precisely because the data is thin and football H2H is weakly predictive.

---

## 5. Team form (`engine/form.js → calcTeamForm`)

**Purpose:** Recent trajectory, independent of FPL's player-level `form` field (which we do not use for team form).

**Inputs:** last `FORM_WINDOW_GWS` (default **5**) results for the team: win/draw/loss, goals for/against, and — critically — **opponent quality** so that beating strong teams counts more than beating weak ones.

**Formula:**
```
For each of the last FORM_WINDOW_GWS matches g:
  resultPoints(g) = 3 win / 1 draw / 0 loss
  oppAdj(g)       = opponent.strength_overall / LEAGUE_AVG_STRENGTH   # >1 if strong opp
  weightedPoints(g) = resultPoints(g) * oppAdj(g)
  recencyWeight(g)  = RECENCY_DECAY ^ (gwsAgo)        # default RECENCY_DECAY = 0.85

rawForm = Σ(weightedPoints(g) * recencyWeight(g)) / Σ(recencyWeight(g))
teamForm = normaliseLinear(rawForm, across all teams)
```
- `RECENCY_DECAY` (default **0.85**) makes the most recent match matter most. A decay of 1.0 = flat average; tune toward 0.7 to react faster to hot/cold streaks.
- Optionally fold in goal difference with weight `W_FORM_GD` (default **0.2**) blended into `rawForm` for a sharper read than results alone.
- Returns `{ value, trend }` where `trend` = sign/magnitude of the slope across the window (improving vs declining), used for UI arrows and as a tiebreaker, not in the composite.

---

## 6. Team style profiling & style clash score (`engine/style.js`)

**Purpose:** Some fixtures are "easy on paper" but stylistically dangerous (e.g. a possession-light counter-attacking side hosting a high line). This metric models *how two teams' styles interact*, not just how strong they are.

### 6.1 Style profile (`calcStyleProfile(team)`)
With FPL-only data in Phase 1, profile each team on three proxy axes, each 0–100:
```
attackDirectness  = proxy from goals-per-shot / quick-scoring patterns
                    (Phase 1 proxy: goals scored vs xG overperformance + early-game goals)
defensiveHeight   = proxy from goals conceded profile + clean-sheet rate
                    (high line ↔ concede fewer-but-bigger chances)
tempo             = proxy from total goals in their matches (for + against) per game
                    (high-tempo, end-to-end teams vs low-event teams)
```
- These are **acknowledged proxies** (`// MODEL:` tagged). True possession/PPDA data is not in the FPL API; Phase 3 may replace these proxies with real xG/xGA and pressing data via an external source through the proxy (see `ARCHITECTURE.md` §7).

### 6.2 Style clash score (`calcStyleClash(teamA, teamB)`)
**Purpose:** Translate the interaction of two profiles into an advantage for A. Style clash is about *mismatches*, so it is computed as directional matchups, not similarity.
```
# Examples of modelled interactions (each contributes a signed delta for A):
#  - A high attackDirectness vs B high defensiveHeight  → favours A (pace in behind)
#  - A low tempo vs B high tempo                         → B drags A into a game it dislikes → disfavours A
#  - A strong attack axis vs B weak corresponding defence axis → favours A
clashDelta = Σ over modelled interaction rules of (ruleSign * ruleMagnitude)
styleClash = clamp(0,100, 50 + clashDelta)     # centred at 50 = neutral clash
```
- The interaction rules and their magnitudes live in `config.js` as a small declarative table (`STYLE_RULES`) so the model is editable without touching logic.
- **MODEL:** if either team lacks enough games to profile (`< MIN_VENUE_GAMES`), return 50, `estimated: true`. Style is the most speculative metric in Phase 1; weight it modestly (see §8) and lean on it more as data accrues / Phase 3 adds real inputs.

---

## 7. Player-level metrics

### 7.1 Player form (`engine/form.js → calcPlayerForm`)
**Purpose:** A truer read than FPL's `form` field (which is just average points over ~30 days and ignores minutes risk and per-90 efficiency).

**Inputs:** player `history[]` (per-GW points, minutes, goals, assists, xG, xA where present).
```
window = last PLAYER_FORM_GWS gameweeks (default 5)

per90Output = points over window / (minutes over window / 90)     # efficiency
minutesSecurity = minutes over window / (90 * gamesAvailable)      # 0–1, nailed-on starter?
xgOverlay = (xG+xA over window) per90    # underlying-numbers sanity check vs actual returns

rawPlayerForm = (W_RETURNS * per90Output_norm)
              + (W_MINUTES * minutesSecurity * 100)
              + (W_UNDERLYING * xgOverlay_norm)
playerForm = clamp(0,100, rawPlayerForm)
```
- Defaults in `config.js`: `W_RETURNS = 0.5`, `W_MINUTES = 0.3`, `W_UNDERLYING = 0.2`.
- **MODEL:** `minutesSecurity` is weighted heavily on purpose — an explosive player who doesn't start is near-useless in FPL. A player flagged injured/suspended (`status != available`) is multiplied by an availability factor (`AVAIL_PENALTY`, default 0.4) and flagged.
- `xgOverlay` lets the ranker spot players over/under-performing their underlying numbers (regression candidates). Returned in the breakdown for the UI.
- Normalisation for `per90Output` and `xgOverlay` is **position-relative** (a FWD's per-90 points distribution differs from a DEF's).

### 7.2 Position counter-matchup score (`engine/counter.js → calcCounterMatchup`)
**Purpose:** The signature Gaffer IQ metric. Asks: *given the positions involved, how does one team's attacking unit match up against the specific defensive unit it will face?* Phase 1 is **position-based only** (per project scope), not individual player-vs-player tracking.

**Position pairings modelled (Phase 1):**
```
ATTACKER GROUP (of team A)        vs   DEFENSIVE GROUP (of team B)
  FWDs (strikers)                       CBs (central defenders)
  wide MIDs / wingers                   FBs (full-backs)
  central attacking MIDs                CBs + defensive MIDs (shielding)
```
Position grouping is derived from `element_type` plus a light heuristic on each player's typical role (Phase 1: use `element_type`; refine with positional data in Phase 3).

**Formula (counter-matchup for A's attack vs B's defence):**
```
For each modelled pairing p (e.g. A.FWDs vs B.CBs):
  attackUnitForm(p)  = minutes-weighted mean playerForm of A's players in the attacking group
  defenceUnitForm(p) = minutes-weighted mean playerForm of B's players in the defensive group
  # If A's in-form strikers face B's out-of-form CBs → big advantage for A.
  pairingEdge(p) = attackUnitForm(p) - defenceUnitForm(p)        # signed
  pairingScore(p) = clamp(0,100, 50 + pairingEdge(p) * COUNTER_SENSITIVITY)

counterMatchup = Σ (pairingScore(p) * PAIRING_WEIGHT(p)) / Σ PAIRING_WEIGHT(p)
```
- `PAIRING_WEIGHT` lets the FWD-vs-CB pairing matter more than winger-vs-FB by default (`config.js`). `COUNTER_SENSITIVITY` (default scaled so a 20-point form gap moves the pairing ~±20) controls responsiveness.
- "Defence unit form" uses the **defensive** read of `calcPlayerForm` for defenders (clean sheets, goals conceded while on pitch, defensive contribution) rather than attacking returns. Document this dual-mode in `counter.js`.
- **MODEL:** uses minutes-weighting so likely starters drive the score, not fringe squad players. If a unit can't be assembled (missing data), fall back to team-level `strength_attack`/`strength_defence` and flag `estimated: true`.
- This metric is **asymmetric**: A's attack vs B's defence is a different number from B's attack vs A's defence. Each team's composite uses *its own* attacking counter-matchup.

---

## 8. The composite matchup score (`engine/composite.js → scoreFixture`)

This is where everything combines into the single 0–100 number (per team, per fixture) that drives the whole app.

### 8.1 Default weights (`config.js → WEIGHTS`)
```
WEIGHTS = {
  baseDifficulty:  0.25,   // strength priors — the dependable floor
  counterMatchup:  0.25,   // the signature metric — position form mismatches
  teamForm:        0.20,   // recent trajectory, opponent-adjusted
  homeAway:        0.15,   // venue performance this season
  styleClash:      0.12,   // stylistic interaction — Understat xG-backed (Phase 3A)
  history:         0.03    // H2H nudge (thin data, low trust)
}   // sums to 1.00
```
Rationale for the ordering:
- **Base difficulty (0.25) and counter-matchup (0.25):** the joint floor of the model — always available, robust strength priors plus the signature position-form mismatch metric. Base difficulty was 0.30 in Phase 1 and reduced to 0.25 in Phase 3A to free room for the now-evidenced style weight.
- **Form (0.20)** and **home/away (0.15):** strong, well-evidenced signals.
- **Style (0.12):** raised from 0.07 to 0.12 in Phase 3A once real Understat xG / xGA replaced the Phase 1 goals/clean-sheet proxies. Still modest because style interactions are genuinely noisy, but no longer speculative.
- **History (0.03):** deliberately small — H2H data is thin and football H2H is weakly predictive.

### 8.2 Combination
```
score(team, fixture) =
    WEIGHTS.baseDifficulty * baseDifficulty
  + WEIGHTS.counterMatchup * counterMatchup
  + WEIGHTS.teamForm       * teamForm
  + WEIGHTS.homeAway       * homeAway
  + WEIGHTS.styleClash     * styleClash
  + WEIGHTS.history        * history          # all sub-metrics already 0–100

value = clamp(0, 100, score)
```

### 8.3 Confidence handling
- Each sub-metric reports `estimated: true|false`. The composite computes a **confidence** = weighted share of non-estimated metrics. If confidence < `CONFIDENCE_FLOOR` (default 0.6), the UI shows the score as provisional (e.g. hatched/greyed) — the number is still produced, never hidden.
- **MODEL:** estimated sub-metrics are *not* dropped (that would silently re-weight the rest); they pass through at their fallback value (usually 50) and merely lower confidence. This keeps weights summing to 1 and behaviour predictable.

### 8.4 Bands (`config.js → BANDS`)
`value` maps to a band string (drives colour everywhere — see `CONVENTIONS.md` §5.2):
```
85–100 → 'great'
68–84  → 'good'
46–67  → 'neutral'
30–45  → 'tough'
 0–29  → 'brutal'
```
Band thresholds are config, not literals, so the palette can be re-calibrated after observing a season's distribution.

### 8.5 Output shape (matches `ARCHITECTURE.md` §8)
```js
CompositeScore = {
  value: 73,
  band: 'good',
  confidence: 0.82,
  breakdown: {
    baseDifficulty: { value: 68, weight: 0.25, estimated: false },
    counterMatchup: { value: 81, weight: 0.25, estimated: false },
    teamForm:       { value: 70, weight: 0.20, estimated: false },
    homeAway:       { value: 75, weight: 0.15, estimated: false },
    styleClash:     { value: 55, weight: 0.12, estimated: false },
    history:        { value: 50, weight: 0.03, estimated: true  }
  }
}
```

---

## 9. Horizon aggregation (`engine/composite.js → scoreOverHorizon`)

Single-fixture scores are aggregated across a horizon (1, 3, or 6 GWs — see `ARCHITECTURE.md` §9).

```
fixtures = team's fixtures within the horizon window (handle blanks & doubles!)

For each fixture f in window:
  s(f)        = scoreFixture(team, f).value
  gwWeight(f) = HORIZON_DECAY ^ (gwOffset(f))     # default HORIZON_DECAY = 0.9; nearer GWs matter more

aggregateMean = Σ(s(f) * gwWeight(f)) / Σ gwWeight(f)
aggregateMin  = min(s(f))                          # the "trap" detector — worst fixture in the run

horizonScore = (AGG_METHOD == 'mean') ? aggregateMean
             : (AGG_METHOD == 'min')  ? aggregateMin
             : (W_MEAN * aggregateMean + W_MIN * aggregateMin)   # 'blend' (default)
```
- **Default `AGG_METHOD = 'blend'`** with `W_MEAN = 0.75`, `W_MIN = 0.25` — rewards a good run but punishes a single brutal fixture hiding in an otherwise green sequence (critical for transfer/captaincy decisions). All in `config.js`.
- **`HORIZON_DECAY` (0.9):** GW+0 weighted fully, GW+5 weighted ~0.59. Reflects that near fixtures are more certain and more decision-relevant.
- **Blank GW handling:** a team with no fixture in a GW contributes a configurable `BLANK_GW_VALUE` (default **40** — a blank is mildly bad for that team's assets, not neutral, because you get zero return). It is included in the aggregation, never silently skipped. Flagged in the breakdown.
- **Double GW handling:** both fixtures are scored and included; the team effectively gets two entries in the window, naturally boosting its horizon score (correctly — doubles are valuable). The UI must label DGW teams.
- Output mirrors `CompositeScore` plus a `perGw: [{ gw, value, band, opponent, venue }]` array so modules can render the fixture run as a strip of coloured cells.

---

## 10. Player projection (`engine/composite.js → scorePlayer`)

Bridges team fixture scores to player-level decisions (consumed by ranker, dashboard, planner).
```
playerProjection(player, horizon) =
    PROJ_FORM   * player.form.value                    # is HE in form & nailed?
  + PROJ_FIXTURE* teamHorizonScore(player.teamId)      # are the FIXTURES good?
  + PROJ_COUNTER* playerCounterEdge(player, horizon)   # does HIS position matchup favour him?
```
- Defaults: `PROJ_FORM = 0.45`, `PROJ_FIXTURE = 0.35`, `PROJ_COUNTER = 0.20` (`config.js`).
- `playerCounterEdge` pulls the specific pairing the player participates in (a striker gets the FWD-vs-CB pairing of each fixture in the horizon), so the counter-matchup is personalised to his role, not just his team's average.
- Output: `{ value, band, perGw, breakdown, valueScore }` where `valueScore = value / price` (points-per-million proxy) for budget-aware ranking.

---

## 11. How the engine feeds each module

| Module | Primary engine call | What it shows |
|---|---|---|
| **Matchup Analyser** (`modules/matchup.js`) | `scoreFixture(team, fixture)` for **both** sides | Full side-by-side breakdown of one fixture: each sub-metric, the counter-matchup pairings, style clash, confidence. The "view source" for any score elsewhere. |
| **Player Ranker** (`modules/ranker.js`) | `rankPlayers(players, horizon)` → sorts by `scorePlayer().value` (and `valueScore` toggle) | Ranked, filterable table (by position, price, team) of projected value over the active horizon, with a per-GW fixture strip per player. |
| **GW Dashboard** (`modules/dashboard.js`) | `scorePlayer(p, HORIZON.GW1)` for owned squad + `event/<gw>/live` | Captaincy pick (top projection in squad), start/bench order, risk flags (low minutesSecurity, brutal band, low confidence), and live points when the GW is in progress. Horizon-locked to GW1. |
| **Transfer Planner** (`modules/planner.js`) | `rankPlayers` over horizon + current squad + constraints | For each candidate out→in swap, computes Δ projected horizon score; ranks transfers by gain per cost, respecting budget and free transfers (−4 hit modelled). Surfaces the moves that most raise total projected score over the horizon. |

All four read the **same** scores and breakdowns. No module recomputes a metric. If a module needs a number the engine doesn't expose, add it to the engine and its breakdown — never inline it (see `CONVENTIONS.md` §11).

---

## 12. Tuning & validation guidance (for whoever maintains the model)

- **Single source of tunables:** every constant named in this doc is in `config.js`. Tuning the model = editing `config.js`, never editing formulas.
- **Sanity benchmark:** after any weight change, spot-check a handful of fixtures whose outcome is intuitively obvious (a top side at home to a bottom side should land 'great'; a poor side away to a top side should land 'brutal'). If it doesn't, the weights or a metric's direction is wrong.
- **Backtesting (Phase 3):** persist each GW's pre-deadline scores and compare against actual points to calibrate weights empirically. Until then, weights are informed priors, explicitly documented here so they can be argued with.
- **Direction bugs are the #1 risk.** A single inverted metric quietly poisons the composite. Every metric function must restate its direction in its JSDoc (`CONVENTIONS.md` §7.2).
