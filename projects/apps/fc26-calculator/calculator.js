/* ═══════════════════════════════════════════════════════════════
   FEEL CALCULATOR — the engine. Pure maths, no DOM.
   ───────────────────────────────────────────────────────────────
   computeFeel(state) → { flat, base, verdicts, rows, slip }
     flat      the 21 effective feel stats (effA … effShootFk)
     base      card values behind the four movement stats
     verdicts  one paragraph per layer
     rows      modifier breakdown per layer ({ label, base?, note?, chips[{k,v,sign}] })
     slip      slipperiness breakdown ({ rows[{label,v,base?}], total })

   computeFeel is a line-for-line extraction of the legacy DOM-bound
   calculate(): tests/golden.json (captured from that version) pins every
   number, verdict and breakdown row. Change the maths here only with a
   matching golden refresh.
   Loads as a classic script (window.FC26) or a CommonJS module (tests).
   ═══════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  const DEFAULT_HEIGHT  = 183;
  const DEFAULT_WEIGHT  = 80;
  const DEFAULT_STR     = 70;
  const DEFAULT_BAL     = 75;
  const MAX_VAL         = 150;
  const EXT_DEFAULT     = 70;
  const SPRINT_CAP      = 120;
  const TENACITY_CAP    = 130;
  const BAR_VISUAL_MAX  = 120; // All stat bars visually fill on a 0-120 scale for consistency

  function clamp(v) { return Math.max(1, Math.min(MAX_VAL, v)); }

  // Round total inches first, so 182cm reads 6'0" rather than 5'12".
  function cmToFtIn(cm) {
    const totalIn = Math.round(cm / 2.54);
    return `${Math.floor(totalIn / 12)}'${totalIn % 12}"`;
  }

  /* Four-tier semantic progression — low <85 · mid 85-99 · high 100-114 · peak 115+. */
  function statTier(v) {
    if (v >= 115) return 'cyan';
    if (v >= 100) return 'green';
    if (v >= 85)  return 'amber';
    return 'magenta';
  }

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

  // Ordered list of extended stat ids — the saved-state shape
  const EXT_STAT_IDS = [
    'shortPass','longPass','vision','crossing','curve','fkAccuracy',
    'standTackle','slideTackle','interceptions','headingAcc','defAwareness','aggression','jumping',
    'finishing','shotPower','longShots','volleys','attPositioning',
    'composure','reactions','ballControl','dribbling','stamina'
  ];

  // A fresh player — the values the legacy Reset button restored.
  const DEFAULTS = {
    chemStyle: null, baseAccel: 80, baseSprint: 80, baseAgility: 80,
    heightCm: DEFAULT_HEIGHT, weight: DEFAULT_WEIGHT, strength: DEFAULT_STR, balance: DEFAULT_BAL,
    accelType: 'controlled', buildType: 'normal', activePS: [],
  };
  EXT_STAT_IDS.forEach(id => { DEFAULTS[id] = EXT_DEFAULT; });

  const PASS_STATS  = [{ key:'sp', label:'SP' }, { key:'lp', label:'LP' }, { key:'tb', label:'TB' }, { key:'cr', label:'CR' }];
  const DEF_STATS   = [{ key:'tk', label:'TK' }, { key:'pos', label:'POS' }, { key:'int', label:'INT' }, { key:'aer', label:'AER' }, { key:'bully', label:'BULLY' }, { key:'slide', label:'SLIDE' }];
  const SHOOT_STATS = [{ key:'fin', label:'FIN' }, { key:'pwr', label:'PWR' }, { key:'fnse', label:'FNSE' }, { key:'vol', label:'VOL' }, { key:'ldr', label:'LDR' }, { key:'fk', label:'FK' }];
  const round150 = v => Math.max(0, Math.min(150, Math.round(v)));

  function computeFeel(input) {
    const s = Object.assign({}, DEFAULTS, input);
    const accelType = s.accelType || 'controlled';
    const buildType = s.buildType || 'normal';
    const activePS = new Set(s.activePS || []);
    const chemTable = s.chemStyle ? CHEM_BOOSTS[s.chemStyle] : null;
    // Returns how many points a given stat key is boosted by the active chem style
    const chemBoost = key => (chemTable && chemTable[key]) || 0;
    // Extended stat ids pass through chemBoost directly; chem keys match stat ids
    const ext = id => Math.min(99, (+s[id] || EXT_DEFAULT) + chemBoost(id));

    const baseAccel    = Math.min(99, (+s.baseAccel   || 0) + chemBoost('accel'));
    const baseSprint   = Math.min(99, (+s.baseSprint  || 0) + chemBoost('sprint'));
    const baseAgility  = Math.min(99, (+s.baseAgility || 0) + chemBoost('agility'));
    const baseTenacity = 75;
    const heightCm     = +s.heightCm     || DEFAULT_HEIGHT;
    const weight       = +s.weight       || DEFAULT_WEIGHT;
    const strength     = Math.min(99, (+s.strength || DEFAULT_STR) + chemBoost('strength'));
    const balance      = Math.min(99, (+s.balance  || DEFAULT_BAL) + chemBoost('balance'));

    let dA = 0, dS = 0, dG = 0, dT = 0;
    const breakdown = [];

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
    // Average of base Dribbling + Ball Control, every 5 points from 75 contributes ±1 to Agility
    const dribAvg = (ext('dribbling') + ext('ballControl')) / 2;
    const dribAgilityMod = Math.round((dribAvg - 75) / 5);
    if (dribAgilityMod !== 0) {
      dG += dribAgilityMod;
      breakdown.push({ source: `Dribbling + Ball Control (avg ${Math.round(dribAvg)})`, a: 0, s: 0, g: dribAgilityMod, t: 0 });
    }

    const effA = clamp(baseAccel    + dA);
    const effS = clamp(baseSprint   + dS);
    const effG = clamp(baseAgility  + dG);
    const effT = clamp(baseTenacity + dT);
    const cappedEffS = Math.min(effS, SPRINT_CAP);
    const cappedEffT = Math.min(effT, TENACITY_CAP);

    const techSlipBonus = activePS.has('technical_plus') ? 5 : activePS.has('technical') ? 2 : 0;
    const buildSlipBonus = buildType === 'very_lean' ? 5 : buildType === 'lean' ? 2 : buildType === 'stocky' ? -2 : buildType === 'very_stocky' ? -5 : 0;
    const pressSlipBonus = activePS.has('press_proven_plus') ? 5 : activePS.has('press_proven') ? 2 : 0;
    const ftSlipBonus = activePS.has('first_touch_plus') ? 5 : activePS.has('first_touch') ? 2 : 0;
    const slip = Math.round((180 + (effG - heightCm)) + ((effT - 100) / 2) + techSlipBonus + buildSlipBonus + pressSlipBonus + ftSlipBonus);

    const ctx = { s, ext, activePS, accelType, buildType, strength, balance, heightCm, weight };
    // Extended feel layers — all consume the movement-layer outputs
    const P = passingFeel(ctx, effA, cappedEffS, effG, cappedEffT);
    const D = defendingFeel(ctx, effA, cappedEffS, effG, cappedEffT);
    const S = shootingFeel(ctx, effA, cappedEffS, effG, cappedEffT, slip);

    return {
      flat: {
        effA, effS: cappedEffS, effG, effT: cappedEffT, effSlip: slip,
        effPassShort: round150(P.sp), effPassLong: round150(P.lp), effPassThrough: round150(P.tb), effPassCross: round150(P.cr),
        effDefTackle: round150(D.tk), effDefPos: round150(D.pos), effDefInt: round150(D.intc), effDefAer: round150(D.aer), effDefBully: round150(D.bully), effDefSlide: round150(D.slide),
        effShootFin: round150(S.fin), effShootPwr: round150(S.pwr), effShootFine: round150(S.fnse), effShootVol: round150(S.vol), effShootLdr: round150(S.ldr), effShootFk: round150(S.fk),
      },
      base: { effA: baseAccel, effS: baseSprint, effG: baseAgility, effT: baseTenacity },
      verdicts: {
        movement: movementVerdict(effT, weight, heightCm, strength, accelType, buildType, activePS),
        passing: P.verdict, defending: D.verdict, shooting: S.verdict,
      },
      rows: {
        movement: movementRows(breakdown),
        passing: extRows(P.bd, PASS_STATS), defending: extRows(D.bd, DEF_STATS), shooting: extRows(S.bd, SHOOT_STATS),
      },
      slip: {
        rows: slipRows(effG, heightCm, effT, techSlipBonus, buildSlipBonus, pressSlipBonus, ftSlipBonus),
        total: slip,
      },
    };
  }

  // Slipperiness breakdown. Effective tenacity here is uncapped, as in the total.
  function slipRows(effG, heightCm, effT, techBonus, buildBonus, pressBonus, ftBonus) {
    const items = [{ label: 'Default (180 + Agility feel − height)', v: Math.round(180 + (effG - heightCm)), base: true }];
    const tenBonus = (effT - 100) / 2;
    if (tenBonus !== 0) items.push({ label: '(Tenacity − 100) ÷ 2', v: Math.round(tenBonus) });
    if (techBonus !== 0) items.push({ label: techBonus === 5 ? 'Technical+' : 'Technical', v: techBonus });
    if (buildBonus !== 0) {
      const label = buildBonus === 5 ? 'Very Lean Build' : buildBonus === 2 ? 'Lean Build' : buildBonus === -2 ? 'Stocky Build' : 'Very Stocky Build';
      items.push({ label, v: buildBonus });
    }
    // Already in the total; the legacy list never itemised them.
    if (pressBonus !== 0) items.push({ label: pressBonus === 5 ? 'Press Proven+' : 'Press Proven', v: pressBonus });
    if (ftBonus !== 0) items.push({ label: ftBonus === 5 ? 'First Touch+' : 'First Touch', v: ftBonus });
    return items;
  }

  function movementRows(items) {
    const active = items.filter(i => i.a||i.s||i.g||i.t);
    if (!active.length) return [{ label: 'No modifiers — all stats at face value', note: true, chips: [] }];
    const chip = (k, v) => ({ k, v, sign: v > 0 ? 1 : -1 });
    return active.map(i => ({
      label: i.source,
      chips: [i.a && chip('ACC', i.a), i.s && chip('SPR', i.s), i.g && chip('AGI', i.g), i.t && chip('TEN', i.t)].filter(Boolean),
    }));
  }

  // Breakdown rows for the extended layers (passing / defending / shooting).
  // Items are grouped by input source (e.g. Height → Bully and Height → Aerial collapse
  // into one row), the redundant "→ Stat" suffix is dropped (the chip already labels
  // its target), and values are integers when the rounded value is exact.
  function extRows(items, statDefs) {
    const active = items.filter(i => i.isBase || statDefs.some(s => i[s.key]));
    if (!active.length) return [{ label: 'No modifiers active', note: true, chips: [] }];

    const stripArrow = s => s.replace(/\s*→\s*.+$/, '');
    const deriveGroup = s => {
      const prefix = stripArrow(s).replace(/\s*\([^)]*\)\s*/g, ' ').trim();
      if (/Build$/i.test(prefix)) return 'build';
      if (/^Aggression/i.test(prefix)) return 'aggression';
      return prefix.toLowerCase();
    };
    const num = v => {
      const r = Math.round(v);
      return Math.abs(v - r) < 0.05 ? r : Math.round(v * 10) / 10;
    };

    const groups = [];
    const groupMap = new Map();
    for (const item of active) {
      if (item.isBase) { groups.push({ base: true, items: [item], label: item.source }); continue; }
      const key = deriveGroup(item.source);
      if (groupMap.has(key)) groupMap.get(key).items.push(item);
      else { const entry = { items: [item], label: stripArrow(item.source) }; groupMap.set(key, entry); groups.push(entry); }
    }

    return groups.map(entry => {
      if (entry.base) {
        const item = entry.items[0];
        return { label: entry.label, base: true, chips: statDefs.filter(s => item[s.key] != null).map(s => ({ k: s.label, v: Math.round(item[s.key]), sign: 0 })) };
      }
      const totals = {};
      for (const item of entry.items) for (const s of statDefs) if (item[s.key]) totals[s.key] = (totals[s.key] || 0) + item[s.key];
      const chips = statDefs.filter(s => totals[s.key] && Math.abs(totals[s.key]) >= 0.05).map(s => {
        const v = num(totals[s.key]);
        return { k: s.label, v, sign: v >= 0 ? 1 : -1 };
      });
      return chips.length ? { label: entry.label, chips } : null;
    }).filter(Boolean);
  }

  function movementVerdict(effT, weight, heightCm, strength, type, build, activePS) {
    const lines = [];
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

    return lines.join(' ');
  }

  // ──────── PASSING FEEL ────────
  function passingFeel(c, effA, effS, effG, effT) {
    const { ext, activePS, buildType, heightCm, weight } = c;
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

    return { sp, lp, tb, cr, bd, verdict: passingVerdict(sp, lp, tb, cr) };
  }

  function passingVerdict(sp, lp, tb, cr) {
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

    return lines.length ? lines.join(' ') : 'Passing profile is broadly average.';
  }

  // ──────── DEFENDING FEEL ────────
  function defendingFeel(c, effA, effS, effG, effT) {
    const { ext, activePS, buildType, heightCm, weight, strength, balance } = c;
    const standTackle = ext('standTackle');
    const slideTackle = ext('slideTackle');
    const interceptions = ext('interceptions');
    const headingAcc = ext('headingAcc');
    const defAwareness = ext('defAwareness');
    const aggression = ext('aggression');
    const jumping = ext('jumping');
    const composure = ext('composure');
    const reactions = ext('reactions');

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
    const balBullyDelta = Math.max(0, (balance - 70) / 8);
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

    return { tk, pos, intc, aer, bully, slide, bd, verdict: defendingVerdict(tk, pos, intc, aer, bully, slide) };
  }

  function defendingVerdict(tk, pos, intc, aer, bully, slide) {
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

    return lines.length ? lines.join(' ') : 'Defending profile is broadly average.';
  }

  // ──────── SHOOTING FEEL ────────
  function shootingFeel(c, effA, effS, effG, effT, effSlip) {
    const { ext, activePS, accelType, buildType, heightCm, weight, balance } = c;
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

    return { fin, pwr, fnse, vol, ldr, fk, bd, verdict: shootingVerdict(fin, pwr, fnse, vol, ldr, fk) };
  }

  function shootingVerdict(fin, pwr, fnse, vol, ldr, fk) {
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

    return lines.length ? lines.join(' ') : 'Shooting profile is broadly average.';
  }

  const FC26 = {
    computeFeel, cmToFtIn, statTier,
    CHEM_BOOSTS, DEFAULTS, EXT_STAT_IDS, SPRINT_CAP, TENACITY_CAP, BAR_VISUAL_MAX,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = FC26;
  else root.FC26 = FC26;
})(typeof window !== 'undefined' ? window : globalThis);
