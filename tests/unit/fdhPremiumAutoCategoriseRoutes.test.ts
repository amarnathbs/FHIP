/**
 * Premium automatic categorisation (PO 05-11-2026) -- route-level proof against the in-memory database that enforces RLS and the approval guard.
 * Synthetic data only. The AI part is off here (its own gates are pinned in fdhPremiumAutoCategorise.test.ts); this file pins the HTTP contract:
 * sign-in required, another person's statement is a 404, the post-approval hook runs only when lines were newly approved, Undo's 409, and that what
 * the run approved is exactly what reaches Monthly Surplus.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- assertions read raw JSON route payloads */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, type FakeDb } from '../support/fdhFakeSupabase';
import { CAT, STATEMENT_A, STATEMENT_B, TXN, USER_A, USER_B, seedAll } from '../support/fdhCategoryReviewFixture';

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb, user: null as { id: string } | null, hook: vi.fn(async () => []) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.db.sessionClient(h.user!.id) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.db.adminClient() }));
vi.mock('@/lib/ai/access/premiumAiAccess', async (importOriginal) => (await import('../support/premiumAiAccessMock')).premiumAiAccessModule(await importOriginal()));
vi.mock('@/lib/financial-data-hub/services/purge', () => ({ scheduleApprovedDocumentPurge: vi.fn(async () => undefined) }));
vi.mock('@/app/api/financial-data-hub/documents/postBankApprovalHook', () => ({ runPostBankApprovalHook: h.hook }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requireCountryConfirmedUser: async () =>
    h.user ? { user: h.user } : { user: null, unauthenticated: Response.json({ error: 'unauthenticated' }, { status: 401 }) },
}));
vi.setConfig({ testTimeout: 30000 });

import { premiumAi } from '../support/premiumAiAccessMock';

const AUTO = '@/app/api/financial-data-hub/documents/[documentId]/category-review/auto-categorise/route';
const UNDO = '@/app/api/financial-data-hub/documents/[documentId]/category-review/auto-categorise/undo/route';

async function call(mod: string, method: 'GET' | 'POST', documentId = STATEMENT_A): Promise<{ status: number; json: any }> {
  const route = await import(mod);
  const res: Response = await route[method](
    new Request('http://local/x', { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined }),
    { params: Promise.resolve({ documentId }) },
  );
  return { status: res.status, json: await res.json() };
}

const txns = (userId: string) => h.db.rows('fdh_transactions').filter((r) => r.user_id === userId);

beforeEach(() => {
  h.db = createFakeDb();
  seedAll(h.db);
  h.user = { id: USER_A };
  h.hook.mockClear();
  premiumAi.reset();
  process.env.AIE_BANK_AUTO_CATEGORISE_ENABLED = 'true';
  delete process.env.AIE_BANK_CATEGORISE_AI_ENABLED; // the AI part is off: only the rules and the fixed answers
  h.db.insert('fdh_subcategories', { id: 'b0000000-0000-4000-8000-0000000000a1', category_id: CAT.income, subcategory_key: 'other_income', display_name: 'Other Income', active: true, display_order: 90 });
});

describe('sign-in and ownership', () => {
  it('signed out: 401 on all three routes, nothing written', async () => {
    h.user = null;
    const before = JSON.stringify(h.db.rows('fdh_transactions'));
    expect((await call(AUTO, 'GET')).status).toBe(401);
    expect((await call(AUTO, 'POST')).status).toBe(401);
    expect((await call(UNDO, 'POST')).status).toBe(401);
    expect(JSON.stringify(h.db.rows('fdh_transactions'))).toBe(before);
  });

  it("another person's statement: 404 on all three routes, and their lines are untouched", async () => {
    const before = JSON.stringify(txns(USER_B));
    expect((await call(AUTO, 'GET', STATEMENT_B)).status).toBe(404);
    expect((await call(AUTO, 'POST', STATEMENT_B)).status).toBe(404);
    expect((await call(UNDO, 'POST', STATEMENT_B)).status).toBe(404);
    expect(JSON.stringify(txns(USER_B))).toBe(before);
  });
});

describe('the contract', () => {
  it('GET says eligible; POST runs it and calls the post-approval hook once; a second POST does nothing and does not call it', async () => {
    const state = await call(AUTO, 'GET');
    expect(state.json.data).toMatchObject({ enabled: true, eligible: true, summary: null });
    const run = await call(AUTO, 'POST');
    expect(run.status).toBe(200);
    expect(run.json.data.status).toBe('done');
    expect(run.json.data.summary.approved_lines).toBeGreaterThan(0);
    expect(h.hook).toHaveBeenCalledTimes(1);
    expect(h.hook).toHaveBeenCalledWith(USER_A, STATEMENT_A, 'category_approve_group');
    const again = await call(AUTO, 'POST');
    expect(again.json.data.status).toBe('already_ran');
    expect(h.hook).toHaveBeenCalledTimes(1);
    expect((await call(AUTO, 'GET')).json.data).toMatchObject({ eligible: false, summary: { approved_lines: run.json.data.summary.approved_lines } });
  });

  it('flag off or a Free plan: POST changes nothing and does not call the hook', async () => {
    delete process.env.AIE_BANK_AUTO_CATEGORISE_ENABLED;
    expect((await call(AUTO, 'POST')).json.data.status).toBe('disabled');
    process.env.AIE_BANK_AUTO_CATEGORISE_ENABLED = 'true';
    premiumAi.setTier(USER_A, 'free');
    expect((await call(AUTO, 'POST')).json.data.status).toBe('premium_required');
    expect(h.db.rows('fdh_transactions').filter((r) => r.approval_status === 'approved')).toHaveLength(0);
    expect(h.hook).not.toHaveBeenCalled();
  });

  it('Undo with nothing to undo is a 409 with a plain reason; after a run it succeeds and the lines wait again', async () => {
    const nothing = await call(UNDO, 'POST');
    expect(nothing.status).toBe(409);
    expect(nothing.json.error).toMatch(/no automatic|nothing/i);
    await call(AUTO, 'POST');
    const undone = await call(UNDO, 'POST');
    expect(undone.status).toBe(200);
    expect(txns(USER_A).filter((r) => r.approval_status === 'approved')).toHaveLength(0);
  });

  it('what the run approved is exactly what reaches Monthly Surplus; the line only the AI could place is not in the figures', async () => {
    await call(AUTO, 'POST');
    const { BANK_INCOME_TRANSACTION_TYPES } = await import('@/lib/services/dashboardData');
    const approved = txns(USER_A).filter((r) => r.approval_status === 'approved');
    const income = approved
      .filter((r) => (BANK_INCOME_TRANSACTION_TYPES as readonly string[]).includes(String(r.economic_transaction_type)))
      .reduce((s, r) => s + Number(r.amount_original), 0);
    expect(income).toBe(3700); // the two unidentified credits, filed as Other Income
    expect(h.db.rows('fdh_transactions').find((r) => r.id === TXN.rent)).toMatchObject({ approval_status: 'pending', economic_transaction_type: 'unknown' });
  });
});
