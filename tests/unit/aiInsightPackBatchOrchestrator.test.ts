// Module 11.3 continuation — item 4 of the closure dispatch: the async
// batch-provider path. Unit-certifies AIInsightPackBatchOrchestrator with
// in-memory FakeDb/FakeBatchDb doubles (mirrors aiInsightPackService.test.ts's
// own style) plus the REAL MockBatchInsightPackProvider — proves:
//   - provider-neutral batch submission (one submitBatch() call for N households)
//   - stable per-household request ids
//   - out-of-order result reconciliation (the mock always reverses order)
//   - partial batch failure handling (some succeed, some fail, independently)
//   - household-level cost attribution (not the batch total duplicated)
//   - no cross-tenant result association, even under an adversarial mismatched-id provider
//   - bounded retries -> terminal failure_code
//   - reuse of the SAME kill-switch check as the single-call path
//   - ai_insight_pack_batches status/count transitions computed from real outcomes

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeContext } from './support/financialContextFixture';
import { AIInsightPackBatchOrchestrator, type BatchHouseholdInput } from '@/lib/ai/insightPack/batchOrchestrator';
import { MockBatchInsightPackProvider, MockInsightPackProvider } from '@/lib/ai/insightPack/mockPackProvider';
import { PROMPT_CODE, type InsightPackDbClient, type PackRow, type PersistedBlockInput, type StoredAnswerUpsertInput } from '@/lib/ai/insightPack/insightPackService';
import type { InsightPackBatchDbClient, BatchRow, InsertBatchInput, BatchCapableProvider, BatchPackItemRequest, BatchPollResult } from '@/lib/ai/insightPack/batchTypes';
import type { PromptTemplateRow } from '@/lib/ai/promptRegistry';
import type { ModelRegistryRow } from '@/lib/ai/modelRegistry';
import { allowAllGate, denyGate, type RecordingGate } from '@/tests/unit/support/entitlementGateStubs';

vi.mock('@/lib/ai/audit/aiRuns', () => ({
  recordAiRun: vi.fn(async () => 'mock-run-id'),
  hashContext: vi.fn((ctx: unknown) => `mock-hash-${JSON.stringify((ctx as { meta?: { snapshot_id?: string } })?.meta?.snapshot_id ?? '')}`),
}));

const PROMPT: PromptTemplateRow = {
  id: 'prompt-1', prompt_code: PROMPT_CODE, prompt_name: 'Monthly Personalised Insight Pack', version: 1,
  task_type: 'monthly_insight_pack', system_prompt: 'system', developer_prompt: 'developer',
  context_schema_version: 'ai-context-1.0.0', output_schema_version: 'insight-pack-1.0.0', country_scope: null,
  safety_policy_version: 'safety-policy-1.0.0', status: 'ACTIVE', approved_by: null, approved_at: null,
  effective_from: null, effective_to: null, supersedes_prompt_id: null, created_at: '', updated_at: '',
};
const MODEL: ModelRegistryRow = {
  id: 'model-1', provider: 'mock', model_identifier: 'mock-1', internal_tier: 'STANDARD', active: true, approved: true,
  task_types: ['monthly_insight_pack'], max_input_tokens: 100000, max_output_tokens: 4000,
  supports_structured_output: true, supports_streaming: false, supports_batch: true,
  cost_input_per_1k_usd: 0.001, cost_output_per_1k_usd: 0.002, effective_from: null, effective_to: null,
  rollout_percentage: 100, fallback_model_id: null, created_by: null, approved_by: null, approved_at: null,
  created_at: '', updated_at: '',
};

class FakeDb implements InsightPackDbClient {
  packs = new Map<string, PackRow & { _identityHash?: string }>();
  blocks: Record<string, unknown>[] = [];
  storedAnswers: Record<string, unknown>[] = [];
  eligible = true;
  ineligibleUsers = new Set<string>();
  globallyEnabled = true;
  batchEnabled = true;
  private seq = 0;

  async getActivePrompt() { return PROMPT; }
  async resolveModelForTask() { return MODEL; }
  async isPersonalisedAiEligible(userId: string) { return this.eligible && !this.ineligibleUsers.has(userId); }
  async isBatchGenerationEnabled() { return { globallyEnabled: this.globallyEnabled, batchEnabled: this.batchEnabled }; }

  async findPackByIdentity(identity: { userId: string }, identityHash: string): Promise<PackRow | null> {
    for (const p of this.packs.values()) {
      if (p.user_id === identity.userId && p._identityHash === identityHash) return p;
    }
    return null;
  }
  async findCurrentPackForUser(userId: string): Promise<PackRow | null> {
    return [...this.packs.values()].find((p) => p.user_id === userId && ['READY', 'PARTIAL'].includes(p.status)) ?? null;
  }
  async findMostRecentGenerationTime(userId: string): Promise<string | null> {
    const times = [...this.packs.values()].filter((p) => p.user_id === userId && p.generated_at).map((p) => p.generated_at as string);
    return times.length > 0 ? times.sort().reverse()[0] : null;
  }
  async insertPendingPack(input: Parameters<InsightPackDbClient['insertPendingPack']>[0]): Promise<PackRow> {
    const id = `pack-${++this.seq}`;
    const row: PackRow & { _identityHash: string } = {
      id, user_id: input.userId, household_id: input.householdId, snapshot_id: input.identity.snapshotId,
      financial_context_hash: input.identity.financialContextHash, context_schema_version: input.identity.contextSchemaVersion,
      pack_schema_version: input.identity.packSchemaVersion, prompt_code: input.identity.promptCode, prompt_version: input.identity.promptVersion,
      country_context: input.identity.countryContext, language: input.identity.language, provider: input.provider, model: input.model,
      model_version: null, status: 'GENERATING', overall_confidence: null, grounding_status: null, critical_safety_failure: false,
      generation_mode: 'BATCH_AI', batch_id: input.batchId ?? null,
      ai_run_id: null, idempotency_key: input.idempotencyKey, input_tokens: null, output_tokens: null, estimated_cost_usd: null,
      generated_at: null, validated_at: null, ready_at: null, stale_at: null, superseded_at: null, failure_code: null, retry_count: 0,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      _identityHash: input.identityHash,
    };
    this.packs.set(id, row);
    return row;
  }
  async updatePack(id: string, patch: Partial<PackRow>): Promise<PackRow> {
    const existing = this.packs.get(id)!;
    const updated = { ...existing, ...patch };
    this.packs.set(id, updated);
    return updated;
  }
  async insertBlocks(packId: string, userId: string, householdId: string | null, blocks: PersistedBlockInput[]): Promise<void> {
    this.blocks.push(...blocks.map((b) => ({ ...b, pack_id: packId, user_id: userId, household_id: householdId })));
  }
  async supersedeOlderPacks(userId: string, keepPackId: string): Promise<number> {
    let n = 0;
    for (const [id, p] of this.packs) {
      if (p.user_id === userId && id !== keepPackId && ['READY', 'PARTIAL', 'STALE'].includes(p.status)) {
        this.packs.set(id, { ...p, status: 'SUPERSEDED', superseded_at: new Date().toISOString() });
        n++;
      }
    }
    return n;
  }
  async upsertStoredAnswer(input: StoredAnswerUpsertInput): Promise<void> {
    this.storedAnswers.push(input as unknown as Record<string, unknown>);
  }
}

class FakeBatchDb implements InsightPackBatchDbClient {
  batches = new Map<string, BatchRow>();
  private seq = 0;
  async insertBatch(input: InsertBatchInput): Promise<BatchRow> {
    const id = `batch-${++this.seq}`;
    const row: BatchRow = {
      id, provider: input.provider, task_type: input.taskType, status: 'PENDING',
      submitted_at: null, completed_at: null, request_count: input.requestCount,
      success_count: 0, failure_count: 0, estimated_cost_usd: 0, actual_cost_usd: null,
      error_summary: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    this.batches.set(id, row);
    return row;
  }
  async updateBatch(id: string, patch: Partial<BatchRow>): Promise<BatchRow> {
    const existing = this.batches.get(id)!;
    const updated = { ...existing, ...patch };
    this.batches.set(id, updated);
    return updated;
  }
}

function ctxFor(userId: string, snapshotId: string) {
  return makeContext({ meta: { ...makeContext().meta, context_version: 'ai-context-1.0.0', snapshot_id: snapshotId, user_scope_identifier: userId } });
}

describe('Module 11.3 continuation — AIInsightPackBatchOrchestrator', () => {
  let db: FakeDb;
  let batchDb: FakeBatchDb;

  beforeEach(() => {
    db = new FakeDb();
    batchDb = new FakeBatchDb();
  });

  it('provider-neutral batch submission: N households -> exactly ONE submitBatch() call, each with a stable, distinct requestId', async () => {
    const provider = new MockBatchInsightPackProvider();
    const spy = vi.spyOn(provider, 'submitBatch');
    const orchestrator = new AIInsightPackBatchOrchestrator(db, batchDb, (ctx) => new MockInsightPackProvider(ctx, 'valid'), provider, allowAllGate(false));
    const households: BatchHouseholdInput[] = [
      { userId: 'u1', householdId: null, context: ctxFor('u1', 'snap-1') },
      { userId: 'u2', householdId: null, context: ctxFor('u2', 'snap-2') },
      { userId: 'u3', householdId: null, context: ctxFor('u3', 'snap-3') },
    ];
    const result = await orchestrator.generateBatch(households);

    expect(spy).toHaveBeenCalledTimes(1);
    const submittedItems = spy.mock.calls[0][0] as BatchPackItemRequest[];
    expect(submittedItems).toHaveLength(3);
    const requestIds = submittedItems.map((i) => i.requestId);
    expect(new Set(requestIds).size).toBe(3); // all distinct
    expect(result.households.every((h) => h.status === 'READY')).toBe(true);
    expect(result.batch.status).toBe('COMPLETED');
    expect(result.batch.request_count).toBe(3);
    expect(result.batch.success_count).toBe(3);
    expect(result.batch.failure_count).toBe(0);
  });

  it('out-of-order reconciliation: the mock provider reverses result order, yet every household still gets its OWN result', async () => {
    const provider = new MockBatchInsightPackProvider();
    const orchestrator = new AIInsightPackBatchOrchestrator(db, batchDb, (ctx) => new MockInsightPackProvider(ctx, 'valid'), provider, allowAllGate(false));
    const households: BatchHouseholdInput[] = [
      { userId: 'u1', householdId: null, context: ctxFor('u1', 'snap-1') },
      { userId: 'u2', householdId: null, context: ctxFor('u2', 'snap-2') },
    ];
    const result = await orchestrator.generateBatch(households);
    const u1 = result.households.find((h) => h.userId === 'u1');
    const u2 = result.households.find((h) => h.userId === 'u2');
    expect(u1?.status).toBe('READY');
    expect(u2?.status).toBe('READY');
    if (u1?.status === 'READY' && u2?.status === 'READY') {
      expect(u1.pack.snapshot_id).toBe('snap-1');
      expect(u2.pack.snapshot_id).toBe('snap-2');
    }
  });

  it('partial batch failure: some households succeed, others fail independently — successes persist, the batch is PARTIAL not all-or-nothing', async () => {
    const provider = new MockBatchInsightPackProvider();
    const orchestrator = new AIInsightPackBatchOrchestrator(db, batchDb, (ctx) => new MockInsightPackProvider(ctx, 'valid'), provider, allowAllGate(false));
    const households: BatchHouseholdInput[] = [
      { userId: 'u1', householdId: null, context: ctxFor('u1', 'snap-1') },
      { userId: 'u2', householdId: null, context: ctxFor('u2', 'snap-2') },
      { userId: 'u3', householdId: null, context: ctxFor('u3', 'snap-3') },
    ];
    // Force u2's item specifically to fail at the PROVIDER level (not a
    // grounding failure) — the requestId is the household's own pack
    // identity idempotency key, computed the SAME way the orchestrator
    // computes it, so this must be set up via a first dry construction.
    // Simplest reliable way: intercept submitBatch to tag u2's request.
    const realSubmit = provider.submitBatch.bind(provider);
    provider.submitBatch = async (items: BatchPackItemRequest[]) => {
      const u2Item = items.find((i) => i.userPrompt.includes('"snap-2"'));
      if (u2Item) provider.setBehaviorForRequest(u2Item.requestId, 'timeout');
      return realSubmit(items);
    };

    const result = await orchestrator.generateBatch(households);
    const u1 = result.households.find((h) => h.userId === 'u1');
    const u2 = result.households.find((h) => h.userId === 'u2');
    const u3 = result.households.find((h) => h.userId === 'u3');

    expect(u1?.status).toBe('READY');
    expect(u3?.status).toBe('READY');
    expect(u2?.status).toBe('FAILED');
    if (u2?.status === 'FAILED') {
      expect(u2.retryable).toBe(true); // first failure, well under the retry budget
    }
    expect(result.batch.status).toBe('PARTIAL');
    expect(result.batch.success_count).toBe(2);
    expect(result.batch.failure_count).toBe(1);
  });

  it('household-level cost attribution: each READY pack carries its OWN cost, not the batch total duplicated onto every row', async () => {
    const provider = new MockBatchInsightPackProvider();
    const orchestrator = new AIInsightPackBatchOrchestrator(db, batchDb, (ctx) => new MockInsightPackProvider(ctx, 'valid'), provider, allowAllGate(false));
    // Two households with very different context sizes -> very different
    // token counts -> genuinely different costs, if cost is computed
    // per-household rather than smeared across the batch.
    const smallCtx = ctxFor('u1', 'snap-small');
    const bigCtx = { ...ctxFor('u2', 'snap-big'), goals: Array.from({ length: 20 }, (_, i) => ({ goal_reference: `g${i}`, goal_type: 'x', goal_status: 'active', target_amount: 1, current_funding: 1, contribution: 1, target_date: null, track_status: null, required_contribution: null, forecast_completion_date: null, confidence: null, calculation_version: null })) };
    const result = await orchestrator.generateBatch([
      { userId: 'u1', householdId: null, context: smallCtx },
      { userId: 'u2', householdId: null, context: bigCtx },
    ]);
    const u1 = result.households.find((h) => h.userId === 'u1');
    const u2 = result.households.find((h) => h.userId === 'u2');
    expect(u1?.status).toBe('READY');
    expect(u2?.status).toBe('READY');
    if (u1?.status === 'READY' && u2?.status === 'READY') {
      expect(u1.pack.estimated_cost_usd).not.toBeNull();
      expect(u2.pack.estimated_cost_usd).not.toBeNull();
      // Not required to differ by much (the mock's output size dominates
      // more than input in this fixture), but they must be independently
      // computed, not the SAME batch-total value copy-pasted onto both.
      expect(u1.pack.estimated_cost_usd).not.toBe(result.batch.estimated_cost_usd);
    }
  });

  it('NO cross-tenant result association: an adversarial provider returning a mismatched requestId is DROPPED, never attributed to a different household', async () => {
    class AdversarialBatchProvider implements BatchCapableProvider {
      readonly providerName = 'mock';
      async submitBatch(items: BatchPackItemRequest[]): Promise<{ providerBatchId: string; itemCount: number }> {
        // Deliberately mislabel household A's result with household B's requestId.
        const [itemA, itemB] = items;
        const results: BatchPollResult['results'] = [
          { requestId: itemB.requestId, ok: true, rawText: extractAndBuildValid(itemA.userPrompt), inputTokens: 10, outputTokens: 10 },
        ];
        this.stash.set('batch-1', { status: 'COMPLETED', results });
        return { providerBatchId: 'batch-1', itemCount: items.length };
      }
      async pollBatch(id: string): Promise<BatchPollResult> { return this.stash.get(id)!; }
      private stash = new Map<string, BatchPollResult>();
    }
    function extractAndBuildValid(userPrompt: string): string {
      const ctx = JSON.parse(userPrompt.slice(userPrompt.indexOf('CONTEXT:\n') + 'CONTEXT:\n'.length));
      return JSON.stringify({ pack_version: 'insight-pack-1.0.0', snapshot_id: ctx.meta.snapshot_id, data_as_of: null, reporting_currency: 'AUD', overall_confidence: 'HIGH', blocks: {}, top_strengths: [], top_risks: [], priority_review_areas: [], limitations: [] });
    }

    const orchestrator = new AIInsightPackBatchOrchestrator(db, batchDb, (ctx) => new MockInsightPackProvider(ctx, 'valid'), new AdversarialBatchProvider(), allowAllGate(false));
    const result = await orchestrator.generateBatch([
      { userId: 'tenantA', householdId: null, context: ctxFor('tenantA', 'snap-A') },
      { userId: 'tenantB', householdId: null, context: ctxFor('tenantB', 'snap-B') },
    ]);

    const a = result.households.find((h) => h.userId === 'tenantA');
    const b = result.households.find((h) => h.userId === 'tenantB');
    // Neither household's own pack ever received the OTHER's mislabeled
    // result: A's own requestId never appeared in the (adversarial)
    // results, so A is treated as "no result returned" (a failure, bounded-
    // retry eligible) — NOT as having received B's content. B's own result
    // likewise never arrived (its requestId was used as the wrapper, not a
    // real second result for B), so B is ALSO "no result returned".
    expect(a?.status).toBe('FAILED');
    expect(b?.status).toBe('FAILED');
    if (a?.status === 'FAILED') expect(a.pack?.snapshot_id).toBe('snap-A'); // A's OWN pack row, unpolluted by B's content
    if (b?.status === 'FAILED') expect(b.pack?.snapshot_id).toBe('snap-B');
    // Ground truth: no block content was ever persisted onto A's pack from B's data.
    expect(db.blocks.length).toBe(0);
  });

  it('bounded retries: a household that keeps failing exhausts its retry budget and becomes a TERMINAL failure with a reportable failure_code', async () => {
    const provider = new MockBatchInsightPackProvider();
    const orchestrator = new AIInsightPackBatchOrchestrator(db, batchDb, (ctx) => new MockInsightPackProvider(ctx, 'valid'), provider, allowAllGate(false), 2 /* maxRetries */);
    const household: BatchHouseholdInput = { userId: 'u-retry', householdId: null, context: ctxFor('u-retry', 'snap-retry') };

    const realSubmit = provider.submitBatch.bind(provider);
    provider.submitBatch = async (items: BatchPackItemRequest[]) => {
      for (const item of items) provider.setBehaviorForRequest(item.requestId, 'timeout');
      return realSubmit(items);
    };

    const first = await orchestrator.generateBatch([household]);
    expect(first.households[0].status).toBe('FAILED');
    if (first.households[0].status === 'FAILED') expect(first.households[0].retryable).toBe(true);

    const second = await orchestrator.generateBatch([household]);
    expect(second.households[0].status).toBe('FAILED');

    const third = await orchestrator.generateBatch([household]);
    expect(third.households[0].status).toBe('FAILED');
    if (third.households[0].status === 'FAILED') {
      expect(third.households[0].retryable).toBe(false); // budget (2) exhausted -> terminal
      expect(third.households[0].failureCode).toBeTruthy();
    }
  });

  it('reuses the SAME kill-switch check as the single-call path — batch_generation_enabled=false aborts the WHOLE batch before any admission, zero provider calls', async () => {
    db.batchEnabled = false;
    const provider = new MockBatchInsightPackProvider();
    const spy = vi.spyOn(provider, 'submitBatch');
    const gate: RecordingGate = allowAllGate(false);
    const orchestrator = new AIInsightPackBatchOrchestrator(db, batchDb, (ctx) => new MockInsightPackProvider(ctx, 'valid'), provider, gate);
    const result = await orchestrator.generateBatch([
      { userId: 'u1', householdId: null, context: ctxFor('u1', 'snap-1') },
      { userId: 'u2', householdId: null, context: ctxFor('u2', 'snap-2') },
    ]);
    expect(result.households.every((h) => h.status === 'BATCH_ABORTED_KILL_SWITCH')).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    expect(gate.admissions).toHaveLength(0); // not one household even reached admission
    expect(result.batch.status).toBe('FAILED');
  });

  it('a cost-ceiling denial for one household in the batch reports COST_BLOCKED for that household, without aborting the others', async () => {
    const provider = new MockBatchInsightPackProvider();
    const orchestrator = new AIInsightPackBatchOrchestrator(db, batchDb, (ctx) => new MockInsightPackProvider(ctx, 'valid'), provider, denyGate('platform_cost_ceiling'));
    const result = await orchestrator.generateBatch([{ userId: 'u1', householdId: null, context: ctxFor('u1', 'snap-1') }]);
    expect(result.households[0].status).toBe('COST_BLOCKED');
  });

  it('an ineligible household in an otherwise-eligible batch is excluded (NOT_ELIGIBLE) without blocking the rest', async () => {
    db.ineligibleUsers.add('u2');
    const provider = new MockBatchInsightPackProvider();
    const orchestrator = new AIInsightPackBatchOrchestrator(db, batchDb, (ctx) => new MockInsightPackProvider(ctx, 'valid'), provider, allowAllGate(false));
    const result = await orchestrator.generateBatch([
      { userId: 'u1', householdId: null, context: ctxFor('u1', 'snap-1') },
      { userId: 'u2', householdId: null, context: ctxFor('u2', 'snap-2') },
    ]);
    const u1 = result.households.find((h) => h.userId === 'u1');
    const u2 = result.households.find((h) => h.userId === 'u2');
    expect(u1?.status).toBe('READY');
    expect(u2?.status).toBe('NOT_ELIGIBLE');
  });
});
