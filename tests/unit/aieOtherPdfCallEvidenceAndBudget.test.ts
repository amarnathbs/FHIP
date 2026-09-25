// AIE other-PDF AI proof (2026-09-25) -- call evidence and output budget at
// the real gateway boundary. Written to FAIL on origin/main 8b6692c:
//
//   1. The four statement adapters (bank, liability, retirement, AU
//      investment) share `requestAdapterDocumentFacts`, which returned no
//      model / request id / token count -- nothing per document recorded which
//      metered OpenAI call produced a draft.
//   2. The Investment Intelligence whole-document extraction asked for the
//      512-token SCALAR output budget, although a statement with positions
//      and their transaction ledgers is a line-item document. A realistic one
//      is cut off mid-JSON and billed as a failure.
//
// The gateway class is replaced by a capturing fake: no provider is called.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { calls, nextResult } = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  nextResult: { current: {} as Record<string, unknown> },
}));
vi.mock('@/lib/aie/provider/gateway', () => ({
  AieDocumentAiGateway: class {
    async requestFieldCompletion(req: Record<string, unknown>) {
      calls.push(req);
      return nextResult.current;
    }
  },
}));
vi.mock('@/lib/aie/provider/providerFactory', () => ({ createAieAiProvider: () => ({}) }));
vi.mock('@/lib/aie/cost/costAdmission', () => ({ reserveConservativeAiCost: vi.fn(), settleAiCost: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order', 'limit']) b[m] = () => b;
      b.maybeSingle = () => Promise.resolve({ data: null, error: null });
      return b;
    },
  }),
}));

beforeEach(() => {
  calls.length = 0;
  delete process.env.AIE_AI_MAX_OUTPUT_TOKENS_LINE_ITEMS;
  delete process.env.AIE_AI_MAX_OUTPUT_TOKENS;
});

describe('shared adapter gateway returns call evidence', () => {
  it('a refused call still reports the model, the per-attempt cost key, the OpenAI request ids and the tokens it was billed for', async () => {
    nextResult.current = { outcome: 'refused', providerRequestIds: ['req_synthetic_refused'], inputTokens: 1500, outputTokens: 20 };
    const { requestBankStatementAiExtraction } = await import('@/lib/aie/adapters/bankStatement/gateway');
    const out = await requestBankStatementAiExtraction({ maskedText: 'synthetic masked text', requestId: 'doc-1' });
    expect(out.outcome).toBe('refused');
    expect(out.evidence).toBeDefined();
    expect(out.evidence!.providerRequestIds).toEqual(['req_synthetic_refused']);
    expect(out.evidence!.inputTokens).toBe(1500);
    expect(out.evidence!.outputTokens).toBe(20);
    expect(out.evidence!.model).toBe('gpt-4o-mini');
    expect(out.evidence!.idempotencyKey).toMatch(/^bank-statement-ai-fallback:doc-1:/);
    expect(out.evidence!.idempotencyKey).toBe(calls[0].idempotencyKey);
  });
});

describe('Investment Intelligence whole-document extraction', () => {
  it('asks for the LINE-ITEM output budget, and a billed failure keeps its evidence', async () => {
    process.env.II_AI_FALLBACK_ENABLED = 'true';
    delete process.env.II_AI_FALLBACK_PILOT_COHORT_ENFORCED;
    nextResult.current = { outcome: 'schema_rejected', providerRequestIds: ['req_synthetic_ii'], inputTokens: 3000, outputTokens: 512 };
    const { getAiFallbackDocumentExtraction } = await import('@/lib/services/investment-intelligence/aiFallbackDocumentExtraction');
    const { getAieAiMaxOutputTokensPerLineItemDocument } = await import('@/lib/aie/config');
    const outcome = await getAiFallbackDocumentExtraction({
      userId: 'u-1', sourceDocumentId: 'd-1', parseRunId: null, triggerReason: 'format_unrecognized',
      request: { maskedDocumentText: 'synthetic masked CAS text' },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].maxOutputTokens).toBe(getAieAiMaxOutputTokensPerLineItemDocument());
    expect(calls[0].maxOutputTokens).toBeGreaterThan(512);
    expect(outcome.outcome).toBe('still_failed');
    const evidence = (outcome as { evidence?: { providerRequestIds: string[]; outputTokens?: number } }).evidence;
    expect(evidence?.providerRequestIds).toEqual(['req_synthetic_ii']);
    expect(evidence?.outputTokens).toBe(512);
    delete process.env.II_AI_FALLBACK_ENABLED;
  });
});
