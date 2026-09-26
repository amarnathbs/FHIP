/**
 * WP-03 -- the Dashboard core on the canonical read models.
 *
 * Every test drives the REAL loader (lib/services/dashboardData.ts
 * loadDashboard -> buildCanonicalFinancialSnapshot -> computeDashboard)
 * against an in-memory PostgREST-shaped database, so what is asserted is what
 * the Dashboard page renders. Expected values are hand-computed from the PO
 * brief's oracle numbers, never copied from a run.
 *
 * NEGATIVE CONTROL: this file was run unchanged against the base branch
 * (feature/canonical-upload-foundation @ f79374f); the failures it produced
 * there are listed in the WP-03 report.
 *
 * DATES: the previous UTC calendar month is always a complete month inside
 * the Dashboard's trailing-3-complete-month window (Sydney or UTC), and each
 * imported account has an approved statement covering all of it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { loadDashboard } from '@/lib/services/dashboardData';
import type { DashboardSummary } from '@/lib/engines/dashboard';
import { makeFakeSupabase, type Row } from './readModels/helpers/fakeSupabase';
import { account, CAT, expenseItem, incomeSource, liability, link, profile, statement, SUB, tables, taxonomy, txn, USER } from './readModels/helpers/fixtures';
import { cashAsset, householdI, householdM, P, P_DAY as DAY, P_END, P_START } from './readModels/helpers/goldenPair';

afterEach(() => vi.restoreAllMocks());

async function dashboard(t: Record<string, Row[]>, options: Parameters<typeof makeFakeSupabase>[1] = {}) {
  const fake = makeFakeSupabase(t, options);
  const d = await loadDashboard(USER, fake.client as never);
  return { d, fake };
}

const EQUAL_FIELDS: (keyof DashboardSummary)[] = [
  'grossMonthlyIncome', 'netMonthlyIncome', 'totalMonthlyExpenses', 'essentialMonthlyExpenses', 'debtMonthlyRepayments',
  'monthlySurplus', 'savingsRate', 'emergencyFundMonths', 'netWorth', 'hasIncome', 'hasExpenses',
];

describe('golden pair: Household M (manual) vs Household I (imported), identical economics', () => {
  it('gives identical Dashboard figures, and those figures are the oracle values', async () => {
    const { d: m } = await dashboard(householdM());
    const { d: i } = await dashboard(householdI());
    const oracle = {
      grossMonthlyIncome: 9000,
      netMonthlyIncome: 7000,
      totalMonthlyExpenses: 3100,
      essentialMonthlyExpenses: 2800,
      debtMonthlyRepayments: 2000,
      monthlySurplus: 1900,
      savingsRate: 1900 / 7000,
      emergencyFundMonths: 12000 / 2800,
      netWorth: 12000 - 31500,
      hasIncome: true,
      hasExpenses: true,
    };
    for (const field of EQUAL_FIELDS) {
      const expected = oracle[field as keyof typeof oracle];
      if (typeof expected === 'number') {
        expect(m[field] as number, `M.${field}`).toBeCloseTo(expected, 6);
        expect(i[field] as number, `I.${field}`).toBeCloseTo(expected, 6);
      } else {
        expect(m[field], `M.${field}`).toBe(expected);
        expect(i[field], `I.${field}`).toBe(expected);
      }
    }
    expect(i.bankMonthlyExpenses).toBe(3100); // all of I's spending is on the actual side
    expect(m.bankMonthlyExpenses).toBe(0);
    expect(i.dataStatus?.basis).toBe('canonical_read_models');
  });
});

describe('economic oracles through the Dashboard', () => {
  const loanOnly = () => tables(profile(), taxonomy(), {
    liabilities: [liability('L', { debt_type: 'personal_loan', master_item_key: 'personal_loan', monthly_repayment: 2000, source_type: 'liability_statement_import' })],
    fdh_financial_accounts: [account('bank'), account('loan', 'personal_loan', { liability_id: 'L' })],
    fdh_statement_uploads: [statement('sb', 'bank', P_START, P_END), statement('sl', 'loan', P_START, P_END)],
    fdh_transactions: [
      txn({ account: 'loan', statement: 'sl', date: DAY, amount: 1550, type: 'debt_principal', cd: 'credit', category: CAT.loanPrincipal }),
      txn({ account: 'loan', statement: 'sl', date: DAY, amount: 430, type: 'debt_interest', category: CAT.loanInterest }),
      txn({ account: 'loan', statement: 'sl', date: DAY, amount: 20, type: 'fee', category: CAT.fees }),
      txn({ account: 'bank', statement: 'sb', date: DAY, amount: 2000, type: 'transfer' }),
    ],
  });

  it('loan: cash outflow 2,000 (not 2,450); cost of debt 450 shown, inside the 2,000 (D-09)', async () => {
    const { d } = await dashboard(loanOnly());
    expect(d.totalMonthlyExpenses + d.debtMonthlyRepayments).toBe(2000);
    expect(d.debtMonthlyRepayments).toBe(2000);
    expect(d.dataStatus?.costOfDebtMonthly).toBe(450);
  });

  it('card: purchases 200 + 20 with a matched 220 repayment are 220 of spending, never 440', async () => {
    const t = tables(profile(), taxonomy(), {
      fdh_financial_accounts: [account('bank'), account('card', 'credit_card')],
      fdh_statement_uploads: [statement('sb', 'bank', P_START, P_END), statement('sc', 'card', P_START, P_END)],
      fdh_transactions: [
        txn({ id: 'p1', account: 'card', statement: 'sc', date: DAY, amount: 200, type: 'expense', category: CAT.food }),
        txn({ id: 'p2', account: 'card', statement: 'sc', date: DAY, amount: 20, type: 'expense', category: CAT.food }),
        txn({ id: 'pc', account: 'card', statement: 'sc', date: DAY, amount: 220, type: 'transfer', cd: 'credit' }),
        txn({ id: 'pb', account: 'bank', statement: 'sb', date: DAY, amount: 220, type: 'expense', category: CAT.ccPayment }),
      ],
      fdh_transaction_links: [link('l', 'pb', 'pc', 'credit_card_settlement')],
    });
    expect((await dashboard(t)).d.totalMonthlyExpenses).toBe(220);
  });

  it('payslip 5,000 net + the same 5,000 bank credit = ONE income of 5,000', async () => {
    const t = tables(profile(), taxonomy(), {
      income_sources: [incomeSource('src', 'Acme salary', 6500, 'monthly', { net_amount: 5000, source_type: 'payslip_import' })],
      fdh_payroll_events: [{ id: 'pe', user_id: USER, employer_name: 'Acme', currency_code: 'AUD', payment_date: DAY, pay_period_end: DAY, gross_pay: 6500, net_pay: 5000, bonus_pay: null, overtime_pay: null, commission_pay: null, other_earnings: null, approval_status: 'approved', superseded_by_payroll_event_id: null, bank_match_transaction_id: 'sal', bank_match_status: 'matched' }],
      fhip_import_applications: [{ user_id: USER, target_domain: 'income', source_payroll_event_id: 'pe', target_entity_id: 'src' }],
      fdh_financial_accounts: [account('bank')],
      fdh_statement_uploads: [statement('sb', 'bank', P_START, P_END)],
      fdh_transactions: [txn({ id: 'sal', account: 'bank', statement: 'sb', date: DAY, amount: 5000, type: 'income', category: CAT.income, subcategory: SUB.salary })],
    });
    const { d } = await dashboard(t);
    expect(d.netMonthlyIncome).toBe(5000);
    expect(d.grossMonthlyIncome).toBe(6500);
  });

  it("approving LAST month's statement changes the surplus (not $0); before Apply the change is 0", async () => {
    const manual = () => tables(profile(), taxonomy(), {
      income_sources: [incomeSource('src', 'Salary', 9000, 'monthly', { net_amount: 7000 })],
      expense_items: [expenseItem('rent', 'Rent', 2000, 'monthly', { master_item_key: 'rent' })],
      fdh_financial_accounts: [account('bank')],
    });
    const withStatement = (state: 'pending' | 'approved') => tables(manual(), {
      fdh_statement_uploads: [statement('sb', 'bank', P_START, P_END, { processing_status: state === 'approved' ? 'approved' : 'review' })],
      fdh_transactions: [txn({ account: 'bank', statement: 'sb', date: DAY, amount: 350, type: 'expense', category: CAT.food, subcategory: SUB.groceries, approval: state })],
    });
    const before = (await dashboard(manual())).d;
    const pending = (await dashboard(withStatement('pending'))).d;
    const approved = (await dashboard(withStatement('approved'))).d;
    expect(pending.monthlySurplus - before.monthlySurplus).toBe(0);
    expect(before.monthlySurplus - approved.monthlySurplus).toBe(350);
    expect(approved.essentialMonthlyExpenses).toBe(2350); // groceries are essential, so emergency-fund months move too
  });
});

describe('an imported-only household is not treated as having no expenses (DC-05 / EXP-G6)', () => {
  it('hasExpenses, essential and top expenses come from the approved actuals', async () => {
    const t = tables(profile(), taxonomy(), {
      income_sources: [incomeSource('src', 'Salary', 9000, 'monthly', { net_amount: 7000 })],
      fdh_financial_accounts: [account('bank')],
      fdh_statement_uploads: [statement('sb', 'bank', P_START, P_END)],
      fdh_transactions: [
        txn({ account: 'bank', statement: 'sb', date: DAY, amount: 2000, type: 'expense', category: CAT.housing }),
        txn({ account: 'bank', statement: 'sb', date: DAY, amount: 200, type: 'expense', category: CAT.food, subcategory: SUB.groceries, description: 'Woolworths' }),
      ],
      assets: [cashAsset(6600)],
    });
    const { d } = await dashboard(t);
    expect(d.hasExpenses).toBe(true);
    expect(d.essentialMonthlyExpenses).toBe(2200);
    expect(d.emergencyFundMonths).toBeCloseTo(3, 10);
    expect(d.topExpenses.map((e) => e.monthlyAmount)).toEqual([2000, 200]);
  });

  it('a statement that only PARTLY covers a month is shown elsewhere but not averaged, so it does not make a $0 figure look real', async () => {
    const t = tables(profile(), taxonomy(), {
      income_sources: [incomeSource('src', 'Salary', 9000, 'monthly', { net_amount: 7000 })],
      fdh_financial_accounts: [account('bank')],
      fdh_statement_uploads: [statement('sb', 'bank', `${P}-10`, P_END)],
      fdh_transactions: [txn({ account: 'bank', statement: 'sb', date: DAY, amount: 500, type: 'expense', category: CAT.food })],
    });
    const { d } = await dashboard(t);
    expect(d.totalMonthlyExpenses).toBe(0);
    expect(d.hasExpenses).toBe(false);
  });
});

describe('null, unknown and unconvertible values are never read as figures (GAP-09, GAP-RET-02, DC-12)', () => {
  it('a payslip row with an unknown net contributes NOTHING to net income (it used to contribute its gross)', async () => {
    const t = tables(profile(), taxonomy(), {
      income_sources: [
        incomeSource('a', 'Acme (variable pay month)', 6500, 'monthly', { net_amount: null, source_type: 'payslip_import' }),
        incomeSource('b', 'Side job', 1200, 'monthly', { net_amount: 1000 }),
      ],
    });
    const { d } = await dashboard(t);
    expect(d.grossMonthlyIncome).toBe(7700);
    expect(d.netMonthlyIncome).toBe(1000);
    expect(d.dataStatus?.netIncomeUnknownComponents).toBe(1);
    expect(d.dataStatus?.netIncomeBasis).toBe('net_partial');
  });

  it('a retirement contribution with no frequency is not assumed monthly', async () => {
    const t = tables(profile(), taxonomy(), {
      income_sources: [incomeSource('src', 'Salary', 9000, 'monthly', { net_amount: 7000 })],
      retirement_accounts: [{
        id: 'r', user_id: USER, account_name: 'Super', account_type: 'industry_fund', current_balance: 100000, currency_code: 'AUD', owner: 'self',
        employer_contribution: 12000, personal_contribution: null, contribution_frequency: null, source_type: 'retirement_statement_import',
        retirement_member_id: null, country_code: 'AU', is_active: true,
      }],
    });
    const { d } = await dashboard(t);
    expect(d.retirementEmployerMonthlyContribution).toBe(0);
    expect(d.dataStatus?.retirementContributionFrequencyUnknown).toBe(1);
    expect(d.totalRetirement).toBe(100000);
  });

  it('INR income in an AUD household is converted once; a USD liability is excluded and surfaced, not added raw', async () => {
    const t = tables(profile('AUD', 'AU', 56), taxonomy(), {
      income_sources: [incomeSource('inr', 'Rent in Pune', 56000, 'monthly', { net_amount: 56000, currency_code: 'INR', master_item_key: 'rental_income' })],
      liabilities: [liability('usd', { balance: 5000, currency_code: 'USD', monthly_repayment: 100, debt_type: 'personal_loan' })],
    });
    const { d } = await dashboard(t);
    expect(d.grossMonthlyIncome).toBe(1000);
    expect(d.rentalMonthlyIncome).toBe(1000);
    expect(d.totalLiabilities).toBe(0);
    expect(d.dataStatus?.unconverted.byCurrency.USD).toBe(5000);
  });
});

describe('financial_snapshots and read failures (DC-01 / DC-14)', () => {
  it('writes this month from the combined figures and back-fills the covered prior month from its own lines', async () => {
    const t = tables(householdI(), {
      financial_snapshots: [{ user_id: USER, snapshot_month: P_START, net_worth: -19000, monthly_income: 9000, monthly_expenses: 0, monthly_surplus: 7000, savings_rate: 1, total_assets: 12000, total_liabilities: 31000 }],
    });
    const { d, fake } = await dashboard(t);
    expect(d.dataStatus?.snapshotWrite).toBe('written');
    const current = fake.upserts.find((u) => u.table === 'financial_snapshots');
    expect(current?.row.monthly_expenses).toBe(3100 + 2000);
    const backfill = fake.updates.find((u) => u.table === 'financial_snapshots' && u.filters.snapshot_month === P_START);
    expect(backfill?.matched).toBe(1);
    expect(t.financial_snapshots[0]).toMatchObject({ monthly_income: 9000, monthly_expenses: 5100, monthly_surplus: 1900, net_worth: -19000 });
  });

  it('a failed snapshot write is logged and reported, never silently ignored', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { d } = await dashboard(householdM(), { failWritesOn: new Set(['financial_snapshots']) });
    expect(d.dataStatus?.snapshotWrite).toBe('failed');
    expect(log).toHaveBeenCalled();
  });

  it('an FX / profile read failure makes every section unavailable -- no ratio is scored from zeros', async () => {
    const { d } = await dashboard(householdM(), { failOn: new Set(['forecast_global_assumptions']) });
    expect(d.dataStatus?.unavailable.map((u) => u.section)).toEqual(expect.arrayContaining(['income', 'expenses', 'liabilities']));
    expect(d.hasIncome).toBe(false);
    expect(d.hasExpenses).toBe(false);
    expect(d.savingsRate).toBeNull();
    expect(d.debtServiceRatio).toBeNull();
  });

  it('a business-entity read failure is reported as unavailable, not as a $0 entity', async () => {
    const { d } = await dashboard(householdM(), { failOn: new Set(['business_entities']) });
    expect(d.dataStatus?.unavailable.map((u) => u.section)).toContain('business_entities');
  });
});

describe('DC-19: no downstream service or engine reads the approved ledger table directly', () => {
  it('lib/services and lib/engines contain no fdh_transactions query', () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
    });
    const offenders = [...walk(join(process.cwd(), 'lib', 'services')), ...walk(join(process.cwd(), 'lib', 'engines'))]
      .filter((f) => /from\(\s*['"]fdh_transactions['"]\s*\)/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
