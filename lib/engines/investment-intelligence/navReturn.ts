// R4 — NAV-based (manager/scheme) return calculations: point-to-point
// return, CAGR, calendar-year returns. These answer "how did the scheme
// perform, independent of investor timing" (spec section 6) and must
// NEVER be confused with investor XIRR.
//
// Years convention (spec section 18): actual calendar days between the two
// valuation dates, divided by 365 ("actual/365"). Documented once here and
// used consistently in production AND in the independent oracle / manual
// reconciliation fixtures — never a different convention in different
// places.

import { NON_ANNUALISED_HORIZON_DAYS } from '@/lib/config/investment-intelligence/minimumHistory';

export const NAV_RETURN_METHOD_VERSION = 'nav-return-actual365-v1';
export const YEARS_CONVENTION = 'actual_days_over_365' as const;

export interface PointToPointReturnResult {
  status: 'ok' | 'unavailable';
  /** Non-annualised point-to-point % change, e.g. 0.083 = 8.3%. */
  pointToPointReturn?: number;
  /** Present only when the period exceeds NON_ANNUALISED_HORIZON_DAYS (spec section 24). */
  cagr?: number;
  actualDays?: number;
  years?: number;
  reason?: 'INVALID_INPUT' | 'ZERO_OR_NEGATIVE_BEGINNING_VALUE' | 'INVALID_DATE_ORDER';
  detail?: string;
}

function daysBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 86_400_000;
}

/**
 * Point-to-point NAV-based return between two certified valuations.
 * beginningValue/endingValue must be same-currency, same-plan-option NAV
 * (or portfolio value) observations — caller is responsible for that
 * eligibility check (plan/option mismatch is a separate DQ gate).
 */
export function pointToPointReturn(
  beginningValue: number,
  beginningDate: Date,
  endingValue: number,
  endingDate: Date
): PointToPointReturnResult {
  if (!Number.isFinite(beginningValue) || !Number.isFinite(endingValue)) {
    return { status: 'unavailable', reason: 'INVALID_INPUT', detail: 'Non-finite valuation supplied.' };
  }
  if (beginningValue <= 0) {
    return { status: 'unavailable', reason: 'ZERO_OR_NEGATIVE_BEGINNING_VALUE' };
  }
  if (!(beginningDate instanceof Date) || !(endingDate instanceof Date) ||
      Number.isNaN(beginningDate.getTime()) || Number.isNaN(endingDate.getTime())) {
    return { status: 'unavailable', reason: 'INVALID_INPUT', detail: 'Invalid date supplied.' };
  }
  const actualDays = daysBetween(beginningDate, endingDate);
  if (actualDays <= 0) {
    return { status: 'unavailable', reason: 'INVALID_DATE_ORDER' };
  }
  const years = actualDays / 365;
  const pointToPointReturnValue = endingValue / beginningValue - 1;
  const result: PointToPointReturnResult = {
    status: 'ok',
    pointToPointReturn: pointToPointReturnValue,
    actualDays,
    years,
  };
  if (actualDays > NON_ANNUALISED_HORIZON_DAYS) {
    result.cagr = Math.pow(endingValue / beginningValue, 1 / years) - 1;
  }
  return result;
}

/**
 * CAGR = (Ending/Beginning)^(1/years) - 1 for a valid point-to-point period
 * ONLY. Never used for irregular external cash flows (that's XIRR's job —
 * see xirr.ts) and never substituted for a failed XIRR (spec section 18).
 */
export function cagr(
  beginningValue: number,
  beginningDate: Date,
  endingValue: number,
  endingDate: Date
): PointToPointReturnResult {
  const p2p = pointToPointReturn(beginningValue, beginningDate, endingValue, endingDate);
  if (p2p.status !== 'ok') return p2p;
  // Boundary MUST match pointToPointReturn's own NON_ANNUALISED_HORIZON_DAYS
  // convention exactly (actualDays > 365, i.e. a period of exactly 365 days
  // is still shown non-annualised) — using a different boundary here would
  // be exactly the "different convention in different places" defect the
  // spec (section 18) warns against. p2p.cagr is already populated
  // correctly by pointToPointReturn for actualDays > 365; nothing further
  // to compute at or below that boundary.
  return p2p;
}

export interface CalendarYearReturn {
  year: number;
  status: 'ok' | 'unavailable';
  return?: number;
  reason?: 'INCOMPLETE_CALENDAR_YEAR' | 'NO_VALUATION_AT_YEAR_START' | 'NO_VALUATION_AT_YEAR_END';
}

/**
 * Calendar-year returns for genuinely complete calendar years only (spec
 * section 24) — never label a partial year as a full calendar-year return.
 * `series` must be sorted ascending by date and represent NAV/valuation
 * observations. A year is "complete" when a valuation exists on or before
 * Jan 1 of that year (or the year's own inception if the fund launched
 * that year — NOT treated as complete here, by design: launch-year partial
 * data is excluded) and on or after Dec 31.
 */
export function calendarYearReturns(
  series: Array<{ date: Date; value: number }>,
  years: number[]
): CalendarYearReturn[] {
  const sorted = [...series].sort((a, b) => a.date.getTime() - b.date.getTime());
  return years.map((year) => {
    const yearStart = new Date(Date.UTC(year - 1, 11, 31)); // last obs on/before this counts as opening
    const yearEnd = new Date(Date.UTC(year, 11, 31));
    const firstOfYearOrBefore = [...sorted].reverse().find((s) => s.date.getTime() <= yearStart.getTime());
    const lastOfYear = [...sorted].reverse().find((s) => s.date.getTime() <= yearEnd.getTime() && s.date.getUTCFullYear() <= year);
    if (!firstOfYearOrBefore) {
      return { year, status: 'unavailable', reason: 'NO_VALUATION_AT_YEAR_START' };
    }
    if (!lastOfYear || lastOfYear.date.getUTCFullYear() !== year) {
      return { year, status: 'unavailable', reason: 'NO_VALUATION_AT_YEAR_END' };
    }
    // Confirm there is at least one observation dated within the year itself
    // (guards against a fund with no trading data at all in that year).
    const hasObsInYear = sorted.some((s) => s.date.getUTCFullYear() === year);
    if (!hasObsInYear) {
      return { year, status: 'unavailable', reason: 'INCOMPLETE_CALENDAR_YEAR' };
    }
    const ret = lastOfYear.value / firstOfYearOrBefore.value - 1;
    return { year, status: 'ok', return: ret };
  });
}
