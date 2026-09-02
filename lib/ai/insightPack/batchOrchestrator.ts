// Module 11.3 continuation — AIInsightPackBatchOrchestrator (spec sections
// 25-26, 66-69). The minimum-viable ASYNC BATCH orchestration path the
// phase's own migration comment always described but the original pass did
// not build: N households' generations submitted as ONE logical provider
// batch, while every household still goes through the IDENTICAL
// entitlement/kill-switch/cost-ceiling/idempotency/grounding pipeline the
// single-call AIPersonalisedInsightPackService already uses — this class
// reuses that pipeline's pieces (packIdentity, mandatoryBlocksApplicableFor,
// summarisePackGrounding, validateProviderPackResponse, estimateCallCost),
// it does not reimplement or relax any of them.
//
// WHAT'S DIFFERENT FROM THE SINGLE-CALL PATH. AIModelGateway.generatePack()
// does admission AND the single provider call in one method — which is
// exactly right for one household, but structurally cannot batch (it always
// executes its OWN provider.generateStructured() call). This orchestrator
// therefore performs the SAME pre-provider steps (entitlement admission via
// the SAME `EntitlementGate.admit()` interface, same field values) itself,
// per household, BEFORE constructing the batch submission — so a
// denied/ineligible/cost-blocked household is excluded from the batch
// entirely, never silently included then discarded.
//
// RECONCILIATION. Every admitted household gets a stable `requestId` (its
// own pack-identity idempotency key — lib/ai/insightPack/packIdentity.ts,
// the SAME key the single-call path already uses for admission dedup).
// Provider batch results are matched back to their household by this id via
// a Map lookup — never by array position — so an out-of-order return, a
// missing result, or an adversarially mismatched id can never be attributed
// to the wrong household (see the dedicated cross-tenant test).

import { createHash } from 'node:crypto';
import type { AIProvider } from '@/lib/ai/providers/types';
import { dbEntitlementGate } from '@/lib/ai/entitlement/entitlementService';
import type { EntitlementGate } from '@/lib/ai/entitlement/types';
import { estimateCallCost } from '@/lib/ai/cost/registryCost';
import type { FinancialContextObject } from '@/lib/ai/context/types';
import type { ModelRegistryRow } from '@/lib/ai/modelRegistry';
import type { PromptTemplateRow } from '@/lib/ai/promptRegistry';
import {
  PACK_BLOCK_CODES, BLOCK_INTENT_MAP, validateProviderPackResponse,
  type PackBlockCode, type ProviderPackBlock,
} from '@/lib/ai/insightPack/types';
import { computePackIdentityHash, packIdempotencyKey } from '@/lib/ai/insightPack/packIdentity';
import { summarisePackGrounding } from '@/lib/ai/insightPack/groundingValidation';
import {
  buildPackIdentity, mandatoryBlocksApplicableFor, REGENERATION_COOLDOWN_MS,
  type InsightPackDbClient, type PackRow, type PersistedBlockInput,
} from '@/lib/ai/insightPack/insightPackService';
import type { BatchCapableProvider, BatchPackItemRequest, InsightPackBatchDbClient, BatchRow } from '@/lib/ai/insightPack/batchTypes';

const TASK_TYPE = 'monthly_insight_pack' as const;
export const BATCH_PROMPT_CODE = 'PR-AI-013';

export interface BatchHouseholdInput {
  userId: string;
  householdId: string | null;
  context: FinancialContextObject;
}

export type HouseholdBatchOutcome =
  | { userId: string; status: 'NOT_ELIGIBLE' }
  | { userId: string; status: 'CONTEXT_UNAVAILABLE'; reason: string }
  | { userId: string; status: 'BATCH_ABORTED_KILL_SWITCH' }
  | { userId: string; status: 'BATCH_ABORTED_NO_PROMPT_OR_MODEL' }
  | { userId: string; status: 'EXISTING_READY'; pack: PackRow }
  | { userId: string; status: 'PARTIAL'; pack: PackRow }
  | { userId: string; status: 'IN_PROGRESS'; pack: PackRow }
  | { userId: string; status: 'REGENERATION_RATE_LIMITED'; nextEligibleAt: string }
  | { userId: string; status: 'COST_BLOCKED'; denyReason: string | null }
  | { userId: string; status: 'READY'; pack: PackRow }
  | { userId: string; status: 'FAILED'; pack: PackRow | null; failureCode: string; retryable: boolean };

export interface BatchGenerationResult {
  batch: BatchRow;
  households: HouseholdBatchOutcome[];
}

interface AdmittedItem {
  userId: string;
  householdId: string | null;
  context: FinancialContextObject;
  identity: ReturnType<typeof buildPackIdentity>;
  identityHash: string;
  requestId: string;
  packId: string;
  admissionId: string | null;
  isRetry: boolean;
  existingRetryCount: number;
  provider: AIProvider; // per-household delegate, used ONLY for cost estimation (mirrors the single-call path's providerFactory use)
}

export class AIInsightPackBatchOrchestrator {
  constructor(
    private readonly db: InsightPackDbClient,
    private readonly batchDb: InsightPackBatchDbClient,
    /** Same shape as AIPersonalisedInsightPackService's own providerFactory — one per-household provider instance, used here only for registry-aware cost estimation (estimateCallCost needs an AIProvider for its no-registry-price fallback path). */
    private readonly providerFactory: (ctx: FinancialContextObject, model: ModelRegistryRow) => AIProvider,
    private readonly batchProvider: BatchCapableProvider,
    private readonly entitlementGate: EntitlementGate = dbEntitlementGate,
    /** Spec's "bounded retries... then terminally fails with a reportable failure_code" — a batch-specific budget, independent of (and not a weakening of) the single-call path's own hardcoded 1-retry budget. */
    private readonly maxRetries: number = 3
  ) {}

  async generateBatch(items: BatchHouseholdInput[]): Promise<BatchGenerationResult> {
    if (items.length === 0) {
      const empty = await this.batchDb.insertBatch({ provider: this.batchProvider.providerName, taskType: TASK_TYPE, requestCount: 0 });
      const completed = await this.batchDb.updateBatch(empty.id, { status: 'COMPLETED', submitted_at: new Date().toISOString(), completed_at: new Date().toISOString() });
      return { batch: completed, households: [] };
    }

    // ---- Kill switch (reused, not bypassed — the SAME check the
    // single-call service makes, applied ONCE for the whole batch since
    // it's a platform-wide switch, not a per-household one). ----
    const { globallyEnabled, batchEnabled } = await this.db.isBatchGenerationEnabled();
    if (!globallyEnabled || !batchEnabled) {
      const pending = await this.batchDb.insertBatch({ provider: this.batchProvider.providerName, taskType: TASK_TYPE, requestCount: items.length });
      const aborted = await this.batchDb.updateBatch(pending.id, { status: 'FAILED', error_summary: 'batch_disabled: ai_globally_enabled/batch_generation_enabled is off' });
      return { batch: aborted, households: items.map((i) => ({ userId: i.userId, status: 'BATCH_ABORTED_KILL_SWITCH' as const })) };
    }

    const prompt = await this.db.getActivePrompt(BATCH_PROMPT_CODE, null);
    const model = await this.db.resolveModelForTask(TASK_TYPE, 'STANDARD');
    if (!prompt || !model) {
      const pending = await this.batchDb.insertBatch({ provider: this.batchProvider.providerName, taskType: TASK_TYPE, requestCount: items.length });
      const aborted = await this.batchDb.updateBatch(pending.id, { status: 'FAILED', error_summary: !prompt ? 'no_active_prompt' : 'no_approved_model' });
      return { batch: aborted, households: items.map((i) => ({ userId: i.userId, status: 'BATCH_ABORTED_NO_PROMPT_OR_MODEL' as const })) };
    }

    const batch = await this.batchDb.insertBatch({ provider: model.provider, taskType: TASK_TYPE, requestCount: items.length });

    const outcomes: HouseholdBatchOutcome[] = [];
    const admitted: AdmittedItem[] = [];

    // ---- Per-household pre-provider gates — IDENTICAL to the single-call
    // path's own gates, applied per household before anything is batched. ----
    for (const item of items) {
      const outcome = await this.admitOneHousehold(item, prompt, model, batch.id);
      if (outcome.kind === 'admitted') admitted.push(outcome.item);
      else outcomes.push(outcome.outcome);
    }

    if (admitted.length === 0) {
      const failureCount = outcomes.filter((o) => o.status === 'FAILED').length;
      const successCount = outcomes.filter((o) => o.status === 'EXISTING_READY' || o.status === 'PARTIAL').length;
      const finalStatus = failureCount > 0 && successCount === 0 ? 'FAILED' : 'COMPLETED';
      const done = await this.batchDb.updateBatch(batch.id, {
        status: finalStatus, submitted_at: new Date().toISOString(), completed_at: new Date().toISOString(),
        success_count: successCount, failure_count: failureCount,
      });
      return { batch: done, households: outcomes };
    }

    // ---- ONE logical provider-side submission for every admitted household. ----
    await this.batchDb.updateBatch(batch.id, { status: 'SUBMITTED', submitted_at: new Date().toISOString() });
    const itemRequests: BatchPackItemRequest[] = admitted.map((a) => ({
      requestId: a.requestId,
      systemPrompt: prompt.system_prompt,
      userPrompt: `${prompt.developer_prompt}\n\nCONTEXT:\n${JSON.stringify(a.context)}`,
      model: model.model_identifier,
      maxOutputTokens: 3000,
    }));
    const { providerBatchId } = await this.batchProvider.submitBatch(itemRequests);

    // Bounded poll loop — the mock always resolves COMPLETED on the first
    // poll; a real async batch provider would need several. Bounded so a
    // provider that never completes cannot hang the orchestrator forever.
    let poll = await this.batchProvider.pollBatch(providerBatchId);
    for (let attempt = 0; attempt < 10 && poll.status !== 'COMPLETED'; attempt++) {
      poll = await this.batchProvider.pollBatch(providerBatchId);
    }

    // ---- Reconciliation by requestId — NEVER by array position/order. ----
    const admittedById = new Map(admitted.map((a) => [a.requestId, a]));
    const handled = new Set<string>();
    let anomalousResultCount = 0;

    for (const result of poll.results) {
      const target = admittedById.get(result.requestId);
      if (!target) {
        // A result whose requestId does not match ANY household THIS batch
        // admitted — e.g. a foreign/adversarially-mismatched id. DROPPED,
        // never attributed to a different household by falling back to
        // position or any other heuristic.
        anomalousResultCount++;
        continue;
      }
      handled.add(result.requestId);
      const outcome = await this.applyHouseholdResult(target, result, prompt, model);
      outcomes.push(outcome);
    }

    // Any admitted household whose requestId never appeared in the results
    // at all (the provider silently dropped it) is handled the same way as
    // an explicit per-item failure — bounded-retry eligible, never silently
    // treated as READY.
    for (const target of admitted) {
      if (handled.has(target.requestId)) continue;
      const outcome = await this.applyHouseholdFailure(target, 'batch_result_missing', 'No result was returned for this household by the batch provider.');
      outcomes.push(outcome);
    }

    const successCount = outcomes.filter((o) => o.status === 'READY' || o.status === 'PARTIAL' || o.status === 'EXISTING_READY').length;
    const failureCount = outcomes.filter((o) => o.status === 'FAILED').length;
    const totalCost = outcomes.reduce((sum, o) => {
      if ((o.status === 'READY' || o.status === 'PARTIAL') && 'pack' in o && o.pack?.estimated_cost_usd) return sum + Number(o.pack.estimated_cost_usd);
      return sum;
    }, 0);
    const finalStatus = failureCount === 0 ? 'COMPLETED' : successCount > 0 ? 'PARTIAL' : 'FAILED';
    const done = await this.batchDb.updateBatch(batch.id, {
      status: finalStatus, completed_at: new Date().toISOString(),
      success_count: successCount, failure_count: failureCount, estimated_cost_usd: totalCost,
      error_summary: anomalousResultCount > 0 ? `${anomalousResultCount} anomalous/unmatched provider result(s) dropped` : null,
    });

    return { batch: done, households: outcomes };
  }

  // -------------------------------------------------------------------------
  private async admitOneHousehold(
    item: BatchHouseholdInput, prompt: PromptTemplateRow, model: ModelRegistryRow, batchId: string
  ): Promise<{ kind: 'admitted'; item: AdmittedItem } | { kind: 'outcome'; outcome: HouseholdBatchOutcome }> {
    const eligible = await this.db.isPersonalisedAiEligible(item.userId, item.householdId);
    if (!eligible) return { kind: 'outcome', outcome: { userId: item.userId, status: 'NOT_ELIGIBLE' } };

    if (item.context.meta.certification_status === 'UNAVAILABLE' || item.context.meta.certification_status === 'INVALID') {
      return { kind: 'outcome', outcome: { userId: item.userId, status: 'CONTEXT_UNAVAILABLE', reason: `context certification is ${item.context.meta.certification_status}` } };
    }
    if (!item.context.meta.snapshot_id) {
      return { kind: 'outcome', outcome: { userId: item.userId, status: 'CONTEXT_UNAVAILABLE', reason: 'no certified snapshot_id available for this household' } };
    }

    const identity = buildPackIdentity(item.userId, item.context, prompt);
    const identityHash = computePackIdentityHash(identity);
    const existing = await this.db.findPackByIdentity(identity, identityHash);

    let isRetry = false;
    let existingRetryCount = 0;
    let pendingPackId: string;

    if (existing) {
      if (existing.status === 'READY') return { kind: 'outcome', outcome: { userId: item.userId, status: 'EXISTING_READY', pack: existing } };
      if (existing.status === 'PARTIAL') return { kind: 'outcome', outcome: { userId: item.userId, status: 'PARTIAL', pack: existing } };
      if (['PENDING', 'QUEUED', 'GENERATING', 'PROVIDER_COMPLETE', 'VALIDATING'].includes(existing.status)) {
        return { kind: 'outcome', outcome: { userId: item.userId, status: 'IN_PROGRESS', pack: existing } };
      }
      if (existing.status === 'FAILED') {
        if (existing.retry_count >= this.maxRetries) {
          return { kind: 'outcome', outcome: { userId: item.userId, status: 'FAILED', pack: existing, failureCode: existing.failure_code ?? 'retry_budget_exhausted', retryable: false } };
        }
        isRetry = true;
        existingRetryCount = existing.retry_count;
        const updated = await this.db.updatePack(existing.id, { status: 'GENERATING', retry_count: existing.retry_count + 1 });
        pendingPackId = updated.id;
      } else {
        // STALE/SUPERSEDED/CANCELLED for this exact identity — a fresh
        // attempt, subject to the same cooldown as a genuinely new identity.
        const mostRecent = await this.db.findMostRecentGenerationTime(item.userId);
        if (mostRecent && Date.now() - new Date(mostRecent).getTime() < REGENERATION_COOLDOWN_MS) {
          return { kind: 'outcome', outcome: { userId: item.userId, status: 'REGENERATION_RATE_LIMITED', nextEligibleAt: new Date(new Date(mostRecent).getTime() + REGENERATION_COOLDOWN_MS).toISOString() } };
        }
        const inserted = await this.db.insertPendingPack({ userId: item.userId, householdId: item.householdId, identity, identityHash, provider: model.provider, model: model.model_identifier, idempotencyKey: packIdempotencyKey(identity), batchId });
        pendingPackId = inserted.id;
      }
    } else {
      const mostRecent = await this.db.findMostRecentGenerationTime(item.userId);
      if (mostRecent && Date.now() - new Date(mostRecent).getTime() < REGENERATION_COOLDOWN_MS) {
        return { kind: 'outcome', outcome: { userId: item.userId, status: 'REGENERATION_RATE_LIMITED', nextEligibleAt: new Date(new Date(mostRecent).getTime() + REGENERATION_COOLDOWN_MS).toISOString() } };
      }
      const inserted = await this.db.insertPendingPack({ userId: item.userId, householdId: item.householdId, identity, identityHash, provider: model.provider, model: model.model_identifier, idempotencyKey: packIdempotencyKey(identity), batchId });
      pendingPackId = inserted.id;
    }

    const requestId = packIdempotencyKey(identity);
    const projectedInputTokens = Math.ceil((prompt.system_prompt.length + prompt.developer_prompt.length + JSON.stringify(item.context).length) / 4);
    const provider = this.providerFactory(item.context, model);
    const projectedCost = estimateCallCost(provider, model, projectedInputTokens, 3000);

    const admission = await this.entitlementGate.admit({
      userId: item.userId,
      householdId: item.householdId,
      requestClass: 'standard',
      taskType: TASK_TYPE,
      provider: model.provider,
      model: model.model_identifier,
      internalTier: model.internal_tier,
      estimatedCostUsd: projectedCost.estimatedCostUsd,
      cacheHit: false,
      usageOutcome: 'BATCH_AI',
      idempotencyKey: requestId,
      requestHash: createHash('sha256').update([TASK_TYPE, 'standard', 'BATCH_AI', model.model_identifier, prompt.system_prompt, requestId].join(' ')).digest('hex'),
      contextTokens: projectedInputTokens,
      userInputTokens: 0,
      outputTokens: 3000,
    });

    if (!admission.allowed) {
      if (admission.denyReason === 'idempotency_conflict') {
        const winning = await this.db.findPackByIdentity(identity, identityHash);
        if (winning) {
          return { kind: 'outcome', outcome: winning.status === 'READY' ? { userId: item.userId, status: 'EXISTING_READY', pack: winning } : winning.status === 'PARTIAL' ? { userId: item.userId, status: 'PARTIAL', pack: winning } : { userId: item.userId, status: 'IN_PROGRESS', pack: winning } };
        }
      }
      const costReasons = ['user_cost_ceiling', 'platform_cost_ceiling', 'request_cost_limit', 'task_monthly_cost_limit', 'provider_cost_limit', 'daily_cost_limit'];
      const failed = await this.db.updatePack(pendingPackId, { status: 'FAILED', failure_code: admission.denyReason ?? 'admission_denied' });
      if (costReasons.includes(admission.denyReason ?? '')) {
        return { kind: 'outcome', outcome: { userId: item.userId, status: 'COST_BLOCKED', denyReason: admission.denyReason } };
      }
      return { kind: 'outcome', outcome: { userId: item.userId, status: 'FAILED', pack: failed, failureCode: admission.denyReason ?? 'admission_denied', retryable: false } };
    }

    return {
      kind: 'admitted',
      item: { userId: item.userId, householdId: item.householdId, context: item.context, identity, identityHash, requestId, packId: pendingPackId, admissionId: admission.admissionId, isRetry, existingRetryCount, provider },
    };
  }

  // -------------------------------------------------------------------------
  private async applyHouseholdResult(
    target: AdmittedItem,
    result: Awaited<ReturnType<BatchCapableProvider['pollBatch']>>['results'][number],
    prompt: PromptTemplateRow, model: ModelRegistryRow
  ): Promise<HouseholdBatchOutcome> {
    if (!result.ok) {
      if (target.admissionId) await this.entitlementGate.refund(target.admissionId);
      return this.applyHouseholdFailure(target, result.errorCode, result.errorMessage);
    }

    const validation = validateProviderPackResponse(result.rawText);
    if (!validation.ok) {
      if (target.admissionId) await this.entitlementGate.refund(target.admissionId);
      return this.applyHouseholdFailure(target, 'rejected_schema', validation.reason);
    }

    // ---- No cross-tenant result association, EVEN when a result's
    // requestId matches this household's own admitted item (spec: "no
    // cross-tenant result association... even under a forced/adversarial
    // test, e.g. deliberately mismatched request ID"). A requestId match
    // alone is necessary but NOT sufficient — the envelope's OWN
    // snapshot_id must also match this household's expected identity, or
    // the result is content that belongs to a DIFFERENT generation
    // (accidentally or adversarially mislabeled) and must never be
    // persisted onto this household's pack row. ----
    if (validation.envelope.snapshot_id !== target.identity.snapshotId) {
      if (target.admissionId) await this.entitlementGate.refund(target.admissionId);
      return this.applyHouseholdFailure(target, 'cross_tenant_snapshot_mismatch', `Result's envelope snapshot_id "${validation.envelope.snapshot_id}" does not match this household's expected identity snapshot_id "${target.identity.snapshotId}" — result rejected, never attributed.`);
    }

    const provided = new Map<PackBlockCode, ProviderPackBlock>();
    for (const code of PACK_BLOCK_CODES) {
      const block = validation.envelope.blocks[code];
      if (block) provided.set(code, block);
    }
    const knownSourceIds = new Set(target.context.source_references.map((s) => s.source_id));
    const mandatory = mandatoryBlocksApplicableFor(target.context);
    const grounding = summarisePackGrounding(provided, target.context, knownSourceIds, mandatory);

    const cost = estimateCallCost(target.provider, model, result.inputTokens, result.outputTokens);
    const nowIso = new Date().toISOString();
    const blockInputs: PersistedBlockInput[] = [];
    let order = 0;
    for (const [code, block] of provided) {
      const g = grounding.blockResults.get(code)!;
      blockInputs.push({
        block_code: code, status: g.status,
        headline: g.status === 'GROUNDED' ? block.headline || null : null,
        short_answer: g.status === 'GROUNDED' ? block.short_answer || null : null,
        explanation: g.status === 'GROUNDED' ? block.explanation || null : null,
        why_it_matters: g.status === 'GROUNDED' ? block.why_it_matters || null : null,
        source_refs_json: g.status === 'GROUNDED' ? block.source_refs : [],
        source_metric_codes: g.status === 'GROUNDED' ? block.metric_claims.map((c) => c.metric_code) : [],
        confidence: g.status === 'GROUNDED' ? block.confidence : null,
        data_as_of: block.data_as_of, limitations_json: block.limitations,
        related_module: block.related_module, action_route: block.action_route,
        safety_classification: g.safetyClassification, block_order: order++, violations_json: g.violations,
      });
    }
    await this.db.insertBlocks(target.packId, target.userId, target.householdId, blockInputs);

    if (grounding.overallStatus === 'FAIL') {
      if (target.admissionId) await this.entitlementGate.refund(target.admissionId);
      const failed = await this.db.updatePack(target.packId, {
        status: 'FAILED', validated_at: nowIso, grounding_status: 'FAIL',
        critical_safety_failure: grounding.criticalSafetyFailure,
        failure_code: grounding.criticalSafetyFailure ? 'safety_violation' : `grounding_failure:${grounding.mandatoryBlockFailed}`,
        input_tokens: result.inputTokens, output_tokens: result.outputTokens, estimated_cost_usd: cost.estimatedCostUsd,
      });
      return { userId: target.userId, status: 'FAILED', pack: failed, failureCode: failed.failure_code ?? 'grounding_failure', retryable: target.existingRetryCount + (target.isRetry ? 1 : 0) < this.maxRetries };
    }

    if (target.admissionId) await this.entitlementGate.finalise(target.admissionId);
    const status = grounding.overallStatus === 'PASS' ? 'READY' : 'PARTIAL';
    const readyPack = await this.db.updatePack(target.packId, {
      status, overall_confidence: validation.envelope.overall_confidence,
      grounding_status: grounding.overallStatus === 'PASS' ? 'PASS' : 'PARTIAL', critical_safety_failure: false,
      generated_at: nowIso, validated_at: nowIso, ready_at: status === 'READY' ? nowIso : null,
      input_tokens: result.inputTokens, output_tokens: result.outputTokens,
      // Household-level cost attribution — THIS household's own tokens, never the batch total.
      estimated_cost_usd: cost.estimatedCostUsd, model_version: model.model_identifier,
    });
    await this.db.supersedeOlderPacks(target.userId, readyPack.id);

    for (const [blockCode, intentCode] of BLOCK_INTENT_MAP) {
      const g = grounding.blockResults.get(blockCode);
      const block = provided.get(blockCode);
      if (!g || g.status !== 'GROUNDED' || !block) continue;
      await this.db.upsertStoredAnswer({
        userId: target.userId, householdId: target.householdId, metricCode: intentCode,
        currentValue: block.metric_claims[0]?.source_value ?? null,
        explanation: block.explanation || block.short_answer, confidence: block.confidence,
      });
    }

    return { userId: target.userId, status: status === 'READY' ? 'READY' : 'PARTIAL', pack: readyPack };
  }

  private async applyHouseholdFailure(target: AdmittedItem, errorCode: string, errorMessage: string): Promise<HouseholdBatchOutcome> {
    const totalAttempts = target.existingRetryCount + (target.isRetry ? 1 : 0) + 1;
    const retryable = totalAttempts < this.maxRetries;
    // ai_insight_packs.failure_code is a short machine-readable code, not a
    // free-text column — the fuller message is logged here (structured,
    // no financial context in it) rather than silently discarded, so a
    // reportable failure carries its own detail somewhere durable.
    console.error(`[AIInsightPackBatchOrchestrator] household ${target.userId} pack ${target.packId} failed: ${errorCode} — ${errorMessage} (attempt ${totalAttempts}/${this.maxRetries}, retryable=${retryable})`);
    const failed = await this.db.updatePack(target.packId, { status: 'FAILED', failure_code: errorCode });
    return { userId: target.userId, status: 'FAILED', pack: failed, failureCode: errorCode, retryable };
  }
}
