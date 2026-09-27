/**
 * Combined precedence of the canonical spending rules (stage-3 consolidation,
 * 2026-09-27). Three certifiers changed spendingRules.effectiveBucket /
 * the ledger independently; this test exercises all three fixes TOGETHER in
 * one household so a merge that silently drops or reorders one of them fails
 * by name:
 *
 *  - D1  (economic oracles): a CONFIRMED card-settlement link beats the
 *        user's own category choice (user_override) -- $220, never $440.
 *  - R9  (security review): approved broker evidence approved AFTER the
 *        user's last own decision on the line beats that decision; one made
 *        after the approval still stands.
 *  - Rule 10 (scale/UI) + PO D-01: an UNLINKED credit of a spending type on an
 *        ordinary account is an unlinked refund -- it neither adds to nor
 *        reduces spending; with a confirmed refund_original link it nets.
 *
 * Every expected value is hand-computed from the rows below.
 */
import { describe, expect, it } from 'vitest';

import { effectiveBucket } from '@/lib/read-models/core/spendingRules';
import { selectExpenses, type ExpensesReadModelData } from '@/lib/read-models/expenses';
import { makeFakeSupabase, type Row } from './helpers/fakeSupabase';
import { account, CAT, link, profile, statement, SUB, tables, taxonomy, txn, USER, WINDOW } from './helpers/fixtures';

async function run(t: Record<string, Row[]>): Promise<ExpensesReadModelData> {
  const { client } = makeFakeSupabase(tables(profile(), taxonomy(), t));
  const res = await selectExpenses(USER, { client, window: WINDOW, basis: 'actual' });
  if (res.status !== 'ok') throw new Error(`unavailable: ${res.reason} ${res.source}`);
  return res;
}

const nonSpending = (e: ExpensesReadModelData, b: string) => e.actual.nonSpending.find((x) => x.bucket === b)?.totalInWindow ?? 0;

interface Knobs {
  /** Status of the card-settlement link on the user-filed repayment (null = no link). */
  settlementLink?: string | null;
  /** When the user last categorised the broker-funding debit (broker statement approved 10:00). */
  fundingDecisionAt?: string;
  /** Confirm a refund_original link from the credit to the groceries purchase. */
  refundLinked?: boolean;
}

function household(k: Knobs = {}): Record<string, Row[]> {
  const settlement = k.settlementLink === undefined ? 'confirmed' : k.settlementLink;
  const decisionAt = k.fundingDecisionAt ?? '2026-09-01T09:00:00Z';
  const links: Row[] = [];
  if (settlement) links.push(link('lnk-settle', 'pay-bank', 'pay-card', 'credit_card_settlement', settlement));
  if (k.refundLinked) links.push(link('lnk-refund', 'ref', 'groc', 'refund_original'));
  return tables(
    { fdh_financial_accounts: [account('bank'), account('card', 'credit_card', { liability_id: 'L-card' })] },
    { fdh_statement_uploads: [statement('s-bank', 'bank', '2026-08-01', '2026-08-31'), statement('s-card', 'card', '2026-08-01', '2026-08-31', { document_type: 'credit_card_statement' })] },
    {
      fdh_transactions: [
        // Card purchases: the household's consumption through the card.
        txn({ id: 'p1', account: 'card', statement: 's-card', date: '2026-08-03', amount: 200, type: 'expense', category: CAT.food, subcategory: SUB.groceries }),
        txn({ id: 'p2', account: 'card', statement: 's-card', date: '2026-08-09', amount: 20, type: 'expense', category: CAT.food, subcategory: SUB.restaurants }),
        txn({ id: 'pay-card', account: 'card', statement: 's-card', date: '2026-08-28', amount: 220, type: 'transfer', cd: 'credit', category: CAT.ccPayment }),
        // D1: the bank repayment the USER filed as spending before the card statement was applied.
        txn({ id: 'pay-bank', account: 'bank', statement: 's-bank', date: '2026-08-28', amount: 220, type: 'expense', category: CAT.lifestyle, userOverride: true }),
        // R9: the broker-funding debit the USER filed as spending.
        txn({ id: 'fund', account: 'bank', statement: 's-bank', date: '2026-08-04', amount: 10000, type: 'expense', category: CAT.lifestyle, userOverride: true }),
        // Ordinary bank spending.
        txn({ id: 'groc', account: 'bank', statement: 's-bank', date: '2026-08-12', amount: 150, type: 'expense', category: CAT.food, subcategory: SUB.groceries }),
        // Rule 10: a credit the USER filed under Food (type expense) -- money in.
        txn({ id: 'ref', account: 'bank', statement: 's-bank', date: '2026-08-20', amount: 20, type: 'expense', cd: 'credit', category: CAT.food, subcategory: SUB.groceries, userOverride: true }),
      ],
      fdh_transaction_links: links,
      fdh_transaction_corrections: [
        { id: 'c-fund', user_id: USER, transaction_id: 'fund', field_name: 'category_id', previous_value: null, corrected_value: CAT.lifestyle, reason: 'user categorised', corrected_at: decisionAt, created_at: decisionAt },
      ],
      fdh_investment_statements: [{ id: 'inv-s', user_id: USER, approval_status: 'approved', approved_at: '2026-09-01T10:00:00Z' }],
      fdh_investment_statement_activities: [{ id: 'a-buy', user_id: USER, statement_id: 'inv-s', activity_type: 'BUY', amount: 10000, currency_code: 'AUD', linked_transaction_id: 'fund', bank_match_status: 'matched' }],
    },
  );
}

describe('effectiveBucket precedence: D1 + R9 + rule 10 in one household', () => {
  it('all three fixes together: spending 200 + 20 + 150 = 370', async () => {
    const e = await run(household());
    expect(e.actual.totalInWindow).toBe(370);
    expect(e.actual.lines.map((l) => l.transactionId).sort()).toEqual(['groc', 'p1', 'p2']);
    // D1: both repayment legs are transfers.
    expect(nonSpending(e, 'transfer')).toBe(440);
    // R9: the funding debit is invested, not spent.
    expect(nonSpending(e, 'investment')).toBe(10000);
    // Rule 10 + D-01: the credit is shown as an unlinked refund and does not reduce spending.
    expect(e.actual.refundsUnlinked.count).toBe(1);
    expect(e.actual.refundsUnlinked.totalInWindow).toBe(20);
    expect(e.actual.refundsNetted.count).toBe(0);
  });

  it('control D1: the settlement link only PENDING -> the user-filed repayment stays spending (370 + 220 = 590)', async () => {
    expect((await run(household({ settlementLink: 'pending' }))).actual.totalInWindow).toBe(590);
  });

  it('control R9: the user re-filed the funding debit AFTER the broker approval -> their decision stands (370 + 10,000)', async () => {
    const e = await run(household({ fundingDecisionAt: '2026-09-01T11:00:00Z' }));
    expect(e.actual.totalInWindow).toBe(10370);
    expect(nonSpending(e, 'investment')).toBe(0);
  });

  it('control rule 10 / D-01: with a CONFIRMED refund_original link the credit nets (370 - 20 = 350)', async () => {
    const e = await run(household({ refundLinked: true }));
    expect(e.actual.totalInWindow).toBe(350);
    expect(e.actual.refundsNetted.count).toBe(1);
    expect(e.actual.refundsUnlinked.count).toBe(0);
  });

  it('all three knobs off together: 370 + 220 + 10,000 = 10,590 (no fix masks another)', async () => {
    expect((await run(household({ settlementLink: null, fundingDecisionAt: '2026-09-01T11:00:00Z' }))).actual.totalInWindow).toBe(10590);
  });
});

describe('effectiveBucket precedence at the pure-function level', () => {
  const base = { onFacility: false, isSplit: false, links: [] as { linkType: string; status: string; counterpartOnFacility: boolean }[], corroborations: [] as { kind: 'investment_activity'; sourceId: string; activityType: string }[] };
  const settled = [{ linkType: 'credit_card_settlement', status: 'confirmed', counterpartOnFacility: true }];
  const buy = [{ kind: 'investment_activity' as const, sourceId: 'a', activityType: 'BUY' }];

  it('confirmed settlement link beats user_override (D1)', () => {
    expect(effectiveBucket({ ...base, type: 'expense', userOverride: true, links: settled, creditDebit: 'debit' }).bucket).toBe('transfer');
  });
  it('user_override still in force beats corroboration (rule 9); cleared override lets it re-bucket (R9 is decided by the ledger)', () => {
    expect(effectiveBucket({ ...base, type: 'expense', userOverride: true, corroborations: buy, creditDebit: 'debit' }).bucket).toBe('spending');
    expect(effectiveBucket({ ...base, type: 'expense', userOverride: false, corroborations: buy, creditDebit: 'debit' }).bucket).toBe('investment');
  });
  it('rule 10 shapes the base under user_override, but a confirmed link still wins', () => {
    expect(effectiveBucket({ ...base, type: 'expense', userOverride: true, creditDebit: 'credit' }).bucket).toBe('refund');
    expect(effectiveBucket({ ...base, type: 'expense', userOverride: true, creditDebit: 'credit', links: [{ linkType: 'internal_transfer', status: 'confirmed', counterpartOnFacility: false }] }).bucket).toBe('transfer');
  });
  it('facility and split lines keep their base bucket', () => {
    expect(effectiveBucket({ ...base, type: 'debt_interest', onFacility: true, userOverride: false, links: settled, creditDebit: 'credit' }).bucket).toBe('cost_of_debt');
    expect(effectiveBucket({ ...base, type: 'expense', isSplit: true, userOverride: false, links: settled, creditDebit: 'debit' }).bucket).toBe('spending');
  });
});
