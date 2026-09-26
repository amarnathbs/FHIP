/**
 * selectLiabilities -- debt service counted exactly once (DC-06 / EXP-G7 / G9,
 * PO D-08 and D-09). Loan oracle from the brief: payment $2,000 = principal
 * $1,550 + interest $430 + fee $20 -> cost of debt $450, debt service $2,000,
 * cash outflow $2,000.
 */
import { describe, expect, it } from 'vitest';

import { selectLiabilities, type LiabilitiesReadModelData } from '@/lib/read-models/liabilities';
import { makeFakeSupabase, type Row } from './helpers/fakeSupabase';
import { account, allocation, CAT, liability, profile, statement, tables, taxonomy, txn, USER, WINDOW } from './helpers/fixtures';

async function run(t: Record<string, Row[]>, cardRepaymentRule?: 'exclude_revolving' | 'include'): Promise<LiabilitiesReadModelData> {
  const { client } = makeFakeSupabase(tables(profile(), taxonomy(), t));
  const res = await selectLiabilities(USER, { client, window: WINDOW, cardRepaymentRule });
  if (res.status !== 'ok') throw new Error(`unavailable: ${res.reason} ${res.source}`);
  return res;
}

const loanFacility = (withEvents: boolean) => tables(
  { liabilities: [liability('L-loan', { debt_type: 'personal_loan', master_item_key: 'personal_loan', balance: 20000, monthly_repayment: 1800 })] },
  { fdh_financial_accounts: [account('loan', 'personal_loan', { liability_id: 'L-loan' })] },
  withEvents ? {
    fdh_statement_uploads: [statement('s-loan', 'loan', '2026-08-01', '2026-08-31')],
    fdh_transactions: [txn({ id: 'leg', account: 'loan', statement: 's-loan', date: '2026-08-15', amount: 2000, type: 'unknown', cd: 'credit' })],
    fdh_transaction_allocations: [
      allocation('leg', 1, 'debt_principal', 1550, CAT.loanPrincipal),
      allocation('leg', 2, 'debt_interest', 430, CAT.loanInterest),
      allocation('leg', 3, 'fee', 20, CAT.fees),
    ],
  } : {},
);

describe('loan (instalment): actual REPLACES contractual, never added (D-09)', () => {
  it('with covered statement events: principal 1,550, cost of debt 450, debt service 2,000 (not 1,800 + 2,000)', async () => {
    const l = await run(loanFacility(true));
    const loan = l.lines[0];
    expect(loan.debtServiceBasis).toBe('actual');
    expect(loan.actual).toMatchObject({ principalMonthly: 1550, interestMonthly: 430, feeMonthly: 20, costOfDebtMonthly: 450, totalMonthly: 2000 });
    expect(l.householdDebtServiceMonthly).toBe(2000);
    expect(l.householdCostOfDebtMonthly).toBe(450);
    expect(l.householdPrincipalMonthly).toBe(1550);
    expect(l.totalBalance).toBe(20000);
  });

  it('with no statement events: the contractual monthly_repayment (1,800) is the debt service', async () => {
    const l = await run(loanFacility(false));
    expect(l.lines[0].debtServiceBasis).toBe('contractual');
    expect(l.householdDebtServiceMonthly).toBe(1800);
  });
});

describe('credit card (revolving): PO D-08, applied equally to manual and imported households', () => {
  it('Household M: manual card with a $150 monthly_repayment contributes 0 to debt service (consumption is already expense)', async () => {
    const l = await run({ liabilities: [liability('L-card', { debt_type: 'credit_card', master_item_key: 'credit_card', balance: 3000, monthly_repayment: 150, minimum_payment: 90 })] });
    expect(l.lines[0].serviceClass).toBe('revolving');
    expect(l.lines[0].debtServiceBasis).toBe('excluded_revolving');
    expect(l.householdDebtServiceMonthly).toBe(0);
    expect(l.totalBalance).toBe(3000);
  });

  it("Household I: imported card counts only its actual interest + fees (35 + 10), never the minimum payment", async () => {
    const l = await run(tables(
      { liabilities: [liability('L-card', { debt_type: 'credit_card', master_item_key: 'credit_card', balance: 3000, monthly_repayment: 150, minimum_payment: 90, source_type: 'liability_statement_import' })] },
      { fdh_financial_accounts: [account('card', 'credit_card', { liability_id: 'L-card' })] },
      { fdh_statement_uploads: [statement('s-card', 'card', '2026-08-01', '2026-08-31')] },
      { fdh_transactions: [
        txn({ account: 'card', statement: 's-card', date: '2026-08-03', amount: 200, type: 'expense', category: CAT.food }),
        txn({ account: 'card', statement: 's-card', date: '2026-08-28', amount: 35, type: 'debt_interest', category: CAT.loanInterest }),
        txn({ account: 'card', statement: 's-card', date: '2026-08-28', amount: 10, type: 'fee', category: CAT.fees }),
      ] },
    ));
    expect(l.lines[0].debtServiceBasis).toBe('actual');
    expect(l.householdDebtServiceMonthly).toBe(45);
    expect(l.lines[0].provenance.label).toBe('Imported from credit card statement');
  });

  it("the pre-programme rule is still available by name ('include') for a consumer that must keep it", async () => {
    const l = await run({ liabilities: [liability('L-card', { debt_type: 'credit_card', master_item_key: 'credit_card', monthly_repayment: 150 })] }, 'include');
    expect(l.householdDebtServiceMonthly).toBe(150);
  });
});

describe('owners, currency and unlinked facilities', () => {
  it('an SMSF-owned loan and an SMSF property-loan-linked loan keep their balance but add no household debt service', async () => {
    const l = await run({
      liabilities: [
        liability('own', { monthly_repayment: 500, balance: 1000 }),
        liability('fund', { owner: 'smsf', monthly_repayment: 2000, balance: 300000 }),
        liability('linked', { owner: 'self', monthly_repayment: 1000, balance: 200000 }),
      ],
      property_liability_links: [{ user_id: USER, liability_id: 'linked', link_type: 'smsf_property_loan', is_active: true }],
    });
    expect(l.householdDebtServiceMonthly).toBe(500);
    expect(l.allOwnerDebtServiceMonthly).toBe(3500);
    expect(l.totalBalance).toBe(501000);
    expect(l.householdBalance).toBe(1000);
    expect(l.lines.find((x) => x.id === 'linked')!.smsfPropertyLoanLinked).toBe(true);
  });

  it('a USD liability is never added raw', async () => {
    const l = await run({ liabilities: [liability('usd', { currency_code: 'USD', balance: 5000, monthly_repayment: 100 })] });
    expect(l.totalBalance).toBe(0);
    expect(l.unconverted).toEqual({ count: 1, byCurrency: { USD: 5000 } });
    expect(l.lines[0].debtServiceMonthly).toBeNull();
    expect(l.lines[0].debtServiceBasis).toBe('unconverted');
  });

  it('interest on a card facility NOT yet linked to a liability is still counted once (unlinkedFacility)', async () => {
    const l = await run(tables(
      { fdh_financial_accounts: [account('card', 'credit_card')] },
      { fdh_statement_uploads: [statement('s-card', 'card', '2026-08-01', '2026-08-31')] },
      { fdh_transactions: [txn({ account: 'card', statement: 's-card', date: '2026-08-28', amount: 40, type: 'debt_interest', category: CAT.loanInterest })] },
    ));
    expect(l.unlinkedFacility.costOfDebtMonthly).toBe(40);
    expect(l.householdDebtServiceMonthly).toBe(40);
  });

  it("a failed read is 'unavailable', never 0", async () => {
    const { client } = makeFakeSupabase(tables(profile(), taxonomy(), { liabilities: [liability('x')] }), { failOn: new Set(['property_liability_links']) });
    expect((await selectLiabilities(USER, { client, window: WINDOW })).status).toBe('unavailable');
  });
});
