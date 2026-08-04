import { z } from 'zod';

export const forecastScenarioSchema = z.object({
  scenario_name: z.string().min(1),
  scenario_type: z.enum(['base', 'conservative', 'optimistic', 'custom', 'stress']),
  description: z.string().optional(),
  is_default: z.boolean().optional(),
});

export type ForecastScenarioInput = z.infer<typeof forecastScenarioSchema>;

export const forecastAssumptionUpsertSchema = z.object({
  scenario_id: z.string().uuid().nullable().optional(),
  assumption_category: z.string().min(1),
  assumption_key: z.string().min(1),
  assumption_value: z.number(),
  value_type: z.enum(['percentage', 'currency', 'number', 'ratio', 'years']).optional(),
  unit: z.string().optional(),
  notes: z.string().optional(),
});

export type ForecastAssumptionUpsertInput = z.infer<typeof forecastAssumptionUpsertSchema>;

export const plannedFinancialEventSchema = z.object({
  month_index: z.number().int().min(1).max(600),
  amount: z.number(),
  description: z.string().min(1),
});

export const resilienceStressScenarioSchema = z.enum([
  'none',
  'income_stops',
  'income_falls_pct',
  'unexpected_expense',
  'interest_rate_rise',
  'rental_vacancy',
  'investment_market_decline',
  'currency_shock',
  'combined_severe',
]);

export const forecastRunRequestSchema = z.object({
  scenario_id: z.string().uuid().optional(),
  forecast_type: z.enum(['net_worth', 'retirement', 'goal', 'debt', 'investment', 'cross_border', 'resilience']),
  months: z.number().int().min(1).max(600).optional(),
  additional_monthly_repayment: z.number().min(0).optional(),
  retirement_target_method: z.enum(['target_corpus', 'desired_income', 'expense_replacement']).optional(),
  retirement_target_corpus: z.number().min(0).optional(),
  retirement_desired_annual_income: z.number().min(0).optional(),
  retirement_replacement_percentage: z.number().min(0).max(100).optional(),
  planned_events: z.array(plannedFinancialEventSchema).max(50).optional(),
  resilience_stress_scenario: resilienceStressScenarioSchema.optional(),
  resilience_duration_months: z.number().int().min(1).max(60).optional(),
  resilience_income_fall_pct: z.number().min(0).max(100).optional(),
  resilience_expense_amount: z.number().min(0).optional(),
  resilience_rate_rise_pct: z.number().min(0).max(20).optional(),
  resilience_market_decline_pct: z.number().min(0).max(100).optional(),
  resilience_currency_shock_pct: z.number().min(0).max(100).optional(),
});

export type ForecastRunRequestInput = z.infer<typeof forecastRunRequestSchema>;
