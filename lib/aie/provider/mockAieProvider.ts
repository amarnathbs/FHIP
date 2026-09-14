/**
 * AIE-1.1 — deterministic mock AI provider for tests and DEV.
 *
 * NO REAL EXTERNAL AI PROVIDER TRAFFIC in this pass (explicit constraint).
 * This mirrors `lib/ai/providers/mockProvider.ts`'s own role for Module
 * 11 — a fully deterministic, offline stand-in — but returns AIE's own
 * result shape. A real provider adapter (e.g. wrapping
 * `lib/ai/providers/openaiProvider.ts`'s HTTP-call technique) is
 * explicitly deferred to whichever future phase is separately authorised
 * to make live provider calls; see AIE_1_1_IMPLEMENTATION.md.
 */

import type { AieAiGenerateRequest, AieAiGenerateResult, AieAiProvider } from './types';
import { ProviderError } from '@/lib/ai/providers/types';

export interface MockAieProviderScript {
  /** Called once per `generateStructured` invocation; return the raw text
   * the "provider" should respond with, or throw a ProviderError to
   * simulate a failure mode. */
  respond: (req: AieAiGenerateRequest) => string;
}

export class MockAieProvider implements AieAiProvider {
  readonly providerName = 'mock';
  constructor(private readonly script: MockAieProviderScript) {}

  async generateStructured(req: AieAiGenerateRequest): Promise<AieAiGenerateResult> {
    const start = Date.now();
    let rawText: string;
    try {
      rawText = this.script.respond(req);
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      throw new ProviderError('UNKNOWN', e instanceof Error ? e.message : 'mock provider failure');
    }
    return {
      rawText,
      inputTokens: Math.ceil(req.userPrompt.length / 4),
      outputTokens: Math.ceil(rawText.length / 4),
      latencyMs: Date.now() - start,
      modelVersion: `${req.model}-mock`,
      finishReason: 'stop',
    };
  }

  async validateProviderHealth() {
    return { healthy: true, checkedAt: new Date().toISOString(), detail: null };
  }

  estimateCost(inputTokens: number, outputTokens: number) {
    // Nominal, non-zero figures so cost-accounting call sites have
    // something real to sum, never actually billed.
    return { inputTokens, outputTokens, estimatedCostUsd: (inputTokens + outputTokens) * 0.000001 };
  }
}
