import { requireUser, ok, bad } from '@/lib/api';
import { publishReport } from '@/lib/services/reportsData';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  try {
    const report = await publishReport(user.id, id);
    return ok(report);
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Could not publish report');
  }
}
