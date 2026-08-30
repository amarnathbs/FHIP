// Module 11.0 — AIModelGateway (spec section 25).
//
// The ONLY path any future business service may use to reach an AI
// provider. Every call: resolves the model from the registry, validates the
// provider response against the structured-output schema, cross-checks
// source references against what the context actually offered, records an
// ai_runs audit row (success or failure), and fails closed on any error
// (ADR-M11-001 decisions #4, #8, #13).

import type { AIProvider, AITaskType, ProviderHealth } from '@/lib/ai/providers/types';
import { ProviderError } from '@/lib/ai/providers/types';
import { validateProviderResponse, type AIResponseEnvelope } from '@/lib/ai/structuredOutput';
import { recordAiRun, type ExecutionStatus } from '@/lib/ai/audit/aiRuns';
import type { ModelRegistryRow } from '@/lib/ai/modelRegistry';
import type { PromptTemplateRow } from '@/lib/ai/promptRegistry';
import type { FinancialContextObject } from '@/lib/ai/context/types';
import { estimateCallCost } from '@/lib/ai/cost/registryCost';
import { dbEntitlementGate } from '@/lib/ai/entitlement/entitlementService';
import { DENY_REASON_MESSAGES, type AdmissionDenyReason, type AIRequestClass, type EntitlementGate } from '@/lib/ai/entitlement/types';

export type GatewayResult =
  | { ok: true; envelope: AIResponseEnvelope; aiRunId: string }
  | { ok: false; reason: string; executionStatus: ExecutionStatus; aiRunId: string | null; denyReason?: AdmissionDenyReason };

export interface GenerateExplanationRequest {
  taskType: AITaskType;
  systemPrompt: string;
  userPrompt: string;
  prompt: PromptTemplateRow | null;
  model: ModelRegistryRow | null;
  context: FinancialContextObject;
  userId: string;
  householdId: string | null;
  /**
   * Module 11.1 — REQUIRED. Which commercial class of request this is:
   * 'custom' (user-initiated, Premium-only, metered against the monthly
   * allowance) or 'standard' (system-generated personalised content, not
   * metered). There is deliberately no default: guessing wrong either burns a
   * user's allowance silently or gives away unmetered custom AI.
   */
  requestClass: AIRequestClass;
  /**
   * Module 11.1 — true only when this answer is being served from
   * ai_answer_cache, in which case it consumes no allowance. MUST be derived
   * server-side (lib/ai/cache/answerCache.ts) and never taken from a request
   * body. Defaults to false, the quota-consuming direction.
   */
  cacheHit?: boolean;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 800;

export class AIModelGateway {
  /**
   * The entitlement gate defaults to the real DB-backed one. That default is
   * deliberate: an enforcement layer that is off unless someone remembers to
   * switch it on is not enforcement. Tests inject a stub explicitly, so a
   * bypass is always visible at the construction site.
   */
  constructor(
    private readonly provider: AIProvider,
    private readonly entitlementGate: EntitlementGate = dbEntitlementGate
  ) {}

  async validateProviderHealth(): Promise<ProviderHealth> {
    return this.provider.validateProviderHealth();
  }

  estimateUsage(systemPrompt: string, userPrompt: string, model: string) {
    // Delegates to the provider's own estimator so estimates stay
    // provider-accurate without the gateway needing to know tokenizer
    // details (spec section 55).
    const roughInput = Math.ceil((systemPrompt.length + userPrompt.length) / 4);
    return this.provider.estimateCost(roughInput, DEFAULT_MAX_OUTPUT_TOKENS, model);
  }

  estimateCost(inputTokens: number, outputTokens: number, model: string) {
    return this.provider.estimateCost(inputTokens, outputTokens, model);
  }

  /**
   * The single entry point for a governed AI explanation. Fails closed at
   * every stage: no model configured, no prompt configured, uncertified
   * context, provider error/timeout, schema-invalid response, or an unknown
   * source reference all produce `{ ok: false, ... }` with an audited
   * ai_runs row — never a partially-trusted answer (spec section 47).
   */
  async generateExplanation(req: GenerateExplanationRequest): Promise<GatewayResult> {
    const knownSourceIds = new Set(req.context.source_references.map((s) => s.source_id));

    if (!req.model) {
      return this.reject(req, 'rejected_certification', 'No approved model is configured for this task type.', null);
    }
    if (!req.prompt) {
      return this.reject(req, 'rejected_certification', 'No ACTIVE prompt template is configured for this task type.', null);
    }
    if (req.context.meta.certification_status === 'UNAVAILABLE' || req.context.meta.certification_status === 'INVALID') {
      return this.reject(req, 'rejected_certification', `Financial context is ${req.context.meta.certification_status}; no personalised explanation can be generated.`, null);
    }

    // -----------------------------------------------------------------------
    // Module 11.1 — commercial/cost admission gate.
    //
    // Placed HERE, after the three free local certification gates and
    // immediately before the only provider.generateStructured() call in the
    // codebase, for two reasons:
    //   * it is genuinely pre-provider, so no provider call and no spend can
    //     ever happen without an admission decision; and
    //   * the free local gates run first, so a request that was going to be
    //     rejected for having no approved model, no ACTIVE prompt, or an
    //     uncertified context never burns a unit of the user's monthly
    //     allowance on a call that was never going to happen.
    //
    // The estimate fed to the ceilings is an upper bound: real input tokens
    // (approximated) plus the FULL output budget, which the model may not use.
    // Erring high is the correct direction for a spend ceiling.
    // -----------------------------------------------------------------------
    const projectedInputTokens = Math.ceil((req.systemPrompt.length + req.userPrompt.length) / 4);
    const projectedCost = estimateCallCost(
      this.provider,
      req.model,
      projectedInputTokens,
      req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
    );

    const admission = await this.entitlementGate.admit({
      userId: req.userId,
      householdId: req.householdId,
      requestClass: req.requestClass,
      taskType: req.taskType,
      provider: this.provider.providerName,
      model: req.model.model_identifier,
      internalTier: req.model.internal_tier,
      estimatedCostUsd: projectedCost.estimatedCostUsd,
      cacheHit: req.cacheHit === true,
    });

    if (!admission.allowed) {
      const reasonCode: AdmissionDenyReason = admission.denyReason ?? 'enforcement_unavailable';
      const rejection = await this.reject(req, 'rejected_entitlement', DENY_REASON_MESSAGES[reasonCode], null, reasonCode);
      return rejection.ok ? rejection : { ...rejection, denyReason: reasonCode };
    }

    /**
     * Module 11.1 — quota is consumed BEFORE the provider call (it has to be,
     * or it is not a pre-provider gate). If the call it paid for then produces
     * no usable answer, the question is returned to the user's allowance: a
     * provider outage must not silently eat a month's entitlement. The
     * recorded COST is deliberately NOT refunded — if the provider was
     * invoked, real money may have been spent, and refunding it would turn a
     * spend ceiling into a fiction.
     */
    const refundConsumedQuestion = async (): Promise<void> => {
      if (admission.quotaConsumed && admission.admissionId) {
        await this.entitlementGate.refund(admission.admissionId);
      }
    };

    let result;
    try {
      result = await this.provider.generateStructured({
        systemPrompt: req.systemPrompt,
        userPrompt: req.userPrompt,
        taskType: req.taskType,
        model: req.model.model_identifier,
        maxOutputTokens: req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        responseSchema: 'ai_response_envelope',
        timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    } catch (err) {
      const status: ExecutionStatus = err instanceof ProviderError && err.code === 'TIMEOUT' ? 'timeout' : 'provider_error';
      await refundConsumedQuestion();
      return this.reject(req, status, err instanceof Error ? err.message : 'Unknown provider error.', null);
    }

    const validation = validateProviderResponse(result.rawText);
    if (!validation.ok) {
      await refundConsumedQuestion();
      return this.reject(req, 'rejected_schema', validation.reason, {
        provider: this.provider.providerName,
        model: req.model.model_identifier,
        modelVersion: result.modelVersion,
        inputTokenCount: result.inputTokens,
        outputTokenCount: result.outputTokens,
        cachedInputTokenCount: result.cachedInputTokens,
        latencyMs: result.latencyMs,
      });
    }

    const unknownRefs = validation.envelope.source_refs.filter((r) => !knownSourceIds.has(r.source_id));
    if (unknownRefs.length > 0) {
      await refundConsumedQuestion();
      return this.reject(req, 'rejected_source_ref', `Response cited ${unknownRefs.length} source(s) not present in the supplied context.`, {
        provider: this.provider.providerName,
        model: req.model.model_identifier,
        modelVersion: result.modelVersion,
        inputTokenCount: result.inputTokens,
        outputTokenCount: result.outputTokens,
        cachedInputTokenCount: result.cachedInputTokens,
        latencyMs: result.latencyMs,
      });
    }

    // Module 11.1: price the ACTUAL token usage, preferring the model
    // registry's own per-model rates over the provider adapter's single
    // indicative default (see lib/ai/cost/registryCost.ts for the accuracy
    // limitations this figure carries).
    const cost = estimateCallCost(this.provider, req.model, result.inputTokens, result.outputTokens);
    const aiRunId = await recordAiRun({
      userId: req.userId,
      householdId: req.householdId,
      requestType: req.taskType,
      promptTemplateId: req.prompt.id,
      promptVersion: req.prompt.version,
      contextVersion: req.context.meta.context_version,
      contextObject: req.context,
      sourceReferenceIds: Array.from(knownSourceIds),
      provider: this.provider.providerName,
      model: req.model.model_identifier,
      modelVersion: result.modelVersion,
      inputTokenCount: result.inputTokens,
      cachedInputTokenCount: result.cachedInputTokens,
      outputTokenCount: result.outputTokens,
      estimatedCostUsd: cost.estimatedCostUsd,
      latencyMs: result.latencyMs,
      structuredOutput: validation.envelope,
      safetyClassification: validation.envelope.safety_classification,
      safetyFlags: [],
      groundingStatus: 'grounded',
      executionStatus: 'success',
      errorCode: null,
    });

    return { ok: true, envelope: validation.envelope, aiRunId };
  }

  private async reject(
    req: GenerateExplanationRequest,
    status: ExecutionStatus,
    reason: string,
    partialResult: { provider: string; model: string; modelVersion: string | null; inputTokenCount: number; outputTokenCount: number; cachedInputTokenCount: number; latencyMs: number } | null,
    /**
     * Module 11.1 — overrides ai_runs.error_code. An entitlement rejection
     * carries the SPECIFIC reason (quota_exhausted, not_premium,
     * kill_switch_active, ...) rather than the generic status, so one new
     * execution_status value preserves full audit granularity.
     */
    errorCode?: string
  ): Promise<GatewayResult> {
    let aiRunId: string | null = null;
    try {
      aiRunId = await recordAiRun({
        userId: req.userId,
        householdId: req.householdId,
        requestType: req.taskType,
        promptTemplateId: req.prompt?.id ?? null,
        promptVersion: req.prompt?.version ?? null,
        contextVersion: req.context.meta.context_version,
        contextObject: req.context,
        sourceReferenceIds: req.context.source_references.map((s) => s.source_id),
        provider: partialResult?.provider ?? this.provider.providerName,
        model: partialResult?.model ?? req.model?.model_identifier ?? 'unresolved',
        modelVersion: partialResult?.modelVersion ?? null,
        inputTokenCount: partialResult?.inputTokenCount ?? 0,
        cachedInputTokenCount: partialResult?.cachedInputTokenCount ?? 0,
        outputTokenCount: partialResult?.outputTokenCount ?? 0,
        estimatedCostUsd: 0,
        latencyMs: partialResult?.latencyMs ?? 0,
        structuredOutput: null,
        safetyClassification: null,
        safetyFlags: [],
        groundingStatus: 'not_applicable',
        executionStatus: status,
        errorCode: errorCode ?? status,
      });
    } catch {
      // Audit-write failure must never mask the original rejection reason,
      // and must never itself become a thrown, unhandled error on a
      // fail-closed path — swallow and surface aiRunId: null instead.
    }
    return { ok: false, reason, executionStatus: status, aiRunId };
  }
}
