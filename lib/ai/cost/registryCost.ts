// Module 11.1 — registry-driven cost estimation.
//
// WHY THIS EXISTS. Module 11.0 shipped a cost estimator whose entire price
// table is one hardcoded entry (lib/ai/providers/openaiProvider.ts):
//
//     const INDICATIVE_PRICING_PER_1K = { default: { input: 0.15, output: 0.6 } };
//
// Because the map has exactly one key, EVERY model id falls through to
// `default` — the estimator cannot distinguish a cheap model from an
// expensive one. Meanwhile ai_model_registry.cost_input_per_1k_usd /
// cost_output_per_1k_usd exist as numeric(10,6) columns and are read by
// nothing. Module 11.1 makes cost ceilings load-bearing, so an estimator that
// prices every model identically would make a per-model cost ceiling
// meaningless. This module closes that gap by preferring the registry's own
// per-model prices when an admin has entered them.
//
// HONEST ACCURACY STATEMENT — this is an ESTIMATE, and the limits are real:
//   * Input token counts come from Module 11.0's `Math.ceil(chars / 4)`
//     heuristic, not a real tokenizer. That is a rough approximation; for
//     English prose it is typically within roughly ±20%, and it can be worse
//     for code, non-Latin scripts and heavily punctuated JSON.
//   * Output tokens are, pre-flight, a CEILING (maxOutputTokens) rather than
//     a measurement — the model may emit far fewer. Pre-flight cost is
//     therefore an upper bound by construction, which is the right direction
//     for a spend ceiling to err.
//   * Registry prices are whatever an admin typed in. They are not fetched
//     from any provider price API; nothing in this codebase verifies them
//     against a real invoice.
//   * `actual_cost_usd` in ai_runs/ai_usage_ledger stays NULL until a real
//     provider reconciliation exists. Every ceiling in Module 11.1 therefore
//     operates on ESTIMATED cost.
// These limits are stated rather than hidden because inventing precision that
// does not exist would be worse than a documented approximation.

import type { AIProvider, CostEstimate } from '@/lib/ai/providers/types';
import type { ModelRegistryRow } from '@/lib/ai/modelRegistry';

export interface CostEstimateResult extends CostEstimate {
  /** 'registry' when both per-1k prices came from ai_model_registry; 'provider' when the provider adapter's own table was used. */
  source: 'registry' | 'provider';
}

function usablePrice(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Prices a call from the model registry when possible, falling back to the
 * provider adapter's estimator otherwise.
 *
 * The registry is preferred because it is per-model and admin-governed; the
 * provider fallback exists so a model with no price rows still produces a
 * number rather than a crash. Both branches are honest about which was used
 * via `source`, so a cost figure is never mistaken for a registry-backed one
 * when it is really the provider's single indicative default.
 */
export function estimateCallCost(
  provider: AIProvider,
  model: ModelRegistryRow,
  inputTokens: number,
  outputTokens: number
): CostEstimateResult {
  const safeIn = Number.isFinite(inputTokens) && inputTokens >= 0 ? inputTokens : 0;
  const safeOut = Number.isFinite(outputTokens) && outputTokens >= 0 ? outputTokens : 0;

  if (usablePrice(model.cost_input_per_1k_usd) && usablePrice(model.cost_output_per_1k_usd)) {
    return {
      inputTokens: safeIn,
      outputTokens: safeOut,
      estimatedCostUsd:
        (safeIn / 1000) * model.cost_input_per_1k_usd + (safeOut / 1000) * model.cost_output_per_1k_usd,
      source: 'registry',
    };
  }

  const fallback = provider.estimateCost(safeIn, safeOut, model.model_identifier);
  return { ...fallback, source: 'provider' };
}
