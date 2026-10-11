// Captures golden outputs from the LEGACY DOM-bound engine (tests/calculator.legacy.js,
// a frozen copy of calculator.js before the UI strip) by running its calculate()
// against a stub DOM. Run once: `node tests/capture-golden.js` → tests/golden.json.
// The pure engine must reproduce every number, verdict and breakdown row.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const here = __dirname;
const LEGACY = fs.readFileSync(path.join(here, 'calculator.legacy.js'), 'utf8');
// cmToFtIn lived in the legacy ui.js; calculator.js called it through the shared global scope.
// Supplied here with the one deliberate fix (round total inches first, so 182cm reads 6'0" not
// 5'12"). It only feeds breakdown labels, never a number.
const CM_TO_FTIN = `function cmToFtIn(cm) {
    const totalIn = Math.round(cm / 2.54);
    return \`\${Math.floor(totalIn / 12)}'\${totalIn % 12}"\`;
  }`;

function makeContext() {
  const els = Object.create(null);
  const el = id => els[id] || (els[id] = {
    id, value: '', textContent: '', innerHTML: '', isConnected: true, style: {},
    classList: { add() {}, remove() {} },
  });
  const ctx = vm.createContext({ document: { getElementById: el }, requestAnimationFrame: () => 0, Math, JSON });
  vm.runInContext(CM_TO_FTIN + '\n' + LEGACY, ctx);
  // Snap the number tween straight to its target so textContent holds the final value.
  vm.runInContext('animateNumber = (el, target) => { if (el) el.textContent = String(target); };', ctx);
  return { ctx, el };
}

const INPUT_IDS = ['baseAccel', 'baseSprint', 'baseAgility', 'heightCm', 'weight', 'strength', 'balance'];

// Pull { label, chips[] } rows back out of the legacy breakdown HTML.
function parseRows(html) {
  return html.split('<div class="breakdown-item"').slice(1).map(chunk => {
    const src = chunk.match(/<span class="source[^"]*">([^<]*)<\/span>/);
    const note = chunk.match(/<span style="color:var\(--muted\);[^"]*">([^<]*)<\/span>/);
    const chips = [...chunk.matchAll(/<span class="bd[^"]*"[^>]*>([^<]*)<\/span>/g)].map(m => m[1]);
    return src ? { label: src[1], chips } : { label: note[1], note: true, chips: [] };
  });
}

function runLegacy(state) {
  const { ctx, el } = makeContext();
  INPUT_IDS.forEach(id => { el(id).value = String(state[id]); });
  vm.runInContext('EXT_STAT_IDS', ctx).forEach(id => { el(id).value = String(state[id]); });
  ctx.__s = state;
  vm.runInContext(`accelType = __s.accelType; buildType = __s.buildType;
    activePS = new Set(__s.activePS); activeChem = __s.chemStyle || null; calculate();`, ctx);
  const num = id => +el(`num${id}Eff`).textContent;
  const flat = {
    effA: num('Accel'), effS: num('Sprint'), effG: num('Agility'), effT: num('Tenacity'), effSlip: num('Slip'),
    effPassShort: num('PassShort'), effPassLong: num('PassLong'), effPassThrough: num('PassThrough'), effPassCross: num('PassCross'),
    effDefTackle: num('DefTackle'), effDefPos: num('DefPos'), effDefInt: num('DefInt'), effDefAer: num('DefAer'), effDefBully: num('DefBully'), effDefSlide: num('DefSlide'),
    effShootFin: num('ShootFin'), effShootPwr: num('ShootPwr'), effShootFine: num('ShootFine'), effShootVol: num('ShootVol'), effShootLdr: num('ShootLdr'), effShootFk: num('ShootFk'),
  };
  const slipRows = parseRows(el('slipBreakdownList').innerHTML);
  const totalRow = slipRows.pop();
  return {
    state, flat,
    verdicts: {
      movement: el('verdictText').textContent, passing: el('passingVerdictText').textContent,
      defending: el('defendingVerdictText').textContent, shooting: el('shootingVerdictText').textContent,
    },
    rows: {
      movement: parseRows(el('breakdownList').innerHTML), passing: parseRows(el('passingBreakdownList').innerHTML),
      defending: parseRows(el('defendingBreakdownList').innerHTML), shooting: parseRows(el('shootingBreakdownList').innerHTML),
    },
    slip: { rows: slipRows.map(r => ({ label: r.label, chip: r.chips[0] })), total: +totalRow.chips[0] },
  };
}

// ── State corpus: defaults + every seed squad player + seeded random builds ──
const PS_KEYS = ['quickstep', 'rapid', 'technical', 'first_touch', 'trickster', 'enforcer', 'bruiser', 'press_proven', 'relentless',
  'aerial', 'incisive', 'pinged', 'long_ball', 'whipped', 'tiki_taka', 'outside_foot', 'intercept_ps', 'block', 'jockey',
  'anticipate', 'slide_tackle_ps', 'finesse', 'power_shot', 'chip_shot', 'dead_ball', 'first_time', 'low_driven',
  'game_changer', 'precision_header'];
const CHEMS = [null, 'basic', 'hunter', 'hawk', 'finisher', 'marksman', 'deadeye', 'sniper', 'catalyst', 'engine', 'artist',
  'architect', 'maestro', 'powerhouse', 'shadow', 'anchor', 'sentinel', 'guardian', 'gladiator', 'backbone'];
const EXT = ['shortPass', 'longPass', 'vision', 'crossing', 'curve', 'fkAccuracy', 'standTackle', 'slideTackle', 'interceptions',
  'headingAcc', 'defAwareness', 'aggression', 'jumping', 'finishing', 'shotPower', 'longShots', 'volleys', 'attPositioning',
  'composure', 'reactions', 'ballControl', 'dribbling', 'stamina'];
const DEFAULTS = { chemStyle: null, baseAccel: 80, baseSprint: 80, baseAgility: 80, heightCm: 183, weight: 80, strength: 70,
  balance: 75, accelType: 'controlled', buildType: 'normal', activePS: [], ...Object.fromEntries(EXT.map(k => [k, 70])) };

function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const rnd = mulberry32(2026);
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = arr => arr[Math.floor(rnd() * arr.length)];

function randomState() {
  const s = { ...DEFAULTS, chemStyle: pick(CHEMS), accelType: pick(['explosive', 'controlled', 'lengthy']),
    buildType: pick(['very_lean', 'lean', 'normal', 'stocky', 'very_stocky']),
    baseAccel: int(40, 99), baseSprint: int(40, 99), baseAgility: int(40, 99), heightCm: int(150, 210),
    weight: int(50, 120), strength: int(1, 99), balance: int(1, 99), activePS: [] };
  EXT.forEach(k => { s[k] = int(1, 99); });
  PS_KEYS.forEach(k => { const r = rnd(); if (r < 0.15) s.activePS.push(k); else if (r < 0.27) s.activePS.push(k + '_plus'); });
  return s;
}

function squadStates() {
  const ctx = vm.createContext({ window: {} });
  vm.runInContext(fs.readFileSync(path.join(here, '..', 'Squad_saves.js'), 'utf8'), ctx);
  const out = [];
  const walk = f => { (f.players || []).forEach(p => out.push({ ...DEFAULTS, ...p.state })); (f.subfolders || []).forEach(walk); };
  ctx.window.SQUAD_SAVES.folders.forEach(walk);
  return out;
}

const states = [DEFAULTS, ...squadStates()];
for (let i = 0; i < 500; i++) states.push(randomState());
// Hand-picked edges: every threshold boundary in the movement / slip / height rules.
[150, 170, 177, 178, 180, 183, 185, 188, 190, 210].forEach(h => states.push({ ...DEFAULTS, heightCm: h }));
[50, 64, 65, 70, 75, 80, 90, 91, 120].forEach(w => states.push({ ...DEFAULTS, weight: w }));
[81, 82, 88, 89, 99].forEach(a => states.push({ ...DEFAULTS, aggression: a }));

const golden = states.map(runLegacy);
fs.writeFileSync(path.join(here, 'golden.json'), JSON.stringify(golden));
console.log(`captured ${golden.length} cases`);
