// Phase 2 — Investment Forecasting. Standalone per-investment-account
// monthly projection, independent of any goal tagging (goal-to-investment
// tagging and allocation validation already exist — goal_funding_sources /
// checkFundingAllocation in lib/services/goalFundingAllocation.ts — this
// calculator is the investment's own growth trajectory, not goal funding).
import { buildExplanation } from './explain';
import { addMonthsToDateString, firstOfMonth, projectInvestmentMonth, round2 } from './monthlyPrimitives';
import type { ForecastExplanationRow, ForecastResultRow, ResolvedAssumptionSet } from './types';
import { getAssumptionValue } from './assumptions';
import { formatMoneyWhole } from '../money';

export interface InvestmentCalculatorInputEntry {
  id: string;
  name: string;
  currentValue: number;
  monthlyContribution: number;
  investmentType: string;
  // The grid's investment_type field defaults to 'other' for almost every
  // grid-created row (the grid collects a master_item_key, not
  // investment_type — see MASTER_ITEM_TO_ASSET_CLASS below), so
  // masterItemKey is the reliable asset-class signal in practice
  // (FHIP-FC-INV-001/002). Null for legacy/manually-created rows with no
  // master item selected.
  masterItemKey: string | null;
  currency: string;
}

export interface InvestmentCalculatorInput {
  baselineDate: string;
  months: number;
  assumptions: ResolvedAssumptionSet;
  investments: InvestmentCalculatorInputEntry[];
}

const DEFAULT_INVESTMENT_RETURN = 7;

// Kept as a secondary check — investment_type (lib/validation/investment.ts)
// only has 6 values and defaults to 'other', but on the rare row where it
// does carry a real signal (e.g. set directly via the API rather than the
// grid), it should still be honoured.
const TYPE_TO_ASSUMPTION_KEY: Record<string, string> = {
  shares: 'equity',
  etf: 'equity',
  managed_fund: 'equity',
  business_equity: 'equity',
  crypto: 'other_asset',
};

// Forecasting P1 fix FHIP-FC-INV-001/002 — master_item_key is the reliable
// asset-class signal (the grid always sets it; investment_type it does not
// collect at all). Mirrors dashboard.ts's bucketInvestmentType() key set
// (seeded in supabase/seed_master_items.sql's 'investment' category) but
// maps onto the 6 return-assumption keys actually seeded in
// forecast_global_assumptions, not that function's own display buckets.
const MASTER_ITEM_TO_ASSET_CLASS: Record<string, string> = {
  australian_shares: 'equity',
  international_shares: 'equity',
  etfs: 'equity',
  managed_funds: 'equity',
  index_funds: 'equity',
  private_equity: 'equity',
  angel_investments: 'equity',
  venture_capital: 'equity',
  education_fund: 'equity',
  children_investment: 'equity',
  bonds: 'fixed_interest',
  government_bonds: 'fixed_interest',
  corporate_bonds: 'fixed_interest',
  cash_investments: 'cash',
  high_interest_savings: 'cash',
  term_deposits: 'cash',
  property: 'property',
  commercial_property: 'property',
  reits: 'property',
  // No dedicated assumption key exists for these — treated as other_asset
  // rather than guessed at, same as the pre-existing crypto/other handling.
  cryptocurrency: 'other_asset',
  gold: 'other_asset',
  silver: 'other_asset',
  commodities: 'other_asset',
  collectibles: 'other_asset',
  options: 'other_asset',
  futures: 'other_asset',
  forex: 'other_asset',
  business_investment: 'other_asset',
  partnership_investment: 'other_asset',
  trust_investment: 'other_asset',
  other_investments: 'other_asset',
  // Superannuation-style master items resolve via a small ordered fallback
  // in resolveAssetClass() below rather than a single key, since AU seeds
  // 'superannuation' and IN seeds 'retirement' — neither country seeds both.
  smsf_investments: 'superannuation',
};

// Ordered fallback for asset classes whose exact assumption key varies by
// country (see MASTER_ITEM_TO_ASSET_CLASS's smsf_investments comment).
const ASSET_CLASS_FALLBACK_CHAIN: Record<string, string[]> = {
  superannuation: ['superannuation', 'retirement', 'other_asset'],
};

interface ResolvedAssetClass {
  assumptionKey: string;
  returnRate: number;
  // True when the mapping had no real signal at all (neither master_item_key
  // nor investment_type resolved) and fell all the way back to the generic
  // other_asset default — surfaced to the user as a caveat rather than
  // silently presenting a guessed rate with the same confidence as a real one.
  isLowConfidence: boolean;
}

function resolveAssetClass(masterItemKey: string | null, investmentType: string, assumptions: ResolvedAssumptionSet): ResolvedAssetClass {
  const candidateKey = (masterItemKey ? MASTER_ITEM_TO_ASSET_CLASS[masterItemKey] : undefined) ?? TYPE_TO_ASSUMPTION_KEY[investmentType];
  if (!candidateKey) {
    return { assumptionKey: 'other_asset', returnRate: getAssumptionValue(assumptions, 'other_asset', DEFAULT_INVESTMENT_RETURN), isLowConfidence: true };
  }
  const chain = ASSET_CLASS_FALLBACK_CHAIN[candidateKey] ?? [candidateKey];
  for (const key of chain) {
    if (assumptions[key] !== undefined) return { assumptionKey: key, returnRate: getAssumptionValue(assumptions, key, DEFAULT_INVESTMENT_RETURN), isLowConfidence: false };
  }
  // A real asset class was identified but this country doesn't seed a rate
  // for it — still a known asset class, just missing country data, distinct
  // from never having identified one at all.
  return { assumptionKey: chain[chain.length - 1], returnRate: getAssumptionValue(assumptions, chain[chain.length - 1], DEFAULT_INVESTMENT_RETURN), isLowConfidence: false };
}

// Plain-English label for the assumption key actually applied — narrative
// text must never interpolate the raw DB/config key (e.g. "(other_asset)")
// directly into user-facing copy.
const ASSUMPTION_KEY_LABEL: Record<string, string> = {
  equity: 'growth assets',
  other_asset: 'other assets',
  cash: 'cash',
  fixed_interest: 'fixed interest',
  property: 'property',
  retirement: 'retirement assets',
  superannuation: 'superannuation',
};

export function runInvestmentForecast(input: InvestmentCalculatorInput): { results: ForecastResultRow[]; explanations: ForecastExplanationRow[] } {
  const results: ForecastResultRow[] = [];
  const explanations: ForecastExplanationRow[] = [];
  const baseline = firstOfMonth(input.baselineDate);

  for (const investment of input.investments) {
    const { assumptionKey, returnRate, isLowConfidence } = resolveAssetClass(investment.masterItemKey, investment.investmentType, input.assumptions);
    let balance = investment.currentValue;

    for (let m = 1; m <= input.months; m++) {
      const periodDate = addMonthsToDateString(baseline, m);
      const month = projectInvestmentMonth({
        openingValue: balance,
        contributions: investment.monthlyContribution,
        withdrawals: 0,
        annualReturnPercent: returnRate,
      });
      balance = month.closingValue;

      results.push({
        forecastType: 'investment',
        entityType: 'investment',
        entityId: investment.id,
        periodDate,
        periodNumber: m,
        openingValue: month.openingValue,
        contributions: month.contributions,
        withdrawals: 0,
        income: 0,
        expenses: 0,
        interest: 0,
        investmentReturn: month.investmentReturn,
        fees: 0,
        fxGainLoss: 0,
        otherMovement: 0,
        closingValue: balance,
        targetValue: null,
        varianceValue: null,
        variancePercentage: null,
        currency: investment.currency,
        baseCurrencyValue: null,
        metadata: { investmentName: investment.name, investmentType: investment.investmentType },
      });
    }

    const narrativeParts = [
      `Projected forward from the current value of ${formatMoneyWhole(round2(investment.currentValue), investment.currency as 'AUD' | 'INR')} using an assumed ${returnRate}% annual return (${ASSUMPTION_KEY_LABEL[assumptionKey] ?? assumptionKey}), compounded monthly, plus any regular contribution.`,
    ];
    if (isLowConfidence) {
      narrativeParts.push('This investment has no recognised asset class on file, so a generic default return was used — set an investment type for a more accurate projection.');
    }

    explanations.push(
      buildExplanation({
        entityType: 'investment',
        entityId: investment.id,
        explanationType: 'investment_growth_forecast',
        title: `${investment.name} — growth forecast`,
        narrative: narrativeParts.join(' '),
        inputs: {
          currentValue: investment.currentValue,
          monthlyContribution: investment.monthlyContribution,
          investmentType: investment.investmentType,
          masterItemKey: investment.masterItemKey,
          assumedReturnPercent: returnRate,
          lowConfidenceReturnAssumption: isLowConfidence,
        },
        formula: 'Closing = (Opening + Contributions - Withdrawals) x (1 + (1+annualReturn)^(1/12) - 1) - Fees',
        priority: 10,
      })
    );
  }

  return { results, explanations };
}
