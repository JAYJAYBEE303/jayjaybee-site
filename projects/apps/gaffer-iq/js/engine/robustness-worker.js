/**
 * js/engine/robustness-worker.js
 * Layer: engine (module worker entry). Runs robustness() off the page's main
 * thread: each message is an engine input and its result's shortlist, each
 * reply the shares for them.
 */

import { robustness } from './robustness.js';
import { DECISION_ENGINE } from '../config.js';

self.onmessage = ({ data }) => self.postMessage(robustness(data.input, DECISION_ENGINE, data.result));
