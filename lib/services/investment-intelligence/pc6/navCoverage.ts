// NAV 1 — daily reconciliation sweep, coverage bookkeeping (2026-09-27).
//
// PO DECISION #1 (27 Sep 2026). The main daily-collection window (0187/0188,
// budgeted by 0204/0205) runs Tue-Sat 03:30-04:30 UTC and is now extended to
// every day (0220). Two real gaps remain even so (NAV1 Production Final
// Certification, 27 Sep 2026, F-17/F-18):
//   F-17: AMFI publishes Saturday/Sunday NAVs for ~600-700 liquid/overnight
//         schemes; NAVAll.txt carries only each scheme's LATEST nav, so a
//         missed calendar day is gone from that file by the time the next
//         window runs.
//   F-18: ~67 schemes on 25 Sep published their NAV after the old 04:30 UTC
//         cutoff and were never collected that morning.
// This module is the PURE decision layer for the fix: a second, SHORTER
// reconciliation window later in the day that checks the CURRENT publication
// date's coverage against the schemes the source itself published that day,
// fills only the gap (never rewrites what is already correct), and marks the
// date "complete" only once the gap is confirmed closed. Everything here is
// deterministic and I/O-free; navReconciliationSweep.ts is the thin orchestrator
// that reads/writes the database around these functions.

/**
 * How many trailing days of recorded coverage are needed before an alert may
 * fire. A freshly-deployed sweep has no history to compare against, and
 * alerting off a single day (or zero) would be a coin flip, not a baseline.
 */
export const COVERAGE_MIN_BASELINE_SAMPLES = 3;

/**
 * Alert when the day's confirmed present count falls below this fraction of
 * the trailing baseline average. 0.85 means "more than 15% below the recent
 * norm" -- deliberately looser than the weekend liquid/overnight fraction
 * (~4-5% of the universe) so a normal weekend dip in a WEEKDAY-scoped baseline
 * does not itself become a false alarm; callers comparing like days (e.g. a
 * weekday baseline against a weekday) get a tighter, more meaningful signal.
 */
export const COVERAGE_MATERIAL_DROP_RATIO = 0.85;

/**
 * The confirmed coverage gap for one publication date, computed against
 * whatever the source itself published for that date (never a static "every
 * mapped instrument" universe -- see the module header: that measure is
 * permanently ~40% short because most AMFI-mapped instruments are dormant or
 * matured and never publish again, which is not a reconciliation defect).
 */
export interface CoverageGap {
  expectedCount: number;
  presentCount: number;
  missingInstrumentIds: string[];
  missingCount: number;
}

/**
 * Pure set difference: which of the day's published, resolved instruments
 * have no "ok" NAV row yet for this date. Duplicate ids in `expectedInstrumentIds`
 * are counted once (a scheme resolves to one instrument at most once per
 * parsed file, but de-duplicating here costs nothing and removes a class of
 * double-count bugs at the call site).
 */
export function computeCoverageGap(
  expectedInstrumentIds: readonly string[],
  presentInstrumentIds: ReadonlySet<string>
): CoverageGap {
  const expected = [...new Set(expectedInstrumentIds)];
  const missing: string[] = [];
  let presentCount = 0;
  for (const id of expected) {
    if (presentInstrumentIds.has(id)) presentCount++;
    else missing.push(id);
  }
  return { expectedCount: expected.length, presentCount, missingInstrumentIds: missing, missingCount: missing.length };
}

/**
 * A publication date is "complete" ONLY once a reconciliation sweep has
 * confirmed zero remaining gap against the source's own published set for
 * that date -- never merely because the main collection window finished (a
 * window can finish having missed schemes the source published late, or
 * on a day the file changed again after the window closed).
 */
export function decideCoverageComplete(missingCountAfterSweep: number): boolean {
  return missingCountAfterSweep === 0;
}

export interface CoverageAlertDecision {
  shouldAlert: boolean;
  /** present / baseline, or null when no baseline could be established. */
  coverageRatio: number | null;
  baselineUsed: number | null;
  detail: string;
}

/**
 * Decide whether today's confirmed coverage is materially below the recent
 * norm -- evaluated with the numbers AFTER the day's final reconciliation
 * sweep (never mid-window: a partial count part-way through the window would
 * always look low and would be a false alarm by construction).
 *
 * `recentPresentCounts` is the caller's own trailing window (most recent
 * first or in any order -- only the values matter), EXCLUDING today, of
 * final present counts for the SAME source/day-type the caller chose to
 * compare against. This function does not know about calendars: a caller
 * that wants "compare Saturdays to Saturdays" filters before calling.
 */
export function evaluateCoverageAlert(input: {
  presentCount: number;
  recentPresentCounts: readonly number[];
  materialDropRatio?: number;
  minBaselineSamples?: number;
}): CoverageAlertDecision {
  const dropRatio = input.materialDropRatio ?? COVERAGE_MATERIAL_DROP_RATIO;
  const minSamples = input.minBaselineSamples ?? COVERAGE_MIN_BASELINE_SAMPLES;
  if (input.recentPresentCounts.length < minSamples) {
    return {
      shouldAlert: false,
      coverageRatio: null,
      baselineUsed: null,
      detail: `Only ${input.recentPresentCounts.length} prior day(s) of coverage history exist; need ${minSamples} to establish a baseline. Not alerting on an unestablished baseline.`,
    };
  }
  const baseline = input.recentPresentCounts.reduce((a, b) => a + b, 0) / input.recentPresentCounts.length;
  if (!(baseline > 0)) {
    return { shouldAlert: false, coverageRatio: null, baselineUsed: baseline, detail: 'Baseline is zero or negative; cannot evaluate a coverage ratio.' };
  }
  const ratio = input.presentCount / baseline;
  const shouldAlert = ratio < dropRatio;
  return {
    shouldAlert,
    coverageRatio: ratio,
    baselineUsed: baseline,
    detail: shouldAlert
      ? `Present count ${input.presentCount} is ${(ratio * 100).toFixed(1)}% of the ${input.recentPresentCounts.length}-day baseline ${baseline.toFixed(1)}, below the ${(dropRatio * 100).toFixed(0)}% material-drop threshold.`
      : `Present count ${input.presentCount} is ${(ratio * 100).toFixed(1)}% of the ${input.recentPresentCounts.length}-day baseline ${baseline.toFixed(1)}, at or above the ${(dropRatio * 100).toFixed(0)}% threshold.`,
  };
}
