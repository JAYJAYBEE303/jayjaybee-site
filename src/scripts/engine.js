// Page-transition engine + small client router. Ported from the "Mockup 8 /
// Brief" prototype (reference/page-transitions.js): same modes, timings,
// shared-element flights and entrance choreography, driven by real URLs
// instead of hash routes. Same-origin page links are fetched, the current
// page exits, <main> (and the header sub-bar) is swapped, the next page enters.
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

const ORD = JSON.parse(document.getElementById('tx-order').textContent);
const root = document.documentElement;
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const main = () => document.querySelector('main');
const motionOn = () => !matchMedia('(prefers-reduced-motion: reduce)').matches;

let route = parse(location) || { page: 'home', id: null }, curPath = location.pathname;
let exiting = false, target = null, exitCall = null, xctx = null, ctx = null, enterMode = null, navId = 0;
let txSrc = [], txClones = [], flights = [];
let toc = null, ch = null, past = false, sec = 'top', sc = '0-0', hv = {};

// ---- Routes ----
function parse(u) {
  const p = u.pathname; let m;
  if (p === '/' || p === '/index.html') return { page: 'home', id: null };
  if ((m = p.match(/^\/work\/([\w-]+)\/?$/))) return { page: 'case', id: m[1] };
  if (/^\/projects\/?$/.test(p)) return { page: 'projects', id: u.hash.slice(1) || null };
  if ((m = p.match(/^\/projects\/wiki\/([\w-]+)(?:\/([\w-]+))?\/?$/))) return { page: 'wiki', id: m[1] + '/' + (m[2] || '') };
  if (/^\/ai-thesis\/?$/.test(p)) return { page: 'thesis', id: u.hash.slice(1) || null };
  return null;
}
const txKey = r => r.page + ':' + (r.id || '');
const depth = r => r.page === 'home' ? 0 : r.page === 'wiki' ? ((r.id || '').split('/')[1] ? 3 : 2) : 1;
const isSec = r => r.page === 'wiki' && !!(r.id || '').split('/')[1];
function txMode(a, b) {
  if (a.page === 'case' && b.page === 'case') { const S = ORD.roles, n = S.length, d = (S.indexOf(b.id) - S.indexOf(a.id) + n) % n; return d <= n / 2 ? 'next' : 'prev'; }
  if (a.page === 'wiki' && b.page === 'wiki') {
    const [aa, as] = (a.id || '').split('/'), [ba, bs] = (b.id || '').split('/'), A = Object.keys(ORD.apps);
    if (aa !== ba && !as && !bs) return A.indexOf(ba) > A.indexOf(aa) ? 'next' : 'prev';
    if (aa === ba && as && bs) { const S = ORD.apps[aa] || []; return S.indexOf(bs) > S.indexOf(as) ? 'next' : 'prev'; }
  }
  return depth(b) < depth(a) ? 'drop' : 'lift';
}

// ---- Fetching ----
const pages = new Map();
function load(href) {
  const k = href.split('#')[0];
  if (!pages.has(k)) pages.set(k, fetch(k).then(r => { if (!r.ok) throw r; return r.text().then(html => ({ url: r.url, html })); })
    .catch(e => { pages.delete(k); throw e; }));
  return pages.get(k);
}

// ---- Navigation ----
function go(href, push) {
  const u = new URL(href, location.href), to = parse(u), prev = route;
  if (exiting && target && target.page === to.page && target.id === to.id) return;
  const id = ++navId, page = load(u.href);
  const finish = mode => page.then(p => { if (id === navId) swap(to, mode, p, u, push); }, () => { if (id === navId) location.href = u.href; });
  if (exiting) {
    exitCall && exitCall.kill(); exitCall = null; gsap.killTweensOf(main()); endFlights(); target = to; finish('lift'); return;
  }
  endFlights(); target = to; exiting = true;
  if (!motionOn()) { gsap.to(main(), { opacity: 0, duration: .16, ease: 'power1.in', overwrite: true, onComplete: () => finish('lift') }); return; }
  const mode = txMode(prev, to);
  runExit(prev, to, mode, () => finish(mode));
}

function swap(to, mode, p, u, push) {
  const doc = new DOMParser().parseFromString(p.html, 'text/html'), fin = new URL(p.url);
  fin.hash = u.hash;
  if (!doc.querySelector('main')) return void (location.href = fin.href); // not one of the site's pages
  exiting = false; enterMode = mode;
  xctx && xctx.revert(); xctx = null;
  txSrc.forEach(el => { el.style.visibility = ''; }); txSrc = [];
  ctx && ctx.revert(); ctx = null;
  const prev = route;
  route = parse(fin) || to; curPath = fin.pathname;
  if (push) history.pushState(null, '', fin.pathname + fin.search + fin.hash);
  document.title = doc.title;
  const m = main();
  m.innerHTML = doc.querySelector('main').innerHTML;
  $('[data-subwrap]').innerHTML = doc.querySelector('[data-subwrap]').innerHTML;
  toc = ch = null; hv = {};
  setNav();
  const a = route.page === 'home' && fin.hash.length > 1 ? document.getElementById(fin.hash.slice(1))
    : (route.page === 'projects' || route.page === 'thesis') && route.id ? document.getElementById(route.id) : null;
  scrollTo({ top: a ? a.getBoundingClientRect().top + scrollY - 72 : 0, behavior: 'instant' });
  m.focus({ preventScroll: true });
  headerEnter(prev, route, mode); land();
  pageOn(); onScroll(); animate();
}

// ---- Exit ----
const hdrB = () => { const h = $('header'); return h ? h.getBoundingClientRect().bottom : 0; };
const inView = (el, hb) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.bottom > hb + 4 && r.top < innerHeight - 4; };
const lineFrom = m => m === 'drop' ? { yPercent: -110 } : m === 'next' ? { x: 64, autoAlpha: 0 } : m === 'prev' ? { x: -64, autoAlpha: 0 } : { yPercent: 110 };
const itemFrom = m => ({ autoAlpha: 0, ...(m === 'drop' ? { y: -14 } : m === 'next' ? { x: 28 } : m === 'prev' ? { x: -28 } : { y: 14 }) });
function showMain(d) { gsap.to(main(), { opacity: 1, duration: d, ease: 'power1.out', overwrite: true }); }

function runExit(prev, to, mode, done) {
  const mn = main(), hb = hdrB(), key = txKey(to), seen = new Set();
  txSrc = []; txClones = [];
  mn.querySelectorAll('[data-tx-to]').forEach(el => { const id = el.dataset.tx;
    if (!id || el.dataset.txTo !== key || seen.has(id) || !inView(el, hb)) return; seen.add(id); txClones.push(mkClone(el)); });
  const T = txClones.length ? .32 : .38, vis = s => [...mn.querySelectorAll(s)].filter(el => inView(el, hb));
  const L = mode === 'drop' ? { yPercent: 110 } : mode === 'next' ? { x: -64, autoAlpha: 0 } : mode === 'prev' ? { x: 64, autoAlpha: 0 } : { yPercent: -110 };
  const I = mode === 'drop' ? { y: 16 } : mode === 'next' ? { x: -32 } : mode === 'prev' ? { x: 32 } : { y: -16 };
  xctx = gsap.context(() => {
    const lines = vis('[data-line],[data-cl],[data-ctl]');
    if (lines.length) gsap.to(lines, { ...L, duration: .34, ease: 'power2.in', stagger: .03, overwrite: true });
    const items = vis('[data-hr],[data-ci],[data-rv],[data-cover],[data-bar],[data-narr] p,[data-wn] p').filter(el => !lines.includes(el));
    if (items.length) gsap.to(items, { ...I, autoAlpha: 0, duration: .3, ease: 'power2.in', stagger: Math.min(.025, .12 / items.length), overwrite: true });
  });
  const sib = isSec(prev) && isSec(to) && (mode === 'next' || mode === 'prev'), dir = mode === 'next' ? 1 : -1;
  if (sib) {
    gsap.to('[data-wkn]', { yPercent: -100 * dir, duration: .34, ease: 'power3.in', overwrite: true });
    gsap.to('[data-wkt]', { autoAlpha: 0, duration: .26, ease: 'power1.in', overwrite: true });
    gsap.to('[data-prog]', { scaleX: 0, transformOrigin: dir > 0 ? '100% 50%' : '0% 50%', duration: .42, ease: 'power3.in', overwrite: true });
  } else {
    if ($('[data-sub]')) gsap.to('[data-sub]', { autoAlpha: 0, y: -4, duration: .3, ease: 'power2.in', overwrite: true });
    if ($('[data-prog]')) gsap.to('[data-prog]', { autoAlpha: 0, duration: .3, ease: 'power1.in', overwrite: true });
  }
  txClones.forEach(o => o.box && gsap.to(o.node, { scale: 1.06, duration: T, ease: 'power2.out' }));
  gsap.to(mn, { opacity: 0, duration: .16, delay: T - .16, ease: 'power1.in', overwrite: true });
  exitCall = gsap.delayedCall(T, done);
}

function headerEnter(prev, to, mode) {
  if ($('[data-prog]')) gsap.set('[data-prog]', { autoAlpha: 1, transformOrigin: '0% 50%' });
  if (!motionOn()) return;
  const sib = isSec(prev) && isSec(to) && (mode === 'next' || mode === 'prev'), dir = mode === 'next' ? 1 : -1;
  if (sib) {
    gsap.fromTo('[data-wkn]', { yPercent: 100 * dir }, { yPercent: 0, duration: .5, ease: 'power4.out', overwrite: true });
    gsap.fromTo('[data-wkt]', { autoAlpha: 0 }, { autoAlpha: 1, duration: .5, delay: .1, ease: 'power1.out', overwrite: true });
  } else if ($('[data-sub]')) gsap.fromTo('[data-sub]', { autoAlpha: 0, y: -4 }, { autoAlpha: 1, y: 0, duration: .55, delay: .1, ease: 'power3.out', overwrite: true });
}

// ---- Shared-element flights ----
function layer(el) {
  const c = el.cloneNode(true); c.removeAttribute('data-tx'); c.removeAttribute('data-tx-to');
  Object.assign(c.style, el.tagName === 'IMG'
    ? { position: 'absolute', left: '50%', top: '50%', width: 'auto', height: '100%', aspectRatio: '1', transform: 'translate(-50%,-50%)', objectFit: 'cover', margin: 0, boxShadow: 'none', borderRadius: '0', visibility: 'visible', filter: 'none', opacity: 1, transition: 'none' }
    : { position: 'absolute', inset: 0, width: '100%', height: '100%', margin: 0, aspectRatio: 'auto', minHeight: 0, borderRadius: '0', visibility: 'visible', clipPath: 'none', transition: 'none' });
  return c;
}
function words(el) {
  const out = [], tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n;
  while ((n = tw.nextNode())) { const re = /\S+/g; let m;
    while ((m = re.exec(n.data))) { const rg = document.createRange(); rg.setStart(n, m.index); rg.setEnd(n, m.index + m[0].length);
      const b = rg.getBoundingClientRect(); if (b.width) out.push({ t: m[0], r: b, cs: getComputedStyle(n.parentElement) }); } }
  return out;
}
function mkClone(el) {
  const r = el.getBoundingClientRect(), cs = getComputedStyle(el), box = el.tagName === 'IMG' || el.hasAttribute('data-tx-box');
  const o = { id: el.dataset.tx, box };
  if (box) {
    o.node = document.createElement('div'); o.a = layer(el);
    Object.assign(o.node.style, { position: 'fixed', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', margin: 0, zIndex: 60, pointerEvents: 'none',
      overflow: 'hidden', borderRadius: cs.borderRadius, background: el.tagName === 'IMG' ? 'transparent' : cs.backgroundColor });
    o.node.appendChild(o.a);
  } else {
    o.node = document.createElement('div');
    Object.assign(o.node.style, { position: 'fixed', left: 0, top: 0, width: 0, height: 0, zIndex: 60, pointerEvents: 'none' });
    o.words = words(el).map(w => {
      const s = document.createElement('span'); s.textContent = w.t;
      Object.assign(s.style, { position: 'absolute', left: w.r.left + 'px', top: w.r.top + 'px', height: w.r.height + 'px', lineHeight: w.r.height + 'px', margin: 0, padding: 0, whiteSpace: 'pre', transformOrigin: '0 0',
        fontFamily: w.cs.fontFamily, fontSize: w.cs.fontSize, fontWeight: w.cs.fontWeight, letterSpacing: w.cs.letterSpacing, color: w.cs.color, fontFeatureSettings: w.cs.fontFeatureSettings, transition: 'none' });
      o.node.appendChild(s); return { node: s, r: w.r, fs: parseFloat(w.cs.fontSize) };
    });
  }
  document.body.appendChild(o.node); el.style.visibility = 'hidden'; txSrc.push(el);
  return o;
}
function land() {
  const C = txClones; txClones = [];
  if (!C.length) return;
  const hb = hdrB();
  C.forEach(o => {
    const d = $$('main [data-tx="' + o.id + '"]').find(el => inView(el, hb));
    if (!d) { gsap.to(o.node, { opacity: 0, y: '-=12', duration: .35, ease: 'power2.out', onComplete: () => o.node.remove() }); return; }
    d.style.visibility = 'hidden'; d.setAttribute('data-txl', '1');
    const r = d.getBoundingClientRect(), cs = getComputedStyle(d), f = { node: o.node, d };
    flights.push(f);
    const finish = () => { d.style.visibility = ''; d.removeAttribute('data-txl');
      gsap.to(o.node, { opacity: 0, duration: .25, ease: 'power1.out', onComplete: () => { o.node.remove(); flights = flights.filter(x => x !== f); } }); };
    if (o.box) {
      const b = layer(d); b.style.opacity = 0; o.node.appendChild(b);
      if (d.tagName !== 'IMG') o.node.style.background = cs.backgroundColor;
      gsap.to(o.node, { left: r.left, top: r.top, width: r.width, height: r.height, borderRadius: cs.borderRadius, scale: 1, duration: .65, ease: 'power3.inOut', onComplete: finish });
      gsap.to(o.a, { opacity: 0, duration: .5, delay: .2, ease: 'power1.inOut' });
      gsap.to(b, { opacity: 1, duration: .5, delay: .2, ease: 'power1.inOut' });
    } else {
      const D = words(d), st = .03, E = { duration: .65, ease: 'power3.inOut' };
      const mk = (t, l, tp, s) => { const b = document.createElement('span'); b.textContent = t.t;
        Object.assign(b.style, { position: 'absolute', left: l + 'px', top: tp + 'px', height: t.r.height + 'px', lineHeight: t.r.height + 'px', margin: 0, padding: 0, whiteSpace: 'pre', transformOrigin: '0 0', opacity: 0,
          fontFamily: t.cs.fontFamily, fontSize: t.cs.fontSize, fontWeight: t.cs.fontWeight, letterSpacing: t.cs.letterSpacing, color: t.cs.color, fontFeatureSettings: t.cs.fontFeatureSettings, transition: 'none' });
        o.node.appendChild(b); gsap.set(b, { scale: s }); return b; };
      o.words.forEach((w, i) => {
        const t = D[i], dl = i * st;
        if (!t) { gsap.to(w.node, { opacity: 0, duration: .3, ease: 'power1.out' }); return; }
        const s = parseFloat(t.cs.fontSize) / w.fs, dx = t.r.left - w.r.left, dy = t.r.top - w.r.top, b = mk(t, w.r.left, w.r.top, 1 / s);
        gsap.to(w.node, { ...E, x: dx, y: dy, scale: s, color: t.cs.color, delay: dl });
        gsap.to(b, { ...E, x: dx, y: dy, scale: 1, delay: dl });
        gsap.to(w.node, { opacity: 0, duration: .26, delay: dl + .14, ease: 'power1.inOut' });
        gsap.to(b, { opacity: 1, duration: .26, delay: dl + .1, ease: 'power1.inOut' });
      });
      D.slice(o.words.length).forEach((t, k) => gsap.to(mk(t, t.r.left, t.r.top, 1), { opacity: 1, duration: .35, delay: .3 + k * st, ease: 'power1.out' }));
      gsap.delayedCall(.65 + Math.max(0, Math.min(o.words.length, D.length) - 1) * st, finish);
    }
  });
}
function endFlights() {
  flights.forEach(f => { gsap.killTweensOf([f.node, ...f.node.children]); f.node.remove(); f.d.style.visibility = ''; f.d.removeAttribute('data-txl'); });
  flights = [];
  txClones.forEach(o => o.node.remove()); txClones = [];
  txSrc.forEach(el => { el.style.visibility = ''; }); txSrc = [];
}

// ---- Entrance ----
function animate() {
  if (!motionOn()) { showMain(.2); return; }
  const m = enterMode || 'lift', LF = lineFrom(m), IF = itemFrom(m), LT = { yPercent: 0, x: 0, autoAlpha: 1 }, IT = { autoAlpha: 1, x: 0, y: 0 };
  // Anything that is, holds, or sits inside a landing flight target skips its entrance.
  const Q = s => gsap.utils.toArray(s).filter(el => !(el.closest('[data-txl]') || el.querySelector('[data-txl]')));
  const FT = (s, a, b) => { const t = Q(s); t.length && gsap.fromTo(t, a, b); };
  requestAnimationFrame(() => {
    ctx && ctx.revert();
    ctx = gsap.context(() => {
      const p = route.page;
      if (p === 'case') {
        FT('[data-cl]', LF, { ...LT, duration: .75, ease: 'power4.out', delay: .05 });
        FT('[data-ci]', IF, { ...IT, duration: .9, ease: 'power3.out', stagger: .07, delay: .3 });
        FT('[data-cover]', { clipPath: 'inset(0 0 100% 0 round 16px)' }, { clipPath: 'inset(0 0 0% 0 round 16px)', duration: .8, ease: 'power3.inOut', delay: .35 });
      } else if (p === 'projects' || p === 'wiki' || p === 'thesis') {
        FT('[data-cl]', LF, { ...LT, duration: .75, ease: 'power4.out', stagger: .12, delay: .05, overwrite: 'auto' });
        FT('[data-ci]', IF, { ...IT, duration: .9, ease: 'power3.out', stagger: .07, delay: .35, overwrite: 'auto' });
        if ($('[data-wn]')) gsap.fromTo(gsap.utils.toArray('[data-ww]'), { opacity: .16 }, { opacity: 1, ease: 'none', stagger: .1,
          scrollTrigger: { trigger: '[data-wn]', start: 'top 70%', end: 'bottom 60%', scrub: .5 } });
        if (p === 'thesis') {
          gsap.utils.toArray('[data-ctl]').forEach(el => gsap.fromTo(el, { yPercent: 110 }, { yPercent: 0, duration: .75, ease: 'power4.out', scrollTrigger: { trigger: el, start: 'top 88%' } }));
          gsap.utils.toArray('[data-pq]').forEach(q => gsap.fromTo(q.querySelectorAll('[data-pw]'), { opacity: .16 }, { opacity: 1, ease: 'none', stagger: .1,
            scrollTrigger: { trigger: q, start: 'top 78%', end: 'bottom 55%', scrub: .5 } }));
          const chs = gsap.utils.toArray('[data-chap]');
          gsap.utils.toArray('[data-chfill]').forEach((el, i) => chs[i] && gsap.fromTo(el, { scaleX: 0 }, { scaleX: 1, ease: 'none',
            scrollTrigger: { trigger: chs[i], start: 'top 40%', end: 'bottom 40%', scrub: .3 } }));
        }
        if ($('[data-article]')) gsap.fromTo('[data-prog]', { scaleX: 0 }, { scaleX: 1, ease: 'none',
          scrollTrigger: { trigger: '[data-article]', start: 'top top', end: 'bottom bottom', scrub: .3 } });
      } else {
        FT('[data-line]', LF, { ...LT, duration: .75, ease: 'power4.out', stagger: .12, delay: .1 });
        // clearProps: GSAP's leftover inline transform would block the cards' CSS hover lift.
        FT('[data-hr]', IF, { ...IT, duration: .9, ease: 'power3.out', stagger: .06, delay: .45, clearProps: 'transform' });
        gsap.fromTo(gsap.utils.toArray('[data-w]'), { opacity: .16 }, { opacity: 1, ease: 'none', stagger: .1,
          scrollTrigger: { trigger: '[data-narr]', start: 'top 70%', end: 'bottom 60%', scrub: .5 } });
        gsap.from('[data-seg]', { scaleX: 0, duration: 1.1, ease: 'power3.inOut', stagger: .18, scrollTrigger: { trigger: '[data-bar]', start: 'top 85%' } });
      }
      const rv = Q('[data-rv]');
      if (rv.length) {
        gsap.set(rv, { autoAlpha: 0, y: 18 });
        ScrollTrigger.batch(rv, { start: 'top 90%', once: true, onEnter: b => gsap.to(b, { autoAlpha: 1, y: 0, duration: .9, ease: 'power3.out', stagger: .08, clearProps: 'transform' }) });
      }
    });
    root.classList.remove('tx-boot');
    showMain(.35);
  });
}

// ---- Page state: nav, case contents, thesis chapters, scenarios ----
function setNav() {
  const p = route.page;
  $$('[data-nav]').forEach(a => { const k = a.dataset.nav;
    a.classList.toggle('is-on', p === 'case' ? k === 'work' : p === 'projects' || p === 'wiki' ? k === 'projects' : p === 'thesis' ? k === 'thesis' : sec === k); });
  $('.nav').classList.toggle('is-hidden', p === 'home' && !past);
}
function onScroll() {
  const p = route.page;
  if (p === 'case') {
    let a = 0; $$('[id^="cs-"]').forEach((el, i) => { if (el.getBoundingClientRect().top < innerHeight * .4) a = i; });
    if (a !== toc) { toc = a; $$('.toc-btn').forEach((b, i) => b.classList.toggle('is-on', i === a)); }
    return;
  }
  if (p === 'thesis') {
    let a = -1; $$('[data-chap]').forEach((el, i) => { if (el.getBoundingClientRect().top < innerHeight * .4) a = i; });
    if (a !== ch) {
      ch = a; const segs = $$('.chseg'), lab = $('[data-chlabel]');
      segs.forEach((b, i) => b.classList.toggle('is-done', i < a));
      if (lab) lab.textContent = a >= 0 && segs[a] ? segs[a].dataset.cur : 'Introduction';
    }
    return;
  }
  if (p === 'projects' || p === 'wiki') return;
  const idx = $('[data-index]'), ps = idx ? idx.getBoundingClientRect().bottom < 70 : false;
  let s = 'top'; $$('[data-sec]').forEach(el => { if (el.getBoundingClientRect().top < innerHeight * .45) s = el.dataset.sec; });
  if (ps !== past || s !== sec) { past = ps; sec = s; setNav(); }
}
function pageOn() { if (route.page === 'thesis') paintSc(false); }
function paintSc(anim) {
  const ci = sc.split('-')[0];
  $$('[data-list]').forEach(l => { l.hidden = l.dataset.list !== ci; });
  $$('.tab[data-sc]').forEach(b => { const on = b.dataset.sc === ci; b.classList.toggle('is-sel', on); b.setAttribute('aria-selected', on); });
  $$('.scen-item[data-sc]').forEach(b => { const on = b.dataset.sc === sc; b.classList.toggle('is-cur', on); b.setAttribute('aria-current', on); });
  let cur = null; $$('[data-detail]').forEach(d => { d.hidden = d.dataset.detail !== sc; if (!d.hidden) cur = d; });
  if (!anim || !cur) return;
  if (motionOn()) requestAnimationFrame(() => {
    gsap.fromTo(cur.querySelectorAll('[data-step]'), { autoAlpha: 0, x: -10 }, { autoAlpha: 1, x: 0, duration: .5, ease: 'power3.out', stagger: .07, overwrite: true });
    gsap.fromTo(cur.querySelector('[data-out]'), { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: .55, ease: 'power3.out', delay: .25, overwrite: true });
  });
  requestAnimationFrame(() => requestAnimationFrame(() => ScrollTrigger.refresh()));
}
function pickSc(k) {
  const keys = $$('[data-detail]').map(d => d.dataset.detail);
  if (k === 'prev' || k === 'next') { const p = keys.indexOf(sc); k = keys[(p + (k === 'next' ? 1 : -1) + keys.length) % keys.length]; }
  else if (!k.includes('-')) k += '-0';
  if (k !== sc) { sc = k; paintSc(true); }
}
const scrollEl = (el, off) => el && scrollTo({ top: el.getBoundingClientRect().top + scrollY - off, behavior: motionOn() ? 'smooth' : 'instant' });
function jump(id) {
  history.replaceState(null, '', '#' + id);
  route = { page: route.page, id };
  if (route.page === 'projects') scrollTo({ top: document.getElementById(id) ? document.getElementById(id).getBoundingClientRect().top + scrollY - 64 : 0, behavior: motionOn() ? 'smooth' : 'instant' });
  else scrollEl(document.getElementById(id), 120);
}

// Hover-dim rows: hovering one [data-hv] item in a [data-hvg] group marks it
// .is-on and its siblings .is-faded; leaving the group clears it.
function setHv(name, k) {
  if (hv[name] === k) return; hv[name] = k;
  $$(`[data-hvg="${name}"]`).forEach(g => {
    g.classList.toggle('is-hov', k != null);
    g.querySelectorAll('[data-hv]').forEach(el => { el.classList.toggle('is-on', el.dataset.hv === k); el.classList.toggle('is-faded', k != null && el.dataset.hv !== k); });
  });
}

// ---- Events ----
const modified = e => e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
document.addEventListener('click', e => {
  if (e.defaultPrevented) return;
  const t = e.target.closest ? e.target : e.target.parentElement;
  const j = t.closest('[data-jump]');
  if (j && !modified(e)) { e.preventDefault(); jump(j.dataset.jump); return; }
  const gt = t.closest('[data-goto]'); if (gt) return scrollEl(document.getElementById(gt.dataset.goto), 96);
  const fn = t.closest('[data-fn]'); if (fn) return scrollEl(document.getElementById('wk-fn-' + fn.dataset.fn), 120);
  const s = t.closest('[data-sc]'); if (s) return pickSc(s.dataset.sc);
  const gl = t.closest('[data-gloss]');
  if (gl) {
    const on = gl.getAttribute('aria-expanded') !== 'true';
    gl.setAttribute('aria-expanded', on); gl.textContent = on ? 'Show fewer' : gl.dataset.all;
    $$('[data-gx]').forEach(el => { el.hidden = !on; });
    return ScrollTrigger.refresh();
  }
  const a = t.closest('a[href]');
  if (!a || modified(e) || a.target === '_blank' || a.hasAttribute('download')) return;
  const h = a.getAttribute('href');
  if (!/^\/(?!\/)/.test(h) || /\.pdf($|\?)/i.test(h)) return;
  const u = new URL(h, location.href);
  if (u.pathname === location.pathname) { // same page: anchors scroll natively; a bare link drops the anchor and returns to the top
    if (u.hash) return;
    e.preventDefault();
    if (location.hash) { history.replaceState(null, '', u.pathname); route = { page: route.page, id: null }; scrollTo({ top: 0, behavior: motionOn() ? 'smooth' : 'instant' }); }
    return;
  }
  if (!parse(u)) { // leaving the site's pages (an app): play the exit, then load it
    if (!motionOn() || exiting) return;
    e.preventDefault(); endFlights(); exiting = true;
    runExit(route, { page: 'ext', id: h }, 'lift', () => { location.href = h; });
    return;
  }
  e.preventDefault();
  go(u.href, true);
});
document.addEventListener('mouseover', e => {
  const t = e.target.closest ? e.target : e.target.parentElement;
  const it = t.closest('[data-hv]'), g = it && it.closest('[data-hvg]');
  if (g) setHv(g.dataset.hvg, it.dataset.hv);
  const a = t.closest('a[href^="/"]');
  if (a && !a.matches('[href$=".pdf"]')) { const u = new URL(a.href); if (u.pathname !== location.pathname && parse(u)) load(u.href).catch(() => {}); }
});
document.addEventListener('mouseout', e => {
  const g = e.target.closest && e.target.closest('[data-hvg]');
  if (g && !(e.relatedTarget && g.contains(e.relatedTarget))) setHv(g.dataset.hvg, null);
});
addEventListener('popstate', () => {
  if (location.pathname === curPath) { const r = parse(location); if (r) route = r; return; }
  if (!parse(location)) return location.reload();
  go(location.href, false);
});
addEventListener('pageshow', e => {
  if (!e.persisted) return;
  exiting = false; xctx && xctx.revert(); xctx = null; endFlights();
  if ($('[data-sub]')) gsap.set('[data-sub]', { autoAlpha: 1, y: 0 });
  showMain(.3);
});
addEventListener('scroll', onScroll, { passive: true });
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

pageOn(); onScroll(); animate();
