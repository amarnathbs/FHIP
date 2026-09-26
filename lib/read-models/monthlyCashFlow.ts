/**
 * One calendar month's combined cash flow, derived from a snapshot that was
 * already built for the request (WP-03, DC-01 / DC-14).
 *
 * WHY. `financial_snapshots` is the month-by-month history the Score's
 * stability component and the Twin trends read. Before WP-03 a row was only
 * ever written for the CURRENT calendar month, from whatever happened to be
 * loaded that day, so approving last month's statement never reached last
 * month's row. Now every month in the read window that an approved statement
 * FULLY covers is re-derived from that month's own approved lines, under the
 * exact same rules as the Dashboard (same selectors, same combined basis),
 * without a second database read: the ledger in the snapshot is restricted to
 * the month and the pure compute functions are run again.
 *
 * Pure. No I/O.
 */
import '@/lib/serverOnly';
import type { CanonicalFinancialSnapshot } from './snapshot';
import { computeActualExpenses, computeCombinedExpenses } from './expenses';
import { computeLiabilities, householdDebtServiceUnderD08, type LiabilityLine, type LiabilityRow } from './liabilities';
import { coveredMonthlyAverage, type NormalisedLedger } from './core/ledger';
import type { CoverageIndex } from './core/coverage';
import { roundMoney } from './core/types';
import { explicitWindow, monthEnd, monthOf, monthStart, type MonthKey } from './core/window';

/** The ledger as if the read window were exactly `month`. */
export function restrictLedgerToMonth(ledger: NormalisedLedger, month: MonthKey): NormalisedLedger {
  const window = explicitWindow(monthStart(month), monthEnd(month), ledger.window.asOf, ledger.window.timeZone);
  const only = (m: Map<string, Set<MonthKey>>) => {
    const out = new Map<string, Set<MonthKey>>();
    for (const [accountId, months] of m) out.set(accountId, months.has(month) ? new Set([month]) : new Set());
    return out;
  };
  const coverage: CoverageIndex = {
    rows: ledger.coverage.rows.filter((r) => r.month === month),
    covered: only(ledger.coverage.covered),
    partial: only(ledger.coverage.partial),
    coveredMonths: ledger.coverage.coveredMonths.filter((m) => m === month),
    partialMonths: ledger.coverage.partialMonths.filter((m) => m === month),
  };
  return {
    ...ledger,
    window,
    coverage,
    lines: ledger.lines.filter((l) => l.month === month),
    nettedRefunds: ledger.nettedRefunds.filter((n) => n.refund.month === month),
    unlinkedRefunds: ledger.unlinkedRefunds.filter((l) => l.month === month),
  };
}

/** Rebuilds the register row a LiabilityLine came from (every field computeLiabilities reads). */
function rowFromLine(line: LiabilityLine): LiabilityRow {
  return {
    id: line.id,
    liability_name: line.name,
    debt_type: line.debtType,
    master_item_key: line.masterItemKey,
    balance: line.balance.amountNative,
    monthly_repayment: line.contractualMonthly?.amountNative ?? null,
    minimum_payment: line.minimumPayment?.amountNative ?? null,
    interest_rate: null,
    credit_limit: null,
    currency_code: line.balance.currency,
    // The SMSF property-loan override is already applied to `owner` on the line.
    owner: line.owner,
    source_type: line.provenance.kind === 'manual' ? 'manual' : 'liability_statement_import',
  };
}

export interface MonthCashFlow {
  month: MonthKey;
  grossIncome: number;
  netIncomeKnown: number;
  netIncomeUnknownComponents: number;
  expenses: number;
  debtService: number;
  /** Same rule as the Dashboard: net when known, otherwise gross. */
  incomeForSurplus: number;
  surplus: number;
  savingsRate: number | null;
}

/**
 * The month's figures, or null when any of income / expenses / liabilities is
 * unavailable in the snapshot (never a partial figure written as if whole).
 */
export function computeMonthCashFlow(snapshot: CanonicalFinancialSnapshot, month: MonthKey): MonthCashFlow | null {
  if (snapshot.ledger.status !== 'ok' || snapshot.income.status !== 'ok' || snapshot.expenses.status !== 'ok' || snapshot.liabilities.status !== 'ok') return null;
  const ledger = restrictLedgerToMonth(snapshot.ledger.value, month);
  const income = snapshot.income;

  const countedInMonth = income.actual.lines.filter((l) => l.treatment === 'counted' && l.month === month);
  const actualIncome = coveredMonthlyAverage(ledger, countedInMonth);
  const variablePay = roundMoney(income.actual.variablePay.lines.filter((v) => monthOf(v.date) === month).reduce((s, v) => s + (v.grossReporting ?? 0), 0));
  const grossIncome = roundMoney(income.planned.grossMonthly + actualIncome + variablePay);
  const netIncomeKnown = roundMoney(income.planned.netKnownMonthly + actualIncome);
  const netIncomeUnknownComponents = income.planned.netUnknownCount + (variablePay > 0 ? 1 : 0);

  const actual = computeActualExpenses(ledger);
  const combined = computeCombinedExpenses(snapshot.expenses.planned, actual);

  const liabilities = computeLiabilities(snapshot.liabilities.lines.map(rowFromLine), new Set(), ledger, snapshot.fx, {
    cardRepaymentRule: snapshot.liabilities.cardRepaymentRule,
  });

  const consumption = snapshot.expenses.planned.lines.some((l) => l.excludedReason === null) || actual.byGroup.some((g) => g.coveredLineCount > 0);
  const debtService = householdDebtServiceUnderD08(liabilities, consumption);
  const incomeForSurplus = netIncomeKnown || grossIncome;
  const surplus = roundMoney(incomeForSurplus - combined.monthly - debtService);
  return {
    month,
    grossIncome,
    netIncomeKnown,
    netIncomeUnknownComponents,
    expenses: combined.monthly,
    debtService,
    incomeForSurplus,
    surplus,
    savingsRate: incomeForSurplus > 0 ? surplus / incomeForSurplus : null,
  };
}
