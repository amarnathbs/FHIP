// Investment Intelligence R12 — price freshness / staleness (spec sections
// 38-39). Pure function, no I/O. A manually-entered valuation is a
// point-in-time fact ("as of this date, the position was worth this much")
// — it is never silently presented as today's live price once time has
// passed. This module is the single place that decision is made, so a
// future UI/report surface calls ONE function rather than re-deriving the
// threshold ad hoc.
//
// THRESHOLD: 5 calendar days for a listed security (equity/equity-oriented
// ETF prices move daily; a value more than a trading week old is stale
// enough that presenting it as "current" would mislead). Mutual fund NAVs
// (T+1 disclosure norm) are NOT governed by this module — R12 does not
// change existing mutual-fund valuation behaviour.
export const LISTED_SECURITY_STALE_THRESHOLD_DAYS = 5;

export type PriceFreshnessStatus = 'CURRENT' | 'STALE';

export interface PriceFreshnessResult {
  status: PriceFreshnessStatus;
  ageDays: number;
  asOfDate: string;
  thresholdDays: number;
}

function daysBetween(a: string, b: string): number {
  const toUtc = (iso: string) => Date.parse(`${iso}T00:00:00.000Z`);
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}

/**
 * @param asOfDate the valuation's own as-of date (ii_holding_snapshots.as_of_date)
 * @param todayIsoDate the caller's "now", injected rather than read from
 *   Date.now() internally, so this stays a pure, deterministically testable
 *   function (matches this codebase's convention elsewhere, e.g. R5's
 *   asOfDate handling).
 */
export function resolvePriceFreshness(asOfDate: string, todayIsoDate: string, thresholdDays: number = LISTED_SECURITY_STALE_THRESHOLD_DAYS): PriceFreshnessResult {
  const ageDays = Math.max(0, daysBetween(asOfDate, todayIsoDate));
  return {
    status: ageDays > thresholdDays ? 'STALE' : 'CURRENT',
    ageDays,
    asOfDate,
    thresholdDays,
  };
}

/**
 * Never fabricate a market value. If a valuation is STALE, the caller must
 * render "Stale valuation — last updated {asOfDate}" rather than the raw
 * number as if it were today's price. This function does not format
 * anything (no UI concerns here) — it returns the decision, not the string.
 */
export function shouldPresentAsCurrentValue(freshness: PriceFreshnessResult): boolean {
  return freshness.status === 'CURRENT';
}
