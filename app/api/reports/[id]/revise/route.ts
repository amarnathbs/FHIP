import { requireUser, ok, bad } from '@/lib/api';
import { generateReport } from '@/lib/services/reportsData';

// Corrections create a new report version rather than overwriting the
// published original (Rule 9/10). The original is marked 'superseded' and
// linked via revises_report_id.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const body = await req.json().catch(() => ({}));
  if (!body?.reason) return bad('A revision reason is required', 422);
  try {
    const result = await generateReport({
      userId: user.id,
      reviseReportId: id,
      revisionReason: body.reason,
      triggerType: 'manual',
    });
    return ok(result);
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Could not revise report');
  }
}
