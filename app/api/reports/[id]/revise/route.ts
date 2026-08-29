import { createClient } from '@/lib/supabase/server';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { generateReport, type ReportTypeCode } from '@/lib/services/reportsData';

// Corrections create a new report version rather than overwriting the
// published original (Rule 9/10). The original is marked 'superseded' and
// linked via revises_report_id.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const body = await req.json().catch(() => ({}));
  if (!body?.reason) return bad('A revision reason is required', 422);

  // II-R10 fix (risk-based closure session): this route previously never
  // passed `reportType` to generateReport(), so every revision silently
  // defaulted to 'monthly_financial_health' regardless of the original
  // report's actual type — a 'net_worth' or 'goal_progress' report,
  // revised, would try to regenerate as a Monthly Financial Health Report
  // and fail its own stricter eligibility gate (Financial Health Score +
  // income + expenses), leaving the "revision" silently FAILED with no
  // indication to the caller why. Live-reproduced this session via
  // scripts/r10_nc3_stale_forecast.mjs. Fix: look up the original report's
  // own type first, exactly the same pattern app/api/reports/[id]/retry/route.ts
  // already uses for the same reason.
  const supabase = await createClient();
  const { data: original } = await supabase.from('reports').select('report_type_code').eq('id', id).eq('user_id', user.id).single();
  if (!original) return bad('Report not found', 404);

  try {
    const result = await generateReport({
      userId: user.id,
      reportType: original.report_type_code as ReportTypeCode,
      reviseReportId: id,
      revisionReason: body.reason,
      triggerType: 'manual',
    });
    return ok(result);
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Could not revise report');
  }
}
