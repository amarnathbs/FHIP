// Phase 3 — Debt Reduction Forecasting (spec section 10). "Current Behaviour
// Forecast" (10.3) using the existing repayment amount is the stored monthly
// trajectory; "Additional repayment analysis" and "Interest scenarios"
// (10.5) are computed as side comparisons surfaced only in the explanation,
// not as extra stored rows — mirroring how goalCalculator.ts surfaces
// required-contribution-gap analysis without persisting a second scenario's
// full monthly history. "Liability snapshots" / "Actual-versus-plan
// tracking" / retaining the original plan (10.1-10.2) are already covered
// generically by forecast_runs never being overwritten — the earliest
// completed run for a liability IS the retained original plan, the same
// mechanism goal and net-worth forecasts already rely on.
import { buildExplanation } from './explain';
import { addMonthsToDateString, firstOfMonth, projectLoanMonth, round2 } from './monthlyPrimitives';
import type { ForecastExplanationRow, ForecastResultRow, ResolvedAssumptionSet } from './types';

export interface DebtCalculatorInputEntry {
  id: string;
  name: string;
  currentBalance: number;
  annualInterestRatePercent: number;
  monthlyRepayment: number;
  debtType: string;
  currency: string;
}

export interface DebtCalculatorInput {
  baselineDate: string;
  months: number;
  assumptions: ResolvedAssumptionSet;
  additionalMonthlyRepayment: number;
  liabilities: DebtCalculatorInputEntry[];
}

interface PayoffSummary {
  payoffMonth: number | null; // null = not paid off within the horizon
  totalInterest: number;
}

// Runs a standalone (unstored) payoff projection for comparison scenarios —
// same formula as the stored loop below, just not persisted per-period.
function projectPayoff(openingBalance: number, annualRatePercent: number, repayment: number, months: number): PayoffSummary {
  let balance = openingBalance;
  let totalInterest = 0;
  let payoffMonth: number | null = balance <= 0 ? 0 : null;
  for (let m = 1; m <= months && balance > 0; m++) {
    const month = projectLoanMonth({ openingBalance: balance, annualInterestRatePercent: annualRatePercent, repayment });
    totalInterest += month.interest;
    balance = month.closingBalance;
    if (payoffMonth === null && balance <= 0) payoffMonth = m;
  }
  return { payoffMonth, totalInterest: round2(totalInterest) };
}

export function runDebtForecast(input: DebtCalculatorInput): { results: ForecastResultRow[]; explanations: ForecastExplanationRow[] } {
  const results: ForecastResultRow[] = [];
  const explanations: ForecastExplanationRow[] = [];
  const baseline = firstOfMonth(input.baselineDate);

  for (const liability of input.liabilities) {
    let balance = liability.currentBalance;
    let totalInterest = 0;
    let payoffMonth: number | null = balance <= 0 ? 0 : null;

    for (let m = 1; m <= input.months && balance > 0; m++) {
      const periodDate = addMonthsToDateString(baseline, m);
      const month = projectLoanMonth({
        openingBalance: balance,
        annualInterestRatePercent: liability.annualInterestRatePercent,
        repayment: liability.monthlyRepayment,
      });
      totalInterest += month.interest;
      balance = month.closingBalance;
      if (payoffMonth === null && balance <= 0) payoffMonth = m;

      results.push({
        forecastType: 'debt',
        entityType: 'liability',
        entityId: liability.id,
        periodDate,
        periodNumber: m,
        openingValue: month.openingBalance,
        contributions: 0,
        withdrawals: month.principalReduction,
        income: 0,
        expenses: 0,
        interest: month.interest,
        investmentReturn: 0,
        fees: month.fees,
        fxGainLoss: 0,
        otherMovement: 0,
        closingValue: balance,
        targetValue: 0,
        varianceValue: round2(balance - 0),
        variancePercentage: null,
        currency: liability.currency,
        baseCurrencyValue: null,
        metadata: { liabilityName: liability.name, debtType: liability.debtType },
      });
    }

    const accelerated =
      input.additionalMonthlyRepayment > 0
        ? projectPayoff(liability.currentBalance, liability.annualInterestRatePercent, liability.monthlyRepayment + input.additionalMonthlyRepayment, input.months)
        : null;
    const higherRate = projectPayoff(liability.currentBalance, liability.annualInterestRatePercent + 1, liability.monthlyRepayment, input.months);
    const lowerRate = projectPayoff(liability.currentBalance, Math.max(0, liability.annualInterestRatePercent - 1), liability.monthlyRepayment, input.months);

    const payoffNarrative =
      payoffMonth === null
        ? `At the current repayment of ${liability.monthlyRepayment}/month, this debt is not projected to be paid off within the ${input.months}-month forecast horizon.`
        : payoffMonth === 0
          ? 'This debt is already paid off.'
          : `At the current repayment of ${liability.monthlyRepayment}/month, this debt is projected to be paid off in month ${payoffMonth} of the forecast, with ${round2(totalInterest)} in total interest.`;

    const acceleratedNarrative =
      accelerated && accelerated.payoffMonth !== null
        ? payoffMonth !== null
          ? ` Adding ${input.additionalMonthlyRepayment}/month would bring the payoff forward to month ${accelerated.payoffMonth} (${payoffMonth - accelerated.payoffMonth} months sooner) and save approximately ${round2(totalInterest - accelerated.totalInterest)} in interest.`
          : ` Adding ${input.additionalMonthlyRepayment}/month would bring this debt within the forecast horizon, paid off by month ${accelerated.payoffMonth} instead of remaining outstanding — saving approximately ${round2(totalInterest - accelerated.totalInterest)} in interest over the ${input.months}-month horizon.`
        : accelerated && input.additionalMonthlyRepayment > 0
          ? ` Even with an extra ${input.additionalMonthlyRepayment}/month, this debt is still not projected to be paid off within the ${input.months}-month forecast horizon.`
          : '';

    const rateNarrative = ` A 1% rate rise would add approximately ${round2(higherRate.totalInterest - totalInterest)} in total interest; a 1% rate cut would save approximately ${round2(totalInterest - lowerRate.totalInterest)}.`;

    explanations.push(
      buildExplanation({
        entityType: 'liability',
        entityId: liability.id,
        explanationType: 'debt_payoff_forecast',
        title: `${liability.name} — payoff forecast`,
        narrative: payoffNarrative + acceleratedNarrative + rateNarrative,
        inputs: {
          currentBalance: liability.currentBalance,
          annualInterestRatePercent: liability.annualInterestRatePercent,
          monthlyRepayment: liability.monthlyRepayment,
          payoffMonth,
          totalInterest: round2(totalInterest),
          additionalMonthlyRepayment: input.additionalMonthlyRepayment || null,
          acceleratedPayoffMonth: accelerated?.payoffMonth ?? null,
          acceleratedTotalInterest: accelerated?.totalInterest ?? null,
          higherRateTotalInterest: higherRate.totalInterest,
          lowerRateTotalInterest: lowerRate.totalInterest,
        },
        formula: 'Monthly Interest = Opening x Annual Rate / 12; Principal Reduction = Repayment - Interest - Fees; Closing = max(0, Opening - Principal Reduction)',
        priority: 10,
      })
    );
  }

  return { results, explanations };
}
