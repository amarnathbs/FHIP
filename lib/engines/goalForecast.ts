import { estimateMonthsToPayoff } from './dashboard';
import {
  annualToMonthlyRate,
  requiredMonthlyContribution,
  inflationAdjustedTarget,
  projectGoalBalance,
  monthsToTarget,
  addMonths,
  monthsBetween,
} from './goalMath';
import { formatMoneyWhole } from './money';

export const MODEL_VERSION = 'goals-1.0.0';

export type ForecastLogicKey =
  | 'emergency_fund'
  | 'home_deposit'
  | 'debt_payoff'
  | 'retirement'
  | 'education'
  | 'cross_border'
  | 'major_purchase'
  | 'business'
  | 'generic';

export type ScenarioCode = 'conservative' | 'base' | 'optimistic';

export type TrackStatus =
  | 'ahead_of_track'
  | 'on_track'
  | 'at_risk'
  | 'off_track'
  | 'fully_funded'
  | 'unable_to_assess';

export interface ScenarioAssumption {
  returnRate: number;
  costInflation: number;
  contributionGrowth: number;
}

export interface GoalPlanningConfig {
  trackStatusThresholds: { aheadMin: number; onTrackMin: number; atRiskMin: number };
  confidenceWeights: Record<string, number>;
  confidenceBands: { min: number; band: string; label: string }[];
  affordabilityThresholds: { comfortableMax: number; manageableMax: number; tightMax: number };
  priorityWeights: Record<string, number>;
  scenarioAssumptions: Record<string, Record<ScenarioCode, ScenarioAssumption>>;
  fxAssumptions: Record<string, Record<ScenarioCode, number>>;
}

export interface GoalRecord {
  targetAmount: number;
  targetAmountBasis: 'today_value' | 'future_value';
  currentAmount: number;
  targetDate: string | null;
  plannedContributionAmount: number; // monthly equivalent
  annualContributionGrowthPct: number;
  inflationAdjusted: boolean;
  inflationCategory: string;
  currencyCode: 'AUD' | 'INR';
  countryCode: string | null;
  forecastLogicKey: string;
}

export interface GoalExtras {
  linkedLiability?: { balance: number; interestRate: number | null; monthlyRepayment: number } | null;
  essentialMonthlyExpenses?: number | null;
  targetCoverageMonths?: number | null;
  additionalPurchaseCosts?: number | null;
  expectedExternalFunding?: number | null;
  reportingCurrencyCode?: 'AUD' | 'INR' | null;
}

export interface CategoryForecastResult {
  targetAmountOriginal: number;
  targetAmountFuture: number;
  currentAmount: number;
  projectedTargetDateValue: number | null;
  projectedCompletionDate: string | null;
  requiredMonthlyContribution: number | null;
  currentMonthlyContribution: number;
  fundingGapAtTargetDate: number | null;
  progressPct: number;
  forecastFundingPct: number | null;
  trackStatus: TrackStatus;
  explanation: string;
  currentValue: Record<string, unknown>;
}

function monthsRemaining(targetDate: string | null, today: Date): number | null {
  if (!targetDate) return null;
  const months = monthsBetween(today, new Date(targetDate));
  return months > 0 ? months : 0;
}

function yearsRemaining(targetDate: string | null, today: Date): number {
  const months = monthsRemaining(targetDate, today);
  return months !== null ? months / 12 : 0;
}

function classifyTrack(
  forecastFundingPct: number | null,
  currentAmount: number,
  targetAmountFuture: number,
  thresholds: GoalPlanningConfig['trackStatusThresholds']
): TrackStatus {
  if (targetAmountFuture > 0 && currentAmount >= targetAmountFuture) return 'fully_funded';
  if (forecastFundingPct === null) return 'unable_to_assess';
  if (forecastFundingPct >= thresholds.aheadMin) return 'ahead_of_track';
  if (forecastFundingPct >= thresholds.onTrackMin) return 'on_track';
  if (forecastFundingPct >= thresholds.atRiskMin) return 'at_risk';
  return 'off_track';
}

export function resolveAssumptions(config: GoalPlanningConfig, logicKey: string, scenario: ScenarioCode): ScenarioAssumption {
  const forLogic = config.scenarioAssumptions[logicKey] ?? config.scenarioAssumptions.generic;
  return forLogic[scenario];
}

// Standard "accumulate toward a lump sum" projection shared by every category
// that isn't debt-payoff (amortisation) or cross-border (FX-converted
// recurring commitment): project the balance to a fixed target date, or —
// if there's no target date — solve for the completion date given the fixed
// contribution.
function standardForecast(params: {
  currentAmount: number;
  targetAmountFuture: number;
  plannedMonthlyContribution: number;
  annualContributionGrowthPct: number;
  monthlyRate: number;
  targetDate: string | null;
  today: Date;
}): {
  projectedTargetDateValue: number | null;
  projectedCompletionDate: string | null;
  requiredMonthlyContribution: number | null;
  forecastFundingPct: number | null;
} {
  const months = monthsRemaining(params.targetDate, params.today);
  if (months !== null && months > 0) {
    const points = projectGoalBalance({
      currentAmount: params.currentAmount,
      monthlyContribution: params.plannedMonthlyContribution,
      monthlyRate: params.monthlyRate,
      months,
      annualContributionGrowthPct: params.annualContributionGrowthPct,
    });
    const projectedTargetDateValue = points[points.length - 1]?.closingBalance ?? params.currentAmount;
    const req = requiredMonthlyContribution(params.targetAmountFuture, params.currentAmount, params.monthlyRate, months);
    const forecastFundingPct = params.targetAmountFuture > 0 ? (projectedTargetDateValue / params.targetAmountFuture) * 100 : null;
    return { projectedTargetDateValue, projectedCompletionDate: null, requiredMonthlyContribution: req, forecastFundingPct };
  }
  if (params.plannedMonthlyContribution <= 0 && params.currentAmount < params.targetAmountFuture) {
    return { projectedTargetDateValue: null, projectedCompletionDate: null, requiredMonthlyContribution: null, forecastFundingPct: null };
  }
  const monthsToGo = monthsToTarget(params.currentAmount, params.plannedMonthlyContribution, params.monthlyRate, params.targetAmountFuture);
  const projectedCompletionDate = monthsToGo !== null ? addMonths(params.today, monthsToGo).toISOString().slice(0, 10) : null;
  return { projectedTargetDateValue: null, projectedCompletionDate, requiredMonthlyContribution: null, forecastFundingPct: null };
}

// ---------------------------------------------------------------------------
// 1. Emergency Fund — target derives from essential monthly expenses (Module
// 3/6 linkage) when available, falling back to the manually entered target.
// ---------------------------------------------------------------------------
function emergencyFundForecast(goal: GoalRecord, extras: GoalExtras, assumption: ScenarioAssumption, today: Date): CategoryForecastResult {
  const coverageMonths = extras.targetCoverageMonths ?? 6;
  const essentialExpenses = extras.essentialMonthlyExpenses ?? null;
  const targetAmountOriginal = essentialExpenses !== null && essentialExpenses > 0 ? essentialExpenses * coverageMonths : goal.targetAmount;
  const targetAmountFuture = targetAmountOriginal; // short horizon: inflation drift is immaterial, kept equal to today's value
  const monthlyRate = annualToMonthlyRate(assumption.returnRate);
  const std = standardForecast({
    currentAmount: goal.currentAmount,
    targetAmountFuture,
    plannedMonthlyContribution: goal.plannedContributionAmount,
    annualContributionGrowthPct: goal.annualContributionGrowthPct,
    monthlyRate,
    targetDate: goal.targetDate,
    today,
  });
  const currentCoverageMonths = essentialExpenses && essentialExpenses > 0 ? goal.currentAmount / essentialExpenses : null;
  return {
    targetAmountOriginal,
    targetAmountFuture,
    currentAmount: goal.currentAmount,
    ...std,
    currentMonthlyContribution: goal.plannedContributionAmount,
    fundingGapAtTargetDate: Math.max(0, targetAmountFuture - goal.currentAmount),
    progressPct: targetAmountFuture > 0 ? (goal.currentAmount / targetAmountFuture) * 100 : 0,
    trackStatus: 'unable_to_assess',
    explanation: `Target reserve is ${coverageMonths} months of essential expenses${essentialExpenses !== null ? ` ($${essentialExpenses.toFixed(0)}/mo)` : ''}.`,
    currentValue: { coverageMonths, currentCoverageMonths, essentialMonthlyExpenses: essentialExpenses },
  };
}

// ---------------------------------------------------------------------------
// 2. Home Deposit
// ---------------------------------------------------------------------------
function homeDepositForecast(goal: GoalRecord, extras: GoalExtras, assumption: ScenarioAssumption, today: Date): CategoryForecastResult {
  const additionalCosts = extras.additionalPurchaseCosts ?? 0;
  const targetAmountOriginal = goal.targetAmount + additionalCosts;
  const targetAmountFuture =
    goal.inflationAdjusted && goal.targetAmountBasis === 'today_value'
      ? inflationAdjustedTarget(targetAmountOriginal, assumption.costInflation, yearsRemaining(goal.targetDate, today))
      : targetAmountOriginal;
  const monthlyRate = annualToMonthlyRate(assumption.returnRate);
  const std = standardForecast({
    currentAmount: goal.currentAmount,
    targetAmountFuture,
    plannedMonthlyContribution: goal.plannedContributionAmount,
    annualContributionGrowthPct: goal.annualContributionGrowthPct,
    monthlyRate,
    targetDate: goal.targetDate,
    today,
  });
  return {
    targetAmountOriginal,
    targetAmountFuture,
    currentAmount: goal.currentAmount,
    ...std,
    currentMonthlyContribution: goal.plannedContributionAmount,
    fundingGapAtTargetDate: Math.max(0, targetAmountFuture - goal.currentAmount),
    progressPct: targetAmountFuture > 0 ? (goal.currentAmount / targetAmountFuture) * 100 : 0,
    trackStatus: 'unable_to_assess',
    explanation: `Estimated deposit + purchase costs at completion: $${targetAmountFuture.toFixed(0)}.`,
    currentValue: { additionalPurchaseCosts: additionalCosts, propertyCostGrowth: assumption.costInflation },
  };
}

// ---------------------------------------------------------------------------
// 3. Debt Payoff — links to the actual liability record (amortisation), not
// a savings-accumulation target. Reuses estimateMonthsToPayoff from
// dashboard.ts rather than re-deriving loan amortisation math.
// ---------------------------------------------------------------------------
function debtPayoffForecast(goal: GoalRecord, extras: GoalExtras, today: Date): CategoryForecastResult {
  const liability = extras.linkedLiability ?? null;
  const currentBalance = liability?.balance ?? Math.max(0, goal.targetAmount - goal.currentAmount);
  const rate = liability?.interestRate ?? null;
  const minimumRepayment = liability?.monthlyRepayment ?? 0;
  const additionalRepayment = goal.plannedContributionAmount;
  const totalRepayment = minimumRepayment + additionalRepayment;
  const originalBalance = goal.targetAmount > 0 ? goal.targetAmount : currentBalance;
  const amountPaidOff = Math.max(0, originalBalance - currentBalance);

  const monthsToPayoff = totalRepayment > 0 ? estimateMonthsToPayoff(currentBalance, rate, totalRepayment) : null;
  const projectedCompletionDate = monthsToPayoff !== null ? addMonths(today, monthsToPayoff).toISOString().slice(0, 10) : null;

  const months = monthsRemaining(goal.targetDate, today);
  let forecastFundingPct: number | null = null;
  if (months !== null && months > 0 && totalRepayment > 0) {
    const monthlyRate = (rate ?? 0) / 100 / 12;
    let bal = currentBalance;
    for (let m = 0; m < months; m++) {
      bal = Math.max(0, bal * (1 + monthlyRate) - totalRepayment);
      if (bal <= 0) break;
    }
    forecastFundingPct = originalBalance > 0 ? ((originalBalance - bal) / originalBalance) * 100 : null;
  }
  const progressPct = originalBalance > 0 ? (amountPaidOff / originalBalance) * 100 : 0;
  return {
    targetAmountOriginal: originalBalance,
    targetAmountFuture: originalBalance,
    currentAmount: amountPaidOff,
    projectedTargetDateValue: null,
    projectedCompletionDate,
    requiredMonthlyContribution: null,
    currentMonthlyContribution: totalRepayment,
    fundingGapAtTargetDate: Math.max(0, currentBalance),
    progressPct,
    forecastFundingPct,
    trackStatus: 'unable_to_assess',
    explanation: `Debt-free date estimated from a $${totalRepayment.toFixed(0)}/mo total repayment (minimum + additional).`,
    currentValue: { currentBalance, minimumRepayment, additionalRepayment, interestRate: rate },
  };
}

// ---------------------------------------------------------------------------
// 4. Retirement
// ---------------------------------------------------------------------------
function retirementForecast(goal: GoalRecord, assumption: ScenarioAssumption, today: Date): CategoryForecastResult {
  const targetAmountFuture = goal.targetAmount;
  const monthlyRate = annualToMonthlyRate(assumption.returnRate);
  const std = standardForecast({
    currentAmount: goal.currentAmount,
    targetAmountFuture,
    plannedMonthlyContribution: goal.plannedContributionAmount,
    annualContributionGrowthPct: goal.annualContributionGrowthPct,
    monthlyRate,
    targetDate: goal.targetDate,
    today,
  });
  return {
    targetAmountOriginal: goal.targetAmount,
    targetAmountFuture,
    currentAmount: goal.currentAmount,
    ...std,
    currentMonthlyContribution: goal.plannedContributionAmount,
    fundingGapAtTargetDate: Math.max(0, targetAmountFuture - goal.currentAmount),
    progressPct: targetAmountFuture > 0 ? (goal.currentAmount / targetAmountFuture) * 100 : 0,
    trackStatus: 'unable_to_assess',
    explanation: `Projected using a ${(assumption.returnRate * 100).toFixed(1)}% annual return assumption.`,
    currentValue: { returnAssumption: assumption.returnRate },
  };
}

// ---------------------------------------------------------------------------
// 5. Education — inflation-adjusted future cost is the primary driver.
// ---------------------------------------------------------------------------
function educationForecast(goal: GoalRecord, assumption: ScenarioAssumption, today: Date): CategoryForecastResult {
  const targetAmountFuture =
    goal.inflationAdjusted && goal.targetAmountBasis === 'today_value'
      ? inflationAdjustedTarget(goal.targetAmount, assumption.costInflation, yearsRemaining(goal.targetDate, today))
      : goal.targetAmount;
  const monthlyRate = annualToMonthlyRate(assumption.returnRate);
  const std = standardForecast({
    currentAmount: goal.currentAmount,
    targetAmountFuture,
    plannedMonthlyContribution: goal.plannedContributionAmount,
    annualContributionGrowthPct: goal.annualContributionGrowthPct,
    monthlyRate,
    targetDate: goal.targetDate,
    today,
  });
  return {
    targetAmountOriginal: goal.targetAmount,
    targetAmountFuture,
    currentAmount: goal.currentAmount,
    ...std,
    currentMonthlyContribution: goal.plannedContributionAmount,
    fundingGapAtTargetDate: Math.max(0, targetAmountFuture - goal.currentAmount),
    progressPct: targetAmountFuture > 0 ? (goal.currentAmount / targetAmountFuture) * 100 : 0,
    trackStatus: 'unable_to_assess',
    explanation: `Cost in today's money is ${formatMoneyWhole(goal.targetAmount, goal.currencyCode)}; estimated cost at completion is ${formatMoneyWhole(targetAmountFuture, goal.currencyCode)} using a ${(assumption.costInflation * 100).toFixed(1)}% education-cost inflation assumption.`,
    currentValue: { costInToday: goal.targetAmount, educationInflation: assumption.costInflation },
  };
}

// ---------------------------------------------------------------------------
// 6. Cross-Border Family Support — recurring commitment converted through an
// explicit FX assumption; original and reporting currency are kept separate.
// ---------------------------------------------------------------------------
function crossBorderForecast(
  goal: GoalRecord,
  assumption: ScenarioAssumption,
  fxRate: number,
  today: Date
): CategoryForecastResult {
  const months = monthsRemaining(goal.targetDate, today) ?? 12;
  const annualSupportCommitmentOriginal = goal.plannedContributionAmount * 12;
  const totalProjectedSupportOriginal = goal.plannedContributionAmount * Math.max(months, 12);
  const targetAmountOriginal = goal.targetAmount > 0 ? goal.targetAmount : totalProjectedSupportOriginal;
  const targetAmountFuture = targetAmountOriginal * fxRate;
  const monthlyRate = annualToMonthlyRate(assumption.returnRate);
  const std = standardForecast({
    currentAmount: goal.currentAmount,
    targetAmountFuture,
    plannedMonthlyContribution: goal.plannedContributionAmount * fxRate,
    annualContributionGrowthPct: goal.annualContributionGrowthPct,
    monthlyRate,
    targetDate: goal.targetDate,
    today,
  });
  return {
    targetAmountOriginal,
    targetAmountFuture,
    currentAmount: goal.currentAmount,
    ...std,
    currentMonthlyContribution: goal.plannedContributionAmount * fxRate,
    fundingGapAtTargetDate: Math.max(0, targetAmountFuture - goal.currentAmount),
    progressPct: targetAmountFuture > 0 ? (goal.currentAmount / targetAmountFuture) * 100 : 0,
    trackStatus: 'unable_to_assess',
    explanation: `Original-currency target of ${targetAmountOriginal.toFixed(0)} converts to ${targetAmountFuture.toFixed(0)} in reporting currency at the assumed FX rate of ${fxRate.toFixed(4)}.`,
    currentValue: {
      annualSupportCommitmentOriginal,
      totalProjectedSupportOriginal,
      fxRateAssumption: fxRate,
      reportingCurrencyEquivalent: targetAmountFuture,
    },
  };
}

// ---------------------------------------------------------------------------
// 7. Major Purchase
// ---------------------------------------------------------------------------
function majorPurchaseForecast(goal: GoalRecord, assumption: ScenarioAssumption, today: Date): CategoryForecastResult {
  const targetAmountFuture =
    goal.inflationAdjusted && goal.targetAmountBasis === 'today_value'
      ? inflationAdjustedTarget(goal.targetAmount, assumption.costInflation, yearsRemaining(goal.targetDate, today))
      : goal.targetAmount;
  const monthlyRate = annualToMonthlyRate(assumption.returnRate);
  const std = standardForecast({
    currentAmount: goal.currentAmount,
    targetAmountFuture,
    plannedMonthlyContribution: goal.plannedContributionAmount,
    annualContributionGrowthPct: goal.annualContributionGrowthPct,
    monthlyRate,
    targetDate: goal.targetDate,
    today,
  });
  return {
    targetAmountOriginal: goal.targetAmount,
    targetAmountFuture,
    currentAmount: goal.currentAmount,
    ...std,
    currentMonthlyContribution: goal.plannedContributionAmount,
    fundingGapAtTargetDate: Math.max(0, targetAmountFuture - goal.currentAmount),
    progressPct: targetAmountFuture > 0 ? (goal.currentAmount / targetAmountFuture) * 100 : 0,
    trackStatus: 'unable_to_assess',
    explanation: `Estimated cost at completion is $${targetAmountFuture.toFixed(0)} after price growth.`,
    currentValue: { priceGrowthAssumption: assumption.costInflation },
  };
}

// ---------------------------------------------------------------------------
// 8. Business
// ---------------------------------------------------------------------------
function businessForecast(goal: GoalRecord, extras: GoalExtras, assumption: ScenarioAssumption, today: Date): CategoryForecastResult {
  const externalFunding = extras.expectedExternalFunding ?? 0;
  const personalFundingRequirement = Math.max(0, goal.targetAmount - externalFunding);
  const monthlyRate = annualToMonthlyRate(assumption.returnRate);
  const std = standardForecast({
    currentAmount: goal.currentAmount,
    targetAmountFuture: personalFundingRequirement,
    plannedMonthlyContribution: goal.plannedContributionAmount,
    annualContributionGrowthPct: goal.annualContributionGrowthPct,
    monthlyRate,
    targetDate: goal.targetDate,
    today,
  });
  return {
    targetAmountOriginal: goal.targetAmount,
    targetAmountFuture: personalFundingRequirement,
    currentAmount: goal.currentAmount,
    ...std,
    currentMonthlyContribution: goal.plannedContributionAmount,
    fundingGapAtTargetDate: Math.max(0, personalFundingRequirement - goal.currentAmount),
    progressPct: personalFundingRequirement > 0 ? (goal.currentAmount / personalFundingRequirement) * 100 : 0,
    trackStatus: 'unable_to_assess',
    explanation: `Personal funding requirement after $${externalFunding.toFixed(0)} of expected external funding.`,
    currentValue: { capitalTarget: goal.targetAmount, expectedExternalFunding: externalFunding, personalFundingRequirement },
  };
}

// ---------------------------------------------------------------------------
// Generic fallback
// ---------------------------------------------------------------------------
function genericForecast(goal: GoalRecord, assumption: ScenarioAssumption, today: Date): CategoryForecastResult {
  const targetAmountFuture =
    goal.inflationAdjusted && goal.targetAmountBasis === 'today_value'
      ? inflationAdjustedTarget(goal.targetAmount, assumption.costInflation, yearsRemaining(goal.targetDate, today))
      : goal.targetAmount;
  const monthlyRate = annualToMonthlyRate(assumption.returnRate);
  const std = standardForecast({
    currentAmount: goal.currentAmount,
    targetAmountFuture,
    plannedMonthlyContribution: goal.plannedContributionAmount,
    annualContributionGrowthPct: goal.annualContributionGrowthPct,
    monthlyRate,
    targetDate: goal.targetDate,
    today,
  });
  return {
    targetAmountOriginal: goal.targetAmount,
    targetAmountFuture,
    currentAmount: goal.currentAmount,
    ...std,
    currentMonthlyContribution: goal.plannedContributionAmount,
    fundingGapAtTargetDate: Math.max(0, targetAmountFuture - goal.currentAmount),
    progressPct: targetAmountFuture > 0 ? (goal.currentAmount / targetAmountFuture) * 100 : 0,
    trackStatus: 'unable_to_assess',
    explanation: `Target of $${targetAmountFuture.toFixed(0)}, based on your current contribution plan.`,
    currentValue: {},
  };
}

export function computeCategoryForecast(
  goal: GoalRecord,
  extras: GoalExtras,
  config: GoalPlanningConfig,
  scenario: ScenarioCode,
  today: Date
): CategoryForecastResult {
  const assumption = resolveAssumptions(config, goal.forecastLogicKey, scenario);
  let result: CategoryForecastResult;
  switch (goal.forecastLogicKey) {
    case 'emergency_fund':
      result = emergencyFundForecast(goal, extras, assumption, today);
      break;
    case 'home_deposit':
      result = homeDepositForecast(goal, extras, assumption, today);
      break;
    case 'debt_payoff':
      result = debtPayoffForecast(goal, extras, today);
      break;
    case 'retirement':
      result = retirementForecast(goal, assumption, today);
      break;
    case 'education':
      result = educationForecast(goal, assumption, today);
      break;
    case 'cross_border': {
      const reportingCurrency = extras.reportingCurrencyCode ?? goal.currencyCode;
      const pairKey = `${goal.currencyCode}_${reportingCurrency}`;
      const fxRate = reportingCurrency === goal.currencyCode ? 1 : (config.fxAssumptions[pairKey]?.[scenario] ?? 1);
      result = crossBorderForecast(goal, assumption, fxRate, today);
      break;
    }
    case 'major_purchase':
      result = majorPurchaseForecast(goal, assumption, today);
      break;
    case 'business':
      result = businessForecast(goal, extras, assumption, today);
      break;
    default:
      result = genericForecast(goal, assumption, today);
  }
  result.trackStatus = classifyTrack(result.forecastFundingPct, result.currentAmount, result.targetAmountFuture, config.trackStatusThresholds);
  return result;
}

export function computeAllScenarios(
  goal: GoalRecord,
  extras: GoalExtras,
  config: GoalPlanningConfig,
  today: Date = new Date()
): Record<ScenarioCode, CategoryForecastResult> {
  return {
    conservative: computeCategoryForecast(goal, extras, config, 'conservative', today),
    base: computeCategoryForecast(goal, extras, config, 'base', today),
    optimistic: computeCategoryForecast(goal, extras, config, 'optimistic', today),
  };
}
