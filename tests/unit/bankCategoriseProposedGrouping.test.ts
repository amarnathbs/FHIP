/**
 * Proposed categories ride inside their category total (PO 29-10-2026: "more than 200 needing approval is ridiculous").
 *
 * The safety model is unchanged and pinned here: nothing counts until the person approves; approval is per category total; a proposed group of
 * transfers needs an explicit "I checked these lines"; a large proposed amount, an uncategorised line, a line whose pending link DISAGREES with
 * its category, and a duplicate still need the person on their own. Synthetic data only.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- assertions read raw JSON route payloads */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildCategoryReview,
  isLargeAmount,
  LARGE_AMOUNT_THRESHOLD_DEFAULT,
  type CategoryReviewBlockers,
  type CategoryReviewTransaction,
} from '@/lib/financial-data-hub/domain/categoryReview';
import { createFakeDb, type FakeDb } from '../support/fdhFakeSupabase';
import { CAT, STATEMENT_A, TXN, USER_A, seedAll } from '../support/fdhCategoryReviewFixture';

const CATEGORIES = [
  { id: 'c-food', category_key: 'food', display_name: 'Food', economic_type: 'expense' },
  { id: 'c-xfer', category_key: 'transfer_own_account', display_name: 'Own-Account Transfer', economic_type: 'transfer' },
  { id: 'c-ccpay', category_key: 'credit_card_payment', display_name: 'Credit-Card Payment', economic_type: 'transfer' },
];

function line(over: Partial<CategoryReviewTransaction> & { id: string }): CategoryReviewTransaction {
  return {
    transaction_date: '2026-10-05', description_clean: 'Synthetic payee', amount_original: 40, currency_original: 'AUD', credit_debit: 'debit',
    economic_transaction_type: 'expense', category_id: 'c-food', classification_method: 'global_rule', classification_confidence: 0.6, user_override: false,
    review_status: 'not_required', approval_status: 'pending', dedup_status: 'unique', ...over,
  };
}

function blockers(links: Record<string, string[]> = {}): CategoryReviewBlockers {
  return {
    pendingLinkTypesByTxn: new Map(Object.entries(links)),
    pendingDuplicateTxnIds: new Set(), blockingReviewItemTxnIds: new Set(), invalidSplitTxnIds: new Set(),
  };
}

describe('buildCategoryReview: proposed lines', () => {
  it('a MEDIUM line is a PROPOSED member of its category total, not an item the person must open', () => {
    const r = buildCategoryReview([line({ id: 'a' }), line({ id: 'b' }), line({ id: 'c', classification_method: 'merchant_master', classification_confidence: 1 })], CATEGORIES, blockers());
    expect(r.counts.needs_decision).toBe(0);
    const g = r.groups[0];
    expect(g.count).toBe(3);
    expect(g.proposed_count).toBe(2);
    expect(g.requires_acknowledgement).toBe(false); // an ordinary spending group is approved by one click, as before
    expect(g.lines.filter((l) => l.proposed).map((l) => l.id)).toEqual(['a', 'b']);
    expect(g.fully_confident).toBe(false);
  });
  it('a line a person decided, or a verified merchant, is never marked proposed', () => {
    const r = buildCategoryReview(
      [line({ id: 'a', classification_method: 'user_manual', classification_confidence: 1, user_override: true }), line({ id: 'b', classification_method: 'merchant_master', classification_confidence: 1 })],
      CATEGORIES,
      blockers(),
    );
    expect(r.groups[0].proposed_count).toBe(0);
    expect(r.groups[0].lines.every((l) => !l.proposed)).toBe(true);
  });
});

describe('buildCategoryReview: transfers keep their extra checks', () => {
  const xfer = (id: string, over: Partial<CategoryReviewTransaction> = {}) =>
    line({ id, economic_transaction_type: 'transfer', category_id: 'c-xfer', description_clean: 'Osko Payment To (own account)', ...over });

  it('a proposed own-account transfer whose pending link AGREES rides in its group, and the group needs the acknowledgement', () => {
    const r = buildCategoryReview([xfer('a'), xfer('b')], CATEGORIES, blockers({ a: ['internal_transfer'], b: ['internal_transfer'] }));
    expect(r.counts.needs_decision).toBe(0);
    expect(r.groups[0]).toMatchObject({ count: 2, proposed_count: 2, requires_acknowledgement: true, counts_toward: 'not_counted' });
  });
  it('NEGATIVE: a pending link that DISAGREES with the category (a purchase with a settlement link) is listed on its own', () => {
    const r = buildCategoryReview([line({ id: 'p' })], CATEGORIES, blockers({ p: ['credit_card_settlement'] }));
    expect(r.needs_decision.map((i) => [i.id, i.reason])).toEqual([['p', 'transfer_check']]);
    expect(r.groups).toHaveLength(0);
  });
  it('NEGATIVE: an uncategorised line with a transfer link, and a low-confidence transfer, are listed on their own', () => {
    const unknown = line({ id: 'u', economic_transaction_type: 'unknown', category_id: null, classification_method: 'unclassified', classification_confidence: 0 });
    const low = xfer('l', { classification_confidence: 0.3 });
    const r = buildCategoryReview([unknown, low], CATEGORIES, blockers({ u: ['internal_transfer'], l: ['internal_transfer'] }));
    expect(r.needs_decision.map((i) => i.id).sort()).toEqual(['l', 'u']);
    expect(r.groups).toHaveLength(0);
  });
  it('NEGATIVE: a duplicate, a refund link and a blocking review item are never absorbed into a group', () => {
    const dup = xfer('d');
    const b: CategoryReviewBlockers = { ...blockers({ r: ['refund_original'] }), pendingDuplicateTxnIds: new Set(['d']), blockingReviewItemTxnIds: new Set(['x']) };
    const r = buildCategoryReview([dup, line({ id: 'r' }), line({ id: 'x' })], CATEGORIES, b);
    expect(r.needs_decision.map((i) => [i.id, i.reason]).sort()).toEqual([['d', 'possible_duplicate'], ['r', 'refund_check'], ['x', 'other_check']]);
  });
  it('NEGATIVE control: the OLD behaviour (any transfer link lists the line) is exactly what this test would see if the agreement rule were removed', () => {
    // A compatible link must NOT list the line; an incompatible one must. If the agreement check were dropped both would list, and the first
    // test of this describe block (needs_decision === 0) would fail.
    const compatible = buildCategoryReview([xfer('a')], CATEGORIES, blockers({ a: ['internal_transfer'] }));
    const incompatible = buildCategoryReview([line({ id: 'a' })], CATEGORIES, blockers({ a: ['internal_transfer'] }));
    expect(compatible.needs_decision).toHaveLength(0);
    expect(incompatible.needs_decision).toHaveLength(1);
  });
});

describe('buildCategoryReview: large amounts', () => {
  it('a PROPOSED line at or above the threshold is listed on its own, with the category pre-selected', () => {
    expect(isLargeAmount(LARGE_AMOUNT_THRESHOLD_DEFAULT, 'AUD')).toBe(true);
    expect(isLargeAmount(LARGE_AMOUNT_THRESHOLD_DEFAULT - 0.01, 'AUD')).toBe(false);
    expect(isLargeAmount(LARGE_AMOUNT_THRESHOLD_DEFAULT, 'INR')).toBe(false); // INR has its own, larger threshold
    const r = buildCategoryReview([line({ id: 'big', amount_original: 7200 }), line({ id: 'small', amount_original: 4999.99 })], CATEGORIES, blockers());
    expect(r.needs_decision).toHaveLength(1);
    expect(r.needs_decision[0]).toMatchObject({ id: 'big', reason: 'large_amount', can_choose_category: true, suggested_category_id: 'c-food' });
    expect(r.groups[0].count).toBe(1);
  });
  it('NEGATIVE: a large line the person decided, or a verified merchant matched, is not re-asked', () => {
    const r = buildCategoryReview(
      [line({ id: 'u', amount_original: 9000, classification_method: 'user_manual', classification_confidence: 1, user_override: true }), line({ id: 'm', amount_original: 9000, classification_method: 'merchant_master', classification_confidence: 1 })],
      CATEGORIES,
      blockers(),
    );
    expect(r.needs_decision).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// Route level: approving a proposed transfer total
// ---------------------------------------------------------------------------------------------------------------------------------------

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.db.sessionClient('a0000000-0000-4000-8000-00000000000a') }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.db.adminClient() }));
vi.mock('@/lib/financial-data-hub/services/purge', () => ({ scheduleApprovedDocumentPurge: vi.fn(async () => undefined) }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requireCountryConfirmedUser: async () => ({ user: { id: 'a0000000-0000-4000-8000-00000000000a' } }),
}));
vi.setConfig({ testTimeout: 30000 });

async function call(mod: string, method: 'GET' | 'POST', opts: { params?: Record<string, string>; body?: unknown } = {}) {
  const route = await import(mod);
  const req = new Request('http://local/x', { method, headers: { 'Content-Type': 'application/json' }, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const res: Response = await route[method](req, { params: Promise.resolve(opts.params ?? {}) });
  return { status: res.status, json: await res.json() as any };
}
const REVIEW = '@/app/api/financial-data-hub/documents/[documentId]/category-review/route';
const APPROVE_GROUP = '@/app/api/financial-data-hub/documents/[documentId]/category-review/approve-group/route';
const txnRow = (id: string) => h.db.rows('fdh_transactions').find((r) => r.id === id)!;

describe('approving a PROPOSED transfer total (route level)', () => {
  beforeEach(() => {
    h.db = createFakeDb();
    seedAll(h.db);
    // The state the new engine leaves for "Linked Acc Trns To Savings": classed as an own-account transfer by a rule (MEDIUM), with the engine's
    // own pending "is this a transfer?" link on it.
    Object.assign(txnRow(TXN.toSavings), { economic_transaction_type: 'transfer', category_id: CAT.transfer, classification_method: 'global_rule', classification_confidence: 0.6 });
    h.db.insert('fdh_transaction_links', { id: 'l-1', user_id: USER_A, transaction_id_from: TXN.toSavings, transaction_id_to: null, link_type: 'internal_transfer', status: 'pending', confidence: 0.3, created_by_method: 'algorithm', user_confirmed: false });
  });
  const groupKey = async () => ((await call(REVIEW, 'GET', { params: { documentId: STATEMENT_A } })).json.data.groups.find((g: any) => g.label === 'Own-Account Transfer')).group_key as string;

  it('the line is in its group (not in the decision list) and the group asks for the acknowledgement', async () => {
    const data = (await call(REVIEW, 'GET', { params: { documentId: STATEMENT_A } })).json.data;
    expect(data.needs_decision.some((i: any) => i.id === TXN.toSavings)).toBe(false);
    const g = data.groups.find((x: any) => x.label === 'Own-Account Transfer');
    expect(g).toMatchObject({ requires_acknowledgement: true, proposed_count: 1, pending_count: 1 });
  });
  it('approving without the acknowledgement is refused and changes NOTHING (line, link and statement)', async () => {
    const res = await call(APPROVE_GROUP, 'POST', { params: { documentId: STATEMENT_A }, body: { group_key: await groupKey() } });
    expect(res.status).toBe(422);
    expect(res.json.error).toMatch(/tick the box/i);
    expect(txnRow(TXN.toSavings).approval_status).toBe('pending');
    expect(h.db.rows('fdh_transaction_links')[0].status).toBe('pending');
    // the acknowledgement must be a real true, not a truthy string
    const sloppy = await call(APPROVE_GROUP, 'POST', { params: { documentId: STATEMENT_A }, body: { group_key: await groupKey(), acknowledge_proposed: 'yes' } });
    expect(sloppy.status).toBe(422);
    expect(txnRow(TXN.toSavings).approval_status).toBe('pending');
  });
  it('with the acknowledgement it settles the agreeing link, approves exactly that line, and nothing else', async () => {
    const res = await call(APPROVE_GROUP, 'POST', { params: { documentId: STATEMENT_A }, body: { group_key: await groupKey(), acknowledge_proposed: true } });
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ outcome: 'approved', approved: 1, failed: 0 });
    expect(h.db.rows('fdh_transaction_links')[0]).toMatchObject({ status: 'confirmed', user_confirmed: true });
    expect(h.db.rows('fdh_transactions').filter((r) => r.approval_status === 'approved').map((r) => r.id)).toEqual([TXN.toSavings]);
  });
  it('an ordinary proposed spending group still approves with one click (no acknowledgement needed)', async () => {
    const data = (await call(REVIEW, 'GET', { params: { documentId: STATEMENT_A } })).json.data;
    const fees = data.groups.find((x: any) => x.label === 'Bank & Financial Fees');
    expect(fees).toMatchObject({ proposed_count: 1, requires_acknowledgement: false });
    const res = await call(APPROVE_GROUP, 'POST', { params: { documentId: STATEMENT_A }, body: { group_key: fees.group_key } });
    expect(res.status).toBe(200);
  });
});
