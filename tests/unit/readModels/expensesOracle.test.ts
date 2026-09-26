/**
 * selectExpenses -- economic oracles from the brief (WP-02 acceptance).
 *
 * Every expected number is hand-computed from the brief, never copied from a
 * run. The matching base-branch defects are demonstrated against the LEGACY
 * loadDashboard in legacyDashboardNegativeControl.test.ts.
 *
 * Window for every case: Jun-Aug 2026 (WINDOW). A statement covering a whole
 * month makes that month "covered" for its account.
 */
import { describe, expect, it } from 'vitest';

import { selectExpenses, type ExpensesReadModelData } from '@/lib/read-models/expenses';
import { makeFakeSupabase, type Row } from './helpers/fakeSupabase';
import { account, allocation, CAT, expenseItem, link, liability, profile, statement, SUB, tables, taxonomy, txn, USER, WINDOW } from './helpers/fixtures';

async function run(t: Record<string, Row[]>, basis: 'planned' | 'actual' | 'combined' = 'combined'): Promise<ExpensesReadModelData> {
  const { client } = makeFakeSupabase(tables(profile(), taxonomy(), t));
  const res = await selectExpenses(USER, { client, window: WINDOW, basis });
  if (res.status !== 'ok') throw new Error(`unavailable: ${res.reason} ${res.source}`);
  return res;
}

const bankAug = () => tables(
  { fdh_financial_accounts: [account('bank')] },
  { fdh_statement_uploads: [statement('s-aug', 'bank', '2026-08-01', '2026-08-31')] },
);
const food = (e: ExpensesReadModelData) => e.actual.byGroup.find((g) => g.group === 'food')?.monthly ?? 0;
const nonSpending = (e: ExpensesReadModelData, b: string) => e.actual.nonSpending.find((x) => x.bucket === b)!;

describe('Woolworths $200 Groceries (the brief\'s visibility oracle)', () => {
  it('approved: appears as an ACTUAL food line with bank-statement provenance, $200/month over the one covered month', async () => {
    const e = await run(tables(bankAug(), { fdh_transactions: [txn({ id: 'w', account: 'bank', statement: 's-aug', date: '2026-08-14', amount: 200, type: 'expense', category: CAT.food, subcategory: SUB.groceries, description: 'Woolworths' })] }));
    expect(e.actual.lines).toHaveLength(1);
    const line = e.actual.lines[0];
    expect(line).toMatchObject({ description: 'Woolworths', group: 'food', essential: true, amountNative: 200, currency: 'AUD', amountReporting: 200, coverage: 'covered' });
    expect(line.provenance).toEqual({ kind: 'bank_statement', statementUploadId: 's-aug', accountId: 'bank', label: 'Imported from bank statement' });
    expect(food(e)).toBe(200);
    expect(e.actual.essentialMonthly).toBe(200);
    expect(e.combined.monthly).toBe(200);
    expect(e.flags).toEqual({ hasPlanned: false, hasActual: true, hasAny: true });
  });

  it('NOT yet approved: effect 0 (before Apply), and it is counted as pending', async () => {
    const e = await run(tables(bankAug(), { fdh_transactions: [txn({ account: 'bank', statement: 's-aug', date: '2026-08-14', amount: 200, type: 'expense', category: CAT.food, approval: 'pending' })] }));
    expect(e.actual.lines).toHaveLength(0);
    expect(e.combined.monthly).toBe(0);
    expect(e.actual.unknownPendingCount).toBe(1);
    expect(e.flags.hasActual).toBe(false);
  });
});

describe('credit card: purchases $200 + $20, repayment $220 -> household expense $220 (never $440, never $0)', () => {
  const card = () => tables(
    { fdh_financial_accounts: [account('bank'), account('card', 'credit_card', { liability_id: 'L-card' })] },
    { fdh_statement_uploads: [statement('s-bank', 'bank', '2026-08-01', '2026-08-31'), statement('s-card', 'card', '2026-08-01', '2026-08-31', { document_type: 'credit_card_statement' })] },
  );
  const rows = (withLink: boolean) => tables(card(), {
    fdh_transactions: [
      txn({ id: 'p1', account: 'card', statement: 's-card', date: '2026-08-03', amount: 200, type: 'expense', category: CAT.food, subcategory: SUB.groceries }),
      txn({ id: 'p2', account: 'card', statement: 's-card', date: '2026-08-09', amount: 20, type: 'expense', category: CAT.food, subcategory: SUB.restaurants }),
      txn({ id: 'pay-card', account: 'card', statement: 's-card', date: '2026-08-28', amount: 220, type: 'transfer', cd: 'credit', category: CAT.ccPayment }),
      // The bank-side debit, mis-typed 'expense' by the classifier: only the confirmed link makes it a transfer.
      txn({ id: 'pay-bank', account: 'bank', statement: 's-bank', date: '2026-08-28', amount: 220, type: 'expense', category: CAT.ccPayment }),
    ],
    fdh_transaction_links: withLink ? [link('lnk', 'pay-bank', 'pay-card', 'credit_card_settlement')] : [],
  });

  it('with the confirmed settlement link: spending is exactly 220', async () => {
    const e = await run(rows(true));
    expect(e.actual.monthly).toBe(220);
    expect(e.actual.lines.map((l) => l.transactionId).sort()).toEqual(['p1', 'p2']);
    expect(nonSpending(e, 'transfer').totalInWindow).toBe(440); // both legs visible as non-spending
  });

  it('negative control: WITHOUT the link the mis-typed bank leg is spending (440) -- the link rule is what fixes it', async () => {
    const e = await run(rows(false));
    expect(e.actual.monthly).toBe(440);
  });

  it('a cash advance on the card is not consumption (spending 0, shown as cash)', async () => {
    const e = await run(tables(card(), { fdh_transactions: [txn({ account: 'card', statement: 's-card', date: '2026-08-05', amount: 300, type: 'cash_withdrawal' })] }));
    expect(e.actual.monthly).toBe(0);
    expect(nonSpending(e, 'cash_withdrawal').monthly).toBe(300);
    expect(nonSpending(e, 'cash_withdrawal').label).toBe('Cash — spending unknown');
  });
});

describe('loan: payment $2,000 = principal $1,550 + interest $430 + fee $20', () => {
  it('expense view: spending 0, cost of debt 450 and principal 1,550 reported as non-spending', async () => {
    const e = await run(tables(
      { fdh_financial_accounts: [account('bank'), account('loan', 'personal_loan', { liability_id: 'L-loan' })] },
      { fdh_statement_uploads: [statement('s-bank', 'bank', '2026-08-01', '2026-08-31'), statement('s-loan', 'loan', '2026-08-01', '2026-08-31')] },
      {
        fdh_transactions: [
          txn({ id: 'loan-leg', account: 'loan', statement: 's-loan', date: '2026-08-15', amount: 2000, type: 'unknown', cd: 'credit' }),
          txn({ id: 'bank-leg', account: 'bank', statement: 's-bank', date: '2026-08-15', amount: 2000, type: 'transfer' }),
        ],
        fdh_transaction_allocations: [
          allocation('loan-leg', 1, 'debt_principal', 1550, CAT.loanPrincipal),
          allocation('loan-leg', 2, 'debt_interest', 430, CAT.loanInterest),
          allocation('loan-leg', 3, 'fee', 20, CAT.fees),
        ],
        fdh_transaction_links: [link('lp', 'bank-leg', 'loan-leg', 'loan_payment')],
      },
    ));
    expect(e.actual.monthly).toBe(0);
    expect(nonSpending(e, 'cost_of_debt').monthly).toBe(450);
    expect(nonSpending(e, 'debt_principal').monthly).toBe(1550);
    expect(e.actual.costOfDebtLines.map((l) => l.amountNative).sort((a, b) => a - b)).toEqual([20, 430]);
  });

  it('interest paid from an ordinary bank account with no facility link stays spending', async () => {
    const e = await run(tables(bankAug(), { fdh_transactions: [txn({ account: 'bank', statement: 's-aug', date: '2026-08-15', amount: 430, type: 'debt_interest', category: CAT.loanInterest })] }));
    expect(e.actual.monthly).toBe(430);
    expect(e.actual.byGroup[0].group).toBe('fees');
  });
});

describe('duplicates, splits and unknown', () => {
  it('a statement uploaded twice and resolved removed_b is counted ONCE', async () => {
    const e = await run(tables(bankAug(), {
      fdh_transactions: [
        txn({ id: 'a', account: 'bank', statement: 's-aug', date: '2026-08-10', amount: 64.5, type: 'expense', category: CAT.food, dedup: 'user_confirmed_distinct' }),
        txn({ id: 'b', account: 'bank', statement: 's-aug', date: '2026-08-10', amount: 64.5, type: 'expense', category: CAT.food, dedup: 'user_confirmed_duplicate' }),
      ],
    }));
    expect(e.actual.monthly).toBe(64.5);
    expect(e.actual.excludedDuplicates).toBe(1);
  });

  it('parent $100 split into $80 expense + $20 transfer counts $80', async () => {
    const e = await run(tables(bankAug(), {
      fdh_transactions: [txn({ id: 'sp', account: 'bank', statement: 's-aug', date: '2026-08-11', amount: 100, type: 'expense', category: CAT.food })],
      fdh_transaction_allocations: [allocation('sp', 1, 'expense', 80, CAT.food), allocation('sp', 2, 'transfer', 20, CAT.transfer)],
    }));
    expect(e.actual.monthly).toBe(80);
    expect(nonSpending(e, 'transfer').totalInWindow).toBe(20);
  });

  it("an 'unknown' allocation is never counted (and is reported as unknown)", async () => {
    const e = await run(tables(bankAug(), {
      fdh_transactions: [txn({ id: 'su', account: 'bank', statement: 's-aug', date: '2026-08-11', amount: 100, type: 'unknown' })],
      fdh_transaction_allocations: [allocation('su', 1, 'expense', 60, CAT.food), allocation('su', 2, 'unknown', 40)],
    }));
    expect(e.actual.monthly).toBe(60);
    expect(e.actual.unknownPendingCount).toBe(1);
  });

  it("an unreconciled split is refused as 'unavailable', never silently summed", async () => {
    const { client } = makeFakeSupabase(tables(profile(), taxonomy(), bankAug(), {
      fdh_transactions: [txn({ id: 'bad', account: 'bank', statement: 's-aug', date: '2026-08-11', amount: 100, type: 'expense' })],
      fdh_transaction_allocations: [allocation('bad', 1, 'expense', 70, CAT.food)],
    }));
    const res = await selectExpenses(USER, { client, window: WINDOW });
    expect(res).toEqual({ status: 'unavailable', reason: 'invalid_split', source: 'fdh_transaction_allocations' });
  });
});

describe('refunds (PO D-01: net ONLY with a confirmed refund_original link)', () => {
  const rows = (status: string | null) => tables(bankAug(), {
    fdh_transactions: [
      txn({ id: 'buy', account: 'bank', statement: 's-aug', date: '2026-08-02', amount: 100, type: 'expense', category: CAT.food, subcategory: SUB.groceries }),
      txn({ id: 'ref', account: 'bank', statement: 's-aug', date: '2026-08-20', amount: 20, type: 'refund', category: CAT.refund }),
    ],
    fdh_transaction_links: status ? [link('rl', 'ref', 'buy', 'refund_original', status)] : [],
  });

  it('confirmed link: groceries 100 - refund 20 = 80, in the ORIGINAL group', async () => {
    const e = await run(rows('confirmed'));
    expect(food(e)).toBe(80);
    expect(e.actual.refundsNetted.count).toBe(1);
    expect(e.actual.refundsUnlinked.count).toBe(0);
  });

  it('no link, or a pending link: not netted (100), shown as unlinked, never counted as income', async () => {
    for (const status of [null, 'pending']) {
      const e = await run(rows(status));
      expect(food(e)).toBe(100);
      expect(e.actual.refundsUnlinked.count).toBe(1);
      expect(e.actual.refundsUnlinked.totalInWindow).toBe(20);
    }
  });

  it('a confirmed refund of a purchase made BEFORE the window still nets against its group', async () => {
    const e = await run(tables(bankAug(), {
      fdh_transactions: [
        txn({ id: 'buy-old', account: 'bank', statement: null, date: '2026-04-02', amount: 50, type: 'expense', category: CAT.lifestyle }),
        txn({ id: 'buy-now', account: 'bank', statement: 's-aug', date: '2026-08-05', amount: 90, type: 'expense', category: CAT.lifestyle }),
        txn({ id: 'ref-now', account: 'bank', statement: 's-aug', date: '2026-08-07', amount: 50, type: 'refund', category: CAT.refund }),
      ],
      fdh_transaction_links: [link('rl2', 'ref-now', 'buy-old', 'refund_original')],
    }));
    expect(e.actual.byGroup.find((g) => g.group === 'lifestyle')!.monthly).toBe(40);
  });
});

describe('currency, owner, coverage window', () => {
  it('AUD + INR are converted once at the live rate; USD is surfaced unconverted, never added', async () => {
    const e = await run(tables(bankAug(), {
      fdh_transactions: [
        txn({ account: 'bank', statement: 's-aug', date: '2026-08-02', amount: 100, type: 'expense', category: CAT.food }),
        txn({ account: 'bank', statement: 's-aug', date: '2026-08-03', amount: 5600, type: 'expense', category: CAT.food, currency: 'INR' }),
        txn({ account: 'bank', statement: 's-aug', date: '2026-08-04', amount: 70, type: 'expense', category: CAT.food, currency: 'USD' }),
      ],
    }));
    expect(e.actual.monthly).toBe(200); // 100 AUD + 5,600 INR / 56
    expect(e.actual.unconverted).toEqual({ count: 1, byCurrency: { USD: 70 } });
  });

  it('an SMSF-owned account is excluded from household spending; a joint account counts in full', async () => {
    const e = await run(tables(
      { fdh_financial_accounts: [account('smsf-acc', 'transaction', { owner_role: 'smsf' }), account('joint-acc', 'transaction', { owner_role: 'joint' })] },
      { fdh_statement_uploads: [statement('s1', 'smsf-acc', '2026-08-01', '2026-08-31'), statement('s2', 'joint-acc', '2026-08-01', '2026-08-31')] },
      { fdh_transactions: [
        txn({ account: 'smsf-acc', statement: 's1', date: '2026-08-02', amount: 900, type: 'expense', category: CAT.fees }),
        txn({ account: 'joint-acc', statement: 's2', date: '2026-08-02', amount: 150, type: 'expense', category: CAT.food }),
      ] },
    ));
    expect(e.actual.monthly).toBe(150);
    expect(e.actual.excludedNonHouseholdCount).toBe(1);
  });

  it('a PRIOR-month statement counts in its covered month (not $0); a partial month is shown but not averaged', async () => {
    const e = await run(tables(
      { fdh_financial_accounts: [account('bank')] },
      // June fully covered; July covered only 10-31 (partial).
      { fdh_statement_uploads: [statement('s-jun', 'bank', '2026-06-01', '2026-06-30'), statement('s-jul', 'bank', '2026-07-10', '2026-07-31')] },
      { fdh_transactions: [
        txn({ account: 'bank', statement: 's-jun', date: '2026-06-12', amount: 300, type: 'expense', category: CAT.food }),
        txn({ account: 'bank', statement: 's-jul', date: '2026-07-15', amount: 999, type: 'expense', category: CAT.food }),
      ] },
    ));
    expect(e.actual.monthly).toBe(300);
    expect(e.coverage.coveredMonths).toEqual(['2026-06']);
    expect(e.coverage.partialMonths).toEqual(['2026-07']);
    expect(e.actual.partialLineCount).toBe(1);
    expect(e.actual.totalInWindow).toBe(1299);
  });

  it('an approved upload with no financial_account_id takes its lines\' account for coverage', async () => {
    const e = await run(tables(
      { fdh_financial_accounts: [account('bank')] },
      { fdh_statement_uploads: [statement('s-noacc', 'bank', '2026-08-01', '2026-08-31', { financial_account_id: null })] },
      { fdh_transactions: [txn({ account: 'bank', statement: 's-noacc', date: '2026-08-12', amount: 120, type: 'expense', category: CAT.food })] },
    ));
    expect(e.coverage.coveredMonths).toEqual(['2026-08']);
    expect(e.actual.monthly).toBe(120);
  });

  it('an approved card statement linked to its facility account (WP-11) defines that account\'s coverage', async () => {
    const t = (approval: string) => tables(
      { fdh_financial_accounts: [account('card', 'credit_card', { liability_id: 'L' })] },
      { fdh_liability_statements: [{ id: 'ls', user_id: USER, statement_upload_id: 'up-card', financial_account_id: 'card', statement_period_start: '2026-08-01', statement_period_end: '2026-08-31', approval_status: approval }] },
      { fdh_transactions: [txn({ account: 'card', statement: 'up-card', date: '2026-08-03', amount: 90, type: 'expense', category: CAT.food })] },
    );
    const approved = await run(t('approved'));
    expect(approved.actual.monthly).toBe(90);
    // Negative control: an unapproved statement gives no coverage -> shown as partial, not averaged.
    const pending = await run(t('pending'));
    expect(pending.actual.monthly).toBe(0);
    expect(pending.actual.partialLineCount).toBe(1);
  });

  it('averages over covered months only: 3 covered months of 200, 400, 600 -> 400/month', async () => {
    const e = await run(tables(
      { fdh_financial_accounts: [account('bank')] },
      { fdh_statement_uploads: [statement('s-q', 'bank', '2026-06-01', '2026-08-31')] },
      { fdh_transactions: [
        txn({ account: 'bank', statement: 's-q', date: '2026-06-12', amount: 200, type: 'expense', category: CAT.food }),
        txn({ account: 'bank', statement: 's-q', date: '2026-07-12', amount: 400, type: 'expense', category: CAT.food }),
        txn({ account: 'bank', statement: 's-q', date: '2026-08-12', amount: 600, type: 'expense', category: CAT.food }),
      ] },
    ));
    expect(e.actual.monthly).toBe(400);
  });
});

describe('investment legs are never spending', () => {
  it('a BUY funding leg typed investment, and one mis-typed expense but corroborated by an approved BUY, are both spending 0', async () => {
    const e = await run(tables(bankAug(), {
      fdh_transactions: [
        txn({ id: 'fund1', account: 'bank', statement: 's-aug', date: '2026-08-04', amount: 10000, type: 'investment', category: CAT.investment }),
        txn({ id: 'fund2', account: 'bank', statement: 's-aug', date: '2026-08-05', amount: 5000, type: 'expense', category: CAT.investment }),
      ],
      fdh_investment_statements: [{ id: 'inv-s', user_id: USER, approval_status: 'approved' }],
      fdh_investment_statement_activities: [{ id: 'buy-act', user_id: USER, statement_id: 'inv-s', activity_type: 'BUY', amount: 5000, currency_code: 'AUD', linked_transaction_id: 'fund2', bank_match_status: 'matched' }],
    }));
    expect(e.actual.monthly).toBe(0);
    expect(nonSpending(e, 'investment').totalInWindow).toBe(15000);
  });

  it('negative control: the same corroboration from an UNAPPROVED broker statement does not re-bucket', async () => {
    const e = await run(tables(bankAug(), {
      fdh_transactions: [txn({ id: 'fund2', account: 'bank', statement: 's-aug', date: '2026-08-05', amount: 5000, type: 'expense', category: CAT.investment })],
      fdh_investment_statements: [{ id: 'inv-s', user_id: USER, approval_status: 'pending' }],
      fdh_investment_statement_activities: [{ id: 'buy-act', user_id: USER, statement_id: 'inv-s', activity_type: 'BUY', amount: 5000, currency_code: 'AUD', linked_transaction_id: 'fund2', bank_match_status: 'matched' }],
    }));
    expect(e.actual.monthly).toBe(5000);
  });
});

describe('combined basis (PO D-02): never planned + actual for the same group', () => {
  const planned = { expense_items: [expenseItem('e-groc', 'Groceries', 800, 'monthly', { master_item_key: 'groceries' })] };

  it('Household M (planned $800 groceries) == Household I (covered actual $800): identical combined totals', async () => {
    const m = await run(planned);
    const i = await run(tables(bankAug(), { fdh_transactions: [txn({ account: 'bank', statement: 's-aug', date: '2026-08-10', amount: 800, type: 'expense', category: CAT.food, subcategory: SUB.groceries })] }));
    expect(m.combined.monthly).toBe(800);
    expect(i.combined.monthly).toBe(800);
    expect(m.combined.essentialMonthly).toBe(i.combined.essentialMonthly);
  });

  it('planned $800 + actual $750 in the same group: combined = 750 (actual), NOT 1,550; variance shown', async () => {
    const e = await run(tables(planned, bankAug(), { fdh_transactions: [txn({ account: 'bank', statement: 's-aug', date: '2026-08-10', amount: 750, type: 'expense', category: CAT.food, subcategory: SUB.groceries })] }));
    const g = e.combined.byGroup.find((x) => x.group === 'food')!;
    expect(g).toMatchObject({ basis: 'actual', monthly: 750, plannedMonthly: 800, actualMonthly: 750, varianceMonthly: -50 });
    expect(e.combined.monthly).toBe(750);
    expect(e.combined.monthly).not.toBe(e.planned.monthly + e.actual.monthly);
    // The explicit bases are still available to consumers that need them.
    expect(e.planned.monthly).toBe(800);
    expect(e.actual.monthly).toBe(750);
  });

  it('a group with no covered actual keeps its plan; partial-month actuals do not displace it', async () => {
    const e = await run(tables(
      { expense_items: [expenseItem('e-rent', 'Rent', 2000, 'monthly', { master_item_key: 'rent' })] },
      { fdh_financial_accounts: [account('bank')] },
      { fdh_statement_uploads: [statement('s-part', 'bank', '2026-08-10', '2026-08-31')] },
      { fdh_transactions: [txn({ account: 'bank', statement: 's-part', date: '2026-08-12', amount: 1900, type: 'expense', category: CAT.housing })] },
    ));
    const g = e.combined.byGroup.find((x) => x.group === 'housing')!;
    expect(g.basis).toBe('planned');
    expect(e.combined.monthly).toBe(2000);
  });

  it('selected basis mirrors the requested basis', async () => {
    const t = tables(planned, bankAug(), { fdh_transactions: [txn({ account: 'bank', statement: 's-aug', date: '2026-08-10', amount: 750, type: 'expense', category: CAT.food })] });
    expect((await run(t, 'planned')).selected.monthly).toBe(800);
    expect((await run(t, 'actual')).selected.monthly).toBe(750);
    expect((await run(t, 'combined')).selected.monthly).toBe(750);
  });

  it('planned rows: superseded / SMSF / debt-service duplicates are excluded and say why', async () => {
    const e = await run(tables(
      { expense_items: [
        expenseItem('e1', 'Groceries', 500, 'monthly', { master_item_key: 'groceries', superseded_by_bank_import: true }),
        expenseItem('e2', 'SMSF audit', 300, 'annually', { owner: 'smsf' }),
        expenseItem('e3', 'Mortgage', 3000, 'monthly', { master_item_key: 'mortgage' }),
        expenseItem('e4', 'Power', 1200, 'quarterly', { master_item_key: 'electricity' }),
      ] },
      { liabilities: [liability('home', { debt_type: 'mortgage', master_item_key: 'home_loan', monthly_repayment: 3000 })] },
    ));
    const reasons = Object.fromEntries(e.planned.lines.map((l) => [l.id, l.excludedReason]));
    expect(reasons).toEqual({ e1: 'superseded_by_bank_import', e2: 'smsf_owned', e3: 'debt_service_duplicate', e4: null });
    expect(e.planned.monthly).toBe(400);
  });
});

describe('fail closed', () => {
  it("a query error on any source is 'unavailable', never $0", async () => {
    for (const table of ['fdh_transactions', 'expense_items', 'fdh_transaction_allocations', 'fdh_statement_uploads', 'liabilities', 'user_profiles']) {
      const { client } = makeFakeSupabase(tables(profile(), taxonomy(), bankAug(), {
        fdh_transactions: [txn({ id: 'x', account: 'bank', statement: 's-aug', date: '2026-08-02', amount: 10, type: 'expense' })],
        expense_items: [expenseItem('e', 'x', 10, 'monthly')],
      }), { failOn: new Set([table]) });
      const res = await selectExpenses(USER, { client, window: WINDOW });
      expect(res.status, table).toBe('unavailable');
      expect(res).not.toHaveProperty('actual');
    }
  });

  it('a database without the 0207 columns degrades owner attribution explicitly instead of failing', async () => {
    const { client } = makeFakeSupabase(tables(profile(), taxonomy(), bankAug(), {
      fdh_transactions: [txn({ account: 'bank', statement: 's-aug', date: '2026-08-02', amount: 10, type: 'expense' })],
    }), { missingColumns: { fdh_financial_accounts: ['owner_role', 'liability_id'] } });
    const res = await selectExpenses(USER, { client, window: WINDOW });
    expect(res.status).toBe('ok');
    if (res.status === 'ok') {
      expect(res.actual.ownerAttributionAvailable).toBe(false);
      expect(res.actual.monthly).toBe(10);
    }
  });
});
