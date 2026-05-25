# Gaffer IQ

A personal Fantasy Premier League (FPL) analysis tool that replaces the official app's blunt 1–5 Fixture Difficulty Rating with a composite, multi-factor matchup score. All analytical logic runs in the browser; one Vercel serverless function acts as a CORS proxy to the FPL API.

## Local development

**Option A — `vercel dev` (recommended; full stack including the proxy function):**

```bash
cd projects/gaffer-iq
vercel dev
```

Open `http://localhost:3000`. The `/api/fpl` proxy function is live, so FPL data loads correctly.

**Option B — `npx serve` (static files only; proxy unavailable):**

```bash
cd projects/gaffer-iq
npx serve .
```

Open `http://localhost:3000`. API calls will fail because the proxy is not running, but the app shell and ES module import chain can be verified.

## Deploy

Push to the repository. Vercel is configured with the root directory set to `projects/gaffer-iq/`. There is no build step — files are served exactly as authored.

## Documentation

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — system design, file structure, layering rules
- [`FEATURE_ENGINE.md`](FEATURE_ENGINE.md) — every metric, formula, weight, and constant
- [`CONVENTIONS.md`](CONVENTIONS.md) — coding standards, naming, commenting
- [`ROADMAP.md`](ROADMAP.md) — phased build plan with exit criteria
