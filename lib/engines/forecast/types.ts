// Shared types for the Forecasting Engine (Module 10). Pure data shapes only —
// no Supabase/IO here, matching the engines/ vs services/ split used by every
// other module (dashboard.ts, goalMath.ts, resilience.ts, etc).

export type ForecastType =
  | 'net_worth'
  | 'retirement'
  | 'goal'
  | 'debt'
  | 'investment'
  | 'cross_border'
  | 'resilience';

export type AssumptionValueType = 'percentage' | 'currency' | 'number' | 'ratio' | 'years';

export type AssumptionSourceType = 'user_override' | 'scenario_default' | 'country_default' | 'global_default';

// One resolved assumption value plus where it came from, so every calculator
// can cite its source in the explainability output (spec 3.4: "Calculation
// methodology" must be shown, and assumptions must be user-adjustable/visible).
export interface ResolvedAssumption {
  key: string;
  category: string;
  value: number;
  valueType: AssumptionValueType;
  unit: string | null;
  sourceType: AssumptionSourceType;
  sourceReference: string | null;
}

export type ResolvedAssumptionSet = Record<string, ResolvedAssumption>;

// A single monthly period's computed movement for one forecast entity
// (matches the forecast_results table column-for-column).
export interface ForecastResultRow {
  forecastType: ForecastType;
  entityType: string;
  entityId: string | null;
  periodDate: string; // YYYY-MM-DD, first-of-month
  periodNumber: number;
  openingValue: number;
  contributions: number;
  withdrawals: number;
  income: number;
  expenses: number;
  interest: number;
  investmentReturn: number;
  fees: number;
  fxGainLoss: number;
  otherMovement: number;
  closingValue: number;
  targetValue: number | null;
  varianceValue: number | null;
  variancePercentage: number | null;
  currency: string;
  baseCurrencyValue: number | null;
  metadata: Record<string, unknown> | null;
}

// Matches the forecast_explanations table. One row typically accompanies one
// (or a small group of) ForecastResultRow so the UI can render a
// "How this was calculated" panel per spec 3.4.
export interface ForecastExplanationRow {
  entityType: string;
  entityId: string | null;
  explanationType: string;
  title: string;
  explanationText: string;
  calculationInputs: Record<string, unknown>;
  calculationFormula: string;
  priority: number;
}

export interface MonthlyForecastOutput {
  results: ForecastResultRow[];
  explanations: ForecastExplanationRow[];
}
