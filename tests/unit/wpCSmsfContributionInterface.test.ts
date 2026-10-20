// The SMSF contribution interface agreed with WP-D Retirement (lib/services/smsfContributionDestination.ts). EVIDENCE LABEL: UNIT-TESTED.
// A contribution is a FLOW: it is listed as evidence for the SMSF screens, it is NEVER added on top of the fund account columns the reports already
// read (WP-D derives those columns from the same ledger), and it never changes the fund net.
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createInMemoryDb } from './support/inMemorySupabase';
import { listSmsfContributionDestinations, loadSmsfContributionHistory } from '@/lib/services/smsfContributionDestination';
import { loadSmsfFundReportBundle } from '@/lib/services/smsfReportData';

const U = 'user-1';
const ledgerRow = (o: Record<string, unknown>) => ({ id: 'c', user_id: U, retirement_account_id: 'ra1', destination_kind: 'smsf', status: 'active', contribution_type: 'employer', amount: 1_000, currency_code: 'AUD', frequency: 'monthly', contribution_date: null, source_type: 'payslip', employer_name: 'Acme', retirement_member_id: 'm1', created_at: '2026-10-01', ...o });

function client(tables: Record<string, Record<string, unknown>[]>) {
  const db = createInMemoryDb();
  db.reset(tables);
  return db.client as unknown as SupabaseClient;
}

describe('listSmsfContributionDestinations', () => {
  it('names the fund, its own Retirement account row and its members, for this household only', async () => {
    const c = client({
      smsf_funds: [{ id: 'f1', user_id: U, fund_name: 'PO SMSF', currency_code: 'AUD', retirement_account_id: 'ra1', is_active: true }, { id: 'f2', user_id: 'other', fund_name: 'Theirs', currency_code: 'AUD', retirement_account_id: 'ra2', is_active: true }],
      smsf_fund_members: [{ user_id: U, smsf_fund_id: 'f1', retirement_member_id: 'm1' }, { user_id: 'other', smsf_fund_id: 'f2', retirement_member_id: 'm9' }],
    });
    expect(await listSmsfContributionDestinations(U, c)).toEqual([{ fundId: 'f1', retirementAccountId: 'ra1', fundName: 'PO SMSF', currency: 'AUD', memberIds: ['m1'] }]);
  });
});

describe('loadSmsfContributionHistory (reads WP-D ledger rows with destination kind smsf and status active)', () => {
  it('returns only active smsf rows of this fund account and this household', async () => {
    const c = client({
      retirement_contributions: [
        ledgerRow({ id: 'keep' }),
        ledgerRow({ id: 'removed', status: 'removed' }),
        ledgerRow({ id: 'superseded', status: 'superseded' }),
        ledgerRow({ id: 'other-kind', destination_kind: 'retirement_account' }),
        ledgerRow({ id: 'other-account', retirement_account_id: 'ra2' }),
        ledgerRow({ id: 'other-user', user_id: 'user-2' }),
      ],
    });
    const h = await loadSmsfContributionHistory(U, 'ra1', c);
    expect(h.status).toBe('ok');
    expect(h.status === 'ok' && h.entries.map((e) => e.id)).toEqual(['keep']);
    expect(h.status === 'ok' && h.entries[0]).toMatchObject({ contributionType: 'employer', amount: 1_000, source: 'payslip', employerName: 'Acme' });
  });

  it('is UNAVAILABLE, not an error and not empty success, while the ledger table does not exist yet', async () => {
    const failing = { from: () => { const chain: Record<string, unknown> = {}; for (const m of ['select', 'eq', 'order']) chain[m] = () => chain; chain.then = (r: (v: unknown) => unknown) => r({ data: null, error: { message: 'relation retirement_contributions does not exist' } }); return chain; } } as unknown as SupabaseClient;
    const h = await loadSmsfContributionHistory(U, 'ra1', failing);
    expect(h).toEqual({ status: 'unavailable', reason: 'relation retirement_contributions does not exist' });
  });
});

describe('NEVER double counted: the report totals stay on the fund account columns, the ledger rows are evidence only', () => {
  const fake = (employer: number | null) => {
    const db = createInMemoryDb();
    db.reset({
      smsf_funds: [{ id: 'f1', user_id: U, fund_name: 'PO SMSF', mode: 'detailed', summary_balance: null, currency_code: 'AUD', retirement_account_id: 'ra1', is_active: true }],
      smsf_holdings: [], smsf_liabilities: [], smsf_fund_members: [], property_liability_links: [], income_sources: [], expense_items: [], entity_income_items: [], entity_expense_items: [],
      retirement_accounts: [{ id: 'ra1', user_id: U, employer_contribution: employer, personal_contribution: null, contribution_frequency: 'monthly' }],
      retirement_contributions: [ledgerRow({ id: 'a', amount: 1_000 }), ledgerRow({ id: 'b', amount: 500, contribution_type: 'personal', source_type: 'manual' })],
    });
    return { from: (t: string) => (db.client as { from: (x: string) => unknown }).from(t), rpc: async () => ({ data: 0, error: null }) } as unknown as SupabaseClient;
  };

  it('with the derived column at 1,500 a month the total is 1,500, not 1,500 + the two ledger rows (3,000)', async () => {
    const { data } = await loadSmsfFundReportBundle('f1', U, fake(1_500));
    expect(data!.contributions.totalContributionMonthly).toBe(1_500);
    expect(data!.contributionHistory.status === 'ok' && data!.contributionHistory.entries).toHaveLength(2);
  });

  it('with no derived column the total is 0 even though ledger rows exist: the SMSF side never sums the ledger itself', async () => {
    const { data } = await loadSmsfFundReportBundle('f1', U, fake(null));
    expect(data!.contributions.totalContributionMonthly).toBe(0);
  });
});
