#!/usr/bin/env node
/**
 * Validates a samples JSON file produced by fetch_session.py against the
 * shared TelemetryUpdate shape (../src/lib/telemetryShape.js,
 * ../docs/DATA_SHAPE.md). One-shot, exits 0 on success / 1 on failure —
 * run after every fetch, before wiring a new file into the adapter.
 *
 * Usage: node validate_output.mjs ../public/data/<slug>.json
 */

import { readFileSync } from 'node:fs';

const REQUIRED_FIELDS = {
  timestamp: (v) => typeof v === 'number' && Number.isFinite(v),
  speed: (v) => typeof v === 'number' && v >= 0 && v <= 400,
  throttle: (v) => typeof v === 'number' && v >= 0 && v <= 100,
  brake: (v) => typeof v === 'number' && v >= 0 && v <= 100,
  gear: (v) => Number.isInteger(v) && v >= -1 && v <= 8,
  rpm: (v) => typeof v === 'number' && v >= 0 && v <= 20000,
  drs: (v) => typeof v === 'boolean',
  lapDistance: (v) => typeof v === 'number' && v >= 0,
};

function validate(samples) {
  const errors = [];

  if (!Array.isArray(samples)) {
    return ['Top-level JSON must be an array of TelemetryUpdate samples.'];
  }
  if (samples.length === 0) {
    return ['Samples array is empty.'];
  }

  samples.forEach((sample, i) => {
    const keys = Object.keys(REQUIRED_FIELDS);
    for (const key of keys) {
      if (!(key in sample)) {
        errors.push(`sample[${i}]: missing field "${key}"`);
        continue;
      }
      if (!REQUIRED_FIELDS[key](sample[key])) {
        errors.push(`sample[${i}]: field "${key}" = ${JSON.stringify(sample[key])} out of range/type`);
      }
    }
    const extra = Object.keys(sample).filter((k) => !keys.includes(k));
    if (extra.length > 0) {
      errors.push(`sample[${i}]: unexpected extra field(s): ${extra.join(', ')}`);
    }
  });

  // Timestamps should be non-decreasing — a replay assumes chronological order.
  for (let i = 1; i < samples.length; i += 1) {
    if (samples[i].timestamp < samples[i - 1].timestamp) {
      errors.push(`sample[${i}]: timestamp goes backwards relative to sample[${i - 1}]`);
      break;
    }
  }

  return errors;
}

function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node validate_output.mjs <path-to-samples.json>');
    process.exit(1);
  }

  const raw = readFileSync(filePath, 'utf-8');
  const samples = JSON.parse(raw);
  const errors = validate(samples);

  if (errors.length > 0) {
    console.error(`✗ ${filePath} failed validation (${errors.length} issue(s)):`);
    for (const err of errors.slice(0, 20)) {
      console.error(`  - ${err}`);
    }
    if (errors.length > 20) {
      console.error(`  ...and ${errors.length - 20} more`);
    }
    process.exit(1);
  }

  console.log(`✓ ${filePath} — ${samples.length} samples, all match the TelemetryUpdate shape.`);
}

main();
