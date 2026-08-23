// Investment Intelligence R5 — actual SIP XIRR, benchmark-equivalent SIP
// XIRR, and the (only) valid comparison between them.
//
// REUSES the certified R4 XIRR engine (lib/engines/investment-intelligence/xirr.ts)
// and its investor-perspective sign convention. R5 deliberately does NOT
// contain a second XIRR implementation (spec section 18).
//   contribution                 -> negative
//   redemption / cash distribution received -> positive
//   ending value at as-of date   -> positive terminal flow
//
// ============================================================================
// THE BENCHMARK-SIP METHODOLOGY (spec sections 27-33) — the heart of R5
// ============================================================================
// For every eligible series, R5 builds a SYNTHETIC benchmark investment that
// receives the IDENTICAL cash-flow schedule: each actual contribution's exact
// amount, on that same date, applied to the mapped benchmark.
//
//   units_i          = Contribution_i / BenchmarkLevel(date_i)
//   SyntheticUnits   = Σ units_i
//   TerminalValue    = SyntheticUnits × BenchmarkLevel(asOfDate)
//   BenchmarkSipXIRR = XIRR( same dates, same amounts, TerminalValue )
//
// BenchmarkLevel() is resolved ONLY through the centralised date-alignment
// rule in dateAlignment.ts — forward for contributions, backward for the
// terminal valuation.
//
// THE PROHIBITED COMPARISON
// It is explicitly forbidden to compare Actual SIP XIRR against an ordinary
// benchmark 5Y CAGR and call the difference "SIP alpha". Those two numbers
// describe incompatible cash-flow structures: a CAGR describes one lump sum
// held throughout, while a SIP XIRR describes money arriving progressively,
// so most of a SIP's capital was never exposed to the full period. The ONLY
// valid comparison R5 produces is
//
//   SIP benchmark excess return = Actual SIP XIRR − Benchmark SIP XIRR
//
// over exactly matching cash flows and period. It is never called alpha —
// R4's `alpha` is a regression intercept and means something different.

import { xirr, type CashFlow, XIRR_METHOD_VERSION } from '../xirr';
import {
  resolveObservationOnOrAfter,
  resolveObservationAsOf,
  sortSeries,
  SIP_DATE_ALIGNMENT_VERSION,
  type Observation,
} from './dateAlignment';
import type { SipSeries } from './sipDetection';
import type { SipAttributionResult } from './sipAttribution';

export const SIP_XIRR_METHOD_VERSION = 'sip-xirr-r5-v1';
export const BENCHMARK_SIP_METHOD_VERSION = 'benchmark-sip-identical-cashflow-r5-v1';

/** The approved label. Never "alpha", never "SIP alpha". */
export const SIP_EXCESS_RETURN_LABEL = 'SIP benchmark excess return';

function toUtc(iso: string): number {
  return Date.parse(`${iso}T00:00:00.000Z`);
}

// ---------------------------------------------------------------------------
// Actual SIP XIRR
// ---------------------------------------------------------------------------

export interface SipCashFlowInputs {
  /** Redemptions / cash distributions received that are attributable to this series. */
  attributableInflows?: Array<{ date: string; amount: number }>;
  /** NAV per unit at the as-of date, used with attributed units for the terminal value. */
  navAtAsOf?: number | null;
  asOfDate: string;
}

export type SipXirrUnavailableReason =
  | 'ATTRIBUTION_UNAVAILABLE'
  | 'NAV_UNAVAILABLE'
  | 'NO_CONTRIBUTIONS'
  | 'XIRR_UNAVAILABLE';

export interface SipXirrResult {
  status: 'ok' | 'unavailable';
  rate?: number;
  terminalValue?: number;
  totalContributed?: number;
  cashFlows?: CashFlow[];
  reason?: SipXirrUnavailableReason;
  detail?: string;
  /** Set when the fund also holds non-series purchases — surfaced in the UI. */
  positionIsMixed?: boolean;
  method: typeof SIP_XIRR_METHOD_VERSION;
  xirrMethod: typeof XIRR_METHOD_VERSION;
}

/**
 * Actual investor XIRR for one recurring series.
 *
 * Refuses to produce a number whenever the series' own ending value cannot
 * be honestly established. In particular, when `attribution.status` is
 * 'unavailable' — which is exactly the mixed SIP + lump-sum case the spec
 * singles out — this returns 'unavailable' with ATTRIBUTION_UNAVAILABLE, and
 * the caller is expected to fall back to R4's certified fund-level investor
 * XIRR rather than show a fabricated SIP-specific figure.
 */
export function calculateActualSipXirr(
  series: SipSeries,
  attribution: SipAttributionResult,
  inputs: SipCashFlowInputs
): SipXirrResult {
  const base = { method: SIP_XIRR_METHOD_VERSION, xirrMethod: XIRR_METHOD_VERSION } as const;

  if (series.contributions.length === 0) {
    return { status: 'unavailable', reason: 'NO_CONTRIBUTIONS', detail: 'This series has no recorded contributions.', ...base };
  }
  if (attribution.status !== 'ok' || attribution.seriesUnitsRemaining === undefined) {
    return {
      status: 'unavailable',
      reason: 'ATTRIBUTION_UNAVAILABLE',
      detail:
        attribution.detail ??
        'The units belonging to this recurring series could not be separated from other purchases in the same fund, so a SIP-specific return is not shown. The fund-level investor return is unaffected and remains available.',
      positionIsMixed: attribution.positionIsMixed,
      ...base,
    };
  }
  if (inputs.navAtAsOf === null || inputs.navAtAsOf === undefined || !Number.isFinite(inputs.navAtAsOf)) {
    return {
      status: 'unavailable',
      reason: 'NAV_UNAVAILABLE',
      detail: `No published NAV is available on or before ${inputs.asOfDate}, so the ending value of this series cannot be established.`,
      positionIsMixed: attribution.positionIsMixed,
      ...base,
    };
  }

  const terminalValue = attribution.seriesUnitsRemaining * inputs.navAtAsOf;
  const flows: CashFlow[] = series.contributions.map((c) => ({
    date: new Date(toUtc(c.transactionDate)),
    amount: -Math.abs(c.grossAmount), // contribution: investor money out
  }));
  for (const inflow of inputs.attributableInflows ?? []) {
    flows.push({ date: new Date(toUtc(inflow.date)), amount: Math.abs(inflow.amount) });
  }
  flows.push({ date: new Date(toUtc(inputs.asOfDate)), amount: terminalValue });

  const solved = xirr(flows);
  const totalContributed = series.contributions.reduce((s, c) => s + Math.abs(c.grossAmount), 0);

  if (solved.status !== 'ok' || solved.rate === undefined) {
    return {
      status: 'unavailable',
      reason: 'XIRR_UNAVAILABLE',
      detail: `A money-weighted return could not be solved for this series (${solved.reason}${solved.detail ? `: ${solved.detail}` : ''}).`,
      terminalValue,
      totalContributed,
      positionIsMixed: attribution.positionIsMixed,
      ...base,
    };
  }

  return {
    status: 'ok',
    rate: solved.rate,
    terminalValue,
    totalContributed,
    cashFlows: flows,
    positionIsMixed: attribution.positionIsMixed,
    ...base,
  };
}

// ---------------------------------------------------------------------------
// Benchmark-equivalent SIP (identical cash flows)
// ---------------------------------------------------------------------------

export type BenchmarkSipUnavailableReason =
  | 'MISSING_BENCHMARK'
  | 'INCOMPLETE_BENCHMARK_HISTORY'
  | 'BENCHMARK_TERMINAL_UNAVAILABLE'
  | 'NO_CONTRIBUTIONS'
  | 'XIRR_UNAVAILABLE';

export interface BenchmarkSipResult {
  status: 'ok' | 'unavailable';
  rate?: number;
  syntheticUnits?: number;
  terminalValue?: number;
  totalContributed?: number;
  /** Per-contribution detail, for methodology transparency in the UI. */
  appliedContributions?: Array<{ date: string; amount: number; benchmarkDate: string; benchmarkLevel: number; unitsBought: number; offsetDays: number }>;
  /** Contributions that could not be aligned to a benchmark observation. */
  unalignedContributions?: Array<{ date: string; amount: number; reason: string }>;
  reason?: BenchmarkSipUnavailableReason;
  detail?: string;
  method: typeof BENCHMARK_SIP_METHOD_VERSION;
  dateAlignmentMethod: typeof SIP_DATE_ALIGNMENT_VERSION;
  xirrMethod: typeof XIRR_METHOD_VERSION;
}

export interface BenchmarkSipInputs {
  /** Benchmark observation series. May be unsorted; sorted internally. */
  benchmarkSeries: Observation[] | null;
  asOfDate: string;
  /** Total-return (TRI) status of the mapped benchmark, carried through for disclosure. */
  benchmarkReturnType?: string | null;
}

/**
 * Build the identical-cash-flow benchmark SIP for a series.
 *
 * Coverage discipline (spec section 31): if the benchmark mapping is absent,
 * or ANY contribution date cannot be aligned to an observation, the result is
 * UNAVAILABLE. A partial-period comparison is never silently presented as a
 * full-period one — that is a critical-FAIL condition.
 */
export function calculateBenchmarkSip(series: SipSeries, inputs: BenchmarkSipInputs): BenchmarkSipResult {
  const base = {
    method: BENCHMARK_SIP_METHOD_VERSION,
    dateAlignmentMethod: SIP_DATE_ALIGNMENT_VERSION,
    xirrMethod: XIRR_METHOD_VERSION,
  } as const;

  if (series.contributions.length === 0) {
    return { status: 'unavailable', reason: 'NO_CONTRIBUTIONS', detail: 'This series has no recorded contributions.', ...base };
  }
  if (!inputs.benchmarkSeries || inputs.benchmarkSeries.length === 0) {
    return {
      status: 'unavailable',
      reason: 'MISSING_BENCHMARK',
      detail: 'No benchmark is mapped to this scheme, or no benchmark history is available, so a like-for-like benchmark comparison cannot be produced. No comparison figure is shown.',
      ...base,
    };
  }

  const sorted = sortSeries(inputs.benchmarkSeries);
  const applied: NonNullable<BenchmarkSipResult['appliedContributions']> = [];
  const unaligned: NonNullable<BenchmarkSipResult['unalignedContributions']> = [];
  let syntheticUnits = 0;

  for (const c of series.contributions) {
    const aligned = resolveObservationOnOrAfter(sorted, c.transactionDate);
    if (aligned.status !== 'ok' || !aligned.observation || aligned.observation.value <= 0) {
      unaligned.push({
        date: c.transactionDate,
        amount: c.grossAmount,
        reason: aligned.reason ?? 'NON_POSITIVE_LEVEL',
      });
      continue;
    }
    const amount = Math.abs(c.grossAmount);
    const units = amount / aligned.observation.value;
    syntheticUnits += units;
    applied.push({
      date: c.transactionDate,
      amount,
      benchmarkDate: aligned.observation.date,
      benchmarkLevel: aligned.observation.value,
      unitsBought: units,
      offsetDays: aligned.offsetDays ?? 0,
    });
  }

  if (unaligned.length > 0) {
    return {
      status: 'unavailable',
      reason: 'INCOMPLETE_BENCHMARK_HISTORY',
      detail: `Benchmark history does not cover ${unaligned.length} of this series' ${series.contributions.length} contribution date(s) (earliest gap: ${unaligned[0].date}). A partial-period comparison would not be like-for-like, so no benchmark comparison is shown.`,
      appliedContributions: applied,
      unalignedContributions: unaligned,
      ...base,
    };
  }

  const terminalObs = resolveObservationAsOf(sorted, inputs.asOfDate);
  if (terminalObs.status !== 'ok' || !terminalObs.observation) {
    return {
      status: 'unavailable',
      reason: 'BENCHMARK_TERMINAL_UNAVAILABLE',
      detail: `No benchmark observation is available on or before the analysis date ${inputs.asOfDate}, so the benchmark-equivalent ending value cannot be established.`,
      appliedContributions: applied,
      ...base,
    };
  }

  const terminalValue = syntheticUnits * terminalObs.observation.value;
  const flows: CashFlow[] = series.contributions.map((c) => ({
    date: new Date(toUtc(c.transactionDate)),
    amount: -Math.abs(c.grossAmount),
  }));
  flows.push({ date: new Date(toUtc(inputs.asOfDate)), amount: terminalValue });

  const solved = xirr(flows);
  const totalContributed = series.contributions.reduce((s, c) => s + Math.abs(c.grossAmount), 0);

  if (solved.status !== 'ok' || solved.rate === undefined) {
    return {
      status: 'unavailable',
      reason: 'XIRR_UNAVAILABLE',
      detail: `A benchmark-equivalent money-weighted return could not be solved (${solved.reason}).`,
      syntheticUnits,
      terminalValue,
      totalContributed,
      appliedContributions: applied,
      ...base,
    };
  }

  return {
    status: 'ok',
    rate: solved.rate,
    syntheticUnits,
    terminalValue,
    totalContributed,
    appliedContributions: applied,
    ...base,
  };
}

// ---------------------------------------------------------------------------
// The only valid comparison
// ---------------------------------------------------------------------------

export interface SipExcessReturnResult {
  status: 'ok' | 'unavailable';
  /** Actual SIP XIRR − Benchmark SIP XIRR, both over identical cash flows. */
  excessReturn?: number;
  label: typeof SIP_EXCESS_RETURN_LABEL;
  reason?: 'ACTUAL_UNAVAILABLE' | 'BENCHMARK_UNAVAILABLE' | 'CASHFLOWS_NOT_IDENTICAL';
  detail?: string;
}

/**
 * Compute the SIP benchmark excess return.
 *
 * Guarded so the two sides cannot silently drift apart: the actual and
 * benchmark legs must have been built from the SAME contribution dates and
 * amounts. If they were not, the comparison is refused rather than reported.
 */
export function calculateSipExcessReturn(
  actual: SipXirrResult,
  benchmark: BenchmarkSipResult,
  series: SipSeries
): SipExcessReturnResult {
  if (actual.status !== 'ok' || actual.rate === undefined) {
    return { status: 'unavailable', label: SIP_EXCESS_RETURN_LABEL, reason: 'ACTUAL_UNAVAILABLE', detail: actual.detail };
  }
  if (benchmark.status !== 'ok' || benchmark.rate === undefined) {
    return { status: 'unavailable', label: SIP_EXCESS_RETURN_LABEL, reason: 'BENCHMARK_UNAVAILABLE', detail: benchmark.detail };
  }
  // Structural guard: identical cash-flow schedule on both sides.
  const applied = benchmark.appliedContributions ?? [];
  const identical =
    applied.length === series.contributions.length &&
    series.contributions.every((c, i) => applied[i].date === c.transactionDate && Math.abs(applied[i].amount - Math.abs(c.grossAmount)) < 1e-6);
  if (!identical) {
    return {
      status: 'unavailable',
      label: SIP_EXCESS_RETURN_LABEL,
      reason: 'CASHFLOWS_NOT_IDENTICAL',
      detail: 'The benchmark comparison was not built from an identical contribution schedule, so the two returns are not comparable and no difference is shown.',
    };
  }
  return { status: 'ok', excessReturn: actual.rate - benchmark.rate, label: SIP_EXCESS_RETURN_LABEL };
}

// ---------------------------------------------------------------------------
// Wealth comparison (descriptive, never predictive)
// ---------------------------------------------------------------------------

export interface SipWealthComparison {
  status: 'ok' | 'unavailable';
  totalContributed?: number;
  actualEndingValue?: number;
  benchmarkEndingValue?: number;
  difference?: number;
  differencePct?: number;
  detail?: string;
}

/** Contributions are identical on both sides by construction, so the
 *  difference in ending value is attributable to the investments' own
 *  behaviour over the recorded period. Descriptive only. */
export function calculateSipWealthComparison(actual: SipXirrResult, benchmark: BenchmarkSipResult): SipWealthComparison {
  if (actual.status !== 'ok' || actual.terminalValue === undefined) {
    return { status: 'unavailable', detail: actual.detail ?? 'Actual ending value unavailable.' };
  }
  if (benchmark.status !== 'ok' || benchmark.terminalValue === undefined) {
    return { status: 'unavailable', detail: benchmark.detail ?? 'Benchmark-equivalent ending value unavailable.' };
  }
  const difference = actual.terminalValue - benchmark.terminalValue;
  return {
    status: 'ok',
    totalContributed: actual.totalContributed,
    actualEndingValue: actual.terminalValue,
    benchmarkEndingValue: benchmark.terminalValue,
    difference,
    differencePct: benchmark.terminalValue !== 0 ? difference / benchmark.terminalValue : undefined,
  };
}
