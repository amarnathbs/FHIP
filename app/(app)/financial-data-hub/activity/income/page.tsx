import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getIncomeBreakdown } from '@/lib/financial-data-hub/analytics/financialActivityAnalytics';
import { formatMoney } from '@/lib/engines/money';
import { SectionCard, Stat } from '@/components/dashboard/SectionCard';
import { AllocationPieChart } from '@/components/dashboard/charts';
import { ResourceEmptyState, ResourceErrorState } from '@/components/resources/admin/ResourceStates';
import { resolveActivityParams, type RawSearchParams } from '../_lib/searchParams';

// FDH-8 spec — Income Explorer. Mirrors spending/page.tsx exactly, but for
// `economic_type = 'income'` categories via getIncomeBreakdown — same
// certified per-category totals path, no second definition.
export default async function FinancialActivityIncomePage({
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

  let breakdowns: Awaited<ReturnType<typeof getIncomeBreakdown>>;
  try {
    breakdowns = await getIncomeBreakdown(user.id, { period, accountId });
  } catch (e) {
    return <ResourceErrorState message={e instanceof Error ? e.message : 'Could not load your income breakdown for this period.'} />;
  }

  const hasAnyIncome = breakdowns.some((b) => b.totalApproved > 0 || b.uncategorisedTotal > 0);
  if (!hasAnyIncome) {
    return <ResourceEmptyState title="No approved income in this period" message="Approved income transactions for this period will appear here once you have some." />;
  }

  return (
    <div className="space-y-6">
      {breakdowns.map((breakdown) => {
        const currency = breakdown.currencyCode as 'AUD' | 'INR';

        return (
          <div key={breakdown.currencyCode} className="space-y-4">
            <SectionCard title={`Approved income — ${breakdown.currencyCode}`}>
              <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
                <Stat label="Total categorised income" value={formatMoney(breakdown.totalApproved, currency)} />
                <Stat label="Categories with income" value={String(breakdown.categories.length)} />
                {breakdown.uncategorisedTotal > 0 && (
                  <Stat label="Needs categorisation" value={formatMoney(breakdown.uncategorisedTotal, currency)} sub="Not included in the category breakdown below" />
                )}
              </div>
            </SectionCard>

            <SectionCard title="Income by category" description="Approved income transactions, grouped by category.">
              {breakdown.categories.length === 0 ? (
                <p className="text-sm text-muted">No categorised income in this period yet.</p>
              ) : (
                <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                  <AllocationPieChart
                    slices={breakdown.categories.map((c) => ({ label: c.displayName, value: c.total }))}
                    currency={currency}
                  />
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <caption className="sr-only">Approved income by category for {breakdown.currencyCode}</caption>
                      <thead>
                        <tr className="border-b border-line text-xs text-muted">
                          <th scope="col" className="py-2 pr-2 font-medium">Category</th>
                          <th scope="col" className="py-2 pr-2 text-right font-medium">Amount</th>
                          <th scope="col" className="py-2 text-right font-medium">Share</th>
                        </tr>
                      </thead>
                      <tbody>
                        {breakdown.categories.map((c) => (
                          <tr key={c.categoryId} className="border-b border-line/60">
                            <td className="py-2 pr-2 text-ink">{c.displayName}</td>
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
    </div>
  );
}
