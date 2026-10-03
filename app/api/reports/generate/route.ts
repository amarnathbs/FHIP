import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { generateReport, type ReportTypeCode } from '@/lib/services/reportsData';
import { waitingResponseFor } from '@/lib/services/investment-intelligence/pc6/reportNavHistoryGate';

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
    // PO 2026-10-03: held until the price history of the user's funds is loaded (HTTP 202, nothing stored).
    const waiting = waitingResponseFor(e);
    if (waiting) return waiting;
    return bad(e instanceof Error ? e.message : 'Could not generate report');
  }
}
