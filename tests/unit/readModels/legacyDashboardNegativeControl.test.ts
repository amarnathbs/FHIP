/**
 * NEGATIVE CONTROL: the base-branch Dashboard loader (lib/services/
 * dashboardData.ts loadDashboard -> computeDashboard, UNCHANGED by WP-02) run
 * on the SAME fixture as the canonical read model. Each case proves the
 * defect is real today, and that the read model gets it right on identical
 * rows. WP-03 switches the Dashboard; until then these legacy assertions
 * document the live behaviour, and they are expected to be rewritten (not
 * deleted) when WP-03 lands.
 *
 * Fixtures are dated in the CURRENT UTC calendar month, because that is the
 * only window the legacy loader reads (DC-01); the read model is given an
 * explicit window of that same month so the comparison is like-for-like.
 */
import { describe, expect, it } from 'vitest';

import { loadDashboard } from '@/lib/services/dashboardData';
import { selectExpenses } from '@/lib/read-models/expenses';
import { selectIncome } from '@/lib/read-models/income';
import { selectLiabilities } from '@/lib/read-models/liabilities';
import { explicitWindow, monthEnd } from '@/lib/read-models/core/window';
import { makeFakeSupabase, type Row } from './helpers/fakeSupabase';
import { account, allocation, CAT, incomeSource, liability, link, profile, statement, SUB, tables, taxonomy, txn, USER } from './helpers/fixtures';

const now = new Date();
const MONTH = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
const START = `${MONTH}-01`;
const END = monthEnd(MONTH);
const DAY = `${MONTH}-01`;
const window = explicitWindow(START, END, END);
const prior = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
const PRIOR_MONTH = `${prior.getUTCFullYear()}-${String(prior.getUTCMonth() + 1).padStart(2, '0')}`;

const base = () => tables(profile(), taxonomy(), { fdh_financial_accounts: [account('bank')] }, { fdh_statement_uploads: [statement('s', 'bank', START, END)] });

async function legacy(t: Record<string, Row[]>) {
  const { client } = makeFakeSupabase(t);
  return loadDashboard(USER, client as never);
}
async function expenses(t: Record<string, Row[]>, w = window) {
  const { client } = makeFakeSupabase(t);
  const r = await selectExpenses(USER, { client, window: w });
  if (r.status !== 'ok') throw new Error('unavailable');
  return r;
}

describe('legacy Dashboard defects vs the canonical read model, same rows', () => {
  it('duplicate resolved removed_b: legacy counts BOTH sides (2 x 64.50); read model counts once', async () => {
    const t = tables(base(), { fdh_transactions: [
      txn({ account: 'bank', statement: 's', date: DAY, amount: 64.5, type: 'expense', category: CAT.food, dedup: 'user_confirmed_distinct' }),
      txn({ account: 'bank', statement: 's', date: DAY, amount: 64.5, type: 'expense', category: CAT.food, dedup: 'user_confirmed_duplicate' }),
    ] });
    expect((await legacy(t)).totalMonthlyExpenses).toBe(129);
    expect((await expenses(t)).actual.monthly).toBe(64.5);
  });

  it('split $100 -> $80 expense + $20 transfer: legacy counts the parent 100; read model 80', async () => {
    const t = tables(base(), {
      fdh_transactions: [txn({ id: 'sp', account: 'bank', statement: 's', date: DAY, amount: 100, type: 'expense', category: CAT.food })],
      fdh_transaction_allocations: [allocation('sp', 1, 'expense', 80, CAT.food), allocation('sp', 2, 'transfer', 20, CAT.transfer)],
    });
    expect((await legacy(t)).totalMonthlyExpenses).toBe(100);
    expect((await expenses(t)).actual.monthly).toBe(80);
  });

  it('UNLINKED refund: legacy nets it anyway (100 - 20 = 80); read model follows D-01 (100, refund shown unlinked)', async () => {
    const t = tables(base(), { fdh_transactions: [
      txn({ account: 'bank', statement: 's', date: DAY, amount: 100, type: 'expense', category: CAT.food }),
      txn({ account: 'bank', statement: 's', date: DAY, amount: 20, type: 'refund', category: CAT.refund }),
    ] });
    expect((await legacy(t)).totalMonthlyExpenses).toBe(80);
    const e = await expenses(t);
    expect(e.actual.monthly).toBe(100);
    expect(e.actual.refundsUnlinked.count).toBe(1);
  });

  it('a PRIOR-month statement: legacy counts $0; read model counts it in its covered month', async () => {
    const pStart = `${PRIOR_MONTH}-01`;
    const pEnd = monthEnd(PRIOR_MONTH);
    const t = tables(profile(), taxonomy(), { fdh_financial_accounts: [account('bank')] }, { fdh_statement_uploads: [statement('sp', 'bank', pStart, pEnd)] }, {
      fdh_transactions: [txn({ account: 'bank', statement: 'sp', date: `${PRIOR_MONTH}-15`, amount: 350, type: 'expense', category: CAT.food })],
    });
    expect((await legacy(t)).totalMonthlyExpenses).toBe(0);
    expect((await expenses(t, explicitWindow(pStart, pEnd, pEnd))).actual.monthly).toBe(350);
  });

  it('USD bank expense: legacy adds 70 raw into an AUD total; read model surfaces it unconverted', async () => {
    const t = tables(base(), { fdh_transactions: [txn({ account: 'bank', statement: 's', date: DAY, amount: 70, type: 'expense', currency: 'USD' })] });
    expect((await legacy(t)).totalMonthlyExpenses).toBe(70);
    const e = await expenses(t);
    expect(e.actual.monthly).toBe(0);
    expect(e.actual.unconverted.byCurrency).toEqual({ USD: 70 });
  });

  it('card $200 + $20 on the card, $220 bank debit mis-typed expense but settled by a confirmed link: legacy 440; read model 220', async () => {
    const t = tables(profile(), taxonomy(),
      { fdh_financial_accounts: [account('bank'), account('card', 'credit_card')] },
      { fdh_statement_uploads: [statement('s', 'bank', START, END), statement('c', 'card', START, END)] },
      { fdh_transactions: [
        txn({ id: 'p1', account: 'card', statement: 'c', date: DAY, amount: 200, type: 'expense', category: CAT.food }),
        txn({ id: 'p2', account: 'card', statement: 'c', date: DAY, amount: 20, type: 'expense', category: CAT.food }),
        txn({ id: 'pc', account: 'card', statement: 'c', date: DAY, amount: 220, type: 'transfer', cd: 'credit' }),
        txn({ id: 'pb', account: 'bank', statement: 's', date: DAY, amount: 220, type: 'expense', category: CAT.ccPayment }),
      ], fdh_transaction_links: [link('l', 'pb', 'pc', 'credit_card_settlement')] },
    );
    expect((await legacy(t)).totalMonthlyExpenses).toBe(440);
    expect((await expenses(t)).actual.monthly).toBe(220);
  });

  it('payslip-Applied salary (net 5,000) + its matched bank credit 5,000: legacy net income 10,000; read model 5,000', async () => {
    const t = tables(base(), {
      income_sources: [incomeSource('src', 'Acme salary', 6500, 'monthly', { net_amount: 5000, source_type: 'payslip_import' })],
      fdh_payroll_events: [{ id: 'pe', user_id: USER, employer_name: 'Acme', currency_code: 'AUD', payment_date: DAY, pay_period_end: DAY, gross_pay: 6500, net_pay: 5000, bonus_pay: null, overtime_pay: null, commission_pay: null, other_earnings: null, approval_status: 'approved', superseded_by_payroll_event_id: null, bank_match_transaction_id: 'sal', bank_match_status: 'matched' }],
      fhip_import_applications: [{ user_id: USER, target_domain: 'income', source_payroll_event_id: 'pe', target_entity_id: 'src' }],
      fdh_transactions: [txn({ id: 'sal', account: 'bank', statement: 's', date: DAY, amount: 5000, type: 'income', category: CAT.income, subcategory: SUB.salary })],
    });
    const d = await legacy(t);
    expect(d.netMonthlyIncome).toBe(10000);
    expect(d.grossMonthlyIncome).toBe(11500);
    const { client } = makeFakeSupabase(t);
    const i = await selectIncome(USER, { client, window });
    expect(i.status === 'ok' && i.combined.netMonthly).toBe(5000);
    expect(i.status === 'ok' && i.combined.grossMonthly).toBe(6500);
  });

  it('loan ledger interest $430 + fee $20 AND the $2,000 monthly_repayment: legacy counts the $450 twice (2,450); read model cash outflow 2,000', async () => {
    // The loan payment as FDH-10 ledger rows on the facility account (what
    // WP-11 writes), with the bank leg a transfer.
    const t = tables(profile(), taxonomy(),
      { liabilities: [liability('L', { monthly_repayment: 2000, debt_type: 'personal_loan', master_item_key: 'personal_loan' })] },
      { fdh_financial_accounts: [account('bank'), account('loan', 'personal_loan', { liability_id: 'L' })] },
      { fdh_statement_uploads: [statement('s', 'bank', START, END), statement('ls', 'loan', START, END)] },
      { fdh_transactions: [
        txn({ account: 'loan', statement: 'ls', date: DAY, amount: 1550, type: 'debt_principal', cd: 'credit', category: CAT.loanPrincipal }),
        txn({ account: 'loan', statement: 'ls', date: DAY, amount: 430, type: 'debt_interest', category: CAT.loanInterest }),
        txn({ account: 'loan', statement: 'ls', date: DAY, amount: 20, type: 'fee', category: CAT.fees }),
        txn({ account: 'bank', statement: 's', date: DAY, amount: 2000, type: 'transfer' }),
      ] },
    );
    const d = await legacy(t);
    expect(d.totalMonthlyExpenses).toBe(450);
    expect(d.debtMonthlyRepayments).toBe(2000);
    expect(d.totalMonthlyExpenses + d.debtMonthlyRepayments).toBe(2450);
    const { client } = makeFakeSupabase(t);
    const l = await selectLiabilities(USER, { client, window });
    const e = await expenses(t);
    expect(l.status === 'ok' && l.householdDebtServiceMonthly).toBe(2000);
    expect(l.status === 'ok' && l.householdCostOfDebtMonthly).toBe(450);
    expect(e.actual.monthly).toBe(0);
    expect(e.actual.monthly + (l.status === 'ok' ? l.householdDebtServiceMonthly : NaN)).toBe(2000);
  });
});
