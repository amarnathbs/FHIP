import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { getOverview, getTrend } from '@/lib/financial-data-hub/analytics/financialActivityAnalytics';
import { resolvePeriod, resolvePreviousPeriod } from '@/lib/financial-data-hub/analytics/period';
import { todayIsoDate } from '@/lib/financial-data-hub/analytics/requestParams';
import { comparePeriods } from '@/lib/financial-data-hub/analytics/periodComparison';
import { formatMoney } from '@/lib/engines/money';
import { SectionCard, Stat } from '@/components/dashboard/SectionCard';
import { TrendLineChart } from '@/components/dashboard/charts';
import { ResourceEmptyState, ResourceErrorState } from '@/components/resources/admin/ResourceStates';
import { resolveActivityParams, type RawSearchParams } from './_lib/searchParams';

// FDH-8 spec 14 — the Overview landing page for Financial Activity.
//
// FDH-8 closure (spec Phase I) — every "Review transactions" link below
// points to the dedicated FDH-7 review workspace
// (app/(app)/financial-data-hub/review), a thin UI wrapper around FDH-7's
// existing, unchanged approve/correct/confirm-transfer/confirm-duplicate/
// split/approve-statement API routes. This closes the prior CONDITIONAL
// PASS's disclosed gap (every link previously fell back to the generic
// `/financial-data-hub` upload screen, which had no review UI at all).
const REVIEW_QUEUE_HREF = '/financial-data-hub/review';

export default async function FinancialActivityOverviewPage({
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
  if (error) {
    return <ResourceErrorState message={error} />;
  }

  let overview: Awaited<ReturnType<typeof getOverview>>;
  try {
    overview = await getOverview(user.id, { period, accountId });
  } catch (e) {
    return <ResourceErrorState message={e instanceof Error ? e.message : 'Could not load your financial activity for this period.'} />;
  }

  // Period-over-period comparison — APPROVED totals only, never pending (spec
  // 12/88). A second getOverview() call for the prior period is not the
  // cheapest possible query, but it reuses the one certified totals path
  // rather than adding a second one; acceptable for a first pass.
  let previousApproved: Awaited<ReturnType<typeof getOverview>>['approved'] = [];
  try {
    const previous = resolvePreviousPeriod(period, todayIsoDate());
    const previousOverview = await getOverview(user.id, { period: previous.range, accountId });
    previousApproved = previousOverview.approved;
  } catch {
    previousApproved = [];
  }

  // Monthly trend (spec 50-53) — a FIXED trailing 6-month window, deliberately
  // independent of the page's own period selector (a trend is a distinct
  // capability from "totals for the selected period"). Historical actuals
  // only — getTrend() performs no forecasting. Best-effort: a failure here
  // must not blank the correct totals above it (spec 109).
  let trend: Awaited<ReturnType<typeof getTrend>> = [];
  try {
    const trendPeriod = resolvePeriod('6_months', todayIsoDate());
    trend = await getTrend(user.id, { period: trendPeriod, accountId: null });
  } catch {
    trend = [];
  }

  const hasApproved = overview.approved.length > 0;
  const hasPending = overview.pending.some((p) => p.transaction_count > 0);
  const reviewTotal =
    overview.review.needs_attention +
    overview.review.transfers +
    overview.review.possible_duplicates +
    overview.review.uncategorised +
    overview.review.recurring_candidates;

  return (
    <div className="space-y-6">
      {/* Freshness — the newest TRANSACTION date, never an upload date (spec 59). */}
      <p className="text-sm text-muted">
        Latest activity:{' '}
        {overview.freshness.latestTransactionDate ? (
          <span className="font-medium text-ink">{overview.freshness.latestTransactionDate}</span>
        ) : (
          'no transactions yet'
        )}
      </p>

      {!hasApproved && !hasPending && (
        <ResourceEmptyState
          title="No financial activity in this period"
          message="Once you upload and approve a statement, your income, expenses and account activity will appear here."
        />
      )}

      {!hasApproved && hasPending && (
        <div className="space-y-3">
          {/* ResourceEmptyState's optional `action` prop is a client-side
              onClick — this page is a Server Component, so navigation is
              rendered as a plain <Link> underneath instead of passed through
              that prop (a function cannot cross the server/client boundary). */}
          <ResourceEmptyState
            title="Your transactions are ready to review"
            message="We found transactions for this period, but none are approved yet. Approve them to see your income and expense totals here."
          />
          <Link href={REVIEW_QUEUE_HREF} className="inline-block text-sm font-semibold text-trust hover:underline">
            Review transactions →
          </Link>
        </div>
      )}

      {hasApproved && (
        <div className="space-y-4">
          {overview.approved.map((currencyTotals) => {
            const currency = currencyTotals.currency_code as 'AUD' | 'INR';
            const prev = previousApproved.find((p) => p.currency_code === currencyTotals.currency_code);
            const incomeCmp = comparePeriods(currencyTotals.income_total, prev?.income_total ?? 0, 'income');
            const expenseCmp = comparePeriods(currencyTotals.expense_total, prev?.expense_total ?? 0, 'spending');
            const netCmp = comparePeriods(currencyTotals.net_cash_flow, prev?.net_cash_flow ?? 0, 'net cash flow');

            return (
              <SectionCard
                key={currencyTotals.currency_code}
                title={`Approved activity — ${currencyTotals.currency_code}`}
                description="Approved transactions only. Pending transactions are shown separately below."
              >
                <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
                  <Stat label="Income" value={formatMoney(currencyTotals.income_total, currency)} sub={incomeCmp.label} />
                  <Stat label="Expenses" value={formatMoney(currencyTotals.expense_total, currency)} sub={expenseCmp.label} />
                  <Stat label="Net cash flow" value={formatMoney(currencyTotals.net_cash_flow, currency)} sub={netCmp.label} />
                  <Stat label="Approved transactions" value={String(currencyTotals.approved_transaction_count)} />
                </div>
              </SectionCard>
            );
          })}
        </div>
      )}

      {/* Pending disclosure — ALWAYS a separate, clearly-labelled card, never
          merged into the approved numbers above (spec 12/88, the single most
          scrutinised requirement in this spec). Only rendered when there is
          genuine pending activity. */}
      {hasPending && (
        <SectionCard title="Pending review" description="These transactions are not yet approved and are excluded from every total above.">
          <div className="space-y-3">
            {overview.pending
              .filter((p) => p.transaction_count > 0)
              .map((p) => {
                const currency = p.currency_code as 'AUD' | 'INR';
                return (
                  <div key={p.currency_code} className="rounded-compact border border-attention/30 bg-attention/5 p-4">
                    <p className="text-sm font-semibold text-ink">
                      {p.transaction_count} pending transaction{p.transaction_count === 1 ? '' : 's'} — {formatMoney(p.net_amount, currency)} waiting for review
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      Income {formatMoney(p.income_total, currency)} · Expenses {formatMoney(p.expense_total, currency)} (not counted in approved totals above)
                    </p>
                  </div>
                );
              })}
            <Link href={REVIEW_QUEUE_HREF} className="inline-block text-sm font-semibold text-trust hover:underline">
              Review transactions →
            </Link>
          </div>
        </SectionCard>
      )}

      {/* Monthly trend (spec 50-53) — historical actuals only, trailing 6
          months, independent of the period selector above. */}
      {trend.some((t) => t.points.length > 0) && (
        <SectionCard title="Monthly trend" description="Approved net cash flow (income minus expenses) over the last 6 months. Historical actuals only — not a forecast.">
          {trend.map((currencyTrend) => (
            <div key={currencyTrend.currencyCode} className="mb-6 last:mb-0">
              <p className="mb-2 text-sm font-medium text-ink">{currencyTrend.currencyCode}</p>
              <TrendLineChart
                data={currencyTrend.points.map((p) => ({ month: p.monthKey, value: p.netCashFlow }))}
                currency={currencyTrend.currencyCode as 'AUD' | 'INR'}
              />
              {/* Accessibility (spec 102-104): the chart's adjacent text/data
                  summary — a screen-reader user gets the same numbers. */}
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">Monthly net cash flow for {currencyTrend.currencyCode}</caption>
                  <thead>
                    <tr className="border-b border-line text-xs text-muted">
                      <th scope="col" className="py-1 pr-2 font-medium">Month</th>
                      <th scope="col" className="py-1 pr-2 text-right font-medium">Income</th>
                      <th scope="col" className="py-1 pr-2 text-right font-medium">Expenses</th>
                      <th scope="col" className="py-1 text-right font-medium">Net cash flow</th>
                    </tr>
                  </thead>
                  <tbody>
                    {currencyTrend.points.map((p) => (
                      <tr key={p.monthKey} className="border-b border-line/60">
                        <td className="py-1 pr-2 text-ink">{p.monthKey}</td>
                        <td className="py-1 pr-2 text-right tabular-nums text-muted">{formatMoney(p.incomeTotal, currencyTrend.currencyCode as 'AUD' | 'INR')}</td>
                        <td className="py-1 pr-2 text-right tabular-nums text-muted">{formatMoney(p.expenseTotal, currencyTrend.currencyCode as 'AUD' | 'INR')}</td>
                        <td className="py-1 text-right tabular-nums text-ink">{formatMoney(p.netCashFlow, currencyTrend.currencyCode as 'AUD' | 'INR')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </SectionCard>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SectionCard title="Largest spending category">
          {overview.largestCategory ? (
            <Stat
              label={overview.largestCategory.displayName}
              value={formatMoney(overview.largestCategory.total, overview.largestCategory.currencyCode as 'AUD' | 'INR')}
            />
          ) : (
            <p className="text-sm text-muted">No categorised spending in this period yet.</p>
          )}
        </SectionCard>

        <SectionCard title="Recurring expenses">
          <Stat label="Active recurring series" value={String(overview.recurringActiveCount)} />
          <Link href="/financial-data-hub/activity/recurring" className="mt-3 inline-block text-sm font-semibold text-trust hover:underline">
            View recurring activity →
          </Link>
        </SectionCard>
      </div>

      <SectionCard title="Needs your review" description="Items that may affect your totals once resolved.">
        {reviewTotal === 0 ? (
          <p className="text-sm text-muted">Nothing needs your attention right now.</p>
        ) : (
          <ul className="space-y-2 text-sm text-ink">
            {overview.review.needs_attention > 0 && (
              <li>
                <Link href={`${REVIEW_QUEUE_HREF}?reason=needs_attention`} className="hover:underline">
                  <span className="mr-2 inline-block rounded-compact bg-attention/10 px-2 py-0.5 text-xs font-semibold text-attention">Needs attention</span>
                  {overview.review.needs_attention} transaction{overview.review.needs_attention === 1 ? '' : 's'} need your review
                </Link>
              </li>
            )}
            {overview.review.transfers > 0 && (
              <li>
                <Link href={`${REVIEW_QUEUE_HREF}?reason=transfers`} className="hover:underline">
                  <span className="mr-2 inline-block rounded-compact bg-attention/10 px-2 py-0.5 text-xs font-semibold text-attention">Transfers</span>
                  {overview.review.transfers} possible transfer{overview.review.transfers === 1 ? '' : 's'} awaiting confirmation
                </Link>
              </li>
            )}
            {overview.review.possible_duplicates > 0 && (
              <li>
                <Link href={`${REVIEW_QUEUE_HREF}?reason=duplicates`} className="hover:underline">
                  <span className="mr-2 inline-block rounded-compact bg-attention/10 px-2 py-0.5 text-xs font-semibold text-attention">Duplicates</span>
                  {overview.review.possible_duplicates} possible duplicate{overview.review.possible_duplicates === 1 ? '' : 's'} to confirm
                </Link>
              </li>
            )}
            {overview.review.uncategorised > 0 && (
              <li>
                <Link href={`${REVIEW_QUEUE_HREF}?reason=uncategorised`} className="hover:underline">
                  <span className="mr-2 inline-block rounded-compact bg-attention/10 px-2 py-0.5 text-xs font-semibold text-attention">Uncategorised</span>
                  {overview.review.uncategorised} uncategorised transaction{overview.review.uncategorised === 1 ? '' : 's'}
                </Link>
              </li>
            )}
            {overview.review.recurring_candidates > 0 && (
              <li>
                <Link href={`${REVIEW_QUEUE_HREF}?reason=recurring`} className="hover:underline">
                  <span className="mr-2 inline-block rounded-compact bg-attention/10 px-2 py-0.5 text-xs font-semibold text-attention">Recurring</span>
                  {overview.review.recurring_candidates} recurring candidate{overview.review.recurring_candidates === 1 ? '' : 's'} to confirm
                </Link>
              </li>
            )}
          </ul>
        )}
        <Link href={REVIEW_QUEUE_HREF} className="mt-4 inline-block text-sm font-semibold text-trust hover:underline">
          Review transactions →
        </Link>
      </SectionCard>
    </div>
  );
}
