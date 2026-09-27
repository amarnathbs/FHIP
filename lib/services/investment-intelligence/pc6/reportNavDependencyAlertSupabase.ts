// NAV 1 — PO decision #6(b): the real Supabase-backed
// ReportNavDependencyAlertClient. Kept separate from
// reportNavDependencyAlertLive.ts (orchestration) so that file stays
// unit-testable with a fake client — the same split
// selectiveHistoricalHydrationJobLive.ts already uses against
// selectiveHistoricalHydrationJob.ts.
//
// Uses createAdminClient() (service role, bypasses RLS) because
// ii_report_nav_dependencies and ii_report_nav_dependency_alerts are both
// admin-read-only tables with no policy for any other role (migrations
// 0172, 0223) — an ordinary authenticated client could not read or write
// either one.

import { createAdminClient } from '@/lib/supabase/admin';
import type { ReportNavDependencyAlertClient } from './reportNavDependencyAlertLive';
import type { ReportNavDependencyBasis, ReportNavDependencyRow } from './reportNavDependencyIntegrity';

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function createLiveReportNavDependencyAlertClient(): ReportNavDependencyAlertClient {
  const db = createAdminClient();

  return {
    async countNavRowsInRange(instrumentId, from, to) {
      let q = db.from('ii_prices_nav').select('id', { count: 'exact', head: true }).eq('instrument_id', instrumentId).lte('price_date', to);
      if (from !== null) q = q.gte('price_date', from);
      const { count, error } = await q;
      if (error) throw new Error(`countNavRowsInRange(${instrumentId}) failed: ${error.message}`);
      return count ?? 0;
    },

    async hasNavRowNear(instrumentId, date, toleranceDays) {
      const { count, error } = await db
        .from('ii_prices_nav')
        .select('id', { count: 'exact', head: true })
        .eq('instrument_id', instrumentId)
        .gte('price_date', addDaysIso(date, -toleranceDays))
        .lte('price_date', addDaysIso(date, toleranceDays));
      if (error) throw new Error(`hasNavRowNear(${instrumentId}, ${date}) failed: ${error.message}`);
      return (count ?? 0) > 0;
    },

    async listDependencies(reportIds) {
      let q = db.from('ii_report_nav_dependencies').select('id, report_id, instrument_id, basis, nav_date_from, nav_date_to');
      if (reportIds && reportIds.length > 0) q = q.in('report_id', reportIds);
      const { data, error } = await q;
      if (error) throw new Error(`listDependencies failed: ${error.message}`);
      return (data ?? []).map(
        (r): ReportNavDependencyRow => ({
          id: r.id as string,
          reportId: r.report_id as string,
          instrumentId: r.instrument_id as string,
          basis: r.basis as ReportNavDependencyBasis,
          navDateFrom: (r.nav_date_from as string | null) ?? null,
          navDateTo: r.nav_date_to as string,
        })
      );
    },

    async findOpenAlert(reportId, instrumentId, basis) {
      const { data, error } = await db
        .from('ii_report_nav_dependency_alerts')
        .select('id')
        .eq('report_id', reportId)
        .eq('instrument_id', instrumentId)
        .eq('basis', basis)
        .is('resolved_at', null)
        .limit(1);
      if (error) throw new Error(`findOpenAlert(${reportId}, ${instrumentId}, ${basis}) failed: ${error.message}`);
      return data && data.length > 0 ? { id: data[0].id as string } : null;
    },

    async insertAlert(row) {
      const { error } = await db.from('ii_report_nav_dependency_alerts').insert({
        report_id: row.reportId,
        report_nav_dependency_id: row.reportNavDependencyId,
        instrument_id: row.instrumentId,
        basis: row.basis,
        nav_date_from: row.navDateFrom,
        nav_date_to: row.navDateTo,
        rows_found: row.rowsFound,
        detail: row.detail,
        detected_by: 'reportNavDependencyIntegrity',
      });
      if (error) throw new Error(`insertAlert(${row.reportId}, ${row.instrumentId}, ${row.basis}) failed: ${error.message}`);
    },

    async refreshAlert(alertId, rowsFound, detail) {
      const { error } = await db
        .from('ii_report_nav_dependency_alerts')
        .update({ rows_found: rowsFound, detail, detected_at: new Date().toISOString() })
        .eq('id', alertId);
      if (error) throw new Error(`refreshAlert(${alertId}) failed: ${error.message}`);
    },

    async resolveAlert(alertId, detail) {
      const { error } = await db
        .from('ii_report_nav_dependency_alerts')
        .update({ resolved_at: new Date().toISOString(), resolution_detail: detail })
        .eq('id', alertId);
      if (error) throw new Error(`resolveAlert(${alertId}) failed: ${error.message}`);
    },
  };
}
