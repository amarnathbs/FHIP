/**
 * "Income and expense allocation" on the Financial Data Hub Overview (PO 04-11-2026). Synthetic lines only: made-up categories, round amounts.
 *
 * Pinned here: the table's income and spending equal the certified approved summary on the same lines (no second definition of income or spending); approved
 * and waiting money are never added together; a duplicate is left out; a split counts through its allocations; a refund is not income; the analysis is built
 * from the figures and says what it excluded.
 */
import { describe, it, expect } from 'vitest';
import {
  buildAllocationOverview,
  describeAllocation,
  sectionOf,
  type AllocationInputTxn,
} from '@/lib/financial-data-hub/analytics/allocationOverview';
import { computeApprovedFinancialSummary, type ApprovedSummaryTransaction } from '@/lib/financial-data-hub/domain/approvedSummary';

const LABELS: Record<string, string> = { salary: 'Salary', rent: 'Housing', food: 'Food & Dining', fuel: 'Transport', own: 'Own-Account Transfer', refunds: 'Refund / Reversal' };
const label = (id: string) => LABELS[id] ?? null;
const money = (n: number) => `$${n.toFixed(2)}`;

function txn(over: Partial<AllocationInputTxn> & Pick<AllocationInputTxn, 'creditDebit' | 'amount' | 'economicType' | 'categoryId'>): AllocationInputTxn {
  return { currency: 'AUD', dedupStatus: 'unique', allocations: [], ...over };
}

const APPROVED: AllocationInputTxn[] = [
  txn({ creditDebit: 'credit', amount: 5000, economicType: 'income', categoryId: 'salary' }),
  txn({ creditDebit: 'credit', amount: 1000, economicType: 'income', categoryId: 'salary' }),
  txn({ creditDebit: 'debit', amount: 1800, economicType: 'expense', categoryId: 'rent' }),
  txn({ creditDebit: 'debit', amount: 400, economicType: 'expense', categoryId: 'food' }),
  txn({ creditDebit: 'debit', amount: 200, economicType: 'expense', categoryId: 'food' }),
  txn({ creditDebit: 'debit', amount: 100, economicType: 'expense', categoryId: 'fuel' }),
  txn({ creditDebit: 'debit', amount: 700, economicType: 'transfer', categoryId: 'own' }),
  txn({ creditDebit: 'debit', amount: 50, economicType: 'unknown', categoryId: null }),
];
const WAITING: AllocationInputTxn[] = [
  txn({ creditDebit: 'debit', amount: 90, economicType: 'expense', categoryId: 'food' }),
  txn({ creditDebit: 'credit', amount: 300, economicType: 'unknown', categoryId: null }),
];

const result = () => buildAllocationOverview({ approved: APPROVED, waiting: WAITING, categoryLabel: label }).currencies[0];

describe('the allocation table', () => {
  it('puts every line in exactly one section, with the category rows biggest first and "No category yet" last', () => {
    const c = result();
    expect(c.sections.income.rows.map((r) => [r.label, r.approvedTotal, r.approvedCount])).toEqual([['Salary', 6000, 2]]);
    expect(c.sections.spending.rows.map((r) => [r.label, r.approvedTotal])).toEqual([['Housing', 1800], ['Food & Dining', 600], ['Transport', 100]]);
    expect(c.sections.not_counted.rows.map((r) => [r.label, r.approvedTotal])).toEqual([['Own-Account Transfer', 700]]);
    expect(c.sections.needs_category.rows.map((r) => [r.label, r.approvedTotal, r.waitingTotal])).toEqual([['No category yet', 50, 300]]);
  });

  it('shares are of the section approved total, to one decimal', () => {
    const c = result();
    expect(c.sections.spending.rows.map((r) => r.approvedSharePct)).toEqual([72, 24, 4]);
    expect(c.sections.income.rows[0].approvedSharePct).toBe(100);
  });

  it('net and savings rate are approved income minus approved spending', () => {
    const c = result();
    expect(c.approvedNet).toBe(3500);
    expect(c.approvedSavingsRatePct).toBe(58.3);
  });

  it('INVARIANT: income and spending equal the certified approved summary on the same lines', () => {
    const oracleIn: ApprovedSummaryTransaction[] = APPROVED.map((t, i) => ({
      id: String(i), amount_original: t.amount, currency_original: t.currency, economic_transaction_type: t.economicType, category_id: t.categoryId,
      dedup_status: t.dedupStatus, credit_debit: t.creditDebit, allocations: [],
    }));
    const oracle = computeApprovedFinancialSummary('AUD', oracleIn, []);
    const c = result();
    expect(c.sections.income.approvedTotal).toBe(oracle.income_total);
    expect(c.sections.spending.approvedTotal).toBe(oracle.expense_total);
  });

  it('INVARIANT: approved and waiting are never added: a waiting line changes the waiting column only', () => {
    const without = buildAllocationOverview({ approved: APPROVED, waiting: [], categoryLabel: label }).currencies[0];
    const withWaiting = result();
    for (const s of ['income', 'spending', 'not_counted', 'needs_category'] as const) {
      expect(withWaiting.sections[s].approvedTotal).toBe(without.sections[s].approvedTotal);
      expect(withWaiting.sections[s].approvedCount).toBe(without.sections[s].approvedCount);
    }
    expect(withWaiting.sections.spending.waitingTotal).toBe(90);
    expect(without.sections.spending.waitingTotal).toBe(0);
  });

  it('a confirmed duplicate is left out; a split counts through its allocations, not its parent', () => {
    const c = buildAllocationOverview({
      approved: [
        txn({ creditDebit: 'debit', amount: 100, economicType: 'expense', categoryId: 'food' }),
        txn({ creditDebit: 'debit', amount: 100, economicType: 'expense', categoryId: 'food', dedupStatus: 'duplicate_confirmed' }),
        txn({
          creditDebit: 'debit', amount: 80, economicType: 'expense', categoryId: 'food',
          allocations: [
            { amount: 50, currency: 'AUD', economicType: 'expense', categoryId: 'food' },
            { amount: 30, currency: 'AUD', economicType: 'expense', categoryId: 'fuel' },
          ],
        }),
      ],
      waiting: [],
      categoryLabel: label,
    }).currencies[0];
    expect(c.sections.spending.rows.map((r) => [r.label, r.approvedTotal, r.approvedCount])).toEqual([['Food & Dining', 150, 2], ['Transport', 30, 1]]);
  });

  it('money in of a spending type is a refund: not income and not negative spending', () => {
    expect(sectionOf('expense', 'credit')).toBe('not_counted');
    const c = buildAllocationOverview({
      approved: [txn({ creditDebit: 'debit', amount: 100, economicType: 'expense', categoryId: 'food' }), txn({ creditDebit: 'credit', amount: 40, economicType: 'expense', categoryId: 'food' })],
      waiting: [],
      categoryLabel: label,
    }).currencies[0];
    expect(c.sections.spending.approvedTotal).toBe(100);
    expect(c.sections.income.approvedTotal).toBe(0);
    expect(c.sections.not_counted.approvedTotal).toBe(40);
  });

  it('currencies are never blended', () => {
    const r = buildAllocationOverview({
      approved: [txn({ creditDebit: 'credit', amount: 100, economicType: 'income', categoryId: 'salary' }), txn({ creditDebit: 'credit', amount: 9000, currency: 'INR', economicType: 'income', categoryId: 'salary' })],
      waiting: [],
      categoryLabel: label,
    });
    expect(r.currencies.map((c) => [c.currency, c.sections.income.approvedTotal])).toEqual([['AUD', 100], ['INR', 9000]]);
  });
});

describe('the analysis', () => {
  const lines = () => describeAllocation(result(), money);

  it('states income, spending and what was kept, from the figures', () => {
    expect(lines()[0]).toBe('In this period you received $6000.00 and spent $2500.00, so you kept $3500.00 (58.3% of what you received).');
  });

  it('names the biggest spending categories with their share', () => {
    expect(lines()).toContain('Your biggest spending is Housing ($1800.00, 72% of your spending), then Food & Dining (24%) and Transport (4%).');
  });

  it('says what is not counted, what has no category and what is still waiting, so nothing is silently left out', () => {
    const text = lines().join('\n');
    expect(text).toContain('1 line ($700.00) is moves between your own accounts');
    expect(text).toContain('1 approved line ($50.00) has no category');
    expect(text).toContain('2 lines are still waiting for your approval');
    expect(text).toContain('1 of those needs a category');
  });

  it('says it plainly when a period overspent', () => {
    const c = buildAllocationOverview({
      approved: [txn({ creditDebit: 'credit', amount: 100, economicType: 'income', categoryId: 'salary' }), txn({ creditDebit: 'debit', amount: 150, economicType: 'expense', categoryId: 'food' })],
      waiting: [],
      categoryLabel: label,
    }).currencies[0];
    expect(describeAllocation(c, money)[0]).toBe('In this period you received $100.00 and spent $150.00, so you spent more than you received, by $50.00 (50% more than you received).');
  });

  it('with nothing approved it still speaks about the waiting lines and says they are not in the figures', () => {
    const c = buildAllocationOverview({ approved: [], waiting: WAITING, categoryLabel: label }).currencies[0];
    const text = describeAllocation(c, money).join('\n');
    expect(text).toContain('2 lines are still waiting for your approval');
    expect(text).not.toContain('In this period you received');
  });

  it('NEGATIVE CONTROL: merging the waiting list into the approved pass would change the approved figures, and the invariant test would catch it', () => {
    const merged = buildAllocationOverview({ approved: [...APPROVED, ...WAITING], waiting: [], categoryLabel: label }).currencies[0];
    expect(merged.sections.spending.approvedTotal).not.toBe(result().sections.spending.approvedTotal);
  });
});
