/**
 * tools/milp/model.js
 * The MILP referee's model (docs/decision-engine-plan.md, Phase 8): the best
 * multi-week transfer plan on the engine's own projections, under FPL's
 * rules, as a mixed-integer program in CPLEX LP format for HiGHS
 * (npm "highs", MIT). Pure: builds the model's text and reads a solution.
 *
 * Over the weeks of the horizon it chooses, each week, who is bought and
 * sold, the squad (2/5/5/3, three a club), the XI (a legal formation), the
 * captain and the bench order, maximising the weighted expected points of
 * the XI and captain plus the bench at fixed slot weights (the engine's
 * linear autosub weights: a MILP cannot hold the probability version), less
 * 4 a hit, each at its week's weight. Money is integer tenths: a sale fetches his sell price if he is
 * owned now, his price if bought within the horizon (prices do not move in
 * it); the bank never goes below zero. Free transfers bank one a week to the
 * cap; transfers past them are hits. Optionally it also places Bench Boost
 * and Triple Captain, once each and never in the same gameweek. A player sold
 * and bought back within the horizon sells again at his old sell price (a
 * cautious error, and rare: it costs two transfers).
 *
 * The formulation follows the shape of open-fpl-solver (Sertalp B. Cay,
 * Apache-2.0, github.com/solioanalytics/open-fpl-solver); no code is taken
 * from it.
 */

const LINE_TERMS = 8;   // terms per line of the model's text, which stays readable

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
 * @param {{benchboost?: boolean, triplecaptain?: boolean}} [p.chips]  place these once each
 * @param {{first?: {in: number[], out: number[]}, benchboost?: number|null, triplecaptain?: number|null}} [p.fixed]
 *   the first week's moves, or a chip's gameweek (null: not played), held fixed
 * @returns {{lp: string, decode: (result: object) => object}}
 */
export function buildPlan(p) {
  // With a later week weighted above an earlier one, a hit (charged at its week's weight) could buy next week's
  // free transfer: the carry row bounds free transfers by the hits taken, not by the transfers left.
  if (p.weights.some((w, k) => k > 0 && w > p.weights[k - 1])) throw new Error('buildPlan: weights must not rise week to week');
  const weeks = p.gws.map((gw, k) => k);
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

    // Free transfers: a hit for each transfer past them; next week's are those left plus one, to the cap.
    const buys = p.players.map(q => [1, v('i', q.id, k)]);
    const ftTerm = k === 0 ? [] : [[1, `ft_${k}`]];
    const ftConst = k === 0 ? p.ft : 0;
    row(`hits_${k}`, [[1, `h_${k}`], ...buys.map(([c, x]) => [-c, x]), ...ftTerm], '>=', -ftConst);
    generals.push(`h_${k}`);
    bounds.push(`h_${k} >= 0`);
    objective.push([-w * p.hitCost, `h_${k}`]);
    if (k + 1 < weeks.length) {
      row(`carry_${k}`, [[1, `ft_${k + 1}`], ...ftTerm.map(([c, x]) => [-c, x]), ...buys, [-1, `h_${k}`]], '<=', 1 + ftConst);
      generals.push(`ft_${k + 1}`);
      bounds.push(`1 <= ft_${k + 1} <= ${p.maxBankedFt}`);
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

  const lp = ['Maximize', ` obj: ${terms(objective)}`, 'Subject To',
    ...rows.map(r => ` ${r.name}: ${terms(r.terms)} ${r.sense} ${r.rhs}`),
    'Bounds', ...bounds.map(b => ` ${b}`),
    'Binaries', ...lines(binaries), 'Generals', ...lines(generals), 'End'].join('\n');

  // ft_k only bounds the hits (the solver may leave it low when nothing rides on it), so the plan's own counts
  // are read off its moves by FPL's rule.
  const decode = result => {
    const value = name => Math.round(result.Columns[name]?.Primal ?? 0);
    const on = (kind, k) => p.players.filter(q => value(v(kind, q.id, k)) === 1).map(q => q.id);
    const fts = [p.ft];
    for (const k of weeks.slice(1)) fts.push(Math.min(p.maxBankedFt, Math.max(0, fts[k - 1] - on('i', k - 1).length) + 1));
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

function terms(list) {
  const parts = list.filter(([c]) => c !== 0).map(([c, x], j) => `${c < 0 ? '-' : (j === 0 ? '' : '+')} ${Math.abs(c)} ${x}`);
  if (!parts.length) return '0 dummy';
  const chunks = [];
  for (let j = 0; j < parts.length; j += LINE_TERMS) chunks.push(parts.slice(j, j + LINE_TERMS).join(' '));
  return chunks.join('\n   ');
}

function lines(names) {
  const out = [];
  for (let j = 0; j < names.length; j += LINE_TERMS) out.push(` ${names.slice(j, j + LINE_TERMS).join(' ')}`);
  return out;
}
