import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { runReviewCentreRefresh } from '@/lib/services/investment-intelligence/reviewCentreData';

// R9 spec sections 74-77: POST /investment-intelligence/review/refresh.
//
// Bounded: scoped to the calling user only, no cross-user fan-out.
// Idempotent: every review item write is keyed by a deterministic
// identity_key (spec section 50); re-running with unchanged evidence
// updates as_of_date only, never inserts a duplicate. Concurrency: the
// partial unique index uidx_ii_review_items_open_identity (migration 0067)
// gives this a real database-level guarantee — two concurrent refreshes
// racing to insert the same open identity_key cannot both succeed; the
// loser's insert fails the unique constraint and that candidate is simply
// skipped on this run (safe: the winner's row already represents the
// current, correct state — the next natural refresh reconciles it).
export async function POST() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  try {
    const result = await runReviewCentreRefresh(user.id);
    return ok(result);
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Review refresh failed', 500);
  }
}
