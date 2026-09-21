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
// - needed_by_accepted_statement_history(row): an instrument is "accepted"
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
  /** True for status IN ('certified', 'certified_with_warnings'). */
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
