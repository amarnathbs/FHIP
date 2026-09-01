// Module 11.3 — AIPersonalisedInsightPackService orchestration tests, using
// an in-memory InsightPackDbClient double (mirrors Module 11.2's own
// router.test.ts style of injecting plain fakes rather than a real DB).
// Proves: entitlement/kill-switch/certified-context gates, single-provider-
// call-per-pack, idempotency-reuse handling, grounding-driven READY/PARTIAL/
// FAILED outcomes, custom-quota non-consumption, and answer-store wiring —
// all WITHOUT a live database or a real provider.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeContext } from './support/financialContextFixture';
import { AIPersonalisedInsightPackService, PROMPT_CODE, type InsightPackDbClient, type PackRow, type PersistedBlockInput, type StoredAnswerUpsertInput } from '@/lib/ai/insightPack/insightPackService';
import { MockInsightPackProvider } from '@/lib/ai/insightPack/mockPackProvider';
import type { PromptTemplateRow } from '@/lib/ai/promptRegistry';
import type { ModelRegistryRow } from '@/lib/ai/modelRegistry';
import { allowAllGate, denyGate } from '@/tests/unit/support/entitlementGateStubs';

// Same pattern as tests/unit/aiMockProviderAndGateway.test.ts: recordAiRun
// hits a real DB via createAdminClient(), which this sandbox has no live
// project for. Mocked here for the same reason, at the same seam.
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
  packs = new Map<string, PackRow>();
  blocks: Record<string, unknown>[] = [];
  storedAnswers: Record<string, unknown>[] = [];
  eligible = true;
  globallyEnabled = true;
  batchEnabled = true;
  private seq = 0;

  async getActivePrompt() { return PROMPT; }
  async resolveModelForTask() { return MODEL; }
  async isPersonalisedAiEligible() { return this.eligible; }
  async isBatchGenerationEnabled() { return { globallyEnabled: this.globallyEnabled, batchEnabled: this.batchEnabled }; }

  async findPackByIdentity(identity: { userId: string }, identityHash: string): Promise<PackRow | null> {
    for (const p of this.packs.values()) {
      if (p.user_id === identity.userId && (p as unknown as { _identityHash?: string })._identityHash === identityHash) return p;
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
      model_version: null,
      status: 'GENERATING', overall_confidence: null, grounding_status: null, critical_safety_failure: false, generation_mode: 'BATCH_AI',
      batch_id: null,
      ai_run_id: null, idempotency_key: input.idempotencyKey, input_tokens: null, output_tokens: null, estimated_cost_usd: null,
      generated_at: null, validated_at: null, ready_at: null, stale_at: null, superseded_at: null, failure_code: null, retry_count: 0,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      // Store the SAME identity hash the service itself computed and passed
      // in — NOT a locally recomputed one — so findPackByIdentity's lookup
      // (keyed on that same hash) actually matches.
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

describe('Module 11.3 — AIPersonalisedInsightPackService', () => {
  let db: FakeDb;
  const ctx = makeContext({ meta: { ...makeContext().meta, snapshot_id: 'snap-1' } });

  beforeEach(() => {
    db = new FakeDb();
  });

  it('Free user: NOT_ELIGIBLE, zero pack rows created, zero provider calls', async () => {
    db.eligible = false;
    let providerCalls = 0;
    class CountingProvider extends MockInsightPackProvider {
      async generateStructured(req: Parameters<MockInsightPackProvider['generateStructured']>[0]) { providerCalls++; return super.generateStructured(req); }
    }
    const service = new AIPersonalisedInsightPackService(db, (c) => new CountingProvider(c, 'valid'));
    const outcome = await service.generateOrGetPack({ userId: 'u1', householdId: null, context: ctx });
    expect(outcome.status).toBe('NOT_ELIGIBLE');
    expect(db.packs.size).toBe(0);
    expect(providerCalls).toBe(0);
  });

  it('Batch kill switch OFF: BATCH_DISABLED, zero provider calls', async () => {
    db.batchEnabled = false;
    let providerCalls = 0;
    class CountingProvider extends MockInsightPackProvider {
      async generateStructured(req: Parameters<MockInsightPackProvider['generateStructured']>[0]) { providerCalls++; return super.generateStructured(req); }
    }
    const service = new AIPersonalisedInsightPackService(db, (c) => new CountingProvider(c, 'valid'));
    const outcome = await service.generateOrGetPack({ userId: 'u1', householdId: null, context: ctx });
    expect(outcome.status).toBe('BATCH_DISABLED');
    expect(providerCalls).toBe(0);
  });

  it('Global AI switch OFF also blocks generation', async () => {
    db.globallyEnabled = false;
    const service = new AIPersonalisedInsightPackService(db, (c) => new MockInsightPackProvider(c, 'valid'));
    const outcome = await service.generateOrGetPack({ userId: 'u1', householdId: null, context: ctx });
    expect(outcome.status).toBe('BATCH_DISABLED');
  });

  it('UNAVAILABLE certification context fails closed with zero provider calls', async () => {
    const badCtx = makeContext({ meta: { ...ctx.meta, certification_status: 'UNAVAILABLE' } });
    let providerCalls = 0;
    class CountingProvider extends MockInsightPackProvider {
      async generateStructured(req: Parameters<MockInsightPackProvider['generateStructured']>[0]) { providerCalls++; return super.generateStructured(req); }
    }
    const service = new AIPersonalisedInsightPackService(db, (c) => new CountingProvider(c, 'valid'));
    const outcome = await service.generateOrGetPack({ userId: 'u1', householdId: null, context: badCtx });
    expect(outcome.status).toBe('CONTEXT_UNAVAILABLE');
    expect(providerCalls).toBe(0);
  });

  it('Premium success: exactly one provider call, pack reaches READY, blocks persisted', async () => {
    let providerCalls = 0;
    class CountingProvider extends MockInsightPackProvider {
      async generateStructured(req: Parameters<MockInsightPackProvider['generateStructured']>[0]) { providerCalls++; return super.generateStructured(req); }
    }
    const service = new AIPersonalisedInsightPackService(db, (c) => new CountingProvider(c, 'valid'), allowAllGate(false));
    const outcome = await service.generateOrGetPack({ userId: 'u1', householdId: null, context: ctx });
    expect(outcome.status).toBe('READY');
    expect(providerCalls).toBe(1);
    expect(db.blocks.length).toBeGreaterThan(0);
    if (outcome.status === 'READY') {
      expect(outcome.pack.validated_at).not.toBeNull();
      expect(outcome.pack.ready_at).not.toBeNull();
      expect(outcome.pack.grounding_status).toBe('PASS');
    }
  });

  it('Second call for the SAME identity after READY reuses the existing pack — no second provider call', async () => {
    let providerCalls = 0;
    class CountingProvider extends MockInsightPackProvider {
      async generateStructured(req: Parameters<MockInsightPackProvider['generateStructured']>[0]) { providerCalls++; return super.generateStructured(req); }
    }
    const service = new AIPersonalisedInsightPackService(db, (c) => new CountingProvider(c, 'valid'), allowAllGate(false));
    const first = await service.generateOrGetPack({ userId: 'u1', householdId: null, context: ctx });
    const second = await service.generateOrGetPack({ userId: 'u1', householdId: null, context: ctx });
    expect(first.status).toBe('READY');
    expect(second.status).toBe('EXISTING_READY');
    expect(providerCalls).toBe(1);
  });

  it('Grounding failure on a MANDATORY block (overall_financial_summary fabricated percentage): pack FAILED, cost still recorded, custom quota untouched', async () => {
    const gate = allowAllGate(false);
    const service = new AIPersonalisedInsightPackService(db, (c) => new MockInsightPackProvider(c, 'fabricated_percentage'), gate);
    const outcome = await service.generateOrGetPack({ userId: 'u1', householdId: null, context: ctx });
    expect(outcome.status).toBe('FAILED');
    if (outcome.status === 'FAILED' && outcome.pack) {
      expect(outcome.pack.failure_code).toContain('grounding_failure');
      expect(outcome.pack.grounding_status).toBe('FAIL');
      // Cost was genuinely incurred (provider WAS called) — not silently hidden.
      expect(outcome.pack.estimated_cost_usd).not.toBeNull();
      expect(outcome.pack.estimated_cost_usd).toBeGreaterThan(0);
    }
    // Custom-question quota was never touched — every admission this
    // generation made declared BATCH_AI (structurally incapable of
    // consuming a user's custom-question allowance — migration 0115).
    expect(gate.admissions.every((a) => a.usageOutcome === 'BATCH_AI')).toBe(true);
  });

  it('Grounding failure on an OPTIONAL block (net_worth_explanation fabricated amount) is isolated: pack PARTIAL, not FAILED (spec section 50)', async () => {
    const service = new AIPersonalisedInsightPackService(db, (c) => new MockInsightPackProvider(c, 'fabricated_monetary_value'), allowAllGate(false));
    const outcome = await service.generateOrGetPack({ userId: 'u1', householdId: null, context: ctx });
    expect(outcome.status).toBe('PARTIAL');
    if (outcome.status === 'PARTIAL') {
      expect(outcome.pack.grounding_status).toBe('PARTIAL');
    }
    const netWorthBlock = db.blocks.find((b) => b.block_code === 'net_worth_explanation');
    expect(netWorthBlock?.status).toBe('UNGROUNDED');
    const overallBlock = db.blocks.find((b) => b.block_code === 'overall_financial_summary');
    expect(overallBlock?.status).toBe('GROUNDED');
  });

  it('Product-recommendation safety violation fails the whole pack closed (critical_safety_failure)', async () => {
    const service = new AIPersonalisedInsightPackService(db, (c) => new MockInsightPackProvider(c, 'product_recommendation'), allowAllGate(false));
    const outcome = await service.generateOrGetPack({ userId: 'u1', householdId: null, context: ctx });
    expect(outcome.status).toBe('FAILED');
    if (outcome.status === 'FAILED' && outcome.pack) {
      expect(outcome.pack.critical_safety_failure).toBe(true);
      expect(outcome.pack.failure_code).toBe('safety_violation');
    }
  });

  it('Malformed JSON provider output never reaches READY', async () => {
    const service = new AIPersonalisedInsightPackService(db, (c) => new MockInsightPackProvider(c, 'malformed_json'), allowAllGate(false));
    const outcome = await service.generateOrGetPack({ userId: 'u1', householdId: null, context: ctx });
    expect(outcome.status).toBe('FAILED');
  });

  it('Snapshot change: prior READY pack for an OLDER snapshot is SUPERSEDED once a new one is READY', async () => {
    const service = new AIPersonalisedInsightPackService(db, (c) => new MockInsightPackProvider(c, 'valid'), allowAllGate(false));
    const snapshotA = makeContext({ meta: { ...ctx.meta, snapshot_id: 'snap-A' } });
    const outcomeA = await service.generateOrGetPack({ userId: 'u1', householdId: null, context: snapshotA });
    expect(outcomeA.status).toBe('READY');
    const packAId = outcomeA.status === 'READY' ? outcomeA.pack.id : '';

    const snapshotB = makeContext({ meta: { ...ctx.meta, snapshot_id: 'snap-B' }, health_score: { ...ctx.health_score!, overall_score: 80 } });
    // bypassRegenerationCooldown simulates the next monthly cycle (a real
    // scheduled run is >24h after the last one by construction) — see the
    // dedicated cooldown test below for the case where this is NOT set.
    const outcomeB = await service.generateOrGetPack({ userId: 'u1', householdId: null, context: snapshotB, bypassRegenerationCooldown: true });
    expect(outcomeB.status).toBe('READY');

    expect(db.packs.get(packAId)!.status).toBe('SUPERSEDED');
    expect(db.packs.get(packAId)!.superseded_at).not.toBeNull();
  });

  it('Regeneration cadence control (spec section 34): a second NEW-identity generation within 24h of the last one is rate-limited, zero provider calls', async () => {
    let providerCalls = 0;
    class CountingProvider extends MockInsightPackProvider {
      async generateStructured(req: Parameters<MockInsightPackProvider['generateStructured']>[0]) { providerCalls++; return super.generateStructured(req); }
    }
    const service = new AIPersonalisedInsightPackService(db, (c) => new CountingProvider(c, 'valid'), allowAllGate(false));
    const snapshotA = makeContext({ meta: { ...ctx.meta, snapshot_id: 'snap-cooldown-A' } });
    const outcomeA = await service.generateOrGetPack({ userId: 'u1', householdId: null, context: snapshotA });
    expect(outcomeA.status).toBe('READY');
    expect(providerCalls).toBe(1);

    // A DIFFERENT (new) snapshot, no bypass flag, immediately afterward —
    // must be rate-limited, not silently regenerated.
    const snapshotB = makeContext({ meta: { ...ctx.meta, snapshot_id: 'snap-cooldown-B' } });
    const outcomeB = await service.generateOrGetPack({ userId: 'u1', householdId: null, context: snapshotB });
    expect(outcomeB.status).toBe('REGENERATION_RATE_LIMITED');
    expect(providerCalls).toBe(1); // still 1 — the rate-limited attempt never reached the provider
    if (outcomeB.status === 'REGENERATION_RATE_LIMITED') {
      expect(new Date(outcomeB.nextEligibleAt).getTime()).toBeGreaterThan(Date.now());
    }
  });

  it('Regeneration cadence control does NOT apply to a bounded retry of the SAME failed identity (spec section 35 governs that separately)', async () => {
    // First: an identity that fails (grounding failure), consuming the free retry.
    const service = new AIPersonalisedInsightPackService(db, (c) => new MockInsightPackProvider(c, 'fabricated_percentage'), allowAllGate(false));
    const snap = makeContext({ meta: { ...ctx.meta, snapshot_id: 'snap-retry-cooldown' } });
    const first = await service.generateOrGetPack({ userId: 'u1', householdId: null, context: snap });
    expect(first.status).toBe('FAILED');

    // Immediately retry the SAME identity (no bypass flag) — must NOT be
    // blocked by the 24h cooldown, because it is a retry of a FAILED pack,
    // not a fresh automatic regeneration for a new identity.
    const retryService = new AIPersonalisedInsightPackService(db, (c) => new MockInsightPackProvider(c, 'valid'), allowAllGate(false));
    const retried = await retryService.generateOrGetPack({ userId: 'u1', householdId: null, context: snap });
    expect(retried.status).toBe('READY');
  });

  it('Stored answer store integration: score_explanation grounded block upserts an ai_insights-equivalent row mapped to SCORE_EXPLANATION', async () => {
    const service = new AIPersonalisedInsightPackService(db, (c) => new MockInsightPackProvider(c, 'valid'), allowAllGate(false));
    await service.generateOrGetPack({ userId: 'u1', householdId: null, context: ctx });
    expect(db.storedAnswers.length).toBeGreaterThan(0);
    const scoreAnswer = db.storedAnswers.find((a) => a.metricCode === 'SCORE_EXPLANATION');
    expect(scoreAnswer).toBeDefined();
    expect(scoreAnswer!.currentValue).toBe(ctx.health_score!.overall_score);
  });

  it('Cost-ceiling denial (an injected deny-gate reporting platform_cost_ceiling) produces COST_BLOCKED, provider never reached', async () => {
    const gate = denyGate('platform_cost_ceiling');
    let providerCalls = 0;
    class CountingProvider extends MockInsightPackProvider {
      async generateStructured(req: Parameters<MockInsightPackProvider['generateStructured']>[0]) { providerCalls++; return super.generateStructured(req); }
    }
    const service = new AIPersonalisedInsightPackService(db, (c) => new CountingProvider(c, 'valid'), gate);
    const outcome = await service.generateOrGetPack({ userId: 'u1', householdId: null, context: ctx });
    expect(outcome.status).toBe('COST_BLOCKED');
    expect(providerCalls).toBe(0);
  });
});
