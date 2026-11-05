/**
 * Premium AUTOMATIC categorisation (PO 05-11-2026): the statement is categorised and counted without an approval step; the person edits or undoes.
 * Real services, the real gates and the real approval path run against the in-memory database that enforces RLS; the provider and the cost ledger are
 * doubles. Synthetic payees only.
 *
 * Pinned here: gated by the flag AND Premium (nothing written, nothing sent otherwise); the AI sees only masked, digit-free BUSINESS wording (never a
 * person-to-person line, never money in); the AI always answers (a low-confidence guess is kept, "unknown" becomes Other spending); fixed answers for
 * people and unidentified credits; the lines that need a person (large amount) are never approved; audit says 'system'; one run per statement; Undo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, type FakeDb } from '../support/fdhFakeSupabase';
import { CAT, STATEMENT_A, STATEMENT_B, TXN, USER_A, seedAll } from '../support/fdhCategoryReviewFixture';

const h = vi.hoisted(() => {
  const state = {
    db: null as unknown as FakeDb,
    prompts: [] as string[],
    reply: ((): string => '{"items":[]}') as () => string,
    reserve: ((): { admitted: boolean; reservedUsd: number; refusalReason?: string } => ({ admitted: true, reservedUsd: 0.01 })) as () => { admitted: boolean; reservedUsd: number; refusalReason?: string },
    calls: 0,
  };
  const fakeProvider = {
    providerName: 'fake',
    generateStructured: async (req: { userPrompt: string; systemPrompt: string }) => {
      state.calls += 1;
      state.prompts.push(req.userPrompt);
      return { rawText: state.reply(), inputTokens: 1400, outputTokens: 900, latencyMs: 1, modelVersion: 'fake', finishReason: 'stop' as const, providerRequestIds: ['req_synthetic'] };
    },
    validateProviderHealth: async () => ({}) as never,
    estimateCost: () => ({}) as never,
  };
  return { state, fakeProvider };
});
vi.mock('@/lib/ai/access/premiumAiAccess', async (importOriginal) => (await import('../support/premiumAiAccessMock')).premiumAiAccessModule(await importOriginal()));
vi.mock('@/lib/aie/provider/providerFactory', () => ({ createAieAiProvider: () => h.fakeProvider, createLazyAieAiProvider: () => h.fakeProvider }));
vi.mock('@/lib/aie/cost/costAdmission', () => ({ reserveConservativeAiCost: async () => h.state.reserve(), settleAiCost: async () => undefined }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.state.db.sessionClient(USER_A) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.state.db.adminClient() }));
vi.mock('@/lib/financial-data-hub/services/purge', () => ({ scheduleApprovedDocumentPurge: vi.fn(async () => undefined) }));
vi.setConfig({ testTimeout: 60000 });

import { premiumAi } from '../support/premiumAiAccessMock';

const PEOPLE_CAT = 'c0000000-0000-4000-8000-0000000000a1';
const OTHER_INCOME_SUB = 'b0000000-0000-4000-8000-0000000000a1';
const CAFES = ['f9000000-0000-4000-8000-000000000001', 'f9000000-0000-4000-8000-000000000002', 'f9000000-0000-4000-8000-000000000003'];
const PERSON = 'f9000000-0000-4000-8000-000000000004';
const BIG = 'f9000000-0000-4000-8000-000000000005';
const MYSTERY = 'f9000000-0000-4000-8000-000000000006';

const rows = () => h.state.db.rows('fdh_transactions');
const row = (id: string) => rows().find((r) => r.id === id)!;
const events = () => h.state.db.rows('fdh_document_audit_events');
const sourceOf = (e: { metadata?: unknown }) => (e.metadata as { source?: string } | null)?.source;

function addLine(id: string, description: string, amount: number, cd: 'credit' | 'debit', over: Record<string, unknown> = {}) {
  const base = row(TXN.rent);
  h.state.db.insert('fdh_transactions', { ...base, id, description_clean: description, description_raw: description, amount_original: amount, credit_debit: cd, ...over });
}

/** Answers by what the prompt shows, so the test does not depend on the order of the payees. */
function replyByWording() {
  h.state.reply = () => {
    const shown = (h.state.prompts.at(-1) ?? '').split('\n').filter((l) => /^p\d+:/.test(l));
    return JSON.stringify({
      items: shown.map((l) => {
        const key = l.split(':')[0];
        const text = l.slice(key.length + 1);
        if (/ZAMBEZI/.test(text)) return { key, categoryKey: 'food', confidence: 'high' };
        if (/MYSTERY/.test(text)) return { key, categoryKey: 'housing', confidence: 'low' }; // a low-confidence GUESS
        return { key, categoryKey: 'unknown', confidence: 'low' }; // "I cannot tell"
      }),
    });
  };
}

beforeEach(() => {
  h.state.db = createFakeDb();
  seedAll(h.state.db);
  h.state.prompts.length = 0;
  h.state.calls = 0;
  h.state.reserve = () => ({ admitted: true, reservedUsd: 0.01 });
  premiumAi.reset();
  process.env.AIE_BANK_AUTO_CATEGORISE_ENABLED = 'true';
  process.env.AIE_BANK_CATEGORISE_AI_ENABLED = 'true';
  process.env.AIE_AI_FALLBACK_ENABLED = 'true';
  process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = 'e5'.repeat(32);
  h.state.db.insert('fdh_categories', { id: PEOPLE_CAT, category_key: 'payments_to_people', display_name: 'Payments to People', economic_type: 'expense', active: true });
  h.state.db.insert('fdh_subcategories', { id: OTHER_INCOME_SUB, category_id: CAT.income, subcategory_key: 'other_income', display_name: 'Other Income', active: true, display_order: 90 });
  for (const [i, id] of CAFES.entries()) addLine(id, `VISA-ZAMBEZI GRILL 4411 DEER PARK AU#${i}(Ref.7700${i})`, 20 + i, 'debit');
  addLine(PERSON, 'Osko Payment To Jordan Smith Account 987654321 WBC Ref#Gift', 77, 'debit');
  addLine(MYSTERY, 'VISA-MYSTERY WORKSHOP BROADMEADOWS', 140, 'debit');
  // A rule's proposal at the large-amount threshold: the manual review lists it on its own, and the automatic run must leave it alone.
  addLine(BIG, 'BIG SHOP PTY LTD', 6000, 'debit', { economic_transaction_type: 'expense', category_id: CAT.housing, classification_method: 'global_rule', classification_confidence: 0.6 });
  replyByWording();
});

describe('the gates: nothing is written or sent unless the flag is on AND the person is Premium', () => {
  it('flag OFF (the default): nothing happens, nothing is sent, no marker is written', async () => {
    delete process.env.AIE_BANK_AUTO_CATEGORISE_ENABLED;
    const { runAutoCategorise, getAutoCategoriseState } = await import('@/lib/financial-data-hub/services/premiumAutoCategoriseService');
    const before = JSON.stringify(rows());
    expect(await runAutoCategorise(USER_A, STATEMENT_A)).toMatchObject({ status: 'disabled' });
    expect(await getAutoCategoriseState(USER_A, STATEMENT_A)).toEqual({ enabled: false, eligible: false, summary: null });
    process.env.AIE_BANK_AUTO_CATEGORISE_ENABLED = '1'; // only the literal 'true' switches it on
    expect((await runAutoCategorise(USER_A, STATEMENT_A)).status).toBe('disabled');
    expect(h.state.calls).toBe(0);
    expect(JSON.stringify(rows())).toBe(before);
    expect(events()).toHaveLength(0);
  });

  it('a Free, lapsed or unreadable plan: refused, not eligible, nothing written, the AI is never called', async () => {
    const { runAutoCategorise, getAutoCategoriseState } = await import('@/lib/financial-data-hub/services/premiumAutoCategoriseService');
    const before = JSON.stringify(rows());
    for (const tier of ['free', 'expired', 'unavailable'] as const) {
      premiumAi.setTier(USER_A, tier);
      expect(await runAutoCategorise(USER_A, STATEMENT_A)).toMatchObject({ status: 'premium_required' });
      expect(await getAutoCategoriseState(USER_A, STATEMENT_A)).toMatchObject({ enabled: true, eligible: false });
    }
    expect(h.state.calls).toBe(0);
    expect(JSON.stringify(rows())).toBe(before);
  });

  it("another person's statement is not found, and nothing is touched", async () => {
    const { runAutoCategorise } = await import('@/lib/financial-data-hub/services/premiumAutoCategoriseService');
    await expect(runAutoCategorise(USER_A, STATEMENT_B)).rejects.toMatchObject({ code: 'not_found' });
    expect(h.state.calls).toBe(0);
  });
});

describe('the run', () => {
  it('categorises and counts every line that can be, sends only masked business wording, and leaves the large amount for the person', async () => {
    const { runAutoCategorise } = await import('@/lib/financial-data-hub/services/premiumAutoCategoriseService');
    const result = await runAutoCategorise(USER_A, STATEMENT_A);
    expect(result.status).toBe('done');

    // What left the process: business wording, no digit, no person, no credit.
    const sent = h.state.prompts.join('\n');
    expect(h.state.calls).toBe(1);
    expect(sent).toMatch(/ZAMBEZI GRILL/);
    expect(sent).toMatch(/MYSTERY WORKSHOP/);
    expect(sent.replace(/^p\d+:/gm, '')).not.toMatch(/\d/);
    expect(sent).not.toMatch(/Jordan|Smith|Osko|Gift|QUILLFEATHER|SAVINGS|BIG SHOP/i);

    // The AI always answered: a confident answer, a low-confidence guess kept, and "unknown" filed as Other spending (counted, visible).
    for (const id of CAFES) expect(row(id)).toMatchObject({ economic_transaction_type: 'expense', category_id: CAT.food, classification_method: 'ai', approval_status: 'approved' });
    expect(row(MYSTERY)).toMatchObject({ economic_transaction_type: 'expense', category_id: CAT.housing, classification_method: 'ai', approval_status: 'approved' });
    expect(row(TXN.rent)).toMatchObject({ economic_transaction_type: 'expense', category_id: null, classification_method: 'ai', approval_status: 'approved' });

    // Fixed answers for what the AI may never see.
    expect(row(PERSON)).toMatchObject({ economic_transaction_type: 'expense', category_id: PEOPLE_CAT, classification_method: 'global_rule', approval_status: 'approved' });
    for (const id of [TXN.salary1, TXN.salary2]) expect(row(id)).toMatchObject({ economic_transaction_type: 'income', category_id: CAT.income, subcategory_id: OTHER_INCOME_SUB, approval_status: 'approved' });
    expect(row(TXN.toSavings)).toMatchObject({ economic_transaction_type: 'transfer', category_id: CAT.transfer, approval_status: 'approved' }); // the review's own suggestion

    // Lines the rules already placed are approved too.
    for (const id of [TXN.energy, TXN.groceries, TXN.cash, TXN.fee]) expect(row(id).approval_status).toBe('approved');

    // The large proposed amount is NOT approved: it is the manual review's "needs your decision" line, and it waits.
    expect(row(BIG).approval_status).toBe('pending');
    const { getStatementCategoryReview } = await import('@/lib/financial-data-hub/services/categoryReviewService');
    const review = await getStatementCategoryReview(USER_A, STATEMENT_A);
    expect(review.needs_decision.map((i) => [i.id, i.reason])).toEqual([[BIG, 'large_amount']]);

    expect(result.summary).toMatchObject({ approved_lines: 13, left_for_you: 1, statement_finalised: false, placed_by_ai: 4, guessed_by_ai: 1, other_spending_lines: 1, placed_by_fixed_answer: 4 });
    expect(result.summary!.income_lines + result.summary!.spending_lines + result.summary!.not_counted_lines + result.summary!.other_lines).toBe(13);
  });

  it('is recorded as automatic: the approvals say system, there is a started marker and one completion event with counts and no payee', async () => {
    const { runAutoCategorise } = await import('@/lib/financial-data-hub/services/premiumAutoCategoriseService');
    await runAutoCategorise(USER_A, STATEMENT_A);
    const approvals = events().filter((e) => e.event_type === 'transaction_approved');
    expect(approvals).toHaveLength(13);
    expect(approvals.every((e) => e.actor_type === 'system')).toBe(true);
    const started = events().filter((e) => e.event_type === 'transaction_classification_run' && sourceOf(e) === 'premium_auto_categorise');
    const completed = events().filter((e) => e.event_type === 'bulk_review_action_completed' && sourceOf(e) === 'premium_auto_categorise');
    expect(started).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(completed[0].actor_type).toBe('system');
    expect(JSON.stringify(completed[0].metadata)).not.toMatch(/ZAMBEZI|MYSTERY|Jordan|Quillfeather|Realty/i);
  });

  it('the AI step refused (kill switch off): the rules and the fixed answers are still counted; the lines only the AI could place are NOT approved', async () => {
    process.env.AIE_AI_FALLBACK_ENABLED = 'false';
    const { runAutoCategorise } = await import('@/lib/financial-data-hub/services/premiumAutoCategoriseService');
    const result = await runAutoCategorise(USER_A, STATEMENT_A);
    expect(h.state.calls).toBe(0);
    expect(result.status).toBe('done');
    expect(result.ai).toMatchObject({ status: 'refused' });
    for (const id of [...CAFES, MYSTERY, TXN.rent]) expect(row(id)).toMatchObject({ economic_transaction_type: 'unknown', approval_status: 'pending' });
    for (const id of [PERSON, TXN.salary1, TXN.energy]) expect(row(id).approval_status).toBe('approved');
    expect(result.summary!.left_for_you).toBe(6); // 5 the AI could not be asked about + the large amount
  });

  it('runs ONCE per statement: a second call (a second tab, a reload) does nothing and sends nothing', async () => {
    const { runAutoCategorise } = await import('@/lib/financial-data-hub/services/premiumAutoCategoriseService');
    await runAutoCategorise(USER_A, STATEMENT_A);
    const calls = h.state.calls;
    const snapshot = JSON.stringify(rows());
    expect(await runAutoCategorise(USER_A, STATEMENT_A)).toMatchObject({ status: 'already_ran' });
    expect(h.state.calls).toBe(calls);
    expect(JSON.stringify(rows())).toBe(snapshot);
  });

  it('the daily AI cap stops the AI part only: the run still counts what the rules and the fixed answers placed', async () => {
    h.state.reserve = () => ({ admitted: false, reservedUsd: 0, refusalReason: 'user_daily_cap' });
    const { runAutoCategorise } = await import('@/lib/financial-data-hub/services/premiumAutoCategoriseService');
    const result = await runAutoCategorise(USER_A, STATEMENT_A);
    expect(result.status).toBe('done');
    expect(row(PERSON).approval_status).toBe('approved');
    expect(row(CAFES[0])).toMatchObject({ economic_transaction_type: 'unknown', approval_status: 'pending' });
  });
});

describe('the banner state and Undo', () => {
  it('after a run the screen gets the counts and is no longer eligible; the person is Premium so they are shown', async () => {
    const { runAutoCategorise, getAutoCategoriseState } = await import('@/lib/financial-data-hub/services/premiumAutoCategoriseService');
    expect(await getAutoCategoriseState(USER_A, STATEMENT_A)).toMatchObject({ enabled: true, eligible: true, summary: null });
    await runAutoCategorise(USER_A, STATEMENT_A);
    expect(await getAutoCategoriseState(USER_A, STATEMENT_A)).toMatchObject({ enabled: true, eligible: false, summary: { approved_lines: 13 } });
  });

  it('Undo withdraws every approval, keeps every category, hides the banner, and the run does NOT start again by itself', async () => {
    const { runAutoCategorise, undoAutoCategorise, getAutoCategoriseState } = await import('@/lib/financial-data-hub/services/premiumAutoCategoriseService');
    await runAutoCategorise(USER_A, STATEMENT_A);
    const categoriesBefore = rows().map((r) => [r.id, r.category_id, r.economic_transaction_type].join('|')).sort();
    expect(await undoAutoCategorise(USER_A, STATEMENT_A)).toMatchObject({ reverted: 13 });
    expect(rows().filter((r) => r.approval_status === 'approved')).toHaveLength(0);
    expect(rows().map((r) => [r.id, r.category_id, r.economic_transaction_type].join('|')).sort()).toEqual(categoriesBefore);
    expect(await getAutoCategoriseState(USER_A, STATEMENT_A)).toMatchObject({ eligible: false, summary: null });
    const calls = h.state.calls;
    const { runAutoCategorise: again } = await import('@/lib/financial-data-hub/services/premiumAutoCategoriseService');
    expect(await again(USER_A, STATEMENT_A)).toMatchObject({ status: 'already_ran' });
    expect(h.state.calls).toBe(calls);
    expect(events().filter((e) => sourceOf(e) === 'premium_auto_categorise_undo')).toHaveLength(1);
  });

  it('after Undo the person edits and approves exactly as in the manual flow', async () => {
    const { runAutoCategorise, undoAutoCategorise } = await import('@/lib/financial-data-hub/services/premiumAutoCategoriseService');
    await runAutoCategorise(USER_A, STATEMENT_A);
    await undoAutoCategorise(USER_A, STATEMENT_A);
    const { setTransactionCategory } = await import('@/lib/financial-data-hub/services/categoryReviewService');
    const saved = await setTransactionCategory(USER_A, PERSON, { category_id: CAT.food });
    expect(saved).toMatchObject({ category_id: CAT.food, classification_method: 'user_manual' });
    expect(row(PERSON)).toMatchObject({ category_id: CAT.food, approval_status: 'pending' });
  });

  it('a completed statement is reopened through the existing reopen, and Undo with nothing to undo is refused', async () => {
    const { runAutoCategorise, undoAutoCategorise } = await import('@/lib/financial-data-hub/services/premiumAutoCategoriseService');
    await expect(undoAutoCategorise(USER_A, STATEMENT_A)).rejects.toMatchObject({ code: 'invalid_state' });
    // Make the whole statement approvable: the large proposal becomes the person's own decision.
    Object.assign(row(BIG), { user_override: true, classification_method: 'user_manual', review_status: 'resolved' });
    const result = await runAutoCategorise(USER_A, STATEMENT_A);
    expect(result.summary).toMatchObject({ left_for_you: 0, statement_finalised: true });
    expect(h.state.db.rows('fdh_statement_uploads').find((s) => s.id === STATEMENT_A)!.approved_by).toBe(USER_A);
    await undoAutoCategorise(USER_A, STATEMENT_A);
    expect(h.state.db.rows('fdh_statement_uploads').find((s) => s.id === STATEMENT_A)!.approved_by).toBeNull();
    expect(events().some((e) => e.event_type === 'statement_reopened')).toBe(true);
    expect(rows().filter((r) => r.user_id === USER_A && r.approval_status === 'approved')).toHaveLength(0);
  });

  it('Undo still works with the flag off or the plan lapsed: a person can always take automatic lines back', async () => {
    const { runAutoCategorise, undoAutoCategorise } = await import('@/lib/financial-data-hub/services/premiumAutoCategoriseService');
    await runAutoCategorise(USER_A, STATEMENT_A);
    delete process.env.AIE_BANK_AUTO_CATEGORISE_ENABLED;
    premiumAi.setTier(USER_A, 'expired');
    expect(await undoAutoCategorise(USER_A, STATEMENT_A)).toMatchObject({ reverted: 13 });
  });
});
