# CONVENTIONS.md

> Coding and naming conventions for **Gaffer IQ**. These are rules, not suggestions. Consistency here is what lets a fresh AI session or developer pick up the codebase and write code that looks like it was always part of it. When in doubt, match the existing pattern; if no pattern exists, follow the spirit of this document and add the new pattern here.

Read `ARCHITECTURE.md` first for the file structure and layering rules this document assumes.

---

## 1. Language & environment baseline

- **Vanilla JavaScript, ES2022+, native ES modules.** Every `.js` file uses `import`/`export`. No CommonJS (`require`), no global namespace object, no IIFE module pattern, no `<script>`-per-file.
- **No transpilation.** Write only syntax that ships in modern evergreen browsers. If a feature needs a polyfill, don't use it.
- **`'use strict'` is implicit** in ES modules; do not add the pragma manually.
- **No runtime frontend dependencies.** `package.json` exists for Vercel/Node detection and dev tooling only. Adding an npm package to the *frontend* requires an explicit decision recorded in `ARCHITECTURE.md`.
- **Indentation:** 2 spaces. **Quotes:** single quotes for JS strings, double quotes only to avoid escaping. **Semicolons:** always. **Line length:** soft cap 100 columns.

---

## 2. File naming

| Thing | Convention | Example |
|---|---|---|
| JS files | `kebab-case.js`, lowercase, descriptive noun | `composite.js`, `counter.js` |
| Multi-word JS files | `kebab-case` | `counter-matchup.js` *(avoid abbreviating to the point of ambiguity)* |
| CSS files | `kebab-case.css`, by role | `base.css`, `layout.css`, `components.css` |
| Markdown docs | `SCREAMING_SNAKE_CASE.md` | `ARCHITECTURE.md` |
| The serverless function | `fpl.js` inside `/api/` | `/api/fpl.js` |

- One primary export concept per file. `engine/form.js` exports form-related functions and nothing about fixtures.
- File name should match its domain, not its mechanism. `style.js` (what it's about), not `aggregator.js` (how it works).

---

## 3. JavaScript naming patterns

### 3.1 Variables & properties
- `camelCase` for variables, function parameters, and object properties: `homeTeamId`, `rollingForm`, `counterScore`.
- `SCREAMING_SNAKE_CASE` for true constants defined in `config.js` (tunable model parameters and fixed config): `FORM_WINDOW_GWS`, `WEIGHTS`, `HORIZONS`.
- Booleans read as assertions: prefix with `is`, `has`, `should`, `can`. `isHome`, `hasPlayed`, `shouldDecay`.
- IDs are always suffixed `Id`/`Ids`: `teamId`, `playerId`, `fixtureIds`. Never bare `id` in a multi-entity context.
- Never use raw FPL field names (`element_type`, `team_h_difficulty`) outside `engine/normalise.js`. The rest of the codebase speaks the internal model (see `ARCHITECTURE.md` §8).

### 3.2 Function naming — by layer

Function names encode **what layer they belong to** so their side-effect profile is predictable.

| Layer / prefix | Meaning | Side effects? | Examples |
|---|---|---|---|
| `fetch…` | network I/O (only in `api.js`) | yes (network) | `fetchBootstrap()`, `fetchPlayerSummary(playerId)` |
| `get…` | read from `store` / cache | no (pure read) | `getActiveHorizon()`, `getTeam(teamId)` |
| `set…` / `update…` | mutate `store` state | yes (state) | `setActiveHorizon(key)`, `updateCache(key, data)` |
| `normalise…` | raw FPL → internal model (only in `normalise.js`) | no | `normaliseTeam(raw)`, `normaliseFixtures(raw)` |
| `calc…` | engine: compute a single metric | no (pure) | `calcTeamForm(team, gw)`, `calcStyleClash(a, b)` |
| `score…` | engine: produce a composite/scored result | no (pure) | `scoreFixture(fixture, horizon)`, `scorePlayer(player, horizon)` |
| `rank…` | engine: order a collection by a score | no (pure) | `rankPlayers(players, horizon)` |
| `render…` | modules: write to the DOM | yes (DOM) | `renderMatchupCard(score)`, `renderRankerTable(rows)` |
| `handle…` / `on…` | event handlers in modules | yes (DOM/state) | `handleHorizonChange(e)`, `onPlayerSelect(playerId)` |
| `build…` | construct a non-DOM data structure for rendering | no | `buildRankerRows(players)` |
| `is…`/`has…` | predicate, returns boolean | no | `isBlankGw(team, gw)` |

**Rule:** If a function name starts with `calc`, `score`, `rank`, `normalise`, `get`, `build`, `is`, or `has`, it must be **pure** (no DOM, no network, no `store` mutation). If it starts with `render`, `handle`, `on`, `set`, `update`, or `fetch`, it is allowed side effects appropriate to its layer and nothing else. A `calc…` function that touches the DOM is a bug.

### 3.3 Engine purity contract
Every function in `engine/` must:
- Take all inputs as explicit parameters (including the current GW — never read "now" internally).
- Return a new value; never mutate its arguments.
- Avoid reading globals except imported constants from `config.js`.
- Be unit-testable in isolation with plain object inputs.

---

## 4. Data object structure & naming

- Internal models follow the shapes in `ARCHITECTURE.md` §8 (`Team`, `Player`, `Fixture`, `CompositeScore`). Do not invent parallel shapes; extend these.
- **Scores are objects, not bare numbers**, once they carry meaning. A composite score is always `{ value, band, breakdown }`, never a lone `0–100` float passed around. This guarantees explainability travels with the number.
- **Normalised metric convention:** every sub-metric the engine produces is normalised to a documented scale before weighting. Default internal scale is **0–100, higher = better for the team in question** (i.e. easier fixture / stronger form / favourable matchup). Document the direction in a comment at the top of each metric function. Consistency of direction is critical — a metric where "higher = harder" silently inverted will corrupt the composite.
- Collections are plural and typed by content: `players`, `fixturesByGw`, `scoresByTeamId`. Maps keyed by id use the `…ById` suffix and are plain objects (or `Map` where insertion order/iteration matters).
- Prefer flat, explicit objects over deep nesting. Three levels deep is a smell; refactor into a named sub-shape documented in §8 of `ARCHITECTURE.md`.
- Dates/times: store kickoff as ISO strings as the API gives them; convert to display only at render time in modules. Engine never formats dates.

---

## 5. CSS conventions

### 5.1 Methodology: BEM-lite
Use a pragmatic BEM (Block / Element / Modifier). Lowercase, kebab-case, no IDs for styling.

```
.matchup-card                 /* block */
.matchup-card__header         /* element (double underscore) */
.matchup-card__score          /* element */
.matchup-card--brutal         /* modifier (double hyphen) */
```

- **Block** = a standalone component (`.matchup-card`, `.ranker-table`, `.horizon-switcher`).
- **Element** = a part of a block, `block__element`.
- **Modifier** = a variant/state, `block--modifier` or `block__element--modifier`.

### 5.2 Score bands → classes
The five composite bands map to fixed modifier classes, used everywhere a score is shown so colour is consistent across all four modules:
```
--great   /* most favourable */
--good
--neutral
--tough
--brutal  /* least favourable */
```
e.g. `<span class="score-pill score-pill--good">`. The band string in `CompositeScore.band` maps 1:1 to these. Define the colour for each band **once** as a CSS variable in `base.css`; never hard-code a hex per component.

### 5.3 Design tokens
- All colours, spacing, radii, font sizes, and the five band colours are CSS custom properties declared in `:root` in `base.css`. Components reference `var(--…)` only. No raw hex or px-spacing literals in `components.css`/`layout.css` except inside `:root`.
- Token naming: `--color-…`, `--space-…`, `--radius-…`, `--font-…`, `--band-…`. e.g. `--band-brutal`, `--space-2`, `--color-bg`.
- No inline styles in HTML and no `style.foo =` in JS except for genuinely dynamic values (e.g. a computed bar width). Toggle classes, don't write style strings.
- `--band-…` also covers the one non-`BANDS` colour added for rank-relative player colouring (`--band-light-green` — see `FEATURE_ENGINE.md` §13): same naming convention, same `:root` location, even though it isn't one of the original five score bands. Extend this block for any future colour need before reaching for a raw hex anywhere else.

### 5.4 Layout
- Flexbox/Grid only. No float layouts. No CSS frameworks (no Tailwind, no Bootstrap). Hand-written CSS, organised by the three files in `ARCHITECTURE.md` §3.
- Mobile is not a Phase 1 target (personal desktop tool), but do not actively prevent it — use relative units and avoid fixed pixel widths on containers.

---

## 6. HTML conventions

- One `index.html`. Module views are sections within it, shown/hidden by the active route (URL hash). No per-module HTML files.
- Semantic elements: `<nav>`, `<main>`, `<section>`, `<table>` for tabular data (the ranker is a real table — use `<table>`, not divs).
- `data-*` attributes carry ids the JS needs: `data-player-id`, `data-fixture-id`, `data-module`. JS reads these rather than parsing text content.
- Module root sections are identified by `data-module="ranker"` etc., and toggled by adding/removing an `is-active` class. JS finds them by `data-module`, not by brittle nth-child selectors.

---

## 7. Commenting & documentation standards

### 7.1 File header
Every JS file starts with a short block comment: its purpose, its layer, and its side-effect profile.
```js
/**
 * engine/counter.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 * Computes position-based counter-matchup scores (e.g. FWD form vs opponent CB form).
 * See FEATURE_ENGINE.md §"Position counter-matchup score" for the formula.
 */
```

### 7.2 Function docs (JSDoc-lite)
Every exported function gets a JSDoc block stating params, return shape, and — for engine functions — the **scale and direction** of the output.
```js
/**
 * Score a single fixture for one team.
 * @param {Fixture} fixture
 * @param {Team} team           team whose perspective we score from
 * @param {object} ctx          { allTeams, allPlayers, currentGw }
 * @returns {CompositeScore}    value 0–100, higher = easier fixture for `team`
 */
```

### 7.3 Inline comments
- Comment **why**, not **what**. The code says what; comments explain non-obvious reasoning, especially any model choice.
- **Every magic-number reference is banned in engine code** — pull the value from `config.js` and let the constant's name document intent. If a comment is needed to explain a number, it should be a named constant instead.
- Mark every model assumption or simplification with a `// MODEL:` tag and a one-line rationale, so the analytical decisions are greppable:
  ```js
  // MODEL: blank GW contributes a neutral 50, not 0 — absence of fixture is not a hard fixture.
  ```
- Use `// TODO(phase-3):` style tags tying deferred work to the roadmap phase from `ROADMAP.md`.

### 7.4 Cross-references
When code implements something specified in a doc, cite it: `// see FEATURE_ENGINE.md §Style clash`. When a doc decision changes, update both the doc and the citing comments.

---

## 8. State, events & the store

- The only mutable shared state lives in `store.js`. Modules never share state directly with each other; they communicate through `store` events.
- Event names are `domain:verb`, lowercase, colon-separated: `data:ready`, `data:error`, `horizon:changed`, `route:changed`, `player:selected`, `squad:updated`, `live:updated`, `match:updated`.
- Subscriptions are set up in a module's init function and described in that module's header comment. Avoid anonymous long-lived subscriptions you can't find later.

### Rendering off screen (the `route:changed` contract)

`data:ready` is a **global broadcast**: every module re-renders on it, whether or not it is the tab on screen. That is fine when it fires once; it is not fine when it fires in a burst. The boot-time team-xG prefetch resolves 20 payloads, and emitting per payload cost ~2.4s of blocking main-thread work each — ~50s of startup lag, most of it spent scoring tabs nobody was looking at.

So modules follow one rule:

> **Invalidate always, recompute lazily.**

In `onDataReady`, do the cheap bookkeeping unconditionally — clearing caches, setting flags, seeding selections — so the module's state stays truthful while hidden. Then check `store.getActiveModule()`; if it is not this module, set a `_pendingRender` flag and return before the expensive work. Subscribe to `route:changed` and flush that flag when the module is shown.

Two things this depends on, both load-bearing:

- `main.js` calls `routeToHash()` **before** the module inits, so `getActiveModule()` is already correct when each module wires up.
- `setActiveModule()` publishes **after** the `is-active` class toggles, so a module waking on `route:changed` measures a section that is already visible. Measuring a `display:none` section is what produces zero-width layout bugs.

New modules must follow this. A module that renders eagerly while hidden re-introduces the lag for every tab, not just its own.

---

## 9. Error handling conventions

- `api.js` throws typed errors: `throw new ApiError(message, { upstreamStatus })`. Callers catch and translate to a `store` `data:error` event; they do not `console.log` and swallow.
- Engine functions do **not** throw on missing optional data — they apply the documented fallback and record it in the score `breakdown` (e.g. `breakdown.styleClash = { value, estimated: true }`). They *may* throw on contract violations (e.g. a null team id) because that's a programming error, not a data condition.
- No silent `catch {}`. Every catch either handles meaningfully or re-throws.

---

## 10. Git & commit conventions

- **Conventional Commits**: `type(scope): summary`. Types: `feat`, `fix`, `refactor`, `docs`, `chore`, `style`, `perf`. Scope is a module or layer: `feat(ranker): …`, `fix(engine/counter): …`, `docs(roadmap): …`.
- One logical change per commit. Engine/model changes and UI changes go in separate commits where practical, so model tuning is reviewable on its own.
- Commit messages for model changes state the *expected effect* on scores (e.g. "increase counter-matchup weight; harsher scores for teams facing in-form attacks").
- The four reference docs are living documents. If a commit changes a documented decision, the same commit updates the doc. **Code and docs never disagree in `main`.**
- Never commit secrets. Phase-3 API keys live in Vercel env vars.

---

## 11. Quick "is my code idiomatic?" checklist

Before considering a change done:
1. Does every function's name match its layer/side-effect profile (§3.2)?
2. Is all new analytical logic in `engine/` and pure?
3. Did I avoid raw FPL field names outside `normalise.js`?
4. Are scores carried as `{ value, band, breakdown }`, not bare numbers?
5. Are all tunable numbers in `config.js`, with no magic numbers in the engine?
6. Do CSS additions use BEM-lite + design tokens, no hard-coded colours?
7. Did I update the relevant `.md` doc if I changed a documented decision?
8. Does every displayed score remain explainable through its breakdown?
