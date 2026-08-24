import { requireUser, bad, ok } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';

const PAGE_SIZE_DEFAULT = 100;
const PAGE_SIZE_MAX = 500;

/**
 * GET /api/financial-data-hub/review-queue — FDH-7 spec sections 20-22,
 * 67-70. A focused review queue (never full expense analytics — spec 7, 20).
 *
 * SCALE (spec 68, 94, 127). Section counts use Supabase `count: 'exact'`,
 * which runs a genuine `SELECT count(*)` server-side and is NOT subject to
 * PostgREST's default row-return cap — this is the exact class of defect
 * FDH-6 found and fixed in `listForUser()` (which returns rows, not a
 * count). The LIST itself is deterministically keyset-paginated
 * (transaction_date desc, id desc — same stable tie-breaker convention as
 * `bank-transactions/route.ts`), so requesting more than one page is the
 * expected, correct behaviour, not a truncation defect.
 */
export async function GET(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const url = new URL(req.url);
  const limitParam = Number(url.searchParams.get('limit') ?? PAGE_SIZE_DEFAULT);
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(1, limitParam), PAGE_SIZE_MAX) : PAGE_SIZE_DEFAULT;
  const beforeDate = url.searchParams.get('before_date');
  const beforeId = url.searchParams.get('before_id');
  const accountId = url.searchParams.get('account_id');

  const supabase = await createClient();

  let itemsQuery = supabase
    .from('fdh_transactions')
    .select(
      'id, financial_account_id, transaction_date, description_clean, amount_original, currency_original, ' +
        'credit_debit, economic_transaction_type, category_id, review_status, approval_status, classification_confidence',
    )
    .eq('user_id', user.id)
    .in('review_status', ['pending', 'in_review'])
    .order('transaction_date', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit);
  if (accountId) itemsQuery = itemsQuery.eq('financial_account_id', accountId);
  if (beforeDate && beforeId) {
    itemsQuery = itemsQuery.or(`transaction_date.lt.${beforeDate},and(transaction_date.eq.${beforeDate},id.lt.${beforeId})`);
  }

  const [items, needsReviewCount, transfersCount, duplicatesCount, uncategorisedCount, lowConfidenceCount, recurringCandidateCount, readyToApproveCount] =
    await Promise.all([
      itemsQuery,
      supabase.from('fdh_transactions').select('id', { count: 'exact', head: true }).eq('user_id', user.id).in('review_status', ['pending', 'in_review']),
      supabase.from('fdh_transaction_links').select('id', { count: 'exact', head: true }).eq('user_id', user.id).eq('status', 'pending').in('link_type', ['internal_transfer', 'credit_card_settlement']),
      supabase.from('fdh_duplicate_candidates').select('id', { count: 'exact', head: true }).eq('user_id', user.id).eq('status', 'pending'),
      supabase.from('fdh_transactions').select('id', { count: 'exact', head: true }).eq('user_id', user.id).eq('economic_transaction_type', 'unknown'),
      supabase.from('fdh_transactions').select('id', { count: 'exact', head: true }).eq('user_id', user.id).lte('classification_confidence', 0.6).not('classification_confidence', 'is', null),
      supabase.from('fdh_recurring_transactions').select('id', { count: 'exact', head: true }).eq('user_id', user.id).eq('status', 'candidate'),
      supabase.from('fdh_transactions').select('id', { count: 'exact', head: true }).eq('user_id', user.id).eq('approval_status', 'pending').eq('review_status', 'not_required'),
    ]);

  if (items.error) return bad('could not list review items', 500);

  return ok({
    items: items.data ?? [],
    page_size: limit,
    sections: {
      needs_attention: needsReviewCount.count ?? 0,
      transfers: transfersCount.count ?? 0,
      possible_duplicates: duplicatesCount.count ?? 0,
      uncategorised: uncategorisedCount.count ?? 0,
      low_confidence: lowConfidenceCount.count ?? 0,
      recurring_candidates: recurringCandidateCount.count ?? 0,
      ready_to_approve: readyToApproveCount.count ?? 0,
    },
  });
}
