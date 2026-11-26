# Understat compat layer - design (short)

2026-11-26. Size: small-to-medium change. Approved in conversation (user: "go all out on steps 1-3 ... park the counter").

## Intent

`understat.com` has served a "We will come back soon" placeholder (HTTP 200, HTML) on every path since 2026-11-03. Everything Understat-derived is blank, so H2H falls to this-season-only FPL fixtures, the venue window ignores last season, and team form/player xG lose their xG inputs. Restore H2H and the venue window, and the xG overlays where FPL has an equivalent, **without changing any consumer** and without depending on Understat coming back (but self-healing if it does).

Audit: `docs/understat-data-audit.md`.

## Goals

1. Finished seasons (2021-2025, `UNDERSTAT_PREV_SEASON` + `UNDERSTAT_HISTORY_SEASONS`) served as static JSON in the **post-`renameUnderstatKeys` Understat shape**, built from vaastav `fixtures.csv` + `teams.csv` (results only). Five of six league requests disappear.
2. The live season gets an FPL-derived stand-in payload of the same shape when the Understat call fails.
3. H2H (composite `history` 0.10 + Fixtures-tab H2H), venue window (`homeAway` 0.05), and player-form xG overlay (FPL season `expected_goals/assists`) work again.

## Non-goals

- **Counter matchup stays parked** (user decision). It already self-zeroes: blank channel, weight dropped, remaining weights re-normalised. No new shot-level provider.
- No consumer refactor (`h2h.js`, `fixtures.js`, `form.js`, `counter.js` untouched apart from one guard in `channel.js`).
- Not fixing the unrelated FWD/MID counter-edge bug or the 5 stale channel-maturity tests.

## Anti-goals (would be failures even if it "works")

- A synthetic payload that makes the app call Understat for something it cannot have: **no `team/{slug}` requests** and **no `match/{id}` lookups from FPL ids** (an FPL fixture id sent to Understat would fetch a *wrong match* if Understat returns).
- Fabricated data presented as Understat's: stand-in carries `synthetic: true`; no invented xG, chain, PPDA, ids.
- Silent staleness: the venue window must keep including this season's games.

## Constraints

- Engine files stay pure (no DOM/network); `api.js` is the only `fetch` caller (CONVENTIONS).
- Shapes per audit §5c: `datesData`/`playersData`/`history` are Arrays; `datetime` is `YYYY-MM-DD HH:MM:SS` UTC with no zone; `h_a` is `'h'|'a'`; `isResult` boolean.
- Club names join via `canonicalClubKey`; vaastav names (FPL spelling) were verified to resolve for all 100 season-club pairs with no new aliases.
- Static app (no build step); files are served from the app folder (`outputDirectory: "."`).

## Approaches considered

| | What | Trade-off | Verdict |
|---|---|---|---|
| **A. Compat layer** | Emit the old shape from vaastav (finished) and FPL (live); consumers untouched | Smallest blast radius; self-heals if Understat returns; keeps a vendor-shaped payload around | **Chosen** |
| B. Neutral shape | Refactor h2h/venue/form to read a plain `results[]` | Cleaner long-term; touches 5 engine files + tests | Later, only if Understat is retired for good |
| C. Serve static from the proxy | Put the lookup in `api/fpl.js` | Works, but costs a function invocation per season per load; couples data to the serverless deploy | Rejected: static assets are cheaper and edge-cached |

## Decisions

User's: steps 1-2, counter parked.

Builder's calls (flagged for review):

1. **Static files**: `data/understat-compat/league-EPL-{y}.json` for y in PREV + HISTORY. Generator `tools/understat-compat/build.js` (CLI) + pure `tools/understat-compat/lib.js` (unit-tested). Output committed; script kept for provenance and the next season bump.
2. **`fetchLeagueXg(season)`**: static first for compat seasons, proxy fallback on a missing file. Live season: proxy only.
3. **Stand-in**: new pure `js/engine/fpl-league.js` → `buildFplLeaguePayload(season)`; installed by `main.js` only when the live-season Understat call rejects. Played fixtures only; `datesData` rows have **no `id`**; `history` rows `{date,h_a,scored,missed}`; `playersData` from FPL totals (`player_name`, `time`, `xG`, `xA`, no chain) so role classification falls to ICT and the personnel factor to 1.
4. **Guard**: `buildUnderstatSlugsByTeamId` returns `{}` when `leagueXg.synthetic`, which stops every team prefetch and keeps `isTeamScoreSettled` honest.
5. **Step 3 dropped** (`calcFixtureHistory` merging FPL fixtures): the stand-in already supplies current-season meetings.
6. `xgSource` in `calcPlayerForm` will read `'understat'` for FPL-sourced xG. It has no reader outside `form.js`; noted in a comment rather than widening the type.
7. Docs: ARCHITECTURE.md (§3 tree, §6, §7), FEATURE_ENGINE.md (§3.1, §4), config comments.

## Verification

- Unit tests (TDD): generator lib, stand-in builder, slug guard, `fetchLeagueXg` static-then-proxy, data-file invariants (20 clubs, 380 played, 38 history rows each, names resolve against `PL_SEASONS`).
- Integration: real engine (`calcFixtureHistory`, `buildRollingVenueStatsByTeamId`, `scoreFixture`) over static + stand-in.
- Browser: Playwright against a local static server, with the FPL proxy replayed from real captured payloads and Understat simulated dead; assert H2H renders, no Understat team/match requests, no console errors.
- `node --test` before/after: baseline 5 known channel-maturity failures (+1 timing-sensitive test), no new failures.

## Left to the builder

File-level layout of tests, exact JSON field order, header/caching rule for `/data/`, wording of the console warning.
