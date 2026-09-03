import type { DashboardSummary } from './dashboard';

export type ScenarioType =
  | 'increase_savings'
  | 'pay_off_debt'
  | 'build_emergency_fund'
  | 'reduce_lifestyle_expenses'
  | 'lose_income';

export const SCENARIO_LABELS: Record<ScenarioType, string> = {
  increase_savings: 'Save an additional $500/month',
  pay_off_debt: 'Pay off $10,000 of debt',
  build_emergency_fund: 'Add 3 months of emergency savings',
  reduce_lifestyle_expenses: 'Reduce discretionary expenses by 10%',
  lose_income: 'Lose your largest income source',
};

// Re-derive the cash-flow fields that depend on income/expenses/debt after a
// scenario mutates one of them, so the health score engine sees a
// self-consistent (if hypothetical) picture rather than stale ratios.
export function recomputeDerived(d: DashboardSummary): void {
  const income = d.netMonthlyIncome || d.grossMonthlyIncome;
  d.totalMonthlyExpenses = d.essentialMonthlyExpenses + d.lifestyleMonthlyExpenses;
  d.monthlySurplus = income - d.totalMonthlyExpenses - d.debtMonthlyRepayments;
  d.savingsRate = income > 0 ? d.monthlySurplus / income : null;
  d.operatingCashFlow = income - d.essentialMonthlyExpenses;
  d.disposableIncome = d.operatingCashFlow - d.debtMonthlyRepayments;
  const totalOutflow = d.totalMonthlyExpenses + d.debtMonthlyRepayments;
  d.cashFlowRatio = totalOutflow > 0 ? d.monthlySurplus / totalOutflow : null;
  d.emergencyFundMonths = d.essentialMonthlyExpenses > 0 ? d.liquidAssets / d.essentialMonthlyExpenses : null;
  // Net income, not gross — matches dashboard.ts's own debtServiceRatio definition.
  d.debtServiceRatio = income > 0 ? d.debtMonthlyRepayments / income : null;
  const annualGrossIncome = d.grossMonthlyIncome * 12;
  // LR-FI-2 §1: household balance over household income, matching
  // dashboard.ts's own debtToIncome definition. Re-deriving this from the
  // unfiltered d.totalLiabilities (as it did before) would have silently
  // restored the pre-fix, mixed-entity ratio on top of every What-If result.
  d.debtToIncome = annualGrossIncome > 0 ? d.householdLiabilityBalance / annualGrossIncome : null;
  d.totalAssetsCombined = d.totalAssets + d.totalInvestments + d.totalRetirement;
  d.netWorth = d.totalAssetsCombined - d.totalLiabilities;
}

export function applyScenario(base: DashboardSummary, type: ScenarioType): DashboardSummary {
  const d: DashboardSummary = JSON.parse(JSON.stringify(base));
  switch (type) {
    case 'increase_savings': {
      // Modelled as freeing up $500/month of lifestyle spend into savings.
      const extra = Math.min(500, d.lifestyleMonthlyExpenses);
      d.lifestyleMonthlyExpenses -= extra;
      break;
    }
    case 'pay_off_debt': {
      const payoff = Math.min(10000, d.totalLiabilities);
      const proportion = d.totalLiabilities > 0 ? payoff / d.totalLiabilities : 0;
      d.totalLiabilities -= payoff;
      d.badDebt = Math.max(0, d.badDebt - d.badDebt * proportion);
      // LR-FI-2 §1: "Pay off $10,000 of debt" is a HOUSEHOLD action, so the
      // household's own balance and repayment must move by the household's
      // own proportion. Scaling the (household-only, post-LR-FI-1)
      // debtMonthlyRepayments by a proportion derived from the unfiltered
      // total understated the scenario's DSR benefit for SMSF households —
      // e.g. $10,000 off a $400,000 personal mortgage is 2.5% of the
      // repayment, not the 1.3% implied by a $765,000 total. Byte-identical
      // for any household with no SMSF rows, where the two bases are equal.
      const householdPayoff = Math.min(payoff, d.householdLiabilityBalance);
      const householdProportion = d.householdLiabilityBalance > 0 ? householdPayoff / d.householdLiabilityBalance : 0;
      d.householdLiabilityBalance -= householdPayoff;
      d.debtMonthlyRepayments -= d.debtMonthlyRepayments * householdProportion;
      d.totalLiabilityMonthlyRepayments -= d.totalLiabilityMonthlyRepayments * proportion;
      break;
    }
    case 'build_emergency_fund': {
      d.liquidAssets += d.essentialMonthlyExpenses * 3;
      d.totalAssets += d.essentialMonthlyExpenses * 3;
      break;
    }
    case 'reduce_lifestyle_expenses': {
      d.lifestyleMonthlyExpenses *= 0.9;
      break;
    }
    case 'lose_income': {
      const share = d.largestIncomeSharePct ?? (d.incomeSourceCount <= 1 ? 1 : 0.5);
      d.grossMonthlyIncome *= 1 - share;
      d.netMonthlyIncome *= 1 - share;
      d.incomeSourceCount = Math.max(0, d.incomeSourceCount - 1);
      d.largestIncomeSharePct = null;
      break;
    }
  }
  recomputeDerived(d);
  return d;
}
