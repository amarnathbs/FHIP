import { requireCountryConfirmedUser as requireUser, ok } from '@/lib/api';
import { attachLifecycleToReviewItems, listReviewItems } from '@/lib/services/investment-intelligence/reviewCentreData';

// R9 spec section 74/78: GET /investment-intelligence/review — paginated,
// deterministic (created_at desc, id desc tie-breaker), never an unbounded
// read (spec section 78).
export async function GET(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const url = new URL(req.url);
  const status = url.searchParams.get('status') ?? undefined;
  const reviewType = url.searchParams.get('type') ?? undefined;
  const limitParam = url.searchParams.get('limit');
  const cursor = url.searchParams.get('cursor') ?? undefined;
  const limit = limitParam ? Number(limitParam) : undefined;

  const { items, nextCursor } = await listReviewItems(user.id, { status, reviewType, limit, cursor });
  // Document2 (4) WP-B: every reconciliation item carries the LIVE lifecycle of its statement (is the raw file still stored?
  // what does the case really need? which actions are real?), so the screen never offers a file-dependent dead end.
  const withLifecycle = await attachLifecycleToReviewItems(user.id, items);
  return ok({ items: withLifecycle, nextCursor });
}
