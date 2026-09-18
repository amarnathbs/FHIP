// Phase 1 proof-of-pipeline calculator. Full per-asset-class/per-liability
// net worth forecasting with variance tracking is Phase 5 of the roadmap
// (Net Worth + Variance) — this calculator gives the Phase 1 engine plumbing
// (forecast_runs/forecast_results/forecast_explanations end-to-end) something
// real to compute now: a single blended-rate net worth trajectory, per spec
// section 13.6's "Forecast Net Worth = Forecast Total Assets (includes
// investments and retirement) - Forecast Total Liabilities".
import { buildExplanation } from './explain';
import { projectInvestmentMonth, projectLoanMonth, firstOfMonth, addMonthsToDateString, round2 } from './monthlyPrimitives';
import type { ForecastExplanationRow, ForecastResultRow, ResolvedAssumptionSet } from './types';
import { getAssumptionValue } from './assumptions';
import { formatMoneyNarrative } from '../money';

// A one-off future inflow (positive amount, e.g. inheritance, bonus, asset
// sale) or outflow (negative amount, e.g. planned purchase) applied to the
// general-assets bucket in the given forecast month. Spec section 13.5 lists
// "future major purchases" and one-off inflows/outflows as required net
// worth forecast inputs.
export interface PlannedFinancialEvent {
  monthIndex: number; // 1-based, matches ForecastResultRow.periodNumber
  amount: number;
  description: string;
}

export interface NetWorthCalculatorInput {
  baselineDate: string; // YYYY-MM-DD
  months: number;
  currency: string;
  openingAssets: number; // non-investment, non-retirement assets (cash, property, etc)
  openingInvestments: number;
  openingRetirement: number;
  openingLiabilities: number;
  monthlyAssetContribution: number; // e.g. surplus swept into savings/assets
  monthlyInvestmentContribution: number;
  monthlyRetirementContribution: number;
  monthlyLoanRepayment: number;
  assumptions: ResolvedAssumptionSet;
  plannedEvents?: PlannedFinancialEvent[];
  // App Review 2026-09-15, item 8 requirement 2 ("confirm the interest rate
  // source for each loan is the user-entered rate, not a default") — extended
  // to the other forecast sections as requirement 4 asks.
  //
  // The Debt section reads the real per-loan liabilities.interest_rate. This
  // section did not: it resolved a 'liability_interest_rate' assumption that
  // is seeded NOWHERE (zero rows in forecast_global_assumptions on DEV,
  // verified live 2026-09-15; no SQL file in supabase/migrations mentions the
  // key at all), so getAssumptionValue always fell through to the hard-coded
  // 6% below. A household with a 3.2% mortgage therefore had that same loan
  // amortised at 3.2% in the Debt report and 6.0% in the Net Worth report,
  // off an identical opening balance — two sections of the same report that
  // could not agree.
  //
  // This is the household's balance-weighted actual rate
  // (DashboardSummary.averageInterestRate). Optional and nullable: null means
  // the household has recorded no rate on any liability, which is the only
  // case where falling back to an assumption is honest.
  liabilityRatePercent?: number | null;
}

const DEFAULT_ASSET_GROWTH = 3;
const DEFAULT_INVESTMENT_RETURN = 7;
const DEFAULT_RETIREMENT_RETURN = 6.5;
const DEFAULT_LIABILITY_RATE = 6;

export function runNetWorthForecast(input: NetWorthCalculatorInput): { results: ForecastResultRow[]; explanations: ForecastExplanationRow[] } {
  const results: ForecastResultRow[] = [];
  const explanations: ForecastExplanationRow[] = [];

  // Assumption keys here match forecast_global_assumptions.assumption_key
  // exactly as seeded (0014_module10_forecasting_seed.sql) — resolveAssumptions()
  // keys its lookup map by assumption_key alone, not category-qualified, so
  // these must be the bare key names ('equity', 'retirement'), not
  // 'investment_return.equity'.
  const assetGrowth = getAssumptionValue(input.assumptions, 'property_growth', DEFAULT_ASSET_GROWTH);
  const investmentReturn = getAssumptionValue(input.assumptions, 'equity', DEFAULT_INVESTMENT_RETURN);
  const retirementReturn = getAssumptionValue(input.assumptions, 'retirement', DEFAULT_RETIREMENT_RETURN);
  // App Review 2026-09-15, item 8 — the household's own balance-weighted
  // liability rate wins. The 'liability_interest_rate' assumption is seeded
  // nowhere (verified live against DEV), so the branch below it was in
  // practice always the hard-coded DEFAULT_LIABILITY_RATE. It is kept only
  // for a household that has recorded no interest rate on any liability, the
  // one case where there is nothing truer to use.
  const liabilityRate =
    input.liabilityRatePercent !== null && input.liabilityRatePercent !== undefined
      ? input.liabilityRatePercent
      : getAssumptionValue(input.assumptions, 'liability_interest_rate', DEFAULT_LIABILITY_RATE);

  let assets = input.openingAssets;
  let investments = input.openingInvestments;
  let retirement = input.openingRetirement;
  let liabilities = input.openingLiabilities;

  const baseline = firstOfMonth(input.baselineDate);
  const eventsByMonth = new Map<number, PlannedFinancialEvent[]>();
  for (const event of input.plannedEvents ?? []) {
    const list = eventsByMonth.get(event.monthIndex) ?? [];
    list.push(event);
    eventsByMonth.set(event.monthIndex, list);
  }

  for (let m = 1; m <= input.months; m++) {
    const periodDate = addMonthsToDateString(baseline, m);
    const eventsThisMonth = eventsByMonth.get(m) ?? [];
    const eventAmountThisMonth = eventsThisMonth.reduce((sum, e) => sum + e.amount, 0);

    const assetMonth = projectInvestmentMonth({
      openingValue: assets,
      // Positive events (inheritance, asset sale) add to contributions;
      // negative events (a planned purchase) reduce the net contribution —
      // projectInvestmentMonth's formula nets contributions and withdrawals
      // the same way regardless of which side an amount is folded into, so
      // there's no need to split this into a separate withdrawals term.
      contributions: input.monthlyAssetContribution + eventAmountThisMonth,
      withdrawals: 0,
      annualReturnPercent: assetGrowth,
    });
    const investmentMonth = projectInvestmentMonth({
      openingValue: investments,
      contributions: input.monthlyInvestmentContribution,
      withdrawals: 0,
      annualReturnPercent: investmentReturn,
    });
    const retirementMonth = projectInvestmentMonth({
      openingValue: retirement,
      contributions: input.monthlyRetirementContribution,
      withdrawals: 0,
      annualReturnPercent: retirementReturn,
    });
    const liabilityMonth = projectLoanMonth({
      openingBalance: liabilities,
      annualInterestRatePercent: liabilityRate,
      repayment: Math.min(input.monthlyLoanRepayment, liabilities + liabilities * (liabilityRate / 100) / 12),
    });

    assets = assetMonth.closingValue;
    investments = investmentMonth.closingValue;
    retirement = retirementMonth.closingValue;
    liabilities = liabilityMonth.closingBalance;

    const totalAssetsClosing = round2(assets + investments + retirement);
    const netWorthClosing = round2(totalAssetsClosing - liabilities);

    results.push({
      forecastType: 'net_worth',
      entityType: 'portfolio',
      entityId: null,
      periodDate,
      periodNumber: m,
      openingValue: round2(assetMonth.openingValue + investmentMonth.openingValue + retirementMonth.openingValue - liabilityMonth.openingBalance),
      contributions: round2(assetMonth.contributions + investmentMonth.contributions + retirementMonth.contributions),
      withdrawals: 0,
      income: 0,
      expenses: 0,
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
      investmentReturn: round2(assetMonth.investmentReturn + investmentMonth.investmentReturn + retirementMonth.investmentReturn),
      fees: 0,
      fxGainLoss: 0,
      otherMovement: round2(liabilityMonth.repayment),
      closingValue: netWorthClosing,
      targetValue: null,
      varianceValue: null,
      variancePercentage: null,
      currency: input.currency,
      baseCurrencyValue: null,
      metadata: {
        assets: totalAssetsClosing,
        liabilities: round2(liabilities),
        breakdown: { assets, investments, retirement },
        ...(eventsThisMonth.length > 0 ? { plannedEvents: eventsThisMonth } : {}),
      },
    });

    if (eventsThisMonth.length > 0) {
      explanations.push(
        buildExplanation({
          entityType: 'portfolio',
          entityId: null,
          explanationType: 'planned_financial_event',
          title: `Planned event — month ${m}`,
          narrative: eventsThisMonth
            // App Review 2026-09-15 G1/item 7: raw toLocaleString() emitted an
            // unsigned, un-symboled, cents-bearing float into user-facing
            // narrative text. Shared whole-unit formatter, sign preserved.
            .map((e) => `${e.description}: ${e.amount >= 0 ? '+' : '-'}${formatMoneyNarrative(Math.abs(e.amount), input.currency)}`)
            .join('; '),
          inputs: { month: m, events: eventsThisMonth },
          formula: 'Applied as an additional one-time contribution (or reduction, if negative) to general assets in the specified month.',
          priority: 5,
        })
      );
    }

    if (m === 1 || m % 12 === 0) {
      explanations.push(
        buildExplanation({
          entityType: 'portfolio',
          entityId: null,
          explanationType: 'net_worth_projection',
          title: `Net worth projection — month ${m}`,
          // App Review 2026-09-15, item 8(d): "the standard reducing-balance
          // formula" invited the reader to assume their own loan terms were
          // used. The rate is now named, and where it came from.
          narrative:
            `Assets, investments and retirement balances are grown monthly using each category's assumed annual return, compounded monthly. ` +
            `Liabilities are amortised using the standard reducing-balance formula at ${round2(liabilityRate)}% p.a. — ` +
            (input.liabilityRatePercent !== null && input.liabilityRatePercent !== undefined
              ? 'your own recorded loan rates, weighted by balance.'
              : 'a default rate, because no interest rate is recorded on any of your liabilities.') +
            ` Net worth = total assets (incl. investments and retirement) - total liabilities.`,
          inputs: {
            assetGrowthPercent: assetGrowth,
            investmentReturnPercent: investmentReturn,
            retirementReturnPercent: retirementReturn,
            liabilityRatePercent: liabilityRate,
            monthlyAssetContribution: input.monthlyAssetContribution,
            monthlyInvestmentContribution: input.monthlyInvestmentContribution,
            monthlyRetirementContribution: input.monthlyRetirementContribution,
            monthlyLoanRepayment: input.monthlyLoanRepayment,
          },
          formula: 'Closing = (Opening + Contributions - Withdrawals) x (1 + (1+annualReturn)^(1/12) - 1) - Fees; Net Worth = Assets + Investments + Retirement - Liabilities',
          priority: m === 1 ? 10 : 0,
        })
      );
    }
  }

  return { results, explanations };
}
