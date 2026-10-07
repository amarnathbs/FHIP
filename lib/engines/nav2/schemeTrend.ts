// NAV2 -- scheme-performance TREND and DESCRIPTIVE statistics (spec 8.13 - 8.15,
// 8.18, 8.19). Family: scheme_performance. Pure and deterministic.
//
// Periods for SMA, EMA and ROC are counts of valid OBSERVATIONS, not calendar
// days, and every result says so. The averages are computed over the prepared
// series (so the warm-up uses the history before the requested window - exactly
// the data the Phase B planner asks for) and only points inside the requested
// window are returned. Nothing is shown before the warm-up is met.

import { mean } from '@/lib/engines/investment-intelligence/riskMetrics';
import { median } from '@/lib/engines/investment-intelligence/rollingReturns';
import { daysBetweenIso } from './dates';
import { guardSeries, isSelectedWindow, lackOfHistory, selectWindow, seriesProvenanceBlock, type PreparedSeries, type Window } from './series';
import {
  available,
  makeProvenance,
  unavailable,
  type Disclosure,
  type Nav2Context,
  type Nav2Result,
  type ProvenanceExtras,
} from './types';
import type { Nav2MetricId } from '@/lib/config/nav2/metricPolicy';

export interface TrendPoint {
  date: string;
  value: number;
}

export interface TrendValue {
  /** N, in valid observations (never calendar days). */
  period: number;
  basis: 'observations';
  points: TrendPoint[];
  latest: TrendPoint;
  pointCount: number;
  /** First date at which the measure is defined anywhere in the series (the warm-up is met from here). */
  firstDefinedDate: string;
}

function trend(
  series: PreparedSeries,
  ctx: Nav2Context,
  metricId: Extract<Nav2MetricId, 'sma' | 'ema' | 'roc'>,
  period: number,
  window: Window,
  firstIndex: number,
  compute: (i: number) => number,
  convention: Record<string, string | number | boolean | null>
): Nav2Result<TrendValue> {
  const extras: ProvenanceExtras = { instrumentId: series.identity.instrumentId, requested: window, navSeries: seriesProvenanceBlock(series), convention: { period, basis: 'observations', ...convention } };
  const guard = guardSeries(series, ctx, metricId, extras);
  if (guard) return guard;
  const obs = series.observations;
  const outStart = window.start ?? obs[0].date;
  const outEnd = window.end ?? obs[obs.length - 1].date;
  if (outStart > outEnd) return unavailable('not_applicable', 'invalid_dates', 'The requested period is not a valid date range.', makeProvenance(ctx, metricId, extras));
  const points: TrendPoint[] = [];
  let firstOut = -1;
  for (let i = firstIndex; i < obs.length; i++) {
    if (obs[i].date < outStart || obs[i].date > outEnd) continue;
    if (firstOut < 0) firstOut = i;
    points.push({ date: obs[i].date, value: compute(i) });
  }
  if (points.length === 0) {
    const need = metricId === 'roc' ? period + 1 : period;
    return lackOfHistory(series, ctx, metricId, 'too_few_observations', `${metricId.toUpperCase()} over ${period} observations needs at least ${need} prices before the end of the period; ${obs.length} ${obs.length === 1 ? 'is' : 'are'} available.`, { ...extras, observationCount: obs.length });
  }
  // A quarantined date inside the observations that feed the points would silently shorten the lookback.
  const usedFrom = obs[Math.max(0, firstOut - (metricId === 'roc' ? period : period - 1))].date;
  const actual = { start: points[0].date, end: points[points.length - 1].date };
  if (series.conflictingDates.some((d) => d >= usedFrom && d <= (window.end ?? series.asOfDate))) {
    return unavailable('data_quality_hold', 'conflicting_nav_values', 'Price data feeding this measure is under review, so no figure is shown yet.', makeProvenance(ctx, metricId, { ...extras, actual, observationCount: points.length }));
  }
  return available(
    { period, basis: 'observations', points, latest: points[points.length - 1], pointCount: points.length, firstDefinedDate: obs[firstIndex].date },
    makeProvenance(ctx, metricId, { ...extras, actual, observationCount: points.length })
  );
}

function approvedPeriod(series: PreparedSeries, ctx: Nav2Context, metricId: 'sma' | 'ema', period: number, window: Window): Nav2Result<never> | null {
  if (!ctx.policy.movingAveragePeriods.includes(period)) {
    return unavailable('not_applicable', 'unsupported_period', `${period} observations is not an approved ${metricId.toUpperCase()} period (${ctx.policy.movingAveragePeriods.join(', ')}).`, makeProvenance(ctx, metricId, { instrumentId: series.identity.instrumentId, requested: window, convention: { period } }));
  }
  return null;
}

/** SMA_N(t) = mean(P_(t-N+1) ... P_t) over valid observations (8.13). */
export function sma(series: PreparedSeries, ctx: Nav2Context, period: number, window: Window = { start: null, end: null }): Nav2Result<TrendValue> {
  const bad = approvedPeriod(series, ctx, 'sma', period, window);
  if (bad) return bad;
  const obs = series.observations;
  return trend(series, ctx, 'sma', period, window, period - 1, (i) => mean(obs.slice(i - period + 1, i + 1).map((o) => o.value)), { label: 'observations_not_calendar_days' });
}

/**
 * EMA_t = P_t x m + EMA_(t-1) x (1 - m), m = 2 / (N + 1) (8.14). SEED: the simple average of the first N
 * observations, placed at the N-th observation; no EMA exists before it.
 */
export function ema(series: PreparedSeries, ctx: Nav2Context, period: number, window: Window = { start: null, end: null }): Nav2Result<TrendValue> {
  const bad = approvedPeriod(series, ctx, 'ema', period, window);
  if (bad) return bad;
  const obs = series.observations;
  const m = 2 / (period + 1);
  // Computed in one pass up front; the closure only reads the result.
  const values: number[] = [];
  if (obs.length >= period) {
    let prev = mean(obs.slice(0, period).map((o) => o.value));
    values[period - 1] = prev;
    for (let i = period; i < obs.length; i++) {
      prev = obs[i].value * m + prev * (1 - m);
      values[i] = prev;
    }
  }
  return trend(series, ctx, 'ema', period, window, period - 1, (i) => values[i], { label: 'observations_not_calendar_days', multiplier: m, seed: 'sma_of_first_n_observations' });
}

/** ROC_N(t) = P_t / P_(t-N) - 1, N valid observations (8.15). */
export function roc(series: PreparedSeries, ctx: Nav2Context, period: number, window: Window = { start: null, end: null }): Nav2Result<TrendValue> {
  if (!Number.isInteger(period) || period < 1 || period > ctx.policy.rocMaxPeriod) {
    return unavailable('not_applicable', 'unsupported_period', `Rate of change needs a whole number of observations from 1 to ${ctx.policy.rocMaxPeriod}.`, makeProvenance(ctx, 'roc', { instrumentId: series.identity.instrumentId, requested: window, convention: { period } }));
  }
  const obs = series.observations;
  return trend(series, ctx, 'roc', period, window, period, (i) => obs[i].value / obs[i - period].value - 1, { label: 'observations_not_calendar_days' });
}

// ---------------------------------------------------------------------------
// Highest / lowest NAV (8.18) and mean / median NAV (8.19)
// ---------------------------------------------------------------------------

export interface NavExtremesValue {
  highestNav: number;
  /** The EARLIEST date on which the highest NAV occurred. */
  highestNavDate: string;
  lowestNav: number;
  lowestNavDate: string;
  observationCount: number;
  periodStart: string;
  periodEnd: string;
}

const LEVEL_NOT_COMPARABLE: Disclosure = {
  code: 'not_a_recommendation',
  detail: 'NAV levels cannot be compared between schemes, and a lower NAV does not mean a cheaper or better fund.',
};

export function navExtremes(series: PreparedSeries, ctx: Nav2Context, window: Window = { start: null, end: null }): Nav2Result<NavExtremesValue> {
  const extras: ProvenanceExtras = { instrumentId: series.identity.instrumentId, requested: window, navSeries: seriesProvenanceBlock(series), convention: { tie: ctx.policy.conventions.highLowTie } };
  const guard = guardSeries(series, ctx, 'nav_extremes', extras);
  if (guard) return guard;
  const sel = selectWindow(series, ctx, 'nav_extremes', window, extras);
  if (!isSelectedWindow(sel)) return sel;
  let hi = sel.obs[0];
  let lo = sel.obs[0];
  for (const o of sel.obs) {
    if (o.value > hi.value) hi = o; // strict: the earliest occurrence of the maximum stays
    if (o.value < lo.value) lo = o;
  }
  return available(
    { highestNav: hi.value, highestNavDate: hi.date, lowestNav: lo.value, lowestNavDate: lo.date, observationCount: sel.obs.length, periodStart: sel.actual.start, periodEnd: sel.actual.end },
    makeProvenance(ctx, 'nav_extremes', { ...extras, actual: sel.actual, observationCount: sel.obs.length }),
    [...sel.disclosures, LEVEL_NOT_COMPARABLE]
  );
}

export interface NavAverageValue {
  meanNav: number;
  medianNav: number;
  observationCount: number;
  /** 'daily' when the median gap between observations is at most 3 calendar days, otherwise 'irregular'. */
  observationFrequency: 'daily' | 'irregular';
  periodStart: string;
  periodEnd: string;
}

export function navAverage(series: PreparedSeries, ctx: Nav2Context, window: Window = { start: null, end: null }): Nav2Result<NavAverageValue> {
  const extras: ProvenanceExtras = { instrumentId: series.identity.instrumentId, requested: window, navSeries: seriesProvenanceBlock(series), convention: { statistic: 'descriptive_not_a_return', median: 'mean_of_two_middle_values_for_even_count' } };
  const guard = guardSeries(series, ctx, 'nav_average', extras);
  if (guard) return guard;
  const sel = selectWindow(series, ctx, 'nav_average', window, extras);
  if (!isSelectedWindow(sel)) return sel;
  const values = sel.obs.map((o) => o.value);
  const gaps: number[] = [];
  for (let i = 1; i < sel.obs.length; i++) gaps.push(daysBetweenIso(sel.obs[i - 1].date, sel.obs[i].date));
  const frequency: NavAverageValue['observationFrequency'] = gaps.length > 0 && median(gaps) <= 3 ? 'daily' : 'irregular';
  return available(
    { meanNav: mean(values), medianNav: median(values), observationCount: values.length, observationFrequency: frequency, periodStart: sel.actual.start, periodEnd: sel.actual.end },
    makeProvenance(ctx, 'nav_average', { ...extras, actual: sel.actual, observationCount: values.length }),
    [...sel.disclosures, LEVEL_NOT_COMPARABLE]
  );
}
