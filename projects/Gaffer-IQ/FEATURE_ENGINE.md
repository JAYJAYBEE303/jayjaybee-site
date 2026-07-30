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

**Fallback (bugfix, confirmed live 2026/27 preseason):** the strengths are *usually* always present, but FPL has been observed leaving `strength_attack_home/away` and `strength_defence_home/away` at **0 for every team** before it has calculated the granular attack/defence breakdown for a new season — while `strength_overall_home/away` and the fixture's own FDR (`team_h_difficulty`/`team_a_difficulty`) are already published. A real strength int never reads 0 (the scale runs ~1000–1400), so `calcBaseDifficulty` treats "both fields exactly 0" as a reliable "not yet published" signal and substitutes the **team's own FPL FDR for that fixture** via a fixed lookup (`config.js → FDR_FALLBACK_VALUES`):
```
FDR 1 → 10   FDR 2 → 30   FDR 3 → 50   FDR 4 → 70   FDR 5 → 90
```
Same direction as the granular calc (higher = HARDER). This is real FPL data, not a guess, so it keeps `estimated: false` — same reasoning as the tenure penalty in §2.1. The breakdown extra `usedFdrFallback` records when this path fired, for auditability. Once FPL publishes real attack/defence values, the granular calc resumes automatically (the `=== 0` check simply stops matching).

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

> Note: `W_MINUTES` here is **not** the whole of the model's minutes handling. It makes minutes-security part of the *form* read; §7.3 additionally makes playing likelihood a first-class term in the player projection (§10). The double-counting is deliberate — see §10.

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

**Defending Counters (`calcCounterMatchupMirrored`) — UI-explanatory only, Phase 4:**
The Matchup Analyser shows two labelled sections per team card: **Attacking Counters** (`calcCounterMatchup`, above — this team's attack vs the opponent's defence) and **Defending Counters** — the same interaction, re-read from the defending side, so a viewer can see "my defence vs their attack" without mentally inverting the other team's card.

`calcCounterMatchupMirrored(attackingResult)` takes an *already-computed* `calcCounterMatchup` result (the opponent's attack against this team's defence) and derives each mirrored pairing as:
```
mirroredPairing(p).value = 100 - attackingPairing(p).value
```
This is **not** a second independent `50 + edge * SENSITIVITY` calculation — it is arithmetically derived from the same computed edge, so `attackingValue + mirroredValue === 100` **exactly**, by construction, for every pairing and for the aggregate. The identity holds even through `clamp(0,100,...)`: for any real `y`, `100 - clamp(0,100,y) === clamp(0,100,100-y)` (trivial by cases: `y<0` → `100-0=100` and `clamp(100-y)=clamp(>100)=100`; `y>100` → `100-100=0` and `clamp(100-y)=clamp(<0)=0`; `0≤y≤100` → both sides equal `100-y`). Verified numerically against real (non-synthetic-formula) pairing data: `stVsCb (67.590909) + cbVsSt (32.409091) = 100.0000000000`, `wmVsFb (54.216756) + fbVsWm (45.783244) = 100.0000000000`, `cmVsCbDm (56.703717) + cbDmVsCm (43.296283) = 100.0000000000`, aggregate `61.177534 + 38.822466 = 100.0000000000`.

Pairing key mirrors (`cbVsSt`, `fbVsWm`, `cbDmVsCm` for role-mode; `cbVsFwd`, `fbVsWideMid`, `cbMidVsCam` for the element-type fallback) live in `engine/counter.js`'s `MIRRORED_PAIRING_KEYS`.

**Composite score: unaffected.** `scoreFixture`'s `WEIGHTS.counterMatchup` still consumes only `calcCounterMatchup`'s aggregate `value` (§8.2) — the mirrored pairings do not feed the composite score, weight, or confidence calculation anywhere. This is a display-only addition to the Matchup Analyser.

**Pairing → named players (`duelsForPairing`).** Each pairing row in the Matchup Analyser carries an info disclosure listing the actual players behind its score. `duelsForPairing(duels, pairingKey)` is a pure filter over an existing `calcIndividualDuels` result (§7.4) — it deliberately does **not** re-identify players, so the info panel can never disagree with the Individual Duels section on the same card. A `PAIRING_ROLE_ALIAS` table collapses all three key families (role-mode `stVsCb…`, element-fallback `fwdVsCb…`, defending mirrors `cbVsSt…`) onto the canonical role-mode key, then filters duels whose `attacker.role` and `defender.role` both fall in that pairing's `ROLE_ATTACK_GROUPS`/`ROLE_DEFENCE_GROUPS`. For a **defending** pairing the relevant duels are the **opponent's** attacking duels, since a defending pairing is their attack against this team's defence. Returns `[]` when duels are unavailable (no summaries / no ICT data), which the UI renders as an explicit "no player data available" state rather than a blank panel.

---

## 7.3 Playing likelihood (`engine/form.js → calcPlayingLikelihood`)

**Purpose:** answer "will this player actually be on the pitch next gameweek?" as a standalone 0–100 metric, so the player projection (§10) can weight it directly rather than relying on it leaking through the form term.

**Inputs — two independent necessary conditions:**
```
startShare   = minutesSecurity * 100          # backward: has he been starting?
availability = chance_of_playing_next_round   # forward: is he fit and permitted?
               ?? STATUS_PLAY_CHANCE[status]  # fallback when FPL gives null

playingLikelihood = min(startShare, availability)      # 0–100, higher = better
```
- **MODEL: `min()`, not a weighted blend.** Either condition alone can rule a player out, so the binding constraint is what matters. A nailed starter who is injured cannot play (→ ~0). A fully fit squad player still won't start (→ his low start share). Averaging the two would wrongly rescue *both* cases — which was precisely the Ranker failure this metric exists to fix: fringe players carrying scores they had no route to delivering.
- **`availability` prefers FPL's own `chance_of_playing_next_round`** — a real percentage FPL publishes from press-conference news, not a proxy. Normalised onto `Player.chanceOfPlayingNext` (see `ARCHITECTURE.md` §8). It is `null` for the majority of players because FPL populates it **only when there is news**, so `null` means *"no doubt reported"*, never *"no data"* — hence the status fallback rather than an `estimated` flag.
- **`STATUS_PLAY_CHANCE`** (`config.js`) maps the internal status string when FPL gives no number: `available: 100`, `doubtful: 50`, `injured / suspended / unavailable: 0`. Doubtful sits at the midpoint because FPL's own scale for a flagged player is 25/50/75; when it declines to give a number, halfway is the honest read.
- **`estimated`** is inherited from the `calcPlayerForm` result passed in: without per-GW history, `minutesSecurity` is the crude season-minutes proxy, so `startShare` is only as good as that.
- Takes an already-computed `PlayerForm` as its second argument rather than recomputing — `scorePlayer` and `engine/chips.js` both already hold one, so this avoids doubling the work per player.

### 7.4 Individual player-vs-player duels (`engine/counter.js → calcIndividualDuels`)

Supplementary to §7.2's position-group aggregate: pairs specific players (a striker against the centre-back he will most likely face) using a likely XI picked by `minutesSecurity` against a 4-4-2 baseline, then scores that single duel with the same `50 + edge * COUNTER_SENSITIVITY` shape. Returns the top 5 by absolute form differential. Consumed by the Matchup Analyser's Individual Duels section and, via `duelsForPairing` (§7.2), by the per-pairing info disclosures. Does not feed the composite.

---

## 8. The composite matchup score (`engine/composite.js → scoreFixture`)

This is where everything combines into the single 0–100 number (per team, per fixture) that drives the whole app.

### 8.1 Default weights (`config.js → WEIGHTS`)
```
WEIGHTS = {
  baseDifficulty:  0.33,   // strength priors — the dependable floor
  counterMatchup:  0.22,   // the signature metric — position form mismatches
  teamForm:        0.18,   // recent trajectory, opponent-adjusted
  homeAway:        0.13,   // venue performance this season
  styleClash:      0.11,   // stylistic interaction — Understat xG-backed (Phase 3A)
  history:         0.03    // H2H nudge (thin data, low trust)
}   // sums to 1.00
```
Rationale for the ordering:
- **Base difficulty (0.33):** by a clear margin the largest weight. Opponent quality is the only sub-metric that is *never* estimated — it is available from day one of a season and does not degrade when player summaries or Understat data are missing. It was 0.30 in Phase 1, cut to 0.25 in Phase 3A to fund the style weight, and raised to **0.33** once it became clear the composite was under-weighting the single most decisive input. **The other five weights were scaled down proportionally (×0.67/0.75 ≈ 0.8933)**, so their relative ordering is untouched and the total still lands on exactly 1.00:

  | Weight | Before | After |
  |---|---|---|
  | `baseDifficulty` | 0.25 | **0.33** |
  | `counterMatchup` | 0.25 | 0.22 |
  | `teamForm` | 0.20 | 0.18 |
  | `homeAway` | 0.15 | 0.13 |
  | `styleClash` | 0.12 | 0.11 |
  | `history` | 0.03 | 0.03 |

- **Counter-matchup (0.22):** still the signature metric and the largest of the secondaries.
- **Form (0.18)** and **home/away (0.13):** strong, well-evidenced signals.
- **Style (0.11):** raised from 0.07 to 0.12 in Phase 3A once real Understat xG / xGA replaced the Phase 1 goals/clean-sheet proxies, then scaled to 0.11 here. Still modest because style interactions are genuinely noisy, but no longer speculative.
- **History (0.03):** deliberately small — H2H data is thin and football H2H is weakly predictive.

> **The base-difficulty weight and the §8.6 stacking penalty are a matched pair.** Raising base difficulty to 0.33 on its own would make a strong favourite's score nearly immovable — no realistic combination of secondary metrics could shift it. §8.6 is what restores the ability of *several* bad secondary signals to tip a fixture, without letting any *single* one do so. Do not tune one without re-checking the other.

### 8.2 Combination
```
linearValue =
    WEIGHTS.baseDifficulty * invert(baseDifficulty)   # §2 direction exception
  + WEIGHTS.counterMatchup * counterMatchup
  + WEIGHTS.teamForm       * teamForm
  + WEIGHTS.homeAway       * homeAway
  + WEIGHTS.styleClash     * styleClash
  + WEIGHTS.history        * history          # all sub-metrics already 0–100

ownRawValue = clamp(0, 100, linearValue - stackingPenalty)   # §8.6 — independent, per-team

# §8.7 — NOT the final value. See §8.7 for why an independent per-team read
# must be compared against the SAME fixture's other team before it's final.
edge  = ownRawValue - opponentRawValue
value = clamp(0, 100, 50 + edge * RELATIVE_EDGE_SENSITIVITY)
```

### 8.3 Confidence handling
- Each sub-metric reports `estimated: true|false`. The composite computes a **confidence** = weighted share of non-estimated metrics. If confidence < `CONFIDENCE_FLOOR` (default 0.6), the UI shows the score as provisional (e.g. hatched/greyed) — the number is still produced, never hidden.
- **MODEL:** estimated sub-metrics are *not* dropped (that would silently re-weight the rest); they pass through at their fallback value (usually 50) and merely lower confidence. This keeps weights summing to 1 and behaviour predictable.

### 8.4 Bands (`config.js → BANDS`)
`value` maps to a band string (drives colour everywhere — see `CONVENTIONS.md` §5.2):
```
67–100 → 'great'
58–66  → 'good'
43–57  → 'neutral'
34–42  → 'tough'
 0–33  → 'brutal'
```
Band thresholds are config, not literals, so the palette can be re-calibrated after observing a season's distribution. Retuned narrower/lower than the original 85/68/46/30 split (which pushed too much of the pool into 'neutral') after observing actual score distributions.

### 8.5 Output shape (matches `ARCHITECTURE.md` §8)
```js
CompositeScore = {
  value: 56,                     // §8.7 — the FINAL, relative-to-opponent value
  band: 'neutral',
  confidence: 0.78,              // §8.7 — min(this team's, opponent's) confidence
  breakdown: {                   // still explains ownRawValue below, unchanged by §8.7
    baseDifficulty: { value: 68, weight: 0.25, estimated: false },
    counterMatchup: { value: 81, weight: 0.25, estimated: false },
    teamForm:       { value: 70, weight: 0.20, estimated: false },
    homeAway:       { value: 75, weight: 0.15, estimated: false },
    styleClash:     { value: 55, weight: 0.11, estimated: false },
    history:        { value: 50, weight: 0.03, estimated: true  }
  },
  stacking: {                    // §8.6 — adjustment ACROSS sub-metrics
    linearValue: 76.4,           // weighted sum before the penalty
    penalty: 3.4,                // points deducted
    stackIndex: 0.27,            // 0–1 severity-weighted share
    countUnfavourable: 2,        // secondaries below the pivot
    consideredWeight: 0.67,      // non-estimated secondary weight in play
    pivot: 45
  },
  relative: {                    // §8.7 — adjustment ACROSS the two teams' totals
    ownRawValue: 73,             // = linearValue - stacking.penalty (76.4-3.4); this
                                 //   is what `value` meant before §8.7 existed
    opponentRawValue: 61,        // the opponent's own independent read, same fixture
    edge: 12,                    // ownRawValue - opponentRawValue
    sensitivity: 0.5             // config: RELATIVE_EDGE_SENSITIVITY
  }
}
// value = clamp(0, 100, 50 + 12 * 0.5) = 56. breakdown/stacking still fully
// explain ownRawValue (73); relative explains the further step from 73 to 56.

---

## 8.6 Stacking penalty (`engine/composite.js → calcStackingPenalty`)

**Purpose:** make the composite behave *conditionally* rather than purely linearly, so a fixture that looks good on the dependable signal stays good when one thing goes wrong, but genuinely tips when several go wrong together.

**The problem with a plain weighted sum.** It degrades linearly: the first poor secondary metric costs a favourite exactly as much as the third does. Real fixtures don't work that way. A side facing a weak opponent still has a strong chance if only one factor is against them — but they genuinely lose that chance when a poor venue record, poor form *and* a losing counter-matchup all arrive at once. A linear model cannot express "resilient to one, vulnerable to three."

**Formula:**
```
STACK_METRICS = [counterMatchup, teamForm, homeAway, styleClash, history]
                # baseDifficulty EXCLUDED — see below

for each m in STACK_METRICS:
    if m.estimated:            skip entirely (do not count its weight)
    consideredWeight += m.weight
    if m.value >= STACK_PIVOT: continue           # metric is fine
    shortfallWeighted += m.weight * (STACK_PIVOT - m.value) / STACK_PIVOT

stackIndex     = clamp(0, 1, shortfallWeighted / consideredWeight)      # 0–1
stackingPenalty = STACK_MAX_PENALTY * (stackIndex ^ STACK_CURVE)        # 0–45
```
- `STACK_PIVOT` = **45**, `STACK_CURVE` = **2.0**, `STACK_MAX_PENALTY` = **45** (`config.js`).
- **The exponent is the mechanism.** Above 1 it makes the punishment *curve* rather than *ramp*. At 2.0 the three-unfavourable case takes roughly **9.8×** the penalty of the one-unfavourable case, despite its stack index being only ~3× larger. Lower toward 1.0 to make secondary metrics bite earlier and more linearly.
- **Same shape and same reasoning as `calcTenurePenalty` (§2.1)** — `MAX * (deficit ^ CURVE)`, curve 2.0. The engine deliberately keeps one idiom for "punish genuine stacking, not incidental single dips."

**Why `baseDifficulty` is excluded:** it is the reading the resilience is measured *relative to*, not one of the things that can pile up against a team. Including it would mean a hard fixture penalised itself twice — once through its own 0.33 weight and again through the stack.

**Why `STACK_PIVOT` sits below 50:** every estimated sub-metric falls back to exactly 50 (§8.3). A pivot at or above 50 would penalise the entire league whenever data is thin — i.e. most of pre-season.

**Why estimated metrics are excluded entirely** (rather than passed through at 50, as §8.3 does for the weighted sum): §1 rule 3 — *absence of information is not evidence of a hard fixture*. A data gap must never manufacture a penalty. The remaining non-estimated weights are re-normalised via `consideredWeight`, so a fixture with only two loaded secondaries is judged on those two, not diluted by three unknowns.

**Worked behaviour** (strong home favourite, `baseDifficulty` 25 = weak opponent, weights as §8.1):

| Scenario | Secondaries below pivot | Linear sum | `stackIndex` | Penalty | Final | Band |
|---|---|---|---|---|---|---|
| One weak secondary (`homeAway` 20) | 1 of 5 | 58.82 | 0.108 | **−0.52** | **58.30** | neutral |
| Three weak (`homeAway` 20, `teamForm` 25, `counter` 30) | 3 of 5 | 46.00 | 0.337 | **−5.10** | **40.90** | tough |
| All five mildly weak (all at 40) | 5 of 5 | — | 0.111 | **−0.56** | — | — |
| All five at 0 (total collapse) | 5 of 5 | — | 1.000 | **−45.00** | — | — |
| Pre-season, all estimated | 0 (skipped) | — | 0.000 | **0.00** | — | — |

The favourite keeps its edge on one bad metric (costs 0.52) but drops **17.40 points and a full band** once three stack. Note the fourth row: *widespread but mild* weakness stays near-free — a merely mediocre side is not the "stacked against them" case, and the curve is what keeps those two situations distinct.

**Explainability:** the adjustment is reported on `CompositeScore.stacking` (see §8.5), not inside `breakdown`, because it is an interaction *across* sub-metrics and has no weight of its own in `WEIGHTS`. Any gap between `stacking.linearValue` and `relative.ownRawValue` is fully accounted for by `stacking.penalty` — **but note `relative.ownRawValue`, not the top-level `value`**, since §8.7. The further gap between `ownRawValue` and `value` is what §8.7's `relative` explains.

---

## 8.7 Relative (zero-sum) composite (`engine/composite.js → scoreFixture`, `computeRawFixtureScore`)

**Purpose:** make the two teams' total composite scores for the same fixture sum to exactly 100, so a score reflects genuine relative strength between the two sides rather than each side being marked against a fixed internal scale independently of who they're actually playing.

**The problem this fixes.** Every sub-metric above (§2–§7) is computed independently per team, against a fixed scale, with no reference to the opponent's own equivalent read. Concretely, `calcBaseDifficulty(team, opponent, ...)` normalises the **opponent's** raw strength against the fixed `OPP_STRENGTH_MIN/MAX = 1000/1400` — it never looks at `team`'s own strength. The consequence, traced with real numbers:

| Fixture | A's baseDifficulty term | B's baseDifficulty term | Sum (should track ~33 for zero-sum) |
|---|---|---|---|
| Two weak teams (strength 1000 vs 1000) | 33.0 | 33.0 | **66.0** — both rewarded for facing a "soft" opponent |
| Two strong teams (strength 1400 vs 1400) | 0.0 | 0.0 | **0.0** — both punished for facing a "tough" opponent |
| Uneven, not extreme (1400 vs 1200) | 16.5 | 0.0 | **16.5** — no consistent relationship at all |

(baseDifficulty is one of six weighted terms; the same independence applies to `teamForm`, `homeAway`, `styleClash`, `counterMatchup`, `history` — none of them compare team A's read to team B's either.) Two strong teams shouldn't both score harshly just because the opponent is individually tough, and two weak teams shouldn't both score well just because neither is "objectively good" — what matters is whether either side has a real edge over the other, and today's independent absolute reads cannot express that.

**Design.** `scoreFixture` no longer returns an independent per-team read directly. The old function body — every sub-metric, the weighted sum, and the §8.6 stacking penalty, all completely unchanged — is now `computeRawFixtureScore(team, opponent, fixture, isHome, ctx)`, an internal (not exported) helper producing the **independent** pre-relative value (`ownRawValue`). `scoreFixture(team, fixture, ctx)` calls this helper **twice** — once for `team`'s own perspective, once for the opponent's — and derives the final value from their difference:

```
ownRawValue      = computeRawFixtureScore(team, opponent, ...).value        # §2-§8.6, unchanged
opponentRawValue = computeRawFixtureScore(opponent, team, ...).value        # same formula, swapped

edge  = ownRawValue - opponentRawValue
value = clamp(0, 100, 50 + edge * RELATIVE_EDGE_SENSITIVITY)               # RELATIVE_EDGE_SENSITIVITY = 0.5
```

**Why this guarantees zero-sum BY CONSTRUCTION, not coincidence.** `scoreFixture(opponent, fixture, ctx)` computes the *identical* `(ownRawValue, opponentRawValue)` pair in swapped roles, so its value is *always* `clamp(0, 100, 50 - edge * RELATIVE_EDGE_SENSITIVITY)` — literally 100 minus this team's pre-clamp figure. `clamp(0,100,v) + clamp(0,100,100-v) ≡ 100` is a general identity for clamp-to-`[0,100]`, true for every real `v` (trivial by cases: below 0 one side clamps to 0 and the other's mirror exceeds 100 and clamps to 100; above 100 the reverse; in range neither clamps and they sum algebraically). This is the same "derive, don't independently compute" principle §7.2 already uses for the mirrored counter-matchup pairings (`mirroredValue = 100 - attackingValue`) — extended here to the whole fixture total. Verified by exhaustive sampling (20,000 random `(ownRawValue, opponentRawValue)` pairs spanning the full `[0,100]²` input space, including clamp-saturating extremes): worst observed `|sum - 100|` was `0` to floating-point precision.

**`RELATIVE_EDGE_SENSITIVITY = 0.5` is not an arbitrary softening constant.** At exactly 0.5, an edge spanning the theoretical full range (`ownRawValue=100, opponentRawValue=0`, edge=±100) maps to the full `[0,100]` output range with the clamp only ever touching the boundary exactly, never saturating early. Raising it above 0.5 makes *smaller* real edges reach 0/100 sooner (a more binary read of a given gap); it does not affect the zero-sum guarantee, which holds at any sensitivity value via the identity above.

**This does NOT flatten every fixture toward 50/50 — and does NOT touch the promoted-team logic.** `calcBaseDifficulty` and `calcTenurePenalty` (§2, §2.1) are completely unchanged; a promoted side's `ownRawValue` still comes out low (their opponent's undiminished strength inverts to near-0) and an established side's `opponentRawValue` reading of that same promoted side is still pulled further down by the tenure penalty. Both of those genuine, real differences flow straight into `edge` — a big real gap produces a big edge, and therefore a lopsided (not 50/50) split. Only the *relationship* (sum ≈ 100) is new; the *size* of the split is still driven entirely by the real, unmodified strength/form/tenure gap between the two teams.

**Worked examples** (`WEIGHTS` and `STACK_*` as §8.1/§8.6; `own`/`opp` = each team's independent `computeRawFixtureScore`):

| Fixture | A's raw (independent) | B's raw (independent) | edge | **A's final** | **B's final** | Sum |
|---|---|---|---|---|---|---|
| Two weak teams (Ipswich vs Hull, strength 1000/1000, near-identical mediocre form) | 64.77 | 64.77 | 0.0 | **50.0** | **50.0** | **100.0** |
| Two strong teams (Man City vs Arsenal, strength 1400/1400, both in form) | 39.01 | 39.01 | 0.0 | **50.0** | **50.0** | **100.0** |
| Promoted vs established (Arsenal, full tenure, vs Coventry, tenure 0.0 — realistic secondaries: Coventry's own form/venue/counter also weak, Arsenal's strong) | 73.98 | 22.52 | 51.46 | **75.73** | **24.27** | **100.0** |

The first two rows are the direct fix: under the old model neither team's absolute raw read was itself meaningful evidence of an edge — Ipswich and Hull both land at 64.77 (both reading a weak opponent generously) and City/Arsenal both land at 39.01 (both reading a tough opponent harshly), yet in both cases the two sides are IDENTICAL, so the honest relative read is exactly 50/50. What matters is the *difference* between the two reads, not their shared absolute level — and that difference is genuinely 0 when neither side has a real edge. The third row shows the promoted-team asymmetry surviving completely intact: a **75.73 / 24.27** split, clearly lopsided, still summing to exactly 100.

**Downstream effects — verified, not assumed:**
- `scoreOverHorizon`, `rankPlayers`, `scorePlayer`, and every module (`ranker.js`, `dashboard.js`, `planner.js`, `matchup.js`) read only `.value`/`.band`/`.confidence`/`.provisional`/`.breakdown` — all still present with the same types, so nothing breaks structurally. The *numbers* shift (by design): a player's fixture outlook is now genuinely "how favourable is this specific matchup" rather than "how strong is my team in the abstract" — an intended, more meaningful ripple into `scorePlayer`'s `PROJ_FIXTURE` term, not a bug.
- `confidence` is now `min(own, opponent)` confidence, not just `team`'s own — because the final value depends on both sides' reads, it can only be as trustworthy as the less-certain one. Both teams' Matchup Analyser cards for the same fixture will now show the *same* confidence percentage; this is intentional (§8.5).
- `CompositeScore.breakdown` still explains `relative.ownRawValue` exactly (§8.5/§8.6's identities hold for `ownRawValue`), but no longer arithmetically reconstructs the top-level `value` on its own — `relative` is required to close that gap. The Matchup Analyser's existing breakdown rows are unchanged and still correct for what they show (`ownRawValue`'s composition); they do not currently render the new `relative` field. Flagged as a follow-up, not implemented here (out of this change's scope): surfacing `relative.opponentRawValue`/`edge` somewhere on the card would let a user see *why* the headline number differs from a manual sum of the breakdown rows.
- Perf: `scoreFixture` now does roughly double the internal work per call (`computeRawFixtureScore` runs for both sides every time). `engine/chips.js` already memoises `scoreFixture` per `(team, fixture)` pair (`makeFxCache`), so chip planning is unaffected. `rankPlayers`/`scorePlayer` have no such cache and call `scoreOverHorizon` (and therefore `scoreFixture`) once per player with no memoisation across players sharing a team — this was already uncached before this change; it is now roughly twice as expensive per call. Not addressed here (a caching layer for `scorePlayer`/`rankPlayers` is a separate concern, unscoped for this change) but worth knowing if Ranker load time is ever noticeably slow.

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
    PROJ_FORM   * player.form.value                    # is HE in form?
  + PROJ_FIXTURE* teamHorizonScore(player.teamId)      # are the FIXTURES good?
  + PROJ_COUNTER* playerCounterEdge(player, horizon)   # does HIS position matchup favour him?
  + PROJ_MINUTES* playingLikelihood(player)            # will he actually START? (§7.3)
```
- Defaults: `PROJ_FORM = 0.36`, `PROJ_FIXTURE = 0.28`, `PROJ_COUNTER = 0.16`, `PROJ_MINUTES = 0.20` (`config.js`). **Sums to 1.00.**
- `playerCounterEdge` pulls the specific pairing the player participates in (a striker gets the FWD-vs-CB pairing of each fixture in the horizon), so the counter-matchup is personalised to his role, not just his team's average.
- Output: `{ value, band, perGw, breakdown, valueScore, avgPointsPerGw, costPerPoint, nextFixtureScore }` where `valueScore = value / price` (points-per-million proxy) for budget-aware ranking.

**`PROJ_MINUTES` — playing likelihood as a first-class term.**

Minutes-security previously reached the composite only *indirectly*, through `W_MINUTES` inside `calcPlayerForm` (§7.1). That gave it just `0.45 × 0.30 ≈ 13.5%` of the score — enough to nudge, not enough to stop a high-per-90 rotation risk out-ranking a nailed starter. The Ranker showed exactly that failure. `PROJ_MINUTES` promotes it to a term of its own, sourced from §7.3.

The three existing weights were scaled down proportionally (**×0.80**) to make room, so the total still lands on exactly 1.00:

| Weight | Before | After |
|---|---|---|
| `PROJ_FORM` | 0.45 | 0.36 |
| `PROJ_FIXTURE` | 0.35 | 0.28 |
| `PROJ_COUNTER` | 0.20 | 0.16 |
| `PROJ_MINUTES` | — | **0.20** |

- **MODEL: this deliberately double-counts minutes.** `W_MINUTES` still sits inside the form term, so total minutes influence is now ≈33%. That is intended, not an oversight: minutes matter twice over in FPL — once as evidence a player is actually performing, and again as the probability he takes the pitch at all. Reducing `W_MINUTES` to compensate was **rejected** because `calcPlayerForm` also feeds `engine/counter.js`'s unit-form reads and the Individual Duels (§7.4), so lowering it would silently move counter-matchup numbers too.
- Measured effect on a player held at form 62 / fixture 70 / counter 60, varying only minutes-security: the Guaranteed-vs-Risk spread attributable to this input rises from **0.00 → 16.00 points**. A rotation punt on 67.1 drops to 59.7 while a nailed starter on 64.4 rises to 70.5 — i.e. the two swap rank. Worked table:

  | `minutesSecurity` | Playing likelihood | Score before | Score after | Δ |
  |---|---|---|---|---|
  | 0.15 | 15 | 64.40 | 54.52 | −9.88 |
  | 0.30 | 30 | 64.40 | 57.52 | −6.88 |
  | 0.50 | 50 | 64.40 | 61.52 | −2.88 |
  | 0.75 | 75 | 64.40 | 66.52 | +2.12 |
  | 0.95 | 95 | 64.40 | 70.52 | +6.12 |

- Reported on `breakdown.minutes` as `{ value, weight, estimated, startShare, availability, availabilitySource }`. Both halves are exposed so the UI can distinguish *benched* (low `startShare`) from *injured* (low `availability`) — they score alike but mean different things.
- **`engine/chips.js` inlines this same four-term blend** for single-fixture chip evaluation. Any change to the `PROJ_*` set must land there too, or chip advice silently diverges from the Ranker/Dashboard/Planner.

**Phase 5 additions (Player Ranker):**

- **`avgPointsPerGw` (`calcAvgPointsPerGw(player, ctx)`)** — `{ value, estimated }`, average FPL points per gameweek THIS season. Prefers real per-GW `history[]` from an already-loaded player summary (mean of `history[].points`, `estimated: false`) — FPL's history payload has one entry per elapsed gameweek regardless of whether the player featured (0 points for a blank week), so this is already a true weekly average. Falls back, when no summary is loaded (or its `history[]` is empty), to `player.totals.points ÷ elapsedGws`, where `elapsedGws` is the count of distinct gameweeks in `ctx.playedFixtures` (`estimated: true`). Pre-season, `elapsedGws` is genuinely `0`, so this is genuinely `0` for every player — real information, not a bug, and this function does **not** substitute anything else in for it (see §10.1 for the explicit alternative view). **Divides by gameweeks elapsed this season, not by games the player actually appeared in** — a player who scored 10 points in GW1 and then missed GW2–4 averages `10/4 = 2.5`, not `10/1 = 10`; dividing by appearances instead would make a fringe player's one big week look like elite sustained output. **Never triggers a bulk player-summary fetch** — uses only `ctx.playerSummariesById`, which is populated lazily as the user clicks into players elsewhere in the app (ARCHITECTURE.md §3 rule 7).
- **`costPerPoint`** — `player.price / avgPointsPerGw.value`, or `null` when `avgPointsPerGw.value` is 0 (never `NaN`/`Infinity`; the ranker displays `null` as "—"). **This is the inverse ratio direction from `valueScore`** (money spent per point vs. points per million) — the two must never be merged or treated as the same figure. `valueScore` answers "how much projected score do I get per pound"; `costPerPoint` answers "how much does each point actually cost". **Reads the exact same `avgPointsPerGw` value the Ranker's Avg Pts/GW column displays** — there is no independent computation, so whenever that column is populated, Cost/Pt is automatically populated too, with no separate wiring. In the Ranker's "Last Season" toggle mode (§10.1), Cost/Pt is instead derived from `calcLastSeasonAvgPointsPerGw`'s value — same derivation, different input, computed in the module layer (`buildLastSeasonLookup`) rather than by `scorePlayer` itself.
- **`nextFixtureScore`** — `{ value, estimated }`, a 0–100 blend of *only* `breakdown.fixture.value` and `breakdown.counter.value` (form excluded), re-normalised over `PROJ_FIXTURE + PROJ_COUNTER` since `PROJ_FORM` drops out of the blend: `(PROJ_FIXTURE × fixture.value + PROJ_COUNTER × counter.value) / (PROJ_FIXTURE + PROJ_COUNTER)`. Answers "is this player's next fixture favourable", independent of whether he's personally in form. Derived from the SAME `horizonResult`/`counterEdge` values `scorePlayer` already computes — not a new metric. The Ranker shows this alongside a rank position among the currently-filtered player set (not the full ~700), since a bare rank number without its underlying score isn't explainable on its own.

### 10.1 "Avg Pts/GW source" toggle (`calcLastSeasonAvgPointsPerGw`, Ranker only)

**History:** an earlier version of this section documented an *automatic* pre-season fallback — `calcAvgPointsPerGw` would silently substitute last season's average whenever `elapsedGws <= 0`. That design was reverted: it turned out to be practically inert, because the player summaries it depended on are only ever lazily loaded when the user clicks into a player (which immediately navigates away to Matchup), so nothing ever populated it from browsing the Ranker alone. Rather than auto-loading summaries to make an invisible fallback work, the feature became an **explicit, user-controlled toggle** instead — simpler to reason about, and the user chooses when the (deliberately bulk) load happens rather than it happening silently.

**What it is:** a button in the Ranker's filter panel ("This Season" / "Last Season") that switches what the **Avg Pts/GW** and **Cost/Pt** columns display:
- **"This Season"** (default) — the ordinary `calcAvgPointsPerGw`/`costPerPoint` from §10 above, unchanged. Shows a real `0` pre-season, since that's genuinely what has happened so far.
- **"Last Season"** — every player's most recent **past** season average instead, via the new `calcLastSeasonAvgPointsPerGw(player, ctx)`: `lastSeasonPoints ÷ SEASON_GWS` (config.js, 38), sourced from `historyPast` (the same lazily-loaded `element-summary` payload that already provides current-season `history[]` — no new endpoint). Always rendered with the `~` estimated marker and a tooltip naming the season (e.g. "2025/26's average — not this season's"), since by definition it isn't this season's number, current-season or not.

**Why bulk-loading here doesn't violate the no-bulk-fetch rule:** ARCHITECTURE.md §12 non-goal 7 / §3 rule 7 forbid *automatically* fetching all ~700 player summaries on load or in the background. Clicking "Last Season" is neither — it is a single, deliberate, user-initiated action, staggered into chunks of `SUMMARY_FETCH_CHUNK_SIZE` (config.js, 20 — deliberately smaller than `RANKER_CHUNK_SIZE`'s 50, since these are real network requests through the proxy, not just CPU-bound scoring) with a yield between each chunk so the page stays responsive. Switching back to "This Season" cancels any in-flight load via an incrementing run-id guard (`_summaryLoadRunId`), mirroring the existing `_computeId` staleness-guard pattern `rebuildRowsChunked` already uses.

**Three display states per row, not two** (`modules/ranker.js → buildRow`, fed by `buildLastSeasonLookup`):
1. **Not loaded yet** (bulk load still in flight, or not yet triggered for this player) — a muted "…" placeholder, not a dash, so it doesn't read as "no data exists".
2. **Loaded, no past-season record** — a definitive "—": this player genuinely has no prior-season history (e.g. a new arrival to the league), not an in-progress load.
3. **Loaded, real value** — the last-season average/cost, flagged `~` as described above.

Sorting by Avg Pts/GW or Cost/Pt while in "Last Season" mode sorts by these same displayed values (`applySort`'s `lastSeasonByPlayerId` parameter), not the current-season ones underneath — otherwise the sort arrow would silently contradict what's on screen. Both column headers append "(last season)" while the toggle is active, so the meaning is clear even scrolled away from the toggle button itself.

**Worked example, real data** (fetched live from `bootstrap-static`/`element-summary`, player id 12, "Saka"):

| | "This Season" | "Last Season" (after load) |
|---|---|---|
| `history[]` (current season) | empty (pre-season) | *(not read by this view)* |
| `avgPointsPerGw.value` / display | `0`, real | `historyPast` most recent entry `{ seasonName: '2025/26', points: 157 }` → `157 / 38 = 4.13` → displayed **4.1~** |
| `costPerPoint` (price = £9.5m) | `null` → displayed **"—"** | `9.5 / 4.131579 = 2.30` → displayed **£2.30m~** |

Confirms the same underlying arithmetic as before — only how (and when) it's surfaced has changed: a real `0` is always available on the default tab, and the last-season figure is only ever shown when the user explicitly asks for it.

---

## 11. How the engine feeds each module

| Module | Primary engine call | What it shows |
|---|---|---|
| **Matchup Analyser** (`modules/matchup.js`) | `scoreFixture(team, fixture)` for **both** sides | Full side-by-side breakdown of one fixture: each sub-metric, the counter-matchup pairings (each with an info disclosure naming the players behind it, via `duelsForPairing` §7.2), style clash, confidence. The "view source" for any score elsewhere. Since §8.7, the two cards' `value`s are guaranteed to sum to 100 — a genuinely relative read of the matchup, not two independent absolute scores. |
| **Player Ranker** (`modules/ranker.js`) | `rankPlayers(players, horizon)` → sortable by `value`, `costPerPoint`, `price`, or `minutesSecurity` | Ranked, filterable table (position, price threshold, team, minutes-security) of projected value over the active horizon — permanent Value and Cost/Pt columns, Avg Pts/GW, Next Fixture (rank + score), and a per-GW fixture strip per player. |
| **GW Dashboard** (`modules/dashboard.js`) | `scorePlayer(p, HORIZON.GW1)` for owned squad + `event/<gw>/live` | Captaincy pick (top projection in squad), start/bench order, risk flags (low minutesSecurity, brutal band, low confidence), and live points when the GW is in progress. Horizon-locked to GW1. |
| **Transfer Planner** (`modules/planner.js`) | `rankPlayers` over horizon + current squad + constraints | For each candidate out→in swap, computes Δ projected horizon score; ranks transfers by gain per cost, respecting budget and free transfers (−4 hit modelled). Surfaces the moves that most raise total projected score over the horizon. |

All four read the **same** scores and breakdowns. No module recomputes a metric. If a module needs a number the engine doesn't expose, add it to the engine and its breakdown — never inline it (see `CONVENTIONS.md` §11).

Because Ranker, Dashboard and Planner all obtain player scores from `scorePlayer`, engine-level changes to the `PROJ_*` blend (such as `PROJ_MINUTES`, §10) propagate to all three with no per-module code. `engine/chips.js` is the **one** exception — it inlines the same blend for single-fixture chip evaluation and must be updated in lockstep.

---

## 12. Tuning & validation guidance (for whoever maintains the model)

- **Single source of tunables:** every constant named in this doc is in `config.js`. Tuning the model = editing `config.js`, never editing formulas.
- **Sanity benchmark:** after any weight change, spot-check a handful of fixtures whose outcome is intuitively obvious (a top side at home to a bottom side should land 'great'; a poor side away to a top side should land 'brutal'). If it doesn't, the weights or a metric's direction is wrong.
- **Backtesting (Phase 3):** persist each GW's pre-deadline scores and compare against actual points to calibrate weights empirically. Until then, weights are informed priors, explicitly documented here so they can be argued with.
- **Direction bugs are the #1 risk.** A single inverted metric quietly poisons the composite. Every metric function must restate its direction in its JSDoc (`CONVENTIONS.md` §7.2).

---

## 13. Rank-relative player colouring (`engine/composite.js → calcRankTier`, `attachRankTiers`)

**Purpose:** make the standout players — genuinely worth squad consideration, or genuinely not — visually pop in the Ranker, Dashboard, and Planner, regardless of how the absolute 0–100 scale happens to be distributed this season.

**This is a SEPARATE axis from `BANDS` (§8.4), not a replacement.** `score.band` classifies a value against the fixed 0–100 scale — it answers "is this an objectively good score". `rankTier` classifies a player against the **current pool** — it answers "does this player stand out relative to everyone else right now". A season where scores cluster low (thin early-season data, most sub-metrics still estimated) would leave `BANDS` unable to distinguish the genuinely best players from the merely-average ones; `rankTier` still can, because it only cares about relative ordering.

**Tiers and precedence** (`config.js`):
```
RANK_ELITE_COUNT_BY_POS  = { GKP: 2, DEF: 5,  MID: 5,  FWD: 3 }   # fixed count, per position
RANK_STRONG_COUNT_BY_POS = { GKP: 5, DEF: 15, MID: 15, FWD: 8 }   # fixed count, per position
RANK_BOTTOM_PERCENTILE   = 0.50                                  # fraction of the pool, POOL-WIDE

calcRankTier(index, poolSize, positionIndex, position):
    # index/poolSize: 0-based rank / size in the WHOLE pool (0 = best)
    # positionIndex:  0-based rank among players of the SAME position only
    if positionIndex < RANK_ELITE_COUNT_BY_POS[position]:                return 'positionElite'
    if positionIndex < RANK_STRONG_COUNT_BY_POS[position]:               return 'positionStrong'
    if index >= poolSize * (1 - RANK_BOTTOM_PERCENTILE):                 return 'bottomPercentile'
    else:                                                                return null
```
**The two "worth considering" tiers are PER-POSITION, not pool-wide.** This was a deliberate correction: the original pool-wide design (a straight top-N or top-X% cut across all 700+ players regardless of position) systematically buried Forwards — there are far fewer of them (3 squad slots vs 5 for DEF/MID) and their scores don't reliably cluster as high as cheap Defenders', who post a similar composite score in bulk. Verified with a simulated pool matching this exact pattern (many strong/cheap DEF, few strong FWD, realistic ~700-player split): the **old** pool-wide top-30 rule gave Forwards **0 of 30 slots**; the **new** per-position rule guarantees Forwards their own 3 elite + 5 more strong (8 total) regardless of how DEF's scores bunch up. `bottomPercentile` stays pool-wide by contrast — there's no equivalent "hidden gem" concern to correct for at the bottom; a weak player is weak regardless of which position shares the flag with him.

Tier names describe their **role** (mirroring the `RANK_*` config constant names), not the current threshold numbers — a name baked to a specific figure (e.g. the original `'top30'`/`'top10'`, which went stale within the same week they were introduced, first retuned to 15/20% and then redesigned entirely to be per-position) silently drifts out of sync the next time any constant is retuned.

The three tiers are checked **most-specific first**: `positionElite` before `positionStrong` before `bottomPercentile`, even though a position-elite player is always also position-strong (the elite count is always ≤ the strong count for every position). `positionElite` is the smaller, "definitely worth considering" flagship signal within that position — checking it first stops it being silently absorbed into the wider tier. **A player outside all three tiers (`rankTier === null`) keeps their existing `BANDS` colour unchanged** — this system only overrides colour for the standout tiers; the unremarkable middle is not the point of the feature and is left alone.

`attachRankTiers` derives each player's `positionIndex` in a single pass over the already pool-wide-sorted array — counting occurrences of each position as it goes (advancing that position's own counter only when it meets another player of it) reproduces the same descending order restricted to one position, with no second sort needed. Verified against an independent brute-force per-position sort across a simulated 700-player pool: 0 mismatches. Also verified per-position: `positionElite`/`positionStrong` counts land exactly on the configured numbers for every position (e.g. FWD: exactly 3 elite, exactly 8 total elite+strong), and `bottomPercentile`'s pool-wide total (350 of 700) is unaffected by the per-position change.

**Colour tokens (`base.css`):** `bottomPercentile` and `positionElite` reuse the existing `--band-brutal` (red) and `--band-great` (green) — no new hex for those two, per CONVENTIONS.md §5.3. `positionStrong` needed a genuinely new colour distinct from both existing greens; the first attempt (`--band-lime`, `#a3e635`, a true lime) read too bright against the app's dark palette, so it was replaced with a softer, more desaturated **`--band-light-green`** (`#6fcf78`) plus `--band-light-green-bg`, added alongside the five existing band tokens, same naming convention. Rendered via three new CSS classes (`components.css`): `.score-chip--rank-green`, `.score-chip--rank-light-green`, `.score-chip--rank-red` — deliberately **not** named after the `BANDS` classes they happen to share a colour with (`.score-chip--great` etc.), because they are a different classification mechanism and conflating the two in the DOM would make a future reader unable to tell "scored 85+" from "ranked position-elite" just by reading the class name. A chip renders **both** its `BANDS` class and (when applicable) its rank-tier class together; the rank-tier rules are declared after the five band rules in `components.css` so they win the cascade at equal specificity, with no `!important` and no JS class-stripping needed.

**Player pool scope — the FULL pool, not the currently-filtered view.** Ranker's rank tiers are computed against every loaded player (`store.getPlayers()`), **before** `applyFilters()` narrows the table for display — "top 5 Forwards in the game" must mean the same thing whether the position filter is set to "FWD only" or "all", and must match what Dashboard and Planner (which have no filters at all) compute for the same players. Dashboard and Planner each maintain a squad of ~15 players with no natural "pool" of their own, so both compute the same full-pool ranking `rankPlayers(store.getPlayers(), horizon, ctx)` + `attachRankTiers(...)` and cache a `playerId → rankTier` lookup, reused across squad edits. Ranker's tooltip text for each chip is built from the player's own position and the live `RANK_ELITE_COUNT_BY_POS`/`RANK_STRONG_COUNT_BY_POS` values (`rankTierTitle`), not a single fixed string, since the count now varies by position.

**Cost, and why it's cached, not recomputed per edit.** A full-pool ranking scores every loaded player — the same cost the Ranker already accepts as normal (it does this on every load/horizon change via chunked async scoring). The ranking depends only on `(ctx, horizon)`, **not** on squad membership, so Dashboard and Planner compute it **once** per data load (and, for Planner, once per horizon change — its horizon can change via the global switcher; Dashboard is locked to GW1 so only data-load invalidates it) and reuse the cached lookup across every subsequent squad add/remove. Recomputing on every edit would re-score ~700 players per click for no reason.

**Where it's shown:** the single headline "Value" score chip in each module (Ranker's Value column; Dashboard's captain/XI/bench/squad-slot chips; Planner's squad-slot and transfer in/out candidate chips) — the number that represents overall player quality. Deliberately **not** applied to the Ranker's Next Fixture chip, the per-GW fixture strip, or the minutes-security badge: those are different, narrower metrics (fixture favourability, per-GW difficulty, playing time) with their own meaning, and colouring them by overall-value rank would misrepresent what they show.
