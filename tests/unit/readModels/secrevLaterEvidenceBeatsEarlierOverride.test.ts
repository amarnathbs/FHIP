/**
 * Security/integrity review (canonical-upload stage 3) -- the residual of the
 * economic-oracle fix D1 (rule 6 before rule 9).
 *
 * Reproduced live on DEV (range D, forecast.tc004): the user files the broker
 * SALE PROCEEDS credit (15,000) as "Income" while reviewing the bank
 * statement -- every categorisation writes a correction row and sets
 * user_override. The broker statement is then approved (its SELL matched to
 * that exact credit) and applied. Counted actual income moved by +15,400
 * (15,000 + the 400 dividend) where the oracle is +400: rule 9 let the EARLIER
 * category choice silence the LATER, explicit approval of the SELL evidence.
 *
 * Rule after the fix: approved evidence re-buckets a user-decided line only
 * when the statement carrying it was approved AFTER the user's last decision
 * on that line (the later explicit decision wins). A decision made after the
 * approval still stands (rule 9 as before), and so does a line whose decision
 * time is unknown.
 */
import { describe, expect, it } from 'vitest';

import { selectIncome, type IncomeReadModelData } from '@/lib/read-models/income';
import { selectExpenses } from '@/lib/read-models/expenses';
import { makeFakeSupabase, type Row } from './helpers/fakeSupabase';
import { account, CAT, profile, statement, tables, taxonomy, txn, USER, WINDOW } from './helpers/fixtures';

async function income(t: Record<string, Row[]>): Promise<IncomeReadModelData> {
  const { client } = makeFakeSupabase(tables(profile(), taxonomy(), t));
  const res = await selectIncome(USER, { client, window: WINDOW });
  if (res.status !== 'ok') throw new Error(`unavailable: ${res.reason} ${res.source}`);
  return res;
}

const bankAug = () => tables({ fdh_financial_accounts: [account('bank')] }, { fdh_statement_uploads: [statement('s-aug', 'bank', '2026-08-01', '2026-08-31')] });
const saleFiledAsIncome = () => txn({ id: 'sale', account: 'bank', statement: 's-aug', date: '2026-08-20', amount: 15000, type: 'income', category: CAT.income, userOverride: true });
const correction = (at: string, reason = 'user categorised') => ({ id: `c-${at}`, user_id: USER, transaction_id: 'sale', field_name: 'category_id', previous_value: null, corrected_value: CAT.income, reason, corrected_at: at, created_at: at });
const broker = (approvedAt: string) => ({
  fdh_investment_statements: [{ id: 'inv-s', user_id: USER, approval_status: 'approved', approved_at: approvedAt }],
  fdh_investment_statement_activities: [{ id: 'a-sell', user_id: USER, statement_id: 'inv-s', activity_type: 'SELL', amount: 15000, currency_code: 'AUD', linked_transaction_id: 'sale', bank_match_status: 'matched' }],
});

describe('approved SELL evidence vs an earlier category choice on the proceeds credit', () => {
  it('categorised 09:00, broker statement approved 10:00 -> the 15,000 is NOT ordinary income', async () => {
    const e = await income(tables(bankAug(), { fdh_transactions: [saleFiledAsIncome()], fdh_transaction_corrections: [correction('2026-09-01T09:00:00Z')] }, broker('2026-09-01T10:00:00Z')));
    expect(e.actual.countedMonthly).toBe(0);
  });

  it('control: the user re-files it as income AFTER approving the broker statement -> their decision stands', async () => {
    const e = await income(tables(bankAug(), { fdh_transactions: [saleFiledAsIncome()], fdh_transaction_corrections: [correction('2026-09-01T11:00:00Z')] }, broker('2026-09-01T10:00:00Z')));
    expect(e.actual.countedMonthly).toBeGreaterThan(0);
  });

  it('control: a SYSTEM reclassification row is not a user decision', async () => {
    const e = await income(tables(bankAug(), {
      fdh_transactions: [saleFiledAsIncome()],
      fdh_transaction_corrections: [correction('2026-09-01T09:00:00Z'), correction('2026-09-01T12:00:00Z', 'system:investment_statement_activity:x')],
    }, broker('2026-09-01T10:00:00Z')));
    expect(e.actual.countedMonthly).toBe(0);
  });

  it('control: decision time unknown (no correction row) -> rule 9 as before, the override stands', async () => {
    const e = await income(tables(bankAug(), { fdh_transactions: [saleFiledAsIncome()] }, broker('2026-09-01T10:00:00Z')));
    expect(e.actual.countedMonthly).toBeGreaterThan(0);
  });

  it('a failed read of the decision history is unavailable, never a silent fallback', async () => {
    const { client } = makeFakeSupabase(tables(profile(), taxonomy(), tables(bankAug(), { fdh_transactions: [saleFiledAsIncome()], fdh_transaction_corrections: [correction('2026-09-01T09:00:00Z')] }, broker('2026-09-01T10:00:00Z'))), { failOn: new Set(['fdh_transaction_corrections']) });
    expect((await selectIncome(USER, { client, window: WINDOW })).status).toBe('unavailable');
  });
});

describe('the same rule on the spending side (BUY funding debit filed as Shopping)', () => {
  it('categorised before the broker statement was approved -> 10,000 is invested, not spending', async () => {
    const { client } = makeFakeSupabase(tables(profile(), taxonomy(), tables(bankAug(), {
      fdh_transactions: [txn({ id: 'fund', account: 'bank', statement: 's-aug', date: '2026-08-04', amount: 10000, type: 'expense', category: CAT.lifestyle, userOverride: true })],
      fdh_transaction_corrections: [{ id: 'c1', user_id: USER, transaction_id: 'fund', field_name: 'category_id', previous_value: null, corrected_value: CAT.lifestyle, reason: 'user', corrected_at: '2026-09-01T09:00:00Z', created_at: '2026-09-01T09:00:00Z' }],
      fdh_investment_statements: [{ id: 'inv-s', user_id: USER, approval_status: 'approved', approved_at: '2026-09-01T10:00:00Z' }],
      fdh_investment_statement_activities: [{ id: 'a-buy', user_id: USER, statement_id: 'inv-s', activity_type: 'BUY', amount: 10000, currency_code: 'AUD', linked_transaction_id: 'fund', bank_match_status: 'matched' }],
    })));
    const res = await selectExpenses(USER, { client, window: WINDOW });
    if (res.status !== 'ok') throw new Error(`unavailable: ${res.reason}`);
    expect(res.actual.totalInWindow).toBe(0);
  });
});
