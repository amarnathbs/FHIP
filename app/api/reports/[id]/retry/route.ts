import { createClient } from '@/lib/supabase/server';
import { requireUser, ok, bad } from '@/lib/api';
import { generateReport, type ReportTypeCode } from '@/lib/services/reportsData';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { data: failedReport } = await supabase.from('reports').select('report_type_code, report_month, status').eq('id', id).eq('user_id', user.id).single();
  if (!failedReport) return bad('Report not found', 404);
  if (failedReport.status !== 'failed') return bad('Only a failed report can be retried', 409);

  try {
    const result = await generateReport({
      userId: user.id,
      reportType: failedReport.report_type_code as ReportTypeCode,
      reportMonth: failedReport.report_month,
      triggerType: 'manual',
    });
    // Superseded by a fresh attempt — archive the failed row so it doesn't
    // linger in report history alongside the newly generated report.
    if (result.report.status !== 'failed') {
      await supabase.from('reports').update({ status: 'archived' }).eq('id', id);
    }
    return ok(result);
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Could not retry report generation');
  }
}
