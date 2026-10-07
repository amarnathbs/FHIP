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

// ---- the plain, short wording an ordinary reader gets (PO review of Version 9, 07-10-2026) -----------------------------------------------
// The full formula, the dates of the rates used and the price-history audit figures stay in the pinned manifest and in the report's
// `calculationNotes`; none of that is deleted, it is simply not printed in the body of the report.

/** Report note 1: ONE plain sentence. The series is named in words; an unknown series is named by its stored label, never guessed. */
export function riskFreeShortNote(rf: { seriesId?: string; seriesLabel?: string; seriesName?: string } | null | undefined): string {
  const id = rf?.seriesId;
  if (id === 'RBI_91D_TBILL_CUTOFF_YIELD') return 'Sharpe and Sortino compare each fund with the RBI 91-day Treasury bill rate (source: Reserve Bank of India).';
  if (id === 'RBI_POLICY_REPO_RATE') return 'Sharpe and Sortino compare each fund with the RBI policy repo rate, used as a stand-in for a risk-free rate (source: Reserve Bank of India).';
  const label = riskFreeLabelOf(rf) ?? rf?.seriesName ?? 'a published risk-free rate';
  return `Sharpe and Sortino compare each fund with ${label} (source: Reserve Bank of India).`;
}

/** The last note: as-at date, source of prices, not advice. `asAt` is already formatted day first. */
export const figuresAsAtNote = (asAt: string): string => `Figures are as at ${asAt}. Prices are published by AMFI. This is information, not a recommendation to buy, sell or switch.`;

/** The one line that replaces the price-history table: `latest` is the formatted (day-first) latest price date across the funds. */
export const pricesRunToLine = (latest: string): string => `Prices are published by AMFI and run to ${latest}.`;

/** Printed once under the risk table when neither beta nor alpha can be worked out because no benchmark index is linked. */
export const BETA_ALPHA_NO_BENCHMARK_LINE = 'Beta and alpha: not available yet (no benchmark index is linked to this fund).';

/** True when BOTH beta and alpha are typed "benchmark missing" for the single reason that no benchmark is mapped (any other reason keeps its own typed row). */
export function betaAlphaNoBenchmark(s: { beta?: { state: string; reason?: string } | null; alpha?: { state: string; reason?: string } | null }): boolean {
  const no = (r: { state: string; reason?: string } | null | undefined) => !!r && r.state === 'benchmark_missing' && r.reason === 'no_benchmark_mapping';
  return no(s.beta) && no(s.alpha);
}

/** The collapsed "How this was calculated" heading on the web page. */
export const HOW_CALCULATED_HEADING = 'How this was calculated';

export const PERFORMANCE_TAB_CAGR_CONVENTION_NOTE =
  'On this tab a year is 365 days, and a figure is annualised (p.a.) only once the period is longer than 365 days. The Fund analytics report counts a year as 365.2425 days and annualises a period of a year or more, so the same fund can show a slightly different annualised figure there. Both are correct for the convention they state.';
