import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { syncReviewItemsWithCases } from '@/lib/services/investment-intelligence/reviewCentreData';

// Document2 (4) WP-B (F6/F7/F8) -- cheap, per-user: resolve Review items whose reconciliation case is no longer open and tidy
// the exact duplicates / already-answered owner questions that repeated reprocessing opened. Unlike `refresh` it recomputes
// no goal / performance / tax rule, so the Review screen runs it every time it opens.
export async function POST() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  try {
    return ok(await syncReviewItemsWithCases(user.id));
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Review sync failed', 500);
  }
}
