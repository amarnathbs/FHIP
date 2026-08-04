import { requireUser, ok, bad } from '@/lib/api';
import { generateReport, type ReportTypeCode } from '@/lib/services/reportsData';

export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const body = await req.json().catch(() => ({}));

  const today = new Date();
  const requestedMonth = typeof body.reportMonth === 'string' ? body.reportMonth : undefined;
  if (requestedMonth && new Date(requestedMonth) > today) {
    return bad('Cannot generate a report for a future month', 422);
  }

  try {
    const result = await generateReport({
      userId: user.id,
      reportType: (body.reportType as ReportTypeCode) ?? 'monthly_financial_health',
      reportMonth: requestedMonth,
      triggerType: 'manual',
    });
    return ok(result);
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Could not generate report');
  }
}
