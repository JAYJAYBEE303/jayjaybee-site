# Full Season — a GW1–38 planning strip on the Matchup page

**Date:** 2026-09-01
**Status:** design approved, implementation plan pending
**Scope:** two new files (`engine/season.js`, `modules/fullSeason.js`), `config.js`, `index.html`, `components.css`, `main.js`, `tests/engine/season.test.js`

---

## 1. Problem

Every existing view answers a question about **one** gameweek, or about a short
window from today. The Matchup Analyser scores a single fixture. The Ranker
scores players over the active horizon. The Planner recommends this week's
transfers. `engine/chips.js` searches `CHIP_PLAN_HORIZON` (6) gameweeks ahead of
`currentGw` and no further.

Nothing answers the question a manager actually asks in August: **which weeks of
this season are worth waiting for?** Which gameweeks are loaded with one-sided
fixtures, where do the schedule irregularities cluster, and when — in each half
of the season — is a chip best spent. That read requires seeing GW1 and GW38 at
the same time, which no current view can do.

## 2. Goals

- One graphic covering **GW1–38**, readable at a glance, that shows where the
  season's good weeks are.
- Per gameweek: the **top 3 matchups** and the **top 5 players**, on demand.
- Make schedule irregularities — doubles, postponements — impossible to miss.
- Name a **chip window per half-season**, respecting the GW19 chip reset.
- Encode strength **graphically** (colour, glow, geometry), not as labels.

## 3. Non-goals

- Replacing the Fixtures tab's per-gameweek views. This is a planning overview,
  not a results browser.
- Squad-specific advice. The strip is the same for every visitor (§4).
- Bench Boost timing, which is meaningless without a squad.
- Mobile layout. Desktop tool, per `CONVENTIONS.md` §5.4.

## 4. Decisions taken

| Question | Decision |
|---|---|
| Placement | Foot of the **Matchup** page, full page width — not a Fixtures sub-view |
| Shape | Horizontal ribbon of 38 columns in a scroller, one per gameweek |
| Expansion | Click a week; a panel expands **upward** over the page |
| Player pool | **Whole league**, ranked for that specific gameweek, skeleton-loaded |
| Played weeks | Collapse to thin recap stubs |
| Chip windows | **Squad-agnostic**, league-wide; Bench Boost dropped |
| Chip rail | Below the ribbon (the panel expands up over where it used to sit) |
| Postponements | Attributed to a gameweek **by inference** (§6.3), shown bottom-up |
| Motion | 3 × 330ms, chained by `transition-delay` (§8) |
| Verification | Tests written; behavioural verification via `.claude/devserver.py` |

## 5. Layout

```
Matchup page
├── gw-nav · matchup cards · team-nav      (existing, untouched)
└── Full Season strip                       (new, full width)
    ├── ribbon   38 columns, horizontal scroller
    ├── rail     chip windows, BELOW the ribbon
    └── key      colour legend
```

Column widths are fixed — **54px** collapsed, **268px** expanded, **22px** for a
played stub, with a 4px gap. `GROW` (§8) is the difference the expansion covers,
214px. Fixed widths rather than flexing to the page: 38 weeks squeezed into one
viewport width made every tile unreadable, and the scroller was never the
problem the float needed solving.

**A collapsed column** carries the gameweek number, three fixture tiles tinted by
one-sidedness, and five dots for the week's top five players. Played weeks shrink
to a 22px dashed stub. A 1px hairline sits between GW19 and GW20, the same
chip-reset marker the Matchup team navigator uses.

**An expanded column** floats as a `position: fixed` panel, pinned by its bottom
edge to its column and growing upward over the matchup cards. Fixed positioning
is load-bearing: the ribbon lives in an `overflow-x: auto` scroller, and per spec
a non-visible overflow on one axis forces the other to `auto` — an in-flow panel
would be clipped or spawn a second scrollbar rather than floating over the page.

## 6. Engine (`engine/season.js`, pure)

### 6.1 Per-gameweek matchups

A fixture carries **two** composite scores, one per side. The matchup's score is
the higher of them, and the side that produced it is the favoured side. The green
ring in the UI therefore falls out of the same calculation rather than needing a
second rule. Top 3 per gameweek, descending.

A team with two fixtures in one gameweek marks those fixtures as a double.

### 6.2 Week strength

A week is **loaded** when at least `SEASON_LOADED_MIN_GREAT` (2) of its top three
matchups land in the `great` band. Threshold lives in `config.js`; the UI renders
it as the column's glow.

### 6.3 Postponement attribution — an inference, and labelled as one

FPL sets `event: null` on a postponed fixture and does **not** retain the
gameweek it was scheduled for. `season.pendingFixtures` holds these with
`gw === null`, and `ARCHITECTURE.md` §9 forbids anything that aggregates over a
gameweek window from reading them. That guard stays.

The gameweek is therefore derived from the hole the postponement left:

1. For each gameweek, collect the clubs with no fixture.
2. A pending fixture whose **both** clubs are blank in that gameweek is a
   candidate for it.
3. Attribute it to the **earliest** matching gameweek — a rearranged date is
   always later than the hole it left.
4. Competing pending fixtures resolve in fixture order.

This is display-only and never feeds a score. The panel's note states that the
attribution is inferred, so a wrong guess is visibly a guess.

Postponed fixtures fill the three matchup slots **from the bottom up**, so slot 1
always holds the week's genuine best fixture no matter how much of the schedule
has fallen over. Two postponements therefore read as "one real fixture left",
which is the signal worth acting on.

### 6.4 Per-gameweek top 5 players

`calcPlayerForm` is gameweek-independent, so it is computed **once per player**
(~700) and reused across all 38 weeks; only the cheap per-gameweek fixture read
repeats. The projection reuses the existing `PROJ_FORM` / `PROJ_FIXTURE` /
`PROJ_COUNTER` / `PROJ_MINUTES` weighting from `composite.js`, evaluated for one
specific gameweek rather than a horizon. A club blank that week is excluded.

Output per gameweek: top 5 by projected points, each with position, price and
that week's projected points.

### 6.5 Chip windows

Each half is searched **independently** — GW1–19 and GW20–38 — which is also why
a band can never straddle the reset.

| Chip | Window | Chosen by |
|---|---|---|
| Wildcard | `WC_WINDOW` gameweeks | best aggregate fixture quality across the top `WC_TOP_TEAMS` clubs |
| Free Hit | 1 gameweek | most blank/postponement damage |
| Triple Captain | 1 gameweek | highest league-wide best-captain projection, double-gameweek weighted |

Squad-agnostic throughout, so the strip works with no squad imported. Bench Boost
is dropped: a bench you do not own carries no information.

## 7. Module (`modules/fullSeason.js`)

Owns the strip's DOM. Subscribes to `data:ready` and `route:changed`, and renders
only while the Matchup view is on screen, per `CONVENTIONS.md` §8.

**Loading.** The ribbon paints immediately from fixtures and composite scores.
The per-gameweek player pass runs chunked in the background across all 38 weeks,
yielding between chunks like `ranker.js` does. A week opened before its pass
completes shows skeleton player rows.

**Risk.** The player pass is the one real performance unknown: ~700 form
computations plus 38 × ~700 cheap per-gameweek reads. If it proves too slow, the
fallback is computing a week's players on demand when it is opened, and deriving
the collapsed dots from a cheaper proxy.

## 8. Motion

Three phases of **330ms**, total **990ms**.

| | Phase 1 | Phase 2 | Phase 3 |
|---|---|---|---|
| Expand | vertical | horizontal | content fades in |
| Collapse | content fades out | horizontal | vertical |

All three are armed in a **single style write** and chained by
`transition-delay`. Awaiting each `transitionend` and then starting the next
costs a frame at every handoff, which measured 999ms instead of 990. Every phase
runs on `cubic-bezier(.32,.72,0,1)`.

Three constraints learned from the prototype, all of which the implementation
must preserve:

- **Never set a transitioned value inside a `setTimeout` that matches its own
  `transition-delay`.** The two compound: the phase starts at 2×delay and is cut
  off when the node is removed. This produced both the "shooting" expand and the
  "delayed then sharp" collapse.
- **Measure the collapsed height before injecting content.** Measuring after
  gives the detail's height at 54px wide — huge and wrapped — and the box snaps
  to it on frame 0.
- **The header is not one element.** The small number belongs to `.summary` and
  the "GW n" title to `.body`, so each fades with its own group. A single
  retitled element stays fully lit while everything around it fades.

**Switching weeks** runs both animations in parallel, each with its own float
element — a shared one cannot collapse the old week and expand the new one at
once. The clicked column is the fixed reference: the scroll resolves to a single
target of `scrollLeft + flowDelta + shift`, where `flowDelta` is `−GROW` if the
collapsing week sits earlier in the ribbon and drags everything after it.

**Directional expansion.** The column always grows rightward in flow; the track
scrolls underneath it during phase 2, and how far decides the direction the
growth appears to take: `0` reads as rightward, `GROW/2` as parting centrally
(the default), `GROW` as expanding leftward (forced near the right-hand edge).
The scripted scroll evaluates the same bezier in JS, or it visibly drifts against
the CSS width transition beside it.

## 9. Visual language

| Signal | Encoding |
|---|---|
| One-sidedness | band tint on the fixture tile |
| Favoured side | green ring around that club's badge |
| Double gameweek | accent outline on the tile |
| Postponed fixture | red outline; `PP` tag; em-dash for the score |
| Loaded week | green glow on the column |
| Standout player | glowing dot / green row |
| Chip window | conjoined colour band under the weeks it covers |
| Chip reset | 1px hairline between GW19 and GW20 |

Conjoined chip bands bridge the flex gap with an **overlay**, never a negative
margin: a negative margin consumes layout width and drifts every later cell
leftward — 32px of accumulated error by GW38 in the prototype.

## 10. Config additions

| Constant | Value | Meaning |
|---|---|---|
| `SEASON_LOADED_MIN_GREAT` | 2 | top-3 matchups in the `great` band before a week glows |
| `SEASON_TOP_MATCHUPS` | 3 | matchup rows per gameweek |
| `SEASON_TOP_PLAYERS` | 5 | player rows per gameweek |
| `SEASON_PHASE_MS` | 330 | one motion phase |

`CHIP_RESET_AFTER_GW` (19) already exists and is reused.

## 11. Open risks

1. **Player-pass cost** (§7). Mitigation stated; measure before optimising.
2. **Postponement attribution** (§6.3) is an inference and can be wrong when a
   club is blank for an unrelated reason. Mitigated by labelling it as inferred,
   and it never feeds a score.
3. **Node is not installed on this machine**, so `tests/engine/season.test.js`
   can be written but not run locally. Behavioural verification is live in the
   browser via `.claude/devserver.py`, as with the rest of this app.
