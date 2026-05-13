/* ═══════════════════════════════════════════════════════════════
   FEEL CALCULATOR — core math and stat rendering
   ───────────────────────────────────────────────────────────────
   Owns the calculation pipeline (movement, passing, defending,
   shooting feel) plus the DOM updates that display the results.
   Cross-file: UI state is read from ui.js (e.g. isDark for stat
   colour selection); inline onclick handlers in the HTML invoke
   functions defined here through the shared global scope.
   ═══════════════════════════════════════════════════════════════ */

/* ── State driven by UI (mutated by selectAccel/selectBuild/togglePS in ui.js) ── */
  let accelType = 'controlled';
  let buildType = 'normal';
  let activePS = new Set();

  const DEFAULT_HEIGHT  = 183;
  const DEFAULT_WEIGHT  = 80;
  const DEFAULT_STR     = 70;
  const DEFAULT_BAL     = 75;
  const MAX_VAL         = 150;

  let activeChem = null;

  function clamp(v) { return Math.max(1, Math.min(MAX_VAL, v)); }

  // ═══════════════════════════════════════════════════════════════
  // CHEMISTRY STYLE BOOSTS — sourced from FC26 official values.
  // Each key maps an input id to a point bonus applied on top of the entered value.
  // Basic chem gives a broad +3 to most stats. Others cluster around themed profiles.
  // Stats not listed simply don't receive a chem boost (treated as 0).
  // ═══════════════════════════════════════════════════════════════
  const CHEM_BOOSTS = {
    // Base stats (stat ids: baseAccel→accel, baseSprint→sprint, baseAgility→agility, balance, strength)
    // Extended ids match directly: shortPass, longPass, vision, crossing, curve, fkAccuracy,
    // standTackle, slideTackle, interceptions, headingAcc, defAwareness, aggression, jumping,
    // finishing, shotPower, longShots, volleys, attPositioning, composure, reactions, ballControl, dribbling, stamina
    basic:     { sprint:3, attPositioning:3, shotPower:3, vision:3, shortPass:3, longPass:3, curve:3, agility:3, ballControl:3, dribbling:3, composure:3, defAwareness:3, standTackle:3, slideTackle:3, strength:3 },
    // — Attacking —
    hunter:    { accel:6, sprint:6, attPositioning:3, finishing:3, shotPower:3, volleys:9, jumping:6 },
    hawk:      { accel:3, sprint:3, attPositioning:3, finishing:3, shotPower:6, longShots:6, jumping:6, strength:3, aggression:6 },
    finisher:  { attPositioning:6, finishing:9, shotPower:3, volleys:3, agility:6, balance:3, reactions:3, dribbling:9 },
    marksman:  { finishing:6, shotPower:3, longShots:6, reactions:6, ballControl:6, dribbling:3, composure:3, jumping:3, strength:6 },
    deadeye:   { attPositioning:6, finishing:3, shotPower:9, longShots:3, vision:3, shortPass:9, longPass:3, curve:6 },
    sniper:    { attPositioning:9, finishing:3, shotPower:3, longShots:6, volleys:3, stamina:6, strength:9, aggression:3 },
    // — Midfield —
    catalyst:  { accel:6, sprint:6, vision:9, crossing:6, shortPass:3, longPass:6, curve:3 },
    engine:    { accel:3, sprint:3, vision:3, crossing:6, shortPass:3, longPass:3, curve:6, agility:3, balance:6, dribbling:6 },
    artist:    { vision:3, crossing:6, shortPass:3, longPass:6, curve:9, agility:9, reactions:6, dribbling:3, composure:3 },
    architect: { vision:6, fkAccuracy:3, shortPass:9, longPass:3, curve:6, reactions:6, stamina:6, strength:9, aggression:3 },
    maestro:   { attPositioning:3, shotPower:3, longShots:6, vision:3, fkAccuracy:6, shortPass:3, longPass:6, reactions:3, ballControl:6, dribbling:3, composure:3 },
    powerhouse:{ vision:9, shortPass:6, longPass:6, curve:3, interceptions:6, defAwareness:3, standTackle:9, slideTackle:3 },
    // — Defending —
    shadow:    { accel:6, sprint:6, interceptions:3, headingAcc:6, defAwareness:3, standTackle:3, slideTackle:9 },
    anchor:    { accel:3, sprint:3, interceptions:3, headingAcc:3, defAwareness:3, standTackle:6, slideTackle:6, jumping:6, strength:6, aggression:3 },
    sentinel:  { interceptions:6, headingAcc:6, defAwareness:9, standTackle:3, slideTackle:3, jumping:9, strength:3, aggression:6 },
    guardian:  { agility:6, reactions:3, ballControl:3, dribbling:6, composure:3, interceptions:3, defAwareness:6, standTackle:9, slideTackle:6 },
    gladiator: { attPositioning:3, shotPower:6, longShots:3, balance:3, reactions:6, ballControl:3, dribbling:3, interceptions:3, headingAcc:3, defAwareness:3, standTackle:3, slideTackle:6 },
    backbone:  { vision:3, shortPass:3, longPass:6, interceptions:6, defAwareness:3, standTackle:6, slideTackle:3, stamina:6, strength:3, aggression:6 },
  };

  // Returns how many points a given stat key is boosted by the current active chem style
  function chemBoost(key) {
    if (!activeChem) return 0;
    const table = CHEM_BOOSTS[activeChem];
    return (table && table[key]) || 0;
  }

  function calculate() {
    const baseAccel    = Math.min(99, (+document.getElementById('baseAccel').value   || 0) + chemBoost('accel'));
    const baseSprint   = Math.min(99, (+document.getElementById('baseSprint').value  || 0) + chemBoost('sprint'));
    const baseAgility  = Math.min(99, (+document.getElementById('baseAgility').value || 0) + chemBoost('agility'));
    const baseTenacity = 75;
    const heightCm     = +document.getElementById('heightCm').value     || DEFAULT_HEIGHT;
    const weight       = +document.getElementById('weight').value       || DEFAULT_WEIGHT;
    const strength     = Math.min(99, (+document.getElementById('strength').value    || DEFAULT_STR) + chemBoost('strength'));
    const balance      = Math.min(99, (+document.getElementById('balance').value     || DEFAULT_BAL) + chemBoost('balance'));

    let dA = 0, dS = 0, dG = 0, dT = 0;
    let breakdown = [];

    // Acceleration type
    if (accelType === 'explosive') {
      dA += 15; dS -= 10; dG += 5;
      breakdown.push({ source: 'Explosive AcceleRATE', a: +15, s: -10, g: +5, t: 0 });
    } else if (accelType === 'lengthy') {
      dA -= 10; dS += 15; dG -= 5;
      breakdown.push({ source: 'Lengthy AcceleRATE', a: -10, s: +15, g: -5, t: 0 });
    }

    // Build
    if (buildType === 'very_lean')        { dT -= 15; dA += 5;  breakdown.push({ source: 'Very Lean Build',    a:+5,  s:0, g:0, t:-15 }); }
    else if (buildType === 'lean')        { dT -= 5;  dA += 2;  breakdown.push({ source: 'Lean Build',          a:+2,  s:0, g:0, t:-5  }); }
    else if (buildType === 'stocky')      { dT += 5;  dA -= 2;  breakdown.push({ source: 'Stocky Build',        a:-2,  s:0, g:0, t:+5  }); }
    else if (buildType === 'very_stocky') { dT += 15; dA -= 5;  breakdown.push({ source: 'Very Stocky Build',   a:-5,  s:0, g:0, t:+15 }); }

    // Height per 2 inches from 6'0" (183cm)
    const hSteps = ((heightCm - DEFAULT_HEIGHT) / 2.54) / 2;
    const hInches = (heightCm - DEFAULT_HEIGHT) / 2.54;
    const hA = Math.round(-1 * hSteps);
    const hS = Math.round(+0.5 * hInches);
    const hG = Math.round(-1 * hSteps);
    const hT = Math.round(-1 * hSteps);
    if (hA||hS||hG||hT) {
      dA+=hA; dS+=hS; dG+=hG; dT+=hT;
      breakdown.push({ source: `Height (${cmToFtIn(heightCm)}, ${heightCm>DEFAULT_HEIGHT?'above':'below'} 6'0")`, a:hA, s:hS, g:hG, t:hT });
    }

    // Weight per 5kg from 80kg — both directions add tenacity (+3 per 5kg away from baseline)
    const wSteps = (weight - DEFAULT_WEIGHT) / 5;
    const wA = Math.round(-1 * wSteps);
    const wS = Math.round(-0.5 * wSteps);
    const wG = Math.round(-1 * wSteps);
    const wT = Math.round(+2.5 * wSteps);
    if (wA||wS||wG||wT) {
      dA+=wA; dS+=wS; dG+=wG; dT+=wT;
      breakdown.push({ source: `Weight (${weight}kg, ${weight>DEFAULT_WEIGHT?'over':'under'} 80kg)`, a:wA, s:wS, g:wG, t:wT });
    }

    // Strength per 5 points from 75
    const sSteps = (strength - DEFAULT_STR) / 5;
    const stA = Math.round(-1 * sSteps);
    const stG = Math.round(-1 * sSteps);
    const stT = Math.round(+1.5 * sSteps);
    if (stA||stG||stT) {
      dA+=stA; dG+=stG; dT+=stT;
      breakdown.push({ source: `Strength (${strength}, ${strength>DEFAULT_STR?'over':'under'} 75)`, a:stA, s:0, g:stG, t:stT });
    }

    // Balance per 5 points from 75 — tenacity only
    const bSteps = (balance - DEFAULT_BAL) / 5;
    const bT = Math.round(+2 * bSteps);
    if (bT) {
      dT+=bT;
      breakdown.push({ source: `Balance (${balance}, ${balance>DEFAULT_BAL?'over':'under'} 75)`, a:0, s:0, g:0, t:bT });
    }

    // Playstyles
    if (activePS.has('quickstep'))      { dA+=5; dS+=1; breakdown.push({ source:'Quickstep',   a:+5,  s:+1,  g:0,   t:0   }); }
    if (activePS.has('quickstep_plus')) { dA+=10; dS+=2; breakdown.push({ source:'Quickstep+',  a:+10, s:+2,  g:0,   t:0   }); }
    if (activePS.has('rapid'))          { dA+=2; dG+=2; breakdown.push({ source:'Rapid',       a:+2,  s:0,   g:+2,  t:0   }); }
    if (activePS.has('rapid_plus'))     { dA+=5; dG+=5; breakdown.push({ source:'Rapid+',      a:+5,  s:0,   g:+5,  t:0   }); }
    if (activePS.has('technical'))      { dG+=5;       breakdown.push({ source:'Technical',   a:0,   s:0,   g:+5,  t:0   }); }
    if (activePS.has('technical_plus')) { dG+=10;      breakdown.push({ source:'Technical+',  a:0,   s:0,   g:+10, t:0   }); }
    if (activePS.has('first_touch'))    { dA+=2;       breakdown.push({ source:'First Touch',  a:+2,  s:0,   g:0,   t:0   }); }
    if (activePS.has('first_touch_plus')) { dA+=5;     breakdown.push({ source:'First Touch+', a:+5,  s:0,   g:0,   t:0   }); }
    if (activePS.has('enforcer'))       { dT+=5;       breakdown.push({ source:'Enforcer',    a:0,   s:0,   g:0,   t:+5  }); }
    if (activePS.has('enforcer_plus'))  { dT+=10;      breakdown.push({ source:'Enforcer+',   a:0,   s:0,   g:0,   t:+10 }); }
    if (activePS.has('press_proven'))       { dT+=2;  breakdown.push({ source:'Press Proven',  a:0, s:0, g:0, t:+2 }); }
    if (activePS.has('press_proven_plus'))  { dT+=5;  breakdown.push({ source:'Press Proven+', a:0, s:0, g:0, t:+5 }); }

    // Trickster boosts agility feel
    if (activePS.has('trickster'))       { dG+=2; breakdown.push({ source:'Trickster',  a:0, s:0, g:+2, t:0 }); }
    if (activePS.has('trickster_plus'))  { dG+=4; breakdown.push({ source:'Trickster+', a:0, s:0, g:+4, t:0 }); }
    if (activePS.has('game_changer'))                    { dG+=2; breakdown.push({ source:'Game Changer',  a:0, s:0, g:+2, t:0 }); }
    if (activePS.has('game_changer_plus'))               { dG+=4; breakdown.push({ source:'Game Changer+', a:0, s:0, g:+4, t:0 }); }

    // ──── Dribbling + Ball Control affect Agility feel ────
    // High dribbling → tighter ball control → ball feels more agile under your feet
    // Average of base Dribbling + Ball Control, every 5 points from 75 contributes ±1 to Agility
    const dribBaseStat = ext('dribbling');
    const ballCtrlStat = ext('ballControl');
    const dribAvg = (dribBaseStat + ballCtrlStat) / 2;
    const dribAgilityMod = Math.round((dribAvg - 75) / 5);
    if (dribAgilityMod !== 0) {
      dG += dribAgilityMod;
      breakdown.push({
        source: `Dribbling + Ball Control (avg ${Math.round(dribAvg)})`,
        a: 0, s: 0, g: dribAgilityMod, t: 0
      });
    }

    const effA = clamp(baseAccel    + dA);
    const effS = clamp(baseSprint   + dS);
    const effG = clamp(baseAgility  + dG);
    const effT = clamp(baseTenacity + dT);

    updateRow('Accel',    baseAccel,    effA, dA, 'var(--neutral)');
    const cappedEffS = Math.min(effS, SPRINT_CAP);
    updateRow('Sprint', baseSprint, cappedEffS, Math.min(effS, SPRINT_CAP) - baseSprint, 'var(--neutral)', true);
    updateRow('Agility',  baseAgility,  effG, dG, 'var(--neutral)');
    const cappedEffT = Math.min(effT, TENACITY_CAP);
    updateRow('Tenacity', baseTenacity, cappedEffT, cappedEffT - baseTenacity, 'var(--accent4)', false, true);

    const techSlipBonus = activePS.has('technical_plus') ? 5 : activePS.has('technical') ? 2 : 0;
    const buildSlipBonus = buildType === 'very_lean' ? 5 : buildType === 'lean' ? 2 : buildType === 'stocky' ? -2 : buildType === 'very_stocky' ? -5 : 0;
    const pressSlipBonus = activePS.has('press_proven_plus') ? 5 : activePS.has('press_proven') ? 2 : 0;
    const slip = Math.round((180 + (effG - heightCm)) + ((effT - 100) / 2) + techSlipBonus + buildSlipBonus + pressSlipBonus);
    updateSlip(slip);
    renderSlipBreakdown(effG, heightCm, effT, techSlipBonus, buildSlipBonus, slip);

    renderBreakdown(breakdown);
    renderVerdict(effA, effS, effG, effT, dT, weight, heightCm, strength, accelType, buildType);

    // Extended feel layers — all consume the movement-layer outputs
    calculatePassingFeel(effA, cappedEffS, effG, cappedEffT, heightCm, weight);
    calculateDefendingFeel(effA, cappedEffS, effG, cappedEffT, heightCm, weight);
    calculateShootingFeel(effA, cappedEffS, effG, cappedEffT, slip, heightCm, weight, balance);
  }

  function sc(v) {
    // stat colour for saved player cards — same thresholds as effColor
    if (v >= 115) return 'var(--neutral)';
    if (v >= 100) return 'var(--gain)';
    if (v >= 85)  return '#E4953C';
    return 'var(--loss)';
  }

  function effColor(eff) {
    if (eff >= 115) return 'var(--overflow)';
    if (eff >= 100) return 'var(--neutral)';
    if (eff >= 85)  return '#E4953C';
    return 'var(--loss)';
  }

  function sprintColor(eff) {
    if (eff >= 110) return 'var(--overflow)';
    if (eff >= 100) return 'var(--neutral)';
    if (eff >= 85)  return '#E4953C';
    return 'var(--loss)';
  }

  const SPRINT_CAP = 120;
  const TENACITY_CAP = 130;

  function tenacityColor(eff) {
    if (eff >= 115) return 'var(--overflow)';
    if (eff >= 100) return 'var(--neutral)';
    if (eff >= 85)  return '#E4953C';
    return 'var(--loss)';
  }

  function animateNumber(el, target, color) {
    const current = parseInt(el.textContent) || 0;
    el.style.color = color;
    if (current === target) return;
    const steps = Math.min(Math.abs(target - current), 16);
    const increment = (target - current) / steps;
    let step = 0, val = current;
    const tick = () => {
      step++;
      val += increment;
      el.textContent = Math.round(step < steps ? val : target);
      if (step < steps) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  const BAR_VISUAL_MAX = 120; // All stat bars visually fill on a 0-120 scale for consistency

  function updateRow(prefix, base, eff, delta, neutralColor, isSprint, isTenacity) {
    document.getElementById(`num${prefix}Base`).textContent = base;
    animateNumber(document.getElementById(`num${prefix}Eff`), eff, isSprint ? sprintColor(eff) : isTenacity ? tenacityColor(eff) : effColor(eff));
    document.getElementById(`bar${prefix}Base`).style.width = `${Math.min(100,(base/BAR_VISUAL_MAX)*100)}%`;

    const effBar = document.getElementById(`bar${prefix}Eff`);
    effBar.style.width      = `${Math.min(100,(eff/BAR_VISUAL_MAX)*100)}%`;
    effBar.style.background = isSprint ? sprintColor(eff) : isTenacity ? tenacityColor(eff) : effColor(eff);

    const dEl = document.getElementById(`delta${prefix}`);
    dEl.textContent  = delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : '±0';
    dEl.className    = `delta ${delta > 0 ? 'pos' : delta < 0 ? 'neg' : 'zero'}`;
    // colour set by animateNumber
  }

  function updateSlip(slip) {
    const el = document.getElementById('numSlipEff');
    const bar = document.getElementById('barSlipEff');
    animateNumber(el, slip, effColor(slip));
    bar.style.width = `${Math.max(0, Math.min(100, (slip / BAR_VISUAL_MAX) * 100))}%`;
    bar.style.background = effColor(slip);
    document.getElementById('numSlipBase').textContent = '—';
    document.getElementById('barSlipBase').style.width = '0%';
    document.getElementById('deltaSlip').textContent = '';
  }

  function renderSlipBreakdown(effG, heightCm, effT, techBonus, buildBonus, total) {
    const el = document.getElementById('slipBreakdownList');
    const items = [];

    const baseSlip = 180 + (effG - heightCm);
    items.push({ source: 'Default (180 + Agility feel − height)', v: Math.round(baseSlip) });

    const tenBonus = (effT - 100) / 2;
    if (tenBonus !== 0) items.push({ source: `(Tenacity − 100) ÷ 2`, v: Math.round(tenBonus) });

    if (techBonus !== 0) {
      const label = techBonus === 5 ? 'Technical+' : 'Technical';
      items.push({ source: label, v: techBonus });
    }

    if (buildBonus !== 0) {
      const label = buildBonus === 5 ? 'Very Lean Build' : buildBonus === 2 ? 'Lean Build' : buildBonus === -2 ? 'Stocky Build' : 'Very Stocky Build';
      items.push({ source: label, v: buildBonus });
    }

    el.innerHTML = items.map((item, idx) => {
      const isDefault = idx === 0;
      const chip = isDefault
        ? `<span class="bd" style="color:#b0a8a0">${item.v}</span>`
        : `<span class="bd ${item.v > 0 ? 'pos' : item.v < 0 ? 'neg' : ''}" style="color:${item.v > 0 ? 'var(--gain)' : item.v < 0 ? 'var(--loss)' : '#a07cc0'}">${item.v > 0 ? '+' : ''}${item.v}</span>`;
      return `<div class="breakdown-item"><span class="source">${item.source}</span><div class="breakdown-deltas">${chip}</div></div>`;
    }).join('') + `<div class="breakdown-item" style="border-top:1px solid var(--border);margin-top:4px;padding-top:6px;">
      <span class="source slip-total-label">Total Slipperiness</span>
      <div class="breakdown-deltas"><span class="bd" class="slip-total-val">${total}</span></div>
    </div>`;
  }

  function renderBreakdown(items) {
    const el = document.getElementById('breakdownList');
    const active = items.filter(i => i.a||i.s||i.g||i.t||i.note);
    if (!active.length) {
      el.innerHTML = '<div class="breakdown-item"><span style="color:var(--muted);font-size:0.68rem;">No modifiers — all stats at face value</span></div>';
      return;
    }
    el.innerHTML = active.map(item => {
      if (item.note) {
        return `<div class="breakdown-item"><span style="color:var(--muted);font-style:italic;">${item.source}</span></div>`;
      }
      const chips = [
        item.a ? `<span class="bd ${item.a>0?'pos':'neg'}">ACC ${item.a>0?'+':''}${item.a}</span>` : '',
        item.s ? `<span class="bd ${item.s>0?'pos':'neg'}">SPR ${item.s>0?'+':''}${item.s}</span>` : '',
        item.g ? `<span class="bd ${item.g>0?'pos':'neg'}">AGI ${item.g>0?'+':''}${item.g}</span>` : '',
        item.t ? `<span class="bd ${item.t>0?'pos':'neg'}" style="color:${item.t>0?'var(--accent4)':'var(--loss)'}">TEN ${item.t>0?'+':''}${item.t}</span>` : '',
      ].filter(Boolean).join('');
      return `<div class="breakdown-item"><span class="source">${item.source}</span><div class="breakdown-deltas">${chips}</div></div>`;
    }).join('');
  }

  // Generic breakdown renderer for extended feel sections (passing / defending / shooting).
  // statDefs: [{ key, label }] — the sub-stat columns to render chips for.
  // Items are grouped by input source (e.g. Height → Bully and Height → Aerial collapse
  // into one row), the redundant "→ Stat" suffix is dropped (the chip already labels
  // its target), and chips are formatted as integers when the rounded value is exact.
  function renderExtBreakdown(listId, items, statDefs) {
    const el = document.getElementById(listId);
    if (!el) return;
    const active = items.filter(i => i.note || i.isBase || statDefs.some(s => i[s.key]));
    if (!active.length) {
      el.innerHTML = '<div class="breakdown-item"><span style="color:var(--muted);font-size:0.68rem;">No modifiers active</span></div>';
      return;
    }

    const stripArrow = s => s.replace(/\s*→\s*.+$/, '');
    const deriveGroup = s => {
      const prefix = stripArrow(s).replace(/\s*\([^)]*\)\s*/g, ' ').trim();
      if (/Build$/i.test(prefix)) return 'build';
      if (/^Aggression/i.test(prefix)) return 'aggression';
      return prefix.toLowerCase();
    };
    const fmt = v => {
      const r = Math.round(v);
      if (Math.abs(v - r) < 0.05) return (r >= 0 ? '+' : '') + r;
      const o = Math.round(v * 10) / 10;
      return (o >= 0 ? '+' : '') + o;
    };

    const rendered = [];
    const groupMap = new Map();
    for (const item of active) {
      if (item.isBase || item.note) {
        rendered.push({ kind: item.isBase ? 'base' : 'note', items: [item], label: item.source });
        continue;
      }
      const key = deriveGroup(item.source);
      if (groupMap.has(key)) {
        groupMap.get(key).items.push(item);
      } else {
        const entry = { kind: 'mod', items: [item], label: stripArrow(item.source) };
        groupMap.set(key, entry);
        rendered.push(entry);
      }
    }

    el.innerHTML = rendered.map(entry => {
      if (entry.kind === 'note') {
        return `<div class="breakdown-item"><span style="color:var(--muted);font-style:italic;">${entry.label}</span></div>`;
      }
      if (entry.kind === 'base') {
        const item = entry.items[0];
        const chips = statDefs.map(s => {
          const v = item[s.key];
          if (v == null) return '';
          return `<span class="bd" style="color:#b0a8a0">${s.label} ${Math.round(v)}</span>`;
        }).filter(Boolean).join('');
        return `<div class="breakdown-item"><span class="source">${entry.label}</span><div class="breakdown-deltas">${chips}</div></div>`;
      }
      const totals = {};
      for (const item of entry.items) {
        for (const s of statDefs) {
          if (item[s.key]) totals[s.key] = (totals[s.key] || 0) + item[s.key];
        }
      }
      const chips = statDefs.map(s => {
        const v = totals[s.key];
        if (!v || Math.abs(v) < 0.05) return '';
        return `<span class="bd ${v > 0 ? 'pos' : 'neg'}">${s.label} ${fmt(v)}</span>`;
      }).filter(Boolean).join('');
      if (!chips) return '';
      return `<div class="breakdown-item"><span class="source">${entry.label}</span><div class="breakdown-deltas">${chips}</div></div>`;
    }).join('');
  }

  const PASS_STATS  = [{ key:'sp', label:'SP' }, { key:'lp', label:'LP' }, { key:'tb', label:'TB' }, { key:'cr', label:'CR' }];
  const DEF_STATS   = [{ key:'tk', label:'TK' }, { key:'pos', label:'POS' }, { key:'int', label:'INT' }, { key:'aer', label:'AER' }, { key:'bully', label:'BULLY' }, { key:'slide', label:'SLIDE' }];
  const SHOOT_STATS = [{ key:'fin', label:'FIN' }, { key:'pwr', label:'PWR' }, { key:'fnse', label:'FNSE' }, { key:'vol', label:'VOL' }, { key:'ldr', label:'LDR' }, { key:'fk', label:'FK' }];

  function renderVerdict(effA, effS, effG, effT, dT, weight, heightCm, strength, type, build) {
    let lines = [];
    if (type==='explosive') lines.push('Explosive type — immediate burst off the mark, bleeds off at top end.');
    else if (type==='lengthy') lines.push('Lengthy type — slow off the mark but hard to catch once moving.');
    else lines.push('Controlled type — balanced, predictable acceleration curve.');

    if (build==='stocky') lines.push('Stocky build — naturally harder to knock off the ball.');
    else if (build==='lean') lines.push('Lean build — lower natural resistance in physical challenges.');

    if (weight < 70) lines.push('Very light — physics engine applies minimal resistance, movement feels near weightless.');
    else if (weight > 90) lines.push('Heavy build — significant physics resistance; pace and agility partially absorbed by mass.');

    if (heightCm < 170) lines.push('Very low centre of gravity — turning arcs extremely tight, agility over-delivers.');
    else if (heightCm > 190) lines.push('Tall frame — wider turning arcs; agility slightly undermined by the longer limb model.');

    if (strength < 55) lines.push('Very low strength — almost no movement resistance, but easily bumped off the ball.');
    else if (strength > 85) lines.push('High strength — self-resistance to movement noticeable; Enforcer+ helps unlock it.');

    if (effT > 115) lines.push('Extremely high effective tenacity — an immovable presence in physical contests.');
    else if (effT > 95) lines.push('High effective tenacity — strong in duels, very hard to dispossess under pressure.');
    else if (effT < 60) lines.push('Low effective tenacity — will struggle in physical contests and be easily dispossessed.');

    if (activePS.has('quickstep_plus') && type==='explosive') lines.push('Quickstep+ on explosive — double burst stacking, feels faster off the mark than the card suggests.');
    if (activePS.has('rapid_plus') && type==='lengthy') lines.push('Rapid+ on lengthy — top end amplified further, almost impossible to catch once moving.');
    if (activePS.has('enforcer_plus') && strength > 80) lines.push('Enforcer+ with high strength — physical resistance unlocked, dominant in all contact situations.');

    document.getElementById('verdictText').textContent = lines.join(' ');
  }

  // ═══════════════════════════════════════════════════════════════
  // EXTENDED FEEL LAYERS — Passing / Defending / Shooting
  // All read the effective movement stats as already computed.
  // ═══════════════════════════════════════════════════════════════

  const EXT_DEFAULT = 70;
  function ext(id) {
    const el = document.getElementById(id);
    const base = el ? (+el.value || EXT_DEFAULT) : EXT_DEFAULT;
    // Extended stat ids pass through chemBoost directly; chem keys match input ids
    return Math.min(99, base + chemBoost(id));
  }

  // Helper: update a sub-stat bar (used by all three layers)
  function updateSubRow(prefix, eff) {
    const effBar = document.getElementById(`bar${prefix}Eff`);
    const baseBar = document.getElementById(`bar${prefix}Base`);
    const numEl = document.getElementById(`num${prefix}Eff`);
    if (!effBar || !numEl) return;
    const capped = Math.max(0, Math.min(150, Math.round(eff)));
    animateNumber(numEl, capped, effColor(capped));
    effBar.style.width = `${Math.min(100, (capped / BAR_VISUAL_MAX) * 100)}%`;
    effBar.style.background = effColor(capped);
    if (baseBar) baseBar.style.width = '0%';
  }

  // ──────── PASSING FEEL ────────
  function calculatePassingFeel(effA, effS, effG, effT, heightCm, weight) {
    const shortPass = ext('shortPass');
    const longPass  = ext('longPass');
    const vision    = ext('vision');
    const crossing  = ext('crossing');
    const curve     = ext('curve');
    const composure = ext('composure');
    const reactions = ext('reactions');

    // Start from base stats
    let sp = shortPass, lp = longPass, tb = (shortPass + vision) / 2, cr = crossing;
    const bd = [];
    bd.push({ source: 'Base stats', sp: shortPass, lp: longPass, tb: (shortPass + vision) / 2, cr: crossing, isBase: true });

    // Composure
    const cmpSteps = (composure - 75) / 5;
    if (cmpSteps !== 0) {
      sp += cmpSteps; lp += cmpSteps; tb += cmpSteps; cr += cmpSteps;
      bd.push({ source: `Composure (${composure}, ref 75)`, sp: cmpSteps, lp: cmpSteps, tb: cmpSteps, cr: cmpSteps });
    }
    // Reactions
    const rxSteps = Math.max(0, (reactions - 80) / 5);
    if (rxSteps > 0) {
      sp += rxSteps; lp += rxSteps; tb += rxSteps; cr += rxSteps;
      bd.push({ source: `Reactions (${reactions}, over 80)`, sp: rxSteps, lp: rxSteps, tb: rxSteps, cr: rxSteps });
    }
    // Vision through-ball boost
    const vsSteps = Math.max(0, (vision - 75) / 5);
    if (vsSteps > 0) {
      tb += vsSteps;
      bd.push({ source: `Vision (${vision}, over 75)`, tb: vsSteps });
    }
    // Curve cross + through
    const cvSteps = Math.max(0, (curve - 75) / 5);
    if (cvSteps > 0) {
      cr += cvSteps; tb += cvSteps;
      bd.push({ source: `Curve (${curve}, over 75)`, tb: cvSteps, cr: cvSteps });
    }
    // Height under 5'10" (177.8cm)
    if (heightCm < 177.8) {
      const inchesUnder = (177.8 - heightCm) / 2.54;
      lp -= inchesUnder; cr -= inchesUnder;
      bd.push({ source: `Height (${cmToFtIn(heightCm)}, below 5'10")`, lp: -inchesUnder, cr: -inchesUnder });
    }
    // Weight under 65kg
    if (weight < 65) {
      sp -= 2;
      bd.push({ source: `Weight (${weight}kg, under 65kg)`, sp: -2 });
    }
    // Build
    if (buildType === 'very_stocky') {
      sp -= 2; lp -= 2; tb -= 2; cr -= 2;
      bd.push({ source: 'Very Stocky Build', sp: -2, lp: -2, tb: -2, cr: -2 });
    } else if (buildType === 'lean') {
      sp += 2;
      bd.push({ source: 'Lean Build', sp: +2 });
    } else if (buildType === 'very_lean') {
      sp += 2;
      bd.push({ source: 'Very Lean Build', sp: +2 });
    }
    // Effective agility > 100
    if (effG > 100) {
      const ag = 2 * ((effG - 100) / 10);
      sp += ag; tb += ag;
      bd.push({ source: `Eff. Agility (${Math.round(effG)}, over 100)`, sp: ag, tb: ag });
    }
    // Effective tenacity > 120 mechanical feel penalty
    if (effT > 120) {
      const pen = (effT - 120) / 10;
      sp -= pen; lp -= pen; tb -= pen; cr -= pen;
      bd.push({ source: `Eff. Tenacity (${Math.round(effT)}, over 120)`, sp: -pen, lp: -pen, tb: -pen, cr: -pen });
    }

    // Playstyles
    if (activePS.has('incisive'))          { tb += 8;        bd.push({ source: 'Incisive',    tb: +8 }); }
    if (activePS.has('incisive_plus'))     { tb += 15;       bd.push({ source: 'Incisive+',   tb: +15 }); }
    if (activePS.has('pinged'))            { lp += 8;        bd.push({ source: 'Pinged',       lp: +8 }); }
    if (activePS.has('pinged_plus'))       { lp += 15;       bd.push({ source: 'Pinged+',      lp: +15 }); }
    if (activePS.has('long_ball'))         { lp += 4; tb += 6;  bd.push({ source: 'Long Ball',    lp: +4, tb: +6 }); }
    if (activePS.has('long_ball_plus'))    { lp += 10; tb += 12; bd.push({ source: 'Long Ball+',   lp: +10, tb: +12 }); }
    if (activePS.has('whipped'))           { cr += 8;        bd.push({ source: 'Whipped',      cr: +8 }); }
    if (activePS.has('whipped_plus'))      { cr += 20;       bd.push({ source: 'Whipped+',     cr: +20 }); }
    if (activePS.has('tiki_taka'))         { sp += 5; tb += 2; bd.push({ source: 'Tiki Taka',   sp: +5, tb: +2 }); }
    if (activePS.has('tiki_taka_plus'))    { sp += 10; tb += 4; bd.push({ source: 'Tiki Taka+',  sp: +10, tb: +4 }); }
    if (activePS.has('outside_foot'))      { tb += 3;        bd.push({ source: 'Inventive',    tb: +3 }); }
    if (activePS.has('outside_foot_plus')) { tb += 6;       bd.push({ source: 'Inventive+',   tb: +6 }); }

    updateSubRow('PassShort',   sp);
    updateSubRow('PassLong',    lp);
    updateSubRow('PassThrough', tb);
    updateSubRow('PassCross',   cr);
    renderExtBreakdown('passingBreakdownList', bd, PASS_STATS);
    renderPassingVerdict(sp, lp, tb, cr);

    return {
      effPassShort:   Math.max(0, Math.min(150, Math.round(sp))),
      effPassLong:    Math.max(0, Math.min(150, Math.round(lp))),
      effPassThrough: Math.max(0, Math.min(150, Math.round(tb))),
      effPassCross:   Math.max(0, Math.min(150, Math.round(cr))),
    };
  }

  function renderPassingVerdict(sp, lp, tb, cr) {
    const lines = [];
    const max = Math.max(sp, lp, tb, cr);
    const min = Math.min(sp, lp, tb, cr);
    const avg = (sp + lp + tb + cr) / 4;

    if (max >= 115 && min >= 100) lines.push('Orchestrator — elite across every passing discipline.');
    else if (tb >= 115 && lp >= 100) lines.push('Quarterback — lethal long-range distributor.');
    else if (sp >= 115 && tb >= 105) lines.push('Playmaker — precise in tight spaces with killer vision.');
    else if (sp >= 115) lines.push('Metronome — relentlessly reliable under pressure.');
    else if (cr >= 115) lines.push('Crosser — genuine threat from wide positions.');
    else if (avg >= 100) lines.push('Solid all-rounder — no glaring weaknesses.');
    else if (avg < 75) lines.push('Limited passing range — stick to safe options.');

    if (tb - sp > 25) lines.push('Heavy bias toward vertical passing over link-up play.');
    if (sp - tb > 25) lines.push('Short-game specialist — struggles to break lines.');
    if (cr >= 120) lines.push('Whipped deliveries land consistently on target.');

    document.getElementById('passingVerdictText').textContent =
      lines.length ? lines.join(' ') : 'Passing profile is broadly average.';
  }

  // ──────── DEFENDING FEEL ────────
  function calculateDefendingFeel(effA, effS, effG, effT, heightCm, weight) {
    const standTackle = ext('standTackle');
    const slideTackle = ext('slideTackle');
    const interceptions = ext('interceptions');
    const headingAcc = ext('headingAcc');
    const defAwareness = ext('defAwareness');
    const aggression = ext('aggression');
    const jumping = ext('jumping');
    const composure = ext('composure');
    const reactions = ext('reactions');
    const strength = Math.min(99, (+document.getElementById('strength').value || DEFAULT_STR) + chemBoost('strength'));
    const balance  = Math.min(99, (+document.getElementById('balance').value  || DEFAULT_BAL) + chemBoost('balance'));

    let tk = standTackle;
    let pos = defAwareness;
    let intc = interceptions;
    let aer = (headingAcc + jumping) / 2;
    let slide = slideTackle;
    const bd = [];

    // ── Bully sub-metric ──
    let bully = (strength + ((standTackle + slideTackle) / 2)) / 2;
    const bullyBase = bully;
    let bullyDelta = 0;
    const aggrBullyBonus = 0.3 * (aggression - 70);
    bullyDelta += aggrBullyBonus;
    let weightBullyDelta = 0;
    if (weight > 80) weightBullyDelta = Math.min((weight - 80) / 2, 10);
    else if (weight < 70) weightBullyDelta = -(70 - weight) / 2;
    bullyDelta += weightBullyDelta;
    let buildBullyDelta = 0;
    if (buildType === 'very_stocky')    buildBullyDelta = 8;
    else if (buildType === 'stocky')    buildBullyDelta = 4;
    else if (buildType === 'lean')      buildBullyDelta = -3;
    else if (buildType === 'very_lean') buildBullyDelta = -6;
    bullyDelta += buildBullyDelta;
    let effTBullyDelta = 0;
    if (effT > 100) effTBullyDelta = 2 * ((effT - 100) / 10);
    bullyDelta += effTBullyDelta;
    let effABullyDelta = 0;
    if (effA > 85) effABullyDelta = (effA - 85) / 10;
    bullyDelta += effABullyDelta;
    let balBullyDelta = Math.max(0, (balance - 70) / 8);
    bullyDelta += balBullyDelta;
    let heightBullyDelta = 0;
    if (heightCm > 185) heightBullyDelta = (heightCm - 185) / 4;
    bullyDelta += heightBullyDelta;
    bully += bullyDelta;
    let psAntpBullyDelta = 0, psBruiserDelta = 0, psBruiserPlusDelta = 0;
    if (activePS.has('anticipate_plus')) { psAntpBullyDelta = 3; bully += 3; }
    if (activePS.has('bruiser'))         { psBruiserDelta = 6;   bully += 6; }
    if (activePS.has('bruiser_plus'))    { psBruiserPlusDelta = 12; bully += 12; }

    // Base row
    bd.push({ source: 'Base stats', tk: standTackle, pos: defAwareness, int: interceptions, aer: (headingAcc + jumping) / 2, bully: bullyBase, slide: slideTackle, isBase: true });

    // Bully modifiers
    if (aggrBullyBonus)    bd.push({ source: `Aggression (${aggression}, ref 70) → Bully`, bully: aggrBullyBonus });
    if (weightBullyDelta)  bd.push({ source: `Weight (${weight}kg) → Bully`, bully: weightBullyDelta });
    if (buildBullyDelta)   bd.push({ source: `${buildType.replace('_',' ')} Build → Bully`, bully: buildBullyDelta });
    if (effTBullyDelta)    bd.push({ source: `Eff. Tenacity (${Math.round(effT)}, over 100) → Bully`, bully: effTBullyDelta });
    if (effABullyDelta)    bd.push({ source: `Eff. Acceleration (${Math.round(effA)}, over 85) → Bully`, bully: effABullyDelta });
    if (balBullyDelta)     bd.push({ source: `Balance (${balance}, over 70) → Bully`, bully: balBullyDelta });
    if (heightBullyDelta)  bd.push({ source: `Height (${cmToFtIn(heightCm)}, over 6'1") → Bully`, bully: heightBullyDelta });
    if (psAntpBullyDelta)  bd.push({ source: 'Anticipate+ → Bully', bully: psAntpBullyDelta });
    if (psBruiserDelta)    bd.push({ source: 'Bruiser → Bully', bully: psBruiserDelta });
    if (psBruiserPlusDelta) bd.push({ source: 'Bruiser+ → Bully', bully: psBruiserPlusDelta });

    // Def. awareness self-boost
    const posAwareDelta = 2 * Math.max(0, (defAwareness - 75) / 5);
    if (posAwareDelta) { pos += posAwareDelta; bd.push({ source: `Def. Awareness (${defAwareness}, over 75)`, pos: posAwareDelta }); }
    // Reactions → interception
    const rxIntDelta = 2 * Math.max(0, (reactions - 80) / 5);
    if (rxIntDelta) { intc += rxIntDelta; bd.push({ source: `Reactions (${reactions}, over 80)`, int: rxIntDelta }); }
    // Composure → tackle
    const cmpTkDelta = Math.max(0, (composure - 75) / 5);
    if (cmpTkDelta) { tk += cmpTkDelta; bd.push({ source: `Composure (${composure}, over 75)`, tk: cmpTkDelta }); }
    // Aggression window
    if (aggression >= 82 && aggression <= 88) { tk += 2; bd.push({ source: `Aggression window (${aggression}, 82–88)`, tk: +2 }); }
    else if (aggression > 88)                 { tk -= 2; bd.push({ source: `Aggression too high (${aggression}, over 88)`, tk: -2 }); }
    // Jumping → aerial
    const jumpAerDelta = 2 * Math.max(0, (jumping - 75) / 5);
    if (jumpAerDelta) { aer += jumpAerDelta; bd.push({ source: `Jumping (${jumping}, over 75)`, aer: jumpAerDelta }); }
    // Height → aerial
    const heightInchesFrom6ft = (heightCm - 183) / 2.54;
    if (heightInchesFrom6ft > 0) {
      const aerHDelta = 2 * heightInchesFrom6ft;
      aer += aerHDelta; bd.push({ source: `Height (${cmToFtIn(heightCm)}, above 6'0") → Aerial`, aer: aerHDelta });
    } else if (heightCm < 177.8) {
      const inchesBelow510 = (177.8 - heightCm) / 2.54;
      const aerHDelta = -3 * inchesBelow510;
      aer += aerHDelta; bd.push({ source: `Height (${cmToFtIn(heightCm)}, below 5'10") → Aerial`, aer: aerHDelta });
    }
    // Weight → tackle
    if (weight > 75) {
      const cappedW = Math.min(weight, 90);
      const wTkDelta = Math.max(0, (cappedW - 75) / 5);
      if (wTkDelta) { tk += wTkDelta; bd.push({ source: `Weight (${weight}kg, over 75kg) → Tackle`, tk: wTkDelta }); }
    }
    if (weight < 65) { tk -= 4; bd.push({ source: `Weight (${weight}kg, under 65kg) → Tackle`, tk: -4 }); }
    // Build → tackle / aerial
    if (buildType === 'very_stocky')    { tk += 3; aer += 3; bd.push({ source: 'Very Stocky Build', tk: +3, aer: +3 }); }
    else if (buildType === 'stocky')    { tk += 1;           bd.push({ source: 'Stocky Build', tk: +1 }); }
    else if (buildType === 'very_lean') { tk -= 3;           bd.push({ source: 'Very Lean Build', tk: -3 }); }
    // Bully > 100 → tackle
    if (bully > 100) {
      const bullyTkDelta = 2 * ((bully - 100) / 10);
      tk += bullyTkDelta; bd.push({ source: `Bully (${Math.round(bully)}, over 100) → Tackle`, tk: bullyTkDelta });
    }
    // Eff. acceleration > 85 → positioning
    if (effA > 85) {
      const effAPosDelta = (effA - 85) / 10;
      pos += effAPosDelta; bd.push({ source: `Eff. Acceleration (${Math.round(effA)}, over 85) → Positioning`, pos: effAPosDelta });
    }
    // Eff. sprint > 100 → recovery across all
    if (effS > 100) {
      const rec = (effS - 100) / 10;
      tk += rec; pos += rec; intc += rec; aer += rec * 0.5; slide += rec;
      bd.push({ source: `Eff. Sprint (${Math.round(effS)}, over 100) → Recovery`, tk: rec, pos: rec, int: rec, aer: rec * 0.5, slide: rec });
    }

    // Slide tackle modifiers
    const aggrSlideDelta = 0.3 * Math.max(0, (aggression - 70));
    if (aggrSlideDelta) { slide += aggrSlideDelta; bd.push({ source: `Aggression (${aggression}, over 70) → Slide`, slide: aggrSlideDelta }); }
    const cmpSlideDelta = Math.max(0, (composure - 75) / 5);
    if (cmpSlideDelta)  { slide += cmpSlideDelta;  bd.push({ source: `Composure (${composure}, over 75) → Slide`, slide: cmpSlideDelta }); }
    if (effG > 85) {
      const agiSlideDelta = (effG - 85) / 10;
      slide += agiSlideDelta; bd.push({ source: `Eff. Agility (${Math.round(effG)}, over 85) → Slide`, slide: agiSlideDelta });
    }
    if (weight > 90) {
      const wSlideDelta = -(weight - 90) / 5;
      slide += wSlideDelta; bd.push({ source: `Weight (${weight}kg, over 90kg) → Slide`, slide: wSlideDelta });
    }

    // Playstyles
    if (activePS.has('intercept_ps'))        { intc += 8;  bd.push({ source: 'Intercept',         int: +8 }); }
    if (activePS.has('intercept_ps_plus'))   { intc += 15; bd.push({ source: 'Intercept+',        int: +15 }); }
    if (activePS.has('block'))               { pos += 6;   bd.push({ source: 'Block',              pos: +6 }); }
    if (activePS.has('block_plus'))          { pos += 12;  bd.push({ source: 'Block+',             pos: +12 }); }
    if (activePS.has('jockey'))              { pos += 6;   bd.push({ source: 'Jockey',             pos: +6 }); }
    if (activePS.has('jockey_plus'))         { pos += 12;  bd.push({ source: 'Jockey+',            pos: +12 }); }
    if (activePS.has('anticipate'))          { tk += 8;    bd.push({ source: 'Anticipate',         tk: +8 }); }
    if (activePS.has('anticipate_plus'))     { tk += 15;   bd.push({ source: 'Anticipate+',        tk: +15 }); }
    if (activePS.has('aerial'))              { aer += 10;  bd.push({ source: 'Aerial',             aer: +10 }); }
    if (activePS.has('aerial_plus'))         { aer += 18;  bd.push({ source: 'Aerial+',            aer: +18 }); }
    if (activePS.has('precision_header'))    { aer += 8;   bd.push({ source: 'Precision Header',   aer: +8 }); }
    if (activePS.has('precision_header_plus')) { aer += 15; bd.push({ source: 'Precision Header+', aer: +15 }); }
    if (activePS.has('slide_tackle_ps'))     { slide += 8;  bd.push({ source: 'Slide Tackle',      slide: +8 }); }
    if (activePS.has('slide_tackle_ps_plus')) { slide += 15; bd.push({ source: 'Slide Tackle+',    slide: +15 }); }

    updateSubRow('DefTackle', tk);
    updateSubRow('DefPos',    pos);
    updateSubRow('DefInt',    intc);
    updateSubRow('DefAer',    aer);
    updateSubRow('DefBully',  bully);
    updateSubRow('DefSlide',  slide);
    renderExtBreakdown('defendingBreakdownList', bd, DEF_STATS);
    renderDefendingVerdict(tk, pos, intc, aer, bully, slide);

    return {
      effDefTackle: Math.max(0, Math.min(150, Math.round(tk))),
      effDefPos:    Math.max(0, Math.min(150, Math.round(pos))),
      effDefInt:    Math.max(0, Math.min(150, Math.round(intc))),
      effDefAer:    Math.max(0, Math.min(150, Math.round(aer))),
      effDefBully:  Math.max(0, Math.min(150, Math.round(bully))),
      effDefSlide:  Math.max(0, Math.min(150, Math.round(slide))),
    };
  }

  function renderDefendingVerdict(tk, pos, intc, aer, bully, slide) {
    const lines = [];
    const max = Math.max(tk, pos, intc, aer);
    const min = Math.min(tk, pos, intc, aer);
    const avg = (tk + pos + intc + aer) / 4;

    if (max >= 115 && min >= 100)            lines.push('Complete Defender — no exploitable weakness.');
    else if (aer >= 120)                     lines.push('Aerial Monster — wins nearly every ball in the air.');
    else if (intc >= 115 && pos >= 105)      lines.push('Reader — anticipates the attacker one step ahead.');
    else if (tk >= 115 && aer >= 100)        lines.push('Destroyer — wins balls through sheer physicality.');
    else if (tk >= 110 && pos >= 105)        lines.push('Anchor — rock-solid defensive baseline.');
    else if (avg >= 100)                     lines.push('Dependable defender across the board.');
    else if (avg < 75)                       lines.push('Defensive limitations expose him in 1v1 situations.');

    if (aer - tk > 30) lines.push('Dominant in the air but less effective on the ground.');
    if (pos > intc + 20) lines.push('Positional awareness outstrips raw reaction speed.');

    // Bully-specific clauses
    if (bully >= 120)                   lines.push('Bully of a defender — attackers physically bounce off on contact.');
    else if (bully >= 105 && tk >= 105) lines.push('Hard to beat 1v1 — won\'t be shrugged off in a direct run.');
    else if (bully < 70)                lines.push('Easily brushed aside in contact — struggles to hold position under pressure.');

    // Slide-tackle clauses
    if (slide >= 115)         lines.push('Elite slide-tackler — times recoveries with precision.');
    else if (slide < 70)      lines.push('Mistimes slide tackles — liable to give away dangerous fouls.');

    document.getElementById('defendingVerdictText').textContent =
      lines.length ? lines.join(' ') : 'Defending profile is broadly average.';
  }

  // ──────── SHOOTING FEEL ────────
  function calculateShootingFeel(effA, effS, effG, effT, effSlip, heightCm, weight, balance) {
    const finishing = ext('finishing');
    const shotPower = ext('shotPower');
    const longShots = ext('longShots');
    const volleys = ext('volleys');
    const attPositioning = ext('attPositioning');
    const curve = ext('curve');
    const composure = ext('composure');
    const reactions = ext('reactions');
    const fkAccuracy = ext('fkAccuracy');

    let fin = finishing;
    let pwr = shotPower;
    let fnse = (longShots + curve) / 2;
    let vol = volleys;
    let ldr = (shotPower * 0.5 + finishing * 0.35 + (balance * 0.15));
    let fk  = (fkAccuracy * 0.85 + curve * 0.10 + composure * 0.05);
    const bd = [];
    bd.push({ source: 'Base stats', fin: finishing, pwr: shotPower, fnse: (longShots + curve) / 2, vol: volleys, ldr: ldr, fk: fk, isBase: true });

    // Att. positioning → finishing
    const atpDelta = 0.5 * Math.max(0, (attPositioning - 75) / 5);
    if (atpDelta) { fin += atpDelta; bd.push({ source: `Att. Positioning (${attPositioning}, over 75)`, fin: atpDelta }); }

    // Composure → all
    const cmp = Math.max(0, (composure - 75) / 5) * 2;
    if (cmp) {
      fin += cmp; pwr += cmp; fnse += cmp; vol += cmp;
      const cmpLdr = Math.max(0, (composure - 75) / 5);
      ldr += cmpLdr;
      bd.push({ source: `Composure (${composure}, over 75)`, fin: cmp, pwr: cmp, fnse: cmp, vol: cmp, ldr: cmpLdr });
    }

    // Reactions → finishing
    const rxDelta = Math.max(0, (reactions - 80) / 5);
    if (rxDelta) { fin += rxDelta; bd.push({ source: `Reactions (${reactions}, over 80)`, fin: rxDelta }); }

    // Curve → finesse (self-boost beyond base)
    const cvDelta = 3 * Math.max(0, (curve - 80) / 5);
    if (cvDelta) { fnse += cvDelta; bd.push({ source: `Curve (${curve}, over 80)`, fnse: cvDelta }); }

    // Balance → all
    const balBonus = Math.max(0, (balance - 75) / 10);
    if (balBonus) {
      fin += balBonus; pwr += balBonus; fnse += balBonus; vol += balBonus;
      bd.push({ source: `Balance (${balance}, over 75)`, fin: balBonus, pwr: balBonus, fnse: balBonus, vol: balBonus });
    }
    // Balance > 85 second tier
    if (balance > 85) {
      const b = (balance - 85) / 5;
      fin += b; pwr += b; fnse += b; vol += b;
      bd.push({ source: `Balance (${balance}, over 85)`, fin: b, pwr: b, fnse: b, vol: b });
    }

    // Height > 6'0" → power
    const inchesOver6ft = (heightCm - 183) / 2.54;
    if (inchesOver6ft > 0) {
      pwr += inchesOver6ft;
      bd.push({ source: `Height (${cmToFtIn(heightCm)}, above 6'0") → Power`, pwr: inchesOver6ft });
    }

    // Weight
    if (weight > 90)      { pwr += 2; fnse -= 2; bd.push({ source: `Weight (${weight}kg, over 90kg)`, pwr: +2, fnse: -2 }); }
    else if (weight < 65) { fnse += 1; pwr -= 2; bd.push({ source: `Weight (${weight}kg, under 65kg)`, fnse: +1, pwr: -2 }); }

    // Build
    if (buildType === 'very_stocky')    { pwr += 3; fnse -= 3; bd.push({ source: 'Very Stocky Build', pwr: +3, fnse: -3 }); }
    else if (buildType === 'very_lean') { fnse += 3; pwr -= 2; bd.push({ source: 'Very Lean Build', fnse: +3, pwr: -2 }); }

    // Effective agility > 100 → finesse + volleys
    if (effG > 100) {
      const ag = 2 * ((effG - 100) / 10);
      fnse += ag; vol += ag;
      const ldrAg = (effG - 100) / 10;
      ldr += ldrAg;
      bd.push({ source: `Eff. Agility (${Math.round(effG)}, over 100)`, fnse: ag, vol: ag, ldr: ldrAg });
    }

    // Effective slipperiness > 130 → finishing
    if (effSlip > 130) {
      const slipDelta = 2 * ((effSlip - 130) / 10);
      fin += slipDelta;
      bd.push({ source: `Eff. Slipperiness (${Math.round(effSlip)}, over 130)`, fin: slipDelta });
    }

    // Low Driven modifiers (height, accel type, build, agility already captured above in ldr)
    if (heightCm < 180) {
      const ldrHDelta = (180 - heightCm) / 4;
      ldr += ldrHDelta; bd.push({ source: `Height (${cmToFtIn(heightCm)}, below 6'0") → Low Driven`, ldr: ldrHDelta });
    }
    if (heightCm > 188) {
      const ldrHDelta = -((heightCm - 188) / 4);
      ldr += ldrHDelta; bd.push({ source: `Height (${cmToFtIn(heightCm)}, above 6'2") → Low Driven`, ldr: ldrHDelta });
    }
    if (accelType === 'controlled') { ldr += 2; bd.push({ source: 'Controlled AcceleRATE → Low Driven', ldr: +2 }); }
    if (buildType === 'stocky')      { ldr += 3; bd.push({ source: 'Stocky Build → Low Driven', ldr: +3 }); }
    if (buildType === 'very_stocky') { ldr += 5; bd.push({ source: 'Very Stocky Build → Low Driven', ldr: +5 }); }
    if (buildType === 'lean')        { ldr += 1; bd.push({ source: 'Lean Build → Low Driven', ldr: +1 }); }

    // Playstyles — main stats
    if (activePS.has('finesse'))            { fnse += 8;  fk += 3;  bd.push({ source: 'Finesse',            fnse: +8,  fk: +3 }); }
    if (activePS.has('finesse_plus'))       { fnse += 15; fk += 6;  bd.push({ source: 'Finesse+',           fnse: +15, fk: +6 }); }
    if (activePS.has('power_shot'))         { pwr += 8;   ldr += 3; bd.push({ source: 'Power Shot',         pwr: +8,   ldr: +3 }); }
    if (activePS.has('power_shot_plus'))    { pwr += 15;  ldr += 5; bd.push({ source: 'Power Shot+',        pwr: +15,  ldr: +5 }); }
    if (activePS.has('chip_shot'))          { fin += 4;             bd.push({ source: 'Chip Shot',          fin: +4 }); }
    if (activePS.has('chip_shot_plus'))     { fin += 8;             bd.push({ source: 'Chip Shot+',         fin: +8 }); }
    if (activePS.has('outside_foot'))       { fnse += 3; vol += 3; fin += 2; ldr += 3; fk += 1;  bd.push({ source: 'Inventive',     fnse: +3, vol: +3, fin: +2, ldr: +3, fk: +1 }); }
    if (activePS.has('outside_foot_plus'))  { fnse += 6; vol += 6; fin += 4; ldr += 6; fk += 3; bd.push({ source: 'Inventive+',  fnse: +6, vol: +6, fin: +4, ldr: +6, fk: +3 }); }
    if (activePS.has('first_time'))         { vol += 10;            bd.push({ source: 'First Time',         vol: +10 }); }
    if (activePS.has('first_time_plus'))    { vol += 18;            bd.push({ source: 'First Time+',        vol: +18 }); }
    if (activePS.has('game_changer'))       { fin += 5;             bd.push({ source: 'Game Changer',       fin: +5 }); }
    if (activePS.has('game_changer_plus'))  { fin += 10;            bd.push({ source: 'Game Changer+',      fin: +10 }); }
    if (activePS.has('low_driven'))         { ldr += 10;            bd.push({ source: 'Low Driven',         ldr: +10 }); }
    if (activePS.has('low_driven_plus'))    { ldr += 18;            bd.push({ source: 'Low Driven+',        ldr: +18 }); }
    if (activePS.has('dead_ball'))          { fk += 15;             bd.push({ source: 'Dead Ball',          fk: +15 }); }
    if (activePS.has('dead_ball_plus'))     { fk += 28;             bd.push({ source: 'Dead Ball+',         fk: +28 }); }

    updateSubRow('ShootFin',  fin);
    updateSubRow('ShootPwr',  pwr);
    updateSubRow('ShootFine', fnse);
    updateSubRow('ShootVol',  vol);
    updateSubRow('ShootLdr',  ldr);
    updateSubRow('ShootFk',   fk);
    renderExtBreakdown('shootingBreakdownList', bd, SHOOT_STATS);
    renderShootingVerdict(fin, pwr, fnse, vol, ldr, fk);

    return {
      effShootFin:  Math.max(0, Math.min(150, Math.round(fin))),
      effShootPwr:  Math.max(0, Math.min(150, Math.round(pwr))),
      effShootFine: Math.max(0, Math.min(150, Math.round(fnse))),
      effShootVol:  Math.max(0, Math.min(150, Math.round(vol))),
      effShootLdr:  Math.max(0, Math.min(150, Math.round(ldr))),
      effShootFk:   Math.max(0, Math.min(150, Math.round(fk))),
    };
  }

  function renderShootingVerdict(fin, pwr, fnse, vol, ldr, fk) {
    const lines = [];
    const max = Math.max(fin, pwr, fnse, vol);
    const min = Math.min(fin, pwr, fnse, vol);
    const avg = (fin + pwr + fnse + vol) / 4;

    if (max >= 120 && min >= 105)             lines.push('Complete Finisher — a threat from every attacking situation.');
    else if (pwr >= 120)                      lines.push('Bomber — long-range shots carry real venom.');
    else if (fnse >= 120)                     lines.push('Sniper — devastating from the edge of the box.');
    else if (fin >= 120 && vol >= 100)        lines.push('Poacher — lives on instinct in the six-yard box.');
    else if (pwr >= 105 && fnse >= 100)       lines.push('Target — varied shooting profile with real power to back it up.');
    else if (avg >= 100)                      lines.push('Reliable finisher across multiple situations.');
    else if (avg < 75)                        lines.push('Limited threat in front of goal — needs clear chances.');

    if (fnse - pwr > 25) lines.push('Heavily reliant on placement over power.');
    if (pwr - fnse > 25) lines.push('Built for blunt force — subtlety is not the strength.');

    if (ldr >= 120)                   lines.push('Low driven shots become a cheat-code under the keeper — lethal from outside the box.');
    else if (ldr >= 105)              lines.push('Comfortable with the low driven shot — reliable finish when space opens up.');

    if (fk >= 115)                    lines.push('Elite free-kick taker — a genuine set-piece threat.');
    else if (fk < 65)                 lines.push('Not a free-kick option — hand the ball to someone else.');

    document.getElementById('shootingVerdictText').textContent =
      lines.length ? lines.join(' ') : 'Shooting profile is broadly average.';
  }

  // Ordered list of extended stat ids — used by getState, applyState, recalc
  const EXT_STAT_IDS = [
    'shortPass','longPass','vision','crossing','curve','fkAccuracy',
    'standTackle','slideTackle','interceptions','headingAcc','defAwareness','aggression','jumping',
    'finishing','shotPower','longShots','volleys','attPositioning',
    'composure','reactions','ballControl','dribbling','stamina'
  ];

  function recalcEffStats(s) {
    if (!s) return { effA:0, effS:0, effG:0, effT:0 };
    let dA=0, dS=0, dG=0, dT=0;
    const type = s.accelType || 'controlled';
    const build = s.buildType || 'normal';
    const ps = new Set(s.activePS || []);
    const heightCm = s.heightCm || DEFAULT_HEIGHT;
    const weight = s.weight || DEFAULT_WEIGHT;
    // Chem boost lookup for recalc — reuses the central CHEM_BOOSTS map
    const rcBoost = (key) => {
      if (!s.chemStyle) return 0;
      const t = CHEM_BOOSTS[s.chemStyle];
      return (t && t[key]) || 0;
    };
    const strength = Math.min(99, (s.strength || DEFAULT_STR) + rcBoost('strength'));
    const balance  = Math.min(99, (s.balance  || DEFAULT_BAL) + rcBoost('balance'));

    if (type==='explosive') { dA+=15; dS-=10; dG+=5; }
    else if (type==='lengthy') { dA-=10; dS+=15; dG-=5; }

    if (build==='very_lean') dT-=15;
    else if (build==='lean') dT-=5;
    else if (build==='stocky') dT+=5;
    else if (build==='very_stocky') dT+=15;

    const hSteps = ((heightCm - DEFAULT_HEIGHT) / 2.54) / 2;
    const hInches = (heightCm - DEFAULT_HEIGHT) / 2.54;
    dA += Math.round(-1*hSteps); dS += Math.round(+0.5*hInches);
    dG += Math.round(-1*hSteps); dT += Math.round(-1*hSteps);

    const wSteps = (weight - DEFAULT_WEIGHT) / 5;
    dA += Math.round(-1*wSteps); dS += Math.round(-0.5*wSteps);
    dG += Math.round(-1*wSteps);
    dT += Math.round(+2.5 * wSteps);

    const sSteps = (strength - DEFAULT_STR) / 5;
    dA += Math.round(-1*sSteps); dG += Math.round(-1*sSteps); dT += Math.round(+1.5*sSteps);

    const bSteps = (balance - DEFAULT_BAL) / 5;
    dT += Math.round(+2*bSteps);

    if (ps.has('quickstep'))      { dA+=5; dS+=1; }
    if (ps.has('quickstep_plus')) { dA+=10; dS+=2; }
    if (ps.has('rapid'))          { dA+=2; dG+=2; }
    if (ps.has('rapid_plus'))     { dA+=5; dG+=5; }
    if (ps.has('technical'))       dG+=5;
    if (ps.has('technical_plus'))  dG+=10;
    if (ps.has('first_touch'))     dA+=2;
    if (ps.has('first_touch_plus')) dA+=5;
    if (ps.has('trickster'))       dG+=2;
    if (ps.has('trickster_plus'))  dG+=4;
    if (ps.has('game_changer'))       dG+=2;
    if (ps.has('game_changer_plus'))  dG+=4;
    if (ps.has('enforcer'))       dT+=5;
    if (ps.has('enforcer_plus'))  dT+=10;
    if (ps.has('press_proven'))       dT+=2;
    if (ps.has('press_proven_plus'))  dT+=5;

    // Apply chem boosts to base stats (rcBoost is declared at the top of this function)
    const rBaseAccel   = Math.min(99, (s.baseAccel   || 0) + rcBoost('accel'));
    const rBaseSprint  = Math.min(99, (s.baseSprint  || 0) + rcBoost('sprint'));
    const rBaseAgility = Math.min(99, (s.baseAgility || 0) + rcBoost('agility'));

    // In-game Dribbling + Ball Control modify Agility feel (same rule as calculate())
    // Include chem boost so chems like Finisher (+9 dribbling) lift effective Agility too
    const gDrib = Math.min(99, (s.dribbling   != null ? +s.dribbling   : 70) + rcBoost('dribbling'));
    const gBall = Math.min(99, (s.ballControl != null ? +s.ballControl : 70) + rcBoost('ballControl'));
    const dribAgilityMod = Math.round(((gDrib + gBall) / 2 - 75) / 5);
    dG += dribAgilityMod;

    const rA = clamp(rBaseAccel   + dA);
    const rS = clamp(rBaseSprint  + dS);
    const rG = clamp(rBaseAgility + dG);
    const rT = clamp(75 + dT);
    const techSlipBonus = ps.has('technical_plus') ? 5 : ps.has('technical') ? 2 : 0;
    const buildSlipBonus = build === 'very_lean' ? 5 : build === 'lean' ? 2 : build === 'stocky' ? -2 : build === 'very_stocky' ? -5 : 0;
    const pressSlipBonus = ps.has('press_proven_plus') ? 5 : ps.has('press_proven') ? 2 : 0;
    const rSlip = Math.round((180 + (rG - (s.heightCm || 183))) + ((rT - 100) / 2) + techSlipBonus + buildSlipBonus + pressSlipBonus);

    const cappedS = Math.min(rS, SPRINT_CAP);
    const cappedT = Math.min(rT, TENACITY_CAP);

    // ──── Extended layers: pure-function equivalents of the DOM calculators ────
    const g = (k) => Math.min(99, (s[k] != null ? +s[k] : 70) + rcBoost(k));
    const round150 = (v) => Math.max(0, Math.min(150, Math.round(v)));

    // Passing
    let sp = g('shortPass'), lp = g('longPass'),
        tb = (g('shortPass') + g('vision')) / 2, cr = g('crossing');
    const composure = g('composure'), reactions = g('reactions'),
          vision = g('vision'), curve = g('curve');
    const cmpSteps = (composure - 75) / 5;
    if (cmpSteps !== 0) { sp += cmpSteps; lp += cmpSteps; tb += cmpSteps; cr += cmpSteps; }
    const rxSteps = Math.max(0, (reactions - 80) / 5);
    if (rxSteps > 0) { sp += rxSteps; lp += rxSteps; tb += rxSteps; cr += rxSteps; }
    tb += 3 * Math.max(0, (vision - 75) / 5);
    const cvSteps = Math.max(0, (curve - 75) / 5);
    cr += cvSteps; tb += cvSteps;
    if (heightCm < 177.8) { const i = (177.8 - heightCm) / 2.54; lp -= i; cr -= i; }
    if (weight < 65) sp -= 2;
    if (build === 'very_stocky') { sp -= 2; lp -= 2; tb -= 2; cr -= 2; }
    else if (build === 'very_lean' || build === 'lean') sp += 2;
    if (rG > 100) { sp += 2 * ((rG - 100) / 10); tb += 2 * ((rG - 100) / 10); }
    if (cappedT > 120) { const p = (cappedT - 120) / 10; sp -= p; lp -= p; tb -= p; cr -= p; }
    if (ps.has('incisive'))          tb += 8;
    if (ps.has('incisive_plus'))     tb += 15;
    if (ps.has('pinged'))            lp += 8;
    if (ps.has('pinged_plus'))       lp += 15;
    if (ps.has('long_ball'))        { lp += 4; tb += 6; }
    if (ps.has('long_ball_plus'))   { lp += 10; tb += 12; }
    if (ps.has('whipped'))           cr += 8;
    if (ps.has('whipped_plus'))      cr += 20;
    if (ps.has('tiki_taka'))        { sp += 5; tb += 2; }
    if (ps.has('tiki_taka_plus'))   { sp += 10; tb += 4; }
    // Inventive (merged into outside_foot) — Through Ball boost
    if (ps.has('outside_foot'))      tb += 3;
    if (ps.has('outside_foot_plus')) tb += 6;

    // Defending
    let tk = g('standTackle'); // Slide tackle no longer feeds tackle feel
    let pos = g('defAwareness');
    let intc = g('interceptions');
    let aer = (g('headingAcc') + g('jumping')) / 2;
    let slide = g('slideTackle'); // new slide sub-metric
    const aggression = g('aggression'), jumping = g('jumping'), defAw = g('defAwareness');

    // ── Bully (recalc) calculated FIRST so Tackle Feel can reference it ──
    let bully = (strength + ((g('standTackle') + g('slideTackle')) / 2)) / 2;
    bully += 0.3 * (aggression - 70);
    if (weight > 80) bully += Math.min((weight - 80) / 2, 10);
    else if (weight < 70) bully -= (70 - weight) / 2;
    if (build === 'very_stocky')    bully += 8;
    else if (build === 'stocky')    bully += 4;
    else if (build === 'lean')      bully -= 3;
    else if (build === 'very_lean') bully -= 6;
    if (cappedT > 100) bully += 2 * ((cappedT - 100) / 10);
    if (rA > 85)       bully += (rA - 85) / 10;
    bully += Math.max(0, (balance - 70) / 8);
    if (heightCm > 185) bully += (heightCm - 185) / 4;
    if (ps.has('anticipate_plus')) bully += 3;
    if (ps.has('bruiser'))         bully += 6;
    if (ps.has('bruiser_plus'))    bully += 12;

    pos += 2 * Math.max(0, (defAw - 75) / 5);
    intc += 2 * Math.max(0, (reactions - 80) / 5);
    tk += Math.max(0, (composure - 75) / 5);
    if (aggression >= 82 && aggression <= 88) tk += 2;
    else if (aggression > 88) tk -= 2;
    aer += 2 * Math.max(0, (jumping - 75) / 5);
    const heightInchesFrom6ft = (heightCm - 183) / 2.54;
    if (heightInchesFrom6ft > 0) aer += 2 * heightInchesFrom6ft;
    else if (heightCm < 177.8) aer -= 3 * ((177.8 - heightCm) / 2.54);
    if (weight > 75) { const cw = Math.min(weight, 90); tk += Math.max(0, (cw - 75) / 5); }
    if (weight < 65) tk -= 4;
    if (build === 'very_stocky')    { tk += 3; aer += 3; }
    else if (build === 'stocky')    { tk += 1; }
    else if (build === 'very_lean') { tk -= 3; }
    // Bully > 100 boosts Tackle (replaces previous Tenacity influence)
    if (bully > 100) tk += 2 * ((bully - 100) / 10);
    if (rA > 85) pos += (rA - 85) / 10;
    if (cappedS > 100) {
      const rec = (cappedS - 100) / 10;
      tk += rec; pos += rec; intc += rec; aer += rec * 0.5; slide += rec;
    }
    // Slide sub-metric modifiers
    slide += 0.3 * Math.max(0, (aggression - 70));
    slide += Math.max(0, (composure - 75) / 5);
    if (rG > 85) slide += (rG - 85) / 10;
    if (weight > 90) slide -= (weight - 90) / 5;

    if (ps.has('intercept_ps'))       intc += 8;
    if (ps.has('intercept_ps_plus'))  intc += 15;
    if (ps.has('block'))              pos += 6;
    if (ps.has('block_plus'))         pos += 12;
    if (ps.has('jockey'))             pos += 6;
    if (ps.has('jockey_plus'))        pos += 12;
    if (ps.has('anticipate'))         tk += 8;
    if (ps.has('anticipate_plus'))    tk += 15;
    if (ps.has('aerial'))             aer += 10;
    if (ps.has('aerial_plus'))        aer += 18;
    if (ps.has('precision_header'))      aer += 8;
    if (ps.has('precision_header_plus')) aer += 15;
    if (ps.has('slide_tackle_ps'))       slide += 8;
    if (ps.has('slide_tackle_ps_plus'))  slide += 15;

    // Shooting
    let fin = g('finishing');
    let pwr = g('shotPower');
    let fnse = (g('longShots') + g('curve')) / 2;
    let vol = g('volleys');
    const attPos = g('attPositioning');
    fin += 2 * Math.max(0, (attPos - 75) / 5);
    const cmp = Math.max(0, (composure - 75) / 5) * 2;
    fin += cmp; pwr += cmp; fnse += cmp; vol += cmp;
    fin += Math.max(0, (reactions - 80) / 5);
    fnse += 3 * Math.max(0, (curve - 80) / 5);
    const balBonus = Math.max(0, (balance - 75) / 10);
    fin += balBonus; pwr += balBonus; fnse += balBonus; vol += balBonus;
    if (heightInchesFrom6ft > 0) pwr += heightInchesFrom6ft;
    if (weight > 90) { pwr += 2; fnse -= 2; }
    else if (weight < 65) { fnse += 1; pwr -= 2; }
    if (build === 'very_stocky')    { pwr += 3; fnse -= 3; }
    else if (build === 'very_lean') { fnse += 3; pwr -= 2; }
    if (rG > 100) { const ag = 2 * ((rG - 100) / 10); fnse += ag; vol += ag; }
    if (balance > 85) {
      const b = (balance - 85) / 5;
      fin += b; pwr += b; fnse += b; vol += b;
    }
    if (rSlip > 130) fin += 2 * ((rSlip - 130) / 10);
    if (ps.has('finesse'))            fnse += 8;
    if (ps.has('finesse_plus'))       fnse += 15;
    if (ps.has('power_shot'))         pwr += 8;
    if (ps.has('power_shot_plus'))    pwr += 15;
    if (ps.has('chip_shot'))          fin += 4;
    if (ps.has('chip_shot_plus'))     fin += 8;
    // Dead Shot (Freekick) — pure FK Taker specialist now (handled below)
    // Inventive (merged from Outside the Foot + old Inventive Trivela)
    if (ps.has('outside_foot'))      { fnse += 3; vol += 3; fin += 2; }
    if (ps.has('outside_foot_plus')) { fnse += 6; vol += 6; fin += 4; }
    if (ps.has('first_time'))         vol += 10;
    if (ps.has('first_time_plus'))    vol += 18;
    if (ps.has('game_changer'))       fin += 5;
    if (ps.has('game_changer_plus'))  fin += 10;

    // ── Low Driven (recalc) ──
    let ldr = (g('shotPower') * 0.5 + g('finishing') * 0.35 + (balance * 0.15));
    ldr += Math.max(0, (composure - 75) / 5);
    if (heightCm < 180) ldr += (180 - heightCm) / 4;
    if (heightCm > 188) ldr -= (heightCm - 188) / 4;
    if (type === 'controlled') ldr += 2;
    if (build === 'stocky')       ldr += 3;
    if (build === 'very_stocky')  ldr += 5;
    if (build === 'lean')         ldr += 1;
    if (rG > 100) ldr += (rG - 100) / 10;
    if (ps.has('power_shot'))      ldr += 3;
    if (ps.has('power_shot_plus')) ldr += 5;
    if (ps.has('low_driven'))      ldr += 10;
    if (ps.has('low_driven_plus')) ldr += 18;
    // Inventive (merged): +3/+6 low driven
    if (ps.has('outside_foot'))      ldr += 3;
    if (ps.has('outside_foot_plus')) ldr += 6;

    // ── Free Kick Taker (recalc) — FK Accuracy-dominant ──
    const fkAccuracyR = g('fkAccuracy');
    let fk = (fkAccuracyR * 0.85 + g('curve') * 0.10 + composure * 0.05);
    if (ps.has('dead_ball'))       fk += 15;
    if (ps.has('dead_ball_plus'))  fk += 28;
    if (ps.has('finesse'))         fk += 3;
    if (ps.has('finesse_plus'))    fk += 6;
    if (ps.has('outside_foot'))      fk += 1;
    if (ps.has('outside_foot_plus')) fk += 3;

    return {
      effA: rA, effS: rS, effG: rG, effT: rT, effSlip: rSlip,
      // Passing
      effPassShort:   round150(sp),
      effPassLong:    round150(lp),
      effPassThrough: round150(tb),
      effPassCross:   round150(cr),
      // Defending
      effDefTackle: round150(tk),
      effDefPos:    round150(pos),
      effDefInt:    round150(intc),
      effDefAer:    round150(aer),
      effDefBully:  round150(bully),
      effDefSlide:  round150(slide),
      // Shooting
      effShootFin:  round150(fin),
      effShootPwr:  round150(pwr),
      effShootFine: round150(fnse),
      effShootVol:  round150(vol),
      effShootLdr:  round150(ldr),
      effShootFk:   round150(fk),
    };
  }

  function statColor(v, isSprint, isTenacity) {
    if (isSprint) return sprintColor(v);
    if (isTenacity) return tenacityColor(v);
    if (v >= 115) return 'var(--neutral)';
    if (v >= 100) return 'var(--gain)';
    if (v >= 85)  return '#E4953C';
    return 'var(--loss)';
  }
