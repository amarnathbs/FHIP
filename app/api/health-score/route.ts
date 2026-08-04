import { requireUser, ok, bad } from '@/lib/api';
import { loadHealthScore } from '@/lib/services/healthScoreData';

export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  try {
    const payload = await loadHealthScore(user.id);
    return ok(payload);
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Could not load health score');
  }
}
