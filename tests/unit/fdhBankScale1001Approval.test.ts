/**
 * WP-08 (EXP-G8): a 1,001-line bank statement through approve-all, the
 * review summary and reopen -- against an in-memory database that enforces
 * PostgREST's REAL limits: every SELECT is silently capped at 1,000 rows
 * (`db-max-rows`), and a GET whose `.in()` list is too long fails like an
 * over-long URL (1,000 UUIDs is ~37 KB of query string; the cap here is 150
 * ids, above the 100-id chunks the fixed code uses).
 *
 * Before WP-08: the approval read stopped at row 1,000, so line 1,001 was
 * never approved while the statement was; the summary covered 1,000 lines;
 * reopen reverted 1,000; the allocation read put all 1,000 ids in one .in().
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- assertions read raw JSON route payloads */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, type FakeDb } from '../support/fdhFakeSupabase';

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb, user: null as { id: string } | null }));

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.db.sessionClient(h.user!.id) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.db.adminClient() }));
vi.mock('@/lib/financial-data-hub/services/purge', () => ({ scheduleApprovedDocumentPurge: vi.fn(async () => undefined) }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requireCountryConfirmedUser: async () =>
    h.user ? { user: h.user } : { user: null, unauthenticated: Response.json({ error: 'unauthenticated' }, { status: 401 }) },
}));

vi.setConfig({ testTimeout: 60000 });

const A = 'a0000000-0000-4000-8000-00000000000a';
const ACC = 'e0000000-0000-4000-8000-0000000000a1';
const BIG = 'd0000000-0000-4000-8000-0000000000bb';
const FOOD = 'c0000000-0000-4000-8000-000000000003';
const N = 1001;
const idOf = (i: number) => `f8000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const LAST = idOf(N);

function seed(db: FakeDb) {
  db.insert('fdh_categories', { id: FOOD, category_key: 'food', display_name: 'Food & Dining', economic_type: 'expense', active: true });
  db.insert('fdh_financial_accounts', { id: ACC, user_id: A, account_type: 'transaction', currency_code: 'AUD', display_name: 'Everyday', active: true });
  db.insert('fdh_statement_uploads', {
    id: BIG, user_id: A, household_id: null, financial_account_id: ACC, source_type: 'csv', currency_code: 'AUD',
    statement_period_start: '2026-07-01', statement_period_end: '2026-07-31', processing_status: 'review_required',
    approved_by: null, approved_at: null, approval_version: 0,
  });
  for (let i = 1; i <= N; i += 1) {
    db.insert('fdh_transactions', {
      id: idOf(i), user_id: A, financial_account_id: ACC, statement_upload_id: BIG,
      transaction_date: `2026-07-${String(1 + (i % 28)).padStart(2, '0')}`, description_clean: `SHOP ${i}`, merchant_raw: null,
      amount_original: 1, currency_original: 'AUD', credit_debit: 'debit', economic_transaction_type: 'expense', category_id: FOOD,
      subcategory_id: null, merchant_id: null, classification_method: 'merchant_master', classification_confidence: 1, user_override: false,
      review_status: 'not_required', approval_status: 'pending', approved_at: null, approved_by: null, dedup_status: 'unique',
    });
  }
}

const approvedCount = () => h.db.rows('fdh_transactions').filter((r) => r.statement_upload_id === BIG && r.approval_status === 'approved').length;

async function call(mod: string, method: 'GET' | 'POST', params: Record<string, string>, body?: unknown): Promise<{ status: number; json: any }> {
  const route = await import(mod);
  const req = new Request('http://local/x', { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const res: Response = await route[method](req, { params: Promise.resolve(params) });
  return { status: res.status, json: await res.json() };
}

describe('1,001-line statement under the real PostgREST limits', () => {
  beforeEach(() => {
    h.db = createFakeDb({ maxRows: 1000, maxInListLength: 150 });
    h.user = { id: A };
    seed(h.db);
  });

  it('anti-vacuity: the fake really caps an unpaged read at 1,000 and refuses a 1,000-id .in()', async () => {
    const client = h.db.sessionClient(A);
    const { data } = await client.from('fdh_transactions').select('*').eq('user_id', A).eq('statement_upload_id', BIG);
    expect((data as unknown[]).length).toBe(1000);
    const { error } = await client.from('fdh_transaction_allocations').select('*').in('transaction_id', Array.from({ length: 1000 }, (_, i) => idOf(i + 1)));
    expect(error?.message).toMatch(/URI Too Long/);
  });

  it('approve-all approves all 1,001 lines -- line 1,001 included -- in 3 set-based calls, and the summary covers 1,001', async () => {
    const res = await call('@/app/api/financial-data-hub/documents/[documentId]/category-review/approve-all/route', 'POST', { documentId: BIG });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ outcome: 'approved', approved: N });
    expect(approvedCount()).toBe(N);
    expect(h.db.rows('fdh_transactions').find((r) => r.id === LAST)!.approval_status).toBe('approved');
    expect(h.db.rpcCalls.fdh7_bulk_approve_transactions).toBe(3); // 500 + 500 + 1, not ~3,000 per-row requests
    const stmt = h.db.rows('fdh_statement_uploads').find((s) => s.id === BIG)!;
    expect(stmt.approved_by).toBe(A);
    const summary = h.db.rows('fdh_approved_financial_summaries').find((s) => s.statement_upload_id === BIG)!;
    expect(summary).toMatchObject({ approved_transaction_count: N, unresolved_transaction_count: 0, expense_total: N });
    // One audit row per approved line, still written (in batches).
    expect(h.db.rows('fdh_document_audit_events').filter((e) => e.event_type === 'transaction_approved').length).toBe(N);
  });

  it('the review summary counts all 1,001 lines', async () => {
    const res = await call('@/app/api/financial-data-hub/documents/[documentId]/review-summary/route', 'GET', { documentId: BIG });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ transactions_found: N, debits: N, transactions_approved: 0 });
  });

  it('the category review covers all 1,001 lines', async () => {
    const res = await call('@/app/api/financial-data-hub/documents/[documentId]/category-review/route', 'GET', { documentId: BIG });
    expect(res.json.data.counts).toMatchObject({ transactions: N, waiting_for_approval: N });
    expect(res.json.data.groups[0]).toMatchObject({ count: N, total: N });
  });

  it('reopen reverts all 1,001 lines in one set-based update', async () => {
    const { approveStatement, reopenStatement } = await import('@/lib/financial-data-hub/services/approvalService');
    await approveStatement(A, BIG);
    expect(approvedCount()).toBe(N);
    await reopenStatement(A, BIG, 'correcting a line');
    expect(approvedCount()).toBe(0);
    expect(h.db.rows('fdh_transactions').filter((r) => r.statement_upload_id === BIG).every((r) => r.approved_at === null && r.approved_by === null)).toBe(true);
    const audit = h.db.rows('fdh_document_audit_events').find((e) => e.event_type === 'statement_reopened')!;
    expect((audit.metadata as { reverted_transaction_count: number }).reverted_transaction_count).toBe(N);
  });

  it('before 0212 is applied (deploy window) the per-row fallback still approves all 1,001', async () => {
    h.db = createFakeDb({ maxRows: 1000, maxInListLength: 150, rpcs: 'without_0212' });
    seed(h.db);
    const { approveStatement } = await import('@/lib/financial-data-hub/services/approvalService');
    await approveStatement(A, BIG);
    expect(approvedCount()).toBe(N);
    expect(h.db.rpcCalls.fdh7_bulk_approve_transactions).toBe(1); // tried once, fell back
  });
});
