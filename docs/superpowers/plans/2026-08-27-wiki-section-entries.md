# Wiki Section Entries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split each wiki write-up into independently-addressable section pages behind a grouped left rail, add click-to-open glossary popovers on infobox values, and add a right rail carrying On this page / Recently read / Entry status.

**Architecture:** Two Jekyll page kinds. An *app* page (`layout: wiki-app`) holds app-level front matter and renders a bare redirect to its first section. A *section* page (`layout: wiki-entry`) declares `parent: <app-slug>`, `group` and `order`, and holds one section of prose. Every derived thing — rail, numbering, pager, backlinks, Entry status — is read from those pages at build time. There is no manifest. `wiki.js` stays progressive enhancement: it adds the TOC, the rail filter, Recently read, the hover peek and the glossary popovers, all on top of content already in the HTML.

**Tech Stack:** Jekyll 3.10 (Liquid 4), vanilla CSS with tokens from `assets/css/variables.css`, vanilla ES5-style JS in one IIFE. No build step beyond Jekyll, no dependencies.

**Spec:** [`docs/superpowers/specs/2026-08-27-wiki-section-entries-design.md`](../specs/2026-08-27-wiki-section-entries-design.md)

## Global Constraints

- **No literal design values in CSS.** No colour, type size, spacing step, radius, rule, duration or easing is written literally in `assets/css/wiki.css`. Every value resolves to a token in `assets/css/variables.css`. The only exceptions are the `--wk-*` structural measures the file declares at the top and documents.
- **Typography comes from markup utilities**, not restated CSS: `.mono`, `.mono-label`, `.section-title`, `.work-lede`.
- **`wiki.js` is progressive enhancement only.** Prose, internal links, footnotes, backlinks, pager, infobox and Entry status are all compiled at build time. With JavaScript off the wiki must read and navigate correctly.
- **No second manifest.** Rail, numbering, backlinks and pager are derived from the section pages themselves.
- **Prose moves verbatim.** No task in this plan rewrites a sentence of either write-up. Content moves between files unchanged.
- **Section slugs are globally unique** across the whole wiki, because `[[slug|label]]` resolves against a flat slug space.
- **New breakpoint:** 74rem, for dropping the right rail out of the grid. Existing site breakpoints 56rem and 40rem are reused unchanged.
- **New custom property:** `--wk-rail-r-w: 14rem`. It joins the three `--wk-*` properties `wiki.css` already declares.
- Every commit message ends with:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

## How verification works in this repo

There is no test runner — this is a static Jekyll site. The equivalent of
a unit test here is: build the site, then assert on the generated HTML in
`_site/`. Every task below follows red-green with real commands:

```bash
bundle exec jekyll build
```

`_site/` is gitignored, so nothing from a build is ever committed.

A `grep -c` that prints `0`, or a `test -f` that fails, is the red state.
The same command printing the expected count is green.

## File structure

| File | Responsibility |
| --- | --- |
| `_layouts/wiki-app.html` | **new** — app page: front matter only, renders a redirect to the first section |
| `_layouts/wiki-entry.html` | rewrite — one section page: parent lookup, three-column shell, crumb, meta, notes, backlinks, pager |
| `_includes/wiki-rail.html` | **new** — the left rail: grouped, numbered section index for one app |
| `_includes/wiki-infobox.html` | **new** — the infobox, with glossary matching on each value |
| `_includes/wiki-term.html` | **new** — one clickable glossary value, so the whole-value and split-part branches cannot drift |
| `_includes/wiki-status.html` | **new** — the right rail's Entry status block |
| `_includes/wiki-body.html` | modify — link resolution gains an app-slug fallback |
| `_data/glossary.yml` | **new** — term → kind / text / ref |
| `assets/css/wiki.css` | modify — three columns, right rail, filter, term, popover |
| `assets/js/wiki.js` | modify — filter, Recently read, popover; TOC unchanged but now mounted right |
| `projects/wiki/index.html` | modify — list apps, not sections |
| `projects/wiki/gaffer-iq/` | index becomes an app page; 12 section folders added |
| `projects/wiki/fc26-calculator/` | index becomes an app page; 6 section folders added |

---

### Task 1: Gaffer IQ section pages + the `wiki-app` redirect layout

Splits the twelve sections out of the long article and turns the app's own
`index.html` into a redirect. The existing `_layouts/wiki-entry.html` is
untouched in this task — the section pages render through it as-is, with a
flat rail and a two-level crumb. That transitional state builds and reads
correctly, which is what makes this task independently committable.

**Files:**
- Create: `_layouts/wiki-app.html`
- Create: `projects/wiki/gaffer-iq/{what-is-this,approach,the-data,the-engine,the-interface,the-analyser,scoring-philosophy,calculations,fixtures,ranker,dashboard,planner}/index.html`
- Modify: `projects/wiki/gaffer-iq/index.html` (becomes the app page)

**Interfaces:**
- Consumes: nothing.
- Produces: the front matter contract every later task reads —
  app pages carry `layout: wiki-app`, `slug`, `order`, `title`, `kind`,
  `revised`, `steward`, `lede`, `summary`, `description`, `app_url`,
  `info`, optional `status`, and `group` (the wiki-wide category, e.g.
  `Tools`).
  Section pages carry `layout: wiki-entry`, `parent` (the app's slug),
  `slug`, `order`, `group` (a rail heading), `title`, and optional `lede`.
  Sections deliberately omit `kind` / `revised` / `steward`; Task 5 makes
  the layout inherit those from the parent.

- [ ] **Step 1: Record the source line ranges**

Prose moves verbatim out of `projects/wiki/gaffer-iq/index.html` (324
lines). These are the exact ranges, each one the body of a heading with
the heading line itself excluded:

| slug | lines | was |
| --- | --- | --- |
| `what-is-this` | 43–60 | `<h2>What is it?</h2>` |
| `approach` | 63–72 | intro under `<h2>Design Philosophy</h2>` |
| `the-data` | 75–97 | `<h3>The data</h3>` |
| `the-engine` | 100–118 | `<h3>The engine</h3>` |
| `the-interface` | 121–136 | `<h3>The interface</h3>` |
| `the-analyser` | 139–144 | intro under `<h2>Matchups</h2>` |
| `scoring-philosophy` | 147–174 | `<h3>Scoring Philosophy</h3>` |
| `calculations` | 177–265 | `<h3>Calculations</h3>` |
| `fixtures` | 268–283 | `<h2>Fixtures</h2>` |
| `ranker` | 286–298 | `<h2>Ranker</h2>` |
| `dashboard` | 301–310 | `<h2>Dashboard</h2>` |
| `planner` | 313–324 | `<h2>Planner</h2>` |

Take a word count of the whole body now, to prove at Step 7 that no prose
was lost:

```bash
cd "$(git rev-parse --show-toplevel)"
sed -n '39,324p' projects/wiki/gaffer-iq/index.html | wc -w
```

Write the number down. Call it `BEFORE`.

- [ ] **Step 2: Write the failing assertion**

```bash
test -f _site/projects/wiki/gaffer-iq/calculations/index.html && echo PASS || echo FAIL
```

- [ ] **Step 3: Run it to verify it fails**

Run:

```bash
bundle exec jekyll build && test -f _site/projects/wiki/gaffer-iq/calculations/index.html && echo PASS || echo FAIL
```

Expected: `FAIL` — the folder does not exist yet.

- [ ] **Step 4: Create `_layouts/wiki-app.html`**

Empty front matter, so this layout does **not** nest inside
`_layouts/default.html`. Rendering the whole site chrome only to leave it
again would flash the header and footer on the way past.

```html
---
---
{%- comment -%}
=============================================================================
  wiki-app.html — the app page at /projects/wiki/<app>/.

  An app page holds no prose. It carries the app-level front matter that
  /projects/wiki/ lists and that every one of its section pages inherits
  from, and it sends the reader straight on to the app's first section.

  Front matter an app page declares:
      layout:   wiki-app            (required)
      slug:     gaffer-iq           (must match the folder name)
      order:    10                  (sort position across the wiki)
      group:    Tools               (the wiki-wide category, shown on
                                     /projects/wiki/ — NOT a rail heading;
                                     a section's `group` is that, and the
                                     two are never read by one template)
      title:    Gaffer IQ
      kind:     Application
      revised:  2026-08-25
      steward:  Josh Bailey
      lede:     one italic sentence
      summary:  the paragraph /projects/wiki/ shows
      status:   draft               (optional)
      app_url:  /projects/apps/gaffer-iq/    (optional)
      info:     mapping of key/value rows for the infobox (optional)

  Deliberately NOT nested in default.html. Three redirect mechanisms are
  emitted because they fail in different situations: the refresh meta for
  no-JS, location.replace so the history entry is not poisoned when JS is
  on, and a real link for anything that honours neither.
=============================================================================
{%- endcomment -%}
{%- assign wk_sections = site.pages | where_exp: "p", "p.layout == 'wiki-entry'" | where: "parent", page.slug | sort: "order" -%}
{%- assign wk_first = wk_sections | first -%}
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{ page.title }} — Wiki — Josh Bailey</title>
{%- if page.description %}
<meta name="description" content="{{ page.description | escape }}">
{%- endif %}
{%- if wk_first %}
<link rel="canonical" href="{{ wk_first.url | absolute_url }}">
<meta http-equiv="refresh" content="0; url={{ wk_first.url }}">
<meta name="robots" content="noindex, follow">
<script>location.replace({{ wk_first.url | jsonify }});</script>
{%- endif %}
</head>
<body>
{%- if wk_first %}
<p>Redirecting to <a href="{{ wk_first.url }}">{{ wk_first.title }}</a>.</p>
{%- else %}
<p>{{ page.title }} has no sections yet.</p>
{%- endif %}
</body>
</html>
```

- [ ] **Step 5: Turn the app's `index.html` into the app page**

Replace the whole of `projects/wiki/gaffer-iq/index.html` with front
matter only. Every value below is copied verbatim from what the file
already declares — nothing is invented:

```html
---
layout: wiki-app
slug: gaffer-iq
order: 10
group: Tools
title: Gaffer IQ
kind: Application
revised: 2026-08-25
steward: Josh Bailey
app_url: /projects/apps/gaffer-iq/
description: Gaffer IQ — a Fantasy Premier League tool that replaces the official 1–5 fixture difficulty rating with a five-signal composite model, scored zero-sum so a fixture's two ratings always sum to 100.
lede: A Fantasy Premier League tool that stops treating fixture difficulty as a property of a team, and starts treating it as a property of a pairing.
summary: Five views over one scoring engine — Matchups, Fixtures, Ranker, Dashboard and Planner — replacing FPL's 1–5 difficulty rating with a weighted composite of five sub-metrics, scored relative to the opponent so both sides of a fixture sum to 100.
info:
  Status: Live · iterating
  Stack: HTML · JS · vanilla CSS
  Build step: None
  Backend: One Vercel function
  Data: FPL API · Understat
  Views: Matchups · Fixtures · Ranker · Dashboard · Planner
  Model: 5 weighted sub-metrics
  First shipped: 2026
---
```

Note what is gone: the `<h2>`/`<h3>` headings and the authoring comment.
The comment's content is now carried by `_layouts/wiki-app.html` and
`_layouts/wiki-entry.html`, which is where a person editing these pages
will actually look.

- [ ] **Step 6: Create the twelve section pages**

Do this from a copy of the original file so the line ranges in Step 1
still hold after Step 5 rewrote `index.html`:

```bash
cd "$(git rev-parse --show-toplevel)"
git show HEAD:projects/wiki/gaffer-iq/index.html > /tmp/gaffer-src.html
```

Each page is front matter plus the extracted lines. Create the folder,
write the front matter, then append the prose. For `calculations`:

```bash
mkdir -p projects/wiki/gaffer-iq/calculations
cat > projects/wiki/gaffer-iq/calculations/index.html <<'EOF'
---
layout: wiki-entry
parent: gaffer-iq
slug: calculations
order: 80
group: Matchups
title: Calculations
lede: Five weighted sub-metrics, each with its own maturity curve, combined into one CompositeScore and mapped to five colour bands.
---
EOF
sed -n '177,265p' /tmp/gaffer-src.html >> projects/wiki/gaffer-iq/calculations/index.html
```

Repeat for all twelve, with this front matter. `lede` is a new one-line
summary per section; it is the only new prose in this task and it exists
because the rail filter and the hover peek both read it.

| folder | order | group | title | lede | lines |
| --- | --- | --- | --- | --- | --- |
| `what-is-this` | 10 | Overview | What is this? | Why a personal FPL tool exists at all, and what is wrong with a difficulty rating that belongs to a team rather than to a fixture. | 43–60 |
| `approach` | 20 | Design Philosophy | Approach | Pull as much data as possible, process it into a new perspective, and keep the platform modular enough that the data can be parsed globally. | 63–72 |
| `the-data` | 30 | Design Philosophy | The data | Two sources, one serverless function, and everything else running in the browser — plus a frank list of what the FPL API does not give you. | 75–97 |
| `the-engine` | 40 | Design Philosophy | The engine | All the number-crunching in one place, the settings that control it in another, and a confidence level attached to every output. | 100–118 |
| `the-interface` | 50 | Design Philosophy | The interface | Splitting dense data so it does not overwhelm, and offering more than one route to the same information. | 121–136 |
| `the-analyser` | 60 | Matchups | The analyser | The deep dive on a single fixture, and the "view source" for any score anywhere else in the app. | 139–144 |
| `scoring-philosophy` | 70 | Matchups | Scoring philosophy | Not "is this fixture hard" but "is this fixture hard for this player, doing this job, right now" — and how much to believe the answer. | 147–174 |
| `calculations` | 80 | Matchups | Calculations | Five weighted sub-metrics, each with its own maturity curve, combined into one CompositeScore and mapped to five colour bands. | 177–265 |
| `fixtures` | 90 | Pages | Fixtures | The schedule-level companion to Matchups, and the one view that carries no scoring of its own. | 268–283 |
| `ranker` | 100 | Pages | Ranker | The bridge between team-level fixture scores and player-level decisions. | 286–298 |
| `dashboard` | 110 | Pages | Dashboard | This week only — captaincy, bench order and risk flags, deliberately locked to a single-gameweek horizon. | 301–310 |
| `planner` | 120 | Pages | Planner | The most horizon-aware view: every candidate transfer evaluated for its change in projected score, with the four-point hit modelled rather than ignored. | 313–324 |

- [ ] **Step 7: Run the assertion and the no-prose-lost check**

```bash
bundle exec jekyll build
test -f _site/projects/wiki/gaffer-iq/calculations/index.html && echo PASS || echo FAIL
ls _site/projects/wiki/gaffer-iq/ | wc -l
cat projects/wiki/gaffer-iq/*/index.html | sed '/^---$/,/^---$/d' | wc -w
```

Expected: `PASS`; `13` (twelve section folders plus `index.html`); and a
word count within a few words of `BEFORE` from Step 1 — the only
difference should be the ledes you just wrote.

If the word count is materially lower, a line range was clipped. Diff the
concatenated sections against `/tmp/gaffer-src.html` before continuing.

- [ ] **Step 8: Check the redirect and one section's prose**

```bash
grep -c 'gaffer-iq/what-is-this' _site/projects/wiki/gaffer-iq/index.html
grep -c 'CompositeScore' _site/projects/wiki/gaffer-iq/calculations/index.html
grep -c '<h2' _site/projects/wiki/gaffer-iq/calculations/index.html
```

Expected: `3` or more for the first (canonical, refresh, link); `1` or
more for the second; and for the third, whatever the site chrome
contributes — the point is that the *body* no longer opens with an `<h2>`,
because the heading became the page title.

- [ ] **Step 9: Commit**

```bash
git add _layouts/wiki-app.html projects/wiki/gaffer-iq/
git commit -m "$(cat <<'EOF'
feat(wiki): split Gaffer IQ into twelve section pages

Each section of the write-up becomes its own page with its own URL, so
the reader navigates sections rather than scrolling one long article.
The prose moves verbatim; the h2 and h3 headings it used to carry become
page titles, and each section gains a one-line lede for the rail filter
and the hover preview.

The app's own index.html keeps the app-level front matter that
/projects/wiki/ reads and becomes a redirect to the first section, via a
new wiki-app layout that deliberately does not nest in default.html —
rendering the site chrome only to leave it again would flash.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: FC26 Feel Calculator section pages

Same treatment, so the layout supports one page model rather than two.
The write-up stays flagged `status: draft`.

**Files:**
- Create: `projects/wiki/fc26-calculator/{the-problem,what-it-models,one-file-no-build,two-layouts,what-it-taught-me,still-to-write}/index.html`
- Modify: `projects/wiki/fc26-calculator/index.html`

**Interfaces:**
- Consumes: `_layouts/wiki-app.html` from Task 1.
- Produces: a second app, which is what lets Task 5's pager walk from the
  end of one app into the start of the next.

- [ ] **Step 1: Record the source line ranges**

From `projects/wiki/fc26-calculator/index.html` (95 lines):

| slug | lines | was |
| --- | --- | --- |
| `the-problem` | 39–46 | the two opening paragraphs |
| `what-it-models` | 50–60 | `<h2>What it models</h2>` |
| `one-file-no-build` | 66–69 | `<h3>One file, no build</h3>` |
| `two-layouts` | 73–78 | `<h3>Two layouts</h3>` |
| `what-it-taught-me` | 82–89 | `<h2>What it taught me</h2>` |
| `still-to-write` | 93–95 | `<h2>Still to write</h2>` |

`<h2>How it is built</h2>` at line 62 has no prose of its own — only its
two h3s — so it contributes the group heading `Build` and no intro entry.

```bash
cd "$(git rev-parse --show-toplevel)"
sed -n '39,95p' projects/wiki/fc26-calculator/index.html | wc -w
```

Write the number down as `BEFORE`.

- [ ] **Step 2: Write the failing assertion**

```bash
bundle exec jekyll build && test -f _site/projects/wiki/fc26-calculator/two-layouts/index.html && echo PASS || echo FAIL
```

Expected: `FAIL`.

- [ ] **Step 3: Turn the app's `index.html` into the app page**

Replace the whole file with front matter only:

```html
---
layout: wiki-app
slug: fc26-calculator
order: 20
group: Tools
title: FC26 Feel Calculator
kind: Application
revised: 2026-08-25
steward: Josh Bailey
status: draft
app_url: /projects/apps/fc26-calculator/
description: FC26 Feel Calculator — models what a player actually feels like on the pitch in EA FC 26, past the raw card numbers into chemistry, PlayStyles and the game's hidden curves.
lede: The card says 87 pace. The player does not feel like 87 pace. This works out the difference.
summary: About 2,500 lines of HTML and vanilla JS in a single file with no build step, rebuilt in Tailwind once the formulas stopped moving, with separate layouts for a focused mobile read and a comparison-heavy desktop one.
info:
  Status: Live · iterating
  Stack: HTML · JS · Tailwind
  Build step: None
  Size: ~2,500 lines · one file
  Layouts: Mobile read · desktop compare
  First shipped: 2026
---
```

- [ ] **Step 4: Create the six section pages**

```bash
cd "$(git rev-parse --show-toplevel)"
git show HEAD:projects/wiki/fc26-calculator/index.html > /tmp/fc26-src.html
```

Then, for each row below: `mkdir -p`, write the front matter with a
heredoc, and append the lines with `sed -n '<range>p' /tmp/fc26-src.html
>> <file>` — exactly the pattern Task 1 Step 6 shows.

| folder | order | group | title | lede | lines |
| --- | --- | --- | --- | --- | --- |
| `the-problem` | 10 | Overview | The problem | An EA FC card is a list of two-digit numbers. What a player feels like under your thumb is something else. | 39–46 |
| `what-it-models` | 20 | Overview | What it models | Chemistry as actually applied, PlayStyles including the plus tiers, and the diminishing-returns curves the game runs underneath. | 50–60 |
| `one-file-no-build` | 30 | Build | One file, no build | Around 2,500 lines in a single document, so the thing that ships is the thing I edited. | 66–69 |
| `two-layouts` | 40 | Build | Two layouts | A focused single-player read on mobile, a comparison view on desktop, and the styling deliberately done last. | 73–78 |
| `what-it-taught-me` | 50 | Notes | What it taught me | More about state management in plain JavaScript than any framework tutorial has. | 82–89 |
| `still-to-write` | 60 | Notes | Still to write | The formula-tuning log — what the first version got wrong, and where the model is still knowingly approximate. | 93–95 |

Note that `what-it-taught-me` contains `[[gaffer-iq|Gaffer IQ]]`. Leave it
exactly as it is. Task 4 is what makes it resolve to Gaffer IQ's first
section; until then it will render as a broken link, which is expected and
is the red state Task 4 starts from.

- [ ] **Step 5: Run the assertion**

```bash
bundle exec jekyll build
test -f _site/projects/wiki/fc26-calculator/two-layouts/index.html && echo PASS || echo FAIL
ls _site/projects/wiki/fc26-calculator/ | wc -l
cat projects/wiki/fc26-calculator/*/index.html | sed '/^---$/,/^---$/d' | wc -w
```

Expected: `PASS`; `7`; word count within a few words of `BEFORE` plus the
six ledes.

- [ ] **Step 6: Confirm the draft flag still reaches the sections**

```bash
grep -c 'wk-draft' _site/projects/wiki/fc26-calculator/two-layouts/index.html
```

Expected: `0` at this point. The current `_layouts/wiki-entry.html` reads
`page.status`, which now lives on the app. Task 5 restores this by reading
it from the parent. Note the `0` and move on — do not patch the old layout
here.

- [ ] **Step 7: Commit**

```bash
git add projects/wiki/fc26-calculator/
git commit -m "$(cat <<'EOF'
feat(wiki): split FC26 Feel Calculator into six section pages

Same shape as Gaffer IQ, so the layout has one page model to support
rather than two. Prose moves verbatim and the write-up stays flagged as
draft. "How it is built" carries no prose of its own, so it contributes
a group heading and no intro entry.

The draft banner stops rendering until the entry layout learns to read
status from the parent app; that lands with the layout rewrite.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `/projects/wiki/` lists apps

**Files:**
- Modify: `projects/wiki/index.html:26` (the `wk_entries` assign) and the
  `{{ forloop.index }} / {{ wk_entries.size }}` cell

**Interfaces:**
- Consumes: the `wiki-app` front matter contract from Task 1.
- Produces: nothing later tasks read.

- [ ] **Step 1: Write the failing assertion**

The index should list two rows, not eighteen:

```bash
bundle exec jekyll build && grep -c 'work-item--featured' _site/projects/wiki/index.html
```

- [ ] **Step 2: Run it to verify it fails**

Expected: `18` — the page is still filtering on `layout == 'wiki-entry'`
and has picked up all eighteen section pages.

- [ ] **Step 3: Change the filter**

In `projects/wiki/index.html`, replace this line:

```liquid
{%- assign wk_entries = site.pages | where_exp: "p", "p.layout == 'wiki-entry'" | sort: "order" -%}
```

with:

```liquid
{%- assign wk_entries = site.pages | where_exp: "p", "p.layout == 'wiki-app'" | sort: "order" -%}
```

Every field the loop reads — `kind`, `group`, `revised`, `status`,
`title`, `url`, `lede`, `summary`, `steward` — exists on an app page, so
nothing else in the markup changes.

- [ ] **Step 4: Update the page's own comment**

The comment block at the top says the list is built from "every page whose
layout is `wiki-entry`". Replace that paragraph with:

```html
     The list is generated from the app pages themselves — every page
     whose layout is `wiki-app` — sorted by their `order` front matter.
     There is no separate manifest to keep in sync; adding an app folder
     under /projects/wiki/ adds a row here. The sections inside an app
     are not listed: they are the app's own rail, not wiki-wide entries.
```

- [ ] **Step 5: Run the assertion**

```bash
bundle exec jekyll build
grep -c 'work-item--featured' _site/projects/wiki/index.html
grep -o 'Gaffer IQ\|FC26 Feel Calculator' _site/projects/wiki/index.html | sort -u
```

Expected: `2`; and both titles present.

- [ ] **Step 6: Commit**

```bash
git add projects/wiki/index.html
git commit -m "$(cat <<'EOF'
fix(wiki): list apps on the index, not every section

The index filtered on layout == 'wiki-entry', which after the split
means eighteen rows where there are two write-ups. It now filters on
wiki-app. Every field the loop reads already exists on an app page, so
only the filter and the comment above it change.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `[[app-slug|label]]` resolves to the app's first section

**Files:**
- Modify: `_includes/wiki-body.html` (pass 1, the link loop)

**Interfaces:**
- Consumes: both page kinds.
- Produces: `a.wl` links carrying `data-peek-kind` / `data-peek-title` /
  `data-peek-lede`, which `wiki.js` reads for the hover preview. Unchanged
  contract — this task only widens what can be linked to.

- [ ] **Step 1: Write the failing assertion**

FC26's `what-it-taught-me` contains `[[gaffer-iq|Gaffer IQ]]`:

```bash
bundle exec jekyll build && grep -c 'gaffer-iq/what-is-this/">Gaffer IQ' _site/projects/wiki/fc26-calculator/what-it-taught-me/index.html
```

- [ ] **Step 2: Run it to verify it fails**

Expected: `0`. `gaffer-iq` is no longer a `wiki-entry` slug, so pass 1
never matches it and the `]]` still closes — leaving a visibly broken
`</a>` in the prose. That loud failure is the behaviour
`_includes/wiki-body.html` documents and wants.

- [ ] **Step 3: Add the app-slug fallback**

In `_includes/wiki-body.html`, replace the pass-1 block:

```liquid
{%- comment -%} ---- pass 1: internal links ---- {%- endcomment -%}
{%- for e in wk_entries -%}
  {%- capture wk_needle -%}[[{{ e.slug }}|{%- endcapture -%}
  {%- capture wk_tag -%}<a class="wl" href="{{ e.url }}" data-peek-kind="{{ e.kind | escape }}" data-peek-title="{{ e.title | escape }}" data-peek-lede="{{ e.lede | escape }}">{%- endcapture -%}
  {%- assign out = out | replace: wk_needle, wk_tag -%}
{%- endfor -%}
```

with:

```liquid
{%- comment -%}
  ---- pass 1: internal links ----
  Sections first, then apps. An app slug resolves to that app's FIRST
  section, so [[gaffer-iq|Gaffer IQ]] keeps working and lands the reader
  on prose rather than on a redirect. Sections are matched first because
  a section slug is the more specific target; the two spaces do not
  overlap, so the order is a statement of intent rather than a
  tie-breaker.
{%- endcomment -%}
{%- for e in wk_entries -%}
  {%- assign wk_pa = wk_apps | where: "slug", e.parent | first -%}
  {%- assign wk_lk_kind = e.kind | default: wk_pa.kind -%}
  {%- capture wk_needle -%}[[{{ e.slug }}|{%- endcapture -%}
  {%- capture wk_tag -%}<a class="wl" href="{{ e.url }}" data-peek-kind="{{ wk_lk_kind | escape }}" data-peek-title="{{ e.title | escape }}" data-peek-lede="{{ e.lede | escape }}">{%- endcapture -%}
  {%- assign out = out | replace: wk_needle, wk_tag -%}
{%- endfor -%}
{%- for a in wk_apps -%}
  {%- assign wk_as = wk_entries | where: "parent", a.slug -%}
  {%- assign wk_af = wk_as | first -%}
  {%- if wk_af -%}
    {%- capture wk_needle -%}[[{{ a.slug }}|{%- endcapture -%}
    {%- capture wk_tag -%}<a class="wl" href="{{ wk_af.url }}" data-peek-kind="{{ a.kind | escape }}" data-peek-title="{{ a.title | escape }}" data-peek-lede="{{ a.lede | escape }}">{%- endcapture -%}
    {%- assign out = out | replace: wk_needle, wk_tag -%}
  {%- endif -%}
{%- endfor -%}
```

- [ ] **Step 4: Add the `wk_apps` assign this needs**

Immediately above the existing `wk_entries` assign near the foot of the
comment block, so both lists are in scope for pass 1:

```liquid
{%- assign wk_entries = site.pages | where_exp: "p", "p.layout == 'wiki-entry'" | sort: "order" -%}
{%- assign wk_apps = site.pages | where_exp: "p", "p.layout == 'wiki-app'" | sort: "order" -%}
{%- assign out = include.html -%}
```

Note `wk_entries` stays sorted by `order` alone. Across two apps that
interleaves them, which does not matter here: pass 1 only needs the set,
not the sequence. The pager in Task 5 builds its own correctly-grouped
sequence.

- [ ] **Step 5: Update the include's authoring rules**

The comment block lists the rules pass 1 relies on. Add one:

```
    * A slug may name a section OR an app. An app slug resolves to that
      app's first section. Slugs are therefore globally unique across the
      whole wiki, sections and apps together.
```

- [ ] **Step 6: Run the assertion**

```bash
bundle exec jekyll build
grep -c 'gaffer-iq/what-is-this/">Gaffer IQ' _site/projects/wiki/fc26-calculator/what-it-taught-me/index.html
grep -c 'data-peek-title="Gaffer IQ"' _site/projects/wiki/fc26-calculator/what-it-taught-me/index.html
```

Expected: `1` and `1`.

- [ ] **Step 7: Commit**

```bash
git add _includes/wiki-body.html
git commit -m "$(cat <<'EOF'
feat(wiki): resolve an app slug in a wiki link

[[gaffer-iq|Gaffer IQ]] stopped resolving when gaffer-iq became an app
page rather than an entry, and failed the loud way the include intends —
a dangling close tag in the prose. Pass 1 now matches app slugs too,
resolving each to that app's first section so the link lands on prose
rather than on a redirect.

Section kind falls back to the parent app's, since sections no longer
declare one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Rewrite `_layouts/wiki-entry.html`

The structural task. Parent lookup, inherited metadata, three-level
crumb, app-scoped meta strip, cross-app pager, and the three-column shell
the two rails sit in. The rails themselves are empty mounts here; Tasks 6
to 8 fill them.

**Files:**
- Modify: `_layouts/wiki-entry.html` (whole file)

**Interfaces:**
- Consumes: both front matter contracts.
- Produces, for Tasks 6–8 to `{% include %}` against:
  - `wk_app` — the parent app page object
  - `wk_sections` — this app's sections, sorted by `order`
  - `wk_idx` — this section's 0-based index within `wk_sections`
  - `wk_backs_count` — number of sections linking here
  - Mount points: `<div class="wk-rail__block--filter" id="wk-rail-filter">`,
    `<nav class="wk-toc" id="wk-toc">`, `<div id="wk-recent">`

- [ ] **Step 1: Write the failing assertions**

```bash
bundle exec jekyll build
grep -c 'wk-crumb__here' _site/projects/wiki/gaffer-iq/calculations/index.html
grep -o 'Entry</b>[^<]*' _site/projects/wiki/gaffer-iq/calculations/index.html
grep -c 'wk__rail' _site/projects/wiki/gaffer-iq/calculations/index.html
grep -c 'wk-draft' _site/projects/wiki/fc26-calculator/two-layouts/index.html
```

- [ ] **Step 2: Run to verify current state**

Expected: `1` for the crumb (but with only two levels above it — no app
name); `Entry</b>08 / 18` (counting across both apps, wrong); `0` for the
right rail; `0` for the draft flag.

Target after this task: three levels plus the app; `Entry</b>08 / 12`;
`1`; `1`.

- [ ] **Step 3: Replace the whole layout**

```html
---
layout: default
---
{%- comment -%}
=============================================================================
  wiki-entry.html — the shell around one SECTION of a write-up, at
  /projects/wiki/<app>/<section>/.

  Nests inside _layouts/default.html, so the header, nav, search, footer,
  theme toggle, paper grain, type scale and reveal animations all come
  from the main site with nothing restated here.

  Front matter a section page declares:
      layout:   wiki-entry          (required)
      parent:   gaffer-iq           (required — the app's slug)
      slug:     calculations        (globally unique across the wiki)
      order:    80                  (sort position within the app)
      group:    Matchups            (rail heading)
      title:    Calculations
      lede:     one italic sentence (optional)

  kind, revised, steward and status are NOT declared per section. They
  are read from the parent app, so twelve pages do not restate the same
  three values. A section may still override any of them.

  Everything derived below — the rail, numbering, backlinks, pager,
  Entry status — is read from the section pages themselves at build time.
  There is no second manifest.

  Two markup conventions are available in a section's body and are
  compiled at build time: the double-square-bracket internal wiki link
  and the double-parenthesis footnote. Both are documented, with literal
  examples, in _includes/wiki-body.html.
=============================================================================
{%- endcomment -%}

{%- comment -%} ---- this section's app, and its siblings ---- {%- endcomment -%}
{%- assign wk_apps = site.pages | where_exp: "p", "p.layout == 'wiki-app'" | sort: "order" -%}
{%- assign wk_app = wk_apps | where: "slug", page.parent | first -%}
{%- assign wk_sections = site.pages | where_exp: "p", "p.layout == 'wiki-entry'" | where: "parent", page.parent | sort: "order" -%}
{%- assign wk_first = wk_sections | first -%}

{%- comment -%} ---- metadata, inherited from the app unless overridden ---- {%- endcomment -%}
{%- assign wk_kind = page.kind | default: wk_app.kind -%}
{%- assign wk_revised = page.revised | default: wk_app.revised -%}
{%- assign wk_steward = page.steward | default: wk_app.steward -%}
{%- assign wk_status = page.status | default: wk_app.status -%}

{%- comment -%} Position within the app, for the meta strip. {%- endcomment -%}
{%- assign wk_idx = 0 -%}
{%- for s in wk_sections -%}
  {%- if s.url == page.url -%}{%- assign wk_idx = forloop.index0 -%}{%- endif -%}
{%- endfor -%}

{%- comment -%}
  Every section in the wiki, in reading order: app by app, and within an
  app by `order`. Sorting the flat list by `order` alone would interleave
  two apps, which is why this is built app-first. The pager walks it, so
  the last section of one write-up leads into the first of the next.
{%- endcomment -%}
{%- assign wk_all = "" | split: "" -%}
{%- for a in wk_apps -%}
  {%- assign wk_as = site.pages | where_exp: "p", "p.layout == 'wiki-entry'" | where: "parent", a.slug | sort: "order" -%}
  {%- assign wk_all = wk_all | concat: wk_as -%}
{%- endfor -%}
{%- assign wk_g = 0 -%}
{%- for s in wk_all -%}
  {%- if s.url == page.url -%}{%- assign wk_g = forloop.index0 -%}{%- endif -%}
{%- endfor -%}
{%- assign wk_pi = wk_g | minus: 1 -%}
{%- assign wk_ni = wk_g | plus: 1 -%}

{%- comment -%}
  Backlinks, derived from the [[slug|…]] convention itself rather than
  from a declared list, so the two can never drift apart.
{%- endcomment -%}
{%- comment -%}
  Built with `capture` and a counter rather than by accumulating an
  array: Liquid has no `push`, and `concat` needs an array on both
  sides, so collecting page objects would mean building a
  single-element array per hit. The markup and the count come out of
  one pass instead.
{%- endcomment -%}
{%- capture wk_needle -%}[[{{ page.slug }}|{%- endcapture -%}
{%- assign wk_backs_count = 0 -%}
{%- capture wk_backs_html -%}
  {%- for s in wk_all -%}
    {%- if s.url != page.url and s.content contains wk_needle -%}
      {%- assign wk_backs_count = wk_backs_count | plus: 1 -%}
      {%- assign wk_bk = s.kind | default: wk_app.kind -%}
      <a class="wl" href="{{ s.url }}" data-peek-kind="{{ wk_bk | escape }}" data-peek-title="{{ s.title | escape }}" data-peek-lede="{{ s.lede | escape }}">{{ s.title }}</a>
    {%- endif -%}
  {%- endfor -%}
{%- endcapture -%}

<section class="wk" aria-labelledby="wk-title">
  <div class="wk-layout">

    <!-- ===================================================================
         Left rail — this app's sections, grouped and numbered. Scoped to
         the app deliberately: the reader is navigating one write-up, and
         the other write-ups are a click away on /projects/wiki/.
         =================================================================== -->
    <aside class="wk-rail" aria-label="{{ wk_app.title }} sections">
      {% include wiki-rail.html app=wk_app sections=wk_sections %}
    </aside>

    <!-- ===================================================================
         Article
         =================================================================== -->
    <article class="wk-art">

      <p class="wk-crumb mono-label">
        <a href="/projects/">Projects</a>
        <span class="wk-crumb__sep" aria-hidden="true">/</span>
        <a href="/projects/wiki/">Wiki</a>
        <span class="wk-crumb__sep" aria-hidden="true">/</span>
        <a href="{{ wk_first.url }}">{{ wk_app.title }}</a>
        <span class="wk-crumb__sep" aria-hidden="true">/</span>
        <span class="wk-crumb__here">{{ page.title }}</span>
      </p>

      <h1 id="wk-title" class="section-title">{{ page.title }}</h1>

      {%- if page.lede %}
      <p class="work-lede wk-art__lede">{{ page.lede }}</p>
      {%- endif %}

      <div class="wk-art__meta mono">
        <span><b>Entry</b>{{ wk_idx | plus: 1 | prepend: '0' | slice: -2, 2 }} / {{ wk_sections.size | prepend: '0' | slice: -2, 2 }}</span>
        <span><b>Kind</b>{{ wk_kind }}</span>
        <span><b>Revised</b>{{ wk_revised }}</span>
        <span><b>Steward</b>{{ wk_steward }}</span>
        <span><b>Words</b>{{ page.content | strip_html | number_of_words }}</span>
      </div>

      {%- if wk_status == 'draft' %}
      <p class="wk-draft mono">
        <span class="wk-draft__tag">Draft</span>
        <span>This write-up is placeholder copy standing in for the finished
        entry. The structure, links and metadata are real; the prose is not
        final.</span>
      </p>
      {%- endif %}

      {%- comment -%}
        The infobox and the launch button belong to the APP, not to a
        section, so they render on the app's first section only. Repeating
        an eight-row infobox on twelve pages would bury the prose.

        This is also the single, deliberate coupling between a wiki entry
        and its app; nothing else on this page knows /projects/apps/
        exists.
      {%- endcomment -%}
      {%- if wk_idx == 0 %}
        {%- if wk_app.app_url %}
        <p>
          <a class="wk-launch mono-label" href="{{ wk_app.app_url }}">
            Launch app <span aria-hidden="true">&#8599;</span>
          </a>
        </p>
        {%- endif %}
        {%- if wk_app.info %}
          {% include wiki-infobox.html app=wk_app %}
        {%- endif %}
      {%- endif %}

      {%- capture wk_raw %}{{ content }}{% endcapture -%}
      {% include wiki-body.html html=wk_raw %}

      <div class="wk-back">
        <p class="wk-back__h mono-label">Referenced by</p>
        <div class="wk-back__list">
          {%- if wk_backs_count > 0 -%}{{ wk_backs_html }}
          {%- else -%}<span class="wk-back__none mono">Nothing yet — an orphan entry.</span>
          {%- endif -%}
        </div>
      </div>

      <nav class="wk-pager mono-label" aria-label="Wiki sections">
        {%- if wk_g > 0 -%}
          {%- assign wk_prev = wk_all[wk_pi] -%}
          <a href="{{ wk_prev.url }}">Previous<span class="wk-pager__t">{{ wk_prev.title }}</span></a>
        {%- else -%}<span></span>{%- endif -%}
        {%- if wk_ni < wk_all.size -%}
          {%- assign wk_next = wk_all[wk_ni] -%}
          <a href="{{ wk_next.url }}">Next<span class="wk-pager__t">{{ wk_next.title }}</span></a>
        {%- else -%}<span></span>{%- endif -%}
      </nav>

    </article>

    <!-- ===================================================================
         Right rail. On this page and Recently read are built by wiki.js
         and stay hidden until it adds .is-built, so neither leaves an
         empty ruled-off label hanging with JS disabled. Entry status is
         compiled here and needs no JS at all.
         =================================================================== -->
    <aside class="wk__rail" aria-label="About this section">

      <div class="wk-rail__block wk-rail__block--toc" id="wk-toc-block">
        <p class="wk-rail__h"><span class="mono-label">On this page</span></p>
        <nav class="wk-toc" id="wk-toc"></nav>
      </div>

      <div class="wk-rail__block wk-rail__block--recent" id="wk-recent-block">
        <p class="wk-rail__h"><span class="mono-label">Recently read</span></p>
        <div class="wk-recent" id="wk-recent"></div>
      </div>

      {% include wiki-status.html revised=wk_revised backs=wk_backs_count %}

    </aside>

  </div>
</section>

<script src="/assets/js/wiki.js?v=2" defer></script>
```

Note the cache-buster moved to `?v=2`, because `wiki.js` changes in
Task 10 and the old file is what a returning reader has cached.

- [ ] **Step 4: Create the three includes as stubs**

The layout references three includes that do not exist yet, and Jekyll
fails a build on a missing include. Create them minimal now; Tasks 6–8
fill them.

```bash
cd "$(git rev-parse --show-toplevel)"
printf '' > _includes/wiki-rail.html
printf '' > _includes/wiki-infobox.html
printf '' > _includes/wiki-status.html
```

- [ ] **Step 5: Run the assertions**

```bash
bundle exec jekyll build
grep -o 'Entry</b>[^<]*' _site/projects/wiki/gaffer-iq/calculations/index.html
grep -c 'wk__rail' _site/projects/wiki/gaffer-iq/calculations/index.html
grep -c 'wk-draft' _site/projects/wiki/fc26-calculator/two-layouts/index.html
grep -o '>Gaffer IQ</a>' _site/projects/wiki/gaffer-iq/calculations/index.html | head -1
grep -o 'Previous<span class="wk-pager__t">[^<]*' _site/projects/wiki/gaffer-iq/calculations/index.html
grep -o 'Next<span class="wk-pager__t">[^<]*' _site/projects/wiki/gaffer-iq/planner/index.html
```

Expected: `Entry</b>08 / 12`; `1`; `1`; `>Gaffer IQ</a>` present in the
crumb; `Previous…Scoring philosophy`; and on `planner`, `Next…The problem`
— the pager crossing from the end of Gaffer IQ into the start of FC26.

- [ ] **Step 6: Confirm the infobox renders on the first section only**

```bash
grep -c 'wk-launch' _site/projects/wiki/gaffer-iq/what-is-this/index.html
grep -c 'wk-launch' _site/projects/wiki/gaffer-iq/calculations/index.html
```

Expected: `1` then `0`.

- [ ] **Step 7: Commit**

```bash
git add _layouts/wiki-entry.html _includes/wiki-rail.html _includes/wiki-infobox.html _includes/wiki-status.html
git commit -m "$(cat <<'EOF'
feat(wiki): rebuild the entry layout around sections

A section page now looks up its parent app and inherits kind, revised,
steward and status from it, so twelve pages do not restate the same
values. The crumb gains the app level, the meta strip counts within the
app rather than across the wiki, and the infobox and launch button
render on the app's first section only.

The pager walks a list built app-first, so it crosses cleanly from the
last section of one write-up into the first of the next — sorting the
flat section list by order alone would have interleaved the two.

Adds the third grid column and the mount points for the rails. The
three new includes are stubs; they are filled next.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: The left rail — `_includes/wiki-rail.html`

**Files:**
- Modify: `_includes/wiki-rail.html` (stub → real)

**Interfaces:**
- Consumes: `include.app`, `include.sections` from Task 5.
- Produces: rail rows carrying `data-title` and `data-lede` (both
  lowercased) for Task 10's filter to match against, and a
  `<span data-rail-count>` per group for it to rewrite.

- [ ] **Step 1: Write the failing assertions**

```bash
bundle exec jekyll build
grep -c 'wk-rail__block' _site/projects/wiki/gaffer-iq/calculations/index.html
grep -o 'wk-nav__n">[0-9]*' _site/projects/wiki/gaffer-iq/planner/index.html | tail -1
grep -c 'aria-current="page"' _site/projects/wiki/gaffer-iq/calculations/index.html
```

- [ ] **Step 2: Run to verify it fails**

Expected: `2` (only the TOC and Recent blocks from Task 5); no numbering
output; `0`.

Target: `6` blocks (4 groups + TOC + Recent); `wk-nav__n">12`; `1`.

- [ ] **Step 3: Write the include**

```html
{%- comment -%}
=============================================================================
  wiki-rail.html — the left rail: one app's sections, grouped and numbered.

  Usage, from _layouts/wiki-entry.html:
      {% include wiki-rail.html app=wk_app sections=wk_sections %}

  Group order is first-appearance in `order`, so the numbers on the
  section pages are the single control over the rail. There is no list of
  groups anywhere to keep in sync with them.

  Numbering is continuous across groups — 01 … 12 — and identifies the
  section rather than its position in a filtered list, which is why
  wiki.js never renumbers when the filter narrows the rail.

  The filter input itself is NOT rendered here. wiki.js injects it into
  the mount below, so with JavaScript off there is no dead control in the
  rail.
=============================================================================
{%- endcomment -%}
{%- assign wk_groups = include.sections | map: "group" | uniq -%}

<div class="wk-rail__block wk-rail__block--filter" id="wk-rail-filter"></div>

{%- for g in wk_groups -%}
{%- assign wk_gitems = include.sections | where: "group", g -%}
<div class="wk-rail__block wk-rail__group" data-rail-group>
  <p class="wk-rail__h">
    <span class="mono-label">{{ g }}</span>
    <span class="mono-label" data-rail-count>{{ wk_gitems.size | prepend: '0' | slice: -2, 2 }}</span>
  </p>
  <nav class="wk-nav">
    {%- for e in wk_gitems -%}
    {%- assign wk_n = 0 -%}
    {%- for s in include.sections -%}
      {%- if s.url == e.url -%}{%- assign wk_n = forloop.index -%}{%- endif -%}
    {%- endfor -%}
    <a href="{{ e.url }}"{% if e.url == page.url %} aria-current="page"{% endif %} data-rail-item data-title="{{ e.title | downcase | escape }}" data-lede="{{ e.lede | downcase | escape }}">
      <span class="wk-nav__n">{{ wk_n | prepend: '0' | slice: -2, 2 }}</span>
      <span class="wk-nav__t">{{ e.title }}</span>
    </a>
    {%- endfor -%}
  </nav>
</div>
{%- endfor -%}
```

The inner loop that finds `wk_n` is O(n²) over twelve sections. That is
144 comparisons at build time and it keeps the numbering derived from one
ordered list rather than from a counter threaded through two loops.

- [ ] **Step 4: Run the assertions**

```bash
bundle exec jekyll build
grep -c 'wk-rail__block' _site/projects/wiki/gaffer-iq/calculations/index.html
grep -o 'wk-nav__n">[0-9]*' _site/projects/wiki/gaffer-iq/planner/index.html | tail -1
grep -c 'aria-current="page"' _site/projects/wiki/gaffer-iq/calculations/index.html
grep -o '<span class="mono-label">[A-Za-z ]*</span>' _site/projects/wiki/gaffer-iq/calculations/index.html | head -6
```

Expected: `7` (4 groups + filter mount + TOC + Recent); `wk-nav__n">12`;
`1`; and the group names `Overview`, `Design Philosophy`, `Matchups`,
`Pages` in that order.

- [ ] **Step 5: Check FC26's rail is its own**

```bash
grep -c 'gaffer-iq' _site/projects/wiki/fc26-calculator/two-layouts/index.html
grep -o '<span class="mono-label">[A-Za-z ]*</span>' _site/projects/wiki/fc26-calculator/two-layouts/index.html | head -3
```

Expected: `0` for the first — FC26's rail contains no Gaffer IQ links;
and `Overview`, `Build`, `Notes`.

- [ ] **Step 6: Commit**

```bash
git add _includes/wiki-rail.html
git commit -m "$(cat <<'EOF'
feat(wiki): group and number the section rail

The rail lists one app's sections under their group headings, numbered
continuously across the groups. Group order is first-appearance in the
section `order` values, so those numbers are the single control and
there is no list of groups to keep in sync with them.

Rows carry lowercased title and lede in data attributes for the filter
that lands with the JS, and each group heading carries a count element
for it to rewrite.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Glossary data + infobox matching

**Files:**
- Create: `_data/glossary.yml`
- Modify: `_includes/wiki-infobox.html` (stub → real)

**Interfaces:**
- Consumes: `include.app` from Task 5.
- Produces: `button.wk-term` carrying `data-term-kind`, `data-term-text`,
  and optionally `data-term-href` + `data-term-ref`. Task 10's popover
  reads exactly those four attributes and nothing else.

- [ ] **Step 1: Write the failing assertion**

```bash
bundle exec jekyll build && grep -c 'wk-term' _site/projects/wiki/gaffer-iq/what-is-this/index.html
```

- [ ] **Step 2: Run to verify it fails**

Expected: `0` — `_includes/wiki-infobox.html` is still the empty stub, so
the first section has no infobox at all.

- [ ] **Step 3: Write `_data/glossary.yml`**

Keys are the infobox value, lowercased and trimmed, exactly as it appears
in an app's `info` mapping — either a whole value or one `·`-separated
part of one.

```yaml
# =============================================================================
# glossary.yml — definitions behind the clickable values in a wiki infobox.
#
# A key is an infobox value, LOWERCASED and trimmed. _includes/wiki-infobox.html
# tries each value whole first, then splits it on "·" and tries each part, so
# both "live · iterating" as a whole and "live" on its own can be defined.
# A part with no key here renders as plain text — that is the normal case,
# not a failure.
#
#   kind:  the small accent label at the top of the card
#   text:  the definition
#   ref:   optional — a SECTION slug. Renders "Full entry: <title> →".
#          An unresolvable slug renders no link rather than a broken one.
# =============================================================================

"live · iterating":
  kind: Status
  text: >
    Deployed and in use, with the model still being retuned between
    gameweeks. Not a finished product and not pretending to be one.

"one vercel function":
  kind: Backend
  text: >
    The single serverless function exists only because the FPL API sends
    no CORS headers. It fetches from an allowlist and forwards. It holds
    no state, no keys, and no logic of its own.
  ref: the-data

"fpl api":
  kind: Source
  text: >
    Supplies the spine — squads, prices, positions, fixtures, per-player
    histories and live gameweek scoring. It has no standings endpoint and
    no access to any season but the current one.
  ref: the-data

"understat":
  kind: Source
  text: >
    Not an API, but it fills the gaps the FPL feed leaves: expected goals,
    six seasons of fixture lists, chronological match timelines, and
    rosters with position codes and substitution linkage.
  ref: the-data

"5 weighted sub-metrics":
  kind: Model
  text: >
    Base difficulty, counter-matchup, team form, head-to-head and home
    and away. Each is scored separately, weighted, and combined into one
    CompositeScore — because "hard fixture" and "hard fixture for a
    winger" are different questions.
  ref: calculations

"none":
  kind: Build step
  text: >
    No bundler, no framework, no compile. The thing that ships is the
    thing that was edited, and there is no toolchain to rot between one
    season and the next.

"html · js · vanilla css":
  kind: Stack
  text: >
    Everything analytical runs in the browser. No framework, and no CSS
    library — the tokens and components are the app's own.

"html · js · tailwind":
  kind: Stack
  text: >
    Rebuilt in Tailwind once the formulas had stopped moving —
    deliberately in that order, so styling effort was not spent on
    layouts the maths was about to invalidate.
  ref: two-layouts

"mobile read · desktop compare":
  kind: Layouts
  text: >
    Mobile gets one player and the numbers that matter. Desktop gets the
    comparison view, because comparison is what people open a calculator
    for and it needs horizontal room.
  ref: two-layouts

"~2,500 lines · one file":
  kind: Size
  text: >
    A single document holding markup and logic together. Large for one
    file, and the deliberate trade for having no build step at all.
  ref: one-file-no-build
```

- [ ] **Step 4: Write `_includes/wiki-infobox.html`**

```html
{%- comment -%}
=============================================================================
  wiki-infobox.html — the floated "at a glance" box, with glossary matching.

  Usage, from _layouts/wiki-entry.html:
      {% include wiki-infobox.html app=wk_app %}

  Each value is looked up in _data/glossary.yml: the WHOLE value first, so
  a multi-word value like "5 weighted sub-metrics" matches as one key,
  then each "·"-separated part. A hit becomes a real <button> carrying the
  definition in data attributes; a miss renders as text.

  Matching here rather than in JavaScript keeps the glossary out of the
  payload and puts the definitions in the HTML source, where the site's
  own search can see them.

  The "click an underlined value" hint renders only if the box actually
  produced a term — an infobox with nothing clickable must not invite a
  click. wk_terms survives the loop because Liquid `assign` is not
  block-scoped.
=============================================================================
{%- endcomment -%}
{%- assign wk_terms = 0 -%}
<aside class="wk-info" aria-label="{{ include.app.title }} at a glance">
  <p class="wk-info__head mono-label">{{ include.app.title }}</p>
  <dl>
    {%- for row in include.app.info %}
    <dt class="mono-label">{{ row[0] }}</dt>
    <dd>
      {%- assign wk_whole = row[1] | strip | downcase -%}
      {%- assign wk_hit = site.data.glossary[wk_whole] -%}
      {%- if wk_hit -%}
        {%- assign wk_terms = wk_terms | plus: 1 -%}
        {%- include wiki-term.html g=wk_hit label=row[1] -%}
      {%- else -%}
        {%- assign wk_parts = row[1] | split: "·" -%}
        {%- for p in wk_parts -%}
          {%- assign wk_p = p | strip -%}
          {%- unless forloop.first %}<span class="wk-info__sep" aria-hidden="true">·</span>{% endunless -%}
          {%- assign wk_pk = wk_p | downcase -%}
          {%- assign wk_ph = site.data.glossary[wk_pk] -%}
          {%- if wk_ph -%}
            {%- assign wk_terms = wk_terms | plus: 1 -%}
            {%- include wiki-term.html g=wk_ph label=wk_p -%}
          {%- else -%}{{ wk_p }}{%- endif -%}
        {%- endfor -%}
      {%- endif -%}
    </dd>
    {%- endfor %}
  </dl>
  {%- if wk_terms > 0 %}
  <p class="wk-info__hint mono-label">Click an underlined value</p>
  {%- endif %}
</aside>
```

- [ ] **Step 5: Write `_includes/wiki-term.html`**

One term button, so the whole-value and split-part branches above cannot
drift apart:

```html
{%- comment -%}
  wiki-term.html — one clickable glossary value.
      {% include wiki-term.html g=<glossary entry> label=<text to show> %}
  A `ref` that names no section renders no link, rather than a link to
  nowhere.
{%- endcomment -%}
{%- assign wk_ref = "" -%}
{%- assign wk_ref_title = "" -%}
{%- if include.g.ref -%}
  {%- assign wk_rp = site.pages | where_exp: "p", "p.layout == 'wiki-entry'" | where: "slug", include.g.ref | first -%}
  {%- if wk_rp -%}
    {%- assign wk_ref = wk_rp.url -%}
    {%- assign wk_ref_title = wk_rp.title -%}
  {%- endif -%}
{%- endif -%}
<button type="button" class="wk-term" aria-expanded="false" data-term-kind="{{ include.g.kind | escape }}" data-term-text="{{ include.g.text | strip_newlines | strip | escape }}"{% if wk_ref != "" %} data-term-href="{{ wk_ref }}" data-term-ref="{{ wk_ref_title | escape }}"{% endif %}>{{ include.label }}</button>
```

- [ ] **Step 6: Run the assertions**

```bash
bundle exec jekyll build
grep -c 'wk-term' _site/projects/wiki/gaffer-iq/what-is-this/index.html
grep -c 'wk-info__hint' _site/projects/wiki/gaffer-iq/what-is-this/index.html
grep -o 'data-term-ref="[^"]*"' _site/projects/wiki/gaffer-iq/what-is-this/index.html | sort -u
grep -c 'wk-term' _site/projects/wiki/gaffer-iq/calculations/index.html
```

Expected: a count of `6` or more for Gaffer IQ's box (`Live · iterating`,
`HTML · JS · vanilla CSS`, `None`, `One Vercel function`, `FPL API`,
`Understat`, `5 weighted sub-metrics`); `1` for the hint; `data-term-ref`
values naming real section titles; and `0` on `calculations`, which has no
infobox.

- [ ] **Step 7: Check a value with no glossary entry is untouched**

```bash
grep -o '<dd>[^<]*2026[^<]*</dd>' _site/projects/wiki/gaffer-iq/what-is-this/index.html
```

Expected: `First shipped: 2026` renders its value as plain text with no
button, because `2026` has no glossary key.

- [ ] **Step 8: Commit**

```bash
git add _data/glossary.yml _includes/wiki-infobox.html _includes/wiki-term.html
git commit -m "$(cat <<'EOF'
feat(wiki): make infobox values open a definition

Each infobox value is matched against a glossary at build time — the
whole value first, so a multi-word value matches as one key, then each
dot-separated part. A hit becomes a real button carrying the definition
in data attributes; a miss renders as text, which is the normal case.

Matching at build rather than in the browser keeps the glossary out of
the payload and puts the definitions in the HTML source, where the
site's own search can see them. The "click an underlined value" hint
renders only when the box actually produced a term.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Entry status — `_includes/wiki-status.html`

**Files:**
- Modify: `_includes/wiki-status.html` (stub → real)

**Interfaces:**
- Consumes: `include.revised`, `include.backs` from Task 5.
- Produces: nothing later tasks read. This block is complete at build
  time and needs no JavaScript.

- [ ] **Step 1: Write the failing assertion**

```bash
bundle exec jekyll build && grep -c 'wk-stats' _site/projects/wiki/gaffer-iq/calculations/index.html
```

- [ ] **Step 2: Run to verify it fails**

Expected: `0`.

- [ ] **Step 3: Write the include**

```html
{%- comment -%}
=============================================================================
  wiki-status.html — the right rail's Entry status block.

  Usage, from _layouts/wiki-entry.html:
      {% include wiki-status.html revised=wk_revised backs=wk_backs_count %}

  Every number here is computed at build time, so the block is complete
  with JavaScript off — unlike the two blocks above it in the rail.

  Notes counts the ((…)) footnote markers in the source, which is the
  same convention _includes/wiki-body.html compiles. Splitting on the
  opening delimiter and subtracting one counts openings, so an unclosed
  note would be counted; that would already be visibly broken in the
  prose.

  The design sheet's "Locally edited" row is deliberately absent. It
  reports on an in-browser edit mode this site does not have.
=============================================================================
{%- endcomment -%}
{%- assign wk_note_count = page.content | split: "((" | size | minus: 1 -%}
<div class="wk-rail__block">
  <p class="wk-rail__h"><span class="mono-label">Entry status</span></p>
  <div class="wk-stats mono">
    <span>Words<b>{{ page.content | strip_html | number_of_words }}</b></span>
    <span>Notes<b>{{ wk_note_count }}</b></span>
    <span>Inbound links<b>{{ include.backs }}</b></span>
    <span>Revised<b>{{ include.revised }}</b></span>
  </div>
</div>
```

- [ ] **Step 4: Run the assertions**

```bash
bundle exec jekyll build
grep -c 'wk-stats' _site/projects/wiki/gaffer-iq/calculations/index.html
grep -o 'Notes<b>[0-9]*' _site/projects/wiki/gaffer-iq/calculations/index.html
grep -o 'Inbound links<b>[0-9]*' _site/projects/wiki/gaffer-iq/what-is-this/index.html
grep -o 'Revised<b>[0-9-]*' _site/projects/wiki/fc26-calculator/two-layouts/index.html
```

Expected: `1`; a Notes count matching the `((` markers in that section's
source (`grep -c '((' projects/wiki/gaffer-iq/calculations/index.html` to
confirm); an Inbound links number; and `Revised<b>2026-08-25` on FC26,
proving the value inherited from the parent app.

- [ ] **Step 5: Commit**

```bash
git add _includes/wiki-status.html
git commit -m "$(cat <<'EOF'
feat(wiki): add the Entry status block

Words, Notes, Inbound links and Revised, all computed by Liquid, so the
block is complete with JavaScript off — unlike On this page and Recently
read above it in the same rail.

The design sheet's "Locally edited" row is deliberately absent: it
reports on an in-browser edit mode this site does not have.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Styles

**Files:**
- Modify: `assets/css/wiki.css` — `:root` block, `.wk-layout`,
  `.wk-rail`, plus new sections for the right rail, the filter, the term
  and the popover

**Interfaces:**
- Consumes: the class names Tasks 5–8 emit.
- Produces: `.is-built` as the reveal hook for both JS-built rail blocks,
  and `.is-on` as the popover's open state — Task 10 toggles both.

- [ ] **Step 1: Add the new structural measure**

In the `:root` block at the top, after `--wk-rail-w`:

```css
  --wk-rail-r-w: 14rem; /* right rail column                                */
```

Update the block comment above `:root`, which currently says "The three
`--wk-*` properties below are the only new values in the file", to say
four.

- [ ] **Step 2: Make the layout three columns**

Replace the `.wk-layout` rule and its media query:

```css
.wk-layout {
  display: grid;
  grid-template-columns: var(--wk-rail-w) minmax(0, 1fr) var(--wk-rail-r-w);
  gap: clamp(var(--space-6), 4vw, var(--space-8));
  align-items: start;
}

/* 74rem is the one new breakpoint in this file: below it the third
   column no longer leaves a readable measure for the prose. The right
   rail drops out of the grid and becomes a row of its three blocks
   above the article — hidden entirely would lose Entry status, which
   needs no JS and is worth keeping at every width. */
@media (max-width: 74rem) {
  .wk-layout { grid-template-columns: var(--wk-rail-w) minmax(0, 1fr); }
  .wk__rail {
    grid-column: 1 / -1;
    grid-row: 1;
    position: static;
    max-height: none;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(var(--wk-rail-w), 1fr));
    gap: var(--space-5);
    padding-bottom: var(--space-6);
    margin-bottom: var(--space-6);
    border-bottom: var(--border-rule);
  }
}

/* 56rem is an existing site breakpoint (components.css) — reused rather
   than introducing a new one. Below it neither rail is a column. */
@media (max-width: 56rem) {
  .wk-layout { grid-template-columns: minmax(0, 1fr); }
  .wk__rail { grid-template-columns: minmax(0, 1fr); }
}
```

- [ ] **Step 3: Style the right rail**

Add after the existing left-rail section:

```css
/* =========================================================================
   RIGHT RAIL — on this page, recently read, entry status
   ========================================================================= */

.wk__rail {
  position: sticky;
  top: var(--space-5);
  max-height: calc(100vh - var(--space-7));
  overflow: auto;
  padding-bottom: var(--space-5);
}

/* Both JS-built blocks stay hidden until wiki.js adds .is-built, so
   neither leaves an empty ruled-off label hanging with JS disabled.
   Entry status carries no such guard — it is compiled. */
.wk-rail__block--toc:not(.is-built),
.wk-rail__block--recent:not(.is-built) { display: none; }

.wk-recent { display: flex; flex-direction: column; gap: var(--space-2); }
.wk-recent a {
  font-family: var(--font-sans);
  font-size: var(--fs-small);
  line-height: var(--lh-ui);
  color: var(--fg-quiet);
  text-decoration: none;
  transition: color var(--dur-1) var(--ease);
}
.wk-recent a:hover { color: var(--accent); }
.wk-recent a[aria-current="page"] { color: var(--fg); }

.wk-stats { display: grid; gap: var(--space-1); color: var(--fg-quiet); }
.wk-stats span { display: flex; justify-content: space-between; gap: var(--space-3); }
.wk-stats b { font-weight: var(--fw-regular); color: var(--fg); }
```

- [ ] **Step 4: Style the rail filter**

Add to the left-rail section, after `.wk-nav` rules:

```css
/* ---- filter (injected by wiki.js) ---------------------------------------- */
.wk-filter { position: relative; }
.wk-filter input {
  width: 100%;
  appearance: none;
  background: transparent;
  border: 0;
  border-bottom: var(--border-hairline);
  padding: var(--space-2) 0;
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  letter-spacing: var(--tr-mono);
  color: var(--fg);
  outline: none;
  transition: border-color var(--dur-1) var(--ease);
}
.wk-filter input::placeholder {
  color: var(--fg-faint);
  letter-spacing: var(--tr-mono-caps);
  text-transform: uppercase;
}
.wk-filter input:focus { border-bottom-color: var(--accent); }

/* Set by wiki.js on a row or a group with no match left in it. */
.wk-nav a[hidden],
.wk-rail__group[hidden] { display: none; }

.wk-rail__empty {
  font-family: var(--font-serif);
  font-style: italic;
  font-size: var(--fs-small);
  color: var(--fg-quiet);
}
```

- [ ] **Step 5: Style the term and the popover**

Add a new section after the INFOBOX section:

```css
/* =========================================================================
   GLOSSARY TERMS + POPOVER
   A term is a real <button> compiled by _includes/wiki-term.html. The
   popover is a single element wiki.js appends to <body>, so its absolute
   coordinates are page coordinates whatever the article's layout does.
   ========================================================================= */

.wk-info__sep { color: var(--fg-faint); padding: 0 var(--space-1); }
.wk-info > .wk-info__hint {
  display: block;
  margin: 0;
  padding: 0 var(--space-4) var(--space-3);
  color: var(--fg-faint);
}

button.wk-term {
  appearance: none;
  background: transparent;
  border: 0;
  border-bottom: 1px dotted var(--fg-faint);
  padding: 0;
  margin: 0;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: color var(--dur-1) var(--ease),
              border-color var(--dur-1) var(--ease);
}
button.wk-term:hover { color: var(--accent); border-bottom-color: var(--accent); }
button.wk-term[aria-expanded="true"] {
  color: var(--accent);
  border-bottom: 1px solid var(--accent);
}
button.wk-term:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* Above the hover peek (z 60) — a term click is deliberate, a hover is
   not, so the deliberate one wins. Still below the skip link (z 100). */
.wk-pop {
  position: absolute;
  z-index: 70;
  width: var(--wk-peek-w);
  padding: var(--space-4);
  background: var(--bg);
  border: var(--border-rule);
  box-shadow: var(--shadow-2);
  display: none;
}
.wk-pop.is-on { display: block; }
.wk-pop__kind {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  margin: 0;
  color: var(--accent);
}
.wk-pop__x {
  appearance: none;
  background: transparent;
  border: 0;
  padding: 0;
  font: inherit;
  letter-spacing: 0;
  color: var(--fg-faint);
  cursor: pointer;
}
.wk-pop__x:hover { color: var(--accent); }
.wk-pop__term {
  margin: var(--space-2) 0 0;
  font-family: var(--font-mono);
  font-size: var(--fs-ui);
  line-height: var(--lh-snug);
  letter-spacing: var(--tr-mono);
  color: var(--fg);
}
.wk-pop__body {
  margin: var(--space-3) 0 0;
  font-family: var(--font-serif);
  font-size: var(--fs-body);
  line-height: var(--lh-ui);
  color: var(--fg-muted);
  text-wrap: pretty;
}
.wk-pop__ref {
  display: inline-block;
  margin-top: var(--space-3);
  color: var(--accent);
  text-decoration: none;
}
.wk-pop__ref:hover { border-bottom: 1px solid var(--accent); }
```

- [ ] **Step 6: Update the file's head comment**

The comment at the top describes the file as "Entry-page article shell
only: rail, article head, infobox, footnotes, backlinks, pager, launch
button." Extend that list to "…launch button, right rail, glossary
popover", and change "three `--wk-*` properties" to four if Step 1 did
not already.

- [ ] **Step 7: Verify no literal design values crept in**

```bash
grep -nE '#[0-9a-fA-F]{3,6}|[0-9]+ms|[0-9.]+rem|[0-9]+px' assets/css/wiki.css \
  | grep -v -- '--wk-' | grep -v 'max-width:' | grep -v '1px dotted' \
  | grep -v '1px solid' | grep -v '2px solid' | grep -v 'outline-offset'
```

Expected: no output. The exceptions grepped out are the four `--wk-*`
declarations, the media-query breakpoints, and the hairline/outline
widths — which are line weights, and which the file already writes
literally in its existing `a.wl` and focus rules.

- [ ] **Step 8: Build and commit**

```bash
bundle exec jekyll build
git add assets/css/wiki.css
git commit -m "$(cat <<'EOF'
feat(wiki): style the right rail, filter, terms and popover

Adds the third grid column and one new breakpoint at 74rem, below which
the right rail leaves the grid and becomes a row of its three blocks
above the article rather than disappearing — Entry status needs no JS
and is worth keeping at every width.

The two JS-built rail blocks stay hidden until wiki.js marks them built,
so neither leaves an empty ruled-off label with JS off. The popover sits
above the hover peek: a term click is deliberate and a hover is not.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Behaviour

**Files:**
- Modify: `assets/js/wiki.js` — extend the existing IIFE with three
  sections; the TOC and hover-peek sections stay as they are

**Interfaces:**
- Consumes: `[data-rail-item]`, `[data-rail-group]`, `[data-rail-count]`,
  `#wk-rail-filter`, `#wk-recent`, `#wk-recent-block`, `#wk-toc-block`,
  `button.wk-term[data-term-*]`.
- Produces: nothing.

- [ ] **Step 1: Reveal the Recently read block**

The TOC section already adds `.is-built` to `#wk-toc-block`. The Recent
block needs the same guard honoured. In the file's section 1, no change.
Everything below is new.

- [ ] **Step 2: Add the rail filter**

Insert a new section after section 1 (On this page), before section 2
(Hover preview). Renumber the hover-preview comment header to 4 at the
end of this task.

```javascript
  /* =======================================================================
     2. Rail filter

     Injected rather than authored into the rail, so with JS off there is
     no dead control. Filtering is over data attributes the build already
     wrote onto each row — no index, no fetch.

     Row numbers are NOT rewritten when the rail narrows: 07 identifies
     the section, not its position in a filtered list.
     ======================================================================= */

  var filterMount = document.getElementById('wk-rail-filter');

  function buildFilter () {
    if (!filterMount) return;

    var items  = Array.prototype.slice.call(document.querySelectorAll('[data-rail-item]'));
    var groups = Array.prototype.slice.call(document.querySelectorAll('[data-rail-group]'));
    if (items.length < 2) return;

    var wrap = document.createElement('div');
    wrap.className = 'wk-filter';

    var input = document.createElement('input');
    input.type = 'text';
    input.id = 'wk-filter-input';
    input.placeholder = 'Filter entries';
    input.autocomplete = 'off';
    input.setAttribute('aria-label', 'Filter sections');

    var empty = document.createElement('p');
    empty.className = 'wk-rail__empty';
    empty.textContent = 'No section matches.';
    empty.hidden = true;

    wrap.appendChild(input);
    filterMount.appendChild(wrap);
    filterMount.appendChild(empty);

    function apply () {
      var q = input.value.trim().toLowerCase();
      var total = 0;

      groups.forEach(function (g) {
        var rows = Array.prototype.slice.call(g.querySelectorAll('[data-rail-item]'));
        var shown = 0;

        rows.forEach(function (a) {
          var hit = !q ||
                    (a.getAttribute('data-title') || '').indexOf(q) > -1 ||
                    (a.getAttribute('data-lede')  || '').indexOf(q) > -1;
          a.hidden = !hit;
          if (hit) shown++;
        });

        g.hidden = shown === 0;
        total += shown;

        var count = g.querySelector('[data-rail-count]');
        if (count) count.textContent = shown < 10 ? '0' + shown : String(shown);
      });

      empty.hidden = total !== 0;
    }

    input.addEventListener('input', apply);
    // Escape clears rather than closes — there is nothing to close.
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && input.value) {
        ev.preventDefault();
        input.value = '';
        apply();
      }
    });
  }
```

- [ ] **Step 3: Add Recently read**

```javascript
  /* =======================================================================
     3. Recently read

     Five most recent sections, newest first, in this browser only. Every
     access is wrapped because localStorage throws outright in some
     privacy modes rather than returning null.

     Titles are stored alongside slugs so a row can be drawn without a
     manifest of every section in the wiki.
     ======================================================================= */

  var RECENT_KEY = 'wk-recent-v1';
  var RECENT_MAX = 5;

  function readRecent () {
    try {
      var raw = window.localStorage.getItem(RECENT_KEY);
      var list = raw ? JSON.parse(raw) : [];
      return Object.prototype.toString.call(list) === '[object Array]' ? list : [];
    } catch (e) { return []; }
  }

  function writeRecent (list) {
    try { window.localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch (e) {}
  }

  function buildRecent () {
    var mount = document.getElementById('wk-recent');
    var block = document.getElementById('wk-recent-block');
    var title = document.getElementById('wk-title');
    if (!mount || !block || !title) return;

    var here = { url: window.location.pathname, title: title.textContent };

    var list = readRecent().filter(function (r) {
      return r && r.url && r.title && r.url !== here.url;
    });
    list.unshift(here);
    list = list.slice(0, RECENT_MAX);
    writeRecent(list);

    mount.innerHTML = '';
    list.forEach(function (r) {
      var a = document.createElement('a');
      a.href = r.url;
      a.textContent = r.title;
      if (r.url === here.url) a.setAttribute('aria-current', 'page');
      mount.appendChild(a);
    });

    block.classList.add('is-built');
  }
```

- [ ] **Step 4: Add the glossary popover**

```javascript
  /* =======================================================================
     4. Glossary popover

     One element appended to <body>, same reason as the hover peek: its
     absolute coordinates are then page coordinates whatever the
     article's layout is doing.

     Content comes from data attributes the build wrote onto the button,
     so the glossary itself is never shipped as JavaScript.
     ======================================================================= */

  var pop = null;
  var openTerm = null;

  function ensurePop () {
    if (pop) return pop;
    pop = document.createElement('div');
    pop.className = 'wk-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Term detail');
    document.body.appendChild(pop);
    return pop;
  }

  function closePop () {
    if (openTerm) openTerm.setAttribute('aria-expanded', 'false');
    openTerm = null;
    if (pop) pop.classList.remove('is-on');
  }

  function openPop (btn) {
    var el = ensurePop();
    el.innerHTML = '';

    var kind = document.createElement('p');
    kind.className = 'wk-pop__kind mono-label';
    var kindText = document.createElement('span');
    kindText.textContent = btn.getAttribute('data-term-kind') || 'Term';
    var x = document.createElement('button');
    x.type = 'button';
    x.className = 'wk-pop__x';
    x.setAttribute('data-pop-close', '');
    x.setAttribute('aria-label', 'Close');
    x.textContent = '✕';
    kind.appendChild(kindText);
    kind.appendChild(x);
    el.appendChild(kind);

    var term = document.createElement('p');
    term.className = 'wk-pop__term';
    term.textContent = btn.textContent.trim();
    el.appendChild(term);

    var body = document.createElement('p');
    body.className = 'wk-pop__body';
    body.textContent = btn.getAttribute('data-term-text') || '';
    el.appendChild(body);

    var href = btn.getAttribute('data-term-href');
    if (href) {
      var ref = document.createElement('a');
      ref.className = 'wk-pop__ref mono-label';
      ref.href = href;
      ref.textContent = 'Full entry: ' + (btn.getAttribute('data-term-ref') || '') + ' →';
      el.appendChild(ref);
    }

    // Measure while shown but invisible, then place: below the term if it
    // fits, above if it does not, and never past the right edge.
    el.style.visibility = 'hidden';
    el.classList.add('is-on');
    var r = btn.getBoundingClientRect();
    var h = el.offsetHeight;
    var w = el.offsetWidth;
    var top = r.bottom + window.scrollY + 8;
    if (r.bottom + h + 16 > window.innerHeight && r.top - h - 8 > 0) {
      top = r.top + window.scrollY - h - 8;
    }
    var left = r.left + window.scrollX + (r.width / 2) - (w / 2);
    left = Math.min(left, window.scrollX + document.documentElement.clientWidth - w - 16);
    el.style.top  = Math.max(window.scrollY + 8, top) + 'px';
    el.style.left = Math.max(8, left) + 'px';
    el.style.visibility = 'visible';

    btn.setAttribute('aria-expanded', 'true');
    openTerm = btn;
  }

  function bindPop () {
    document.addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('button.wk-term') : null;
      if (btn) {
        ev.preventDefault();
        // A second click on the open term closes it.
        if (btn === openTerm) { closePop(); return; }
        closePop();
        openPop(btn);
        return;
      }
      if (ev.target.closest && ev.target.closest('[data-pop-close]')) { closePop(); return; }
      if (ev.target.closest && ev.target.closest('.wk-pop')) return;
      closePop();
    });

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && openTerm) { ev.preventDefault(); closePop(); }
    });

    window.addEventListener('resize', closePop);
  }
```

- [ ] **Step 5: Renumber the hover-peek section and extend the file header**

Change its comment header from `2. Hover preview` to `5. Hover preview`.

In the file's head comment, replace the "Two jobs:" list with:

```
   Five jobs:
     1. Build the "On this page" list from the section's own h2/h3, and
        keep the current heading marked as the reader scrolls.
     2. Inject and run the rail filter.
     3. Keep the Recently read list, in this browser only.
     4. Open a definition when an infobox term is clicked.
     5. Show a small preview card when the reader hovers an internal wiki
        link. The card's content comes from data-peek-* attributes the
        build already wrote onto each link — no manifest, no fetch.
```

- [ ] **Step 6: Call the new builders**

At the foot of the IIFE, replace `buildToc();` with:

```javascript
  buildToc();
  buildFilter();
  buildRecent();
  bindPop();
```

- [ ] **Step 7: Verify in the browser**

Create `.claude/launch.json` if it does not exist:

```json
{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "jekyll",
      "runtimeExecutable": "bundle",
      "runtimeArgs": ["exec", "jekyll", "serve", "--port", "4000"],
      "port": 4000
    }
  ]
}
```

Start it with the Browser pane's `preview_start` (never with Bash), open
`/projects/wiki/gaffer-iq/what-is-this/`, then check:

1. `read_console_messages` — no errors.
2. Click an underlined infobox value: the card opens under it, carries
   the right kind label, and the `Full entry` link points at a real
   section.
3. Click the same term again: it closes. Click elsewhere: it closes.
   Press `Escape`: it closes.
4. Type `plan` in the rail filter: only `Planner` remains, the `Pages`
   count reads `01`, the other three groups disappear, and Planner's
   number still reads `12`. Clear it: everything returns.
5. Type `zzz`: `No section matches.` appears.
6. Visit three sections, return to the first: Recently read lists them
   newest first. Reload: the list survives.
7. On `calculations`, the On this page block is absent (no h2s in that
   section); confirm it appears on a section that has one.

- [ ] **Step 8: Commit**

```bash
git add assets/js/wiki.js .claude/launch.json
git commit -m "$(cat <<'EOF'
feat(wiki): filter the rail, remember reading, open definitions

Three additions, all progressive enhancement over content already in the
HTML. The filter input is injected rather than authored, so with JS off
there is no dead control; it matches the title and lede the build wrote
onto each row, and never renumbers, because 07 identifies a section
rather than its slot in a filtered list.

Recently read keeps five entries in this browser, storing titles beside
slugs so a row needs no manifest, and wrapping every access because
localStorage throws outright in some privacy modes.

The popover reads its content from the term button's data attributes, so
the glossary is never shipped as JavaScript.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

Note: `.claude/` is gitignored, so `git add .claude/launch.json` will be
a no-op. That is fine — the file is local tooling.

---

### Task 11: Full verification pass

**Files:**
- None. This task changes nothing; it proves the previous ten.

**Interfaces:**
- Consumes: everything.
- Produces: a green build or a list of defects to fix before merge.

- [ ] **Step 1: Clean build**

```bash
cd "$(git rev-parse --show-toplevel)"
rm -rf _site .jekyll-cache
bundle exec jekyll build 2>&1 | tee /tmp/wiki-build.log
grep -iE 'warn|error|liquid' /tmp/wiki-build.log
```

Expected: no Liquid warnings, no errors.

- [ ] **Step 2: Every section resolves**

```bash
for f in $(find _site/projects/wiki -name index.html); do
  test -s "$f" || echo "EMPTY: $f"
done
find _site/projects/wiki -name index.html | wc -l
```

Expected: no `EMPTY` lines; `21` files (2 apps + 12 + 6 sections + the
wiki index).

- [ ] **Step 3: Walk the pager end to end in the browser**

From `/projects/wiki/gaffer-iq/what-is-this/`, follow `Next` eighteen
times. Expected order: the twelve Gaffer IQ sections in rail order, then
FC26's six. The first page has no Previous; the last has no Next.

- [ ] **Step 4: The no-JavaScript pass**

Disable JavaScript in the Browser pane
(`javascript_tool` cannot do this — use the pane's own settings, or load
the page and confirm each item below is present in `_site` HTML rather
than injected):

```bash
grep -c 'wk-stats'      _site/projects/wiki/gaffer-iq/calculations/index.html
grep -c 'wk-info'       _site/projects/wiki/gaffer-iq/what-is-this/index.html
grep -c 'wk-pager'      _site/projects/wiki/gaffer-iq/calculations/index.html
grep -c 'wk-back'       _site/projects/wiki/gaffer-iq/calculations/index.html
grep -c 'wk-filter'     _site/projects/wiki/gaffer-iq/calculations/index.html
grep -c 'is-built'      _site/projects/wiki/gaffer-iq/calculations/index.html
```

Expected: `1`, `1`, `1`, `1` for the compiled things; `0` for the filter
and `0` for `is-built`, proving the two JS-built blocks and the filter
input are genuinely absent rather than present-but-empty.

- [ ] **Step 5: Responsive pass**

`resize_window` to desktop, then `1100` × `900` (below 74rem), then
mobile. Confirm: three columns; then two columns with the right rail as a
row above the article; then a single stack. The page body must never
scroll horizontally at any of the three.

- [ ] **Step 6: Screenshot the result**

`computer {action: "screenshot"}` on `/projects/wiki/gaffer-iq/what-is-this/`
with a term popover open, and on `/projects/wiki/gaffer-iq/calculations/`
to show the rail's current-row state.

- [ ] **Step 7: Push the branch**

```bash
git push -u origin wiki-section-entries
```

---

## Self-review

**Spec coverage.** Every section of the spec maps to a task: the two page
kinds and both decompositions to Tasks 1–2; the index to Task 3; the
`[[app-slug]]` fallback to Task 4; crumb, meta, infobox placement, draft
flag, footnotes, backlinks and pager to Task 5; the left rail and its
filter contract to Task 6; glossary data, build-time matching and the
hint to Task 7; Entry status and the dropped `Locally edited` row to
Task 8; layout, breakpoints and popover styling to Task 9; popover
runtime, filter and Recently read to Task 10; every numbered verification
item in the spec to Task 11.

**Two things the spec left implicit, now pinned down here.** The spec
said the right rail is hidden below 74rem; Task 9 keeps it as a row
instead, because Entry status is compiled and worth keeping at every
width — a behaviour change from the spec, called out in the CSS comment
and the commit message. And the spec did not say what happens to the
`?v=1` cache-buster on `wiki.js`; Task 5 moves it to `?v=2`, since Task
10 changes that file.

**Liquid variables are not scoped to an include.** Jekyll's `{% include %}`
shares the layout's variable scope, so an include that assigns `wk_kind`
would clobber the layout's. Three names are deliberately distinct for
that reason: the link loop in `wiki-body.html` uses `wk_lk_kind`, and
`wiki-status.html` counts into `wk_note_count` rather than `wk_notes`,
which `wiki-body.html` already uses for the notes markup. `wk_needle` is
reused by both, which is safe only because the layout finishes with it
before the body include runs — do not move the backlink block below the
include.

**Type consistency.** `wk_app`, `wk_sections`, `wk_idx`,
`wk_backs_count` are produced in Task 5 and consumed by name in Tasks 6
and 8. The four `data-term-*` attributes are written in Task 7 and read
in Task 10. `data-rail-item` / `data-rail-group` / `data-rail-count` are
written in Task 6 and read in Task 10. `.is-built` is styled in Task 9
and set in Task 10 for both `#wk-toc-block` (existing code) and
`#wk-recent-block` (new). `.is-on` is styled in Task 9 and toggled in
Task 10.
