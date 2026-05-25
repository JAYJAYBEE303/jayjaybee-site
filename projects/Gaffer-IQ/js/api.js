/**
 * js/api.js
 * Layer: data access. The ONLY file in the app that calls fetch().
 * Calls the Vercel proxy (/api/fpl?path=…) and returns parsed JSON.
 * Side effects: network I/O. No DOM, no store mutation.
 * See ARCHITECTURE.md §5 (proxy) and §6 (fetch strategy).
 */

// TODO(phase-1): implement fetchBootstrap, fetchFixtures, fetchPlayerSummary, fetchLive
