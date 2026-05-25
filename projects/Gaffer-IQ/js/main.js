/**
 * js/main.js
 * Layer: entry point. Bootstrap only — imports modules, reads the URL hash to
 * pick the active view, wires the nav and horizon switcher, and subscribes to
 * store events. Contains no analytical logic and no per-module rendering.
 * See ARCHITECTURE.md §4 for the module loading strategy.
 */

import { HORIZONS } from './config.js';

// TODO(phase-1): import { store } from './store.js';
// TODO(phase-1): import { fetchBootstrap, fetchFixtures } from './api.js';
// TODO(phase-1): import './modules/matchup.js';
// TODO(phase-1): import './modules/ranker.js';
// TODO(phase-1): import './modules/dashboard.js';
// TODO(phase-1): import './modules/planner.js';

// Phase 0 confirmation: verifies the ES module graph resolves and config
// constants are importable. Remove this log when Phase 1 init runs.
console.log('[Gaffer IQ] Phase 0 scaffold — horizons:', Object.keys(HORIZONS));
