/**
 * AIE-1.1 — the AI provider abstraction for document field-completion calls.
 *
 * REUSE DECISION. `lib/ai/providers/types.ts` (Module 11.0) already defines
 * `ProviderError`/`ProviderErrorCode`/`ProviderHealth`/`CostEstimate` as
 * fully generic, provider-agnostic types with no Module-11-specific
 * coupling — these are imported and reused as-is below, not redefined.
 *
 * `AIProvider`/`AIGenerateRequest`, however, ARE locked to Module 11's own
 * concerns: `AIGenerateRequest.taskType` is a closed `AITaskType` union of
 * explanation/pack task names, and `responseSchema` is a literal type fixed
 * to `'ai_response_envelope'`. Extending that closed union with document-
 * extraction task types would coscript AIE-1.1's field-completion gateway
 * onto Module 11's explanation/insight-pack gateway, entitlement service and
 * envelope schema — none of which fit a document-extraction fallback call
 * (different cost model, different schema shape per adapter/document-class,
 * no "explanation" semantics at all). AIE-1.1 spec section 19 (GW) also
 * requires its OWN, separate, typed internal extraction operation — "no
 * public/browser provider endpoint" — not a shared choke point with an
 * unrelated feature. So this file defines AIE's own request/result shape,
 * structurally modelled on `AIGenerateRequest`/`AIGenerateResult` (same
 * fields where the concept is identical: prompts, tokens, latency, finish
 * reason) but with `schemaName`/`schemaVersion` referencing
 * `lib/aie/schema/schemaRegistry.ts` instead of Module 11's fixed envelope.
 */

export type { ProviderErrorCode, ProviderHealth, CostEstimate } from '@/lib/ai/providers/types';
export { ProviderError } from '@/lib/ai/providers/types';

export interface AieAiGenerateRequest {
  /** Instructions ONLY — PRM-01: states document content is untrusted
   * evidence, never instruction. */
  systemPrompt: string;
  /** MASKED document evidence + the specific missing-field request. Built
   * exclusively by `lib/aie/provider/gateway.ts` from already-masked text —
   * no caller may construct this directly with unmasked content. */
  userPrompt: string;
  schemaName: string;
  schemaVersion: string;
  model: string;
  maxOutputTokens: number;
  temperature?: number;
  timeoutMs?: number;
}

export interface AieAiGenerateResult {
  rawText: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  modelVersion: string;
  finishReason: 'stop' | 'length' | 'content_filter' | 'error';
}

export interface AieAiProvider {
  readonly providerName: string;
  generateStructured(req: AieAiGenerateRequest): Promise<AieAiGenerateResult>;
  validateProviderHealth(): Promise<import('@/lib/ai/providers/types').ProviderHealth>;
  estimateCost(inputTokens: number, outputTokens: number, model: string): import('@/lib/ai/providers/types').CostEstimate;
}
