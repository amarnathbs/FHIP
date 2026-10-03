// NAV2 -- scheme-performance RISK and RELATIVE measures (spec 8.7 - 8.12, 8.16).
// Family: scheme_performance. Pure and deterministic.
//
// Shared discipline (each rule has a named negative control in the tests):
//   * the return series is the simple return between CONSECUTIVE valid NAVs; a
//     periodic measure is only valid when every interval is consistent with the
//     declared frequency (a gap makes it `insufficient_history`, never a number
//     computed across the hole);
//   * sample standard deviation (n - 1), through the certified riskMetrics helper;
//   * annualisation only by the declared factor for the declared frequency, and the
//     convention is written into the result's provenance;
//   * a zero-variance input yields `not_applicable` with no ratio;
//   * Sharpe, Sortino and alpha need a risk-free supply and answer `risk_free_missing`
//     without one; beta, alpha need a gated benchmark and answer `benchmark_missing`
//     without one. Neither is ever replaced by zero.
//   * correlation is on RETURNS, never NAV levels, and only among schemes the caller
//     states are held in scope.
//
// Reuse: sampleStdDev / mean (riskMetrics), maxDrawdown and beta arithmetic
// (riskMetrics), the benchmark gate predicates (holdingBenchmarkComparison), the
// governed risk-free lookup (pc6/riskFreeSeries). The Sharpe, Sortino and alpha
// DEFINITIONS here are the NAV2 spec's own (excess-return based) and differ from the
// R4 Performance-tab ones; both are versioned and documented in the register.

import { beta as r4Beta, maxDrawdown as r4MaxDrawdown, mean, sampleStdDev } from '@/lib/engines/investment-intelligence/riskMetrics';
import type { Nav2MetricId, ReturnFrequency } from '@/lib/config/nav2/metricPolicy';
import { daysBetweenIso } from './dates';
import { gateBenchmark, type Nav2BenchmarkInput } from './benchmarkGate';
import { matchRiskFree, type RiskFreeSupply } from './riskFree';
import {
  alignOnCommonDates,
  buildReturns,
  checkContinuity,
  continuityDetail,
  guardSeries,
  isSelectedWindow,
  lackOfHistory,
  resampleObservations,
  selectWindow,
  seriesProvenanceBlock,
  type PreparedSeries,
  type ReturnPoint,
  type SelectedWindow,
  type Window,
} from './series';
import {
  available,
  makeProvenance,
  propagateUnavailable,
  unavailable,
  type Disclosure,
  type Nav2Context,
  type Nav2Result,
  type Nav2Unavailable,
  type ProvenanceExtras,
} from './types';

interface PeriodicOk {
  ok: true;
  sel: SelectedWindow;
  returns: ReturnPoint[];
  extras: ProvenanceExtras;
  disclosures: Disclosure[];
}
type PeriodicResult = PeriodicOk | { ok: false; result: Nav2Unavailable };

/**
 * Guard, window, resample to the declared frequency, build simple returns, enforce interval consistency and the
 * metric's minimum number of returns. The one place every periodic measure goes through.
 */
function periodicReturns(
  series: PreparedSeries,
  ctx: Nav2Context,
  metricId: Nav2MetricId,
  window: Window,
  frequency: ReturnFrequency,
  minReturns: number,
  convention: Record<string, string | number | boolean | null>
): PeriodicResult {
  const baseExtras: ProvenanceExtras = {
    instrumentId: series.identity.instrumentId,
    requested: window,
    navSeries: seriesProvenanceBlock(series),
    convention: { frequency, periodsPerYear: ctx.policy.periodsPerYear[frequency], standardDeviation: ctx.policy.conventions.standardDeviation, ...convention },
  };
  const guard = guardSeries(series, ctx, metricId, baseExtras);
  if (guard) return { ok: false, result: guard };
  const sel = selectWindow(series, ctx, metricId, window, baseExtras);
  if (!isSelectedWindow(sel)) return { ok: false, result: sel };
  const obs = resampleObservations(sel.obs, frequency);
  const returns = buildReturns(obs);
  const extras: ProvenanceExtras = { ...baseExtras, actual: sel.actual, observationCount: returns.length };
  const cont = checkContinuity(returns, frequency, ctx.policy);
  if (!cont.ok) {
    return { ok: false, result: lackOfHistory(series, ctx, metricId, cont.reason, continuityDetail(ctx, cont, frequency), extras, sel.disclosures) };
  }
  if (returns.length < minReturns) {
    return {
      ok: false,
      result: lackOfHistory(series, ctx, metricId, 'too_few_returns', `At least ${minReturns} ${frequency} returns are needed for this measure; this period has ${returns.length}.`, extras, sel.disclosures),
    };
  }
  return { ok: true, sel, returns, extras, disclosures: [...sel.disclosures] };
}

function belowPreferred(count: number, preferred: number): Disclosure | null {
  return count < preferred ? { code: 'below_preferred_observations', detail: `This figure rests on ${count} observations; ${preferred} or more would make it more reliable.` } : null;
}

// ---------------------------------------------------------------------------
// Volatility (8.7)
// ---------------------------------------------------------------------------

export interface VolatilityValue {
  frequency: ReturnFrequency;
  periodsPerYear: number;
  returnCount: number;
  /** Sample (n - 1) standard deviation of the periodic simple returns. */
  periodicSampleSd: number;
  /** periodicSampleSd x sqrt(periodsPerYear), at the declared frequency only. */
  annualisedVolatility: number;
  annualisationConvention: string;
}

export function volatility(series: PreparedSeries, ctx: Nav2Context, window: Window = { start: null, end: null }, frequency: ReturnFrequency = 'daily'): Nav2Result<VolatilityValue> {
  const p = periodicReturns(series, ctx, 'volatility', window, frequency, ctx.policy.minimums.volatilityReturns, { annualisation: 'sample_sd_x_sqrt_periods_per_year' });
  if (!p.ok) return p.result;
  const sd = sampleStdDev(p.returns.map((r) => r.simple));
  const ppy = ctx.policy.periodsPerYear[frequency];
  const disclosures = [...p.disclosures];
  const bp = belowPreferred(p.returns.length, ctx.policy.minimums.volatilityPreferredReturns);
  if (bp) disclosures.push(bp);
  return available(
    { frequency, periodsPerYear: ppy, returnCount: p.returns.length, periodicSampleSd: sd, annualisedVolatility: sd * Math.sqrt(ppy), annualisationConvention: `sample standard deviation x sqrt(${ppy}) for ${frequency} returns` },
    makeProvenance(ctx, 'volatility', p.extras),
    disclosures
  );
}

// ---------------------------------------------------------------------------
// Sharpe (8.8) and Sortino (8.9)
// ---------------------------------------------------------------------------

export interface SharpeValue {
  frequency: ReturnFrequency;
  returnCount: number;
  meanExcessReturn: number;
  sampleSdExcessReturn: number;
  /** mean(r - rf) / sample_sd(r - rf), per period. */
  periodicRatio: number;
  /** periodicRatio x sqrt(periodsPerYear) (the spec's annualised approximation). */
  annualisedRatio: number;
}

export function sharpeRatio(
  series: PreparedSeries,
  ctx: Nav2Context,
  riskFree: RiskFreeSupply,
  window: Window = { start: null, end: null },
  frequency: ReturnFrequency = 'daily'
): Nav2Result<SharpeValue> {
  const p = periodicReturns(series, ctx, 'sharpe_ratio', window, frequency, ctx.policy.minimums.sharpeSortinoReturns, { sharpe: ctx.policy.conventions.sharpe, riskFreeConversion: ctx.policy.conventions.riskFreeConversion });
  if (!p.ok) return p.result;
  const rf = matchRiskFree(p.returns, riskFree, ctx, 'sharpe_ratio', p.extras, frequency);
  if (!rf.ok) return rf.result;
  const excess = p.returns.map((r, i) => r.simple - rf.periodic[i]);
  const sd = sampleStdDev(excess);
  const prov = makeProvenance(ctx, 'sharpe_ratio', { ...p.extras, riskFree: rf.provenance });
  if (!(sd > ctx.policy.zeroVarianceEpsilon)) {
    return unavailable('not_applicable', 'zero_volatility', 'The excess returns did not vary, so a Sharpe ratio is not defined for this period.', prov, [...p.disclosures, ...rf.disclosures]);
  }
  const m = mean(excess);
  const ppy = ctx.policy.periodsPerYear[frequency];
  return available(
    { frequency, returnCount: excess.length, meanExcessReturn: m, sampleSdExcessReturn: sd, periodicRatio: m / sd, annualisedRatio: (m / sd) * Math.sqrt(ppy) },
    prov,
    [...p.disclosures, ...rf.disclosures]
  );
}

export interface SortinoValue {
  frequency: ReturnFrequency;
  returnCount: number;
  meanExcessOverTarget: number;
  /** sqrt(mean over ALL periods of min(0, r - MAR)^2): the declared convention. */
  downsideDeviation: number;
  downsideConvention: string;
  periodicRatio: number;
  annualisedRatio: number;
}

export function sortinoRatio(
  series: PreparedSeries,
  ctx: Nav2Context,
  riskFree: RiskFreeSupply,
  window: Window = { start: null, end: null },
  frequency: ReturnFrequency = 'daily'
): Nav2Result<SortinoValue> {
  const p = periodicReturns(series, ctx, 'sortino_ratio', window, frequency, ctx.policy.minimums.sharpeSortinoReturns, { sortino: ctx.policy.conventions.sortino, riskFreeConversion: ctx.policy.conventions.riskFreeConversion });
  if (!p.ok) return p.result;
  const rf = matchRiskFree(p.returns, riskFree, ctx, 'sortino_ratio', p.extras, frequency);
  if (!rf.ok) return rf.result;
  const excess = p.returns.map((r, i) => r.simple - rf.periodic[i]); // MAR = the matched risk-free return
  const downside = excess.map((x) => Math.min(0, x) ** 2);
  const dd = Math.sqrt(downside.reduce((s, x) => s + x, 0) / excess.length);
  const prov = makeProvenance(ctx, 'sortino_ratio', { ...p.extras, riskFree: rf.provenance });
  if (!(dd > ctx.policy.zeroVarianceEpsilon)) {
    return unavailable('not_applicable', 'zero_downside_deviation', 'No period fell below the target return, so a Sortino ratio is not defined for this period.', prov, [...p.disclosures, ...rf.disclosures]);
  }
  const m = mean(excess);
  const ppy = ctx.policy.periodsPerYear[frequency];
  return available(
    { frequency, returnCount: excess.length, meanExcessOverTarget: m, downsideDeviation: dd, downsideConvention: 'all periods in the denominator (mean over every period of min(0, r - MAR)^2); MAR = matched risk-free return', periodicRatio: m / dd, annualisedRatio: (m / dd) * Math.sqrt(ppy) },
    prov,
    [...p.disclosures, ...rf.disclosures]
  );
}

// ---------------------------------------------------------------------------
// Maximum drawdown (8.10)
// ---------------------------------------------------------------------------

export interface MaxDrawdownValue {
  /** Negative fraction (-0.25 = -25%); 0 when the series never fell below a prior high. */
  maxDrawdown: number;
  status: 'recovered' | 'not_recovered' | 'no_drawdown';
  peakDate: string | null;
  peakNav: number | null;
  troughDate: string | null;
  troughNav: number | null;
  /** First observation after the trough at or above the prior peak; null when not recovered. */
  recoveryDate: string | null;
  daysPeakToTrough: number | null;
  daysTroughToRecovery: number | null;
  observationCount: number;
}

const toDate = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const toIso = (d: Date): string => d.toISOString().slice(0, 10);

export function maxDrawdown(series: PreparedSeries, ctx: Nav2Context, window: Window = { start: null, end: null }): Nav2Result<MaxDrawdownValue> {
  const baseExtras: ProvenanceExtras = { instrumentId: series.identity.instrumentId, requested: window, navSeries: seriesProvenanceBlock(series), convention: { recovery: ctx.policy.conventions.drawdownRecovery, wealthSeries: 'nav' } };
  const guard = guardSeries(series, ctx, 'max_drawdown', baseExtras);
  if (guard) return guard;
  const sel = selectWindow(series, ctx, 'max_drawdown', window, baseExtras);
  if (!isSelectedWindow(sel)) return sel;
  const extras: ProvenanceExtras = { ...baseExtras, actual: sel.actual, observationCount: sel.obs.length };
  if (sel.obs.length < ctx.policy.minimums.drawdownObservations) {
    return lackOfHistory(series, ctx, 'max_drawdown', 'too_few_observations', `At least ${ctx.policy.minimums.drawdownObservations} prices are needed to measure a drawdown.`, extras, sel.disclosures);
  }
  const r = r4MaxDrawdown(sel.obs.map((o) => ({ date: toDate(o.date), value: o.value })));
  const prov = makeProvenance(ctx, 'max_drawdown', extras);
  if (r.status !== 'ok' || !r.value) {
    return lackOfHistory(series, ctx, 'max_drawdown', 'too_few_observations', 'A drawdown could not be measured for this period.', extras, sel.disclosures);
  }
  const disclosures = [...sel.disclosures];
  if (daysBetweenIso(sel.actual.start, sel.actual.end) < ctx.policy.minimums.drawdownShortPeriodDays) {
    disclosures.push({ code: 'short_period', detail: `This drawdown is measured over only ${daysBetweenIso(sel.actual.start, sel.actual.end)} days, a short period.` });
  }
  const v = r.value;
  if (v.maxDrawdown === 0) {
    return available({ maxDrawdown: 0, status: 'no_drawdown', peakDate: null, peakNav: null, troughDate: null, troughNav: null, recoveryDate: null, daysPeakToTrough: null, daysTroughToRecovery: null, observationCount: sel.obs.length }, prov, disclosures);
  }
  const peakDate = toIso(v.peakDate);
  const troughDate = toIso(v.troughDate);
  const recoveryDate = v.recoveryDate ? toIso(v.recoveryDate) : null;
  return available(
    {
      maxDrawdown: v.maxDrawdown,
      status: recoveryDate ? 'recovered' : 'not_recovered',
      peakDate,
      peakNav: v.peakValue,
      troughDate,
      troughNav: v.troughValue,
      recoveryDate,
      daysPeakToTrough: daysBetweenIso(peakDate, troughDate),
      daysTroughToRecovery: recoveryDate ? daysBetweenIso(troughDate, recoveryDate) : null,
      observationCount: sel.obs.length,
    },
    prov,
    disclosures
  );
}

// ---------------------------------------------------------------------------
// Beta (8.11) and Jensen alpha (8.12)
// ---------------------------------------------------------------------------

interface BenchmarkAligned {
  ok: true;
  sel: SelectedWindow;
  schemeReturns: ReturnPoint[];
  benchmarkReturns: ReturnPoint[];
  extras: ProvenanceExtras;
  disclosures: Disclosure[];
}

function alignedBenchmarkReturns(
  series: PreparedSeries,
  ctx: Nav2Context,
  metricId: 'beta' | 'jensen_alpha',
  benchmarks: readonly Nav2BenchmarkInput[] | undefined,
  window: Window,
  frequency: ReturnFrequency
): BenchmarkAligned | { ok: false; result: Nav2Unavailable } {
  const baseExtras: ProvenanceExtras = {
    instrumentId: series.identity.instrumentId,
    requested: window,
    navSeries: seriesProvenanceBlock(series),
    convention: { frequency, periodsPerYear: ctx.policy.periodsPerYear[frequency], alignment: 'common_dates_only', returns: 'simple' },
  };
  const guard = guardSeries(series, ctx, metricId, baseExtras);
  if (guard) return { ok: false, result: guard };
  const sel = selectWindow(series, ctx, metricId, window, baseExtras);
  if (!isSelectedWindow(sel)) return { ok: false, result: sel };
  const gate = gateBenchmark(benchmarks, sel.actual, ctx, metricId, { ...baseExtras, actual: sel.actual });
  if (!gate.ok) return gate;
  const { gated } = gate;
  const benchInWindow = gated.observations.filter((o) => o.date >= sel.actual.start && o.date <= sel.actual.end);
  const aligned = alignOnCommonDates(resampleObservations(sel.obs, frequency), resampleObservations(benchInWindow, frequency));
  const schemeReturns = buildReturns(aligned.a);
  const benchmarkReturns = buildReturns(aligned.b);
  const provenance = { ...gated.provenance, commonObservationCount: aligned.a.length };
  const extras: ProvenanceExtras = { ...baseExtras, actual: sel.actual, observationCount: schemeReturns.length, benchmark: provenance };
  const disclosures = [...sel.disclosures, ...gated.disclosures];
  const fail = (u: Nav2Unavailable) => ({ ok: false as const, result: u });
  // The common dates must reach both ends of the window, or the regression would describe a different period from the one asked for.
  if (aligned.a.length === 0 || daysBetweenIso(sel.actual.start, aligned.a[0].date) > ctx.policy.boundaryLookupDays || daysBetweenIso(aligned.a[aligned.a.length - 1].date, sel.actual.end) > ctx.policy.boundaryLookupDays) {
    return fail(unavailable('benchmark_missing', 'benchmark_history_incomplete', 'Benchmark data unavailable: the benchmark has no published levels on the same dates across this whole period.', makeProvenance(ctx, metricId, extras), disclosures));
  }
  const cont = checkContinuity(schemeReturns, frequency, ctx.policy);
  if (!cont.ok) {
    return fail(lackOfHistory(series, ctx, metricId, cont.reason, continuityDetail(ctx, cont, frequency), extras, disclosures));
  }
  if (schemeReturns.length < ctx.policy.minimums.betaAlphaReturns) {
    // Enough scheme history but too little shared with the benchmark is the benchmark's gap, not the scheme's.
    const schemeReturnCount = buildReturns(resampleObservations(sel.obs, frequency)).length;
    if (schemeReturnCount >= ctx.policy.minimums.betaAlphaReturns) {
      return fail(unavailable('benchmark_missing', 'benchmark_overlap_insufficient', `Benchmark data unavailable: only ${schemeReturns.length} returns share dates with the benchmark; ${ctx.policy.minimums.betaAlphaReturns} are needed.`, makeProvenance(ctx, metricId, extras), disclosures));
    }
    return fail(lackOfHistory(series, ctx, metricId, 'too_few_returns', `At least ${ctx.policy.minimums.betaAlphaReturns} ${frequency} returns are needed for this measure; this period has ${schemeReturns.length}.`, extras, disclosures));
  }
  return { ok: true, sel, schemeReturns, benchmarkReturns, extras, disclosures };
}

export interface BetaValue {
  beta: number;
  commonReturnCount: number;
  frequency: ReturnFrequency;
  benchmarkLabel: string;
  benchmarkBasisLabel: string;
}

export function beta(
  series: PreparedSeries,
  ctx: Nav2Context,
  benchmarks: readonly Nav2BenchmarkInput[] | undefined,
  window: Window = { start: null, end: null },
  frequency: ReturnFrequency = 'daily'
): Nav2Result<BetaValue> {
  const a = alignedBenchmarkReturns(series, ctx, 'beta', benchmarks, window, frequency);
  if (!a.ok) return a.result;
  const f = a.schemeReturns.map((r) => r.simple);
  const b = a.benchmarkReturns.map((r) => r.simple);
  const prov = makeProvenance(ctx, 'beta', a.extras);
  if (!(sampleStdDev(b) > ctx.policy.zeroVarianceEpsilon)) {
    return unavailable('not_applicable', 'zero_benchmark_variance', 'The benchmark did not move over this period, so beta is not defined.', prov, a.disclosures);
  }
  const r = r4Beta(f, b);
  if (r.status !== 'ok' || !r.value) {
    return unavailable('not_applicable', 'zero_benchmark_variance', 'Beta could not be calculated for this period.', prov, a.disclosures);
  }
  const disclosures = [...a.disclosures];
  const bp = belowPreferred(f.length, ctx.policy.minimums.betaAlphaPreferredReturns);
  if (bp) disclosures.push(bp);
  const bench = a.extras.benchmark!;
  return available({ beta: r.value.beta, commonReturnCount: f.length, frequency, benchmarkLabel: bench.label, benchmarkBasisLabel: bench.basisLabel }, prov, disclosures);
}

export interface JensenAlphaValue {
  beta: number;
  commonReturnCount: number;
  frequency: ReturnFrequency;
  meanSchemeReturn: number;
  meanBenchmarkReturn: number;
  /** Mean of the matched per-interval risk-free returns. */
  meanRiskFreeReturn: number;
  /** mean(r_s) - [rf + beta x (mean(r_b) - rf)], per period. */
  alphaPeriodic: number;
  /** alphaPeriodic x periodsPerYear: the declared ARITHMETIC annualisation. */
  alphaAnnualised: number;
  annualisationConvention: 'arithmetic_periodic_alpha_times_periods_per_year';
  benchmarkLabel: string;
  benchmarkBasisLabel: string;
}

export function jensenAlpha(
  series: PreparedSeries,
  ctx: Nav2Context,
  benchmarks: readonly Nav2BenchmarkInput[] | undefined,
  riskFree: RiskFreeSupply,
  window: Window = { start: null, end: null },
  frequency: ReturnFrequency = 'daily'
): Nav2Result<JensenAlphaValue> {
  const a = alignedBenchmarkReturns(series, ctx, 'jensen_alpha', benchmarks, window, frequency);
  if (!a.ok) return a.result;
  const f = a.schemeReturns.map((r) => r.simple);
  const b = a.benchmarkReturns.map((r) => r.simple);
  const baseProv = makeProvenance(ctx, 'jensen_alpha', a.extras);
  // Alpha is never shown when beta is unavailable.
  const betaResult = beta(series, ctx, benchmarks, window, frequency);
  if (betaResult.state !== 'available') return propagateUnavailable(betaResult, baseProv);
  const rf = matchRiskFree(a.schemeReturns, riskFree, ctx, 'jensen_alpha', a.extras, frequency);
  if (!rf.ok) return rf.result;
  const prov = makeProvenance(ctx, 'jensen_alpha', { ...a.extras, riskFree: rf.provenance, convention: { ...a.extras.convention, alpha: 'jensen_single_factor', alphaAnnualisation: ctx.policy.conventions.alphaAnnualisation, riskFreeConversion: ctx.policy.conventions.riskFreeConversion } });
  const rfBar = mean(rf.periodic);
  const alphaPeriodic = mean(f) - (rfBar + betaResult.value.beta * (mean(b) - rfBar));
  const ppy = ctx.policy.periodsPerYear[frequency];
  const bench = a.extras.benchmark!;
  const disclosures = [...a.disclosures, ...rf.disclosures];
  const bp = belowPreferred(f.length, ctx.policy.minimums.betaAlphaPreferredReturns);
  if (bp) disclosures.push(bp);
  return available(
    {
      beta: betaResult.value.beta,
      commonReturnCount: f.length,
      frequency,
      meanSchemeReturn: mean(f),
      meanBenchmarkReturn: mean(b),
      meanRiskFreeReturn: rfBar,
      alphaPeriodic,
      alphaAnnualised: alphaPeriodic * ppy,
      annualisationConvention: 'arithmetic_periodic_alpha_times_periods_per_year',
      benchmarkLabel: bench.label,
      benchmarkBasisLabel: bench.basisLabel,
    },
    prov,
    disclosures
  );
}

// ---------------------------------------------------------------------------
// Correlation between HELD schemes (8.16)
// ---------------------------------------------------------------------------

export interface CorrelationValue {
  correlation: number;
  commonReturnCount: number;
  frequency: ReturnFrequency;
  windowStart: string;
  windowEnd: string;
  /** Always 'returns': NAV levels are never correlated. */
  correlatedSeries: 'periodic_simple_returns';
}

function pearson(x: readonly number[], y: readonly number[], epsilon: number): number | null {
  const sdx = sampleStdDev([...x]);
  const sdy = sampleStdDev([...y]);
  if (!(sdx > epsilon) || !(sdy > epsilon)) return null;
  const mx = mean([...x]);
  const my = mean([...y]);
  let cov = 0;
  for (let i = 0; i < x.length; i++) cov += (x[i] - mx) * (y[i] - my);
  cov /= x.length - 1;
  return cov / (sdx * sdy);
}

/**
 * Pearson correlation of aligned periodic RETURNS between two schemes. Both must be in `heldInstrumentIds`
 * (the caller passes the household's own held set): a scheme outside it is `not_applicable`, so this can never
 * become a way to correlate arbitrary funds.
 */
export function correlationBetweenHeldSchemes(
  a: PreparedSeries,
  b: PreparedSeries,
  ctx: Nav2Context,
  heldInstrumentIds: ReadonlySet<string>,
  window: Window = { start: null, end: null },
  frequency: ReturnFrequency = 'daily'
): Nav2Result<CorrelationValue> {
  const baseExtras: ProvenanceExtras = {
    instrumentId: a.identity.instrumentId,
    requested: window,
    navSeries: seriesProvenanceBlock(a),
    convention: { frequency, correlatedSeries: 'periodic_simple_returns', alignment: 'common_dates_only', pairedInstrumentId: b.identity.instrumentId },
  };
  if (!heldInstrumentIds.has(a.identity.instrumentId) || !heldInstrumentIds.has(b.identity.instrumentId)) {
    return unavailable('not_applicable', 'scheme_not_held_in_scope', 'Correlation is only shown between schemes you hold.', makeProvenance(ctx, 'correlation', baseExtras));
  }
  for (const s of [a, b]) {
    const g = guardSeries(s, ctx, 'correlation', baseExtras);
    if (g) return g;
  }
  const selA = selectWindow(a, ctx, 'correlation', window, baseExtras);
  if (!isSelectedWindow(selA)) return selA;
  const selB = selectWindow(b, ctx, 'correlation', window, baseExtras);
  if (!isSelectedWindow(selB)) return selB;
  const aligned = alignOnCommonDates(resampleObservations(selA.obs, frequency), resampleObservations(selB.obs, frequency));
  const ra = buildReturns(aligned.a);
  const rb = buildReturns(aligned.b);
  const start = aligned.a.length ? aligned.a[0].date : selA.actual.start;
  const end = aligned.a.length ? aligned.a[aligned.a.length - 1].date : selA.actual.end;
  const extras: ProvenanceExtras = { ...baseExtras, actual: { start, end }, observationCount: ra.length };
  const cont = checkContinuity(ra, frequency, ctx.policy);
  if (!cont.ok) return lackOfHistory(a, ctx, 'correlation', cont.reason, continuityDetail(ctx, cont, frequency), extras, [...selA.disclosures, ...selB.disclosures]);
  if (ra.length < ctx.policy.minimums.correlationReturns) {
    return lackOfHistory(a, ctx, 'correlation', 'too_few_returns', `At least ${ctx.policy.minimums.correlationReturns} returns on shared dates are needed; these two schemes share ${ra.length}.`, extras, [...selA.disclosures, ...selB.disclosures]);
  }
  const prov = makeProvenance(ctx, 'correlation', extras);
  const rho = pearson(ra.map((r) => r.simple), rb.map((r) => r.simple), ctx.policy.zeroVarianceEpsilon);
  if (rho === null) {
    return unavailable('not_applicable', 'zero_variance', 'One of the schemes did not change in price over this period, so correlation is not defined.', prov, [...selA.disclosures, ...selB.disclosures]);
  }
  const disclosures = [...selA.disclosures, ...selB.disclosures];
  if (ra.length < ctx.policy.minimums.correlationDisclosureBelowReturns) {
    disclosures.push({ code: 'below_preferred_observations', detail: `Only ${ra.length} returns are shared between these two schemes (fewer than ${ctx.policy.minimums.correlationDisclosureBelowReturns}); treat this correlation with caution.` });
  }
  return available({ correlation: rho, commonReturnCount: ra.length, frequency, windowStart: start, windowEnd: end, correlatedSeries: 'periodic_simple_returns' }, prov, disclosures);
}

