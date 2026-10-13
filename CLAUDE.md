# jayjaybee.com - project directives

Astro site, static output (`npm run build` -> `dist/`). The UI is the
"Mockup 8 / Brief" design handoff rebuilt pixel-for-pixel: copy, layout and
motion timings are final. Change them only on request.

Verify every change with `npm run build` (must pass) and `npm run preview`.
There are no tests or linters.

## Deploy

Hosted on **Vercel** as one repo, several Vercel projects. Each builds
only when its own files change (Ignored Build Step = `git diff HEAD^ HEAD
--quiet -- <paths> || exit 1`):

| Vercel project | Root Directory | Builds when |
|---|---|---|
| jayjaybee-site | `/` | anything outside `projects/apps/` changes |
| gaffer-iq | `projects/apps/gaffer-iq` | that folder changes |
| fc26-calculator | `projects/apps/fc26-calculator` | that folder changes |
| f1live | `projects/apps/f1live` | that folder changes |

Root `vercel.json` pins the site project to Astro (`framework`, install,
build, `outputDirectory: dist`), overriding any dashboard settings left over
from the old Jekyll build. Astro 7 needs Node >= 22.12 (`engines` in
`package.json`).

jayjaybee.com reaches each app through `vercel.json` rewrites
(`/projects/apps/<slug>/:path*` -> that app's `*.vercel.app` host). Astro
never builds anything under `projects/apps/`: Vercel serves real files
before rewrites, so a copy in `dist/` would shadow the live app. A new app =
new Vercel project + a redirect/rewrite pair in `vercel.json`.

`public/assets/css/back-to-jayjaybee.css` and
`public/assets/js/back-to-jayjaybee.js` are loaded *by the apps* (relative
`../../../assets/...` from `/projects/apps/<slug>/`). They look unused by the
site; they are not. Keep both paths.

`vercel.json` redirects `/projects/wiki/f1live/*` to `/projects/` while the
F1 Live write-up is unwritten. Remove that redirect when it lands.

The Ignored Build Step diffs `HEAD^` (first parent) against `HEAD`. A
merge commit whose first parent already holds the changes - e.g. `main`
merged *into* a branch, then that branch pushed to `main` - diffs empty
and the site build is **skipped**. Land work on `main` as a
fast-forward or as a merge made *on* `main`, never the other way round.

## Scope boundary

`projects/apps/**` is excluded - see `.claudeignore`. Each app owns its
entire document and shares no code with the site or with each other.
Nothing below applies inside that path.

## Content

All copy lives in `src/data/content.json`, `wiki.json` and `thesis.json`;
project cards/details and per-role meta (logo, cover tone, stack, one-line
summary) are in `src/lib/site.js`. `site.js` applies the design's render-time
typography exactly where the prototype did: `typo()` (en dashes, curly
quotes) and `fix()` (en dashes). Wiki/thesis inline markup: `**bold**`,
`` `code` ``, `[[slug|label]]`, `[label](url)`, `((footnote))`.

A wiki section with `"draft": true` has no page: it shows as "Planned" in the
contents and its URL forwards to the write-up's front page. Drop the flag to
publish it.

## Styling

`src/styles/site.css` is the only stylesheet and every page loads all of it:
the transition engine swaps `<main>` in place, so the next page's rules must
already be present. Never add component-scoped `<style>` blocks.

Colours, fonts and shared measures are custom properties on `:root`; use
`var(--...)`, no raw hex in rules. One-off structural values (a `clamp()`
padding, a `flex-basis`) stay literal, as in the design. Per-item data values
(`--g` segment grow, `--tone`/`--img` role covers) go in a `style` attribute
as custom properties only.

## Motion engine contract

`src/scripts/engine.js` is a port of the design's transition engine. It keys
off data attributes, so markup changes must keep them:

- Entrances: `data-line` (home lines), `data-cl` (inner-page lines),
  `data-ctl` (thesis chapter titles), `data-hr` / `data-ci` (items),
  `data-cover`, `data-rv` (scroll reveal), `data-w` / `data-ww` / `data-pw`
  (words that brighten on scroll).
- Shared-element flights: source has `data-tx="<id>" data-tx-to="<page>:<id>"`,
  destination has the same `data-tx`; `data-tx-box` marks a box (non-img)
  flight. Route keys: `home:`, `case:<slug>`, `projects:<slug>`,
  `wiki:<app>/<section>`, `thesis:`.
- Header sub-bar: `data-sub`, `data-wkn`, `data-wkt`, `data-prog`,
  `data-chfill`, `data-chlabel`; page content goes in Base's `sub` slot.
- Behaviour hooks: `data-hvg`/`data-hv` (hover-dim rows), `data-jump`,
  `data-goto`, `data-fn`, `data-sc`, `data-gloss`/`data-gx`.

Same-origin links to site pages are fetched and swapped client-side; other
same-origin links (the apps) play the exit and then load normally. Reduced
motion: a plain fade, no flights or scrubs.

## What NOT to touch here

`projects/apps/**` (see above), `dist/` and `.astro/` (build output),
`.claude/` (working files), anything matching `.gitignore`'s AMF1/Aston
patterns.
