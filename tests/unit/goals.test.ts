import { describe, it, expect } from 'vitest';
import {
  computeCategoryForecast,
  type GoalRecord,
  type GoalExtras,
  type GoalPlanningConfig,
} from '@/lib/engines/goalForecast';
import { computeGoalAffordability } from '@/lib/engines/goalAffordability';
import { evaluateAllocation } from '@/lib/services/goalFundingAllocation';

const GOAL_CONFIG: GoalPlanningConfig = {
  trackStatusThresholds: { aheadMin: 105, onTrackMin: 100, atRiskMin: 90 },
  confidenceWeights: {
    targetAmountCompleteness: 0.15,
    targetDateCertainty: 0.1,
    currentBalanceVerification: 0.15,
    contributionHistory: 0.15,
    linkedCashFlowData: 0.15,
    assumptionReliability: 0.1,
    timeHorizon: 0.1,
    dataRecency: 0.1,
  },
  confidenceBands: [
    { min: 85, band: 'high', label: 'High' },
    { min: 70, band: 'good', label: 'Good' },
    { min: 55, band: 'moderate', label: 'Moderate' },
    { min: 40, band: 'low', label: 'Low' },
    { min: 0, band: 'insufficient', label: 'Insufficient' },
  ],
  affordabilityThresholds: { comfortableMax: 0.6, manageableMax: 0.85, tightMax: 1.0 },
  priorityWeights: {
    userImportance: 0.25,
    dateUrgency: 0.2,
    protectionValue: 0.2,
    mandatoryObligation: 0.15,
    consequenceOfDelay: 0.1,
    fundingGap: 0.05,
    dependency: 0.05,
  },
  scenarioAssumptions: {
    generic: {
      conservative: { returnRate: 0.02, costInflation: 0.035, contributionGrowth: 0.0 },
      base: { returnRate: 0.045, costInflation: 0.025, contributionGrowth: 0.02 },
      optimistic: { returnRate: 0.07, costInflation: 0.015, contributionGrowth: 0.04 },
    },
    emergency_fund: {
      conservative: { returnRate: 0.01, costInflation: 0.035, contributionGrowth: 0.0 },
      base: { returnRate: 0.03, costInflation: 0.025, contributionGrowth: 0.0 },
      optimistic: { returnRate: 0.045, costInflation: 0.015, contributionGrowth: 0.0 },
    },
    home_deposit: {
      conservative: { returnRate: 0.02, costInflation: 0.06, contributionGrowth: 0.0 },
      base: { returnRate: 0.04, costInflation: 0.045, contributionGrowth: 0.02 },
      optimistic: { returnRate: 0.06, costInflation: 0.03, contributionGrowth: 0.04 },
    },
    debt_payoff: {
      conservative: { returnRate: 0.0, costInflation: 0.0, contributionGrowth: 0.0 },
      base: { returnRate: 0.0, costInflation: 0.0, contributionGrowth: 0.02 },
      optimistic: { returnRate: 0.0, costInflation: 0.0, contributionGrowth: 0.05 },
    },
    retirement: {
      conservative: { returnRate: 0.04, costInflation: 0.03, contributionGrowth: 0.0 },
      base: { returnRate: 0.065, costInflation: 0.025, contributionGrowth: 0.03 },
      optimistic: { returnRate: 0.09, costInflation: 0.02, contributionGrowth: 0.05 },
    },
    education: {
      conservative: { returnRate: 0.02, costInflation: 0.07, contributionGrowth: 0.0 },
      base: { returnRate: 0.04, costInflation: 0.05, contributionGrowth: 0.02 },
      optimistic: { returnRate: 0.06, costInflation: 0.035, contributionGrowth: 0.04 },
    },
    cross_border: {
      conservative: { returnRate: 0.01, costInflation: 0.04, contributionGrowth: 0.0 },
      base: { returnRate: 0.03, costInflation: 0.03, contributionGrowth: 0.0 },
      optimistic: { returnRate: 0.045, costInflation: 0.02, contributionGrowth: 0.0 },
    },
    major_purchase: {
      conservative: { returnRate: 0.02, costInflation: 0.045, contributionGrowth: 0.0 },
      base: { returnRate: 0.035, costInflation: 0.03, contributionGrowth: 0.0 },
      optimistic: { returnRate: 0.05, costInflation: 0.02, contributionGrowth: 0.0 },
    },
    business: {
      conservative: { returnRate: 0.02, costInflation: 0.03, contributionGrowth: 0.0 },
      base: { returnRate: 0.04, costInflation: 0.025, contributionGrowth: 0.03 },
      optimistic: { returnRate: 0.07, costInflation: 0.02, contributionGrowth: 0.06 },
    },
  },
  fxAssumptions: {
    AUD_INR: { conservative: 54, base: 57, optimistic: 60 },
    INR_AUD: { conservative: 0.0167, base: 0.0175, optimistic: 0.0185 },
  },
};

function goal(overrides: Partial<GoalRecord>): GoalRecord {
  return {
    targetAmount: 0,
    targetAmountBasis: 'today_value',
    currentAmount: 0,
    targetDate: null,
    plannedContributionAmount: 0,
    annualContributionGrowthPct: 0,
    inflationAdjusted: true,
    inflationCategory: 'general',
    currencyCode: 'AUD',
    countryCode: 'AU',
    forecastLogicKey: 'generic',
    ...overrides,
  };
}

function yearsFromNow(years: number): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() + years);
  return d.toISOString().slice(0, 10);
}

describe('Goal Planning — synthetic personas', () => {
  it('Persona A: Emergency Fund', () => {
    const extras: GoalExtras = { essentialMonthlyExpenses: 6000, targetCoverageMonths: 6 };
    const g = goal({
      forecastLogicKey: 'emergency_fund',
      currentAmount: 18000,
      plannedContributionAmount: 1500,
      inflationAdjusted: false,
    });
    const result = computeCategoryForecast(g, extras, GOAL_CONFIG, 'base', new Date());
    expect(result.targetAmountFuture).toBe(36000);
    expect(result.progressPct).toBeCloseTo(50, 0);
    expect(result.fundingGapAtTargetDate).toBe(18000);
    expect(result.projectedCompletionDate).not.toBeNull();
  });

  it('Persona B: Home Deposit', () => {
    const g = goal({
      forecastLogicKey: 'home_deposit',
      targetAmount: 150000,
      currentAmount: 60000,
      targetDate: yearsFromNow(4),
      plannedContributionAmount: 1500,
      inflationAdjusted: true,
    });
    const result = computeCategoryForecast(g, {}, GOAL_CONFIG, 'base', new Date());
    expect(result.requiredMonthlyContribution).not.toBeNull();
    expect(result.requiredMonthlyContribution!).toBeGreaterThan(1500);
    expect(['at_risk', 'off_track']).toContain(result.trackStatus);
  });

  it('Persona C: Overallocated Household', () => {
    const result = computeGoalAffordability({
      monthlySurplus: 2000,
      totalPlannedGoalContributions: 2700,
      thresholds: GOAL_CONFIG.affordabilityThresholds,
      emergencyFundAtRisk: false,
    });
    expect(result.status).toBe('overallocated');
    expect(result.overallocatedAmount).toBeCloseTo(700, 0);
  });

  it('Persona D: Debt Payoff', () => {
    const extras: GoalExtras = { linkedLiability: { balance: 18000, interestRate: 18, monthlyRepayment: 500 } };
    const g = goal({ forecastLogicKey: 'debt_payoff', targetAmount: 18000, plannedContributionAmount: 600 });
    const result = computeCategoryForecast(g, extras, GOAL_CONFIG, 'base', new Date());
    expect(result.currentMonthlyContribution).toBe(1100);
    expect(result.targetAmountFuture).toBe(18000);
    expect(result.currentAmount).toBe(0); // amount paid off so far on a fresh goal
    expect(result.projectedCompletionDate).not.toBeNull();
  });

  it('Persona E: Education Goal', () => {
    const g = goal({
      forecastLogicKey: 'education',
      targetAmount: 100000,
      currentAmount: 20000,
      targetDate: yearsFromNow(10),
      plannedContributionAmount: 500,
      inflationAdjusted: true,
    });
    const result = computeCategoryForecast(g, {}, GOAL_CONFIG, 'base', new Date());
    expect(result.targetAmountFuture).toBeGreaterThan(100000);
    expect(result.currentValue.costInToday).toBe(100000);
    expect(result.fundingGapAtTargetDate).toBeCloseTo(result.targetAmountFuture - 20000, 0);
  });

  it('Persona F: Cross-Border Family Support', () => {
    const g = goal({
      forecastLogicKey: 'cross_border',
      currencyCode: 'INR',
      countryCode: 'IN',
      targetDate: yearsFromNow(5),
      plannedContributionAmount: 100000 / 3, // quarterly 100,000 INR expressed as a monthly equivalent
    });
    const extras: GoalExtras = { reportingCurrencyCode: 'AUD' };
    const result = computeCategoryForecast(g, extras, GOAL_CONFIG, 'base', new Date());
    expect(result.targetAmountOriginal).toBeCloseTo(2000000, -2);
    expect(result.currentValue.fxRateAssumption).toBe(0.0175);
    expect(result.currentValue.reportingCurrencyEquivalent as number).toBeCloseTo(35000, -1);
  });

  it('Persona H: Same Asset Used Twice is blocked', () => {
    const first = evaluateAllocation(0, 50);
    expect(first.ok).toBe(true);
    const second = evaluateAllocation(50, 60);
    expect(second.ok).toBe(false);
    expect(second.error).toContain('already 50% allocated');
  });

  it('Persona G: Independent assets do not interfere with each other', () => {
    const savingsAllocation = evaluateAllocation(0, 100);
    const termDepositAllocation = evaluateAllocation(0, 100);
    expect(savingsAllocation.ok).toBe(true);
    expect(termDepositAllocation.ok).toBe(true);
  });

  it('Persona I: No Cash-Flow Data', () => {
    const result = computeGoalAffordability({
      monthlySurplus: null,
      totalPlannedGoalContributions: 500,
      thresholds: GOAL_CONFIG.affordabilityThresholds,
      emergencyFundAtRisk: false,
    });
    expect(result.status).toBe('insufficient_data');
  });

  it('Persona J: Achieved Goal (overfunded)', () => {
    const g = goal({ forecastLogicKey: 'generic', targetAmount: 20000, currentAmount: 21500, inflationAdjusted: false });
    const result = computeCategoryForecast(g, {}, GOAL_CONFIG, 'base', new Date());
    expect(result.trackStatus).toBe('fully_funded');
    expect(result.progressPct).toBeCloseTo(107.5, 1);
    expect(result.fundingGapAtTargetDate).toBe(0);
  });

  it('Persona K: Retired Household — retirement forecast has no employment-income dependency', () => {
    const g = goal({
      forecastLogicKey: 'retirement',
      targetAmount: 800000,
      currentAmount: 750000,
      targetDate: yearsFromNow(2),
      plannedContributionAmount: 0,
    });
    expect(() => computeCategoryForecast(g, {}, GOAL_CONFIG, 'base', new Date())).not.toThrow();
    const result = computeCategoryForecast(g, {}, GOAL_CONFIG, 'base', new Date());
    expect(result.trackStatus).not.toBe('unable_to_assess');
  });

  it('Persona L: Flexible Lifestyle Goal', () => {
    const g = goal({
      forecastLogicKey: 'major_purchase',
      targetAmount: 15000,
      currentAmount: 3000,
      targetDate: yearsFromNow(2),
      plannedContributionAmount: 250,
    });
    const result = computeCategoryForecast(g, {}, GOAL_CONFIG, 'base', new Date());
    expect(result.requiredMonthlyContribution).not.toBeNull();
    expect(result.trackStatus).not.toBe('unable_to_assess');
  });
});
