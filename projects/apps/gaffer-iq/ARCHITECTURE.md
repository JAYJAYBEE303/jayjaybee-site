# ARCHITECTURE.md

> **Gaffer IQ** — a personal Fantasy Premier League (FPL) analysis tool that provides a deeper read on fixtures than the official FPL app.
>
> This document is the canonical description of *how the system is built*. If you are an AI assistant or developer joining this project, read this document **and** `FEATURE_ENGINE.md` before writing any code. Decisions here are deliberate. Do not "modernise" them (e.g. do not introduce React, a build step, or a backend database) without an explicit instruction from the project owner.

---

## 1. What Gaffer IQ is (and is not)

Gaffer IQ is a **single-user, client-heavy web app** that ranks and analyses FPL fixtures and players using metrics the official app does not expose. The official FPL app gives you a crude 1–5 Fixture Difficulty Rating (FDR). Gaffer IQ replaces that with a composite, multi-factor model (see `FEATURE_ENGINE.md`).

It **is**:
- A personal tool. There is no auth, no multi-tenancy, no user accounts, no public sign-up.
- A static frontend (HTML/CSS/vanilla JS) plus **one** serverless function used purely as a CORS proxy.
- Hosted on Vercel, always-on, requiring no local server to use day-to-day.

It is **not**:
- A React/Vue/Svelte app. No framework. No JSX. No virtual DOM.
- A Python project. There is zero Python anywhere in the stack.
- A product with a build pipeline (no webpack, no Vite, no bundler, no transpilation). Files are served as authored.
- A betting tool, a price-prediction engine, or a public SaaS — at least not in the phases this document covers.

The guiding principle: **the proxy is dumb, the client is smart.** All analytical logic lives in the browser. The serverless function does as little as legally possible — it fetches and forwards.

---

## 2. High-level system diagram

```
                          ┌─────────────────────────────────────┐
                          │            BROWSER (client)           │
                          │                                       │
   ┌──────────────┐       │  index.html                          │
   │   You (user) │──────▶│   ├── css/  (presentation only)       │
   └──────────────┘       │   └── js/   (all logic & analytics)   │
                          │        ├── api.js      ← data layer   │
                          │        ├── store.js    ← state cache   │
                          │        ├── engine/     ← FEATURE_ENGINE│
                          │        └── modules/    ← feature views │
                          └───────────────┬───────────────────────┘
                                          │ fetch('/api/fpl?path=…')
                                          ▼
                          ┌───────────────────────────────────────┐
                          │      VERCEL SERVERLESS FUNCTION         │
                          │      /api/fpl.js  (CORS proxy)          │
                          │  - validates `path` against allowlist  │
                          │  - forwards to fantasy.premierleague    │
                          │  - sets CORS + cache headers            │
                          └───────────────┬───────────────────────┘
                                          │ https
                                          ▼
                          ┌───────────────────────────────────────┐
                          │   OFFICIAL FPL API (read-only, public)  │
                          │   fantasy.premierleague.com/api/...     │
                          └───────────────────────────────────────┘

   (Phase 3+) External supplementary sources are fetched through the
   same proxy via additional allowlisted upstreams (e.g. understat-style
   xG data). See §7.
```

---

## 3. Folder & file structure

### Monorepo context

Gaffer IQ lives inside a larger site repository (`jayjaybee-site`) as a subfolder. It is configured as its own **separate Vercel project** with the root directory set to `projects/gaffer-iq`. This means Vercel treats `projects/gaffer-iq/` as if it were the repo root — the `api/` folder is picked up correctly, and the frontend and proxy share the same origin.

**Do not scaffold Gaffer IQ files at the repo root.** All files below belong inside `projects/gaffer-iq/` within the repo. When Vercel deploys, it sees only this subtree.

```
jayjaybee-site/                   ← repo root (not Gaffer IQ's concern)
└── projects/
    └── gaffer-iq/                ← Vercel project root for Gaffer IQ
        ├── index.html
        ├── vercel.json
        ├── package.json
        ├── README.md
        ├── ARCHITECTURE.md
        ├── CONVENTIONS.md
        ├── FEATURE_ENGINE.md
        ├── ROADMAP.md
        ├── api/
        │   └── fpl.js
        ├── css/
        │   ├── base.css
        │   ├── layout.css
        │   └── components.css
        └── js/
            ├── main.js
            ├── config.js
            ├── api.js
            ├── store.js
            ├── util.js
            ├── engine/
            │   ├── normalise.js
            │   ├── fixtures.js
            │   ├── standings.js
            │   ├── form.js
            │   ├── style.js
            │   ├── counter.js
            │   └── composite.js
            └── modules/
                ├── matchup.js
                ├── fixtures.js
                ├── ranker.js
                ├── dashboard.js
                └── planner.js
```

### Authoritative file layout (from Vercel's perspective)

This is what Vercel sees as the project root. Create files exactly here within `projects/gaffer-iq/`. Do not nest deeper than necessary.

```
gaffer-iq/                          (= projects/gaffer-iq/ in the repo)
├── index.html                  # Single page; the app shell. Hosts all module views.
├── vercel.json                 # Vercel config: routing, headers, function settings.
├── package.json                # Declares the project; NO runtime deps for the frontend.
│                               #   Used only so Vercel detects Node for the function.
├── README.md                   # One-paragraph "what is this + how to run locally".
├── ARCHITECTURE.md             # ← this file
├── CONVENTIONS.md
├── FEATURE_ENGINE.md
├── ROADMAP.md
│
├── api/
│   └── fpl.js                  # THE serverless proxy. Single file. See §5.
│
├── css/
│   ├── base.css                # Reset, CSS variables (design tokens), typography.
│   ├── layout.css              # App shell, grid, nav, horizon switcher.
│   └── components.css          # Reusable component styles (cards, tables, badges, pills).
│
└── js/
    ├── main.js                 # ENTRY POINT (ESM). Imports modules, reads URL hash to
    │                           #   pick the active view, wires nav + horizon switcher,
    │                           #   subscribes to store events. The ONLY script in index.html.
    ├── config.js               # Constants: weights, thresholds, horizon defs, endpoints.
    ├── api.js                  # Data-access layer. The ONLY file that calls fetch().
    ├── store.js                # In-memory + sessionStorage cache. App state. Pub/sub.
    ├── util.js                 # Pure helpers: math, formatting, array ops. No DOM, no fetch.
    │
    ├── engine/                 # The analytical brain. Pure functions. No DOM.
    │   ├── normalise.js        # Builds clean internal models from raw FPL payloads.
    │   ├── fixtures.js         # Fixture difficulty, home/away splits, fixture history.
    │   ├── standings.js        # League table accumulated from played fixtures.
    │   ├── form.js             # Team form & player form calculations.
    │   ├── style.js            # Team style profiling + style clash score.
    │   ├── counter.js          # Position-based counter-matchup scoring.
    │   └── composite.js        # Combines all metrics → composite matchup score.
    │
    └── modules/                # The feature views. These OWN the DOM; engine never does.
        ├── matchup.js          # Matchup Analyser.
        ├── fixtures.js         # Fixtures: GW grid, league table, team schedule, H2H.
        ├── ranker.js           # Player Ranker.
        ├── dashboard.js        # GW Decision Dashboard.
        └── planner.js          # Transfer Planner.
```

### Hard rules about this structure
1. **Only `api.js` is allowed to call `fetch()`.** Modules and engine never fetch directly. This keeps the network surface in one place and makes caching and the proxy boundary trivial to reason about.
2. **Everything under `engine/` is pure.** Given the same inputs, it returns the same outputs. No DOM access, no `window`, no `fetch`, no `Date.now()` baked into a metric (pass the current GW in explicitly). This makes the analytics independently testable and reusable across all four modules.
3. **Everything under `modules/` owns rendering.** Modules read from `store`, call `engine` functions, and write to the DOM. They are the only place `document.querySelector` etc. should appear (besides a tiny bootstrap in `index.html`'s entry script).
4. **`config.js` holds every tunable number.** No magic numbers in engine code. Weights, thresholds, the definition of "form window", horizon GW counts — all live in `config.js` so the model can be tuned in one place. See `FEATURE_ENGINE.md` for what these values mean.

---

## 4. Module loading strategy (no bundler)

Because there is no build step, modules are loaded as **native ES modules**, and there is exactly one entry point: **`js/main.js`**.

- `index.html` includes **one and only one** script tag: `<script type="module" src="js/main.js"></script>`. Nothing else. Every other file enters the dependency graph by being `import`ed (directly or transitively) from `main.js`.
- `main.js` is the bootstrap. Its responsibilities, and *only* these: import the four modules, kick off the initial data load via `api.js`/`store`, read the URL hash to decide which module view is active, wire up the nav and the horizon switcher, and subscribe to `store` events (`data:ready`, `data:error`, `horizon:changed`). It contains **no analytical logic** and **no per-module rendering** — it delegates to the modules.
- Use `import`/`export` (ESM) throughout. No global `window.GafferIQ` namespace, no IIFE pattern, no `<script>` tag per file. One entry module, dependency graph resolved by the browser.
- This works on Vercel and locally with any static file server. It does **not** work from `file://` (ESM + CORS), so local dev uses `npx serve` or `vercel dev` (documented in README).

> **Phase 0 scaffolding note:** `main.js` is the very first JS file to create, before any module. It is listed at the top of the `js/` tree in §3. Nothing renders until it exists, because it is the only thing `index.html` loads.

---

## 5. The Vercel proxy (`api/fpl.js`)

### Why it exists
The official FPL API (`https://fantasy.premierleague.com/api/...`) does **not** send permissive CORS headers, so a browser cannot call it directly. The serverless function sits in the same origin as the frontend (both on the Vercel deployment) and forwards requests server-side, where CORS does not apply.

### What it does — and nothing more
1. Accepts `GET /api/fpl?path=<encoded-fpl-path>`.
2. **Validates `path` against a strict allowlist** of known FPL endpoints (see below). Rejects anything else with `400`. This prevents the proxy being used as an open relay.
3. Fetches `https://fantasy.premierleague.com/api/<path>` server-side with a sane `User-Agent`.
4. Forwards the JSON back with:
   - `Access-Control-Allow-Origin: *` (fine for a personal tool; can be tightened to the deployment origin later).
   - `Cache-Control` tuned per endpoint (bootstrap data is near-static within a GW; live data is not — see §6).
5. On upstream failure, returns the upstream status and a small JSON error envelope `{ "error": "...", "upstream": <status> }`.

### Allowlist (Phase 1)

> **Critical for the implementer:** some of these endpoints are *parameterised* (the player id and GW number vary), so the proxy must validate by **pattern match**, not by string equality against a fixed list. A naive `ALLOWED.includes(path)` check will reject every `element-summary/<id>/` request because the id changes. Match each incoming `path` against the regexes below, in full (anchored `^…$`), and reject anything that doesn't match exactly one of them.

The proxy permits only these path patterns:

| Endpoint | Anchored regex | Notes |
|---|---|---|
| Bootstrap | `^bootstrap-static/$` | static, no params |
| All fixtures | `^fixtures/$` | static |
| Fixtures for a GW | `^fixtures/\?event=\d{1,2}$` | `event` is 1–2 digits (GW 1–38); reject non-numeric |
| Player summary | `^element-summary/\d{1,4}/$` | **parameterised** — id is 1–4 digits |
| GW live points | `^event/\d{1,2}/live/$` | **parameterised** — GW is 1–2 digits; dashboard use, Phase 2 |

Validation contract for `api/fpl.js`:
1. Read and `decodeURIComponent` the `path` query param. If absent → `400`.
2. **Normalise defensively first:** reject any `path` containing `..`, a leading `/`, a scheme (`http:`, `https:`, `//`), or a host. The proxy only ever builds `https://fantasy.premierleague.com/api/<path>` from a path *fragment* — never a full URL. This is what stops it being used as an open relay.
3. Test the cleaned `path` against the anchored patterns above. If **none** match → `400 Bad Request` with the error envelope. If one matches → forward.
4. The numeric bounds (`\d{1,4}` for player id, `\d{1,2}` for GW) are loose sanity guards, not correctness guarantees — an out-of-range id simply 404s upstream, which the proxy forwards through. The point of the digit class is to keep the matcher tight, not to validate FPL's id space.

Keep these patterns in a single `ALLOWED_PATTERNS` array at the top of `api/fpl.js` so the allowlist is auditable at a glance. When Phase 3 adds external sources, add them as **named routes** (e.g. `?source=xg&path=...`) with their *own* pattern array per source — never a free-form URL parameter, and never relax rule 2.

### What the proxy must NOT do
- It must not contain analytical logic. No scoring, no aggregation. (That all lives in `engine/`.)
- It must not store data. No database, no KV. Caching is via HTTP headers + the client-side `store`.
- It must not require secrets for the core FPL API (it's public). If a Phase 3 source needs a key, read it from a Vercel environment variable; never commit it.

### `vercel.json`
Configures:
- The function runtime (Node).
- A rewrite so `/api/fpl` maps to `api/fpl.js` (Vercel does this by convention, but pin it explicitly).
- Static caching headers for `css/` and `js/` assets.

---

## 6. How the frontend fetches & processes data

The data flow is a strict one-way pipeline. **Raw → Normalised → Metrics → View.**

```
api.js  ──fetch via proxy──▶  raw FPL JSON
   │
   ▼
store.js  ──caches raw payloads (session) + exposes getters
   │
   ▼
engine/normalise.js  ──▶  clean internal models (Team, Player, Fixture)   [see §8]
   │
   ▼
engine/{fixtures,form,style,counter}.js  ──▶  per-factor metrics
   │
   ▼
engine/composite.js  ──▶  composite matchup score per (team, fixture) and per (player, fixture)
   │
   ▼
modules/*  ──▶  read scores, render DOM for the active horizon
```

### Fetch strategy
- On app load, `api.js` fetches `bootstrap-static/` and `fixtures/` **once** and hands them to `store`. These two payloads power almost everything.
- `element-summary/<id>/` is fetched **lazily and on demand** (e.g. when the user opens a player in the ranker or expands a matchup), then cached in `store`. Never bulk-fetch all ~700 players' summaries on load — that's ~700 requests; it's slow and abusive to the API. **Sanctioned exception:** the Ranker's "Last Season" Avg Pts/GW toggle (FEATURE_ENGINE.md §10.1) does load every summary, but only on an explicit button click, staggered into small chunks with a yield between each — never automatically on load.
- `event/<gw>/live/` is fetched only by the dashboard, only when viewing the current/in-progress GW.
- `team/{slug}/{season}` is fetched eagerly for every team at startup, once
  `leagueXg` and fixtures have loaded, and cached in `store.teamXg` for the
  session. Consumed as `ctx.teamXgBySlug`. Fetched up front — not lazily per
  fixture — so every module scores every team on the same counter-matchup tier
  from the first render; no score can differ between two sessions, or two tabs
  in the same session, based on which fixture happened to be opened first.
  Failures are swallowed to a console warning — the channel counter tier
  degrades to the role tier per team, so a dead Understat upstream must never
  surface as a page error.

### Caching (the `store`)
- `store.js` keeps an in-memory object for the session and mirrors the big static payloads (`bootstrap`, `fixtures`) into `sessionStorage` keyed by a fetch timestamp.
- TTL policy: bootstrap/fixtures are treated as fresh for the session unless the user hits a manual "refresh data" control. Player summaries cached for the session. Live data is never cached (always re-fetched).
- `store` exposes a tiny pub/sub (`subscribe(event, cb)` / `emit(event)`) so modules can react to `data:ready`, `horizon:changed`, etc., without tight coupling.

### Processing
- All transformation from raw JSON to the internal model happens in `engine/normalise.js` and **nowhere else**. Modules and other engine files only ever see the clean model, never raw FPL field names like `element_type` or `team_h_difficulty`. This insulates the whole codebase from the FPL API's quirky naming and from upstream schema changes — if the API renames a field, you fix it in one function.

---

## 7. FPL API: what it gives vs what we calculate

This is the crux of why Gaffer IQ exists. The API gives raw facts; the value-add is the derived metrics.

### Provided directly by the FPL API
| Data | Endpoint | Notes |
|---|---|---|
| Teams (id, name, short name, strength ratings) | `bootstrap-static/` → `teams[]` | Includes FPL's own `strength`, `strength_overall/attack/defence_home/away` integers. Useful priors. |
| Players (id, name, team, position, price, ownership, total points, ICT, form string) | `bootstrap-static/` → `elements[]` | `element_type` = position id; `form` = avg points last ~30 days (FPL's own). |
| Positions | `bootstrap-static/` → `element_types[]` | GKP/DEF/MID/FWD. |
| Gameweeks/events | `bootstrap-static/` → `events[]` | Deadlines, finished flags, current/next GW flags, average scores. |
| Fixtures (home/away team, GW, kickoff, FPL difficulty, score if played) | `fixtures/` | `team_h_difficulty`/`team_a_difficulty` = the official 1–5 FDR we are replacing. |
| Per-player history (points, minutes, opponent, home/away, per-GW stats incl. xG/xA where present) | `element-summary/<id>/` | `history[]` (this season), `history_past[]` (prior seasons), `fixtures[]` (upcoming). |
| Live GW points | `event/<gw>/live/` | Per-element live scoring during a GW. |

### Calculated locally by Gaffer IQ (the engine)
| Derived metric | Source inputs | Where |
|---|---|---|
| **Custom fixture difficulty** | team strengths, form, home/away split, opponent style | `engine/fixtures.js` + `composite.js` |
| **Home/away split performance** | per-fixture results & player histories filtered by venue | `engine/fixtures.js` |
| **Fixture history (head-to-head)** | `history_past` + this season's results between the two clubs | `engine/fixtures.js` |
| **Team form** | recent results/points over a rolling window (not FPL's player `form` field) | `engine/form.js` |
| **Team style profile + style clash score** | aggregated attacking/defensive tendencies (e.g. xG for/against, goals, clean sheets, possession proxies) | `engine/style.js` |
| **Position counter-matchup score** | one team's attackers' form vs the opponent's defenders' form, by position pairing | `engine/counter.js` |
| **Player form (custom)** | rolling per-90 output, minutes security, trend | `engine/form.js` |
| **Composite matchup score** | weighted blend of all the above | `engine/composite.js` |

> The exact formulas, windows, and weights are specified in `FEATURE_ENGINE.md`. This document only states *where* each lives and *that the API does not provide them*.

### What the API does NOT provide (and how we cope)
- Rich possession/passing/pressing data → not available. Style profiling in Phase 1 uses **proxies** derivable from FPL data (goals for/against, xG/xGA where exposed in player histories, clean sheets, cards). Phase 3 may add an external xG source through the proxy.
- **League standings** → not available. There is no `/standings` endpoint and `bootstrap-static` carries strengths, not points. `engine/standings.js` accumulates the table from `fixtures/` instead — see the Fixtures tab's Table view.
- **Team lineups** (starting XI, bench, formation) and **event minute timings** → not available at all. `event/{gw}/live/` gives per-player, per-fixture stat totals, so the Fixtures tab can show who scored/assisted/was booked and who featured for how many minutes, but never a teamsheet or a timeline. The UI says so rather than implying otherwise.
- True per-player-vs-player matchup history → not available at the granularity we'd like. Hence **position-based** counter-matchups only, to start (a striker's form vs the aggregate form of the opponent's centre-backs), per the project scope.

---

## 8. The internal data model

`engine/normalise.js` produces these shapes. Modules and engine code consume **only** these — never raw FPL JSON. Field names are ours, camelCase, stable.

```
Team {
  id, name, shortName,
  strength: { overall, attackHome, attackAway, defenceHome, defenceAway },  // from FPL priors
  plTenure: {                            // recent top-flight history — set by normalise.js
    seasons,                             // count of the last `lookback` seasons the club featured in
    lookback,                            // seasons considered (config: PL_TENURE_LOOKBACK, default 15)
    ratio,                               // 0–1, RECENCY-WEIGHTED presence (1 = ever-present)
    matched                              // false = club absent from PL_SEASONS entirely
  },
  fixtures: [fixtureId, ...],            // ordered by GW
  // derived (filled by engine, not normalise):
  form: { rolling, trend },              // engine/form.js
  style: { attackProfile, defenceProfile, tempo }   // engine/style.js
}

Player {
  id, name, teamId, position,            // position ∈ { GKP, DEF, MID, FWD }
  price, ownership, status,              // status: available/injured/doubtful
  chanceOfPlayingNext,                   // FPL's own 0–100 playing chance, or null.
                                         //   null = "no news reported", NOT "no data" —
                                         //   FPL populates it only when there IS news.
                                         //   engine/form.js → calcPlayingLikelihood
                                         //   falls back to STATUS_PLAY_CHANCE[status].
  totals: { points, minutes, goals, assists, xG, xA, cleanSheets },
  history: [ GwStat, ... ],              // per-GW, populated lazily from element-summary
  // derived:
  form: { per90, minutesSecurity, trend }
}

Fixture {
  id, gw, kickoff,
  homeTeamId, awayTeamId,
  started,                               // FPL flips this at kickoff
  played,                                // finished || finished_provisional.
                                         //   FPL's own `finished` flips only once
                                         //   BONUS is confirmed, hours after full
                                         //   time, so reading it alone hides every
                                         //   result for the rest of the evening.
  bonusConfirmed,                        // raw `finished`. Read this ONLY for bonus;
                                         //   the scoreline is final at full time.
  result: { homeGoals, awayGoals } | null,  // the score AS IT STANDS — set as soon as
                                         //   FPL publishes one, so a live match shows
                                         //   its running score. `played` says whether
                                         //   it is final; engine code only ever reads
                                         //   results via ctx.playedFixtures, which is
                                         //   gated on played && result.

  fplDifficulty: { home, away },         // the official FDR we are replacing
  // derived (per side), filled by composite.js:
  gafferScore: { home: CompositeScore, away: CompositeScore }
}

CompositeScore {
  value,                 // 0–100, higher = easier/better for the team in question.
                         //   RELATIVE to the fixture's other team since §8.7 — see below.
  band,                  // 'great' | 'good' | 'neutral' | 'tough' | 'brutal'
  confidence,            // 0–1; min() of both teams' own confidence since §8.7 —
                         //   `value` depends on both sides' reads, so it is only as
                         //   trustworthy as the less-certain of the two.
  breakdown: {           // each sub-metric's normalised contribution, for transparency.
                         //   Still this team's OWN read (unchanged by §8.7) — see note below.
    baseDifficulty, homeAway, teamForm, styleClash, counterMatchup, history
  },
  stacking: {            // conditional adjustment ACROSS sub-metrics — FEATURE_ENGINE.md §8.6
    linearValue,         //   the weighted sum BEFORE the penalty
    penalty,             //   points deducted because several secondaries stacked up
    stackIndex,          //   0–1 severity-weighted share of unfavourable secondaries
    countUnfavourable,   //   how many secondaries fell below the pivot
    consideredWeight,    //   non-estimated secondary weight actually in play
    pivot                //   the threshold used (config: STACK_PIVOT)
  },
  relative: {            // the §8.7 zero-sum step — FEATURE_ENGINE.md §8.7
    ownRawValue,         //   this team's independent pre-relative composite (what
                         //     `value` meant before §8.7 — breakdown + stacking still
                         //     explain exactly this number, unchanged)
    opponentRawValue,    //   the opponent's own independent pre-relative composite
    edge,                //   ownRawValue − opponentRawValue — drives the final split
    sensitivity          //   config: RELATIVE_EDGE_SENSITIVITY
  }
}
```

> `stacking` sits alongside `breakdown` because it is an interaction *between* sub-metrics, not a sub-metric itself. `relative` sits alongside both because it is an interaction *between the two teams' totals*, not a property of one team's own metrics. **`relative.ownRawValue === clamp(0, 100, stacking.linearValue − stacking.penalty)` always holds** — `breakdown` and `stacking` together still fully explain `ownRawValue`. The final `value` is then `clamp(0, 100, 50 + relative.edge × relative.sensitivity)`, which is **not** the same number as `ownRawValue` whenever the opponent's own read differs from this team's — the gap between them is exactly what `relative` explains. See FEATURE_ENGINE.md §8.7 for why `value` and the opponent's own `value` for the same fixture are guaranteed to sum to 100, and for the worked examples showing this doesn't flatten every fixture toward 50/50.

> `CompositeScore.breakdown` (plus, since §8.7, `relative`) is mandatory: every score the UI shows must be explainable by drilling into its components. "Why is this fixture green?" must always be answerable. This is a core product principle, not a nice-to-have.

---

## 9. The three planning horizons

Horizons are a **first-class, cross-cutting concept**, defined once in `config.js`:

```
HORIZONS = {
  GW1:  { label: 'This GW',      gws: 1 },
  GW3:  { label: 'Next 3 GWs',   gws: 3 },
  GW6:  { label: 'Next 6 GWs',   gws: 6 }
}
```

### How they work
- A single global "active horizon" lives in `store` and is changed by a horizon switcher in the app shell (`layout.css`). Changing it emits `horizon:changed`; every module re-renders against the new horizon.
- For multi-GW horizons, a team/player's score is the **aggregate of its per-fixture composite scores across the horizon's GWs**, with a configurable aggregation method (default: mean, with an option for "worst-case" / minimum to surface fixture traps). The aggregation method and any GW-distance decay live in `config.js` and are detailed in `FEATURE_ENGINE.md`.
- **Blank and double gameweeks** must be handled explicitly: a team with no fixture in a GW contributes a defined "blank" value (not zero, not skipped silently); a team with two fixtures contributes both, aggregated. `engine/fixtures.js` is responsible for resolving each team's fixture list per horizon correctly, including these cases. Do not assume one-fixture-per-GW anywhere.

---

## 10. How the four modules relate

All four modules consume the **same** engine output (composite scores + breakdowns). They differ only in framing and interaction. None of them re-implements scoring; if you find yourself computing a metric inside a module, it belongs in `engine/` instead.

```
                    ┌────────────────────────────┐
                    │     engine/composite.js      │
                    │  scores per fixture/team/    │
                    │  player, per horizon          │
                    └──────────────┬───────────────┘
                                   │ (shared scores + breakdowns)
        ┌──────────────────┬───────┴───────┬──────────────────┐
        ▼                  ▼               ▼                  ▼
┌───────────────┐  ┌───────────────┐ ┌──────────────┐ ┌────────────────┐
│ Matchup       │  │ Player Ranker │ │ GW Dashboard │ │ Transfer       │
│ Analyser      │  │               │ │              │ │ Planner        │
├───────────────┤  ├───────────────┤ ├──────────────┤ ├────────────────┤
│ Deep-dive on  │  │ Ranks players │ │ Decision view│ │ Models in/out  │
│ ONE fixture:  │  │ by projected  │ │ for the      │ │ moves over a   │
│ shows full    │  │ value over the│ │ active GW:   │ │ horizon: which │
│ breakdown,    │  │ horizon, using│ │ captaincy,   │ │ transfers most │
│ both sides,   │  │ player form × │ │ start/bench, │ │ improve total  │
│ style clash,  │  │ fixture       │ │ flags risky  │ │ projected score│
│ counter-      │  │ composite.    │ │ picks.       │ │ given budget & │
│ matchups.     │  │               │ │              │ │ free transfers.│
└───────────────┘  └───────────────┘ └──────────────┘ └────────────────┘
        │                  │               │                  │
        └── drill-down ────┴───────────────┴── feeds picks ───┘
            into matchup        share the same        into planner
            from any view       player projections
```

Relationships, concretely:
- **Matchup Analyser** is the "view source" for a single fixture. Other modules link into it ("why is this score what it is?").
- **Fixtures** is the schedule-level companion to the Matchup Analyser: the GW grid (kickoff times, results, per-fixture events and lineups), the league table with its European/relegation zones, one team's results/upcoming split, and the full H2H history for a pairing. It carries no scoring of its own — it is the "what and when" view that the Matchup Analyser then explains. Gameweek and Table run on live data; By team and Head-to-head are still blueprints, with their remaining data seams marked `DATA SEAM:` in `js/modules/fixtures.js`.
- **Player Ranker** = player form × that player's fixture composite over the horizon → a ranked projected-value list. It is the bridge between team-level fixture scores and player-level decisions.
- **GW Dashboard** is horizon-locked to `GW1` by design (it's about *this* week's decisions: captaincy, starting XI, bench order, risk flags). It consumes the ranker's projections and the live endpoint.
- **Transfer Planner** is the most horizon-aware module: it takes your current squad (entered manually in Phase 1; possibly imported in a later phase), the ranker's projections over the chosen horizon, and budget/free-transfer constraints, and proposes the moves that most raise projected total. It depends on the ranker and, through it, the whole engine.

Dependency direction is strictly: `modules → engine → normalise → store → api → proxy → FPL`. Nothing points back up the chain.

---

## 11. Error handling & resilience

- **Network/proxy failure:** `api.js` surfaces a typed error; `store` emits `data:error`; the app shell shows a non-blocking banner with a retry. The app must never render a blank white screen on fetch failure.
- **Partial data:** if a player summary fails to load, that player's advanced metrics degrade gracefully to the prior (FPL `strength`/`form` fields) and the UI flags the score as "estimated". The engine must tolerate missing optional inputs and document the fallback in the breakdown.
- **Schema drift:** because all raw→model mapping is in `normalise.js`, an upstream field rename breaks exactly one file. Add defensive checks there and fail loudly in dev, gracefully in prod.

---

## 12. Non-goals / explicit constraints (do not violate without instruction)

1. No framework, no bundler, no transpiler. Native ESM only.
2. No Python anywhere.
3. The proxy stays dumb (fetch + forward + allowlist). No logic creep.
4. No analytical logic in modules; it all lives in `engine/`.
5. Only `api.js` performs network I/O.
6. Every displayed score must be explainable via its `breakdown`.
7. No bulk-fetching every player summary on load (an explicit, user-clicked, chunked bulk load is a sanctioned exception — FEATURE_ENGINE.md §10.1).
8. Horizons, weights, and thresholds are configured in `config.js`, never hard-coded in engine logic.
