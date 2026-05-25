/**
 * js/engine/normalise.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 * Transforms raw FPL API payloads into the clean internal models:
 * Team, Player, Fixture (see ARCHITECTURE.md §8).
 * This is the ONLY file that reads raw FPL field names (e.g. element_type,
 * team_h_difficulty). Everything downstream speaks the internal model only.
 */

// TODO(phase-1): implement normaliseTeams(raw), normalisePlayers(raw),
// normaliseFixtures(raw), normalisePlayerSummary(raw, playerId)
