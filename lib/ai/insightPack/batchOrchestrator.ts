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
import { ProviderError } from '@/lib/ai/providers/types';
import { hashContext } from '@/lib/ai/audit/aiRuns';
import { dbEntitlementGate } from '@/lib/ai/entitlement/entitlementService';
import type { EntitlementGate } from '@/lib/ai/entitlement/types';
import { estimateCallCost } from '@/lib/ai/cost/registryCost';
import type { FinancialContextObject } from '@/lib/ai/context/types';
import type { ModelRegistryRow } from '@/lib/ai/modelRegistry';
import type { PromptTemplateRow } from '@/lib/ai/promptRegistry';
import {
  PACK_BLOCK_CODES, validateProviderPackResponse,
  type PackBlockCode, type ProviderPackBlock,
} from '@/lib/ai/insightPack/types';
import { computePackIdentityHash, packIdempotencyKey } from '@/lib/ai/insightPack/packIdentity';
import { summarisePackGrounding } from '@/lib/ai/insightPack/groundingValidation';
import {
  buildPackIdentity, mandatoryBlocksApplicableFor, REGENERATION_COOLDOWN_MS,
  type InsightPackDbClient, type PackRow, type PersistedBlockInput,
} from '@/lib/ai/insightPack/insightPackService';
import type { BatchCapableProvider, BatchPackItemRequest, BatchPollResult, InsightPackBatchDbClient, BatchRow } from '@/lib/ai/insightPack/batchTypes';
import { assertCanonicalRanking, type PriorityRankingSource, type RankedPriorityArea } from '@/lib/ai/insightPack/priorityRanking';
import { defaultPriorityRankingSource } from '@/lib/ai/insightPack/priorityRankingSource';
import { buildPackUserPrompt, storedAnswersFromValidatedPack } from '@/lib/ai/insightPack/packComposition';

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

/** R3 — what submitBatch() hands back: pre-provider outcomes plus the admitted set for an in-process reconcile. */
export interface BatchSubmission {
  batch: BatchRow;
  households: HouseholdBatchOutcome[];
  admitted: AdmittedItem[];
  providerBatchId: string | null;
  prompt: PromptTemplateRow | null;
  model: ModelRegistryRow | null;
}

export interface BatchReconcileResult {
  batch: BatchRow;
  households: HouseholdBatchOutcome[];
  /** true = provider batch still running; call again after batch.next_poll_at. */
  pending: boolean;
}

/**
 * Brief section 31 — failures that must NEVER be retried as if transient:
 * grounding, certification, safety, hard cost limits, ranking-producer
 * defects, cross-tenant/identity mismatches. Everything else (provider
 * outage, timeout, rate limit, missing result, batch-level expiry) is
 * transient and retry-eligible within the bounded budget.
 */
export const NON_RETRYABLE_FAILURE_PREFIXES = [
  'grounding_failure', 'safety_violation', 'rejected_certification', 'canonical_ranking_invalid',
  'context_changed_before_reconcile', 'cross_tenant_snapshot_mismatch', 'context_rebuild_failed',
  'user_cost_ceiling', 'platform_cost_ceiling', 'request_cost_limit', 'task_monthly_cost_limit', 'provider_cost_limit', 'daily_cost_limit',
  'not_premium', 'ai_disabled', 'kill_switch_active', 'live_provider_disabled', 'batch_disabled', 'provider_disabled', 'model_unknown', 'model_inactive', 'model_not_approved',
] as const;

export function isRetryableFailureCode(code: string | null | undefined): boolean {
  if (!code) return true;
  return !NON_RETRYABLE_FAILURE_PREFIXES.some((p) => code.startsWith(p));
}

export interface AdmittedItem {
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
  /** R1 — this household's own deterministic ranking, computed at admission and reused as the provenance oracle at reconciliation. */
  canonicalRanking: RankedPriorityArea[];
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
    private readonly maxRetries: number = 3,
    /** R1 — same deterministic ranking producer the single-call service uses; injected so the two transports share one ranking authority. */
    private readonly rankingSource: PriorityRankingSource = defaultPriorityRankingSource,
    /** R3 — how many reconcile polls a SUBMITTED batch may consume before it is abandoned (OpenAI's window is 24h; at 15-minute ticks 120 polls = 30h of headroom). */
    private readonly maxPolls: number = 120,
    /** R3 — minimum gap between polls of one batch. */
    private readonly pollIntervalMs: number = 15 * 60_000,
    /** R3 — the provider's batch-rate multiplier used for actual_cost attribution (OpenAI Batch = 50%). */
    private readonly batchPriceMultiplier: number = 0.5
  ) {}

  /**
   * The SYNCHRONOUS composition: submit, then poll+reconcile in-process
   * (bounded). Exactly the pre-R3 behaviour for the in-process mock batch
   * provider and every existing test; a real async provider (OpenAI Batch,
   * 24h window) is driven instead by submitBatch() now and
   * reconcileBatchFromDb() later, from separate scheduler invocations.
   */
  async generateBatch(items: BatchHouseholdInput[]): Promise<BatchGenerationResult> {
    const submission = await this.submitBatch(items);
    return this.completeSubmissionInProcess(submission);
  }

  /** True when the batch provider's results exist only in this process (sync fan-out) — reconcile must happen in the same invocation. */
  get providerCompletesSynchronously(): boolean {
    return (this.batchProvider as { completesSynchronously?: boolean }).completesSynchronously === true;
  }

  /**
   * R3 — poll (bounded) and reconcile a submission in THIS process. Used by
   * generateBatch() (mock + tests) and by the scheduler when the provider
   * completes synchronously.
   */
  async completeSubmissionInProcess(submission: BatchSubmission): Promise<BatchGenerationResult> {
    if (!submission.providerBatchId || submission.admitted.length === 0) {
      return { batch: submission.batch, households: submission.households };
    }
    // Bounded poll loop — the mock always resolves COMPLETED on the first
    // poll; a real async batch provider would need several. Bounded so a
    // provider that never completes cannot hang the orchestrator forever.
    let poll = await this.batchProvider.pollBatch(submission.providerBatchId);
    for (let attempt = 0; attempt < 10 && poll.status !== 'COMPLETED'; attempt++) {
      poll = await this.batchProvider.pollBatch(submission.providerBatchId);
    }
    if (poll.status !== 'COMPLETED') {
      // Still pending after the bounded in-process wait: leave the batch
      // SUBMITTED for a later reconcileBatchFromDb() — never fail it.
      const pending = await this.batchDb.updateBatch(submission.batch.id, { poll_count: 10, next_poll_at: new Date(Date.now() + this.pollIntervalMs).toISOString(), provider_status: 'pending' });
      return { batch: pending, households: [...submission.households, ...submission.admitted.map((a) => ({ userId: a.userId, status: 'IN_PROGRESS' as const, pack: { id: a.packId } as PackRow }))] };
    }
    const reconciled = await this.applyPollResults(submission.batch, submission.admitted, poll, submission.prompt!, submission.model!);
    return { batch: reconciled.batch, households: [...submission.households, ...reconciled.households] };
  }

  /**
   * R3 phase 1 — admission + ONE provider submission. Returns immediately
   * after the provider accepts the batch; every admitted pack stays
   * GENERATING with its provider batch id and admission reservation
   * persisted, so a LATER process can reconcile (ADR-M11-002 decision 3).
   */
  async submitBatch(items: BatchHouseholdInput[]): Promise<BatchSubmission> {
    if (items.length === 0) {
      const empty = await this.batchDb.insertBatch({ provider: this.batchProvider.providerName, taskType: TASK_TYPE, requestCount: 0 });
      const completed = await this.batchDb.updateBatch(empty.id, { status: 'COMPLETED', submitted_at: new Date().toISOString(), completed_at: new Date().toISOString() });
      return { batch: completed, households: [], admitted: [], providerBatchId: null, prompt: null, model: null };
    }

    // ---- Kill switch (reused, not bypassed — the SAME check the
    // single-call service makes, applied ONCE for the whole batch since
    // it's a platform-wide switch, not a per-household one). ----
    const { globallyEnabled, batchEnabled } = await this.db.isBatchGenerationEnabled();
    if (!globallyEnabled || !batchEnabled) {
      const pending = await this.batchDb.insertBatch({ provider: this.batchProvider.providerName, taskType: TASK_TYPE, requestCount: items.length });
      const aborted = await this.batchDb.updateBatch(pending.id, { status: 'FAILED', error_summary: 'batch_disabled: ai_globally_enabled/batch_generation_enabled is off' });
      return { batch: aborted, households: items.map((i) => ({ userId: i.userId, status: 'BATCH_ABORTED_KILL_SWITCH' as const })), admitted: [], providerBatchId: null, prompt: null, model: null };
    }

    const prompt = await this.db.getActivePrompt(BATCH_PROMPT_CODE, null);
    const model = await this.db.resolveModelForTask(TASK_TYPE); // R2: configured provider/model, see insightPackService.ts
    // R3: a REAL provider-native batch needs a batch-capable model row; the
    // in-process mock and the sync fan-out transport (which uses the
    // synchronous endpoint) are exempt.
    const modelUsable = model && (this.batchProvider.providerName === 'mock' || this.providerCompletesSynchronously || model.supports_batch);
    if (!prompt || !modelUsable) {
      const pending = await this.batchDb.insertBatch({ provider: this.batchProvider.providerName, taskType: TASK_TYPE, requestCount: items.length });
      const aborted = await this.batchDb.updateBatch(pending.id, { status: 'FAILED', error_summary: !prompt ? 'no_active_prompt' : !model ? 'no_approved_model' : 'model_not_batch_capable' });
      return { batch: aborted, households: items.map((i) => ({ userId: i.userId, status: 'BATCH_ABORTED_NO_PROMPT_OR_MODEL' as const })), admitted: [], providerBatchId: null, prompt: null, model: null };
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
      return { batch: done, households: outcomes, admitted: [], providerBatchId: null, prompt, model };
    }

    // ---- ONE logical provider-side submission for every admitted household. ----
    const itemRequests: BatchPackItemRequest[] = admitted.map((a) => ({
      requestId: a.requestId,
      systemPrompt: prompt.system_prompt,
      userPrompt: buildPackUserPrompt(prompt, a.context, a.canonicalRanking),
      model: model.model_identifier,
      maxOutputTokens: 3000,
    }));
    let providerBatchId: string;
    try {
      ({ providerBatchId } = await this.batchProvider.submitBatch(itemRequests));
    } catch (err) {
      // The provider refused the whole submission: every admitted household
      // fails independently (reservation refunded, retry-eligible if the
      // cause was transient), the batch is FAILED, nothing is left dangling.
      const code = err instanceof ProviderError ? `submit_${err.code.toLowerCase()}` : 'submit_failed';
      const message = err instanceof Error ? err.message : 'Batch submission failed.';
      const preFailures = outcomes.filter((o) => o.status === 'FAILED').length;
      for (const a of admitted) {
        if (a.admissionId) await this.entitlementGate.refund(a.admissionId);
        outcomes.push(await this.applyHouseholdFailure(a, code, message));
      }
      const failed = await this.batchDb.updateBatch(batch.id, { status: 'FAILED', submitted_at: new Date().toISOString(), completed_at: new Date().toISOString(), failure_count: preFailures + admitted.length, error_summary: message.slice(0, 500) });
      return { batch: failed, households: outcomes, admitted: [], providerBatchId: null, prompt, model };
    }

    const submitted = await this.batchDb.updateBatch(batch.id, {
      status: 'SUBMITTED', submitted_at: new Date().toISOString(),
      provider_batch_id: providerBatchId,
      provider_status: 'submitted',
      next_poll_at: new Date().toISOString(),
    });
    // Persist the reservation on each pack so a different process can
    // finalise/refund it at reconciliation (migration 0176 admission_id).
    for (const a of admitted) {
      if (a.admissionId) await this.db.updatePack(a.packId, { admission_id: a.admissionId });
    }
    return { batch: submitted, households: outcomes, admitted, providerBatchId, prompt, model };
  }

  /**
   * R3 phase 2 — reconcile a SUBMITTED batch from persisted state in a
   * process that did not submit it. Rebuilds each admitted household's
   * certified context and REQUIRES its hash to equal the hash the pack was
   * admitted with: a household whose certified data changed while the
   * batch was in flight is failed closed (`context_changed_before_reconcile`)
   * rather than grounded against a context the provider never saw.
   */
  async reconcileBatchFromDb(batch: BatchRow, rebuildContext: (userId: string) => Promise<FinancialContextObject>): Promise<BatchReconcileResult> {
    if (!batch.provider_batch_id) return { batch, households: [], pending: false };
    const prompt = await this.db.getActivePrompt(BATCH_PROMPT_CODE, null);
    const model = await this.db.resolveModelForTask(TASK_TYPE);
    if (!prompt || !model) {
      return this.failWholeBatch(batch, !prompt ? 'no_active_prompt_at_reconcile' : 'no_approved_model_at_reconcile');
    }

    let poll: BatchPollResult;
    try {
      poll = await this.batchProvider.pollBatch(batch.provider_batch_id);
    } catch (err) {
      // A transient poll error is NOT a batch failure: bump the poll count,
      // push next_poll_at out, try again next tick. Bounded by maxPolls.
      const pollCount = (batch.poll_count ?? 0) + 1;
      if (pollCount >= this.maxPolls) {
        return this.failWholeBatch(batch, `poll_budget_exhausted: ${err instanceof Error ? err.message : 'poll failed'}`);
      }
      const updated = await this.batchDb.updateBatch(batch.id, { poll_count: pollCount, next_poll_at: new Date(Date.now() + this.pollIntervalMs).toISOString(), provider_status: 'poll_error' });
      return { batch: updated, households: [], pending: true };
    }
    if (poll.status !== 'COMPLETED') {
      const pollCount = (batch.poll_count ?? 0) + 1;
      if (pollCount >= this.maxPolls) {
        try { await (this.batchProvider as { cancelBatch?: (id: string) => Promise<void> }).cancelBatch?.(batch.provider_batch_id); } catch { /* best effort */ }
        return this.failWholeBatch(batch, 'poll_budget_exhausted: provider batch never completed');
      }
      const updated = await this.batchDb.updateBatch(batch.id, { poll_count: pollCount, next_poll_at: new Date(Date.now() + this.pollIntervalMs).toISOString(), provider_status: 'pending' });
      return { batch: updated, households: [], pending: true };
    }

    // Rebuild the admitted set from the persisted packs (GENERATING rows of this batch).
    const packs = (await this.batchDb.listPacksForBatch(batch.id)).filter((p) => p.status === 'GENERATING');
    const admitted: AdmittedItem[] = [];
    const households: HouseholdBatchOutcome[] = [];
    for (const pack of packs) {
      let context: FinancialContextObject | null = null;
      try {
        context = await rebuildContext(pack.user_id);
      } catch (err) {
        if (pack.admission_id) await this.entitlementGate.refund(pack.admission_id);
        households.push(await this.applyHouseholdFailure(this.admittedFromPack(pack, null, [], model), 'context_rebuild_failed', err instanceof Error ? err.message : 'context rebuild failed'));
        continue;
      }
      if (hashContext(context) !== pack.financial_context_hash || (context.meta.snapshot_id ?? '') !== pack.snapshot_id) {
        if (pack.admission_id) await this.entitlementGate.refund(pack.admission_id);
        households.push(await this.applyHouseholdFailure(this.admittedFromPack(pack, context, [], model), 'context_changed_before_reconcile', 'The certified context changed while the batch was in flight; the result is not grounded against a context the provider never saw.'));
        continue;
      }
      admitted.push(this.admittedFromPack(pack, context, this.rankingSource(context), model));
    }
    const applied = await this.applyPollResults(batch, admitted, poll, prompt, model);
    return { batch: applied.batch, households: [...households, ...applied.households], pending: false };
  }

  private admittedFromPack(pack: PackRow, context: FinancialContextObject | null, canonicalRanking: RankedPriorityArea[], model: ModelRegistryRow): AdmittedItem {
    const unpricedProvider = { providerName: model.provider, estimateCost: () => ({ inputTokens: 0, outputTokens: 0, estimatedCostUsd: Number.NaN }) } as unknown as AIProvider;
    return {
      userId: pack.user_id, householdId: pack.household_id, context: context as FinancialContextObject,
      identity: { userId: pack.user_id, snapshotId: pack.snapshot_id, financialContextHash: pack.financial_context_hash, contextSchemaVersion: pack.context_schema_version, packSchemaVersion: pack.pack_schema_version, promptCode: pack.prompt_code, promptVersion: pack.prompt_version, countryContext: pack.country_context, language: pack.language },
      identityHash: '', requestId: pack.idempotency_key ?? '', packId: pack.id, admissionId: pack.admission_id ?? null,
      isRetry: pack.retry_count > 0, existingRetryCount: Math.max(pack.retry_count - 1, 0),
      provider: context ? this.providerFactory(context, model) : unpricedProvider,
      canonicalRanking,
    };
  }

  private async failWholeBatch(batch: BatchRow, reason: string): Promise<BatchReconcileResult> {
    const packs = (await this.batchDb.listPacksForBatch(batch.id)).filter((p) => p.status === 'GENERATING');
    const households: HouseholdBatchOutcome[] = [];
    for (const pack of packs) {
      if (pack.admission_id) await this.entitlementGate.refund(pack.admission_id);
      const failed = await this.db.updatePack(pack.id, { status: 'FAILED', failure_code: 'batch_abandoned' });
      households.push({ userId: pack.user_id, status: 'FAILED', pack: failed, failureCode: 'batch_abandoned', retryable: pack.retry_count < this.maxRetries });
    }
    const failed = await this.batchDb.updateBatch(batch.id, { status: 'FAILED', completed_at: new Date().toISOString(), failure_count: packs.length, error_summary: reason.slice(0, 500), provider_status: 'abandoned' });
    return { batch: failed, households, pending: false };
  }

  /** Shared reconciliation (in-process or resumed): match by requestId only, never by position. */
  private async applyPollResults(batch: BatchRow, admitted: AdmittedItem[], poll: BatchPollResult, prompt: PromptTemplateRow, model: ModelRegistryRow): Promise<{ batch: BatchRow; households: HouseholdBatchOutcome[] }> {
    const outcomes: HouseholdBatchOutcome[] = [];
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
      if (handled.has(result.requestId)) { anomalousResultCount++; continue; } // a duplicate result for one id is applied once
      handled.add(result.requestId);
      const outcome = await this.applyHouseholdResult(target, result, prompt, model);
      outcomes.push(outcome);
    }

    // Any admitted household whose requestId never appeared in the results
    // at all (the provider silently dropped it, or the batch itself failed)
    // is handled the same way as an explicit per-item failure —
    // bounded-retry eligible, never silently treated as READY.
    for (const target of admitted) {
      if (handled.has(target.requestId)) continue;
      if (target.admissionId) await this.entitlementGate.refund(target.admissionId);
      const outcome = await this.applyHouseholdFailure(
        target,
        poll.batchFailure ? `batch_${poll.batchFailure.status}` : 'batch_result_missing',
        poll.batchFailure ? poll.batchFailure.message : 'No result was returned for this household by the batch provider.'
      );
      outcomes.push(outcome);
    }

    const successCount = outcomes.filter((o) => o.status === 'READY' || o.status === 'PARTIAL' || o.status === 'EXISTING_READY').length;
    const failureCount = outcomes.filter((o) => o.status === 'FAILED').length;
    const totalCost = outcomes.reduce((sum, o) => {
      if ((o.status === 'READY' || o.status === 'PARTIAL') && 'pack' in o && o.pack?.estimated_cost_usd) return sum + Number(o.pack.estimated_cost_usd);
      return sum;
    }, 0);
    const finalStatus = failureCount === 0 ? 'COMPLETED' : successCount > 0 ? 'PARTIAL' : 'FAILED';
    const isMock = this.batchProvider.providerName === 'mock';
    const isFanout = this.providerCompletesSynchronously;
    const done = await this.batchDb.updateBatch(batch.id, {
      status: finalStatus, completed_at: new Date().toISOString(),
      success_count: successCount, failure_count: failureCount, estimated_cost_usd: totalCost,
      // Provider-native batches are billed at the batch rate; sync fan-out at
      // the standard rate; the per-pack estimate always stays at the
      // conservative standard rate (ADR decision 8).
      actual_cost_usd: isMock ? null : isFanout ? totalCost : totalCost * this.batchPriceMultiplier,
      cost_pricing_basis: isMock ? null : isFanout ? 'standard' : 'batch',
      provider_status: poll.batchFailure ? poll.batchFailure.status : 'completed',
      error_summary: anomalousResultCount > 0 ? `${anomalousResultCount} anomalous/unmatched provider result(s) dropped` : poll.batchFailure ? poll.batchFailure.message.slice(0, 500) : null,
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
        // Brief section 31: a grounding/certification/safety/hard-cost
        // failure is terminal for this identity — never retried as if it
        // were a transient network error.
        if (existing.retry_count >= this.maxRetries || !isRetryableFailureCode(existing.failure_code)) {
          return { kind: 'outcome', outcome: { userId: item.userId, status: 'FAILED', pack: existing, failureCode: existing.failure_code ?? 'retry_budget_exhausted', retryable: false } };
        }
        isRetry = true;
        existingRetryCount = existing.retry_count;
        // R3: a retried pack must be re-parented to THIS batch, or a resumed
        // reconcile (which lists packs by batch_id) can never find it and
        // its result is dropped as "unmatched" — found by the R3 PGlite
        // certification run, not by inspection.
        const updated = await this.db.updatePack(existing.id, { status: 'GENERATING', retry_count: existing.retry_count + 1, batch_id: batchId, failure_code: null });
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

    // R1 — FHIP ranks at admission, before any provider submission. A
    // structurally invalid canonical list is a producer defect: this
    // household fails closed (no provider item, no spend), the rest of the
    // batch is unaffected.
    const canonicalRanking = this.rankingSource(item.context);
    if (assertCanonicalRanking(canonicalRanking).length > 0) {
      const failed = await this.db.updatePack(pendingPackId, { status: 'FAILED', failure_code: 'canonical_ranking_invalid' });
      return { kind: 'outcome', outcome: { userId: item.userId, status: 'FAILED', pack: failed, failureCode: 'canonical_ranking_invalid', retryable: false } };
    }

    const projectedInputTokens = Math.ceil((prompt.system_prompt.length + buildPackUserPrompt(prompt, item.context, canonicalRanking).length) / 4);
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
      item: { userId: item.userId, householdId: item.householdId, context: item.context, identity, identityHash, requestId, packId: pendingPackId, admissionId: admission.admissionId, isRetry, existingRetryCount, provider, canonicalRanking },
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
    const grounding = summarisePackGrounding(provided, target.context, knownSourceIds, mandatory, {
      canonical: target.canonicalRanking,
      provided: validation.envelope.priority_review_areas,
    });

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

    for (const candidate of storedAnswersFromValidatedPack(provided, grounding, validation.envelope, target.canonicalRanking)) {
      await this.db.upsertStoredAnswer({ userId: target.userId, householdId: target.householdId, ...candidate });
    }

    return { userId: target.userId, status: status === 'READY' ? 'READY' : 'PARTIAL', pack: readyPack };
  }

  private async applyHouseholdFailure(target: AdmittedItem, errorCode: string, errorMessage: string): Promise<HouseholdBatchOutcome> {
    const totalAttempts = target.existingRetryCount + (target.isRetry ? 1 : 0) + 1;
    const retryable = totalAttempts < this.maxRetries && isRetryableFailureCode(errorCode);
    // ai_insight_packs.failure_code is a short machine-readable code, not a
    // free-text column — the fuller message is logged here (structured,
    // no financial context in it) rather than silently discarded, so a
    // reportable failure carries its own detail somewhere durable.
    console.error(`[AIInsightPackBatchOrchestrator] household ${target.userId} pack ${target.packId} failed: ${errorCode} — ${errorMessage} (attempt ${totalAttempts}/${this.maxRetries}, retryable=${retryable})`);
    const failed = await this.db.updatePack(target.packId, { status: 'FAILED', failure_code: errorCode });
    return { userId: target.userId, status: 'FAILED', pack: failed, failureCode: errorCode, retryable };
  }
}
