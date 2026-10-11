// Golden-output tests: the pure engine in calculator.js must reproduce the legacy
// DOM-bound calculate() exactly (numbers, verdicts, breakdown rows) and leave
// recalcEffStats() unchanged. Run: `node --test tests/`
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const golden = require('./golden.json');
const E = require('../calculator.js');

const sign = v => (v >= 0 ? '+' : '') + v;
// Render engine rows into the legacy chip text so they compare 1:1 with the snapshot.
const asLegacy = rows => rows.map(r => r.note
  ? { label: r.label, note: true, chips: [] }
  : { label: r.label, chips: r.chips.map(c => `${c.k} ${r.base ? c.v : sign(c.v)}`) });
// The console also lists Press Proven / First Touch slip bonuses (already in the
// legacy total, just never itemised there) — compare the rest row-for-row.
const legacySlipRows = rows => rows
  .filter(r => !/^(Press Proven|First Touch)/.test(r.label))
  .map(r => ({ label: r.label, chip: r.base ? String(r.v) : (r.v > 0 ? '+' : '') + r.v }));

test('calculator.js is UI-free', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'calculator.js'), 'utf8');
  assert.doesNotMatch(src, /\bdocument\b|\bwindow\.document\b|innerHTML|getElementById/);
});

test(`computeFeel matches legacy calculate() on ${golden.length} builds`, () => {
  golden.forEach((g, i) => {
    const r = E.computeFeel(g.state);
    const where = `case ${i}`;
    assert.deepEqual(r.flat, g.flat, `${where} flat`);
    assert.deepEqual(r.verdicts, g.verdicts, `${where} verdicts`);
    for (const k of ['movement', 'passing', 'defending', 'shooting']) {
      assert.deepEqual(asLegacy(r.rows[k]), g.rows[k], `${where} ${k} rows`);
    }
    assert.deepEqual(legacySlipRows(r.slip.rows), g.slip.rows, `${where} slip rows`);
    assert.equal(r.slip.total, g.slip.total, `${where} slip total`);
    assert.ok(Math.abs(r.slip.rows.reduce((a, x) => a + x.v, 0) - r.slip.total) <= 1, `${where} slip rows sum`);
  });
});

test('recalcEffStats is unchanged', () => {
  golden.forEach((g, i) => assert.deepEqual(E.recalcEffStats(g.state), g.recalc, `case ${i}`));
});

test('computeFeel fills missing fields from defaults', () => {
  assert.deepEqual(E.computeFeel({}).flat, golden[0].flat);
});
