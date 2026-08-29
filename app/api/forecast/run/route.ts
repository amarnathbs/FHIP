import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { runForecast } from '@/lib/services/forecastData';
import { forecastRunRequestSchema } from '@/lib/validation/forecast';
import type { StressScenarioParams } from '@/lib/engines/resilienceStress';

// Object spread with explicit `undefined` values overrides a merged
// default's real value (e.g. {...DEFAULTS, ...{durationMonths: undefined}}
// yields durationMonths: undefined, not the default) — applyStressScenario
// relies on {...DEFAULTS, ...params} to fill in unset fields, so only keys
// the caller actually provided must be forwarded.
function omitUndefined<T extends object>(obj: T): Partial<T> {
  const result: Partial<T> = {};
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (obj[key] !== undefined) result[key] = obj[key];
  }
  return result;
}

export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = forecastRunRequestSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return bad(parsed.error.message, 422);
  try {
    const stressParams: StressScenarioParams = omitUndefined({
      durationMonths: parsed.data.resilience_duration_months,
      incomeFallPct: parsed.data.resilience_income_fall_pct,
      expenseAmount: parsed.data.resilience_expense_amount,
      rateRisePct: parsed.data.resilience_rate_rise_pct,
      marketDeclinePct: parsed.data.resilience_market_decline_pct,
      currencyShockPct: parsed.data.resilience_currency_shock_pct,
    });
    const result = await runForecast(user.id, {
      scenarioId: parsed.data.scenario_id,
      forecastType: parsed.data.forecast_type,
      months: parsed.data.months,
      additionalMonthlyRepayment: parsed.data.additional_monthly_repayment,
      retirementTargetMethod: parsed.data.retirement_target_method,
      retirementTargetCorpus: parsed.data.retirement_target_corpus,
      retirementDesiredAnnualIncome: parsed.data.retirement_desired_annual_income,
      retirementReplacementPercentage: parsed.data.retirement_replacement_percentage,
      plannedEvents: parsed.data.planned_events?.map((e) => ({ monthIndex: e.month_index, amount: e.amount, description: e.description })),
      resilienceStressScenario:
        parsed.data.resilience_stress_scenario && parsed.data.resilience_stress_scenario !== 'none'
          ? parsed.data.resilience_stress_scenario
          : undefined,
      resilienceStressParams: stressParams,
    });
    return ok(result);
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Could not run forecast');
  }
}
