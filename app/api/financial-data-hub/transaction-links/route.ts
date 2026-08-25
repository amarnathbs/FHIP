import { requireUser, bad, ok } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';

/**
 * GET /api/financial-data-hub/transaction-links?transaction_id=<id>
 *
 * FDH-8 closure (spec Phase I) — a minimal, READ-ONLY addition needed so the
 * review workspace can discover which `fdh_transaction_links` row (transfer,
 * settlement, refund, reversal, duplicate) applies to a given transaction
 * before calling the EXISTING, unchanged
 * `POST /transaction-links/{linkId}/review` action. This adds no new
 * mutation, no new approval semantics, and no new table — it queries the
 * same `fdh_transaction_links` table `[linkId]/review/route.ts` already
 * reads and writes, scoped by RLS (`auth.uid() = user_id`) plus the
 * explicit `.eq('user_id', ...)` defence-in-depth every other FDH route
 * uses. `transaction_id` is REQUIRED — this is intentionally not a general
 * "list all my links" endpoint (out of scope for this closure pass; the
 * review workspace only ever needs links for one focused transaction at a
 * time).
 */
export async function GET(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const url = new URL(req.url);
  const transactionId = url.searchParams.get('transaction_id');
  if (!transactionId) return bad('transaction_id is required', 422);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('fdh_transaction_links')
    .select('id, transaction_id_from, transaction_id_to, link_type, status, confidence, created_by_method, user_confirmed')
    .eq('user_id', user.id)
    .or(`transaction_id_from.eq.${transactionId},transaction_id_to.eq.${transactionId}`)
    .order('created_at', { ascending: false });
  if (error) return bad('could not list transaction links', 500);

  return ok({ links: data ?? [] });
}
