/**
 * Optional Premium AI categorisation of the lines the rules could not classify (29-10-2026). UNIT-TESTED with a STUB provider: no network,
 * no live OpenAI call. The shared gateway, the shared pre-egress gate (masking, Premium, kill switch), the strict schema, the answer rules and the
 * proposal write are the REAL code; the provider, the cost ledger and the database are doubles. Synthetic payees only.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- rows and JSON payloads are raw */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, type FakeDb } from '../support/fdhFakeSupabase';
import { CAT, STATEMENT_A, TXN, USER_A, seedAll } from '../support/fdhCategoryReviewFixture';

const h = vi.hoisted(() => {
  const state = {
    db: null as unknown as FakeDb,
    prompts: [] as string[],
    systemPrompts: [] as string[],
    reply: ((): string => '{"items":[]}') as () => string,
    reserve: ((): { admitted: boolean; reservedUsd: number; refusalReason?: string } => ({ admitted: true, reservedUsd: 0.01 })) as () => { admitted: boolean; reservedUsd: number; refusalReason?: string },
    calls: 0,
  };
  const fakeProvider = {
    providerName: 'fake',
    generateStructured: async (req: { userPrompt: string; systemPrompt: string }) => {
      state.calls += 1;
      state.prompts.push(req.userPrompt);
      state.systemPrompts.push(req.systemPrompt);
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
vi.mock('@/lib/api', async (importOriginal) => ({ ...(await importOriginal<object>()), requireCountryConfirmedUser: async () => ({ user: { id: USER_A } }) }));
vi.setConfig({ testTimeout: 60000 });

import { premiumAi } from '../support/premiumAiAccessMock';
import {
  allowedAiCategories, buildAiBatches, estimateAiCostUsd, isAiCandidate, payeeTextForAi, resolveAiAnswer, evidenceTextForBatch, type AiCandidateLine,
} from '@/lib/financial-data-hub/domain/bankAiCategorise';
import { bankCategoriseAnswerSchema } from '@/lib/aie/adapters/bankCategorise/schema';
import { BANK_CATEGORISE_OPENAI_JSON_SCHEMA } from '@/lib/aie/adapters/bankCategorise/openaiSchema';
import { getKnownOpenAiJsonSchema } from '@/lib/aie/provider/openaiJsonSchema';
import { AIE_BANK_CATEGORISE_SCHEMA_NAME, AIE_BANK_CATEGORISE_SCHEMA_VERSION } from '@/lib/aie/adapters/bankCategorise/schema';

const FOOD = { id: 'c-food', category_key: 'food', display_name: 'Food & Dining', economic_type: 'expense' };
const HOUSING = { id: 'c-housing', category_key: 'housing', display_name: 'Housing', economic_type: 'expense' };
const INCOME = { id: 'c-income', category_key: 'income', display_name: 'Income', economic_type: 'income' };
const XFER = { id: 'c-xfer', category_key: 'transfer_own_account', display_name: 'Own-Account Transfer', economic_type: 'transfer' };
const ALLOWED = allowedAiCategories([FOOD, HOUSING, INCOME, XFER, { id: 'c-unk', category_key: 'unknown', display_name: 'Unknown', economic_type: 'unknown' }]);

const line = (id: string, description: string, over: Partial<AiCandidateLine> = {}): AiCandidateLine => ({
  id, description, direction: 'out', reason: 'uncategorised', currentCategoryId: null, suggestedCategoryId: null, ...over,
});

describe('payee text and eligibility (pure)', () => {
  it('removes every digit run, the card wrapper, references, e-mails and URLs', () => {
    expect(payeeTextForAi('VISA-SQ *COLOR ERA BAKERY Deer Park AU#12345(Ref.99887766) Apple Pay')).toBe('SQ COLOR ERA BAKERY DEER PARK');
    expect(payeeTextForAi('POS #4411-HARRY FRESH MARKET KEILOR DOWNS AU')).toBe('HARRY FRESH MARKET KEILOR DOWNS AU');
    expect(payeeTextForAi('Direct Debit Acme Gym Pty Ltd 0455 123 456 acme@example.com Ref:99XX')).toBe('DIRECT DEBIT ACME GYM PTY LTD');
    const t = payeeTextForAi('INTERNET BPAY TO SOMEBODY - BILLER CODE 123456 - RECEIPT NO 99887766')!;
    expect(t).not.toMatch(/\d/);
  });
  it('NEGATIVE: person-to-person and transfer narratives are NEVER sent; neither is a line with nothing left to read', () => {
    for (const d of ['Osko Payment To Jordan Smith Account 123456789 WBC Ref#Rent', 'OSKO to Taylor Green Ref-Gift', 'PayID payment to a.b@example.com', 'Transfer to SAV 12345678', 'Received from SAV 12345678', 'TFR from ***91S31.2 MOB']) {
      expect(payeeTextForAi(d), d).toBeNull();
    }
    expect(payeeTextForAi('12345 6789')).toBeNull();
    expect(payeeTextForAi('')).toBeNull();
    expect(payeeTextForAi(null)).toBeNull();
  });
  it('only unresolved money OUT with no category and no suggestion is a candidate', () => {
    expect(isAiCandidate(line('a', 'VISA-SOME NEW CAFE'))).toBe(true);
    expect(isAiCandidate(line('a', 'VISA-SOME NEW CAFE', { direction: 'in' }))).toBe(false); // money in is never an AI question
    expect(isAiCandidate(line('a', 'VISA-SOME NEW CAFE', { reason: 'transfer_check' }))).toBe(false);
    expect(isAiCandidate(line('a', 'VISA-SOME NEW CAFE', { reason: 'large_amount' }))).toBe(false);
    expect(isAiCandidate(line('a', 'VISA-SOME NEW CAFE', { currentCategoryId: 'x' }))).toBe(false);
    expect(isAiCandidate(line('a', 'Linked Acc Trns To Savings', { suggestedCategoryId: 'c-xfer' }))).toBe(false);
  });
  it('the closed list is spending, fee and tax categories: never income, transfer, loan, retirement, investment, cash, refund or unknown', () => {
    expect(ALLOWED.map((c) => c.key).sort()).toEqual(['food', 'housing']);
    const all = allowedAiCategories([
      { id: '1', category_key: 'government_tax', display_name: 'Tax', economic_type: 'tax' },
      { id: '2', category_key: 'financial_fees', display_name: 'Fees', economic_type: 'fee' },
      ...['income', 'transfer_own_account', 'loan_principal', 'retirement_contribution', 'investment_purchase', 'cash_withdrawal', 'refund_reversal', 'loan_interest'].map((k, i) => ({ id: `x${i}`, category_key: k, display_name: k, economic_type: k === 'income' ? 'income' : k === 'transfer_own_account' ? 'transfer' : k === 'loan_principal' ? 'debt_principal' : k === 'loan_interest' ? 'debt_interest' : k === 'retirement_contribution' ? 'investment' : k === 'investment_purchase' ? 'asset_purchase' : k === 'cash_withdrawal' ? 'cash_withdrawal' : 'refund' })),
    ]);
    expect(all.map((c) => c.key).sort()).toEqual(['financial_fees', 'government_tax']);
  });
});

describe('batching and dedupe (pure)', () => {
  it('25 payments to the same payee are ONE question; identical text from different numbers collapses', () => {
    const lines = Array.from({ length: 25 }, (_, i) => line(`t${i}`, `VISA-SOME NEW CAFE ${1000 + i} MELBOURNE AU#${i}(Ref.${i})`));
    const batches = buildAiBatches(lines);
    expect(batches).toHaveLength(1);
    expect(batches[0].payees).toHaveLength(1);
    expect([...batches[0].idsByText.values()][0]).toHaveLength(25);
  });
  it('distinct payees are split into batches of at most 40 (85 -> 3 calls), most repeated payee first', () => {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const distinct = (i: number) => `VISA-${letters[i % 26]}${letters[Math.floor(i / 26) % 26]}${letters[Math.floor(i / 676)]} TRADING`; // 85 different names
    const lines = Array.from({ length: 85 }, (_, i) => line(`t${i}`, distinct(i)));
    lines.push(line('rep1', distinct(84)), line('rep2', distinct(84)));
    const batches = buildAiBatches(lines);
    expect(batches.map((b) => b.payees.length)).toEqual([40, 40, 5]);
    expect(batches[0].payees[0].text).toBe(payeeTextForAi(distinct(84)));
    expect(evidenceTextForBatch(batches[2]).split('\n')).toHaveLength(5);
  });
});

describe('accepting an answer (pure): anything not explicitly acceptable is unknown', () => {
  const batch = buildAiBatches([line('a', 'VISA-ALPHA CAFE'), line('b', 'VISA-BETA STORE'), line('c', 'VISA-GAMMA CO'), line('d', 'VISA-DELTA CO'), line('e', 'VISA-EPSILON CO'), line('f', 'VISA-ZETA CO')])[0];
  const key = (text: string) => batch.payees.find((p) => p.text.includes(text))!.key;
  it('accepts high/medium answers from the list; rejects not-in-list, unknown, low, missing and conflicting', () => {
    const answer = bankCategoriseAnswerSchema.parse({
      items: [
        { key: key('ALPHA'), categoryKey: 'food', confidence: 'high' },
        { key: key('BETA'), categoryKey: 'housing', confidence: 'medium' },
        { key: key('GAMMA'), categoryKey: 'income', confidence: 'high' }, // not in the offered list
        { key: key('DELTA'), categoryKey: 'unknown', confidence: 'low' },
        { key: key('EPSILON'), categoryKey: 'food', confidence: 'low' },
        { key: 'p99', categoryKey: 'food', confidence: 'high' }, // a key that was never shown is ignored
      ],
    });
    const r = resolveAiAnswer(answer, batch, ALLOWED);
    expect([...r.accepted.entries()].map(([t, c]) => [t, c.key]).sort()).toEqual([['ALPHA CAFE', 'food'], ['BETA STORE', 'housing']]);
    expect(Object.fromEntries(r.rejected)).toEqual({ 'GAMMA CO': 'not_in_list', 'DELTA CO': 'unknown_answer', 'EPSILON CO': 'low_confidence', 'ZETA CO': 'missing' });
    const dup = resolveAiAnswer(
      bankCategoriseAnswerSchema.parse({ items: [{ key: key('ALPHA'), categoryKey: 'food', confidence: 'high' }, { key: key('ALPHA'), categoryKey: 'housing', confidence: 'high' }] }),
      batch,
      ALLOWED,
    );
    expect(dup.rejected.get('ALPHA CAFE')).toBe('conflicting_duplicate');
  });
  it('the strict schema refuses extra fields, a bad key shape and an unlisted confidence; the OpenAI JSON schema is registered and in step with it', () => {
    expect(bankCategoriseAnswerSchema.safeParse({ items: [{ key: 'p1', categoryKey: 'food', confidence: 'certain' }] }).success).toBe(false);
    expect(bankCategoriseAnswerSchema.safeParse({ items: [{ key: 'payee 1', categoryKey: 'food', confidence: 'high' }] }).success).toBe(false);
    expect(bankCategoriseAnswerSchema.safeParse({ items: [{ key: 'p1', categoryKey: 'food', confidence: 'high', note: 'x' }] }).success).toBe(false);
    expect(getKnownOpenAiJsonSchema(AIE_BANK_CATEGORISE_SCHEMA_NAME, AIE_BANK_CATEGORISE_SCHEMA_VERSION)).toBeTruthy();
    const props = (BANK_CATEGORISE_OPENAI_JSON_SCHEMA as any).properties.items.items;
    expect(props.required).toEqual(['key', 'categoryKey', 'confidence']);
    expect(props.additionalProperties).toBe(false);
  });
  it('cost estimate: 300 lines of distinct payees (8 calls of ~1.4k in / ~0.9k out) cost well under one cent on a gpt-4o-mini class model', () => {
    const perCall = estimateAiCostUsd(1400, 900);
    expect(perCall).toBeCloseTo(0.00075, 5);
    expect(perCall * 8).toBeLessThan(0.01);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// The service, with a stub provider and the fake database
// ---------------------------------------------------------------------------------------------------------------------------------------

const txnRow = (id: string) => h.state.db.rows('fdh_transactions').find((r) => r.id === id)!;
const NEW_CAFE = ['f9000000-0000-4000-8000-000000000001', 'f9000000-0000-4000-8000-000000000002', 'f9000000-0000-4000-8000-000000000003'];
const STRANGER = 'f9000000-0000-4000-8000-000000000004';
const CREDIT = 'f9000000-0000-4000-8000-000000000005';

function addLine(id: string, description: string, amount: number, cd: 'credit' | 'debit') {
  const base = h.state.db.rows('fdh_transactions').find((r) => r.id === TXN.rent)!;
  h.state.db.insert('fdh_transactions', { ...base, id, description_clean: description, description_raw: description, amount_original: amount, credit_debit: cd });
}

function categoriesInDb() {
  // The fixture seeds categories with fixed ids; add the spending category the stub will answer with.
  expect(h.state.db.rows('fdh_categories').some((c) => c.category_key === 'housing')).toBe(true);
}

beforeEach(() => {
  h.state.db = createFakeDb();
  seedAll(h.state.db);
  h.state.prompts.length = 0;
  h.state.systemPrompts.length = 0;
  h.state.calls = 0;
  h.state.reserve = () => ({ admitted: true, reservedUsd: 0.01 });
  premiumAi.reset();
  process.env.AIE_AI_FALLBACK_ENABLED = 'true';
  process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = 'e5'.repeat(32);
  process.env.AIE_BANK_CATEGORISE_AI_ENABLED = 'true';
  addLine(NEW_CAFE[0], 'VISA-ZAMBEZI GRILL 4411 DEER PARK AU#1(Ref.77001)', 21.5, 'debit');
  addLine(NEW_CAFE[1], 'VISA-ZAMBEZI GRILL 4411 DEER PARK AU#2(Ref.77002)', 19.5, 'debit');
  addLine(NEW_CAFE[2], 'VISA-ZAMBEZI GRILL 4411 DEER PARK AU#3(Ref.77003)', 24, 'debit');
  addLine(STRANGER, 'Osko Payment To Jordan Smith Account 987654321 WBC Ref#Gift', 77, 'debit');
  addLine(CREDIT, 'VISA-REFUND ZAMBEZI GRILL', 12, 'credit');
  h.state.reply = () => JSON.stringify({ items: [{ key: 'p1', categoryKey: 'food', confidence: 'high' }, { key: 'p2', categoryKey: 'housing', confidence: 'medium' }] });
});

describe('aiCategoriseStatement with a stub provider', () => {
  it('flag OFF (the default): does nothing, calls nothing, writes nothing', async () => {
    delete process.env.AIE_BANK_CATEGORISE_AI_ENABLED;
    const { aiCategoriseStatement } = await import('@/lib/financial-data-hub/services/bankAiCategoriseService');
    const before = JSON.stringify(h.state.db.rows('fdh_transactions'));
    expect(await aiCategoriseStatement(USER_A, STATEMENT_A)).toMatchObject({ status: 'disabled', calls: 0 });
    expect(h.state.calls).toBe(0);
    expect(JSON.stringify(h.state.db.rows('fdh_transactions'))).toBe(before);
    process.env.AIE_BANK_CATEGORISE_AI_ENABLED = '1'; // only the literal 'true' switches it on
    expect((await aiCategoriseStatement(USER_A, STATEMENT_A)).status).toBe('disabled');
  });

  it('ONE call for the distinct payees; sends masked digit-free business wording only; writes PROPOSALS (method ai, MEDIUM, pending)', async () => {
    categoriesInDb();
    const { aiCategoriseStatement } = await import('@/lib/financial-data-hub/services/bankAiCategoriseService');
    const r = await aiCategoriseStatement(USER_A, STATEMENT_A);
    expect(r).toMatchObject({ status: 'done', calls: 1 });
    expect(h.state.calls).toBe(1);
    const sent = h.state.prompts.join('\n');
    expect(sent).toMatch(/ZAMBEZI GRILL/);
    expect(sent.replace(/^p\d+:/gm, '')).not.toMatch(/\d/); // no digit of any kind left the process (only the p1/p2 question keys)
    expect(sent).not.toMatch(/Jordan|Smith|Osko|Gift/i); // the person-to-person line was never sent
    expect(sent).not.toMatch(/REFUND/); // money in is never sent
    // 3 identical payees = 1 payee line in the prompt; plus the other unresolved business payee(s)
    expect(sent.split('\n').filter((l) => /ZAMBEZI GRILL/.test(l))).toHaveLength(1);
    // Which category the stub gave p1 depends on the payee order (most repeated first): the Zambezi payee is p1 -> food.
    for (const id of NEW_CAFE) {
      expect(txnRow(id)).toMatchObject({ economic_transaction_type: 'expense', category_id: CAT.food, classification_method: 'ai', classification_confidence: 0.6, approval_status: 'pending', review_status: expect.anything() });
    }
    expect(txnRow(STRANGER)).toMatchObject({ economic_transaction_type: 'unknown', category_id: null });
    expect(txnRow(CREDIT)).toMatchObject({ economic_transaction_type: 'unknown', category_id: null });
    expect(h.state.db.rows('fdh_transactions').filter((t) => t.approval_status === 'approved')).toHaveLength(0);
    expect(r.proposed_lines).toBeGreaterThanOrEqual(3);
    expect(r.estimated_cost_usd).toBeCloseTo((1400 * 0.15 + 900 * 0.6) / 1e6, 8);
    const hist = h.state.db.rows('fdh_classification_history').filter((x) => x.transaction_id === NEW_CAFE[0]);
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ classification_method: 'ai', changed_by_type: 'system', global_rule_id: null, user_rule_id: null });
  });

  it('NEGATIVE: an answer outside the list, "unknown", low confidence or a made-up key writes nothing', async () => {
    const { aiCategoriseStatement } = await import('@/lib/financial-data-hub/services/bankAiCategoriseService');
    for (const reply of [
      { items: [{ key: 'p1', categoryKey: 'income', confidence: 'high' }] },
      { items: [{ key: 'p1', categoryKey: 'definitely_a_new_category', confidence: 'high' }] },
      { items: [{ key: 'p1', categoryKey: 'unknown', confidence: 'low' }] },
      { items: [{ key: 'p1', categoryKey: 'food', confidence: 'low' }] },
      { items: [{ key: 'p77', categoryKey: 'food', confidence: 'high' }] },
    ]) {
      h.state.reply = () => JSON.stringify(reply);
      const r = await aiCategoriseStatement(USER_A, STATEMENT_A);
      expect(r.proposed_lines, JSON.stringify(reply)).toBe(0);
      expect(NEW_CAFE.every((id) => txnRow(id).economic_transaction_type === 'unknown')).toBe(true);
    }
  });

  it('NEGATIVE: a malformed answer (not the schema) is rejected as a whole and writes nothing', async () => {
    const { aiCategoriseStatement } = await import('@/lib/financial-data-hub/services/bankAiCategoriseService');
    h.state.reply = () => 'sure, here are the categories: food';
    const r = await aiCategoriseStatement(USER_A, STATEMENT_A);
    expect(r).toMatchObject({ status: 'stopped', proposed_lines: 0 });
    expect(NEW_CAFE.every((id) => txnRow(id).economic_transaction_type === 'unknown')).toBe(true);
  });

  it('NEGATIVE: never overwrites a decision made between the question and the write (the UPDATE itself is guarded)', async () => {
    const { recordAiProposals } = await import('@/lib/financial-data-hub/services/transactionClassificationService');
    Object.assign(txnRow(NEW_CAFE[0]), { economic_transaction_type: 'expense', category_id: CAT.housing, classification_method: 'user_manual', user_override: true });
    Object.assign(txnRow(NEW_CAFE[1]), { approval_status: 'approved' });
    const r = await recordAiProposals(USER_A, NEW_CAFE.map((id) => ({ transactionId: id, newEconomicType: 'expense' as const, newCategoryId: CAT.food })));
    expect(r.writtenIds).toEqual([NEW_CAFE[2]]);
    expect(r.skippedIds.sort()).toEqual([NEW_CAFE[0], NEW_CAFE[1]].sort());
    expect(txnRow(NEW_CAFE[0])).toMatchObject({ category_id: CAT.housing, classification_method: 'user_manual' });
  });

  it('Premium required: a Free or lapsed user is refused BEFORE any provider call, and nothing is written', async () => {
    const { aiCategoriseStatement } = await import('@/lib/financial-data-hub/services/bankAiCategoriseService');
    for (const tier of ['free', 'expired', 'unavailable'] as const) {
      premiumAi.setTier(USER_A, tier);
      const r = await aiCategoriseStatement(USER_A, STATEMENT_A);
      expect(r.status).toBe('refused');
      expect(['premium_required', 'entitlement_unavailable']).toContain(r.reason);
    }
    expect(h.state.calls).toBe(0);
    expect(NEW_CAFE.every((id) => txnRow(id).economic_transaction_type === 'unknown')).toBe(true);
  });

  it('kill switch: the shared AIE_AI_FALLBACK_ENABLED off stops it before any call', async () => {
    const { aiCategoriseStatement } = await import('@/lib/financial-data-hub/services/bankAiCategoriseService');
    process.env.AIE_AI_FALLBACK_ENABLED = 'false';
    expect(await aiCategoriseStatement(USER_A, STATEMENT_A)).toMatchObject({ status: 'refused', reason: 'global_kill_switch_disabled' });
    expect(h.state.calls).toBe(0);
  });

  it('per-user daily cap and the global $10 ledger stop the run; the provider is not called; nothing is written', async () => {
    const { aiCategoriseStatement } = await import('@/lib/financial-data-hub/services/bankAiCategoriseService');
    h.state.reserve = () => ({ admitted: false, reservedUsd: 0, refusalReason: 'user_daily_cap' });
    expect(await aiCategoriseStatement(USER_A, STATEMENT_A)).toMatchObject({ status: 'stopped', reason: 'user_daily_cap_reached', proposed_lines: 0 });
    h.state.reserve = () => ({ admitted: false, reservedUsd: 0, refusalReason: 'budget_exhausted' });
    expect(await aiCategoriseStatement(USER_A, STATEMENT_A)).toMatchObject({ status: 'stopped', reason: 'budget_exhausted' });
    expect(h.state.calls).toBe(0);
    expect(NEW_CAFE.every((id) => txnRow(id).economic_transaction_type === 'unknown')).toBe(true);
  });

  it('the proposals ride in a total that needs "I checked these lines"; approving remembers a payee ONLY when asked; a rule never auto-approves', async () => {
    const { aiCategoriseStatement } = await import('@/lib/financial-data-hub/services/bankAiCategoriseService');
    await aiCategoriseStatement(USER_A, STATEMENT_A);
    const { getStatementCategoryReview, approveCategoryGroup, CategoryReviewError } = await import('@/lib/financial-data-hub/services/categoryReviewService');
    const review = await getStatementCategoryReview(USER_A, STATEMENT_A);
    expect(review.needs_decision.some((i) => NEW_CAFE.includes(i.id))).toBe(false);
    const g = review.groups.find((x) => x.lines.some((l) => l.id === NEW_CAFE[0]))!;
    expect(g).toMatchObject({ ai_proposed_count: 3, requires_acknowledgement: true });
    expect(g.lines.filter((l) => NEW_CAFE.includes(l.id)).every((l) => l.proposed_by === 'ai')).toBe(true);
    // Not acknowledged: refused, nothing approved.
    await expect(approveCategoryGroup(USER_A, STATEMENT_A, g.group_key)).rejects.toBeInstanceOf(CategoryReviewError);
    expect(NEW_CAFE.every((id) => txnRow(id).approval_status === 'pending')).toBe(true);
    // Acknowledged but not asked to remember: approved, and NO personal rule is created.
    const ok = await approveCategoryGroup(USER_A, STATEMENT_A, g.group_key, { acknowledgeProposed: true });
    expect(ok.approved).toBeGreaterThanOrEqual(3);
    expect(h.state.db.rows('fdh_user_classification_rules')).toHaveLength(0);
  });

  it('remember_ai_payees on approval creates the person\'s own rule for the AI-proposed payee (and only then)', async () => {
    const { aiCategoriseStatement } = await import('@/lib/financial-data-hub/services/bankAiCategoriseService');
    await aiCategoriseStatement(USER_A, STATEMENT_A);
    const { getStatementCategoryReview, approveCategoryGroup } = await import('@/lib/financial-data-hub/services/categoryReviewService');
    const review = await getStatementCategoryReview(USER_A, STATEMENT_A);
    const g = review.groups.find((x) => x.lines.some((l) => l.id === NEW_CAFE[0]))!;
    await approveCategoryGroup(USER_A, STATEMENT_A, g.group_key, { acknowledgeProposed: true, rememberAiPayees: true });
    const rules = h.state.db.rows('fdh_user_classification_rules');
    expect(rules.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(rules)).toMatch(/ZAMBEZI GRILL/);
    expect(rules.every((r: any) => r.action_definition.category_id === CAT.food)).toBe(true);
  });
});
