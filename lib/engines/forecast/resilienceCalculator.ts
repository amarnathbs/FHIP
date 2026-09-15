// Phase 7 — Financial Resilience Forecast (spec section 14). Projects how
// financial security develops over time, optionally starting from a shocked
// state. The 8 stress scenarios themselves are NOT reimplemented here — the
// service layer reuses lib/engines/resilienceStress.ts's applyStressScenario
// (Module 6, already tested) to produce the shocked opening state and
// surplus; this calculator's job is purely the forward monthly trajectory
// and the forecasting-specific outputs spec 14.3 asks for that Module 6's
// point-in-time before/after snapshot doesn't compute: emergency-fund
// depletion date, recovery period, and net worth/retirement impact over time.
import { buildExplanation } from './explain';
import { addMonthsToDateString, firstOfMonth, projectInvestmentMonth, projectLoanMonth, round2 } from './monthlyPrimitives';
import { getAssumptionValue } from './assumptions';
import { bandFor, type ScoreBand } from '../scoring';
import type { ForecastExplanationRow, ForecastResultRow, ResolvedAssumptionSet } from './types';
import { formatMoneyNarrative } from '../money';

export interface ResilienceCalculatorInput {
  baselineDate: string;
  months: number;
  assumptions: ResolvedAssumptionSet;
  currency: string;
  openingLiquidAssets: number;
  openingOtherAssets: number;
  openingInvestments: number;
  openingRetirement: number;
  openingLiabilities: number;
  // App Review 2026-09-15, item 8 — the household's own balance-weighted
  // liability rate. Same defect and same fix as netWorthCalculator's: the
  // 'liability_interest_rate' assumption is seeded nowhere (zero rows in
  // forecast_global_assumptions on DEV, verified live; no migration mentions
  // the key), so this section always amortised every loan at the hard-coded
  // default while the Debt section used the user's real per-loan rates.
  // Optional and nullable: null means no rate is recorded on any liability.
  liabilityRatePercent?: number | null;
  monthlyEssentialExpenses: number;
  baselineMonthlySurplus: number; // pre-shock, or same as shocked if scenario === 'none'
  shockedMonthlySurplus: number;
  shockDurationMonths: number | null; // null = no time limit (permanent shock, or no shock at all)
  scenarioLabel: string;
  monthlyLoanRepayment: number;
  baselineNetWorthAtStart: number; // for reporting the shock's immediate net worth impact
  baselineRetirementAtStart: number;
}

const DEFAULT_CASH_RETURN = 3.5;
const DEFAULT_ASSET_GROWTH = 3;
const DEFAULT_INVESTMENT_RETURN = 7;
const DEFAULT_RETIREMENT_RETURN = 6.5;
const DEFAULT_LIABILITY_RATE = 6;
const RECOVERY_EMERGENCY_FUND_MONTHS_THRESHOLD = 6;

// FHIP-FC-RES-002 — Resilience Health status band, distinct from
// resilience.ts's own overall-score bands (highly_resilient/resilient/
// moderately_vulnerable/vulnerable/fragile, which band a 0-100 weighted
// score, not months of runway). "Critical" isn't a min-months tier here —
// it's whenever the forecast actually projects the balance hitting zero
// (see below), months-of-runway only distinguishes Strong/Moderate/Weak for
// households that never deplete within the horizon.
const RESILIENCE_HEALTH_BANDS: ScoreBand[] = [
  { min: 6, band: 'strong', label: 'Strong' },
  { min: 3, band: 'moderate', label: 'Moderate' },
  { min: 0, band: 'weak', label: 'Weak' },
];

export function runResilienceForecast(input: ResilienceCalculatorInput): { results: ForecastResultRow[]; explanations: ForecastExplanationRow[] } {
  const results: ForecastResultRow[] = [];
  const explanations: ForecastExplanationRow[] = [];
  const baseline = firstOfMonth(input.baselineDate);

  const cashReturn = getAssumptionValue(input.assumptions, 'cash', DEFAULT_CASH_RETURN);
  const assetGrowth = getAssumptionValue(input.assumptions, 'property_growth', DEFAULT_ASSET_GROWTH);
  const investmentReturn = getAssumptionValue(input.assumptions, 'equity', DEFAULT_INVESTMENT_RETURN);
  const retirementReturn = getAssumptionValue(input.assumptions, 'retirement', DEFAULT_RETIREMENT_RETURN);
  // App Review 2026-09-15, item 8 — the user's own recorded rate wins; the
  // never-seeded assumption below it survives only for a household that has
  // recorded no liability rate at all.
  const liabilityRate =
    input.liabilityRatePercent !== null && input.liabilityRatePercent !== undefined
      ? input.liabilityRatePercent
      : getAssumptionValue(input.assumptions, 'liability_interest_rate', DEFAULT_LIABILITY_RATE);

  let liquidAssets = input.openingLiquidAssets;
  let otherAssets = input.openingOtherAssets;
  let investments = input.openingInvestments;
  let retirement = input.openingRetirement;
  let liabilities = input.openingLiabilities;

  let depletionMonth: number | null = liquidAssets <= 0 ? 0 : null;
  let recoveryMonth: number | null = null;

  for (let m = 1; m <= input.months; m++) {
    const periodDate = addMonthsToDateString(baseline, m);
    const shockActive = input.shockDurationMonths === null || m <= input.shockDurationMonths;
    const currentSurplus = shockActive ? input.shockedMonthlySurplus : input.baselineMonthlySurplus;

    const liquidMonth = projectInvestmentMonth({
      openingValue: liquidAssets,
      contributions: currentSurplus >= 0 ? currentSurplus : 0,
      withdrawals: currentSurplus < 0 ? -currentSurplus : 0,
      annualReturnPercent: cashReturn,
    });
    const otherAssetMonth = projectInvestmentMonth({ openingValue: otherAssets, contributions: 0, withdrawals: 0, annualReturnPercent: assetGrowth });
    const investmentMonth = projectInvestmentMonth({ openingValue: investments, contributions: 0, withdrawals: 0, annualReturnPercent: investmentReturn });
    const retirementMonth = projectInvestmentMonth({ openingValue: retirement, contributions: 0, withdrawals: 0, annualReturnPercent: retirementReturn });
    const liabilityMonth = projectLoanMonth({
      openingBalance: liabilities,
      annualInterestRatePercent: liabilityRate,
      repayment: Math.min(input.monthlyLoanRepayment, liabilities + (liabilities * liabilityRate) / 100 / 12),
    });

    liquidAssets = liquidMonth.closingValue;
    otherAssets = otherAssetMonth.closingValue;
    investments = investmentMonth.closingValue;
    retirement = retirementMonth.closingValue;
    liabilities = liabilityMonth.closingBalance;

    if (depletionMonth === null && liquidAssets <= 0) depletionMonth = m;
    if (depletionMonth !== null && recoveryMonth === null && !shockActive && liquidAssets > 0) {
      const emergencyFundMonths = input.monthlyEssentialExpenses > 0 ? liquidAssets / input.monthlyEssentialExpenses : null;
      if (currentSurplus >= 0 && (emergencyFundMonths === null || emergencyFundMonths >= RECOVERY_EMERGENCY_FUND_MONTHS_THRESHOLD)) {
        recoveryMonth = m;
      }
    }

    const netWorth = round2(liquidAssets + otherAssets + investments + retirement - liabilities);
    const emergencyFundMonths = input.monthlyEssentialExpenses > 0 ? round2(liquidAssets / input.monthlyEssentialExpenses) : null;

    results.push({
      forecastType: 'resilience',
      entityType: 'resilience_portfolio',
      entityId: null,
      periodDate,
      periodNumber: m,
      openingValue: round2(liquidMonth.openingValue + otherAssetMonth.openingValue + investmentMonth.openingValue + retirementMonth.openingValue - liabilityMonth.openingBalance),
      contributions: round2(Math.max(0, currentSurplus)),
      withdrawals: round2(Math.max(0, -currentSurplus)),
      income: 0,
      expenses: input.monthlyEssentialExpenses,
      // App Review 2026-09-15, item 8 requirement 4 (verification extended to
      // the other forecast sections) — CONFIRMED SIGN DEFECT, fixed here.
      //
      // These per-period movement columns are supposed to decompose the change
      // in the headline value: closing = opening + contributions +
      // investmentReturn + interest + otherMovement. The liability leg's
      // contribution to NET WORTH is -(L_m - L_(m-1)) = +principalReduction,
      // and principalReduction = repayment - interest. Recording BOTH
      // `-interest` AND `-principalReduction` summed to `-repayment` instead,
      // so the movement columns missed closingValue by (2 x repayment -
      // interest) every single period -- 1,500/month on a 100,000 balance at
      // 6% with a 1,000 repayment.
      //
      // The reconciling decomposition is `-interest` (net worth is reduced by
      // the interest accrued) plus `+repayment` (cash moved into the debt),
      // which sums to exactly +principalReduction. closingValue itself was
      // always correct; only these two columns were wrong. No UI reads them
      // today (the only consumer is the forecast_results write in
      // lib/services/forecastData.ts), so this corrects stored data before
      // anything is built on it.
      interest: -liabilityMonth.interest,
      investmentReturn: round2(otherAssetMonth.investmentReturn + investmentMonth.investmentReturn + retirementMonth.investmentReturn + liquidMonth.investmentReturn),
      fees: 0,
      fxGainLoss: 0,
      otherMovement: round2(liabilityMonth.repayment),
      closingValue: netWorth,
      targetValue: null,
      varianceValue: null,
      variancePercentage: null,
      currency: input.currency,
      baseCurrencyValue: null,
      metadata: {
        liquidAssets: round2(liquidAssets),
        emergencyFundMonths,
        retirementBalance: round2(retirement),
        shockActive,
        currentMonthlySurplus: round2(currentSurplus),
      },
    });
  }

  const netWorthImpact = round2(
    input.openingLiquidAssets + input.openingOtherAssets + input.openingInvestments + input.openingRetirement - input.openingLiabilities - input.baselineNetWorthAtStart
  );
  const retirementImpact = round2(input.openingRetirement - input.baselineRetirementAtStart);

  const openingEmergencyFundMonths = input.monthlyEssentialExpenses > 0 ? input.openingLiquidAssets / input.monthlyEssentialExpenses : null;
  const resilienceHealth =
    depletionMonth !== null
      ? { band: 'critical', label: 'Critical' }
      : openingEmergencyFundMonths !== null
        ? bandFor(openingEmergencyFundMonths, RESILIENCE_HEALTH_BANDS)
        : { band: 'unknown', label: 'Not available' };

  const narrativeParts: string[] = [`Scenario: ${input.scenarioLabel}.`, `Resilience Health: ${resilienceHealth.label}.`];
  if (netWorthImpact !== 0) {
    // App Review 2026-09-15 G1/item 7 — shared whole-unit formatter instead of
    // a raw toLocaleString() float in user-facing narrative text.
    narrativeParts.push(`Immediate net worth impact from the shock: ${netWorthImpact >= 0 ? '' : '-'}${formatMoneyNarrative(Math.abs(netWorthImpact), input.currency)}.`);
  }
  if (retirementImpact !== 0) {
    narrativeParts.push(`Retirement balance impact: ${retirementImpact >= 0 ? '' : '-'}${formatMoneyNarrative(Math.abs(retirementImpact), input.currency)}.`);
  }
  narrativeParts.push(
    depletionMonth === null
      ? 'Liquid reserves are not projected to be depleted within the forecast horizon.'
      : depletionMonth === 0
        ? 'Liquid reserves are already depleted at the shock\'s starting point.'
        : `Liquid reserves are projected to be depleted by month ${depletionMonth}.`
  );
  if (input.shockDurationMonths !== null) {
    narrativeParts.push(
      recoveryMonth === null
        ? `After the ${input.shockDurationMonths}-month shock ends, recovery to a healthy ${RECOVERY_EMERGENCY_FUND_MONTHS_THRESHOLD}-month emergency fund is not projected within the forecast horizon.`
        : `Recovery to a healthy ${RECOVERY_EMERGENCY_FUND_MONTHS_THRESHOLD}-month emergency fund and positive cash flow is projected by month ${recoveryMonth}, ${recoveryMonth - input.shockDurationMonths} months after the shock ends.`
    );
  }

  explanations.push(
    buildExplanation({
      entityType: 'resilience_portfolio',
      entityId: null,
      explanationType: 'resilience_forecast',
      title: 'Financial resilience forecast',
      narrative: narrativeParts.join(' '),
      inputs: {
        scenarioLabel: input.scenarioLabel,
        shockDurationMonths: input.shockDurationMonths,
        baselineMonthlySurplus: input.baselineMonthlySurplus,
        shockedMonthlySurplus: input.shockedMonthlySurplus,
        netWorthImpact,
        retirementImpact,
        depletionMonth,
        recoveryMonth,
        resilienceHealthBand: resilienceHealth.band,
        resilienceHealthLabel: resilienceHealth.label,
      },
      formula:
        'Liquid assets grow/draw by monthly surplus (or shortfall) at the cash return rate; depletion = first month liquid assets <= 0; recovery = first month after the shock ends with positive cash flow and >= 6 months of essential expenses in liquid reserves',
      priority: 10,
    })
  );

  return { results, explanations };
}
