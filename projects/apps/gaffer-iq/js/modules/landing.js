/**
 * js/modules/landing.js
 * Layer: module (owns the DOM). No analytical logic, no network beyond the
 * GSAP import below.
 * Renders the landing route at /projects/apps/gaffer-iq/ — the "Matchnight
 * Scoreboard" front page, ported from the design export's
 * FINAL - Landing page.html. Markup in index.html, styles in css/landing.css.
 *
 * Presentational: every fixture and score on the board is a fixed sample. This
 * file owns
 *   1. the split-flap scoreboard (cascade, ticker picker, auto-rotation, sound),
 *   2. the hanging-board physics loop (tilt spring, sway, press, light tracking),
 *   3. the intro timeline, and the exit/enter transition to and from a module,
 *   4. one live value — the gameweek named in the ticker tag.
 *
 * GSAP is loaded with a dynamic import from the CDN, so a blocked or slow CDN
 * costs only the intro: the board still runs, and nothing else in the app
 * waits on it. See ARCHITECTURE.md §4.
 *
 * Hiding the app chrome is NOT done here — layout.css derives it from the
 * markup alone, so it survives first paint.
 *
 * Store subscriptions:
 *   route:changed — first entry runs the intro; a later return plays the exit
 *                   back in and re-measures the board.
 *   data:ready    — fills in the real gameweek number.
 */

import { store } from '../store.js';
import { bandFromValue } from '../engine/composite.js';

const MODULE_KEY = 'landing';
const GSAP_URL = 'https://cdn.jsdelivr.net/npm/gsap@3.12.5/index.js';

/** How long the intro waits for GSAP and for Anton before starting anyway. */
const GSAP_WAIT_MS = 1500;
const FONT_WAIT_MS = 700;

/* ---- scoreboard tuning: change feel here ---- */
const CFG = {
  tiltY: 9, tiltX: 6,               // max tilt toward the cursor (deg). Y auto-reduces so the far edge never leaves the viewport
  stiffness: 48, damping: 12.5,     // tilt spring (1/s², 1/s) — ζ≈0.9: weighty, one soft settle
  swayDeg: .12, swayTwist: .32, swayPeriod: 6.2,   // idle pendulum: roll + twist (deg), period (s)
  kickDeg: .45, kickTwist: .9, kickDecay: 2.2,     // extra sway after a press/landing, decays with τ (s)
  driftY: 2.2, driftX: 1.1,         // touch: autonomous drift (deg), periods 11s / 17s
  pressZ: -10,                      // press depth (px)
  flipStep: 56, flipFinal: 240,     // ms per intermediate flip / final flip (with overshoot)
  stagger: 70,                      // ms between tiles in a cascade
  maxSteps: 7,                      // max drum steps before landing
  cycle: 7000,                      // auto-advance (ms)
};

const NAME = { excellent: 'Excellent', great: 'Great', good: 'Good', neutral: 'Neutral', tough: 'Tough', brutal: 'Brutal' };
const TEAM = {
  ARS: 'Arsenal', FUL: 'Fulham', SUN: 'Sunderland', BUR: 'Burnley', LIV: 'Liverpool', WHU: 'West Ham',
  TOT: 'Spurs', BHA: 'Brighton', NEW: 'Newcastle', BRE: 'Brentford', BOU: 'Bournemouth', MUN: 'Man Utd',
  CHE: 'Chelsea', EVE: 'Everton', WOL: 'Wolves', LEE: 'Leeds', MCI: 'Man City', NFO: "Nott'm Forest",
  AVL: 'Aston Villa', CRY: 'Crystal Palace',
};
/** Per-metric offsets from the home composite, cycled across the samples. */
const OFF = [[-2, 9, -6, 7, 0, -8], [-6, 5, -3, 4, 2, -2], [3, -7, 6, -4, 5, -3], [5, -4, 8, -7, 3, -5]];
/** [home, away, homeScore, awayScore, metricOffsets, homeName] */
const FX = [
  ['NEW', 'BRE', 72, 41], ['ARS', 'FUL', 81, 30], ['MCI', 'NFO', 88, 22], ['LIV', 'WHU', 77, 36],
  ['CHE', 'EVE', 69, 44], ['AVL', 'CRY', 58, 52], ['TOT', 'BHA', 51, 55], ['BOU', 'MUN', 47, 60],
  ['WOL', 'LEE', 49, 50], ['SUN', 'BUR', 54, 48],
].map((f, i) => f.concat([OFF[i % OFF.length], TEAM[f[0]]]));
const ML = [['Base difficulty', 'Base'], ['Counter-matchup', 'Counter'], ['Team form', 'Form'], ['Home/away', 'Venue'], ['Style clash', 'Style'], ['Head-to-head', 'H2H']];

const NB = ' ';
const DIG = '0123456789';
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const EXIT_TARGETS = '.top,.ticker,#rig,#hang,#cast,.lights,.headline .ln>span,.intro > *,.modules,.mod,.foot';

const RM = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const FINE = window.matchMedia('(hover:hover) and (pointer:fine)').matches;

const $ = id => document.getElementById(id);
const noop = () => {};
const clamp = v => Math.max(-1, Math.min(1, v));
const pad = n => (n < 10 ? '0' : '') + n;
const fdrOf = s => Math.min(5, Math.max(1, Math.round(5 - (s - 20) / 20)));
const later = (fn, ms) => { if (RM || ms <= 0) fn(); else setTimeout(fn, ms); };

let root = null;
let gsap = null;
let started = false;
let introTl = null;
let exitTl = null;
let leaving = false;

// Board state, filled by buildBoard().
let el = {};
let tks = [];
let hc, ac, hs, as, ms, fd;
let cur = 0;
let paused = false;
let hold = false;
let onscreen = true;
let timer = 0;

/* ─── Click audio: off by default, created only on the user's own click ──── */

const snd = { on: false, ctx: null, buf: null, last: 0 };

function sndInit() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return false;
  snd.ctx = new AC();
  const n = Math.floor(snd.ctx.sampleRate * .018);
  const b = snd.ctx.createBuffer(1, n, snd.ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 6);
  snd.buf = b;
  return true;
}

function click(fin) {
  if (!snd.on || !snd.ctx || document.hidden) return;
  const t = snd.ctx.currentTime;
  if (t - snd.last < .016) return;
  snd.last = t;
  const s = snd.ctx.createBufferSource(), f = snd.ctx.createBiquadFilter(), g = snd.ctx.createGain();
  s.buffer = snd.buf;
  s.playbackRate.value = .85 + Math.random() * .3;
  f.type = 'bandpass';
  f.frequency.value = fin ? 1700 : 2900;
  f.Q.value = 1.3;
  g.gain.value = fin ? .08 : .04;
  s.connect(f); f.connect(g); g.connect(snd.ctx.destination);
  s.start(t);
}

/* ─── Split-flap tiles ──────────────────────────────────────────────────────
   Static top (next) + static bottom (current) + one hinged leaf (front:
   current top, back: next bottom). */

function setAll(c, ch) {
  c._v = ch;
  c._st.textContent = c._sb.textContent = c._lf.textContent = ch;
  c._lb.textContent = NB;
}

function tile() {
  const c = document.createElement('span');
  c.className = 'flap';
  c.innerHTML = '<span class="h t"><i></i><s></s></span><span class="h b"><i></i><s></s></span><span class="leaf"><span class="h t"><i></i><s></s></span><span class="h t bk"><i></i><s></s></span></span>';
  const i = c.getElementsByTagName('i');
  c._st = i[0]; c._sb = i[1]; c._lf = i[2]; c._lb = i[3];
  c._s = c.getElementsByTagName('s');
  c._leaf = c.lastChild;
  c._q = Promise.resolve();
  c._n = 0;
  setAll(c, NB);
  return c;
}

function group(id, n) {
  const g = $(id);
  for (let k = 0; k < n; k++) g.appendChild(tile());
  return Array.from(g.children);
}

/** Resolve even if the animation clock is throttled (background tab) so the board never sticks. */
function settle(a, d) {
  return Promise.race([a.finished.catch(noop), new Promise(r => setTimeout(r, d + 160))]);
}

function flipOnce(c, ch, d, fin) {
  const old = c._v;
  c._v = ch;
  if (RM || !d || !c.animate) { setAll(c, ch); return Promise.resolve(); }
  c._st.textContent = ch; c._lf.textContent = old; c._lb.textContent = ch;
  const L = fin ? .7 : 1, o = { duration: d, fill: 'forwards' }, s = c._s;
  const leafK = fin
    ? [{ transform: 'rotateX(0deg)', easing: 'cubic-bezier(.5,0,.85,.45)' }, { transform: 'rotateX(-180deg)', offset: .7, easing: 'cubic-bezier(.2,.7,.4,1)' }, { transform: 'rotateX(-167deg)', offset: .85, easing: 'cubic-bezier(.5,0,.75,.5)' }, { transform: 'rotateX(-180deg)' }]
    : [{ transform: 'rotateX(0deg)', easing: 'cubic-bezier(.45,0,.9,.55)' }, { transform: 'rotateX(-180deg)' }];
  const backK = fin
    ? [{ opacity: .7 }, { opacity: .7, offset: .35 }, { opacity: 0, offset: .7 }, { opacity: .18, offset: .85 }, { opacity: 0 }]
    : [{ opacity: .7 }, { opacity: .7, offset: .5 }, { opacity: 0 }];
  const A = [
    c._leaf.animate(leafK, o),
    s[0].animate([{ opacity: .6 }, { opacity: 0, offset: L * .65 }, { opacity: 0 }], o),        // next-top emerges from under the leaf
    s[1].animate([{ opacity: 0 }, { opacity: .55, offset: L }, { opacity: fin ? .3 : .55 }], o), // current-bottom falls into the leaf's shadow
    s[2].animate([{ opacity: 0 }, { opacity: .75, offset: L * .5 }, { opacity: .75 }], o),      // leaf front darkens as it turns away from the lights
    s[3].animate(backK, o),                                                                     // leaf back brightens as it lands
  ];
  setTimeout(() => { c._sb.textContent = ch; click(fin); }, d * L);
  return settle(A[0], d).then(() => {
    c._lf.textContent = ch; c._sb.textContent = ch; c._lb.textContent = NB;
    A.forEach(a => a.cancel());
  });
}

function enqueue(c, ch, d, fin) {
  c._n++;
  c._q = c._q.then(() => flipOnce(c, ch, d, fin)).then(() => { c._n--; });
  return c._q;
}

/** Step through the drum like a real split-flap. */
function spin(c, ch, set) {
  const tgt = set.indexOf(ch), from = c._t == null ? -1 : set.indexOf(c._t);
  c._t = ch;
  if (RM) { enqueue(c, ch, 0, true); return; }
  const n = Math.min(CFG.maxSteps, from < 0 ? CFG.maxSteps : (tgt - from + set.length) % set.length);
  for (let k = n - 1; k >= 1; k--) enqueue(c, set[(tgt - k + set.length) % set.length], CFG.flipStep, false);
  enqueue(c, ch, CFG.flipFinal, true);
}

/** Only tiles whose value changes flip; stagger counts changed tiles, left to right. */
function cascade(list, t0) {
  let k = 0;
  list.forEach((g) => {
    g[1].split('').forEach((ch, i) => {
      const c = g[0][i];
      if (c._p === ch) return;
      c._p = ch;
      later(() => spin(c, ch, g[2]), t0 + k++ * CFG.stagger);
    });
  });
  return t0 + k * CFG.stagger;
}

function stamp(chip, b, dl) {
  if (chip._b === b) return;
  chip._b = b;
  later(() => {
    chip.dataset.band = b;
    chip.textContent = NAME[b];
    chip.classList.remove('is-off');
    if (!RM) chip.animate([{ opacity: 0, transform: 'scale(1.4)' }, { opacity: 1, transform: 'scale(.96)', offset: .6 }, { opacity: 1, transform: 'scale(1)' }], { duration: 280, easing: 'cubic-bezier(.2,.7,.2,1)' });
  }, dl);
}

/* ─── Scoreboard ────────────────────────────────────────────────────────── */

function show(i, mode) {
  cur = (i + FX.length) % FX.length;
  const f = FX[cur], hb = bandFromValue(f[2]), ab = bandFromValue(f[3]), intro = mode === 'intro', fdr = fdrOf(f[2]);
  const mv = f[4].map(o => Math.max(3, Math.min(97, f[2] + o)));
  if (RM && !intro) el.screen.animate([{ opacity: .2 }, { opacity: 1 }], { duration: 260, easing: 'ease-out' });
  $('nowfx').textContent = `${f[0]} v ${f[1]}`;
  $('fdrteam').textContent = f[0];
  tks.forEach(t => t.setAttribute('aria-current', String(+t.dataset.i === cur)));
  let tS = cascade([[hc, f[0], ALPHA], [ac, f[1], ALPHA]], 0);        // 1 team codes
  if (intro) tS = Math.max(tS, 400);
  later(() => { $('home').dataset.band = hb; $('away').dataset.band = ab; }, tS);
  let tM = cascade([[hs, pad(f[2]), DIG], [as, pad(f[3]), DIG]], tS);  // 2 composites
  const tC = tS + (intro ? 820 : CFG.flipStep * 4 + CFG.flipFinal);
  stamp($('hband'), hb, tC); stamp($('aband'), ab, tC + CFG.stagger);  // 3 band chips
  if (intro) tM = tC + 60;
  mv.forEach((v, k) => {                                               // 4 metrics + bars
    const d = tM + k * CFG.stagger;
    cascade([[ms[k], pad(v), DIG]], d);
    later(() => { const b = $(`mb${k}`); b.dataset.band = bandFromValue(v); b.style.setProperty('--v', v / 100); }, d + 80);
  });
  cascade([[fd, String(fdr), DIG]], tM + 6 * CFG.stagger);
  const txt = `Sample fixture: ${f[5]} ${f[2]} (${NAME[hb]}), ${TEAM[f[1]]} ${f[3]} (${NAME[ab]}). Metrics for ${f[5]}: ${ML.map((m, k) => `${m[0].toLowerCase()} ${mv[k]}`).join(', ')}. Official FDR for ${f[5]}: ${fdr}.`;
  $('readout').textContent = txt;
  if (mode === 'user') $('announce').textContent = txt; // auto-rotation stays silent; user-chosen fixtures are announced politely
}

/** One Pause for everything that moves on its own: ticker scroll, board rotation, sway and drift. */
function cycle() {
  clearInterval(timer);
  timer = setInterval(() => {
    if (paused || hold || document.hidden || !onscreen) return;
    show(cur + 1, 'auto');
  }, CFG.cycle);
}

/* ─── Hanging-board physics: one rAF loop ───────────────────────────────── */

const st = { x: 0, y: 0, vx: 0, vy: 0, pz: 0, vz: 0, pzT: 0, kick: -99, sT: 0, sx: 0, sy: 0, so: 0 };
const lim = { x: CFG.tiltX, y: CFG.tiltY };
let ptr = null, ori = null, R = null, specS = 420, raf = 0, last = 0;

function kick() { st.kick = performance.now() / 1000; }
function advance() { show(cur + 1, 'user'); kick(); cycle(); }
function press() { st.pzT = RM ? 0 : CFG.pressZ; }
function release() { st.pzT = 0; }

function measure() {
  R = el.rig.getBoundingClientRect();
  if (!R.width) return; // off screen: keep the last good measurement
  const tk = el.ticker.getBoundingClientRect();
  el.rig.style.setProperty('--cable', `${Math.max(12, Math.round(R.top - tk.top - 4))}px`); // cable tops tuck under the ticker gantry
  const P = parseFloat(getComputedStyle(el.rig).perspective) || 2000, half = R.width / 2, m = Math.min(R.left, innerWidth - R.right) - 8;
  const rx = CFG.tiltX * Math.PI / 180, extra = CFG.swayTwist + CFG.kickTwist;
  lim.y = 0;
  for (let a = CFG.tiltY + extra; a >= 0; a -= .25) {
    const r = a * Math.PI / 180, z = half * Math.sin(r) + R.height / 2 * Math.sin(rx) + 16;
    if (half * Math.cos(r) * P / (P - z) - half <= m) { lim.y = Math.max(0, Math.min(CFG.tiltY, a - extra)); break; }
  }
  specS = Math.round(R.width * .42);
  el.spec.style.width = el.spec.style.height = `${specS}px`;
}

function running() { return !RM && !document.hidden && onscreen; }

function loop() {
  if (!raf && running()) { last = performance.now(); raf = requestAnimationFrame(frame); }
}

function frame(now) {
  raf = 0;
  if (!running()) return;
  const dt = Math.min(.033, Math.max(0, (now - last) / 1000));
  last = now;
  const t = now / 1000;
  if (!paused) st.sT += dt;
  let gx = 0, gy = 0;
  if (ori) { gy = Math.max(-lim.y, Math.min(lim.y, ori.g * .25)); gx = Math.max(-3, Math.min(3, -ori.b * .2)); }
  else if (!FINE && !paused) { gy = Math.min(CFG.driftY, lim.y) * Math.sin(st.sT * 2 * Math.PI / 11); gx = CFG.driftX * Math.sin(st.sT * 2 * Math.PI / 17 + 1); }
  const k = CFG.stiffness, c = CFG.damping;
  st.vx += (k * (gx - st.x) - c * st.vx) * dt; st.x += st.vx * dt;
  st.vy += (k * (gy - st.y) - c * st.vy) * dt; st.y += st.vy * dt;
  st.vz += (420 * (st.pzT - st.pz) - 30 * st.vz) * dt; st.pz += st.vz * dt;
  const kt = t - st.kick, K = (kt > 0 && !paused) ? (1 - Math.exp(-kt / .25)) * Math.exp(-kt / CFG.kickDecay) : 0, w = 2 * Math.PI * st.sT / CFG.swayPeriod;
  const roll = (CFG.swayDeg + CFG.kickDeg * K) * Math.sin(w), twist = (CFG.swayTwist + CFG.kickTwist * K) * Math.sin(w * .83 + 1.3), Y = st.y + twist;
  el.obj.style.transform = `rotateZ(${roll.toFixed(3)}deg) rotateY(${twist.toFixed(3)}deg)`;
  el.tilt.style.transform = `translateZ(${st.pz.toFixed(2)}px) rotateX(${st.x.toFixed(3)}deg) rotateY(${st.y.toFixed(3)}deg)`;
  el.castI.style.transform = `translate(${(-Y * R.width * .007).toFixed(1)}px,${(st.x * 1.2).toFixed(1)}px) scaleX(${(1 - Math.abs(Y) * .006).toFixed(4)})`;
  el.sheen.style.transform = `translateX(${(-Y / CFG.tiltY * R.width * .14).toFixed(1)}px) skewX(-14deg)`;
  if (FINE) {
    const a = 1 - Math.exp(-dt * 9), tx = ptr ? ptr.px : R.width / 2, ty = ptr ? ptr.py : -R.height * .2, to = ptr ? (ptr.inside ? 1 : .35) : 0;
    st.sx += (tx - st.sx) * a; st.sy += (ty - st.sy) * a; st.so += (to - st.so) * a;
    el.spec.style.transform = `translate3d(${(st.sx - specS / 2).toFixed(1)}px,${(st.sy - specS / 2).toFixed(1)}px,0)`;
    el.spec.style.opacity = st.so.toFixed(3);
    el.edge.style.transform = `translateX(${(st.sx - R.width * .14).toFixed(1)}px)`;
    el.edge.style.opacity = (st.so * .9).toFixed(3);
  }
  raf = requestAnimationFrame(frame);
}

/* ─── Build + wire (once) ───────────────────────────────────────────────── */

function buildBoard() {
  ['rig', 'obj', 'tilt', 'board', 'castI', 'sheen', 'spec', 'edge', 'lit', 'lamp', 'ticker'].forEach((id) => { el[id] = $(id); });
  el.screen = el.board.querySelector('.screen');

  const one = hidden => FX.map((f, i) => `<button type="button" class="tk" data-i="${i}"${hidden ? ' tabindex="-1" aria-hidden="true"' : ` aria-label="Show ${TEAM[f[0]]} ${f[2]} v ${TEAM[f[1]]} ${f[3]} on the scoreboard"`}>${f[0]} <span class="price" data-band="${bandFromValue(f[2])}">${f[2]}</span><span class="tk__v">v</span><span class="price" data-band="${bandFromValue(f[3])}">${f[3]}</span> ${f[1]}</button>`).join('');
  $('track').innerHTML = one(false) + one(true);
  tks = Array.from(root.querySelectorAll('.tk'));

  for (let k = 0; k < 15; k++) {
    $('bank-l').insertAdjacentHTML('beforeend', '<span class="lamp"></span>');
    $('bank-r').insertAdjacentHTML('beforeend', '<span class="lamp"></span>');
  }
  $('metrics').innerHTML = ML.map((m, i) => `<li class="cell"><span class="cell__l"><span class="l">${m[0]}</span><span class="s">${m[1]}</span></span><span class="flaps f-sm" id="m${i}"></span><span class="cell__bar"><i id="mb${i}"></i></span></li>`).join('');

  hc = group('hcode', 3); ac = group('acode', 3); hs = group('hscore', 2); as = group('ascore', 2);
  ms = [0, 1, 2, 3, 4, 5].map(i => group(`m${i}`, 2));
  fd = group('fdr', 1);
}

function wireBoard() {
  const { board, ticker } = el;
  const pb = $('pause');

  board.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') hold = true; });
  board.addEventListener('pointerleave', () => { hold = false; });
  ticker.addEventListener('focusin', () => { ticker.classList.add('is-paused'); hold = true; });
  ticker.addEventListener('focusout', () => { if (!paused) ticker.classList.remove('is-paused'); hold = false; });
  $('track').addEventListener('click', (e) => {
    const t = e.target.closest('.tk');
    if (t) { show(+t.dataset.i, 'user'); kick(); cycle(); }
  });
  pb.addEventListener('click', () => {
    paused = ticker.classList.toggle('is-paused');
    pb.setAttribute('aria-pressed', paused);
    pb.textContent = paused ? 'Play' : 'Pause';
    el.lamp.classList.toggle('is-off', paused);
  });

  // press / next / sound
  board.addEventListener('pointerdown', (e) => { if (e.button || e.target.closest('button')) return; press(); });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(n => board.addEventListener(n, release));
  board.addEventListener('click', (e) => { if (e.target.closest('button')) return; advance(); });
  board.addEventListener('keydown', (e) => {
    if (e.target !== board || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    if (e.repeat) return;
    press(); setTimeout(release, 120); advance();
  });
  $('next').addEventListener('click', advance);
  $('snd').addEventListener('click', function onSound() {
    if (!snd.ctx && !sndInit()) return;
    snd.on = !snd.on;
    if (snd.ctx.state === 'suspended') snd.ctx.resume();
    this.setAttribute('aria-pressed', snd.on);
    this.textContent = snd.on ? 'Sound on' : 'Sound off';
  });
  if (FINE && !RM) {
    Array.from($('metrics').children).forEach((li, k) => {
      li.addEventListener('pointerenter', () => {
        ms[k].forEach((c, j) => {
          if (c._n || c._v === NB) return;
          setTimeout(() => { enqueue(c, c._v, 64, false); enqueue(c, c._v, 170, true); }, j * 40);
        });
      });
    });
  }

  // pointer light tracking
  if (FINE && !RM) {
    addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch' || !R) return;
      const px = e.clientX - R.left, py = e.clientY - R.top;
      ptr = { nx: clamp((px - R.width / 2) / (innerWidth / 2)), ny: clamp((py - R.height / 2) / (innerHeight / 2)), px, py, inside: px >= 0 && py >= 0 && px <= R.width && py <= R.height };
    }, { passive: true });
    document.addEventListener('pointerout', (e) => { if (!e.relatedTarget) ptr = null; });
    addEventListener('blur', () => { ptr = null; });
  }
  // device tilt only where no permission prompt is needed (never asks)
  if (!FINE && !RM && window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission !== 'function') {
    let o0 = null;
    addEventListener('deviceorientation', (e) => {
      if (e.gamma == null) return;
      if (!o0) o0 = { g: e.gamma, b: e.beta };
      ori = { g: e.gamma - o0.g, b: e.beta - o0.b };
    });
  }
  document.addEventListener('visibilitychange', loop);
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((en) => { onscreen = en[0].isIntersecting; loop(); }).observe(el.rig);
  }
  addEventListener('resize', measure);

  // "How the score works"
  const dlg = $('how');
  $('how-open').addEventListener('click', () => dlg.showModal());
  $('how-close').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

  if (!RM && FINE) {
    root.querySelectorAll('.magnet').forEach((m) => {
      m.addEventListener('pointermove', (e) => {
        const r = m.getBoundingClientRect();
        m.style.transform = `translate(${(e.clientX - r.left - r.width / 2) * .2}px,${(e.clientY - r.top - r.height / 2) * .3}px)`;
      });
      m.addEventListener('pointerleave', () => { m.style.transform = ''; });
    });
    root.querySelectorAll('.mod').forEach((t) => {
      t.style.transition = 'background-color .15s,transform .3s cubic-bezier(.2,.7,.2,1)';
      t.addEventListener('pointermove', (e) => {
        const r = t.getBoundingClientRect();
        t.style.transform = `rotateY(${((e.clientX - r.left) / r.width - .5) * 7}deg) rotateX(${-((e.clientY - r.top) / r.height - .5) * 10}deg)`;
      });
      t.addEventListener('pointerleave', () => { t.style.transform = ''; });
    });
  }

  // Leaving for a module: play the exit, then route. Plain navigation where
  // there is nothing to play (reduced motion, no GSAP) or the click is a
  // modified one (new tab etc.).
  root.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (RM || !gsap) return;
    e.preventDefault();
    if (leaving) return;
    leaving = true;
    exit().then(() => {
      leaving = false;
      window.location.hash = a.getAttribute('href');
    });
  });
}

/* ─── Intro / exit / enter ──────────────────────────────────────────────── */

function unpre() { root.classList.add('is-live'); }

/** Warm-up: lamps on bank by bank, beams after them. */
function powerOn(lamps, beams, delay) {
  lamps.forEach((l, i) => l.animate([{ opacity: .08 }, { opacity: .9, offset: .3 }, { opacity: .25, offset: .45 }, { opacity: 1 }], { duration: 380, delay: delay + (i % 5) * 22, easing: 'steps(4,end)', fill: 'backwards' }));
  beams.forEach(b => b.animate([{ opacity: 0 }, { opacity: +getComputedStyle(b).opacity }], { duration: 520, delay: delay + 200, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'backwards' }));
}

/** Chrome fades, ticker slides in, board lowers on its cables and settles, headline rises, strike draws, CTAs and modules stagger in. */
function intro() {
  const q = gsap.utils.selector(root);
  const tl = gsap.timeline({ defaults: { ease: 'power4.out' } });
  introTl = tl;
  tl.from(q('.top'), { opacity: 0, duration: .4 }, 0)
    .from(q('.ticker'), { xPercent: -100, duration: .7, ease: 'expo.out' }, .05)
    .from(q('#rig'), { opacity: 0, duration: .3, ease: 'none' }, .3)
    .fromTo(q('#hang'), { y: -24 }, { y: 0, duration: 1.05, ease: 'back.out(1.7)' }, .3)
    .from(q('#cast'), { opacity: 0, duration: .9, ease: 'power2.out' }, .7)
    .from(q('.headline .ln>span'), { yPercent: 105, duration: .8, stagger: .12 }, .55)
    .from(q('#bar'), { scaleX: 0, duration: .38, ease: 'power3.inOut' }, 1.25)
    .from(q('.intro > *'), { y: 14, opacity: 0, duration: .6, stagger: .08 }, .95)
    .from(q('.modules'), { y: 18, opacity: 0, duration: .6, clearProps: 'transform,opacity' }, 1.15)
    .from(q('.mod'), { opacity: 0, duration: .4, stagger: .07, clearProps: 'opacity' }, 1.25)
    .from(q('.foot'), { opacity: 0, duration: .5 }, 1.4);
  unpre();
  setTimeout(() => { if (tl.progress() < 1) tl.progress(1); }, 3600);
  powerOn(Array.from($('bank-l').children), root.querySelectorAll('.beam--l1,.beam--l2'), 120);
  powerOn(Array.from($('bank-r').children), root.querySelectorAll('.beam--r1,.beam--r2'), 420);
  el.lit.animate([{ opacity: 0 }, { opacity: .8, offset: .18 }, { opacity: .2, offset: .3 }, { opacity: .9, offset: .5 }, { opacity: 1 }], { duration: 560, delay: 1000, easing: 'linear', fill: 'backwards' });
  setTimeout(kick, 1200);
  setTimeout(() => show(0, 'intro'), 1150);
  root.querySelectorAll('.beam--l1,.beam--r1').forEach((bm, i) => {
    const base = i ? 24 : -24, dir = i ? -1 : 1, x = i ? 50 : -50;
    bm.animate([{ transform: `translateX(${x}%) rotate(${base}deg)` }, { transform: `translateX(${x}%) rotate(${base + dir * 1.4}deg)` }], { duration: 9000, delay: 1600, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out' });
  });
  setTimeout(cycle, 3600);
}

/** The intro run backwards and quicker — chrome drops, headline sinks, board hauls up on its cables, ticker runs off. */
function exit() {
  if (introTl && introTl.progress() < 1) introTl.progress(1);
  clearInterval(timer);
  const dlg = $('how');
  if (dlg.open) dlg.close();
  if (exitTl) exitTl.kill();
  const q = gsap.utils.selector(root);
  const x = exitTl = gsap.timeline({ defaults: { ease: 'power3.in' } });
  x.to(q('.foot'), { opacity: 0, duration: .16 }, 0)
    .to(q('.mod'), { opacity: 0, y: 8, duration: .18, stagger: .03 }, 0)
    // The panel behind the tiles has its own fill and border — fade it too,
    // or it lingers as an empty box after everything else has gone.
    .to(q('.modules'), { opacity: 0, duration: .2 }, .12)
    .to(q('.intro > *'), { y: 10, opacity: 0, duration: .2, stagger: .04 }, .02)
    .to(q('.headline .ln>span'), { yPercent: 105, duration: .3, stagger: .06 }, .06)
    .to(q('#hang'), { y: -28, duration: .42, ease: 'back.in(1.6)' }, .1)
    .to(q('#rig'), { opacity: 0, duration: .2, ease: 'none' }, .34)
    // The board's floor shadow goes with the board.
    .to(q('#cast'), { opacity: 0, duration: .24, ease: 'none' }, .2)
    .to(q('.ticker'), { xPercent: 100, duration: .4, ease: 'expo.in' }, .12)
    .to(q('.lights'), { opacity: 0, duration: .3, ease: 'none' }, .26)
    .to(q('.top'), { opacity: 0, duration: .2 }, .36);
  return new Promise((r) => { x.eventCallback('onComplete', r); setTimeout(r, 900); });
}

/** Back on the landing after an exit: play the exit in reverse. */
function enter() {
  if (!exitTl) return;
  const x = exitTl;
  exitTl = null;
  const q = gsap.utils.selector(root);
  x.timeScale(1.25).eventCallback('onReverseComplete', () => {
    x.kill();
    gsap.set(q(EXIT_TARGETS), { clearProps: 'transform,opacity' });
    kick();
  }).reverse();
  setTimeout(kick, 300);
  cycle();
}

/** Resolve with GSAP, or null if the CDN is slow or unreachable. */
function loadGsap() {
  if (RM) return Promise.resolve(null);
  const timeout = new Promise(r => setTimeout(() => r(null), GSAP_WAIT_MS));
  const load = import(GSAP_URL).then(m => m.gsap || m.default).catch(() => null);
  return Promise.race([load, timeout]);
}

async function start() {
  buildBoard();
  wireBoard();
  measure();
  if (document.fonts) document.fonts.ready.then(measure);
  loop();

  gsap = await loadGsap();
  if (!gsap) { unpre(); show(0, 'intro'); cycle(); return; }

  // Wait for Anton (capped) so the headline can't reflow and shove the board mid-intro.
  if (document.fonts && document.fonts.load) {
    await Promise.race([document.fonts.load('400 1em Anton').catch(noop), new Promise(r => setTimeout(r, FONT_WAIT_MS))]);
  }
  measure();
  intro();
}

/* ─── Live value + routing ──────────────────────────────────────────────── */

/**
 * Name the gameweek the app is pointed at in the ticker tag, replacing the
 * static fallback copy. Silent no-op until data lands, so a dead FPL proxy
 * leaves the generic wording rather than "GWundefined".
 */
function renderGameweek() {
  const slot = root?.querySelector('[data-landing-gw]');
  if (!slot) return;
  const gw = store.getUpcomingGw() ?? store.getCurrentGw();
  if (!gw) return;
  slot.textContent = `GW${pad(gw)} · sample`;
}

function onRouteChanged(moduleKey) {
  if (moduleKey !== MODULE_KEY) return;
  if (!started) { started = true; start(); return; }
  measure();
  if (gsap && !RM) enter();
}

/**
 * Wire the landing route. Called once from main.js, after routeToHash() has
 * already seeded store.activeModule — so the initial route:changed emit has
 * been and gone, and the current route is read directly here instead. The
 * board is built lazily on first entry: a deep link to a module never pays for it.
 */
export function initLanding() {
  root = document.querySelector(`[data-module="${MODULE_KEY}"]`);
  if (!root) return;

  store.subscribe('route:changed', onRouteChanged);
  store.subscribe('data:ready', renderGameweek);

  onRouteChanged(store.getActiveModule());
}
