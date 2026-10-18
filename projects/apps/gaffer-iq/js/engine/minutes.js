/**
 * js/engine/minutes.js
 * Layer: engine (pure). No DOM, no network, no store mutation.
 * The minutes model's shared half (docs/decision-engine-plan.md Phase 4): the
 * features read from a player's contention record, and the chances the fitted
 * heads give him to appear, start and play 60 minutes in one fixture he is
 * available for. tools/minutes builds its training rows with these same
 * functions, so the app and the fit never disagree on what a feature means.
 *
 * Availability is not modelled here: it stays FPL's flag and its recovery
 * (projections.js), as no history of flags exists to fit it on.
 */

import { DECISION_ENGINE, MATCH_MINUTES } from '../config.js';
import { mean } from '../util.js';

/**
 * One gameweek of a player's record in which his club played.
 * @typedef {object} GwRecord
 * @property {number} gw
 * @property {number} fixtures      his club's matches that gameweek (2 in a double)
 * @property {number} minutes       summed over them
 * @property {number|null} starts   summed over them; null where the source has none
 */

/**
 * His features for a fixture, from his contention record before it (the
 * gameweeks his club played, an excused absence removed). A double counts per
 * fixture.
 *
 * @param {GwRecord[]} history  ascending
 * @param {{position: string, priceTenths: number}} player  his price now
 * @param {object} [settings]   DECISION_ENGINE.minutesFeatures
 * @returns {object|null}  null with fewer than settings.minHistoryGws gameweeks
 */
export function minutesFeatures(history, { position, priceTenths }, settings = DECISION_ENGINE.minutesFeatures) {
  if (history.length === 0 || history.length < settings.minHistoryGws) return null;
  const { short, mid, long } = settings.windows;
  const starts  = history.map(r => startShare(r, settings));
  const minutes = history.map(r => r.minutes / r.fixtures);
  const last = history.length - 1;
  // The runs still going at the end of his record: of gameweeks with no
  // minutes, and of gameweeks with 60 a fixture.
  const run = holds => {
    let length = 0;
    while (length < history.length && holds(minutes[last - length])) length++;
    return length;
  };

  return {
    startShort:   mean(starts.slice(-short)),
    startLong:    mean(starts.slice(-long)),
    startSeason:  mean(starts),
    appearMid:    mean(minutes.slice(-mid).map(m => (m > 0 ? 1 : 0))),
    minutesMid:   mean(minutes.slice(-mid)) / MATCH_MINUTES,
    startedLast:  starts[last],
    played60Last: minutes[last] >= settings.playedMinutes ? 1 : 0,
    zeroRun:      Math.log1p(run(m => m === 0)),
    fullRun:      Math.log1p(run(m => m >= settings.playedMinutes)),
    history:      Math.min(history.length, long) / long,
    def:          position === 'DEF' ? 1 : 0,
    mid:          position === 'MID' ? 1 : 0,
    fwd:          position === 'FWD' ? 1 : 0,
    price:        priceTenths,
  };
}

/** The share of a gameweek's fixtures he started; 60 minutes a fixture stands in where starts are missing. */
export function startShare(record, settings = DECISION_ENGINE.minutesFeatures) {
  if (Number.isFinite(record.starts)) return Math.min(1, record.starts / record.fixtures);
  return record.minutes / record.fixtures >= settings.playedMinutes ? 1 : 0;
}

/**
 * His chances, in one fixture he is available for, of appearing, starting and
 * playing 60 minutes: each the logistic of its head's intercept plus weighted
 * features. `ahead` gameweeks after the planning gameweek each head's logit z
 * reads as a + b z, with that gameweek's [a, b] from model.ahead (the last
 * pair past its end): his record says less about later gameweeks, so the
 * chances drift towards the average. A start or a 60-minute game is never
 * likelier than an appearance.
 *
 * @param {object} features  minutesFeatures output
 * @param {{appear: object, start: object, p60: object, ahead?: object}} model
 *   each head { intercept, <feature>: weight, ... }; ahead { <head>: [[a, b], ...] }
 *   for 1, 2, ... gameweeks ahead
 * @param {number} [ahead]   gameweeks after the planning gameweek
 * @returns {{appear: number, start: number, p60: number}}
 */
export function selectionChances(features, model, ahead = 0) {
  const chance = name => {
    let z = linear(model[name], features);
    const pairs = model.ahead?.[name];
    if (ahead > 0 && pairs?.length) {
      const [a, b] = pairs[Math.min(ahead, pairs.length) - 1];
      z = a + (b * z);
    }
    return 1 / (1 + Math.exp(-z));
  };
  const appear = chance('appear');
  return { appear, start: Math.min(appear, chance('start')), p60: Math.min(appear, chance('p60')) };
}

function linear(weights, features) {
  let z = 0;
  for (const [name, weight] of Object.entries(weights)) {
    if (name === 'intercept') {
      z += weight;
      continue;
    }
    const value = features[name];
    if (!Number.isFinite(value)) throw new TypeError(`minutes model: no value for feature "${name}"`);
    z += weight * value;
  }
  return z;
}

/**
 * The gameweeks of an absence that should not count against his record: his
 * latest run of zero-minute gameweeks when it is still running and he is
 * flagged now, or when it lasted at least absenceMinRunGws, ended within
 * absenceLookbackGws of his latest gameweek and he has played since (P8). A
 * running zero run while he is fit is a dropping, and counts.
 *
 * @param {Array<{gw: number, minutes: number}>} history  ascending gameweeks
 * @param {boolean} flaggedNow
 * @returns {Set<number>}
 */
export function excusedAbsence(history, flaggedNow) {
  let end = history.length - 1;
  while (end >= 0 && history[end].minutes > 0) end--;
  if (end < 0) return new Set();
  let start = end;
  while (start > 0 && history[start - 1].minutes === 0) start--;

  const run = history.slice(start, end + 1).map(h => h.gw);
  const running = end === history.length - 1;
  const excused = running
    ? flaggedNow
    : run.length >= DECISION_ENGINE.absenceMinRunGws
      && history.at(-1).gw - run.at(-1) <= DECISION_ENGINE.absenceLookbackGws;
  return excused ? new Set(run) : new Set();
}
