// NAV2 Phase B -- the REQUIRED-WINDOW PLANNER (spec 4, 5). Pure and
// deterministic: no I/O, no clock (today is an argument).
//
// For each HELD scheme it computes ONE consolidated range of NAV history rather
// than one request per metric:
//
//   requiredFrom = the EARLIEST of
//       earliest canonical transaction / user investment date / holding snapshot (- 10 days)
//       the mandatory reconstruction buffer                                        (- 10 days)
//       the beginning of each selected point-to-point period                        (- 10 days)
//       each rolling horizon's preceding-data requirement before the first endpoint (- 45 ... 1855 days)
//       each moving average / rate-of-change warm-up, in observations -> calendar days
//       the risk / benchmark minimum-observation span                               (- 10 days)
//       the as-of date's own boundary                                               (- 10 days)
//   requiredTo   = the as-of date, never later than today (no future-dated NAV).
//
// It never defaults to scheme inception: the only thing that can reach back
// further than the earliest held date is a longer horizon the analysis spec
// itself selects, and the furthest any standard horizon goes is 1,855 days before
// the analysis start. An earlier date needs an explicit analysisStart.
//
// Every buffer comes from the central policy (lib/config/nav2/metricPolicy.ts);
// every driver that set a date is recorded, so "why is this scheme's history being
// fetched back to <date>?" always has a printed answer.
//
// DEDUPLICATION (spec 12.3): consolidateWindows() merges any number of windows
// (several statements, several household members, several triggers) into ONE
// window per instrument. The output carries NO user, household or document
// identifier, so a window - and anything keyed on it - cannot reveal who holds
// the scheme (spec 14).

import type { Nav2Policy } from '@/lib/config/nav2/metricPolicy';
import { addDaysIso, daysBetweenIso } from './dates';
import type { AnalysisSpec } from './analysisSpec';

/** AMFI's own earliest published history (the NAV1 hydration floor). A window is never planned before it. */
export const PLANNER_HISTORY_FLOOR = '2006-04-01';

export type DriverKind =
  | 'earliest_transaction'
  | 'earliest_holding_snapshot'
  | 'user_investment_date'
  | 'reconstruction_buffer'
  | 'point_to_point_period'
  | 'rolling_window'
  | 'moving_average'
  | 'rate_of_change'
  | 'risk_minimum_span'
  | 'report_as_of';

export interface AppliedDriver {
  kind: DriverKind;
  /** Human-readable, no identifiers: "1Y rolling return, first endpoint 2024-01-01". */
  detail: string;
  /** The date this driver is anchored to. */
  targetDate: string;
  /** Calendar days requested before the target. */
  bufferDays: number;
  /** targetDate minus bufferDays: the earliest date this driver needs. */
  from: string;
}

export interface RequiredWindow {
  instrumentId: string;
  requiredFrom: string;
  requiredTo: string;
  /** Sorted earliest-first. */
  drivers: AppliedDriver[];
  policyVersion: string;
}

export type HeldDateKind = 'earliest_transaction' | 'earliest_holding_snapshot' | 'user_investment_date';

/** The loader's reason strings map onto driver kinds one to one. */
export function heldDateKind(reason: 'transactions' | 'investment_date' | 'holding_date'): HeldDateKind {
  return reason === 'transactions' ? 'earliest_transaction' : reason === 'investment_date' ? 'user_investment_date' : 'earliest_holding_snapshot';
}

export interface ComputeWindowArgs {
  instrumentId: string;
  /** Earliest date the scheme is held from (transaction / investment date / snapshot), or null when unknown. */
  earliestHeldDate: string | null;
  earliestHeldKind: HeldDateKind | null;
  spec: AnalysisSpec;
  policy: Nav2Policy;
  /** Today (ISO): requiredTo never goes past it. */
  today: string;
}

function driver(kind: DriverKind, detail: string, targetDate: string, bufferDays: number): AppliedDriver {
  return { kind, detail, targetDate, bufferDays, from: addDaysIso(targetDate, -bufferDays) };
}

/** Calendar days to cover `observations` valid NAV observations (5 trading days per 7 calendar days, rounded up). */
export function calendarDaysForObservations(observations: number, policy: Nav2Policy): number {
  return Math.ceil(observations * policy.windowPlanning.calendarDaysPerObservation);
}

export function computeRequiredWindow(args: ComputeWindowArgs): RequiredWindow {
  const { spec, policy } = args;
  const wp = policy.windowPlanning;
  const requiredTo = spec.asOfDate < args.today ? spec.asOfDate : args.today;
  const analysisEnd = spec.analysisEnd && spec.analysisEnd < requiredTo ? spec.analysisEnd : requiredTo;
  const start = spec.analysisStart ?? args.earliestHeldDate; // the first date an endpoint is wanted
  const drivers: AppliedDriver[] = [];

  if (args.earliestHeldDate && args.earliestHeldKind) {
    drivers.push(driver(args.earliestHeldKind, `earliest ${args.earliestHeldKind.replace(/_/g, ' ')}`, args.earliestHeldDate, wp.boundaryBufferDays));
    drivers.push(driver('reconstruction_buffer', 'mandatory reconstruction buffer before the earliest held date', args.earliestHeldDate, wp.reconstructionBufferDays));
  }
  drivers.push(driver('report_as_of', 'previous valid NAV on or before the as-of date', requiredTo, wp.boundaryBufferDays));

  for (const p of spec.pointToPoint) {
    drivers.push(driver('point_to_point_period', `point-to-point period ${p.id} start`, p.start, wp.boundaryBufferDays));
  }

  if (start) {
    for (const id of spec.rollingHorizonIds) {
      const preceding = wp.rollingPrecedingDays[id];
      if (preceding === undefined) continue; // an unknown horizon id has no policy requirement; the engine rejects it as unsupported
      drivers.push(driver('rolling_window', `${id} rolling return, first endpoint`, start, preceding));
    }
    for (const ma of spec.movingAverages) {
      const observations = ma.period - 1 + (ma.kind === 'ema' ? wp.emaWarmupExtraObservations : 0);
      drivers.push(driver('moving_average', `${ma.kind.toUpperCase()} over ${ma.period} observations (warm-up ${observations} observations before the first point)`, start, calendarDaysForObservations(observations, policy) + wp.boundaryBufferDays));
    }
    for (const n of spec.rocPeriods) {
      drivers.push(driver('rate_of_change', `ROC over ${n} observations`, start, calendarDaysForObservations(n, policy) + wp.boundaryBufferDays));
    }
  }

  if (spec.risk || spec.benchmarkRelative) {
    const m = policy.minimums;
    const returnsNeeded = Math.max(spec.risk ? m.sharpeSortinoReturns : 0, spec.benchmarkRelative ? m.betaAlphaReturns : 0, m.volatilityReturns);
    const span = calendarDaysForObservations(returnsNeeded + 1, policy);
    const spanStart = addDaysIso(analysisEnd, -span);
    const target = start && start < spanStart ? start : spanStart;
    drivers.push(driver('risk_minimum_span', `risk and benchmark measures need at least ${returnsNeeded} returns ending at the analysis end`, target, wp.boundaryBufferDays));
  }

  drivers.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  const earliest = drivers[0].from;
  return {
    instrumentId: args.instrumentId,
    requiredFrom: earliest < PLANNER_HISTORY_FLOOR ? PLANNER_HISTORY_FLOOR : earliest,
    requiredTo,
    drivers,
    policyVersion: policy.version,
  };
}

/**
 * ONE window per instrument from any number of windows: earliest requiredFrom, latest requiredTo, drivers merged
 * (identical kind+target+buffer collapse). Input order never changes the result. Carries no user, household or
 * document identifier.
 */
export function consolidateWindows(windows: readonly RequiredWindow[]): RequiredWindow[] {
  const byInstrument = new Map<string, RequiredWindow>();
  for (const w of windows) {
    const cur = byInstrument.get(w.instrumentId);
    if (!cur) {
      byInstrument.set(w.instrumentId, { ...w, drivers: [...w.drivers] });
      continue;
    }
    const seen = new Set(cur.drivers.map((d) => `${d.kind}|${d.targetDate}|${d.bufferDays}`));
    for (const d of w.drivers) if (!seen.has(`${d.kind}|${d.targetDate}|${d.bufferDays}`)) cur.drivers.push(d);
    cur.drivers.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
    if (w.requiredFrom < cur.requiredFrom) cur.requiredFrom = w.requiredFrom;
    if (w.requiredTo > cur.requiredTo) cur.requiredTo = w.requiredTo;
  }
  return [...byInstrument.values()].sort((a, b) => (a.instrumentId < b.instrumentId ? -1 : a.instrumentId > b.instrumentId ? 1 : 0));
}

/** How many calendar days of history before today the window asks for (for the "bounded, not inception" disclosure and tests). */
export function windowSpanDays(w: Pick<RequiredWindow, 'requiredFrom' | 'requiredTo'>): number {
  return daysBetweenIso(w.requiredFrom, w.requiredTo);
}

// ---------------------------------------------------------------------------
// Triggers (spec 4.1). Classification only: the service decides how to act.
// ---------------------------------------------------------------------------

/** Document / source states that must never create a hydration requirement (spec 4.1: draft, rejected, quarantined, malware-failed, unresolved, unaccepted). */
export type NonAcceptedSourceState = 'draft' | 'rejected' | 'quarantined' | 'malware_failed' | 'unresolved' | 'unaccepted';

export type Nav2Trigger =
  | { kind: 'statement_accepted' }
  | { kind: 'new_holding' }
  | { kind: 'report_period_requested' }
  | { kind: 'analysis_period_changed' }
  | { kind: 'nav_correction'; instrumentId: string; date: string }
  | { kind: 'benchmark_mapping_active'; benchmarkId: string }
  | { kind: 'statement_not_accepted'; state: NonAcceptedSourceState };

export type TriggerAction =
  | { action: 'plan_held_windows'; reason: string }
  | { action: 'invalidate_dependents'; instrumentId: string; date: string; reason: string }
  | { action: 'record_benchmark_history_requirement'; benchmarkId: string; reason: string }
  | { action: 'ignore'; reason: string };

export function classifyTrigger(t: Nav2Trigger): TriggerAction {
  switch (t.kind) {
    case 'statement_accepted':
      return { action: 'plan_held_windows', reason: 'An accepted and certified statement can introduce newly held schemes.' };
    case 'new_holding':
      return { action: 'plan_held_windows', reason: 'A canonical transaction or holding introduced a newly held scheme.' };
    case 'report_period_requested':
      return { action: 'plan_held_windows', reason: 'A report asked for an analysis period that may not be covered yet.' };
    case 'analysis_period_changed':
      return { action: 'plan_held_windows', reason: 'The user changed the analysis period.' };
    case 'nav_correction':
      return { action: 'invalidate_dependents', instrumentId: t.instrumentId, date: t.date, reason: 'A corrected NAV changes only the results that used that scheme and date.' };
    case 'benchmark_mapping_active':
      return { action: 'record_benchmark_history_requirement', benchmarkId: t.benchmarkId, reason: 'A benchmark mapping became active; its history comes from the governed benchmark upload, not from a NAV fetch.' };
    case 'statement_not_accepted':
      return { action: 'ignore', reason: `A ${t.state.replace(/_/g, ' ')} document creates no hydration requirement.` };
  }
}
