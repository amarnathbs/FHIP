// Investment Intelligence R6-P1 — holding-period computation.
//
// LEGAL RULE (researched, not assumed): the Income-tax Act's period of
// holding runs from the date of acquisition up to the day IMMEDIATELY
// PRECEDING the date of transfer — i.e. both the acquisition date's "own day"
// and the transfer date itself are excluded from the count
// (incometaxindia.gov.in capital-gains FAQ; CBDT guidance). The universally
// applied practitioner consequence: an asset acquired on D becomes long-term
// only if transferred STRICTLY AFTER the calendar-month anniversary of D —
// selling exactly ON the 12-month anniversary is still short-term (one day
// short). This is the classic off-by-one boundary the spec calls out.
//
// Worked example: acquired 1 April 2022 → 12-month anniversary is
// 1 April 2023. Sold 1 April 2023 = STCG (not "more than 12 months").
// Sold 2 April 2023 = LTCG.
//
// All dates are handled as UTC-normalised calendar dates (YYYY-MM-DD strings
// in, no wall-clock/timezone involvement) to avoid a different class of
// off-by-one bug from local-timezone date parsing.

export type IsoDate = string; // 'YYYY-MM-DD'

function parseIsoDate(iso: IsoDate): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) throw new Error(`holdingPeriod: invalid ISO date "${iso}"`);
  return { y, m, d };
}

function toUtcMillis(iso: IsoDate): number {
  const { y, m, d } = parseIsoDate(iso);
  return Date.UTC(y, m - 1, d);
}

function daysInMonth(year: number, monthIndex0: number): number {
  // monthIndex0: 0=Jan..11=Dec. Day 0 of next month = last day of this month.
  return new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
}

/**
 * Add whole calendar months to an ISO date with legal "clamp to last day"
 * semantics (General Clauses Act interpretation of "month": the
 * corresponding day of the target month, or its last day if that day
 * doesn't exist there — e.g. 29 Feb 2024 + 12 months = 28 Feb 2025, not the
 * JS-Date-default rollover to 1 Mar 2025).
 */
export function addMonthsClamped(iso: IsoDate, months: number): IsoDate {
  const { y, m, d } = parseIsoDate(iso);
  const totalMonthIndex0 = (m - 1) + months; // 0-based, can exceed 11 or go negative
  const targetYear = y + Math.floor(totalMonthIndex0 / 12);
  const targetMonthIndex0 = ((totalMonthIndex0 % 12) + 12) % 12;
  const clampedDay = Math.min(d, daysInMonth(targetYear, targetMonthIndex0));
  const mm = String(targetMonthIndex0 + 1).padStart(2, '0');
  const dd = String(clampedDay).padStart(2, '0');
  return `${targetYear}-${mm}-${dd}`;
}

export interface HoldingPeriodResult {
  acquisitionDate: IsoDate;
  disposalDate: IsoDate;
  /** Calendar days from acquisition date to disposal date, inclusive of
   * neither endpoint's "extra" day — i.e. plain (disposal - acquisition) in
   * days. Informational; the LTCG/STCG decision uses the anniversary
   * comparison, not a day-count threshold, because calendar months vary in
   * length. */
  holdingDays: number;
  /** The calendar-month anniversary that must be strictly exceeded for
   * long-term treatment. */
  thresholdMonths: number;
  anniversaryDate: IsoDate;
  /** true iff disposalDate is strictly after the anniversary date. */
  isLongTerm: boolean;
}

/**
 * Compute the per-lot holding period and the long-term/short-term boundary
 * decision for a given threshold (12 months for equity-oriented MF units,
 * listed securities; 24/36 months apply to other asset classes not modelled
 * in R6-P1's mutual-fund-only scope).
 */
export function computeHoldingPeriod(
  acquisitionDate: IsoDate,
  disposalDate: IsoDate,
  thresholdMonths: number = 12
): HoldingPeriodResult {
  if (toUtcMillis(disposalDate) < toUtcMillis(acquisitionDate)) {
    throw new Error(
      `computeHoldingPeriod: disposalDate ${disposalDate} precedes acquisitionDate ${acquisitionDate}`
    );
  }
  const anniversaryDate = addMonthsClamped(acquisitionDate, thresholdMonths);
  const isLongTerm = toUtcMillis(disposalDate) > toUtcMillis(anniversaryDate);
  const holdingDays = Math.round((toUtcMillis(disposalDate) - toUtcMillis(acquisitionDate)) / 86_400_000);
  return { acquisitionDate, disposalDate, holdingDays, thresholdMonths, anniversaryDate, isLongTerm };
}
