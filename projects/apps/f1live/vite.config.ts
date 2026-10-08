import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base: the app is served at its own root and behind /projects/apps/f1live/ (proxy rewrite).
export default defineConfig({ base: './', plugins: [react()] });
