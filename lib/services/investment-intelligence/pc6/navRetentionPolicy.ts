// PC6/NAV 1 — selective historical NAV retention policy (NAV 1.07/1.12).
//
// Implements the governing workbook's policy contract as real, testable
// logic bound to THIS repository's actual schema, instead of leaving it as
// pseudocode:
//
//   KEEP(row) =
//     row.nav_date >= C
//     OR needed_by_accepted_statement_history(row)
//     OR needed_by_benchmark_dependency(row)
//     OR pinned_by_report_or_revision(row)
//     OR protected_by_active_hold(row)
//   CANDIDATE(row) = NOT KEEP(row)
//
// Schema bindings discovered 2026-09-21 (NAV 1.02/1.09 discovery):
//
// - needed_by_accepted_statement_history(row): SUPERSEDED BY MIGRATION 0189
//   (NAV 1 Stage D, 2026-09-24). An instrument is now protected when ANY user
//   holds or has held it, in any user-scoped ii_* table and any statement
//   status, and its ENTIRE history is kept -- see
//   userHeldInstrumentsToDependencies() and the SQL pc6_instrument_is_user_held().
//   The certified-only binding below protected nothing in production, where no
//   statement had ever certified. It is retained as the record of what 0166-
//   0172 did, and because the windowing logic still applies to any dependency
//   that carries a history_completeness.
//
//   ORIGINAL (0166-0172): an instrument was "accepted"
//   when it has an `ii_portfolio_truth_status` row (0041) with
//   status IN ('certified', 'certified_with_warnings') for ANY account.
//   `history_completeness` on that row decides how far back the requirement
//   reaches:
//     'complete_from_inception'            -> no lower bound (keep everything
//                                              up to C for that instrument)
//     'complete_from_known_opening_balance' -> from the account's earliest
//                                              non-reversed ii_transactions
//                                              row for that instrument
//     'partial_history' | 'holdings_only'   -> from the certified holding
//                                              snapshot's as-of date only
//   A fully redeemed investment is still represented by a (possibly
//   superseded-in-effect) ii_portfolio_truth_status row and MUST remain
//   protected — this binding does not filter on "currently held".
//
// - needed_by_benchmark_dependency(row): an instrument that is currently or
//   was ever mapped via `ii_instrument_benchmarks` requires its own NAV
//   history over the SAME window a benchmark comparison would need, so a
//   scheme kept for comparison purposes is bound the same way as an
//   accepted-statement scheme, not given a separate weaker retention.
//
// - pinned_by_report_or_revision(row): NO CURRENT MECHANISM in this
//   repository's `report_snapshots` table (0010) records which specific NAV
//   (instrument_id, price_date) rows were used to render an investment
//   report — `report_snapshots` stores `source_as_of_date` and a generic
//   payload hash, not NAV row identity. This is a genuine, disclosed gap
//   (see docs/investment-intelligence/NAV1_PROGRESS_LEDGER.md, NAV 1.35),
//   not something this module may silently assume away. Until a real pin
//   exists, this predicate is UNDECIDABLE from data alone, so this module
//   exposes `reportPinLookup` as an injectable function that defaults to
//   "protect" (fail closed) rather than "no dependency" (fail open) when the
//   caller has not wired a real answer.
//
// - protected_by_active_hold(row): binds to a new `ii_nav_retention_holds`
//   table (see migration 0166), which cleanup dry-run/execution must
//   consult and which a new-upload-in-flight can register to prevent a
//   Stage-E race (workbook "Race prevention").
//
// This module is PURE (no DB/network calls) so KEEP/CANDIDATE can be unit
// tested without live credentials, and the exact same decision function can
// be re-expressed as SQL for the dry-run candidate manifest
// (scripts/pc6_nav1_retention_dryrun_manifest.sql) — the two must be kept in
// sync deliberately, not by construction, since Postgres and TypeScript
// cannot share one source file.

export type HistoryCompleteness =
  | 'complete_from_inception'
  | 'complete_from_known_opening_balance'
  | 'partial_history'
  | 'holdings_only'
  | null;

export interface AcceptedDependency {
  instrumentId: string;
  /**
   * True when a user holds or has ever held the instrument.
   *
   * Until migration 0189 this meant status IN ('certified',
   * 'certified_with_warnings') only. In production no statement had ever
   * certified (all sat at 'reconciliation_required'), so it was never true
   * for anyone -- see userHeldInstrumentsToDependencies().
   */
  isAccepted: boolean;
  historyCompleteness: HistoryCompleteness;
  /** ISO date. Earliest non-reversed transaction for this instrument/account, if known. */
  earliestTransactionDate: string | null;
  /** ISO date. The certified holding snapshot's as-of date, if known. */
  certifiedAsOfDate: string | null;
}

export interface BenchmarkDependency {
  instrumentId: string;
  /** True if ii_instrument_benchmarks ever mapped this instrument (current or historical). */
  everBenchmarked: boolean;
}

export interface RetentionHold {
  instrumentId: string;
  /** True while an ii_nav_retention_holds row is active and unexpired for this instrument. */
  isHeld: boolean;
}

export interface NavRow {
  instrumentId: string;
  /** ISO yyyy-mm-dd. */
  navDate: string;
}

export interface PolicyContext {
  /** The explicit changeover date C, ISO yyyy-mm-dd. Per PO decision: 2026-09-21. */
  changeoverDate: string;
  /** Keyed by instrumentId. Only accepted-statement dependencies need be present; absence means "no accepted dependency found". */
  acceptedDependencies: Map<string, AcceptedDependency>;
  benchmarkDependencies: Map<string, BenchmarkDependency>;
  retentionHolds: Map<string, RetentionHold>;
  /**
   * Injectable, fail-closed by default (see module header on
   * pinned_by_report_or_revision). Return true to protect the row.
   */
  reportPinLookup?: (row: NavRow) => boolean;
}

export interface KeepDecision {
  keep: boolean;
  /** Every reason that independently justified KEEP, for audit/evidence (workbook "reasoned"). Empty when CANDIDATE. */
  reasons: KeepReason[];
}

export type KeepReason =
  | 'post_changeover'
  | 'accepted_statement_history'
  | 'benchmark_dependency'
  | 'report_pin'
  | 'active_hold';

function isoLessThan(a: string, b: string): boolean {
  return a < b; // ISO yyyy-mm-dd strings compare lexicographically == chronologically
}

/**
 * needed_by_accepted_statement_history(row) — returns true when this
 * instrument/date pair falls inside the retained window implied by an
 * accepted statement's own history_completeness.
 */
export function neededByAcceptedStatementHistory(row: NavRow, ctx: PolicyContext): boolean {
  const dep = ctx.acceptedDependencies.get(row.instrumentId);
  if (!dep || !dep.isAccepted) return false;
  switch (dep.historyCompleteness) {
    case 'complete_from_inception':
      return true; // no lower bound: everything up to C is required
    case 'complete_from_known_opening_balance':
      return dep.earliestTransactionDate == null || !isoLessThan(row.navDate, dep.earliestTransactionDate);
    case 'partial_history':
    case 'holdings_only':
      return dep.certifiedAsOfDate == null || !isoLessThan(row.navDate, dep.certifiedAsOfDate);
    case null:
      // Accepted but completeness not yet evaluated: hold conservatively
      // (missing coverage classification is never permission to delete).
      return true;
    default:
      return true;
  }
}

export function neededByBenchmarkDependency(row: NavRow, ctx: PolicyContext): boolean {
  return ctx.benchmarkDependencies.get(row.instrumentId)?.everBenchmarked ?? false;
}

export function pinnedByReportOrRevision(row: NavRow, ctx: PolicyContext): boolean {
  // Fail closed: no wired lookup means "protect", not "no dependency".
  if (!ctx.reportPinLookup) return true;
  return ctx.reportPinLookup(row);
}

export function protectedByActiveHold(row: NavRow, ctx: PolicyContext): boolean {
  return ctx.retentionHolds.get(row.instrumentId)?.isHeld ?? false;
}

/** KEEP(row) — the full policy contract, with every satisfied reason recorded. */
export function evaluateKeep(row: NavRow, ctx: PolicyContext): KeepDecision {
  const reasons: KeepReason[] = [];
  if (!isoLessThan(row.navDate, ctx.changeoverDate)) reasons.push('post_changeover');
  if (neededByAcceptedStatementHistory(row, ctx)) reasons.push('accepted_statement_history');
  if (neededByBenchmarkDependency(row, ctx)) reasons.push('benchmark_dependency');
  if (pinnedByReportOrRevision(row, ctx)) reasons.push('report_pin');
  if (protectedByActiveHold(row, ctx)) reasons.push('active_hold');
  return { keep: reasons.length > 0, reasons };
}

/** CANDIDATE(row) = NOT KEEP(row). */
export function evaluateCandidate(row: NavRow, ctx: PolicyContext): boolean {
  return !evaluateKeep(row, ctx).keep;
}

/**
 * A context with `reportPinLookup` explicitly set to "no dependency for any
 * row". ONLY for use where the caller has independently confirmed report
 * pinning is genuinely out of scope (e.g. a test fixture, or a future
 * verified integration) — never as a default, per the module header.
 */
export function withNoReportPinDependency(ctx: Omit<PolicyContext, 'reportPinLookup'>): PolicyContext {
  return { ...ctx, reportPinLookup: () => false };
}

// ---------------------------------------------------------------------------
// NAV 1.26 — initial historical hydration: the INVERSE question from
// KEEP/CANDIDATE. Given an instrument (not yet knowing which dates exist),
// how far back does its history need to be FETCHED? Deliberately excludes
// post_changeover (that is the daily job's job, not hydration's) and
// report_pin (fails closed for retention purposes, but a fail-closed
// "protect everything" is not an actionable fetch instruction — hydration
// only fetches for a NAMED reason, never "because we couldn't prove we
// didn't need it") and active_hold (a hold protects existing rows; it does
// not, by itself, demand fetching new ones).
// ---------------------------------------------------------------------------

export interface HydrationRequirement {
  required: boolean;
  /** ISO date, or null meaning "from inception / earliest the provider has" when required=true. */
  fromDate: string | null;
  reasons: Extract<KeepReason, 'accepted_statement_history' | 'benchmark_dependency'>[];
}

// ---------------------------------------------------------------------------
// Benchmark-only lookback: GROUNDED in the actual calculation code, not a
// guess. Traced live (this session) through the real call chain a benchmark
// comparison depends on:
//
//   lib/engines/investment-intelligence/rollingReturnService.ts
//     -> ROLLING_HORIZON_YEARS = [1, 3, 5]  (the only horizons ever computed)
//   lib/engines/investment-intelligence/rollingReturns.ts:rollingReturnSeries()
//     -> for EVERY month-end observation `end` in the series, it looks
//        `windowYears * 365` days back for a matching start point and forms
//        ONE window per month-end `end` date (i.e. windows are stepped
//        MONTHLY, one per available month-end observation -- NOT stepped by
//        windowYears, and NOT windowYears*rollingMinWindows apart). A series
//        needs `MINIMUM_OBSERVATIONS.rollingMinWindows` (6) such windows
//        before it reports anything (`INSUFFICIENT_HISTORY` otherwise).
//   lib/config/investment-intelligence/minimumHistory.ts
//     -> rollingMinWindows = 6; the other benchmark-relevant metrics
//        (volatility/Sharpe/Sortino/beta/tracking-error/information-ratio at
//        12 periodic observations, Calmar at 365 days) all need LESS history
//        than the rolling5Y+6-windows case, so that case is the true maximum.
//
// Therefore the REAL minimum lookback a benchmark-only dependency needs is:
//   max(ROLLING_HORIZON_YEARS) * 365 days
//   + (rollingMinWindows - 1) EXTRA MONTH-END OBSERVATIONS to have 6 valid
//     window-end dates once the window itself becomes satisfiable
// This is materially smaller than "from inception" for any scheme with more
// than ~6 years of real history -- e.g. a 20-year-old scheme's benchmark
// comparison does NOT need all 20 years, only ~6.
//
// This does NOT apply to an ACCEPTED-STATEMENT complete_from_inception
// dependency, which is a genuinely different requirement (an investor's own
// XIRR since their real first cash flow needs their real inception date,
// regardless of any rolling-window formula) -- that case correctly stays
// unbounded (fromDate: null) below.
const MAX_ROLLING_HORIZON_YEARS = 5; // grounded: max(ROLLING_HORIZON_YEARS) in rollingReturnService.ts
const ROLLING_MIN_WINDOWS = 6; // grounded: MINIMUM_OBSERVATIONS.rollingMinWindows in minimumHistory.ts
// +31 days/month (calendar-safe upper bound, not 30.44 average) for the
// extra month-end observations, plus the algorithm's own 20-day window-match
// tolerance, plus a further 30-day safety margin for weekend/holiday gaps
// between the daily NAV series and the monthly grid `toMonthEndSeries()`
// derives from it. Every constant here traces to a cited line above or is
// explicitly marked as an added safety margin -- never an unexplained number.
export const BENCHMARK_LOOKBACK_DAYS =
  MAX_ROLLING_HORIZON_YEARS * 365 + (ROLLING_MIN_WINDOWS - 1) * 31 + 20 /* window-match tolerance */ + 30 /* gap safety margin */;

function subtractDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Hoisted out of `determineHydrationRequirement`'s switch statement (2026-09-22
 * production build fix): reassigning `fromDate` from multiple `case` branches
 * defeats TypeScript's control-flow narrowing across the switch, surfacing as
 * "Operator '<' cannot be applied to types 'string' and 'never'" the moment
 * this file becomes reachable from a real build (it wasn't before). Comparing
 * inside a plain function call, where `current`'s null-check and the `<`
 * comparison are both local to this function's own narrowing scope, sidesteps
 * the limitation without changing behaviour. */
function isEarlierOrUnset(candidate: string, current: string | null): boolean {
  return current === null || candidate < current;
}

export function determineHydrationRequirement(
  instrumentId: string,
  ctx: Pick<PolicyContext, 'acceptedDependencies' | 'benchmarkDependencies'>,
  /** ISO date to measure a benchmark-only lookback from. Required only when a benchmark-only case is reached; the changeover date C is the correct anchor (the last date daily collection alone can't yet cover). */
  benchmarkLookbackAnchorDate?: string
): HydrationRequirement {
  const reasons: HydrationRequirement['reasons'] = [];
  let fromDate: string | null = null;
  let sawInceptionRequirement = false;

  const dep = ctx.acceptedDependencies.get(instrumentId);
  if (dep?.isAccepted) {
    reasons.push('accepted_statement_history');
    switch (dep.historyCompleteness) {
      case 'complete_from_inception':
      case null:
        sawInceptionRequirement = true;
        break;
      case 'complete_from_known_opening_balance':
        if (dep.earliestTransactionDate && isEarlierOrUnset(dep.earliestTransactionDate, fromDate)) fromDate = dep.earliestTransactionDate;
        else if (!dep.earliestTransactionDate) sawInceptionRequirement = true;
        break;
      case 'partial_history':
      case 'holdings_only':
        if (dep.certifiedAsOfDate && isEarlierOrUnset(dep.certifiedAsOfDate, fromDate)) fromDate = dep.certifiedAsOfDate;
        else if (!dep.certifiedAsOfDate) sawInceptionRequirement = true;
        break;
    }
  }

  if (ctx.benchmarkDependencies.get(instrumentId)?.everBenchmarked) {
    reasons.push('benchmark_dependency');
    if (reasons.length === 1) {
      // Benchmark-only: use the grounded rolling-window lookback rather than
      // an unbounded "from inception" default, per the module's own header.
      if (benchmarkLookbackAnchorDate) {
        fromDate = subtractDays(benchmarkLookbackAnchorDate, BENCHMARK_LOOKBACK_DAYS);
      } else {
        // No anchor supplied: caller has not wired the real changeover date
        // through. Fail conservative (from inception) rather than silently
        // computing a wrong window from an assumed "today".
        sawInceptionRequirement = true;
      }
    }
    // else: an accepted-statement reason already established a narrower or
    // unbounded requirement above; a benchmark comparison never NARROWS
    // what an accepted statement already requires, so nothing to do here.
  }

  if (reasons.length === 0) return { required: false, fromDate: null, reasons: [] };
  return { required: true, fromDate: sawInceptionRequirement ? null : fromDate, reasons };
}

/**
 * NAV 1 Stage D (migration 0189) — the hydration side of the ONE shared
 * definition of "held by a user".
 *
 * The input is exactly what the SQL function `pc6_user_held_instrument_ids()`
 * returns: every instrument present in any user-scoped ii_* table, in any
 * statement status. Retention consults the same definition through
 * `pc6_instrument_is_user_held()`, so the two can never disagree about which
 * instruments are protected and which must be re-fetched on demand.
 *
 * Every held instrument is hydrated FROM INCEPTION (`historyCompleteness:
 * null`), because retention keeps a held instrument's ENTIRE history. A
 * narrower hydration window would leave a gap that retention was promising
 * to keep -- and the old windowing inputs (history_completeness, the
 * certified snapshot date) only ever existed for certified statements,
 * which production has never had.
 *
 * Deliberately tolerant: duplicate and empty ids are ignored rather than
 * thrown, since the input is a union the database already de-duplicates.
 */
export function userHeldInstrumentsToDependencies(instrumentIds: readonly string[]): Map<string, AcceptedDependency> {
  const map = new Map<string, AcceptedDependency>();
  for (const instrumentId of instrumentIds) {
    if (!instrumentId || map.has(instrumentId)) continue;
    map.set(instrumentId, {
      instrumentId,
      isAccepted: true,
      historyCompleteness: null,
      earliestTransactionDate: null,
      certifiedAsOfDate: null,
    });
  }
  return map;
}
