/**
 * The rows that exposed each legacy Dashboard defect, re-run through the
 * Dashboard itself after WP-03 switched it to the canonical read models.
 *
 * HISTORY (WP-02 left this file as a documented negative control, "to be
 * rewritten, not deleted, when WP-03 lands"). On the base branch
 * (feature/canonical-upload-foundation, f79374f) loadDashboard() gave, for
 * these exact rows dated in the current UTC month:
 *   duplicate removed_b  129      (both sides)     -> now 64.50
 *   split 80 + 20         100      (the parent)     -> now 80
 *   unlinked refund       80       (netted anyway)  -> now 100, refund shown unlinked
 *   prior-month statement 0        (calendar month) -> now 350
 *   USD 70                70       (added raw)      -> now 0, surfaced as unconverted
 *   card 200 + 20 + 220   440                       -> now 220
 *   payslip + bank        net 10,000 / gross 11,500 -> now 5,000 / 6,500
 *   loan ledger + 2,000   outflow 2,450             -> now 2,000
 * Every assertion below now reads the DASHBOARD (loadDashboard), and each one
 * fails on the base branch (proved by running this file there -- see the
 * WP-03 report).
 *
 * Fixtures are dated in the previous calendar month (UTC), which is always a
 * complete month inside the Dashboard's trailing-3-complete-month window
 * (whatever the Sydney/UTC offset), with an approved statement covering it.
 */
import { describe, expect, it } from 'vitest';

import { loadDashboard } from '@/lib/services/dashboardData';
import { selectExpenses } from '@/lib/read-models/expenses';
import { monthEnd } from '@/lib/read-models/core/window';
import { makeFakeSupabase, type Row } from './helpers/fakeSupabase';
import { account, allocation, CAT, incomeSource, liability, link, profile, statement, SUB, tables, taxonomy, txn, USER } from './helpers/fixtures';

const now = new Date();
const prior = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
const MONTH = `${prior.getUTCFullYear()}-${String(prior.getUTCMonth() + 1).padStart(2, '0')}`;
const START = `${MONTH}-01`;
const END = monthEnd(MONTH);
const DAY = `${MONTH}-15`;

const base = () => tables(profile(), taxonomy(), { fdh_financial_accounts: [account('bank')] }, { fdh_statement_uploads: [statement('s', 'bank', START, END)] });

async function dashboard(t: Record<string, Row[]>) {
  const { client } = makeFakeSupabase(t);
  return loadDashboard(USER, client as never);
}

describe('WP-03: the Dashboard now agrees with the canonical read model on every legacy-defect fixture', () => {
  it('duplicate resolved removed_b: counted once (legacy 129)', async () => {
    const t = tables(base(), { fdh_transactions: [
      txn({ account: 'bank', statement: 's', date: DAY, amount: 64.5, type: 'expense', category: CAT.food, dedup: 'user_confirmed_distinct' }),
      txn({ account: 'bank', statement: 's', date: DAY, amount: 64.5, type: 'expense', category: CAT.food, dedup: 'user_confirmed_duplicate' }),
    ] });
    expect((await dashboard(t)).totalMonthlyExpenses).toBe(64.5);
  });

  it('split $100 -> $80 expense + $20 transfer: counts 80 (legacy 100)', async () => {
    const t = tables(base(), {
      fdh_transactions: [txn({ id: 'sp', account: 'bank', statement: 's', date: DAY, amount: 100, type: 'expense', category: CAT.food })],
      fdh_transaction_allocations: [allocation('sp', 1, 'expense', 80, CAT.food), allocation('sp', 2, 'transfer', 20, CAT.transfer)],
    });
    expect((await dashboard(t)).totalMonthlyExpenses).toBe(80);
  });

  it('UNLINKED refund is not netted (D-01): 100 (legacy 80)', async () => {
    const t = tables(base(), { fdh_transactions: [
      txn({ account: 'bank', statement: 's', date: DAY, amount: 100, type: 'expense', category: CAT.food }),
      txn({ account: 'bank', statement: 's', date: DAY, amount: 20, type: 'refund', category: CAT.refund }),
    ] });
    expect((await dashboard(t)).totalMonthlyExpenses).toBe(100);
  });

  it('a PRIOR-month statement counts in its covered month: 350 (legacy 0)', async () => {
    const t = tables(base(), { fdh_transactions: [txn({ account: 'bank', statement: 's', date: DAY, amount: 350, type: 'expense', category: CAT.food })] });
    const d = await dashboard(t);
    expect(d.totalMonthlyExpenses).toBe(350);
    expect(d.hasExpenses).toBe(true);
  });

  it('USD bank expense is surfaced, never added raw into AUD: 0 + unconverted {USD: 70} (legacy 70)', async () => {
    const t = tables(base(), { fdh_transactions: [txn({ account: 'bank', statement: 's', date: DAY, amount: 70, type: 'expense', currency: 'USD' })] });
    const d = await dashboard(t);
    expect(d.totalMonthlyExpenses).toBe(0);
    expect(d.dataStatus?.unconverted.byCurrency).toEqual({ USD: 70 });
  });

  it('card $200 + $20, $220 bank debit settled by a confirmed link: 220 (legacy 440)', async () => {
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
    expect((await dashboard(t)).totalMonthlyExpenses).toBe(220);
    // Same rows, same answer as the read model the Dashboard now consumes.
    const { client } = makeFakeSupabase(t);
    const e = await selectExpenses(USER, { client });
    expect(e.status === 'ok' && e.combined.monthly).toBe(220);
  });

  it('payslip-Applied salary (net 5,000) + its matched bank credit 5,000: ONE income (legacy net 10,000 / gross 11,500)', async () => {
    const t = tables(base(), {
      income_sources: [incomeSource('src', 'Acme salary', 6500, 'monthly', { net_amount: 5000, source_type: 'payslip_import' })],
      fdh_payroll_events: [{ id: 'pe', user_id: USER, employer_name: 'Acme', currency_code: 'AUD', payment_date: DAY, pay_period_end: DAY, gross_pay: 6500, net_pay: 5000, bonus_pay: null, overtime_pay: null, commission_pay: null, other_earnings: null, approval_status: 'approved', superseded_by_payroll_event_id: null, bank_match_transaction_id: 'sal', bank_match_status: 'matched' }],
      fhip_import_applications: [{ user_id: USER, target_domain: 'income', source_payroll_event_id: 'pe', target_entity_id: 'src' }],
      fdh_transactions: [txn({ id: 'sal', account: 'bank', statement: 's', date: DAY, amount: 5000, type: 'income', category: CAT.income, subcategory: SUB.salary })],
    });
    const d = await dashboard(t);
    expect(d.netMonthlyIncome).toBe(5000);
    expect(d.grossMonthlyIncome).toBe(6500);
    expect(d.bankMonthlyIncome).toBe(0); // the credit is the payslip's own money, represented by it
  });

  it('loan ledger $1,550 + $430 + $20 AND the $2,000 monthly_repayment: cash outflow 2,000 (legacy 2,450)', async () => {
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
    const d = await dashboard(t);
    expect(d.totalMonthlyExpenses).toBe(0);
    expect(d.debtMonthlyRepayments).toBe(2000);
    expect(d.totalMonthlyExpenses + d.debtMonthlyRepayments).toBe(2000);
    expect(d.dataStatus?.costOfDebtMonthly).toBe(450); // D-09 display line, inside the 2,000
  });
});
