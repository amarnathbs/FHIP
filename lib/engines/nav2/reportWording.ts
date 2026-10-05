// Fixed wording of the Fund analytics report that more than one place prints (the page, the print document, the PDF footer). Pure.
import { formatDateTimeMinutes } from '@/lib/engines/date';
import { RISK_FREE_SERIES_LABELS, type RiskFreeSeriesId } from '@/lib/config/nav2/riskFreeSeriesConfig';

export const FUND_ANALYTICS_SAVED_REPORT_SENTENCE = 'This is a saved report: it does not change when prices are later corrected. Generate a new version to include them.';

/** "Version 5, made 05-10-2026, 9:30 am". Day-first; the time is to the minute. */
export function versionMadeLine(versionNumber: number, createdAt: string, currency: 'AUD' | 'INR' = 'INR'): string {
  return `Version ${versionNumber}, made ${formatDateTimeMinutes(createdAt, currency)}`;
}

/** The short series label for a risk-free provenance block; a report stored before the label existed gets it from the series id (never a guess: an unknown id has no label). */
export function riskFreeLabelOf(rf: { seriesId?: string; seriesLabel?: string } | null | undefined): string | null {
  if (!rf) return null;
  return rf.seriesLabel ?? (rf.seriesId ? RISK_FREE_SERIES_LABELS[rf.seriesId as RiskFreeSeriesId] ?? null : null);
}

/**
 * Why an annualised figure here can differ a little from the same fund's figure on the Performance tab (PO review D). Plain words; both
 * screens state their own convention and neither is wrong. The Performance tab's maths is not changed.
 */
export const FUND_ANALYTICS_CAGR_CONVENTION_NOTE =
  'In this report a year is 365.2425 days (the average calendar year), and a period of a year or more is annualised over the days actually between the two prices. The Performance tab counts a year as 365 days and starts annualising only once a period is longer than 365 days, so the same fund can show a slightly different annualised figure on the two screens. Both are correct for the convention they state.';

export const PERFORMANCE_TAB_CAGR_CONVENTION_NOTE =
  'On this tab a year is 365 days, and a figure is annualised (p.a.) only once the period is longer than 365 days. The Fund analytics report counts a year as 365.2425 days and annualises a period of a year or more, so the same fund can show a slightly different annualised figure there. Both are correct for the convention they state.';
