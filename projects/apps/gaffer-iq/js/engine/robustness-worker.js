/**
 * js/engine/robustness-worker.js
 * Layer: engine (module worker entry). Runs the engine's robustness off the page's main thread. Two messages in, the
 * reply for each out:
 *   { input, result }  ->  robustness(input, ..., result)'s shares for the engine's shortlist
 *   { kind: 'rescore', input, modeId, weights, candidates, pickKey, key }  ->  { kind: 'rescore', key, share }
 * The second is the solver's pick re-scored against its alternatives on the same noisy copies (solver/rescore.js);
 * `key` is the card's, handed back so the page lands the share on the card it was computed for.
 */

import { robustness } from './robustness.js';
import { pickBeatsAlternatives } from './solver/rescore.js';
import { DECISION_ENGINE } from '../config.js';

/** One message's reply. */
export function handle(data) {
  if (data.kind === 'rescore') {
    const { input, modeId, weights, candidates, pickKey, key } = data;
    return { kind: 'rescore', key, share: pickBeatsAlternatives(input, DECISION_ENGINE, modeId, weights, candidates, pickKey) };
  }
  return robustness(data.input, DECISION_ENGINE, data.result);
}

// The page's glue; there is no worker scope in Node, where the tests call handle.
if (globalThis.WorkerGlobalScope) self.onmessage = ({ data }) => self.postMessage(handle(data));
