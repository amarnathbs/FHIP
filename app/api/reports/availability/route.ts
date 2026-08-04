import { requireUser, ok, bad } from '@/lib/api';
import { resolveReportSourceData, buildEligibilityInput, isEligibleForOfficialMonthlyReport } from '@/lib/services/reportSnapshotResolver';
import { createClient } from '@/lib/supabase/server';

function monthStart(date = new Date()): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

export async function GET(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const url = new URL(req.url);
  const reportMonth = url.searchParams.get('month') ?? monthStart();

  try {
    const source = await resolveReportSourceData(user.id, reportMonth);
    const eligibility = isEligibleForOfficialMonthlyReport(buildEligibilityInput(source));

    const supabase = await createClient();
    const { data: existing } = await supabase
      .from('reports')
      .select('id, status, version_number')
      .eq('user_id', user.id)
      .eq('report_type_code', 'monthly_financial_health')
      .eq('report_month', reportMonth)
      .in('status', ['ready', 'published'])
      .is('revises_report_id', null)
      .maybeSingle();

    return ok({ eligible: eligibility.eligible, reason: eligibility.reason, existingReport: existing ?? null });
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Could not check report availability');
  }
}
