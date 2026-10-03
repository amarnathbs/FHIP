// NAV2 Stage 2 -- how a typed result is SHOWN. Pure (no React, no I/O), so every state's wording is unit-tested and the
// interactive page, the print page and the PDF all say the same thing.
//
// THE RULES (spec sections 11, 13):
//   * an unavailable result is shown as its plain HEADLINE plus the engine's own sentence, and NEVER as a number: no 0, no
//     0%, no dash that could be read as zero;
//   * the headline wording is fixed per state (below), the detail sentence comes from the engine unchanged;
//   * a figure that rests on a statement value or a stale NAV is labelled "Statement value" / "Stale NAV" beside it;
//   * dates are day-first (dd-mm-yyyy INR, dd/mm/yyyy otherwise) through the shared formatter, never ISO;
//   * money is whole rupees (the app's G1 rule), percentages carry two decimals.

import { formatMoneyWhole } from '@/lib/engines/money';
import type { ChartData } from './fundAnalyticsReport';
import { showDate, type Disclosure, type Nav2Context, type Nav2Reason, type Nav2Result, type Nav2UnavailableState } from './types';

export const INSUFFICIENT_DATA_SAFE_LABEL = 'Insufficient data to display safely.';

const HEADLINES: Record<Nav2UnavailableState, string> = {
  history_hydrating: 'History is being prepared',
  insufficient_history: 'Insufficient history',
  benchmark_missing: 'Benchmark data unavailable',
  risk_free_missing: 'Risk-free data unavailable',
  data_quality_hold: 'Data under review',
  currency_mismatch: 'Currency mismatch',
  identity_unresolved: 'Fund not identified',
  not_applicable: 'Not applicable',
};

const BENCHMARK_MAPPING_REASONS: ReadonlySet<Nav2Reason> = new Set<Nav2Reason>(['no_benchmark_mapping', 'benchmark_category_reference_not_allowed', 'benchmark_mapping_not_effective', 'benchmark_changed_in_window']);

/** The fixed headline for a non-available state. A missing benchmark MAPPING has its own wording. */
export function unavailableHeadline(state: Nav2UnavailableState, reason?: Nav2Reason | null): string {
  if (state === 'benchmark_missing' && reason && BENCHMARK_MAPPING_REASONS.has(reason)) return 'Benchmark mapping missing';
  return HEADLINES[state];
}

export interface ShownCell {
  available: boolean;
  /** The figure when available; the headline when not (never a number-like placeholder). */
  text: string;
  /** Non-null exactly when the result is not available. */
  headline: string | null;
  /** The engine's own sentence for an unavailable result. */
  detail: string | null;
  /** Labels and disclosures that travel with an available figure ("Statement value", "Stale NAV", short period, ...). */
  notes: string[];
}

const LABELLED: Partial<Record<Disclosure['code'], string>> = { statement_value: 'Statement value', stale_nav: 'Stale NAV' };

export function disclosureNote(d: Disclosure): string {
  const label = LABELLED[d.code];
  return label ? `${label}: ${d.detail}` : d.detail;
}

/** A metric the spec did not request for this report: stated plainly, not shown as a figure. */
export const NOT_CALCULATED: ShownCell = { available: false, text: 'Not calculated', headline: 'Not calculated', detail: null, notes: [] };

export function showResult<T>(r: Nav2Result<T> | null | undefined, format: (v: T) => string): ShownCell {
  if (!r) return NOT_CALCULATED;
  if (r.state === 'available') return { available: true, text: format(r.value), headline: null, detail: null, notes: r.disclosures.map(disclosureNote) };
  const headline = unavailableHeadline(r.state, r.reason);
  return { available: false, text: headline, headline, detail: r.detail, notes: r.disclosures.map(disclosureNote) };
}

// ---------------------------------------------------------------------------
// Number formats
// ---------------------------------------------------------------------------
const PCT = { minimumFractionDigits: 2, maximumFractionDigits: 2 } as const;

/** A fraction (0.1234) as "12.34%". */
export function pct(fraction: number): string {
  const v = Math.abs(fraction) < 0.00005 ? 0 : fraction;
  return `${(v * 100).toLocaleString('en-IN', PCT)}%`;
}

export function ratio(x: number, digits = 2): string {
  const v = Math.abs(x) < 0.5 * 10 ** -digits ? 0 : x;
  return v.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** A NAV is a price to four decimals, not money to the whole rupee. */
export function navPrice(x: number): string {
  return x.toLocaleString('en-IN', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}

export const rupees = (x: number): string => formatMoneyWhole(x, 'INR');

export function period(ctx: Pick<Nav2Context, 'currency'>, from: string | null, to: string | null): string {
  return `${showDate(ctx, from)} to ${showDate(ctx, to)}`;
}

// ---------------------------------------------------------------------------
// Chart rows: a line is never drawn across a material gap
// ---------------------------------------------------------------------------
export interface ChartRow {
  date: string;
  nav: number | null;
  sma50: number | null;
  sma200: number | null;
}

/**
 * Joins the NAV line with its SMA 50 / 200 by date and inserts one all-null row inside every material gap, so a chart
 * that does not connect nulls breaks the line there. A gap that falls between two charted points (the line was
 * down-sampled across it) is honoured as well.
 */
export function chartRowsWithGaps(chart: ChartData): ChartRow[] {
  const s50 = new Map(chart.sma50);
  const s200 = new Map(chart.sma200);
  const rows: ChartRow[] = [];
  for (let i = 0; i < chart.navPoints.length; i++) {
    const [date, nav] = chart.navPoints[i];
    if (i > 0) {
      const prev = chart.navPoints[i - 1][0];
      if (chart.gaps.some((g) => g.from >= prev && g.to <= date)) rows.push({ date: prev, nav: null, sma50: null, sma200: null });
    }
    rows.push({ date, nav, sma50: s50.get(date) ?? null, sma200: s200.get(date) ?? null });
  }
  return rows;
}
