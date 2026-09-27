/**
 * Canonical-cert scale finding (live on DEV, 2026-09-27): the R8 classification run
 * (`classifyUserTransactions`, behind POST .../bank-transactions/categorise, which the Expenses import
 * panel calls after every bank import, and behind "Save category" + "Remember this payee") wrote ONE
 * transaction row per request, plus one classification-history insert per classified row. For a
 * 1,000-line statement that is ~1,000-2,000 SEQUENTIAL PostgREST round trips in one HTTP request:
 * 292.9 s for categorise and 5.1 min for a remember-payee save on localhost against DEV, and above the
 * production 28 s request limit at any round-trip time over ~15 ms.
 *
 * The fix batches the writes: rows that receive the SAME update are written together with
 * `.in('id', <=100 ids)`, and history rows are inserted in chunks. The results must be identical.
 * Each [NC] test fails on the per-row code with the number of write requests it made.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, type FakeDb } from '../support/fdhFakeSupabase';

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  writes: { update: 0, insert: 0 } as Record<string, number>,
  writesByTable: {} as Record<string, number>,
}));

/** The admin client, with every UPDATE / INSERT request counted (one builder = one request). */
function countingAdmin() {
  const admin = h.db.adminClient() as unknown as { from(t: string): Record<string, (...a: unknown[]) => unknown> };
  return {
    ...admin,
    rpc: (h.db.adminClient() as unknown as { rpc: (...a: unknown[]) => unknown }).rpc,
    from(table: string) {
      const qb = admin.from(table);
      for (const m of ['update', 'insert'] as const) {
        const orig = qb[m].bind(qb);
        qb[m] = (...a: unknown[]) => { h.writes[m] += 1; h.writesByTable[`${m}:${table}`] = (h.writesByTable[`${m}:${table}`] ?? 0) + 1; return orig(...a); };
      }
      return qb;
    },
  };
}

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.db.sessionClient(A) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => countingAdmin() }));

vi.setConfig({ testTimeout: 60000 });

const A = 'a0000000-0000-4000-8000-00000000000a';
const ACC = 'e0000000-0000-4000-8000-0000000000a1';
const UP = 'd0000000-0000-4000-8000-000000000001';
const FOOD = 'c0000000-0000-4000-8000-000000000003';
const N = 250;
const idOf = (i: number) => `f8000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

function seed(db: FakeDb) {
  db.insert('fdh_categories', { id: FOOD, category_key: 'food', display_name: 'Food & Dining', economic_type: 'expense', active: true });
  db.insert('fdh_financial_accounts', { id: ACC, user_id: A, institution_id: null, account_type: 'transaction', currency_code: 'AUD', display_name: 'Everyday', active: true });
  db.insert('fdh_statement_uploads', {
    id: UP, user_id: A, household_id: null, financial_account_id: ACC, source_type: 'csv', currency_code: 'AUD',
    statement_period_start: '2026-08-01', statement_period_end: '2026-08-31', processing_status: 'review_required', approved_by: null, approved_at: null, approval_version: 0,
  });
  for (let i = 1; i <= N; i += 1) {
    db.insert('fdh_transactions', {
      id: idOf(i), user_id: A, financial_account_id: ACC, statement_upload_id: UP, transaction_date: `2026-08-${String(1 + (i % 28)).padStart(2, '0')}`,
      description_clean: `FHIP TEST MERCHANT ${String(i).padStart(5, '0')} C`, description_raw: `FHIP TEST MERCHANT ${i}`, merchant_raw: null,
      // Distinct amounts so no recurring series / transfer pair is detected (they would add their own writes).
      amount_original: 10 + i * 1.37, currency_original: 'AUD', credit_debit: i % 10 === 0 ? 'credit' : 'debit', transaction_type_hint: null,
      source_reference: null, economic_transaction_type: 'unknown', category_id: null, subcategory_id: null, merchant_id: null,
      classification_method: 'unclassified', classification_confidence: null, user_override: false, review_status: 'not_required',
      approval_status: 'pending', approved_at: null, approved_by: null, dedup_status: 'unique', recurring_transaction_id: null,
      recurring_flag: false, subscription_flag: false, transfer_flag: false, posting_date: null, value_date: null, balance_after: null, source_row: i,
    });
  }
}

const txns = () => h.db.rows('fdh_transactions').filter((r) => r.statement_upload_id === UP);

beforeEach(() => {
  h.db = createFakeDb();
  h.writes.update = 0; h.writes.insert = 0;
  for (const k of Object.keys(h.writesByTable)) delete h.writesByTable[k];
  seed(h.db);
});

describe('classifyUserTransactions writes in batches, with identical results', () => {
  it('[NC] 250 unresolved lines: every one sent to review, in at most 3 UPDATE requests (was 250)', async () => {
    const { classifyUserTransactions } = await import('@/lib/financial-data-hub/services/transactionClassificationService');
    const summary = await classifyUserTransactions(A);
    expect(summary.transactionsUnresolved).toBe(N);
    expect(txns().every((t) => t.review_status === 'pending')).toBe(true);
    expect(h.writesByTable['update:fdh_transactions'] ?? 0).toBeLessThanOrEqual(3);
  });

  it('[NC] 250 lines classified by one remembered payee: same values on every row, <= 3 UPDATEs and <= 1 history INSERT (was 250 + 250)', async () => {
    h.db.insert('fdh_user_classification_rules', {
      user_id: A, rule_type: 'description_contains', priority: 100, active: true,
      match_definition: { match_kind: 'description_contains', needle_normalised: 'FHIP TEST MERCHANT' },
      action_definition: { action_kind: 'classify', category_id: FOOD, economic_transaction_type: 'expense' },
    });
    const { classifyUserTransactions } = await import('@/lib/financial-data-hub/services/transactionClassificationService');
    const summary = await classifyUserTransactions(A);
    expect(summary.transactionsClassified).toBe(N);
    for (const t of txns()) expect(t, t.id as string).toMatchObject({ economic_transaction_type: 'expense', category_id: FOOD, classification_method: 'user_rule' });
    const history = h.db.rows('fdh_classification_history').filter((r) => r.user_id === A);
    expect(history).toHaveLength(N);
    expect(new Set(history.map((r) => r.transaction_id)).size).toBe(N);
    expect(history.every((r) => r.new_category_id === FOOD && r.previous_economic_transaction_type === 'unknown' && r.new_economic_transaction_type === 'expense')).toBe(true);
    expect(h.writesByTable['update:fdh_transactions'] ?? 0).toBeLessThanOrEqual(3);
    expect(h.writesByTable['insert:fdh_classification_history'] ?? 0).toBeLessThanOrEqual(1);
  });

  it('control: a second run changes nothing and writes nothing to fdh_transactions', async () => {
    const { classifyUserTransactions } = await import('@/lib/financial-data-hub/services/transactionClassificationService');
    await classifyUserTransactions(A);
    const before = JSON.stringify(txns());
    h.writesByTable['update:fdh_transactions'] = 0;
    await classifyUserTransactions(A);
    expect(JSON.stringify(txns())).toBe(before);
    expect(h.writesByTable['update:fdh_transactions']).toBe(0);
  });
});
