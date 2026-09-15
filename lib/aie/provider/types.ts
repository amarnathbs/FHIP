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
  /**
   * M12C `M2-OPEN-5` — COST-ACCOUNTING CONTRACT. `inputTokens`/`outputTokens`
   * are the CUMULATIVE totals across EVERY provider attempt made inside this
   * ONE logical `generateStructured` call (i.e. including the attempts that
   * were transiently retried), NOT just the attempt that finally returned.
   * These are therefore the settle-relevant figures: `gateway.ts` passes
   * exactly these to `costAdmission.settle`, so a call that was rate-limited
   * twice before succeeding is billed for all three attempts' reported usage
   * rather than only the last one's.
   *
   * A provider implementation that only ever makes one HTTP attempt (e.g.
   * `mockAieProvider.ts`) satisfies this contract trivially: cumulative ==
   * that single attempt.
   */
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  modelVersion: string;
  finishReason: 'stop' | 'length' | 'content_filter' | 'error';
  /**
   * M12C `M2-OPEN-5` — the FINAL (returning) attempt's usage, kept separate
   * and explicit so that widening `inputTokens`/`outputTokens` to cumulative
   * totals cannot SILENTLY change the meaning of anything that genuinely
   * wanted the last attempt's numbers (e.g. a per-response latency/usage
   * ratio). Optional rather than required so that existing provider
   * implementations and test stubs written against the pre-M12C shape keep
   * compiling; a consumer that needs them should fall back to the cumulative
   * figures (`finalAttemptInputTokens ?? inputTokens`), which is exactly
   * correct for a single-attempt provider.
   */
  finalAttemptInputTokens?: number;
  finalAttemptOutputTokens?: number;
  /** Number of provider attempts actually made (>= 1). Optional for the same
   * backward-compatibility reason; absent means "not reported", which for a
   * single-attempt provider is equivalent to 1. */
  attemptCount?: number;
}

/**
 * M12C `M2-OPEN-5` — usage that was already incurred when a provider call
 * ultimately FAILS.
 *
 * The problem: `OpenAiAieProvider.generateStructured` THROWS once its bounded
 * retry budget is exhausted, so up to 3 real HTTP requests can have been sent
 * (and billed) while the gateway's catch block had literally nothing to
 * settle but `0, 0`. The fix needs the already-incurred usage to survive the
 * throw.
 *
 * DELIBERATELY NARROW CHOICE. Two alternatives were rejected:
 *   (a) adding fields to the shared `ProviderError` class in
 *       `lib/ai/providers/types.ts` — that class is Module 11.0's, used by an
 *       unrelated feature's gateway/adapters, and widening it for an AIE-only
 *       concern would couple the two modules for no benefit;
 *   (b) making the provider RETURN instead of THROW on exhaustion — that
 *       changes the provider's error contract, which `gateway.ts`'s
 *       `mapProviderErrorToOutcome` and four existing adapter tests depend
 *       on, and would have been a far wider blast radius.
 * Instead the usage rides along as an extra own-property on the thrown error
 * object under one well-known key, written by `attachAieCumulativeUsage` and
 * read back defensively by `readAieCumulativeUsage`. Nothing that does not
 * know about the key is affected, and an error from any other source simply
 * reads back as `null` (=> the gateway settles 0, exactly as before).
 */
export interface AieCumulativeAttemptUsage {
  /** Summed `usage.prompt_tokens` over every attempt that actually returned a
   * parseable body. */
  cumulativeInputTokens: number;
  /** Summed `usage.completion_tokens` over the same attempts. */
  cumulativeOutputTokens: number;
  /** How many provider attempts were made before this error was thrown. */
  attemptCount: number;
}

/** The single well-known own-property key used to carry
 * `AieCumulativeAttemptUsage` on a thrown provider error. */
export const AIE_CUMULATIVE_USAGE_KEY = '__aieCumulativeAttemptUsage';

/** Attach already-incurred usage to an error about to be thrown, and return
 * the same error so call sites can write `throw attachAieCumulativeUsage(e, u)`. */
export function attachAieCumulativeUsage<E>(error: E, usage: AieCumulativeAttemptUsage): E {
  if (error && typeof error === 'object') {
    Object.defineProperty(error, AIE_CUMULATIVE_USAGE_KEY, {
      value: usage,
      enumerable: false, // never widens what a logged/serialised error exposes
      configurable: true,
      writable: true,
    });
  }
  return error;
}

/** Read usage off a thrown error, or `null` when the error did not carry any
 * (any non-AIE error, or an AIE failure that happened before the first
 * attempt — e.g. a missing API key). `null` MUST be settled as zero, never
 * guessed. */
export function readAieCumulativeUsage(error: unknown): AieCumulativeAttemptUsage | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = (error as Record<string, unknown>)[AIE_CUMULATIVE_USAGE_KEY];
  if (!candidate || typeof candidate !== 'object') return null;
  const u = candidate as Partial<AieCumulativeAttemptUsage>;
  if (typeof u.cumulativeInputTokens !== 'number' || typeof u.cumulativeOutputTokens !== 'number') return null;
  return {
    cumulativeInputTokens: u.cumulativeInputTokens,
    cumulativeOutputTokens: u.cumulativeOutputTokens,
    attemptCount: typeof u.attemptCount === 'number' ? u.attemptCount : 0,
  };
}

export interface AieAiProvider {
  readonly providerName: string;
  generateStructured(req: AieAiGenerateRequest): Promise<AieAiGenerateResult>;
  validateProviderHealth(): Promise<import('@/lib/ai/providers/types').ProviderHealth>;
  estimateCost(inputTokens: number, outputTokens: number, model: string): import('@/lib/ai/providers/types').CostEstimate;
}
