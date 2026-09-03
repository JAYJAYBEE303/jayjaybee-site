# jayjaybee.com — design-system directives

Jekyll static site, no build step beyond Jekyll itself. No npm, no
`package.json`, no bundler — there is nothing to `npm install`, `lint`,
or `type-check`. Verification is push-and-check-live (see
`SKILL.md`), not a local build.

## Scope boundary

`projects/apps/**` is excluded — see `.claudeignore`. Each app under
`/projects/apps/<slug>/` owns its entire document (own `<head>`,
fonts, tokens, stylesheets) and shares no code with the site or with
each other; `_config.yml`'s `layout: null` scope enforces the same
rule at build time. Nothing below applies inside that path.

## Token source

`assets/css/variables.css` is the one token file — colour, type
family/scale, spacing steps, radii, shadows, motion (durations +
easings). **These categories must always resolve through `var(--...)`
— no raw hex, no raw font stacks, no literal `ms`/`cubic-bezier`, no
inline `style="color: #..."` or similar.** Resolve to an existing `--`
custom property, or add one to `variables.css` if the value is
genuinely new and reusable.

One-off *structural* dimensions — a grid-column width
(`11rem 1fr`), a component's own `max-width` (`32ch`), a breakpoint
(`@media (max-width: 56rem)`) — are legitimately literal in
`layout.css` and `components.css`; that is this repo's real
convention (see e.g. `.role-item`'s `grid-template-columns: 11rem 1fr`,
`.footer-portrait`'s `width: 6rem`), not debt to clean up. Only
promote one to a `--` token when it is reused across multiple rules —
`wiki.css` does exactly this with its own `--wk-rail-w` etc. for
measures with "no site-wide counterpart" (its own words).

`wiki.css` alone holds itself to a stricter, file-scoped rule: *zero*
literal values of any kind, including one-off structural ones — its
own header states this explicitly. Match that stricter bar only
inside `wiki.css`; don't import it into `layout.css`/`components.css`.

Approved exceptions (checked, not tokens, not violations):
- `assets/css/layout.css`'s `.footer-portrait` mask-image gradients
  use literal `#000`/`transparent` — mask **luminance**, not painted
  colour. A `--` token would misrepresent what the value does.
- HTML numeric character references (`&#8617;`, `&#8599;`, …) are
  glyphs, not colours, even though they match a `#[0-9a-f]+`-shaped
  regex.

## UI primitive reuse

Reusable pieces (buttons, chips, cards, nav, disclosure panels) live
in `assets/css/components.css`; wiki-specific ones in `wiki.css`.
Before writing a new one-off, check whether an existing class already
does the job (`.mono-label`, `.chip`, `.role-disclosure-summary`,
`a.wk-launch`, `.accent`, …) — an inline `style` attribute is a sign
one is missing, not licence to skip the primitive.

`assets/css/buttons.css` from the design-system export (`.btn`,
`.btn--primary/secondary/ghost/link/mono`) is **not yet wired into
`global.css`** — nothing on the live site currently duplicates a
generic CTA button badly enough to justify importing unused CSS. If a
future page needs one, wire it in then, matching `a.wk-launch`'s
existing `.btn--primary` styling rather than inventing a second one.

## Cascade + cache-busting

`global.css` imports, in order: `variables.css` → `layout.css` →
`components.css` → `wiki.css`, each with a `?v=N` query string that
**must be bumped** on any edit to that file (and `global.css`'s own
`?v=N` in `_layouts/default.html`'s `<link>` when `global.css` itself
changes, e.g. adding a new `@import`). GitHub Pages caches
aggressively; a stale `?v=` means the edit never reaches a visitor.

## Motion + reveal-selector sync

Reveal-on-scroll selector lists appear in four places that must stay
identical: the hidden-state and revealed-state blocks in
`components.css`, the no-JS failsafe block below them, and
`ABOVE_GATE_SELECTOR`/`BELOW_GATE_SELECTOR` in `assets/js/animations.js`.
Adding a new reveal-eligible element means editing all four.

## What NOT to touch here

`projects/apps/**` (see above), `_site/` (Jekyll build output,
gitignored), `.claude/` (working files, gitignored), anything matching
`.gitignore`'s AMF1/Aston-branded patterns.
