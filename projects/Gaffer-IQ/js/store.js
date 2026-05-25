/**
 * js/store.js
 * Layer: state. In-memory + sessionStorage cache. App-wide pub/sub.
 * Side effects: state mutation, sessionStorage reads/writes.
 * Modules communicate through store events, never directly with each other.
 * See ARCHITECTURE.md §6 (caching) and CONVENTIONS.md §8 (event naming).
 */

// TODO(phase-1): implement store: in-memory cache, sessionStorage mirror,
// subscribe/emit pub/sub, getActiveHorizon/setActiveHorizon, manual refresh flag
