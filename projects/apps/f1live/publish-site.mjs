// Copies the Vite build into the committed _site/ that jayjaybee.com serves (that Vercel project has
// no build step). Run via `npm run publish:site`, then commit _site/. A Jekyll rebuild of _site wipes
// this folder, so re-run it afterwards.
import { cpSync, existsSync, rmSync } from 'node:fs';

const from = new URL('./dist', import.meta.url);
const to = new URL('../../../_site/projects/apps/f1live', import.meta.url);
if (!existsSync(from)) throw new Error('dist/ missing: run `npm run build` first');
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
console.log('published dist/ to _site/projects/apps/f1live/');
