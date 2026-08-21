# ROADMAP.md

> Phased build plan for **Gaffer IQ**. Each phase has concrete, checkable deliverables and an exit criterion. Build phases in order — later phases assume the earlier ones are done and stable. This document defines *what* and *in what order*; `ARCHITECTURE.md`, `CONVENTIONS.md`, and `FEATURE_ENGINE.md` define *how*.
>
> Guiding sequencing principle: **get real data flowing end-to-end before building any analytics, and get one full vertical slice working before going wide.** Do not build all four modules half-way. Build one module fully, prove the pipeline, then expand.

---

## Phase 0 — Scaffold (half a day; do this first, it's not optional)

Before any feature work, stand up the skeleton exactly as `ARCHITECTURE.md` §3 specifies.

**Deliverables**
- Repo scaffolded with the full folder/file tree (empty but present files, each with its header comment per `CONVENTIONS.md` §7.1).
- `js/main.js` entry module created and referenced from `index.html` via `<script type="module">`.
- `vercel.json` + `package.json` in place; project deploys to Vercel as an empty shell that loads without console errors.
- `config.js` populated with the constants named in `FEATURE_ENGINE.md` (weights, windows, horizon defs, bands) — values can be the documented defaults.
- README documents local dev (`vercel dev` / `npx serve`) and the deploy flow.

**Exit criterion:** the empty app loads on the live Vercel URL with no errors; ES modules resolve; `config.js` imports work.

---

## Phase 1 — MVP: data flowing + the Matchup Analyser working end-to-end

The goal of Phase 1 is a **single proven vertical slice**: real FPL data → proxy → normalise → engine → one rendered module. The chosen MVP module is the **Matchup Analyser**, because it exercises the most of the engine (it shows the full breakdown) and validates the scoring model visually before anything is built on top of it.

### 1A. Data pipeline (build first)
- `api/fpl.js` proxy: working, allowlisted (`bootstrap-static/`, `fixtures/`, `element-summary/<id>/`), correct CORS + cache headers, error envelope. (`ARCHITECTURE.md` §5)
- `api.js`: `fetchBootstrap()`, `fetchFixtures()`, `fetchPlayerSummary(id)` — the only `fetch` calls in the app.
- `store.js`: in-memory + `sessionStorage` cache, pub/sub (`data:ready`, `data:error`), manual refresh.
- `engine/normalise.js`: raw FPL payloads → `Team`, `Player`, `Fixture` internal models (`ARCHITECTURE.md` §8). Nothing downstream ever touches raw FPL field names again.

**Exit criterion for 1A:** from the browser console you can load the app and inspect a fully normalised list of 20 teams, ~700 players, and the season's fixtures, all in the internal model shape, fetched live through the proxy.

### 1B. Engine — enough to score a fixture
Implement, as pure functions with the formulas in `FEATURE_ENGINE.md`:
- `calcBaseDifficulty` (§2) — always available, the floor.
- `calcHomeAwaySplit` (§3).
- `calcTeamForm` (§5).
- `calcCounterMatchup` (§7.2) — the signature metric; position-based.
- `calcStyleClash` (§6) — proxy version is fine for MVP.
- `calcFixtureHistory` (§4) — minimal; may return mostly-estimated values initially.
- `composite.js → scoreFixture` (§8) combining all of the above with `WEIGHTS`, producing `CompositeScore` with full `breakdown` + `confidence` + `band`.

**Exit criterion for 1B:** `scoreFixture` returns a sensible `CompositeScore` for any fixture, and the §12 sanity benchmark passes (obvious fixtures land in the obvious bands).

### 1C. Matchup Analyser module (the visible MVP)
- `modules/matchup.js` renders one fixture from **both** teams' perspectives.
- Shows: composite value + band (coloured), every sub-metric in the breakdown with its weight, the counter-matchup pairings (FWD-vs-CB etc.), confidence indicator, and the official FPL FDR alongside for comparison ("here's what the app says vs what Gaffer IQ says").
- A fixture picker (choose any upcoming fixture).
- CSS: `base.css` design tokens incl. the five band colours, `layout.css` app shell + the **horizon switcher** (even though Phase 1 mostly uses GW1, build the switcher now since it's cross-cutting), `components.css` for the matchup card.

**Exit criterion for Phase 1:** On the live Vercel URL, you can pick any upcoming fixture and see Gaffer IQ's full, explainable matchup breakdown for both teams, powered by live FPL data, side-by-side with the official FDR. The whole pipeline (proxy → normalise → engine → DOM) is proven.

---

## Phase 2 — Expand the modules

With the pipeline and scoring proven, go wide. Build the remaining three modules on the **same** engine. Also implement full horizon aggregation, which Phase 1 only stubbed.

### 2A. Horizon aggregation
- `composite.js → scoreOverHorizon` (`FEATURE_ENGINE.md` §9): mean/min/blend, GW decay, **blank and double GW handling**.
- Horizon switcher fully wired: changing horizon re-renders all live modules via `horizon:changed`.
- `composite.js → scorePlayer` (§10) player projection + `valueScore`.

**Exit criterion:** any team's fixture run over 3 and 6 GWs renders as a coloured per-GW strip, correctly handling at least one real blank/double GW in the season's data.

### 2B. Player Ranker
- `engine` `rankPlayers` + `modules/ranker.js`: sortable/filterable `<table>` (position, price band, team, min minutes-security), projected value over active horizon, per-GW fixture strip per player, toggle between raw projection and `valueScore` (points-per-million).
- Lazy-load player summaries on demand (no bulk fetch).
- Click a player → drill into the Matchup Analyser for their next fixture.

**Exit criterion:** a ranked, filterable list of players by projected value over any horizon, each linking to its underlying matchup breakdown.

### 2C. GW Decision Dashboard
- `modules/dashboard.js`, horizon-locked to GW1.
- Manual squad entry (Phase 1/2 has no squad import): pick your 15.
- Outputs: captaincy recommendation (top projection in squad), suggested starting XI + bench order, risk flags (low minutes-security, brutal band, low confidence).
- Live points integration via `event/<gw>/live/` when the GW is in progress (re-fetch, never cache live).

**Exit criterion:** enter your squad, get a captaincy pick, XI/bench order, and risk flags for the current GW; live points appear during an active GW.

### 2D. Transfer Planner
- `modules/planner.js`: takes current squad + budget + free transfers, evaluates out→in swaps using `scoreOverHorizon`/`scorePlayer`, ranks transfers by projected gain, models the −4 point hit, respects budget.
- Surfaces top N single transfers and the best 2-transfer combination over the active horizon.

**Exit criterion:** for a given squad and budget, the planner proposes ranked transfers with quantified projected-score gains over the chosen horizon, hit-aware.

---

## Phase 3 — Refinement & additional data sources

Now the tool is feature-complete on FPL-only data. Phase 3 raises analytical quality and trustworthiness.

### 3A. External data via the proxy
- Add allowlisted external upstream(s) for **xG / xGA / shot quality** data (an Understat-style source), fetched through `api/fpl.js` as a named source (`?source=xg`), keys (if any) in Vercel env vars (`ARCHITECTURE.md` §5, §7).
- Replace the Phase 1 **style proxies** (`FEATURE_ENGINE.md` §6) with real underlying-numbers profiles; raise `styleClash` weight in `config.js` now that it's evidence-backed.
- Improve `calcPlayerForm` underlying overlay with real xG/xA instead of FPL-exposed approximations.

### 3B. Model calibration / backtesting
- Persist pre-deadline scores per GW (sessionStorage → optionally a lightweight export to JSON) and compare to actual points.
- Empirically tune `WEIGHTS`, `RECENCY_DECAY`, `HORIZON_DECAY`, `COUNTER_SENSITIVITY` against realised results. Document any change in `FEATURE_ENGINE.md` and the commit (`CONVENTIONS.md` §10).

### 3C. UX & robustness refinement
- Refine counter-matchup position grouping beyond raw `element_type` (use positional/role data to better assign wingers vs central mids, etc. — `FEATURE_ENGINE.md` §7.2).
- Graceful degradation polish: estimated/low-confidence scores visually distinct everywhere; data-error banner + retry.
- Performance pass: ensure lazy player-summary loading and caching keep the ranker responsive across all ~700 players.

**Exit criterion:** scores incorporate real xG-based style/form data, the model has been calibrated against at least a handful of GWs of realised results, and low-confidence scores are clearly distinguished in every module.

---

## Phase 4 — Stretch goals (only after Phases 1–3 are solid)

These are explicitly optional and out of the core scope. Do not start any of these while earlier phases have open exit criteria.

- **Squad import:** pull the user's actual FPL squad via the entry/picks endpoints (add to proxy allowlist) so the dashboard/planner don't need manual entry. Read-only; never write to the FPL account.
- **Individual player-vs-player counter-matchups:** move beyond position-group aggregates to specific likely individual duels (this striker vs that specific CB), the natural evolution of `engine/counter.js` once richer data exists.
- **Chip planning:** model Wildcard / Free Hit / Bench Boost / Triple Captain timing against horizon scores and blank/double GW structure.
- **Price-change prediction:** integrate an ownership-trend source to flag imminent rises/falls (affects transfer timing).
- **Multi-season fixture-history depth:** richer H2H once more historical data is wired in, raising the (currently tiny) `history` weight if it proves predictive.
- **Public/shareable mode:** only if the tool ever stops being personal — would require auth, rate-limit-friendly caching, and a review of the proxy's open-CORS posture (`ARCHITECTURE.md` §5, §12). Not in scope now.
- **Mobile layout:** make the desktop tool genuinely mobile-friendly (Phase 1 only avoids actively breaking it).

---

## Cross-phase definition of done

A phase is done only when **every** exit criterion is met **and**:
1. The live Vercel deployment reflects it (not just local).
2. No documented decision in the four `.md` files is contradicted by the code; any decision that changed updated its doc in the same commit (`CONVENTIONS.md` §10).
3. The engine remained pure and module-free of analytics; all new tunables landed in `config.js`.
4. Every newly displayed score is explainable via its breakdown.
