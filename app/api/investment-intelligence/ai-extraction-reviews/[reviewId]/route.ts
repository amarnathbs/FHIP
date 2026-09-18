import { createClient } from '@/lib/supabase/server';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';

// Investment Intelligence — AI-fallback document extraction review
// (2026-09-17 PO addendum). Read-only fetch of a pending/decided review for
// display in the accept/reject UI. RLS-scoped request client — a mismatched
// reviewId simply yields 404, never another user's extracted holdings.
export async function GET(request: Request, { params }: { params: Promise<{ reviewId: string }> }) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const { reviewId } = await params;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('ii_ai_extraction_reviews')
    .select('id, source_document_id, trigger_reason, status, extracted_holdings, provider_confidence, created_at, decided_at')
    .eq('id', reviewId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) return bad(`Could not load the AI extraction review: ${error.message}`, 500);
  if (!data) return bad('AI extraction review not found.', 404);
  return ok(data);
}
