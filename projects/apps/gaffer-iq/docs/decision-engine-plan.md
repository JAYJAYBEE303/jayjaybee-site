# Decision engine plan (Phase 0)

Date: 2026-10-16, revision 2 on 2026-10-17 (after an adversarial review of
revision 1 against the code and the brief: 58 findings, 44 confirmed and folded
in below).
Status: **approved**; grill-me questions Q1-Q10 answered (§7). Phase 1 done
(`f4ef63f`); Phase 2 done (`cfad609`); Phase 3 done (`3870fc1`, review fixes
`94d309a`); UI phase done (`17db173`, review fixes `3564ffc`); Phase 4 done
(`a713624`); Phase 5 done, awaiting your check. Where the build departed from this plan, the text below
was updated to match it.
Brief: `fpl-decision-engine-brief.md` (16 Oct 2026). Section numbers below
(§3, §5 ...) refer to the brief unless prefixed with a file name.
Scope: `projects/apps/gaffer-iq/` only. Branch:
`Refactor/gaffer-IQ-transfer-suggestion-engine-redesign`.

## Primary goal

When you open the Transfer Planner, each of the six modes shows one move (or
"Roll"), scored by what it does to your whole squad over that mode's horizon,
with the reasons behind it laid out so you can check it before you act. A bench
filler is never offered as a sell just because his own numbers are low, and a
captain is never sold without the loss of the armband being counted.

---

## 1. Inventory: where the current transfer feature lives

### 1.1 Engine (pure JS, no DOM)

| File | Symbol | Role |
|---|---|---|
| `js/engine/transfers.js:195` | `enumerateSwaps` | Enumerates every single swap from a 40-per-position candidate pool and scores it on six lanes. |
| `js/engine/transfers.js:49` | `memoScore` | Per-window `scorePlayer` cache (three windows: `long`, `now1`, `far`). |
| `js/engine/transfers.js:91,128` | `candidateProxyScore`, `buildCandidatePools` | Season points per elapsed GW, top `CANDIDATE_POOL_PER_POS` (40) per position. |
| `js/engine/transfers.js:434` | `calcSquadFlexibility` | Price-clumping / headroom index (feeds the `cashCrunch` trigger). |
| `js/engine/transfers.js:491,552,610,693` | `scoreFutureLane`, `scoreFundsLane`, `scoreCeilingLane`, `scoreStructureLane` | Four of the six lanes. Now and Long term are inline at `:337-353`. |
| `js/engine/strategy.js:233` | `buildVerdict` | Normalises lanes by hand-calibrated `LANE_SCALE_*` divisors, ranks them, applies triggers, emits one weekly verdict or "roll". |
| `js/engine/strategy.js:93` | `detectTriggers` | `xiPlayerUnavailable`, `chipWindow`, `cashCrunch`, `priceDeadline`. |
| `js/engine/lineup.js:44` | `pickStartingXI` | Greedy XI + bench order by `expectedPoints`. **Shared with the Dashboard** (`js/modules/dashboard.js:515`). |
| `js/engine/lineup.js:91` | `calcXiExpectedPoints` | XI sum + `BENCH_CONTRIBUTION_WEIGHT` (0.15) x bench. The quantity every lane differences. |
| `js/engine/prices.js:36` | `calcPriceChangeRisk` | Price-move guess from in-GW transfer flow. Used by the Funds lane and the planner's "Buy now" note. |
| `js/engine/chips.js:125-321` | `score*Timing` | Chip week recommendations; feed the `chipWindow` trigger and the run's chip pills. Imported only by the planner. Wildcard and Free Hit timing are league-wide fixture reads; Bench Boost uses a proxy bench (the 4 lowest composite scores, `planner.js:563-570`) and Triple Captain inlines the `PROJ_*` blend with this week's availability carried flat (`chips.js:321-371`). |

### 1.2 Module / UI

| File | What |
|---|---|
| `js/modules/planner.js` (1,686 lines) | The whole Transfer Planner view. Verdict "tape" (Out -> In) `heroHTML:812`; run settings bar `renderCmd:925`; "the run" (six staged weeks of moves and chips, plus the only "Mark used" / "Place in GW" chip controls) `renderRun:984`, `weekHTML:946`; move tray with lens radio `renderTray:1043`; squad drawer `renderDrawer:1177`; import `handleImport:1506`; enumeration driver `computeBoards:462`; chip recs `computeChipRecs:601`; planning-GW logic `getPlanningTiming:233`, `buildCtx:277`. |
| `js/modules/planner-boards.js` | `LANE_BOARDS` (six boards, titles, blurbs, units), `LANE_DIRECTIONS`, `timingNote` (the live-round warning), `emptyMessage`. |
| `js/modules/planner-run.js` | `evaluateRun`: FT rolling (cap 5), hits, bank carry, 3-per-club, one chip per week. Pure, module layer. |
| `index.html:437-535` | Planner markup: hero, settings bar (bank, FT 1/2, hits, squad, save), run, tray, drawer, toast, dialog. `index.html:147`: the landing card for the planner ("+6 ... Your moves across the next six gameweeks"). |
| `css/planner.css` (334 lines) | Every rule nested under `.pl` as flat siblings; tokens from `css/base.css`. |
| `js/main.js:30-32, 490-527` | `window.__engine` exposes `enumerateSwaps`, `buildVerdict`, `calcXiExpectedPoints`, `calcSquadFlexibility` (`window.__verify` at `:538` builds on it). |
| `index-FXL00-CK7M8F4.html` | A stale old index page with an old planner section (`:138-160`). Nothing links to it, but it loads `js/main.js` and is served (`vercel.json` `outputDirectory: "."`). |

### 1.3 Data, routes, persistence

There are **no database tables** anywhere (see §3). The feature's state is:

- Route: hash route `#planner` (`js/main.js` router).
- Proxy routes used: `entry/{id}/event/{gw}/picks/`, `entry/{id}/` (`api/fpl.js:34-35`). `me/` is allowlisted (`:36`) but useless: the proxy forwards no credentials, and must not.
- `sessionStorage`: season payload, squad ids and imported picks (`js/store.js:190-199, 400-441`).
- `localStorage`: `gafferiq_planner_run` (staged run; also the only place bank, FTs and the hit setting are saved), `gafferiq_chips_used` (one season-long set, although chips reissue after GW19, `config.js:998`), `gafferiq_fpl_team_id`.

### 1.4 Config and tests

- `js/config.js:1294-1461`: `XI_FORMATION_MIN`, `HIT_PENALTY`, `BENCH_CONTRIBUTION_WEIGHT`, window constants, `CANDIDATE_POOL_PER_POS`, `FUNDS_MIN_CASH_FREED`, `FLEX_*`, `CEILING_*`, `HAUL_POINTS_THRESHOLD`, `STRUCTURE_PLAYTIME_FLOOR`, `LANE_SCALE_*`, `VERDICT_*`.
- Tests: `tests/engine/transfers.test.js`, `strategy.test.js`, `lineup.test.js`, `tests/modules/planner-run.test.js`.
- Docs: `FEATURE_ENGINE.md` §14 (lines 1215-1354); `ARCHITECTURE.md:171-172,190-192`; `ROADMAP.md:85-87` (§2D); specs `docs/superpowers/specs/2026-08-30-planner-multi-lens-transfers-design.md` and `2026-09-07-planner-horizon-split-and-value-funds-design.md`; `GAFFER_IQ_TESTING_ROADMAP.md:267-431`.

### 1.5 The six existing modes

They already exist as the six boards (`planner-boards.js:35`), so the brief's
six presets map one to one:

| Brief mode | Current board id | Current window and ranking |
|---|---|---|
| 1 Now | `now` | 1 GW, XI delta |
| 2 Long term | `longterm` | 5 GWs, XI delta x 5 |
| 3 Future prep | `future` | GWs 3-5, XI delta x 3 |
| 4 Funds & flexibility | `funds` | 5 GWs, points gained per GBP m freed |
| 5 Ceiling | `ceiling` | incoming player's own peak week + haul rate |
| 6 Structure fix | `structure` | flagged / low playtime / bottom-percentile starter, XI delta x 5 |

### 1.6 Current flow

```mermaid
flowchart TD
  A[data:ready / route:changed<br/>planner.js:1606,1626] --> B[scoreSquad<br/>planner.js:416]
  B --> C[ensureRankTiers: rank full pool, ~920 ms<br/>planner.js:443]
  A --> D[computeChipRecs<br/>planner.js:601]
  D --> E[computeBoards<br/>planner.js:462]
  E --> F[enumerateSwaps<br/>transfers.js:195]
  F --> G[scorePlayer x 3 windows, memoised<br/>composite.js:1101]
  F --> H[calcXiExpectedPoints before/after<br/>lineup.js:91]
  F --> I[six lane scorers<br/>transfers.js:337-369]
  E --> J[buildVerdict<br/>strategy.js:233]
  J --> K[heroHTML verdict tape<br/>planner.js:812]
  F --> L[renderTray lens boards<br/>planner.js:1043]
  L --> M[addMove -> the run<br/>planner.js:720]
  M --> N[evaluateRun FT/bank/club rules<br/>planner-run.js:52]
```

### 1.7 Defects in the current engine against the brief

Each one is a reason for the gut, with evidence:

1. **Budget uses current price, never sell price.** `transfers.js:273-274` (`priceDiff > budget`). Brief §10 pitfall 3.
2. **No 3-per-club check during enumeration.** Only checked once a move is staged into the run (`planner-run.js:79-90`), so the boards can recommend an illegal move.
3. **Squad value has no captain term.** `lineup.js:91-106` sums the XI and bench; selling the only strong captain option costs no more than his raw points. Pitfall 5.
4. **Bench = flat 0.15 weight**, not autosub probability, no formation legality.
5. **Next-GW availability carried flat across every window.** `calcPlayingLikelihood` (`form.js:490`) and the team-level channel factor (`channel.js:376`) read `chanceOfPlayingNext` whatever window is being scored, so the GW 3-5 window inherits this week's 25%. Pitfall 4, named in §3.
6. **One projection per window, not per GW.** `expectedPoints` takes the fixture count from the window's first GW only (`composite.js:1204-1207`), averages the fixture multiplier across the window, and the lanes multiply that per-GW rate by the window length (`transfers.js:310-311`). Blanks and doubles inside a window are miscounted (acknowledged and deferred in spec 2026-09-07 §6).
7. **Transfer economics are thin.** A single swap's cost is 0 whenever FT >= 1 (`transfers.js:263`); the UI only allows 1 or 2 FTs (`index.html:459-462`); there is no FT value, so "roll" is decided by a lane clearing an arbitrary normalised threshold (35), not by beating the value of a banked transfer. Pitfall 6.
8. **Lanes are compared by convention, not units.** `LANE_SCALE_*` divisors were hand-fitted to one live sample (`FEATURE_ENGINE.md` §14.4 says so).
9. **Two lanes decide on the player, not the squad.** Structure Fix's value is an XI delta, but whether it fires is decided by the out-player's own flags and rank tier (`transfers.js:702-713`); Ceiling ranks the incoming player's own peak week (`:610-658`). Pitfall 1.
10. **The prediction layer itself has defects** that break the §3 contract. They are listed in §2.1 because they sit below the transfer engine and some are shared with other tabs.

---

## 2. Prediction layer audit (§3 data contract)

The prediction engine is `scorePlayer` (`js/engine/composite.js:1101`). It
returns, per player and per **window**, a 0-100 composite `value` and a real
points figure `expectedPoints` (`calcExpectedPoints`, `composite.js:1061`):

```
expectedPoints = avgPointsPerGw x fixtureMultiplier x (min(startShare, availability) / 100) x countMultiplier
```

### 2.1 Contract failures found in the kept prediction layer

| # | Defect | Evidence | Effect |
|---|---|---|---|
| P1 | **Minutes counted twice.** `avgPointsPerGw` already divides by every elapsed GW, zero-minute weeks included; `calcExpectedPoints` then multiplies by `min(startShare, availability)`, where `startShare` is itself a minutes share. | `composite.js:979-989`, `:1063,1070`; `form.js:325, 413, 491, 500`; `FEATURE_ENGINE.md:1028` | A 50%-appearance player scoring 6 per appearance projects 1.5 instead of 3.0; a nailed starter subbed at 65' loses ~28%. Brief §10 pitfall 2. |
| P2 | **Double GW counted twice.** `DGW_UPLIFT` lifts the GW value that becomes `nextFixtureScore` and so the fixture multiplier, then the x1.9 count term is applied on top. | `composite.js:845-847, 1158-1161, 1062, 1068`; forbidden by `FEATURE_ENGINE.md:1076` | A neutral double projects ~2.12x a single instead of 1.9x. Biases Ceiling's t\*, TC/BB weeks, DGW buys. |
| P3 | **Blank GW keeps 10%.** Count term is `1 + 0.9 x (0 - 1) = 0.1` at zero fixtures. | `composite.js:1068`; failing test `tests/engine/composite.test.js:98` | A blanking player still projects points. |
| P4 | **Defender counter edge jumps to 100 on a blank channel.** `edgeValue = 100 - oppCm.value`, and a blank channel returns `value: null`, so the edge becomes 100. | `composite.js:746`; `channel.js:266, 336`; contradicts `counter.js:564` ("a blank pairing mirrors to blank, never to 100") | ~+16% xpts for DEF/GKP at a club with an incomplete Understat profile. |
| P5 | **MID/FWD counter edge is dead.** It reads pairings (`fwdVsCb`, `wideMidVsFb`, `camVsCbMid`) the live channel tier never emits, so it is always 50, flagged estimated. | `composite.js:733-737`; `config.js:559-563` | Neutral, so not harmful, but a missing signal. **Recorded only; out of scope** (a model change). |
| P6 | **Projections depend on browsing history.** The planner's ctx passes whatever element-summaries are in memory; the Ranker loads them on row clicks and in bulk on its "Last season" toggle. A loaded summary switches `avgPointsPerGw` and `minutesSecurity` to a different estimator. | `planner.js:281`; `ranker.js:1444-1487`; `composite.js:979-989`; `form.js:395-413` | The same squad gets different advice in different sessions; `p` and `q` are scored on different bases. |
| P7 | **Team-level availability is carried flat.** `channelPersonnelFactor` reads every team-mate's `chanceOfPlayingNext` from `ctx.playersByTeamId`, inside every fixture score. | `channel.js:376`; `composite.js:160-163, 419-420` | A striker flagged 25% this week still scales his club's attacking share at GW+4. |
| P8 | **Injury spells drag the rates forever.** `avgPointsPerGw` and every appearance measure average over the whole season (or the last 5 GWs), injured zeros included, so a recovering premium stays suppressed at every GW+k even when fit. | `composite.js:982-983`; `form.js:400, 413, 588-590` | Modes 2, 3 and 6 lean towards selling a returning premium, against §6 mode 6 "hold if the recovery ends inside the horizon". |

P1-P4 are fixed at the root in Phase 2 (P2-P4 break rules the repo already
documents; P1 by your decision, Q5), so the Dashboard's captain and XI use the
same corrected rule. The projection adapter does not depend on those fixes. P6,
P7 and P8 are handled in the adapter. P5 is a separate follow-up.

### 2.2 The v1 derivation (projection adapter)

The adapter does **not** read `expectedPoints`. It builds every field forward
from one basis for every player, so the identities hold by algebra:

For each player and each GW `t` of the horizon (`k = t - planningGw`, `k = 0..5`):

- **Context.** `ctx_k` = the engine ctx with `currentGw = planningGw + k`, `playerSummariesById = {}` (P6) and `playersByTeamId` rebuilt from clones whose `chanceOfPlayingNext` is the recovered value for that GW (P7). `{ gws: 1 }` single-GW scoring; nothing else in ctx is keyed to `currentGw`, so this is a valid window with no future leak.
- **`a_t` availability.** `k = 0`: FPL's `chance_of_playing_next_round`, else `STATUS_PLAY_CHANCE[status]`. `k >= 1`: `1 - (1 - a_0) x absenceCarryOver[status]^k` - the share of this week's absence chance still there `k` gameweeks on (config; doubtful 0.3, injured 0.6, suspended 0, unavailable 1). Never carried flat. The same recovered figure is what `ctx_k` gives his club's channel read, also at `k = 0` (an injured player with no FPL chance used to read as 100% available there).
- **Contention GWs `C`.** Elapsed GWs in which his club had a fixture (a club blank is not a missed appearance), minus the player's latest run of zero-minute GWs when that run is still going and he is flagged now, or lasted at least `absenceMinRunGws` (2; one missed week is as likely a benching), ended within `absenceLookbackGws` and he has played since (P8). Per-GW minutes come from the Phase 1 `event/{gw}/live/` table (one request per finished GW, every player). Without the table, `C` = his club's played matches, flagged estimated.
- **Rates, unshrunk.** `appearRate` = GWs in `C` with minutes > 0 / |C| (fallback: starts / his club's played matches); `ppa` (points per appearance) = points in `C` / appearances in `C`, a past double's points scaled back to one fixture by `count(n)` (fallback: points / starts); `startRate` = season starts / |C| (starts only happen in contention GWs). If |C| < `minContentionGws`, fall back to `calcPlaytimeSecurity`'s price prior, flagged estimated. Never the price-shrunk `startRate` for `pZero` (an ever-present cheap starter would get a false 29% pZero).
- **`fm_t` fixture multiplier** from the pre-uplift GW mean (P2), with the P4 guard. `n_t` = fixtures in GW `t`; `count(n) = n == 0 ? 0 : 1 + DGW_EXPECTED_PTS_FACTOR x (n - 1)`.

```
xpts_t        = a_t x appearRate x ppa x fm_t x count(n_t)
pZero_t       = n_t == 0 ? 1 : (1 - a_t) + a_t x (1 - appearRate)^n_t     // availability shared across a double, selection per fixture
xptsIfPlays_t = n_t == 0 ? 0 : xpts_t / (1 - pZero_t)                     // when 1 - pZero_t <= eps: the a_t = 1 value
pStart_t      = min(1 - pZero_t, a_t x (1 - (1 - startRate)^n_t))          // starts at least once; approximate until Phase 4
p60_t         = pStart_t x completion,  p60Approx: true                    // completion = minutes / (starts x 90)
pP90          = null                                                       // Phase 7
```

For a single GW this gives `xptsIfPlays = ppa x fm x count`, independent of
`a_t`, so an injured nailed starter keeps a positive `xptsIfPlays` (needed by
mode 6's uncovered loss), and `xpts = (1 - pZero) x xptsIfPlays` holds exactly.
With the fallbacks, `xpts = a x avgPointsPerGw x fm x count`, i.e. P1 removed.
Phase 4 swapped the sources of `appearRate` and `startRate`, and of `p60`
(`a_t x (1 - (1 - p60Rate)^n_t)`, `p60Approx: false`), for the fitted minutes
model's per-fixture chances wherever the live table holds his record; the
formulas stay. `a_t` stays FPL's flag and its recovery: no history of flags
exists to fit it on.

Known v1 limits: an impact sub's appearances are
undercounted without the live table; a benched (not injured) player's finished
zero run is excluded like an injury; a mid-season arrival's early GWs count
against him. The minutes model needs the table, so it never meets the first;
it reads the same record as v1, so the other two remain (Phase 4).

### 2.3 Field status

| Field | Status today | v1 (this plan) |
|---|---|---|
| `xpts` | **Approximation, and wrong** (P1-P4, per window not per GW) | §2.2, per GW |
| `p_start` | **Approximation** (`startShare` is a minutes share; `playtime.startRate` is price-shrunk) | `a_t x startRate`, flagged approximate; Phase 4: the minutes model's start head |
| `p_zero` | **Not produced** | §2.2; Phase 4: from the appear head |
| `p_60` | **Not produced** | `pStart x completion`, `p60Approx: true`; Phase 4: the 60-minute head, `p60Approx: false` |
| `xpts_if_plays` | **Not produced** | §2.2 |
| `p_p90` | **Not produced** (Ceiling's haul rate is a backward proxy) | `null` until Phase 7 |
| Point-in-time snapshots | **Not produced** (`calibration.js` stores fixture composites only, in `localStorage`) | Phase 1, in the browser (Q1) |

---

## 3. Stack facts

- **Language and runtime.** Vanilla JavaScript ES modules, served as authored: no framework, no bundler, no transpiler (`ARCHITECTURE.md` §1, §4). `package.json` has **zero dependencies**. Tests run on Node's built-in runner (`npm test` -> `node --test tests/**/*.test.js`). Baseline today: **219 tests, 213 pass, 6 fail** (5 in `channel.test.js`, 1 in `composite.test.js` - P3). Node has no IndexedDB, so browser storage code is tested through an injected store plus a manual browser step.
- **Data store.** None on the server. `api/fpl.js` is a stateless Vercel function: an allowlisted, cached CORS proxy that "must not store data. No database, no KV" (`ARCHITECTURE.md` §5). Client state is `js/store.js` (memory + `sessionStorage`) plus a few `localStorage` keys.
- **How predictions are produced and refreshed.** In the browser, on demand. Boot fetches `bootstrap-static/` and `fixtures/`, then prefetches Understat team xG for all 20 clubs; modules wait for `store.isTeamXgSettled()` and then call `buildScoreContext` + `scorePlayer`. **A reload in the same tab does not refresh**: the season is restored from `sessionStorage` with no age check (`store.js:190-199, 484-499`; `main.js:115-152`), so prices, flags and transfer counts can stay frozen for the life of the tab. Player summaries load lazily, except the Ranker's sanctioned bulk load on its "Last season" toggle.
- **How the squad is stored.** `store.getSquad()`: an array of 15 player ids, shared with the Dashboard. Imported picks (slot 1-15, captain, vice) are kept separately (`store.js:400-441`), cleared on any hand edit, and only used to show "your XI vs the model's XI". Starters and bench are always re-picked by `pickStartingXI`.
- **Import quirks.** The import takes picks from the current GW and ignores `active_chip` (`squadImport.js:59-65, 106`), so during a Free Hit week it imports the temporary Free Hit squad. The Dashboard import keeps only player ids (`dashboard.js:1315`).
- **Purchase prices.** **Not stored anywhere.** Bank is a manual input (`#pl-bank`) although the picks payload carries `entry_history.bank`. Free transfers are a manual 1 or 2 toggle.
- **Ledger sources.** The public `entry/{id}/transfers/` (each buy with `element_in_cost` and GW) and `entry/{id}/history/` (per-GW transfers and chips) - allowlisted in Phase 1 (Q2). Players held since before any transfer are priced from `element-summary` `history[].value` for the GW they arrived (owned players only; the engine's ctx ignores summaries, P6, so this does not leak into projections).

---

## 4. Gut plan

### 4.1 Deleted (in the UI phase, once the new screen is live)

- `js/engine/transfers.js` and `js/engine/strategy.js` (whole files).
- `js/modules/planner-boards.js` and `js/modules/planner-run.js` (whole files; Q4), after moving `timingNote` into `planner.js`.
- In `js/modules/planner.js`: the verdict tape, the run, the move tray and lens boards and their state (`_moves`, `_chipsAt`, `_swaps`, `_verdict`, `RUN_KEY`, `runSnapshot`, `isDirty`, `onBeforeUnload`, FLIP code); `scoreSquad`, `_scores`, `ensureRankTiers`, `_rankTierByPlayerId` and the `rankPlayers` / `attachRankTiers` imports (the ~920 ms full-pool rank fed only the Structure lane); `priceChangeNote`; `pickBenchPlayerIds` and `pickTcCandidate` (the Bench Boost and Triple Captain hints come from the engine instead, Q4).
- In `index.html`: the run, the tray, and the ids with no counterpart in the new screen: `#pl-hit`, `#pl-save`, `#pl-save-st`, `#pl-run-range`, `#pl-clear`, `#pl-issues`, `#pl-unplaced`, `#pl-totals`, the FT 1/2 radio. In `css/planner.css`: **delete by consumer, not by name** - the rules are flat siblings under `.pl`, so every class no template or `index.html` still uses goes (UI-phase acceptance checks this).
- `calcXiExpectedPoints` from `js/engine/lineup.js`; `rankByPriceRise` / `rankByPriceFall` from `js/engine/prices.js` (already unused). **`calcPriceChangeRisk` stays** with `PRICE_MIN_ACTIVITY` / `PRICE_ACTIVITY_SCALE`, as the price adapter's flagged fallback (risk 4).
- In `js/engine/chips.js`: `scoreBenchBoostTiming` and `scoreTripleCaptainTiming`, with the inlined `PROJ_*` blend and the imports only they used (Q4: replaced by engine hints that use the same projections and the real bench). `scoreWildcardTiming` and `scoreFreeHitTiming` stay.
- Config constants left without an importer: `BENCH_CONTRIBUTION_WEIGHT`, `NOW_WINDOW_GWS`, `FUTURE_*`, `CANDIDATE_POOL_PER_POS`, `FUNDS_MIN_CASH_FREED`, `FLEX_*`, `CEILING_*`, `HAUL_POINTS_THRESHOLD`, `STRUCTURE_PLAYTIME_FLOOR`, `LANE_SCALE_*`, `VERDICT_*`, `HIT_PENALTY` (replaced by `DECISION_ENGINE.hitCost`), and any other constant whose last importer goes.
- Tests: `tests/engine/transfers.test.js`, `tests/engine/strategy.test.js`, `tests/modules/planner-run.test.js`, the `calcXiExpectedPoints` cases in `lineup.test.js`.
- `window.__engine` transfer hooks in `js/main.js` (replaced by hooks for the new engine).
- The landing card's run copy (`index.html:147`): the "+6" badge goes and the hint becomes "One best move per mode, scored on your whole squad." (Q9).
- Docs, in the same commit as the code deletion: `FEATURE_ENGINE.md` §14 becomes a pointer to `docs/decision-engine.md`, keeping §14.1's description of the kept `pickStartingXI`; `ARCHITECTURE.md` file tree and §10; `ROADMAP.md` §2D; `GAFFER_IQ_TESTING_ROADMAP.md` planner checklist; the `chips.js` lockstep notes in `FEATURE_ENGINE.md` §10-§11; stale code comments (`index.html:441`, `css/planner.css:4`, `lineup.js:7-11`, `dashboard.js:7`). The two superseded specs and the old plan stay in `docs/superpowers/` as history, marked superseded.

### 4.2 Kept

- The whole prediction layer: `composite.js`, `form.js`, `counter.js`, `fixtures.js`, `channel.js`, `normalise.js`, `season.js`, `h2h.js`, `style.js`, `standings.js`. Changed only by the root fixes in §2.1 (P1-P4) and extended by the projection adapter.
- `pickStartingXI` (`lineup.js:44`), given an optional value accessor so the squad value function can rank by a GW's `xpts` while the Dashboard keeps calling it as today. Greedy minimum-then-fill is optimal for the brief's "maximise sum of xpts" objective; Phase 2 tests it against brute-force formation enumeration.
- Data ingestion: `api.js`, `api/fpl.js`, `store.js`, `squadImport.js` (all extended, not replaced).
- `chips.js` Wildcard and Free Hit timing, and `computeChipRecs`, which now merges them with the engine's Bench Boost and Triple Captain hints (Q4).
- Planner shell: data-ready / settle gating, `route:changed` deferral, `getPlanningTiming` and `buildCtx` (planning GW, not a live GW), squad drawer (its bench / start / C markers driven by `DecisionResult.lineup`, so one screen never shows two XIs), import form, toast, confirm dialog, bank input, `#pl-cmd` and its resize observer.

### 4.3 How the new UI sits in the site

The new screen replaces the contents of the existing `#planner` module view.
It keeps the app's design system: tokens from `css/base.css` (`--color-*`,
`--band-*`, `--font-*`, `--radius-*`), BEM-lite classes nested under `.pl` in
`css/planner.css`, the score-chip and band vocabulary, skeletons for unsettled
values (`CONVENTIONS.md` §5.4), and entrance motion gated on `[data-anim]` and
`prefers-reduced-motion`. Layout, in reading order:

1. Settings bar: bank (from import, editable), FTs 0-5 (derived for the planning GW, editable), chips used per half (derived from `history/` `chips[]`, split at `CHIP_RESET_AFTER_GW`, with a manual override), chip plan (chip -> GW; the engine's only chip input), pre-filled with the chip hints - Wildcard and Free Hit from `chips.js`, Bench Boost and Triple Captain from the engine, each with its reasoning - and your choice always overrides a hint. Bank, FT and chip overrides are saved in `localStorage` next to the ledger.
2. Live-round note (`timingNote`) when planning while a GW is in play.
3. Six mode cards (§8 items 1-7).
4. Captain and XI panel.
5. Sell / hold table with lock and ban buttons.

### 4.4 Isolation

All work happens on this branch. Vercel's `gaffer-iq` production deploy builds
only from `main`, so the live app keeps the old planner until the branch is
merged. The old engine's baseline is commit `3aa8f3a` (the base of this
branch, permanently in `main`'s history): Phase 7 runs it in a git worktree as
its "old engine" baseline, so no frozen copy of dead code has to live in the
tree. A local tag `gaffer-iq-pre-decision-engine` marks it; pushing the tag was
refused by this environment (HTTP 403 - only branch pushes are allowed), so the
SHA is the reference.

---

## 5. Interface design

Names follow the repo's conventions (camelCase properties, `CONVENTIONS.md`
§3); the brief's names are given alongside where they differ.

### 5.1 Prediction layer -> decision engine

New pure module `js/engine/projections.js`:

```js
/**
 * @typedef {object} GwProjection
 * @property {number}  gw
 * @property {number}  fixtures      0 = blank, 2 = double
 * @property {number}  xpts          §2.2; minutes included, summed over fixtures
 * @property {number}  pStart        brief: p_start
 * @property {number}  pZero         brief: p_zero
 * @property {number}  p60           brief: p_60
 * @property {boolean} p60Approx     true where the v1 rates stood in (Phase 4)
 * @property {number}  xptsIfPlays   brief: xpts_if_plays
 * @property {number|null} pP90      brief: p_p90, null until Phase 7
 * @property {boolean} estimated
 * @property {'fpl'|'status'|'recovery'} availabilitySource
 */

/** @returns {Map<number, { playerId, position, teamId, price, gws: GwProjection[] }>} */
export function buildProjections(players, ctx,
  { planningGw, horizonGws, gwTable, scorePlayerFn = scorePlayer, minutesModel = DECISION_ENGINE.minutesModel })
```

`ctx` is built for the engine with `playerSummariesById: {}`; `gwTable` is the
per-GW minutes/points table from Phase 1 (or `null`, giving the estimated
fallbacks). Built once per data load for the squad plus every feasible
candidate, cached by the planner, and never recomputed by a lock, ban, bank,
FT or chip change. The GW-independent form result is computed once per player
and reused across the six GWs.

### 5.2 Decision engine

```js
// js/engine/prices.js
export function calcSellPrice(purchasePrice, currentPrice)        // §4, integer tenths

// js/engine/ledger.js
export function buildPurchaseLedger(transfers, squadIds, priceAtGw) // -> Map<playerId, purchasePrice>, keyed by player id
export function deriveFreeTransfers(entryHistory, planningGw, rules) // -> number 0-5, counted for the planning GW

// js/engine/feasibility.js
export function checkSwap(squadState, outId, inPlayer)             // -> { ok, reason }
// squadState: { players: [{ playerId, position, teamId, sellPrice }], bank }

// js/engine/squad-value.js
export function squadValue(squad, t, projections, opts)
// -> { value, xi, bench, captainId, viceId,
//      components: { xi, captain, autosub, benchBoost } }
// opts: { chip: null | 'benchboost' | 'triplecaptain', autosubMode, benchWeightsLinear }
export function autosubRecovery(xi, benchOrder, t, projections, mode)
// exported on its own so formation and injured-starter cases run against a fixed XI

// js/engine/decision.js
export function runDecisionEngine(input, config)                   // -> DecisionResult
```

Rules the signatures do not show:

- **Captain.** Chosen to maximise `xpts_c + pZero_c x xpts_v` (vice covers only when the captain does not play; `xpts_v` is the vice's unconditional figure). Triple Captain doubles that bonus.
- **Autosubs, probability mode.** Each bench player comes on at most once. Expected recovery is computed exactly, with no cap: the outcome depends only on how many starters are absent at each position and on which subs play, and with `c` subs playing, absences past `c` at one position change nothing (each finds no sub left or fails as the one before did). So each position's absence count is capped at `c` with its tail probability folded in - at most `(c + 1)^3` states per play/miss outcome of the three subs, none when no sub plays - and FPL's bench order and formation rules are applied to each state; the GK slot is separate (`pZero_gk1 x xpts_gk2`). A test checks it against brute force over all 2^10 x 2^3 patterns. Bench order: outfield by `xptsIfPlays` descending, GK last (configurable).
- **Free Hit and Wildcard** are handled in `decision.js` by weights, not in `squadValue`: `w_t = 0` for a planned Free Hit GW, and for every GW from a planned Wildcard onward, in DeltaEV, KeepValue and lock value.
- **Ghost** (KeepValue): `{ xpts: 0, xptsIfPlays: 0, pZero: 1 }`, built directly, never passed through `checkSwap` or the funds term.
- **No ledger entry** for a player (drawer edit, Dashboard import): purchase = current price, so sell = current price, flagged `estimated` on the move and in the table.
- **Free transfer cost.** With `n` FTs banked: `n == 0` -> `hitCost + hitMargin`; `n >= maxBankedFt` -> 0; otherwise the value of the FT that rolling would bank, `ftValueSchedule[n + 1]` (or `ftValueFlat`). So 1 -> 1.5, 2 -> 1.0, 4 -> 0.3, 5 -> 0.
- **Performance bounds.** `V_t(S - p + q)` is computed once per `(p, q, t)` and reused by all six modes, which differ only in weights, lambda and gates; lock and ban only re-filter. Mode 4 chaining takes the top-K downgrades only, draws the second buy from the newly affordable price band, and scores the pair jointly as `V(S - p + q - r + s)` with the club check across both moves. Robustness runs after first paint and never on the lock / ban path.

```js
// runDecisionEngine(input, config = DECISION_ENGINE, cache = createDecisionCache())
input = {
  planningGw,
  squad: [{ playerId, name, position, teamId, priceTenths, purchaseTenths }],  // 15; purchaseTenths null = no ledger entry
  bankTenths, freeTransfers,
  chipPlan: { [gw]: 'benchboost' | 'triplecaptain' | 'freehit' | 'wildcard' },
  chipsUsed: [{ chip, gw }],          // from history/ (with the UI's override): the chip hints' halves
  locks: Set<playerId>, bans: Set<playerId>,
  projections,        // from buildProjections, for the squad and every candidate
  candidates,         // Player[]: every possible replacement (no cap); the engine applies checkSwap
  priceSignals,       // Phase 5: priceSignals() of price-adapter.js, { [id]: { fall, rise, source } }, or null
  hoursToDeadline,    // Phase 5: to the planning GW's deadline, or null (Now then never waits for team news)
}
// The engine prices each sale itself (calcSellPrice). The cache holds V per
// (gw, swap) between runs and empties itself when the projections, the squad,
// the planned Bench Boost / Triple Captain GWs or the autosub settings change.

DecisionResult = {
  modes: { [modeId]: {
    modeId, label, weights,
    call: 'move' | 'roll' | 'wait',
    root: Move | null,
    rollValue,                       // display only: the value of the FT kept by rolling
    alternatives: Move[],            // within `alternativesWindow` points, at most `alternativesMax`
    waitForNews: boolean, deferral: { gw, laterScore, epsilon } | null,   // Phase 5; call 'wait' with a deferral
    robustness: number | null,       // Phase 6
    targetGw,                        // Ceiling only: t*, null when a planned chip covers every GW
  } },
  players: [{ playerId, sellPriceTenths,   // what he sells for (flagged sellPriceEstimated without a ledger entry)
    keepValue: { [modeId]: number }, outScore: { [modeId]: number | null },
    best: { [modeId]: Move | null }, // full components for every owned player, every mode; null with no legal move
    flags: Array<'sell' | 'hold' | 'protected' | 'locked' | 'pendingNews' | 'sellPriceEstimated'
      | 'priceFall' | 'priceRise'>,  // a likely move that would change his sell price (Phase 5)
    priceSource: 'fpl' | 'estimate' | null,
    lockValue: number | null,        // null: no affordable replacement (or no t*), so no sale to protect against
    uncoveredLoss: number }],        // mode 6's structural exposure, Structure-weighted
  lineup: { xi, bench, captainId, viceId, captainGap, nextCaptainId },
  chipHints: {                       // pre-fill only; never applied unless you accept them (Q4)
    benchboost:    { gw, gain, reasoning } | null,   // GW with the largest Bench Boost increment from squadValue
    triplecaptain: { gw, gain, reasoning } | null,   // GW with the largest captain bonus
  },
}

Move = {
  mode, outId, inId,
  deltaEv, perGw: number[],          // w_t x (V_t(S - p + q) - V_t(S)) per GW
  fundsTerm, priceTerm, transferCost,
  deadSlotTerm,                      // Structure only, else 0
  outScore,                          // = deltaEv + fundsTerm + deadSlotTerm - priceTerm - transferCost: the gain over rolling
  efficiency,                        // Funds only: money freed per point given up
  tentativeFromGw,                   // later-GW parts shown greyed: every GW after the planning GW
  minutesRisk: { out: Risk, in: Risk },   // Risk 'low' | 'medium' | 'high' by pZero in the planning GW; 'blank' with no fixture
  chained: Move | null,              // mode 4 only
  tags: Array<'blankGwOneWeek' | 'sellPriceEstimated' | 'pendingNews'>,
  why: { squad, funds, price, cost }, // plain-English sentences, built in the engine; price null with no likely price move
}
```

`outScore` already nets the FT value, so there is no separate "gain vs roll"
field to subtract it from twice.

### 5.3 Decision engine -> UI

The planner module renders `DecisionResult` and nothing else; no analysis in
the module (`ARCHITECTURE.md` §12 rule 4). Lock and ban re-call
`runDecisionEngine` with new sets against cached projections and cached `V`
values (target under 200 ms).

### 5.4 Config

One exported block in `js/config.js` (the repo's existing single source of
tunables; YAML would need a parser and the app has no dependencies). Every
threshold the engine uses gets a key; the final grep bans other numeric
literals in the new engine files.

```js
export const DECISION_ENGINE = {
  horizonGws: 6,
  ftValueMode: 'decreasing',             // 'flat' | 'decreasing'
  ftValueFlat: 1.75,
  ftValueSchedule: { 2: 1.5, 3: 1.0, 4: 0.6, 5: 0.3 },
  maxBankedFt: 5,
  hitCost: 4,
  hitMargin: 2,
  decayBase: 0.85,
  lambdaDefault: 0.10,
  autosubMode: 'probability',            // 'linear' | 'probability'
  benchOrder: 'xptsIfPlays',
  benchWeightsLinear: { s1: 0.30, s2: 0.10, s3: 0.03, gk: 0.03 },
  fundsModeTau: 1.0,
  robustnessRuns: 30,
  alternativesWindow: 2, alternativesMax: 2,
  absenceCarryOver: { doubtful: 0.3, injured: 0.6, suspended: 0, unavailable: 1 },
  absenceMinRunGws: 2, absenceLookbackGws: 5, minContentionGws: 3,
  minutesFeatures: { windows: { short: 3, mid: 5, long: 10 }, playedMinutes: 60, minHistoryGws: 1 },
  minutesModel: { appear, start, p60, ahead },   // fitted by tools/minutes (Phase 4); null runs v1
  seasonMaxAgeMinutes: 60, snapshotMinIntervalMinutes: 360,
  minutesRiskPZero: { medium: 0.1, high: 0.3 },
  priceMoveLikely: 0.95, waitForNewsMinHours: 24,   // Phase 5
  modes: {   // each also has a label
    now:       { weights, lambda: 0, pZeroGate: 0.25, threshold: 0 },
    longterm:  { weights, lambda: 0.10, threshold: 0 },
    future:    { weights, lambda: 0.15, threshold: 0, deferralEpsilon: 0.1 },
    funds:     { weights: 'decay', tau: 1.0, eps: 0.1, chainTopK: 5, threshold: 0, minFreedTenths: 5 },   // decayBase^k; lambda: lambdaDefault
    ceiling:   { targetWeight: 1, otherWeight: 0.1, lambda: 0, lockThreshold: 3, threshold: 0 },
    structure: { weights, lambda: 0.10, deadSlotMinGws: 2, deadSlotPenalty: 1, recoveredAvailability: 0.9, threshold: 0 },
  },
};
```

Mode weights are the brief's §6 presets exactly as written (Q6): `now` [1,0,0,0,0];
`longterm` [1,1,1,0,0] / 3 (the brief's alternative, decay 0.85, is tried in
Phase 7); `future` [0.5,0.75,1,1,1] normalised to sum 1; `funds` 0.85^(t-1) over
5, not normalised; `structure` [1,0.85,0.72,0.61,0.52]; `ceiling` most weight on
t\*, small elsewhere. Every mode's `threshold` is 0: a move is recommended only
when OutScore > 0, i.e. it beats rolling after the FT value or hit is paid
(Q7). Long term additionally keeps the brief's own gate, DeltaEV > FT value
(free) or > `hitCost + hitMargin` (hit).

---

## 6. Risks, and what in the brief does not fit the repo

1. **No server-side store.** Resolved: the ledger is a pure function over the public transfers endpoint, cached in `localStorage`; snapshots are captured in the browser on each visit and kept in IndexedDB (Q1).
2. **Snapshots live on one device and have gaps.** Browser capture records only on days the app is opened, only in that browser. Phase 4 and Phase 7 read snapshots through an "Export snapshots" JSON download; a missed day is a missing row, never an interpolated one; clearing site data loses history (the export is the backup). Nothing runs outside `projects/apps/gaffer-iq/`.
3. **Network.** You will allow `fantasy.premierleague.com` in this environment (Q3). When re-checked on 17 Oct it was still refused; `raw.githubusercontent.com` (vaastav) is reachable. Until the FPL host is allowed, Phases 1-3 run on synthetic squads, and the live checks (price-predictor fields, real-squad timing, ledger and Free Hit import against a real account) wait. Separately, the client calls the **production** proxy by absolute URL (`js/api.js` `PROXY_BASE_URL`), so the two new ledger routes only answer once this branch is merged and the `gaffer-iq` project deploys; until then the import carries on without purchase prices (each falls back to the current price, flagged).
4. **Price-predictor fields are undocumented** (risk 3). Phase 5 isolates them in one adapter file; if they are absent, the adapter falls back to `calcPriceChangeRisk`, flagged as an estimate. Snapshots keep unknown element fields from Phase 1 on, so the fields are logged even before the adapter reads them. Phase 5 read their shape from vaastav's 2026-27 capture of bootstrap-static (FPL itself is still unreachable here); a live check against FPL is still owed.
5. **The MILP referee is Python.** open-fpl-solver needs Python + HiGHS; the repo says "zero Python anywhere in the stack". Phase 8 would run it as an offline tool outside the served app, or port the formulation to Node with a WASM HiGHS build (licence check first). Decide at Phase 8.
6. **Performance (measured on synthetic data).** The real `scorePlayer` took 430 ms for 255 players x 6 single-GW calls and 570 ms for 615 x 6, so projecting every feasible candidate fits the 5 s budget; **no candidate cap**, as the brief decided brute force. `pickStartingXI` costs ~3 us, so single-swap enumeration (~5-15k `V` calls) is cheap. The two things that would not fit, unbounded mode 4 chaining (~1M `V` calls) and synchronous robustness, are bounded in §5.2. If Phase 3 measurement still blows the budget, a capped pre-filter comes back to you as a question, with its criterion. Measured in Phase 2: `buildProjections` takes 0.3 s for the real 616-player pool (vaastav 2026-27) and 0.8 s for a synthetic 620-player one, 6 GWs, real scorer; `squadValue` takes 43 us a call in probability mode and 7 us in linear mode, so a 15.7k-call cache fill (every same-position swap x 6 GWs on that pool) is ~0.7 s.
7. **Brief inconsistencies, read as follows** (confirmed, Q10): `horizon_gws: 6` vs five weights per mode (plan: the 6th GW is used only by the mode 3 deferral test; since Phase 5's review, by your call, the deferral scores over the same five GWs, so the 6th GW now feeds only the chip plan's weeks and its Bench Boost / Triple Captain hints); mode 3 is titled "GW+3..+5" but its weights cover GW+1..+5 (plan: use the weights as written); Ceiling's upper tail does not exist before Phase 7 (plan: Phase 3 ships Ceiling on the mean at t\*, labelled as such). Mode 4's lambda "derived (see below)" is read from the same row: the funds credit is the chained second move's net gain, else `lambdaDefault`.
8. **Units of DeltaEV** (kept as written, Q6). Modes 2 and 3 normalise their weights (sum 1, a per-GW average) while modes 4 and 6 do not (a horizon total), yet all are compared against the same one-off FT value and hit cost, so the same move can roll in mode 2 and go ahead in mode 6. Phase 7 reports whether this costs points; any change to the presets comes back to you.
9. **Dashboard divergence.** The Dashboard keeps its own XI and captain from `expectedPoints`. The P1-P4 root fixes reach it, so it uses the same corrected rule; it still reads one projection per window rather than the per-GW projections. Moving the Dashboard onto the new projections is a follow-up.
10. **Free transfer derivation.** 2026/27 FT rules (what Wildcard / Free Hit do to banked FTs, any mid-season top-up) are not in the API. Derived count is a pre-fill; the control stays editable.
11. **Free Hit and the import.** During a Free Hit week the import returns the temporary squad and bank; Phase 1 re-reads picks and bank from GW-1 when `active_chip` is `freehit`. Whether `transfers/` lists Free Hit moves needs a real account (risk 3); purchase prices stay editable.
12. **The live table costs requests.** One `event/{gw}/live/` request per finished GW, once (re-fetched until that GW's bonus is confirmed), cached in IndexedDB. Up to 38 small requests over a season; light, and nothing else in the app bulk-fetches.
13. **Backtest leakage and effort.** Reconstructing the engine's context for past GWs from vaastav needs care: team strengths in that dataset may be end-of-season values, status flags are not available historically (structure mode cannot be backtested until our own snapshots accumulate), and the old engine needs the same reconstructed context. Phase 7 is the largest phase.
14. **Terms and access flags (§11)** found in the repo: the proxy sends a spoofed desktop Chrome user agent (`api/fpl.js:120`); `Access-Control-Allow-Origin: *` (`:143`) lets any site use this proxy against FPL; the Understat `match/{id}` route forwards a scraped HTML page. Check the vaastav dataset's licence before using it. Snapshots stay on your device, so no FPL data is redistributed.
15. **Leftovers kept by decision (Q9).** `index-FXL00-CK7M8F4.html` stays: nothing links to it, but it is served and boots `js/main.js`, so after the gut it will run the new code against its old markup. The useless `me/` proxy route also stays.
16. **Pre-existing failures.** The 5 failing `channel.test.js` tests stay out of scope. `composite.test.js:98` turned green with the P3 fix (Phase 2). The baseline must not otherwise move.
17. **Skills.** `smart-explore` could not parse files under `projects/apps/` (the repo's `.claudeignore` excludes that path), so discovery used targeted reads. `pathfinder` was applied inline rather than writing a `PATHFINDER-*/` folder at the repo root, which would break the folder restriction. Phases 1 onward use a branch rather than a separate worktree; the cloud container is already isolated.

## 7. Decisions from the grill-me pass

- **Q1 Snapshots. Decided:** browser capture on each visit, stored in IndexedDB, exportable as JSON.
- **Q2 Ledger. Decided:** allowlist both `entry/{id}/transfers/` and `entry/{id}/history/` (public, read-only) in the proxy.
- **Q3 Network. Decided:** you will allow `fantasy.premierleague.com` (and `raw.githubusercontent.com`, already reachable) in this environment.
- **Q4 The run and chip hints. Decided:** delete the run; keep chip-week hints as pre-fills for the chip plan, re-pointed so Bench Boost and Triple Captain come from the engine's projections and real bench (Wildcard and Free Hit stay in `chips.js`).
- **Q5 Root fix for the minutes double count (P1). Decided:** fix `calcExpectedPoints` at the root; the Dashboard's captain and XI order will move.
- **Q6 Units of DeltaEV. Decided:** keep the brief's presets exactly as written; Phase 7 reports the effect (risk 8).
- **Q7 Threshold. Decided:** OutScore > 0 in every mode (a config key per mode for Phase 7 tuning); Long term also keeps its DeltaEV gate.
- **Q8 Blank next GW in mode 1. Decided:** Now stays a pure one-week preset - it may offer the sale, labelled "blank GW - one-week view"; a planned Free Hit that GW means he is never sold.
- **Q9 Leftovers. Decided:** rewrite the landing card copy; keep `index-FXL00-CK7M8F4.html` and the `me/` route (risk 15).
- **Q10 Brief readings. Decided:** the four readings in risk 7 stand. (Phase 5's review: you changed the mode 3 deferral to score both versions over the same five GWs.)

---

## Phases

Every phase ends with: `npm test` green except the known baseline failures,
the phase's acceptance tests shown passing, a manual check in `vercel dev` where
the phase touches the UI or browser storage, and one commit. No phase starts
before the previous one passes. Phases 1, 2, 3 and 5 are strictly sequential.

### Phase 1: Foundations (sell price, ledger, feasibility, snapshots)

> **How this serves the primary goal:** every later number depends on what a sale actually raises, on which swaps are legal, and on data that is fresh; get those wrong and the best-scored move can be one you cannot make.

**Implement**
1. `calcSellPrice(purchase, current)` in `js/engine/prices.js`, in integer tenths: `current <= purchase ? current : purchase + floor((current - purchase) / 0.2) x 0.1` (in tenths: `p + floor((c - p) / 2)`).
2. `js/engine/ledger.js`: `buildPurchaseLedger` (keyed by player id, joined to `store.getSquad()`), `deriveFreeTransfers` (for the planning GW, so a live GW's roll-over counts). `api.js`: `fetchEntryTransfers`, `fetchEntryHistory`; two anchored patterns in `api/fpl.js`'s `ALLOWED_PATTERNS`, same shape as `entryPicks`. `squadImport.js` also returns the squad's gameweek, `entry_history.bank`, the ledger and the normalised history (the FT count is replayed from it for whichever GW is being planned, so it never goes stale); when `active_chip` is `freehit`, picks and bank come from GW-1. The new entry payloads are normalised in `engine/normalise.js`, the only file allowed FPL's raw field names. The import record (ledger, bank, history) is persisted in `localStorage` (`gafferiq_ledger`); the bank / FT / chip override controls arrive with the UI phase and save to the same record.
3. `js/engine/feasibility.js` `checkSwap`: positions, 3 per club after removing p, `price(q) <= bank + sell(p)`, legal formation still possible.
4. Season freshness: a max age (`seasonMaxAgeMinutes`) on the season restored from `sessionStorage`; older than that, it is refetched before advice is built.
5. `js/snapshots.js` (module layer, the same side-effect tier as `js/calibration.js`): on `data:ready`, capture one record holding the per-player bootstrap fields (status, news, `chance_of_playing_*`, `now_cost`, `cost_change_*`, transfers in/out, ownership) **plus any element key `normalise.js` does not know** (so new predictor fields survive), the events row, the capture time and the bootstrap fetch time. Skip when the fetch time equals the last record's (a cached payload is not a new observation) or inside `snapshotMinIntervalMinutes`. Also build the per-GW table from `event/{gw}/live/` (minutes, points, starts when present), once per finished GW, re-fetched until its bonus is confirmed. Stored in IndexedDB through a `get` / `put` / `getAll` adapter wrapped in try/catch that degrades to a no-op and never throws into `data:ready`. The record builder is pure and the store is injected. `downloadSnapshots` exports everything as one JSON file (console `__engine.exportSnapshots()` until the UI phase adds the button).

**References** `api/fpl.js:25-36` (allowlist shape), `js/squadImport.js:59-106` (import flow), `js/modules/planner-run.js:79-90` (club count logic to move into the engine), `js/store.js:484-499` (hydrate).

**Acceptance (tests first)**
- Sell price: purchase 5.0 -> current 5.1 sells 5.0; 5.2 -> 5.1; 5.3 -> 5.1; 4.8 -> 4.8; 5.0 -> 5.0.
- Feasibility rejects a 4th player from one club, and a swap affordable at current price but not at sell price.
- FTs derived during a live GW include that GW's roll-over.
- A Free Hit picks payload imports the GW-1 squad and bank.
- Snapshot capture run twice (in-memory store, advancing clock and new fetch time) stores two distinct records; a repeat with the same fetch time stores nothing; an unknown element field reaches the record.
- Manual browser step: two captures across the interval, a reload, an export that holds both; a private window degrades silently.

**Guards** Never forward cookies or tokens through the proxy. No relaxed allowlist patterns. Prices in tenths internally; no float accumulation.

### Phase 2: Projection adapter and squad value function V_t(S)

> **How this serves the primary goal:** this is the "what does it do to the whole squad" measure; every recommendation is a difference of it, so its inputs must be right first.

**Implement**
1. Root fixes in the prediction layer: P3 (count 0 -> 0, `fixtureCountFactor`, shared with the adapter), P2 (`nextFixtureScore` from the pre-uplift GW mean, `scoreOverHorizon`'s new `preUpliftValue`; the uplift stays in `value` only), P4 (`defensiveCounterEdge` in `engine/counter.js`: `oppCm.value == null ? 50 : 100 - oppCm.value`, also used by `engine/chips.js`'s Triple Captain timing, which carried the same inversion), and P1 (the minutes factor in `calcExpectedPoints` becomes availability alone, Q5). The commit message records the before/after on the Dashboard captain, XI order and Ranker numbers for one squad (the real 2026-27 league from vaastav after GW1; the FPL host is still refused).
2. `js/engine/projections.js` `buildProjections` per §2.2 and §5.1.
3. `pickStartingXI` gains an optional value accessor (Dashboard call unchanged).
4. `js/engine/squad-value.js`: `squadValue` (optimal XI by `xpts`; captain and vice per §5.2; Triple Captain; Bench Boost counts only the increment over autosub value; blanks via `xpts = 0`, `pZero = 1`) and `autosubRecovery` (linear mode first, then probability mode per §5.2). Then switch the default to `probability`. FPL facts the new files need (`MATCH_MINUTES`, `PERCENT`, `CAPTAIN_MULTIPLIER`, `TRIPLE_CAPTAIN_MULTIPLIER`) are config constants, so the engine files hold no numeric literals but 0 and 1.

**Known v1 limit seen on real data.** Until a player has `minContentionGws` contention gameweeks, his appearance rate is the price prior: after GW1 a nailed but mid-priced starter reads `pZero` ~0.6, and `ppa` rests on one appearance. Both are flagged `estimated`; Phase 4's model replaces them. (Phase 4: with the live table the model reads him from his first GW; that starter reads `pZero` ~0.10 after GW1.)

**Acceptance (tests first)**
- Brief §7 Phase 2 cases, with their conditions pinned: the 3rd-sub defender's ~3% / ~100% case in `linear` mode, plus a hand-computed probability-mode case; the injured-starter and exactly-3-DEF cases run through `autosubRecovery` against a fixed XI (re-picking the XI would bench the injured starter and skip the autosub code); selling the only strong captain costs more than the raw xpts difference.
- Two certain absences and one playing sub recover at most that sub's points.
- Greedy XI equals brute-force formation enumeration on random squads.
- `composite.test.js:98` green; a blank GW projects exactly 0; a double against identical opponents projects exactly 1.9x a single; a DEF at a club with a blank channel gets a neutral edge, not 100.
- 50% appearances at 6 points per appearance, availability 100, neutral fixture: `xpts` 3.0, not 1.5. An ever-present starter has `pZero < 0.05` at any price. A 0% injured nailed starter has `xptsIfPlays > 0`. A 50% doubtful nailed player in a double has `pZero` 0.5. `xpts = (1 - pZero) x xptsIfPlays` for every projection.
- A 25% flag at GW+1 is not 25% at GW+4, including the team-level channel read. A nailed premium who recovers by GW+3 projects at GW+4 within 10% of his pre-injury rate.
- Projections are identical with and without an extra element-summary loaded in the store.

**Guards** Never multiply `xpts` by a start probability again. No fixture-difficulty term on top of `xpts`. The decision engine reads availability only through projections.

### Phase 3: Pairwise enumerator with mode presets

> **How this serves the primary goal:** turns the squad value into one scored move (or Roll) per mode, with every component kept for the explanation.

**Implement** `js/engine/decision.js` `runDecisionEngine`: every feasible `(p, q)`, `V` cached per `(p, q, t)`; §5 formulas per mode; `KeepValue` with the ghost; Free Hit / Wildcard weights; full `best` move for every owned player and mode; lock list; locks and bans; missing-ledger fallback; Bench Boost and Triple Captain chip hints from `squadValue` (only for chips still available in the half that contains the hinted GW). Then each mode's extra logic from §6, as named steps:
- **Mode 1:** hard availability gate - an incoming player flagged out, or with `pZero_1 > pZeroGate`, is never the root buy.
- **Mode 4:** tau gate (points lost over the horizon <= `tau`); efficiency = money freed (`sell(p) - price(q)`) / max(`eps`, points lost); chained second move per §5.2, credited net of its FT / hit cost and decay.
- **Mode 5:** t\* = the GW in the next 5 with the highest sum of top-15 `xpts` (ties: most double-GW fixtures); mean at t\* until Phase 7; chip-aware (BB bench weight 1, TC captain x3, Free Hit blankers not sold); lock value `V_t*(S) - V_t*(S - p + best affordable q)`; players above `lockThreshold` are protected in modes 1-4.
- **Mode 6:** uncovered loss `pZero_t x (xptsIfPlays_t - expected autosub recovery for that slot)`, summed with decay; dead-slot penalty when the expected absence spans `deadSlotMinGws` or more (no bench cover, zero in a Bench Boost week); hold rather than sell when the recovery ends inside the horizon and a sell-price-lowering fall is unlikely.

**Acceptance (tests first)**
- One test per extra-logic rule above.
- `deltaEv` equal to the FT value gives `outScore` 0 and the call "roll"; in Long term, a move with OutScore > 0 but DeltaEV below the FT value also rolls.
- Every owned player carries all components for all six modes.
- A starter who blanks only in a planned Free Hit GW is not a top sell in any mode; the Triple Captain captain gap is exactly double the normal one.
- Bench filler (brief §7): the squad holds a genuine sell, bank 0, and no `q` affordable for the filler beats the weakest starter; the filler is not mode 1's top sell. No cheap-sell penalty is added to pass it.
- Blank next GW (Q8): with a Free Hit planned that GW, a fit premium who blanks is never sold in any mode; without one, Now may offer the sale, tagged "blank GW - one-week view", while modes 2-6 keep him whenever his later GWs outweigh the blank.
- Chip hints: the Bench Boost hint is the GW with the largest Bench Boost increment on a hand-built squad; the Triple Captain hint picks a captain's double over his single; a chip already used in that half is never hinted.
- Identical output for identical input. Under ~5 s per mode on a real squad (risk 3) and on a synthetic 15-man squad now; a lock / ban re-run under 200 ms.

**Review** `requesting-code-review` on the scorer before moving on.

**Guards** Sell price, never current price, in budget and funds logic. Ranking by raw points or form is a bug.

**As built** (`js/engine/decision.js`; tests `tests/engine/decision.test.js`). Readings and starting values the plan left open, all in `config.js` for Phase 7 to tune:
- **Defaults chosen:** Now's `pZeroGate` 0.25 (FPL's 75% flag); Future prep's lambda 0.15 (the midpoint of the brief's 0.10-0.20); Funds' `eps` 0.1 and `chainTopK` 5; Ceiling's `otherWeight` 0.1 and `lockThreshold` 3 points; Structure's `deadSlotMinGws` 2, `deadSlotPenalty` 1 point and `recoveredAvailability` 0.9.
- **t\*** sums the 15 highest xpts across every projected player, squad and candidates alike: the GW with the most to gain for any squad, which also keeps t\* from moving with the moves being scored.
- **Lock value** is null when nothing affordable can replace him: there is then no sale to protect against.
- **Mode 6's uncovered loss** is reported per player but not added to DeltaEV: V already prices it through the autosub term, so every mode credits a move that removes it. The dead-slot penalty is added, in Structure only, as `deadSlotTerm` (expected GWs unavailable = the sum of `1 - availability`, which projections now carry apart from rotation). The hold rule needs a flag now, availability reaching `recoveredAvailability` inside the five GWs, and no `fallLikely` price signal (none until Phase 5).
- **Mode 4's chain** is a second transfer this GW, costed at `transferCost(freeTransfers - 1)`; the funds credit is the better of its net gain and lambda per £1.0m freed.
- **Gates** act on admissible moves: Now's availability gate removes the buy from all of Now's moves; Long term's DeltaEV gate and every threshold filter the root and the alternatives, so an alternative also beats rolling.
- **FT cost** (§5.2) is built here because OutScore needs it; Phase 5 keeps the rest of its list.
- **Measured:** the real 2025-26 league rebuilt as of GW20 from vaastav (790 players, live table GW1-19, the 15 most-selected players): projections 1.6 s, all six modes 0.7 s cold, a lock re-run 45 ms; the synthetic 600-candidate test asserts < 5 s and < 200 ms (with real squad prices and an FPL-like price spread, so the lock re-run searches new Funds chains: about 100 ms here).
- **Review fixes** (the commit after `3870fc1`): a Free Hit / Wildcard GW counts for nothing, so a mode whose every GW a planned chip covers now rolls instead of moving on money alone, and money freed and the dead-slot penalty count only for the share of a mode's weight no chip covers (a Wildcard budget is the squad's value either way); chip plans for GWs already gone are ignored; t\* is never a covered GW (none when all are); `alternativesMax` is its own key, apart from the points window; Funds' weights are `decayBase^k` at run time; the V cache keys planned chips by GW; every preset must weigh as many GWs as Now; a player with no fixture reads `minutesRisk` 'blank', not 'high'; a move's text names only the GWs it counts; no Bench Boost / Triple Captain week is hinted at or after a planned Wildcard.
- **Funds ranks by OutScore**, as every mode does (brief §5's max over q, which is where the chained second move's credit counts); efficiency, money freed per point lost, picks the `chainTopK` downgrades searched for a chain and is shown on the move.
- **Open for Phase 5 (Q7's threshold):** at 5 banked FTs the cost is 0, so Future prep, Funds and Structure (no DeltaEV gate) can recommend a swap whose only gain is a little money freed (OutScore +0.01). It follows Q7 as decided; the hit threshold and FT economics in Phase 5 are where to revisit it. (Resolved in Phase 5: money never makes a move on its own; see its As built.)

### UI (brief §8) - after Phase 3, may run alongside Phase 4

> **How this serves the primary goal:** this is where the one recommended move per mode, and the evidence for it, reaches you.

**Implement** The layout in §4.3, built from `DecisionResult` only. Mode card: root move or Roll, EV gain vs rolling (`outScore`), robustness (hidden until Phase 6), minutes-risk badges, two collapsed alternatives, plain-English why, later-GW parts greyed, pending-news note. Sell/hold table: sortable, KeepValue and OutScore per mode, flags, estimated sell prices marked. Lock / ban buttons re-run the engine. Captain and XI panel with the EV gap. Chip plan pre-filled from the hints. An "Export snapshots" button in the settings bar. Drawer markers from `DecisionResult.lineup`. Then delete everything in §4.1, docs included, in the same commit.

**Pattern checklist** (ui-consistency pass over the app's module views - the bound is `index.html` + `js/main.js`; 5 chrome views counted, `.mx` `.fc` `.rk` `.db` `.pl`, of 6 candidates, landing left out as chrome-less; theme `css/base.css :root` + `assets/fonts.css`, no `DESIGN.md`):
- Holder: `section.module-view[data-module=planner] > .pl`; every rule nested under `.pl` (5 of 5).
- Section head: `<header>` with a `.lbl` kicker and an `h2` in `600 22px/1 var(--font-head)`, .05em, uppercase (ranker, dashboard, planner); a card's title one level down at 20px (dashboard `.card h2`).
- `.lbl`: 700 11px/1.2 sans, .1em, uppercase, muted (5 of 5). Bands through `[data-band]` -> `--b/--bb/--bt` (6 of 6); a colour that is not a rating (minutes risk) reads a primitive (CONVENTIONS §5.2).
- Tabular data is a real `<table>` (CONVENTIONS §6; fixtures 4 of 4): scrolling `region` wrapper with `tabindex=0`, `<caption class="sr">`, `th scope=col` in the `.lbl` bundle, numbers right-aligned in tabular figures, row hover `--color-surface-raised`. Sort control: the ranker's `.sb` header button ("Sort by X, high to low", arrow glyph, `.is-on`); on a real table the header also carries `aria-sort`.
- Toggles are `aria-pressed` buttons (5 of 5); a single choice is `role=radio` / `aria-checked` (planner `.lens`, `.seg`).
- Unsettled values: `.sk` / `.chip.is-pending`, `aria-hidden`, `aria-busy` on the region; a ranked view is skeletoned whole (CONVENTIONS §5.4) - mode cards, the XI and the table all wait for settled counter-matchup data.
- Entrances only under `[data-anim]`, set on reader-caused renders; reduced motion turns every animation off (6 of 6).
- Values: colours only through tokens; spacing and type are px literals in module CSS (5 of 6) on a 2 px step, reused from planner.css's own; no inline styles except `--d` delays.
- Reuse in place: planner's drawer, toast, dialog, bank stepper, `.seg`, `.tog`, `.lens`, `.btn`, `.chip`, `.card` grid.

**Acceptance** Manual check in `vercel dev` (keyboard, reduced motion, 360 px width, skeletons while unsettled, live-round note); `grep -rE 'enumerateSwaps|buildVerdict|LANE_SCALE|planner-run|planner-boards' js tests css index.html` finds nothing; every class in `css/planner.css` has a consumer; `ui-ux-pro-max` review of cards, table and lock/ban flow; `requesting-code-review`.

**Guards** Tokens only, no raw hex outside `base.css` / the `.pl` token block; every rule under `.pl`; no analysis in the module; no parallel old screen.

**As built** (`js/modules/planner.js`, `css/planner.css`, the planner section of `index.html`; tests `tests/modules/planner.test.js`):
- **Layout** as §4.3, with the chip plan as its own section under the settings bar rather than inside it (four chips do not fit a sticky bar). The bar holds the bank stepper, free transfers 0-5 (a radio group; arrow keys move it), the squad drawer and "Export snapshots".
- **Chip plan:** per chip, a week picker over the projection horizon (the planning GW and the five after it), chips used per half (derived from `history/` chips, your marks saved), and the hint with a "Plan GWn" button: a hint is never applied until you press it. A week already holding another chip, or in a half where the chip is used, cannot be picked.
- **Settings** (`gafferiq_planner` in localStorage): your bank and free transfers stand for the import and planning GW you set them for, your chips-used marks for that import, your chip plan always (the engine ignores weeks already gone). No history at all gives one free transfer; history with no deadline before the planning GW gives 5 (transfers are unlimited, so a move costs nothing).
- **Projections** are built once per data load, after the skeletons paint, from the archived minutes tables when they hold every finished GW (a partial table would make most players look out of contention), else from season totals, flagged estimated. That build blocks the main thread once: 1.9-2.4 s on the 2025-26 GW20 pool in headless Chromium. Lock, ban, bank and FT re-runs take 27-209 ms there (the slowest is a lock that changes which downgrades Funds chains).
- **Lock and ban:** "Don't sell" / "Don't buy" on each card, "Keep" on each table row, and a "Not selling / Not buying" line to undo them; each change toasts with Undo and puts keyboard focus back where the reader was. They last for the visit, not saved.
- **Sell / hold table:** the mode pills pick which mode's KeepValue and OutScore show; four columns sort both ways (`aria-sort`, no figure last); the player column stays put while the table scrolls sideways on a phone. `DecisionResult.players` gained `sellPriceTenths` for its sell-price column.
- **Dropped with no consumer left:** the `--pl-cmd-h` ResizeObserver (§4.2 listed it as kept; nothing read the value), the drawer's band chips (they needed the deleted `scoreSquad`), and the landing card's badge (Q9; one `landing.css` rule keeps a badge-less card's text full width).
- **Review fixes** (the commit after `17db173`): gameweeks past GW38 count for nothing in the engine and are never hinted or offered (Wildcard / Free Hit timing too); the first projection build waits, up to `GW_TABLES_WAIT_MS`, for this visit's minutes tables to be archived, so a reload gives the same advice, and the cards say when the projections fall back to season totals; V values are keyed by their GW's planned Bench Boost / Triple Captain, so moving one costs about 250 ms instead of 600; a malformed ledger reads as no import; a chip plan lapses with its season and in a half where its chip is used; locks and bans drop with the squad change that makes them moot; expanded alternatives stay open across re-runs; the why line says "weighted points", the table says Lock, and Keep is defined as what he is worth with his place left empty.
- **Verified** in headless Chromium against intercepted payloads rebuilt from vaastav's 2025-26 data as of GW20 (FPL and the proxy are not reachable from this environment): 1280 px and 360 px with no page scroll sideways, reduced motion, skeletons while counter-matchup data is unsettled, the live-round note with a GW in play, the empty and short-squad states, the drawer's focus trap and Escape, keyboard focus after a lock or ban, and no page errors.

### Phase 4: Minutes and availability model

> **How this serves the primary goal:** autosub value and the structure and "wait for news" calls are only as good as the per-GW chance a player plays.

**Implement** Fit offline in Node (`tools/minutes/`) on vaastav history plus our exported snapshots and live tables; ship coefficients into `DECISION_ENGINE` (no training at runtime). Features per §7 Phase 4. The model supplies `a_t`, `appearRate`, `pStart` and `p60` (`availabilitySource: 'model'`, `p60Approx: false`); `xpts` and `xptsIfPlays` follow through the §2.2 formulas unchanged.

**Acceptance** Brier on P(60+) beats the last-5-starts baseline on a held-out period; calibration table by bucket, reported by return category; `xpts = (1 - pZero) x xptsIfPlays` still holds for every model projection.

**Guards** No bulk `element-summary` fetches in the app. No future data in training rows.

**As built**

- **The model.** `js/engine/minutes.js` (pure, shared with the tool). `minutesFeatures` reads a player's contention record - the GWs his club played before the planning GW, an excused absence removed, a double counted per fixture - as 14 features: start share over the last 3 and 10 GWs and the season, appearances and minutes over the last 5, whether he started and played 60 minutes last time, the zero-minute run and the 60-minute run still going (each `log(1 + n)`), how much record there is (capped at 10 GWs), position and price. `selectionChances` turns them into per-fixture chances to appear, start and play 60+ with three logistic heads. k = 1-5 GWs ahead, each head's logit z reads `a_k + b_k z` (fitted per head and k): the record before the planning GW says less about later GWs, so the chances drift towards the average. Start and 60 are capped at appear. `excusedAbsence` moved here from `projections.js`, so training rows and the app excuse a finished absence the same way; a running one is excused only when FPL flags him, which training rows cannot know, so there it always counts.
- **In `projections.js`.** With the live table and at least `minHistoryGws` (1) GW of record, `appearRate`, `startRate` and the 60-minute rate come from the model for each GW of the horizon; `p60 = a_t (1 - (1 - p60Rate)^n)`, `p60Approx: false`, `estimated: false`. `xpts`, `pZero` and `xptsIfPlays` follow through §2.2 unchanged, and `ppa` still comes from his record. Without the table, or with no record (a new signing), the v1 rates stand in. `buildProjections` takes `minutesModel` (default `DECISION_ENGINE.minutesModel`; `null` runs v1, which the v1 tests pin).
- **The fit.** `tools/minutes/` (Node, offline, never loaded by the app). `download.js` caches vaastav's `merged_gw.csv` per season in `tools/minutes/data/` (gitignored). `lib.js` builds the rows - one per player per single-fixture GW, read with nothing from the planning GW on but the outcome and the kickoff - fits ridge logistic regression by IRLS, and scores. `fit.js` chooses each head's penalty on 2024-25, fits the heads and the recalibration on 2023-24 and 2024-25, tests on 2025-26, and writes `tools/minutes/REPORT.md`, ending with the block pasted into `DECISION_ENGINE.minutesModel`.
- **Acceptance.** P(60+) for the next GW of held-out 2025-26: Brier 0.0809 against 0.1055 for last-5-starts (0.1502 against 0.1980 for players who played in one of their last five); log loss 0.261 against 0.473. The model also beats the v1 rates on every head (P(60+) Brier 0.0804 against 0.1037 on the rows v1 covers). Next GW, every decile of the calibration table is within 4 points. Five GWs ahead the recalibration brings the Brier from 0.1327 to 0.1241. The report gives the calibration table and the scores by return category (OpenFPL's: Zeros did not play, Blanks 2 or fewer points, Tickers 3-4, Haulers 5+). `xpts = (1 - pZero) x xptsIfPlays` holds for every model projection: the projections test checks it with the shipped model, and in the browser all 790 players passed.
- **Departures from the plan and brief.**
  - **Availability is not fitted.** `a_t` is not fitted and `availabilitySource` is never `'model'`: vaastav has no history of FPL's flags or news. Availability stays the flag and `absenceCarryOver`. Injury-type recovery priors would need that news history too.
  - **vaastav only.** Our exported snapshots and live tables cover a few weeks on one device, so they are not training data yet; a refit can add them.
  - **2022-23 left out.** FPL recorded no starts before its GW16.
  - **No congestion or rotation features.** Two club measures were tried: days of rest before the match, and the share of the club's XI changed per GW over its last five. Neither improved any head's validation log loss or Brier by more than 0.0003 (the ablation in `REPORT.md`), so the app does not compute them. European and cup fixtures are in no source here.
  - **No suspension counters.** FPL flags a ban once it is triggered; the risk of a fifth yellow inside the horizon is left as a follow-up.
  - **Added beyond the plan: the per-GW recalibration.** Without it the model is overconfident further out: players given about 86% five GWs ahead played 60 minutes 69% of the time.
  - **Added beyond the plan: the 60-minute run feature.** Without it, ever-present starters read about 2.5 points low on appearing.
- **Known residual.** Keepers are stickier than the model allows. An ever-present keeper gets a 7% chance of no minutes where 4% got none. A keeper-only start term moved the validation scores by under 0.0002, so it is not in the model.
- **Verified** in headless Chromium on the 2025-26 GW20 payloads, with all 19 minutes tables archived. 780 of 790 players ran on the model; the other ten have no record. Projections build in about 1.15 s, against about 1.0 s with the v1 rates. The cards appear about 2 s after a reload, with no page errors.

### Phase 5: Transfer economics and price layer

> **How this serves the primary goal:** decides when a move is worth a transfer at all, and stops a 0.1m wobble from driving advice.

**Implement** FT cost per §5.2 (built in Phase 3, with its table tests), hit threshold, mode 3 deferral test (with the exception for a price move that changes affordability), mode 1 "wait for team news" flag; `js/engine/price-adapter.js` as the only reader of the undocumented predictor fields, falling back to `calcPriceChangeRisk` (flagged); `PriceTerm` from the actual change in `sell(p)`.

**Acceptance (tests first)** FT cost table: banked 0 -> hit cost + margin, 1 -> 1.5, 2 -> 1.0, 4 -> 0.3, 5 -> 0 (flat mode at 5 also 0); deferral test and its affordability exception; price term is zero when a fall does not change the sell price (odd-tenths profit case); the fallback path is tested; a decision on money-only moves at 5 banked FTs (Phase 3 notes).

**Review** `requesting-code-review`.

**As built** (`js/engine/price-adapter.js`, `js/engine/decision.js`; tests `tests/engine/price-adapter.test.js`, `decision.test.js`)

- **The adapter** is the only reader of FPL's predictor. `normalise.js` passes every `price_change_*` field through untouched as `player.priceFeed`. Their shape, read from vaastav's 2026-27 capture of bootstrap-static:
  - `price_change_percent` is a player's progress towards a price change, signed (rise positive), where 100 makes the change.
  - `price_change_projections` holds the progress FPL projects at its next three updates (offsets 0-2). Each entry has a `likelihood`, which is only a coarse band of the projected percent (±5 at 100 or more, ±4 at 95-100, and so on).
  - `price_change_locked_until` and `price_change_hourly_rate` are not read; locked players project 0 anyway.
  - A player's chance of a fall (or rise) is the furthest progress FPL projects towards it, as a share of the threshold, at most 1.
  - While FPL calibrates a player, or without the fields, `calcPriceChangeRisk`'s transfer-flow confidence stands in, flagged `estimate`.
  - On that capture, 615 of 616 players read from FPL; 53 had a likely fall and 11 a likely rise.
- **PriceTerm** = lambda x the expected change in sell(p) x the mode's unmasked weight share. The expected change is each chance times what one fall or rise does to his sell price, so a fall from an odd-tenths profit counts nothing. At lambda 0.10 it is worth at most 0.01 points: a tie-break, as the brief wants.
- **Likely** = a chance of at least `priceMoveLikely` (0.95: FPL's own bands 4 and 5). A likely fall that lowers a seller's sell price stops Structure's hold and Now's wait for team news. Owned players whose sell price a likely move would change are flagged `priceFall` / `priceRise` ("Falling" / "Rising" in the table), and the move's `why.price` says what selling now gains or what buying now saves.
- **Future prep's deferral** (`call: 'wait'`, `deferral: { gw, laterScore, epsilon }`):
  - The root move is scored as if made next week, over the same five GWs with the planning GW given up, against q's expected price then; money freed counts only for the GWs it covers. p sells at today's price there, because the fall that waiting risks is already in today's PriceTerm. It reuses the V values already computed, so it costs no extra V calls.
  - Its free transfer costs what it costs now. Either way the two weeks make one transfer and bank the same free transfers. The exception is with none banked, where waiting turns this week's hit into next week's free transfer (`transferCost(max(ft, 1))`).
  - Within `deferralEpsilon` (0.1) of making it now, the mode waits. In Future prep's units, a weighted average where the planning GW weighs 0.5 / 4.25, that is a move gaining under about 0.85 points this week. `gw` is the first GW the later move counts for (the one after a Free Hit, say).
  - It never waits:
    - when no later GW counts (the season's last GW, a Wildcard next week);
    - when a likely fall in p's sell price or rise in q's price would put q out of reach (the brief's exception);
    - at the free-transfer cap, where waiting would roll one away (brief §10).
  - A waiting mode's seller is not flagged `sell`.
  - **The window (your call after the review: option B).** The approved reading scored the later move over GW t+1..t+5. It never charged the gain the move would have made in the planning GW, so a move whose gain was the same every week always waited. Both versions are now scored over the same five GWs, with the planning GW at zero for the later one, so waiting costs that week's gain: a steady gain is made now, and WAIT appears when the gain comes later. `deferralEpsilon` went from 0.25 to 0.1 with it. At 0.25 a steady gain of up to about 2.1 points a GW would still have waited.
- **Now's `waitForNews`.** All of these must hold:
  - a flagged (doubtful) player is in its move;
  - more than `waitForNewsMinHours` (24) remain to the deadline, so the press conferences are still to come; the planner passes `hoursToDeadline` from the event's deadline;
  - no likely fall lowers the seller's sell price and no likely rise lifts the buy's price.
- **Money alone never makes a move** (the Phase 3 open item, resolved). A move with no squad gain (DeltaEV + dead-slot term ≤ 0) and no second move it pays for is not made in any mode but Funds. Funds makes it only when it frees at least `minFreedTenths` (£0.5m). Otherwise, at five banked FTs, a £0.1m downgrade cleared Q7's threshold.
- **Already in place from Phase 3:** the FT cost table and the hit threshold, with their tests (0 -> 6, 1 -> 1.5, 2 -> 1.0, 4 -> 0.3, 5 -> 0, flat at 5 -> 0).
- **UI.**
  - A waiting Future prep card reads WAIT with a muted top bar. It says what the move scores if made next week against now, keeps the sell and buy rows with their Don't sell / Don't buy, and shows the price line when there is one.
  - Now's card says "Wait for team news" when it waits, and keeps the old "Team news pending" note otherwise.
  - The table shows Falling / Rising flags, red and green, AA on every surface; their title says when the signal is the transfer-flow estimate.
- **Readings and defaults to check** (all in `config.js`, untuned):
  - `priceMoveLikely` 0.95, `waitForNewsMinHours` 24, `deferralEpsilon` 0.1, `minFreedTenths` 5.
  - Progress-as-chance for an undocumented field.
  - Now's wait also needs no likely rise in the buy's price; the brief names only a fall.
  - The deadline clock is the browser's.
- **Review fixes** (the commit after `7386ef1`):
  - The deferral's free transfer costs the same now and next week. Before, next week's cheaper FT gave waiting an unearned 0.3-0.5 points.
  - It never waits when no later GW counts; its GW skips a Free Hit; p's expected fall is not counted twice.
  - A signal without numeric chances (such as the old `{ fallLikely }` shape) reads as no move expected instead of NaN.
  - "Estimated" goes only on the price lines an estimate gives, and FPL's "-0.0" is no longer a negative zero.
  - The WAIT card's words fit 0 FTs and say that waiting has a price.
  - New tests: the season-end and Wildcard deferrals, the Free Hit GW, 0 FTs, the odd-tenths flag and hold, the estimate source end to end, malformed signals and -0.
  - Left as it is: `hoursToDeadline` is read on each run, so a tab left open past the 24-hour mark keeps "wait for team news" until the next run, as the planning GW does past a deadline.
- **Verified** in headless Chromium on the 2025-26 GW20 payloads, with predictor fields injected:
  - Future prep showed WAIT for M.Salah -> Gravenberch at first: +1.2 next week against +0.8 now, then +0.8 against +0.8 after the review's FT-cost fix.
    - Under option B it makes the move (+0.8), a steady gain.
    - With `deferralEpsilon` widened in the page, its WAIT card reads +0.6 next week against +0.8 now.
  - Funds and Structure show the price line, and Salah's row is flagged Falling.
  - Removing the fields falls back to the estimate without errors.
  - With the deadline 2099, a 25% Haaland in Now's move shows "Wait for team news"; with it 6 hours away, "Team news pending".
  - 360 px has no sideways scroll; no page errors; cards about 2 s after a reload, as before; an FT change repaints in about 150 ms.

### Phase 6: Robustness layer

> **How this serves the primary goal:** tells you how much to trust a recommendation, and what else was close.

**Implement** Seeded PRNG; `robustnessRuns` re-runs with noise on `xpts`, `pZero`, FT value and decay; 3/2/1 scoring of top-3 per run; robustness % and alternatives within `alternativesWindow`. Runs after first paint, off the lock / ban path (a module Web Worker if it blocks the main thread).

**Acceptance** Dominant move shows high robustness; two near-identical moves split.

### Phase 7: Backtest harness and ceiling mode

> **How this serves the primary goal:** the only honest evidence that the new advice beats the old advice and beats doing nothing.

**Implement** `tools/backtest/` (Node): point-in-time context from vaastav + Understat (dates sliced), many starting squads, metrics and baselines per §7 Phase 7, old engine from the tag (§4.4), paired per-GW bootstrap CIs; tune config; ceiling Monte Carlo and `pP90`. Report `docs/decision-engine-backtest.md`.

**Acceptance** States plainly, with confidence intervals, whether the new engine beats the old engine and the roll baseline, and whether the mixed weight units (risk 8) cost points.

**Guards** Suspect leakage first when numbers look good.

### Phase 8 (optional): MILP referee

> **How this serves the primary goal:** cross-checks multi-transfer chains and chip timing the pairwise engine cannot see.

Per risk 5; report disagreements, Apache-2.0 attribution.

### Final: Verification and docs

> **How this serves the primary goal:** leaves the next reader able to trust and tune the engine.

- `docs/decision-engine.md`: data contract, formulas, modes, config.
- Docs left over from the UI-phase commit, if any, brought in line.
- Anti-pattern greps: `.price` in budget code paths of `decision.js` / `feasibility.js`; `chanceOfPlayingNext` in decision-engine files other than `projections.js`; numeric literals other than 0 and 1 in the new engine files.
- `npm test`; `finishing-a-development-branch` to choose how to land on `main` (fast-forward or a merge made on `main`, per the repo's deploy note).
