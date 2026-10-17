# Decision engine plan (Phase 0)

Date: 2026-10-16, revision 2 on 2026-10-17 (after an adversarial review of
revision 1 against the code and the brief: 58 findings, 44 confirmed and folded
in below).
Status: **draft, awaiting approval** - no code has been changed.
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
- **`a_t` availability.** `k = 0`: FPL's `chance_of_playing_next_round`, else `STATUS_PLAY_CHANCE[status]`. `k >= 1`: the recovery curve in config, by status. Never carried flat.
- **Contention GWs `C`.** Elapsed GWs, minus the player's latest run of zero-minute GWs when that run is still going and he is flagged now, or ended within `absenceLookbackGws` and he has played since (P8). Per-GW minutes come from the Phase 1 `event/{gw}/live/` table (one request per finished GW, every player). Without the table, `C` = all elapsed GWs, flagged estimated.
- **Rates, unshrunk.** `appearRate` = GWs in `C` with minutes > 0 / |C| (fallback: starts / elapsed GWs); `ppa` (points per appearance) = points in `C` / appearances in `C` (fallback: points / starts); `startRate` = season starts / |C| (starts only happen in contention GWs). If |C| < `minContentionGws`, fall back to `calcPlaytimeSecurity`'s price prior, flagged estimated. Never the price-shrunk `startRate` for `pZero` (an ever-present cheap starter would get a false 29% pZero).
- **`fm_t` fixture multiplier** from the pre-uplift GW mean (P2), with the P4 guard. `n_t` = fixtures in GW `t`; `count(n) = n == 0 ? 0 : 1 + DGW_EXPECTED_PTS_FACTOR x (n - 1)`.

```
xpts_t        = a_t x appearRate x ppa x fm_t x count(n_t)
pZero_t       = n_t == 0 ? 1 : (1 - a_t) + a_t x (1 - appearRate)^n_t     // availability shared across a double, selection per fixture
xptsIfPlays_t = n_t == 0 ? 0 : xpts_t / (1 - pZero_t)                     // when 1 - pZero_t <= eps: the a_t = 1 value
pStart_t      = a_t x startRate                                            // approximate until Phase 4
p60_t         = pStart_t x completion,  p60Approx: true                    // completion = minutes / (starts x 90)
pP90          = null                                                       // Phase 7
```

For a single GW this gives `xptsIfPlays = ppa x fm x count`, independent of
`a_t`, so an injured nailed starter keeps a positive `xptsIfPlays` (needed by
mode 6's uncovered loss), and `xpts = (1 - pZero) x xptsIfPlays` holds exactly.
With the fallbacks, `xpts = a x avgPointsPerGw x fm x count`, i.e. P1 removed.
Phase 4 swaps only the sources of `a_t` and `appearRate`; the formulas stay.

Known v1 limits, all replaced by Phase 4: an impact sub's appearances are
undercounted without the live table; a benched (not injured) player's finished
zero run is excluded like an injury; a mid-season arrival's early GWs count
against him.

### 2.3 Field status

| Field | Status today | v1 (this plan) |
|---|---|---|
| `xpts` | **Approximation, and wrong** (P1-P4, per window not per GW) | §2.2, per GW |
| `p_start` | **Approximation** (`startShare` is a minutes share; `playtime.startRate` is price-shrunk) | `a_t x startRate`, flagged approximate |
| `p_zero` | **Not produced** | §2.2 |
| `p_60` | **Not produced** | `pStart x completion`, `p60Approx: true` |
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
- `index-FXL00-CK7M8F4.html` and the `me/` allowlist entry (Q9).
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
merged. Before the first code change, tag the base commit
`gaffer-iq-pre-decision-engine`; Phase 7 runs the old engine from that tag in
a git worktree as its "old engine" baseline, so no frozen copy of dead code
has to live in the tree.

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
 * @property {boolean} p60Approx     true until Phase 4
 * @property {number}  xptsIfPlays   brief: xpts_if_plays
 * @property {number|null} pP90      brief: p_p90, null until Phase 7
 * @property {boolean} estimated
 * @property {'fpl'|'status'|'recovery'|'model'} availabilitySource
 */

/** @returns {Map<number, { playerId, position, teamId, price, gws: GwProjection[] }>} */
export function buildProjections(players, ctx, { planningGw, horizonGws, gwTable, scorePlayerFn = scorePlayer })
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
- **Autosubs, probability mode.** Each bench player comes on at most once. Expected recovery is computed exactly over the absence patterns of outfield starters (up to `autosubMaxAbsences`), applying FPL's bench order and formation rules to each pattern; the GK slot is separate (`pZero_gk1 x xpts_gk2`). Probability mass beyond the cap is reported in `components`, not credited. Bench order: outfield by `xptsIfPlays` descending, GK last (configurable).
- **Free Hit and Wildcard** are handled in `decision.js` by weights, not in `squadValue`: `w_t = 0` for a planned Free Hit GW, and for every GW from a planned Wildcard onward, in DeltaEV, KeepValue and lock value.
- **Ghost** (KeepValue): `{ xpts: 0, xptsIfPlays: 0, pZero: 1 }`, built directly, never passed through `checkSwap` or the funds term.
- **No ledger entry** for a player (drawer edit, Dashboard import): purchase = current price, so sell = current price, flagged `estimated` on the move and in the table.
- **Free transfer cost.** With `n` FTs banked: `n == 0` -> `hitCost + hitMargin`; `n >= maxBankedFt` -> 0; otherwise the value of the FT that rolling would bank, `ftValueSchedule[n + 1]` (or `ftValueFlat`). So 1 -> 1.5, 2 -> 1.0, 4 -> 0.3, 5 -> 0.
- **Performance bounds.** `V_t(S - p + q)` is computed once per `(p, q, t)` and reused by all six modes, which differ only in weights, lambda and gates; lock and ban only re-filter. Mode 4 chaining takes the top-K downgrades only, draws the second buy from the newly affordable price band, and scores the pair jointly as `V(S - p + q - r + s)` with the club check across both moves. Robustness runs after first paint and never on the lock / ban path.

```js
input = {
  planningGw,
  squad: [{ playerId, position, teamId, price, purchasePrice, sellPrice, sellPriceEstimated }],  // 15
  bank, freeTransfers,
  chipPlan: { [gw]: 'benchboost' | 'triplecaptain' | 'freehit' | 'wildcard' },
  locks: Set<playerId>, bans: Set<playerId>,
  projections,        // from buildProjections
  candidates,         // Player[]: every feasible replacement, per position (no cap)
  priceSignals,       // Phase 5 adapter output, or null
}

DecisionResult = {
  modes: { [modeId]: {
    modeId, label, weights,
    call: 'move' | 'roll' | 'wait',
    root: Move | null,
    rollValue,                       // display only: the value of the FT kept by rolling
    alternatives: Move[],            // within `alternativesWindow` points, max 2
    waitForNews: boolean, deferral: { laterScore, epsilon } | null,
    robustness: number | null,       // Phase 6
  } },
  players: [{ playerId,
    keepValue: { [modeId]: number }, outScore: { [modeId]: number },
    best: { [modeId]: Move | null }, // full components for every owned player, every mode
    flags: Array<'sell' | 'hold' | 'protected' | 'locked' | 'pendingNews' | 'sellPriceEstimated'>,
    lockValue: number | null }],
  lineup: { xi, bench, captainId, viceId, captainGap, nextCaptainId },
  chipHints: {                       // pre-fill only; never applied unless you accept them (Q4)
    benchboost:    { gw, gain, reasoning } | null,   // GW with the largest Bench Boost increment from squadValue
    triplecaptain: { gw, gain, reasoning } | null,   // GW with the largest captain bonus
  },
}

Move = {
  outId, inId,
  deltaEv, perGw: number[],          // w_t x (V_t(S - p + q) - V_t(S)) per GW
  fundsTerm, priceTerm, transferCost,
  outScore,                          // = deltaEv + fundsTerm - priceTerm - transferCost: the gain over rolling
  tentativeFromGw,                   // later-GW parts shown greyed
  minutesRisk: { out: 'low' | 'medium' | 'high', in: 'low' | 'medium' | 'high' },
  chained: Move | null,              // mode 4 only
  why: { squad, funds, price, cost }, // plain-English sentences, built in the engine
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
  autosubMaxAbsences: 3,
  benchOrder: 'xptsIfPlays',
  benchWeightsLinear: { s1: 0.30, s2: 0.10, s3: 0.03, gk: 0.03 },
  fundsModeTau: 1.0,
  robustnessRuns: 30,
  alternativesWindow: 2,
  availabilityRecovery: { /* per status, per GW ahead */ },
  absenceLookbackGws: 5, minContentionGws: 3,
  seasonMaxAgeMinutes: 60, snapshotMinIntervalMinutes: 360,
  modes: {
    now:       { weights, lambda, pZeroGate, threshold },
    longterm:  { weights, lambda, threshold },
    future:    { weights, lambda, threshold, deferralEpsilon },
    funds:     { weights, tau, eps, chainTopK, threshold },
    ceiling:   { targetWeight, otherWeight, lockThreshold, threshold },
    structure: { weights, lambda, deadSlotMinGws, deadSlotPenalty, threshold },
  },
};
```

Mode weights, normalisation and thresholds follow Q6 and Q7.

---

## 6. Risks, and what in the brief does not fit the repo

1. **No server-side store.** Resolved: the ledger is a pure function over the public transfers endpoint, cached in `localStorage`; snapshots are captured in the browser on each visit and kept in IndexedDB (Q1).
2. **Snapshots live on one device and have gaps.** Browser capture records only on days the app is opened, only in that browser. Phase 4 and Phase 7 read snapshots through an "Export snapshots" JSON download; a missed day is a missing row, never an interpolated one; clearing site data loses history (the export is the backup). Nothing runs outside `projects/apps/gaffer-iq/`.
3. **Network.** You will allow `fantasy.premierleague.com` in this environment (Q3). When re-checked on 17 Oct it was still refused; `raw.githubusercontent.com` (vaastav) is reachable. Until the FPL host is allowed, Phases 1-3 run on synthetic squads, and the live checks (price-predictor fields, real-squad timing, ledger and Free Hit import against a real account) wait.
4. **Price-predictor fields are unverified** (risk 3). Phase 5 isolates them in one adapter file; if they are absent, the adapter falls back to `calcPriceChangeRisk`, flagged as an estimate. Snapshots keep unknown element fields from Phase 1 on, so the fields are logged even before the adapter reads them.
5. **The MILP referee is Python.** open-fpl-solver needs Python + HiGHS; the repo says "zero Python anywhere in the stack". Phase 8 would run it as an offline tool outside the served app, or port the formulation to Node with a WASM HiGHS build (licence check first). Decide at Phase 8.
6. **Performance (measured on synthetic data).** The real `scorePlayer` took 430 ms for 255 players x 6 single-GW calls and 570 ms for 615 x 6, so projecting every feasible candidate fits the 5 s budget; **no candidate cap**, as the brief decided brute force. `pickStartingXI` costs ~3 us, so single-swap enumeration (~5-15k `V` calls) is cheap. The two things that would not fit, unbounded mode 4 chaining (~1M `V` calls) and synchronous robustness, are bounded in §5.2. If Phase 3 measurement still blows the budget, a capped pre-filter comes back to you as a question, with its criterion.
7. **Brief inconsistencies to confirm** (Q10): `horizon_gws: 6` vs five weights per mode (plan: the 6th GW is used only by the mode 3 deferral test); mode 3 is titled "GW+3..+5" but its weights cover GW+1..+5 (plan: use the weights as written); Ceiling's upper tail does not exist before Phase 7 (plan: Phase 3 ships Ceiling on the mean at t\*, labelled as such). Mode 4's lambda "derived (see below)" is read from the same row: the funds credit is the chained second move's net gain, else `lambdaDefault`.
8. **Units of DeltaEV** (Q6). Modes 2 and 3 normalise their weights (sum 1, a per-GW average) while mode 6 does not (sum 3.70, a horizon total), yet all are compared against the same one-off FT value and hit cost. The same move can roll in mode 2 and go ahead in mode 6.
9. **Dashboard divergence.** The Dashboard keeps its own XI and captain from `expectedPoints`. The P1-P4 root fixes reach it, so it uses the same corrected rule; it still reads one projection per window rather than the per-GW projections. Moving the Dashboard onto the new projections is a follow-up.
10. **Free transfer derivation.** 2026/27 FT rules (what Wildcard / Free Hit do to banked FTs, any mid-season top-up) are not in the API. Derived count is a pre-fill; the control stays editable.
11. **Free Hit and the import.** During a Free Hit week the import returns the temporary squad and bank; Phase 1 re-reads picks and bank from GW-1 when `active_chip` is `freehit`. Whether `transfers/` lists Free Hit moves needs a real account (risk 3); purchase prices stay editable.
12. **The live table costs requests.** One `event/{gw}/live/` request per finished GW, once (re-fetched until that GW's bonus is confirmed), cached in IndexedDB. Up to 38 small requests over a season; light, and nothing else in the app bulk-fetches.
13. **Backtest leakage and effort.** Reconstructing the engine's context for past GWs from vaastav needs care: team strengths in that dataset may be end-of-season values, status flags are not available historically (structure mode cannot be backtested until our own snapshots accumulate), and the old engine needs the same reconstructed context. Phase 7 is the largest phase.
14. **Terms and access flags (§11)** found in the repo: the proxy sends a spoofed desktop Chrome user agent (`api/fpl.js:120`); `Access-Control-Allow-Origin: *` (`:143`) lets any site use this proxy against FPL; the Understat `match/{id}` route forwards a scraped HTML page. Check the vaastav dataset's licence before using it. Snapshots stay on your device, so no FPL data is redistributed.
15. **Pre-existing failures.** The 5 failing `channel.test.js` tests stay out of scope. `composite.test.js:98` turns green with the P3 fix. The baseline must not otherwise move.
16. **Skills.** `smart-explore` could not parse files under `projects/apps/` (the repo's `.claudeignore` excludes that path), so discovery used targeted reads. `pathfinder` was applied inline rather than writing a `PATHFINDER-*/` folder at the repo root, which would break the folder restriction. Phases 1 onward use a branch rather than a separate worktree; the cloud container is already isolated.

## 7. Open questions (grill-me pass)

- **Q1 Snapshots. Decided:** browser capture on each visit, stored in IndexedDB, exportable as JSON.
- **Q2 Ledger. Decided:** allowlist both `entry/{id}/transfers/` and `entry/{id}/history/` (public, read-only) in the proxy.
- **Q3 Network. Decided:** you will allow `fantasy.premierleague.com` (and `raw.githubusercontent.com`, already reachable) in this environment.
- **Q4 The run and chip hints. Decided:** delete the run; keep chip-week hints as pre-fills for the chip plan, re-pointed so Bench Boost and Triple Captain come from the engine's projections and real bench (Wildcard and Free Hit stay in `chips.js`).
- **Q5 Root fix for the minutes double count (P1). Decided:** fix `calcExpectedPoints` at the root; the Dashboard's captain and XI order will move.
- **Q6 Units of DeltaEV** (risk 8). Use weights as per-GW discount factors without normalising, so DeltaEV is a horizon total in the same unit as the FT value and hit cost?
- **Q7 Threshold.** Recommend a move whenever OutScore > 0 in every mode (OutScore already nets the FT value or the hit)?
- **Q8 Blank next GW in mode 1.** What should Now do with a fit premium whose team blanks next GW?
- **Q9 Leftovers.** Rewrite the landing card copy, delete `index-FXL00-CK7M8F4.html`, drop the `me/` allowlist entry?
- **Q10** Confirm the readings in risk 7.

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
2. `js/engine/ledger.js`: `buildPurchaseLedger` (keyed by player id, joined to `store.getSquad()`), `deriveFreeTransfers` (for the planning GW, so a live GW's roll-over counts). `api.js`: `fetchEntryTransfers`, `fetchEntryHistory`; two anchored patterns in `api/fpl.js`'s `ALLOWED_PATTERNS`, same shape as `entryPicks`. `squadImport.js` also returns `active_chip`, `entry_history.bank`, the ledger and derived FTs; when `active_chip` is `freehit`, picks and bank come from GW-1. Ledger plus bank / FT / chip overrides persisted in `localStorage`, editable.
3. `js/engine/feasibility.js` `checkSwap`: positions, 3 per club after removing p, `price(q) <= bank + sell(p)`, legal formation still possible.
4. Season freshness: a max age (`seasonMaxAgeMinutes`) on the season restored from `sessionStorage`; older than that, it is refetched before advice is built.
5. `js/snapshots.js` (module layer, the same side-effect tier as `js/calibration.js`): on `data:ready`, capture one record holding the per-player bootstrap fields (status, news, `chance_of_playing_*`, `now_cost`, `cost_change_*`, transfers in/out, ownership) **plus any element key `normalise.js` does not know** (so new predictor fields survive), the events row, the capture time and the bootstrap fetch time. Skip when the fetch time equals the last record's (a cached payload is not a new observation) or inside `snapshotMinIntervalMinutes`. Also build the per-GW table from `event/{gw}/live/` (minutes, points, starts when present), once per finished GW, re-fetched until its bonus is confirmed. Stored in IndexedDB through a `get` / `put` / `getAll` adapter wrapped in try/catch that degrades to a no-op and never throws into `data:ready`. The record builder is pure and the store is injected. "Export snapshots" downloads everything as one JSON file.

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
1. Root fixes in the prediction layer: P3 (count 0 -> 0), P2 (`nextFixtureScore` from the pre-uplift GW mean; the uplift stays in `value` only), P4 (`edgeValue = oppCm.value == null ? 50 : 100 - oppCm.value`), and P1 (the minutes factor in `calcExpectedPoints` becomes availability alone, Q5). The commit message records the before/after on the Dashboard captain, XI order and Ranker numbers for one squad.
2. `js/engine/projections.js` `buildProjections` per §2.2 and §5.1.
3. `pickStartingXI` gains an optional value accessor (Dashboard call unchanged).
4. `js/engine/squad-value.js`: `squadValue` (optimal XI by `xpts`; captain and vice per §5.2; Triple Captain; Bench Boost counts only the increment over autosub value; blanks via `xpts = 0`, `pZero = 1`) and `autosubRecovery` (linear mode first, then probability mode per §5.2). Then switch the default to `probability`.

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
- `deltaEv` equal to the FT value gives `outScore` 0 and the call "roll".
- Every owned player carries all components for all six modes.
- A starter who blanks only in a planned Free Hit GW is not a top sell in any mode; the Triple Captain captain gap is exactly double the normal one.
- Bench filler (brief §7): the squad holds a genuine sell, bank 0, and no `q` affordable for the filler beats the weakest starter; the filler is not mode 1's top sell. No cheap-sell penalty is added to pass it.
- The blank-next-GW case behaves as Q8 decides.
- Chip hints: the Bench Boost hint is the GW with the largest Bench Boost increment on a hand-built squad; the Triple Captain hint picks a captain's double over his single; a chip already used in that half is never hinted.
- Identical output for identical input. Under ~5 s per mode on a real squad (risk 3) and on a synthetic 15-man squad now; a lock / ban re-run under 200 ms.

**Review** `requesting-code-review` on the scorer before moving on.

**Guards** Sell price, never current price, in budget and funds logic. Ranking by raw points or form is a bug.

### UI (brief §8) - after Phase 3, may run alongside Phase 4

> **How this serves the primary goal:** this is where the one recommended move per mode, and the evidence for it, reaches you.

**Implement** The layout in §4.3, built from `DecisionResult` only. Mode card: root move or Roll, EV gain vs rolling (`outScore`), robustness (hidden until Phase 6), minutes-risk badges, two collapsed alternatives, plain-English why, later-GW parts greyed, pending-news note. Sell/hold table: sortable, KeepValue and OutScore per mode, flags, estimated sell prices marked. Lock / ban buttons re-run the engine. Captain and XI panel with the EV gap. Chip plan pre-filled from the hints. Drawer markers from `DecisionResult.lineup`. Then delete everything in §4.1, docs included, in the same commit.

**Acceptance** Manual check in `vercel dev` (keyboard, reduced motion, 360 px width, skeletons while unsettled, live-round note); `grep -rE 'enumerateSwaps|buildVerdict|LANE_SCALE|planner-run|planner-boards' js tests css index.html` finds nothing; every class in `css/planner.css` has a consumer; `ui-ux-pro-max` review of cards, table and lock/ban flow; `requesting-code-review`.

**Guards** Tokens only, no raw hex outside `base.css` / the `.pl` token block; every rule under `.pl`; no analysis in the module; no parallel old screen.

### Phase 4: Minutes and availability model

> **How this serves the primary goal:** autosub value and the structure and "wait for news" calls are only as good as the per-GW chance a player plays.

**Implement** Fit offline in Node (`tools/minutes/`) on vaastav history plus our exported snapshots and live tables; ship coefficients into `DECISION_ENGINE` (no training at runtime). Features per §7 Phase 4. The model supplies `a_t`, `appearRate`, `pStart` and `p60` (`availabilitySource: 'model'`, `p60Approx: false`); `xpts` and `xptsIfPlays` follow through the §2.2 formulas unchanged.

**Acceptance** Brier on P(60+) beats the last-5-starts baseline on a held-out period; calibration table by bucket, reported by return category; `xpts = (1 - pZero) x xptsIfPlays` still holds for every model projection.

**Guards** No bulk `element-summary` fetches in the app. No future data in training rows.

### Phase 5: Transfer economics and price layer

> **How this serves the primary goal:** decides when a move is worth a transfer at all, and stops a 0.1m wobble from driving advice.

**Implement** FT cost per §5.2, hit threshold, mode 3 deferral test (with the exception for a price move that changes affordability), mode 1 "wait for team news" flag; `js/engine/price-adapter.js` as the only reader of the undocumented predictor fields, falling back to `calcPriceChangeRisk` (flagged); `PriceTerm` from the actual change in `sell(p)`.

**Acceptance (tests first)** FT cost table: banked 0 -> hit cost + margin, 1 -> 1.5, 2 -> 1.0, 4 -> 0.3, 5 -> 0 (flat mode at 5 also 0); deferral test and its affordability exception; price term is zero when a fall does not change the sell price (odd-tenths profit case); the fallback path is tested.

**Review** `requesting-code-review`.

### Phase 6: Robustness layer

> **How this serves the primary goal:** tells you how much to trust a recommendation, and what else was close.

**Implement** Seeded PRNG; `robustnessRuns` re-runs with noise on `xpts`, `pZero`, FT value and decay; 3/2/1 scoring of top-3 per run; robustness % and alternatives within `alternativesWindow`. Runs after first paint, off the lock / ban path (a module Web Worker if it blocks the main thread).

**Acceptance** Dominant move shows high robustness; two near-identical moves split.

### Phase 7: Backtest harness and ceiling mode

> **How this serves the primary goal:** the only honest evidence that the new advice beats the old advice and beats doing nothing.

**Implement** `tools/backtest/` (Node): point-in-time context from vaastav + Understat (dates sliced), many starting squads, metrics and baselines per §7 Phase 7, old engine from the tag (§4.4), paired per-GW bootstrap CIs; tune config; ceiling Monte Carlo and `pP90`. Report `docs/decision-engine-backtest.md`.

**Acceptance** States plainly, with confidence intervals, whether the new engine beats the old engine and the roll baseline.

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
