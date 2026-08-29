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

export type GatewayResult =
  | { ok: true; envelope: AIResponseEnvelope; aiRunId: string }
  | { ok: false; reason: string; executionStatus: ExecutionStatus; aiRunId: string | null };

export interface GenerateExplanationRequest {
  taskType: AITaskType;
  systemPrompt: string;
  userPrompt: string;
  prompt: PromptTemplateRow | null;
  model: ModelRegistryRow | null;
  context: FinancialContextObject;
  userId: string;
  householdId: string | null;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 800;

export class AIModelGateway {
  constructor(private readonly provider: AIProvider) {}

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
      return this.reject(req, status, err instanceof Error ? err.message : 'Unknown provider error.', null);
    }

    const validation = validateProviderResponse(result.rawText);
    if (!validation.ok) {
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

    const cost = this.provider.estimateCost(result.inputTokens, result.outputTokens, req.model.model_identifier);
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
    partialResult: { provider: string; model: string; modelVersion: string | null; inputTokenCount: number; outputTokenCount: number; cachedInputTokenCount: number; latencyMs: number } | null
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
        errorCode: status,
      });
    } catch {
      // Audit-write failure must never mask the original rejection reason,
      // and must never itself become a thrown, unhandled error on a
      // fail-closed path — swallow and surface aiRunId: null instead.
    }
    return { ok: false, reason, executionStatus: status, aiRunId };
  }
}
