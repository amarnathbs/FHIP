// Investment Intelligence R11 — professional report-access proxy (spec
// section 65 / LIVE-R11-017): "R11 must consume existing R10 report
// security, not create a professional report engine." This route computes
// NOTHING — it reads the exact same `reports` + `report_sections` rows
// `getReport()` (lib/services/reportsData.ts) already returns to the
// report's OWNER, gated by the SAME `VIEW_REPORTS` scope check every other
// professional-facing proxy in this module uses (checkAccessLive), via the
// service-role client for the identical reason investments-summary/route.ts
// already documents: the professional is not the row owner, so the
// RLS-respecting client would correctly return nothing regardless of scope.
//
// This mirrors the already-written-but-never-wired `recordReportAccess()`
// helper (lib/services/professional-access/access.ts) — that function
// existed with no caller anywhere in the app before this route; wiring it
// up here closes that gap rather than introducing new scope.
import { requireUser, ok, bad } from '@/lib/api';
import { createAdminClient } from '@/lib/supabase/admin';
import { checkAccessLive, recordReportAccess, fetchAccessContext } from '@/lib/services/professional-access/access';

export async function GET(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const url = new URL(req.url);
  const clientUserId = url.searchParams.get('clientUserId');
  const reportId = url.searchParams.get('reportId');
  if (!clientUserId) return bad('clientUserId query parameter is required.');
  if (!reportId) return bad('reportId query parameter is required.');

  const decision = await checkAccessLive(clientUserId, user.id, 'VIEW_REPORTS');
  if (!decision.allow) return bad(decision.reason, 403);

  const admin = createAdminClient();
  const { data: report, error } = await admin.from('reports').select('*').eq('id', reportId).eq('user_id', clientUserId).single();
  if (error || !report) return bad('Report not found', 404);
  const { data: sections } = await admin.from('report_sections').select('*').eq('report_id', reportId).order('display_order');

  // Best-effort audit trail — the relationship id is re-derived rather than
  // trusted from the client, same discipline as every write in access.ts.
  const ctx = await fetchAccessContext(clientUserId, user.id);
  if (ctx.relationship) {
    await recordReportAccess(ctx.relationship.id, user.id, clientUserId, reportId, 'view');
  }

  return ok({ report, sections: sections ?? [] });
}
