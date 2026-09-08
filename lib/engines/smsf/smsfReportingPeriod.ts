// ---------------------------------------------------------------------------
// LR-6 WP-01 — SMSF reporting-period model.
//
// SMSF is AU-only: migration 0084's own jurisdiction-gate trigger blocks
// creating an smsf_funds row for any household not confirmed AU (see
// smsfDetection.ts's header for the same AU-only framing on the import side).
// The Australian superannuation/SMSF financial year is 1 July - 30 June —
// this is a fixed calendar convention, not tax or legal advice, so hard-
// coding it here does not cross the phase's "no tax/legal advice" boundary.
//
// No `smsf_funds`/`smsf_holdings` row carries a period column (confirmed by
// direct migration read: smsf_funds has only a single point-in-time
// `summary_balance_date`; smsf_holdings has only created_at/updated_at) — so
// this module defines the period boundaries only. It does not require, and
// this phase does not add, a schema change: P&L/cash-flow computation
// windows the *existing* income_sources/expense_items rows (which already
// carry an implicit "current, ongoing" recurring amount + frequency, exactly
// as computeDashboard() already treats them) into one of these periods.
// ---------------------------------------------------------------------------

export interface SmsfReportingPeriod {
  /** e.g. "FY2025-26" */
  label: string;
  /** ISO date, inclusive. */
  startDate: string;
  /** ISO date, inclusive. */
  endDate: string;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** The AU financial year (1 Jul - 30 Jun) containing `asOfDate`. */
export function australianFinancialYearFor(asOfDate: Date): SmsfReportingPeriod {
  const month = asOfDate.getUTCMonth(); // 0-indexed; July = 6
  const startYear = month >= 6 ? asOfDate.getUTCFullYear() : asOfDate.getUTCFullYear() - 1;
  const start = new Date(Date.UTC(startYear, 6, 1));
  const end = new Date(Date.UTC(startYear + 1, 5, 30));
  return {
    label: `FY${startYear}-${pad2((startYear + 1) % 100)}`,
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

export function currentSmsfFinancialYear(now: Date = new Date()): SmsfReportingPeriod {
  return australianFinancialYearFor(now);
}

/** The current FY plus the `count - 1` FYs immediately before it, newest first. */
export function recentSmsfFinancialYears(count: number, now: Date = new Date()): SmsfReportingPeriod[] {
  const current = australianFinancialYearFor(now);
  const currentStartYear = Number(current.startDate.slice(0, 4));
  const periods: SmsfReportingPeriod[] = [];
  for (let i = 0; i < count; i++) {
    periods.push(australianFinancialYearFor(new Date(Date.UTC(currentStartYear - i, 6, 15))));
  }
  return periods;
}

/** Whole calendar months spanned by a period (FY = 12). */
export function periodLengthMonths(period: SmsfReportingPeriod): number {
  const start = new Date(period.startDate + 'T00:00:00Z');
  const end = new Date(period.endDate + 'T00:00:00Z');
  return (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth()) + 1;
}
