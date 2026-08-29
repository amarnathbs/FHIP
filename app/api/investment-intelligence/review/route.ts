import { requireCountryConfirmedUser as requireUser, ok } from '@/lib/api';
import { listReviewItems } from '@/lib/services/investment-intelligence/reviewCentreData';

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
  return ok({ items, nextCursor });
}
