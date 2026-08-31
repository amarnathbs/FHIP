// Module 11.3 — AIPersonalisedInsightPackService (spec section 6).
//
// The single service responsible for the whole Monthly Personalised AI
// Insight Pack lifecycle: entitlement gate -> feature-switch gate ->
// certified-context gate -> pack identity -> idempotent admission (reusing
// Module 11.1's own advisory-lock/idempotency-key mechanism, spec sections
// 10, 67, 113) -> ONE governed provider call via AIModelGateway.generatePack()
// -> grounding validation -> persistence -> Module 11.2 answer-store
// integration. No user-facing AI output may bypass this service (spec
// section 6's own closing line).
//
// DEPENDENCY INJECTION. Mirrors lib/ai/resolution/router.ts's
// RouterDependencies pattern deliberately: the service takes its DB client
// and provider as constructor arguments rather than importing
// `createAdminClient()`/a concrete provider at module scope, so it is
// unit-testable with an in-memory double and callable from a script/route
// with no Next.js request context (buildFinancialContextObject() itself
// still needs one — see the accompanying live-dev scripts' own notes on
// that constraint, which is Module 11.0's, not introduced here).

import { AIModelGateway } from '@/lib/ai/gateway/aiModelGateway';
import type { AIProvider } from '@/lib/ai/providers/types';
import type { PromptTemplateRow } from '@/lib/ai/promptRegistry';
import type { ModelRegistryRow } from '@/lib/ai/modelRegistry';
import type { FinancialContextObject } from '@/lib/ai/context/types';
import { hashContext } from '@/lib/ai/audit/aiRuns';
import {
  PACK_SCHEMA_VERSION,
  PACK_BLOCK_CODES,
  MANDATORY_BLOCK_CODES,
  BLOCK_INTENT_MAP,
  type PackBlockCode,
  type PackIdentity,
  type ProviderPackBlock,
  type ProviderPackEnvelope,
} from '@/lib/ai/insightPack/types';
import { computePackIdentityHash, packIdempotencyKey } from '@/lib/ai/insightPack/packIdentity';
import { summarisePackGrounding } from '@/lib/ai/insightPack/groundingValidation';

export const PROMPT_CODE = 'PR-AI-013';

// ---------------------------------------------------------------------------
// The minimal DB surface the service needs — a subset of the supabase-js
// client shape, so a unit test can inject an in-memory double without
// reimplementing the whole query builder.
// ---------------------------------------------------------------------------
export interface InsightPackDbClient {
  getActivePrompt(promptCode: string, countryScope: string | null): Promise<PromptTemplateRow | null>;
  resolveModelForTask(taskType: 'monthly_insight_pack', tier?: 'LOW_COST' | 'STANDARD' | 'ADVANCED'): Promise<ModelRegistryRow | null>;
  isPersonalisedAiEligible(userId: string, householdId: string | null): Promise<boolean>;
  isBatchGenerationEnabled(): Promise<{ globallyEnabled: boolean; batchEnabled: boolean }>;
  findPackByIdentity(identity: PackIdentity, identityHash: string): Promise<PackRow | null>;
  findCurrentPackForUser(userId: string): Promise<PackRow | null>;
  insertPendingPack(input: InsertPendingPackInput): Promise<PackRow>;
  updatePack(id: string, patch: Partial<PackRow>): Promise<PackRow>;
  insertBlocks(packId: string, userId: string, householdId: string | null, blocks: PersistedBlockInput[]): Promise<void>;
  supersedeOlderPacks(userId: string, keepPackId: string): Promise<number>;
  upsertStoredAnswer(input: StoredAnswerUpsertInput): Promise<void>;
}

export interface PackRow {
  id: string;
  user_id: string;
  household_id: string | null;
  snapshot_id: string;
  financial_context_hash: string;
  context_schema_version: string;
  pack_schema_version: string;
  prompt_code: string;
  prompt_version: number;
  country_context: string | null;
  language: string;
  provider: string;
  model: string;
  model_version: string | null;
  status: string;
  overall_confidence: string | null;
  grounding_status: string | null;
  critical_safety_failure: boolean;
  generation_mode: string;
  ai_run_id: string | null;
  idempotency_key: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  estimated_cost_usd: number | null;
  generated_at: string | null;
  validated_at: string | null;
  ready_at: string | null;
  stale_at: string | null;
  superseded_at: string | null;
  failure_code: string | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
}

export interface InsertPendingPackInput {
  userId: string;
  householdId: string | null;
  identity: PackIdentity;
  identityHash: string;
  provider: string;
  model: string;
  idempotencyKey: string;
}

export interface PersistedBlockInput {
  block_code: PackBlockCode;
  status: string;
  headline: string | null;
  short_answer: string | null;
  explanation: string | null;
  why_it_matters: string | null;
  source_refs_json: unknown;
  source_metric_codes: string[];
  confidence: string | null;
  data_as_of: string | null;
  limitations_json: unknown;
  related_module: string | null;
  action_route: string | null;
  safety_classification: string | null;
  block_order: number;
  violations_json: unknown;
}

export interface StoredAnswerUpsertInput {
  userId: string;
  householdId: string | null;
  metricCode: string;
  currentValue: number | null;
  explanation: string;
  confidence: string | null;
}

export type GenerateInsightPackOutcome =
  | { status: 'NOT_ELIGIBLE' }
  | { status: 'BATCH_DISABLED' }
  | { status: 'CONTEXT_UNAVAILABLE'; reason: string }
  | { status: 'EXISTING_READY'; pack: PackRow }
  | { status: 'IN_PROGRESS'; pack: PackRow }
  | { status: 'COST_BLOCKED'; denyReason: string | null }
  | { status: 'READY'; pack: PackRow }
  | { status: 'PARTIAL'; pack: PackRow }
  | { status: 'FAILED'; pack: PackRow | null; failureCode: string };

/** Spec section 34 — one automatic regeneration per subject per rolling 24h, configurable. */
export const REGENERATION_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export function buildPackIdentity(userId: string, ctx: FinancialContextObject, prompt: PromptTemplateRow): PackIdentity {
  return {
    userId,
    snapshotId: ctx.meta.snapshot_id ?? '',
    financialContextHash: hashContext(ctx),
    contextSchemaVersion: ctx.meta.context_version,
    packSchemaVersion: PACK_SCHEMA_VERSION,
    promptCode: prompt.prompt_code,
    promptVersion: prompt.version,
    countryContext: ctx.meta.country_of_residence,
    language: 'en',
  };
}

/** Spec section 51 — mandatory blocks that don't require a domain the certified context actually lacks are skipped (not counted a failure) so a genuinely unavailable domain doesn't hard-fail a pack it was never meant to answer for. */
function mandatoryBlocksApplicableFor(ctx: FinancialContextObject): PackBlockCode[] {
  return MANDATORY_BLOCK_CODES.filter((code) => {
    if (code === 'overall_financial_summary') return ctx.cash_flow !== null || ctx.balance_sheet !== null;
    return true; // data_quality_summary/strengths/risks are always in-scope — data_quality is never null
  });
}

export class AIPersonalisedInsightPackService {
  constructor(
    private readonly db: InsightPackDbClient,
    private readonly providerFactory: (ctx: FinancialContextObject, model: ModelRegistryRow) => AIProvider
  ) {}

  /**
   * Spec sections 6, 9-11, 32: the whole orchestration. `context` is
   * ALREADY built by the caller (an API route via buildFinancialContextObject,
   * or a test/script fixture) — this service never builds it itself, so it
   * carries no Next.js request-context dependency of its own.
   */
  async generateOrGetPack(input: { userId: string; householdId: string | null; context: FinancialContextObject }): Promise<GenerateInsightPackOutcome> {
    const { userId, householdId, context } = input;

    // ---- Step 1: Premium entitlement gate (spec section 11) ----
    const eligible = await this.db.isPersonalisedAiEligible(userId, householdId);
    if (!eligible) return { status: 'NOT_ELIGIBLE' };

    // ---- Step 2: feature switches (spec section 12, 76) ----
    const { globallyEnabled, batchEnabled } = await this.db.isBatchGenerationEnabled();
    if (!globallyEnabled || !batchEnabled) return { status: 'BATCH_DISABLED' };

    // ---- Step 3: certified context gate (spec sections 17-19) ----
    if (context.meta.certification_status === 'UNAVAILABLE' || context.meta.certification_status === 'INVALID') {
      return { status: 'CONTEXT_UNAVAILABLE', reason: `context certification is ${context.meta.certification_status}` };
    }
    if (!context.meta.snapshot_id) {
      return { status: 'CONTEXT_UNAVAILABLE', reason: 'no certified snapshot_id available for this household' };
    }

    // ---- Step 4: model + prompt resolution ----
    const prompt = await this.db.getActivePrompt(PROMPT_CODE, context.meta.country_of_residence);
    if (!prompt) return { status: 'FAILED', pack: null, failureCode: 'no_active_prompt' };
    const model = await this.db.resolveModelForTask('monthly_insight_pack', 'STANDARD');
    if (!model) return { status: 'FAILED', pack: null, failureCode: 'no_approved_model' };

    // ---- Step 5: pack identity + idempotent admission (spec sections 9-10) ----
    const identity = buildPackIdentity(userId, context, prompt);
    const identityHash = computePackIdentityHash(identity);

    const existing = await this.db.findPackByIdentity(identity, identityHash);
    if (existing) {
      if (existing.status === 'READY' || existing.status === 'PARTIAL') return { status: existing.status === 'READY' ? 'EXISTING_READY' : 'PARTIAL', pack: existing };
      if (['PENDING', 'QUEUED', 'GENERATING', 'PROVIDER_COMPLETE', 'VALIDATING'].includes(existing.status)) {
        return { status: 'IN_PROGRESS', pack: existing };
      }
      // FAILED with retry budget remaining (spec section 35: max 1 controlled retry)
      if (existing.status === 'FAILED' && existing.retry_count < 1) {
        return this.executeGeneration(userId, householdId, context, prompt, model, identity, identityHash, existing);
      }
      if (existing.status === 'FAILED') return { status: 'FAILED', pack: existing, failureCode: existing.failure_code ?? 'retry_budget_exhausted' };
      // STALE/SUPERSEDED/CANCELLED for this exact identity — treat as a fresh generation attempt for the (still current) identity.
    }

    return this.executeGeneration(userId, householdId, context, prompt, model, identity, identityHash, null);
  }

  private async executeGeneration(
    userId: string,
    householdId: string | null,
    context: FinancialContextObject,
    prompt: PromptTemplateRow,
    model: ModelRegistryRow,
    identity: PackIdentity,
    identityHash: string,
    retryOf: PackRow | null
  ): Promise<GenerateInsightPackOutcome> {
    const idempotencyKey = packIdempotencyKey(identity);
    const pending = retryOf
      ? await this.db.updatePack(retryOf.id, { status: 'GENERATING', retry_count: retryOf.retry_count + 1 })
      : await this.db.insertPendingPack({ userId, householdId, identity, identityHash, provider: model.provider, model: model.model_identifier, idempotencyKey });

    const provider = this.providerFactory(context, model);
    const gateway = new AIModelGateway(provider);

    const systemPrompt = prompt.system_prompt;
    const userPrompt = `${prompt.developer_prompt}\n\nCONTEXT:\n${JSON.stringify(context)}`;

    const result = await gateway.generatePack({
      taskType: 'monthly_insight_pack',
      systemPrompt,
      userPrompt,
      prompt,
      model,
      context,
      userId,
      householdId,
      usageOutcome: 'BATCH_AI',
      idempotencyKey,
      maxOutputTokens: 3000,
    });

    if (!result.ok) {
      // Spec section 10 — a caller that lost the idempotency race sees the
      // WINNING caller's row, not a failure of its own making.
      if (result.denyReason === 'idempotency_conflict') {
        const winning = await this.db.findPackByIdentity(identity, identityHash);
        if (winning) return { status: ['READY', 'PARTIAL'].includes(winning.status) ? (winning.status === 'READY' ? 'EXISTING_READY' : 'PARTIAL') : 'IN_PROGRESS', pack: winning };
      }
      const failureCode = result.denyReason ?? result.executionStatus;
      const failed = await this.db.updatePack(pending.id, {
        status: 'FAILED',
        ai_run_id: result.aiRunId,
        failure_code: failureCode,
        updated_at: new Date().toISOString(),
      });
      if (result.executionStatus === 'rejected_entitlement' && ['user_cost_ceiling', 'platform_cost_ceiling', 'request_cost_limit', 'task_monthly_cost_limit', 'provider_cost_limit', 'daily_cost_limit'].includes(result.denyReason ?? '')) {
        return { status: 'COST_BLOCKED', denyReason: result.denyReason ?? null };
      }
      return { status: 'FAILED', pack: failed, failureCode };
    }

    // ---- Provider succeeded (schema-valid). Now grounding validation
    // (spec sections 38-51) — the step that determines READY vs PARTIAL vs
    // FAILED. Provider success alone never reaches here as "done". ----
    const provided = new Map<PackBlockCode, ProviderPackBlock>();
    for (const code of PACK_BLOCK_CODES) {
      const block = result.envelope.blocks[code];
      if (block) provided.set(code, block);
    }
    const knownSourceIds = new Set(context.source_references.map((s) => s.source_id));
    const mandatory = mandatoryBlocksApplicableFor(context);
    const grounding = summarisePackGrounding(provided, context, knownSourceIds, mandatory);

    const nowIso = new Date().toISOString();
    const blockInputs: PersistedBlockInput[] = [];
    let order = 0;
    for (const [code, block] of provided) {
      const g = grounding.blockResults.get(code)!;
      blockInputs.push({
        block_code: code,
        status: g.status,
        headline: g.status === 'GROUNDED' ? block.headline || null : null,
        short_answer: g.status === 'GROUNDED' ? block.short_answer || null : null,
        explanation: g.status === 'GROUNDED' ? block.explanation || null : null,
        why_it_matters: g.status === 'GROUNDED' ? block.why_it_matters || null : null,
        source_refs_json: g.status === 'GROUNDED' ? block.source_refs : [],
        source_metric_codes: g.status === 'GROUNDED' ? block.metric_claims.map((c) => c.metric_code) : [],
        confidence: g.status === 'GROUNDED' ? block.confidence : null,
        data_as_of: block.data_as_of,
        limitations_json: block.limitations,
        related_module: block.related_module,
        action_route: block.action_route,
        safety_classification: g.safetyClassification,
        block_order: order++,
        violations_json: g.violations,
      });
    }
    await this.db.insertBlocks(pending.id, userId, householdId, blockInputs);

    if (grounding.overallStatus === 'FAIL') {
      const failed = await this.db.updatePack(pending.id, {
        status: 'FAILED',
        validated_at: nowIso,
        ai_run_id: result.aiRunId,
        grounding_status: 'FAIL',
        critical_safety_failure: grounding.criticalSafetyFailure,
        failure_code: grounding.criticalSafetyFailure ? 'safety_violation' : `grounding_failure:${grounding.mandatoryBlockFailed}`,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        estimated_cost_usd: result.estimatedCostUsd,
        updated_at: nowIso,
      });
      return { status: 'FAILED', pack: failed, failureCode: failed.failure_code ?? 'grounding_failure' };
    }

    const status = grounding.overallStatus === 'PASS' ? 'READY' : 'PARTIAL';
    const readyPatch: Partial<PackRow> = {
      status,
      overall_confidence: result.envelope.overall_confidence,
      grounding_status: grounding.overallStatus === 'PASS' ? 'PASS' : 'PARTIAL',
      critical_safety_failure: false,
      generated_at: nowIso,
      validated_at: nowIso,
      ready_at: status === 'READY' ? nowIso : null,
      ai_run_id: result.aiRunId,
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
      estimated_cost_usd: result.estimatedCostUsd,
      model_version: model.model_identifier,
      updated_at: nowIso,
    };
    const readyPack = await this.db.updatePack(pending.id, readyPatch);

    // Spec sections 32-33, 62-63: mark any OTHER current pack for this user
    // (a different, older identity/snapshot) STALE/SUPERSEDED now that this
    // one is current.
    await this.db.supersedeOlderPacks(userId, readyPack.id);

    // Spec sections 29, 59: feed the Module 11.2 STORED_PERSONALISED answer
    // store — ONLY from GROUNDED blocks, and only for the (deliberately
    // small) block->intent mapping this phase wires.
    for (const [blockCode, intentCode] of BLOCK_INTENT_MAP) {
      const g = grounding.blockResults.get(blockCode);
      const block = provided.get(blockCode);
      if (!g || g.status !== 'GROUNDED' || !block) continue;
      await this.db.upsertStoredAnswer({
        userId,
        householdId,
        metricCode: intentCode,
        currentValue: block.metric_claims[0]?.source_value ?? null,
        explanation: block.explanation || block.short_answer,
        confidence: block.confidence,
      });
    }

    return { status: status === 'READY' ? 'READY' : 'PARTIAL', pack: readyPack };
  }
}

export { mandatoryBlocksApplicableFor as _mandatoryBlocksApplicableForTest };
export type { ProviderPackEnvelope };
