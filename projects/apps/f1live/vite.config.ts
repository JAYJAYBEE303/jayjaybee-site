import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Assets load from /projects/apps/f1live/ so the jayjaybee.com rewrite can route them.
// This project's vercel.json maps that prefix back to / so the direct vercel.app link still works.
export default defineConfig({ base: '/projects/apps/f1live/', plugins: [react()] });