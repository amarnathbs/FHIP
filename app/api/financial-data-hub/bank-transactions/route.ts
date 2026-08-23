import { requireUser, bad, ok } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';

const PAGE_SIZE_DEFAULT = 100;
const PAGE_SIZE_MAX = 500;

// GET /api/financial-data-hub/bank-transactions?account_id=&limit=&before_date=&before_id=
// spec section 54. Deterministic, keyset-style pagination: ordered by
// (transaction_date desc, id desc), a stable unique tie-breaker (spec 76)
// — never transaction_date alone, which can repeat many times over.
export async function GET(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const url = new URL(req.url);
  const accountId = url.searchParams.get('account_id');
  const limitParam = Number(url.searchParams.get('limit') ?? PAGE_SIZE_DEFAULT);
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(1, limitParam), PAGE_SIZE_MAX) : PAGE_SIZE_DEFAULT;
  const beforeDate = url.searchParams.get('before_date');
  const beforeId = url.searchParams.get('before_id');

  const supabase = await createClient();
  let query = supabase
    .from('fdh_transactions')
    .select(
      'id, financial_account_id, transaction_date, posting_date, value_date, description_raw, description_clean, ' +
        'amount_original, currency_original, credit_debit, economic_transaction_type, transaction_type_hint, ' +
        'dedup_status, review_status, source_row, statement_upload_id, created_at',
    )
    .eq('user_id', user.id)
    .order('transaction_date', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit);

  if (accountId) query = query.eq('financial_account_id', accountId);
  if (beforeDate && beforeId) {
    query = query.or(`transaction_date.lt.${beforeDate},and(transaction_date.eq.${beforeDate},id.lt.${beforeId})`);
  }

  const { data, error } = await query;
  if (error) return bad('could not list transactions', 500);

  return ok({ transactions: data ?? [], page_size: limit });
}
