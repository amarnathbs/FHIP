/**
 * WP-08 (Approved Upload -> Canonical programme): bank statement pipeline and
 * approval integrity. Route- and service-level proof against the in-memory
 * database in tests/support/fdhFakeSupabase.ts (RLS, the R7/R8 field trigger,
 * the FDH-7 approval guard, and -- mirrored from migration 0212 -- the
 * set-based approve, the atomic split replace and the allocation guard).
 * The SQL itself is proven by scripts/fdh_0212_pglite_verification.mjs.
 *
 * Every describe block names the gap it closes. Each was run against the base
 * branch's implementation files (feature/canonical-upload-foundation, f79374f)
 * as a negative control; see the WP-08 report for the exact failures.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- assertions read raw JSON route payloads */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, type FakeDb } from '../support/fdhFakeSupabase';

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb, user: null as { id: string } | null }));

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.db.sessionClient(h.user!.id) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.db.adminClient() }));
vi.mock('@/lib/financial-data-hub/services/purge', () => ({ scheduleApprovedDocumentPurge: vi.fn(async () => undefined) }));
vi.mock('@/lib/financial-data-hub/services/uploadLifecycle', () => ({
  FdhUploadLifecycleError: class extends Error { constructor(readonly code: string, message: string) { super(message); } },
  createUploadSession: vi.fn(async () => ({ session: { id: 'd9000000-0000-4000-8000-000000000001' } })),
  completeUpload: vi.fn(async () => {
    const row = h.db.insert('fdh_statement_uploads', {
      id: 'd9000000-0000-4000-8000-000000000001', user_id: h.user!.id, household_id: null, processing_status: 'queued',
      source_type: 'csv', currency_code: 'AUD', financial_account_id: null,
    });
    return { ...row };
  }),
}));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requireCountryConfirmedUser: async () =>
    h.user ? { user: h.user } : { user: null, unauthenticated: Response.json({ error: 'unauthenticated' }, { status: 401 }) },
}));

vi.setConfig({ testTimeout: 30000 });

const REPO = path.resolve(__dirname, '..', '..');
const A = 'a0000000-0000-4000-8000-00000000000a';
const B = 'b0000000-0000-4000-8000-00000000000b';
const ACC = 'e0000000-0000-4000-8000-0000000000a1';
const ACC_B = 'e0000000-0000-4000-8000-0000000000b1';
const UP1 = 'd0000000-0000-4000-8000-000000000001';
const UP2 = 'd0000000-0000-4000-8000-000000000002';
const CAT = {
  food: 'c0000000-0000-4000-8000-000000000003',
  utilities: 'c0000000-0000-4000-8000-000000000004',
  transfer: 'c0000000-0000-4000-8000-000000000005',
  refund: 'c0000000-0000-4000-8000-00000000000a',
};

function seedCategories(db: FakeDb) {
  for (const [id, key, name, type] of [
    [CAT.food, 'food', 'Food & Dining', 'expense'],
    [CAT.utilities, 'utilities', 'Utilities', 'expense'],
    [CAT.transfer, 'transfer_own_account', 'Own-Account Transfer', 'transfer'],
    [CAT.refund, 'refund_reversal', 'Refund / Reversal', 'refund'],
  ]) db.insert('fdh_categories', { id, category_key: key, display_name: name, economic_type: type, active: true });
}

function seedStatement(db: FakeDb, id: string, userId = A, accountId = ACC, extra: Record<string, unknown> = {}) {
  db.insert('fdh_statement_uploads', {
    id, user_id: userId, household_id: null, financial_account_id: accountId, source_type: 'csv', currency_code: 'AUD',
    original_filename_sanitised: `${id}.csv`, statement_period_start: '2026-08-01', statement_period_end: '2026-08-31',
    processing_status: 'review_required', approved_by: null, approved_at: null, approval_version: 0, ...extra,
  });
}

function txn(id: string, over: Record<string, unknown>) {
  return {
    id, user_id: A, financial_account_id: ACC, statement_upload_id: UP2, transaction_date: '2026-08-10',
    description_clean: 'Line', description_raw: 'Line', merchant_raw: null, amount_original: 10, currency_original: 'AUD',
    credit_debit: 'debit', transaction_type_hint: 'debit', source_reference: null, economic_transaction_type: 'expense',
    category_id: CAT.food, subcategory_id: null, merchant_id: null, classification_method: 'merchant_master',
    classification_confidence: 1, user_override: false, review_status: 'not_required', approval_status: 'pending',
    approved_at: null, approved_by: null, dedup_status: 'unique', recurring_transaction_id: null, recurring_flag: false,
    subscription_flag: false, transfer_flag: false, posting_date: null, value_date: null, balance_after: null, source_row: 1,
    ...over,
  };
}

const row = (id: string) => h.db.rows('fdh_transactions').find((r) => r.id === id)!;

async function call(mod: string, method: 'GET' | 'POST', opts: { params?: Record<string, string>; body?: unknown; query?: string } = {}): Promise<{ status: number; json: any }> {
  const route = await import(mod);
  const req = new Request(`http://local/x${opts.query ?? ''}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const res: Response = await route[method](req, { params: Promise.resolve(opts.params ?? {}) });
  return { status: res.status, json: await res.json() };
}

beforeEach(() => {
  h.db = createFakeDb();
  h.user = { id: A };
  seedCategories(h.db);
  h.db.insert('fdh_financial_accounts', { id: ACC, user_id: A, institution_id: null, account_type: 'transaction', currency_code: 'AUD', display_name: 'Imported account', masked_identifier: null, active: true });
  h.db.insert('fdh_financial_accounts', { id: ACC_B, user_id: B, institution_id: null, account_type: 'transaction', currency_code: 'AUD', display_name: 'B', active: true });
});

// ---------------------------------------------------------------------------
// EXP-G4: the same statement uploaded twice, the overlap resolved removed_b.
// ---------------------------------------------------------------------------
const G1 = 'f0000000-0000-4000-8000-000000000001';
const G2 = 'f0000000-0000-4000-8000-000000000002';
const N2 = 'f0000000-0000-4000-8000-000000000003';
const U2 = 'f0000000-0000-4000-8000-000000000004';

function seedTwice(db: FakeDb) {
  seedStatement(db, UP1, A, ACC, { processing_status: 'approved', approved_by: A, approved_at: '2026-09-01T00:00:00Z', approval_version: 1 });
  seedStatement(db, UP2);
  // First upload: groceries $200, approved.
  db.insert('fdh_transactions', txn(G1, { statement_upload_id: UP1, amount_original: 200, description_clean: 'WOOLWORTHS 1234', approval_status: 'approved', approved_by: A, approved_at: '2026-09-01T00:00:00Z', dedup_status: 'user_confirmed_distinct' }));
  // Second upload of the same statement: the copy (removed_b -> side b is the
  // excluded duplicate) classified like its twin, a genuinely new line, and
  // a second excluded copy that R8 could not classify.
  db.insert('fdh_transactions', txn(G2, { amount_original: 200, description_clean: 'WOOLWORTHS 1234', dedup_status: 'user_confirmed_duplicate' }));
  db.insert('fdh_transactions', txn(N2, { amount_original: 42.5, description_clean: 'COLES 88', transaction_date: '2026-08-20' }));
  db.insert('fdh_transactions', txn(U2, { amount_original: 19.99, economic_transaction_type: 'unknown', category_id: null, classification_method: 'unclassified', classification_confidence: null, dedup_status: 'user_confirmed_duplicate', review_status: 'pending' }));
  db.insert('fdh_duplicate_candidates', { user_id: A, transaction_id_a: G1, transaction_id_b: G2, match_method: 'fuzzy_amount_date', confidence: 0.9, status: 'confirmed_duplicate', user_resolution: 'removed_b' });
}

describe('EXP-G4 duplicate chain: same statement twice, overlap resolved removed_b', () => {
  it('the approval cascade never approves an excluded duplicate: groceries count exactly 1x, and the statement finalises', async () => {
    seedTwice(h.db);
    const { approveStatement } = await import('@/lib/financial-data-hub/services/approvalService');
    const { statement } = await approveStatement(A, UP2);

    expect(row(G2).approval_status).toBe('pending');
    expect(row(U2).approval_status).toBe('pending');
    expect(row(N2).approval_status).toBe('approved');
    expect(statement.approved_by).toBe(A);
    // The legacy Dashboard reading had no dedup filter: every approved row counted.
    const approvedGroceries = h.db.rows('fdh_transactions').filter((r) => r.approval_status === 'approved' && r.description_clean === 'WOOLWORTHS 1234').reduce((s, r) => s + Number(r.amount_original), 0);
    expect(approvedGroceries).toBe(200);
    const summary = h.db.rows('fdh_approved_financial_summaries').find((s) => s.statement_upload_id === UP2)!;
    expect(summary).toMatchObject({ approved_transaction_count: 1, unresolved_transaction_count: 0, expense_total: 42.5 });
  });

  it('ORACLE: 1x in Activity (ACT) and 1x in the canonical read model', async () => {
    seedTwice(h.db);
    const { approveStatement } = await import('@/lib/financial-data-hub/services/approvalService');
    await approveStatement(A, UP2);
    const { getOverview } = await import('@/lib/financial-data-hub/analytics/financialActivityAnalytics');
    const overview = await getOverview(A, { period: { from: '2026-08-01', to: '2026-08-31' } });
    expect(overview.approved[0]).toMatchObject({ currency_code: 'AUD', expense_total: 242.5, duplicate_excluded_count: 0 });

    const { loadApprovedLedger, normaliseLedger } = await import('@/lib/read-models/core/ledger');
    const { fxContext } = await import('@/lib/read-models/core/currency');
    const { explicitWindow } = await import('@/lib/read-models/core/window');
    const window = explicitWindow('2026-08-01', '2026-08-31');
    const ledger = normaliseLedger(await loadApprovedLedger(A, h.db.sessionClient(A), window), fxContext('AUD', 56), window);
    const groceries = ledger.lines.filter((l) => l.bucket === 'spending' && l.amountNative === 200);
    expect(groceries).toHaveLength(1);
    expect(ledger.lines.filter((l) => l.bucket === 'spending').reduce((s, l) => s + l.amountNative, 0)).toBe(242.5);
  });

  it('the category-review approve-all finalises the statement and reports the removed duplicates', async () => {
    seedTwice(h.db);
    const review = await call('@/app/api/financial-data-hub/documents/[documentId]/category-review/route', 'GET', { params: { documentId: UP2 } });
    expect(review.json.data.counts).toMatchObject({ duplicates_removed: 2, needs_decision: 0, waiting_for_approval: 1 });
    const all = await call('@/app/api/financial-data-hub/documents/[documentId]/category-review/approve-all/route', 'POST', { params: { documentId: UP2 } });
    expect(all.status).toBe(200);
    expect(h.db.rows('fdh_statement_uploads').find((s) => s.id === UP2)!.approved_by).toBe(A);
    expect(row(G2).approval_status).toBe('pending');
  });

  it('approving a removed duplicate on its own is refused (409), never silently approved', async () => {
    seedTwice(h.db);
    const res = await call('@/app/api/financial-data-hub/bank-transactions/[transactionId]/approve/route', 'POST', { params: { transactionId: G2 } });
    expect(res.status).toBe(409);
    expect(row(G2).approval_status).toBe('pending');
  });

  it('R8 classification never classifies a removed duplicate, and never re-classifies an approved line', async () => {
    seedStatement(h.db, UP2);
    const W1 = 'f0000000-0000-4000-8000-000000000011';
    const W2 = 'f0000000-0000-4000-8000-000000000012';
    const W3 = 'f0000000-0000-4000-8000-000000000013';
    const unknown = { economic_transaction_type: 'unknown', category_id: null, classification_method: 'unclassified', classification_confidence: null, review_status: 'pending' };
    h.db.insert('fdh_transactions', txn(W1, { ...unknown, description_clean: 'WOOLWORTHS 1234' }));
    h.db.insert('fdh_transactions', txn(W2, { ...unknown, description_clean: 'WOOLWORTHS 1234', dedup_status: 'user_confirmed_duplicate' }));
    h.db.insert('fdh_transactions', txn(W3, { description_clean: 'WOOLWORTHS 99', category_id: CAT.utilities, approval_status: 'approved', approved_by: A, approved_at: '2026-09-01T00:00:00Z' }));
    h.db.insert('fdh_user_classification_rules', {
      user_id: A, rule_type: 'description_contains', priority: 100, active: true,
      match_definition: { match_kind: 'description_contains', needle_normalised: 'WOOLWORTHS' },
      action_definition: { action_kind: 'classify', category_id: CAT.food, economic_transaction_type: 'expense' },
    });
    const { classifyUserTransactions } = await import('@/lib/financial-data-hub/services/transactionClassificationService');
    await classifyUserTransactions(A);
    expect(row(W1)).toMatchObject({ economic_transaction_type: 'expense', category_id: CAT.food }); // the engine really ran
    expect(row(W2)).toMatchObject({ economic_transaction_type: 'unknown', category_id: null });
    expect(row(W3)).toMatchObject({ economic_transaction_type: 'expense', category_id: CAT.utilities });
  });

  it('a resolution that would EXCLUDE an approved line is refused (409); the new copy is still removable', async () => {
    seedStatement(h.db, UP1, A, ACC, { processing_status: 'approved', approved_by: A, approved_at: '2026-09-01T00:00:00Z', approval_version: 1 });
    seedStatement(h.db, UP2);
    h.db.insert('fdh_transactions', txn(G1, { statement_upload_id: UP1, amount_original: 200, approval_status: 'approved', approved_by: A, approved_at: '2026-09-01T00:00:00Z' }));
    h.db.insert('fdh_transactions', txn(G2, { amount_original: 200 }));
    const cand = h.db.insert('fdh_duplicate_candidates', { user_id: A, transaction_id_a: G1, transaction_id_b: G2, match_method: 'fuzzy_amount_date', confidence: 0.9, status: 'pending' });
    const route = '@/app/api/financial-data-hub/bank-transactions/[transactionId]/duplicate-resolution/route';
    const refused = await call(route, 'POST', { params: { transactionId: G2 }, body: { duplicate_candidate_id: cand.id, resolution: 'removed_a' } });
    expect(refused.status).toBe(409);
    expect(row(G1).dedup_status).toBe('unique');
    const ok = await call(route, 'POST', { params: { transactionId: G2 }, body: { duplicate_candidate_id: cand.id, resolution: 'removed_b' } });
    expect(ok.status).toBe(200);
    expect(row(G2).dedup_status).toBe('user_confirmed_duplicate');
  });
});

// ---------------------------------------------------------------------------
// EXP-G12: an approved line cannot be corrected without reopening.
// ---------------------------------------------------------------------------
describe('EXP-G12 approved-row correction', () => {
  const CORRECTION = '@/app/api/financial-data-hub/bank-transactions/[transactionId]/correction/route';
  it('an approved-row correction gets 409 and changes nothing; a pending row is still correctable', async () => {
    seedStatement(h.db, UP2);
    const T = 'f0000000-0000-4000-8000-000000000021';
    const P = 'f0000000-0000-4000-8000-000000000022';
    h.db.insert('fdh_transactions', txn(T, { amount_original: 55, approval_status: 'approved', approved_by: A, approved_at: '2026-09-01T00:00:00Z' }));
    h.db.insert('fdh_transactions', txn(P, { amount_original: 55 }));
    for (const [field, value] of [['amount_original', 555], ['economic_transaction_type', 'income'], ['transaction_date', '2026-01-01']] as const) {
      const res = await call(CORRECTION, 'POST', { params: { transactionId: T }, body: { field_name: field, corrected_value: value } });
      expect(res.status, field).toBe(409);
      expect(res.json.error).toMatch(/Reopen its statement/);
    }
    expect(row(T)).toMatchObject({ amount_original: 55, economic_transaction_type: 'expense', transaction_date: '2026-08-10' });
    expect(h.db.rows('fdh_transaction_corrections').filter((c) => c.transaction_id === T)).toHaveLength(0);
    const ok = await call(CORRECTION, 'POST', { params: { transactionId: P }, body: { field_name: 'amount_original', corrected_value: 56 } });
    expect(ok.status).toBe(200);
    expect(row(P).amount_original).toBe(56);
  });
});

// ---------------------------------------------------------------------------
// EXP-G5: splits.
// ---------------------------------------------------------------------------
describe('EXP-G5 split replace', () => {
  const SPLIT = '@/app/api/financial-data-hub/bank-transactions/[transactionId]/split/route';
  const S = 'f0000000-0000-4000-8000-000000000031';
  const allocs = () => h.db.rows('fdh_transaction_allocations').filter((a) => a.transaction_id === S).sort((a, b) => Number(a.allocation_sequence) - Number(b.allocation_sequence));
  const split = (lines: Array<[string, number]>) => call(SPLIT, 'POST', { params: { transactionId: S }, body: { finalize: true, allocations: lines.map(([t, amount]) => ({ economic_transaction_type: t, amount })) } });

  beforeEach(() => {
    seedStatement(h.db, UP2);
    h.db.insert('fdh_transactions', txn(S, { amount_original: 100, economic_transaction_type: 'unknown', category_id: null }));
  });

  it('a reconciled split is saved as one set; a second save REPLACES it', async () => {
    expect((await split([['expense', 80], ['transfer', 20]])).status).toBe(200);
    expect(allocs().map((a) => [a.economic_transaction_type, a.amount])).toEqual([['expense', 80], ['transfer', 20]]);
    expect((await split([['expense', 100]])).status).toBe(200);
    expect(allocs().map((a) => [a.economic_transaction_type, a.amount])).toEqual([['expense', 100]]);
  });

  it("an 'unknown' split line is refused (422) and nothing is written", async () => {
    const res = await split([['expense', 80], ['unknown', 20]]);
    expect(res.status).toBe(422);
    expect(allocs()).toHaveLength(0);
  });

  it('an APPROVED transaction cannot be re-split until its statement is reopened (409)', async () => {
    await split([['expense', 80], ['transfer', 20]]);
    Object.assign(row(S), { approval_status: 'approved', approved_by: A, approved_at: '2026-09-01T00:00:00Z' });
    const res = await split([['expense', 100]]);
    expect(res.status).toBe(409);
    expect(allocs().map((a) => a.amount)).toEqual([80, 20]);
  });

  it('concurrent split replace is atomic: two interleaved saves leave exactly ONE complete set', async () => {
    const [r1, r2] = await Promise.all([split([['expense', 80], ['transfer', 20]]), split([['expense', 50], ['fee', 30], ['transfer', 20]])]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    const set = allocs().map((a) => [a.economic_transaction_type, a.amount]);
    expect([JSON.stringify([['expense', 80], ['transfer', 20]]), JSON.stringify([['expense', 50], ['fee', 30], ['transfer', 20]])]).toContain(JSON.stringify(set));
    expect(allocs().reduce((s, a) => s + Number(a.amount), 0)).toBe(100);
  });

  it('negative control for the test above: the pre-0212 request sequence DOES interleave into a mixed set', async () => {
    h.db = createFakeDb({ rpcs: 'without_0212' });
    seedCategories(h.db);
    seedStatement(h.db, UP2);
    h.db.insert('fdh_transactions', txn(S, { amount_original: 100, economic_transaction_type: 'unknown', category_id: null }));
    await Promise.all([split([['expense', 80], ['transfer', 20]]), split([['expense', 50], ['fee', 30], ['transfer', 20]])]);
    expect(allocs().reduce((s, a) => s + Number(a.amount), 0)).not.toBe(100);
  });

  it('a direct allocation write onto an approved line is refused by the 0212 guard (mirrored)', async () => {
    Object.assign(row(S), { approval_status: 'approved', approved_by: A, approved_at: '2026-09-01T00:00:00Z' });
    const { error } = await h.db.sessionClient(A).from('fdh_transaction_allocations').insert({ user_id: A, transaction_id: S, allocation_sequence: 1, economic_transaction_type: 'expense', amount: 100, currency_code: 'AUD' });
    expect(error?.message).toMatch(/approved; reopen its statement/);
  });
});

// ---------------------------------------------------------------------------
// EXP-G14: CSV currency column; unread lines with reasons.
// ---------------------------------------------------------------------------
describe('EXP-G14 CSV currency column and unread lines', () => {
  const csv = [
    'Date,Description,Amount,Currency',
    '01/08/2026,Woolworths,-200.00,AUD',
    '02/08/2026,Amazon US,-50.00,USD',
    '03/08/2026,Coles,-30.00,',
    '04/08/2026,Bad line,,AUD',
  ].join('\n');

  it('a mapped currency column is HONOURED as a check: a line in another currency is rejected with a visible reason, never added', async () => {
    const { mappingToRowFormat } = await import('@/lib/financial-data-hub/bank-csv/normalize');
    const { runBankCsvPipeline } = await import('@/lib/financial-data-hub/bank-csv/orchestrator');
    const { summariseUnreadLines, describeUnreadLines } = await import('@/lib/financial-data-hub/domain/unreadLines');
    const rowFormat = mappingToRowFormat({ transaction_date: 'Date', description: 'Description', amount: 'Amount', currency: 'Currency' }, 'single_signed', 'DD/MM/YYYY');
    expect(rowFormat.columnRoles.currency).toBe('Currency');
    const pipeline = runBankCsvPipeline({
      bytes: new TextEncoder().encode(csv), statementUploadId: UP2, financialAccountId: ACC, currencyCode: 'AUD', rowFormatOverride: rowFormat, dedupIndex: new Map(),
    });
    expect(pipeline.accepted.map((a) => a.descriptionClean)).toEqual(['Woolworths', 'Coles']);
    expect(pipeline.rejected).toEqual([{ sourceRowNumber: 2, reason: 'currency_mismatch' }, { sourceRowNumber: 4, reason: 'missing_amount' }]);
    const text = describeUnreadLines(summariseUnreadLines(pipeline.rejected));
    expect(text).toBe('2 lines could not be read: 1 had a different currency from the statement; 1 had no amount. They are not included. Add them by hand if they are real transactions.');
  });

  it('the unread-lines summary round-trips through the persisted data-quality detail', async () => {
    const { encodeUnreadLines, decodeUnreadLines, summariseUnreadLines } = await import('@/lib/financial-data-hub/domain/unreadLines');
    const s = summariseUnreadLines([{ reason: 'invalid_amount' }, { reason: 'invalid_amount' }, { reason: 'zero_amount' }], 2);
    expect(decodeUnreadLines(`declared=10 parsed=5 ${encodeUnreadLines(s)}`)).toEqual(s);
    expect(s.count).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// EXP-G14 / EXP-G15 / EXP-G17 through the one canonical PDF write.
// ---------------------------------------------------------------------------
describe('PDF / AI statement: period, masked identifier, AI evidence, incomplete extraction, overlap', () => {
  const DOC = 'd0000000-0000-4000-8000-0000000000f1';
  async function persist(rows: number, aiContext: Record<string, unknown> | undefined, opts: { masked?: string | null; prior?: Map<string, { start: string; end: string }> } = {}) {
    h.db.insert('fdh_statement_uploads', {
      id: DOC, user_id: A, household_id: null, financial_account_id: ACC, source_type: 'pdf_native', currency_code: 'AUD',
      statement_period_start: null, statement_period_end: null, processing_status: 'processing', approved_by: null, approval_version: 0,
      original_filename_sanitised: 'statement.pdf',
    });
    const { runBankPdfPipelineFromReadRows } = await import('@/lib/financial-data-hub/bank-pdf/orchestrator');
    const { persistBankPdfPipelineResult } = await import('@/lib/financial-data-hub/services/bankPdfProcessingService');
    const pipeline = runBankPdfPipelineFromReadRows({
      statementUploadId: DOC, financialAccountId: ACC, currencyCode: 'AUD', dedupIndex: new Map(),
      rows: Array.from({ length: rows }, (_, i) => ({ sourceRowNumber: i + 1, transactionDate: `2026-07-${String(1 + (i % 28)).padStart(2, '0')}`, descriptionRaw: `SHOP ${i}`, amountOriginal: 10 + i, creditDebit: 'debit' as const, balanceAfter: null })),
      statementMetadata: { declaredOpeningBalance: null, declaredClosingBalance: null, maskedAccountIdentifier: opts.masked ?? null, statementPeriodStart: '2026-07-01', statementPeriodEnd: '2026-07-31' },
      pageCount: 2, parserVersion: 'test',
    });
    const document = { ...h.db.rows('fdh_statement_uploads').find((s) => s.id === DOC)! } as never;
    return persistBankPdfPipelineResult({ userId: A, documentId: DOC, document, pipeline, priorRanges: opts.prior ?? new Map(), aiContext: aiContext as never });
  }
  const items = () => h.db.rows('fdh_review_items').filter((r) => r.statement_upload_id === DOC);
  const doc = () => h.db.rows('fdh_statement_uploads').find((s) => s.id === DOC)!;

  it('persists the printed statement period (the read models\' coverage input)', async () => {
    await persist(3, undefined);
    expect(doc()).toMatchObject({ statement_period_start: '2026-07-01', statement_period_end: '2026-07-31' });
  });

  it('an AI reading that says it did not list everything is never certified: blocking item, review_required, DQ evidence', async () => {
    const result = await persist(5, { institutionName: 'Bank of Testing', allTransactionsListed: false, warningCount: 2, rowsRead: 5 });
    expect(result.incompleteExtraction).toBe(true);
    expect(result.certificationStatus).toBe('review_required');
    expect(doc().processing_status).toBe('review_required');
    expect(items().find((i) => i.title_code === 'bank_statement.ai_extraction_incomplete')).toMatchObject({ severity: 'blocking', status: 'open' });
    const dq = h.db.rows('fdh_data_quality_results').filter((q) => q.statement_upload_id === DOC);
    expect(dq.find((q) => q.check_code === 'low_extraction_confidence')).toMatchObject({ status: 'warning', details_sanitised: 'ai_reading all_transactions_listed=false rows_read=5 row_cap=80 warnings=2' });
    expect(dq.find((q) => q.check_code === 'transaction_count_valid')!.status).toBe('fail');
    // AI institution name names the generically-named account.
    expect(h.db.rows('fdh_financial_accounts').find((a) => a.id === ACC)!.display_name).toBe('Bank of Testing');
  });

  it('an AI reading that hit the 80-row cap with nothing to reconcile against is treated as incomplete too', async () => {
    const result = await persist(80, { institutionName: null, allTransactionsListed: true, warningCount: 0, rowsRead: 80 });
    expect(result.incompleteExtraction).toBe(true);
    expect(items().some((i) => i.title_code === 'bank_statement.ai_extraction_incomplete')).toBe(true);
  });

  it('a complete AI reading is not flagged', async () => {
    const result = await persist(5, { institutionName: null, allTransactionsListed: true, warningCount: 0, rowsRead: 5 });
    expect(result.incompleteExtraction).toBe(false);
    expect(items().some((i) => i.title_code === 'bank_statement.ai_extraction_incomplete')).toBe(false);
  });

  it('the blocking item stops approval with its reason in words; the user acknowledges it; then the statement approves', async () => {
    await persist(5, { institutionName: null, allTransactionsListed: false, warningCount: 0, rowsRead: 5 });
    for (const t of h.db.rows('fdh_transactions').filter((r) => r.statement_upload_id === DOC)) {
      Object.assign(t, { economic_transaction_type: 'expense', category_id: CAT.food, classification_method: 'merchant_master', classification_confidence: 1 });
    }
    const review = await call('@/app/api/financial-data-hub/documents/[documentId]/category-review/route', 'GET', { params: { documentId: DOC } });
    const note = review.json.data.notes.find((n: any) => n.title_code === 'bank_statement.ai_extraction_incomplete');
    expect(note).toMatchObject({ severity: 'blocking', can_acknowledge: true });
    expect(note.text).toMatch(/may be missing transactions/);
    const blocked = await call('@/app/api/financial-data-hub/documents/[documentId]/category-review/approve-all/route', 'POST', { params: { documentId: DOC } });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toMatch(/may be missing transactions/);
    const ack = await call('@/app/api/financial-data-hub/documents/[documentId]/review-items/[itemId]/acknowledge/route', 'POST', { params: { documentId: DOC, itemId: note.id } });
    expect(ack.status).toBe(200);
    expect(ack.json.data).toEqual({ acknowledged: true });
    const approved = await call('@/app/api/financial-data-hub/documents/[documentId]/category-review/approve-all/route', 'POST', { params: { documentId: DOC } });
    expect(approved.status).toBe(200);
    expect(doc().approved_by).toBe(A);
  });

  it('only the incomplete-reading check can be acknowledged; another user cannot acknowledge it', async () => {
    await persist(3, undefined);
    const recon = h.db.insert('fdh_review_items', { user_id: A, statement_upload_id: DOC, transaction_id: null, review_type: 'reconciliation_failure', severity: 'blocking', status: 'open', title_code: 'bank_pdf.reconciliation_failed' });
    const ack = await call('@/app/api/financial-data-hub/documents/[documentId]/review-items/[itemId]/acknowledge/route', 'POST', { params: { documentId: DOC, itemId: String(recon.id) } });
    expect(ack.status).toBe(422);
    expect(h.db.rows('fdh_review_items').find((r) => r.id === recon.id)!.status).toBe('open');
    h.user = { id: B };
    const foreign = await call('@/app/api/financial-data-hub/documents/[documentId]/review-items/[itemId]/acknowledge/route', 'POST', { params: { documentId: DOC, itemId: String(recon.id) } });
    expect(foreign.status).toBe(404);
  });

  it('EXP-G17: a statement overlapping an earlier import gets a visible info note with the overlapping span', async () => {
    await persist(3, undefined, { prior: new Map([['old', { start: '2026-06-15', end: '2026-07-02' }]]) });
    expect(items().find((i) => i.title_code === 'bank_statement.overlaps_prior_statement')).toMatchObject({
      severity: 'info', context_json: { overlapping_statement_count: 1, overlap_from: '2026-07-01', overlap_to: '2026-07-02' },
    });
  });

  it('the printed masked identifier is used for matching: recorded on an account that had none, a mismatch is flagged', async () => {
    await persist(3, undefined, { masked: '****4321' });
    const acc = h.db.rows('fdh_financial_accounts').find((a) => a.id === ACC)!;
    expect(acc.masked_identifier).toBe('****4321');
    expect(typeof acc.account_fingerprint).toBe('string');
    h.db.tables.fdh_statement_uploads = h.db.rows('fdh_statement_uploads').filter((s) => s.id !== DOC);
    h.db.tables.fdh_transactions = [];
    h.db.tables.fdh_review_items = [];
    await persist(3, undefined, { masked: '****9999' });
    expect(items().some((i) => i.title_code === 'bank_statement.account_identifier_mismatch')).toBe(true);
    expect(h.db.rows('fdh_data_quality_results').filter((q) => q.statement_upload_id === DOC && q.check_code === 'account_identified').at(-1)).toMatchObject({ status: 'warning' });
  });

  it('statement details: posting/value date, reference, balance, reconciliation, closing balance labelled per D-04, unread lines, notes (and 404 for another user)', async () => {
    await persist(3, { institutionName: null, allTransactionsListed: false, warningCount: 0, rowsRead: 3 });
    const t = h.db.rows('fdh_transactions').find((r) => r.statement_upload_id === DOC)!;
    Object.assign(t, { posting_date: '2026-07-02', value_date: '2026-07-03', source_reference: 'REF123', balance_after: 999.5 });
    h.db.insert('fdh_reconciliation_results', { user_id: A, statement_upload_id: DOC, status: 'failed', opening_balance: 100, reported_closing_balance: 50, expected_closing_balance: 61, variance: 11, currency_code: 'AUD', created_at: '2026-09-27T00:00:00Z' });
    const dq = h.db.rows('fdh_data_quality_results').find((q) => q.statement_upload_id === DOC && q.check_code === 'transaction_count_valid')!;
    dq.details_sanitised = `${dq.details_sanitised} unread=2 invalid_amount=2`.replace(/unread=0\s*/, '');
    const res = await call('@/app/api/financial-data-hub/documents/[documentId]/statement-details/route', 'GET', { params: { documentId: DOC } });
    expect(res.status).toBe(200);
    const d = res.json.data;
    expect(d.statement).toMatchObject({ id: DOC, period_start: '2026-07-01', period_end: '2026-07-31', approved: false, account: { id: ACC } });
    expect(d.reconciliation).toEqual({ status: 'failed', opening_balance: 100, closing_balance: 50, expected_closing_balance: 61, variance: 11, currency: 'AUD' });
    expect(d.closing_balance_label).toMatch(/not in your Net Worth unless you add it as a cash asset/);
    expect(d.unread_lines_text).toMatch(/2 lines could not be read: 2 had an amount we could not read/);
    expect(d.notes.some((n: any) => n.title_code === 'bank_statement.ai_extraction_incomplete')).toBe(true);
    expect(d.lines.total).toBe(3);
    expect(d.lines.rows.find((r: any) => r.id === t.id)).toMatchObject({ posting_date: '2026-07-02', value_date: '2026-07-03', reference: 'REF123', balance_after: 999.5 });
    // The drawer reads exactly these keys (snake_case contract).
    const drawer = fs.readFileSync(path.join(REPO, 'components/financial-data-hub/StatementDetailsDrawer.tsx'), 'utf8');
    for (const key of ['posting_date', 'value_date', 'reference', 'balance_after', 'closing_balance_label', 'unread_lines_text', 'opening_balance', 'closing_balance']) expect(drawer).toContain(key);
    h.user = { id: B };
    expect((await call('@/app/api/financial-data-hub/documents/[documentId]/statement-details/route', 'GET', { params: { documentId: DOC } })).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// EXP-G18, D-01 and the review copy (EXP-G3 copy).
// ---------------------------------------------------------------------------
describe('Approved Financial Summary labels, the D-01 refund rule and month copy', () => {
  it('EXP-G18: category_aggregates carry the category display name, not its UUID', async () => {
    seedStatement(h.db, UP2);
    h.db.insert('fdh_transactions', txn('f0000000-0000-4000-8000-000000000041', { amount_original: 12 }));
    const { approveStatement } = await import('@/lib/financial-data-hub/services/approvalService');
    await approveStatement(A, UP2);
    const summary = h.db.rows('fdh_approved_financial_summaries').find((s) => s.statement_upload_id === UP2)!;
    expect(summary.category_aggregates).toEqual({ [CAT.food]: { label: 'Food & Dining', total: 12 } });
  });

  it('D-01 in the review: only a refund with a CONFIRMED link reduces spending; month figures name the month', async () => {
    seedStatement(h.db, UP2);
    const P = 'f0000000-0000-4000-8000-000000000051';
    const R1 = 'f0000000-0000-4000-8000-000000000052';
    const R2 = 'f0000000-0000-4000-8000-000000000053';
    h.db.insert('fdh_transactions', txn(P, { amount_original: 100 }));
    h.db.insert('fdh_transactions', txn(R1, { amount_original: 20, economic_transaction_type: 'refund', category_id: CAT.refund, credit_debit: 'credit' }));
    h.db.insert('fdh_transactions', txn(R2, { amount_original: 5, economic_transaction_type: 'refund', category_id: CAT.refund, credit_debit: 'credit', transaction_date: '2026-09-02' }));
    h.db.insert('fdh_transaction_links', { user_id: A, transaction_id_from: R1, transaction_id_to: P, link_type: 'refund_original', status: 'confirmed' });
    const review = await call('@/app/api/financial-data-hub/documents/[documentId]/category-review/route', 'GET', { params: { documentId: UP2 } });
    const d = review.json.data;
    expect(d.groups.find((g: any) => g.counts_toward === 'reduces_spending')).toMatchObject({ total: 20, count: 1 });
    expect(d.groups.find((g: any) => g.counts_toward === 'refund_unlinked')).toMatchObject({ total: 5, count: 1 });
    expect(d.totals).toEqual([{ currency: 'AUD', waiting_income: 0, waiting_spending: 80, approved_income: 0, approved_spending: 0 }]);
    expect(d.months).toEqual([
      { month: '2026-08', currency: 'AUD', waiting_income: 0, waiting_spending: 80, approved_income: 0, approved_spending: 0 },
      // The unlinked September refund is listed but moves nothing (D-01).
      { month: '2026-09', currency: 'AUD', waiting_income: 0, waiting_spending: 0, approved_income: 0, approved_spending: 0 },
    ]);
    const page = fs.readFileSync(path.join(REPO, 'app/(app)/financial-data-hub/review/StatementCategoryReview.tsx'), 'utf8');
    expect(page).not.toMatch(/dated in the current month/);
    expect(page).toMatch(/last 3 complete months/);
  });
});

// ---------------------------------------------------------------------------
// EXP-G13 capture (D-10): owner attribution at upload.
// ---------------------------------------------------------------------------
describe('EXP-G13 owner attribution captured at upload (D-10)', () => {
  it('the upload metadata accepts self/spouse/joint/smsf and nothing else', async () => {
    const { bankCsvUploadMetadataSchema } = await import('@/lib/financial-data-hub/validation/bankCsv');
    const base = { country_code: 'AU', currency_code: 'AUD' };
    for (const owner of ['self', 'spouse', 'joint', 'smsf']) expect(bankCsvUploadMetadataSchema.safeParse({ ...base, owner_role: owner }).success).toBe(true);
    expect(bankCsvUploadMetadataSchema.safeParse({ ...base, owner_role: 'company' }).success).toBe(false);
  });

  it('an upload that creates the account records the chosen owner on it', async () => {
    h.db.tables.fdh_financial_accounts = [];
    const { uploadBankCsv } = await import('@/lib/financial-data-hub/services/bankCsvUploadService');
    const out = await uploadBankCsv(A, { country_code: 'AU', currency_code: 'AUD', owner_role: 'smsf', declared_masked_identifier: '1234' } as never, new Uint8Array([1]));
    expect(out.accountResolution).toBe('created');
    expect(out.ownerRole).toBe('recorded');
    expect(h.db.rows('fdh_financial_accounts').find((a) => a.id === out.document.financial_account_id)!.owner_role).toBe('smsf');
  });

  it('a database without migration 0207 (no owner_role column) never fails the upload', async () => {
    const repos = await import('@/lib/financial-data-hub/repositories');
    const spy = vi.spyOn(repos.financialAccountsRepository, 'update').mockResolvedValueOnce({ data: null, error: { message: "Could not find the 'owner_role' column of 'fdh_financial_accounts' in the schema cache" } } as never);
    const { recordAccountOwner } = await import('@/lib/financial-data-hub/services/accountOwner');
    expect(await recordAccountOwner(A, ACC, 'joint')).toBe('unavailable');
    spy.mockRestore();
    expect(await recordAccountOwner(A, ACC, 'joint')).toBe('recorded');
    expect(h.db.rows('fdh_financial_accounts').find((a) => a.id === ACC)!.owner_role).toBe('joint');
    expect(await recordAccountOwner(A, ACC, null)).toBe('not_provided');
  });

  it('the Expenses import panel asks whose account it is, with no default, and sends it', () => {
    const panel = fs.readFileSync(path.join(REPO, 'components/expenses/BankStatementImportPanel.tsx'), 'utf8');
    expect(panel).toMatch(/Whose account is this\?/);
    expect(panel).toMatch(/useState<'' \| 'self' \| 'spouse' \| 'joint' \| 'smsf'>\(''\)/);
    expect(panel).toMatch(/params\.set\('owner_role', ownerRole\)/);
    expect(panel).toMatch(/disabled=\{!file \|\| !ownerRole/);
  });
});

// ---------------------------------------------------------------------------
// UPL-03 / D-13: the generic upload page is retired.
// ---------------------------------------------------------------------------
describe('UPL-03 / D-13 generic hub upload page retired', () => {
  it('routes every supported document type to its own import tab and names the unsupported ones', async () => {
    const { importDestinationFor, NOT_SUPPORTED_FOR_IMPORT } = await import('@/app/(app)/financial-data-hub/importDestinations');
    expect(importDestinationFor('payslip')).toBe('/income');
    expect(importDestinationFor('bank_statement')).toBe('/expenses');
    expect(importDestinationFor('credit_card_statement')).toBe('/liabilities');
    expect(importDestinationFor('loan_statement')).toBe('/liabilities');
    expect(importDestinationFor('investment_statement')).toBe('/investments');
    expect(importDestinationFor('super_statement')).toBe('/retirement');
    expect(importDestinationFor('tax_document')).toBeNull();
    expect(NOT_SUPPORTED_FOR_IMPORT.map((n) => n.type)).toEqual(['epf_statement', 'nps_statement', 'tax_document', 'other']);
  });

  it('the page no longer carries any uploader', () => {
    expect(fs.existsSync(path.join(REPO, 'components/financial-data-hub/FdhDocumentUploadClient.tsx'))).toBe(false);
    const page = fs.readFileSync(path.join(REPO, 'app/(app)/financial-data-hub/page.tsx'), 'utf8');
    expect(page).not.toMatch(/upload-sessions|type="file"|FdhDocumentUploadClient/);
    expect(page).toMatch(/redirect\(destination\)/);
  });
});

// ---------------------------------------------------------------------------
// UPL-04: the malware-config comment matches the code.
// ---------------------------------------------------------------------------
describe('UPL-04 malware config comment', () => {
  it('no longer claims incomplete settings are treated as "flag off"', () => {
    const src = fs.readFileSync(path.join(REPO, 'lib/aie/malware/config.ts'), 'utf8');
    expect(src).not.toMatch(/`not_configured` and every caller treats that exactly like "flag off"/);
    expect(src).toMatch(/FAILS CLOSED/);
  });
});
