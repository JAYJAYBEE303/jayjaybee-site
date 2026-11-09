# Understat data audit - Gaffer IQ

Audited 2026-11-09. Inventory only: no source changed, no network call made.
All `file:line` refs are relative to `projects/apps/gaffer-iq/`.

**Method.** Read `api/fpl.js`, `js/api.js`, `js/store.js`, `js/main.js`, `js/config.js`, every engine file, every module, `tools/`, `tests/`, then the docs, and compared the two. Two throwaway engine runs (outside the repo, no network) confirmed the behaviours flagged in §4. `node --test` baseline: 739 tests, 5 deterministic failures (all `tests/engine/channel.test.js`, see D9) plus one wall-clock-bound test ("a full run takes well under 5 s...") that failed once under load.

## Headline findings

1. **Understat is reached through exactly four proxy paths**; the allowlist is closed (`api/fpl.js:102-122`).
2. **Cold load = 6 league + up to 20 team = at most 26 Understat requests** (`main.js:191-194`, `main.js:353-401`). Team payloads exist **only for the live season** (`api.js:290`); no finished-season team, match or matchdata payload is ever requested.
3. **Nothing Understat-derived is persisted** client-side: memory only (`store.js:41-87`); sessionStorage holds FPL `season`, squad and picks only (`store.js:206-216`, `store.js:507-539`).
4. **The counter-matchup has no fallback tier.** `calcCounterMatchup` returns the channel read unconditionally (`js/engine/counter.js:431`); the role/element ladder is commented out. Several docs and comments still say it degrades to a role tier (D1).
5. **FWD/MID player counter edge is a constant 50, flagged `estimated`, even with full Understat data** (`js/engine/composite.js:731-741`; verified by run). Every FWD/MID chip in Ranker/Dashboard therefore renders as "estimated" (`ranker.js:181-183`, `dashboard.js:208-210`).
6. **Boot waits on all 6 league calls** before first `data:ready`, with no client timeout (`main.js:188-199`, `api.js:47`). An erroring Understat is harmless; a hanging one delays first render.
7. **Large parts of what is fetched are never read** (§3): PPDA/deep/xG team-history rows (dead `style.js` path), `playersData` of every season but 2026, `teamsData` of 2021-2024, most of each team `statistics`.
8. **No Understat-derived raw data is committed**, apart from 7 player records in two test files (§6). Offline backtests ran with no Understat at all.

---

## 1. ENDPOINT INVENTORY

### 1a. Allowlist and upstream mapping (`api/fpl.js:102-122`, `:258-264`)

| Name | Client path (regex) | Upstream URL | Response to client | Cache-Control sent |
|---|---|---|---|---|
| leagueEpl | `league/EPL/{yyyy}` (`^league\/EPL\/\d{4}$`) | `https://understat.com/getLeagueData/EPL/{yyyy}` | JSON, keys renamed `teams→teamsData`, `players→playersData`, `dates→datesData` (`:337-344`) | `seasonCache(path)` (`:82-100`) |
| teamSeason | `team/{slug}/{yyyy}` (`^team\/[A-Za-z_]+\/\d{4}$`) | `https://understat.com/getTeamData/{slug}/{yyyy}` | JSON, same rename; `statistics` passes through | `seasonCache(path)` |
| matchPage | `match/{id}` (`^match\/\d{1,8}$`) | `https://understat.com/match/{id}` (HTML page) | `{ "html": "<markup>" }` (`:294-304`) | `public, max-age=86400` (`:116`) |
| matchData | `matchdata/{id}` (`^matchdata\/\d{1,8}$`) | `https://understat.com/getMatchData/{id}` | JSON, no rename applicable | `public, max-age=86400` (`:121`) |

Request headers upstream (`:270-285`): browser `User-Agent`; JSON paths add `X-Requested-With: XMLHttpRequest`; `Referer` = the corresponding page URL (`matchdata/` mapped to `match/`). Non-OK upstream becomes `{error, upstream}` with the same status (`:290-292`); non-JSON becomes 422 `{error:'parse_failed'}` (`:306-318`). Error responses set no `Cache-Control`.

No other Understat path exists in the app. Outside the app, `docs/superpowers/derive_constants.py:284-296` hits `getLeagueData/EPL/{season}` and `getTeamData/{slug}/{season}` directly (offline analysis script, one season, default `2025`).

### 1b. Call sites, triggers, seasons, counts

| Path | Client fn | Call site | Trigger | Seasons | Requests |
|---|---|---|---|---|---|
| `league/EPL/{y}` | `fetchLeagueXg` `api.js:264-277` | `main.js:191-194` | Boot (`loadInitialData`, `main.js:737`); Retry button `main.js:422-429`; `window.__refresh` `main.js:528` | `UNDERSTAT_SEASON` 2026 (`config.js:1149`), `UNDERSTAT_PREV_SEASON` 2025 (`:1150`), `UNDERSTAT_HISTORY_SEASONS` 2024/2023/2022/2021 (`:1167`) | **6** per cold load |
| `team/{slug}/{y}` | `fetchTeamXg` `api.js:285-297` | `main.js:377` inside `prefetchAllTeamXg` `main.js:353-401` | Boot, after league payloads settle (`main.js:168`, `:253`); same re-triggers as above | **`UNDERSTAT_SEASON` only** (`api.js:290`) | **≤20** (one per resolved slug, `main.js:357-361`); **0** if no slug resolves |
| `match/{id}` | `fetchMatchTimeline` `api.js:323-344` | `fixtures.js:1262` (`ensureTimeline`) | User opens a match drawer for a fixture that is not `upcoming` (`fixtures.js:1144-1147`, `:500-504`); once per fixture per page life (`_timelineRequested`, `fixtures.js:218`) | Current season only: id resolved from `store.getLeagueXg()` (2026) at `fixtures.js:1248-1251` | 1 per opened fixture |
| `matchdata/{id}` | `fetchMatchData` `api.js:352-365` | `fixtures.js:1274` | Same drawer open; **sequential after** `match/{id}` and **only if** the timeline has ≥1 event (`fixtures.js:1264-1267`) | Same | 1 per opened fixture |

**Cold-load count:** 6 league + ≤20 team = **≤26 Understat requests**, plus FPL `bootstrap-static/` + `fixtures/` (2) unless `season` is fresh in sessionStorage (<60 min, `config.js:1108`, `main.js:152`). A same-tab reload repeats all 26, because Understat state is memory-only (`main.js:153`) and the boot gate awaits them (`main.js:188-199`).
**Per drawer:** 1-2 Understat requests (+1 FPL `event/{gw}/live/`, `fixtures.js:1145`). Ceiling 380 matches x 2 = 760 per season, user-driven.
**Slug source:** `buildUnderstatSlugsByTeamId(leagueXg2026, season.teamsById)` (`channel.js:41-61`): the 2026 league payload's team titles, matched to FPL names, spaces to underscores. If that payload lists no teams, **no team payload is requested for the session** (§4).

### 1c. Cache-control behaviour (verified in code)

| Layer | league / team | match / matchdata |
|---|---|---|
| **Edge** (`s-maxage`) | Finished season (`year < currentSeason`): `public, max-age=31536000, s-maxage=31536000, immutable` (`:57`). Live: `public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400` (`:58`). `currentSeason` is derived from the server clock: UTC month >= 6 gives this year, else last year (`:94-99`), read from the last 4 chars of the path (`:86`). **As of 2026-11-09: 2026 live, 2021-2025 finished.** | `public, max-age=86400` only: no `s-maxage`, no `immutable` (`:116`, `:121`) |
| **Browser HTTP cache** | Honours the same `max-age` | `max-age=86400` |
| **sessionStorage** | **None for Understat.** Only `season` (`store.js:206-216`), squad, picks (`store.js:423-460`) | None |
| **IndexedDB** | None; `js/snapshots.js` holds FPL bootstrap and GW tables only (no Understat reference) | None |
| **In-memory** | `store.leagueXg/leagueXgPrev/leagueXgHistory/teamXg` (`store.js:41-56`); no TTL; lifetime = page. `XG_TTL_MS` (`config.js:1179`) is **declared and never read** (D4) | `store.matchDetail[fixtureId] = {events, lineups}` (`store.js:87`, `:386`); memory only; failures remembered per page in `_timelineFailed` (`fixtures.js:219`) |

Fixed-string caches fail closed to `no-store` if an entry declares neither `cache` nor `cacheFor` (`:138-141`).

---

## 2. FIELD-LEVEL INVENTORY

Field names are post-rename (what consumers see). "Reads" = code that dereferences the field. Numerics arrive as strings from Understat and are parsed at the read site. Only fields the code touches are listed; anything else in a payload is ignored.

### 2a. `league/EPL/{y}` -> `teamsData` (object keyed by Understat team id; code uses `Object.values`, so an array also works)

| Field | Reads | Parse | Seasons read | Feeds |
|---|---|---|---|---|
| `[*].title` | `channel.js:46`, `fixtures.js:207-208`, `style.js:71,149` | string | 2026 (slugs, profiles); 2026+2025 (venue window) | **Team identity**: FPL<->Understat join, slug for `team/{slug}/` |
| `[*].history[]` (must be an Array) | `fixtures.js:207-208`, `style.js:85,102,123` | - | 2026, 2025 | see rows below |
| `history[*].date` | `fixtures.js:223` | `new Date()` | 2026, 2025 | **homeAway** rolling 38-match window (sort) |
| `history[*].scored`, `.missed` | `fixtures.js:228-229` | `Number()` | 2026, 2025 | **homeAway**: win/draw/loss to 3/1/0 PPG |
| `history[*].h_a` (`'h'`/`'a'`) | `fixtures.js:232-233` | exact compare | 2026, 2025 | **homeAway** home/away split |
| `history[*].xG`, `.xGA`, `.npxG` | `style.js:103-107` | `parseFloat` | 2026 | `xgProfilesByTeamId` only: **no live consumer** (§3) |
| `history[*].ppda`, `.ppda_allowed` (`{att,def}` or number) | `style.js:109-110`, `readPpdaPair` `:265-275` | `Number()` | 2026 | same: dead path |
| `history[*].deep`, `.deep_allowed` | `style.js:111-112` | `Number()` | 2026 | same: dead path |
| `[*].id` | not read | - | - | - |

### 2b. `league/EPL/{y}` -> `playersData` (**must be an Array**, `form.js:270`; **2026 payload only**, `composite.js:176-184`)

| Field | Reads | Parse | Feeds |
|---|---|---|---|
| `player_name` | `form.js:273-274` | lowercased, trimmed; first occurrence wins (`:275`) | **Join key** to FPL `fullName` (`form.js:287`, `counter.js:68`, `channel.js:365`) |
| `time` | `form.js:291`; `counter.js:71,161,372` | `parseFloat` | Player-form per-90 divisor; role-signature minutes floor (450); personnel factor |
| `xG` | `form.js:293` | `parseFloat` | **Player form** underlying overlay: (xG+xA)/90 -> `W_UNDERLYING` 0.2 of `calcPlayerForm` (`config.js:398`) -> `PROJ_FORM` 0.36 |
| `xA` | `form.js:294`; `counter.js:167` | `parseFloat` | Player form overlay; **role signature** `createBias` (DEF FB test) |
| `npxG` | `counter.js:168` | `parseFloat` | **Role signature** `npxg90` (MID WM test, `ROLE_SIGNATURE_THRESHOLDS.midWmNpxg90Min`) |
| `xGChain` | `counter.js:72,162-163,177,373` | `parseFloat` | **Role signature**: floor (>=0.5), `buildupShare` denominator, `chain90` -> **channel personnel factor** |
| `xGBuildup` | `counter.js:166` | `parseFloat` | **Role signature** `buildupShare` numerator |
| `position`, `team_title`, others | not read in the app (`position` read only by offline `derive_constants.py:111`) | - | - |

Role classification (`classifyRole`, `counter.js:59-130`) is consumed live by `channelPersonnelFactor` roles (`channel.js:276-279`) and `calcIndividualDuels` (`counter.js:820,825`; Matchup duels).

### 2c. `league/EPL/{y}` -> `datesData` (**must be an Array**; every season fetched)

| Field | Reads | Parse | Seasons | Feeds |
|---|---|---|---|---|
| `isResult` | `form.js:49`, `h2h.js:157` | truthiness | all 6 | Played-match filter: **H2H**, **team-form xG index** |
| `h.title`, `a.title` | `h2h.js:157-163,176-177`, `form.js:49,53`, `channel.js:416-419` | `canonicalClubKey` | all 6 (form/matchId: 2026) | **H2H** pair match; **teamForm** xG lookup key `home\|away`; **fixture to match-id** match |
| `goals.h`, `goals.a` | `h2h.js:165-166` | `Number()` | all 6 | **H2H**: `composite.history` (weight 0.10, last `N_H2H`=8, `config.js:304`) and the Fixtures-tab H2H view (last `H2H_MEETING_WINDOW`=10, `config.js:1275`) |
| `datetime` (`YYYY-MM-DD HH:MM:SS`, UTC) | `h2h.js:170,59-63`; `channel.js:423` | space to `T`; `+'Z'` in channel | all 6 (channel: 2026) | H2H date/season label/ordering; match-id tolerance (5 days, `config.js:1249`) |
| `xG.h`, `xG.a` | `form.js:50-51` | `Number()` | **2026 only** (`form.js:35-37`) | **teamForm** performance overlay (`W_FORM_PERFORMANCE` 0.2 of teamForm 0.20 = ~0.04 of composite, `config.js:324`) |
| `id` | `channel.js:416,428` | `String()` | 2026 | **Understat match id** for `match/{id}`, `matchdata/{id}` |

### 2d. `team/{slug}/{UNDERSTAT_SEASON}` -> `{ statistics, datesData, playersData }`

| Field | Reads | Feeds |
|---|---|---|
| `statistics.situation.{OpenPlay, FromCorner, SetPiece, DirectFreekick}.xG` and `.against.xG` | `channel.js:126,131,168` via `bucketXg` `:80-84` (`parseFloat`) | **Channel: `setPieceThreat`** (dead-ball share of non-penalty xG; weight 0.50) |
| `statistics.situation.*.shots` | `channel.js:137-141` | Diagnostic `profile.shots` only; no reader |
| `statistics.situation.Penalty` | deliberately excluded (`channel.js:103-105`) | - |
| `statistics.shotZone.{shotSixYardBox, shotPenaltyArea, shotOboxTotal}.xG` / `.against.xG` | `channel.js:127,132,169` | **Channel: `boxThreat`** (weight 0.20). `shotOboxTotal` is the denominator "rest" |
| `statistics.shotZone.ownGoals` | excluded | - |
| `statistics.attackSpeed.{Fast, Normal, Standard, Slow}.xG` / `.against.xG` | `channel.js:128,170-171` | **Channel: `wideTransition`** (Fast share; weight 0.30) |
| `datesData[*].isResult` | `channel.js:222` | **Maturity**: `matchesPlayed / 10` (`CHANNEL_MATURITY_FULL_MATCHES`, `config.js:596`; `channel.js:165`) scales the counter's composite weight 0..1 |
| `playersData`, other `statistics.*` blocks, other `datesData` fields | not read | - |

Channel output feeds `calcChannelCounter` (`channel.js:256-320`) -> `calcCombinedCounterMatchup` (`counter.js:652-673`) -> `composite.counterMatchup` (weight 0.25, `config.js:687`) and, mirrored, the DEF/GKP player counter edge (`composite.js:742-748`).

### 2e. `match/{id}` -> `{html}`; parsed by `parseMatchTimeline` (`api.js:407-460`)

| Selector / attribute | Reads | Feeds |
|---|---|---|
| `.timeline-block .timeline-item` | `:415` | One minute |
| `.timeline-item-right` (class) | `:423` | Side: away if present, else home |
| `.timeline-time` text | `:419` | `parseInt` minute |
| `.timeline-row` | `:425` | One event |
| `a.timeline-player-name` text | `:426` | Player; for a sub, `[0]` off and `[1]` on |
| `.timeline-match-score` text | `:436` | Running score (goals) |
| any `[title]` containing `own goal` / `goal` / `yellow` / `red` / `substitut`; `.icon-sub` | `:433-444` | Event type |

Feeds the **Fixtures-tab match feed** only (`fixtures.js:848-879`). Source of card/sub **minutes** (stated as published nowhere else, `api.js:299-305`).

### 2f. `matchdata/{id}` -> `{ rosters, shots, tmpl }`

| Field | Reads | Parse | Feeds |
|---|---|---|---|
| `shots.h[]`, `shots.a[]` -> `.result === 'Goal'`, `.player_assisted`, `.minute`, `.player` | `api.js:476-487` | `Number(minute)`; exact string equality on `player` | **Goal to assist pairing** in the feed |
| `rosters.h`, `rosters.a` (objects keyed by roster id) | `normalise.js:860-868` | - | **Lineups**: formation + XI + subs used |
| `rosters.*[*].id, .player, .position, .positionOrder, .time, .goals, .own_goals, .assists, .yellow_card, .red_card, .roster_in, .roster_out` | `normalise.js:804-822` | `Number()` via `num()` (`:777`) | Lineup rows, marks, substitution linkage (`:826-835`), formation from position codes (`FORMATION_LINES`, `:765-771`) |
| `tmpl`, other shot fields | not read | - | - |

---

## 3. FETCHED BUT UNUSED

| Dataset / field | Where it sits | Evidence it is unread |
|---|---|---|
| `teamsData[*].history[*].{xG, xGA, npxG, ppda, ppda_allowed, deep, deep_allowed}` (2026) and the whole `xgProfilesByTeamId` it builds | Built on **every** `buildScoreContext` (`composite.js:177-179`) | Only reader is `calcStyleProfile` (`style.js:332`). Its callers are `calcStyleClash` (commented out, `composite.js:422`) and the console-only `window.__engine` (`main.js:560`). No test imports `style.js`. `composite.js:30-32` claims counter.js and the UI consume it (D7); neither does |
| `playersData` for 2025 (`leagueXgPrev`) and 2021-2024 (`leagueXgHistory`) | Fetched inside each league payload | `buildUnderstatPlayerLookup` is fed `leagueXg` (2026) only (`composite.js:182-184`) |
| `teamsData` for 2021-2024 | Same payloads | History consumers read `leagueXg` + `leagueXgPrev` only (`fixtures.js:199-202`); H2H reads only `datesData` (`h2h.js:150-153`) |
| `datesData[*].xG` for 2021-2025 | Same payloads | `buildXgIndex` reads `ctx.leagueXg` only (`form.js:35-37,72`) |
| Team payload `playersData` | `team/{slug}/{y}` x20 | No read of `teamXg[slug].playersData` anywhere |
| Team payload `datesData` beyond `isResult` | Same | Only `.filter(m => m?.isResult).length` (`channel.js:222`) |
| `statistics` blocks other than `situation`, `shotZone`, `attackSpeed` | Same | Spec lists the others as `formation, gameState, timing, result`, "deferred" (`docs/superpowers/specs/2026-08-20-understat-channel-counters-design.md:47,288-295`); code reads three keys (`channel.js:126-128`) |
| `statistics.*.{goals, shots}` and `against.{goals, shots}` | Same | Only `.xG` / `.against.xG` used; `shots` feeds a diagnostic with no reader |
| `profile.shots`, `profile.matches` | Channel profile (`channel.js:137-141,185-187`) | No reader in engine or modules |
| `matchdata.tmpl`; non-`Goal` shots; shot `xG/X/Y/situation` etc. | `matchdata/{id}` | Only `result`, `player_assisted`, `minute`, `player` read (`api.js:476-487`) |
| `minutesWeightedMeanChain` and `CHAIN_UNIT_ANCHORS` | `counter.js:300`, `config.js:522` | Only referenced from the commented-out tier (`counter.js:469-471`) and tests |
| `config.js:1138` `PROXY_BASE` | - | No importer; `api.js:16` hardcodes the proxy URL (D6) |

---

## 4. DEGRADATION MAP

"Missing" = request fails, payload empty, or (for the live season) not yet published.

| Feature | Needs | If missing | Fallback | User sees | Throws? | Silently wrong? |
|---|---|---|---|---|---|---|
| **Boot / first render** | 6 league calls (`main.js:188-195`) | Rejected calls log a warning and continue (`:216-249`); never `setError` | n/a | Nothing, once settled. **A hanging call delays first `data:ready`**: all 8 requests are `allSettled`, no client timeout (`api.js:47`), no `maxDuration` in `vercel.json` | No | Latency only |
| **Channel counter** (composite `counterMatchup`, weight 0.25) | 2026 league titles -> slugs; team `statistics`; team `datesData.isResult` | Team absent -> omitted from profiles (`channel.js:211-227`); either side absent -> **blank shell**: `value:null`, `estimated:true`, `maturity:0` (`channel.js:266`, `:328-337`) | **None.** `counter.js:431` returns channel unconditionally. Weight dropped and remaining weights re-normalised (`composite.js:432-472`, `term()` `:463-464`); stacking penalty skips it (`:343`) | Em-dash rows, "No Understat shot data published for these teams yet" (`matchup.js:432`) | No | **Yes (minor):** blank `breakdown.counterMatchup.value` is numeric `0`, not `null`, because `0.5*null` is `0` (`counter.js:654-655`; verified). Masked by `estimated`/`maturity 0`; a reader that ignores both sees 0 |
| Channel: season start / empty 2026 payload | 2026 `teamsData` non-empty | Empty league payload gives no slugs (`channel.js:41-60`), so **0 team requests all session**; `store.getLeagueXg()` is non-null so no refetch until reload (`main.js:153`) | None | Blank counter everywhere. Test header records the 2026 payload was `{"teams":[],"players":[],"dates":[]}` on 2026-08-21 (`tests/engine/roleThresholds.test.js:20-25`) | No | No |
| Channel: early-season thin data | team `isResult` count | Ramp, not gate: weight = 0.25 x min(maturity_A, maturity_B), maturity = matches/10 (`channel.js:165,271`) | n/a | Maturity counter in Matchup (`matchup.js:440-476`) | No | No |
| **Player counter edge** (`PROJ_COUNTER` 0.16) | channel profiles | **DEF/GKP:** blank -> neutral 50 (`counter.js:616-619`; test `composite.test.js:160-172`). **FWD/MID:** see next row | - | - | No | - |
| **Player counter edge, FWD/MID** | nothing usable | Reads `pairings.fwdVsCb / wideMidVsFb / camVsCbMid` (`composite.js:733-741`): keys the channel tier never emits, so always `50` and `estimated:true`, **with or without Understat** (verified: with mature, non-neutral profiles FWD/MID = 50/estimated, DEF/GKP = 39.86/not estimated) | None; no data path exists | Every FWD/MID chip shows the "estimated" treatment (`ranker.js:181-183`, `dashboard.js:208-210`); `nextFixtureScore.estimated` true (`composite.js:1207`) | No | **Yes:** a constant 0.16 x 50 in 2 of 4 positions, contradicting `FEATURE_ENGINE.md:997` (D2) |
| **teamForm xG overlay** (~0.04 of composite) | 2026 `datesData.xG` + titles | Per match: actual goal difference instead (`form.js:126-129`) | Goal difference | Nothing | No | **Yes:** definition switches per match with no flag |
| **H2H** (`composite.history` 0.10; Fixtures H2H view) | `datesData` x6 | Fewer seasons -> fewer meetings. None -> FPL this-season fixtures (`fixtures.js:554-556`); <2 meetings -> 50, `estimated:true`, weight dropped (`:558-565`) | This-season FPL only. A pair meets once per venue per season, so >=2 needs both legs played | Fixtures H2H: "No meeting ... in the seasons loaded" / "still loading" (`fixtures.js:958-966`); season count from `loadedSeasonCount` (`:404-407`) | No | No: weight dropped |
| **homeAway** (0.05) | 2026+2025 `history` | Falls to current-season FPL fixtures (`fixtures.js:255-258`, `:306-309`); <4 games at either venue -> neutral 50 **not flagged estimated** (`fixtures.js:278-288`) | FPL fixtures | Nothing | No | By design: neutral 50 keeps its weight |
| **Player form xG overlay** (`W_UNDERLYING` 0.2) | 2026 `playersData` name match | No match -> FPL element-summary xG/xA (`form.js:430-436`, `xgSource:'fpl'`, `xgEstimated:true`); no history -> neutral 50 (`:339-347`) | FPL xG | Nothing explicit | No | Name misses are silent: exact lowercase equality, no accent folding (`form.js:265-268`) |
| **Role classification** | 2026 `playersData` | Chain tier skipped (`counter.js:70-79`); ICT shares used (`:82-129`) | ICT, then `null` | Nothing | No | Roles may differ from chain-based ones |
| **Channel personnel factor** (0.80-1.20) | `playersData` chain | No lookup/match -> exactly 1 (`channel.js:358-359,380`) | Neutral | Nothing | No | No |
| **Planner xG goals** | Everything above, via `scoreFixture` (`projections.js:211-241`) | Inherits every row | Inherits | Planner gated until `isTeamXgSettled` (`planner.js:538`) | No | Inherits silent items |
| **Skeleton gating** | team prefetch bookkeeping | No league payload -> no slugs -> `markTeamXgRequested([])` latches dispatched (`main.js:357-373`, `store.js:261-264`) so nothing stays skeletoned. Team fetch error: settled in `.finally` (`main.js:384-399`). Hang: 20 s force-settle (`config.js:1102`, `main.js:333-351`) | n/a | No stuck skeleton | No | No |
| **Unresolved club name** (alias miss, e.g. the earlier Coventry bug, `config.js:187-191`) | Name via `TEAM_NAME_ALIASES` | No slug -> no team fetch -> blank counter; `isTeamScoreSettled` returns true (`store.js:348-353`) | None | One team on blank counter | No | No |
| **Fixtures match feed** | league `datesData.id` -> `match/{id}`, `matchdata/{id}` | No league payload: silent no-op, FPL fallback (`fixtures.js:1248-1249`, `:1003-1010`). No id match / empty timeline / fetch error: `failTimeline` (`:1207-1211`) -> FPL grouped totals (`eventHtml` `:822`) | FPL grouped totals (no minutes, no order) | Fallback list | No | No |
| **Fixtures lineups / assists** | `matchdata/{id}` | Fail -> feed without assists; FPL appearance list instead of lineups (`fixtures.js:1273-1279`, `:931-932`) | Appearances list | Fallback list | No | No |

**Features with NO fallback:** the channel counter (no alternative tier); card/sub **minutes** and goal-to-assist pairing (no other source, `ARCHITECTURE.md:475`); formation/lineup shape; the FWD/MID counter edge (no data path at all); H2H beyond the current season (FPL fixtures cover this season only, `ARCHITECTURE.md:474`); the 38-match cross-season venue window (falls back to this season only).

---

## 5. SNAPSHOT PLAN

### 5a. Finished seasons (cannot change) - as of 2026-11-09

The proxy treats `year < currentSeason` as final (`api/fpl.js:94-99`); the app's config lists exactly these (`config.js:1150`, `:1167`):

| # | Client path | Upstream URL | Why the app needs it |
|---|---|---|---|
| 1 | `league/EPL/2025` | `https://understat.com/getLeagueData/EPL/2025` | PREV: `datesData` (H2H) + `teamsData[*].{title, history}` (venue window) |
| 2 | `league/EPL/2024` | `.../getLeagueData/EPL/2024` | H2H `datesData` |
| 3 | `league/EPL/2023` | `.../getLeagueData/EPL/2023` | H2H `datesData` |
| 4 | `league/EPL/2022` | `.../getLeagueData/EPL/2022` | H2H `datesData` |
| 5 | `league/EPL/2021` | `.../getLeagueData/EPL/2021` | H2H `datesData` |

**Request count to freeze exactly what the app consumes from finished seasons: 5.**

Not requested by the app, so **not needed for parity**:
- **Team payloads for finished seasons: 0.** `fetchTeamXg` is hardcoded to `UNDERSTAT_SEASON` (`api.js:290`). If wanted anyway: 5 seasons x 20 clubs = **100** `team/{slug}/{y}` files (27 distinct clubs across 2021-2025 from `PL_SEASONS`, `config.js:87-125`). Slugs per season are that season's `teamsData[*].title` with spaces to underscores (`channel.js:55`).
- **Match/matchdata for finished seasons: 0.** Ids are read from the 2026 payload only (`fixtures.js:1248-1251`). If wanted anyway: ids = `datesData[*].id` per season, 380 x 5 = 1,900 matches = **3,800** requests.

**Match ids the app actually requests:** no static list. Runtime: `findUnderstatMatchId` (`channel.js:399-432`) maps a non-upcoming 2026 FPL fixture to a `datesData[*].id` of the 2026 payload (home title + away title via `canonicalClubKey`, kickoff within 5 days). At most one `match` plus one `matchdata` per played 2026 fixture, only when a user opens that drawer.

### 5b. Live season (2026)

| Dataset | Requests | Refresh implied by cache |
|---|---|---|
| `league/EPL/2026` | 1 | 1 h edge/browser (`:58`) |
| `team/{slug}/2026` | ≤20 | 1 h |
| `match/{id}`, `matchdata/{id}` for played 2026 fixtures | ≤2 x 380 over the season, on demand | 24 h |

At the next **1 July (UTC)** `seasonCache` flips 2026 to "finished" automatically (`:94-95`) while `UNDERSTAT_SEASON` still reads `'2026'` until hand-bumped (`config.js:1146-1149`). Then `league/EPL/2026` joins (a) (as the new PREV), and the 20 `team/{slug}/2026` files only matter if finished-season team data is wanted.

**Not a snapshot:** finished-season responses were declared cacheable for a year at the edge and in browsers (`:57`), so copies *may* still exist at the proxy (`https://gaffer-iq-josh-bailey.vercel.app/api/fpl?source=understat&path=league/EPL/{y}`, `api.js:16`) or in a browser profile that loaded the app. Unverified (no network call made); edge entries are not a durable archive.

### 5c. Required shape of each response (post `renameUnderstatKeys`, `api/fpl.js:337-344`)

Rename is deterministic: `teams`→`teamsData`, `players`→`playersData`, `dates`→`datesData` when present; `statistics`, `rosters`, `shots`, `tmpl` untouched. Save the **post-rename** JSON so it can replace the proxy response verbatim. Minimum the code requires:

```
league/EPL/{y}  ->  {
  teamsData:   { "<id>": { title: string,                        // or an array of the same objects
                           history: [ { date: "YYYY-MM-DD HH:MM:SS",
                                        h_a: "h"|"a", scored, missed,           // Number()-parsed
                                        xG, xGA, npxG, ppda:{att,def}|number,
                                        ppda_allowed:{att,def}|number,
                                        deep, deep_allowed } ] } },    // xG..deep_allowed: read only by dead style.js
  playersData: [ { player_name, time, xG, xA, npxG, xGChain, xGBuildup } ],   // ARRAY, numerics as strings or numbers
  datesData:   [ { id, isResult: boolean,
                   datetime: "YYYY-MM-DD HH:MM:SS",               // UTC, no zone suffix
                   h: { title }, a: { title },
                   goals: { h, a }, xG: { h, a } } ]               // ARRAY
}
team/{slug}/{y} ->  {
  statistics: {
    situation:   { OpenPlay, FromCorner, SetPiece, DirectFreekick },       // each { xG, against:{xG} } (shots optional)
    shotZone:    { shotSixYardBox, shotPenaltyArea, shotOboxTotal },       // each { xG, against:{xG} }
    attackSpeed: { Fast, Normal, Standard, Slow }                          // each { xG, against:{xG} }
  },
  datesData: [ { isResult } ]                                              // only the played count is used
}
match/{id}      ->  { html: "<markup containing .timeline-block .timeline-item ...>" }   // see §2e selectors
matchdata/{id}  ->  { rosters: { h: { "<rosterId>": {id, player, position, positionOrder, time,
                                      goals, own_goals, assists, yellow_card, red_card,
                                      roster_in, roster_out} }, a: { ... } },
                      shots:   { h: [ {result, player_assisted, minute, player} ], a: [ ... ] } }
```

Shape constraints that break silently if violated:
- `playersData` and `datesData` must be **Arrays** (`form.js:270`, `channel.js:401`); `history` must be an Array (`fixtures.js:207`).
- `isResult` is tested by truthiness (`form.js:49`, `h2h.js:157`, `channel.js:222`): a string `"false"` would count as played.
- `datetime` must be space-separated, zone-less UTC: channel appends `Z` after swapping the space (`channel.js:423`); an ISO string with its own `Z` parses to NaN and the 5-day tolerance is skipped (`channel.js:424-426`).
- `h_a` exact lowercase `'h'`/`'a'` (`fixtures.js:232-233`).
- Bucket names are literal keys (`channel.js:131-132,168-171`).

**Insertion seams (facts only).** `handleUnderstat` validates the path then fetches upstream at `api/fpl.js:270`: a static lookup before that line, with `resolveCache` headers preserved, would be invisible to the client. Alternatively the four client fns (`api.js:264, 285, 323, 352`) all go through `callProxy` (`:40-76`) and return the body unmodified, so any JSON of the shapes above can stand in for the response.

---

## 6. LOCAL DATA ALREADY ON DISK

**This container is a fresh clone**, so gitignored/generated folders are absent here. `git status --ignored` shows nothing ignored under `gaffer-iq`. Anything below marked "may exist" can only be checked on the user's machine.

| Location | Here? | Contents | Understat? |
|---|---|---|---|
| `tools/backtest/data/` (ignored, `tools/backtest/.gitignore:1`) | **Absent** | Filled by `tools/backtest/download.js` from vaastav FPL data: `merged_gw.csv, fixtures.csv, teams.csv, players_raw.csv` for `2022-23, 2023-24, 2024-25, 2025-26` (`history.js:22`). Root `.gitignore` also ignores `*.csv` | **No.** FPL only |
| `tools/minutes/data/` (ignored, `tools/minutes/.gitignore:1`) | **Absent** | `merged_gw.csv` for `2023-24, 2024-25, 2025-26` (`tools/minutes/lib.js:16`) | **No** |
| `tools/points/` | No data dir | Reads backtest data via `tools/backtest/history.js` (`fit.js:31`); `tools/points/REPORT.md` is a written report | **No.** `leagueXg` in `points/lib.js:185`, `model.js:65`, `fit.js:185` is an FPL-derived league mean-xG constant (name collision) |
| `understat-cache/` (default `--out` of `docs/superpowers/derive_constants.py:280-281`) | **Absent** | Would hold raw un-renamed `league-{season}.json` and `team-{slug}-{season}.json` (`:284-296`; keys `players`, `statistics`, `teams`), default season 2025. Not ignored by any `.gitignore` rule I found, and not committed | **Yes, raw**, if it was ever run locally. **Check the machine that ran it** |
| `tests/modules/fixtures/planner-cards-solver-off.json` | Present, 115,483 B | Planner card fixture (keys `moves, rolls, rollsFt, covered, wait, news, blank, estimated, tail, tailPlan`) | **No** (0 matches for `understat`, `xGChain`, `teamsData`, `datesData`, `playersData`, `statistics`, `ppda`) |
| `tests/engine/roleThresholds.test.js:41-81` | Present | **5 raw `playersData` records** (Robertson, Tarkowski, Xhaka, Saka, Haaland): `time, xG, xA, npxG, xGChain, xGBuildup`, season **2025**, captured live 2026-08-21 (`:11-25`) | **Yes, raw**, 5 players |
| `tests/engine/counter.test.js:15-20` | Present | 2 raw records (Saliba, Saka), "real 2025 Understat records" | **Yes, raw**, 2 players |
| `tests/engine/channel.test.js:25-50` | Present | One synthetic `statistics` block with round numbers | Shape only, not captured |
| `tests/engine/{projections,ceiling,team-goals}.test.js` | Present | Synthetic signatures; `leagueXg: 1.4` is the FPL-derived constant | No |
| `js/config.js:475-489,522,548-563` | Present | Constants derived from the 2025 payload: `ROLE_SIGNATURE_THRESHOLDS`, `CHAIN_UNIT_ANCHORS`, `CHANNEL_AXIS_POOLED_SD`, `CHANNEL_WEIGHTS` | **Derived numbers only** |
| `docs/superpowers/specs/2026-08-20-understat-channel-counters-design.md` | Present | Quoted statistics (e.g. "537 players in the 2025 season payload", correlations) | Derived numbers only |
| Browser IndexedDB (`js/snapshots.js`) | n/a | FPL bootstrap + GW tables | **No** |

**Offline engine runs used no Understat.** `tools/backtest/run.js:294,370` and `tools/points/fit.js:72` call `buildScoreContext(s, { currentGw: t })` with no Understat options; `tools/backtest/run.js:1441` and `tools/points/REPORT.md:41` state it. The counter weight and `PROJ_COUNTER` were never back-tested with Understat inputs.

**Net:** no complete Understat payload for any season exists in the repo. The only raw Understat data in git is 7 player records.

---

## 7. ASSUMPTIONS TO RE-CHECK

| Area | Assumption | Where |
|---|---|---|
| **Team identity** | FPL and Understat join **by name** via `canonicalClubKey` (lowercase, strip non-alphanumerics, then `TEAM_NAME_ALIASES`), never by id (`normalise.js:94-97`; `config.js:1168-1175`). The alias table carries Understat-specific forms (`tottenham` `:179`, `coventry` `:191`). A new source's club names must resolve through it or need alias entries |
| **Slug** | `title.replace(/ /g,'_')` (`channel.js:55`); accepted charset `[A-Za-z_]+` on both client and proxy (`api.js:286`, `fpl.js:106`): digits, hyphens, dots, accents rejected |
| **Season naming** | 4-digit **start year** string: `'2026'` = 2026/27 (`config.js:1142-1149`, `fpl.js:83-84`); client regex `^\d{4}$` (`api.js:265`); `seasonCache` reads `path.slice(-4)` (`fpl.js:86`); July rollover (`fpl.js:94-95`, `config.js:1258`); `UNDERSTAT_*` hand-bumped each close season; `PL_SEASONS` needs a yearly addition (`config.js:1146-1149`); display label `YYYY/YY` derived from dates (`h2h.js:70-76`) |
| **Match id** | `^\d{1,8}$` (`api.js:313`, `fpl.js:116,121`); taken from `datesData[*].id`, stringified (`channel.js:416,428`); **no id crosswalk**: FPL fixture is matched by home title + away title + kickoff within 5 days (`config.js:1249`, `channel.js:399-432`) |
| **String-typed numbers** | `playersData` numerics parsed with `parseFloat` (accepts real numbers); `history.scored/missed`, `deep`, `datesData.goals/xG` via `Number()`; a non-numeric value is skipped or `NaN`-guarded at each site |
| **Timestamps** | `YYYY-MM-DD HH:MM:SS` UTC with no zone: channel appends `Z` (`channel.js:423`); `h2h.js:59-63` and `fixtures.js:223` parse as local time; ISO-with-`Z` would break the channel tolerance |
| **Played flag** | `isResult` boolean and the team payload's `datesData` as the per-team **played count** driving maturity (`channel.js:222`) |
| **Venue marker** | `h_a` is `'h'`/`'a'` and `scored`/`missed` are the **team's own** goals, not home/away goals (`fixtures.js:183-188`) |
| **xG definition** | Per-90 anchors, thresholds and SDs were derived on Understat 2025: `PLAYER_XG_ANCHORS` (`config.js:413`), `CHANNEL_AXIS_POOLED_SD` (`:548-552`), `CHANNEL_WEIGHTS` (`:559-563`), `ROLE_SIGNATURE_THRESHOLDS` (`:475-489`, "derived from the 2025 season, 139 DEF / 153 MID / 24 FWD with at least 900 minutes"), `CHAIN_UNIT_ANCHORS` (`:522`). A different xG model shifts every one |
| **Understat-defined metrics** | `xGChain`, `xGBuildup` (role signature: `buildupShare = xGBuildup/xGChain`, `createBias = xA90/(xA90+npxG90)`, `counter.js:158-179`) and `npxG` have Understat definitions; the FB/DM/WM/SS thresholds depend on them |
| **PPDA / deep** | `ppda` as `{att, def}` aggregated as ratio-of-sums (`style.js:95-100`, `:257-275`); `deep` = passes completed within ~20 m of goal (`style.js:217-219`). Dead path today; matters only if style is restored (`config.js:352-379`) |
| **Shot buckets** | Literal keys: `OpenPlay/FromCorner/SetPiece/DirectFreekick` (+`Penalty` excluded), `shotSixYardBox/shotPenaltyArea/shotOboxTotal` (+`ownGoals` excluded), `Fast/Normal/Standard/Slow` (`channel.js:131-132,168-171`). Box share = (6yd + penalty area) / (that + `shotOboxTotal`) |
| **Player name matching** | Exact lowercased equality of `player_name` against FPL `fullName`, first duplicate wins (`form.js:273-275`, `counter.js:68`); the same string equality joins a goal's shot to its timeline entry (`api.js:485-486`) |
| **Match page DOM** | Scraped selectors and title strings (`Goal`, `Own goal`, `Yellow card`, `Red card`, `Substituted off/on`, `.icon-sub`) (`api.js:407-460`) |
| **Roster codes** | `GK, DR, DC, DL, DMC, DML, DMR, MC, ML, MR, AMC, AML, AMR, FW, FWL, FWR, Sub`; `roster_in`/`roster_out` substitution linkage; only players who appeared are listed (`normalise.js:765-774,801-847`) |
| **Season-start state** | The channel tier needs the **live-season** league payload to list teams before any team fetch can start (`channel.js:41-60`). Empty payload at season start means a blank counter for the session |
| **Proxy contract** | Upstream required `X-Requested-With: XMLHttpRequest` and an explicit season (`fpl.js:240-246`); the proxy URL is hardcoded absolute (`api.js:16`) |

### Code vs docs disagreements (consolidated)

| # | Docs / comments say | Code does |
|---|---|---|
| D1 | `ARCHITECTURE.md:393-395`; spec `…channel-counters-design.md:257`; `composite.js:188-190`; `counter.js:395-397`; `main.js:532-535` (`teamXgBySlug: {}` "forces the role tier"); `FEATURE_ENGINE.md:344-347,456-458`: counter degrades to a role/element tier | `counter.js:431` returns channel unconditionally; `FEATURE_ENGINE.md:386-394` correctly says the ladder is retired. `classifyTeamRoles` has no live caller |
| D2 | `FEATURE_ENGINE.md:997`: a striker gets the FWD-vs-CB pairing | `composite.js:731-741` reads retired pairing keys: FWD/MID edge is always 50, `estimated:true` |
| D3 | `FEATURE_ENGINE.md:170` "across the 4 fetched seasons"; `h2h.js:125` "five seasons" | 6 seasons (`config.js:1149,1150,1167`; `FEATURE_ENGINE.md:164`; `ARCHITECTURE.md:474`) |
| D4 | `config.js:1177-1179` `XG_TTL_MS` "Cache TTL for the league-level Understat payload" | Never read; no TTL logic exists (memory lives for the page) |
| D5 | `main.js:141` names `leagueXg/leagueXgPrev/Prev2/Prev3` | Fields are `leagueXg`, `leagueXgPrev`, `leagueXgHistory[]` (`store.js:41-55`) |
| D6 | `config.js:1137-1138` `PROXY_BASE = '/api/fpl'` | Unused; `api.js:16` hardcodes an absolute URL |
| D7 | `composite.js:30-32`: xG profiles "consumed by engine/counter.js and displayed by the UI" | No reader except `calcStyleProfile` (`style.js:332`), itself unwired (`composite.js:422`) |
| D8 | `store.js:42-47`, `composite.js:199-200`: `leagueXgPrev` is read only by the venue window | Also read by H2H (`h2h.js:151`) |
| D9 | `tests/engine/channel.test.js:96,256,261,274,295` and the comments at `:253-257` assert shot-count maturity (`CHANNEL_MATURITY_FULL_SHOTS` 120, `MIN_CHANNEL_SHOTS`) | `channel.js:125,165` uses `matchesPlayed/10`; those constants no longer exist. **5 failing tests**: `no longer nulls a thin profile - it scales it`, `reports maturity 1 at or above the full-evidence bar`, `scores a thin profile instead of nulling it`, `clamps maturity to 1, never above`, `keeps thin profiles now that they score`. `FEATURE_ENGINE.md:396-399` describes the history correctly |
| D10 | `api/fpl.js:330-332`: `statistics` "the client doesn't currently read it" | `channel.js:126-128` reads it; it is the channel tier's only input |
| D11 | Spec §10 (`…design.md:296-297`): interim `MIN_CHANNEL_SHOTS` guard | Gone from code |

---

## RANKED: load-bearing vs nice-to-have

**Load-bearing (engine breaks or degrades badly without them)**
1. `teamsData[*].title` + `datesData[*].{h.title, a.title}` (2026): the identity join. Without the 2026 titles **no slug resolves, so no team payload is ever fetched** and the whole channel tier is blank.
2. Team `statistics.{situation, shotZone, attackSpeed}.{xG, against.xG}`: sole input of the counter (composite weight 0.25) and of DEF/GKP player counter edge. **No fallback.**
3. Team `datesData[*].isResult`: sets maturity; without it the counter's weight is 0 even with `statistics`.
4. `datesData[*].{isResult, goals.h, goals.a, datetime}` x 6 seasons: sole source of multi-season H2H (composite 0.10 + Fixtures H2H view). Fallback is this-season FPL only, which is almost always <2 meetings.

**Important but has a fallback (degrades, does not break)**
5. `playersData[*].{player_name, time, xG, xA}` (2026): player-form xG overlay (0.2 of form; fallback FPL xG).
6. `playersData[*].{xGChain, xGBuildup, npxG, xA, time}` (2026): chain role signature, personnel factor 0.80-1.20, duels (fallbacks: ICT roles, factor 1).
7. `teamsData[*].history[*].{date, h_a, scored, missed}` (2026 + 2025): homeAway rolling window (weight 0.05; fallback this-season FPL, neutral 50).
8. `datesData[*].xG.{h,a}` (2026): teamForm overlay (~0.04 of composite; fallback goal difference).

**Nice-to-have (UI enrichment of the Fixtures drawer only)**
9. `datesData[*].{id, datetime}` (2026): fixture to match-id mapping.
10. `match/{id}` timeline HTML (minutes, order); `matchdata` `shots[].player_assisted` (assists) and `rosters` (lineups, formation).

**Fetched, never used:** team-history `xG/xGA/npxG/ppda/ppda_allowed/deep/deep_allowed`, `playersData` of 2021-2025, `teamsData` of 2021-2024, team `playersData`, unread `statistics` blocks, `tmpl`.
