// NAV2 -- canonical series preparation (spec section 7) and the shared window,
// return and alignment primitives every metric builds on. Pure and
// deterministic: no I/O, no clock (the as-of date is an argument).
//
// PREPARATION RULES (spec 6, 7), each with a named test:
//   1. only rows for THIS instrument (a foreign instrument id is rejected: no
//      cross-series contamination, e.g. a regular-plan row in a direct-plan series);
//   2. only rows in the series' own currency;
//   3. a valid calendar date, never later than the as-of date (no future NAV);
//   4. a finite price > 0 (a zero or negative NAV is a data fault, never a value);
//   5. quality_status null/'ok' only (stale, suspicious_jump, superseded excluded -
//      the SAME eligibility the certified valuation rule uses);
//   6. one effective value per date by correction lineage: a row that has been
//      superseded, or that another row names as correction_of, is replaced; exact
//      duplicates collapse; two DIFFERENT effective values for one date are a
//      conflict that is QUARANTINED (the date is withheld and any metric whose
//      window contains it answers `data_quality_hold`);
//   7. ascending by date, never forward-filled, never interpolated.
//
// The series records its first and last observation, the count, the material
// gaps and a content checksum, so a result can name exactly what it rested on.

import { fingerprintInputs } from '@/lib/engines/investment-intelligence/analyticsVersioning';
import { isNavQualityEligible } from '@/lib/engines/investment-intelligence/valuation/currentHoldingValuation';
import { resolveObservationAsOf, type Observation } from '@/lib/engines/investment-intelligence/sip/dateAlignment';
import { toMonthEndSeries } from '@/lib/engines/investment-intelligence/rollingReturnService';
import type { IiOptionType, IiPlanType } from '@/lib/services/investment-intelligence/types';
import type { Nav2Policy, ReturnFrequency } from '@/lib/config/nav2/metricPolicy';
import { daysBetweenIso, isValidIsoDate, isoWeekKey, weekdayCount } from './dates';
import {
  makeProvenance,
  showDate,
  unavailable,
  type Disclosure,
  type Nav2Context,
  type Nav2Provenance,
  type Nav2Reason,
  type Nav2Unavailable,
  type ProvenanceExtras,
} from './types';
import type { Nav2MetricId } from '@/lib/config/nav2/metricPolicy';

/** One NAV observation: `date` is ISO yyyy-mm-dd, `value` is the NAV. (The R5 Observation shape, so the R5 lookup is reused as is.) */
export type NavObservation = Observation;

export interface RawNavRow {
  id?: string | null;
  instrumentId: string;
  priceDate: string;
  /** numeric(24,10) arrives from Postgres as a string; both are accepted and parsed at this boundary. */
  price: number | string;
  currencyCode: string | null;
  qualityStatus?: string | null;
  supersededById?: string | null;
  correctionOfId?: string | null;
  recordChecksum?: string | null;
  provider?: string | null;
  dataVersion?: string | null;
}

/** What the series IS. A scheme is identified by its canonical instrument; plan and option are properties of that instrument and are never inferred from a name. */
export interface SeriesIdentity {
  instrumentId: string;
  /** The series' own currency (INR for an Indian mutual fund). */
  currency: string;
  planType?: IiPlanType | null;
  optionType?: IiOptionType | null;
  /** False = the statement could not be resolved to exactly this instrument (fail closed: every metric answers `identity_unresolved`). */
  resolved: boolean;
  schemeName?: string | null;
}

export interface CoverageGapInput {
  from: string;
  to: string;
  reasonCode: string;
}

export type RowRejectReason = 'foreign_instrument' | 'impossible_date' | 'future_dated' | 'currency_mismatch' | 'invalid_price' | 'quality_not_ok';

export interface PrepareArgs {
  identity: SeriesIdentity;
  /** The calculation date (ISO). A NAV dated after it is never used. */
  asOfDate: string;
  rows: readonly RawNavRow[];
  /** True while this fund's history is still being fetched: a lack of history is then `history_hydrating`, not `insufficient_history`. */
  hydrating?: boolean;
  /** Confirmed unrecoverable source gaps (ii_nav_source_coverage_gaps) - disclosed when they fall inside a window. */
  knownCoverageGaps?: readonly CoverageGapInput[];
}

export interface SeriesGap {
  from: string;
  to: string;
  days: number;
}

export interface PreparedSeries {
  identity: SeriesIdentity;
  asOfDate: string;
  hydrating: boolean;
  observations: NavObservation[];
  firstDate: string | null;
  lastDate: string | null;
  count: number;
  /** Counts only, by reason; the rows themselves are not retained. */
  rejected: Record<RowRejectReason, number>;
  /** Rows replaced by a correction (or by lineage); informational. */
  supersededCount: number;
  /** Dates with two different effective values and no correction lineage: withheld. */
  conflictingDates: string[];
  /** Consecutive observations further apart than policy.materialGapDays. */
  gaps: SeriesGap[];
  /** Observations / Monday-to-Friday days in [first, last]. Informational: it knows no market holidays. */
  weekdayCoverageRatio: number | null;
  knownCoverageGaps: CoverageGapInput[];
  /** Content fingerprint of the effective observations (instrument, currency, date and NAV). Changes if and only if the effective series changes. */
  checksum: string;
}

export function parseNav(price: number | string): number {
  return typeof price === 'number' ? price : Number(price);
}

export function prepareSeries(args: PrepareArgs, policy: Nav2Policy): PreparedSeries {
  const { identity } = args;
  const rejected: Record<RowRejectReason, number> = {
    foreign_instrument: 0,
    impossible_date: 0,
    future_dated: 0,
    currency_mismatch: 0,
    invalid_price: 0,
    quality_not_ok: 0,
  };

  // Lineage: a row another row names as the thing it corrects is replaced, even if its own
  // superseded_by_id was never written.
  const replacedIds = new Set<string>();
  for (const r of args.rows) if (r.correctionOfId) replacedIds.add(r.correctionOfId);

  const byDate = new Map<string, number[]>();
  let supersededCount = 0;
  const wantCurrency = identity.currency.toUpperCase();
  for (const r of args.rows) {
    if (r.instrumentId !== identity.instrumentId) {
      rejected.foreign_instrument++;
      continue;
    }
    if (r.supersededById || (r.id && replacedIds.has(r.id))) {
      supersededCount++;
      continue;
    }
    if (!isValidIsoDate(r.priceDate)) {
      rejected.impossible_date++;
      continue;
    }
    if (r.priceDate > args.asOfDate) {
      rejected.future_dated++;
      continue;
    }
    if (!r.currencyCode || r.currencyCode.toUpperCase() !== wantCurrency) {
      rejected.currency_mismatch++;
      continue;
    }
    const price = parseNav(r.price);
    if (!Number.isFinite(price) || price <= 0) {
      rejected.invalid_price++;
      continue;
    }
    if (!isNavQualityEligible(r.qualityStatus)) {
      rejected.quality_not_ok++;
      continue;
    }
    const list = byDate.get(r.priceDate);
    if (list) list.push(price);
    else byDate.set(r.priceDate, [price]);
  }

  const observations: NavObservation[] = [];
  const conflictingDates: string[] = [];
  for (const date of [...byDate.keys()].sort()) {
    const prices = byDate.get(date)!;
    const distinct = new Set(prices);
    if (distinct.size === 1) observations.push({ date, value: prices[0] });
    else conflictingDates.push(date);
  }

  const gaps: SeriesGap[] = [];
  for (let i = 1; i < observations.length; i++) {
    const days = daysBetweenIso(observations[i - 1].date, observations[i].date);
    if (days > policy.materialGapDays) gaps.push({ from: observations[i - 1].date, to: observations[i].date, days });
  }

  const firstDate = observations.length ? observations[0].date : null;
  const lastDate = observations.length ? observations[observations.length - 1].date : null;
  const expected = firstDate && lastDate ? weekdayCount(firstDate, lastDate) : 0;

  return {
    identity,
    asOfDate: args.asOfDate,
    hydrating: args.hydrating === true,
    observations,
    firstDate,
    lastDate,
    count: observations.length,
    rejected,
    supersededCount,
    conflictingDates,
    gaps,
    weekdayCoverageRatio: expected > 0 ? observations.length / expected : null,
    knownCoverageGaps: [...(args.knownCoverageGaps ?? [])],
    checksum: fingerprintInputs([identity.instrumentId, identity.currency, observations.map((o) => [o.date, o.value])]),
  };
}

export function seriesProvenanceBlock(s: PreparedSeries): NonNullable<Nav2Provenance['navSeries']> {
  return { checksum: s.checksum, firstDate: s.firstDate, lastDate: s.lastDate, count: s.count };
}

// ---------------------------------------------------------------------------
// Lack-of-history and guards
// ---------------------------------------------------------------------------

/** `insufficient_history`, or `history_hydrating` while this fund's history is still being fetched. Only for LACK OF DATA, never for a zero-variance or blocked input. */
export function lackOfHistory(
  series: Pick<PreparedSeries, 'hydrating'>,
  ctx: Nav2Context,
  metricId: Nav2MetricId,
  reason: Extract<Nav2Reason, 'window_not_covered' | 'too_few_observations' | 'too_few_returns' | 'boundary_not_found' | 'material_gap_in_window' | 'irregular_return_intervals'>,
  detail: string,
  extras: ProvenanceExtras = {},
  disclosures: Disclosure[] = []
): Nav2Unavailable {
  if (series.hydrating) {
    return unavailable('history_hydrating', 'history_hydrating', 'History is being prepared. No figure is shown until it has loaded.', makeProvenance(ctx, metricId, extras), disclosures);
  }
  return unavailable('insufficient_history', reason, detail, makeProvenance(ctx, metricId, extras), disclosures);
}

/** Identity and currency gates common to every metric. Null = proceed. */
export function guardSeries(series: PreparedSeries, ctx: Nav2Context, metricId: Nav2MetricId, extras: ProvenanceExtras = {}): Nav2Unavailable | null {
  const prov = (): Nav2Provenance => makeProvenance(ctx, metricId, { instrumentId: series.identity.instrumentId, navSeries: seriesProvenanceBlock(series), ...extras });
  if (!series.identity.resolved) {
    return unavailable('identity_unresolved', 'identity_unresolved', 'This scheme could not be matched to exactly one fund, so no analytics are shown for it until it is reviewed.', prov());
  }
  if (series.count === 0) {
    const otherRejects = series.rejected.foreign_instrument + series.rejected.impossible_date + series.rejected.future_dated + series.rejected.invalid_price + series.rejected.quality_not_ok;
    if (series.rejected.currency_mismatch > 0 && otherRejects === 0 && series.conflictingDates.length === 0) {
      return unavailable('currency_mismatch', 'currency_mismatch', 'The price history found for this scheme is in a different currency from the scheme, so it is not used.', prov());
    }
    if (series.conflictingDates.length > 0) {
      return unavailable('data_quality_hold', 'conflicting_nav_values', 'Price data for this scheme is under review, so no figure is shown yet.', prov());
    }
    return lackOfHistory(series, ctx, metricId, 'too_few_observations', 'There is no usable price history for this scheme yet.', { instrumentId: series.identity.instrumentId, navSeries: seriesProvenanceBlock(series), ...extras });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Window selection
// ---------------------------------------------------------------------------

export interface Window {
  /** ISO. null = from the first available observation (then no coverage check is made at the start). */
  start: string | null;
  /** ISO. null = to the last available observation. */
  end: string | null;
}

export interface SelectedWindow {
  obs: NavObservation[];
  requested: { start: string | null; end: string | null };
  actual: { start: string; end: string };
  gapsInWindow: SeriesGap[];
  disclosures: Disclosure[];
}

function overlapsGap(g: CoverageGapInput, start: string, end: string): boolean {
  return g.from <= end && g.to >= start;
}

/**
 * The observations dated inside [start, end] (inclusive), with the coverage rule: a requested boundary that the
 * history does not reach (the first in-window NAV is more than boundaryLookupDays after the requested start, or
 * the last is more than that before the requested end) is `window_not_covered` - never a shorter window
 * presented under the requested label. A conflicting (quarantined) date inside the window is `data_quality_hold`.
 */
export function selectWindow(
  series: PreparedSeries,
  ctx: Nav2Context,
  metricId: Nav2MetricId,
  window: Window,
  extras: ProvenanceExtras = {}
): SelectedWindow | Nav2Unavailable {
  const requested = { start: window.start, end: window.end };
  const base: ProvenanceExtras = { instrumentId: series.identity.instrumentId, requested, navSeries: seriesProvenanceBlock(series), ...extras };
  const start = window.start ?? series.firstDate!;
  const end = window.end ?? series.lastDate!;
  if ((window.start && !isValidIsoDate(window.start)) || (window.end && !isValidIsoDate(window.end)) || start > end) {
    return unavailable('not_applicable', 'invalid_dates', 'The requested period is not a valid date range.', makeProvenance(ctx, metricId, base));
  }
  const obs = series.observations.filter((o) => o.date >= start && o.date <= end);
  if (obs.length === 0) {
    return lackOfHistory(series, ctx, metricId, 'window_not_covered', `No price history falls between ${showDate(ctx, start)} and ${showDate(ctx, end)}.`, base);
  }
  const first = obs[0].date;
  const last = obs[obs.length - 1].date;
  const look = ctx.policy.boundaryLookupDays;
  if (window.start && daysBetweenIso(window.start, first) > look) {
    return lackOfHistory(series, ctx, metricId, 'window_not_covered', `Price history for this scheme starts on ${showDate(ctx, first)}, after the requested start of ${showDate(ctx, window.start)}.`, { ...base, actual: { start: first, end: last } });
  }
  if (window.end && daysBetweenIso(last, window.end) > look) {
    return lackOfHistory(series, ctx, metricId, 'window_not_covered', `The latest price in the period is dated ${showDate(ctx, last)}, before the requested end of ${showDate(ctx, window.end)}.`, { ...base, actual: { start: first, end: last } });
  }
  // A quarantined date anywhere in the REQUESTED period (up to the as-of date for an open end) means the figure
  // would change when it is resolved; checked against the requested bounds, not just the dates that happen to have data.
  const holdLo = window.start ?? first;
  const holdHi = window.end ?? series.asOfDate;
  if (series.conflictingDates.some((d) => d >= holdLo && d <= holdHi)) {
    return unavailable('data_quality_hold', 'conflicting_nav_values', 'Price data inside this period is under review, so no figure is shown yet.', makeProvenance(ctx, metricId, { ...base, actual: { start: first, end: last } }));
  }
  const gapsInWindow = series.gaps.filter((g) => g.from >= first && g.to <= last);
  return { obs, requested, actual: { start: first, end: last }, gapsInWindow, disclosures: coverageGapDisclosures(series, ctx, first, last) };
}

/** Confirmed unrecoverable source gaps that overlap [from, to], as plain disclosures. Nothing is estimated for them. */
export function coverageGapDisclosures(series: Pick<PreparedSeries, 'knownCoverageGaps'>, ctx: Nav2Context, from: string, to: string): Disclosure[] {
  return series.knownCoverageGaps
    .filter((g) => overlapsGap(g, from, to))
    .map((g) => ({
      code: 'unrecoverable_history_period' as const,
      detail: `Price history from ${showDate(ctx, g.from)} to ${showDate(ctx, g.to)} could not be obtained from any approved source; nothing has been estimated for that period.`,
    }));
}

/** Option types whose NAV-only return leaves out the distributions paid (spec 8.2): everything except growth. */
export function isDistributionOption(identity: Pick<SeriesIdentity, 'optionType'>): boolean {
  const o = identity.optionType;
  return o === 'idcw' || o === 'dividend_payout' || o === 'dividend_reinvestment';
}

export function distributionOptionDisclosure(): Disclosure {
  return {
    code: 'nav_only_distribution_option',
    detail: 'This is an IDCW / dividend option. The return shown is from the NAV alone and leaves out the distributions paid, so it can understate what the scheme delivered.',
  };
}

export function isSelectedWindow(x: SelectedWindow | Nav2Unavailable): x is SelectedWindow {
  return (x as Nav2Unavailable).state === undefined;
}

// ---------------------------------------------------------------------------
// Boundary lookup (previous valid NAV, never interpolated)
// ---------------------------------------------------------------------------

export interface BoundaryHit {
  obs: NavObservation;
  /** Calendar days between the requested date and the NAV used (0 = exact). */
  offsetDays: number;
}

/** The latest NAV on or before `date`, no more than `maxBackDays` earlier. The R5 valuation-alignment rule (resolveObservationAsOf), one implementation. */
export function navOnOrBefore(observations: NavObservation[], date: string, maxBackDays: number): BoundaryHit | null {
  const r = resolveObservationAsOf(observations, date, maxBackDays);
  return r.status === 'ok' && r.observation ? { obs: r.observation, offsetDays: r.offsetDays ?? 0 } : null;
}

// ---------------------------------------------------------------------------
// Returns, resampling, alignment, continuity
// ---------------------------------------------------------------------------

export interface ReturnPoint {
  /** The later observation's date. */
  date: string;
  /** The earlier observation's date. */
  startDate: string;
  simple: number;
  log: number;
  intervalDays: number;
}

/** Returns between CONSECUTIVE observations (spec 8.3, 8.4); never synthetic calendar days. */
export function buildReturns(obs: readonly NavObservation[]): ReturnPoint[] {
  const out: ReturnPoint[] = [];
  for (let i = 1; i < obs.length; i++) {
    const ratio = obs[i].value / obs[i - 1].value;
    out.push({
      date: obs[i].date,
      startDate: obs[i - 1].date,
      simple: ratio - 1,
      log: Math.log(ratio),
      intervalDays: daysBetweenIso(obs[i - 1].date, obs[i].date),
    });
  }
  return out;
}

/**
 * Last observation in each period (weekly = ISO week, monthly = calendar month). Never interpolates and never
 * carries a value into a period with no observation. Monthly reuses the certified toMonthEndSeries.
 */
export function resampleObservations(obs: readonly NavObservation[], frequency: ReturnFrequency): NavObservation[] {
  if (frequency === 'daily') return [...obs];
  if (frequency === 'monthly') {
    return toMonthEndSeries(obs.map((o) => ({ date: new Date(`${o.date}T00:00:00.000Z`), value: o.value }))).map((p) => ({
      date: p.date.toISOString().slice(0, 10),
      value: p.value,
    }));
  }
  const byWeek = new Map<string, NavObservation>();
  for (const o of obs) byWeek.set(isoWeekKey(o.date), o); // ascending input: the last write per week is the last observation
  return [...byWeek.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

export type Continuity =
  | { ok: true }
  | { ok: false; reason: 'material_gap_in_window'; worstIntervalDays: number; worst: { from: string; to: string } }
  | { ok: false; reason: 'irregular_return_intervals'; medianIntervalDays: number };

function medianOf(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Spec 8.7: a periodic measure is only valid when the intervals are consistent with the DECLARED frequency:
 * no interval wider than the frequency allows (a gap), and the typical (median) interval inside the frequency's
 * band (a weekly series declared daily would otherwise be annualised with the wrong factor).
 */
export function checkContinuity(returns: readonly ReturnPoint[], frequency: ReturnFrequency, policy: Nav2Policy): Continuity {
  const limit = policy.maxReturnIntervalDays[frequency];
  let worst: ReturnPoint | null = null;
  for (const r of returns) if (r.intervalDays > limit && (!worst || r.intervalDays > worst.intervalDays)) worst = r;
  if (worst) return { ok: false, reason: 'material_gap_in_window', worstIntervalDays: worst.intervalDays, worst: { from: worst.startDate, to: worst.date } };
  if (returns.length > 0) {
    const median = medianOf(returns.map((r) => r.intervalDays));
    const band = policy.medianIntervalDays[frequency];
    if (median < band.min || median > band.max) return { ok: false, reason: 'irregular_return_intervals', medianIntervalDays: median };
  }
  return { ok: true };
}

export function continuityDetail(ctx: Nav2Context, c: Extract<Continuity, { ok: false }>, frequency: ReturnFrequency): string {
  if (c.reason === 'irregular_return_intervals') {
    return `The prices in this period are about ${c.medianIntervalDays} days apart, which does not match a ${frequency} series, so this measure is not shown rather than annualised with the wrong factor.`;
  }
  return `The prices in this period have a gap of ${c.worstIntervalDays} days (${showDate(ctx, c.worst.from)} to ${showDate(ctx, c.worst.to)}), too long to treat as a ${frequency} series, so this measure is not shown. Nothing has been filled in.`;
}

/** The observations both series have on the SAME date (spec 7.6, 8.11). Both inputs ascending. */
export function alignOnCommonDates(a: readonly NavObservation[], b: readonly NavObservation[]): { a: NavObservation[]; b: NavObservation[] } {
  const outA: NavObservation[] = [];
  const outB: NavObservation[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i].date === b[j].date) {
      outA.push(a[i]);
      outB.push(b[j]);
      i++;
      j++;
    } else if (a[i].date < b[j].date) i++;
    else j++;
  }
  return { a: outA, b: outB };
}

