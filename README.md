# jayjaybee.com

Josh Bailey's portfolio. Astro, static output, deployed on Vercel.

```sh
npm install
npm run dev       # http://localhost:4321
npm run build     # -> dist/
npm run preview
```

- `src/data/*.json` - all copy: roles and about (`content.json`), project write-ups (`wiki.json`), the AI thesis (`thesis.json`).
- `src/lib/site.js` - turns that copy into what each page renders.
- `src/pages/` - home, `/work/<role>/`, `/projects/`, `/projects/wiki/<app>/[<section>/]`, `/ai-thesis/`.
- `src/styles/site.css` - the one stylesheet; design tokens on `:root`.
- `src/scripts/engine.js` - page transitions, shared-element flights, scroll reveals.
- `projects/apps/` - standalone apps, each its own Vercel project (see `CLAUDE.md`).
