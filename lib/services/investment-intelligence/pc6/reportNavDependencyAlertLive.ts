// NAV 1 — PO decision #6(b), live wiring for reportNavDependencyIntegrity.ts.
//
// The one real DB read+write this mechanism needs: for every recorded
// report NAV dependency (or a caller-supplied subset), measure real NAV
// coverage against ii_prices_nav, derive a verdict (pure, see
// reportNavDependencyIntegrity.ts), and write/refresh/resolve an alert row
// in ii_report_nav_dependency_alerts accordingly.
//
// NEVER touches `reports`, `report_sections` or `report_snapshots` — a
// broken dependency is disclosed here, not repaired here (see
// scripts/nav1_report_dependency_restoration_attempt.ts for a controlled,
// operator-run restoration attempt, PO decision #6(d)).
//
// Uses read-then-write rather than a single upsert against
// ii_report_nav_dependency_alerts's PARTIAL unique index (one open row per
// report/instrument/basis): PostgREST's upsert (`Prefer:
// resolution=merge-duplicates` + `on_conflict=col,col,col`) can only target
// a full, non-partial unique constraint, and this index is deliberately
// partial (`where resolved_at is null`) so a genuinely new alert after a
// real resolution gets its own row instead of reviving the old one. A
// two-step select-then-branch is the same shape this file's own read
// (dependencies) already needs anyway.

import type {
  AlertUpsertPlan,
  IntegrityVerdict,
  NavCoverageProbe,
  ReportNavDependencyRow,
} from './reportNavDependencyIntegrity';
import { BOUNDARY_TOLERANCE_DAYS, deriveIntegrityVerdict, planAlertWrite } from './reportNavDependencyIntegrity';

/** Minimal Supabase-client-shaped surface this file needs — same style as reportNavDependencyWriter.ts's ReportNavDependencyWriteClient. */
export interface ReportNavDependencyAlertClient {
  countNavRowsInRange(instrumentId: string, from: string | null, to: string): Promise<number>;
  hasNavRowNear(instrumentId: string, date: string, toleranceDays: number): Promise<boolean>;
  listDependencies(reportIds?: string[]): Promise<ReportNavDependencyRow[]>;
  findOpenAlert(reportId: string, instrumentId: string, basis: string): Promise<{ id: string } | null>;
  insertAlert(row: {
    reportId: string;
    reportNavDependencyId: string;
    instrumentId: string;
    basis: string;
    navDateFrom: string | null;
    navDateTo: string;
    rowsFound: number;
    detail: string;
  }): Promise<void>;
  refreshAlert(alertId: string, rowsFound: number, detail: string): Promise<void>;
  resolveAlert(alertId: string, detail: string): Promise<void>;
}

export interface DependencyCheckResult {
  dependency: ReportNavDependencyRow;
  verdict: IntegrityVerdict;
  plan: AlertUpsertPlan;
}

async function probeCoverage(client: ReportNavDependencyAlertClient, dep: ReportNavDependencyRow): Promise<NavCoverageProbe> {
  const rowsFound = await client.countNavRowsInRange(dep.instrumentId, dep.navDateFrom, dep.navDateTo);
  const hasRowNearTo = await client.hasNavRowNear(dep.instrumentId, dep.navDateTo, BOUNDARY_TOLERANCE_DAYS);
  const hasRowNearFrom = dep.navDateFrom === null ? null : await client.hasNavRowNear(dep.instrumentId, dep.navDateFrom, BOUNDARY_TOLERANCE_DAYS);
  return { rowsFound, hasRowNearFrom, hasRowNearTo };
}

/**
 * Runs the full check for a batch of dependencies (or every dependency in
 * the system if `reportIds` is omitted) and applies whatever write each
 * verdict calls for. Returns every result so a caller (a script, a
 * scheduled check, an admin action) can report exactly what it found —
 * never swallows a per-dependency failure into a blanket "done".
 */
export async function checkReportNavDependencyIntegrity(
  client: ReportNavDependencyAlertClient,
  reportIds?: string[]
): Promise<DependencyCheckResult[]> {
  const dependencies = await client.listDependencies(reportIds);
  const results: DependencyCheckResult[] = [];
  for (const dep of dependencies) {
    const probe = await probeCoverage(client, dep);
    const verdict = deriveIntegrityVerdict(dep, probe);
    const existing = await client.findOpenAlert(dep.reportId, dep.instrumentId, dep.basis);
    const plan = planAlertWrite(verdict, existing !== null);
    switch (plan.kind) {
      case 'open_new':
        await client.insertAlert({
          reportId: dep.reportId,
          reportNavDependencyId: dep.id,
          instrumentId: dep.instrumentId,
          basis: dep.basis,
          navDateFrom: dep.navDateFrom,
          navDateTo: dep.navDateTo,
          rowsFound: probe.rowsFound,
          detail: plan.detail!,
        });
        break;
      case 'refresh_existing':
        await client.refreshAlert(existing!.id, probe.rowsFound, plan.detail!);
        break;
      case 'resolve_existing':
        await client.resolveAlert(existing!.id, plan.detail!);
        break;
      case 'no_action':
        break;
    }
    results.push({ dependency: dep, verdict, plan });
  }
  return results;
}
