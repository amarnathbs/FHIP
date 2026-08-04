import { requireUser, ok, bad } from '@/lib/api';
import { loadResilience } from '@/lib/services/resilienceData';

export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  try {
    const payload = await loadResilience(user.id);
    return ok(payload);
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Could not load resilience score');
  }
}
