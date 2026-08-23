// R4 — Versioned risk-free-rate reference data (spec section 37). NEVER a
// hard-coded "6%" scattered through the app. Backed by ii_risk_free_rates
// (migration 0043). This module is the ONLY place risk-free rates are
// looked up; RiskMetricsEngine callers always go through here.
//
// If the required country/date-period rate is not present in reference
// data, the affected metric (Sharpe, regression alpha, Sortino target
// when target=risk-free) is suppressed via 'unavailable' — this module
// never fabricates or defaults a rate.

export const RISK_FREE_RATE_METHOD_VERSION = 'risk-free-rate-lookup-v1';

export interface RiskFreeRatePoint {
  countryCode: string; // 'IN' | 'AU'
  periodStart: Date;
  periodEnd: Date;
  annualisedRate: number; // e.g. 0.071 = 7.1%
  source: string; // e.g. 'RBI 91-day T-Bill', 'RBA cash rate'
  method: string; // e.g. 'period_average', 'period_end'
  version: string;
}

export interface RiskFreeLookupResult {
  status: 'ok' | 'unavailable';
  rate?: number;
  point?: RiskFreeRatePoint;
  reason?: 'RISK_FREE_DATA_MISSING';
}

/**
 * Look up the risk-free rate applicable to a country and a specific date
 * (typically the analysis period's mid-point or end-date, per the
 * calling engine's documented convention). Pure function over a supplied
 * reference-data array so it is trivially testable and so the API layer
 * controls exactly which rows are fetched (world-readable, admin-write —
 * see migration 0043).
 */
export function lookupRiskFreeRate(series: RiskFreeRatePoint[], countryCode: string, date: Date): RiskFreeLookupResult {
  const point = series.find(
    (p) => p.countryCode === countryCode && p.periodStart.getTime() <= date.getTime() && p.periodEnd.getTime() >= date.getTime()
  );
  if (!point) {
    return { status: 'unavailable', reason: 'RISK_FREE_DATA_MISSING' };
  }
  return { status: 'ok', rate: point.annualisedRate, point };
}
