import type { DashboardSummary } from './dashboard';
import { computeInsuranceAdequacy } from './dashboard';
import { clamp, scoreFromBrackets, bandFor, type ScoreBand } from './scoring';
import { type FinancialSection, type FinancialSectionStatus } from './financialSectionStatus';

export const MODEL_VERSION = 'resilience-1.0.0';

export type ResilienceComponentCode =
  | 'emergency_fund'
  | 'liquidity'
  | 'income_resilience'
  | 'insurance_protection'
  | 'debt_pressure'
  | 'concentration_risk';

export type Treatment = 'scored' | 'not_applicable' | 'missing_data';

export interface ResilienceComponentResult {
  code: ResilienceComponentCode;
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

export interface ResilienceConfig {
  componentWeights: Record<ResilienceComponentCode, number>;
  scoreBands: ScoreBand[];
  confidenceWeights: {
    incomeCompleteness: number;
    expenseCompleteness: number;
    liquidAssetCompleteness: number;
    liabilityCompleteness: number;
    insuranceCompleteness: number;
    dataRecency: number;
    verificationHistory: number;
  };
  riskOverride: {
    scoreCapPrimary: number;
    scoreCapSecondary: number;
    criticalLiquidityWeeks: number;
    refinanceExposureMonths: number;
  };
}

export interface CommitmentRow {
  amount: number;
  due_date: string; // ISO date
  is_mandatory: boolean;
}

export interface ResilienceInput {
  dashboard: DashboardSummary;
  dependantsCount: number;
  isSelfEmployed: boolean;
  commitments: CommitmentRow[];
  isCurrentSnapshotRecent: boolean; // most recent financial_snapshots row is this calendar month
  hasPriorMonthHistory: boolean; // at least one earlier resilience_scores row exists
  config: ResilienceConfig;
  // Phase 0C: same canonical per-section status Health Score uses (see
  // lib/engines/financialSectionStatus.ts) — applies the same missing-data
  // integrity principle here: an unconfirmed absence of liabilities/
  // insurance must not be silently scored as a confirmed zero.
  sectionStatus: Record<FinancialSection, FinancialSectionStatus>;
}

export type RiskSeverity = 'low' | 'medium' | 'high' | 'critical';
export type RiskCategory = 'liquidity' | 'income' | 'insurance' | 'debt' | 'concentration';

export interface ResilienceRisk {
  code: string;
  category: RiskCategory;
  severity: RiskSeverity;
  title: string;
  explanation: string;
  metricValue: number | null;
  thresholdValue: number | null;
}

export interface ResilienceAction {
  code: string;
  title: string;
  explanation: string;
  priority: 'high' | 'medium' | 'low';
  relatedModule: string;
  relatedMetric: string;
}

export interface ResilienceResult {
  overallScore: number;
  roundedScore: number;
  statusBand: string;
  statusLabel: string;
  confidence: number;
  riskOverrideApplied: boolean;
  riskOverrideReason: string | null;
  components: ResilienceComponentResult[];
  risks: ResilienceRisk[];
  actions: ResilienceAction[];
  accessibleLiquidResources: number;
  committedCash90d: number;
  modelVersion: string;
}

function missingComponent(
  code: ResilienceComponentCode,
  label: string,
  weight: number,
  reason: string
): ResilienceComponentResult {
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

// Cash committed to known upcoming mandatory outflows within `days`, so it
// isn't double-counted as available emergency/liquidity coverage.
function committedCashWithinDays(commitments: CommitmentRow[], days: number, today = new Date()): number {
  const todayStr = today.toISOString().slice(0, 10);
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() + days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return commitments
    .filter((c) => c.is_mandatory && c.due_date >= todayStr && c.due_date <= cutoffStr)
    .reduce((sum, c) => sum + c.amount, 0);
}

// Liquid assets minus cash already committed to known mandatory outflows due
// within 90 days. Shared with the stress-test simulator (resilienceStress.ts)
// so "what's actually available" isn't computed two different ways.
export function computeAccessibleLiquidResources(
  d: DashboardSummary,
  commitments: CommitmentRow[]
): { accessible: number; committed90d: number } {
  const committed90d = committedCashWithinDays(commitments, 90);
  const accessible = Math.max(0, d.liquidAssets - committed90d);
  return { accessible, committed90d };
}

// ---------------------------------------------------------------------------
// 1. Emergency Fund Adequacy (25%)
// ---------------------------------------------------------------------------
function scoreEmergencyFund(
  input: ResilienceInput,
  bands: ScoreBand[]
): { result: ResilienceComponentResult; accessible: number; committed90d: number } {
  const d = input.dashboard;
  const weight = input.config.componentWeights.emergency_fund;
  const { accessible, committed90d } = computeAccessibleLiquidResources(d, input.commitments);

  if (!d.hasExpenses) {
    return {
      result: missingComponent('emergency_fund', 'Emergency Fund Adequacy', weight, 'Add expenses to calculate this.'),
      accessible,
      committed90d,
    };
  }
  if (d.essentialMonthlyExpenses === 0) {
    return {
      result: missingComponent(
        'emergency_fund',
        'Emergency Fund Adequacy',
        weight,
        'Mark at least one expense as essential to calculate months of coverage.'
      ),
      accessible,
      committed90d,
    };
  }

  const essentialMonths = accessible / d.essentialMonthlyExpenses;
  const coreSurvivalMonths = d.coreSurvivalMonthlyExpenses > 0 ? accessible / d.coreSurvivalMonthlyExpenses : null;
  const raw = scoreFromBrackets(essentialMonths, [
    { min: 9, score: 100 },
    { min: 6, score: 90 },
    { min: 4, score: 72 },
    { min: 3, score: 58 },
    { min: 1, score: 32 },
    { min: 0, score: 10 },
  ]);
  return {
    result: {
      code: 'emergency_fund',
      label: 'Emergency Fund Adequacy',
      rawScore: raw,
      weight,
      weightedContribution: 0,
      statusBand: bandFor(raw, bands).band,
      dataCompleteness: 100,
      treatment: 'scored',
      explanation:
        committed90d > 0
          ? `Accessible cash covers ${essentialMonths.toFixed(1)} months of essential expenses, after setting aside known commitments due in the next 90 days.`
          : `Accessible cash covers ${essentialMonths.toFixed(1)} months of essential expenses.`,
      currentValue: { accessibleResources: accessible, committed90d, essentialMonths, coreSurvivalMonths },
      benchmarkValue: { recommendedMonths: 6 },
    },
    accessible,
    committed90d,
  };
}

// ---------------------------------------------------------------------------
// 2. Liquidity Strength (15%)
// ---------------------------------------------------------------------------
function scoreLiquidity(input: ResilienceInput, bands: ScoreBand[], accessible: number): ResilienceComponentResult {
  const d = input.dashboard;
  const weight = input.config.componentWeights.liquidity;
  const monthlyObligations = d.totalMonthlyExpenses + d.debtMonthlyRepayments;
  if (monthlyObligations <= 0) {
    return missingComponent('liquidity', 'Liquidity Strength', weight, 'Add expenses to calculate this.');
  }
  const coverageMonths = accessible / monthlyObligations;
  const raw = scoreFromBrackets(coverageMonths, [
    { min: 3, score: 100 },
    { min: 2, score: 85 },
    { min: 1, score: 65 },
    { min: 0.5, score: 45 },
    { min: 0, score: 20 },
  ]);
  return {
    code: 'liquidity',
    label: 'Liquidity Strength',
    rawScore: raw,
    weight,
    weightedContribution: 0,
    statusBand: bandFor(raw, bands).band,
    dataCompleteness: 100,
    treatment: 'scored',
    explanation: `Accessible liquid resources cover ${coverageMonths.toFixed(1)} months of your total monthly obligations (30/90-day coverage).`,
    currentValue: { accessibleResources: accessible, monthlyObligations, coverageMonths },
    benchmarkValue: { recommendedMonths: 3 },
  };
}

// ---------------------------------------------------------------------------
// 3. Income Resilience (15%)
// ---------------------------------------------------------------------------
function scoreIncomeResilience(input: ResilienceInput, bands: ScoreBand[]): ResilienceComponentResult {
  const d = input.dashboard;
  const weight = input.config.componentWeights.income_resilience;
  if (!d.hasIncome) {
    return missingComponent('income_resilience', 'Income Resilience', weight, 'Add income to calculate this.');
  }
  const sourceDiversityScore = d.incomeSourceCount >= 3 ? 100 : d.incomeSourceCount === 2 ? 75 : 40;
  const fallbackShare = d.largestIncomeSharePct ?? (d.incomeSourceCount <= 1 ? 1 : 0.5);
  const concentration = d.employerConcentration ?? fallbackShare ** 2;
  const concentrationScore = scoreFromBrackets((1 - concentration) * 100, [
    { min: 70, score: 100 },
    { min: 50, score: 80 },
    { min: 30, score: 55 },
    { min: 0, score: 30 },
  ]);
  const passiveRatio = d.grossMonthlyIncome > 0 ? d.passiveMonthlyIncome / d.grossMonthlyIncome : 0;
  const passiveScore = scoreFromBrackets(passiveRatio * 100, [
    { min: 30, score: 100 },
    { min: 15, score: 80 },
    { min: 5, score: 60 },
    { min: 0, score: 45 },
  ]);
  const selfEmployedPenalty = input.isSelfEmployed && d.incomeSourceCount <= 1 ? 10 : 0;
  const raw = clamp(sourceDiversityScore * 0.45 + concentrationScore * 0.35 + passiveScore * 0.2 - selfEmployedPenalty);
  return {
    code: 'income_resilience',
    label: 'Income Resilience',
    rawScore: raw,
    weight,
    weightedContribution: 0,
    statusBand: bandFor(raw, bands).band,
    dataCompleteness: 100,
    treatment: 'scored',
    explanation: `${d.incomeSourceCount} income source(s) recorded${d.employerConcentration !== null ? `, with employer concentration factored in` : ''}.`,
    currentValue: {
      incomeSourceCount: d.incomeSourceCount,
      employerConcentration: d.employerConcentration,
      passiveIncomeRatio: passiveRatio,
    },
    benchmarkValue: { targetSources: 2 },
  };
}

// ---------------------------------------------------------------------------
// 4. Insurance and Protection (20%)
// ---------------------------------------------------------------------------
function scoreInsuranceProtection(input: ResilienceInput, bands: ScoreBand[]): ResilienceComponentResult {
  const d = input.dashboard;
  const weight = input.config.componentWeights.insurance_protection;
  if (!d.hasInsurance) {
    // Phase 0C fix: same principle as healthScore.ts's Insurance component
    // — only an explicit "reviewed_zero" confirmation may be scored here,
    // never an inferred engagement heuristic.
    if (input.dependantsCount === 0 && input.sectionStatus.insurance === 'reviewed_zero') {
      const raw = 55;
      return {
        code: 'insurance_protection',
        label: 'Insurance & Protection',
        rawScore: raw,
        weight,
        weightedContribution: 0,
        statusBand: bandFor(raw, bands).band,
        dataCompleteness: 100,
        treatment: 'scored',
        explanation: 'No insurance held — confirmed by you. With no dependants this is lower risk, but income protection is still worth reviewing.',
        currentValue: { totalCover: 0 },
        benchmarkValue: {},
      };
    }
    return missingComponent(
      'insurance_protection',
      'Insurance & Protection',
      weight,
      'Add insurance policies (or confirm you have none) to calculate this.'
    );
  }
  const facts = computeInsuranceAdequacy(d, input.dependantsCount);
  let raw = 45;
  if (facts.hasLife) raw += 20;
  if (facts.hasIncomeProtection) raw += 20;
  if (input.dependantsCount > 0 && !facts.hasLife) raw -= 25;
  if (facts.adequacyRatio !== null && facts.adequacyRatio >= 0.8) raw += 10;
  if (facts.incomeProtectionWaitingPeriodDays !== null && facts.incomeProtectionWaitingPeriodDays > 90) raw -= 10;
  raw = clamp(raw);
  return {
    code: 'insurance_protection',
    label: 'Insurance & Protection',
    rawScore: raw,
    weight,
    weightedContribution: 0,
    statusBand: bandFor(raw, bands).band,
    dataCompleteness: 100,
    treatment: 'scored',
    explanation: facts.hasLife
      ? `Life cover is ${facts.adequacyRatio !== null ? `${(facts.adequacyRatio * 100).toFixed(0)}% of a rough guideline` : 'recorded'}.`
      : input.dependantsCount > 0
        ? 'No life insurance recorded despite having dependants.'
        : 'Insurance recorded, but no life cover found.',
    currentValue: {
      hasLife: facts.hasLife,
      hasIncomeProtection: facts.hasIncomeProtection,
      lifeCover: facts.lifeCover,
      waitingPeriodDays: facts.incomeProtectionWaitingPeriodDays,
    },
    benchmarkValue: { targetLifeCover: facts.targetLifeCover },
  };
}

// ---------------------------------------------------------------------------
// 5. Debt and Commitment Pressure (15%)
// ---------------------------------------------------------------------------
function scoreDebtPressure(input: ResilienceInput, bands: ScoreBand[]): ResilienceComponentResult {
  const d = input.dashboard;
  const weight = input.config.componentWeights.debt_pressure;
  if (!d.hasLiabilities) {
    // Phase 0C fix: same principle as healthScore.ts's Debt Health — only
    // an explicit "reviewed_zero" confirmation may be scored as a
    // confirmed-zero debt position.
    if (input.sectionStatus.liabilities === 'reviewed_zero') {
      const raw = 100;
      return {
        code: 'debt_pressure',
        label: 'Debt & Commitment Pressure',
        rawScore: raw,
        weight,
        weightedContribution: 0,
        statusBand: bandFor(raw, bands).band,
        dataCompleteness: 100,
        treatment: 'scored',
        explanation: 'No debts reported — confirmed by you.',
        currentValue: { totalDebt: 0 },
        benchmarkValue: {},
      };
    }
    return missingComponent(
      'debt_pressure',
      'Debt & Commitment Pressure',
      weight,
      'Add liabilities (or confirm you have none) to calculate this.'
    );
  }
  const dsr = d.debtServiceRatio ?? 0;
  const dsrScore = scoreFromBrackets((1 - dsr) * 100, [
    { min: 85, score: 100 },
    { min: 75, score: 82 },
    { min: 65, score: 60 },
    { min: 55, score: 38 },
    { min: 0, score: 15 },
  ]);
  const variableScore =
    d.variableRateDebtRatio === null
      ? 70
      : scoreFromBrackets((1 - d.variableRateDebtRatio) * 100, [
          { min: 70, score: 100 },
          { min: 40, score: 75 },
          { min: 0, score: 45 },
        ]);
  const resetExposureRatio = d.totalLiabilities > 0 ? d.upcomingRateResetBalance12m / d.totalLiabilities : 0;
  const resetScore = scoreFromBrackets((1 - resetExposureRatio) * 100, [
    { min: 80, score: 100 },
    { min: 50, score: 75 },
    { min: 0, score: 50 },
  ]);
  const utilizationScore =
    d.creditUtilization === null
      ? 70
      : scoreFromBrackets((1 - d.creditUtilization) * 100, [
          { min: 70, score: 100 },
          { min: 40, score: 70 },
          { min: 0, score: 35 },
        ]);
  const raw = clamp(dsrScore * 0.45 + variableScore * 0.2 + resetScore * 0.2 + utilizationScore * 0.15);
  return {
    code: 'debt_pressure',
    label: 'Debt & Commitment Pressure',
    rawScore: raw,
    weight,
    weightedContribution: 0,
    statusBand: bandFor(raw, bands).band,
    dataCompleteness: 100,
    treatment: 'scored',
    explanation: `Debt repayments are ${(dsr * 100).toFixed(0)}% of net income${
      d.variableRateDebtRatio !== null ? `, with ${(d.variableRateDebtRatio * 100).toFixed(0)}% on variable rates` : ''
    }.`,
    currentValue: {
      debtServiceRatio: dsr,
      variableRateDebtRatio: d.variableRateDebtRatio,
      upcomingRateResetBalance12m: d.upcomingRateResetBalance12m,
      creditUtilization: d.creditUtilization,
    },
    benchmarkValue: { targetDebtServiceRatio: 0.15 },
  };
}

// ---------------------------------------------------------------------------
// 6. Concentration and Exposure Risk (10%)
// ---------------------------------------------------------------------------
function scoreConcentrationRisk(input: ResilienceInput, bands: ScoreBand[]): ResilienceComponentResult {
  const d = input.dashboard;
  const weight = input.config.componentWeights.concentration_risk;
  const assetBase = d.totalAssets + d.totalInvestments + d.totalRetirement;
  if (assetBase <= 0) {
    return missingComponent('concentration_risk', 'Concentration & Exposure Risk', weight, 'Add assets or investments to calculate this.');
  }
  const propertyScore =
    d.propertyConcentration === null
      ? 70
      : scoreFromBrackets((1 - d.propertyConcentration) * 100, [
          { min: 60, score: 100 },
          { min: 40, score: 75 },
          { min: 20, score: 50 },
          { min: 0, score: 25 },
        ]);
  const institutionScore =
    d.institutionConcentration === null
      ? 70
      : scoreFromBrackets((1 - d.institutionConcentration) * 100, [
          { min: 70, score: 100 },
          { min: 50, score: 78 },
          { min: 0, score: 50 },
        ]);
  const countryTotal = d.investmentByCountry.reduce((s, c) => s + c.value, 0);
  const countryConcentration =
    countryTotal > 0 && d.investmentByCountry.length > 0 ? Math.max(...d.investmentByCountry.map((c) => c.value)) / countryTotal : null;
  const countryScore =
    countryConcentration === null
      ? 70
      : scoreFromBrackets((1 - countryConcentration) * 100, [
          { min: 50, score: 100 },
          { min: 20, score: 75 },
          { min: 0, score: 55 },
        ]);
  const raw = clamp(propertyScore * 0.5 + institutionScore * 0.3 + countryScore * 0.2);
  return {
    code: 'concentration_risk',
    label: 'Concentration & Exposure Risk',
    rawScore: raw,
    weight,
    weightedContribution: 0,
    statusBand: bandFor(raw, bands).band,
    dataCompleteness: 100,
    treatment: 'scored',
    explanation: `Property makes up ${((d.propertyConcentration ?? 0) * 100).toFixed(0)}% of your asset base.`,
    currentValue: {
      propertyConcentration: d.propertyConcentration,
      institutionConcentration: d.institutionConcentration,
      countryConcentration,
    },
    benchmarkValue: { targetPropertyConcentration: 0.5 },
  };
}

// ---------------------------------------------------------------------------
// Risk register
// ---------------------------------------------------------------------------
function buildRiskRegister(input: ResilienceInput, accessible: number): ResilienceRisk[] {
  const d = input.dashboard;
  const risks: ResilienceRisk[] = [];
  const weeks = input.config.riskOverride.criticalLiquidityWeeks;

  if (d.hasExpenses && d.coreSurvivalMonthlyExpenses > 0) {
    const weeklyCoreSurvival = (d.coreSurvivalMonthlyExpenses * 12) / 52;
    const weeksCovered = weeklyCoreSurvival > 0 ? accessible / weeklyCoreSurvival : Infinity;
    if (weeksCovered < weeks) {
      risks.push({
        code: 'critical_liquidity',
        category: 'liquidity',
        severity: 'critical',
        title: 'Critical liquidity shortfall',
        explanation: `Accessible cash covers only ${weeksCovered.toFixed(1)} weeks of core survival expenses.`,
        metricValue: weeksCovered,
        thresholdValue: weeks,
      });
    }
  }

  if (d.hasExpenses && d.essentialMonthlyExpenses > 0) {
    const essentialMonths = accessible / d.essentialMonthlyExpenses;
    if (essentialMonths < 3) {
      risks.push({
        code: 'low_emergency_fund',
        category: 'liquidity',
        severity: essentialMonths < 1 ? 'critical' : 'high',
        title: 'Emergency fund below recommended minimum',
        explanation: `Accessible cash covers ${essentialMonths.toFixed(1)} months of essential expenses, below the 3-month minimum.`,
        metricValue: essentialMonths,
        thresholdValue: 3,
      });
    }
  }

  const fallbackShare = d.largestIncomeSharePct ?? (d.incomeSourceCount <= 1 ? 1 : 0.5);
  const concentration = d.employerConcentration ?? fallbackShare ** 2;
  if (d.hasIncome && concentration > 0.7) {
    risks.push({
      code: 'income_concentration',
      category: 'income',
      severity: concentration > 0.85 ? 'high' : 'medium',
      title: 'High income concentration',
      explanation: 'A single income source or employer accounts for most household income.',
      metricValue: concentration,
      thresholdValue: 0.7,
    });
  }

  if (d.hasInsurance || input.dependantsCount > 0) {
    const facts = computeInsuranceAdequacy(d, input.dependantsCount);
    if (input.dependantsCount > 0 && !facts.hasLife) {
      risks.push({
        code: 'no_life_insurance',
        category: 'insurance',
        severity: 'high',
        title: 'No life insurance with dependants',
        explanation: 'You have dependants but no life insurance cover recorded.',
        metricValue: 0,
        thresholdValue: null,
      });
    }
    if (!facts.hasIncomeProtection) {
      risks.push({
        code: 'no_income_protection',
        category: 'insurance',
        severity: 'medium',
        title: 'No income protection cover',
        explanation: 'No income protection policy recorded — a prolonged illness or injury would remove income entirely.',
        metricValue: 0,
        thresholdValue: null,
      });
    }
  }

  if (d.variableRateDebtRatio !== null && d.variableRateDebtRatio > 0.7) {
    risks.push({
      code: 'variable_rate_exposure',
      category: 'debt',
      severity: 'medium',
      title: 'High variable-rate debt exposure',
      explanation: `${(d.variableRateDebtRatio * 100).toFixed(0)}% of rate-tracked debt is on variable rates, exposed to rate rises.`,
      metricValue: d.variableRateDebtRatio,
      thresholdValue: 0.7,
    });
  }

  if (d.totalLiabilities > 0) {
    const resetRatio = d.upcomingRateResetBalance12m / d.totalLiabilities;
    if (resetRatio > 0.3) {
      risks.push({
        code: 'refinancing_exposure',
        category: 'debt',
        severity: resetRatio > 0.6 ? 'high' : 'medium',
        title: 'Refinancing exposure within 12 months',
        explanation: `${(resetRatio * 100).toFixed(0)}% of your debt balance is on a fixed rate expiring within 12 months.`,
        metricValue: resetRatio,
        thresholdValue: 0.3,
      });
    }
  }

  if (d.creditUtilization !== null && d.creditUtilization > 0.5) {
    risks.push({
      code: 'high_credit_utilization',
      category: 'debt',
      severity: d.creditUtilization > 0.8 ? 'high' : 'medium',
      title: 'High credit utilization',
      explanation: `Credit card balances are at ${(d.creditUtilization * 100).toFixed(0)}% of available limits.`,
      metricValue: d.creditUtilization,
      thresholdValue: 0.5,
    });
  }

  if (d.propertyConcentration !== null && d.propertyConcentration > 0.6) {
    risks.push({
      code: 'property_concentration',
      category: 'concentration',
      severity: d.propertyConcentration > 0.8 ? 'high' : 'medium',
      title: 'High property concentration',
      explanation: `Property makes up ${(d.propertyConcentration * 100).toFixed(0)}% of your asset base.`,
      metricValue: d.propertyConcentration,
      thresholdValue: 0.6,
    });
  }

  return risks;
}

// ---------------------------------------------------------------------------
// Focus actions
// ---------------------------------------------------------------------------
const ACTION_LIBRARY: Record<ResilienceComponentCode, { code: string; title: string; relatedModule: string }> = {
  emergency_fund: { code: 'build_emergency_fund', title: 'Build your emergency fund', relatedModule: 'assets' },
  liquidity: { code: 'improve_liquidity', title: 'Improve short-term liquidity', relatedModule: 'assets' },
  income_resilience: { code: 'diversify_income', title: 'Review your income-interruption readiness', relatedModule: 'income' },
  insurance_protection: { code: 'review_insurance', title: 'Review your insurance cover', relatedModule: 'insurance' },
  debt_pressure: { code: 'reduce_debt_pressure', title: 'Reduce debt and commitment pressure', relatedModule: 'liabilities' },
  concentration_risk: { code: 'diversify_exposure', title: 'Reduce concentration risk', relatedModule: 'investments' },
};

function buildActions(components: ResilienceComponentResult[]): ResilienceAction[] {
  return components
    .filter((c) => c.treatment === 'scored' && c.rawScore !== null && c.rawScore < 80)
    .sort((a, b) => (a.rawScore ?? 0) - (b.rawScore ?? 0))
    .slice(0, 5)
    .map((c) => {
      const lib = ACTION_LIBRARY[c.code];
      return {
        code: lib.code,
        title: lib.title,
        explanation: c.explanation,
        priority: (c.rawScore ?? 0) < 40 ? 'high' : (c.rawScore ?? 0) < 65 ? 'medium' : 'low',
        relatedModule: lib.relatedModule,
        relatedMetric: c.code,
      } satisfies ResilienceAction;
    });
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
export function computeResilience(input: ResilienceInput): ResilienceResult {
  const bands = input.config.scoreBands;

  const { result: emergencyFund, accessible, committed90d } = scoreEmergencyFund(input, bands);
  const liquidity = scoreLiquidity(input, bands, accessible);
  const incomeResilience = scoreIncomeResilience(input, bands);
  const insuranceProtection = scoreInsuranceProtection(input, bands);
  const debtPressure = scoreDebtPressure(input, bands);
  const concentrationRisk = scoreConcentrationRisk(input, bands);

  const components = [emergencyFund, liquidity, incomeResilience, insuranceProtection, debtPressure, concentrationRisk];

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

  const d = input.dashboard;
  const cw = input.config.confidenceWeights;
  const incomeCompleteness = d.hasIncome ? 100 : 0;
  const expenseCompleteness = d.hasExpenses ? 100 : 0;
  const liquidAssetCompleteness = d.hasAssets ? 100 : 0;
  const liabilityCompleteness = d.hasLiabilities ? 100 : d.hasIncome && d.hasExpenses ? 60 : 0;
  const insuranceCompleteness = d.hasInsurance ? 100 : input.dependantsCount === 0 ? 60 : 0;
  const dataRecency = input.isCurrentSnapshotRecent ? 100 : 70;
  const verificationHistory = input.hasPriorMonthHistory ? 100 : 40;
  const confidence = clamp(
    incomeCompleteness * cw.incomeCompleteness +
      expenseCompleteness * cw.expenseCompleteness +
      liquidAssetCompleteness * cw.liquidAssetCompleteness +
      liabilityCompleteness * cw.liabilityCompleteness +
      insuranceCompleteness * cw.insuranceCompleteness +
      dataRecency * cw.dataRecency +
      verificationHistory * cw.verificationHistory
  );

  const risks = buildRiskRegister(input, accessible);
  const criticalLiquidity = risks.some((r) => r.code === 'critical_liquidity');
  const protectionWarning = risks.some((r) => r.code === 'no_life_insurance');

  const { scoreCapPrimary, scoreCapSecondary } = input.config.riskOverride;
  let riskOverrideApplied = false;
  let riskOverrideReason: string | null = null;
  if (criticalLiquidity && overallScore > scoreCapPrimary) {
    overallScore = scoreCapPrimary;
    riskOverrideApplied = true;
    riskOverrideReason = 'A critical liquidity shortfall caps the score until accessible cash reserves improve.';
  } else if (protectionWarning && overallScore > scoreCapSecondary) {
    overallScore = scoreCapSecondary;
    riskOverrideApplied = true;
    riskOverrideReason = 'Having dependants with no life insurance caps the score until cover is reviewed.';
  }

  const roundedScore = Math.round(overallScore);
  const { band, label } = bandFor(roundedScore, bands);
  const actions = buildActions(components);

  return {
    overallScore,
    roundedScore,
    statusBand: band,
    statusLabel: label,
    confidence,
    riskOverrideApplied,
    riskOverrideReason,
    components,
    risks,
    actions,
    accessibleLiquidResources: accessible,
    committedCash90d: committed90d,
    modelVersion: MODEL_VERSION,
  };
}
