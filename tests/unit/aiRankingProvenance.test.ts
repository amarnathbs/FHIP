// Module 11 remediation R1 — Ranking provenance certification
// (brief sections 4-9).
//
// Proves, end-to-end through the REAL AIPersonalisedInsightPackService and
// the REAL AIInsightPackBatchOrchestrator (in-memory DB doubles, the
// project's own mock providers), that:
//
//   1. the provider RECEIVES FHIP's deterministic ranking as immutable data
//      with an explicit preserve-order instruction (section 6);
//   2. a well-behaved provider's echo is accepted and the stored "focus
//      first" answer is composed in CANONICAL order (section 7);
//   3. THE SECTION 8 NEGATIVE TEST: canonical A(1) B(2) C(3), provider
//      returns C, A, B -> rejected, provider is never the ranking authority;
//   4. invented / dropped / relabelled items are likewise rejected;
//   5. with an EMPTY canonical ranking (the R1 production state, before
//      Module 11.6 exists), ANY provider-supplied priority is rejected and
//      no PRIORITY_REVIEW_AREAS_EXPLANATION stored answer is ever written;
//   6. a structurally invalid canonical ranking fails closed BEFORE the
//      provider is called (zero provider calls, zero spend).

import { describe, it, expect, vi } from 'vitest';
import { makeContext } from './support/financialContextFixture';
import { AIPersonalisedInsightPackService, PROMPT_CODE, type InsightPackDbClient, type PackRow, type PersistedBlockInput, type StoredAnswerUpsertInput } from '@/lib/ai/insightPack/insightPackService';
import { AIInsightPackBatchOrchestrator } from '@/lib/ai/insightPack/batchOrchestrator';
import { MockInsightPackProvider, MockBatchInsightPackProvider, type MockPackBehavior } from '@/lib/ai/insightPack/mockPackProvider';
import { buildPackUserPrompt, splitPackUserPrompt, storedAnswersFromValidatedPack, PRIORITY_REVIEW_AREAS_INTENT } from '@/lib/ai/insightPack/packComposition';
import {
  assertCanonicalRanking,
  buildRankedPriorityPromptSection,
  composeCanonicalPriorityExplanation,
  validatePriorityRankingProvenance,
  type RankedPriorityArea,
} from '@/lib/ai/insightPack/priorityRanking';
import { summarisePackGrounding } from '@/lib/ai/insightPack/groundingValidation';
import { validateProviderPackResponse, PACK_SCHEMA_VERSION, type PackBlockCode, type ProviderPackBlock, type ProviderPackEnvelope } from '@/lib/ai/insightPack/types';
import type { PromptTemplateRow } from '@/lib/ai/promptRegistry';
import type { ModelRegistryRow } from '@/lib/ai/modelRegistry';
import type { InsightPackBatchDbClient, BatchRow, InsertBatchInput } from '@/lib/ai/insightPack/batchTypes';
import { allowAllGate } from '@/tests/unit/support/entitlementGateStubs';

vi.mock('@/lib/ai/audit/aiRuns', () => ({
  recordAiRun: vi.fn(async () => 'mock-run-id'),
  hashContext: vi.fn((ctx: unknown) => `mock-hash-${JSON.stringify((ctx as { meta?: { snapshot_id?: string } })?.meta?.snapshot_id ?? '')}`),
}));

const PROMPT: PromptTemplateRow = {
  id: 'prompt-1', prompt_code: PROMPT_CODE, prompt_name: 'Monthly Personalised Insight Pack', version: 2,
  task_type: 'monthly_insight_pack', system_prompt: 'system', developer_prompt: 'developer',
  context_schema_version: 'ai-context-1.0.0', output_schema_version: PACK_SCHEMA_VERSION, country_scope: null,
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

/** The section 8 fixture: A rank 1, B rank 2, C rank 3. */
const ABC: RankedPriorityArea[] = [
  { rank: 1, action_code: 'A', title: 'Action A', source_ref: 'test:a' },
  { rank: 2, action_code: 'B', title: 'Action B', source_ref: 'test:b' },
  { rank: 3, action_code: 'C', title: 'Action C', source_ref: 'test:c' },
];

class FakeDb implements InsightPackDbClient {
  packs = new Map<string, PackRow>();
  blocks: (PersistedBlockInput & { pack_id: string })[] = [];
  storedAnswers: StoredAnswerUpsertInput[] = [];
  private seq = 0;
  async getActivePrompt() { return PROMPT; }
  async resolveModelForTask() { return MODEL; }
  async isPersonalisedAiEligible() { return true; }
  async isBatchGenerationEnabled() { return { globallyEnabled: true, batchEnabled: true }; }
  async findPackByIdentity(identity: { userId: string }, identityHash: string): Promise<PackRow | null> {
    for (const p of this.packs.values()) if (p.user_id === identity.userId && (p as unknown as { _h?: string })._h === identityHash) return p;
    return null;
  }
  async findCurrentPackForUser() { return null; }
  async findMostRecentGenerationTime() { return null; }
  async insertPendingPack(input: Parameters<InsightPackDbClient['insertPendingPack']>[0]): Promise<PackRow> {
    const id = `pack-${++this.seq}`;
    const row = {
      id, user_id: input.userId, household_id: input.householdId, snapshot_id: input.identity.snapshotId,
      financial_context_hash: input.identity.financialContextHash, context_schema_version: input.identity.contextSchemaVersion,
      pack_schema_version: input.identity.packSchemaVersion, prompt_code: input.identity.promptCode, prompt_version: input.identity.promptVersion,
      country_context: input.identity.countryContext, language: input.identity.language, provider: input.provider, model: input.model, model_version: null,
      status: 'GENERATING', overall_confidence: null, grounding_status: null, critical_safety_failure: false, generation_mode: 'BATCH_AI', batch_id: input.batchId ?? null,
      ai_run_id: null, idempotency_key: input.idempotencyKey, input_tokens: null, output_tokens: null, estimated_cost_usd: null,
      generated_at: null, validated_at: null, ready_at: null, stale_at: null, superseded_at: null, failure_code: null, retry_count: 0,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(), _h: input.identityHash,
    } as PackRow & { _h: string };
    this.packs.set(id, row);
    return row;
  }
  async updatePack(id: string, patch: Partial<PackRow>): Promise<PackRow> {
    const updated = { ...this.packs.get(id)!, ...patch };
    this.packs.set(id, updated);
    return updated;
  }
  async insertBlocks(packId: string, _u: string, _h: string | null, blocks: PersistedBlockInput[]) { this.blocks.push(...blocks.map((b) => ({ ...b, pack_id: packId }))); }
  async supersedeOlderPacks() { return 0; }
  async upsertStoredAnswer(input: StoredAnswerUpsertInput) { this.storedAnswers.push(input); }
}

class FakeBatchDb implements InsightPackBatchDbClient {
  rows = new Map<string, BatchRow>();
  private seq = 0;
  async insertBatch(input: InsertBatchInput): Promise<BatchRow> {
    const id = `batch-${++this.seq}`;
    const row: BatchRow = { id, provider: input.provider, task_type: input.taskType, status: 'PENDING', submitted_at: null, completed_at: null, request_count: input.requestCount, success_count: 0, failure_count: 0, estimated_cost_usd: 0, actual_cost_usd: null, error_summary: null, created_at: '', updated_at: '' };
    this.rows.set(id, row);
    return row;
  }
  async updateBatch(id: string, patch: Partial<BatchRow>): Promise<BatchRow> {
    const updated = { ...this.rows.get(id)!, ...patch };
    this.rows.set(id, updated);
    return updated;
  }
  async listPacksForBatch(): Promise<PackRow[]> { return []; }
  async listOpenBatches(): Promise<BatchRow[]> { return [...this.rows.values()].filter((b) => b.status === 'SUBMITTED'); }
}

const ctx = makeContext({ meta: { ...makeContext().meta, snapshot_id: 'snap-r1' } });

function serviceWith(behavior: MockPackBehavior, ranking: RankedPriorityArea[]) {
  const db = new FakeDb();
  const providerSpy = vi.fn((c) => new MockInsightPackProvider(c, behavior));
  const service = new AIPersonalisedInsightPackService(db, providerSpy, allowAllGate(false), () => ranking);
  return { db, service, providerSpy };
}

describe('R1 — section 6: what the provider actually receives', () => {
  it('the rendered prompt carries the ranked items as DATA with an explicit immutable/preserve-order instruction, after the context', () => {
    const userPrompt = buildPackUserPrompt(PROMPT, ctx, ABC);
    expect(userPrompt).toContain('RANKED_PRIORITY_AREAS (IMMUTABLE');
    expect(userPrompt).toContain('Do NOT reorder, re-rank, add, remove, merge or rename any item.');
    expect(userPrompt).toContain('echoing each `rank` and `action_code` verbatim');
    // Round-trips exactly: a text-only consumer recovers both the context and the ranked list.
    const split = splitPackUserPrompt(userPrompt);
    expect(JSON.parse(split.contextJson).meta.snapshot_id).toBe('snap-r1');
    expect(split.rankedItems).toEqual([
      { rank: 1, action_code: 'A', title: 'Action A' },
      { rank: 2, action_code: 'B', title: 'Action B' },
      { rank: 3, action_code: 'C', title: 'Action C' },
    ]);
    // source_ref (provenance bookkeeping) is deliberately NOT sent to the provider.
    expect(userPrompt).not.toContain('test:a');
  });

  it('an empty ranking still sends the instruction and an empty list — the provider is told not to invent priorities', () => {
    const section = buildRankedPriorityPromptSection([]);
    expect(section).toContain('do not invent priorities');
    expect(section.trim().endsWith('[]')).toBe(true);
  });
});

describe('R1 — section 8: the negative test (provider must not become the ranking authority)', () => {
  it('canonical A,B,C — provider returns C,A,B -> validator REJECTS with reordered_priority_area', () => {
    const violations = validatePriorityRankingProvenance(
      [{ rank: 3, action_code: 'C', explanation: '' }, { rank: 1, action_code: 'A', explanation: '' }, { rank: 2, action_code: 'B', explanation: '' }],
      ABC
    );
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((v) => v.code === 'reordered_priority_area')).toBe(true);
  });

  it('through the REAL single-call service: reordered provider output -> priority block UNGROUNDED, pack PARTIAL, NO focus-first stored answer', async () => {
    const { db, service } = serviceWith('reordered_priority', ABC);
    const outcome = await service.generateOrGetPack({ userId: 'u1', householdId: null, context: ctx });
    expect(outcome.status).toBe('PARTIAL');
    const priorityAnswer = db.storedAnswers.find((a) => a.metricCode === PRIORITY_REVIEW_AREAS_INTENT);
    expect(priorityAnswer).toBeUndefined();
    // Other, independently grounded blocks are still served (the provider's misbehaviour on ranking does not poison unrelated answers).
    expect(db.storedAnswers.some((a) => a.metricCode === 'SCORE_EXPLANATION')).toBe(true);
  });

  it('through the REAL batch orchestrator: a reordering provider yields PARTIAL for that household and no focus-first stored answer', async () => {
    const db = new FakeDb();
    const batchDb = new FakeBatchDb();
    const batchProvider = new MockBatchInsightPackProvider();
    const orchestrator = new AIInsightPackBatchOrchestrator(db, batchDb, (c) => new MockInsightPackProvider(c, 'valid'), batchProvider, allowAllGate(false), 3, () => ABC);
    // Force the (only) household's item to reorder. requestId = pack idempotency key; discover it from the inserted pack after admission by
    // pre-registering the behaviour for ALL request ids the mock sees — the mock keys overrides by requestId, so register lazily via submitBatch hook.
    const original = batchProvider.submitBatch.bind(batchProvider);
    batchProvider.submitBatch = async (items) => {
      for (const item of items) batchProvider.setBehaviorForRequest(item.requestId, 'reordered_priority');
      return original(items);
    };
    const result = await orchestrator.generateBatch([{ userId: 'u-batch', householdId: null, context: ctx }]);
    expect(result.households[0].status).toBe('PARTIAL');
    expect(db.storedAnswers.find((a) => a.metricCode === PRIORITY_REVIEW_AREAS_INTENT)).toBeUndefined();
  });
});

describe('R1 — section 7: a well-behaved provider is accepted, and presentation is CANONICAL order by construction', () => {
  it('single-call service: echo accepted, pack READY, stored focus-first answer composed in canonical order', async () => {
    const { db, service } = serviceWith('valid', ABC);
    const outcome = await service.generateOrGetPack({ userId: 'u2', householdId: null, context: ctx });
    expect(outcome.status).toBe('READY');
    const priorityAnswer = db.storedAnswers.find((a) => a.metricCode === PRIORITY_REVIEW_AREAS_INTENT);
    expect(priorityAnswer).toBeDefined();
    expect(priorityAnswer!.explanation.startsWith('1. Action A:')).toBe(true);
    expect(priorityAnswer!.explanation.indexOf('2. Action B')).toBeGreaterThan(priorityAnswer!.explanation.indexOf('1. Action A'));
    expect(priorityAnswer!.explanation.indexOf('3. Action C')).toBeGreaterThan(priorityAnswer!.explanation.indexOf('2. Action B'));
  });

  it('composeCanonicalPriorityExplanation() uses canonical order even if handed provider items in a different order (defence in depth)', () => {
    const text = composeCanonicalPriorityExplanation(ABC, [
      { rank: 3, action_code: 'C', explanation: 'c-text' },
      { rank: 1, action_code: 'A', explanation: 'a-text' },
      { rank: 2, action_code: 'B', explanation: 'b-text' },
    ]);
    expect(text).toBe('1. Action A: a-text 2. Action B: b-text 3. Action C: c-text');
  });

  it('the provider cannot re-title an action: a `title` field in the provider item is a schema violation', () => {
    const envelope = {
      pack_version: PACK_SCHEMA_VERSION, snapshot_id: 'snap-r1', data_as_of: null, reporting_currency: 'AUD', overall_confidence: 'HIGH',
      blocks: {}, top_strengths: [], top_risks: [], limitations: [],
      priority_review_areas: [{ rank: 1, action_code: 'A', title: 'Provider renamed it', explanation: '' }],
    };
    const v = validateProviderPackResponse(JSON.stringify(envelope));
    expect(v.ok).toBe(false);
  });
});

describe('R1 — other provenance violations', () => {
  it.each([
    ['invented_priority', 'invented_priority_area'],
    ['dropped_priority', 'dropped_priority_area'],
    ['relabelled_rank', 'rank_mismatch'],
  ] as const)('%s -> pack PARTIAL, priority block UNGROUNDED with %s, no focus-first stored answer', async (behavior, code) => {
    const { db, service } = serviceWith(behavior, ABC);
    const outcome = await service.generateOrGetPack({ userId: 'u3', householdId: null, context: ctx });
    expect(outcome.status).toBe('PARTIAL');
    expect(db.storedAnswers.find((a) => a.metricCode === PRIORITY_REVIEW_AREAS_INTENT)).toBeUndefined();
    // The violation is auditable through the validator directly.
    const provided = JSON.parse(await new MockInsightPackProvider(ctx, behavior).generateStructured({ systemPrompt: '', userPrompt: buildPackUserPrompt(PROMPT, ctx, ABC), taskType: 'monthly_insight_pack', model: 'mock-1', maxOutputTokens: 10, responseSchema: 'ai_response_envelope' }).then((r) => r.rawText)).priority_review_areas;
    expect(validatePriorityRankingProvenance(provided, ABC).some((v) => v.code === code)).toBe(true);
  });

  it('duplicate action_code from the provider is rejected', () => {
    const v = validatePriorityRankingProvenance([{ rank: 1, action_code: 'A', explanation: '' }, { rank: 2, action_code: 'A', explanation: '' }], ABC.slice(0, 2));
    expect(v.some((x) => x.code === 'duplicate_priority_area')).toBe(true);
  });
});

describe('R1 — production state before Module 11.6: EMPTY canonical ranking', () => {
  it('provider echo of an empty list is GROUNDED; no focus-first stored answer is written because FHIP ranked nothing', async () => {
    const { db, service } = serviceWith('valid', []);
    const outcome = await service.generateOrGetPack({ userId: 'u4', householdId: null, context: ctx });
    expect(outcome.status).toBe('READY');
    expect(db.storedAnswers.find((a) => a.metricCode === PRIORITY_REVIEW_AREAS_INTENT)).toBeUndefined();
  });

  it('ANY provider-supplied priority under an empty canonical list is invented_priority_area -> rejected', async () => {
    const { db, service } = serviceWith('invented_priority', []);
    const outcome = await service.generateOrGetPack({ userId: 'u5', householdId: null, context: ctx });
    expect(outcome.status).toBe('PARTIAL');
    expect(db.storedAnswers.find((a) => a.metricCode === PRIORITY_REVIEW_AREAS_INTENT)).toBeUndefined();
  });

  it('the default production binding IS the empty source (nothing on this branch ranks until R5 wires Module 11.6)', async () => {
    const { defaultPriorityRankingSource, EMPTY_PRIORITY_RANKING_SOURCE } = await import('@/lib/ai/insightPack/priorityRankingSource');
    expect(defaultPriorityRankingSource(ctx)).toEqual([]);
    expect(EMPTY_PRIORITY_RANKING_SOURCE(ctx)).toEqual([]);
  });
});

describe('R1 — canonical-ranking structural guard (producer defects fail closed, pre-provider)', () => {
  it('assertCanonicalRanking() rejects non-contiguous ranks, duplicates, and >3 items', () => {
    expect(assertCanonicalRanking([{ rank: 2, action_code: 'A', title: 'A', source_ref: 's' }]).length).toBeGreaterThan(0);
    expect(assertCanonicalRanking([{ rank: 1, action_code: 'A', title: 'A', source_ref: 's' }, { rank: 2, action_code: 'A', title: 'A', source_ref: 's' }]).length).toBeGreaterThan(0);
    expect(assertCanonicalRanking([...ABC, { rank: 4, action_code: 'D', title: 'D', source_ref: 's' }]).length).toBeGreaterThan(0);
    expect(assertCanonicalRanking(ABC)).toEqual([]);
    expect(assertCanonicalRanking([])).toEqual([]);
  });

  it('an invalid canonical list fails the generation with canonical_ranking_invalid and ZERO provider calls', async () => {
    const bad: RankedPriorityArea[] = [{ rank: 7, action_code: 'A', title: 'A', source_ref: 's' }];
    const { db, service, providerSpy } = serviceWith('valid', bad);
    const outcome = await service.generateOrGetPack({ userId: 'u6', householdId: null, context: ctx });
    expect(outcome.status).toBe('FAILED');
    expect(outcome.status === 'FAILED' && outcome.failureCode).toBe('canonical_ranking_invalid');
    expect(providerSpy).not.toHaveBeenCalled();
    expect(db.storedAnswers).toEqual([]);
  });
});

describe('R1 — grounding summary integration', () => {
  it('a ranking failure marks the priority_review_areas BLOCK ungrounded and the pack PARTIAL, never FAIL (not a mandatory block)', () => {
    const block: ProviderPackBlock = { block_code: 'priority_review_areas', status: 'POPULATED', headline: 'Focus', short_answer: 'Focus here.', explanation: 'Focus here first.', why_it_matters: '', metric_claims: [], source_refs: [], limitations: [], confidence: 'HIGH', data_as_of: null, related_module: null, action_route: null };
    const provided = new Map<PackBlockCode, ProviderPackBlock>([['priority_review_areas', block]]);
    const summary = summarisePackGrounding(provided, ctx, new Set(), [], { canonical: ABC, provided: [{ rank: 1, action_code: 'C', explanation: '' }, { rank: 2, action_code: 'A', explanation: '' }, { rank: 3, action_code: 'B', explanation: '' }] });
    expect(summary.rankingProvenance.status).toBe('UNGROUNDED');
    expect(summary.blockResults.get('priority_review_areas')!.status).toBe('UNGROUNDED');
    expect(summary.overallStatus).toBe('PARTIAL');
    // And the answer-store composer refuses to emit the focus-first answer from that state.
    const envelope: ProviderPackEnvelope = { pack_version: PACK_SCHEMA_VERSION, snapshot_id: 's', data_as_of: null, reporting_currency: 'AUD', overall_confidence: 'HIGH', blocks: {}, top_strengths: [], top_risks: [], limitations: [], priority_review_areas: [] };
    expect(storedAnswersFromValidatedPack(provided, summary, envelope, ABC).some((a) => a.metricCode === PRIORITY_REVIEW_AREAS_INTENT)).toBe(false);
  });

  it('legacy callers that pass no ranking inputs get NOT_APPLICABLE (no change to their verdict)', () => {
    const summary = summarisePackGrounding(new Map(), ctx, new Set(), []);
    expect(summary.rankingProvenance.status).toBe('NOT_APPLICABLE');
    expect(summary.overallStatus).toBe('PASS');
  });
});
