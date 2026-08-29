import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { getTransactions, type TransactionSort } from '@/lib/financial-data-hub/analytics/financialActivityAnalytics';
import { parseActivityParams } from '@/lib/financial-data-hub/analytics/requestParams';
import type { FdhEconomicTransactionType, FdhTransactionApprovalStatus } from '@/lib/financial-data-hub/constants/enums';

const SORTS: readonly TransactionSort[] = ['newest', 'oldest', 'highest', 'lowest', 'merchant'];

// GET /api/financial-data-hub/activity/transactions — FDH-8 Transaction
// Explorer (spec 44-49). Deterministic keyset-style pagination via `limit`
// (no offset-based paging that would degrade or truncate past 1,000 rows).
export async function GET(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const url = new URL(req.url);
  const sortParam = url.searchParams.get('sort');
  const sort: TransactionSort = SORTS.includes(sortParam as TransactionSort) ? (sortParam as TransactionSort) : 'newest';
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? Number(limitParam) : undefined;

  const period = url.searchParams.has('period') || url.searchParams.has('from')
    ? parseActivityParams(url)
    : { period: null, accountId: null, error: null };
  if (period.error) return bad(period.error, 400);

  try {
    const page = await getTransactions(
      user.id,
      {
        accountId: url.searchParams.get('account_id'),
        categoryId: url.searchParams.get('category_id'),
        merchantId: url.searchParams.get('merchant_id'),
        economicType: url.searchParams.get('economic_type') as FdhEconomicTransactionType | null,
        approvalStatus: url.searchParams.get('approval_status') as FdhTransactionApprovalStatus | null,
        reviewStatus: url.searchParams.get('review_status'),
        isRecurring: url.searchParams.get('is_recurring') === 'true' ? true : url.searchParams.get('is_recurring') === 'false' ? false : null,
        isTransfer: url.searchParams.get('is_transfer') === 'true' ? true : url.searchParams.get('is_transfer') === 'false' ? false : null,
        minAmount: url.searchParams.get('min_amount') ? Number(url.searchParams.get('min_amount')) : null,
        maxAmount: url.searchParams.get('max_amount') ? Number(url.searchParams.get('max_amount')) : null,
        search: url.searchParams.get('q'),
        period: period.period,
      },
      { limit, sort },
    );
    return ok(page);
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'could not list transactions', 500);
  }
}
