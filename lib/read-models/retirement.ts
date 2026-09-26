/**
 * selectRetirement -- retirement_accounts as a summary-balance register
 * (DC-12 / GAP-RET-02).
 *
 *  - Balances are converted once; an unsupported currency is left out and
 *    surfaced, never added raw.
 *  - Contributions are monthly ONLY when their frequency is known. A null
 *    contribution_frequency is UNKNOWN: the amount is reported as-is and
 *    excluded from the monthly figure -- never assumed monthly (the old
 *    Dashboard read a statement PERIOD total as a monthly rate, ~12x).
 *  - SMSF-owned accounts stay in the balance (Net Worth) and are flagged; their
 *    contributions are not household cash flow.
 */
import '@/lib/serverOnly';
import { toMonthly, type Frequency } from '@/lib/engines/money';
import { loadFxContext, toReporting, type FxContext, type ReportingCurrency } from './core/currency';
import { fetchAllRows, type ReadModelClient } from './core/paginate';
import { addUnconverted, emptyUnconverted, isHouseholdOwner, provenance, roundMoney, toUnavailable, type MoneyValue, type Provenance, type ReadModelResult, type UnconvertedTally } from './core/types';

export interface RetirementAccountRow {
  id: string;
  account_name: string;
  account_type: string | null;
  current_balance: number;
  currency_code: string;
  owner: string | null;
  employer_contribution: number | null;
  personal_contribution: number | null;
  contribution_frequency: string | null;
  source_type: string | null;
  retirement_member_id: string | null;
}

export interface ContributionFigure {
  amountNative: number;
  frequency: string | null;
  /** null when the frequency is unknown, or the currency is unconverted. */
  monthlyReporting: number | null;
  frequencyKnown: boolean;
}

export interface RetirementLine {
  id: string;
  name: string;
  accountType: string | null;
  owner: string | null;
  household: boolean;
  memberId: string | null;
  balance: MoneyValue;
  employerContribution: ContributionFigure | null;
  personalContribution: ContributionFigure | null;
  provenance: Provenance;
}

export interface RetirementReadModelData {
  reportingCurrency: ReportingCurrency;
  lines: RetirementLine[];
  /** All owners (Net Worth). */
  totalBalance: number;
  householdBalance: number;
  /** Household, frequency-known contributions only. */
  householdEmployerContributionMonthly: number;
  householdPersonalContributionMonthly: number;
  /** Contributions with a null frequency: shown, never turned into a monthly rate. */
  unknownFrequencyCount: number;
  unconverted: UnconvertedTally;
}

export type RetirementReadModel = ReadModelResult<RetirementReadModelData>;

const r = roundMoney;
const KNOWN_FREQUENCIES = new Set(['weekly', 'fortnightly', 'monthly', 'quarterly', 'annually', 'one_off']);

function contribution(amount: number | null, frequency: string | null, currency: string, fx: FxContext): ContributionFigure | null {
  if (amount == null) return null;
  const known = frequency != null && KNOWN_FREQUENCIES.has(frequency);
  const monthlyReporting = known ? toReporting(r(toMonthly(Number(amount), frequency as Frequency)), currency, fx) : null;
  return { amountNative: Number(amount), frequency, monthlyReporting, frequencyKnown: known };
}

export function computeRetirement(rows: readonly RetirementAccountRow[], fx: FxContext): RetirementReadModelData {
  const unconverted = emptyUnconverted();
  let unknownFrequencyCount = 0;
  const lines: RetirementLine[] = rows.map((row) => {
    const amountReporting = toReporting(Number(row.current_balance), row.currency_code, fx);
    if (amountReporting === null) addUnconverted(unconverted, row.currency_code, Number(row.current_balance));
    const employer = contribution(row.employer_contribution, row.contribution_frequency, row.currency_code, fx);
    const personal = contribution(row.personal_contribution, row.contribution_frequency, row.currency_code, fx);
    for (const c of [employer, personal]) if (c && !c.frequencyKnown && c.amountNative !== 0) unknownFrequencyCount += 1;
    return {
      id: row.id, name: row.account_name, accountType: row.account_type, owner: row.owner, household: isHouseholdOwner(row.owner), memberId: row.retirement_member_id,
      balance: { amountNative: Number(row.current_balance), currency: row.currency_code, amountReporting },
      employerContribution: employer,
      personalContribution: personal,
      provenance: row.source_type === 'retirement_statement_import' ? provenance('retirement_statement')
        : row.source_type === 'investment_intelligence_published' ? provenance('investment_intelligence') : provenance('manual'),
    };
  });
  const household = lines.filter((l) => l.household);
  const sum = (vals: (number | null | undefined)[]) => r(vals.reduce<number>((s, v) => s + (v ?? 0), 0));
  return {
    reportingCurrency: fx.reportingCurrency,
    lines,
    totalBalance: sum(lines.map((l) => l.balance.amountReporting)),
    householdBalance: sum(household.map((l) => l.balance.amountReporting)),
    householdEmployerContributionMonthly: sum(household.map((l) => l.employerContribution?.monthlyReporting)),
    householdPersonalContributionMonthly: sum(household.map((l) => l.personalContribution?.monthlyReporting)),
    unknownFrequencyCount,
    unconverted,
  };
}

export async function loadRetirementAccounts(userId: string, client: ReadModelClient): Promise<RetirementAccountRow[]> {
  return fetchAllRows<RetirementAccountRow>('retirement_accounts', (from, to) =>
    client
      .from('retirement_accounts')
      .select('id, account_name, account_type, current_balance, currency_code, owner, employer_contribution, personal_contribution, contribution_frequency, source_type, retirement_member_id')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('id', { ascending: true })
      .range(from, to));
}

/** THE Retirement selector. Any failed read -> { status: 'unavailable' }. */
export async function selectRetirement(userId: string, opts: { client: ReadModelClient; fx?: FxContext }): Promise<RetirementReadModel> {
  try {
    const fx = opts.fx ?? (await loadFxContext(userId, opts.client));
    return { status: 'ok', ...computeRetirement(await loadRetirementAccounts(userId, opts.client), fx) };
  } catch (error) {
    return toUnavailable(error, 'selectRetirement');
  }
}
