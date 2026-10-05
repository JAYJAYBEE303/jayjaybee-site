/**
 * js/modules/planner-run.js
 * Layer: module (pure). The Transfer Planner's staged "run": moves and chips
 * queued into the next six gameweeks, checked against FPL's transfer rules.
 * No DOM, no store, no engine calls — planner.js passes everything in.
 *
 * This is rules arithmetic, not analysis. Every number a move carries (its
 * price difference, its projected gain) is an engine output that planner.js
 * snapshotted from engine/transfers.js's enumerateSwaps when the move was
 * added; this file only adds them up week by week and says which plans FPL
 * would refuse.
 *
 * Model, per week:
 *   - Free transfers roll over: one new each week, carried up to RUN_FT_CAP.
 *   - A Wildcard or Free Hit week has unlimited transfers and neither spends
 *     nor accrues free transfers.
 *   - Each move past the free count costs HIT_PENALTY points — allowed only
 *     when the reader has turned hits on.
 *   - The bank carries forward; a move's price difference comes out of it.
 *   - One chip per gameweek.
 * And across the whole run: a player can't be sold or bought twice, sold if
 * he isn't in the squad, and no club may end up with more than three.
 */

import { HIT_PENALTY } from '../config.js';

/** FPL's cap on banked free transfers. */
export const RUN_FT_CAP = 5;

/** How many gameweeks the run covers, starting at the planning gameweek. */
export const RUN_WEEKS = 6;

/** Most players any one club may have in a squad. */
const CLUB_LIMIT = 3;

/**
 * @typedef {{ id: string, outId: number, inId: number, gw: number,
 *             priceDiff: number, gain: number }} RunMove
 *   priceDiff: £m, in-price minus out-price (positive costs money)
 *   gain:      projected XI points over the long window (lanes.longterm)
 */

/**
 * @param {RunMove[]} moves
 * @param {Object<string, number|null>} chipsAt  chip id → gameweek (null = not in the run)
 * @param {{ gws: number[], ft: number, hit: boolean, bank: number,
 *           squad: number[], teamOf: (id:number) => number|null,
 *           nameOf: (id:number) => string, teamName: (teamId:number) => string }} o
 * @returns {{ weeks: object[], issues: object[], badMoves: Set<string>,
 *             errors: number, valid: boolean, gain: number, hitCost: number, net: number }}
 */
export function evaluateRun(moves, chipsAt, o) {
  const issues = [];
  const badMoves = new Set();
  const outs = new Map();
  const ins = new Set();

  for (const m of moves) {
    if (outs.has(m.outId)) {
      badMoves.add(m.id);
      badMoves.add(outs.get(m.outId));
      issues.push({ lvl: 'error', text: `${o.nameOf(m.outId)} is sold twice. Keep one of the two moves.` });
    } else {
      outs.set(m.outId, m.id);
    }
    if (ins.has(m.inId)) {
      badMoves.add(m.id);
      issues.push({ lvl: 'error', text: `${o.nameOf(m.inId)} is bought twice.` });
    } else {
      ins.add(m.inId);
    }
    if (!o.squad.includes(m.outId)) {
      badMoves.add(m.id);
      issues.push({ lvl: 'error', text: `${o.nameOf(m.outId)} isn’t in your squad any more.` });
    }
  }

  // The squad as it stands once every move has gone through.
  const after = o.squad.filter(id => !outs.has(id)).concat([...ins]);
  const clubs = new Map();
  for (const id of after) {
    const t = o.teamOf(id);
    if (t != null) clubs.set(t, (clubs.get(t) ?? 0) + 1);
  }
  for (const [team, n] of clubs) {
    if (n <= CLUB_LIMIT) continue;
    for (const m of moves) if (o.teamOf(m.inId) === team) badMoves.add(m.id);
    issues.push({ lvl: 'error', text: `${n} ${o.teamName(team)} players — the limit is ${CLUB_LIMIT}.` });
  }

  const chipsByGw = new Map();
  for (const [chip, gw] of Object.entries(chipsAt)) {
    if (gw == null) continue;
    chipsByGw.set(gw, [...(chipsByGw.get(gw) ?? []), chip]);
  }

  let avail = o.ft;
  let cash = o.bank;
  let gain = 0;
  let hitCost = 0;
  const weeks = o.gws.map(gw => {
    const ms = moves.filter(m => m.gw === gw);
    const chips = chipsByGw.get(gw) ?? [];
    const unlimited = chips.includes('wildcard') || chips.includes('freehit');
    const used = ms.length;
    const hits = unlimited ? 0 : Math.max(0, used - avail);
    cash = Math.round((cash - ms.reduce((a, m) => a + m.priceDiff, 0)) * 10) / 10;
    const weekGain = ms.reduce((a, m) => a + m.gain, 0);
    const w = { gw, moves: ms, chips, ftAvail: avail, used, unlimited, hits, hitCost: hits * HIT_PENALTY,
                bank: cash, gain: weekGain, problems: [] };

    if (chips.length > 1) w.problems.push(`Two chips in GW${gw} — only one chip per gameweek.`);
    if (cash < 0) w.problems.push(`£${Math.abs(cash).toFixed(1)}m over budget by GW${gw}.`);
    if (hits && !o.hit) w.problems.push(`${used} moves with ${avail} free — allow hits or move one to a later week.`);
    if (hits && o.hit) issues.push({ lvl: 'warn', text: `−${hits * HIT_PENALTY} in hits in GW${gw}.`, gw });

    gain += weekGain;
    hitCost += hits * HIT_PENALTY;
    if (!unlimited) avail = Math.min(RUN_FT_CAP, Math.max(0, avail - used) + 1);
    return w;
  });

  const weekErrors = weeks.reduce((a, w) => a + w.problems.length, 0);
  const errors = issues.filter(x => x.lvl === 'error').length + weekErrors;
  return {
    weeks, issues, badMoves, errors, valid: errors === 0,
    gain, hitCost, net: gain - (o.hit ? hitCost : 0),
  };
}
