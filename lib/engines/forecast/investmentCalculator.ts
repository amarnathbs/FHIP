// Phase 2 — Investment Forecasting. Standalone per-investment-account
// monthly projection, independent of any goal tagging (goal-to-investment
// tagging and allocation validation already exist — goal_funding_sources /
// checkFundingAllocation in lib/services/goalFundingAllocation.ts — this
// calculator is the investment's own growth trajectory, not goal funding).
import { buildExplanation } from './explain';
import { addMonthsToDateString, firstOfMonth, projectInvestmentMonth, round2 } from './monthlyPrimitives';
import type { ForecastExplanationRow, ForecastResultRow, ResolvedAssumptionSet } from './types';
import { getAssumptionValue } from './assumptions';

export interface InvestmentCalculatorInputEntry {
  id: string;
  name: string;
  currentValue: number;
  monthlyContribution: number;
  investmentType: string;
  currency: string;
}

export interface InvestmentCalculatorInput {
  baselineDate: string;
  months: number;
  assumptions: ResolvedAssumptionSet;
  investments: InvestmentCalculatorInputEntry[];
}

const DEFAULT_INVESTMENT_RETURN = 7;

// investment_type (lib/validation/investment.ts) values don't line up
// one-to-one with the seeded assumption keys — this is a deliberate, coarse
// simplification for Phase 2; per-product return assumptions are a later
// refinement, not a Phase 2 requirement.
const TYPE_TO_ASSUMPTION_KEY: Record<string, string> = {
  shares: 'equity',
  etf: 'equity',
  managed_fund: 'equity',
  business_equity: 'equity',
  crypto: 'other_asset',
  other: 'other_asset',
};

export function runInvestmentForecast(input: InvestmentCalculatorInput): { results: ForecastResultRow[]; explanations: ForecastExplanationRow[] } {
  const results: ForecastResultRow[] = [];
  const explanations: ForecastExplanationRow[] = [];
  const baseline = firstOfMonth(input.baselineDate);

  for (const investment of input.investments) {
    const assumptionKey = TYPE_TO_ASSUMPTION_KEY[investment.investmentType] ?? 'other_asset';
    const returnRate = getAssumptionValue(input.assumptions, assumptionKey, DEFAULT_INVESTMENT_RETURN);
    let balance = investment.currentValue;

    for (let m = 1; m <= input.months; m++) {
      const periodDate = addMonthsToDateString(baseline, m);
      const month = projectInvestmentMonth({
        openingValue: balance,
        contributions: investment.monthlyContribution,
        withdrawals: 0,
        annualReturnPercent: returnRate,
      });
      balance = month.closingValue;

      results.push({
        forecastType: 'investment',
        entityType: 'investment',
        entityId: investment.id,
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
        targetValue: null,
        varianceValue: null,
        variancePercentage: null,
        currency: investment.currency,
        baseCurrencyValue: null,
        metadata: { investmentName: investment.name, investmentType: investment.investmentType },
      });
    }

    explanations.push(
      buildExplanation({
        entityType: 'investment',
        entityId: investment.id,
        explanationType: 'investment_growth_forecast',
        title: `${investment.name} — growth forecast`,
        narrative: `Projected forward from the current value of ${round2(investment.currentValue)} using an assumed ${returnRate}% annual return (${assumptionKey}), compounded monthly, plus any regular contribution.`,
        inputs: {
          currentValue: investment.currentValue,
          monthlyContribution: investment.monthlyContribution,
          investmentType: investment.investmentType,
          assumedReturnPercent: returnRate,
        },
        formula: 'Closing = (Opening + Contributions - Withdrawals) x (1 + (1+annualReturn)^(1/12) - 1) - Fees',
        priority: 10,
      })
    );
  }

  return { results, explanations };
}
