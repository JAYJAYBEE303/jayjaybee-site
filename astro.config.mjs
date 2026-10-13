import { defineConfig } from 'astro/config';

// Static build served by Vercel. /projects/apps/* are separate Vercel projects
// reached through vercel.json rewrites; nothing under that path is built here.
export default defineConfig({
  site: 'https://jayjaybee.com',
  build: { inlineStylesheets: 'never' }
});
