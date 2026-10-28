/**
 * js/engine/solver/model.js
 * The MILP model (docs/decision-engine-plan.md, Phase 8; the app's solver,
 * docs/decision-engine-solver-plan.md): the best multi-week transfer plan on
 * the engine's own projections, under FPL's rules, as a mixed-integer program
 * in CPLEX LP format for HiGHS (npm "highs", MIT). Pure: builds the model's
 * text and reads a solution.
 *
 * Over the weeks of the horizon it chooses, each week, who is bought and
 * sold, the squad (2/5/5/3, three a club), the XI (a legal formation), the
 * captain and the bench order, maximising the weighted expected points of
 * the XI and captain plus the bench at fixed slot weights (the engine's
 * linear autosub weights: a MILP cannot hold the probability version), less
 * 4 a hit, each at its week's weight (or, with flatHits, at the full cost whatever the week weighs). Money is integer tenths: a sale fetches his sell price if he is
 * owned now, his price if bought within the horizon (prices do not move in
 * it); the bank never goes below zero. Free transfers bank one a week to the
 * cap, counted exactly (the unused ones carry, a hit buys none, whatever the
 * weights); transfers past them are hits. Optionally it also places Bench Boost
 * and Triple Captain, once each and never in the same gameweek. A player sold
 * and bought back within the horizon sells again at his old sell price (a
 * cautious error, and rare: it costs two transfers).
 *
 * A mode's problem may add, each off unless given: what the horizon's end is
 * worth (the free transfers left, the bank), a margin on every hit, players
 * held in the first week, Free Hit weeks with no transfers at all, dead slots,
 * sale points, and first weeks the plan must not repeat.
 *
 * The formulation follows the shape of open-fpl-solver (Sertalp B. Cay,
 * Apache-2.0, github.com/solioanalytics/open-fpl-solver); no code is taken
 * from it.
 */

import { SQUAD_TOTAL } from '../../config.js';

/**
 * @param {object} p
 * @param {number[]} p.gws            the horizon's gameweeks, in order
 * @param {number[]} p.weights        each week's weight in the objective
 * @param {Array<{id: number, position: string, teamId: number, priceTenths: number, sellTenths: number,
 *   owned: boolean, xpts: number[]}>} p.players  the owned squad and the candidates; xpts per week
 * @param {number} p.bankTenths
 * @param {number} p.ft               free transfers for the first week
 * @param {number} p.maxBankedFt
 * @param {number} p.hitCost
 * @param {{gk: number, s1: number, s2: number, s3: number}} p.benchWeights
 * @param {number} p.maxPerClub
 * @param {Object<string, number>} p.squadLimits
 * @param {Object<string, number>} p.xiMin
 * @param {number} p.lineTerms         terms per line of the model's text, which stays readable (DECISION_ENGINE.solver.lpLineTerms)
 * @param {{benchboost?: boolean, triplecaptain?: boolean}} [p.chips]  place these once each
 * @param {{first?: {in: number[], out: number[]}, benchboost?: number|null, triplecaptain?: number|null}} [p.fixed]
 *   the first week's moves, or a chip's gameweek (null: not played), held fixed
 * @param {Object<number, number>|null} [p.endFtValue]  the value of each free transfer banked at the horizon's end,
 *   by the count it brings the bank to ({2: 1.5, 3: 1, ...}); it must not rise with the count
 * @param {number} [p.bankPerTenth]    the value of each tenth left in the bank at the horizon's end
 * @param {number} [p.hitMargin]       points added to every hit's cost in the objective (decode still reports hitCost)
 * @param {boolean} [p.flatHits]      each hit costs hitCost plus the margin in the objective whatever its week's weight
 *   (the engine's transferCost); off: a hit costs that times its week's weight, as Phase 8's planner priced it
 * @param {number[]} [p.keep]          owned ids not sold in the first week (each must be among p.players)
 * @param {number[]} [p.frozen]        gameweeks with no transfers at all (a Free Hit): the free transfers pass through
 *   (each must be among p.gws)
 * @param {{ids: number[], penalty: number}|null} [p.deadSlot]  players (owned or not) whose place in the squad after
 *   the first week's moves costs the penalty, once
 * @param {Object<number, number>} [p.salePoints]  points for selling an id in the first week (his price is about to fall)
 * @param {Array<{in: number[], out: number[]}>} [p.exclude]  first weeks the plan must not be
 * @returns {{lp: string, decode: (result: object) => object}}
 */
export function buildPlan(p) {
  if (!(p.lineTerms >= 1)) throw new Error('buildPlan: lineTerms is the terms per line of the text, at least one');
  // A player to keep or a week to freeze that the problem does not hold would do nothing, silently: refuse it.
  const known = new Set(p.players.map(q => q.id));
  const unknownKeep = (p.keep ?? []).filter(id => !known.has(id));
  if (unknownKeep.length) throw new Error(`buildPlan: keep holds ${unknownKeep.join(', ')}, not among the players`);
  const unknownFrozen = (p.frozen ?? []).filter(gw => !p.gws.includes(gw));
  if (unknownFrozen.length) throw new Error(`buildPlan: frozen holds ${unknownFrozen.join(', ')}, not among the gws`);
  const weeks = p.gws.map((gw, k) => k);
  const isFrozen = k => Boolean(p.frozen?.includes(p.gws[k]));
  const v = (kind, id, k) => `${kind}${id}_${k}`;
  const rows = [];
  const binaries = [];
  const generals = [];
  const bounds = [];
  const objective = [];
  const row = (name, terms, sense, rhs) => rows.push({ name, terms: terms.filter(([c]) => c !== 0), sense, rhs });
  const outfield = q => q.position !== 'GKP';
  const slots = ['g', 'b1', 'b2', 'b3'];
  const slotWeight = { g: p.benchWeights.gk, b1: p.benchWeights.s1, b2: p.benchWeights.s2, b3: p.benchWeights.s3 };
  const slotsOf = q => (outfield(q) ? ['b1', 'b2', 'b3'] : ['g']);
  // The XI is the squad less one player a bench slot.
  const xiSize = Object.values(p.squadLimits).reduce((a, n) => a + n, 0) - slots.length;

  for (const k of weeks) {
    const w = p.weights[k];
    const frozen = isFrozen(k);
    for (const q of p.players) {
      const [s, l, c, i, o] = ['s', 'l', 'c', 'i', 'o'].map(kind => v(kind, q.id, k));
      binaries.push(s, l, c, i, o, ...slotsOf(q).map(b => v(b, q.id, k)));
      // The squad carries over, plus buys, less sales.
      if (k === 0) row(`flow_${q.id}_${k}`, [[1, s], [-1, i], [1, o]], '=', q.owned ? 1 : 0);
      else row(`flow_${q.id}_${k}`, [[1, s], [-1, v('s', q.id, k - 1)], [-1, i], [1, o]], '=', 0);
      row(`move_${q.id}_${k}`, [[1, i], [1, o]], '<=', 1);
      row(`inxi_${q.id}_${k}`, [[1, l], [-1, s]], '<=', 0);
      row(`cap_${q.id}_${k}`, [[1, c], [-1, l]], '<=', 0);
      // In the squad: in the XI or in one bench slot of his kind.
      row(`seat_${q.id}_${k}`, [[1, l], ...slotsOf(q).map(b => [1, v(b, q.id, k)]), [-1, s]], '=', 0);
      objective.push([w * q.xpts[k], l], [w * q.xpts[k], c],
        ...slotsOf(q).map(b => [w * q.xpts[k] * slotWeight[b], v(b, q.id, k)]));
    }
    for (const [position, n] of Object.entries(p.squadLimits)) {
      const ofPos = p.players.filter(q => q.position === position);
      row(`shape_${position}_${k}`, ofPos.map(q => [1, v('s', q.id, k)]), '=', n);
      row(`xipos_${position}_${k}`, ofPos.map(q => [1, v('l', q.id, k)]), position === 'GKP' ? '=' : '>=', p.xiMin[position]);
    }
    for (const teamId of new Set(p.players.map(q => q.teamId))) {
      row(`club_${teamId}_${k}`, p.players.filter(q => q.teamId === teamId).map(q => [1, v('s', q.id, k)]), '<=', p.maxPerClub);
    }
    row(`xi_${k}`, p.players.map(q => [1, v('l', q.id, k)]), '=', xiSize);
    row(`captain_${k}`, p.players.map(q => [1, v('c', q.id, k)]), '=', 1);
    for (const b of slots) {
      row(`slot_${b}_${k}`, p.players.filter(q => slotsOf(q).includes(b)).map(q => [1, v(b, q.id, k)]), '=', 1);
    }

    // Money: the bank after this week's sales and buys, never below zero.
    const money = p.players.flatMap(q => [[-(q.owned ? q.sellTenths : q.priceTenths), v('o', q.id, k)], [q.priceTenths, v('i', q.id, k)]]);
    if (k === 0) row(`bank_${k}`, [[1, `bank_${k}`], ...money], '=', p.bankTenths);
    else row(`bank_${k}`, [[1, `bank_${k}`], [-1, `bank_${k - 1}`], ...money], '=', 0);
    bounds.push(`bank_${k} >= 0`);

    // Free transfers, exactly as FPL counts them. T is the week's buys, ft its free transfers (p.ft in week 0), u those
    // left unused and all says every one was used: u = max(0, ft - T), so the hits are h = T - ft + u, and next
    // week's free transfers are u + 1, to the cap. A hit buys nothing, so no weighting of the weeks can make one pay
    // for a free transfer. ft_k need have no lower row: more free transfers never cost the objective.
    const buys = p.players.map(q => [1, v('i', q.id, k)]);
    const ftTerm = k === 0 ? [] : [[1, `ft_${k}`]];
    const ftConst = k === 0 ? p.ft : 0;
    const [unused, all] = [`u_${k}`, `all_${k}`];
    row(`unused_${k}`, [[1, unused], ...ftTerm.map(([c, x]) => [-c, x]), ...buys], '>=', ftConst);
    row(`usedall_${k}`, [[1, unused], ...ftTerm.map(([c, x]) => [-c, x]), ...buys, [-SQUAD_TOTAL, all]], '<=', ftConst);
    row(`unusedcap_${k}`, [[1, unused], [SQUAD_TOTAL, all]], '<=', SQUAD_TOTAL);
    row(`hits_${k}`, [[1, `h_${k}`], ...buys.map(([c, x]) => [-c, x]), ...ftTerm, [-1, unused]], '=', -ftConst);
    binaries.push(all);
    generals.push(`h_${k}`, unused);
    bounds.push(`h_${k} >= 0`, `${unused} >= 0`);
    // MODEL: flatHits prices a hit as the engine does (transferCost): hitCost plus the margin, whatever the week weighs.
    objective.push([-(p.flatHits ? 1 : w) * (p.hitCost + (p.hitMargin ?? 0)), `h_${k}`]);
    // A Free Hit week has no transfers whatever its weight, so a week that weighs nothing cannot make hits or moves free.
    if (frozen) row(`frozen_${k}`, [[1, `h_${k}`], ...p.players.flatMap(q => [[1, v('i', q.id, k)], [1, v('o', q.id, k)]])], '=', 0);
    // ft_{k+1} is the next week's count; after the last week it is the count the horizon hands on, which only the
    // end-of-horizon value reads. A Free Hit week neither spends nor adds (the ledger's rule): the count passes through.
    if (k + 1 < weeks.length || p.endFtValue) {
      const next = `ft_${k + 1}`;
      if (frozen) row(`carry_${k}`, [[1, next], ...ftTerm.map(([c, x]) => [-c, x])], '=', ftConst);
      else row(`carry_${k}`, [[1, next], [-1, unused]], '<=', 1);
      generals.push(next);
      bounds.push(`1 <= ${next} <= ${p.maxBankedFt}`);
    }

    // Chips, each at most once: Bench Boost scores the bench in full, Triple Captain the armband again. Each
    // chip's points ride on a product of two binaries, bound from both sides so that any plan, one stopped
    // early included, counts them.
    if (p.chips?.benchboost) {
      binaries.push(`bb_${k}`);
      for (const q of p.players) {
        for (const b of slotsOf(q)) {
          const x = v(`x${b}`, q.id, k);
          row(`bbs_${b}_${q.id}_${k}`, [[1, x], [-1, v(b, q.id, k)]], '<=', 0);
          row(`bbw_${b}_${q.id}_${k}`, [[1, x], [-1, `bb_${k}`]], '<=', 0);
          row(`bbl_${b}_${q.id}_${k}`, [[1, x], [-1, v(b, q.id, k)], [-1, `bb_${k}`]], '>=', -1);
          bounds.push(`0 <= ${x} <= 1`);
          objective.push([w * q.xpts[k] * (1 - slotWeight[b]), x]);
        }
      }
    }
    // One chip a gameweek.
    if (p.chips?.benchboost && p.chips?.triplecaptain) row(`chip_${k}`, [[1, `bb_${k}`], [1, `tc_${k}`]], '<=', 1);
    if (p.chips?.triplecaptain) {
      binaries.push(`tc_${k}`);
      for (const q of p.players) {
        const y = v('y', q.id, k);
        row(`tcc_${q.id}_${k}`, [[1, y], [-1, v('c', q.id, k)]], '<=', 0);
        row(`tcw_${q.id}_${k}`, [[1, y], [-1, `tc_${k}`]], '<=', 0);
        row(`tcl_${q.id}_${k}`, [[1, y], [-1, v('c', q.id, k)], [-1, `tc_${k}`]], '>=', -1);
        bounds.push(`0 <= ${y} <= 1`);
        objective.push([w * q.xpts[k], y]);
      }
    }
  }
  if (p.chips?.benchboost) row('bb_once', weeks.map(k => [1, `bb_${k}`]), '<=', 1);
  if (p.chips?.triplecaptain) row('tc_once', weeks.map(k => [1, `tc_${k}`]), '<=', 1);

  // The horizon's end. MODEL: each free transfer banked past the first is worth the schedule's value for its place, and
  // the values fall, so the plan fills the places in order with continuous ev_j (no binaries): sum ev_j = ft_H - 1, where
  // ft_H is the count handed on. The bank's tenths are worth a flat rate.
  if (p.endFtValue) {
    const places = Object.keys(p.endFtValue);
    row('endft', [...places.map(j => [1, `ev_${j}`]), [-1, `ft_${weeks.length}`]], '=', -1);
    for (const j of places) {
      bounds.push(`0 <= ev_${j} <= 1`);
      objective.push([p.endFtValue[j], `ev_${j}`]);
    }
  }
  if (p.bankPerTenth) objective.push([p.bankPerTenth, `bank_${weeks.length - 1}`]);

  // First-week terms and holds, on the players the model knows.
  const [kept, dead] = [new Set(p.keep), new Set(p.deadSlot?.ids)];
  for (const q of p.players) {
    if (kept.has(q.id)) row(`keep_${q.id}`, [[1, v('o', q.id, 0)]], '=', 0);
    if (dead.has(q.id)) objective.push([-p.deadSlot.penalty, v('s', q.id, 0)]);
    if (p.salePoints?.[q.id]) objective.push([p.salePoints[q.id], v('o', q.id, 0)]);
  }
  // No-good cuts: the left side reaches |I| + |O| only at the first week of exactly these buys and sales, so each
  // listed week is infeasible and every other is not. The empty set (rolling) is the one with no moves at all.
  (p.exclude ?? []).forEach(({ in: ins, out: outs }, n) => {
    const [bought, sold] = [new Set(ins), new Set(outs)];
    row(`nogood_${n}`, p.players.flatMap(q => [[bought.has(q.id) ? 1 : -1, v('i', q.id, 0)], [sold.has(q.id) ? 1 : -1, v('o', q.id, 0)]]),
      '<=', bought.size + sold.size - 1);
  });

  // Fixed parts, so another plan is priced against the free one: the first week's moves, a chip's week (null: unused).
  const fixed = p.fixed ?? {};
  if (fixed.first) {
    for (const q of p.players) {
      row(`fixi_${q.id}`, [[1, v('i', q.id, 0)]], '=', fixed.first.in.includes(q.id) ? 1 : 0);
      row(`fixo_${q.id}`, [[1, v('o', q.id, 0)]], '=', fixed.first.out.includes(q.id) ? 1 : 0);
    }
  }
  for (const [chip, name] of [['benchboost', 'bb'], ['triplecaptain', 'tc']]) {
    if (!p.chips?.[chip] || !(chip in fixed)) continue;
    for (const k of weeks) row(`fix${name}_${k}`, [[1, `${name}_${k}`]], '=', p.gws[k] === fixed[chip] ? 1 : 0);
  }

  const lp = ['Maximize', ` obj: ${terms(objective, p.lineTerms)}`, 'Subject To',
    ...rows.map(r => ` ${r.name}: ${terms(r.terms, p.lineTerms)} ${r.sense} ${r.rhs}`),
    'Bounds', ...bounds.map(b => ` ${b}`),
    'Binaries', ...lines(binaries, p.lineTerms), 'Generals', ...lines(generals, p.lineTerms), 'End'].join('\n');

  // ft_k only bounds the hits (the solver may leave it low when nothing rides on it), so the plan's own counts
  // are read off its moves by FPL's rule (a Free Hit week passes the count through).
  const decode = result => {
    const value = name => Math.round(result.Columns[name]?.Primal ?? 0);
    const on = (kind, k) => p.players.filter(q => value(v(kind, q.id, k)) === 1).map(q => q.id);
    const fts = [p.ft];
    for (const k of weeks.slice(1)) {
      fts.push(isFrozen(k - 1) ? fts[k - 1] : Math.min(p.maxBankedFt, Math.max(0, fts[k - 1] - on('i', k - 1).length) + 1));
    }
    return {
      objective: result.ObjectiveValue,
      weeks: weeks.map(k => ({
        gw: p.gws[k],
        in: on('i', k),
        out: on('o', k),
        hits: value(`h_${k}`) * p.hitCost,
        ft: fts[k],
        xi: on('l', k),
        captain: on('c', k)[0] ?? null,
        bench: [...['b1', 'b2', 'b3'].map(b => on(b, k)[0]), on('g', k)[0]].filter(id => id !== undefined),
        benchBoost: value(`bb_${k}`) === 1,
        tripleCaptain: value(`tc_${k}`) === 1,
      })),
    };
  };
  return { lp, decode };
}

function terms(list, lineTerms) {
  const parts = list.filter(([c]) => c !== 0).map(([c, x], j) => `${c < 0 ? '-' : (j === 0 ? '' : '+')} ${Math.abs(c)} ${x}`);
  if (!parts.length) return '0 dummy';
  const chunks = [];
  for (let j = 0; j < parts.length; j += lineTerms) chunks.push(parts.slice(j, j + lineTerms).join(' '));
  return chunks.join('\n   ');
}

function lines(names, lineTerms) {
  const out = [];
  for (let j = 0; j < names.length; j += lineTerms) out.push(` ${names.slice(j, j + lineTerms).join(' ')}`);
  return out;
}
