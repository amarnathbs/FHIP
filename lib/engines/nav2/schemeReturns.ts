// NAV2 -- scheme-performance RETURNS (spec 8.1 - 8.6). Family: scheme_performance.
// These describe the fund's own NAV series. They never read the user's
// contribution dates or amounts (spec 2.1) and are never labelled as the user's
// personal return (spec 2.2) - the investor's XIRR lives in investorExperience.ts.
//
// Every function: guard (identity / currency) -> boundary or window -> arithmetic
// -> typed result with provenance and disclosures. No NAV is ever interpolated;
// a boundary uses the latest valid NAV on or before the requested date within the
// policy's boundary lookup window, and says which date it actually used.

import { annualiseGrowth } from '@/lib/engines/investment-intelligence/navReturn';
import { mean } from '@/lib/engines/investment-intelligence/riskMetrics';
import { median } from '@/lib/engines/investment-intelligence/rollingReturns';
import { daysBetweenIso, subtractMonthsIso } from './dates';
import {
  buildReturns,
  coverageGapDisclosures,
  distributionOptionDisclosure,
  guardSeries,
  isDistributionOption,
  isSelectedWindow,
  lackOfHistory,
  navOnOrBefore,
  selectWindow,
  seriesProvenanceBlock,
  type PreparedSeries,
  type ReturnPoint,
  type Window,
} from './series';
import {
  available,
  makeProvenance,
  showDate,
  unavailable,
  type Disclosure,
  type Nav2Context,
  type Nav2Result,
  type ProvenanceExtras,
} from './types';
import type { Nav2MetricId } from '@/lib/config/nav2/metricPolicy';

// ---------------------------------------------------------------------------
// Point-to-point (8.1, 8.2, 8.6)
// ---------------------------------------------------------------------------

export interface PointToPointValue {
  requestedStart: string;
  requestedEnd: string;
  /** The NAV dates actually used (the previous valid NAV on or before each requested date). */
  startDate: string;
  endDate: string;
  startNav: number;
  endNav: number;
  /** Calendar days between the two NAV dates actually used. */
  actualDays: number;
  /** Days the requested date is after the NAV date used (0 = exact). A weekend or market holiday gives 1 or more. */
  startOffsetDays: number;
  endOffsetDays: number;
  boundarySubstituted: boolean;
  absoluteReturn: number;
  /** CAGR on actual elapsed days; null when the period is under cagrMinDays (the absolute return is shown instead). */
  cagr: number | null;
}

function resolvePointToPoint(
  series: PreparedSeries,
  ctx: Nav2Context,
  metricId: Nav2MetricId,
  requestedStart: string,
  requestedEnd: string
): { ok: true; value: PointToPointValue; disclosures: Disclosure[]; extras: ProvenanceExtras } | { ok: false; result: Nav2Result<never> } {
  const requested = { start: requestedStart, end: requestedEnd };
  const extras: ProvenanceExtras = { instrumentId: series.identity.instrumentId, requested, navSeries: seriesProvenanceBlock(series), convention: { daysPerYear: ctx.policy.daysPerYear, boundaryRule: 'previous_valid_nav_within_lookup', boundaryLookupDays: ctx.policy.boundaryLookupDays } };
  const guard = guardSeries(series, ctx, metricId, extras);
  if (guard) return { ok: false, result: guard };
  if (requestedStart >= requestedEnd) {
    return { ok: false, result: unavailable('not_applicable', 'invalid_dates', 'The start of the period must be before its end.', makeProvenance(ctx, metricId, extras)) };
  }
  const look = ctx.policy.boundaryLookupDays;
  const s = navOnOrBefore(series.observations, requestedStart, look);
  const e = navOnOrBefore(series.observations, requestedEnd, look);
  const missing = !s ? requestedStart : !e ? requestedEnd : null;
  if (missing) {
    return { ok: false, result: lackOfHistory(series, ctx, metricId, 'boundary_not_found', `There is no published price on or within ${look} days before ${showDate(ctx, missing)}, so the return for this period is not shown. Nothing has been estimated.`, extras) };
  }
  const startHit = s!;
  const endHit = e!;
  // A quarantined (conflicting) date between the NAV used and the requested date: the substitution would hide it.
  for (const [hit, req] of [[startHit, requestedStart], [endHit, requestedEnd]] as const) {
    if (series.conflictingDates.some((d) => d > hit.obs.date && d <= req)) {
      return { ok: false, result: unavailable('data_quality_hold', 'conflicting_nav_values', 'Price data at one end of this period is under review, so no figure is shown yet.', makeProvenance(ctx, metricId, extras)) };
    }
  }
  if (startHit.obs.date >= endHit.obs.date) {
    return { ok: false, result: lackOfHistory(series, ctx, metricId, 'too_few_observations', 'Both ends of the period resolve to the same published price, so there is no return to show.', extras) };
  }
  if (!(startHit.obs.value > 0) || !(endHit.obs.value > 0)) {
    return { ok: false, result: unavailable('data_quality_hold', 'non_positive_nav', 'A price at one end of the period is not a valid positive value.', makeProvenance(ctx, metricId, extras)) };
  }
  const actualDays = daysBetweenIso(startHit.obs.date, endHit.obs.date);
  const ratio = endHit.obs.value / startHit.obs.value;
  const disclosures: Disclosure[] = [];
  const startSub = startHit.offsetDays > 0;
  const endSub = endHit.offsetDays > 0;
  if (startSub || endSub) {
    const parts: string[] = [];
    if (startSub) parts.push(`the start of ${showDate(ctx, requestedStart)} had no published price, so ${showDate(ctx, startHit.obs.date)} was used`);
    if (endSub) parts.push(`the end of ${showDate(ctx, requestedEnd)} had no published price, so ${showDate(ctx, endHit.obs.date)} was used`);
    disclosures.push({ code: 'boundary_substitution', detail: `Prices are not published every day: ${parts.join('; ')}.` });
  }
  if (isDistributionOption(series.identity)) disclosures.push(distributionOptionDisclosure());
  disclosures.push(...coverageGapDisclosures(series, ctx, startHit.obs.date, endHit.obs.date));
  const cagrShown = actualDays >= ctx.policy.cagrMinDays;
  if (!cagrShown) disclosures.push({ code: 'cagr_not_shown_under_one_year', detail: 'The period is under a year, so the absolute return is shown and no annualised figure is given.' });
  const value: PointToPointValue = {
    requestedStart,
    requestedEnd,
    startDate: startHit.obs.date,
    endDate: endHit.obs.date,
    startNav: startHit.obs.value,
    endNav: endHit.obs.value,
    actualDays,
    startOffsetDays: startHit.offsetDays,
    endOffsetDays: endHit.offsetDays,
    boundarySubstituted: startSub || endSub,
    absoluteReturn: ratio - 1,
    cagr: cagrShown ? annualiseGrowth(ratio, actualDays, ctx.policy.daysPerYear) : null,
  };
  return { ok: true, value, disclosures, extras: { ...extras, actual: { start: value.startDate, end: value.endDate }, observationCount: 2 } };
}

/** Point-to-point return between two requested dates, with the actual NAV dates and any boundary substitution disclosed (8.6). */
export function pointToPointReturn(series: PreparedSeries, ctx: Nav2Context, requestedStart: string, requestedEnd: string): Nav2Result<PointToPointValue> {
  const r = resolvePointToPoint(series, ctx, 'point_to_point', requestedStart, requestedEnd);
  if (!r.ok) return r.result;
  return available(r.value, makeProvenance(ctx, 'point_to_point', r.extras), r.disclosures);
}

export interface AbsoluteReturnValue {
  startDate: string;
  endDate: string;
  startNav: number;
  endNav: number;
  absoluteReturn: number;
  boundarySubstituted: boolean;
}

/** (P1 / P0) - 1 with the latest valid NAV on or before each boundary (8.1). */
export function absoluteReturn(series: PreparedSeries, ctx: Nav2Context, requestedStart: string, requestedEnd: string): Nav2Result<AbsoluteReturnValue> {
  const r = resolvePointToPoint(series, ctx, 'absolute_return', requestedStart, requestedEnd);
  if (!r.ok) return r.result;
  const v = r.value;
  return available(
    { startDate: v.startDate, endDate: v.endDate, startNav: v.startNav, endNav: v.endNav, absoluteReturn: v.absoluteReturn, boundarySubstituted: v.boundarySubstituted },
    makeProvenance(ctx, 'absolute_return', r.extras),
    r.disclosures.filter((d) => d.code !== 'cagr_not_shown_under_one_year')
  );
}

export interface CagrValue {
  startDate: string;
  endDate: string;
  startNav: number;
  endNav: number;
  actualDays: number;
  /** The exponent denominator used: actual elapsed days over 365.2425, never an assumed trading-day count. */
  yearsElapsed: number;
  cagr: number;
  /** Always 'scheme_nav_series': this is the fund's own growth, not the investor's return. */
  basis: 'scheme_nav_series';
}

/** (P1 / P0) ^ (365.2425 / actualDays) - 1 (8.2). Under one year it is `not_applicable` and the absolute return is the figure to show. */
export function cagr(series: PreparedSeries, ctx: Nav2Context, requestedStart: string, requestedEnd: string): Nav2Result<CagrValue> {
  const r = resolvePointToPoint(series, ctx, 'cagr', requestedStart, requestedEnd);
  if (!r.ok) return r.result;
  const v = r.value;
  const prov = makeProvenance(ctx, 'cagr', r.extras);
  if (v.cagr === null) {
    return unavailable('not_applicable', 'period_under_one_year', 'CAGR is shown for periods of a year or more. For this shorter period the absolute return is shown instead.', prov, r.disclosures);
  }
  return available(
    { startDate: v.startDate, endDate: v.endDate, startNav: v.startNav, endNav: v.endNav, actualDays: v.actualDays, yearsElapsed: v.actualDays / ctx.policy.daysPerYear, cagr: v.cagr, basis: 'scheme_nav_series' },
    prov,
    r.disclosures
  );
}

// ---------------------------------------------------------------------------
// Daily simple and log returns (8.3, 8.4)
// ---------------------------------------------------------------------------

export interface DailyReturnRow extends ReturnPoint {
  /** The interval is wider than the policy's material gap: it spans missing data, not one trading step. */
  spansMaterialGap: boolean;
}

export interface DailyReturnsValue {
  returns: DailyReturnRow[];
  count: number;
  /** product(1 + r) - 1. */
  cumulativeSimpleReturn: number;
  /** exp(sum of log returns) - 1: log returns are converted back, never added up and shown as a percentage. */
  cumulativeFromLogReturns: number;
  intervalBasis: 'consecutive_valid_observations';
}

/** Returns between consecutive valid observations in the window; never synthetic calendar days. Needs 2 observations. */
export function dailyReturns(series: PreparedSeries, ctx: Nav2Context, window: Window = { start: null, end: null }): Nav2Result<DailyReturnsValue> {
  const extras: ProvenanceExtras = { instrumentId: series.identity.instrumentId, requested: window, navSeries: seriesProvenanceBlock(series), convention: { intervals: 'consecutive_valid_observations', logDefinition: NAV2_LOG_DEFINITION } };
  const guard = guardSeries(series, ctx, 'daily_simple_return', extras);
  if (guard) return guard;
  const sel = selectWindow(series, ctx, 'daily_simple_return', window, extras);
  if (!isSelectedWindow(sel)) return sel;
  const prov = (n: number) => makeProvenance(ctx, 'daily_simple_return', { ...extras, actual: sel.actual, observationCount: n });
  if (sel.obs.length < ctx.policy.minimums.dailyReturnObservations) {
    return lackOfHistory(series, ctx, 'daily_simple_return', 'too_few_observations', `At least ${ctx.policy.minimums.dailyReturnObservations} prices are needed to form a return.`, { ...extras, actual: sel.actual, observationCount: sel.obs.length });
  }
  const rows: DailyReturnRow[] = buildReturns(sel.obs).map((r) => ({ ...r, spansMaterialGap: r.intervalDays > ctx.policy.materialGapDays }));
  const disclosures = [...sel.disclosures];
  const spanning = rows.filter((r) => r.spansMaterialGap);
  if (spanning.length > 0) {
    disclosures.push({ code: 'material_gap_disclosed', detail: `${spanning.length} of these returns span a gap of more than ${ctx.policy.materialGapDays} days in the published prices (first: ${showDate(ctx, spanning[0].startDate)} to ${showDate(ctx, spanning[0].date)}). They are marked and nothing has been filled in.` });
  }
  return available(
    {
      returns: rows,
      count: rows.length,
      cumulativeSimpleReturn: rows.reduce((acc, r) => acc * (1 + r.simple), 1) - 1,
      cumulativeFromLogReturns: Math.exp(rows.reduce((acc, r) => acc + r.log, 0)) - 1,
      intervalBasis: 'consecutive_valid_observations',
    },
    prov(rows.length),
    disclosures
  );
}

const NAV2_LOG_DEFINITION = 'nav2-daily-log-return-v1';

// ---------------------------------------------------------------------------
// Rolling returns (8.5)
// ---------------------------------------------------------------------------

export interface RollingWindowRow {
  endDate: string;
  startDate: string;
  startNav: number;
  endNav: number;
  /** Absolute return under the annualise threshold, CAGR at or above it (see `measure`). */
  value: number;
}

export interface RollingSummary {
  min: number;
  max: number;
  mean: number;
  median: number;
  /** Share of windows with a return above zero, 0 to 1. */
  positiveWindowShare: number;
}

export interface RollingReturnValue {
  horizonId: string;
  horizonMonths: number;
  measure: 'absolute' | 'annualised_cagr';
  observationFrequency: 'one_window_per_available_daily_observation';
  firstEndpoint: string;
  lastEndpoint: string;
  windowCount: number;
  endpointsConsidered: number;
  /** End dates BEFORE the first complete window: the history simply does not reach back a full horizon yet. Not a gap. */
  endpointsBeforeFirstWindow: number;
  /** End dates AFTER the first complete window that have no NAV on or before (end - horizon) within the lookup window: a gap in the data, skipped, never interpolated. */
  endpointsSkippedInside: number;
  /** 'partial' when any endpoint inside the series was skipped for lack of a start NAV. */
  completeness: 'complete' | 'partial';
  /** null until there are materially more windows than one (policy.minimums.rollingSummaryMinWindows). */
  summary: RollingSummary | null;
  windows?: RollingWindowRow[];
}

/**
 * For every eligible end date t in the window: the latest valid NAV on or before (t - horizon), then the
 * absolute or annualised return between the two. A single trailing return is point-to-point, not rolling;
 * the summary statistics are withheld until the window count is materially larger than one.
 */
export function rollingReturn(
  series: PreparedSeries,
  ctx: Nav2Context,
  horizonId: string,
  window: Window = { start: null, end: null },
  opts: { includeWindows?: boolean } = {}
): Nav2Result<RollingReturnValue> {
  const horizon = ctx.policy.rollingHorizons.find((h) => h.id === horizonId);
  const extras: ProvenanceExtras = { instrumentId: series.identity.instrumentId, requested: window, navSeries: seriesProvenanceBlock(series), convention: { horizonId, horizonMonths: horizon?.months ?? null, startRule: 'latest_valid_nav_on_or_before_end_minus_horizon', daysPerYear: ctx.policy.daysPerYear } };
  const guard = guardSeries(series, ctx, 'rolling_return', extras);
  if (guard) return guard;
  if (!horizon) {
    return unavailable('not_applicable', 'unsupported_period', `Rolling horizon ${horizonId} is not an approved horizon.`, makeProvenance(ctx, 'rolling_return', extras));
  }
  const sel = selectWindow(series, ctx, 'rolling_return', window, extras);
  if (!isSelectedWindow(sel)) return sel;
  const look = ctx.policy.boundaryLookupDays;
  const annualise = horizon.months >= ctx.policy.rollingAnnualiseFromMonths;
  const windows: RollingWindowRow[] = [];
  let skippedBefore = 0;
  let skippedInside = 0;
  for (const end of sel.obs) {
    const target = subtractMonthsIso(end.date, horizon.months);
    const hit = navOnOrBefore(series.observations, target, look);
    if (!hit || hit.obs.date >= end.date || series.conflictingDates.some((d) => d > hit.obs.date && d <= target)) {
      if (windows.length === 0) skippedBefore++;
      else skippedInside++;
      continue;
    }
    const days = daysBetweenIso(hit.obs.date, end.date);
    const ratio = end.value / hit.obs.value;
    windows.push({
      endDate: end.date,
      startDate: hit.obs.date,
      startNav: hit.obs.value,
      endNav: end.value,
      value: annualise ? annualiseGrowth(ratio, days, ctx.policy.daysPerYear) : ratio - 1,
    });
  }
  const outExtras: ProvenanceExtras = { ...extras, actual: sel.actual, observationCount: windows.length };
  if (windows.length < ctx.policy.minimums.rollingMinWindows) {
    return lackOfHistory(series, ctx, 'rolling_return', 'too_few_observations', `The ${horizon.id} rolling return needs at least one complete ${horizon.id} window inside the period; there is not enough price history yet.`, outExtras, sel.disclosures);
  }
  const values = windows.map((w) => w.value);
  const disclosures = [...sel.disclosures];
  let summary: RollingSummary | null = null;
  if (windows.length >= ctx.policy.minimums.rollingSummaryMinWindows) {
    summary = { min: Math.min(...values), max: Math.max(...values), mean: mean(values), median: median(values), positiveWindowShare: values.filter((v) => v > 0).length / values.length };
  } else {
    disclosures.push({ code: 'rolling_summary_withheld', detail: `Only ${windows.length} rolling window${windows.length === 1 ? '' : 's'} fit${windows.length === 1 ? 's' : ''} in this period; summary figures need at least ${ctx.policy.minimums.rollingSummaryMinWindows}, so they are not shown.` });
  }
  return available(
    {
      horizonId: horizon.id,
      horizonMonths: horizon.months,
      measure: annualise ? 'annualised_cagr' : 'absolute',
      observationFrequency: 'one_window_per_available_daily_observation',
      firstEndpoint: windows[0].endDate,
      lastEndpoint: windows[windows.length - 1].endDate,
      windowCount: windows.length,
      endpointsConsidered: sel.obs.length,
      endpointsBeforeFirstWindow: skippedBefore,
      endpointsSkippedInside: skippedInside,
      completeness: skippedInside === 0 ? 'complete' : 'partial',
      summary,
      ...(opts.includeWindows ? { windows } : {}),
    },
    makeProvenance(ctx, 'rolling_return', outExtras),
    disclosures
  );
}
