import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { getTransactions, type TransactionSort } from '@/lib/financial-data-hub/analytics/financialActivityAnalytics';
import { categoriesRepository, merchantsRepository } from '@/lib/financial-data-hub/repositories/index';
import type { FdhEconomicTransactionType, FdhTransactionApprovalStatus } from '@/lib/financial-data-hub/constants/enums';
import { formatMoney } from '@/lib/engines/money';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { ResourceEmptyState, ResourceErrorState } from '@/components/resources/admin/ResourceStates';
import { resolveActivityParams, rawParam, type RawSearchParams } from '../_lib/searchParams';
import { TransactionFilters } from './TransactionFilters';

// No FDH-7 review/correction UI exists yet under app/(app)/financial-data-hub/
// (see page.tsx's own comment) — every "Review / Edit" link below falls back
// to /financial-data-hub, matching Overview's fallback for consistency.
// FDH-8 closure (spec Phase I) — the dedicated FDH-7 review workspace.
// Deep-links to the specific transaction so "Review / Edit" opens focused,
// not the general queue.
const REVIEW_QUEUE_HREF = '/financial-data-hub/review';

const SORTS: readonly TransactionSort[] = ['newest', 'oldest', 'highest', 'lowest', 'merchant'];

function titleCase(value: string): string {
  return value
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

interface AccountLookupRow {
  id: string;
  display_name: string;
  masked_identifier: string | null;
  status: string;
}

// FDH-8 spec 44-49 — Transaction Explorer. `limit` alone is used for
// pagination (documented known simplification — the analytics layer's
// getTransactions is deterministic keyset-style but exposes no cursor param
// yet; "load more" re-issues the same query with a larger `limit`).
export default async function FinancialActivityTransactionsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const sp = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const hasPeriodParams = 'period' in sp || 'from' in sp;
  const { period, error } = hasPeriodParams ? resolveActivityParams(sp) : { period: null, error: null };
  if (error) return <ResourceErrorState message={error} />;

  const sortParam = rawParam(sp, 'sort');
  const sort: TransactionSort = SORTS.includes(sortParam as TransactionSort) ? (sortParam as TransactionSort) : 'newest';
  const limitParam = rawParam(sp, 'limit');
  const limit = limitParam ? Number(limitParam) : 100;

  let page: Awaited<ReturnType<typeof getTransactions>>;
  let accounts: AccountLookupRow[];
  let categoryMap: Map<string, string>;
  let merchantMap: Map<string, string>;
  try {
    const [pageResult, accountsResult, categoriesResult, merchantsResult] = await Promise.all([
      getTransactions(
        user.id,
        {
          accountId: rawParam(sp, 'account_id'),
          categoryId: rawParam(sp, 'category_id'),
          merchantId: rawParam(sp, 'merchant_id'),
          economicType: rawParam(sp, 'economic_type') as FdhEconomicTransactionType | null,
          approvalStatus: rawParam(sp, 'approval_status') as FdhTransactionApprovalStatus | null,
          reviewStatus: rawParam(sp, 'review_status'),
          search: rawParam(sp, 'q'),
          period,
        },
        { limit, sort },
      ),
      supabase
        .from('fdh_financial_accounts')
        .select('id, display_name, masked_identifier, status')
        .eq('user_id', user.id)
        .returns<AccountLookupRow[]>(),
      categoriesRepository.listActiveAll(),
      merchantsRepository.listActiveAll(),
    ]);
    if (accountsResult.error) throw new Error(accountsResult.error.message);
    if (categoriesResult.error) throw new Error(categoriesResult.error.message);
    if (merchantsResult.error) throw new Error(merchantsResult.error.message);

    page = pageResult;
    accounts = accountsResult.data ?? [];
    categoryMap = new Map((categoriesResult.data ?? []).map((c) => [c.id, c.display_name]));
    merchantMap = new Map((merchantsResult.data ?? []).map((m) => [m.id, m.display_name]));
  } catch (e) {
    return <ResourceErrorState message={e instanceof Error ? e.message : 'Could not load your transactions.'} />;
  }

  const accountMap = new Map(accounts.map((a) => [a.id, a]));
  const activeAccounts = accounts.filter((a) => a.status === 'active');
  const categoryOptions = [...categoryMap.entries()].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));

  return (
    <div className="space-y-6">
      <TransactionFilters
        accounts={activeAccounts.map((a) => ({ id: a.id, label: a.masked_identifier ? `${a.display_name} (${a.masked_identifier})` : a.display_name }))}
        categories={categoryOptions}
      />

      <SectionCard title="Transactions" description={`Showing up to ${page.pageSize} transactions, sorted by ${sort === 'merchant' ? 'merchant' : sort.replace(/^\w/, (c) => c.toUpperCase())}.`}>
        {page.transactions.length === 0 ? (
          <ResourceEmptyState title="No transactions match these filters" message="Try widening the date range or clearing a filter." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Your financial transactions</caption>
              <thead>
                <tr className="border-b border-line text-xs text-muted">
                  <th scope="col" className="py-2 pr-2 font-medium">Date</th>
                  <th scope="col" className="py-2 pr-2 font-medium">Description</th>
                  <th scope="col" className="py-2 pr-2 font-medium">Category</th>
                  <th scope="col" className="py-2 pr-2 text-right font-medium">Amount</th>
                  <th scope="col" className="py-2 pr-2 font-medium">Economic type</th>
                  <th scope="col" className="py-2 pr-2 font-medium">Approval status</th>
                  <th scope="col" className="py-2 font-medium">Details</th>
                </tr>
              </thead>
              <tbody>
                {page.transactions.map((t) => {
                  const currency = t.currency_original as 'AUD' | 'INR';
                  const account = accountMap.get(t.financial_account_id);
                  const merchantOrDescription = (t.merchant_id && merchantMap.get(t.merchant_id)) || t.description_clean || 'Unlabelled transaction';
                  const categoryLabel = t.category_id ? categoryMap.get(t.category_id) ?? 'Uncategorised' : 'Uncategorised';
                  const needsReview = t.approval_status === 'pending' || t.review_status === 'pending' || t.review_status === 'in_review';

                  return (
                    <tr key={t.id} className="border-b border-line/60 align-top">
                      <td className="py-2 pr-2 whitespace-nowrap text-ink">{t.transaction_date}</td>
                      <td className="py-2 pr-2 text-ink">{merchantOrDescription}</td>
                      <td className="py-2 pr-2 text-muted">{categoryLabel}</td>
                      <td className="py-2 pr-2 text-right tabular-nums text-ink">{formatMoney(t.amount_original, currency)}</td>
                      <td className="py-2 pr-2 text-muted">{titleCase(t.economic_transaction_type)}</td>
                      <td className="py-2 pr-2">
                        <span
                          className={`inline-block rounded-compact px-2 py-0.5 text-xs font-semibold ${
                            t.approval_status === 'approved' ? 'bg-positive/10 text-positive' : 'bg-attention/10 text-attention'
                          }`}
                        >
                          {t.approval_status === 'approved' ? 'Approved' : 'Pending'}
                        </span>
                      </td>
                      <td className="py-2">
                        <details>
                          <summary className="cursor-pointer text-xs font-medium text-trust">
                            <span className="sr-only">Details for {merchantOrDescription} on {t.transaction_date}</span>
                            <span aria-hidden="true">More</span>
                          </summary>
                          <div className="mt-2 space-y-1 text-xs text-muted">
                            <p>Account: {account ? (account.masked_identifier ? `${account.display_name} (${account.masked_identifier})` : account.display_name) : 'Unknown account'}</p>
                            <p>Recurring: {t.recurring_transaction_id ? 'Yes' : 'No'}</p>
                            <p>Transfer: {t.economic_transaction_type === 'transfer' ? 'Yes' : 'No'}</p>
                            <p>Duplicate status: {titleCase(t.dedup_status)}</p>
                            {needsReview && (
                              <Link href={`${REVIEW_QUEUE_HREF}?transaction=${t.id}`} className="inline-block font-semibold text-trust hover:underline">
                                Review / Edit this transaction →
                              </Link>
                            )}
                          </div>
                        </details>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
