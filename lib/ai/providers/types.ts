// Module 11.0 — Provider abstraction (spec sections 25-26).
//
// AIModelGateway is the ONLY caller of these. No business service may import
// a provider adapter directly, and no adapter may be reached without going
// through the gateway's certification/allowlist/audit pipeline first.

export type AITaskType =
  | 'score_explanation'
  | 'monthly_summary'
  | 'next_best_action'
  | 'forecast_explanation'
  | 'twin_explanation'
  | 'missing_data_explanation'
  | 'resilience_explanation'
  | 'dna_explanation'
  | 'goal_progress_explanation'
  | 'general_coach'
  | 'report_explanation'
  | 'cross_border_explanation'
  // Module 11.3 — single governed generation producing the whole Monthly
  // Personalised Insight Pack (spec section 13). Deliberately a NEW value
  // rather than reusing 'monthly_summary': that task type's registered
  // contract targets the single-envelope ai_response_envelope schema, and
  // spec section 36 forbids silently repurposing an existing prompt/task
  // contract whose shape differs materially.
  | 'monthly_insight_pack';

export interface AIGenerateRequest {
  /** Rendered system prompt — instructions ONLY, never user/retrieved data. */
  systemPrompt: string;
  /** Rendered developer/template prompt with the Financial Context Object already interpolated as DATA, never as instruction text. */
  userPrompt: string;
  taskType: AITaskType;
  model: string;
  maxOutputTokens: number;
  /** JSON schema name the response envelope must validate against (see lib/ai/structuredOutput.ts). */
  responseSchema: 'ai_response_envelope';
  temperature?: number;
  timeoutMs?: number;
}

export interface AIGenerateResult {
  /** Raw text as returned by the provider — NOT yet schema-validated. Caller (gateway) validates. */
  rawText: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  latencyMs: number;
  modelVersion: string;
  finishReason: 'stop' | 'length' | 'content_filter' | 'error';
}

export type ProviderErrorCode = 'TIMEOUT' | 'AUTH' | 'RATE_LIMIT' | 'INVALID_REQUEST' | 'PROVIDER_UNAVAILABLE' | 'UNKNOWN';

export class ProviderError extends Error {
  code: ProviderErrorCode;
  constructor(code: ProviderErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'ProviderError';
  }
}

export interface ProviderHealth {
  healthy: boolean;
  checkedAt: string;
  detail: string | null;
}

export interface CostEstimate {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

/**
 * Provider-independent interface. Every adapter (MockAIProvider,
 * OpenAIProviderAdapter, any future_provider_adapter) implements exactly
 * this — AIModelGateway never imports a vendor SDK type.
 */
export interface AIProvider {
  readonly providerName: string;
  generateStructured(req: AIGenerateRequest): Promise<AIGenerateResult>;
  validateProviderHealth(): Promise<ProviderHealth>;
  estimateCost(inputTokens: number, outputTokens: number, model: string): CostEstimate;
}
