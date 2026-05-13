/* ═══════════════════════════════════════════════════════════════
   UI — theme, layout toggles, save/load, compare, info tooltips
   ───────────────────────────────────────────────────────────────
   Wires DOM events to the calculator and renders the non-stat UI:
   panels opening/closing, saved-player folders, drag-and-drop,
   import/export, comparison view, and the inline info bubbles.
   Loaded last — runs the initial calculate() / renderAll() at the
   bottom so the calculator and animations are both ready.
   ═══════════════════════════════════════════════════════════════ */

  let isDark = document.documentElement.classList.contains('dark');

  function applyThemeColor() {
    const m = document.getElementById('themeColorMeta');
    if (m) m.setAttribute('content', isDark ? '#00352F' : '#f5f6f4');
  }

  function toggleTheme() {
    isDark = !isDark;
    document.documentElement.classList.toggle('dark', isDark);
    try { localStorage.setItem('fc26_theme', isDark ? 'dark' : 'light'); } catch(e) {}
    applyThemeColor();
    const btn = document.getElementById('themeToggle');
    btn.textContent = isDark ? '☀ Light' : '● Dark';

    // Let the stylesheet drive the body background (image in dark, flat in light)
    document.body.style.backgroundImage = '';

    // Update effColor thresholds yellow for dark/light
    calculate();
  }

  // Sync the toggle button label on page load if dark was restored from storage
  (function syncThemeButtonOnLoad() {
    const btn = document.getElementById('themeToggle');
    if (btn && isDark) btn.textContent = '☀️ Light';
    applyThemeColor();
  })();

  function cmToFtIn(cm) {
    const totalIn = cm / 2.54;
    const ft = Math.floor(totalIn / 12);
    const inch = Math.round(totalIn % 12);
    return `${ft}'${inch}"`;
  }

  document.getElementById('heightCm').addEventListener('input', function() {
    document.getElementById('heightDisplay').textContent = cmToFtIn(+this.value);
    calculate();
  });
  document.getElementById('heightDisplay').textContent = cmToFtIn(DEFAULT_HEIGHT);

  ['baseAccel','baseSprint','baseAgility','weight','strength','balance',
   // Extended stats — all trigger recalc to update passing/defending/shooting feel
   'shortPass','longPass','vision','crossing','curve','fkAccuracy',
   'standTackle','slideTackle','interceptions','headingAcc','defAwareness','aggression','jumping',
   'finishing','shotPower','longShots','volleys','attPositioning',
   'composure','reactions','ballControl','dribbling','stamina']
    .forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', calculate);
    });

  function selectAccel(el) {
    document.querySelectorAll('[data-type]').forEach(b => b.classList.remove('active'));
    el.classList.add('active');
    accelType = el.dataset.type;
    calculate();
  }

  function selectBuild(el) {
    document.querySelectorAll('[data-build]').forEach(b => b.classList.remove('active'));
    el.classList.add('active');
    buildType = el.dataset.build;
    calculate();
  }

  function togglePS(el) {
    const ps = el.dataset.ps;
    const group = el.dataset.group;
    document.querySelectorAll(`[data-group="${group}"]`).forEach(b => {
      if (b.dataset.ps !== ps) { activePS.delete(b.dataset.ps); b.classList.remove('active'); }
    });
    if (activePS.has(ps)) { activePS.delete(ps); el.classList.remove('active'); }
    else { activePS.add(ps); el.classList.add('active'); }
    calculate();
  }
  let breakdownOpen = false;
  let compareOpen = false;
  let compareView = 'radar';
  function setCompareView(mode) {
    if (mode !== 'radar' && mode !== 'bars') return;
    compareView = mode;
    const r = document.getElementById('compareViewRadar');
    const b = document.getElementById('compareViewBars');
    if (r) r.classList.toggle('active', mode === 'radar');
    if (b) b.classList.toggle('active', mode === 'bars');
    renderComparison();
  }
  let squadOpen = false;

  // ── SQUAD VIEW ──
  function toggleSquad() {
    squadOpen = !squadOpen;
    document.getElementById('squadBody').classList.toggle('open', squadOpen);
    document.getElementById('squadChevron').classList.toggle('open', squadOpen);
    if (squadOpen) renderSquad();
  }

  // Squad leaderboard config — composites are equal-weighted averages of each
  // layer's existing eff* sub-stats (the ones already shown in the feel-layer
  // cards). Don't reimplement the modifier pipeline — recalcEffStats does that.
  const SQUAD_LAYERS = [
    { key: 'movement',  label: 'Movement',  subs: [
      { label: 'Acc', key: 'effA' },
      { label: 'Spr', key: 'effS' },
      { label: 'Agi', key: 'effG' },
      { label: 'Ten', key: 'effT' },
      { label: 'Slp', key: 'effSlip' },
    ]},
    { key: 'passing',   label: 'Passing',   subs: [
      { label: 'Sht', key: 'effPassShort' },
      { label: 'Lng', key: 'effPassLong' },
      { label: 'Thr', key: 'effPassThrough' },
      { label: 'Crs', key: 'effPassCross' },
    ]},
    { key: 'defending', label: 'Defending', subs: [
      { label: 'Tck', key: 'effDefTackle' },
      { label: 'Pos', key: 'effDefPos' },
      { label: 'Int', key: 'effDefInt' },
      { label: 'Aer', key: 'effDefAer' },
      { label: 'Bly', key: 'effDefBully' },
      { label: 'Sld', key: 'effDefSlide' },
    ]},
    { key: 'shooting',  label: 'Shooting',  subs: [
      { label: 'Fin', key: 'effShootFin' },
      { label: 'Pwr', key: 'effShootPwr' },
      { label: 'Fns', key: 'effShootFine' },
      { label: 'Vol', key: 'effShootVol' },
      { label: 'Ldr', key: 'effShootLdr' },
      { label: 'FK',  key: 'effShootFk' },
    ]},
  ];

  // Persisted across re-renders. Default sort: Movement composite, descending.
  let squadSort = { key: '_movement', dir: 'desc' };
  const squadExpanded = { movement: false, passing: false, defending: false, shooting: false };

  function squadSortBy(key) {
    if (squadSort.key === key) {
      squadSort.dir = squadSort.dir === 'desc' ? 'asc' : 'desc';
    } else {
      squadSort = { key, dir: key === '_name' ? 'asc' : 'desc' };
    }
    renderSquad();
  }

  function squadToggleExpand(layerKey) {
    squadExpanded[layerKey] = !squadExpanded[layerKey];
    renderSquad();
  }

  function squadComposite(p, layerKey) {
    const layer = SQUAD_LAYERS.find(l => l.key === layerKey);
    const vals = layer.subs.map(s => +(p[s.key] || 0));
    return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
  }

  // Diverging heat: per-column scale, anchored at column median, capped at 99.
  // Values >99 get the overflow color (signals "off the charts").
  function squadHeatBg(v, cs) {
    if (v > 99) return { bg: 'rgb(var(--c-overflow) / 0.85)', overflow: true };
    if (cs.max99 === cs.min) return { bg: 'rgb(var(--c-line) / 0.25)' };
    if (v >= cs.median) {
      const span = Math.max(1, cs.max99 - cs.median);
      const t = Math.min(1, (v - cs.median) / span);
      return { bg: `rgb(var(--c-gain) / ${(0.06 + t * 0.55).toFixed(2)})` };
    }
    const span = Math.max(1, cs.median - cs.min);
    const t = Math.min(1, (cs.median - v) / span);
    return { bg: `rgb(var(--c-loss) / ${(0.06 + t * 0.50).toFixed(2)})` };
  }

  function renderSquad() {
    const data = loadData();
    const allPlayers = [];
    allFolders(data.folders).forEach(f => f.players.forEach(p => {
      const recalc = p.state ? recalcEffStats(p.state) : {};
      allPlayers.push({ ...p, ...recalc, folder: f.name });
    }));
    const el = document.getElementById('squadGrid');
    if (!allPlayers.length) {
      el.innerHTML = '<div class="no-saves">No saved players yet</div>';
      return;
    }

    const filterRole = document.getElementById('squadFilterRole')?.value || '';
    const filterArch = document.getElementById('squadFilterArch')?.value || '';
    const primaryOnly = document.getElementById('squadFilterPrimaryOnly')?.checked || false;
    const excludeSecondary = document.getElementById('squadFilterExcludeSecondary')?.checked || false;

    const filtered = allPlayers.filter(p => {
      const playerRoles = p.roles && p.roles.length ? p.roles : (p.role ? [p.role] : []);
      const playerArchs = [p.archetypePrimary, p.archetypeSecondary].filter(Boolean);
      const roleMatch = !filterRole || playerRoles.includes(filterRole);
      let archMatch;
      if (!filterArch) archMatch = true;
      else if (primaryOnly) archMatch = p.archetypePrimary === filterArch && !p.archetypeSecondary;
      else if (excludeSecondary) archMatch = p.archetypePrimary === filterArch;
      else archMatch = playerArchs.includes(filterArch);
      return roleMatch && archMatch;
    });

    if (!filtered.length) {
      el.innerHTML = '<div class="no-saves" style="margin-top:8px;">No players match these filters</div>';
      return;
    }

    // Stamp composite fields onto each player so they're sortable like any other key.
    filtered.forEach(p => {
      SQUAD_LAYERS.forEach(l => { p['_' + l.key] = squadComposite(p, l.key); });
    });

    // Active columns in render order — composites + (optionally) their subs inline.
    const activeColumns = [];
    SQUAD_LAYERS.forEach(layer => {
      activeColumns.push({ kind: 'composite', layer, key: '_' + layer.key, label: layer.label });
      if (squadExpanded[layer.key]) {
        layer.subs.forEach(s => {
          activeColumns.push({ kind: 'sub', layer, key: s.key, label: s.label });
        });
      }
    });

    // Per-column stats — min/median/max99 across all visible (filtered) rows.
    const colStats = {};
    activeColumns.forEach(col => {
      const vs = filtered.map(p => Math.min(99, +(p[col.key] || 0))).sort((a, b) => a - b);
      colStats[col.key] = {
        min: vs[0],
        median: vs[Math.floor(vs.length / 2)],
        max99: vs[vs.length - 1],
      };
    });

    // Top-3 ranks per visible column (across all filtered rows, regardless of group).
    const ranks = {};
    activeColumns.forEach(col => {
      const ranked = [...filtered]
        .map(p => ({ id: p.folderName + '|' + p.name, v: +(p[col.key] || 0) }))
        .sort((a, b) => b.v - a.v);
      ranks[col.key] = {};
      ranked.slice(0, 3).forEach((r, i) => { ranks[col.key][r.id] = i + 1; });
    });

    // Sort filtered list (sticky across re-renders via squadSort).
    const sortKey = squadSort.key;
    const dir = squadSort.dir === 'asc' ? 1 : -1;
    if (sortKey === '_name') {
      filtered.sort((a, b) => a.name.localeCompare(b.name) * dir);
    } else {
      filtered.sort((a, b) => ((+(a[sortKey] || 0)) - (+(b[sortKey] || 0))) * dir);
    }

    const buildLabels = { very_lean: 'V.Lean', lean: 'Lean', normal: 'Avg', stocky: 'Stocky', very_stocky: 'V.Stocky' };
    const sortInd = (key) => squadSort.key === key ? (squadSort.dir === 'desc' ? ' ▾' : ' ▴') : '';
    const sortClass = (key) => squadSort.key === key ? ' is-sorted' : '';

    // Header
    let header = `<tr class="squad-lb-header">
      <th class="squad-lb-name-col" onclick="squadSortBy('_name')">
        <span class="squad-lb-col-label${sortClass('_name')}">Player${sortInd('_name')}</span>
      </th>`;
    activeColumns.forEach(col => {
      if (col.kind === 'composite') {
        const open = squadExpanded[col.layer.key];
        header += `<th class="squad-lb-col layer-${col.layer.key}${open ? ' is-expanded' : ''}">
          <span class="squad-lb-col-label${sortClass(col.key)}" onclick="squadSortBy('${col.key}')">${esc(col.label)}${sortInd(col.key)}</span>
          <button class="squad-lb-expand" type="button" onclick="squadToggleExpand('${col.layer.key}')" aria-label="${open ? 'Collapse' : 'Expand'} ${esc(col.label)}">${open ? '−' : '+'}</button>
        </th>`;
      } else {
        header += `<th class="squad-lb-col squad-lb-substat squad-lb-substat-h${sortClass(col.key)}" onclick="squadSortBy('${col.key}')">${esc(col.label)}${sortInd(col.key)}</th>`;
      }
    });
    header += '</tr>';

    // Body — sorted rows, no role groups
    let body = '';
    filtered.forEach(p => {
      const id = p.folderName + '|' + p.name;
      const rs = (p.roles && p.roles.length ? p.roles : (p.role ? [p.role] : [])).join(' · ');
      const h = p.state?.heightCm ? cmToFtIn(p.state.heightCm) : '—';
      const build = buildLabels[p.state?.buildType] || '—';
      const arch = [p.archetypePrimary, p.archetypeSecondary].filter(Boolean).join(' / ');

      body += `<tr class="squad-lb-row">
        <td class="squad-lb-name">
          <div class="squad-lb-name-main">${esc(p.name)}</div>
          <div class="squad-lb-name-sub">
            ${rs ? `<span class="squad-lb-roles">${esc(rs)}</span>` : ''}
            ${arch ? `<span class="squad-lb-arch">${esc(arch)}</span>` : ''}
            <span>${esc(h)} · ${esc(build)}</span>
          </div>
        </td>`;

      activeColumns.forEach(col => {
        const v = +(p[col.key] || 0);
        if (!v) {
          body += `<td class="squad-lb-cell${col.kind === 'sub' ? ' is-substat squad-lb-substat' : ''}"><span class="squad-lb-num muted">—</span></td>`;
          return;
        }
        const heat = squadHeatBg(v, colStats[col.key]);
        const rank = ranks[col.key][id];
        const rankBadge = rank ? `<span class="squad-lb-rank rank-${rank}">${rank}</span>` : '';
        const subClass = col.kind === 'sub' ? ' is-substat squad-lb-substat' : '';
        const overflowClass = heat.overflow ? ' is-overflow' : '';
        body += `<td class="squad-lb-cell${subClass}${overflowClass}" style="background:${heat.bg};">
          ${rankBadge}<span class="squad-lb-num">${Math.round(v)}</span>
        </td>`;
      });
      body += '</tr>';
    });

    // Footer — median + max across all visible rows.
    const median = (arr) => { const s = [...arr].sort((a,b)=>a-b); return s[Math.floor(s.length/2)]; };
    const footRow = (label, fn) => {
      let r = `<tr class="squad-lb-foot"><td class="squad-lb-foot-label">${label}</td>`;
      activeColumns.forEach(col => {
        const all = filtered.map(p => +(p[col.key] || 0));
        const v = fn(all);
        const subClass = col.kind === 'sub' ? ' is-substat squad-lb-substat' : '';
        r += `<td class="squad-lb-cell${subClass}"><span class="squad-lb-num">${Math.round(v)}</span></td>`;
      });
      r += '</tr>';
      return r;
    };
    const footer = footRow('Median', median) + footRow('Max', a => Math.max(...a));

    el.innerHTML = `<div class="squad-lb-wrap">
      <table class="squad-lb-table">
        <thead>${header}</thead>
        <tbody>${body}</tbody>
        <tfoot>${footer}</tfoot>
      </table>
    </div>`;
  }
  // ── END SQUAD VIEW ──

  function toggleCompare() {
    compareOpen = !compareOpen;
    document.getElementById('compareBody').classList.toggle('open', compareOpen);
    document.getElementById('compareChevron').classList.toggle('open', compareOpen);
  }
  let savesOpen = true;
  let playstylesOpen = true;
  let chemStyleOpen = true;
  let passingFeelOpen = true;
  let defendingFeelOpen = true;
  let shootingFeelOpen = true;
  function togglePassingFeel() {
    passingFeelOpen = !passingFeelOpen;
    document.getElementById('passingFeelBody').classList.toggle('open', passingFeelOpen);
    document.getElementById('passingFeelChevron').classList.toggle('open', passingFeelOpen);
  }

  function toggleDefendingFeel() {
    defendingFeelOpen = !defendingFeelOpen;
    document.getElementById('defendingFeelBody').classList.toggle('open', defendingFeelOpen);
    document.getElementById('defendingFeelChevron').classList.toggle('open', defendingFeelOpen);
  }

  function toggleShootingFeel() {
    shootingFeelOpen = !shootingFeelOpen;
    document.getElementById('shootingFeelBody').classList.toggle('open', shootingFeelOpen);
    document.getElementById('shootingFeelChevron').classList.toggle('open', shootingFeelOpen);
  }

  let movementFeelOpen = true; // open by default — it's the primary container
  function toggleMovementFeel() {
    movementFeelOpen = !movementFeelOpen;
    document.getElementById('movementFeelBody').classList.toggle('open', movementFeelOpen);
    document.getElementById('movementFeelChevron').classList.toggle('open', movementFeelOpen);
  }

  let passingVerdictOpen = false;
  function togglePassingVerdict() {
    passingVerdictOpen = !passingVerdictOpen;
    document.getElementById('passingVerdictBody').classList.toggle('open', passingVerdictOpen);
    document.getElementById('passingVerdictChevron').classList.toggle('open', passingVerdictOpen);
  }

  let defendingVerdictOpen = false;
  function toggleDefendingVerdict() {
    defendingVerdictOpen = !defendingVerdictOpen;
    document.getElementById('defendingVerdictBody').classList.toggle('open', defendingVerdictOpen);
    document.getElementById('defendingVerdictChevron').classList.toggle('open', defendingVerdictOpen);
  }

  let shootingVerdictOpen = false;
  function toggleShootingVerdict() {
    shootingVerdictOpen = !shootingVerdictOpen;
    document.getElementById('shootingVerdictBody').classList.toggle('open', shootingVerdictOpen);
    document.getElementById('shootingVerdictChevron').classList.toggle('open', shootingVerdictOpen);
  }

  function toggleChemStyle() {
    chemStyleOpen = !chemStyleOpen;
    document.getElementById('chemStyleBody').classList.toggle('open', chemStyleOpen);
    document.getElementById('chemStyleChevron').classList.toggle('open', chemStyleOpen);
  }

  function toggleRole(chip) {
    chip.classList.toggle('active');
    calculate();
  }

  // Archetype chips: first click = primary, second click = secondary, third = off
  function toggleArchetype(chip) {
    const currentPrimary = document.querySelector('.archetype-chip.primary');
    const currentSecondary = document.querySelector('.archetype-chip.secondary');

    if (chip.classList.contains('primary')) {
      // Was primary → become secondary
      chip.classList.remove('primary');
      chip.classList.add('secondary');
    } else if (chip.classList.contains('secondary')) {
      // Was secondary → deselect
      chip.classList.remove('secondary');
    } else {
      // Not selected → become primary (demote existing primary to secondary if needed)
      if (currentPrimary && currentPrimary !== chip) {
        if (currentSecondary && currentSecondary !== chip) {
          // Already have two selected — deselect secondary first
          currentSecondary.classList.remove('secondary');
        }
        currentPrimary.classList.remove('primary');
        currentPrimary.classList.add('secondary');
      }
      chip.classList.add('primary');
    }
  }

  function clearArchetypeChips() {
    document.querySelectorAll('.archetype-chip').forEach(c => {
      c.classList.remove('primary', 'secondary');
    });
  }

  function clearRoleChips() {
    document.querySelectorAll('.role-chip').forEach(c => c.classList.remove('active'));
  }

  function selectChem(btn) {
    const chem = btn.dataset.chem;
    // Toggle off if already active
    if (activeChem === chem) {
      activeChem = null;
      document.querySelectorAll('[data-chemgroup="chem"]').forEach(b => b.classList.remove('active'));
    } else {
      activeChem = chem;
      document.querySelectorAll('[data-chemgroup="chem"]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    }
    calculate();
  }

  function togglePlaystyles() {
    playstylesOpen = !playstylesOpen;
    document.getElementById('playstylesBody').classList.toggle('open', playstylesOpen);
    document.getElementById('playstylesChevron').classList.toggle('open', playstylesOpen);
  }

  function toggleSaves() {
    savesOpen = !savesOpen;
    document.getElementById('savesBody').classList.toggle('open', savesOpen);
    document.getElementById('savesChevron').classList.toggle('open', savesOpen);
  }

  function toggleBreakdown() {
    breakdownOpen = !breakdownOpen;
    document.getElementById('breakdownBody').classList.toggle('open', breakdownOpen);
    document.getElementById('breakdownChevron').classList.toggle('open', breakdownOpen);
  }

  function resetAll() {
    document.getElementById('baseAccel').value    = 80;
    document.getElementById('baseSprint').value   = 80;
    document.getElementById('baseAgility').value  = 80;
    document.getElementById('heightCm').value     = DEFAULT_HEIGHT;
    document.getElementById('heightDisplay').textContent = cmToFtIn(DEFAULT_HEIGHT);
    document.getElementById('weight').value    = DEFAULT_WEIGHT;
    document.getElementById('strength').value  = DEFAULT_STR;
    document.getElementById('balance').value   = DEFAULT_BAL;

    // Reset all extended stats to 70
    ['shortPass','longPass','vision','crossing','curve','fkAccuracy',
     'standTackle','slideTackle','interceptions','headingAcc','defAwareness','aggression','jumping',
     'finishing','shotPower','longShots','volleys','attPositioning',
     'composure','reactions','ballControl','dribbling','stamina'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = 70;
    });

    accelType = 'controlled';
    buildType = 'normal';
    activeChem = null;
    activePS.clear();

    document.querySelectorAll('[data-type]').forEach(b => { b.classList.remove('active'); if(b.dataset.type==='controlled') b.classList.add('active'); });
    document.querySelectorAll('[data-build]').forEach(b => { b.classList.remove('active'); if(b.dataset.build==='normal') b.classList.add('active'); });
    document.querySelectorAll('[data-chemgroup="chem"]').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.ps-btn').forEach(b => b.classList.remove('active'));
    clearRoleChips();
    clearArchetypeChips();

    calculate();
  }
  function getState() {
    const s = {
      chemStyle: activeChem,
      baseAccel:   +document.getElementById('baseAccel').value,
      baseSprint:  +document.getElementById('baseSprint').value,
      baseAgility: +document.getElementById('baseAgility').value,
      heightCm:    +document.getElementById('heightCm').value,
      weight:      +document.getElementById('weight').value,
      strength:    +document.getElementById('strength').value,
      balance:     +document.getElementById('balance').value,
      accelType,
      buildType,
      activePS: [...activePS],
    };
    // Capture all extended stats
    EXT_STAT_IDS.forEach(id => {
      const el = document.getElementById(id);
      s[id] = el ? (+el.value || 70) : 70;
    });
    return s;
  }

  function applyState(s) {
    document.getElementById('baseAccel').value   = s.baseAccel;
    document.getElementById('baseSprint').value  = s.baseSprint;
    document.getElementById('baseAgility').value = s.baseAgility;
    document.getElementById('heightCm').value    = s.heightCm;
    document.getElementById('heightDisplay').textContent = cmToFtIn(s.heightCm);
    document.getElementById('weight').value   = s.weight;
    document.getElementById('strength').value = s.strength;
    document.getElementById('balance').value  = s.balance;
    // Restore extended stats — default to 70 for any missing fields (graceful migration)
    EXT_STAT_IDS.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = (s[id] != null) ? s[id] : 70;
    });
    accelType = s.accelType;
    buildType = s.buildType;
    activePS  = new Set(s.activePS);
    document.querySelectorAll('[data-type]').forEach(b => { b.classList.remove('active'); if (b.dataset.type === accelType) b.classList.add('active'); });
    document.querySelectorAll('[data-build]').forEach(b => { b.classList.remove('active'); if (b.dataset.build === buildType) b.classList.add('active'); });
    document.querySelectorAll('.ps-btn').forEach(b => { if (activePS.has(b.dataset.ps)) b.classList.add('active'); else b.classList.remove('active'); });
    // Restore chem style
    activeChem = s.chemStyle || null;
    document.querySelectorAll('[data-chemgroup="chem"]').forEach(b => {
      b.classList.toggle('active', b.dataset.chem === activeChem);
    });
    calculate();
  }

  // ── Nested folder helpers ────────────────────────────────────────────────

  function genId() { return Math.random().toString(36).slice(2, 9); }

  function findFolder(folders, id) {
    for (const f of folders) {
      if (f.id === id) return f;
      const found = findFolder(f.subfolders || [], id);
      if (found) return found;
    }
    return null;
  }

  function findParentFolder(folders, childId) {
    for (const f of folders) {
      if ((f.subfolders || []).some(sf => sf.id === childId)) return f;
      const found = findParentFolder(f.subfolders || [], childId);
      if (found) return found;
    }
    return null;
  }

  function removeFolder(folders, id) {
    const idx = folders.findIndex(f => f.id === id);
    if (idx >= 0) { folders.splice(idx, 1); return true; }
    for (const f of folders) {
      if (removeFolder(f.subfolders || [], id)) return true;
    }
    return false;
  }

  function allFolders(folders, result = []) {
    for (const f of folders) {
      result.push(f);
      allFolders(f.subfolders || [], result);
    }
    return result;
  }

  function migrateData(data) {
    function ensureFolder(f) {
      if (!f.id) f.id = genId();
      if (!f.subfolders) f.subfolders = [];
      if (!f.players) f.players = [];
      (f.subfolders || []).forEach(ensureFolder);
    }
    (data.folders || []).forEach(ensureFolder);
    return data;
  }

  function loadData() {
    try { return JSON.parse(localStorage.getItem('fc26_data') || '{"folders":[]}'); }
    catch { return { folders: [] }; }
  }

  function persistData(data) {
    localStorage.setItem('fc26_data', JSON.stringify(data));
  }

  function createFolder() {
    const name = document.getElementById('folderName').value.trim();
    if (!name) { document.getElementById('folderName').focus(); return; }
    const data = loadData();
    if (data.folders.find(f => f.name.toLowerCase() === name.toLowerCase())) {
      document.getElementById('folderName').value = '';
      return;
    }
    data.folders.push({ id: genId(), name, open: true, players: [], subfolders: [] });
    persistData(data);
    document.getElementById('folderName').value = '';
    renderAll();
  }

  function deleteFolder(id) {
    const data = loadData();
    migrateData(data);
    removeFolder(data.folders, id);
    persistData(data);
    renderAll();
  }

  function toggleFolder(id) {
    const data = loadData();
    migrateData(data);
    const folder = findFolder(data.folders, id);
    if (!folder) return;
    const wasOpen = folder.open;

    // Find the sibling list (same level as this folder)
    const parent = findParentFolder(data.folders, id);
    const siblings = parent ? (parent.subfolders || []) : data.folders;

    // Close all siblings at this level only
    siblings.forEach(f => f.open = false);

    // Toggle this folder
    folder.open = !wasOpen;
    persistData(data);
    renderAll();
  }

  function savePlayer() {
    const name = document.getElementById('playerName').value.trim();
    const folderId = document.getElementById('folderSelect').value;
    if (!name) { document.getElementById('playerName').focus(); return; }
    if (!folderId) { document.getElementById('folderSelect').focus(); return; }
    const data = loadData();
    migrateData(data);
    const folder = findFolder(data.folders, folderId);
    if (!folder) return;
    const entry = {
      name,
      roles: Array.from(document.querySelectorAll('.role-chip.active')).map(c => c.dataset.role),
      archetypePrimary: document.querySelector('.archetype-chip.primary')?.dataset.arch || '',
      archetypeSecondary: document.querySelector('.archetype-chip.secondary')?.dataset.arch || '',
      state: getState(),
      effA: +document.getElementById('numAccelEff').textContent,
      effS: +document.getElementById('numSprintEff').textContent,
      effG: +document.getElementById('numAgilityEff').textContent,
      effT: +document.getElementById('numTenacityEff').textContent,
      effSlip: +document.getElementById('numSlipEff').textContent,
      // Passing layer
      effPassShort:   +document.getElementById('numPassShortEff').textContent   || 0,
      effPassLong:    +document.getElementById('numPassLongEff').textContent    || 0,
      effPassThrough: +document.getElementById('numPassThroughEff').textContent || 0,
      effPassCross:   +document.getElementById('numPassCrossEff').textContent   || 0,
      // Defending layer
      effDefTackle: +document.getElementById('numDefTackleEff').textContent || 0,
      effDefPos:    +document.getElementById('numDefPosEff').textContent    || 0,
      effDefInt:    +document.getElementById('numDefIntEff').textContent    || 0,
      effDefAer:    +document.getElementById('numDefAerEff').textContent    || 0,
      effDefBully:  +document.getElementById('numDefBullyEff').textContent  || 0,
      effDefSlide:  +document.getElementById('numDefSlideEff').textContent  || 0,
      // Shooting layer
      effShootFin:  +document.getElementById('numShootFinEff').textContent  || 0,
      effShootPwr:  +document.getElementById('numShootPwrEff').textContent  || 0,
      effShootFine: +document.getElementById('numShootFineEff').textContent || 0,
      effShootVol:  +document.getElementById('numShootVolEff').textContent  || 0,
      effShootLdr:  +document.getElementById('numShootLdrEff').textContent  || 0,
      effShootFk:   +document.getElementById('numShootFkEff').textContent   || 0,
    };
    const existing = folder.players.findIndex(p => p.name.toLowerCase() === name.toLowerCase());
    if (existing >= 0) folder.players[existing] = entry;
    else folder.players.push(entry);
    persistData(data);
    document.getElementById('playerName').value = '';
    renderAll();
  }

  function deletePlayer(folderId, playerName) {
    const data = loadData();
    migrateData(data);
    const folder = findFolder(data.folders, folderId);
    if (folder) folder.players = folder.players.filter(p => p.name !== playerName);
    persistData(data);
    renderAll();
  }

  function loadPlayer(folderId, playerName) {
    const data = loadData();
    migrateData(data);
    const folder = findFolder(data.folders, folderId);
    if (!folder) return;
    const player = folder.players.find(p => p.name === playerName);
    if (!player) return;
    applyState(player.state);
    document.getElementById('playerName').value = playerName;
    document.querySelectorAll('.role-chip').forEach(c => {
      const roles = player.roles || (player.role ? [player.role] : []);
      c.classList.toggle('active', roles.includes(c.dataset.role));
    });
    clearArchetypeChips();
    document.querySelectorAll('.archetype-chip').forEach(c => {
      if (c.dataset.arch === player.archetypePrimary) c.classList.add('primary');
      else if (c.dataset.arch === player.archetypeSecondary) c.classList.add('secondary');
    });
    document.getElementById('folderSelect').value = folderId;
  }

  function esc(str) { return (str || '').replace(/'/g, "\\'"); }

  function renderFolderSelect() {
    const data = loadData();
    migrateData(data);
    const sel = document.getElementById('folderSelect');
    const current = sel.value;
    function opts(folders, prefix) {
      return folders.flatMap(f => [
        `<option value="${f.id}"${f.id===current?' selected':''}>${prefix}${f.name} (${f.players.length})</option>`,
        ...opts(f.subfolders || [], prefix + '\u00a0\u00a0\u00a0')
      ]);
    }
    sel.innerHTML = '<option value="">Select folder...</option>' + opts(data.folders, '').join('');
  }

  // Drag state
  let dragSrcFolderId = null;
  let dragSrcPlayerId = null;
  let dragSrcPlayer = null;

  function renderFolderGroup(folder, depth = 0) {
    const indent = depth * 14;
    const playersHtml = folder.players.length
      ? folder.players.map(p => `
        <div class="saved-player"
          ondragstart="onPlayerDragStart(event,'${esc(folder.id)}','${esc(p.name)}')"
          ondragover="onPlayerDragOver(event)"
          ondragleave="onPlayerDragLeave(event)"
          ondrop="onPlayerDrop(event,'${esc(folder.id)}','${esc(p.name)}')"
          ondragend="onDragEnd(event)">
          <span class="drag-handle" onmousedown="setDraggable(event,true)" onmouseup="setDraggable(event,false)">⠿</span>
          <div class="saved-player-info">
            <div class="saved-player-name" onclick="startRename(event,'${esc(folder.id)}','${esc(p.name)}')" title="Click to rename" style="cursor:text;">
              ${p.name}
              ${p.archetypePrimary ? `<span class="player-arch-tag primary-arch">${p.archetypePrimary}</span>` : ''}
              ${p.archetypeSecondary ? `<span class="player-arch-tag secondary-arch">/ ${p.archetypeSecondary}</span>` : ''}
            </div>
          </div>
          <div class="saved-player-actions">
            <button class="load-btn" onclick="loadPlayer('${esc(folder.id)}','${esc(p.name)}')">Load</button>
            <button class="delete-btn" onclick="deletePlayer('${esc(folder.id)}','${esc(p.name)}')">Del</button>
          </div>
        </div>`).join('')
      : '';

    const subHtml = (folder.subfolders || []).map(sf => renderFolderGroup(sf, depth + 1)).join('');
    const totalCount = folder.players.length + (folder.subfolders || []).reduce((acc, sf) => acc + allFolders([sf]).reduce((a, f) => a + f.players.length, 0), 0);

    return `
      <div class="folder-group" style="margin-left:${Math.min(indent, 28)}px;"
        ondragstart="onFolderDragStart(event,'${esc(folder.id)}')"
        ondragover="onFolderDragOver(event)"
        ondragleave="onFolderDragLeave(event)"
        ondrop="onFolderDrop(event,'${esc(folder.id)}')"
        ondragend="onDragEnd(event)">
        <div class="folder-header" onclick="toggleFolder('${esc(folder.id)}')">
          <div class="folder-header-left">
            <span class="drag-handle" style="margin-right:4px;" onmousedown="setDraggable(event,true)" onmouseup="setDraggable(event,false)">⠿</span>
            <span class="folder-chevron ${folder.open ? 'open' : ''}">▶</span>
            <span class="folder-name-text" onclick="startFolderRename(event,'${esc(folder.id)}')" title="Click to rename" style="cursor:text;">${folder.name}</span>
            <span class="folder-count">${totalCount} player${totalCount !== 1 ? 's' : ''}</span>
          </div>
          <button class="folder-delete-btn" onclick="event.stopPropagation();deleteFolder('${esc(folder.id)}')">✕</button>
        </div>
        <div class="folder-contents ${folder.open ? 'open' : ''}">${playersHtml}${subHtml}</div>
      </div>`;
  }

  function renderSaves() {
    const data = loadData();
    migrateData(data); // ensure all folders have ids — mutates in place
    persistData(data); // save migrated data back so ids are stable
    const el = document.getElementById('savedPlayersList');
    if (!data.folders.length) {
      el.innerHTML = '<div class="no-saves">No folders yet — create one above</div>';
      return;
    }
    el.innerHTML = data.folders.map(f => renderFolderGroup(f, 0)).join('');
  }
  function onFolderDragStart(e, folderId) {
    dragSrcFolderId = folderId;
    dragSrcPlayer = null;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', folderId);
  }

  function onFolderDragOver(e) {
    e.preventDefault();
    e.currentTarget.classList.add('drag-over');
  }

  function onFolderDragLeave(e) {
    e.currentTarget.classList.remove('drag-over');
  }

  function onFolderDrop(e, targetFolderId) {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');
    const data = migrateData(loadData());

    // Player dropped onto folder header — move player into that folder
    if (dragSrcPlayer) {
      if (dragSrcPlayerId === targetFolderId) return;
      const src = findFolder(data.folders, dragSrcPlayerId);
      const tgt = findFolder(data.folders, targetFolderId);
      if (!src || !tgt) return;
      const idx = src.players.findIndex(p => p.name === dragSrcPlayer);
      if (idx < 0) return;
      const [moved] = src.players.splice(idx, 1);
      tgt.players.push(moved);
      persistData(data);
      renderAll();
      return;
    }

    // Folder dropped onto folder — nest it inside, or reorder if same parent
    if (!dragSrcFolderId || dragSrcFolderId === targetFolderId) return;

    // Prevent dropping a folder into its own descendant
    const srcFolder = findFolder(data.folders, dragSrcFolderId);
    if (!srcFolder) return;
    if (findFolder(srcFolder.subfolders || [], targetFolderId)) return; // would create cycle

    // Remove from current location
    const srcParent = findParentFolder(data.folders, dragSrcFolderId);
    const srcList = srcParent ? (srcParent.subfolders || []) : data.folders;
    const srcIdx = srcList.findIndex(f => f.id === dragSrcFolderId);
    if (srcIdx < 0) return;
    const [movedFolder] = srcList.splice(srcIdx, 1);

    // Insert as subfolder of target
    const tgtFolder = findFolder(data.folders, targetFolderId);
    if (!tgtFolder) return;
    if (!tgtFolder.subfolders) tgtFolder.subfolders = [];
    tgtFolder.subfolders.push(movedFolder);

    persistData(data);
    renderAll();
  }

  function onPlayerDragStart(e, folderId, playerName) {
    dragSrcPlayerId = folderId;
    dragSrcPlayer = playerName;
    dragSrcFolderId = null;
    e.stopPropagation();
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', playerName);
  }

  function onPlayerDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.classList.add('drag-over');
  }

  function onPlayerDragLeave(e) {
    e.currentTarget.classList.remove('drag-over');
  }

  function onPlayerDrop(e, targetFolderId, targetPlayer) {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.classList.remove('drag-over');
    if (!dragSrcPlayer || dragSrcPlayer === targetPlayer) return;
    const data = migrateData(loadData());
    const srcFolder = findFolder(data.folders, dragSrcPlayerId);
    const tgtFolder = findFolder(data.folders, targetFolderId);
    if (!srcFolder || !tgtFolder) return;
    const fromIdx = srcFolder.players.findIndex(p => p.name === dragSrcPlayer);
    if (fromIdx < 0) return;
    const [moved] = srcFolder.players.splice(fromIdx, 1);
    const toIdx = tgtFolder.players.findIndex(p => p.name === targetPlayer);
    tgtFolder.players.splice(toIdx >= 0 ? toIdx : tgtFolder.players.length, 0, moved);
    persistData(data);
    renderAll();
  }

  function setDraggable(e, val) {
    e.stopPropagation();
    const parent = e.currentTarget.closest('.folder-group, .saved-player');
    if (parent) parent.draggable = val;
  }

  function onDragEnd(e) {
    dragSrcFolderId = null;
    dragSrcPlayer = null;
    dragSrcPlayerId = null;
    // Remove draggable from all elements after drag ends
    document.querySelectorAll('.folder-group, .saved-player').forEach(el => el.draggable = false);
    document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  }

  function startFolderRename(e, folderId) {
    e.stopPropagation();
    const nameEl = e.currentTarget;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = nameEl.textContent.trim();
    input.className = 'rename-input';
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    function commit() {
      const newName = input.value.trim();
      if (newName) {
        const data = migrateData(loadData());
        const folder = findFolder(data.folders, folderId);
        if (folder) { folder.name = newName; persistData(data); }
      }
      renderAll();
    }

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { input.blur(); }
      if (e.key === 'Escape') { renderAll(); }
    });
  }

  function startRename(e, folderId, playerName) {
    e.stopPropagation();
    const nameEl = e.currentTarget;
    const current = playerName;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = current;
    input.className = 'rename-input';
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    function commit() {
      const newName = input.value.trim();
      if (newName && newName !== current) {
        const data = migrateData(loadData());
        const folder = findFolder(data.folders, folderId);
        if (folder) {
          const player = folder.players.find(p => p.name === current);
          const conflict = folder.players.find(p => p.name === newName);
          if (player && !conflict) {
            player.name = newName;
            persistData(data);
          }
        }
      }
      renderAll();
    }

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { input.blur(); }
      if (e.key === 'Escape') { input.value = current; input.blur(); }
    });
  }

  function renderAll() {
    renderFolderSelect();
    renderSaves();
    if (typeof populateCompareSelects === 'function') populateCompareSelects();
    if (squadOpen) renderSquad();
  }
  let ioMode = 'export';

  function showExport() {
    ioMode = 'export';
    const data = loadData();
    const json = JSON.stringify(data);
    document.getElementById('ioPanelLabel').textContent = 'Copy this JSON and save it as a .json file';
    document.getElementById('ioTextarea').value = json;
    document.getElementById('ioTextarea').readOnly = true;
    document.getElementById('ioActionBtn').textContent = 'Copy to Clipboard';
    document.getElementById('ioPanel').style.display = 'block';
    document.getElementById('ioTextarea').select();
  }

  function showImport() {
    ioMode = 'import';
    document.getElementById('ioPanelLabel').textContent = 'Paste your exported JSON below and click Import';
    document.getElementById('ioTextarea').value = '';
    document.getElementById('ioTextarea').readOnly = false;
    document.getElementById('ioTextarea').placeholder = 'Paste JSON here...';
    document.getElementById('ioActionBtn').textContent = 'Import';
    document.getElementById('ioPanel').style.display = 'block';
    document.getElementById('ioTextarea').focus();
  }

  function closeIO() {
    document.getElementById('ioPanel').style.display = 'none';
    document.getElementById('ioTextarea').value = '';
  }

  function ioAction() {
    if (ioMode === 'export') {
      const text = document.getElementById('ioTextarea').value;
      navigator.clipboard.writeText(text).then(() => {
        document.getElementById('ioActionBtn').textContent = 'Copied!';
        setTimeout(() => document.getElementById('ioActionBtn').textContent = 'Copy to Clipboard', 2000);
      }).catch(() => {
        document.getElementById('ioTextarea').select();
        document.execCommand('copy');
        document.getElementById('ioActionBtn').textContent = 'Copied!';
        setTimeout(() => document.getElementById('ioActionBtn').textContent = 'Copy to Clipboard', 2000);
      });
    } else {
      try {
        const json = document.getElementById('ioTextarea').value.trim();
        const imported = JSON.parse(json);
        if (!imported.folders || !Array.isArray(imported.folders)) {
          alert('Invalid data — folders not found.');
          return;
        }
        // Ensure all imported folders have ids and subfolders (migration)
        function ensureIds(folders) {
          folders.forEach(f => {
            if (!f.id) f.id = genId();
            if (!f.subfolders) f.subfolders = [];
            if (!f.players) f.players = [];
            ensureIds(f.subfolders);
          });
        }
        ensureIds(imported.folders);
        const existingData = loadData();
        const hasExisting = (existingData.folders || []).length > 0;
        if (hasExisting && !confirm('Import will replace all of your current saves with the imported data. Continue?')) return;
        persistData({ folders: imported.folders });
        renderAll();
        closeIO();
        alert('Import successful.');
      } catch(err) {
        alert('Invalid JSON — make sure you pasted the full export.');
      }
    }
  }

  // ---- Comparison Tool ----

  function getAllPlayers() {
    const data = loadData();
    migrateData(data);
    const players = [];
    allFolders(data.folders).forEach(f => f.players.forEach(p => players.push({ folderId: f.id, folderName: f.name, folder: f.name, ...p })));
    return players;
  }

  // Ideal archetype reference profiles. Values are target effective stats —
  // what an exemplar of each archetype "feels" like. Used as virtual entries
  // in compare slots so users can benchmark a real player against an ideal.
  const IDEAL_ARCHETYPES = {
    'Assassin':      { kind: 'attacker', effA:135, effS:110, effG:140, effT:70,  effSlip:145, effPassShort:105, effPassLong:90,  effPassThrough:110, effPassCross:95,  effDefTackle:70,  effDefPos:75,  effDefInt:75,  effDefAer:60,  effDefBully:60,  effDefSlide:70,  effShootFin:110, effShootPwr:95,  effShootFine:115, effShootVol:100, effShootLdr:100, effShootFk:95  },
    'Fighter':       { kind: 'attacker', effA:130, effS:115, effG:130, effT:100, effSlip:130, effPassShort:105, effPassLong:95,  effPassThrough:105, effPassCross:100, effDefTackle:85,  effDefPos:85,  effDefInt:80,  effDefAer:70,  effDefBully:90,  effDefSlide:80,  effShootFin:115, effShootPwr:110, effShootFine:110, effShootVol:105, effShootLdr:110, effShootFk:100 },
    'Bulldozer':     { kind: 'attacker', effA:110, effS:100, effG:100, effT:130, effSlip:100, effPassShort:100, effPassLong:100, effPassThrough:95,  effPassCross:100, effDefTackle:95,  effDefPos:90,  effDefInt:90,  effDefAer:100, effDefBully:130, effDefSlide:90,  effShootFin:120, effShootPwr:130, effShootFine:100, effShootVol:110, effShootLdr:120, effShootFk:100 },
    'Jungler':       { kind: 'attacker', effA:125, effS:130, effG:115, effT:105, effSlip:115, effPassShort:100, effPassLong:105, effPassThrough:105, effPassCross:105, effDefTackle:85,  effDefPos:85,  effDefInt:85,  effDefAer:115, effDefBully:95,  effDefSlide:90,  effShootFin:115, effShootPwr:115, effShootFine:105, effShootVol:110, effShootLdr:110, effShootFk:100 },
    'Freight Train': { kind: 'attacker', effA:115, effS:135, effG:95,  effT:130, effSlip:100, effPassShort:95,  effPassLong:105, effPassThrough:95,  effPassCross:100, effDefTackle:95,  effDefPos:90,  effDefInt:90,  effDefAer:130, effDefBully:130, effDefSlide:95,  effShootFin:120, effShootPwr:130, effShootFine:95,  effShootVol:115, effShootLdr:120, effShootFk:95  },
    'Surgeon':       { kind: 'defender', effA:115, effS:105, effG:125, effT:105, effSlip:120, effPassShort:115, effPassLong:110, effPassThrough:105, effPassCross:105, effDefTackle:130, effDefPos:130, effDefInt:130, effDefAer:75,  effDefBully:90,  effDefSlide:115, effShootFin:85,  effShootPwr:90,  effShootFine:95,  effShootVol:85,  effShootLdr:90,  effShootFk:95  },
    'Bruiser':       { kind: 'defender', effA:105, effS:105, effG:105, effT:120, effSlip:105, effPassShort:105, effPassLong:105, effPassThrough:95,  effPassCross:100, effDefTackle:120, effDefPos:120, effDefInt:115, effDefAer:110, effDefBully:115, effDefSlide:115, effShootFin:95,  effShootPwr:105, effShootFine:90,  effShootVol:90,  effShootLdr:95,  effShootFk:90  },
    'Brawler':       { kind: 'defender', effA:100, effS:100, effG:100, effT:130, effSlip:95,  effPassShort:100, effPassLong:100, effPassThrough:90,  effPassCross:95,  effDefTackle:125, effDefPos:115, effDefInt:110, effDefAer:110, effDefBully:130, effDefSlide:115, effShootFin:90,  effShootPwr:110, effShootFine:85,  effShootVol:95,  effShootLdr:95,  effShootFk:85  },
    'Spider':        { kind: 'defender', effA:105, effS:115, effG:110, effT:105, effSlip:105, effPassShort:105, effPassLong:110, effPassThrough:95,  effPassCross:100, effDefTackle:120, effDefPos:125, effDefInt:120, effDefAer:130, effDefBully:110, effDefSlide:130, effShootFin:90,  effShootPwr:105, effShootFine:90,  effShootVol:90,  effShootLdr:95,  effShootFk:85  },
    'Wall':          { kind: 'defender', effA:90,  effS:100, effG:90,  effT:135, effSlip:90,  effPassShort:100, effPassLong:105, effPassThrough:90,  effPassCross:95,  effDefTackle:125, effDefPos:120, effDefInt:115, effDefAer:140, effDefBully:140, effDefSlide:110, effShootFin:95,  effShootPwr:115, effShootFine:85,  effShootVol:95,  effShootLdr:100, effShootFk:85  },
  };

  const COMPARE_MIN_SLOTS = 2;
  const COMPARE_MAX_SLOTS = 6;

  // Radar grid: four feel-layer charts shown above the bar table.
  // Axes and keys mirror the bar table so headers stay consistent.
  const RADAR_LAYERS = [
    { key: 'movement', title: 'Movement', axes: [
      { label: 'Accel',     k: 'effA' },
      { label: 'Sprint',    k: 'effS' },
      { label: 'Agility',   k: 'effG' },
      { label: 'Tenacity',  k: 'effT' },
      { label: 'Slip',      k: 'effSlip' },
    ]},
    { key: 'passing', title: 'Passing', axes: [
      { label: 'Short',     k: 'effPassShort' },
      { label: 'Long',      k: 'effPassLong' },
      { label: 'Through',   k: 'effPassThrough' },
      { label: 'Cross',     k: 'effPassCross' },
    ]},
    { key: 'defending', title: 'Defending', axes: [
      { label: 'Tackle',    k: 'effDefTackle' },
      { label: 'Position',  k: 'effDefPos' },
      { label: 'Intercept', k: 'effDefInt' },
      { label: 'Aerial',    k: 'effDefAer' },
      { label: 'Bully',     k: 'effDefBully' },
      { label: 'Slide',     k: 'effDefSlide' },
    ]},
    { key: 'shooting', title: 'Shooting', axes: [
      { label: 'Finish',    k: 'effShootFin' },
      { label: 'Power',     k: 'effShootPwr' },
      { label: 'Finesse',   k: 'effShootFine' },
      { label: 'Volley',    k: 'effShootVol' },
      { label: 'Low Driven',k: 'effShootLdr' },
      { label: 'FK',        k: 'effShootFk' },
    ]},
  ];

  // Effective stats can exceed 99 in this calc (caps at 150). Rings sit at
  // the same perceptual thresholds the calculator uses for stat coloring:
  // 85 = baseline, 100 = strong, 115 = elite.
  const RADAR_MAX = 150;
  const RADAR_RINGS = [85, 100, 115];

  function radarSVG(layer, entries) {
    const W = 240, H = 240, cx = W / 2, cy = H / 2, r = 72;
    const N = layer.axes.length;
    const ang = i => (2 * Math.PI * i / N) - Math.PI / 2;
    const ptAt = (i, frac) => {
      const a = ang(i);
      return [cx + r * frac * Math.cos(a), cy + r * frac * Math.sin(a)];
    };
    const polyPts = frac => layer.axes.map((_, i) =>
      ptAt(i, frac).map(n => n.toFixed(1)).join(',')
    ).join(' ');

    let svg = `<svg viewBox="0 0 ${W} ${H}" class="radar-svg" preserveAspectRatio="xMidYMid meet">`;

    svg += '<g class="radar-grid-lines">';
    RADAR_RINGS.forEach(v => { svg += `<polygon points="${polyPts(v / RADAR_MAX)}"/>`; });
    svg += `<polygon class="radar-outer" points="${polyPts(1)}"/>`;
    layer.axes.forEach((_, i) => {
      const [x, y] = ptAt(i, 1);
      svg += `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`;
    });
    svg += '</g>';

    entries.forEach((p, pi) => {
      const pts = layer.axes.map((a, i) => {
        const v = Math.max(0, Math.min(RADAR_MAX, +p[a.k] || 0));
        return ptAt(i, v / RADAR_MAX).map(n => n.toFixed(1)).join(',');
      }).join(' ');
      const slot = pi + 1;
      svg += `<polygon class="radar-poly radar-slot-${slot}" points="${pts}" `
           + `style="fill:rgb(var(--slot-${slot}) / 0.22);stroke:rgb(var(--slot-${slot}));"/>`;
    });

    layer.axes.forEach((a, i) => {
      const vals = entries.map(p => +p[a.k] || 0);
      const max = Math.max(...vals);
      const min = Math.min(...vals);
      const allClose = (max - min) <= 3;
      const winnerIdx = !allClose ? vals.indexOf(max) : -1;

      const angle = ang(i);
      const labelR = r + 14;
      const lx = cx + labelR * Math.cos(angle);
      const ly = cy + labelR * Math.sin(angle);
      const cosA = Math.cos(angle), sinA = Math.sin(angle);
      const anchor = cosA > 0.3 ? 'start' : cosA < -0.3 ? 'end' : 'middle';
      const dy = sinA > 0.3 ? '0.75em' : sinA < -0.3 ? '-0.15em' : '0.35em';

      const tipLines = entries.map((p, pi) => `${p.name}: ${vals[pi]}`);
      if (!allClose) tipLines.push(`Δ ${max - min} — ${entries[winnerIdx].name} leads`);
      const tip = tipLines.join('\n');

      const cls = winnerIdx >= 0
        ? `radar-label radar-label-winner radar-slot-${winnerIdx + 1}`
        : 'radar-label';
      const styleAttr = winnerIdx >= 0
        ? ` style="--slot-color: var(--slot-${winnerIdx + 1});"`
        : '';
      svg += `<text class="${cls}"${styleAttr} x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" `
           + `text-anchor="${anchor}" dy="${dy}"><title>${esc(tip)}</title>${a.label}</text>`;
    });

    svg += '</svg>';
    return svg;
  }

  // FLIP: capture First rect, apply Last state, then animate transform back to identity.
  // Makes the card appear to grow from its original grid cell into the centered zoom.
  function flipFromTo(el, firstRect) {
    const last = el.getBoundingClientRect();
    if (last.width === 0 || last.height === 0) return;
    const dx = firstRect.left - last.left;
    const dy = firstRect.top - last.top;
    const sx = firstRect.width / last.width;
    const sy = firstRect.height / last.height;
    el.style.transformOrigin = 'top left';
    el.style.transition = 'none';
    el.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
    void el.offsetWidth; // force reflow so the inverted transform paints first
    el.style.transition = 'transform 420ms cubic-bezier(0.32, 0.72, 0.24, 1)';
    el.style.transform = '';
    const cleanup = (e) => {
      if (e.propertyName !== 'transform') return;
      el.style.transition = '';
      el.style.transform = '';
      el.style.transformOrigin = '';
      el.removeEventListener('transitionend', cleanup);
    };
    el.addEventListener('transitionend', cleanup);
  }

  function toggleRadarZoom(layerKey) {
    const grid = document.querySelector('#compareResults .radar-grid');
    if (!grid) return;
    const target = grid.querySelector(`.radar-card[data-layer="${layerKey}"]`);
    if (!target) return;
    const wasZoomed = target.classList.contains('is-zoomed');
    const first = target.getBoundingClientRect();

    grid.querySelectorAll('.radar-card').forEach(c => c.classList.remove('is-zoomed'));
    if (wasZoomed) {
      grid.classList.remove('has-zoomed');
    } else {
      grid.classList.add('has-zoomed');
      target.classList.add('is-zoomed');
    }
    flipFromTo(target, first);
  }

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const grid = document.querySelector('#compareResults .radar-grid.has-zoomed');
    if (!grid) return;
    const zoomed = grid.querySelector('.radar-card.is-zoomed');
    const first = zoomed && zoomed.getBoundingClientRect();
    grid.classList.remove('has-zoomed');
    grid.querySelectorAll('.radar-card').forEach(c => c.classList.remove('is-zoomed'));
    if (zoomed && first) flipFromTo(zoomed, first);
  });

  function radarBlockHTML(entries) {
    const legend = entries.map((p, i) => {
      const slot = i + 1;
      return `<span class="radar-legend-item" style="--slot-color: var(--slot-${slot});">
        <span class="radar-legend-swatch"></span>
        <span><b>${esc(p.name)}</b>${p.folder ? ` <span class="radar-legend-folder">— ${esc(p.folder)}</span>` : ''}</span>
      </span>`;
    }).join('');

    const cards = RADAR_LAYERS.map(layer => `
      <div class="radar-card layer-${layer.key}" data-layer="${layer.key}" onclick="toggleRadarZoom('${layer.key}')" role="button" tabindex="0">
        <div class="radar-title"><span class="radar-title-dot"></span>${layer.title}</div>
        ${radarSVG(layer, entries)}
        <div class="radar-card-hint">Click to return</div>
      </div>`).join('');

    return `<div class="radar-legend">${legend}</div>
      <div class="radar-grid">${cards}</div>`;
  }

  function buildCompareOptions() {
    const players = getAllPlayers();
    let html = '<option value="">Select…</option>';
    if (players.length) {
      const byFolder = new Map();
      players.forEach(p => {
        const key = p.folderId;
        if (!byFolder.has(key)) byFolder.set(key, { name: p.folderName, players: [] });
        byFolder.get(key).players.push(p);
      });
      [...byFolder.values()].forEach(f => {
        html += `<optgroup label="${esc(f.name) || 'Unfiled'}">`;
        html += f.players.map(p => `<option value="player::${esc(p.folderId)}||${esc(p.name)}">${esc(p.name)}</option>`).join('');
        html += '</optgroup>';
      });
    }
    html += '<optgroup label="Ideal — Attackers">';
    Object.entries(IDEAL_ARCHETYPES).filter(([_,v]) => v.kind === 'attacker')
      .forEach(([k]) => { html += `<option value="ideal::${esc(k)}">★ Ideal ${esc(k)}</option>`; });
    html += '</optgroup><optgroup label="Ideal — Defenders">';
    Object.entries(IDEAL_ARCHETYPES).filter(([_,v]) => v.kind === 'defender')
      .forEach(([k]) => { html += `<option value="ideal::${esc(k)}">★ Ideal ${esc(k)}</option>`; });
    html += '</optgroup>';
    return html;
  }

  function ensureCompareSlots() {
    const wrap = document.getElementById('compareSlots');
    if (!wrap) return;
    if (!wrap.children.length) {
      for (let i = 0; i < COMPARE_MIN_SLOTS; i++) addCompareSlot(true);
    }
  }

  function addCompareSlot(skipRender) {
    const wrap = document.getElementById('compareSlots');
    if (!wrap) return;
    if (wrap.children.length >= COMPARE_MAX_SLOTS) return;
    const idx = wrap.children.length;
    const slot = document.createElement('div');
    slot.className = 'compare-slot';
    slot.innerHTML = `
      <div class="compare-slot-head">
        <label class="compare-label">Slot ${idx + 1}</label>
        <button class="compare-slot-remove" type="button" title="Remove slot" onclick="removeCompareSlot(this)">×</button>
      </div>
      <select class="folder-select compare-slot-select" onchange="renderComparison()">
        ${buildCompareOptions()}
      </select>`;
    wrap.appendChild(slot);
    refreshCompareSlotControls();
    if (!skipRender) renderComparison();
  }

  function removeCompareSlot(btn) {
    const wrap = document.getElementById('compareSlots');
    if (!wrap) return;
    if (wrap.children.length <= COMPARE_MIN_SLOTS) return;
    btn.closest('.compare-slot').remove();
    refreshCompareSlotControls();
    renderComparison();
  }

  function refreshCompareSlotControls() {
    const wrap = document.getElementById('compareSlots');
    if (!wrap) return;
    const slots = [...wrap.children];
    slots.forEach((s, i) => {
      const lbl = s.querySelector('.compare-label');
      if (lbl) lbl.textContent = `Slot ${i + 1}`;
      const rm = s.querySelector('.compare-slot-remove');
      if (rm) rm.disabled = slots.length <= COMPARE_MIN_SLOTS;
    });
    const addBtn = document.getElementById('compareAddBtn');
    if (addBtn) addBtn.disabled = slots.length >= COMPARE_MAX_SLOTS;
  }

  function populateCompareSelects() {
    ensureCompareSlots();
    const wrap = document.getElementById('compareSlots');
    if (!wrap) return;
    const opts = buildCompareOptions();
    [...wrap.querySelectorAll('.compare-slot-select')].forEach(sel => {
      const prev = sel.value;
      sel.innerHTML = opts;
      if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
    });
    refreshCompareSlotControls();
    renderComparison();
  }

  function getCompareEntry(value) {
    if (!value) return null;
    if (value.startsWith('ideal::')) {
      const name = value.slice(7);
      const profile = IDEAL_ARCHETYPES[name];
      if (!profile) return null;
      return {
        kind: 'ideal',
        name: `Ideal ${name}`,
        folder: profile.kind === 'attacker' ? 'Attacker archetype' : 'Defender archetype',
        ...profile,
      };
    }
    if (value.startsWith('player::')) {
      const [folderId, name] = value.slice(8).split('||');
      const p = getAllPlayers().find(p => p.folderId === folderId && p.name === name);
      if (!p) return null;
      const recalc = recalcEffStats(p.state);
      return { kind: 'player', ...p, ...recalc };
    }
    return null;
  }

  function renderComparison() {
    const el = document.getElementById('compareResults');
    if (!el) return;
    const wrap = document.getElementById('compareSlots');
    const selects = wrap ? [...wrap.querySelectorAll('.compare-slot-select')] : [];
    const entries = selects.map(s => getCompareEntry(s.value));
    const filled = entries.filter(Boolean);

    if (filled.length < 2) {
      el.innerHTML = '<div class="compare-empty">Pick at least two players or archetypes to compare</div>';
      return;
    }

    const stats = [
      { group: 'Movement' },
      { label: 'Acceleration',  k: 'effA' },
      { label: 'Sprint Speed',  k: 'effS', isSprint: true },
      { label: 'Agility',       k: 'effG' },
      { label: 'Tenacity',      k: 'effT', isTenacity: true },
      { label: 'Slipperiness',  k: 'effSlip' },
      { group: 'Passing' },
      { label: 'Short Pass',    k: 'effPassShort'   },
      { label: 'Long Pass',     k: 'effPassLong'    },
      { label: 'Through Ball',  k: 'effPassThrough' },
      { label: 'Cross',         k: 'effPassCross'   },
      { group: 'Defending' },
      { label: 'Tackle',        k: 'effDefTackle' },
      { label: 'Positioning',   k: 'effDefPos'    },
      { label: 'Interception',  k: 'effDefInt'    },
      { label: 'Aerial',        k: 'effDefAer'    },
      { label: 'Bully',         k: 'effDefBully'  },
      { label: 'Slide Tackles', k: 'effDefSlide'  },
      { group: 'Shooting' },
      { label: 'Finishing',     k: 'effShootFin'  },
      { label: 'Shot Power',    k: 'effShootPwr'  },
      { label: 'Finesse',       k: 'effShootFine' },
      { label: 'Volley',        k: 'effShootVol'  },
      { label: 'Low Driven',    k: 'effShootLdr'  },
      { label: 'Free Kick',     k: 'effShootFk'   },
    ];

    const maxVal = 120;
    const colCount = filled.length + 1;
    const multi = filled.length >= 3;
    const midBar = multi ? 'rgb(var(--c-line-strong))' : 'var(--neutral)';

    const rows = stats.map(s => {
      if (s.group) {
        return `<tr><td colspan="${colCount}" style="padding:12px 0 4px;font-size:0.6rem;letter-spacing:0.18em;text-transform:uppercase;color:var(--ink-muted);font-family:'Geist','Inter',sans-serif;font-weight:600;border-bottom:1px solid var(--hairline);">${s.group}</td></tr>`;
      }
      const vals = filled.map(p => +p[s.k] || 0);
      const max = Math.max(...vals);
      const min = Math.min(...vals);
      const allClose = (max - min) <= 3;
      return `<tr>
        <td class="stat-col">${s.label}</td>
        ${vals.map(v => {
          const isWin = !allClose && v === max;
          const isLose = !allClose && v === min;
          const cls = isWin ? 'winner' : isLose ? 'loser' : 'draw';
          const barCol = isWin ? 'var(--gain)' : isLose ? 'var(--loss)' : midBar;
          const w = Math.min(100, Math.round((v / maxVal) * 100));
          return `<td>
            <span class="${cls}">${v}</span>
            <div class="compare-bar-wrap"><div class="compare-bar" style="width:${w}%;background:${barCol}"></div></div>
          </td>`;
        }).join('')}
      </tr>`;
    }).join('');

    const headerCols = filled.map((p, i) => {
      const slot = i + 1;
      const sub = p.kind === 'ideal'
        ? `<span style="font-size:0.6rem;color:var(--accent4);font-weight:500">${esc(p.folder)}</span>`
        : `<span style="font-size:0.6rem;color:var(--muted);font-weight:400">${esc(p.folder || '')}</span>`;
      return `<th class="col-slot" style="--slot-color: var(--slot-${slot});">${esc(p.name)}<br>${sub}</th>`;
    }).join('');
    const subHeaderCols = filled.map((_, i) => {
      const slot = i + 1;
      return `<th class="col-slot" style="--slot-color: var(--slot-${slot});">${i + 1}</th>`;
    }).join('');

    const idealNote = filled.some(p => p.kind === 'ideal')
      ? '<div style="font-size:0.65rem;color:var(--ink-muted);text-align:center;margin-bottom:10px;letter-spacing:0.06em;font-style:italic;">★ Ideal profiles are reference targets — what an exemplar of that archetype tends to feel like</div>'
      : '';

    const body = compareView === 'radar'
      ? radarBlockHTML(filled)
      : `<table class="compare-table">
          <thead>
            <tr class="compare-name-row">
              <th class="stat-col"></th>
              ${headerCols}
            </tr>
            <tr>
              <th class="stat-col">Stat</th>
              ${subHeaderCols}
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`;

    el.innerHTML = idealNote + body;
  }
  const INFO_MAP = {
    // ─── Base movement stats ───
    baseAccel:   { title: 'Acceleration', body: 'Your raw burst off the mark. Affects: Effective Acceleration. Modified by: build (lean → faster), height, weight, strength, Quickstep, Rapid, First Touch, chem style.' },
    baseSprint:  { title: 'Sprint Speed', body: 'Your top speed once at full pace. Affects: Effective Sprint Speed. Modified by: AcceleRATE type (lengthy → higher), height, weight, Quickstep, Rapid.' },
    baseAgility: { title: 'Agility', body: 'Your turning sharpness. Affects: Effective Agility, Slipperiness, Dribbling Feel, Short Pass Feel, Through Ball Feel, Finesse Feel, Volley Feel. Modified by: height, weight, strength, Technical, Rapid, Trickster.' },
    balance:     { title: 'Balance', body: 'How upright you stay when jostled. Affects: Effective Tenacity, all shot feel at high values, Bully Feel. Modified by: nothing — balance stays as entered.' },
    heightCm:    { title: 'Height', body: 'Affects: Effective Acceleration, Sprint, Agility, Tenacity, Aerial Feel, Bully Feel, Low Driven Feel. Taller → wider turning arc, better headers, better low-driven recoil from the ground.' },
    weight:      { title: 'Weight', body: 'Affects: Effective Acceleration, Sprint, Agility, Tenacity, Tackle Feel, Bully Feel, Power Shot Feel. Heavier → more physics resistance and harder to shift off the ball.' },
    strength:    { title: 'Strength', body: 'Affects: Effective Tenacity, Tackle Feel, Bully Feel. High strength also adds self-resistance to movement — Enforcer+ unlocks it.' },

    // ─── Extended stats ───
    shortPass:      { title: 'Short Pass', body: 'Affects: Short Pass Feel, Through Ball Feel.' },
    longPass:       { title: 'Long Pass',  body: 'Affects: Long Pass Feel. Pinged Pass and Long Ball Pass scale off this.' },
    vision:         { title: 'Vision',     body: 'Affects: Through Ball Feel. Unlocks line-breaking passes when high.' },
    crossing:       { title: 'Crossing',   body: 'Affects: Cross Feel. Whipped Pass scales off this.' },
    curve:          { title: 'Curve',      body: 'Affects: Cross Feel, Through Ball Feel, Finesse Shot Feel.' },
    fkAccuracy:     { title: 'FK Accuracy', body: 'Affects: Free Kick Taker Feel (overwhelmingly — 85% of the base formula). This is the primary stat for set-piece quality. Pairs with Dead Shot (Freekick) for elite free-kick specialists.' },
    standTackle:    { title: 'Standing Tackle', body: 'Affects: Tackle Feel, Bully Feel. The primary driver of standing-tackle quality.' },
    slideTackle:    { title: 'Sliding Tackle', body: 'Affects: Slide Tackles Feel (primary), Bully Feel. No longer contributes to standing Tackle Feel — it has its own metric.' },
    interceptions:  { title: 'Interceptions', body: 'Affects: Interception Feel. Intercept playstyle scales off this.' },
    headingAcc:     { title: 'Heading Accuracy', body: 'Affects: Aerial Feel.' },
    defAwareness:   { title: 'Defensive Awareness', body: 'Affects: Positioning Feel. Huge impact when over 75.' },
    aggression:     { title: 'Aggression', body: 'Affects: Tackle Feel, Bully Feel. Sweet spot is 82–88; over 88 brings reckless fouls.' },
    jumping:        { title: 'Jumping', body: 'Affects: Aerial Feel.' },
    finishing:      { title: 'Finishing', body: 'Affects: Finishing Feel, Low Driven Feel.' },
    shotPower:      { title: 'Shot Power', body: 'Affects: Power Shot Feel, Low Driven Feel.' },
    longShots:      { title: 'Long Shots', body: 'Affects: Finesse Feel. Blended into finesse shot quality from distance.' },
    volleys:        { title: 'Volleys', body: 'Affects: Volley Feel. First Time Shot scales off this.' },
    attPositioning: { title: 'Attacking Positioning', body: 'Affects: Finishing Feel. Finding space in the box.' },
    composure:      { title: 'Composure', body: 'Affects: all Passing Feel, Tackle Feel, all Shooting Feel, Low Driven Feel. The most universal modifier in the game.' },
    reactions:      { title: 'Reactions', body: 'Affects: all Passing Feel, Interception Feel, Finishing Feel. Kicks in over 80.' },
    ballControl:    { title: 'Ball Control', body: 'Affects: Effective Agility (averaged with Dribbling, every 5 points from 75 shifts Agility ±1).' },
    dribbling:      { title: 'Dribbling', body: 'Affects: Effective Agility (averaged with Ball Control, every 5 points from 75 shifts Agility ±1). Close-control stat — higher values make the ball feel tighter to your feet.' },
    stamina:        { title: 'Stamina', body: 'Affects: endurance in long games. Not currently factored into any effective feel layer.' },

    // ─── Playstyles — movement ───
    quickstep:         { title: 'Quickstep', body: 'Accel +5, Sprint +1. Boosts Effective Acceleration and Sprint Speed.' },
    quickstep_plus:    { title: 'Quickstep+', body: 'Accel +10, Sprint +2. Major burst off the mark.' },
    rapid:             { title: 'Rapid', body: 'Accel +2, Agility +2. Slight agility-biased speed boost.' },
    rapid_plus:        { title: 'Rapid+', body: 'Accel +5, Agility +5. Turns short runs into separation moments.' },
    technical:         { title: 'Technical', body: 'Agility +5. Also contributes to Slipperiness and Dribbling Feel.' },
    technical_plus:    { title: 'Technical+', body: 'Agility +10. Big boost to close control, Slipperiness, Dribbling Feel.' },
    first_touch:       { title: 'First Touch', body: 'Accel +2. Also contributes to Dribbling Feel.' },
    first_touch_plus:  { title: 'First Touch+', body: 'Accel +5. Better ball settling, improved Dribbling Feel.' },
    trickster:         { title: 'Trickster', body: 'Agility +2, Dribbling Feel +6. Unlocks flair moves and tighter turns.' },
    trickster_plus:    { title: 'Trickster+', body: 'Agility +4, Dribbling Feel +12. Elite close-quarters ball manipulation.' },
    enforcer:          { title: 'Enforcer', body: 'Tenacity +5. Extra resistance in physical duels.' },
    enforcer_plus:     { title: 'Enforcer+', body: 'Tenacity +10. Unlocks high strength properly; adds to Bully Feel indirectly.' },
    bruiser:           { title: 'Bruiser', body: 'Bully Feel +6. Shoulder barges land with more force — harder for attackers to run through you.' },
    bruiser_plus:      { title: 'Bruiser+', body: 'Bully Feel +12. Opponents bounce off contact — a proper enforcer in 1v1s.' },
    press_proven:      { title: 'Press Proven', body: 'Slipperiness +2, Tenacity +2. Keeps composure and body shape when pressed by multiple defenders.' },
    press_proven_plus: { title: 'Press Proven+', body: 'Slipperiness +5, Tenacity +5. Big lift under high press — stays slippery and resistant when surrounded.' },
    relentless:        { title: 'Relentless', body: 'Cosmetic only — no mechanical effect in this calculator. In-game, it reduces fatigue effects late in matches.' },
    relentless_plus:   { title: 'Relentless+', body: 'Cosmetic only — no mechanical effect in this calculator. In-game, it further reduces fatigue effects across the full match.' },

    // ─── Playstyles — passing ───
    incisive:         { title: 'Incisive Pass', body: 'Through Ball Feel +8. Breaks defensive lines.' },
    incisive_plus:    { title: 'Incisive Pass+', body: 'Through Ball Feel +15. Elite line-breaking distribution.' },
    pinged:           { title: 'Pinged Pass', body: 'Long Pass Feel +8. Accurate long-range distribution.' },
    pinged_plus:      { title: 'Pinged Pass+', body: 'Long Pass Feel +15. Switches of play become reliable.' },
    long_ball:        { title: 'Long Ball Pass', body: 'Long Pass Feel +4, Through Ball +6. Diagonal balls over the top into attacking areas.' },
    long_ball_plus:   { title: 'Long Ball Pass+', body: 'Long Pass Feel +10, Through Ball +12. Hollywood passes that actually land.' },
    whipped:          { title: 'Whipped Pass', body: 'Cross Feel +8. Adds pace and curl to crosses.' },
    whipped_plus:     { title: 'Whipped Pass+', body: 'Cross Feel +20. Dangerous delivery from wide areas.' },
    tiki_taka:        { title: 'Tiki Taka', body: 'Short Pass +5, Through Ball +2. Quick one-twos and third-man runs.' },
    tiki_taka_plus:   { title: 'Tiki Taka+', body: 'Short Pass +10, Through Ball +4. Devastating in tight spaces.' },

    // ─── Playstyles — defending ───
    intercept_ps:       { title: 'Intercept', body: 'Interception Feel +8. Reads passing lanes.' },
    intercept_ps_plus:  { title: 'Intercept+', body: 'Interception Feel +15. Cuts out passes consistently.' },
    block:              { title: 'Block', body: 'Positioning Feel +6. Throws body into shooting lanes.' },
    block_plus:         { title: 'Block+', body: 'Positioning Feel +12. Elite shot-blocking positioning.' },
    jockey:             { title: 'Jockey', body: 'Positioning Feel +6. Better defensive shape in 1v1s.' },
    jockey_plus:        { title: 'Jockey+', body: 'Positioning Feel +12. Forces attackers wide.' },
    anticipate:         { title: 'Anticipate', body: 'Tackle Feel +8. Reads and times tackles earlier.' },
    anticipate_plus:    { title: 'Anticipate+', body: 'Tackle Feel +15. Reads the attacker before they commit, and subtly helps resist being brushed aside.' },
    aerial:             { title: 'Aerial', body: 'Aerial Feel +10. Better header contact.' },
    aerial_plus:        { title: 'Aerial+', body: 'Aerial Feel +18. Dominant in the box.' },
    slide_tackle_ps:      { title: 'Slide Tackle', body: 'Slide Tackles Feel +8. Clean, well-timed slide tackles — fewer mistimed fouls.' },
    slide_tackle_ps_plus: { title: 'Slide Tackle+', body: 'Slide Tackles Feel +15. Elite slide-tackle timing and recovery — a weapon against fast attackers.' },

    // ─── Playstyles — shooting ───
    finesse:            { title: 'Finesse Shot', body: 'Finesse Feel +8. Curled placement shots.' },
    finesse_plus:       { title: 'Finesse Shot+', body: 'Finesse Feel +15. Top-corner bound from the edge.' },
    power_shot:         { title: 'Power Shot', body: 'Power Feel +8. Low Driven Feel +3.' },
    power_shot_plus:    { title: 'Power Shot+', body: 'Power Feel +15. Low Driven Feel +5.' },
    chip_shot:          { title: 'Chip Shot', body: 'Finishing Feel +4. Clean dinks over the keeper.' },
    chip_shot_plus:     { title: 'Chip Shot+', body: 'Finishing Feel +8. Reliable chip technique.' },
    dead_ball:          { title: 'Dead Shot (Freekick)', body: 'Free Kick Taker +15. A pure free-kick specialist — this is the primary lever for free-kick quality.' },
    dead_ball_plus:     { title: 'Dead Shot (Freekick)+', body: 'Free Kick Taker +28. Elite set-piece specialist — transforms a mediocre FK taker into a genuine threat from anywhere in range.' },
    outside_foot:       { title: 'Inventive', body: 'Finesse Feel +3, Volley +3, Finishing +2, Through Ball +3, Low Driven +3, Free Kick Taker +1. Unlocks trivela outside-foot strikes and curved passes — a flair-creator playstyle.' },
    outside_foot_plus:  { title: 'Inventive+', body: 'Finesse Feel +6, Volley +6, Finishing +4, Through Ball +6, Low Driven +6, Free Kick Taker +3. Elite trivela execution — bent finishes and passes from impossible angles.' },
    first_time:         { title: 'Acrobatic', body: 'Volley Feel +10. Better connection on first-time strikes and acrobatic finishes.' },
    first_time_plus:    { title: 'Acrobatic+', body: 'Volley Feel +18. Lethal on crosses and cut-backs — bicycle kicks and scissor volleys come off more often.' },
    low_driven:         { title: 'Low Driven', body: 'Low Driven Feel +10. Adds venom and accuracy to low drives.' },
    low_driven_plus:    { title: 'Low Driven+', body: 'Low Driven Feel +18. Devastating from outside the box, right under the keeper.' },
    game_changer:       { title: 'Game Changer (Flair)', body: 'Finishing Feel +5, Effective Agility +2. Flair touches and clutch finishes in the box.' },
    game_changer_plus:  { title: 'Game Changer (Flair)+', body: 'Finishing Feel +10, Effective Agility +4. Big-moment player — more effective in clutch situations.' },
    precision_header:      { title: 'Precision Header', body: 'Aerial Feel +8. Better technique and direction on headers, especially on set pieces.' },
    precision_header_plus: { title: 'Precision Header+', body: 'Aerial Feel +15. Elite aerial precision — headers land exactly where intended.' },

    // ─── Chem styles (FC26 official boosts) ───
    basic:     { title: 'Basic', body: 'Flat +3 to most stats — no specialisation. Boosts Sprint, Att. Pos., Shot Power, Vision, Short/Long Pass, Curve, Agility, Ball Ctrl, Dribbling, Composure, Def. Awareness, Stand/Slide Tackle, and Strength. Good neutral pick.' },
    // Attacking
    hunter:    { title: 'Hunter', body: 'Accel +6, Sprint +6, Att. Pos. +3, Finishing +3, Shot Power +3, Volleys +9, Jumping +6. Pacy poacher.' },
    hawk:      { title: 'Hawk', body: 'Accel +3, Sprint +3, Att. Pos. +3, Finishing +3, Shot Power +6, Long Shots +6, Jumping +6, Strength +3, Aggression +6. Complete striker profile.' },
    finisher:  { title: 'Finisher', body: 'Att. Pos. +6, Finishing +9, Shot Power +3, Volleys +3, Agility +6, Balance +3, Reactions +3, Dribbling +9. Clinical inside the box.' },
    marksman:  { title: 'Marksman', body: 'Finishing +6, Shot Power +3, Long Shots +6, Reactions +6, Ball Ctrl +6, Dribbling +3, Composure +3, Jumping +3, Strength +6. Rounded goalscorer.' },
    deadeye:   { title: 'Deadeye', body: 'Att. Pos. +6, Finishing +3, Shot Power +9, Long Shots +3, Vision +3, Short Pass +9, Long Pass +3, Curve +6. Shooting + playmaking blend.' },
    sniper:    { title: 'Sniper', body: 'Att. Pos. +9, Finishing +3, Shot Power +3, Long Shots +6, Volleys +3, Stamina +6, Strength +9, Aggression +3. Physically dominant finisher with endurance.' },
    // Midfield
    catalyst:  { title: 'Catalyst', body: 'Accel +6, Sprint +6, Vision +9, Crossing +6, Short Pass +3, Long Pass +6, Curve +3. Playmaking creator with elite distribution and pace.' },
    engine:    { title: 'Engine', body: 'Accel +3, Sprint +3, Vision +3, Crossing +6, Short Pass +3, Long Pass +3, Curve +6, Agility +3, Balance +6, Dribbling +6. Jack-of-all-trades creator.' },
    artist:    { title: 'Artist', body: 'Vision +3, Crossing +6, Short Pass +3, Long Pass +6, Curve +9, Agility +9, Reactions +6, Dribbling +3, Composure +3. The archetypal No. 10.' },
    architect: { title: 'Architect', body: 'Vision +6, FK Acc. +3, Short Pass +9, Long Pass +3, Curve +6, Reactions +6, Stamina +6, Strength +9, Aggression +3. Box-to-box midfielder with set-piece touch.' },
    maestro:   { title: 'Maestro', body: 'Att. Pos. +3, Shot Power +3, Long Shots +6, Vision +3, FK Acc. +6, Short Pass +3, Long Pass +6, Reactions +3, Ball Ctrl +6, Dribbling +3, Composure +3. Deep-lying set-piece specialist.' },
    powerhouse:{ title: 'Powerhouse', body: 'Vision +9, Short Pass +6, Long Pass +6, Curve +3, Interceptions +6, Def. Awareness +3, Stand Tackle +9, Slide Tackle +3. Defensive-minded creator.' },
    // Defending
    shadow:    { title: 'Shadow', body: 'Accel +6, Sprint +6, Interceptions +3, Heading +6, Def. Awareness +3, Stand Tackle +3, Slide Tackle +9. Pure defensive sweeper — pace plus elite slide tackling.' },
    anchor:    { title: 'Anchor', body: 'Accel +3, Sprint +3, Interceptions +3, Heading +3, Def. Awareness +3, Stand Tackle +6, Slide Tackle +6, Jumping +6, Strength +6, Aggression +3. Aerially dominant aggressive defender.' },
    sentinel:  { title: 'Sentinel', body: 'Interceptions +6, Heading +6, Def. Awareness +9, Stand Tackle +3, Slide Tackle +3, Jumping +9, Strength +3, Aggression +6. Aerial-dominant centre-back.' },
    guardian:  { title: 'Guardian', body: 'Agility +6, Reactions +3, Ball Ctrl +3, Dribbling +6, Composure +3, Interceptions +3, Def. Awareness +6, Stand Tackle +9, Slide Tackle +6. Mobile ball-playing defender.' },
    gladiator: { title: 'Gladiator', body: 'Att. Pos. +3, Shot Power +6, Long Shots +3, Balance +3, Reactions +6, Ball Ctrl +3, Dribbling +3, Interceptions +3, Heading +3, Def. Awareness +3, Stand Tackle +3, Slide Tackle +6. Field-player GK novelty chem — broad but shallow.' },
    backbone:  { title: 'Backbone', body: 'Vision +3, Short Pass +3, Long Pass +6, Interceptions +6, Def. Awareness +3, Stand Tackle +6, Slide Tackle +3, Stamina +6, Strength +3, Aggression +6. Endurance-focused defender with a passing range.' },

    // ─── Archetype groupings ───
    archetype_attackers: { title: 'Attacker Archetypes', body: '<b>Assassin</b> — the lightest, shortest, and most slippery.<br><b>Fighter</b> — short players who balance explosiveness, slipperiness, and tenacity.<br><b>Bulldozer</b> — stocky, strong, controlled, and hard to budge.<br><b>Jungler</b> — tall, fast, and agile.<br><b>Freight Train</b> — very tall, very fast, very strong.' },
    archetype_defenders: { title: 'Defender Archetypes', body: '<b>Surgeon</b> — short for their role, very precise.<br><b>Bruiser</b> — average height for their role, balanced physical and defending.<br><b>Brawler</b> — average height for their role, bully focus, and centre of gravity.<br><b>Spider</b> — min 6’4”, leaner side.<br><b>Wall</b> — min 6’4”, heavier side.' },

    // ─── AcceleRATE + build types ───
    accel_type: { title: 'AcceleRATE Type', body: 'Explosive = burst off the mark, loses top end. Controlled = balanced curve. Lengthy = slow burst but devastating top speed.' },
    build_type: { title: 'Build Type', body: 'Lean builds accelerate faster and feel slippier but lose tenacity. Stocky builds gain tenacity, tackle feel, and bully presence but lose burst.' },

    // ─── Effective (output) stats ───
    effAccel:    { title: 'Effective Acceleration', body: 'Affected by: base Accel, build, height, weight, strength, AcceleRATE type, Quickstep, Rapid, First Touch, chem style.' },
    effSprint:   { title: 'Effective Sprint Speed', body: 'Affected by: base Sprint, height, weight, AcceleRATE type, Quickstep, chem style. Caps at 120.' },
    effAgility:  { title: 'Effective Agility', body: 'Affected by: base Agility, height, weight, strength, Technical, Rapid, Trickster, chem style, and Dribbling + Ball Control average.' },
    effTenacity: { title: 'Effective Tenacity', body: 'Affected by: build, weight, strength, balance, height, Enforcer, Bruiser. Caps at 130.' },
    effSlip:     { title: 'Slipperiness', body: 'How slick your turns feel. Built from effective Agility, height, effective Tenacity, Technical and build.' },
    // Passing
    numPassShortEff:   { title: 'Short Pass Feel', body: 'Built from Short Pass + Composure + Reactions + effective Agility + build. Tiki Taka and weight under 65kg push it.' },
    numPassLongEff:    { title: 'Long Pass Feel', body: 'Built from Long Pass + Composure + Reactions + height. Pinged Pass and Long Ball Pass push it.' },
    numPassThroughEff: { title: 'Through Ball Feel', body: 'Built from Short Pass + Vision + Curve + Composure + Reactions + effective Agility. Incisive Pass and Tiki Taka push it.' },
    numPassCrossEff:   { title: 'Cross Feel', body: 'Built from Crossing + Curve + Composure + Reactions + height. Whipped Pass pushes it.' },
    // Defending
    numDefTackleEff: { title: 'Tackle Feel', body: 'Built from Standing Tackle + Composure + Aggression + weight + build + recovery pace, with Bully Feel as a major amplifier (replaces Tenacity). Anticipate playstyle pushes it. Slide tackling has its own separate metric and no longer feeds into this.' },
    numDefPosEff:    { title: 'Positioning Feel', body: 'Built from Def. Awareness + effective Acceleration + effective Sprint. Block and Jockey push it.' },
    numDefIntEff:    { title: 'Interception Feel', body: 'Built from Interceptions + Reactions + effective Sprint. Intercept playstyle pushes it.' },
    numDefAerEff:    { title: 'Aerial Feel', body: 'Built from Heading + Jumping + height + build + effective Sprint. Aerial playstyle pushes it.' },
    numDefBullyEff:  { title: 'Bully Feel', body: 'How hard you are to run through 1v1. Built from strength + tackle + aggression + weight + build + balance + height + effective Tenacity + recovery pace. Bruiser and Bruiser+ push it.' },
    numDefSlideEff:  { title: 'Slide Tackles Feel', body: 'Built from Slide Tackle stat + aggression + composure + effective Agility + recovery pace. Too heavy slows the slide. Slide Tackle and Slide Tackle+ playstyles boost it.' },
    // Shooting
    numShootFinEff:  { title: 'Finishing Feel', body: 'Built from Finishing + Att. Positioning + Composure + Reactions + balance + effective Slipperiness. Dead Ball and Chip Shot push it.' },
    numShootPwrEff:  { title: 'Shot Power', body: 'Built from Shot Power + Composure + balance + height + weight + build. Power Shot playstyle pushes it.' },
    numShootFineEff: { title: 'Finesse Feel', body: 'Built from Long Shots + Curve + Composure + balance + weight + build + effective Agility. Finesse Shot and Outside the Foot push it.' },
    numShootVolEff:  { title: 'Volley Feel', body: 'Built from Volleys + Composure + balance + effective Agility. First Time Shot and Outside the Foot push it.' },
    numShootLdrEff:  { title: 'Low Driven Feel', body: 'Weighted blend of Shot Power + Finishing + balance + Composure. Boosted by lower height, Controlled AcceleRATE, stocky build, effective Agility, Power Shot, Low Driven, and Inventive playstyles.' },
    numShootFkEff:   { title: 'Free Kick Taker', body: 'Overwhelmingly driven by FK Accuracy (85% of the base), with minor contributions from Curve and Composure. Dead Shot (Freekick) is by far the biggest lever on top — Finesse Shot and Inventive add smaller boosts. Finishing, Shot Power, and raw strength are deliberately ignored: set pieces are a technique skill, not a power skill.' },
  };

  // Singleton bubble element
  let infoBubble = null;
  let activeInfoBtn = null;

  function ensureBubble() {
    if (!infoBubble) {
      infoBubble = document.createElement('div');
      infoBubble.className = 'info-bubble';
      document.body.appendChild(infoBubble);
    }
    return infoBubble;
  }

  function hideBubble() {
    if (infoBubble) infoBubble.classList.remove('open');
    if (activeInfoBtn) activeInfoBtn.classList.remove('active');
    activeInfoBtn = null;
  }

  function showBubble(btn, infoKey) {
    const info = INFO_MAP[infoKey];
    if (!info) return;
    const b = ensureBubble();
    b.innerHTML = `<div class="info-bubble-title">${info.title}</div><div class="info-bubble-body">${info.body}</div>`;
    // Position relative to button
    const r = btn.getBoundingClientRect();
    const scrollY = window.scrollY || document.documentElement.scrollTop;
    const scrollX = window.scrollX || document.documentElement.scrollLeft;
    // Default: below the button
    let top = r.bottom + scrollY + 8;
    let left = r.left + scrollX - 8;
    // Keep inside viewport horizontally
    const maxLeft = scrollX + window.innerWidth - 280;
    if (left > maxLeft) left = maxLeft;
    if (left < scrollX + 8) left = scrollX + 8;
    b.style.top  = `${top}px`;
    b.style.left = `${left}px`;
    b.classList.add('open');
    if (activeInfoBtn && activeInfoBtn !== btn) activeInfoBtn.classList.remove('active');
    btn.classList.add('active');
    activeInfoBtn = btn;
  }

  function handleInfoClick(e) {
    const btn = e.target.closest('.info-btn');
    if (!btn) {
      if (!e.target.closest('.info-bubble')) hideBubble();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const key = btn.dataset.info;
    if (activeInfoBtn === btn) { hideBubble(); return; }
    showBubble(btn, key);
  }

  document.addEventListener('click', handleInfoClick);
  // Also dismiss on scroll
  window.addEventListener('scroll', hideBubble, { passive: true });
  window.addEventListener('resize', hideBubble);

  // Injection: attach a tiny "i" button next to each known target
  function injectInfoButtons() {
    // 1. Base stat inputs & extended stat inputs — target the <label> for the input
    const inputKeys = [
      'baseAccel','baseSprint','baseAgility','balance','heightCm','weight','strength',
      'shortPass','longPass','vision','crossing','curve','fkAccuracy',
      'standTackle','slideTackle','interceptions','headingAcc','defAwareness','aggression','jumping',
      'finishing','shotPower','longShots','volleys','attPositioning',
      'composure','reactions','ballControl','dribbling','stamina'
    ];
    inputKeys.forEach(id => {
      const input = document.getElementById(id);
      if (!input) return;
      const label = input.parentElement?.querySelector('label');
      if (!label || label.querySelector('.info-btn')) return;
      const btn = document.createElement('button');
      btn.className = 'info-btn';
      btn.type = 'button';
      btn.textContent = 'i';
      btn.dataset.info = id;
      btn.setAttribute('aria-label', `Info about ${id}`);
      label.appendChild(btn);
    });

    // 2. Every playstyle button — append the "i" to its ps-name span
    document.querySelectorAll('.ps-btn').forEach(psBtn => {
      const psId = psBtn.dataset.ps || psBtn.dataset.chem;
      if (!psId) return;
      const nameEl = psBtn.querySelector('.ps-name');
      if (!nameEl || nameEl.querySelector('.info-btn')) return;
      if (!INFO_MAP[psId]) return;
      const btn = document.createElement('button');
      btn.className = 'info-btn';
      btn.type = 'button';
      btn.textContent = 'i';
      btn.dataset.info = psId;
      btn.setAttribute('aria-label', `Info about ${psId}`);
      // Handle click directly on this button so the parent ps-btn's onclick doesn't toggle the playstyle
      btn.addEventListener('click', ev => {
        ev.preventDefault();
        ev.stopPropagation();
        if (activeInfoBtn === btn) { hideBubble(); return; }
        showBubble(btn, psId);
      });
      btn.addEventListener('mousedown', ev => ev.stopPropagation());
      nameEl.appendChild(btn);
    });

    // 3. Effective stat labels — target via the num-id on each row
    const effTargets = [
      { numId: 'numAccelEff',    key: 'effAccel' },
      { numId: 'numSprintEff',   key: 'effSprint' },
      { numId: 'numAgilityEff',  key: 'effAgility' },
      { numId: 'numTenacityEff', key: 'effTenacity' },
      { numId: 'numSlipEff',     key: 'effSlip' },
    ];
    effTargets.forEach(({ numId, key }) => {
      const num = document.getElementById(numId);
      if (!num) return;
      const row = num.closest('.stat-row');
      const label = row?.querySelector('.stat-label');
      if (!label || label.querySelector('.info-btn')) return;
      const btn = document.createElement('button');
      btn.className = 'info-btn';
      btn.type = 'button';
      btn.textContent = 'i';
      btn.dataset.info = key;
      btn.setAttribute('aria-label', 'Info');
      label.appendChild(btn);
    });

    // 4. Sub-stat-label elements in the 3 feel-layer cards — tag by nearest num-id
    document.querySelectorAll('.sub-stat-row').forEach(row => {
      const label = row.querySelector('.sub-stat-label');
      const numEl = row.querySelector('[id^="num"]');
      if (!label || !numEl || label.querySelector('.info-btn')) return;
      const key = numEl.id; // e.g. "numPassShortEff"
      if (!INFO_MAP[key]) return;
      const btn = document.createElement('button');
      btn.className = 'info-btn';
      btn.type = 'button';
      btn.textContent = 'i';
      btn.dataset.info = key;
      btn.setAttribute('aria-label', 'Info');
      label.appendChild(btn);
    });

    // 5. Build Type + AcceleRATE Type section labels get info buttons too
    document.querySelectorAll('.ps-section-label').forEach(lbl => {
      const txt = lbl.textContent.trim().toLowerCase();
      let key = null;
      if (txt === 'build type')         key = 'build_type';
      else if (txt === 'acceleration type' || txt === 'accelerate type') key = 'accel_type';
      if (!key || lbl.querySelector('.info-btn')) return;
      const btn = document.createElement('button');
      btn.className = 'info-btn';
      btn.type = 'button';
      btn.textContent = 'i';
      btn.dataset.info = key;
      btn.setAttribute('aria-label', 'Info');
      lbl.appendChild(btn);
    });
  }

/* ── Initial render ── */
  injectInfoButtons();

  calculate();
  renderAll();
