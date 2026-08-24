import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { getAccounts } from '@/lib/financial-data-hub/analytics/financialActivityAnalytics';
import { formatMoney } from '@/lib/engines/money';
import { SectionCard, Stat } from '@/components/dashboard/SectionCard';
import { ResourceEmptyState, ResourceErrorState } from '@/components/resources/admin/ResourceStates';
import { resolveActivityParams, type RawSearchParams } from '../_lib/searchParams';

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  transaction: 'Transaction account',
  savings: 'Savings account',
  term_deposit: 'Term deposit',
  credit_card: 'Credit card',
  home_loan: 'Home loan',
  personal_loan: 'Personal loan',
  vehicle_loan: 'Vehicle loan',
  brokerage_source: 'Brokerage',
  super_source: 'Super',
  epf_source: 'EPF',
  nps_source: 'NPS',
  other: 'Other account',
};

interface AccountRow {
  id: string;
  institution_id: string | null;
  account_type: string;
  display_name: string;
  masked_identifier: string | null;
  currency_code: string;
  status: string;
}

// FDH-8 spec 41-43 — Accounts. Same join the
// app/api/financial-data-hub/activity/accounts route.ts uses (household +
// per-account totals from getAccounts(), account display metadata queried
// directly) — this page calls the analytics function and Supabase directly
// rather than fetching its own API route over HTTP, per this phase's
// server-page convention (see app/(app)/dashboard/page.tsx).
export default async function FinancialActivityAccountsPage({
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

  const { period, error } = resolveActivityParams(sp);
  if (error) return <ResourceErrorState message={error} />;

  let activity: Awaited<ReturnType<typeof getAccounts>>;
  let accounts: AccountRow[];
  try {
    const [activityResult, accountsResult] = await Promise.all([
      getAccounts(user.id, { period }),
      supabase
        .from('fdh_financial_accounts')
        .select('id, institution_id, account_type, display_name, masked_identifier, currency_code, status')
        .eq('user_id', user.id)
        .eq('status', 'active')
        .returns<AccountRow[]>(),
    ]);
    if (accountsResult.error) throw new Error(accountsResult.error.message);
    activity = activityResult;
    accounts = accountsResult.data ?? [];
  } catch (e) {
    return <ResourceErrorState message={e instanceof Error ? e.message : 'Could not load your accounts.'} />;
  }

  if (accounts.length === 0) {
    return <ResourceEmptyState title="No accounts yet" message="Accounts from your approved statements will appear here." />;
  }

  return (
    <div className="space-y-6">
      <SectionCard title="Household activity" description="Combined across every account, grouped by currency.">
        {activity.household.length === 0 ? (
          <p className="text-sm text-muted">No approved activity for this period yet.</p>
        ) : (
          <div className="space-y-4">
            {activity.household.map((h) => {
              const currency = h.currency_code as 'AUD' | 'INR';
              return (
                <div key={h.currency_code} className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
                  <Stat label={`Income (${h.currency_code})`} value={formatMoney(h.income_total, currency)} />
                  <Stat label={`Expenses (${h.currency_code})`} value={formatMoney(h.expense_total, currency)} />
                  <Stat label={`Net cash flow (${h.currency_code})`} value={formatMoney(h.net_cash_flow, currency)} />
                  <Stat label="Transactions" value={String(h.approved_transaction_count)} />
                </div>
              );
            })}
          </div>
        )}
      </SectionCard>

      <SectionCard title="Accounts" description="Never shows a full account number — only the masked identifier on file.">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Per-account approved activity for this period</caption>
            <thead>
              <tr className="border-b border-line text-xs text-muted">
                <th scope="col" className="py-2 pr-2 font-medium">Account</th>
                <th scope="col" className="py-2 pr-2 font-medium">Type</th>
                <th scope="col" className="py-2 pr-2 text-right font-medium">Income</th>
                <th scope="col" className="py-2 pr-2 text-right font-medium">Expenses</th>
                <th scope="col" className="py-2 pr-2 text-right font-medium">Net</th>
                <th scope="col" className="py-2 pr-2 text-right font-medium">Transfers</th>
                <th scope="col" className="py-2 text-right font-medium">Transactions</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => {
                const rows = activity.perAccount.filter((p) => p.accountId === account.id);
                if (rows.length === 0) {
                  return (
                    <tr key={account.id} className="border-b border-line/60">
                      <td className="py-2 pr-2 text-ink">
                        <Link href={`/financial-data-hub/activity/transactions?account_id=${account.id}`} className="font-medium text-trust hover:underline">
                          {account.display_name}
                          {account.masked_identifier ? ` (${account.masked_identifier})` : ''}
                        </Link>
                      </td>
                      <td className="py-2 pr-2 text-muted">{ACCOUNT_TYPE_LABELS[account.account_type] ?? account.account_type}</td>
                      <td className="py-2 pr-2 text-right text-muted" colSpan={4}>
                        No approved activity this period
                      </td>
                      <td className="py-2 text-right tabular-nums text-muted">0</td>
                    </tr>
                  );
                }
                return rows.map((row) => {
                  const currency = row.currencyCode as 'AUD' | 'INR';
                  return (
                    <tr key={`${account.id}-${row.currencyCode}`} className="border-b border-line/60">
                      <td className="py-2 pr-2 text-ink">
                        <Link href={`/financial-data-hub/activity/transactions?account_id=${account.id}`} className="font-medium text-trust hover:underline">
                          {account.display_name}
                          {account.masked_identifier ? ` (${account.masked_identifier})` : ''}
                        </Link>
                      </td>
                      <td className="py-2 pr-2 text-muted">{ACCOUNT_TYPE_LABELS[account.account_type] ?? account.account_type}</td>
                      <td className="py-2 pr-2 text-right tabular-nums text-ink">{formatMoney(row.incomeTotal, currency)}</td>
                      <td className="py-2 pr-2 text-right tabular-nums text-ink">{formatMoney(row.expenseTotal, currency)}</td>
                      <td className="py-2 pr-2 text-right tabular-nums text-ink">{formatMoney(row.netCashFlow, currency)}</td>
                      <td className="py-2 pr-2 text-right tabular-nums text-muted">{formatMoney(row.transferTotal, currency)}</td>
                      <td className="py-2 text-right tabular-nums text-muted">{row.transactionCount}</td>
                    </tr>
                  );
                });
              })}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}
