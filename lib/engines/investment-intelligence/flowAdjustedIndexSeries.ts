// Flow-adjusted index series -- INTERNAL building block for the portfolio risk
// cards. It is NOT a user-facing return metric: the investor sees XIRR only.
//
// WHY. A portfolio's money value moves for two very different reasons: the
// holdings gained or lost value, and the investor put money in or took money
// out. Risk cards (maximum drawdown, drawdown series, volatility, beta, tracking
// error, Calmar, rolling-return windows, "beat benchmark" share, the
// growth-of-100 line) describe how the HOLDINGS behaved, so they must be derived
// from a series in which a deposit never looks like a gain and a redemption never
// looks like a loss. Run on the raw value series, a full redemption showed as a
// -79% "drawdown" and a deposit as a jump up.
//
// METHOD (a flow-adjusted index, base 100 at the first observation). For each
// consecutive pair of observations (a, b]:
//     C      = net money contributed to the portfolio in (a, b]
//     base   = V(a) + sum over flows of  w * flow,   w = (b - flowDate) / (b - a)
//     r      = (V(b) - V(a) - C) / base
//     index(b) = index(a) * (1 + r)
// A flow ON the observation date has weight 0 (end-of-day), a flow just after
// `a` has weight ~1, so flows on non-observation dates are handled and several
// flows on one day simply add.
//
// EDGE RULES (each has a named test):
//   * base <= a small fraction of the largest value seen so far (a fully
//     redeemed portfolio, a zero-value gap, a residual of a few paise): the
//     period has no meaningful base, so r = 0 -- the index stays at its last
//     level instead of dividing by zero or amplifying rounding noise. After a
//     redeem-then-rebuy the index therefore continues from its last pre-exit
//     level.
//   * a non-finite r is treated as 0; r is never allowed to reach -100%.
//   * flows dated on or before the first observation, or after the last, move
//     nothing (no period brackets them).
//
// A scheme's own value ENTERING the portfolio (its first valuation point) is
// treated as a contribution on that date, and its flows dated on or before that
// point are ignored, so a holding that simply starts being valued mid-history is
// not read as a gain. Schemes with no valuation series at all (units but no NAV)
// contribute neither value nor flows, consistently with the value series.

import type { SeriesPoint } from './benchmarkService';

export interface IndexFlow {
  date: Date;
  /** Money INTO the portfolio (a purchase) is positive; money OUT (a redemption) is negative. */
  contribution: number;
}

/** Smallest base, as a fraction of the largest value seen so far, on which a period return is still computed. */
export const MIN_BASE_FRACTION = 1e-4;
const MIN_BASE_ABSOLUTE = 1e-9;
const MIN_PERIOD_RETURN = -0.9999;

export const FLOW_ADJUSTED_INDEX_METHOD_VERSION = 'flow-adjusted-index-v1';

export function buildFlowAdjustedIndex(values: ReadonlyArray<SeriesPoint>, flows: ReadonlyArray<IndexFlow>): SeriesPoint[] {
  const obs = [...values].sort((x, y) => x.date.getTime() - y.date.getTime());
  if (obs.length === 0) return [];
  const sortedFlows = [...flows].sort((x, y) => x.date.getTime() - y.date.getTime());

  const out: SeriesPoint[] = [{ date: obs[0].date, value: 100 }];
  let level = 100;
  let largest = Math.max(0, obs[0].value);
  let fi = 0;
  // skip flows on or before the first observation
  while (fi < sortedFlows.length && sortedFlows[fi].date.getTime() <= obs[0].date.getTime()) fi++;

  for (let i = 1; i < obs.length; i++) {
    const a = obs[i - 1];
    const b = obs[i];
    const span = b.date.getTime() - a.date.getTime();
    let contributed = 0;
    let weighted = 0;
    while (fi < sortedFlows.length && sortedFlows[fi].date.getTime() <= b.date.getTime()) {
      const f = sortedFlows[fi];
      contributed += f.contribution;
      const w = span > 0 ? (b.date.getTime() - f.date.getTime()) / span : 0;
      weighted += w * f.contribution;
      fi++;
    }
    largest = Math.max(largest, a.value, b.value);
    const base = a.value + weighted;
    let r = 0;
    if (base > Math.max(MIN_BASE_ABSOLUTE, MIN_BASE_FRACTION * largest)) {
      r = (b.value - a.value - contributed) / base;
      if (!Number.isFinite(r)) r = 0;
      if (r < MIN_PERIOD_RETURN) r = MIN_PERIOD_RETURN;
    }
    level *= 1 + r;
    out.push({ date: b.date, value: level });
  }
  return out;
}

export interface SchemeFlowInput {
  /** The scheme's own valuation series (already closed on a zero if it was redeemed in full). */
  series: ReadonlyArray<SeriesPoint>;
  /** The scheme's REAL external flows, investor perspective: purchase negative, redemption positive. No terminal valuation flow, no switches. */
  realFlows: ReadonlyArray<{ date: Date; amount: number }>;
}

/**
 * The money contributed to / withdrawn from the portfolio, in the shape
 * buildFlowAdjustedIndex needs. Flows from several schemes landing on the same
 * date are added together.
 */
export function portfolioContributionFlows(schemes: ReadonlyArray<SchemeFlowInput>): IndexFlow[] {
  const byDate = new Map<number, number>();
  const add = (date: Date, amount: number) => {
    if (amount === 0 || !Number.isFinite(amount)) return;
    byDate.set(date.getTime(), (byDate.get(date.getTime()) ?? 0) + amount);
  };
  for (const s of schemes) {
    if (s.series.length === 0) continue; // no valuation series: contributes neither value nor flows
    const first = [...s.series].sort((x, y) => x.date.getTime() - y.date.getTime())[0];
    if (first.value > 0) add(first.date, first.value); // the value entering the portfolio is a contribution, not a gain
    for (const f of s.realFlows) {
      if (f.date.getTime() > first.date.getTime()) add(f.date, -f.amount);
    }
  }
  return [...byDate.entries()].sort((x, y) => x[0] - y[0]).map(([t, contribution]) => ({ date: new Date(t), contribution }));
}
