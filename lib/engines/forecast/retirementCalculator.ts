// Phase 4 — Retirement Forecasting (spec section 9). A single consolidated
// retirement position (entity_type='retirement', no entity_id — mirrors how
// netWorthCalculator.ts treats the whole portfolio as one entity), covering
// both the accumulation phase (9.5: "Closing = Opening + Contributions +
// Return - Fees - Withdrawals") and the decumulation phase after retirement
// age ("Closing = Opening + Return - Withdrawals - Fees"). Retirement assets
// are tracked separately from general investments per 9.1 to avoid double
// counting — this calculator only ever reads retirement_accounts, never
// investments.
import { requiredMonthlyContribution } from '../goalMath';
import { buildExplanation } from './explain';
import { addMonthsToDateString, firstOfMonth, monthlyCompoundRate, projectInvestmentMonth, round2 } from './monthlyPrimitives';
import { getAssumptionValue } from './assumptions';
import { formatMoneyWhole } from '../money';
import type { ForecastExplanationRow, ForecastResultRow, ResolvedAssumptionSet } from './types';

export type RetirementTargetMethod = 'target_corpus' | 'desired_income' | 'expense_replacement';

export interface RetirementCalculatorInput {
  baselineDate: string;
  months: number;
  assumptions: ResolvedAssumptionSet;
  currency: string;
  currentBalance: number;
  monthlyContribution: number;
  currentAge: number | null; // null when date_of_birth isn't recorded or isn't plausible
  retirementAge: number;
  // Forecasting P1 fix FHIP-FC-RET-001 — set by the caller when a higher- or
  // equal-priority timing signal is available: an explicit retirement_date
  // (tier 1, takes priority over the age-based calculation below) or a
  // manual "months until retirement" fallback for when no DOB is on file at
  // all (tier 3/4 collapsed into one field — see migration 0028). Left
  // undefined/null to fall back to the existing currentAge/retirementAge
  // calculation (tier 2).
  monthsUntilRetirementOverride?: number | null;
  targetMethod: RetirementTargetMethod;
  targetCorpus?: number; // target_corpus method
  desiredAnnualIncome?: number; // desired_income method
  currentAnnualEssentialExpenses?: number; // expense_replacement method
  replacementPercentage?: number; // expense_replacement method, e.g. 70 for 70%
}

export type RetirementStatus = 'fully_funded' | 'on_track' | 'minor_gap' | 'material_gap' | 'high_risk' | 'insufficient_information';

const DEFAULT_RETIREMENT_RETURN = 6.5;

function statusFromReadiness(readinessPct: number | null): RetirementStatus {
  if (readinessPct === null) return 'insufficient_information';
  if (readinessPct >= 100) return 'fully_funded';
  if (readinessPct >= 90) return 'on_track';
  if (readinessPct >= 75) return 'minor_gap';
  if (readinessPct >= 50) return 'material_gap';
  return 'high_risk';
}

// Required Retirement Corpus, per method (spec 9.4). Returns null when the
// method's required inputs weren't supplied — callers must treat that as
// "Insufficient Information", not as a zero target.
function resolveRequiredCorpus(input: RetirementCalculatorInput, withdrawalRatePercent: number, yearsToRetirement: number | null): number | null {
  if (input.targetMethod === 'target_corpus') {
    return input.targetCorpus ?? null;
  }
  if (input.targetMethod === 'desired_income') {
    if (input.desiredAnnualIncome === undefined || withdrawalRatePercent <= 0) return null;
    return round2(input.desiredAnnualIncome / (withdrawalRatePercent / 100));
  }
  // expense_replacement
  if (input.currentAnnualEssentialExpenses === undefined || input.replacementPercentage === undefined || withdrawalRatePercent <= 0) return null;
  const requiredIncomeToday = input.currentAnnualEssentialExpenses * (input.replacementPercentage / 100);
  const inflationPercent = getAssumptionValue(input.assumptions, 'general_inflation', 3);
  const years = yearsToRetirement ?? 0;
  const inflatedIncome = requiredIncomeToday * Math.pow(1 + inflationPercent / 100, years);
  return round2(inflatedIncome / (withdrawalRatePercent / 100));
}

export function runRetirementForecast(input: RetirementCalculatorInput): { results: ForecastResultRow[]; explanations: ForecastExplanationRow[] } {
  const results: ForecastResultRow[] = [];
  const explanations: ForecastExplanationRow[] = [];
  const baseline = firstOfMonth(input.baselineDate);
  const returnRate = getAssumptionValue(input.assumptions, 'retirement', DEFAULT_RETIREMENT_RETURN);
  const withdrawalRate = getAssumptionValue(input.assumptions, 'withdrawal_rate', 4);

  const monthsUntilRetirement =
    input.monthsUntilRetirementOverride ?? (input.currentAge !== null ? Math.max(0, Math.round((input.retirementAge - input.currentAge) * 12)) : null);
  const yearsToRetirement = monthsUntilRetirement !== null ? monthsUntilRetirement / 12 : null;
  const requiredCorpus = resolveRequiredCorpus(input, withdrawalRate, yearsToRetirement);
  const desiredAnnualIncomeAtRetirement =
    input.targetMethod === 'desired_income'
      ? input.desiredAnnualIncome ?? null
      : requiredCorpus !== null
        ? round2(requiredCorpus * (withdrawalRate / 100))
        : null;
  const monthlyWithdrawalPostRetirement = desiredAnnualIncomeAtRetirement !== null ? desiredAnnualIncomeAtRetirement / 12 : 0;

  let balance = input.currentBalance;
  let balanceAtRetirement: number | null = monthsUntilRetirement === 0 ? balance : null;
  let depletionMonth: number | null = null;

  for (let m = 1; m <= input.months; m++) {
    const periodDate = addMonthsToDateString(baseline, m);
    const isPreRetirement = monthsUntilRetirement === null || m <= monthsUntilRetirement;
    const month = projectInvestmentMonth({
      openingValue: balance,
      contributions: isPreRetirement ? input.monthlyContribution : 0,
      withdrawals: isPreRetirement ? 0 : monthlyWithdrawalPostRetirement,
      annualReturnPercent: returnRate,
    });
    balance = month.closingValue;

    if (monthsUntilRetirement !== null && m === monthsUntilRetirement) balanceAtRetirement = balance;
    if (!isPreRetirement && depletionMonth === null && balance <= 0) depletionMonth = m;

    results.push({
      forecastType: 'retirement',
      entityType: 'retirement',
      entityId: null,
      periodDate,
      periodNumber: m,
      openingValue: month.openingValue,
      contributions: month.contributions,
      withdrawals: month.withdrawals,
      income: 0,
      expenses: 0,
      interest: 0,
      investmentReturn: month.investmentReturn,
      fees: month.fees,
      fxGainLoss: 0,
      otherMovement: 0,
      closingValue: balance,
      targetValue: requiredCorpus,
      varianceValue: requiredCorpus !== null ? round2(balance - requiredCorpus) : null,
      variancePercentage: requiredCorpus !== null && requiredCorpus > 0 ? round2(((balance - requiredCorpus) / requiredCorpus) * 100) : null,
      currency: input.currency,
      baseCurrencyValue: null,
      metadata: { phase: isPreRetirement ? 'accumulation' : 'decumulation' },
    });
  }

  if (balanceAtRetirement === null) balanceAtRetirement = balance; // retirement falls beyond the forecast horizon — use the final projected balance as the best available estimate

  const readinessPct = requiredCorpus !== null && requiredCorpus > 0 ? round2((balanceAtRetirement / requiredCorpus) * 100) : null;
  const status = statusFromReadiness(readinessPct);
  const fundingGap = requiredCorpus !== null ? round2(requiredCorpus - balanceAtRetirement) : null;

  const monthlyRate = monthlyCompoundRate(returnRate);
  const requiredContribution =
    requiredCorpus !== null && monthsUntilRetirement !== null && monthsUntilRetirement > 0
      ? requiredMonthlyContribution(requiredCorpus, input.currentBalance, monthlyRate, monthsUntilRetirement)
      : null;
  const contributionGap = requiredContribution !== null ? round2(Math.max(0, requiredContribution - input.monthlyContribution)) : null;

  const currency = input.currency as 'AUD' | 'INR';
  const narrativeParts: string[] = [];
  if (monthsUntilRetirement === null) {
    narrativeParts.push('Retirement age could not be projected because no date of birth is on file — this forecast shows the accumulation trajectory only.');
  } else {
    narrativeParts.push(
      `Projected retirement balance at age ${input.retirementAge} (in ${Math.round(monthsUntilRetirement / 12)} years) is ${formatMoneyWhole(balanceAtRetirement, currency)}.`
    );
  }
  if (requiredCorpus !== null) {
    narrativeParts.push(`Required retirement corpus under the ${input.targetMethod.replace('_', ' ')} method is ${formatMoneyWhole(requiredCorpus, currency)}.`);
    narrativeParts.push(
      fundingGap !== null && fundingGap > 0
        ? `This leaves a funding gap of approximately ${formatMoneyWhole(fundingGap, currency)}.`
        : 'The current trajectory is projected to fully fund this target.'
    );
    if (contributionGap && contributionGap > 0) {
      narrativeParts.push(
        `Closing the gap would require an additional ${formatMoneyWhole(contributionGap, currency)}/month, on top of the current ${formatMoneyWhole(input.monthlyContribution, currency)}/month.`
      );
    }
  } else {
    narrativeParts.push('A funding gap could not be calculated — the selected target method is missing a required input.');
  }
  if (depletionMonth !== null) {
    narrativeParts.push(`At the assumed withdrawal rate, the portfolio is projected to be depleted ${Math.round((depletionMonth - (monthsUntilRetirement ?? 0)) / 12)} years into retirement.`);
  }

  explanations.push(
    buildExplanation({
      entityType: 'retirement',
      entityId: null,
      explanationType: 'retirement_readiness_forecast',
      title: 'Retirement readiness forecast',
      narrative: narrativeParts.join(' '),
      inputs: {
        currentBalance: input.currentBalance,
        monthlyContribution: input.monthlyContribution,
        assumedReturnPercent: returnRate,
        withdrawalRatePercent: withdrawalRate,
        monthsUntilRetirement,
        balanceAtRetirement,
        requiredCorpus,
        fundingGap,
        readinessPct,
        status,
        requiredMonthlyContribution: requiredContribution,
        contributionGap,
        depletionMonth,
      },
      formula:
        'Pre-retirement: Closing = (Opening + Contributions) x (1 + (1+annualReturn)^(1/12) - 1); Post-retirement: Closing = (Opening - Withdrawals) x (1 + (1+annualReturn)^(1/12) - 1); Required Corpus = Annual Income / Withdrawal Rate',
      priority: 10,
    })
  );

  return { results, explanations };
}
