// Builds forecast_explanations rows. Spec 3.4 requires every forecast to show
// a "How this was calculated" panel with: opening value, forecast period,
// contributions, withdrawals, growth rate, inflation rate, debt interest
// rate, repayment amount, FX assumption, goal target, exclusions, and the
// calculation methodology in plain language.
import type { ForecastExplanationRow } from './types';

export function buildExplanation(params: {
  entityType: string;
  entityId: string | null;
  explanationType: string;
  title: string;
  narrative: string;
  inputs: Record<string, unknown>;
  formula: string;
  priority?: number;
}): ForecastExplanationRow {
  return {
    entityType: params.entityType,
    entityId: params.entityId,
    explanationType: params.explanationType,
    title: params.title,
    explanationText: params.narrative,
    calculationInputs: params.inputs,
    calculationFormula: params.formula,
    priority: params.priority ?? 0,
  };
}
