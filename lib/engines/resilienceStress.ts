import type { DashboardSummary } from './dashboard';
import { recomputeDerived } from './whatIf';
import { computeAccessibleLiquidResources, type CommitmentRow } from './resilience';
import type { CountryCode } from '@/lib/services/jurisdiction';

export type StressScenarioType =
  | 'income_stops'
  | 'income_falls_pct'
  | 'unexpected_expense'
  | 'interest_rate_rise'
  | 'rental_vacancy'
  | 'investment_market_decline'
  | 'currency_shock'
  | 'combined_severe';

export const STRESS_SCENARIO_LABELS: Record<StressScenarioType, string> = {
  income_stops: 'Primary income stops (job loss)',
  income_falls_pct: 'Household income falls by 20%',
  unexpected_expense: 'Unexpected expense of $5,000',
  interest_rate_rise: 'Interest rates rise by 1 percentage point',
  rental_vacancy: 'Rental property sits vacant',
  investment_market_decline: 'Investment markets fall by 15%',
  currency_shock: 'Adverse 10% currency move on overseas holdings',
  combined_severe: 'Combined severe scenario (job loss + market decline + rate rise)',
};

export interface StressScenarioParams {
  durationMonths?: number; // income_stops, rental_vacancy, combined_severe
  incomeFallPct?: number; // income_falls_pct
  expenseAmount?: number; // unexpected_expense
  rateRisePct?: number; // interest_rate_rise, combined_severe
  marketDeclinePct?: number; // investment_market_decline, combined_severe
  currencyShockPct?: number; // currency_shock
}

const DEFAULTS: Required<StressScenarioParams> = {
  durationMonths: 6,
  incomeFallPct: 20,
  expenseAmount: 5000,
  rateRisePct: 1,
  marketDeclinePct: 15,
  currencyShockPct: 10,
};

function applyIncomeStops(d: DashboardSummary): void {
  const share = d.largestIncomeSharePct ?? (d.incomeSourceCount <= 1 ? 1 : 0.5);
  d.grossMonthlyIncome *= 1 - share;
  d.netMonthlyIncome *= 1 - share;
  d.incomeSourceCount = Math.max(0, d.incomeSourceCount - 1);
  d.largestIncomeSharePct = null;
}

function applyIncomeFallsPct(d: DashboardSummary, pct: number): void {
  d.grossMonthlyIncome *= 1 - pct / 100;
  d.netMonthlyIncome *= 1 - pct / 100;
}

function applyUnexpectedExpense(d: DashboardSummary, amount: number): void {
  const draw = Math.min(amount, d.liquidAssets);
  d.liquidAssets -= draw;
  d.totalAssets -= draw;
}

function applyInterestRateRise(d: DashboardSummary, risePct: number): void {
  const extraMonthly = (d.variableRateDebtBalance * (risePct / 100)) / 12;
  d.debtMonthlyRepayments += extraMonthly;
}

function applyRentalVacancy(d: DashboardSummary): void {
  const loss = Math.min(d.rentalMonthlyIncome, d.grossMonthlyIncome);
  d.grossMonthlyIncome -= loss;
  d.netMonthlyIncome = Math.max(0, d.netMonthlyIncome - loss);
  d.passiveMonthlyIncome = Math.max(0, d.passiveMonthlyIncome - loss);
}

function applyInvestmentMarketDecline(d: DashboardSummary, pct: number): void {
  const investmentLoss = d.totalInvestments * (pct / 100);
  const retirementLoss = d.totalRetirement * (pct / 100);
  d.totalInvestments -= investmentLoss;
  d.totalRetirement -= retirementLoss;
  d.investmentUnrealisedGain -= investmentLoss + retirementLoss;
}

// G0-JA-1 Wave 1 (JA-D2): homeCountry must be the caller's own already-
// resolved country_of_residence (threaded in by the caller via
// getUserHomeCountry()/forecast_profiles.country_code — see the two call
// sites, app/api/resilience/scenario/route.ts and
// lib/services/forecastData.ts), never re-derived from currency. A
// household's preferred/reporting currency is an independent, currency-only
// concept (01-canonical-architecture.md §7/§8) — a household can legitimately
// hold AUD while resident in India, or vice versa, which is exactly the
// scenario the old `currency === 'AUD' ? 'AU' : 'IN'` line silently
// mishandled (inverting or over-broadening which holdings counted as
// "foreign"). When the country is unresolved, this does not guess AU or IN —
// it skips the home/foreign split entirely for this scenario (no holding can
// be honestly labelled "foreign" relative to an unknown home), so no
// currency-shock loss is applied rather than fabricating one against a
// guessed home country.
function applyCurrencyShock(d: DashboardSummary, pct: number, homeCountry: CountryCode | null): void {
  if (!homeCountry) return;
  const foreignValue = d.investmentByCountry
    .filter((c) => c.countryCode !== homeCountry)
    .reduce((sum, c) => sum + c.value, 0);
  const loss = foreignValue * (pct / 100);
  d.totalInvestments = Math.max(0, d.totalInvestments - loss);
}

export interface StressScenarioResult {
  scenario: StressScenarioType;
  label: string;
  before: { monthlySurplus: number; netWorth: number; accessibleLiquidResources: number };
  after: { monthlySurplus: number; netWorth: number; accessibleLiquidResources: number };
  monthlyShortfall: number;
  survivalMonths: number | null; // null = indefinite (household stays cash-flow positive under the shock)
  durationMonths: number | null;
  shockedDashboard: DashboardSummary; // exposed so the caller can re-score resilience components under the shock
}

// A simulated result only — never persisted. Clones the dashboard (same
// pattern as whatIf.ts) so the real DashboardSummary is left untouched.
//
// homeCountry (JA-D2): the caller's own already-resolved country_of_residence,
// used only by the 'currency_shock' scenario's foreign-holdings filter.
// Optional/nullable and defaulted to null so every other scenario (which
// never depended on home country) is completely unaffected by this
// parameter's addition — see applyCurrencyShock's own doc comment for the
// unresolved-country handling.
export function applyStressScenario(
  base: DashboardSummary,
  scenario: StressScenarioType,
  commitments: CommitmentRow[],
  params: StressScenarioParams = {},
  homeCountry: CountryCode | null = null
): StressScenarioResult {
  const p = { ...DEFAULTS, ...params };
  const before = computeAccessibleLiquidResources(base, commitments);

  const d: DashboardSummary = JSON.parse(JSON.stringify(base));
  let durationMonths: number | null = null;

  switch (scenario) {
    case 'income_stops':
      applyIncomeStops(d);
      durationMonths = p.durationMonths;
      break;
    case 'income_falls_pct':
      applyIncomeFallsPct(d, p.incomeFallPct);
      break;
    case 'unexpected_expense':
      applyUnexpectedExpense(d, p.expenseAmount);
      break;
    case 'interest_rate_rise':
      applyInterestRateRise(d, p.rateRisePct);
      break;
    case 'rental_vacancy':
      applyRentalVacancy(d);
      durationMonths = p.durationMonths;
      break;
    case 'investment_market_decline':
      applyInvestmentMarketDecline(d, p.marketDeclinePct);
      break;
    case 'currency_shock':
      applyCurrencyShock(d, p.currencyShockPct, homeCountry);
      break;
    case 'combined_severe':
      applyIncomeStops(d);
      applyInvestmentMarketDecline(d, p.marketDeclinePct);
      applyInterestRateRise(d, p.rateRisePct);
      durationMonths = p.durationMonths;
      break;
  }

  recomputeDerived(d);
  const after = computeAccessibleLiquidResources(d, commitments);

  const monthlyShortfall = d.monthlySurplus < 0 ? Math.abs(d.monthlySurplus) : 0;
  const survivalMonths = monthlyShortfall > 0 ? (after.accessible > 0 ? after.accessible / monthlyShortfall : 0) : null;

  return {
    scenario,
    label: STRESS_SCENARIO_LABELS[scenario],
    before: { monthlySurplus: base.monthlySurplus, netWorth: base.netWorth, accessibleLiquidResources: before.accessible },
    after: { monthlySurplus: d.monthlySurplus, netWorth: d.netWorth, accessibleLiquidResources: after.accessible },
    monthlyShortfall,
    survivalMonths,
    durationMonths,
    shockedDashboard: d,
  };
}
