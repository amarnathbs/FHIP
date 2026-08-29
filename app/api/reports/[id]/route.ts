import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { getReport, archiveReport, recordAccessEvent } from '@/lib/services/reportsData';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const result = await getReport(user.id, id);
  if (!result) return bad('Report not found', 404);
  await recordAccessEvent(user.id, id, 'viewed');
  return ok(result);
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
