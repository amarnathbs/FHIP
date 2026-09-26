/**
 * Forecast inputs read through the canonical read models (WP-05).
 *
 * Before WP-05 each forecast branch queried the registers itself: no paging
 * (a >1000-row register was silently truncated, DC-18), errors coerced to []
 * (a failed read forecast as a zero, DC-14), an unsupported currency treated
 * as if it were the reporting currency, and a retirement contribution with a
 * NULL frequency treated as MONTHLY (a statement period total read as a
 * monthly rate, ~12x -- GAP-RET-02). Every branch now reads the same paged,
 * fail-closed register loaders the canonical selectors use
 * (lib/read-models), and the SAME rules:
 *
 *  - unsupported currency: left out of every total and counted, never added raw;
 *  - null contribution frequency: UNKNOWN -- excluded from the monthly figure
 *    and counted, never assumed monthly;
 *  - a failed read throws (the run fails / the variance row says
 *    "unavailable"), never a zero.
 *
 * The forecast keeps its OWN reporting currency and FX rate (the forecast
 * profile's base currency and the scenario's fx_rate_aud_inr assumption) --
 * that is a deliberate forecast input a scenario can override -- so the
 * selectors' pure computations are called with an FxContext built from them.
 */
import '@/lib/serverOnly';
import { toMonthly, type Frequency } from '@/lib/engines/money';
import { computeRetirement, type RetirementLine } from '@/lib/read-models/retirement';
import { loadRetirementAccounts } from '@/lib/read-models/retirement';
import { loadAssetRows } from '@/lib/read-models/assets';
import { loadInvestmentRows, type InvestmentRow } from '@/lib/read-models/investments';
import { loadLiabilityRows, type LiabilityRow } from '@/lib/read-models/liabilities';
import { fxContext, isSupportedCurrency, toReporting, type FxContext } from '@/lib/read-models/core/currency';
import type { ReadModelClient } from '@/lib/read-models/core/paginate';
import { roundMoney } from '@/lib/read-models/core/types';

export type ForecastCurrency = 'AUD' | 'INR';

/** The forecast's own FX context: its base currency and its scenario FX assumption. */
export function forecastFx(baseCurrency: ForecastCurrency, fxRateAudInr: number, countryCode: string | null = null): FxContext {
  return fxContext(baseCurrency, fxRateAudInr, countryCode);
}

const KNOWN_CONTRIBUTION_FREQUENCIES = new Set<Frequency>(['weekly', 'fortnightly', 'monthly', 'quarterly', 'annually', 'one_off']);

function nativeMonthlyContribution(amount: number | null, frequency: string | null): { monthly: number; unknown: boolean } {
  if (amount == null || Number(amount) === 0) return { monthly: 0, unknown: false };
  if (frequency == null || !KNOWN_CONTRIBUTION_FREQUENCIES.has(frequency as Frequency)) return { monthly: 0, unknown: true };
  return { monthly: toMonthly(Number(amount), frequency as Frequency), unknown: false };
}

// ---------------------------------------------------------------------------
// Cross-border: the foreign-currency leg, in its own (foreign) currency
// ---------------------------------------------------------------------------

export interface ForeignPosition {
  foreignCurrency: ForecastCurrency;
  assets: number;
  investments: number;
  investmentMonthlyContribution: number;
  retirement: number;
  retirementMonthlyContribution: number;
  /** Foreign retirement contributions left out because their frequency is unknown. */
  retirementUnknownFrequencyCount: number;
  liabilities: number;
  liabilityMonthlyRepayment: number;
  /** Balance-weighted rate across the foreign liabilities that record one; null when none does. */
  liabilityRatePercent: number | null;
}

export async function loadForeignPosition(userId: string, client: ReadModelClient, foreignCurrency: ForecastCurrency): Promise<ForeignPosition> {
  const [assets, investments, liabilities, retirement] = await Promise.all([
    loadAssetRows(userId, client),
    loadInvestmentRows(userId, client),
    loadLiabilityRows(userId, client).then((l) => l.rows),
    loadRetirementAccounts(userId, client),
  ]);
  return computeForeignPosition({ assets, investments, liabilities, retirement }, foreignCurrency);
}

export function computeForeignPosition(
  input: {
    assets: readonly { current_value: number; currency_code: string }[];
    investments: readonly Pick<InvestmentRow, 'current_value' | 'currency_code' | 'annual_contribution'>[];
    liabilities: readonly Pick<LiabilityRow, 'balance' | 'currency_code' | 'monthly_repayment' | 'interest_rate'>[];
    retirement: readonly { current_balance: number; currency_code: string; employer_contribution: number | null; personal_contribution: number | null; contribution_frequency: string | null }[];
  },
  foreignCurrency: ForecastCurrency,
): ForeignPosition {
  const isForeign = (c: string | null | undefined) => c === foreignCurrency;
  const assets = input.assets.filter((a) => isForeign(a.currency_code));
  const investments = input.investments.filter((i) => isForeign(i.currency_code));
  const liabilities = input.liabilities.filter((l) => isForeign(l.currency_code));
  const retirement = input.retirement.filter((r) => isForeign(r.currency_code));
  let unknown = 0;
  let retirementMonthly = 0;
  for (const r of retirement) {
    for (const amount of [r.employer_contribution, r.personal_contribution]) {
      const c = nativeMonthlyContribution(amount, r.contribution_frequency);
      if (c.unknown) unknown += 1;
      retirementMonthly += c.monthly;
    }
  }
  const withRate = liabilities.filter((l) => l.interest_rate !== null && l.interest_rate !== undefined);
  const balanceWithRate = withRate.reduce((s, l) => s + Number(l.balance), 0);
  return {
    foreignCurrency,
    assets: roundMoney(assets.reduce((s, a) => s + Number(a.current_value), 0)),
    investments: roundMoney(investments.reduce((s, i) => s + Number(i.current_value), 0)),
    investmentMonthlyContribution: roundMoney(investments.reduce((s, i) => s + Number(i.annual_contribution ?? 0) / 12, 0)),
    retirement: roundMoney(retirement.reduce((s, r) => s + Number(r.current_balance ?? 0), 0)),
    retirementMonthlyContribution: roundMoney(retirementMonthly),
    retirementUnknownFrequencyCount: unknown,
    liabilities: roundMoney(liabilities.reduce((s, l) => s + Number(l.balance), 0)),
    liabilityMonthlyRepayment: roundMoney(liabilities.reduce((s, l) => s + Number(l.monthly_repayment ?? 0), 0)),
    liabilityRatePercent: balanceWithRate > 0 ? withRate.reduce((s, l) => s + Number(l.interest_rate) * Number(l.balance), 0) / balanceWithRate : null,
  };
}

// ---------------------------------------------------------------------------
// Retirement: balances and contributions in the forecast's reporting currency
// ---------------------------------------------------------------------------

export interface RetirementForecastAccount {
  id: string;
  owner: string | null;
  /** Reporting currency; null when the account's currency is unsupported (excluded). */
  balance: number | null;
  /** Reporting currency per month, known-frequency contributions only. */
  monthlyContribution: number;
  unknownFrequencyContributions: number;
}

export interface RetirementForecastPosition {
  accounts: RetirementForecastAccount[];
  currentBalance: number;
  unconvertedCount: number;
  unknownFrequencyCount: number;
}

export function retirementForecastAccounts(lines: readonly RetirementLine[]): RetirementForecastAccount[] {
  return lines.map((l) => {
    let monthly = 0;
    let unknown = 0;
    for (const c of [l.employerContribution, l.personalContribution]) {
      if (!c || c.amountNative === 0) continue;
      if (!c.frequencyKnown) {
        unknown += 1;
        continue;
      }
      monthly += c.monthlyReporting ?? 0;
    }
    return { id: l.id, owner: l.owner, balance: l.balance.amountReporting, monthlyContribution: roundMoney(monthly), unknownFrequencyContributions: unknown };
  });
}

export async function loadRetirementForecastPosition(userId: string, client: ReadModelClient, fx: FxContext): Promise<RetirementForecastPosition> {
  const model = computeRetirement(await loadRetirementAccounts(userId, client), fx);
  const accounts = retirementForecastAccounts(model.lines);
  return {
    accounts,
    currentBalance: model.totalBalance,
    unconvertedCount: model.unconverted.count,
    unknownFrequencyCount: accounts.reduce((s, a) => s + a.unknownFrequencyContributions, 0),
  };
}

// ---------------------------------------------------------------------------
// Debt and investment registers (paged, fail closed)
// ---------------------------------------------------------------------------

export async function loadDebtForecastLiabilities(userId: string, client: ReadModelClient): Promise<LiabilityRow[]> {
  return (await loadLiabilityRows(userId, client)).rows;
}

export async function loadInvestmentForecastHoldings(userId: string, client: ReadModelClient): Promise<InvestmentRow[]> {
  return loadInvestmentRows(userId, client);
}

// ---------------------------------------------------------------------------
// Goal variance: convert per goal BEFORE summing (DC-13)
// ---------------------------------------------------------------------------

export interface GoalVarianceTotals {
  actual: number;
  target: number;
  /** Goals left out because their currency is unsupported. */
  unconvertedCount: number;
}

export function sumGoalsInReportingCurrency(
  goals: readonly { currency_code: string | null; actualNative: number; targetNative: number | null }[],
  fx: FxContext,
): GoalVarianceTotals {
  let actual = 0;
  let target = 0;
  let unconverted = 0;
  for (const g of goals) {
    // A goal with no currency recorded is in the household's reporting
    // currency (the goals grid's own default) -- the one case where no
    // conversion is the correct conversion.
    const currency = g.currency_code ?? fx.reportingCurrency;
    if (!isSupportedCurrency(currency)) {
      unconverted += 1;
      continue;
    }
    actual += toReporting(g.actualNative, currency, fx) ?? 0;
    target += toReporting(g.targetNative ?? 0, currency, fx) ?? 0;
  }
  return { actual: roundMoney(actual), target: roundMoney(target), unconvertedCount: unconverted };
}
