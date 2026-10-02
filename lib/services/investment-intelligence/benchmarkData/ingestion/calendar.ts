// BENCH-1 Phase 2 - market-calendar helpers for the recurring-ingestion layer
// (pure; no clock - every function takes an explicit date).
//
// HONEST LIMITATION. FHIP ships NO exchange holiday calendar: no verified,
// licensed source for NSE/BSE trading holidays is configured. These helpers
// therefore reason on WEEKDAYS (Monday-Friday) and tolerate short runs of
// missing weekdays (default 3, enough for a typical holiday cluster) as
// "possible holidays". An operator-supplied holiday set can be passed in and is
// honoured exactly. Nothing here ever synthesises or interpolates a missing
// market date; the watermark only states how far coverage is complete UNDER THIS
// TOLERANCE.

const DAY_MS = 86_400_000;

export const DEFAULT_MAX_TOLERABLE_GAP_WEEKDAYS = 3;

export function dayNumber(iso: string): number {
  return Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
}
export function isoFromDay(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}
export function isWeekdayIso(iso: string): boolean {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6;
}
export function addDaysIso(iso: string, days: number): string {
  return isoFromDay(dayNumber(iso) + days);
}

/** The latest weekday strictly before or on `iso` (holidays honoured when supplied). */
export function latestWeekdayOnOrBefore(iso: string, holidays?: ReadonlySet<string>): string {
  let n = dayNumber(iso);
  for (let i = 0; i < 14; i++) {
    const d = isoFromDay(n);
    if (isWeekdayIso(d) && !holidays?.has(d)) return d;
    n -= 1;
  }
  return isoFromDay(n);
}

/**
 * The latest session whose close a source could ALREADY have published at
 * `nowIso`: today's date minus the source's publication lag (days), snapped
 * back to a weekday.
 */
export function expectedLatestSession(nowIso: string, lagDays: number, holidays?: ReadonlySet<string>): string {
  const today = nowIso.slice(0, 10);
  return latestWeekdayOnOrBefore(addDaysIso(today, -Math.max(0, lagDays)), holidays);
}

/** Weekdays strictly between (from, to] that are not holidays. */
export function weekdaysAfter(from: string, to: string, holidays?: ReadonlySet<string>): number {
  let n = 0;
  for (let d = dayNumber(from) + 1; d <= dayNumber(to); d++) {
    const iso = isoFromDay(d);
    if (isWeekdayIso(iso) && !holidays?.has(iso)) n += 1;
  }
  return n;
}

export interface GapRun {
  from: string;
  to: string;
  weekdaysMissing: number;
}

/**
 * Runs of consecutive missing weekdays inside [from, to] given the dates that
 * HAVE a stored level. A run touching `from` or `to` is a run like any other
 * (leading/trailing absence is a gap, not a pass).
 */
export function findGapRuns(have: ReadonlySet<string>, from: string, to: string, holidays?: ReadonlySet<string>): GapRun[] {
  const runs: GapRun[] = [];
  let open: { from: string; to: string; n: number } | null = null;
  for (let d = dayNumber(from); d <= dayNumber(to); d++) {
    const iso = isoFromDay(d);
    if (!isWeekdayIso(iso) || holidays?.has(iso)) continue;
    if (have.has(iso)) {
      if (open) {
        runs.push({ from: open.from, to: open.to, weekdaysMissing: open.n });
        open = null;
      }
    } else if (open) {
      open.to = iso;
      open.n += 1;
    } else {
      open = { from: iso, to: iso, n: 1 };
    }
  }
  if (open) runs.push({ from: open.from, to: open.to, weekdaysMissing: open.n });
  return runs;
}

export interface CompletenessAssessment {
  /** Latest date D with data such that [requiredFrom, D] has no intolerable gap; null when coverage is not complete even at its start. */
  watermark: string | null;
  /** The first gap longer than the tolerance, if any (this is what stops the watermark). */
  firstIntolerableGap: GapRun | null;
  /** Short gaps that were tolerated as possible holidays (disclosed, never hidden). */
  toleratedGaps: GapRun[];
  /** Earliest stored date at or after requiredFrom, or null when none. */
  firstDataDate: string | null;
}

/**
 * completeness_watermark: how far coverage is complete from `requiredFrom`
 * onward, tolerating at most `maxTolerableGapWeekdays` consecutive missing
 * weekdays. A leading gap longer than the tolerance (history missing at the
 * start) yields a null watermark: coverage is not complete anywhere.
 */
export function assessCompleteness(have: ReadonlySet<string>, requiredFrom: string, upTo: string, opts?: { maxTolerableGapWeekdays?: number; holidays?: ReadonlySet<string> }): CompletenessAssessment {
  const tol = opts?.maxTolerableGapWeekdays ?? DEFAULT_MAX_TOLERABLE_GAP_WEEKDAYS;
  const holidays = opts?.holidays;
  const sorted = [...have].filter((d) => d >= requiredFrom && d <= upTo).sort();
  const firstDataDate = sorted[0] ?? null;
  const runs = findGapRuns(have, requiredFrom, upTo, holidays);
  const tolerated = runs.filter((r) => r.weekdaysMissing <= tol);
  const intolerable = runs.find((r) => r.weekdaysMissing > tol) ?? null;
  if (sorted.length === 0) return { watermark: null, firstIntolerableGap: intolerable, toleratedGaps: tolerated, firstDataDate };
  // A leading run (starting at the first required weekday) that is intolerable means no complete coverage at all.
  if (intolerable && runs[0] === intolerable && intolerable.from <= firstDataDate!) {
    return { watermark: null, firstIntolerableGap: intolerable, toleratedGaps: tolerated, firstDataDate };
  }
  const limit = intolerable ? intolerable.from : addDaysIso(upTo, 1);
  const before = sorted.filter((d) => d < limit);
  return { watermark: before.length ? before[before.length - 1] : null, firstIntolerableGap: intolerable, toleratedGaps: tolerated, firstDataDate };
}
