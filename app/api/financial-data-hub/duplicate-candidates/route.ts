import { requireUser, bad, ok } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';

/**
 * GET /api/financial-data-hub/duplicate-candidates?transaction_id=<id>
 *
 * FDH-8 closure (spec Phase I) companion to `transaction-links/route.ts` —
 * same rationale: a minimal, READ-ONLY lookup so the review workspace can
 * find the `fdh_duplicate_candidates` row for a focused transaction before
 * calling the EXISTING, unchanged
 * `POST /bank-transactions/{transactionId}/duplicate-resolution` action.
 * No new mutation, no new table, RLS-scoped exactly like every other FDH
 * read route. `transaction_id` is required — not a general listing endpoint.
 */
export async function GET(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const url = new URL(req.url);
  const transactionId = url.searchParams.get('transaction_id');
  if (!transactionId) return bad('transaction_id is required', 422);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('fdh_duplicate_candidates')
    .select('id, transaction_id_a, transaction_id_b, match_method, confidence, status, reason_code, user_resolution')
    .eq('user_id', user.id)
    .or(`transaction_id_a.eq.${transactionId},transaction_id_b.eq.${transactionId}`)
    .order('created_at', { ascending: false });
  if (error) return bad('could not list duplicate candidates', 500);

  return ok({ candidates: data ?? [] });
}
