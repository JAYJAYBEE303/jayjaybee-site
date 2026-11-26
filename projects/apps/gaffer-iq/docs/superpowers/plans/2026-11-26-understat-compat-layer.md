# Understat Compat Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore H2H, the venue window and the FPL-backed xG overlays while Understat is down, with no consumer changes.

**Architecture:** Finished seasons ship as static JSON in the post-`renameUnderstatKeys` Understat shape, generated once from vaastav results CSVs. The live season gets a pure FPL-derived stand-in (`synthetic: true`) installed only when the Understat call fails. One guard in `channel.js` keeps the stand-in from driving any Understat request.

**Tech Stack:** Vanilla ES modules (no build), `node --test`, Playwright (pre-installed) for the browser check.

**Spec:** `docs/superpowers/specs/2026-11-26-understat-compat-layer-design.md` (audit: `docs/understat-data-audit.md`)

## Global Constraints

- Shapes (audit §5c): `datesData`, `playersData`, `history` are **Arrays**; `datetime` is `YYYY-MM-DD HH:MM:SS` UTC, **no zone suffix**; `h_a` is exactly `'h'` or `'a'`; `isResult` is a boolean.
- **No `id` field on any `datesData` row** (compat or stand-in): an FPL fixture id must never reach `match/{id}`.
- Engine files are pure (no DOM, no network); `js/api.js` is the only `fetch` caller.
- Club names join via `canonicalClubKey` only; no new `TEAM_NAME_ALIASES` entries.
- Compat seasons = `[UNDERSTAT_PREV_SEASON, ...UNDERSTAT_HISTORY_SEASONS]` = `['2025','2024','2023','2022','2021']`.
- Counter matchup is parked: do not touch `counter.js`, `composite.js` weights, or the 5 failing `channel.test.js` maturity tests.
- Baseline `node --test`: 739 tests, 5 failures (all `tests/engine/channel.test.js:96,256,261,274,295`) plus one wall-clock-bound test that can flake. No new failures allowed.
- Static app: no bundler, no new dependencies.

## Review Focus

1. Postponed/unplayed vaastav rows (empty scores) must be dropped, not read as 0-0 (Task 1).
2. Start of a season (GW0): clubs with zero played fixtures and players with zero minutes must not throw or emit rows (Task 2).
3. A started-but-unfinished fixture (running score) must not appear as a result (Task 2).
4. Static file missing or network failure must fall through to the proxy, and a proxy failure must still reject as before (Task 3).
5. If Understat returns a real payload later, it must win and team prefetch must resume (Task 2 guard test, Task 4 wiring).

## File Structure

| File | Responsibility |
|---|---|
| `tools/understat-compat/lib.js` (new) | Pure: vaastav CSV text to Understat-shaped league payload |
| `tools/understat-compat/build.js` (new) | CLI: fetch CSVs, write `data/understat-compat/league-EPL-{y}.json` |
| `data/understat-compat/*.json` (new, generated, committed) | 5 finished-season payloads |
| `js/engine/fpl-league.js` (new) | Pure: normalised season to stand-in payload |
| `js/engine/channel.js` (modify) | `buildUnderstatSlugsByTeamId` returns `{}` for `synthetic` payloads |
| `js/api.js`, `js/config.js` (modify) | Static-first `fetchLeagueXg`; `UNDERSTAT_COMPAT_SEASONS` |
| `js/main.js`, `vercel.json` (modify) | Install stand-in on live-season failure; cache header for `/data/` |
| `tests/tools/understat-compat.test.js`, `tests/engine/fpl-league.test.js`, `tests/modules/api.test.js` (new) | Tests |

---

### Task 1: Generator lib

**Files:** Create `tools/understat-compat/lib.js`; Test `tests/tools/understat-compat.test.js`

**Interfaces:**
- Consumes: `parseCsv(text: string): string[][]` from `tools/minutes/lib.js:41` (first row is the header).
- Produces: `buildLeagueCompat(teamsCsv: string, fixturesCsv: string): { teamsData: Record<string, {id: string, title: string, history: {date: string, h_a: 'h'|'a', scored: number, missed: number}[]}>, playersData: [], datesData: {isResult: true, datetime: string, h: {title: string}, a: {title: string}, goals: {h: number, a: number}}[] }`

- [ ] **Step 1: Write the failing tests** in `tests/tools/understat-compat.test.js` with fixtures `TEAMS = 'id,name\n1,Arsenal\n2,Man City\n'` and `FIXTURES = 'event,finished,kickoff_time,team_h,team_h_score,team_a,team_a_score\n1,True,2021-08-13T19:00:00Z,1,2,2,0\n2,False,2021-08-20T14:00:00Z,2,,1,\n'`:
  - `played fixture becomes an Understat-shaped datesData row`: `out.datesData` deepEquals `[{ isResult: true, datetime: '2021-08-13 19:00:00', h: { title: 'Arsenal' }, a: { title: 'Man City' }, goals: { h: 2, a: 0 } }]`.
  - `unplayed rows are dropped, never read as 0-0`: `datesData.length === 1` (the second fixture has empty scores and `finished` False).
  - `each club gets history from its own end`: `teamsData['1']` deepEquals `{ id: '1', title: 'Arsenal', history: [{ date: '2021-08-13 19:00:00', h_a: 'h', scored: 2, missed: 0 }] }`; `teamsData['2'].history[0]` is `{ date: ..., h_a: 'a', scored: 0, missed: 2 }`.
  - `playersData is an empty array and no row carries an id`.
  - `history and datesData are sorted by datetime ascending` (add a third fixture out of order).
- [ ] **Step 2: Run** `node --test tests/tools/understat-compat.test.js` - Expected: FAIL (module not found).
- [ ] **Step 3: Implement `buildLeagueCompat`** in `tools/understat-compat/lib.js`. A row is played only when `finished === 'True'` and both scores are non-empty; convert `kickoff_time` by replacing `T` with a space and dropping `Z`/fractions; index columns by header name, not position.
- [ ] **Step 4: Run** the same command - Expected: PASS.
- [ ] **Step 5: Commit** `git add tools/understat-compat/lib.js tests/tools/understat-compat.test.js && git commit -m "Add vaastav to Understat-shape generator lib"`

### Task 2: Generator CLI and the five data files

**Files:** Create `tools/understat-compat/build.js`, `data/understat-compat/league-EPL-{2021..2025}.json`; Modify `tests/tools/understat-compat.test.js`

**Interfaces:**
- Consumes: `buildLeagueCompat` (Task 1); `UNDERSTAT_PREV_SEASON`, `UNDERSTAT_HISTORY_SEASONS` from `js/config.js`.
- Produces: files read by Task 4 at `data/understat-compat/league-EPL-{y}.json`.

- [ ] **Step 1: Write the failing data-invariant tests** (loop over `2021..2025`, reading `new URL('../../data/understat-compat/league-EPL-{y}.json', import.meta.url)`): 20 `teamsData` entries; `datesData.length === 380`; every row `isResult`, `datetime` matches `/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/`, and `!('id' in row)`; every `history.length === 38`; sum of all `history[*].scored` equals sum of all `goals.h + goals.a`; every `title` passes `canonicalClubKey` against `PL_SEASONS['{y}/{yy}']` mapped through `canonicalClubKey`.
- [ ] **Step 2: Run** the file - Expected: FAIL (files missing).
- [ ] **Step 3: Implement `build.js`**: for each season in `[PREV, ...HISTORY]` fetch `https://raw.githubusercontent.com/vaastav/Fantasy-Premier-League/master/data/{y}-{yy}/teams.csv` and `fixtures.csv` (label: `2021` to `2021-22`), run `buildLeagueCompat`, write compact JSON (no indent) to `data/understat-compat/`. Always overwrite. Header comment: needs `NODE_USE_ENV_PROXY=1` behind a proxy; rerun on each `UNDERSTAT_*` bump.
- [ ] **Step 4: Generate** `NODE_USE_ENV_PROXY=1 node tools/understat-compat/build.js` then run the tests - Expected: PASS. Check `du -sh data/understat-compat` is under 1 MB.
- [ ] **Step 5: Commit** `git add tools/understat-compat data tests/tools && git commit -m "Generate finished-season Understat-shape league payloads from vaastav"`

### Task 3: FPL-derived stand-in and slug guard

**Files:** Create `js/engine/fpl-league.js`, `tests/engine/fpl-league.test.js`; Modify `js/engine/channel.js:41-42`, `tests/engine/channel.test.js` (append one test)

**Interfaces:**
- Consumes: normalised season `{ teams, teamsById, players, fixtures }` (`normaliseSeason` output; fixture fields `played, result.{homeGoals,awayGoals}, kickoff, homeTeamId, awayTeamId`; player fields `fullName, totals.{minutes,xG,xA}`).
- Produces: `buildFplLeaguePayload(season): { synthetic: true, teamsData, playersData, datesData }` - same shapes as Task 1 except `playersData` rows are `{ player_name: string, time: number, xG: number, xA: number }`; consumed by Task 4.

- [ ] **Step 1: Write the failing tests** (use `syntheticSeason`/`rawPlayer` from `tests/engine/synthetic-season.js`; clubs 5 v 6 play every finished round, gw1 home is club 5):
  - `only played fixtures become results`: `playedGws: 3` plus an upcoming `[4,1,2]` gives `datesData.length === 3`; and a pushed copy of a fixture with `played:false, started:true` (running score) adds no row.
  - `no row has an id; payload is flagged synthetic`.
  - `history is built from each club's own end`: `teamsData['5'].history[0]` has `h_a: 'h'`, `teamsData['6'].history[0].h_a === 'a'`; `teamsData['1'].history` deepEquals `[]`.
  - `datetime is zone-less UTC`: first row matches the Task 2 regex.
  - `playersData only carries players with minutes`: one player with `minutes: 900, expected_goals: '3.0', expected_assists: '1.5'` yields `{ player_name: 'Player 1', time: 900, xG: 3, xA: 1.5 }`; a 0-minute player yields no row.
  - `empty season (playedGws: 0) yields empty arrays and buildScoreContext does not throw`.
  - `consumers accept it`: `collectUnderstatMeetings(5, 6, { teamsById, leagueXg })` returns 3 meetings; `buildRollingVenueStatsByTeamId(leagueXg, null, teamsById)[5]` has `homeGames: 2, awayGames: 1`; `calcPlayerForm(player, buildScoreContext(season, { leagueXg }))` has `xgSource === 'understat'` and `xgEstimated === false`.
  - In `channel.test.js`: `buildUnderstatSlugsByTeamId returns {} for a synthetic payload` and `still resolves a real payload when synthetic is absent` (reuse the file's existing `leagueXg` and `teamsById`).
- [ ] **Step 2: Run** `node --test tests/engine/fpl-league.test.js tests/engine/channel.test.js` - Expected: new tests FAIL; the 5 known maturity failures unchanged.
- [ ] **Step 3: Implement `buildFplLeaguePayload`** in `js/engine/fpl-league.js`: derive `datetime` with `new Date(kickoff).toISOString()` (slice, swap `T` for a space); header comment states it is a stand-in, carries no xG/chain/PPDA/ids, and why (anti-goals in the spec). Then change `channel.js:42` to also return `{}` when `leagueXg.synthetic`.
- [ ] **Step 4: Run** the same command - Expected: all new tests PASS; failures limited to the 5 known.
- [ ] **Step 5: Commit** `git add js/engine tests/engine && git commit -m "Add FPL-derived Understat stand-in and slug guard"`

### Task 4: Static-first `fetchLeagueXg`

**Files:** Modify `js/api.js:264-277`, `js/config.js` (after `UNDERSTAT_HISTORY_SEASONS`, ~line 1167); Create `tests/modules/api.test.js`

**Interfaces:**
- Consumes: files from Task 2.
- Produces: `UNDERSTAT_COMPAT_SEASONS: string[]` exported from `config.js`; `fetchLeagueXg(season: string): Promise<object>` unchanged signature, now static-first for compat seasons.

- [ ] **Step 1: Write the failing tests** (mock `globalThis.fetch` with `t.mock.method`, returning `new Response(JSON.stringify(body), { status })`):
  - `UNDERSTAT_COMPAT_SEASONS` deepEquals `['2025','2024','2023','2022','2021']`.
  - `compat season is read from the static file, one request`: `fetchLeagueXg('2025')` returns the stub body; one call whose URL matches `/data\/understat-compat\/league-EPL-2025\.json$/`.
  - `live season goes to the proxy only`: `fetchLeagueXg('2026')`, one call whose URL contains `source=understat` and `league%2FEPL%2F2026`.
  - `missing static file falls through to the proxy`: first response 404, second 200; two calls, second to the proxy.
  - `proxy failure still rejects with ApiError` (422 `{error:'parse_failed'}` on the proxy call).
- [ ] **Step 2: Run** `node --test tests/modules/api.test.js` - Expected: FAIL.
- [ ] **Step 3: Implement**: `export const UNDERSTAT_COMPAT_SEASONS = [UNDERSTAT_PREV_SEASON, ...UNDERSTAT_HISTORY_SEASONS]` with a comment pointing at the generator; in `fetchLeagueXg`, for compat seasons try `fetch(new URL('../data/understat-compat/league-EPL-{season}.json', import.meta.url))` in a try/catch, return its JSON when `response.ok`, otherwise continue to the existing proxy path.
- [ ] **Step 4: Run** the same command - Expected: PASS.
- [ ] **Step 5: Commit** `git add js/api.js js/config.js tests/modules/api.test.js && git commit -m "Serve finished-season league payloads from static compat files"`

### Task 5: Wire the stand-in into boot, and prove it in a browser

**Files:** Modify `js/main.js:211-222` (and the import list), `vercel.json`

**Interfaces:**
- Consumes: `buildFplLeaguePayload` (Task 3), static-first `fetchLeagueXg` (Task 4).

- [ ] **Step 1: Capture real data** (scratchpad): through the proxy `https://gaffer-iq-josh-bailey.vercel.app/api/fpl?path=bootstrap-static/` and `?path=fixtures/` save to `$SCRATCH/fpl/bootstrap.json` and `fixtures.json`.
- [ ] **Step 2: Write the Playwright smoke** `$SCRATCH/smoke.mjs`: serve the app dir (`python3 -m http.server`), route `https://gaffer-iq-josh-bailey.vercel.app/api/fpl*` (FPL paths from the captured files; `source=understat` returns 422 `{error:'parse_failed'}`; other FPL paths 404), load the app, wait for `data:ready`. Assertions: the only Understat proxy request is `league/EPL/2026`; **zero** `team/` and `match/` requests; `window.__store.getLeagueXg().synthetic === true`; `getLeagueXgPrev()` and 4 history payloads present; `window.__engine.calcFixtureHistory(a, b, window.__engine.context())` for a pair with prior meetings has `estimated === false`; no `console.error`; screenshot of the Fixtures H2H pane saved to scratchpad.
- [ ] **Step 3: Run it** - Expected: FAIL (live-season payload is null, H2H estimated).
- [ ] **Step 4: Implement** in `main.js`: when `leagueXgRes` is rejected, call `store.setLeagueXg(buildFplLeaguePayload(store.getSeason()))` and change the warning to say a stand-in is in use; a fulfilled response is unchanged. In `vercel.json` add `Cache-Control: public, max-age=86400` for `/data/(.*)` and `/v2/data/(.*)`.
- [ ] **Step 5: Run the smoke** - Expected: PASS, screenshot shows meetings.
- [ ] **Step 6: Commit** `git add js/main.js vercel.json && git commit -m "Install FPL stand-in when the live Understat call fails"`

### Task 6: Docs

**Files:** Modify `ARCHITECTURE.md` (§3 tree, §6, §7), `FEATURE_ENGINE.md` (§3.1, §4), `docs/understat-data-audit.md` (one-line note at top), comments at `js/config.js` `UNDERSTAT_*`

- [ ] **Step 1:** Add the `data/understat-compat/` and `tools/understat-compat/` entries to the §3 tree; one paragraph in §6 (static-first, stand-in, `synthetic` rule, no team/match requests); amend the §7 "Any season but the current one" bullet; one sentence each in FEATURE_ENGINE §3.1 and §4 naming the data source; a top-of-file note in the audit pointing here.
- [ ] **Step 2: Run** `grep -n "understat-compat" ARCHITECTURE.md FEATURE_ENGINE.md docs/understat-data-audit.md` - Expected: a hit in each.
- [ ] **Step 3: Commit** `git add -A projects/apps/gaffer-iq && git commit -m "Document the Understat compat layer"`

### Task 7: Final verification and push

- [ ] **Step 1: Run** `node --test "tests/**/*.test.js"` - Expected: only the 5 known channel-maturity failures (+ the timing test if it flakes); report the pass/fail counts.
- [ ] **Step 2: Re-run** the Task 5 smoke - Expected: PASS.
- [ ] **Step 3: Confirm** `git status --short` is clean and `git diff origin/claude/eager-ramanujan-tt4vol --stat` lists only files from the File Structure table plus docs.
- [ ] **Step 4: Push** `git push -u origin claude/eager-ramanujan-tt4vol` (no PR).
