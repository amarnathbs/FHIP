import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getSpendingBreakdown, getMerchants } from '@/lib/financial-data-hub/analytics/financialActivityAnalytics';
import { formatMoney } from '@/lib/engines/money';
import { SectionCard, Stat } from '@/components/dashboard/SectionCard';
import { AllocationPieChart } from '@/components/dashboard/charts';
import { ResourceEmptyState, ResourceErrorState } from '@/components/resources/admin/ResourceStates';
import { resolveActivityParams, type RawSearchParams } from '../_lib/searchParams';

const ESSENTIAL_DISCRETIONARY_LABELS: Record<string, string> = {
  essential: 'Essential',
  discretionary: 'Discretionary',
  mixed: 'Mixed',
  user_dependent: 'Depends on the user',
  not_applicable: 'Not applicable',
};

// FDH-8 spec 25-28 — Spending Explorer. Approved expense only; category
// breakdown reuses the SAME per-category totals Overview's "largest
// category" stat is built from (getSpendingBreakdown), so there is no
// second definition of "how much did Groceries cost this period" anywhere
// in this file.
export default async function FinancialActivitySpendingPage({
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

  const { period, accountId, error } = resolveActivityParams(sp);
  if (error) return <ResourceErrorState message={error} />;

  let breakdowns: Awaited<ReturnType<typeof getSpendingBreakdown>>;
  try {
    breakdowns = await getSpendingBreakdown(user.id, { period, accountId });
  } catch (e) {
    return <ResourceErrorState message={e instanceof Error ? e.message : 'Could not load your spending breakdown for this period.'} />;
  }

  // Top merchants (spec 29-31) — a separate, best-effort fetch: a failure
  // here must not blank out the (already-successful) category breakdown
  // above (spec 109 — partial failure isolation).
  let merchantsByCurrency: Awaited<ReturnType<typeof getMerchants>> = [];
  let merchantsError: string | null = null;
  try {
    merchantsByCurrency = await getMerchants(user.id, { period, accountId }, { limit: 10 });
  } catch (e) {
    merchantsError = e instanceof Error ? e.message : 'Could not load your top merchants for this period.';
  }

  const hasAnySpending = breakdowns.some((b) => b.totalApproved > 0 || b.uncategorisedTotal > 0);
  if (!hasAnySpending) {
    return <ResourceEmptyState title="No approved spending in this period" message="Approved expense transactions for this period will appear here once you have some." />;
  }

  return (
    <div className="space-y-6">
      {breakdowns.map((breakdown) => {
        const currency = breakdown.currencyCode as 'AUD' | 'INR';
        const essentialTotal = breakdown.categories
          .filter((c) => c.essentialDiscretionary === 'essential')
          .reduce((sum, c) => sum + c.total, 0);
        const discretionaryTotal = breakdown.categories
          .filter((c) => c.essentialDiscretionary === 'discretionary')
          .reduce((sum, c) => sum + c.total, 0);
        const hasEssentialSplit = essentialTotal > 0 || discretionaryTotal > 0;

        return (
          <div key={breakdown.currencyCode} className="space-y-4">
            <SectionCard title={`Approved spending — ${breakdown.currencyCode}`}>
              <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
                <Stat label="Total categorised spending" value={formatMoney(breakdown.totalApproved, currency)} />
                <Stat label="Categories with spending" value={String(breakdown.categories.length)} />
                {breakdown.uncategorisedTotal > 0 && (
                  <Stat label="Needs categorisation" value={formatMoney(breakdown.uncategorisedTotal, currency)} sub="Not included in the category breakdown below" />
                )}
              </div>
              {hasEssentialSplit && (
                <div className="mt-4 grid grid-cols-1 gap-6 sm:grid-cols-2">
                  <Stat label="Essential" value={formatMoney(essentialTotal, currency)} />
                  <Stat label="Discretionary" value={formatMoney(discretionaryTotal, currency)} />
                </div>
              )}
            </SectionCard>

            <SectionCard title="Spending by category" description="Approved expense transactions, grouped by category.">
              {breakdown.categories.length === 0 ? (
                <p className="text-sm text-muted">No categorised spending in this period yet.</p>
              ) : (
                <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                  <AllocationPieChart
                    slices={breakdown.categories.map((c) => ({ label: c.displayName, value: c.total }))}
                    currency={currency}
                  />
                  {/* Accessibility (spec 102-104): every chart needs an adjacent
                      text/data summary — this table is that summary, not just
                      decoration next to the pie chart above. */}
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <caption className="sr-only">Approved spending by category for {breakdown.currencyCode}</caption>
                      <thead>
                        <tr className="border-b border-line text-xs text-muted">
                          <th scope="col" className="py-2 pr-2 font-medium">Category</th>
                          <th scope="col" className="py-2 pr-2 font-medium">Type</th>
                          <th scope="col" className="py-2 pr-2 text-right font-medium">Amount</th>
                          <th scope="col" className="py-2 text-right font-medium">Share</th>
                        </tr>
                      </thead>
                      <tbody>
                        {breakdown.categories.map((c) => (
                          <tr key={c.categoryId} className="border-b border-line/60">
                            <td className="py-2 pr-2 text-ink">{c.displayName}</td>
                            <td className="py-2 pr-2 text-muted">
                              {c.essentialDiscretionary ? ESSENTIAL_DISCRETIONARY_LABELS[c.essentialDiscretionary] ?? c.essentialDiscretionary : '—'}
                            </td>
                            <td className="py-2 pr-2 text-right tabular-nums text-ink">{formatMoney(c.total, currency)}</td>
                            <td className="py-2 text-right tabular-nums text-muted">{c.percentage}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </SectionCard>
          </div>
        );
      })}

      {/* Top merchants (spec 29-31) — a best-effort section: rendered only
          when the fetch succeeded, so an isolated merchants-query failure
          never invalidates the correct category breakdown above (spec 109). */}
      {merchantsError && <ResourceErrorState message={merchantsError} />}
      {!merchantsError && merchantsByCurrency.some((m) => m.merchants.length > 0) && (
        <SectionCard title="Top merchants" description="Ranked by approved expense magnitude. Excludes transfers, loan drawdowns, investment funding and ATM withdrawals — a merchant total is genuine consumer spend, never a cash movement.">
          {merchantsByCurrency.map((m) =>
            m.merchants.length === 0 ? null : (
              <div key={m.currencyCode} className="mb-4 overflow-x-auto last:mb-0">
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">Top merchants by approved spending for {m.currencyCode}</caption>
                  <thead>
                    <tr className="border-b border-line text-xs text-muted">
                      <th scope="col" className="py-2 pr-2 font-medium">Merchant</th>
                      <th scope="col" className="py-2 pr-2 text-right font-medium">Total spent</th>
                      <th scope="col" className="py-2 pr-2 text-right font-medium">Transactions</th>
                      <th scope="col" className="py-2 pr-2 text-right font-medium">Average</th>
                      <th scope="col" className="py-2 text-right font-medium">Last transaction</th>
                    </tr>
                  </thead>
                  <tbody>
                    {m.merchants.map((row) => (
                      <tr key={row.merchantId} className="border-b border-line/60">
                        <td className="py-2 pr-2 text-ink">{row.displayName}</td>
                        <td className="py-2 pr-2 text-right tabular-nums text-ink">{formatMoney(row.totalSpent, m.currencyCode as 'AUD' | 'INR')}</td>
                        <td className="py-2 pr-2 text-right tabular-nums text-muted">{row.transactionCount}</td>
                        <td className="py-2 pr-2 text-right tabular-nums text-muted">{formatMoney(row.averageTransaction, m.currencyCode as 'AUD' | 'INR')}</td>
                        <td className="py-2 text-right tabular-nums text-muted">{row.lastTransactionDate}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ),
          )}
        </SectionCard>
      )}
    </div>
  );
}
