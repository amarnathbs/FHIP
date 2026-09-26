/**
 * selectLiabilities -- balances for every owner, and household DEBT SERVICE
 * counted exactly once (DC-06 / EXP-G7 / G9, PO D-08 and D-09).
 *
 * DEBT SERVICE RULE, per liability:
 *  - INSTALMENT (loans): when the linked facility account has at least one
 *    covered month of approved ledger events in the window, debt service is
 *    the ACTUAL principal + interest + fee monthly average (e.g. 1,550 + 430 +
 *    20 = 2,000). It REPLACES the contractual monthly_repayment -- never added
 *    to it (D-09). Otherwise the contractual monthly_repayment is used.
 *  - REVOLVING (cards, lines of credit, BNPL): the card's consumption is
 *    already counted as spending (manual expense rows, or imported card
 *    purchases), so its minimum payment / monthly_repayment is NOT counted
 *    again (D-08, applied equally to manual and imported households). Only
 *    actual interest + fees ("cost of debt") count, when imported.
 *  - Facility interest/fees on a card/loan account that is not yet linked to
 *    a liability (pre-WP-11 data) are still counted, in `unlinkedFacility`, so
 *    they are never dropped between the expense and debt-service figures.
 *
 * BALANCES stay whole for every owner (Net Worth), exactly as dashboard.ts's
 * totalLiabilities does; DEBT SERVICE is household-only (SMSF-owned, or SMSF
 * property-loan-linked, liabilities are the fund's -- LR-FI-1 / LR-12R).
 */
import '@/lib/serverOnly';
import { debtFamilyFor, debtServiceClassFor, type DebtFamily, type DebtServiceClass } from '@/lib/engines/debtServiceContext';
import { resolveContext, type ReadModelOptions } from './core/context';
import { toReporting, type FxContext, type ReportingCurrency } from './core/currency';
import { coveredMonthlyAverage, type ActualLine, type NormalisedLedger } from './core/ledger';
import { fetchAllRows, type ReadModelClient } from './core/paginate';
import { REVOLVING_FACILITY_ACCOUNT_TYPES } from './core/spendingRules';
import { addUnconverted, emptyUnconverted, isHouseholdOwner, provenance, roundMoney, toUnavailable, type MoneyValue, type Provenance, type ReadModelResult, type UnconvertedTally } from './core/types';
import type { ReadWindow } from './core/window';

export interface LiabilityRow {
  id: string;
  liability_name: string;
  debt_type: string;
  master_item_key: string | null;
  balance: number;
  monthly_repayment: number | null;
  minimum_payment: number | null;
  interest_rate: number | null;
  credit_limit: number | null;
  currency_code: string;
  owner: string | null;
  source_type: string | null;
}

/** 'exclude_revolving' = PO D-08 (default). 'include' = the pre-programme Dashboard rule. */
export type CardRepaymentRule = 'exclude_revolving' | 'include';

export type DebtServiceBasis = 'actual' | 'contractual' | 'excluded_revolving' | 'none' | 'unconverted';

export interface LiabilityActualFigures {
  coveredMonths: number;
  principalMonthly: number;
  interestMonthly: number;
  feeMonthly: number;
  costOfDebtMonthly: number;
  totalMonthly: number;
}

export interface LiabilityLine {
  id: string;
  name: string;
  debtType: string;
  family: DebtFamily;
  serviceClass: DebtServiceClass;
  owner: string | null;
  household: boolean;
  smsfPropertyLoanLinked: boolean;
  balance: MoneyValue;
  contractualMonthly: MoneyValue | null;
  minimumPayment: MoneyValue | null;
  facilityAccountIds: string[];
  actual: LiabilityActualFigures | null;
  /** Reporting currency, per month. null only when unconverted. */
  debtServiceMonthly: number | null;
  debtServiceBasis: DebtServiceBasis;
  provenance: Provenance;
}

export interface LiabilitiesReadModelData {
  window: ReadWindow;
  reportingCurrency: ReportingCurrency;
  lines: LiabilityLine[];
  /** All owners, reporting currency (Net Worth side). */
  totalBalance: number;
  /** Household only: the balance basis for DTI. */
  householdBalance: number;
  /** Household only: the figure surplus / DSR / cash outflow use, counted once. */
  householdDebtServiceMonthly: number;
  householdCostOfDebtMonthly: number;
  householdPrincipalMonthly: number;
  /** All owners (amortisation pairing, like dashboard totalLiabilityMonthlyRepayments). */
  allOwnerDebtServiceMonthly: number;
  unlinkedFacility: { accountIds: string[]; costOfDebtMonthly: number; lines: ActualLine[] };
  unconverted: UnconvertedTally;
  cardRepaymentRule: CardRepaymentRule;
}

export type LiabilitiesReadModel = ReadModelResult<LiabilitiesReadModelData>;

const r = roundMoney;

function money(amount: number, currency: string, fx: FxContext): MoneyValue {
  return { amountNative: Number(amount), currency, amountReporting: toReporting(Number(amount), currency, fx) };
}

export function computeLiabilities(
  rows: readonly LiabilityRow[],
  smsfPropertyLoanLinkedIds: ReadonlySet<string>,
  ledger: NormalisedLedger,
  fx: FxContext,
  options: { cardRepaymentRule?: CardRepaymentRule } = {},
): LiabilitiesReadModelData {
  const rule = options.cardRepaymentRule ?? 'exclude_revolving';
  const unconverted = emptyUnconverted();
  const facilityLines = ledger.lines.filter((l) => l.onFacility);
  const accountsByLiability = new Map<string, string[]>();
  for (const acc of ledger.accounts.values()) {
    if (!acc.liability_id) continue;
    if (!accountsByLiability.has(acc.liability_id)) accountsByLiability.set(acc.liability_id, []);
    accountsByLiability.get(acc.liability_id)!.push(acc.id);
  }

  const lines: LiabilityLine[] = rows.map((row) => {
    const smsfLinked = smsfPropertyLoanLinkedIds.has(row.id);
    const owner = smsfLinked ? 'smsf' : row.owner;
    const facilityAccountIds = accountsByLiability.get(row.id) ?? [];
    const accountTypes = facilityAccountIds.map((id) => ledger.accounts.get(id)?.account_type ?? '');
    const serviceClass: DebtServiceClass = accountTypes.some((t) => REVOLVING_FACILITY_ACCOUNT_TYPES.has(t)) ? 'revolving' : debtServiceClassFor(row.debt_type, row.master_item_key);
    const balance = money(row.balance, row.currency_code, fx);
    if (balance.amountReporting === null) addUnconverted(unconverted, row.currency_code, Number(row.balance));
    const contractualMonthly = row.monthly_repayment == null ? null : money(row.monthly_repayment, row.currency_code, fx);
    const minimumPayment = row.minimum_payment == null ? null : money(row.minimum_payment, row.currency_code, fx);

    const own = facilityLines.filter((l) => facilityAccountIds.includes(l.accountId));
    const coveredMonths = facilityAccountIds.reduce((s, id) => s + (ledger.coverage.covered.get(id)?.size ?? 0), 0);
    let actual: LiabilityActualFigures | null = null;
    if (coveredMonths > 0) {
      const avg = (pred: (l: ActualLine) => boolean) => coveredMonthlyAverage(ledger, own.filter(pred), undefined, true);
      const principalMonthly = avg((l) => l.bucket === 'debt_principal');
      const interestMonthly = avg((l) => l.bucket === 'cost_of_debt' && l.type === 'debt_interest');
      const feeMonthly = avg((l) => l.bucket === 'cost_of_debt' && l.type === 'fee');
      actual = {
        coveredMonths,
        principalMonthly,
        interestMonthly,
        feeMonthly,
        costOfDebtMonthly: r(interestMonthly + feeMonthly),
        totalMonthly: r(principalMonthly + interestMonthly + feeMonthly),
      };
    }

    let debtServiceMonthly: number | null;
    let basis: DebtServiceBasis;
    if (balance.amountReporting === null && (contractualMonthly?.amountReporting ?? null) === null && !actual) {
      debtServiceMonthly = null;
      basis = 'unconverted';
    } else if (serviceClass === 'revolving' && rule === 'exclude_revolving') {
      debtServiceMonthly = actual ? actual.costOfDebtMonthly : 0;
      basis = actual ? 'actual' : 'excluded_revolving';
    } else if (serviceClass === 'instalment' && actual) {
      debtServiceMonthly = actual.totalMonthly;
      basis = 'actual';
    } else if (contractualMonthly) {
      debtServiceMonthly = contractualMonthly.amountReporting;
      basis = contractualMonthly.amountReporting === null ? 'unconverted' : 'contractual';
    } else {
      debtServiceMonthly = 0;
      basis = 'none';
    }

    return {
      id: row.id,
      name: row.liability_name,
      debtType: row.debt_type,
      family: debtFamilyFor(row.debt_type, row.master_item_key),
      serviceClass,
      owner,
      household: isHouseholdOwner(owner),
      smsfPropertyLoanLinked: smsfLinked,
      balance,
      contractualMonthly,
      minimumPayment,
      facilityAccountIds,
      actual,
      debtServiceMonthly,
      debtServiceBasis: basis,
      provenance: row.source_type === 'liability_statement_import'
        ? provenance(serviceClass === 'revolving' ? 'card_statement' : 'loan_statement')
        : provenance('manual'),
    };
  });

  const linkedAccountIds = new Set([...accountsByLiability.values()].flat());
  const unlinkedLines = facilityLines.filter((l) => !linkedAccountIds.has(l.accountId) && l.bucket === 'cost_of_debt' && l.household);
  const unlinkedCostOfDebt = coveredMonthlyAverage(ledger, unlinkedLines);

  const household = lines.filter((l) => l.household);
  const sum = (ls: LiabilityLine[], f: (l: LiabilityLine) => number | null) => r(ls.reduce((s, l) => s + (f(l) ?? 0), 0));
  return {
    window: ledger.window,
    reportingCurrency: fx.reportingCurrency,
    lines,
    totalBalance: sum(lines, (l) => l.balance.amountReporting),
    householdBalance: sum(household, (l) => l.balance.amountReporting),
    householdDebtServiceMonthly: r(sum(household, (l) => l.debtServiceMonthly) + unlinkedCostOfDebt),
    householdCostOfDebtMonthly: r(sum(household, (l) => l.actual?.costOfDebtMonthly ?? 0) + unlinkedCostOfDebt),
    householdPrincipalMonthly: sum(household, (l) => l.actual?.principalMonthly ?? 0),
    allOwnerDebtServiceMonthly: r(sum(lines, (l) => l.debtServiceMonthly) + unlinkedCostOfDebt),
    unlinkedFacility: { accountIds: [...new Set(unlinkedLines.map((l) => l.accountId))], costOfDebtMonthly: unlinkedCostOfDebt, lines: unlinkedLines },
    unconverted,
    cardRepaymentRule: rule,
  };
}

export interface LoadedLiabilities {
  rows: LiabilityRow[];
  smsfPropertyLoanLinkedIds: Set<string>;
}

export async function loadLiabilityRows(userId: string, client: ReadModelClient): Promise<LoadedLiabilities> {
  const rows = await fetchAllRows<LiabilityRow>('liabilities', (from, to) =>
    client
      .from('liabilities')
      .select('id, liability_name, debt_type, master_item_key, balance, monthly_repayment, minimum_payment, interest_rate, credit_limit, currency_code, owner, source_type')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('id', { ascending: true })
      .range(from, to));
  const links = await fetchAllRows<{ liability_id: string }>('property_liability_links', (from, to) =>
    client
      .from('property_liability_links')
      .select('liability_id')
      .eq('user_id', userId)
      .eq('link_type', 'smsf_property_loan')
      .eq('is_active', true)
      .order('liability_id', { ascending: true })
      .range(from, to));
  return { rows, smsfPropertyLoanLinkedIds: new Set(links.map((l) => l.liability_id)) };
}

/** THE Liabilities selector. Any failed read -> { status: 'unavailable' }. */
export async function selectLiabilities(
  userId: string,
  opts: ReadModelOptions & { cardRepaymentRule?: CardRepaymentRule; liabilities?: LoadedLiabilities },
): Promise<LiabilitiesReadModel> {
  try {
    const ctx = await resolveContext(userId, opts);
    const [loaded, ledger] = await Promise.all([
      opts.liabilities ? Promise.resolve(opts.liabilities) : loadLiabilityRows(userId, ctx.client),
      ctx.ledger(),
    ]);
    return { status: 'ok', ...computeLiabilities(loaded.rows, loaded.smsfPropertyLoanLinkedIds, ledger, ctx.fx, { cardRepaymentRule: opts.cardRepaymentRule }) };
  } catch (error) {
    return toUnavailable(error, 'selectLiabilities');
  }
}

/** Rows with the SMSF property-loan link applied to `owner` (LR-12R). */
export function liabilitiesWithOwnerOverride(loaded: LoadedLiabilities): LiabilityRow[] {
  return loaded.rows.map((r0) => (loaded.smsfPropertyLoanLinkedIds.has(r0.id) ? { ...r0, owner: 'smsf' } : r0));
}
