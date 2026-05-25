/**
 * js/modules/matchup.js
 * Layer: module. Owns the DOM for the Matchup Analyser view.
 * Side effects: DOM writes only. Reads from store; calls engine functions.
 * Renders one fixture from both teams' perspectives — the full CompositeScore
 * breakdown, counter-matchup pairings, confidence, and official FPL FDR comparison.
 * See ARCHITECTURE.md §10 and ROADMAP.md Phase 1C.
 */

// TODO(phase-1): implement renderMatchup(fixtureId), buildMatchupCard(score),
// fixture picker, handle store data:ready and horizon:changed events
