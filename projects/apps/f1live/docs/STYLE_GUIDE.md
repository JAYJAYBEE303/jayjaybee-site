# Style guide

Design tokens live in [`src/styles/tokens.css`](../src/styles/tokens.css);
base element rules built on them live in
[`src/styles/global.css`](../src/styles/global.css). This doc explains the
reasoning, not just the values — read `tokens.css` for the exact numbers.

**Direction, flagged for review:** the choices below (amber-on-graphite,
Space Grotesk + IBM Plex Mono, sharp small-radius panels) are a first pass
for Chapter 0 scaffolding, not a signed-off brand. Nothing downstream
depends on these specific values — only on the *token names* — so they're
cheap to revise once there's a real visual direction to sign off on.

## Colour

Reference point: an engineer's timing-tower / dashboard, not a generic SaaS
card kit.

- **Base surfaces** (`--color-bg`, `--color-surface`, `--color-surface-raised`)
  are graphite/near-black rather than flat `#000` — three steps so panels
  read as layered without needing drop shadows.
- **Accent** (`--color-accent`, amber `#f2a63d`) stands in for pit-lane /
  timing-tower signage. Used sparingly — active nav state, focus rings — not
  as a wash or gradient.
- **Data-series colours** (`--color-data-*`) are kept separate from the
  brand accent on purpose: throttle/brake follow the real motorsport
  convention of green/red pedal traces, and `--color-data-fastest` (purple)
  follows F1's own fastest-sector broadcast convention. Charts should pick
  colours from this group, never from the accent group.

## Type

Two families, distinct roles:

- `--font-ui` (Space Grotesk) — headings, nav, body copy. Geometric,
  technical character without being a mono face for everything.
- `--font-data` (IBM Plex Mono) — anything showing a live-updating number
  (`class="data-value"`). Tabular figures (`font-variant-numeric:
  tabular-nums`) so digits don't jitter in width as values change.

Both are loaded via Google Fonts `<link>` tags in `index.html`, with system
fallbacks in the token values in case that request fails.

Type scale is a simple modular set, `--font-size-xs` (12px) through
`--font-size-2xl` (40px) — see `tokens.css` for the full list. Headings use
`--line-height-tight`; body copy uses the more readable `--line-height-base`.

## Layout & spacing

4px-based spacing scale (`--space-1` … `--space-16`). Panels are separated
with a 1px `--color-border` hairline by default; `--shadow-overlay` is
reserved for genuinely floating/overlay surfaces, not every card, to avoid
the "identical rounded card + soft grey shadow" look.

## Radii

Small and sharp — `--radius-sm` (2px) / `--radius-md` (4px) — instrument
panels rather than rounded SaaS cards.

## Motion

`--duration-fast` / `--duration-base` / `--duration-slow` and
`--ease-standard` / `--ease-out` exist now for later chart-update and
route-transition animation; nothing in Chapter 0 uses more than the fast
hover transition on nav links. `prefers-reduced-motion: reduce` is respected
globally in `global.css`.

## Adding a token

If a new component needs a colour, size, or timing value: check whether an
existing token already fits before adding one. Add new tokens to
`tokens.css` only, grouped with their category, and reference them by name
everywhere else — no literal hex/px/ms values in component CSS.
