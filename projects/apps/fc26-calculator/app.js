/* ═══════════════════════════════════════════════════════════════
   CONSOLE — the six views (Build · Styles · Chem · Feel · Compare ·
   Squad) and the readout, on one 3×2 plane seen through the stage.
   ───────────────────────────────────────────────────────────────
   One state object `S`; set() schedules a single render per frame.
   Each view builds its DOM once and render() only patches what
   changed, so CSS transitions (thumbs, bars, rings) keep running.
   Every number comes from calculator.js (FC26.computeFeel); labels
   and groupings from data.js (FC26_UI).
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  const E = window.FC26, U = window.FC26_UI;
  const $ = id => document.getElementById(id);
  const html = document.documentElement, app = $('app');
  const cl = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const RM = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const KEY_SAVES = 'fc26_saves';   // legacy key + { folders } shape — existing saves carry over
  const KEY_DRAFT = 'fc26_draft';
  const KEY_THEME = 'fc26_theme';

  // Plane cells (col,row): Build · Styles · Chem · Feel · Compare · Squad
  const POS = [[0, 0], [1, 0], [2, 0], [2, 1], [1, 1], [0, 1]];
  const TABS = [['build', 'Build', 'M5 4v16M12 4v16M19 4v16M3 9h4M10 15h4M17 7h4'], ['styles', 'Styles', 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z'], ['chem', 'Chem', 'M21 12a9 9 0 1 1-18 0a9 9 0 1 1 18 0M12 12l4-4'], ['feel', 'Feel', 'M5 20V10M10 20V4M15 20v-7M20 20V8'], ['compare', 'Compare', 'M12 3l8 6-3 10H7L4 9zM12 8.5l3.5 2.6-1.3 4.4H9.8l-1.3-4.4z'], ['squad', 'Squad', 'M4 6h16M4 12h16M4 18h10']];
  const SUN = 'M12 7.8a4.2 4.2 0 1 0 0.01 0M12 2.6v2M12 19.4v2M2.6 12h2M19.4 12h2M5.4 5.4l1.4 1.4M17.2 17.2l1.4 1.4M18.6 5.4l-1.4 1.4M6.8 17.2l-1.4 1.4';
  const MOON = 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z';
  const BOOST_KEYS = [['accel', 'Acceleration'], ['sprint', 'Sprint'], ['agility', 'Agility']];
  const PLUS = 'M12 5v14M5 12h14', CHECK = 'M5 12.5l4.5 4.5L19 7.5';

  // Silicone part layers
  const L_FACE = '<i data-l="face"></i><i data-l="cast"></i><i data-l="sheen"></i><i data-l="ex"></i><i data-l="db"></i>';
  const L_FACE_LIT = '<i data-l="face"></i><i data-l="lit"></i><i data-l="cast"></i><i data-l="sheen"></i><i data-l="ex"></i><i data-l="db"></i>';

  /* ── Heat tiers (engine statTier → one dyed-rubber fill) ───── */
  const HEAT = {
    magenta: { word: 'Low', range: 'Under 85', core: 'var(--t0a)', core2: 'var(--t0b)' },
    amber: { word: 'Mid', range: '85–99', core: 'var(--t1a)', core2: 'var(--t1b)' },
    green: { word: 'High', range: '100–114', core: 'var(--t2a)', core2: 'var(--t2b)' },
    cyan: { word: 'Peak', range: '115+', core: 'var(--t3a)', core2: 'var(--t3b)' },
  };
  const heat = v => HEAT[E.statTier(v)];
  const barPct = v => cl(v / E.BAR_VISUAL_MAX * 100, 0, 100);
  const barFill = h => `linear-gradient(180deg, ${h.core} 0%, ${h.core2} 100%)`;
  const barGlow = h => h.word === 'Low' ? 'none' : 'var(--glow)';

  /* ── Small DOM patch helpers (write only on change) ─────────── */
  const setAttr = (el, k, v) => { v = String(v); if (el.getAttribute(k) !== v) el.setAttribute(k, v); };
  const setText = (el, v) => { v = String(v); if (el.textContent !== v) el.textContent = v; };
  const setStyle = (el, k, v) => { if (el.style.getPropertyValue(k) !== v) el.style.setProperty(k, v); };

  const store = {
    get(k, f) { try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : f; } catch (e) { return f; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };

  /* Simulate a damped spring and return a CSS linear() easing, so a plain animation can overshoot. */
  function springLinear({ stiffness = 170, damping = 16, mass = 1, precision = 0.0015 } = {}) {
    const dt = 1 / 120; let x = 0, v = 0, t = 0, n = 0, still = 0; const pts = [0];
    while (t < 3 && n < 1000) {
      v += ((-stiffness * (x - 1) - damping * v) / mass) * dt; x += v * dt; t += dt; n++;
      if (n % 3 === 0) pts.push(+x.toFixed(4));
      if (Math.abs(x - 1) < precision && Math.abs(v) < precision) { if (++still > 6) break; } else still = 0;
    }
    pts.push(1);
    return `linear(${pts.join(', ')})`;
  }
  const SPRING_EASE = springLinear({ stiffness: 120, damping: 15.5 });
  const SOFT = 'cubic-bezier(0.25,1,0.35,1)';

  /* Roving focus for tablists / radiogroups. Returns the new index or null. */
  function rove(e, i, n, vertical) {
    const prev = vertical ? 'ArrowUp' : 'ArrowLeft', next = vertical ? 'ArrowDown' : 'ArrowRight';
    let j = null;
    if (e.key === next || (!vertical && e.key === 'ArrowDown') || (vertical && e.key === 'ArrowRight')) j = (i + 1) % n;
    else if (e.key === prev || (!vertical && e.key === 'ArrowUp') || (vertical && e.key === 'ArrowLeft')) j = (i - 1 + n) % n;
    else if (e.key === 'Home') j = 0; else if (e.key === 'End') j = n - 1;
    if (j === null) return null;
    e.preventDefault();
    const box = e.currentTarget.closest('[role=radiogroup],[role=tablist]') || e.currentTarget.parentElement;
    const sibs = box.querySelectorAll('[data-rove]');
    if (sibs[j]) sibs[j].focus();
    return j;
  }

  /* View Transition wrapper — update(done) must apply the change synchronously. */
  function vt(update, skip) {
    if (skip || RM || !document.startViewTransition) { update(); return null; }
    return document.startViewTransition(() => update());
  }

  /* ═════════ Squad data: seed (Squad_saves.js) + user saves ═════════ */
  const seedFolders = (window.SQUAD_SAVES && window.SQUAD_SAVES.folders) || [];
  let userFolders = null; // set below, once sanitize() exists
  let entries = [];

  const genId = () => Math.random().toString(36).slice(2, 9);
  const clone = o => JSON.parse(JSON.stringify(o));
  // Coerce stored / imported folders into the shape the views rely on; drop players without a name.
  const str = v => typeof v === 'string' ? v : '';
  function sanitize(folders) {
    return (Array.isArray(folders) ? folders : []).filter(f => f && typeof f === 'object').map(f => ({
      ...f, id: f.id || genId(), name: str(f.name) || 'Folder',
      players: (Array.isArray(f.players) ? f.players : []).filter(p => p && str(p.name).trim()).map(p => {
        const state = p.state && typeof p.state === 'object' ? { ...p.state } : {};
        state.activePS = Array.isArray(state.activePS) ? state.activePS.filter(k => typeof k === 'string') : [];
        return { ...p, state, archetypePrimary: str(p.archetypePrimary), archetypeSecondary: str(p.archetypeSecondary),
          roles: Array.isArray(p.roles) ? p.roles.filter(r => typeof r === 'string') : str(p.role) ? [p.role] : [] };
      }),
      subfolders: sanitize(f.subfolders),
    }));
  }
  // Merge folder trees by name; players replace by (case-insensitive) name.
  function mergeFolders(into, from) {
    let n = 0;
    from.forEach(src => {
      const t = into.find(f => f.name === src.name);
      if (!t) { into.push(src); n += countPlayers([src]); return; }
      (src.players || []).forEach(p => {
        const i = t.players.findIndex(x => x.name.toLowerCase() === p.name.toLowerCase());
        if (i >= 0) t.players[i] = p; else t.players.push(p);
        n++;
      });
      n += mergeFolders(t.subfolders, src.subfolders || []);
    });
    return n;
  }
  userFolders = sanitize((store.get(KEY_SAVES, null) || {}).folders);
  const countPlayers = fs => fs.reduce((a, f) => a + (f.players || []).length + countPlayers(f.subfolders || []), 0);

  function flatten(folders, src) {
    const out = [];
    const walk = (f, path) => {
      const p = [...path, f.name];
      (f.players || []).forEach(pl => out.push({
        id: 'e:' + (p.join('/') + '/' + pl.name).toLowerCase(), src, name: pl.name,
        roles: pl.roles || (pl.role ? [pl.role] : []), arch1: pl.archetypePrimary || '', arch2: pl.archetypeSecondary || '',
        group: p[0], path: p, state: pl.state || {}, res: null,
      }));
      (f.subfolders || []).forEach(sf => walk(sf, p));
    };
    folders.forEach(f => walk(f, []));
    return out;
  }
  // A user save at the same folder path + name overrides the seed copy (same id).
  function rebuildEntries() {
    const user = flatten(userFolders, 'user'), mine = new Set(user.map(e => e.id));
    entries = [...flatten(seedFolders, 'seed').filter(e => !mine.has(e.id)), ...user];
  }
  const entryRes = e => e.res || (e.res = E.computeFeel(e.state));
  const persistUser = () => store.set(KEY_SAVES, { folders: userFolders });

  /* ═════════ Derived numbers ═════════ */
  function layersOf(res) {
    if (res._layers) return res._layers;
    return (res._layers = U.LAYERS.map(L => {
      const stats = L.stats.map(st => ({ ...st, value: res.flat[st.k], base: res.base[st.k] }));
      return { key: L.key, title: L.title, stats, avg: Math.round(stats.reduce((a, b) => a + b.value, 0) / stats.length) };
    }));
  }
  const overall = res => { const ls = layersOf(res); return Math.round(ls.reduce((a, l) => a + l.avg, 0) / ls.length); };
  let memoP = null, memoRes = null;
  const currentRes = () => { if (memoP !== S.p) { memoP = S.p; memoRes = E.computeFeel(S.p); } return memoRes; };

  /* ═════════ State ═════════ */
  const S = {
    ready: false, theme: html.dataset.theme === 'dark' ? 'dark' : 'light', view: 0, p: { ...E.DEFAULTS }, name: 'New player', fromId: null, srcId: null,
    raw: {}, feelOpen: null, feelDet: null, feelRow: true, psHover: null, chemPreview: undefined,
    filt: { role: '', arch: '', primaryOnly: false, exclSecondary: false }, cmp: ['current'], cmpView: 'radar',
    form: { folder: 'My saves', newFolder: '', roles: [], arch: [] }, flash: '', ignite: false, mode: 'wide', short: false,
  };
  let raf = 0;
  function set(patch) {
    Object.assign(S, typeof patch === 'function' ? patch(S) : patch);
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); });
  }
  function commit(patch) { Object.assign(S, patch); cancelAnimationFrame(raf); raf = 0; render(); }
  let draftT = 0;
  const saveDraft = () => { clearTimeout(draftT); draftT = setTimeout(() => store.set(KEY_DRAFT, { p: S.p, name: S.name }), 300); };
  function setP(patch) { set({ p: { ...S.p, ...patch }, fromId: null }); saveDraft(); }

  /* ═════════ Shared builders ═════════ */
  // Segmented radiogroup: pressed-in track, sliding raised thumb.
  function makeSeg(box, opts, getCur, onSet, optClass) {
    box.style.setProperty('--n', opts.length);
    box.innerHTML = '<i class="seg-thumb" aria-hidden="true" data-ext="sm"></i>' + opts.map(o =>
      `<button type="button" class="seg-opt${optClass ? ' ' + optClass : ''}" role="radio" data-rove aria-checked="false" tabindex="-1">${esc(o.label)}</button>`).join('');
    const thumb = box.firstElementChild, btns = [...box.querySelectorAll('button')];
    btns.forEach((b, i) => {
      b.addEventListener('click', () => onSet(opts[i].key));
      b.addEventListener('keydown', e => { const j = rove(e, i, opts.length); if (j !== null) onSet(opts[j].key); });
    });
    return () => {
      const cur = getCur(), idx = Math.max(0, opts.findIndex(o => o.key === cur));
      btns.forEach((b, i) => { setAttr(b, 'aria-checked', i === idx); setAttr(b, 'tabindex', i === idx ? 0 : -1); });
      setStyle(thumb, 'transform', `translate3d(${idx * 100}%,0,0)`);
    };
  }
  // innerHTML rebuilds destroy the focused control; the returned fn puts focus on its
  // replacement (same data-* value), else the first of its kind, else `fallback`.
  function focusKey(box, attrs, fallback) {
    const a = document.activeElement, attr = a && box.contains(a) && attrs.find(k => a.dataset[k] !== undefined);
    if (!attr) return () => {};
    const v = a.dataset[attr];
    return () => {
      const all = [...box.querySelectorAll(`[data-${attr}]`)], el = all.find(x => x.dataset[attr] === v) || all[0] || fallback;
      if (el) el.focus({ preventScroll: true });
    };
  }
  const switchHTML = label => `<button type="button" class="sw" role="switch" aria-checked="false" aria-label="${esc(label)}" data-deb="sm"><i class="sw-glow" aria-hidden="true"></i><i class="sw-thumb" aria-hidden="true" data-ext="sm"></i></button>`;
  const chevSVG = '<svg class="chev" aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 9l6 6 6-6"></path></svg>';

  /* ═════════ Rail ═════════ */
  const tabsEl = $('tabs');
  tabsEl.innerHTML = TABS.map(([k, l, d], i) => `<button type="button" class="tab" role="tab" id="t-${k}" aria-controls="p-${k}" aria-selected="false" tabindex="-1" data-rove data-m="sm" data-hov data-on="false" title="${l} (${i + 1})">${L_FACE}<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"></path></svg><span class="tab-label">${l}</span></button>`).join('');
  const tabBtns = [...tabsEl.children];
  tabBtns.forEach((b, i) => {
    b.addEventListener('click', () => go(i));
    b.addEventListener('keydown', e => { const j = rove(e, i, TABS.length, S.mode !== 'narrow'); if (j !== null) go(j); });
  });
  $('themeSw').addEventListener('click', toggleTheme);
  $('puck').addEventListener('click', () => go(3));
  function renderRail(ovr, sweep) {
    tabBtns.forEach((b, i) => { const on = S.view === i; setAttr(b, 'aria-selected', on); setAttr(b, 'data-on', on); setAttr(b, 'tabindex', on ? 0 : -1); });
    setAttr(tabsEl, 'aria-orientation', S.mode === 'narrow' ? 'horizontal' : 'vertical');
    setAttr($('themeSw'), 'aria-checked', S.theme === 'dark');
    setAttr($('themeIcon'), 'd', S.theme === 'dark' ? MOON : SUN);
    setAttr($('puck'), 'aria-label', `${S.name}, overall feel ${ovr}. Open feel view`);
    setStyle($('puck').querySelector('.puck-ring'), '--sweep', sweep);
  }

  /* ═════════ 01 Build ═════════ */
  const gm = {}; U.INPUT_GROUPS.forEach(g => { gm[g.key] = g; });
  const PLATES = [['body', 'plate--body'], ['move', ''], ['pass', ''], ['mental', ''], ['def', 'plate--def'], ['shoot', 'plate--shoot']];
  const wellLabel = (st, v) => st.id === 'heightCm' ? `Height · ${E.cmToFtIn(v)}` : st.label + (st.unit ? ` (${st.unit})` : '');
  $('plates').innerHTML = PLATES.map(([key, cls]) => {
    const g = gm[key];
    const wells = g.stats.map(st => `<label class="well"><span class="well-label mute">${esc(wellLabel(st, E.DEFAULTS[st.id]))}</span><span class="well-box"><span class="well-field" data-deb="sm"><input class="well-input" type="number" inputmode="numeric" min="${st.min}" max="${st.max}" data-id="${st.id}"></span><i class="well-glow" aria-hidden="true"></i></span></label>`).join('');
    const segs = key !== 'body' ? '' :
      '<div class="seg-block seg-block--build"><span class="caps" id="lb-build">Build</span><div class="seg" role="radiogroup" aria-labelledby="lb-build" data-deb="md" id="segBuild"></div></div>' +
      '<div class="seg-block seg-block--accel"><span class="caps" id="lb-accel">AcceleRATE</span><div class="seg" role="radiogroup" aria-labelledby="lb-accel" data-deb="md" id="segAccel"></div></div>';
    return `<div class="plate ${cls}" role="group" aria-labelledby="h-g-${key}" data-ext="md"><h3 class="plate-title" id="h-g-${key}"><span class="groove" aria-hidden="true" data-deb="sm"></span>${esc(g.title)}</h3><div class="plate-body"><div class="wells">${wells}</div>${segs}</div></div>`;
  }).join('');
  const wells = [...$('plates').querySelectorAll('.well-input')].map(input => {
    const st = U.ALL_INPUTS.find(x => x.id === input.dataset.id);
    const well = { st, input, label: input.closest('.well').querySelector('.well-label'), glow: input.closest('.well-box').querySelector('.well-glow') };
    input.addEventListener('input', () => {
      const t = input.value, n = parseInt(t, 10);
      S.raw[st.id] = t;
      if (!isNaN(n) && n >= st.min && n <= st.max) setP({ [st.id]: n });
    });
    input.addEventListener('change', () => {
      const n = parseInt(input.value, 10);
      delete S.raw[st.id];
      if (!isNaN(n)) setP({ [st.id]: cl(n, st.min, st.max) }); else set({});
    });
    input.addEventListener('blur', () => { delete S.raw[st.id]; set({}); });
    input.addEventListener('pointerdown', e => scrub(e, st));
    return well;
  });
  // Drag sideways on a well to scrub: 5px dead-zone, 1 unit per 4px.
  function scrub(e, st) {
    if (e.pointerType === 'touch' || e.button) return;
    const x0 = e.clientX, v0 = +S.p[st.id]; let on = false;
    const mv = ev => {
      const dx = ev.clientX - x0;
      if (!on && Math.abs(dx) > 5) { on = true; document.body.style.cursor = 'ew-resize'; }
      if (on) { const n = cl(Math.round(v0 + dx / 4), st.min, st.max); if (n !== +S.p[st.id]) { delete S.raw[st.id]; setP({ [st.id]: n }); } }
    };
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); document.body.style.cursor = ''; };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  }
  const renderBuildSeg = makeSeg($('segBuild'), U.BUILD_TYPES, () => S.p.buildType, k => setP({ buildType: k }));
  const renderAccelSeg = makeSeg($('segAccel'), U.ACCEL_TYPES, () => S.p.accelType, k => setP({ accelType: k }));
  function renderBuild() {
    wells.forEach(w => {
      const v = +S.p[w.st.id];
      if (S.raw[w.st.id] === undefined && w.input.value !== String(v)) w.input.value = v;
      setText(w.label, wellLabel(w.st, v));
      setStyle(w.glow, 'transform', `scaleX(${cl((v - w.st.min) / (w.st.max - w.st.min)).toFixed(3)})`);
    });
    renderBuildSeg(); renderAccelSeg();
  }

  /* ═════════ 02 Styles ═════════ */
  const psState = (active, ps) => active.includes(ps.plus) ? 'plus' : active.includes(ps.key) ? 'on' : 'off';
  function cyclePS(active, ps) {
    const next = { off: 'on', on: 'plus', plus: 'off' }[psState(active, ps)];
    const a = active.filter(k => k !== ps.key && k !== ps.plus);
    if (next === 'on') a.push(ps.key); else if (next === 'plus') a.push(ps.plus);
    return a;
  }
  $('psShelves').innerHTML = U.PS_CATS.map(cat => {
    const items = U.PS.filter(x => x.cat === cat);
    return `<div class="shelf" role="group" aria-labelledby="h-ps-${cat}"><div class="shelf-rail"><h3 class="shelf-title" id="h-ps-${cat}">${cat}</h3><span class="shelf-count mute"><span data-act>0</span> of ${items.length}</span></div><div class="shelf-grid">${items.map(ps =>
      `<button type="button" class="key" data-m="sm" data-hov data-on="false" data-lit="false" aria-pressed="false" data-ps="${ps.key}">${L_FACE_LIT}<i class="key-icon" aria-hidden="true"></i><span class="key-name"></span></button>`).join('')}</div></div>`;
  }).join('');
  const psKeys = [...$('psShelves').querySelectorAll('.key')].map(btn => {
    const ps = U.PS.find(x => x.key === btn.dataset.ps);
    btn.addEventListener('click', () => setP({ activePS: cyclePS(S.p.activePS, ps) }));
    const hover = () => set({ psHover: ps.key }), out = () => set({ psHover: null });
    btn.addEventListener('pointerenter', hover); btn.addEventListener('focus', hover);
    btn.addEventListener('pointerleave', out); btn.addEventListener('blur', out);
    return { ps, btn, icon: btn.querySelector('.key-icon'), name: btn.querySelector('.key-name') };
  });
  const psShelves = [...$('psShelves').children].map((el, i) => ({ cat: U.PS_CATS[i], count: el.querySelector('[data-act]') }));
  $('psClear').addEventListener('click', () => setP({ activePS: [] }));
  function renderStyles() {
    const active = S.p.activePS;
    psKeys.forEach(k => {
      const st = psState(active, k.ps), plus = st === 'plus', fx = plus ? k.ps.fxPlus : k.ps.fx;
      setText(k.name, plus ? k.ps.plusName : k.ps.name);
      setStyle(k.icon, 'background-image', `url("${U.iconUrl(plus ? k.ps.iconPlus : k.ps.icon)}")`);
      setAttr(k.btn, 'data-on', st !== 'off'); setAttr(k.btn, 'data-lit', plus); setAttr(k.btn, 'aria-pressed', st !== 'off');
      setAttr(k.btn, 'aria-label', `${k.ps.name}, ${plus ? 'plus' : st}. ${fx}. Press to ${st === 'off' ? 'activate' : st === 'on' ? 'upgrade to plus' : 'clear'}.`);
    });
    psShelves.forEach(s => setText(s.count, psKeys.filter(k => k.ps.cat === s.cat && psState(active, k.ps) !== 'off').length));
    setText($('psActive'), active.length);
    const hov = S.psHover && U.PS.find(x => x.key === S.psHover), hs = hov && psState(active, hov);
    setText($('psHint'), hov ? `${hs === 'plus' ? hov.plusName : hov.name} — ${hs === 'plus' ? hov.fxPlus : hov.fx}${hs === 'on' ? ` · plus: ${hov.fxPlus}` : ''}` : 'Point at a key to read its effect.');
  }

  /* ═════════ 03 Chem ═════════ */
  const CHEM_KEYS = [null, ...U.CHEMS.map(c => c.key)];
  const chemRows = [{ group: 'Base', items: [{ key: null, name: 'No style' }, ...U.CHEMS.filter(c => c.group === 'Basic')] },
    ...U.CHEM_GROUPS.filter(g => g !== 'Basic').map(g => ({ group: g, items: U.CHEMS.filter(c => c.group === g) }))];
  $('chemShelves').innerHTML = chemRows.map(g => `<div class="shelf"><span class="shelf-rail shelf-rail--chem shelf-title mute">${g.group}</span><div class="shelf-grid shelf-grid--pads">${g.items.map(c =>
    `<button type="button" class="pad" role="radio" data-rove data-m="sm" data-hov data-on="false" data-lit="false" aria-checked="false" aria-describedby="chem-map" tabindex="-1" data-chem="${c.key || ''}">${L_FACE_LIT}${esc(c.name)}</button>`).join('')}</div></div>`).join('');
  const pads = [...$('chemShelves').querySelectorAll('.pad')].map(btn => {
    const key = btn.dataset.chem || null, idx = CHEM_KEYS.indexOf(key);
    btn.addEventListener('click', () => setChem(key));
    btn.addEventListener('keydown', e => { const j = rove(e, idx, CHEM_KEYS.length); if (j !== null) setChem(CHEM_KEYS[j]); });
    const prev = () => set({ chemPreview: key }), out = () => set({ chemPreview: undefined });
    btn.addEventListener('pointerenter', prev); btn.addEventListener('focus', prev);
    btn.addEventListener('pointerleave', out); btn.addEventListener('blur', out);
    return { key, btn };
  });
  const setChem = k => { if (k !== S.p.chemStyle) setP({ chemStyle: k }); };
  // All attributes in fixed positions so previews compare at a glance.
  const cellDefs = [...BOOST_KEYS, ...U.ALL_INPUTS.filter(x => !['baseAccel', 'baseSprint', 'baseAgility', 'heightCm', 'weight'].includes(x.id)).map(x => [x.id, x.label])];
  $('chemCells').innerHTML = cellDefs.map(([, label]) => `<div class="cell"><span>${esc(label)}</span><span class="cell-v"><span data-t>—</span><i class="cell-dot" aria-hidden="true"></i></span></div>`).join('');
  const cells = [...$('chemCells').children].map((el, i) => ({ k: cellDefs[i][0], v: el.querySelector('.cell-v'), t: el.querySelector('[data-t]'), dot: el.querySelector('.cell-dot') }));
  function renderChem() {
    const cur = S.p.chemStyle || null;
    pads.forEach(p => { const on = p.key === cur; setAttr(p.btn, 'data-on', on); setAttr(p.btn, 'data-lit', on); setAttr(p.btn, 'aria-checked', on); setAttr(p.btn, 'tabindex', on ? 0 : -1); });
    const shown = S.chemPreview !== undefined ? S.chemPreview : cur, chem = U.CHEMS.find(c => c.key === shown), tb = chem ? E.CHEM_BOOSTS[chem.key] : {};
    setText($('chemTitle'), chem ? `${chem.name} boosts` : 'No chemistry boosts');
    setText($('chemSub'), S.chemPreview !== undefined && S.chemPreview !== cur ? 'Previewing — select to apply.' : chem ? `${chem.group} style · ${chem.fx}` : 'Attributes stay at their base values.');
    cells.forEach(c => {
      const v = tb[c.k] || 0;
      setText(c.t, v ? '+' + v : '—'); c.v.classList.toggle('is-pos', !!v);
      setStyle(c.dot, 'opacity', v ? (0.35 + v / 9 * 0.65).toFixed(2) : '0');
      setStyle(c.dot, 'transform', `scale(${v ? (0.7 + v / 9 * 0.5).toFixed(2) : 0.4})`);
    });
  }

  /* ═════════ 04 Feel ═════════ */
  $('heatScale').innerHTML = Object.values(HEAT).map(h => `<li><i class="heat-dot" aria-hidden="true" style="background:${h.core}"></i>${h.word} <span class="mute">${h.range}</span></li>`).join('');
  $('feelGrid').innerHTML = U.LAYERS.map(L => `<div class="feel-col" data-col="${L.key}"><button type="button" class="layer-btn" data-m="sm" data-hov data-on="false" aria-expanded="false" aria-controls="det-${L.key}">${L_FACE}<span class="layer-btn-text"><span class="layer-title">${L.title}</span><span class="layer-sub mute"><span data-heat></span> · <span data-hint>details</span></span></span><span class="layer-avg" data-avg></span></button><div class="bars">${L.stats.map((st, i) =>
    `<div class="bar" role="img"><span class="bar-v"></span><span class="bar-track" data-deb="sm"><span class="bar-glowclip" aria-hidden="true"><i style="transition-delay:${i * 70}ms"></i></span><span class="bar-fillclip"><i style="transition-delay:${i * 70}ms"></i></span></span><span class="bar-short mute">${st.short}</span></div>`).join('')}</div><div data-det></div></div>`).join('');
  const feelCols = [...$('feelGrid').children].map((col, li) => {
    const L = U.LAYERS[li], btn = col.querySelector('.layer-btn');
    btn.addEventListener('click', () => toggleLayer(L.key));
    return {
      L, col, btn, heat: btn.querySelector('[data-heat]'), hint: btn.querySelector('[data-hint]'), avg: btn.querySelector('[data-avg]'), slot: col.querySelector('[data-det]'), detKey: null,
      bars: [...col.querySelectorAll('.bar')].map(b => ({ el: b, v: b.querySelector('.bar-v'), glow: b.querySelector('.bar-glowclip > i'), fill: b.querySelector('.bar-fillclip > i') })),
    };
  });
  let detT = 0;
  function toggleLayer(key, force) {
    const cur = S.feelOpen, next = force ? key : cur === key ? null : key;
    if (next === cur) return;
    clearTimeout(detT);
    if (!S.feelRow && !RM && document.startViewTransition) {
      feelCols.forEach(c => { c.col.style.viewTransitionName = 'fc-' + c.L.key; });
      const clear = () => feelCols.forEach(c => { c.col.style.viewTransitionName = ''; });
      const t = vt(() => commit({ feelOpen: next, feelDet: next }));
      if (t) t.finished.then(clear, clear); else clear();
      return;
    }
    set({ feelOpen: next, feelDet: next || S.feelDet });
    if (!next) detT = setTimeout(() => set({ feelDet: S.feelOpen ? S.feelDet : null }), 320);
  }
  const chipHTML = (r, c) => r.base ? `<span class="chip chip--base">${esc(c.k)} ${c.v}</span>`
    : `<span class="chip${c.sign > 0 ? ' chip--pos' : ''}">${c.v > 0 ? '+' : '−'}${Math.abs(c.v)} ${esc(c.k)}</span>`;
  function detailsHTML(key, res) {
    const rows = res.rows[key].map(r => `<div class="det-row${r.base ? ' det-row--base' : ''}"><span class="det-label">${esc(r.label)}</span><span class="chips">${r.chips.map(c => chipHTML(r, c)).join('')}</span></div>`).join('');
    const slip = key !== 'movement' ? '' : `<div class="slip"><span class="slip-h">Slipperiness · ${res.slip.total}</span>${res.slip.rows.map(r =>
      `<div class="slip-row"><span>${esc(r.label)}</span><b>${r.base ? r.v : (r.v > 0 ? '+' : '−') + Math.abs(r.v)}</b></div>`).join('')}</div>`;
    return `<div class="det" id="det-${key}"><p class="verdict">${esc(res.verdicts[key])}</p><div class="det-card" data-deb="md">${rows}${slip}</div></div>`;
  }
  function renderFeel(res) {
    const layers = layersOf(res);
    feelCols.forEach((c, li) => {
      const L = layers[li], open = S.feelOpen === L.key, h = heat(L.avg);
      setAttr(c.btn, 'data-on', open); setAttr(c.btn, 'aria-expanded', open);
      setText(c.heat, h.word); setText(c.hint, open ? 'close' : 'details'); setText(c.avg, L.avg);
      setStyle(c.col, 'grid-column', !S.feelRow && open ? '1 / -1' : 'auto');
      L.stats.forEach((st, i) => {
        const b = c.bars[i], bh = heat(st.value), y = `translate3d(0,${(100 - (S.ignite ? barPct(st.value) : 0)).toFixed(2)}%,0)`;
        setText(b.v, st.value);
        setAttr(b.el, 'aria-label', `${st.label}: ${st.value}, ${bh.word}${st.base != null ? `, base ${st.base}` : ''}`);
        setStyle(b.fill, 'background', barFill(bh)); setStyle(b.glow, 'box-shadow', barGlow(bh));
        setStyle(b.fill, 'transform', y); setStyle(b.glow, 'transform', y);
      });
      // Details: mounted while S.feelDet names this column; fades out before unmount.
      const want = S.feelDet === L.key ? L.key + '|' + (memoKey(res)) : null;
      if (want !== c.detKey) { c.detKey = want; c.slot.innerHTML = want ? detailsHTML(L.key, res) : ''; }
      const det = c.slot.firstElementChild;
      if (det) det.toggleAttribute('data-closing', !open);
    });
    const tracks = !S.feelRow ? (S.mode === 'narrow' ? 'minmax(0,1fr)' : 'repeat(2,minmax(0,1fr))')
      : layers.map(L => S.feelOpen === L.key ? '2.8fr' : S.feelOpen ? (L.stats.length * 0.3).toFixed(2) + 'fr' : L.stats.length + 'fr').join(' ');
    setStyle($('feelGrid'), 'grid-template-columns', tracks);
  }
  // Identity tag for a computeFeel result, so derived DOM rebuilds only on change.
  let resSeq = 0;
  const memoKey = res => res._id || (res._id = ++resSeq);

  /* ═════════ 05 Compare ═════════ */
  const SERIES = [
    { stroke: 'var(--rad)', dash: 'none', w: 2.8, glow: true },
    { stroke: 'var(--ink)', dash: 'none', w: 1.8 },
    { stroke: 'var(--ink)', dash: '6 5', w: 1.8 },
    { stroke: 'var(--mute)', dash: 'none', w: 1.8 },
    { stroke: 'var(--mute)', dash: '2 5', w: 2 },
    { stroke: 'var(--ink)', dash: '12 4 2 4', w: 1.6 },
  ];
  const IDEAL_NAMES = [...U.ARCH_ATT, ...U.ARCH_DEF];
  function compareSeries(res) {
    return S.cmp.map((id, i) => {
      let label, flat;
      if (id === 'current') { label = S.name + ' (editing)'; flat = res.flat; }
      else if (id.startsWith('ideal:')) { const n = id.slice(6); label = 'Ideal ' + n; flat = U.idealFlat(n); }
      else { const e = entries.find(x => x.id === id); if (!e) return null; label = e.name; flat = entryRes(e).flat; }
      return { id, label, flat, ...SERIES[i % SERIES.length] };
    }).filter(Boolean);
  }
  const radarAxis = (i, n, r) => { const a = -Math.PI / 2 + i * 2 * Math.PI / n; return [Math.cos(a) * r, Math.sin(a) * r]; };
  const radarPath = (vals, r, max = 150) => vals.map((v, i) => { const d = r * Math.min(1, Math.max(0, v) / max), [x, y] = radarAxis(i, vals.length, d); return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`; }).join(' ') + 'Z';
  function radarHTML(series) {
    const R = 200, ST = U.ALL_STATS, n = ST.length;
    const rings = [50, 85, 100, 115, 150].map(v => `<path class="radar-ring" d="${radarPath(ST.map(() => v), R)}"></path>`).join('');
    const axes = ST.map((s, i) => {
      const [x, y] = radarAxis(i, n, R + 18), [x2, y2] = radarAxis(i, n, R);
      return `<line class="radar-axis" x1="0" y1="0" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"></line><text class="radar-label" x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${Math.abs(x) < 6 ? 'middle' : x > 0 ? 'start' : 'end'}" dominant-baseline="middle">${s.short}</text>`;
    }).join('');
    const paths = series.map(s => `<path d="${radarPath(ST.map(st => s.flat[st.k]), R)}" stroke-linejoin="round" style="fill:${s.glow ? 'rgba(var(--ac),0.16)' : 'none'};stroke:${s.stroke};stroke-width:${s.w};stroke-dasharray:${s.dash};filter:${s.glow ? 'drop-shadow(0 0 6px rgba(var(--ac),.5))' : 'none'}"></path>`).join('');
    return `<div class="radar-wrap"><div class="radar-disc" aria-hidden="true" data-deb="lg"></div><svg class="radar" role="img" aria-label="${esc('Radar of 21 feel stats for ' + series.map(x => x.label).join(', '))}" viewBox="-280 -280 560 560">${rings}${axes}${paths}</svg></div>`;
  }
  function barsHTML(series) {
    const cols = `minmax(90px,130px) repeat(${Math.max(1, series.length)}, minmax(0,1fr))`;
    return `<div class="btables">${U.LAYERS.map(L => `<div class="btable" role="table" aria-label="${L.title}"><span role="rowgroup"><span role="row" style="display:block"><span role="columnheader" class="caps">${L.title}</span></span></span><span role="rowgroup" class="btable-rows">${L.stats.map(st =>
      `<span role="row" class="brow" style="grid-template-columns:${cols}" data-k="${st.k}"><span role="rowheader" class="brow-h">${st.label}</span>${series.map(() => `<span role="cell" class="bcell"><span class="bcell-v"></span><span class="bcell-track" aria-hidden="true" data-deb="sm"><i class="bcell-fill"></i></span></span>`).join('')}</span>`).join('')}</span></div>`).join('')}</div>`;
  }
  function fillBars(series) {
    $('chart').querySelectorAll('.brow').forEach(row => {
      const vals = series.map(s => s.flat[row.dataset.k]), best = Math.max(...vals);
      [...row.querySelectorAll('.bcell')].forEach((cell, i) => {
        cell.classList.toggle('is-best', vals[i] === best && series.length > 1);
        setText(cell.firstElementChild, vals[i]);
        setStyle(cell.querySelector('.bcell-fill'), 'transform', `scaleX(${(barPct(vals[i]) / 100).toFixed(3)})`);
      });
    });
  }
  const renderCmpView = makeSeg($('cmpView'), [{ key: 'radar', label: 'Radar' }, { key: 'bars', label: 'Bars' }], () => S.cmpView, k => set({ cmpView: k }));
  $('cmpAdd').addEventListener('change', e => { const v = e.target.value; if (v) set({ cmp: [...S.cmp, v].slice(0, 6) }); });
  const legendEl = document.querySelector('.legend');
  legendEl.addEventListener('click', e => { const b = e.target.closest('[data-rm]'); if (b) set({ cmp: S.cmp.filter(c => c !== b.dataset.rm) }); });
  let cmpSig = { add: null, legend: null, chart: null, shape: null };
  function renderCompare(res) {
    const series = compareSeries(res), full = S.cmp.length >= 6;
    setText($('cmpCount'), series.length);
    // Add-to-compare menu
    const avail = entries.filter(e => !S.cmp.includes(e.id));
    const addSig = [S.cmp.join(), S.name, entries.length, full].join('|');
    if (addSig !== cmpSig.add) {
      cmpSig.add = addSig;
      const sel = $('cmpAdd');
      sel.innerHTML = `<option value="">${full ? 'Six slots full' : 'Add to compare…'}</option>` +
        (S.cmp.includes('current') ? '' : `<option value="current">${esc(S.name)} (editing)</option>`) +
        `<optgroup label="Ideal profiles">${IDEAL_NAMES.filter(a => !S.cmp.includes('ideal:' + a)).map(a => `<option value="ideal:${esc(a)}">Ideal ${esc(a)}</option>`).join('')}</optgroup>` +
        `<optgroup label="Saved players">${avail.map(e => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join('')}</optgroup>`;
      sel.value = ''; sel.disabled = full;
    }
    // Legend
    const legSig = series.map(s => s.id + s.label).join('|');
    if (legSig !== cmpSig.legend) {
      cmpSig.legend = legSig;
      const refocus = focusKey(legendEl, ['rm'], $('cmpAdd'));
      legendEl.querySelectorAll('li:not(.legend-hint)').forEach(li => li.remove());
      legendEl.insertAdjacentHTML('afterbegin', series.map(s => `<li><svg class="legend-line" aria-hidden="true" width="34" height="12" viewBox="0 0 34 12"><line x1="2" y1="6" x2="32" y2="6" stroke-linecap="round" style="stroke:${s.stroke};stroke-width:${s.w};stroke-dasharray:${s.dash};filter:${s.glow ? 'drop-shadow(0 0 5px rgba(var(--ac),.5))' : 'none'}"></line></svg><span class="legend-name">${esc(s.label)}</span><button type="button" class="round-btn" data-m="sm" data-rm="${esc(s.id)}" aria-label="${esc('Remove ' + s.label + ' from compare')}">${L_FACE}<svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"></path></svg></button></li>`).join(''));
      refocus();
      setText($('cmpHint'), series.length ? (series.length < 2 ? 'Add a second player or an ideal profile.' : '') : 'Nothing to compare yet.');
    }
    // Chart: radar rebuilds on any change; bars keep their cells so fills animate.
    const valSig = series.map(s => s.id + ':' + U.ALL_STATS.map(st => s.flat[st.k]).join(',')).join('|');
    if (S.cmpView === 'radar') {
      const sig = 'radar|' + S.theme + '|' + valSig + '|' + legSig;
      if (sig !== cmpSig.chart) { cmpSig.chart = sig; cmpSig.shape = null; $('chart').innerHTML = radarHTML(series); }
    } else {
      const shape = 'bars|' + series.map(s => s.id).join('|');
      if (shape !== cmpSig.shape) { cmpSig.shape = shape; cmpSig.chart = null; $('chart').innerHTML = barsHTML(series); requestAnimationFrame(() => fillBars(series)); }
      else if (valSig !== cmpSig.chart) fillBars(series);
      cmpSig.chart = valSig;
    }
    renderCmpView();
  }

  /* ═════════ 06 Squad ═════════ */
  const roleList = [{ key: '', label: 'All' }, ...U.ROLES.map(r => ({ key: r, label: r }))];
  const renderRoleSeg = makeSeg($('roleFilter'), roleList, () => S.filt.role, k => set({ filt: { ...S.filt, role: k } }));
  $('archFilter').innerHTML = '<option value="">All archetypes</option>' + U.ARCH_ATT.map(a => `<option value="${a}">Attacker · ${a}</option>`).join('') + U.ARCH_DEF.map(a => `<option value="${a}">Defender · ${a}</option>`).join('');
  $('archFilter').addEventListener('change', e => set({ filt: { ...S.filt, arch: e.target.value } }));
  const FILTER_SW = [['Primary only', 'primaryOnly'], ['Exclude secondary', 'exclSecondary']];
  $('sqFilters').insertAdjacentHTML('beforeend', FILTER_SW.map(([label]) => `<span class="sw-row">${switchHTML(label)}<span aria-hidden="true">${label}</span></span>`).join(''));
  const filterSws = [...$('sqFilters').querySelectorAll('.sw')].map((b, i) => {
    const key = FILTER_SW[i][1];
    b.addEventListener('click', () => set({ filt: { ...S.filt, [key]: !S.filt[key] } }));
    return { b, key };
  });
  function filterSquad(all, f) {
    return all.filter(e => {
      if (f.role && !(e.roles || []).includes(f.role)) return false;
      if (f.arch) {
        if (f.primaryOnly) return e.arch1 === f.arch && !e.arch2;
        if (f.exclSecondary) return e.arch1 === f.arch;
        return e.arch1 === f.arch || e.arch2 === f.arch;
      }
      return true;
    });
  }
  $('cards').addEventListener('click', e => {
    const load = e.target.closest('[data-load]'), cmp = e.target.closest('[data-cmpid]');
    if (cmp) { const id = cmp.dataset.cmpid; set({ cmp: S.cmp.includes(id) ? S.cmp.filter(x => x !== id) : [...S.cmp, id].slice(0, 6) }); }
    else if (load) { const en = entries.find(x => x.id === load.dataset.load); if (en) loadPlayer(en, load); }
  });
  // Save form
  $('formRoles').innerHTML = U.ROLES.map(r => `<button type="button" class="pill pill--tog" data-m="sm" data-hov data-on="false" aria-pressed="false" data-role="${r}">${L_FACE}<span>${r}</span></button>`).join('');
  const roleTogs = [...$('formRoles').children];
  roleTogs.forEach(b => b.addEventListener('click', () => {
    const r = b.dataset.role, roles = S.form.roles.includes(r) ? S.form.roles.filter(x => x !== r) : [...S.form.roles, r];
    set({ form: { ...S.form, roles } });
  }));
  $('formArch').innerHTML = [['Attacker archetypes', U.ARCH_ATT], ['Defender archetypes', U.ARCH_DEF]].map(([label, list]) =>
    `<div class="toggles" role="group" aria-label="${label}">${list.map(a => `<button type="button" class="pill pill--tog" data-m="sm" data-hov data-on="false" aria-pressed="false" data-arch="${a}">${L_FACE}<span>${a}</span><span class="rank mute"></span></button>`).join('')}</div>`).join('');
  const archTogs = [...$('formArch').querySelectorAll('[data-arch]')];
  archTogs.forEach(b => b.addEventListener('click', () => {
    const a = b.dataset.arch; let ar = S.form.arch;
    ar = ar.includes(a) ? ar.filter(x => x !== a) : ar.length < 2 ? [...ar, a] : [ar[0], a];
    set({ form: { ...S.form, arch: ar } });
  }));
  $('nameInput').addEventListener('input', e => { set({ name: e.target.value }); saveDraft(); });
  $('folderSel').addEventListener('change', e => set({ form: { ...S.form, folder: e.target.value } }));
  $('newFolderInput').addEventListener('input', e => { S.form = { ...S.form, newFolder: e.target.value }; });
  $('saveForm').addEventListener('submit', onSave);
  $('exportBtn').addEventListener('click', onExport);
  $('importBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', onFile);

  let sqSig = null, folderSig = null;
  function renderSquad() {
    const filtered = filterSquad(entries, S.filt);
    setText($('squadCount'), entries.length);
    renderRoleSeg();
    filterSws.forEach(w => setAttr(w.b, 'aria-checked', !!S.filt[w.key]));
    if ($('archFilter').value !== S.filt.arch) $('archFilter').value = S.filt.arch;
    const rows = filtered.map(e => {
      const res = entryRes(e), o = overall(res), inCmp = S.cmp.includes(e.id);
      return { e, o, inCmp, cur: S.fromId === e.id, meta: [(e.roles || []).join(' · '), [e.arch1, e.arch2].filter(Boolean).join(' / ')].filter(Boolean).join(' — ') || e.group };
    });
    const sig = rows.map(r => [r.e.id, r.e.name, r.meta, r.o, r.inCmp, r.cur].join(':')).join('|') + '|' + (S.cmp.length >= 6);
    if (sig !== sqSig) {
      sqSig = sig;
      const refocus = focusKey($('cards'), ['cmpid', 'load']);
      $('cards').innerHTML = rows.map(r => {
        const dis = !r.inCmp && S.cmp.length >= 6;
        return `<li><button type="button" class="card" data-m="sm" data-on="${r.cur}" data-load="${esc(r.e.id)}" aria-label="${esc(`Load ${r.e.name}, overall ${r.o}`)}">${L_FACE}<span class="card-name" data-name>${esc(r.e.name)}</span><span class="card-meta mute">${esc(r.meta)}</span><span class="card-ovr-row"><span class="card-ovr" data-ovr>${r.o}</span><span class="card-heat mute">${heat(r.o).word}</span></span></button>` +
          `<button type="button" class="card-cmp" data-m="sm" data-hov data-on="${r.inCmp}" aria-pressed="${r.inCmp}" aria-label="${esc((r.inCmp ? 'Remove ' : 'Add ') + r.e.name + (r.inCmp ? ' from compare' : ' to compare'))}" data-cmpid="${esc(r.e.id)}" title="Compare"${dis ? ' disabled' : ''}>${L_FACE}<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="${r.inCmp ? CHECK : PLUS}"></path></svg></button></li>`;
      }).join('');
      refocus();
    }
    setText($('sqCount'), filtered.length ? `${filtered.length} shown · select a card to load it` : 'No saved players match these filters.');
    // Form
    const ni = $('nameInput');
    if (document.activeElement !== ni && ni.value !== S.name) ni.value = S.name;
    const folders = [...new Set(['My saves', ...userFolders.map(f => f.name), ...seedFolders.map(f => f.name)].filter(Boolean))];
    if (S.form.folder !== '__new' && !folders.includes(S.form.folder)) folders.push(S.form.folder);
    const fsig = folders.join('|');
    if (fsig !== folderSig) { folderSig = fsig; $('folderSel').innerHTML = folders.map(f => `<option value="${esc(f)}">${esc(f)}</option>`).join('') + '<option value="__new">New folder…</option>'; }
    if ($('folderSel').value !== S.form.folder) $('folderSel').value = S.form.folder;
    $('newFolderField').hidden = S.form.folder !== '__new';
    roleTogs.forEach(b => { const on = S.form.roles.includes(b.dataset.role); setAttr(b, 'data-on', on); setAttr(b, 'aria-pressed', on); });
    archTogs.forEach(b => {
      const a = b.dataset.arch, i = S.form.arch.indexOf(a);
      setAttr(b, 'data-on', i >= 0); setAttr(b, 'aria-pressed', i >= 0);
      setAttr(b, 'aria-label', a + (i === 0 ? ', primary' : i === 1 ? ', secondary' : ''));
      setText(b.querySelector('.rank'), i === 0 ? '1st' : i === 1 ? '2nd' : '');
    });
    setText($('flash'), S.flash);
  }
  let flashT = 0;
  function flashMsg(m) { clearTimeout(flashT); set({ flash: m }); flashT = setTimeout(() => set({ flash: '' }), 3200); }
  const pickState = p => { const s = {}; Object.keys(E.DEFAULTS).forEach(k => { s[k] = p[k]; }); s.activePS = [...(p.activePS || [])]; return s; };
  function onSave(e) {
    e.preventDefault();
    const name = (S.name || '').trim() || 'Untitled';
    const folderName = S.form.folder === '__new' ? (S.form.newFolder.trim() || 'My saves') : S.form.folder;
    // Re-saving the loaded player (same name, same top folder) updates it where it lives, subfolders included.
    const src = entries.find(x => x.id === S.srcId);
    const path = src && src.group === folderName && src.name.toLowerCase() === name.toLowerCase() ? src.path : [folderName];
    let folder = null, list = userFolders;
    path.forEach(n => {
      folder = list.find(f => f.name === n);
      if (!folder) { folder = { id: genId(), name: n, open: true, players: [], subfolders: [] }; list.push(folder); }
      list = folder.subfolders;
    });
    const state = pickState(S.p), i = folder.players.findIndex(p => p.name.toLowerCase() === name.toLowerCase());
    const entry = {
      name, roles: [...S.form.roles], archetypePrimary: S.form.arch[0] || '', archetypeSecondary: S.form.arch[1] || '',
      state, ...E.computeFeel(state).flat, colorTags: i >= 0 ? (folder.players[i].colorTags || []) : [],
    };
    if (i >= 0) folder.players[i] = entry; else folder.players.push(entry);
    persistUser(); rebuildEntries();
    set({ name, fromId: 'e:' + (path.join('/') + '/' + name).toLowerCase(), srcId: 'e:' + (path.join('/') + '/' + name).toLowerCase(), form: { ...S.form, folder: folderName, newFolder: '' } });
    $('newFolderInput').value = '';
    flashMsg('Saved to ' + folderName);
  }
  function onExport() {
    const folders = sanitize(clone(seedFolders));
    mergeFolders(folders, clone(userFolders));
    const stamp = fs => fs.forEach(f => { f.players.forEach(p => Object.assign(p, E.computeFeel(p.state || {}).flat)); stamp(f.subfolders); });
    stamp(folders);
    const text = '// FC26 Calculator — Squad saves. Re-import via the "Import Saves" button.\nwindow.SQUAD_SAVES = ' + JSON.stringify({ folders }, null, 2) + ';\n';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
    a.download = 'Squad_saves.js'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  async function onFile(e) {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    try {
      const text = await f.text(), a = text.indexOf('{'), b = text.lastIndexOf('}');
      if (a < 0 || b < a) throw new Error('No saves found in file');
      const data = JSON.parse(text.slice(a, b + 1));
      if (!Array.isArray(data.folders)) throw new Error('No folders');
      const next = clone(userFolders), n = mergeFolders(next, sanitize(data.folders));
      userFolders = next; persistUser(); rebuildEntries(); set({});
      flashMsg(`Imported ${n} players`);
    } catch (err) { flashMsg('Could not read that file'); }
    e.target.value = '';
  }
  function loadPlayer(entry, tile) {
    const nm = tile.querySelector('[data-name]'), ov = tile.querySelector('[data-ovr]');
    const vis = sel => [...document.querySelectorAll(sel)].find(el => el.offsetParent), pk = vis('[data-puck-name]'), po = vis('[data-puck-ovr]');
    const nameT = (el, n) => { if (el) el.style.viewTransitionName = n; };
    const can = !RM && !!document.startViewTransition;
    if (can) { nameT(nm, pk ? 'pk-name' : ''); nameT(ov, po ? 'pk-ovr' : ''); }
    const p = { ...E.DEFAULTS, ...entry.state, activePS: [...(entry.state.activePS || [])] };
    const apply = () => {
      commit({ p, name: entry.name, fromId: entry.id, srcId: entry.id, raw: {}, ignite: false, form: { ...S.form, folder: entry.group, roles: [...(entry.roles || [])], arch: [entry.arch1, entry.arch2].filter(Boolean) } });
      if (can) { nameT(nm, ''); nameT(ov, ''); nameT(pk, 'pk-name'); nameT(po, 'pk-ovr'); }
    };
    const fin = () => { nameT(pk, ''); nameT(po, ''); nameT(nm, ''); nameT(ov, ''); saveDraft(); setTimeout(() => set({ ignite: true }), 60); };
    const t = can ? vt(apply) : (apply(), null);
    if (t) t.finished.then(fin, fin); else fin();
  }

  /* ═════════ Readout ═════════ */
  $('gauges').innerHTML = U.LAYERS.map(L => `<button type="button" class="gauge" data-m="sm" data-hov data-layer="${L.key}">${L_FACE}<span class="gauge-title">${L.title}</span><span class="gauge-avg"></span><span class="gauge-track" aria-hidden="true" data-deb="sm"><span class="gauge-glowclip"><i></i></span><span class="gauge-fillclip"><i></i></span></span></button>`).join('');
  const gauges = [...$('gauges').children].map(b => {
    b.addEventListener('click', () => go(3, () => toggleLayer(b.dataset.layer, true)));
    return { b, avg: b.querySelector('.gauge-avg'), glow: b.querySelector('.gauge-glowclip > i'), fill: b.querySelector('.gauge-fillclip > i') };
  });
  document.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => go(+b.dataset.go)));
  $('roSave').addEventListener('click', () => go(5, () => $('nameInput').focus({ preventScroll: true })));
  function renderReadout(res, ovr, sweep) {
    const H = heat(ovr);
    document.querySelectorAll('[data-puck-ovr]').forEach(el => setText(el, ovr));
    setText($('roName'), S.name); setText($('roHeat'), `${H.word} · ${H.range}`);
    document.querySelectorAll('.ring-glow, .ring-arc').forEach(el => setStyle(el, '--sweep', sweep));
    layersOf(res).forEach((L, i) => {
      const g = gauges[i], v = S.ignite ? L.avg : 0, h = heat(v), x = `translate3d(${(barPct(v) - 100).toFixed(2)}%,0,0)`;
      setText(g.avg, L.avg); setAttr(g.b, 'aria-label', `${L.title}, average ${L.avg}. Open details`);
      setStyle(g.fill, 'background', barFill(h)); setStyle(g.glow, 'box-shadow', barGlow(h));
      setStyle(g.fill, 'transform', x); setStyle(g.glow, 'transform', x);
    });
    const chem = U.CHEMS.find(c => c.key === S.p.chemStyle);
    setText($('roChem'), chem ? chem.name : 'None'); setText($('roPs'), S.p.activePS.length);
  }

  /* ═════════ Render ═════════ */
  const plane = $('plane'), camera = $('camera'), panels = [...document.querySelectorAll('[data-panel]')];
  function render() {
    if (!S.ready) return;
    const res = currentRes(), ovr = overall(res), sweep = S.ignite ? (barPct(ovr) / 100 * 270).toFixed(1) + 'deg' : '0deg';
    const [vc, vr] = POS[S.view];
    setStyle(plane, 'transform', `translate3d(${-vc * 33.3333}%,${-vr * 50}%,0)`);
    renderRail(ovr, sweep);
    renderBuild(); renderStyles(); renderChem(); renderFeel(res); renderCompare(res); renderSquad(); renderReadout(res, ovr, sweep);
  }
  const syncInert = (active, keep) => panels.forEach(el => { const i = +el.dataset.panel; el.inert = !(i === active || i === keep); });

  /* ═════════ View change: spring slide + camera dip ═════════ */
  let viewT = null, pA = null, cA = null;
  function go(i, after) {
    const prev = viewT ?? S.view;
    if (i === prev || i < 0 || i > 5 || !S.ready) { if (after) after(); return; }
    viewT = i;
    if (RM) {
      commit({ view: i }); syncInert(i);
      plane.animate([{ opacity: 0.25 }, { opacity: 1 }], { duration: 240 });
      if (after) after();
      return;
    }
    const cur = getComputedStyle(plane).transform, [c0, r0] = POS[prev], [c1, r1] = POS[i];
    const dx = c1 - c0, dy = r1 - r0, d = Math.hypot(dx, dy), dur = 980 + d * 240;
    syncInert(i, prev);
    if (pA) pA.cancel(); if (cA) cA.cancel();
    const a = pA = plane.animate([{ transform: cur === 'none' ? 'translate3d(0,0,0)' : cur }, { transform: `translate3d(${-c1 * 33.3333}%,${-r1 * 50}%,0)` }], { duration: dur, easing: SPRING_EASE });
    cA = camera.animate([
      { transform: 'scale(1)', easing: 'cubic-bezier(0.45,0,0.2,1)' },
      { transform: `scale(${(0.9 - 0.035 * d).toFixed(3)}) rotateX(${(-dy * 6).toFixed(1)}deg) rotateY(${(dx * 6).toFixed(1)}deg)`, offset: 0.4, easing: SOFT },
      { transform: 'none' }], { duration: dur });
    // Slide first; commit the heavier state update two frames later.
    requestAnimationFrame(() => requestAnimationFrame(() => { if (S.view !== viewT) set({ view: viewT }); }));
    a.finished.then(() => { if (viewT === i) syncInert(i); }, () => {});
    if (after) setTimeout(after, dur * 0.62);
  }

  /* ═════════ Theme: diagonal clip-path reveal ═════════ */
  function toggleTheme() {
    const next = S.theme === 'dark' ? 'light' : 'dark';
    const apply = () => {
      html.dataset.theme = next;
      $('themeColorMeta').setAttribute('content', next === 'dark' ? '#24272B' : '#E9E5DD');
      try { localStorage.setItem(KEY_THEME, next); } catch (e) {}
      commit({ theme: next });
    };
    const t = vt(apply);
    if (t) t.ready.then(() => html.animate({ clipPath: ['polygon(0 0, 0 0, 0 0)', 'polygon(0 0, 260% 0, 0 260%)'] }, { duration: 1100, easing: SOFT, pseudoElement: '::view-transition-new(root)' })).catch(() => {});
  }

  /* ═════════ Intro: tabs spring in, stage fades, parts rise ═════════ */
  const mechSet = m => { if (m) app.dataset.mech = m; else delete app.dataset.mech; };
  const mechCur = (...ids) => panels.forEach(el => { if (ids.includes(+el.dataset.panel)) el.dataset.cur = '1'; else delete el.dataset.cur; });
  // Stagger each part's rise by its distance across the panel.
  function stagger(i, span) {
    const panel = panels[i], pr = panel.getBoundingClientRect(), w = Math.max(1, pr.width), h = Math.max(1, Math.min(pr.height, innerHeight));
    const SH = '[data-m],[data-deb],[data-ext]', LEAF = ['svg', 'img', 'input', 'select']; let n = 0;
    panel.querySelectorAll('[data-fx]').forEach(el => el.removeAttribute('data-fx'));
    const delayOf = el => { const r = el.getBoundingClientRect(); const t = cl(((r.left + r.width / 2 - pr.left) / w + (r.top + r.height / 2 - pr.top) / h) / 2); return Math.round(t * span + (n++ * 37 % 41)); };
    const walk = (el, inh) => {
      for (const c of el.children) {
        const tag = c.tagName.toLowerCase(); if (tag === 'script' || tag === 'style' || c.hasAttribute('data-l')) continue;
        const shape = c.matches(SH); let d = inh;
        if (shape) { d = delayOf(c); c.style.setProperty('--d', d + 'ms'); }
        const own = [...c.childNodes].some(x => x.nodeType === 3 && x.textContent.trim());
        if (!shape && (LEAF.includes(tag) || !c.children.length || own)) { if (d == null) d = delayOf(c); c.dataset.fx = '1'; c.style.setProperty('--d', d + 'ms'); }
        else if (shape && own && ![...c.children].some(x => !x.hasAttribute('data-l'))) c.dataset.fx = '1';
        else if (c.children.length && !LEAF.includes(tag)) walk(c, shape ? d : inh);
      }
    };
    walk(panel, null);
  }
  function intro() {
    syncInert(S.view);
    if (RM) { mechSet(null); mechCur(); set({ ignite: true }); return; }
    tabBtns.forEach((el, i) => el.animate([{ opacity: 0, transform: 'scale(.6)' }, { opacity: 1, transform: 'none' }], { duration: 900, delay: 200 + i * 70, easing: SPRING_EASE, fill: 'backwards' }));
    $('stage').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 700, easing: SOFT, fill: 'backwards' });
    $('readout').animate([{ opacity: 0, transform: 'translate3d(28px,0,0)' }, { opacity: 1, transform: 'none' }], { duration: 1200, delay: 900, easing: SOFT, fill: 'backwards' });
    document.querySelectorAll('[data-breathe]').forEach(el => el.animate([{ opacity: 1 }, { opacity: 0.6 }], { duration: 3600, direction: 'alternate', iterations: Infinity, easing: 'ease-in-out' }));
    mechCur(S.view); mechSet('flat'); stagger(S.view, 520 * 1);
    setTimeout(() => { mechSet('rise'); setTimeout(() => { mechSet(null); mechCur(); }, 1900); }, 350);
    setTimeout(() => set({ ignite: true }), 1100);
  }

  /* ═════════ Global keys + layout mode ═════════ */
  window.addEventListener('keydown', e => {
    const t = e.target, typing = t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
    if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && e.key >= '1' && e.key <= '6') { e.preventDefault(); go(+e.key - 1); }
    if (e.key === 'Escape' && S.feelOpen) toggleLayer(S.feelOpen);
  });
  function onResize() {
    const w = innerWidth, mode = w < 760 ? 'narrow' : w < 1180 ? 'medium' : 'wide', short = innerHeight < 720;
    const sw = mode === 'wide' ? w - 456 : mode === 'medium' ? w - 150 : w - 36, feelRow = sw - 2 * cl(w * 0.03, 22, 40) >= 800;
    if (mode !== S.mode || short !== S.short || feelRow !== S.feelRow) set({ mode, short, feelRow });
  }
  window.addEventListener('resize', onResize);
  // The stage clips its plane; never let focus scrolling shift it.
  $('stage').addEventListener('scroll', e => { e.currentTarget.scrollTop = 0; e.currentTarget.scrollLeft = 0; });

  /* ═════════ Boot ═════════ */
  if (!RM) { mechCur(0); mechSet('flat'); }
  rebuildEntries();
  const draft = store.get(KEY_DRAFT, null), start = entries.find(x => /mbapp/i.test(x.name)) || entries[0];
  const p0 = draft && draft.p ? { ...E.DEFAULTS, ...draft.p } : start ? { ...E.DEFAULTS, ...start.state } : { ...E.DEFAULTS };
  p0.activePS = [...(p0.activePS || [])];
  Object.assign(S, { ready: true, p: p0, name: draft && draft.name ? draft.name : start ? start.name : 'New player', fromId: draft ? null : start ? start.id : null });
  onResize();
  render();
  requestAnimationFrame(intro);
})();
