import type { DashboardSummary } from './dashboard';
import { clamp, scoreFromBrackets, bandFor, type ScoreBand } from './scoring';
import type { ResilienceResult } from './resilience';

export const MODEL_VERSION = 'fhs-2.0.0';

export type ComponentCode =
  | 'cash_flow'
  | 'savings'
  | 'emergency_fund'
  | 'debt'
  | 'net_worth'
  | 'investment'
  | 'retirement'
  | 'insurance'
  | 'resilience'
  | 'behaviour';

export type Treatment = 'scored' | 'not_applicable' | 'missing_data';

export interface ComponentResult {
  code: ComponentCode;
  label: string;
  rawScore: number | null;
  weight: number;
  weightedContribution: number;
  statusBand: string;
  dataCompleteness: number;
  treatment: Treatment;
  explanation: string;
  currentValue: Record<string, unknown>;
  benchmarkValue: Record<string, unknown>;
}

export interface HealthScoreConfig {
  componentWeights: Record<ComponentCode, number>;
  scoreBands: ScoreBand[];
  riskOverride: { deficitMonthsThreshold: number; emergencyMonthsThreshold: number; scoreCap: number };
}

export interface CheckIns {
  goals_reviewed_at: string | null;
  insurance_reviewed_at: string | null;
  debt_reviewed_at: string | null;
  investment_plan_reviewed_at: string | null;
  beneficiaries_reviewed_at: string | null;
  bills_paid_on_time: boolean | null;
  budget_maintained: boolean | null;
  savings_automated: boolean | null;
}

export interface HealthScoreInput {
  dashboard: DashboardSummary;
  age: number | null;
  dependantsCount: number;
  isSelfEmployed: boolean;
  checkIns: CheckIns | null;
  // Module 6's Financial Resilience score, absorbed as this component rather
  // than recomputed inline (superseded the old 4-signal blend). Null if
  // Module 6's config/data couldn't be loaded.
  resilienceResult: ResilienceResult | null;
  config: HealthScoreConfig;
}

export interface Recommendation {
  componentCode: ComponentCode;
  priority: 'high' | 'medium' | 'low';
  title: string;
  explanation: string;
  estimatedScoreImprovement: number;
  estimatedFinancialBenefit: number | null;
}

export interface HealthScoreResult {
  overallScore: number;
  roundedScore: number;
  statusBand: string;
  statusLabel: string;
  dataConfidence: number;
  riskOverrideApplied: boolean;
  riskOverrideReason: string | null;
  components: ComponentResult[];
  recommendations: Recommendation[];
  positiveContributors: string[];
  reductions: string[];
  modelVersion: string;
}

function missingComponent(code: ComponentCode, label: string, weight: number, reason: string): ComponentResult {
  return {
    code,
    label,
    rawScore: null,
    weight,
    weightedContribution: 0,
    statusBand: 'unknown',
    dataCompleteness: 0,
    treatment: 'missing_data',
    explanation: reason,
    currentValue: {},
    benchmarkValue: {},
  };
}

// Whether the user has genuinely engaged with data entry, used to decide
// whether an empty register means "confirmed zero" or "not entered yet".
function hasEngaged(d: DashboardSummary): boolean {
  return d.hasIncome && d.hasExpenses && (d.hasAssets || d.hasLiabilities || d.hasInvestments);
}

// ---------------------------------------------------------------------------
// 1. Cash Flow Health
// ---------------------------------------------------------------------------
function scoreCashFlow(input: HealthScoreInput, bands: ScoreBand[]): ComponentResult {
  const d = input.dashboard;
  const weight = input.config.componentWeights.cash_flow;
  if (!d.hasIncome || !d.hasExpenses) {
    return missingComponent('cash_flow', 'Cash Flow Health', weight, 'Add income and expenses to calculate this.');
  }
  const margin = d.savingsRate ?? 0;
  const marginScore =
    margin < 0
      ? clamp(10 + margin * 100, 10, 30)
      : scoreFromBrackets(margin * 100, [
          { min: 25, score: 100 },
          { min: 20, score: 90 },
          { min: 15, score: 80 },
          { min: 10, score: 70 },
          { min: 5, score: 55 },
          { min: 0, score: 40 },
        ]);
  const deficitMonths = d.snapshots.filter((s) => s.monthly_surplus < 0).length;
  const stabilityScore = deficitMonths === 0 ? 100 : deficitMonths === 1 ? 80 : deficitMonths === 2 ? 60 : 30;
  const concentration = d.largestIncomeSharePct ?? (d.incomeSourceCount <= 1 ? 1 : 0.5);
  const concentrationScore = concentration <= 0.6 ? 100 : concentration <= 0.8 ? 70 : 40;
  const raw = clamp(marginScore * 0.7 + stabilityScore * 0.2 + concentrationScore * 0.1);
  return {
    code: 'cash_flow',
    label: 'Cash Flow Health',
    rawScore: raw,
    weight,
    weightedContribution: 0,
    statusBand: bandFor(raw, bands).band,
    dataCompleteness: 100,
    treatment: 'scored',
    explanation: `Your household retains ${(margin * 100).toFixed(0)}% of net income after expenses.`,
    currentValue: {
      monthlyIncome: d.netMonthlyIncome,
      monthlyExpenses: d.totalMonthlyExpenses + d.debtMonthlyRepayments,
      cashFlowMargin: margin,
      deficitMonths,
      incomeSourceCount: d.incomeSourceCount,
    },
    benchmarkValue: { targetMargin: 0.15 },
  };
}

// ---------------------------------------------------------------------------
// 2. Savings Behaviour
// ---------------------------------------------------------------------------
function scoreSavings(input: HealthScoreInput, bands: ScoreBand[]): ComponentResult {
  const d = input.dashboard;
  const weight = input.config.componentWeights.savings;
  if (!d.hasIncome) {
    return missingComponent('savings', 'Savings Behaviour', weight, 'Add income to calculate this.');
  }
  const income = d.netMonthlyIncome || d.grossMonthlyIncome;
  const cashSavingsRate = income > 0 ? Math.max(d.monthlySurplus, 0) / income : 0;
  const investmentContributionRate = d.investmentContributionRate ?? 0;
  const retirementContributionRate = d.retirementContributionRate ?? 0;
  const retirementEmployerContributionRate = d.retirementEmployerContributionRate ?? 0;
  // Only employer retirement contributions are genuinely additive — that
  // money is never part of take-home pay to begin with. Personal retirement
  // contributions and investment contributions are funded from the same net
  // income already reflected in cashSavingsRate (monthlySurplus / income),
  // since neither is subtracted anywhere when monthlySurplus is calculated —
  // adding them again on top would double-count the same dollars.
  const totalSavingsRate = cashSavingsRate + retirementEmployerContributionRate;
  const raw =
    totalSavingsRate < 0
      ? clamp(15 + totalSavingsRate * 100, 0, 15)
      : scoreFromBrackets(totalSavingsRate * 100, [
          { min: 25, score: 100 },
          { min: 20, score: 90 },
          { min: 15, score: 80 },
          { min: 10, score: 65 },
          { min: 5, score: 45 },
          { min: 0, score: 25 },
        ]);
  const streak = (() => {
    let count = 0;
    for (let i = d.snapshots.length - 1; i >= 0; i--) {
      if ((d.snapshots[i].savings_rate ?? 0) > 0) count++;
      else break;
    }
    return count;
  })();
  return {
    code: 'savings',
    label: 'Savings Behaviour',
    rawScore: raw,
    weight,
    weightedContribution: 0,
    statusBand: bandFor(raw, bands).band,
    dataCompleteness: 100,
    treatment: 'scored',
    explanation: `Total savings rate (monthly surplus plus employer retirement contributions) is ${(totalSavingsRate * 100).toFixed(0)}%.`,
    currentValue: {
      cashSavingsRate,
      investmentContributionRate,
      retirementContributionRate,
      retirementEmployerContributionRate,
      totalSavingsRate,
      monthlySavedAmount: Math.max(d.monthlySurplus, 0),
      savingsStreakMonths: streak,
    },
    benchmarkValue: { targetSavingsRate: 0.2 },
  };
}

// ---------------------------------------------------------------------------
// 3. Emergency Fund and Liquidity
// ---------------------------------------------------------------------------
function recommendedEmergencyMonths(input: HealthScoreInput): number {
  const d = input.dashboard;
  let target = 6;
  if (input.isSelfEmployed) target += 2;
  if (input.dependantsCount > 0) target += 1;
  if (d.incomeSourceCount <= 1) target += 1;
  return clamp(target, 3, 12);
}

function scoreEmergencyFund(input: HealthScoreInput, bands: ScoreBand[]): ComponentResult {
  const d = input.dashboard;
  const weight = input.config.componentWeights.emergency_fund;
  if (!d.hasExpenses) {
    return missingComponent('emergency_fund', 'Emergency Fund & Liquidity', weight, 'Add expenses to calculate this.');
  }
  const months = d.emergencyFundMonths;
  if (months === null) {
    // essentialMonthlyExpenses is 0 — nothing has been marked essential yet,
    // so "months of coverage" can't be computed. That's missing data, not a
    // confirmed zero: don't let it silently drag the score down.
    return missingComponent(
      'emergency_fund',
      'Emergency Fund & Liquidity',
      weight,
      'Mark at least one expense as essential to calculate months of coverage.'
    );
  }
  const raw = scoreFromBrackets(months, [
    { min: 9, score: 100 },
    { min: 6, score: 90 },
    { min: 4, score: 75 },
    { min: 3, score: 60 },
    { min: 1, score: 35 },
    { min: 0, score: 15 },
  ]);
  const target = recommendedEmergencyMonths(input);
  const targetBalance = d.essentialMonthlyExpenses * target;
  const gap = Math.max(0, targetBalance - d.liquidAssets);
  return {
    code: 'emergency_fund',
    label: 'Emergency Fund & Liquidity',
    rawScore: raw,
    weight,
    weightedContribution: 0,
    statusBand: bandFor(raw, bands).band,
    dataCompleteness: 100,
    treatment: 'scored',
    explanation: `Your liquid cash covers ${months.toFixed(1)} months of essential expenses.`,
    currentValue: { balance: d.liquidAssets, essentialMonthlyExpenses: d.essentialMonthlyExpenses, months, fundingGap: gap },
    benchmarkValue: { recommendedMonths: target, targetBalance },
  };
}

// ---------------------------------------------------------------------------
// 4. Debt Health
// ---------------------------------------------------------------------------
function scoreDebt(input: HealthScoreInput, bands: ScoreBand[]): ComponentResult {
  const d = input.dashboard;
  const weight = input.config.componentWeights.debt;
  const engaged = hasEngaged(d);
  if (!d.hasLiabilities) {
    if (engaged) {
      // Confirmed zero debt — genuinely excellent for this component.
      return {
        code: 'debt',
        label: 'Debt Health',
        rawScore: 100,
        weight,
        weightedContribution: 0,
        statusBand: bandFor(100, bands).band,
        dataCompleteness: 100,
        treatment: 'scored',
        explanation: 'No liabilities recorded — no debt-servicing burden.',
        currentValue: { totalDebt: 0, debtServiceRatio: 0 },
        benchmarkValue: {},
      };
    }
    return missingComponent('debt', 'Debt Health', weight, 'Add liabilities (or confirm you have none) to calculate this.');
  }
  const dsr = d.debtServiceRatio ?? 0;
  const raw = scoreFromBrackets((1 - dsr) * 100, [
    { min: 85, score: 100 },
    { min: 75, score: 85 },
    { min: 65, score: 65 },
    { min: 55, score: 40 },
    { min: 0, score: 15 },
  ]);
  const consumerDebtRatio = d.grossMonthlyIncome > 0 ? d.badDebt / (d.grossMonthlyIncome * 12) : 0;
  const penalty = consumerDebtRatio > 0.2 ? 10 : 0;
  const finalScore = clamp(raw - penalty);
  return {
    code: 'debt',
    label: 'Debt Health',
    rawScore: finalScore,
    weight,
    weightedContribution: 0,
    statusBand: bandFor(finalScore, bands).band,
    dataCompleteness: 100,
    treatment: 'scored',
    explanation: `Debt repayments are ${(dsr * 100).toFixed(1)}% of net monthly income.`,
    currentValue: {
      totalDebt: d.totalLiabilities,
      goodDebt: d.goodDebt,
      badDebt: d.badDebt,
      debtServiceRatio: dsr,
      debtToIncome: d.debtToIncome,
      averageInterestRate: d.averageInterestRate,
    },
    benchmarkValue: { targetDebtServiceRatio: 0.15, targetDebtToIncome: 3 },
  };
}

// ---------------------------------------------------------------------------
// 5. Net Worth and Asset Position
// ---------------------------------------------------------------------------
function scoreNetWorth(input: HealthScoreInput, bands: ScoreBand[]): ComponentResult {
  const d = input.dashboard;
  const weight = input.config.componentWeights.net_worth;
  if (!d.hasAssets && !d.hasLiabilities) {
    return missingComponent('net_worth', 'Net Worth & Asset Position', weight, 'Add assets or liabilities to calculate this.');
  }
  const assetBase = d.totalAssets + d.totalInvestments + d.totalRetirement;
  const netWorthRatio = assetBase > 0 ? d.netWorth / assetBase : 0;
  const ratioScore = scoreFromBrackets(netWorthRatio * 100, [
    { min: 80, score: 100 },
    { min: 60, score: 85 },
    { min: 40, score: 65 },
    { min: 20, score: 45 },
    { min: 0, score: 25 },
  ]);
  const largest = d.netWorthAllocation.slice().sort((a, b) => b.value - a.value)[0];
  const concentration = assetBase > 0 && largest ? largest.value / assetBase : 0;
  const concentrationPenalty = concentration > 0.7 ? 15 : concentration > 0.5 ? 5 : 0;
  const raw = clamp(ratioScore - concentrationPenalty);
  return {
    code: 'net_worth',
    label: 'Net Worth & Asset Position',
    rawScore: d.netWorth < 0 ? clamp(raw, 0, 20) : raw,
    weight,
    weightedContribution: 0,
    statusBand: bandFor(raw, bands).band,
    dataCompleteness: 100,
    treatment: 'scored',
    explanation: `Net worth is ${(netWorthRatio * 100).toFixed(0)}% of total assets.`,
    currentValue: { netWorth: d.netWorth, totalAssets: assetBase, netWorthRatio, concentration },
    benchmarkValue: { targetNetWorthRatio: 0.6 },
  };
}

// ---------------------------------------------------------------------------
// 6. Investment Health
// ---------------------------------------------------------------------------
function scoreInvestment(input: HealthScoreInput, bands: ScoreBand[]): ComponentResult {
  const d = input.dashboard;
  const weight = input.config.componentWeights.investment;
  if (!d.hasInvestments) {
    return missingComponent('investment', 'Investment Health', weight, 'Add investments to calculate this, or this may genuinely be zero if you invest only through super.');
  }
  const diversification = d.investmentDiversificationScore ?? 50;
  const contributing = d.investmentAnnualContribution > 0 ? 10 : 0;
  const raw = clamp(diversification * 0.9 + contributing);
  return {
    code: 'investment',
    label: 'Investment Health',
    rawScore: raw,
    weight,
    weightedContribution: 0,
    statusBand: bandFor(raw, bands).band,
    dataCompleteness: 100,
    treatment: 'scored',
    explanation: `Diversification score is ${diversification}/100 across your investment holdings.`,
    currentValue: {
      portfolioValue: d.totalInvestments,
      diversificationScore: diversification,
      annualContribution: d.investmentAnnualContribution,
      unrealisedGain: d.investmentUnrealisedGain,
    },
    benchmarkValue: { targetDiversificationScore: 70 },
  };
}

// ---------------------------------------------------------------------------
// 7. Retirement Readiness
// ---------------------------------------------------------------------------
function scoreRetirement(input: HealthScoreInput, bands: ScoreBand[]): ComponentResult {
  const d = input.dashboard;
  const weight = input.config.componentWeights.retirement;
  if (!d.hasRetirement) {
    return missingComponent('retirement', 'Retirement Readiness', weight, 'Add retirement accounts to calculate this.');
  }
  const age = input.age;
  const annualIncome = d.grossMonthlyIncome * 12;
  // Rough multiple-of-income guideline by age (a common rule of thumb, not
  // personalised advice) — used only to gauge whether the balance looks
  // roughly on track, never shown as a recommendation to buy a product.
  const targetMultiple = age === null ? 3 : age < 30 ? 0.5 : age < 40 ? 1.5 : age < 50 ? 3 : age < 60 ? 5 : 7;
  const targetBalance = annualIncome > 0 ? annualIncome * targetMultiple : null;
  const balanceRatio = targetBalance && targetBalance > 0 ? d.totalRetirement / targetBalance : null;
  const balanceScore =
    balanceRatio === null
      ? 50
      : scoreFromBrackets(balanceRatio * 100, [
          { min: 100, score: 100 },
          { min: 75, score: 85 },
          { min: 50, score: 65 },
          { min: 25, score: 45 },
          { min: 0, score: 25 },
        ]);
  const contributionRate =
    annualIncome > 0
      ? ((d.retirementEmployerMonthlyContribution + d.retirementPersonalMonthlyContribution) * 12) / annualIncome
      : 0;
  const contributionScore = scoreFromBrackets(contributionRate * 100, [
    { min: 12, score: 100 },
    { min: 9, score: 85 },
    { min: 6, score: 65 },
    { min: 0, score: 40 },
  ]);
  const raw = clamp(balanceScore * 0.6 + contributionScore * 0.4);
  return {
    code: 'retirement',
    label: 'Retirement Readiness',
    rawScore: raw,
    weight,
    weightedContribution: 0,
    statusBand: bandFor(raw, bands).band,
    dataCompleteness: age !== null ? 100 : 70,
    treatment: 'scored',
    explanation: targetBalance
      ? `Retirement balance is ${((d.totalRetirement / targetBalance) * 100).toFixed(0)}% of a rough age-based guideline.`
      : 'Add your date of birth for a more accurate retirement guideline.',
    currentValue: {
      currentBalance: d.totalRetirement,
      contributionRate,
      employerMonthly: d.retirementEmployerMonthlyContribution,
      personalMonthly: d.retirementPersonalMonthlyContribution,
    },
    benchmarkValue: { targetBalance, targetMultiple, targetContributionRate: 0.12 },
  };
}

// ---------------------------------------------------------------------------
// 8. Insurance and Protection
// ---------------------------------------------------------------------------
function scoreInsurance(input: HealthScoreInput, bands: ScoreBand[]): ComponentResult {
  const d = input.dashboard;
  const weight = input.config.componentWeights.insurance;
  const engaged = hasEngaged(d);
  if (!d.hasInsurance) {
    if (engaged && input.dependantsCount === 0) {
      return {
        code: 'insurance',
        label: 'Insurance & Protection',
        rawScore: 60,
        weight,
        weightedContribution: 0,
        statusBand: bandFor(60, bands).band,
        dataCompleteness: 100,
        treatment: 'scored',
        explanation: 'No insurance recorded. With no dependants this may be lower risk, but income protection is still worth reviewing.',
        currentValue: { totalCover: 0 },
        benchmarkValue: {},
      };
    }
    return missingComponent('insurance', 'Insurance & Protection', weight, 'Add insurance policies (or confirm you have none) to calculate this.');
  }
  const hasLife = d.insuranceByType.some((i) => i.coverType === 'life');
  const hasIncomeProtection = d.insuranceByType.some((i) => i.coverType === 'income_protection');
  const lifeCover = d.insuranceByType.find((i) => i.coverType === 'life')?.coverAmount ?? 0;
  const annualIncome = d.grossMonthlyIncome * 12;
  const targetLifeCover = annualIncome * (input.dependantsCount > 0 ? 10 : 5);
  const adequacyRatio = targetLifeCover > 0 ? lifeCover / targetLifeCover : null;
  let raw = 50;
  if (hasLife) raw += 20;
  if (hasIncomeProtection) raw += 20;
  if (input.dependantsCount > 0 && !hasLife) raw -= 20;
  if (adequacyRatio !== null && adequacyRatio >= 0.8) raw += 10;
  raw = clamp(raw);
  return {
    code: 'insurance',
    label: 'Insurance & Protection',
    rawScore: raw,
    weight,
    weightedContribution: 0,
    statusBand: bandFor(raw, bands).band,
    dataCompleteness: 100,
    treatment: 'scored',
    explanation: hasLife
      ? `Life cover is ${adequacyRatio !== null ? `${(adequacyRatio * 100).toFixed(0)}% of a rough guideline` : 'recorded'}.`
      : input.dependantsCount > 0
        ? 'No life insurance recorded despite having dependants.'
        : 'Insurance recorded, but no life cover found.',
    currentValue: { totalAnnualPremium: d.totalAnnualPremium, hasLife, hasIncomeProtection, lifeCover },
    benchmarkValue: { targetLifeCover },
  };
}

// ---------------------------------------------------------------------------
// 9. Financial Resilience — superseded/absorbed from Module 6's dedicated
// Financial Resilience™ engine (lib/engines/resilience.ts), which replaces
// the original inline 4-signal blend this component used before Module 6
// existed. See app/(app)/resilience for the full 6-component breakdown.
// ---------------------------------------------------------------------------
function scoreResilience(input: HealthScoreInput, bands: ScoreBand[]): ComponentResult {
  const weight = input.config.componentWeights.resilience;
  const r = input.resilienceResult;
  const anyScored = r?.components.some((c) => c.treatment === 'scored') ?? false;
  if (!r || !anyScored) {
    return missingComponent('resilience', 'Financial Resilience', weight, 'Add income and expenses to calculate this.');
  }
  return {
    code: 'resilience',
    label: 'Financial Resilience',
    rawScore: r.overallScore,
    weight,
    weightedContribution: 0,
    statusBand: bandFor(r.overallScore, bands).band,
    dataCompleteness: r.confidence,
    treatment: 'scored',
    explanation:
      r.risks.length > 0
        ? `Your Financial Resilience score is ${r.roundedScore}/100 (${r.statusLabel}). The main resilience risk identified is ${r.risks[0].title.toLowerCase()}.`
        : `Your Financial Resilience score is ${r.roundedScore}/100 (${r.statusLabel}), reflecting your capacity to withstand unexpected financial pressure across income, debt, savings and insurance.`,
    currentValue: { resilienceScore: r.roundedScore, resilienceBand: r.statusBand, resilienceConfidence: r.confidence },
    benchmarkValue: {},
  };
}

// ---------------------------------------------------------------------------
// 10. Financial Management Behaviour
// ---------------------------------------------------------------------------
function scoreBehaviour(input: HealthScoreInput, bands: ScoreBand[]): ComponentResult {
  const weight = input.config.componentWeights.behaviour;
  const c = input.checkIns;
  const untouched =
    !c ||
    (!c.goals_reviewed_at &&
      !c.insurance_reviewed_at &&
      !c.debt_reviewed_at &&
      !c.investment_plan_reviewed_at &&
      !c.beneficiaries_reviewed_at &&
      c.bills_paid_on_time === null &&
      c.budget_maintained === null &&
      c.savings_automated === null);
  if (untouched) {
    return missingComponent('behaviour', 'Financial Management Behaviour', weight, 'Complete the check-in checklist to calculate this.');
  }
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const isRecent = (d: string | null) => d !== null && new Date(d) >= oneYearAgo;
  const items = [
    isRecent(c.goals_reviewed_at),
    isRecent(c.insurance_reviewed_at),
    isRecent(c.debt_reviewed_at),
    isRecent(c.investment_plan_reviewed_at),
    isRecent(c.beneficiaries_reviewed_at),
    c.bills_paid_on_time === true,
    c.budget_maintained === true,
    c.savings_automated === true,
  ];
  const completed = items.filter(Boolean).length;
  const raw = clamp((completed / items.length) * 100);
  return {
    code: 'behaviour',
    label: 'Financial Management Behaviour',
    rawScore: raw,
    weight,
    weightedContribution: 0,
    statusBand: bandFor(raw, bands).band,
    dataCompleteness: 100,
    treatment: 'scored',
    explanation: `${completed} of ${items.length} good financial habits are up to date.`,
    currentValue: { completedActions: completed, totalActions: items.length },
    benchmarkValue: {},
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
export function computeHealthScore(input: HealthScoreInput): HealthScoreResult {
  const bands = input.config.scoreBands;

  const cashFlow = scoreCashFlow(input, bands);
  const savings = scoreSavings(input, bands);
  const emergencyFund = scoreEmergencyFund(input, bands);
  const debt = scoreDebt(input, bands);
  const netWorth = scoreNetWorth(input, bands);
  const investment = scoreInvestment(input, bands);
  const retirement = scoreRetirement(input, bands);
  const insurance = scoreInsurance(input, bands);
  const behaviour = scoreBehaviour(input, bands);
  const resilience = scoreResilience(input, bands);

  const components = [cashFlow, savings, emergencyFund, debt, netWorth, investment, retirement, insurance, resilience, behaviour];

  const scored = components.filter((c) => c.treatment === 'scored' && c.rawScore !== null);
  const scoredWeightTotal = scored.reduce((sum, c) => sum + c.weight, 0);

  let overallScore = 0;
  for (const c of components) {
    if (c.treatment === 'scored' && c.rawScore !== null && scoredWeightTotal > 0) {
      const effectiveWeight = c.weight / scoredWeightTotal;
      c.weightedContribution = Math.round(c.rawScore * effectiveWeight * 1000) / 1000;
      overallScore += c.weightedContribution;
    } else {
      c.weightedContribution = 0;
    }
  }
  overallScore = clamp(overallScore);

  const deficitMonths = input.dashboard.snapshots.filter((s) => s.monthly_surplus < 0).length;
  const { deficitMonthsThreshold, emergencyMonthsThreshold, scoreCap } = input.config.riskOverride;
  const emergencyMonths = input.dashboard.emergencyFundMonths ?? Infinity;
  let riskOverrideApplied = false;
  let riskOverrideReason: string | null = null;
  if (deficitMonths >= deficitMonthsThreshold && emergencyMonths < emergencyMonthsThreshold && overallScore > scoreCap) {
    overallScore = scoreCap;
    riskOverrideApplied = true;
    riskOverrideReason = `Persistent negative cash flow with less than ${emergencyMonthsThreshold} month(s) of emergency reserves caps the score until one of these improves.`;
  }

  const roundedScore = Math.round(overallScore);
  const { band, label } = bandFor(roundedScore, bands);

  const dataConfidence = clamp(
    (components.filter((c) => c.treatment === 'scored').length / components.length) * 100
  );

  const positiveContributors = components
    .filter((c) => c.treatment === 'scored' && c.rawScore !== null && c.rawScore >= 70)
    .sort((a, b) => b.weightedContribution - a.weightedContribution)
    .slice(0, 4)
    .map((c) => c.explanation);

  const reductions = components
    .filter((c) => c.treatment !== 'scored' || (c.rawScore !== null && c.rawScore < 70))
    .sort((a, b) => (a.rawScore ?? 0) - (b.rawScore ?? 0))
    .slice(0, 4)
    .map((c) => c.explanation);

  const recommendations: Recommendation[] = components
    .filter((c) => c.treatment === 'scored' && c.rawScore !== null && c.rawScore < 85)
    .map((c) => {
      const gap = 85 - (c.rawScore ?? 0);
      const estimatedScoreImprovement = Math.round(((gap / 100) * (c.weight / scoredWeightTotal) * 100) * 10) / 10;
      return {
        componentCode: c.code,
        priority: (c.rawScore ?? 0) < 40 ? 'high' : (c.rawScore ?? 0) < 65 ? 'medium' : 'low',
        title: `Improve ${c.label}`,
        explanation: c.explanation,
        estimatedScoreImprovement,
        estimatedFinancialBenefit:
          typeof c.currentValue.fundingGap === 'number' ? (c.currentValue.fundingGap as number) : null,
      } satisfies Recommendation;
    })
    .sort((a, b) => b.estimatedScoreImprovement - a.estimatedScoreImprovement)
    .slice(0, 5);

  return {
    overallScore,
    roundedScore,
    statusBand: band,
    statusLabel: label,
    dataConfidence,
    riskOverrideApplied,
    riskOverrideReason,
    components,
    recommendations,
    positiveContributors,
    reductions,
    modelVersion: MODEL_VERSION,
  };
}
