/**
 * buildCanonicalFinancialSnapshot -- one FX rate, one window, one ledger per
 * request (DC-15); each section independently 'ok' or 'unavailable'.
 */
import { describe, expect, it } from 'vitest';

import { buildCanonicalFinancialSnapshot } from '@/lib/read-models/snapshot';
import { selectExpenses } from '@/lib/read-models/expenses';
import { makeFakeSupabase } from './helpers/fakeSupabase';
import { account, CAT, expenseItem, incomeSource, liability, profile, statement, tables, taxonomy, txn, USER, WINDOW } from './helpers/fixtures';

const household = () => tables(profile(), taxonomy(),
  { fdh_financial_accounts: [account('bank')] },
  { fdh_statement_uploads: [statement('s', 'bank', '2026-08-01', '2026-08-31')] },
  { fdh_transactions: [txn({ account: 'bank', statement: 's', date: '2026-08-10', amount: 200, type: 'expense', category: CAT.food })] },
  { expense_items: [expenseItem('e', 'Rent', 2000, 'monthly', { master_item_key: 'rent' })] },
  { income_sources: [incomeSource('i', 'Salary', 8000, 'monthly', { net_amount: 6000 })] },
  { liabilities: [liability('l', { monthly_repayment: 500 })] },
);

describe('buildCanonicalFinancialSnapshot', () => {
  it('computes every section from ONE ledger load (no repeated fdh_transactions reads)', async () => {
    const snapFake = makeFakeSupabase(household());
    const snap = await buildCanonicalFinancialSnapshot(USER, { client: snapFake.client, window: WINDOW });
    if (snap.status !== 'ok') throw new Error('unavailable');
    expect(snap.expenses.status === 'ok' && snap.expenses.combined.monthly).toBe(2200);
    expect(snap.income.status === 'ok' && snap.income.combined.netMonthly).toBe(6000);
    expect(snap.liabilities.status === 'ok' && snap.liabilities.householdDebtServiceMonthly).toBe(500);
    expect(snap.investments.status).toBe('ok');
    expect(snap.retirement.status).toBe('ok');
    expect(snap.assets.status).toBe('ok');

    const oneSelector = makeFakeSupabase(household());
    await selectExpenses(USER, { client: oneSelector.client, window: WINDOW });
    const txnReads = (reqs: { table: string }[]) => reqs.filter((r) => r.table === 'fdh_transactions').length;
    // The whole snapshot reads fdh_transactions exactly as often as ONE selector does.
    expect(txnReads(snapFake.requests)).toBe(txnReads(oneSelector.requests));
    expect(snapFake.requests.filter((r) => r.table === 'user_profiles')).toHaveLength(1);
  });

  it('a failed investments read blanks ONLY investments', async () => {
    const { client } = makeFakeSupabase(household(), { failOn: new Set(['ii_holding_snapshots']) });
    const snap = await buildCanonicalFinancialSnapshot(USER, { client, window: WINDOW });
    if (snap.status !== 'ok') throw new Error('unavailable');
    expect(snap.investments.status).toBe('unavailable');
    expect(snap.expenses.status).toBe('ok');
    expect(snap.income.status).toBe('ok');
  });

  it('a failed ledger read makes income, expenses and liabilities unavailable -- never zeros -- and leaves the registers-only sections', async () => {
    const { client } = makeFakeSupabase(household(), { failOn: new Set(['fdh_transactions']) });
    const snap = await buildCanonicalFinancialSnapshot(USER, { client, window: WINDOW });
    if (snap.status !== 'ok') throw new Error('unavailable');
    for (const s of [snap.ledger, snap.income, snap.expenses, snap.liabilities]) expect(s.status).toBe('unavailable');
    expect(snap.retirement.status).toBe('ok');
    expect(snap.assets.status).toBe('ok');
  });

  it('no FX context (profile read failed) -> the whole snapshot is unavailable', async () => {
    const { client } = makeFakeSupabase(household(), { failOn: new Set(['user_profiles']) });
    expect((await buildCanonicalFinancialSnapshot(USER, { client, window: WINDOW })).status).toBe('unavailable');
  });
});
