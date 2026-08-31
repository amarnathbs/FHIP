// Module 11.0 — MockAIProvider (spec section 26).
//
// Deterministic, zero-network, zero-cost provider used by every automated
// test and by the DEV context-preview tooling. It never spends a paid API
// token. Its behaviour is driven entirely by a `MockBehavior` the caller
// selects (defaults to 'valid'), so tests can exercise every failure mode
// in spec section 51 without a real provider ever being involved.

import type { AIGenerateRequest, AIGenerateResult, AIProvider, CostEstimate, ProviderHealth } from '@/lib/ai/providers/types';
import { ProviderError } from '@/lib/ai/providers/types';

export type MockBehavior =
  | 'valid'
  | 'malformed_json'
  | 'schema_invalid'
  | 'unknown_source_ref'
  | 'timeout'
  | 'provider_unavailable'
  | 'fabricated_number';

export interface MockAIProviderOptions {
  behavior?: MockBehavior;
  /** Overrides the default valid envelope's fields for a specific test. */
  envelopeOverrides?: Record<string, unknown>;
}

const MOCK_MODEL_VERSION = 'mock-1.0.0';

// Very rough token estimator (chars/4) — good enough for cost-preparation
// tests (spec section 55), which never require real tokenizer parity since
// no paid call is ever made against these numbers.
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export class MockAIProvider implements AIProvider {
  readonly providerName = 'mock';
  private behavior: MockBehavior;
  private envelopeOverrides: Record<string, unknown>;

  constructor(options: MockAIProviderOptions = {}) {
    this.behavior = options.behavior ?? 'valid';
    this.envelopeOverrides = options.envelopeOverrides ?? {};
  }

  async generateStructured(req: AIGenerateRequest): Promise<AIGenerateResult> {
    const start = Date.now();

    if (this.behavior === 'timeout') {
      throw new ProviderError('TIMEOUT', 'Mock provider simulated a timeout.');
    }
    if (this.behavior === 'provider_unavailable') {
      throw new ProviderError('PROVIDER_UNAVAILABLE', 'Mock provider simulated an outage.');
    }

    const inputTokens = estimateTokens(req.systemPrompt + req.userPrompt);
    let rawText: string;

    switch (this.behavior) {
      case 'malformed_json':
        rawText = '{ this is not valid json ';
        break;
      case 'schema_invalid':
        rawText = JSON.stringify({ headline: 'missing required fields' });
        break;
      case 'unknown_source_ref':
        rawText = JSON.stringify(this.buildValidEnvelope(req, [{ source_type: 'health_score', source_id: 'does-not-exist', model_version: null, data_as_of: null }]));
        break;
      case 'fabricated_number':
        rawText = JSON.stringify({
          ...this.buildValidEnvelope(req),
          summary: 'Your net worth is exactly $9,999,999 and growing 40% a year.',
        });
        break;
      case 'valid':
      default:
        rawText = JSON.stringify(this.buildValidEnvelope(req));
        break;
    }

    const outputTokens = estimateTokens(rawText);
    return {
      rawText,
      inputTokens,
      outputTokens,
      cachedInputTokens: 0,
      latencyMs: Date.now() - start,
      modelVersion: MOCK_MODEL_VERSION,
      finishReason: 'stop',
    };
  }

  private buildValidEnvelope(req: AIGenerateRequest, sourceRefs?: Record<string, unknown>[]) {
    return {
      answer_type: req.taskType,
      headline: 'Mock explanation headline',
      summary: 'This is a deterministic mock explanation used for automated testing only.',
      key_points: ['Mock key point one', 'Mock key point two'],
      actions: [],
      source_refs: sourceRefs ?? [],
      confidence: 'medium',
      data_as_of: null,
      limitations: [],
      safety_classification: 'FHIP_EXPLANATION',
      prompt_version: 'mock-prompt-1',
      model_version: MOCK_MODEL_VERSION,
      ...this.envelopeOverrides,
    };
  }

  async validateProviderHealth(): Promise<ProviderHealth> {
    if (this.behavior === 'provider_unavailable') {
      return { healthy: false, checkedAt: new Date().toISOString(), detail: 'Mock provider simulated an outage.' };
    }
    return { healthy: true, checkedAt: new Date().toISOString(), detail: null };
  }

  estimateCost(inputTokens: number, outputTokens: number, model?: string): CostEstimate {
    // Mock cost model: $0/token — never a real charge, but shaped identically
    // to a real adapter's estimate so aggregation code is provider-agnostic.
    // `model` is accepted (matching AIProvider's real-adapter shape) but
    // irrelevant to the mock's always-zero pricing.
    void model;
    return { inputTokens, outputTokens, estimatedCostUsd: 0 };
  }
}
