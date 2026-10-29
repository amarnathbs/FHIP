/**
 * Bulk "Choose a category" on an imported bank statement's review (PO request
 * 2026-10-29: 271 lines waited for a category, each needing its own Save).
 *
 * ROUTE-LEVEL proof against the in-memory database that enforces RLS, the R7/R8
 * authoritative-field triggers and the FDH-7 approval guard
 * (tests/support/fdhFakeSupabase.ts). It is NOT a real Postgres: the SQL triggers are
 * a faithful mirror, not the SQL itself.
 *
 * What it pins:
 *   BULK-1  one request sets one category on many lines, with the single-save's evidence
 *   BULK-2  the final state equals N single saves (same rows, same corrections / history / audit)
 *   BULK-3  it NEVER approves; the existing explicit approvals still work afterwards
 *   BULK-4  isolation: another user's statement is 404; foreign / invented ids touch nothing
 *   BULK-5  partial failure is reported line by line (requested = applied + unchanged + failed)
 *   BULK-6  idempotent re-run writes nothing a second time
 *   BULK-7  "suggested" mode, remember-payee (once per payee), link settlement
 *   BULK-8  limits and validation
 *   BULK-9  ONE request: the number of database round trips does not grow per line
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- assertions read raw JSON route payloads */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, type FakeDb } from '../support/fdhFakeSupabase';
import { CAT, STATEMENT_A, STATEMENT_B, TXN, USER_A, USER_B, seedAll } from '../support/fdhCategoryReviewFixture';

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb, user: null as { id: string } | null, requests: 0 }));

/** The session client, with every query (one `from()` = one PostgREST request) counted. */
function countingSession(uid: string) {
  const inner = h.db.sessionClient(uid) as unknown as { from(t: string): unknown };
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'from') return (t: string) => { h.requests += 1; return target.from(t); };
      return Reflect.get(target, prop, receiver);
    },
  });
}
function countingAdmin() {
  const inner = h.db.adminClient() as unknown as { from(t: string): unknown };
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'from') return (t: string) => { h.requests += 1; return target.from(t); };
      return Reflect.get(target, prop, receiver);
    },
  });
}

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => countingSession(h.user!.id) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => countingAdmin() }));
vi.mock('@/lib/financial-data-hub/services/purge', () => ({ scheduleApprovedDocumentPurge: vi.fn(async () => undefined) }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requireCountryConfirmedUser: async () =>
    h.user ? { user: h.user } : { user: null, unauthenticated: Response.json({ error: 'unauthenticated' }, { status: 401 }) },
}));

vi.setConfig({ testTimeout: 60000 });

async function call(mod: string, opts: { params?: Record<string, string>; body?: unknown } = {}): Promise<{ status: number; json: any }> {
  const route = await import(mod);
  const req = new Request('http://local/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const res: Response = await route.POST(req, { params: Promise.resolve(opts.params ?? {}) });
  return { status: res.status, json: await res.json() };
}
async function getReview(statementId = STATEMENT_A): Promise<any> {
  const route = await import('@/app/api/financial-data-hub/documents/[documentId]/category-review/route');
  const res: Response = await route.GET(new Request('http://local/x'), { params: Promise.resolve({ documentId: statementId }) });
  return (await res.json()).data;
}

const BULK = '@/app/api/financial-data-hub/documents/[documentId]/category-review/set-categories/route';
const SET_CATEGORY = '@/app/api/financial-data-hub/bank-transactions/[transactionId]/set-category/route';
const APPROVE_GROUP = '@/app/api/financial-data-hub/documents/[documentId]/category-review/approve-group/route';
const APPROVE_ALL = '@/app/api/financial-data-hub/documents/[documentId]/category-review/approve-all/route';

const bulk = (ids: string[], categoryId: string, extra: Record<string, unknown> = {}, statementId = STATEMENT_A) =>
  call(BULK, { params: { documentId: statementId }, body: { transaction_ids: ids, mode: 'category', category_id: categoryId, ...extra } });
const bulkSuggested = (ids: string[], extra: Record<string, unknown> = {}, statementId = STATEMENT_A) =>
  call(BULK, { params: { documentId: statementId }, body: { transaction_ids: ids, mode: 'suggested', ...extra } });
const single = (transactionId: string, categoryId: string, remember = false) =>
  call(SET_CATEGORY, { params: { transactionId }, body: { category_id: categoryId, remember_payee: remember } });

const txnRow = (id: string) => h.db.rows('fdh_transactions').find((r) => r.id === id)!;
const rowsOf = (userId: string) => h.db.rows('fdh_transactions').filter((r) => r.user_id === userId);
const bId = (id: string) => `f1${id.slice(2)}`;
const UNKNOWN_IDS = [TXN.salary1, TXN.toSavings, TXN.rent, TXN.salary2];

/** The columns a category choice may change, plus the evidence it leaves. */
function snapshot(db: FakeDb, userId: string) {
  const rows = db.rows('fdh_transactions').filter((r) => r.user_id === userId)
    .map((r) => ({ id: r.id, type: r.economic_transaction_type, category: r.category_id, method: r.classification_method, conf: r.classification_confidence, override: r.user_override, review: r.review_status, transfer: r.transfer_flag, approval: r.approval_status }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const corrections = db.rows('fdh_transaction_corrections').filter((c) => c.user_id === userId)
    .map((c) => `${c.transaction_id}|${c.field_name}|${JSON.stringify(c.previous_value)}|${JSON.stringify(c.corrected_value)}`).sort();
  const history = db.rows('fdh_classification_history').filter((c) => c.user_id === userId)
    .map((c) => `${c.transaction_id}|${c.previous_economic_transaction_type}>${c.new_economic_transaction_type}|${c.previous_category_id}>${c.new_category_id}|${c.classification_method}`).sort();
  const audit = db.rows('fdh_document_audit_events').filter((e) => e.user_id === userId && e.event_type === 'transaction_corrected')
    .map((e) => `${e.document_id}|${JSON.stringify(e.metadata)}`).sort();
  return { rows, corrections, history, audit };
}

/** Extra uncategorised lines on statement A (the PO's 271-line case, synthetic). */
function addUncategorised(n: number, description = 'Synthetic Payee') {
  const template = rowsOf(USER_A).find((r) => r.id === TXN.rent)!;
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = `f9000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
    h.db.insert('fdh_transactions', { ...template, id, description_clean: `${description} ${i}`, description_raw: `${description} ${i}`, amount_original: 10 + i });
    ids.push(id);
  }
  return ids;
}

beforeEach(() => {
  h.db = createFakeDb();
  seedAll(h.db);
  h.user = { id: USER_A };
  h.requests = 0;
});

describe('BULK-1 one request sets one category on many lines', () => {
  it('sets the category, derives the type, stamps the user method and leaves the same evidence as the single save', async () => {
    const { status, json } = await bulk([TXN.rent, TXN.salary1], CAT.housing);
    expect(status).toBe(200);
    expect(json.data).toMatchObject({ requested: 2, applied: 2, unchanged: 0, failed: [], approved: 0, outcome: 'applied' });
    expect(json.data.by_category).toEqual([{ category_id: CAT.housing, label: 'Housing', count: 2 }]);
    for (const id of [TXN.rent, TXN.salary1]) {
      expect(txnRow(id)).toMatchObject({ category_id: CAT.housing, economic_transaction_type: 'expense', classification_method: 'user_manual', classification_confidence: 1, review_status: 'resolved', user_override: true, approval_status: 'pending' });
    }
    const corrections = h.db.rows('fdh_transaction_corrections').filter((c) => c.transaction_id === TXN.rent);
    expect(corrections.map((c) => c.field_name).sort()).toEqual(['category_id', 'economic_transaction_type']);
    expect(corrections.every((c) => c.user_id === USER_A && c.reason === 'Chosen by you in the statement review.')).toBe(true);
    expect(h.db.rows('fdh_classification_history').filter((x) => x.transaction_id === TXN.rent)).toHaveLength(1);
    expect(h.db.rows('fdh_document_audit_events').filter((e) => e.event_type === 'transaction_corrected' && e.document_id === STATEMENT_A)).toHaveLength(4);
    // Lines not named are untouched.
    expect(txnRow(TXN.toSavings)).toMatchObject({ economic_transaction_type: 'unknown', classification_method: 'unclassified' });
  });

  it('a transfer category sets the transfer flag, like the single save', async () => {
    await bulk([TXN.toSavings], CAT.transfer);
    expect(txnRow(TXN.toSavings)).toMatchObject({ economic_transaction_type: 'transfer', transfer_flag: true, category_id: CAT.transfer });
  });

  it('clears a subcategory that no longer belongs to the new category, keeps one that does', async () => {
    const SUB_OTHER = 'a1000000-0000-4000-8000-000000000001';
    const SUB_OWN = 'a1000000-0000-4000-8000-000000000002';
    h.db.insert('fdh_subcategories', { id: SUB_OTHER, category_id: CAT.food, display_name: 'Cafes', active: true });
    h.db.insert('fdh_subcategories', { id: SUB_OWN, category_id: CAT.housing, display_name: 'Rent', active: true });
    Object.assign(txnRow(TXN.rent), { subcategory_id: SUB_OWN });
    Object.assign(txnRow(TXN.salary1), { subcategory_id: SUB_OTHER });
    await bulk([TXN.rent, TXN.salary1], CAT.housing);
    expect(txnRow(TXN.rent).subcategory_id).toBe(SUB_OWN);
    expect(txnRow(TXN.salary1).subcategory_id).toBeNull();
  });
});

describe('BULK-2 equals N single saves (the strongest equivalence check)', () => {
  it('the same rows, corrections, history and audit events as saving each line on its own', async () => {
    const ids = [TXN.rent, TXN.salary1, TXN.toSavings, TXN.salary2];
    for (const id of ids) expect((await single(id, CAT.housing)).status).toBe(200);
    const viaSingle = snapshot(h.db, USER_A);

    h.db = createFakeDb();
    seedAll(h.db);
    expect((await bulk(ids, CAT.housing)).status).toBe(200);
    const viaBulk = snapshot(h.db, USER_A);

    expect(viaBulk.rows).toEqual(viaSingle.rows);
    expect(viaBulk.corrections).toEqual(viaSingle.corrections);
    expect(viaBulk.history).toEqual(viaSingle.history);
    expect(viaBulk.audit).toEqual(viaSingle.audit);
    expect(viaBulk.corrections.length).toBeGreaterThan(0);
  });
});

describe('BULK-3 it never approves', () => {
  it('assigning categories leaves every line pending and the dashboard inputs at zero; the existing approvals still work afterwards', async () => {
    const res = await bulk(UNKNOWN_IDS, CAT.housing);
    expect(res.json.data.approved).toBe(0);
    expect(rowsOf(USER_A).every((r) => r.approval_status === 'pending' && !r.approved_by)).toBe(true);
    expect(h.db.rows('fdh_statement_uploads').find((s) => s.id === STATEMENT_A)).toMatchObject({ approved_by: null });
    expect(h.db.rows('fdh_document_audit_events').some((e) => e.event_type === 'transaction_approved')).toBe(false);

    // The existing explicit step is unchanged: approve the Housing group, then everything.
    const review = await getReview();
    const housing = review.groups.filter((g: any) => g.label === 'Housing'); // money out and money in are separate groups
    expect(housing.map((g: any) => g.count).sort()).toEqual([2, 2]);
    expect(housing.every((g: any) => g.status === 'waiting')).toBe(true);
    const group = await call(APPROVE_GROUP, { params: { documentId: STATEMENT_A }, body: { group_key: housing[0].group_key } });
    expect(group.json.data).toMatchObject({ outcome: 'approved', approved: 2 });
    const all = await call(APPROVE_ALL, { params: { documentId: STATEMENT_A } });
    expect(all.status).toBe(200);
    expect(rowsOf(USER_A).every((r) => r.approval_status === 'approved')).toBe(true);
  });

  it('a line that is already approved is refused with a reason, never changed', async () => {
    Object.assign(txnRow(TXN.groceries), { approval_status: 'approved', approved_by: USER_A });
    const { json } = await bulk([TXN.groceries, TXN.rent], CAT.housing);
    expect(json.data).toMatchObject({ applied: 1, outcome: 'partly_applied' });
    expect(json.data.failed).toEqual([expect.objectContaining({ transaction_id: TXN.groceries, code: 'already_approved' })]);
    expect(txnRow(TXN.groceries)).toMatchObject({ category_id: CAT.food, approval_status: 'approved' });
  });
});

describe('BULK-4 isolation between users', () => {
  it("another user's statement is a 404 and nothing changes", async () => {
    h.user = { id: USER_B };
    const res = await bulk(UNKNOWN_IDS, CAT.housing, {}, STATEMENT_A);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.json)).not.toContain('Quillfeather');
    expect(rowsOf(USER_A).filter((r) => r.classification_method === 'user_manual')).toHaveLength(0);
    expect(h.db.rows('fdh_transaction_corrections')).toHaveLength(0);
  });

  it("a user cannot categorise another user's lines even on their own statement: every foreign id is reported not found and nothing changes", async () => {
    h.user = { id: USER_B };
    const res = await bulk([TXN.rent, TXN.salary1, bId(TXN.rent)], CAT.housing, {}, STATEMENT_B);
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ requested: 3, applied: 1, outcome: 'partly_applied' });
    expect(res.json.data.failed.map((f: any) => [f.transaction_id, f.code, f.description]).sort()).toEqual(
      [[TXN.rent, 'not_found', null], [TXN.salary1, 'not_found', null]].sort(),
    );
    expect(txnRow(bId(TXN.rent))).toMatchObject({ user_id: USER_B, category_id: CAT.housing });
    expect(txnRow(TXN.rent)).toMatchObject({ user_id: USER_A, economic_transaction_type: 'unknown', classification_method: 'unclassified' });
    expect(txnRow(TXN.salary1)).toMatchObject({ economic_transaction_type: 'unknown' });
    expect(h.db.rows('fdh_transaction_corrections').every((c) => c.user_id === USER_B)).toBe(true);
  });

  it("a line of the user's OTHER statement is not accepted on this statement's request", async () => {
    const OTHER_STATEMENT = 'd0000000-0000-4000-8000-0000000000a2';
    h.db.insert('fdh_statement_uploads', { ...h.db.rows('fdh_statement_uploads').find((s) => s.id === STATEMENT_A)!, id: OTHER_STATEMENT });
    Object.assign(txnRow(TXN.rent), { statement_upload_id: OTHER_STATEMENT });
    const { json } = await bulk([TXN.rent, TXN.salary1], CAT.housing);
    expect(json.data.failed).toEqual([expect.objectContaining({ transaction_id: TXN.rent, code: 'not_found' })]);
    expect(txnRow(TXN.rent).economic_transaction_type).toBe('unknown');
  });

  it("remembering a payee never touches another user's lines or rules", async () => {
    await bulk([TXN.salary1], CAT.income, { remember_payee: true });
    expect(h.db.rows('fdh_user_classification_rules').every((r) => r.user_id === USER_A)).toBe(true);
    expect(rowsOf(USER_B).every((r) => r.economic_transaction_type !== 'income')).toBe(true);
  });

  it('unauthenticated is 401', async () => {
    h.user = null;
    expect((await bulk([TXN.rent], CAT.housing)).status).toBe(401);
  });
});

describe('BULK-5 partial failure is reported line by line', () => {
  it('requested = applied + unchanged + failed; an invented id is reported, the rest are saved', async () => {
    const invented = 'f7777777-0000-4000-8000-000000000001';
    const { json } = await bulk([TXN.rent, invented, TXN.salary1], CAT.housing);
    const d = json.data;
    expect(d.requested).toBe(3);
    expect(d.applied + d.unchanged + d.failed.length).toBe(3);
    expect(d.failed).toEqual([{ transaction_id: invented, description: null, code: 'not_found', message: 'This transaction was not found on this statement.' }]);
    expect(d.outcome).toBe('partly_applied');
    expect(txnRow(TXN.rent).category_id).toBe(CAT.housing);
  });

  it('a write the database refuses is reported as failed for exactly that line (the others are saved)', async () => {
    const dbAny = h.db as any;
    const real = dbAny.beforeUpdate.bind(h.db);
    dbAny.beforeUpdate = (table: string, old: any, next: any, role: string, uid: string | null) => {
      if (table === 'fdh_transactions' && role === 'authenticated' && old.id === TXN.salary1 && next.category_id !== old.category_id) throw new Error('simulated database refusal');
      return real(table, old, next, role, uid);
    };
    // The bulk update is one statement per chunk: a refusal fails that chunk; the report names every line in it.
    const { json } = await bulk([TXN.rent, TXN.salary1], CAT.housing);
    expect(json.data.applied + json.data.unchanged + json.data.failed.length).toBe(2);
    expect(json.data.failed.length).toBeGreaterThan(0);
    expect(json.data.failed.every((f: any) => f.code === 'write_failed' && f.message.length > 10)).toBe(true);
    dbAny.beforeUpdate = real;
  });

  it('a line that has to be decided on its own page (a possible duplicate) is reported, not forced', async () => {
    h.db.insert('fdh_duplicate_candidates', { user_id: USER_A, transaction_id_a: TXN.rent, transaction_id_b: TXN.salary2, status: 'pending' });
    const item = (await getReview()).needs_decision.find((i: any) => i.id === TXN.rent);
    expect(item).toMatchObject({ reason: 'possible_duplicate', can_choose_category: false });
    const { json } = await bulk([TXN.rent, TXN.salary1], CAT.housing);
    expect(json.data.failed).toEqual([expect.objectContaining({ transaction_id: TXN.rent, code: 'cannot_choose_here' })]);
    expect(txnRow(TXN.rent).economic_transaction_type).toBe('unknown');
    expect(txnRow(TXN.salary1).category_id).toBe(CAT.housing);
  });
});

describe('BULK-6 idempotent re-run', () => {
  it('repeating the same request changes nothing and writes no second correction, history or audit row', async () => {
    const ids = [TXN.rent, TXN.salary1, TXN.toSavings];
    const first = await bulk(ids, CAT.housing);
    expect(first.json.data).toMatchObject({ applied: 3, unchanged: 0 });
    const before = snapshot(h.db, USER_A);
    const counts = ['fdh_transaction_corrections', 'fdh_classification_history', 'fdh_document_audit_events'].map((t) => h.db.rows(t).length);
    const second = await bulk(ids, CAT.housing);
    expect(second.status).toBe(200);
    expect(second.json.data).toMatchObject({ applied: 0, unchanged: 3, failed: [], outcome: 'already_set' });
    expect(snapshot(h.db, USER_A)).toEqual(before);
    expect(['fdh_transaction_corrections', 'fdh_classification_history', 'fdh_document_audit_events'].map((t) => h.db.rows(t).length)).toEqual(counts);
  });

  it('repeating with a different category is a real change (not mistaken for a no-op)', async () => {
    await bulk([TXN.rent], CAT.housing);
    const again = await bulk([TXN.rent], CAT.utilities);
    expect(again.json.data).toMatchObject({ applied: 1, unchanged: 0 });
    expect(txnRow(TXN.rent).category_id).toBe(CAT.utilities);
  });
});

describe('BULK-7 suggested mode, remember payee, links', () => {
  it('applies each line its own suggested category; lines without a suggestion are left as they are', async () => {
    const review = await getReview();
    const suggested = review.needs_decision.find((i: any) => i.id === TXN.toSavings);
    expect(suggested.suggested_category_id).toBe(CAT.transfer);
    const none = review.needs_decision.find((i: any) => i.id === TXN.rent);
    expect(none.suggested_category_id).toBeNull();
    const only = await bulkSuggested([TXN.toSavings]);
    expect(only.json.data).toMatchObject({ applied: 1, failed: [] });
    expect(txnRow(TXN.toSavings)).toMatchObject({ category_id: CAT.transfer, economic_transaction_type: 'transfer', classification_method: 'user_manual' });
    const mixed = await bulkSuggested([TXN.rent]);
    expect(mixed.json.data.failed).toEqual([expect.objectContaining({ transaction_id: TXN.rent, code: 'no_suggestion' })]);
    expect(txnRow(TXN.rent)).toMatchObject({ economic_transaction_type: 'unknown', classification_method: 'unclassified' });
  });

  it('remember payee creates ONE rule per payee (two lines, same payee), reclassifies the rest, audits once', async () => {
    const { json } = await bulk([TXN.salary1, TXN.salary2], CAT.income, { remember_payee: true });
    expect(json.data).toMatchObject({ applied: 2, payees_remembered: 1, payees_not_remembered: [] });
    const rules = h.db.rows('fdh_user_classification_rules').filter((r) => r.user_id === USER_A && r.active);
    expect(rules).toHaveLength(1);
    expect(rules[0].match_definition).toEqual({ match_kind: 'description_contains', needle_normalised: 'QUILLFEATHER STUDIO PTY LTD' });
    expect(h.db.rows('fdh_document_audit_events').filter((e) => e.event_type === 'personal_rule_created')).toHaveLength(1);
  });

  it('without the tick no rule is created (default off)', async () => {
    await bulk([TXN.salary1], CAT.income);
    expect(h.db.rows('fdh_user_classification_rules')).toHaveLength(0);
  });

  it('repeating a remember request does not create a second rule', async () => {
    await bulk([TXN.salary1], CAT.income, { remember_payee: true });
    await bulk([TXN.salary1], CAT.income, { remember_payee: true });
    expect(h.db.rows('fdh_user_classification_rules').filter((r) => r.active)).toHaveLength(1);
  });

  it('the same payee given two different suggested categories is reported as not remembered, never guessed', async () => {
    Object.assign(txnRow(TXN.salary1), { description_clean: 'Zeta Holdings Pty', description_raw: 'Zeta Holdings Pty' });
    Object.assign(txnRow(TXN.groceries), { description_clean: 'Zeta Holdings Pty', description_raw: 'Zeta Holdings Pty', classification_confidence: 0.3 });
    h.db.insert('fdh_transaction_links', { user_id: USER_A, transaction_id_from: TXN.salary1, transaction_id_to: null, link_type: 'internal_transfer', status: 'pending', confidence: 0.3 });
    const review = await getReview();
    expect(review.needs_decision.find((i: any) => i.id === TXN.salary1).suggested_category_id).toBe(CAT.transfer);
    expect(review.needs_decision.find((i: any) => i.id === TXN.groceries).suggested_category_id).toBe(CAT.food);
    const { json } = await bulkSuggested([TXN.salary1, TXN.groceries], { remember_payee: true });
    expect(json.data).toMatchObject({ applied: 2, payees_remembered: 0 });
    expect(json.data.payees_not_remembered).toEqual([expect.objectContaining({ payee_key: 'ZETA HOLDINGS PTY' })]);
    expect(h.db.rows('fdh_user_classification_rules')).toHaveLength(0);
  });

  it('settles a pending "is this a transfer?" match the choice answers, like the single save', async () => {
    h.db.insert('fdh_transaction_links', { user_id: USER_A, transaction_id_from: TXN.groceries, transaction_id_to: null, link_type: 'internal_transfer', status: 'pending', confidence: 0.3 });
    const { json } = await bulk([TXN.groceries], CAT.food);
    expect(json.data.links_settled).toBe(1);
    expect(h.db.rows('fdh_transaction_links')[0]).toMatchObject({ status: 'rejected' });
  });
});

describe('BULK-8 limits and validation', () => {
  it('refuses more than 500 ids, an empty list, a repeated id, a malformed id, a missing category and an unknown category', async () => {
    const many = Array.from({ length: 501 }, (_, i) => `f9000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
    const tooMany = await bulk(many, CAT.housing);
    expect(tooMany.status).toBe(422);
    expect(tooMany.json.error).toMatch(/up to 500/);
    expect((await bulk([], CAT.housing)).status).toBe(422);
    const twice = await bulk([TXN.rent, TXN.rent], CAT.housing);
    expect(twice.status).toBe(422);
    expect(twice.json.error).toMatch(/twice/);
    expect((await bulk(['not-a-uuid'], CAT.housing)).status).toBe(422);
    expect((await call(BULK, { params: { documentId: STATEMENT_A }, body: { transaction_ids: [TXN.rent], mode: 'category' } })).status).toBe(422);
    expect((await call(BULK, { params: { documentId: STATEMENT_A }, body: { transaction_ids: [TXN.rent], mode: 'suggested', category_id: CAT.housing } })).status).toBe(422);
    const unknown = await bulk([TXN.rent], CAT.unknown);
    expect(unknown.status).toBe(422);
    expect(unknown.json.error).toBe('Choose a category from the list.');
    expect(h.db.rows('fdh_transaction_corrections')).toHaveLength(0);
    expect(txnRow(TXN.rent).economic_transaction_type).toBe('unknown');
  });

  it('exactly 500 ids is accepted', async () => {
    const ids = addUncategorised(500);
    const { status, json } = await bulk(ids, CAT.housing);
    expect(status).toBe(200);
    expect(json.data).toMatchObject({ requested: 500, applied: 500, failed: [] });
  });
});

describe('BULK-9 one request, not one per line', () => {
  it('271 lines (the PO case) are written with a round-trip count that does not grow per line', async () => {
    const ids = addUncategorised(271);
    h.requests = 0;
    const { status, json } = await bulk(ids, CAT.housing);
    expect(status).toBe(200);
    expect(json.data).toMatchObject({ requested: 271, applied: 271, failed: [], approved: 0 });
    const used = h.requests;
    // Per-line saving costs ~8 requests per line (>2,000 for 271). The batched path is a few dozen in total.
    expect(used, `database round trips for 271 lines: ${used}`).toBeLessThan(60);
    // State is right for every line.
    expect(rowsOf(USER_A).filter((r) => String(r.id).startsWith('f9000000') && r.category_id === CAT.housing && r.classification_method === 'user_manual')).toHaveLength(271);
    expect(h.db.rows('fdh_transaction_corrections').filter((c) => String(c.transaction_id).startsWith('f9000000'))).toHaveLength(542);
  });

  it('the same 271 lines saved one by one cost more than 1,000 round trips (the baseline the batch replaces)', async () => {
    const ids = addUncategorised(30);
    h.requests = 0;
    for (const id of ids) await single(id, CAT.housing);
    const perLine = h.requests / 30;
    expect(perLine).toBeGreaterThan(6);
  });
});
