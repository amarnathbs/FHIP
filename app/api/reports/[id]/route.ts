import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { getReport, archiveReport, recordAccessEvent } from '@/lib/services/reportsData';
import { newCorrelationId, typedError } from '@/lib/services/reportApiResponses';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const correlationId = newCorrelationId();
  try {
    const result = await getReport(user.id, id);
    if (!result) return typedError(404, 'REPORT_NOT_FOUND', 'Report not found', correlationId, false);
    // Recording that the report was viewed must never stop it being read.
    await recordAccessEvent(user.id, id, 'viewed').catch((err) => console.error('[reports] view event not recorded', { correlationId, reportId: id, message: err instanceof Error ? err.message : String(err) }));
    return ok(result);
  } catch (e) {
    console.error('[reports] report read failed', { correlationId, reportId: id, message: e instanceof Error ? e.message : String(e) });
    return typedError(500, 'REPORT_READ_FAILED', 'The report could not be read just now. Please try again.', correlationId, true);
  }
}

// Deletion normally archives a report rather than permanently removing it.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  try {
    const report = await archiveReport(user.id, id);
    return ok(report);
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Could not archive report');
  }
}
