# Wiki: section entries, glossary popovers, right rail

Date: 2026-08-27
Status: approved, not yet implemented

## Why

The wiki today is one long article per project. `/projects/wiki/gaffer-iq/`
is a single page carrying twelve sections of prose, read by scrolling. The
rail lists projects, not the thing the reader is actually navigating —
sections.

The design sheet supplied as `Website front page (1).zip`
(`ds/pages/wiki.html`) demonstrates three changes to that model. This spec
covers all three, and only the wiki part of the sheet.

1. **Section entries.** Each section becomes an independent article with
   its own URL. The left rail becomes the index of those sections, grouped.
2. **Glossary popovers.** Infobox values become clickable and open a small
   attached card with an expanded definition.
3. **Right rail.** A third column: On this page, Recently read, Entry
   status.

## Non-goals

Explicitly out of scope, though present in the design sheet:

- The masthead (`The Handbook`, entry count).
- The `Search /` command palette. The site already has its own search in
  `_layouts/default.html`, which indexes `<main id="main">` — every section
  page feeds it for free.
- The `Random` button.
- The `Edit E` in-browser edit mode, and therefore the `Locally edited`
  row in Entry status.
- Client-side routing. Sections are real pages.
- Any change to `/projects/apps/`. The apps are standalone documents and
  the wiki's only coupling to them stays the single `app_url` link.

## Model

### Two page kinds

**App** — `_layouts/wiki-app.html`, at `projects/wiki/<app>/index.html`.

Front matter, all of it app-level:

```yaml
layout: wiki-app
slug: gaffer-iq
order: 10                     # sort position across the wiki
title: Gaffer IQ
kind: Application
revised: 2026-08-25
steward: Josh Bailey
description: …                # <meta name="description">
lede: …                       # one italic sentence
summary: …                    # shown on /projects/wiki/
app_url: /projects/apps/gaffer-iq/
status: draft                 # optional
info:                         # infobox rows
  Status: Live · iterating
```

Body is empty. The layout emits a bare redirect document to the app's
first section — `<meta http-equiv="refresh">`, `<link rel="canonical">`
pointing at the target, a `<script>` `location.replace` for speed, and a
visible fallback link for anything that honours none of those. It does
**not** nest inside `_layouts/default.html`; rendering the full site
chrome only to leave immediately is waste, and it would flash.

`_config.yml` sets `layout: default` as a default for everything under
`projects/`. Front matter overrides a default, so `layout: wiki-app`
wins with no config change.

**Section** — `_layouts/wiki-entry.html`, at
`projects/wiki/<app>/<section>/index.html`.

```yaml
layout: wiki-entry
parent: gaffer-iq             # NEW — the app's slug
slug: calculations            # globally unique across the wiki
order: 80                     # sort position within the app
group: Matchups               # rail grouping
title: Calculations
lede: …                       # optional, one italic sentence
```

`kind`, `revised` and `steward` are read from the parent app unless the
section overrides them, so twelve pages do not each restate the same
three values.

### Section slugs are globally unique

`[[slug|label]]` resolves against a flat slug space, so two sections in
different apps may not share a slug. This is a naming rule, not a
mechanism: FC26's sections are named so they do not collide with Gaffer
IQ's.

### Gaffer IQ decomposition

Prose moves verbatim. Nothing is rewritten. Existing
`<h3 class="mono-label">` headings stop being headings and become section
titles.

| order | group | title | slug | from |
| --- | --- | --- | --- | --- |
| 10 | Overview | What is this? | `what-is-this` | `<h2>What is it?</h2>` |
| 20 | Design Philosophy | Approach | `approach` | the intro paragraph under `<h2>Design Philosophy</h2>` |
| 30 | Design Philosophy | The data | `the-data` | `<h3>The data</h3>` |
| 40 | Design Philosophy | The engine | `the-engine` | `<h3>The engine</h3>` |
| 50 | Design Philosophy | The interface | `the-interface` | `<h3>The interface</h3>` |
| 60 | Matchups | The analyser | `the-analyser` | the intro paragraph under `<h2>Matchups</h2>` |
| 70 | Matchups | Scoring philosophy | `scoring-philosophy` | `<h3>Scoring Philosophy</h3>` |
| 80 | Matchups | Calculations | `calculations` | `<h3>Calculations</h3>` |
| 90 | Pages | Fixtures | `fixtures` | `<h2>Fixtures</h2>` |
| 100 | Pages | Ranker | `ranker` | `<h2>Ranker</h2>` |
| 110 | Pages | Dashboard | `dashboard` | `<h2>Dashboard</h2>` |
| 120 | Pages | Planner | `planner` | `<h2>Planner</h2>` |

The two group intros — `approach` and `the-analyser` — exist because
those paragraphs describe their whole group rather than any one
subsection. Folding them into the next section would misattribute them.

Group order in the rail is first-appearance in `order`, so the numbers
are the single control. There is no second list of groups to keep in
sync.

### FC26 Feel Calculator decomposition

Same treatment, so the layout supports one model rather than two. Prose
untouched; it remains flagged `status: draft`.

| order | group | title | slug |
| --- | --- | --- | --- |
| 10 | Overview | The problem | `the-problem` |
| 20 | Overview | What it models | `what-it-models` |
| 30 | Build | One file, no build | `one-file-no-build` |
| 40 | Build | Two layouts | `two-layouts` |
| 50 | Notes | What it taught me | `what-it-taught-me` |
| 60 | Notes | Still to write | `still-to-write` |

`<h2>How it is built</h2>` has no prose of its own — only its two h3s —
so it contributes a group and no intro entry.

### /projects/wiki/ index

Switches its filter from `p.layout == 'wiki-entry'` to
`p.layout == 'wiki-app'`. Every field it reads (`kind`, `group`,
`revised`, `status`, `title`, `url`, `lede`, `summary`, `steward`) exists
on the app page, so the markup is otherwise unchanged. `e.url` now points
at a redirect, which lands the reader on the first section.

`group` on an app page keeps its current meaning — the wiki-wide
category shown in the index's meta strip (`Tools`) — and is unrelated to
a section's `group`, which is a rail heading within one app. The two are
never read by the same template.

## Left rail

Scoped to the current app. Order of blocks:

1. **Filter entries.** A text input. On each keystroke, hide rail rows
   whose title or lede does not contain the query, hide a group whose
   rows are all hidden, and update each group's count to the number
   shown. Row numbers do **not** renumber under a filter — `07` stays
   `07` — because the number identifies the section, not its position in
   a filtered list. Empty query restores everything. Filtering is over
   data already in the DOM — no index, no fetch. With JS off the input
   is not rendered at all: `wiki.js` injects it, so there is no dead
   control.
2. **One block per group.** Uppercase group name on the left, count on
   the right, hairline under, then the numbered rows. Numbering is
   continuous across groups — `01` … `12` — matching the design sheet.
3. Current section carries `aria-current="page"` and the accent colour.

The `On this page` block moves out of this rail. See below.

## Article

- **Crumb** gains a level: `Projects / Wiki / Gaffer IQ / Calculations`.
  The app name links to the app's first section.
- **Meta strip** counts within the app: `Entry 08 / 12`. `Kind`,
  `Revised`, `Steward` fall back to the parent app. `Words` stays
  per-section.
- **Infobox** and the `Launch app` button render on the app's first
  section only, from the app's front matter. Repeating a seventeen-row
  infobox on twelve pages would bury the prose.
- **Draft banner** renders on every section of a draft app.
- **Footnotes** stay per-section, numbered from 1 within each. This is
  what `_includes/wiki-body.html` already does; splitting the pages just
  makes the numbering shorter.
- **Backlinks** resolve against section slugs. An `[[<app-slug>|…]]`
  link keeps working and resolves to that app's first section, so the
  existing `[[gaffer-iq|Gaffer IQ]]` in FC26's prose needs no edit.
- **Pager** walks sections in `order` within the app, across group
  boundaries. At the first section it walks back to the previous app's
  last section; at the last, forward to the next app's first. The wiki
  therefore remains a single readable sequence end to end.

## Glossary popovers

### Data

`_data/glossary.yml`, keyed by the exact infobox value, lowercased:

```yaml
"5 weighted sub-metrics":
  kind: Model
  text: >
    Base difficulty, counter-matchup, team form, head-to-head and
    home/away, combined into one CompositeScore.
  ref: calculations        # optional — a section slug
```

`kind` is the small accent label at the top of the card. `text` is the
definition. `ref`, when present and resolvable, renders a
`Full entry: <title> →` link at the foot of the card.

### Build

`_includes/wiki-infobox.html` renders the infobox. For each `dd` it
splits the value on `·`, trims each part, and looks the lowercased part
up in the glossary. A hit renders

```html
<button type="button" class="wk-term" data-term="<key>" aria-expanded="false">Live</button>
```

A miss renders the text unchanged. A value with no `·` is looked up
whole first, so multi-word values like `5 weighted sub-metrics` match.
Under the `<dl>`, a `Click an underlined value` hint renders only when
the box produced at least one term.

Doing the matching at build time keeps the glossary out of the
JavaScript payload and means the definitions are in the HTML source.

### Runtime

`wiki.js` gains a popover, following the pattern the hover peek already
uses:

- One `.wk-pop` element appended to `<body>`, so its absolute
  coordinates are page coordinates.
- Content comes from `data-*` attributes the build wrote onto the
  button. No second copy of the glossary in JS.
- Positioned below the button, flipped above when it will not fit,
  clamped to the viewport's right edge and to a minimum top.
- Opens on click. Closes on outside click, on `Escape`, on resize, and
  on a second click of the same term. `aria-expanded` tracks state.
- Focus stays on the button. The card is `role="dialog"` with an
  `aria-label`, and its close control is a real button.

With JS off the values render as plain text in a `<button>` that does
nothing. The infobox still reads correctly.

## Right rail

A third grid column. Three blocks, top to bottom:

- **On this page** — the existing TOC and scrollspy, moved here from the
  left rail. Most sections will now have no `h2`s at all, so the block
  keeps its current `.is-built` guard and stays hidden rather than
  render an empty ruled-off label. Built from `h2, h3` as today.
- **Recently read** — the last five sections visited, newest first,
  from `localStorage`. Written on load, read on load. Every access is
  wrapped in `try`/`catch`, and the block stays hidden until it has at
  least one row, so a private window or a first visit shows nothing
  rather than an empty list. Titles are stored alongside slugs so a
  visited page's title survives without a manifest.
- **Entry status** — `Words`, `Notes`, `Inbound links`, `Revised`. All
  four are computed by Liquid at build time, so the block is complete
  with JS off. `Locally edited` from the design sheet is dropped: it
  reports on an edit mode this site does not have.

### Layout

`--wk-rail-w` (14rem) / `minmax(0, 1fr)` / `--wk-rail-r-w` (14rem).

- Above 74rem: three columns, both rails sticky.
- 56rem–74rem: two columns. The right rail leaves the grid and renders
  as a horizontal row of its three blocks above the article.
- Below 56rem: everything stacks, as the left rail already does at this
  breakpoint today.

74rem is a new breakpoint and `--wk-rail-r-w` a new custom property.
Both are structural measures with no site-wide counterpart, matching the
three `--wk-*` properties `wiki.css` already declares and documents.

## Files

| File | Change |
| --- | --- |
| `_layouts/wiki-app.html` | new — redirect document |
| `_layouts/wiki-entry.html` | rewrite — parent lookup, three columns, new crumb/meta/pager |
| `_includes/wiki-rail.html` | new — left rail |
| `_includes/wiki-infobox.html` | new — infobox + glossary matching |
| `_includes/wiki-body.html` | link resolution over sections, with app-slug fallback |
| `_data/glossary.yml` | new |
| `assets/css/wiki.css` | three-column layout, right rail, filter, term, popover |
| `assets/js/wiki.js` | TOC moves right, filter, recently read, popover |
| `projects/wiki/index.html` | list apps instead of entries |
| `projects/wiki/gaffer-iq/` | index becomes app page; 12 section folders |
| `projects/wiki/fc26-calculator/` | index becomes app page; 6 section folders |

## Constraints carried forward

These are the existing rules of the files being edited, and they hold:

- `wiki.css` writes no literal colour, size, spacing step, radius, rule,
  duration or easing. Every value resolves to a token in
  `variables.css`. The two new `--wk-*` properties above are the
  exception the file already documents.
- Typography that exists as a utility is applied in the markup
  (`.mono`, `.mono-label`, `.section-title`, `.work-lede`), not restated
  in CSS.
- `wiki.js` is progressive enhancement only. Prose, links, footnotes,
  backlinks, pager, infobox and Entry status are all compiled at build
  time. With JS off the wiki reads and navigates correctly; what is lost
  is the TOC, the filter, Recently read, the hover peek and the
  popovers — every one of them an enhancement over content that is
  already on the page.
- There is no second manifest. The rail, numbering, backlinks and pager
  are all derived from the section pages themselves.

## Verification

1. `bundle exec jekyll build` completes with no Liquid warnings.
2. Every section URL resolves; `/projects/wiki/gaffer-iq/` redirects to
   `/projects/wiki/gaffer-iq/what-is-this/`.
3. `/projects/wiki/` lists two rows, not eighteen.
4. Rail: correct groups, continuous numbering, current row marked.
5. Filter narrows rows and group counts; empty query restores.
6. Popover opens on click, positions under the term, flips near the
   viewport foot, closes on outside click and `Escape`.
7. TOC hides on sections with no headings; tracks on sections with them.
8. Recently read accumulates across visits and survives a reload.
9. Entry status numbers are correct against the prose.
10. Pager walks 01 → 12 and on into the next app.
11. Backlinks still resolve; `[[gaffer-iq|Gaffer IQ]]` from FC26 lands
    on Gaffer IQ's first section.
12. With JavaScript disabled the page reads, navigates, and shows the
    infobox and Entry status.
13. Three-column, two-column and stacked layouts each hold.
