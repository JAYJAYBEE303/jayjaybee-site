# Aston Martin Aramco F1 — Design System

A design system for the **Aston Martin Aramco Formula One™ Team** — a Silverstone-based F1 constructor competing in the FIA Formula One World Championship as **AMR GP Limited**, owned by Lawrence Stroll, with **Aramco** as exclusive title sponsor and **Honda** as works power-unit partner from 2026.

> "Driven by performance. Crafted with intent."
> The visual language is **prestige + engineering**: deep racing green carbon, glassy floating surfaces, brutal Flare display type, and a single high-voltage lime accent.

---

## Index — what's in this folder

| Path | What it is |
|---|---|
| `README.md` | This file. Brand context, content fundamentals, visual foundations, iconography. |
| `SKILL.md` | Agent Skill manifest — read this first if you're an LLM consuming the system. |
| `colors_and_type.css` | All design tokens (colors, type, spacing, radii, shadows, motion) + semantic styles. |
| `fonts/` | Aston Martin Flare + Aston Martin Sans TTFs (partial set — see "Font substitutions"). |
| `assets/` | Logos, livery imagery, partner marks, illustrative iconography. |
| `preview/` | Design-system preview cards (one per concept). Surfaces in the Design System tab. |
| `slides/` | Sample 16:9 slides built from `AMF1-2026-Template` style language. |
| `ui_kits/web/` | High-fidelity recreation of the public **astonmartinf1.com** marketing site. |
| `ui_kits/race-hub/` | Race-weekend live timing / pit-wall dashboard concept (telemetry-flavoured). |

---

## Sources used

- **Uploaded fonts** (in `uploads/`, copied into `fonts/`): `ASTONMARTINFLARE_BD/MD/XBD.TTF`, `ASTONMARTINSANS_LTIT/BDIT/XBDIT.TTF`.
- **Referenced (NOT uploaded — flagged below)**: `AMF1-2026-Template.potx`. The PowerPoint template was mentioned in the brief but the file did not appear in `uploads/`. Slide layouts in `slides/` are best-effort interpretations of the AMF1 2026 brand language and should be re-checked against the official template once provided.
- **Public reference**: astonmartinf1.com home + news pages, F1.com team page, the team's public Instagram handle, and the Wikipedia article on Aston Martin in Formula One. No code or Figma was attached.

---

## CONTENT FUNDAMENTALS

The team writes the way it races: **short, declarative, technical**. Sentences land like callouts on a pit-wall radio. Marketing copy borrows the cadence of motorsport telemetry — clipped phrases, full stops where commas would do, capitalised impact words.

### Voice
- **Confident, not loud.** "Mastery. Driven." not "We're the best."
- **Engineered, not poetic.** Verbs of precision: *engineered, formed, crafted, refined, calibrated, integrated*. Avoid soft verbs (*love, dream, imagine*) unless quoting a partner programme like Honda's *"Power of Dreams"*.
- **Heritage + future tension.** A 1959 racing lineage paired with "2026 demands a fresh approach." The brand is **historic AND on the front foot**.
- **British understatement.** Never breathless. A podium gets a sentence, not a paragraph.

### Person & address
- **Mostly third-person team voice** in announcements: *"Aston Martin Aramco Formula One Team are delighted to confirm…"*
- **Direct second-person** in calls to action: *"Make it yours."* / *"Discover more."* / *"Shop the new collection."*
- **First-person plural** is rare and reserved for moments of collective identity: *"we" only when speaking AS the team*.

### Casing & punctuation
- **TITLE-CASE / ALL-CAPS** for display headlines and CTAs (`SHOP NOW`, `EXPLORE`, `READ MORE`).
- **Sentence case** for body copy, news article bodies, captions.
- **Stop-driven sentences**: `Mastery. Driven.` `Formed with precision, worn with pride.` Use the period as percussion.
- **The slash brand mark**: the team uses **`I / AM`** (with surrounding spaces) for its membership/drops programme — preserve the exact spacing, never `I/AM` or `I-AM`.
- **The "+" connector**: "Aston Martin, Aramco **+** You" — the plus sign is used in headlines to mean "with"/"and"; reads as a stylistic upgrade over an ampersand.
- **Em-dash sparingly** for emphasis; never for lists.
- No Oxford comma in body copy; use it in lists of three or more nominal items where ambiguity would otherwise creep in.

### Numbers, stats, dates
- **Race-weekend dates** are written `DD MMM YYYY` (e.g. `23 Apr 2026`).
- **Numbers under 10** spelled out in body, numerals for stats and lap data.
- **Driver tags**: `Fernando Alonso, two-time World Champion` — descriptor follows the name, set off by commas.
- **Hashtags allowed** on social only: `#MiamiGP`, `#IAMF1`. Never in headline copy.

### Emoji
- **Not in headlines or marketing body.** The brand voice is too tailored.
- **Acceptable on social** with restraint — green heart 💚, racing flag 🏁, lime sparkle ✨ used 1× per post max.
- **Replace with logos/marks** wherever possible (the wings mark, the Aramco lockup, the AM letterform).

### Examples (from public surfaces)
- "Mastery. Driven."
- "Formed with precision, worn with pride."
- "2026 demands a fresh approach."
- "Aston Martin, Aramco + You."
- "Generation 3 is your chance to shine."
- "From exclusive collabs to once-in-a-lifetime prizes, I / AM DROPS is a series of unique and ultra-limited moments and fan experiences."

### Tone matrix — quick reference

| Surface | Register | Length | Caps |
|---|---|---|---|
| Hero headline | Imperative, percussive | 2–6 words | UPPER |
| Section title | Declarative | 3–8 words | UPPER |
| News headline | Reportorial, factual | 6–14 words | Sentence |
| News body | Plain technical English | Paragraph | Sentence |
| Stat / data label | Telemetric, abbreviated | 1–3 words | UPPER |
| CTA button | Verb + (object) | 1–3 words | UPPER |
| Partner mention | Formal lockup | Full title | Title Case |

---

## VISUAL FOUNDATIONS

The Aston Martin F1 visual language reads as **deep racing green carbon, brushed metal hairlines, and floating glass panels lit by a single lime accent**. It should feel like the inside of a hospitality suite at Silverstone at dusk — quiet, low-lit, and very expensive — not a loud sports broadcast.

### Colour
- **Aston Martin Racing Green** (`#00352F`) is the **primary** background and primary brand mark colour. Almost everything sits on green or near-black.
- **Onyx / Carbon** (`#0A0F0E` / `#14201E`) — secondary surface for cards, modals, panels on top of green; warmer than pure black so it tonally relates.
- **Aramco Lime** (`#CEDC00`) — single high-voltage accent. **Use as an accent, never a fill for large surfaces.** Reserved for CTAs, key data points, the active state, the live-timing pulse, the "drop" callout, the underline beneath a hero headline.
- **Podium Teal / Bright Teal** (`#006F62`, `#00A39A`) — secondary accent, used for data-viz and "engineering" surfaces (telemetry, charts, technical readouts). Never compete with lime.
- **Neutron White** (`#FFFFFF`) — type colour on green. Use white on green almost exclusively; black-on-green is too low-contrast.

**Usage proportions** on a typical screen: ~70% racing-green / onyx, ~25% white type, ~3% teal, ~2% lime. The lime should feel earned.

**Contrast**: text colour is `--fg-1` (white) or `--fg-on-lime` (onyx). Never put lime type on green — the contrast is awful and the colours fight.

### Typography
- **Aston Martin Flare** is the display face — a flared sans with humanist proportions, similar in feel to Optima/Frutiger Serif. Used for **headlines, section titles, stat numerals, eyebrows in caps**. Always weight 500/700/800. Almost always uppercase at display sizes; mixed case only at h3 and below.
- **Aston Martin Sans (italic)** is the body face. The files we have are italic-only (Light Italic, Bold Italic, X-Bold Italic). The italic adds forward motion — appropriate to a racing brand — and we lean into it for all body copy and captions. When a roman feel is required, fall back to Inter.
- **Letter-spacing**: tight on display (-0.02em), open on caps eyebrows (+0.18em). Never auto-tracked.
- **Numerals**: tabular for any data display (lap times, sector times, gap, position). Flare numerals are proportional by default — switch to a mono fallback for live timing.

### Backgrounds
- **Default**: solid racing green (`#00352F`) or onyx, NOT gradients.
- **Hero moments**: full-bleed photography of the car or driver, dark-graded (cool, slightly desaturated, deep shadows), with a black→transparent **protection gradient** at top and bottom for type legibility. Never crop the car tightly — let it breathe.
- **Pattern accents**: a **carbon-weave macro texture** at very low opacity (≤8%) on hero sections; thin **hairline grids** (1px white at 6% opacity) behind data panels. Both used as garnish, never wallpaper.
- **No painterly gradients, no purple→pink, no rainbow.** Single-direction subtle vignettes at most (radial dark to keep eye centred).

### Imagery character
- **Photography is cool, contrasty, slightly desaturated**, with deep shadows and lifted greens.
- **Pit-lane and on-track shots** dominate — mechanic hands, telemetry screens, helmet detail, suit textures.
- **Studio shots** of the car use a black or near-black sweep and rim-light the body in lime/teal LED.
- **No stock photography. No people-in-meeting-rooms B-roll.** If a real photo isn't available, use a placeholder rectangle in `--amf1-grey-800` with an `AM` mark — never an emoji.

### Spacing & layout
- **4px base grid.** All spacing tokens are multiples (`--s-1` … `--s-13`).
- **Generous outer padding** on marketing surfaces — never let content kiss the viewport edge. Use `--s-8` (40px) minimum on desktop, `--s-5` (20px) on mobile.
- **Strict modular grid**: 12-column with 24px gutters on desktop. Snap aggressively.
- **Asymmetric hero compositions**: large image bleeds 60–70% of viewport, type sits in the remaining gutter, heavily left-aligned. Symmetry is reserved for results / standings tables.
- **Fixed elements**: a thin top nav (60px) + occasional bottom timing strip on race-day surfaces. Don't fix sidebars — the brand reads cinematic, not dashboard-heavy.

### Borders & hairlines
- **1px hairlines** at low alpha (`--border-1` = white @ 10%) separate sections.
- **2px lime under-rule** marks active nav items and sometimes underlines a hero headline.
- **No coloured left-border accent cards.** That pattern is forbidden — it reads SaaS, not racing.

### Corner radii
- **Predominantly small** (`--r-2` 4px, `--r-3` 8px) on cards, inputs, and modals. The brand is technical, not friendly.
- **Pills** (`--r-pill`) only on tags, status chips, and small filter buttons.
- **Sharp corners** (0px) are also valid for edge-of-screen full-bleed panels and stat tiles.
- **Never `--r-4` or larger** on functional UI — that's iOS-bubbly and wrong.

### Shadows & elevation
- Two shadow systems coexist:
  1. **Tactile** (`--shadow-1` … `--shadow-3`) — soft drops on dark grounds with a white inset top-edge to imply a beveled, glass-edge highlight.
  2. **Glow** (`--shadow-lime-glow`, `--shadow-teal-glow`) — used **once per screen at most**, around the most important CTA or live indicator, to feel "lit from within".
- Inset highlights matter: every glass card has a 1px top inner-stroke at white @ 4–6% to imply a lit edge.

### Glass & blur
- **Floating panels** use `backdrop-filter: blur(14px) saturate(140%)` on top of the racing-green background. The glass should pass colour through (~6–10% white tint) so the green still reads.
- Use glass for: drop-down menus, the top nav at scroll, hover cards, side sheets, race-weekend timing widgets.
- Don't stack glass on glass — at most one layer of glass over a solid surface.

### Cards
- Default card: `--bg-glass` (white @ 6%) with `--border-1` 1px stroke, `--r-3` (8px) radius, `--shadow-2`.
- Hover: lift to `--shadow-3`, border to `--border-2`, no scale (cars don't scale; they accelerate).
- Active/pressed: drop one elevation level, no scale.
- **No "spotlight" gradients**, no glow on hover (reserve glow for CTAs).

### Hover & press states
- **Hover (default)**: increase brightness by ~6% (lighter overlay), or strengthen border. Never colour-shift the surface.
- **Hover on lime CTA**: shift to `--amf1-lime-hi` (`#E2F000`) — slightly more chromatic, slightly brighter.
- **Press**: lower elevation by one step, no scale transform. Avoid shrink-on-press; F1 doesn't shrink, it transitions.
- **Focus**: 2px lime outline at `outline-offset: 2px`. Never blue/native — always lime.

### Motion & easing
- **Easing**: `cubic-bezier(0.22, 1, 0.36, 1)` (out-quart) for entrances; in-out cubic for transitions. **No bounce, ever** — a racing brand does not boing.
- **Durations**: 120ms for micro (hover), 200ms for state changes, 320ms for panel transitions, 480ms only for hero / page-level reveals.
- **Hero motion**: car photography has slow Ken-Burns drift + opacity fade-in over 600–800ms.
- **Hover transitions**: opacity, border-colour, transform: translateY(-2px) on cards. Never rotate, never bounce.
- **Loading states**: a thin lime shimmer/sweep (left-to-right, 1.2s linear infinite) — no spinner emoji, no spinning circles unless on telemetry.

### Transparency & blur usage
- Use blur **only for floating UI** (nav, menus, side sheets, modals on dark photo).
- Use transparency in **protection gradients** behind hero text (black → 0% over 240px from top/bottom).
- Don't use translucency on body text or icons — text is fully opaque white at the relevant emphasis level.

### Iconography stance
See `ICONOGRAPHY` below.

### Anti-patterns (do NOT)
- Bluish-purple gradients
- Rounded chunky cards with coloured left border
- Emoji in product/marketing UI
- Drop shadows that look like cardboard cutouts (offset > 4px without blur)
- "Friendly" rounded buttons
- Centre-aligned long-form copy
- Inflating lime to >5% of any composition
- Two accent colours competing (lime AND teal both highlighted) — pick one per surface

---

## ICONOGRAPHY

The team's iconography is **deliberately minimal** — most icons in marketing surfaces are replaced with **logo lockups, partner marks, or the AM wings**. Functional product UI (apps, dashboards, the website chrome) uses a **light/regular line-icon system** — Lucide is the closest CDN match to what's seen on the site.

### Approach
- **Logos > icons.** The brand expresses itself through marks (the AM wings, the Aramco wordmark, the Honda red), not stock UI symbols. Where possible, use a partner logo instead of a generic icon (e.g. the Aramco mark instead of a "fuel" icon, the Honda mark instead of an "engine" icon).
- **Functional icons** (chevrons, search, hamburger, close, share, play) come from **Lucide** at stroke 1.5, size 20px or 24px. Stroke colour is `--fg-1` for inactive and `--amf1-lime` for active/hovered.
- **No filled-shape icons** in chrome. If you need a filled feel, use a 1px stroked icon inside a `--bg-glass` rounded square.
- **No emoji in product UI.** On social, sparingly (see CONTENT FUNDAMENTALS).
- **Unicode marks** are acceptable for typography: `™` (after "Formula One™"), `®` (after "Formula 1®"), the divisional slash in `I / AM`.
- **No hand-drawn SVG illustrations.** This brand does not do squiggle.

### What's in `assets/`
- `assets/logos/wings.svg` — the AM wings mark, single-colour (lime + green variants).
- `assets/logos/wordmark.svg` — the AMR GP wordmark.
- `assets/logos/aramco.svg` — Aramco partner lockup placeholder.
- `assets/logos/honda.svg` — Honda partner mark placeholder.
- `assets/livery-placeholder.svg` — placeholder for the AMR26 hero crop.

> **Honest disclosure**: where official partner logos couldn't be sourced as licensed files, we ship simple typographic placeholders in the same colour palette and shape to indicate where the real lockup goes. Replace these with the licensed vector files before any external use.

### Icon CDN
Use Lucide via CDN:
```html
<script src="https://unpkg.com/lucide@latest/dist/umd/lucide.min.js"></script>
<i data-lucide="chevron-right"></i>
<script>lucide.createIcons();</script>
```
Then style with `stroke-width: 1.5; color: currentColor; width: 20px; height: 20px`.

---

## Font substitutions (open issue — please update)

The uploaded font set is **incomplete**:
- `Aston Martin Flare` — we have **Md, Bd, XBd** (no Light, no Regular).
- `Aston Martin Sans` — we have **Lt-Italic, Bd-Italic, XBd-Italic only** (no roman/upright weights).

What this means in practice:
1. **Display headlines (Flare)** are fine — we have the heavy weights we'd reach for.
2. **Body copy (Sans)** is forced italic, which is on-brand for short copy but readable long-form is a problem. The CSS falls back to **Inter** for any context that requires a roman body.

**Action requested**: please upload the missing weights — at minimum `AstonMartinSans-Regular`, `AstonMartinSans-Bold`, and ideally a Flare regular/light — so we can drop the Inter fallback.

The `AMF1-2026-Template.potx` file referenced in the brief was not found in `uploads/` — please re-attach it via the Import menu so we can extract its layouts, masters, and embedded assets.
