import { requireCountryConfirmedUser as requireUser, ok } from '@/lib/api';
import { listOpenUnresolvedItemsForUser } from '@/lib/aie/db/repository';

// GET /api/aie/unresolved-items — diagnostic listing only (EXC-10: AIE-1.1
// deliberately does not build the real reviewer UI; that is AIE-1.5's job).
// Exists so this phase's own live-DEV evidence and tests have something to
// call, and so a future AIE-1.5 pass has a proven query shape to build on.
export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const items = await listOpenUnresolvedItemsForUser(user.id);
  return ok({ items });
}
