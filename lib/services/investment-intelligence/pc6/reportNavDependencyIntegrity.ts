// NAV 1 — PO decision #6 (2026-09-27): a finalized report's NAV dependency
// later becoming missing must fail closed, not silently recalculate.
//
// WHAT ALREADY EXISTS (verified by reading the code, not assumed — see
// docs/nav1/NAV1_PO_DECISION_2_5_6_2026-09-27.md for the full trail):
//   - Module 9 finalized reports (`reports`/`report_sections`) already
//     store FROZEN output (reportsData.ts writes `section_data_json` once
//     at generation; getReport()/getReportByRenderToken() only ever SELECT
//     — never recompute). PO #6(a)/(c) are already true.
//   - Regeneration already goes through a real version chain
//     (`reports.version_number`, `revises_report_id`, `status='superseded'`)
//     — a revision always inserts a NEW row, never overwrites in place.
//     PO #6(e) is already true.
//   - `ii_report_nav_dependencies` (0172) + `pc6_nav_row_is_candidate()`
//     (0200/0219) already protect a report's pinned range from Stage-E
//     deletion. PO #6(f) is already true for the exact range a report
//     recorded — 0219 additionally protects a *coverage gap* range even
//     for an instrument nothing has pinned yet.
//
// WHAT THIS FILE ADDS — the one genuinely missing piece, PO #6(b): a
// DETECTOR that notices when a dependency a report already relied on no
// longer has the NAV coverage it had at generation time (a bug, a bypassed
// predicate, an operator mistake — anything that deleted rows the manifest
// says a report needs), and raises a queryable alert
// (ii_report_nav_dependency_alerts, migration 0223). This file NEVER
// recalculates a report and NEVER edits report_sections/report_snapshots —
// see reportNavDependencyAlertLive.ts for the one, small, real DB
// read+write, split the same way this programme already splits every
// pure-computation file from its live-DB counterpart
// (reportNavDependencyManifest.ts vs reportNavDependencyWriter.ts;
// selectiveHistoricalHydrationJob.ts vs ...Live.ts).
//
// WHAT A "COVERAGE PROBE" CAN AND CANNOT PROVE. `ii_report_nav_dependencies`
// is a COMPACT RANGE manifest (migration 0172's own header), not a list of
// the exact dates a report used. This file therefore checks three bounded
// signals, not an exact per-date reconciliation:
//   1. rowsFound > 0 somewhere in the range at all;
//   2. a row within BOUNDARY_TOLERANCE_DAYS of the range's required latest
//      date (nav_date_to);
//   3. when nav_date_from is not null (a bounded lower edge, not "from
//      inception"), a row within the same tolerance of it.
// The tolerance exists because a "required" date can legitimately fall on
// a weekend/holiday with no NAV published — the same idiom this
// programme's own reconciliation scripts already use (nav1_p6_provider_
// accuracy_probe.mjs, nav1_daily_coverage_probe.mjs). This WILL catch the
// realistic failure this decision is worried about (a whole range wiped by
// a bug or a bypassed predicate) and WILL NOT catch a single date deleted
// out of a thousand — stated plainly rather than claimed as exhaustive.

/** Matches the tolerance idiom already used by nav1_p6_provider_accuracy_probe.mjs-style reconciliation for a legitimate non-trading day. */
export const BOUNDARY_TOLERANCE_DAYS = 7;

export type ReportNavDependencyBasis =
  | 'xirr_since_inception'
  | 'twr_since_opening_balance'
  | 'rolling_return_window'
  | 'sip_xray_transaction_history'
  | 'tax_lot_fifo'
  | 'other';

export interface ReportNavDependencyRow {
  id: string;
  reportId: string;
  instrumentId: string;
  basis: ReportNavDependencyBasis;
  navDateFrom: string | null;
  navDateTo: string;
}

/** What the live layer must measure against ii_prices_nav for one dependency row. Kept minimal and DB-shape-agnostic so this stays testable without a client. */
export interface NavCoverageProbe {
  rowsFound: number;
  hasRowNearFrom: boolean | null; // null when navDateFrom is null — "from inception", nothing to check at a lower edge
  hasRowNearTo: boolean;
}

export type IntegrityVerdict = { healthy: true } | { healthy: false; reason: string };

/**
 * PURE. No I/O. Given one dependency row and what the live layer measured
 * for it, decide whether the report's own recorded need is still met.
 * Order matters for the reason text: "zero rows at all" is a more useful
 * diagnostic than "missing the boundary" when both are true.
 */
export function deriveIntegrityVerdict(dep: ReportNavDependencyRow, probe: NavCoverageProbe): IntegrityVerdict {
  if (probe.rowsFound === 0) {
    return {
      healthy: false,
      reason: `no NAV rows remain for instrument ${dep.instrumentId} anywhere in [${dep.navDateFrom ?? 'inception'}, ${dep.navDateTo}] (basis ${dep.basis}) — the report's own recorded dependency range now has zero coverage`,
    };
  }
  if (!probe.hasRowNearTo) {
    return {
      healthy: false,
      reason: `no NAV row within ${BOUNDARY_TOLERANCE_DAYS} days of the dependency's required latest date ${dep.navDateTo} for instrument ${dep.instrumentId} (basis ${dep.basis})`,
    };
  }
  if (dep.navDateFrom !== null && probe.hasRowNearFrom === false) {
    return {
      healthy: false,
      reason: `no NAV row within ${BOUNDARY_TOLERANCE_DAYS} days of the dependency's required earliest date ${dep.navDateFrom} for instrument ${dep.instrumentId} (basis ${dep.basis})`,
    };
  }
  return { healthy: true };
}

export interface AlertUpsertPlan {
  kind: 'open_new' | 'refresh_existing' | 'resolve_existing' | 'no_action';
  detail?: string;
}

/**
 * PURE. Given the current verdict and whether an alert is already open for
 * this exact (report, instrument, basis), decide what write (if any) the
 * live layer should perform. Never "reopens" a resolved alert by mutating
 * it — a fresh break after a real resolution gets its own new row (matches
 * migration 0223's own dedup-by-open-rows-only index and this programme's
 * existing ii_nav_retention_holds "re-open vs extend" idiom).
 */
export function planAlertWrite(verdict: IntegrityVerdict, hasOpenAlert: boolean): AlertUpsertPlan {
  if (!verdict.healthy) {
    return hasOpenAlert ? { kind: 'refresh_existing', detail: verdict.reason } : { kind: 'open_new', detail: verdict.reason };
  }
  return hasOpenAlert ? { kind: 'resolve_existing', detail: 'coverage restored on re-check' } : { kind: 'no_action' };
}
