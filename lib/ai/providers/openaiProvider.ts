// Module 11.0 — OpenAIProviderAdapter (spec section 26).
//
// Minimum-viable production provider adapter, built ONLY to prove the
// AIProvider abstraction holds against a real vendor SDK shape — nothing in
// Module 11.0 calls this from a user-facing path (no user-facing AI Coach
// exists yet, spec section 48). No test in this module spends a paid token:
// every automated test uses MockAIProvider instead.
//
// The provider API key is read from process.env only, inside this
// server-only module — it is never accepted as a constructor argument from
// a caller, never logged, and this file is never imported by client code.

import type { AIGenerateRequest, AIGenerateResult, AIProvider, CostEstimate, ProviderHealth } from '@/lib/ai/providers/types';
import { ProviderError } from '@/lib/ai/providers/types';
import { estimateTokens } from '@/lib/ai/providers/mockProvider';

// Indicative per-1K-token USD pricing for cost-estimation/aggregation only
// (spec section 55) — not billing-accurate, and never used to make a real
// call unless OPENAI_API_KEY is actually configured.
const INDICATIVE_PRICING_PER_1K: Record<string, { input: number; output: number }> = {
  default: { input: 0.15, output: 0.6 },
};

export class OpenAIProviderAdapter implements AIProvider {
  readonly providerName = 'openai';

  private apiKey(): string {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new ProviderError('AUTH', 'OPENAI_API_KEY is not configured in this environment.');
    return key;
  }

  async generateStructured(req: AIGenerateRequest): Promise<AIGenerateResult> {
    // Deliberately not wired to a live network call in Module 11.0 — no
    // user-facing feature calls this adapter, so there is nothing to
    // exercise it against, and calling out unconditionally here would risk
    // spending paid tokens the moment any future code imports this module.
    // A real integration is Phase 11.1+ work, gated on Product Owner
    // authorisation for live provider spend. `req` is intentionally unused
    // until then — kept as a named parameter so the AIProvider interface
    // shape stays honest about what a real call would receive.
    void req;
    this.apiKey();
    throw new ProviderError('PROVIDER_UNAVAILABLE', 'OpenAIProviderAdapter is not activated in Module 11.0 (architecture-proof only — see ADR-M11-001).');
  }

  async validateProviderHealth(): Promise<ProviderHealth> {
    try {
      this.apiKey();
      return { healthy: false, checkedAt: new Date().toISOString(), detail: 'Adapter present but not activated in Module 11.0.' };
    } catch (e) {
      return { healthy: false, checkedAt: new Date().toISOString(), detail: e instanceof Error ? e.message : 'Unknown error.' };
    }
  }

  estimateCost(inputTokens: number, outputTokens: number, model: string): CostEstimate {
    const pricing = INDICATIVE_PRICING_PER_1K[model] ?? INDICATIVE_PRICING_PER_1K.default;
    const estimatedCostUsd = (inputTokens / 1000) * pricing.input + (outputTokens / 1000) * pricing.output;
    return { inputTokens, outputTokens, estimatedCostUsd };
  }
}

// Exported for cost-preparation tests / documentation only.
export { estimateTokens };
