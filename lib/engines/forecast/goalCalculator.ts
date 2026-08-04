// Phase 2 — Goal Forecasting. Projects each active goal's balance forward
// using the same monthly-compounding primitives as every other Forecasting
// Engine calculator, and stores the result as versioned forecast_runs /
// forecast_results / forecast_explanations rows — the new capability this
// module adds over the existing on-demand Goal Planning simulator
// (goalForecast.ts / GoalWhatIfSimulator) is that these projections are
// retained so "Original forecast" vs "Current forecast" vs "Actual" can be
// compared over time (spec section 3.1), not the underlying math itself.
// requiredMonthlyContribution() is reused directly from goalMath.ts rather
// than re-derived, since it's the same annuity-shortfall formula either way.
import { requiredMonthlyContribution } from '../goalMath';
import { buildExplanation } from './explain';
import { addMonthsToDateString, firstOfMonth, monthlyCompoundRate, projectInvestmentMonth, round2 } from './monthlyPrimitives';
import type { ForecastExplanationRow, ForecastResultRow } from './types';
import { getAssumptionValue } from './assumptions';
import type { ResolvedAssumptionSet } from './types';

export interface GoalCalculatorInputEntry {
  id: string;
  name: string;
  currentAmount: number;
  targetAmount: number;
  targetDate: string | null; // ISO date, may be in the past/unset
  monthlyContribution: number;
  currency: string;
}

export interface GoalCalculatorInput {
  baselineDate: string;
  months: number;
  assumptions: ResolvedAssumptionSet;
  goals: GoalCalculatorInputEntry[];
}

const DEFAULT_GOAL_GROWTH = 3.5; // matches the 'cash' assumption default — most goal savings sit in cash/high-interest accounts, not growth assets

function monthsBetweenDates(fromIso: string, toIso: string): number {
  const from = new Date(fromIso + 'T00:00:00Z');
  const to = new Date(toIso + 'T00:00:00Z');
  return (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
}

export function runGoalForecast(input: GoalCalculatorInput): { results: ForecastResultRow[]; explanations: ForecastExplanationRow[] } {
  const results: ForecastResultRow[] = [];
  const explanations: ForecastExplanationRow[] = [];
  const baseline = firstOfMonth(input.baselineDate);
  const growthRate = getAssumptionValue(input.assumptions, 'cash', DEFAULT_GOAL_GROWTH);
  const monthlyRate = monthlyCompoundRate(growthRate);

  for (const goal of input.goals) {
    let balance = goal.currentAmount;
    let completionMonth: number | null = balance >= goal.targetAmount ? 0 : null;
    const monthsToTargetDate = goal.targetDate ? monthsBetweenDates(baseline, goal.targetDate) : null;

    for (let m = 1; m <= input.months; m++) {
      const periodDate = addMonthsToDateString(baseline, m);
      const month = projectInvestmentMonth({
        openingValue: balance,
        contributions: goal.monthlyContribution,
        withdrawals: 0,
        annualReturnPercent: growthRate,
      });
      balance = month.closingValue;
      if (completionMonth === null && balance >= goal.targetAmount) completionMonth = m;

      const varianceValue = round2(balance - goal.targetAmount);

      results.push({
        forecastType: 'goal',
        entityType: 'goal',
        entityId: goal.id,
        periodDate,
        periodNumber: m,
        openingValue: month.openingValue,
        contributions: month.contributions,
        withdrawals: 0,
        income: 0,
        expenses: 0,
        interest: 0,
        investmentReturn: month.investmentReturn,
        fees: 0,
        fxGainLoss: 0,
        otherMovement: 0,
        closingValue: balance,
        targetValue: goal.targetAmount,
        varianceValue,
        variancePercentage: goal.targetAmount > 0 ? round2((varianceValue / goal.targetAmount) * 100) : null,
        currency: goal.currency,
        baseCurrencyValue: null,
        metadata: { goalName: goal.name },
      });
    }

    const requiredContribution = monthsToTargetDate && monthsToTargetDate > 0
      ? requiredMonthlyContribution(goal.targetAmount, goal.currentAmount, monthlyRate, monthsToTargetDate)
      : null;
    const contributionGap = requiredContribution !== null ? round2(Math.max(0, requiredContribution - goal.monthlyContribution)) : null;

    const completionNarrative =
      completionMonth === null
        ? `At the current contribution of ${goal.monthlyContribution}/month, this goal is not projected to reach its target within the ${input.months}-month forecast horizon.`
        : completionMonth === 0
          ? 'This goal has already reached its target amount.'
          : `At the current contribution of ${goal.monthlyContribution}/month plus assumed growth, this goal is projected to reach its target in month ${completionMonth} of the forecast.`;

    explanations.push(
      buildExplanation({
        entityType: 'goal',
        entityId: goal.id,
        explanationType: 'goal_completion_forecast',
        title: `${goal.name} — completion forecast`,
        narrative:
          completionNarrative +
          (contributionGap && contributionGap > 0
            ? ` To reach the target by ${goal.targetDate ?? 'the planned date'}, the required monthly contribution is ${requiredContribution?.toFixed(2)} — a gap of ${contributionGap.toFixed(2)} above the current plan.`
            : ''),
        inputs: {
          currentAmount: goal.currentAmount,
          targetAmount: goal.targetAmount,
          targetDate: goal.targetDate,
          monthlyContribution: goal.monthlyContribution,
          assumedGrowthPercent: growthRate,
          requiredMonthlyContribution: requiredContribution,
          contributionGap,
        },
        formula: 'Closing = (Opening + Contributions) x (1 + (1+annualReturn)^(1/12) - 1); Required contribution solves the same annuity for the target/date gap',
        priority: 10,
      })
    );
  }

  return { results, explanations };
}
