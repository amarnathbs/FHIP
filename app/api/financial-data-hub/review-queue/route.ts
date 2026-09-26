import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { fetchAllRows, type RangeableQuery } from '@/lib/financial-data-hub/bank-csv/pagination';
import { LOW_CONFIDENCE_CEILING } from '@/lib/financial-data-hub/domain/categoryReview';

const PAGE_SIZE_DEFAULT = 100;
const PAGE_SIZE_MAX = 500;

/**
 * The ONE definition of "needs your attention" used by BOTH the list and the
 * tiles (2026-09-26, production bug 2: the tiles counted 3 uncategorised and
 * 4 low-confidence lines while the list — filtered on `review_status` only —
 * said "Nothing to review"). A transaction needs attention when it is still
 * waiting for approval AND any of:
 *   - its review is still open (`review_status` pending / in_review);
 *   - it is uncategorised (`economic_transaction_type = 'unknown'` — the
 *     column FDH-7's approval gate and Monthly Surplus actually read);
 *   - it is low confidence: FDH-6's own boundary (`<= LOW`, 0.3 — see
 *     `domain/categoryReview.ts`), never a person's own decision.
 * The same three predicates are the `uncategorised` / `low_confidence` tile
 * filters, applied server-side (the old client-side filter only saw the
 * first page of 100 rows).
 */
const UNCATEGORISED = 'economic_transaction_type.eq.unknown';
const LOW_CONFIDENCE = `and(classification_confidence.lte.${LOW_CONFIDENCE_CEILING},economic_transaction_type.neq.unknown,user_override.is.false)`;
const NEEDS_ATTENTION = `review_status.in.(pending,in_review),${UNCATEGORISED},${LOW_CONFIDENCE}`;

const REASONS = ['needs_attention', 'uncategorised', 'low_confidence', 'awaiting_approval', 'transfers', 'duplicates'] as const;
type Reason = (typeof REASONS)[number];

/**
 * GET /api/financial-data-hub/review-queue — FDH-7 spec sections 20-22,
 * 67-70. A focused review queue (never full expense analytics — spec 7, 20).
 *
 * SCALE (spec 68, 94, 127). Section counts use Supabase `count: 'exact'`,
 * which runs a genuine `SELECT count(*)` server-side and is NOT subject to
 * PostgREST's default row-return cap. The LIST itself is deterministically
 * keyset-paginated (transaction_date desc, id desc).
 *
 * `?reason=` narrows the list to exactly the rows a tile counts.
 * `statements` lists the user's statements that still have transactions
 * waiting for approval, so the page can send the user to the category
 * review of each one instead of line-by-line review.
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
  const reasonParam = url.searchParams.get('reason');
  const reason: Reason = (REASONS as readonly string[]).includes(reasonParam ?? '') ? (reasonParam as Reason) : 'needs_attention';

  const supabase = await createClient();

  // Link/duplicate-based tiles narrow the list to the transactions involved.
  let restrictToIds: string[] | null = null;
  if (reason === 'transfers') {
    const { data } = await supabase
      .from('fdh_transaction_links')
      .select('transaction_id_from, transaction_id_to')
      .eq('user_id', user.id)
      .eq('status', 'pending')
      .in('link_type', ['internal_transfer', 'credit_card_settlement'])
      .limit(PAGE_SIZE_MAX);
    restrictToIds = [...new Set(((data ?? []) as Array<{ transaction_id_from: string; transaction_id_to: string | null }>).flatMap((l) => [l.transaction_id_from, l.transaction_id_to].filter((x): x is string => Boolean(x))))];
  } else if (reason === 'duplicates') {
    const { data } = await supabase
      .from('fdh_duplicate_candidates')
      .select('transaction_id_a, transaction_id_b')
      .eq('user_id', user.id)
      .eq('status', 'pending')
      .limit(PAGE_SIZE_MAX);
    restrictToIds = [...new Set(((data ?? []) as Array<{ transaction_id_a: string; transaction_id_b: string }>).flatMap((d) => [d.transaction_id_a, d.transaction_id_b]))];
  }

  let itemsQuery = supabase
    .from('fdh_transactions')
    .select(
      'id, financial_account_id, statement_upload_id, transaction_date, description_clean, amount_original, currency_original, ' +
        'credit_debit, economic_transaction_type, category_id, review_status, approval_status, classification_confidence, classification_method',
    )
    .eq('user_id', user.id)
    .eq('approval_status', 'pending')
    .order('transaction_date', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit);
  // One `or=` parameter only: the reason filter and the keyset cursor are
  // combined into a single expression rather than sent as two `or` params.
  const reasonFilter =
    reason === 'needs_attention' ? NEEDS_ATTENTION : reason === 'uncategorised' ? UNCATEGORISED : reason === 'low_confidence' ? LOW_CONFIDENCE : null;
  const keysetFilter =
    beforeDate && beforeId ? `transaction_date.lt.${beforeDate},and(transaction_date.eq.${beforeDate},id.lt.${beforeId})` : null;
  if (reasonFilter && keysetFilter) itemsQuery = itemsQuery.or(`and(or(${reasonFilter}),or(${keysetFilter}))`);
  else if (reasonFilter) itemsQuery = itemsQuery.or(reasonFilter);
  else if (keysetFilter) itemsQuery = itemsQuery.or(keysetFilter);
  if (restrictToIds) itemsQuery = itemsQuery.in('id', restrictToIds.length > 0 ? restrictToIds : ['00000000-0000-0000-0000-000000000000']);
  if (accountId) itemsQuery = itemsQuery.eq('financial_account_id', accountId);

  const pendingCount = () =>
    supabase.from('fdh_transactions').select('id', { count: 'exact', head: true }).eq('user_id', user.id).eq('approval_status', 'pending');

  const [items, needsAttentionCount, transfersCount, duplicatesCount, uncategorisedCount, lowConfidenceCount, recurringCandidateCount, awaitingApprovalCount, pendingStatementRows] =
    await Promise.all([
      itemsQuery,
      pendingCount().or(NEEDS_ATTENTION),
      supabase.from('fdh_transaction_links').select('id', { count: 'exact', head: true }).eq('user_id', user.id).eq('status', 'pending').in('link_type', ['internal_transfer', 'credit_card_settlement']),
      supabase.from('fdh_duplicate_candidates').select('id', { count: 'exact', head: true }).eq('user_id', user.id).eq('status', 'pending'),
      pendingCount().or(UNCATEGORISED),
      pendingCount().or(LOW_CONFIDENCE),
      supabase.from('fdh_recurring_transactions').select('id', { count: 'exact', head: true }).eq('user_id', user.id).eq('status', 'candidate'),
      pendingCount(),
      fetchAllRows<{ id: string; statement_upload_id: string | null }>(() =>
        supabase
          .from('fdh_transactions')
          .select('id, statement_upload_id')
          .eq('user_id', user.id)
          .eq('approval_status', 'pending')
          .not('statement_upload_id', 'is', null)
          .order('id', { ascending: true }) as unknown as RangeableQuery<{ id: string; statement_upload_id: string | null }>,
      ).catch(() => [] as Array<{ id: string; statement_upload_id: string | null }>),
    ]);

  if (items.error) return bad('could not list review items', 500);

  const waitingByStatement = new Map<string, number>();
  for (const r of pendingStatementRows) {
    if (r.statement_upload_id) waitingByStatement.set(r.statement_upload_id, (waitingByStatement.get(r.statement_upload_id) ?? 0) + 1);
  }
  const statementIds = [...waitingByStatement.keys()].slice(0, 100);
  let statements: Array<{ id: string; period_start: string | null; period_end: string | null; file_name: string | null; waiting: number }> = [];
  if (statementIds.length > 0) {
    const { data } = await supabase
      .from('fdh_statement_uploads')
      .select('id, statement_period_start, statement_period_end, original_filename_sanitised')
      .eq('user_id', user.id)
      .in('id', statementIds);
    statements = ((data ?? []) as Array<{ id: string; statement_period_start: string | null; statement_period_end: string | null; original_filename_sanitised: string | null }>)
      .map((s) => ({
        id: s.id,
        period_start: s.statement_period_start,
        period_end: s.statement_period_end,
        file_name: s.original_filename_sanitised,
        waiting: waitingByStatement.get(s.id) ?? 0,
      }))
      .sort((a, b) => ((b.period_end ?? '') < (a.period_end ?? '') ? -1 : (b.period_end ?? '') > (a.period_end ?? '') ? 1 : a.id < b.id ? -1 : 1));
  }

  const needsAttention = needsAttentionCount.count ?? 0;
  const awaitingApproval = awaitingApprovalCount.count ?? 0;

  return ok({
    items: items.data ?? [],
    page_size: limit,
    reason,
    sections: {
      needs_attention: needsAttention,
      transfers: transfersCount.count ?? 0,
      possible_duplicates: duplicatesCount.count ?? 0,
      uncategorised: uncategorisedCount.count ?? 0,
      low_confidence: lowConfidenceCount.count ?? 0,
      recurring_candidates: recurringCandidateCount.count ?? 0,
      awaiting_approval: awaitingApproval,
      ready_to_approve: Math.max(0, awaitingApproval - needsAttention),
    },
    statements,
  });
}
