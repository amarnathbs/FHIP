/**
 * Category-totals review of an imported bank statement (PO scope 2026-09-26)
 * — route-level proof against an in-memory database that enforces RLS, the
 * R7/R8 authoritative-field trigger and the FDH-7 approval guard
 * (tests/support/fdhFakeSupabase.ts).
 *
 * Written to FAIL on origin/main (15fa64b). The production defects it pins:
 *   1. choosing a category left `classification_method = 'unclassified'` and
 *      `economic_transaction_type = 'unknown'` (tile still said uncategorised,
 *      line could never be approved);
 *   2. tiles and list used different definitions ("Nothing to review" beside
 *      a non-zero tile);
 *   3. nothing offered approval, so every line stayed pending and nothing
 *      reached Monthly Surplus;
 *   4. no way back to Expenses.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- assertions read raw JSON route payloads */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, type FakeDb } from '../support/fdhFakeSupabase';
import { CAT, STATEMENT_A, STATEMENT_B, TXN, USER_A, USER_B, seedAll } from '../support/fdhCategoryReviewFixture';

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb, user: null as { id: string } | null }));

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.db.sessionClient(h.user!.id) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.db.adminClient() }));
vi.mock('@/lib/financial-data-hub/services/purge', () => ({ scheduleApprovedDocumentPurge: vi.fn(async () => undefined) }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requireCountryConfirmedUser: async () =>
    h.user ? { user: h.user } : { user: null, unauthenticated: Response.json({ error: 'unauthenticated' }, { status: 401 }) },
}));

vi.setConfig({ testTimeout: 30000 });

const REPO = path.resolve(__dirname, '..', '..');

async function call(
  mod: string,
  method: 'GET' | 'POST',
  opts: { params?: Record<string, string>; body?: unknown; query?: string } = {},
): Promise<{ status: number; json: any }> {
  const route = await import(mod);
  const req = new Request(`http://local/x${opts.query ?? ''}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const res: Response = await route[method](req, { params: Promise.resolve(opts.params ?? {}) });
  return { status: res.status, json: await res.json() };
}

const REVIEW = '@/app/api/financial-data-hub/documents/[documentId]/category-review/route';
const APPROVE_GROUP = '@/app/api/financial-data-hub/documents/[documentId]/category-review/approve-group/route';
const APPROVE_ALL = '@/app/api/financial-data-hub/documents/[documentId]/category-review/approve-all/route';
const SET_CATEGORY = '@/app/api/financial-data-hub/bank-transactions/[transactionId]/set-category/route';
const CORRECTION = '@/app/api/financial-data-hub/bank-transactions/[transactionId]/correction/route';
const QUEUE = '@/app/api/financial-data-hub/review-queue/route';

const getReview = (statementId = STATEMENT_A) => call(REVIEW, 'GET', { params: { documentId: statementId } });
const setCategory = (transactionId: string, categoryId: string, remember = false) =>
  call(SET_CATEGORY, 'POST', { params: { transactionId }, body: { category_id: categoryId, remember_payee: remember } });
const approveGroup = (groupKey: string, statementId = STATEMENT_A) =>
  call(APPROVE_GROUP, 'POST', { params: { documentId: statementId }, body: { group_key: groupKey } });
const queue = (reason?: string) => call(QUEUE, 'GET', { query: reason ? `?reason=${reason}` : '' });

const txnRow = (id: string) => h.db.rows('fdh_transactions').find((r) => r.id === id)!;
const rowsOf = (userId: string) => h.db.rows('fdh_transactions').filter((r) => r.user_id === userId);

/** What lib/services/dashboardData.ts feeds Monthly Surplus: approved rows
 * of these economic types (its own exported constants). */
async function surplusInputs(userId: string) {
  const { BANK_EXPENSE_TRANSACTION_TYPES, BANK_INCOME_TRANSACTION_TYPES, BANK_REFUND_TRANSACTION_TYPE } = await import('@/lib/services/dashboardData');
  const approved = rowsOf(userId).filter((r) => r.approval_status === 'approved');
  const sum = (types: readonly string[]) => Math.round(approved.filter((r) => types.includes(String(r.economic_transaction_type))).reduce((s, r) => s + Number(r.amount_original) * 100, 0)) / 100;
  return {
    income: sum(BANK_INCOME_TRANSACTION_TYPES),
    spending: Math.round((sum(BANK_EXPENSE_TRANSACTION_TYPES) - sum([BANK_REFUND_TRANSACTION_TYPE])) * 100) / 100,
  };
}

async function classifyEverything() {
  expect((await setCategory(TXN.salary1, CAT.income, true)).status).toBe(200);
  expect((await setCategory(TXN.toSavings, CAT.transfer)).status).toBe(200);
  expect((await setCategory(TXN.rent, CAT.housing)).status).toBe(200);
}

beforeEach(() => {
  h.db = createFakeDb();
  seedAll(h.db);
  h.user = { id: USER_A };
});

describe('category review: grouping and totals', () => {
  it('groups the statement by category with count and total; only the unrecognised lines are listed', async () => {
    const { status, json } = await getReview();
    expect(status).toBe(200);
    const r = json.data;
    expect(r.counts).toMatchObject({ transactions: 8, approved: 0, waiting_for_approval: 8, needs_decision: 4, uncategorised: 4, low_confidence: 0, ready_to_approve: 4 });
    expect(r.needs_decision.map((i: any) => i.id).sort()).toEqual([TXN.salary1, TXN.toSavings, TXN.rent, TXN.salary2].sort());
    const byLabel = Object.fromEntries(r.groups.map((g: any) => [g.label, g]));
    expect(Object.keys(byLabel).sort()).toEqual(['Bank & Financial Fees', 'Cash Withdrawal', 'Food & Dining', 'Utilities']);
    expect(byLabel['Utilities']).toMatchObject({ count: 1, total: 184.3, currency: 'AUD', direction: 'out', counts_toward: 'spending', fully_confident: true, status: 'waiting' });
    expect(byLabel['Cash Withdrawal']).toMatchObject({ total: 60, counts_toward: 'not_counted', fully_confident: false });
    expect(r.totals).toEqual([{ currency: 'AUD', waiting_income: 0, waiting_spending: 312.75, approved_income: 0, approved_spending: 0 }]);
  });

  it('offers "Linked Acc Trns To Savings" as an own-account transfer', async () => {
    const { json } = await getReview();
    const item = json.data.needs_decision.find((i: any) => i.id === TXN.toSavings);
    expect(item).toMatchObject({ reason: 'uncategorised', can_choose_category: true, suggested_category_id: CAT.transfer, direction: 'out', amount: 500, currency: 'AUD' });
  });

  it("another user's statement is a 404 and reveals nothing", async () => {
    h.user = { id: USER_B };
    const { status, json } = await getReview(STATEMENT_A);
    expect(status).toBe(404);
    expect(JSON.stringify(json)).not.toContain('Quillfeather');
  });
});

describe('choosing a category (production bug 1)', () => {
  it("records the user's own method, sets the type the category implies, and resolves the review", async () => {
    const { status, json } = await setCategory(TXN.rent, CAT.housing);
    expect(status).toBe(200);
    expect(json.data).toMatchObject({ economic_transaction_type: 'expense', classification_method: 'user_manual' });
    const row = txnRow(TXN.rent);
    expect(row).toMatchObject({
      category_id: CAT.housing,
      economic_transaction_type: 'expense',
      classification_method: 'user_manual',
      classification_confidence: 1,
      review_status: 'resolved',
      user_override: true,
    });
    const history = h.db.rows('fdh_classification_history').filter((x) => x.transaction_id === TXN.rent);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ changed_by_type: 'user', changed_by_user: USER_A, classification_method: 'user_manual', new_economic_transaction_type: 'expense' });
  });

  it('the existing correction route (category) now also sets the type and the user method', async () => {
    const { status } = await call(CORRECTION, 'POST', { params: { transactionId: TXN.rent }, body: { field_name: 'category_id', corrected_value: CAT.housing } });
    expect(status).toBe(200);
    expect(txnRow(TXN.rent)).toMatchObject({ economic_transaction_type: 'expense', classification_method: 'user_manual', category_id: CAT.housing });
  });

  it("refuses another user's transaction and a category that is not in the list", async () => {
    h.user = { id: USER_B };
    expect((await setCategory(TXN.rent, CAT.housing)).status).toBe(404);
    h.user = { id: USER_A };
    expect((await setCategory(TXN.rent, CAT.unknown)).status).toBe(422);
    expect(txnRow(TXN.rent)).toMatchObject({ economic_transaction_type: 'unknown', classification_method: 'unclassified' });
  });

  it('tiles, list and category review agree after each choice', async () => {
    for (const [id, cat] of [[TXN.rent, CAT.housing], [TXN.salary1, CAT.income]] as const) {
      await setCategory(id, cat);
      const q = await queue('uncategorised');
      const r = await getReview();
      expect(q.json.data.sections.uncategorised).toBe(q.json.data.items.length);
      expect(q.json.data.sections.uncategorised).toBe(r.json.data.counts.uncategorised);
    }
    expect((await getReview()).json.data.counts.uncategorised).toBe(2);
  });

  it('remembering a payee classifies the same payee elsewhere through the user\'s own rule', async () => {
    const { json } = await setCategory(TXN.salary1, CAT.income, true);
    expect(json.data.payee_remembered).toBe(true);
    const rules = h.db.rows('fdh_user_classification_rules').filter((r) => r.user_id === USER_A && r.active);
    expect(rules).toHaveLength(1);
    expect(rules[0].match_definition).toEqual({ match_kind: 'description_contains', needle_normalised: 'QUILLFEATHER STUDIO PTY LTD' });
    expect(txnRow(TXN.salary2)).toMatchObject({ economic_transaction_type: 'income', category_id: CAT.income, classification_method: 'user_rule' });
    // Never another user's rows.
    expect(rowsOf(USER_B).every((r) => r.economic_transaction_type !== 'income')).toBe(true);
  });
});

describe('one definition for tiles and list (production bug 2)', () => {
  it('a row with a category but no type (the production state) is uncategorised in the tile AND the list', async () => {
    Object.assign(txnRow(TXN.rent), { category_id: CAT.housing, review_status: 'resolved', user_override: true });
    const q = await queue();
    expect(q.json.data.sections.uncategorised).toBe(4);
    expect(q.json.data.items.map((i: any) => i.id)).toContain(TXN.rent);
    const u = await queue('uncategorised');
    expect(u.json.data.items).toHaveLength(u.json.data.sections.uncategorised);
  });

  it("low confidence is FDH-6's LOW boundary: an approved general rule (0.6) is not low, 0.3 is — tile and list alike", async () => {
    let q = await queue('low_confidence');
    expect(q.json.data.sections.low_confidence).toBe(0);
    expect(q.json.data.items).toHaveLength(0);
    Object.assign(txnRow(TXN.cash), { classification_confidence: 0.3 });
    q = await queue('low_confidence');
    expect(q.json.data.sections.low_confidence).toBe(1);
    expect(q.json.data.items.map((i: any) => i.id)).toEqual([TXN.cash]);
    const r = await getReview();
    expect(r.json.data.counts.low_confidence).toBe(1);
    expect(r.json.data.needs_decision.find((i: any) => i.id === TXN.cash)?.reason).toBe('low_confidence');
  });

  it('lines waiting for approval are counted and their statement is offered for category review', async () => {
    const q = await queue();
    expect(q.json.data.sections.awaiting_approval).toBe(8);
    expect(q.json.data.sections.ready_to_approve).toBe(4);
    expect(q.json.data.statements).toEqual([expect.objectContaining({ id: STATEMENT_A, waiting: 8 })]);
  });
});

describe('approving a category group (production bug 3)', () => {
  const groupKey = async (label: string) => (await getReview()).json.data.groups.find((g: any) => g.label === label).group_key as string;

  it("approves exactly the group's transactions and nothing else", async () => {
    const key = await groupKey('Food & Dining');
    const { status, json } = await approveGroup(key);
    expect(status).toBe(200);
    expect(json.data).toMatchObject({ outcome: 'approved', approved: 1, failed: 0 });
    const approved = rowsOf(USER_A).filter((r) => r.approval_status === 'approved').map((r) => r.id);
    expect(approved).toEqual([TXN.groceries]);
    expect(txnRow(TXN.groceries)).toMatchObject({ approved_by: USER_A });
  });

  it('a second approve of the same group changes nothing', async () => {
    const key = await groupKey('Food & Dining');
    await approveGroup(key);
    const approvedAt = txnRow(TXN.groceries).approved_at;
    const events = h.db.rows('fdh_document_audit_events').length;
    const again = await approveGroup(key);
    expect(again.status).toBe(200);
    expect(again.json.data).toMatchObject({ outcome: 'already_approved', approved: 0 });
    expect(txnRow(TXN.groceries).approved_at).toBe(approvedAt);
    expect(h.db.rows('fdh_document_audit_events').length).toBe(events);
  });

  it("is refused for another user's statement and changes nothing", async () => {
    const key = await groupKey('Food & Dining');
    h.user = { id: USER_B };
    const res = await approveGroup(key, STATEMENT_A);
    expect(res.status).toBe(404);
    expect(rowsOf(USER_A).every((r) => r.approval_status === 'pending')).toBe(true);
    // The same category on B's OWN statement approves only B's line, never A's.
    const own = await approveGroup(key, STATEMENT_B);
    expect(own.status).toBe(200);
    expect(own.json.data).toMatchObject({ outcome: 'approved', approved: 1 });
    expect(rowsOf(USER_B).filter((r) => r.approval_status === 'approved').map((r) => r.description_clean)).toEqual(['Woolworths']);
    expect(rowsOf(USER_A).every((r) => r.approval_status === 'pending')).toBe(true);
  });

  it('a line that still has an open question is never inside a group', async () => {
    h.db.insert('fdh_transaction_links', { user_id: USER_A, transaction_id_from: TXN.groceries, transaction_id_to: null, link_type: 'internal_transfer', status: 'pending', confidence: 0.3 });
    const r = (await getReview()).json.data;
    expect(r.groups.some((g: any) => g.lines.some((l: any) => l.id === TXN.groceries))).toBe(false);
    expect(r.needs_decision.find((i: any) => i.id === TXN.groceries)).toMatchObject({ reason: 'transfer_check', can_choose_category: true });
    // Choosing a non-transfer category answers the question (the match is rejected)...
    await setCategory(TXN.groceries, CAT.food);
    expect(h.db.rows('fdh_transaction_links')[0]).toMatchObject({ status: 'rejected' });
    // ...and the line is back in its group and approvable.
    const key = await groupKey('Food & Dining');
    expect((await approveGroup(key)).json.data).toMatchObject({ outcome: 'approved', approved: 1 });
  });

  it('an unknown group key is a 404, never a wider approval', async () => {
    const res = await approveGroup('cat:not-a-real-group|out|AUD');
    expect(res.status).toBe(404);
    expect(rowsOf(USER_A).every((r) => r.approval_status === 'pending')).toBe(true);
  });
});

describe('approve all', () => {
  it('is refused while a line needs a decision, then approves everything; Monthly Surplus inputs move by exactly the approved amounts; repeating it does nothing', async () => {
    const refused = await call(APPROVE_ALL, 'POST', { params: { documentId: STATEMENT_A } });
    expect(refused.status).toBe(409);
    expect(refused.json.error).toMatch(/4 transactions still need your decision/);
    expect(rowsOf(USER_A).every((r) => r.approval_status === 'pending')).toBe(true);
    expect(await surplusInputs(USER_A)).toEqual({ income: 0, spending: 0 });

    await classifyEverything();
    const before = (await getReview()).json.data;
    expect(before.counts).toMatchObject({ needs_decision: 0, ready_to_approve: 8 });
    expect(before.totals[0]).toMatchObject({ waiting_income: 3700, waiting_spending: 1262.75 });
    const labels = before.groups.map((g: any) => `${g.label}:${g.counts_toward}:${g.total}`);
    expect(labels).toEqual(expect.arrayContaining(['Income:income:3700', 'Housing:spending:950', 'Own-Account Transfer:not_counted:500']));

    const ok = await call(APPROVE_ALL, 'POST', { params: { documentId: STATEMENT_A } });
    expect(ok.status).toBe(200);
    expect(ok.json.data).toMatchObject({ outcome: 'approved', approved: 8 });
    expect(rowsOf(USER_A).every((r) => r.approval_status === 'approved')).toBe(true);
    expect(h.db.rows('fdh_statement_uploads').find((s) => s.id === STATEMENT_A)).toMatchObject({ approved_by: USER_A, approval_version: 1 });
    // Transfer and cash withdrawal never count; income and spending exactly.
    expect(await surplusInputs(USER_A)).toEqual({ income: 3700, spending: 1262.75 });
    expect(rowsOf(USER_B).every((r) => r.approval_status === 'pending')).toBe(true);

    const after = (await getReview()).json.data;
    expect(after.counts).toMatchObject({ approved: 8, waiting_for_approval: 0, needs_decision: 0 });
    expect(after.totals[0]).toMatchObject({ approved_income: 3700, approved_spending: 1262.75, waiting_income: 0, waiting_spending: 0 });

    const again = await call(APPROVE_ALL, 'POST', { params: { documentId: STATEMENT_A } });
    expect(again.status).toBe(200);
    expect(again.json.data).toMatchObject({ outcome: 'already_approved', approved: 0 });
    expect(h.db.rows('fdh_statement_uploads').find((s) => s.id === STATEMENT_A)).toMatchObject({ approval_version: 1 });
  });

  it('approving every group one by one also completes the statement', async () => {
    await classifyEverything();
    for (const g of (await getReview()).json.data.groups) await approveGroup(g.group_key);
    expect(rowsOf(USER_A).every((r) => r.approval_status === 'approved')).toBe(true);
    expect(h.db.rows('fdh_statement_uploads').find((s) => s.id === STATEMENT_A)).toMatchObject({ approved_by: USER_A });
    expect(await surplusInputs(USER_A)).toEqual({ income: 3700, spending: 1262.75 });
  });
});

describe('UI contract (snake_case) and copy', () => {
  it('every field the category review page reads exists in the real API response', async () => {
    await classifyEverything();
    await setCategory(TXN.cash, CAT.cash); // no-op-ish; keeps one group confident
    Object.assign(txnRow(TXN.fee), { economic_transaction_type: 'unknown', category_id: null });
    const r = (await getReview()).json.data;
    const src = fs.readFileSync(path.join(REPO, 'app', '(app)', 'financial-data-hub', 'review', 'StatementCategoryReview.tsx'), 'utf8');
    const fieldsRead = (obj: string) => [...new Set([...src.matchAll(new RegExp(`\\b${obj}\\.([a-z_]+)`, 'g'))].map((m) => m[1]))];
    const check = (obj: string, sample: Record<string, unknown>) => {
      const fields = fieldsRead(obj);
      expect(fields.length, `${obj}.* fields read by the page`).toBeGreaterThan(0);
      for (const f of fields) expect(Object.keys(sample), `${obj}.${f}`).toContain(f);
    };
    check('group', r.groups[0]);
    check('line', r.groups[0].lines[0]);
    check('item', r.needs_decision[0]);
    check('counts', r.counts);
    check('statement', r.statement);
    check('t', r.totals[0]);
    // No camelCase field is ever read off the API payload.
    expect(fieldsRead('group').concat(fieldsRead('item'), fieldsRead('counts')).some((f) => /[A-Z]/.test(f))).toBe(false);
  });

  it('the general review page never says "Nothing to review" while lines wait for approval, and every review view links back', () => {
    const workspace = fs.readFileSync(path.join(REPO, 'app', '(app)', 'financial-data-hub', 'review', 'ReviewWorkspace.tsx'), 'utf8');
    const page = fs.readFileSync(path.join(REPO, 'app', '(app)', 'financial-data-hub', 'review', 'page.tsx'), 'utf8');
    expect(workspace).not.toContain('Nothing to review');
    expect(workspace).toContain('waiting for your approval');
    expect(page).toContain('Back to Expenses');
    expect(page).toMatch(/href=\{backTarget\.href\}/);
  });

  it('the bank import "done" step opens this statement\'s category review and returns to Expenses', () => {
    const panel = fs.readFileSync(path.join(REPO, 'components', 'expenses', 'BankStatementImportPanel.tsx'), 'utf8');
    expect(panel).toContain('/financial-data-hub/review?statement=${encodeURIComponent(summary.statementId)}&from=expenses');
  });
});
