// Phase 6 — Cross-Border Forecasting (spec section 12). Scope matches this
// app's two supported currencies exactly: an AUD-base user's INR-denominated
// holdings, or an INR-base user's AUD-denominated holdings (spec 12.1's
// worked examples are literally "Australian investor with INR assets" /
// "Indian investor with AUD assets"). Net foreign wealth is projected in
// local currency using the same monthly primitives every other calculator
// uses, then converted to the reporting currency via a single stored,
// documented FX convention (spec 12.4) with an assumption-driven drift.
//
// FX convention (must match 0016_module10_forecasting_fx_seed.sql and be
// shown to the user, per spec 12.4): fx_rate_aud_inr = INR per 1 AUD.
//   AUD value = INR value / fx_rate_aud_inr
//   INR value = AUD value * fx_rate_aud_inr
import { buildExplanation } from './explain';
import { addMonthsToDateString, firstOfMonth, monthlyCompoundRate, projectInvestmentMonth, projectLoanMonth, round2 } from './monthlyPrimitives';
import { getAssumptionValue } from './assumptions';
import type { ForecastExplanationRow, ForecastResultRow, ResolvedAssumptionSet } from './types';

export interface CrossBorderCalculatorInput {
  baselineDate: string;
  months: number;
  assumptions: ResolvedAssumptionSet;
  reportingCurrency: 'AUD' | 'INR';
  foreignCurrency: 'AUD' | 'INR';
  openingForeignAssets: number; // all amounts in foreignCurrency (local)
  openingForeignInvestments: number;
  openingForeignRetirement: number;
  openingForeignLiabilities: number;
  monthlyForeignAssetContribution: number;
  monthlyForeignInvestmentContribution: number;
  monthlyForeignRetirementContribution: number;
  monthlyForeignLoanRepayment: number;
}

const DEFAULT_ASSET_GROWTH = 3;
const DEFAULT_INVESTMENT_RETURN = 7;
const DEFAULT_RETIREMENT_RETURN = 6.5;
const DEFAULT_LIABILITY_RATE = 6;
const DEFAULT_FX_RATE_AUD_INR = 56;

function convertToReporting(localAmount: number, foreignCurrency: 'AUD' | 'INR', fxRateAudInr: number): number {
  // foreignCurrency is whichever isn't the reporting currency, so exactly
  // one of these two directions applies for a given forecast run.
  return foreignCurrency === 'INR' ? localAmount / fxRateAudInr : localAmount * fxRateAudInr;
}

export function runCrossBorderForecast(input: CrossBorderCalculatorInput): { results: ForecastResultRow[]; explanations: ForecastExplanationRow[] } {
  const results: ForecastResultRow[] = [];
  const explanations: ForecastExplanationRow[] = [];
  const baseline = firstOfMonth(input.baselineDate);

  const assetGrowth = getAssumptionValue(input.assumptions, 'property_growth', DEFAULT_ASSET_GROWTH);
  const investmentReturn = getAssumptionValue(input.assumptions, 'equity', DEFAULT_INVESTMENT_RETURN);
  const retirementReturn = getAssumptionValue(input.assumptions, 'retirement', DEFAULT_RETIREMENT_RETURN);
  const liabilityRate = getAssumptionValue(input.assumptions, 'liability_interest_rate', DEFAULT_LIABILITY_RATE);
  const baseFxRate = getAssumptionValue(input.assumptions, 'fx_rate_aud_inr', DEFAULT_FX_RATE_AUD_INR);
  const fxDriftAnnualPercent = getAssumptionValue(input.assumptions, 'fx_drift_aud_inr', 0);
  const monthlyFxDrift = monthlyCompoundRate(fxDriftAnnualPercent);

  let assets = input.openingForeignAssets;
  let investments = input.openingForeignInvestments;
  let retirement = input.openingForeignRetirement;
  let liabilities = input.openingForeignLiabilities;
  let fxRate = baseFxRate;
  const netForeignWealthLocalPrev = assets + investments + retirement - liabilities;
  let reportingValuePrev = convertToReporting(netForeignWealthLocalPrev, input.foreignCurrency, fxRate);

  for (let m = 1; m <= input.months; m++) {
    const periodDate = addMonthsToDateString(baseline, m);
    const fxRatePrevMonth = fxRate;
    fxRate = baseFxRate * Math.pow(1 + monthlyFxDrift, m);

    const assetMonth = projectInvestmentMonth({ openingValue: assets, contributions: input.monthlyForeignAssetContribution, withdrawals: 0, annualReturnPercent: assetGrowth });
    const investmentMonth = projectInvestmentMonth({ openingValue: investments, contributions: input.monthlyForeignInvestmentContribution, withdrawals: 0, annualReturnPercent: investmentReturn });
    const retirementMonth = projectInvestmentMonth({ openingValue: retirement, contributions: input.monthlyForeignRetirementContribution, withdrawals: 0, annualReturnPercent: retirementReturn });
    const liabilityMonth = projectLoanMonth({
      openingBalance: liabilities,
      annualInterestRatePercent: liabilityRate,
      repayment: Math.min(input.monthlyForeignLoanRepayment, liabilities + (liabilities * liabilityRate) / 100 / 12),
    });

    assets = assetMonth.closingValue;
    investments = investmentMonth.closingValue;
    retirement = retirementMonth.closingValue;
    liabilities = liabilityMonth.closingBalance;

    const netForeignWealthLocal = round2(assets + investments + retirement - liabilities);

    // Return attribution (spec 12.5): hold FX at last month's rate to
    // isolate the local-currency return, then apply this month's actual
    // rate to isolate the pure currency movement.
    const closingAtPrevFx = convertToReporting(netForeignWealthLocal, input.foreignCurrency, fxRatePrevMonth);
    const closingAtCurrentFx = convertToReporting(netForeignWealthLocal, input.foreignCurrency, fxRate);
    const localReturnInReportingCurrency = round2(closingAtPrevFx - reportingValuePrev);
    const currencyGainLoss = round2(closingAtCurrentFx - closingAtPrevFx);
    const totalReportingReturn = round2(closingAtCurrentFx - reportingValuePrev);

    results.push({
      forecastType: 'cross_border',
      entityType: 'cross_border_portfolio',
      entityId: null,
      periodDate,
      periodNumber: m,
      openingValue: round2(reportingValuePrev),
      contributions: round2(
        convertToReporting(assetMonth.contributions + investmentMonth.contributions + retirementMonth.contributions, input.foreignCurrency, fxRate)
      ),
      withdrawals: 0,
      income: 0,
      expenses: 0,
      interest: round2(-convertToReporting(liabilityMonth.interest, input.foreignCurrency, fxRate)),
      investmentReturn: round2(localReturnInReportingCurrency),
      fees: 0,
      fxGainLoss: currencyGainLoss,
      otherMovement: round2(-convertToReporting(liabilityMonth.principalReduction, input.foreignCurrency, fxRate)),
      closingValue: round2(closingAtCurrentFx),
      targetValue: null,
      varianceValue: null,
      variancePercentage: null,
      currency: input.reportingCurrency,
      baseCurrencyValue: round2(closingAtCurrentFx),
      metadata: {
        netForeignWealthLocal,
        foreignCurrency: input.foreignCurrency,
        fxRate,
        localReturnInReportingCurrency,
        currencyGainLoss,
        totalReportingReturn,
      },
    });

    reportingValuePrev = closingAtCurrentFx;

    if (m === 1 || m % 12 === 0) {
      explanations.push(
        buildExplanation({
          entityType: 'cross_border_portfolio',
          entityId: null,
          explanationType: 'cross_border_projection',
          title: `Cross-border wealth projection — month ${m}`,
          narrative: `Net foreign wealth (assets + investments + retirement - liabilities, in ${input.foreignCurrency}) is projected using the same category return assumptions as domestic holdings, then converted to ${input.reportingCurrency} using the FX rate assumption (${round2(fxRate)} INR per AUD) with ${fxDriftAnnualPercent}%/year assumed drift. This period's ${input.reportingCurrency} movement splits into a local-currency return of ${localReturnInReportingCurrency.toLocaleString()} and a currency gain/loss of ${currencyGainLoss.toLocaleString()} — the same foreign holding can grow in its own currency while its ${input.reportingCurrency} value falls if that currency weakens, or vice versa.`,
          inputs: {
            assetGrowthPercent: assetGrowth,
            investmentReturnPercent: investmentReturn,
            retirementReturnPercent: retirementReturn,
            liabilityRatePercent: liabilityRate,
            fxRateAudInr: round2(fxRate),
            fxDriftAnnualPercent,
            netForeignWealthLocal,
            localReturnInReportingCurrency,
            currencyGainLoss,
            totalReportingReturn,
          },
          formula: 'AUD value = INR value / fx_rate_aud_inr (or INR value = AUD value x fx_rate_aud_inr); Currency gain/loss = value at this month\'s rate - value at last month\'s rate, holding local growth constant',
          priority: m === 1 ? 10 : 0,
        })
      );
    }
  }

  return { results, explanations };
}
