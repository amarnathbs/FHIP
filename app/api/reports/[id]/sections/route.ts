import { requireCountryConfirmedUser as requireUser, ok } from '@/lib/api';
import { getReport } from '@/lib/services/reportsData';
import { newCorrelationId, typedError } from '@/lib/services/reportApiResponses';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const correlationId = newCorrelationId();
  try {
    const result = await getReport(user.id, id);
    if (!result) return typedError(404, 'REPORT_NOT_FOUND', 'Report not found', correlationId, false);
    return ok(result.sections);
  } catch (e) {
    console.error('[reports] sections read failed', { correlationId, reportId: id, message: e instanceof Error ? e.message : String(e) });
    return typedError(500, 'REPORT_READ_FAILED', 'The report sections could not be read just now. Please try again.', correlationId, true);
  }
}
