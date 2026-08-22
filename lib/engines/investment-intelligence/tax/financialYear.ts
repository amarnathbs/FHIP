// Investment Intelligence R6-P1 — India financial-year (1 April–31 March)
// bucketing, used for taxpayer-level LTCG threshold aggregation. Deliberately
// NOT calendar-year: 15 Feb 2024 and 15 Jun 2024 are different financial
// years (FY2023-24 vs FY2024-25) but the same calendar year would bucket
// them together, which is why the spec calls this out explicitly.

import type { IsoDate } from './holdingPeriod';

/** Financial-year label in the "FY2023-24" convention used throughout this
 * module's docs and test fixtures. */
export type FinancialYearLabel = string;

function parseIsoDate(iso: IsoDate): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) throw new Error(`financialYear: invalid ISO date "${iso}"`);
  return { y, m, d };
}

/**
 * India's financial year runs 1 April (year N) to 31 March (year N+1),
 * labelled "FYN-(N+1 last two digits)". A date on/after 1 April belongs to
 * the FY starting that calendar year; a date in Jan/Feb/Mar belongs to the
 * FY that started the previous calendar year.
 */
export function financialYearOf(date: IsoDate): FinancialYearLabel {
  const { y, m } = parseIsoDate(date);
  const startYear = m >= 4 ? y : y - 1;
  const endYearShort = String((startYear + 1) % 100).padStart(2, '0');
  return `FY${startYear}-${endYearShort}`;
}

export function financialYearBounds(fy: FinancialYearLabel): { start: IsoDate; end: IsoDate } {
  const match = /^FY(\d{4})-(\d{2})$/.exec(fy);
  if (!match) throw new Error(`financialYear: invalid FY label "${fy}"`);
  const startYear = Number(match[1]);
  return { start: `${startYear}-04-01`, end: `${startYear + 1}-03-31` };
}

/** true iff [start, end] straddles a 31 March / 1 April financial-year
 * boundary — used by certification cases exercising cross-FY aggregation. */
export function straddlesFinancialYearBoundary(start: IsoDate, end: IsoDate): boolean {
  return financialYearOf(start) !== financialYearOf(end);
}
