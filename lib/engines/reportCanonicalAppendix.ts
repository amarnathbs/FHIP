/**
 * The Premium report appendix, built from the canonical read models (WP-06,
 * DC-10 / EXP-G11 / GAP-02).
 *
 * The appendix promises to "list every recorded item used in this report's
 * calculations". Before WP-06 it listed the raw income_sources / expense_items
 * registers: superseded rows the calculations exclude were listed as if
 * counted, every approved imported bank line the calculations include was
 * missing, retirement accounts were missing, and no row showed its currency.
 *
 * It is now built from the SAME selector line items the calculations use:
 *  - planned (manual / Applied) rows AND approved imported lines, each with
 *    its provenance label ("Imported from bank statement");
 *  - rows a calculation leaves out are still listed, marked "not counted"
 *    with the reason (superseded, SMSF-owned, same money as a payslip, ...);
 *  - every row shows its own currency, plus the reporting-currency amount;
 *  - retirement accounts are included;
 *  - a reconciliation block ties each table to the figure the report uses
 *    (the combined expense figure is per group actual-else-planned, never
 *    planned + actual -- PO D-02), and items that are shown but deliberately
 *    NOT in Net Worth or spending are listed separately.
 *
 * Pure: takes the snapshot, returns JSON-safe data stored in report_sections
 * (so the PDF export, which renders the stored sections, inherits it).
 */
import type { CanonicalFinancialSnapshot } from '@/lib/read-models/snapshot';
import { NON_SPENDING_LABELS, type NonSpendingBucket } from '@/lib/read-models/core/spendingRules';

export const CANONICAL_APPENDIX_VERSION = 2 as const;

export type AppendixMeasure = 'monthly' | 'balance' | 'transaction';

export interface AppendixRow {
  name: string;
  /** Frequency, date, group or account type -- whatever identifies the row. */
  detail: string | null;
  amountNative: number;
  currency: string;
  /** Reporting currency; null when the currency is not convertible (never added raw). */
  amountReporting: number | null;
  provenance: string;
  counted: boolean;
  /** Why the row is not counted, or a review prompt. */
  note: string | null;
}

export interface AppendixTable {
  key:
    | 'income_planned'
    | 'income_actual'
    | 'income_variable_pay'
    | 'expenses_planned'
    | 'expenses_actual'
    | 'cost_of_debt'
    | 'other_imported_activity'
    | 'assets'
    | 'liabilities'
    | 'investments'
    | 'retirement';
  title: string;
  measure: AppendixMeasure;
  rows: AppendixRow[];
  /** Sum of the COUNTED rows' reporting amounts. */
  countedTotal: number;
}

export interface NotInCalculationsItem {
  label: string;
  count: number;
  total: number;
}

export interface CanonicalAppendix {
  version: typeof CANONICAL_APPENDIX_VERSION;
  reportingCurrency: string;
  window: { from: string; to: string; coveredMonths: string[] } | null;
  tables: AppendixTable[];
  reconciliation: {
    income: { plannedGrossMonthly: number; actualCountedMonthly: number; variablePayMonthly: number; combinedGrossMonthly: number } | null;
    expenses: {
      plannedMonthly: number;
      actualMonthly: number;
      combinedMonthly: number;
      byGroup: { group: string; label: string; basis: 'actual' | 'planned' | 'none'; monthly: number }[];
    } | null;
    netWorth: { assets: number; investments: number; retirement: number; liabilities: number } | null;
  };
  notInCalculations: NotInCalculationsItem[];
  /** Sections that could not be read -- shown as unavailable, never as empty. */
  unavailable: string[];
}

const round = (n: number) => Math.round(n * 100) / 100;
const sumCounted = (rows: AppendixRow[]) => round(rows.filter((r) => r.counted).reduce((s, r) => s + (r.amountReporting ?? 0), 0));

const PLANNED_EXCLUSION_TEXT: Record<string, string> = {
  superseded_by_bank_import: 'Not counted: you marked this as replaced by imported bank data',
  smsf_owned: "Not counted: SMSF-owned (the fund's, not the household's)",
  debt_service_duplicate: 'Not counted here: already counted once as a loan repayment',
  unconverted: 'Not counted: currency cannot be converted',
};

function table(key: AppendixTable['key'], title: string, measure: AppendixMeasure, rows: AppendixRow[]): AppendixTable {
  return { key, title, measure, rows, countedTotal: sumCounted(rows) };
}

export function buildCanonicalAppendix(snapshot: CanonicalFinancialSnapshot): CanonicalAppendix {
  const tables: AppendixTable[] = [];
  const unavailable: string[] = [];
  const notInCalculations: NotInCalculationsItem[] = [];
  const reconciliation: CanonicalAppendix['reconciliation'] = { income: null, expenses: null, netWorth: null };

  // ---- Income ---------------------------------------------------------------
  const income = snapshot.income;
  if (income.status === 'ok') {
    tables.push(table('income_planned', 'Income sources (monthly)', 'monthly', income.planned.lines.map((l) => ({
      name: l.name,
      detail: l.frequency,
      amountNative: l.grossNative,
      currency: l.currency,
      amountReporting: l.grossMonthly,
      provenance: l.provenance.label,
      counted: l.excludedReason === null,
      note: l.excludedReason ? PLANNED_EXCLUSION_TEXT[l.excludedReason] ?? `Not counted: ${l.excludedReason}` : null,
    }))));
    tables.push(table('income_actual', 'Imported income (approved statement lines)', 'transaction', income.actual.lines.map((l) => ({
      name: l.description ?? l.categoryLabel ?? 'Income',
      detail: l.date,
      amountNative: l.amountNative,
      currency: l.currency,
      amountReporting: l.amountReporting,
      provenance: l.provenance.label,
      counted: l.treatment === 'counted' && l.amountReporting !== null,
      note: l.treatment === 'represented_by_planned_source'
        ? 'Not counted again: the same money as an Applied payslip income source'
        : l.possibleDuplicateOf.length > 0
          ? `Counted; possible duplicate of ${l.possibleDuplicateOf.map((d) => d.name).join(', ')} -- please review`
          : l.amountReporting === null ? 'Not counted: currency cannot be converted' : null,
    }))));
    if (income.actual.variablePay.lines.length > 0) {
      tables.push(table('income_variable_pay', 'Variable pay from Applied payslips', 'transaction', income.actual.variablePay.lines.map((v) => ({
        name: v.employerName ?? 'Variable pay',
        detail: v.date,
        amountNative: v.grossNative,
        currency: v.currency,
        amountReporting: v.grossReporting,
        provenance: v.provenance.label,
        counted: v.grossReporting !== null,
        note: null,
      }))));
    }
    reconciliation.income = {
      plannedGrossMonthly: income.planned.grossMonthly,
      actualCountedMonthly: income.actual.countedMonthly,
      variablePayMonthly: income.actual.variablePay.grossMonthly,
      combinedGrossMonthly: income.combined.grossMonthly,
    };
  } else {
    unavailable.push('income');
  }

  // ---- Expenses -------------------------------------------------------------
  const expenses = snapshot.expenses;
  if (expenses.status === 'ok') {
    tables.push(table('expenses_planned', 'Planned expenses (monthly)', 'monthly', expenses.planned.lines.map((l) => ({
      name: l.name,
      detail: l.frequency,
      amountNative: l.amountNative,
      currency: l.currency,
      amountReporting: l.monthlyReporting,
      provenance: l.provenance.label,
      counted: l.excludedReason === null,
      note: l.excludedReason ? PLANNED_EXCLUSION_TEXT[l.excludedReason] ?? `Not counted: ${l.excludedReason}` : null,
    }))));
    const spendingRows: AppendixRow[] = expenses.actual.lines.map((l) => ({
      name: l.description ?? l.categoryLabel ?? 'Expense',
      detail: `${l.date} · ${l.categoryLabel ?? l.group}`,
      amountNative: l.amountNative,
      currency: l.currency,
      amountReporting: l.amountReporting,
      provenance: l.provenance.label,
      counted: l.amountReporting !== null,
      note: l.amountReporting === null ? 'Not counted: currency cannot be converted' : l.coverage === 'partial' ? 'Shown; its month is only partly covered by a statement, so it is not averaged' : null,
    }));
    const refundRows: AppendixRow[] = expenses.actual.refundsNetted.items.map((n) => ({
      name: n.refund.description ?? 'Refund',
      detail: `${n.refund.date} · refund of an earlier purchase`,
      amountNative: -n.refund.amountNative,
      currency: n.refund.currency,
      amountReporting: n.refund.amountReporting === null ? null : -n.refund.amountReporting,
      provenance: n.refund.provenance.label,
      counted: n.refund.amountReporting !== null,
      note: 'Netted against the original purchase (confirmed refund link)',
    }));
    tables.push(table('expenses_actual', 'Imported spending (approved statement lines, in the period)', 'transaction', [...spendingRows, ...refundRows]));
    if (expenses.actual.costOfDebtLines.length > 0) {
      tables.push(table('cost_of_debt', 'Cost of debt (interest and fees -- counted once, in debt service)', 'transaction', expenses.actual.costOfDebtLines.map((l) => ({
        name: l.description ?? l.categoryLabel ?? 'Interest / fee',
        detail: `${l.date} · ${l.accountName ?? l.accountType ?? ''}`.trim(),
        amountNative: l.amountNative,
        currency: l.currency,
        amountReporting: l.amountReporting,
        provenance: l.provenance.label,
        counted: l.amountReporting !== null,
        note: 'Counted in debt service, not in spending',
      }))));
    }
    reconciliation.expenses = {
      plannedMonthly: expenses.planned.monthly,
      actualMonthly: expenses.actual.monthly,
      combinedMonthly: expenses.combined.monthly,
      byGroup: expenses.combined.byGroup.map((g) => ({ group: g.group, label: g.label, basis: g.basis, monthly: g.monthly })),
    };
    if (expenses.actual.refundsUnlinked.count > 0) {
      notInCalculations.push({ label: 'Refunds with no confirmed link to a purchase (shown, not netted)', count: expenses.actual.refundsUnlinked.count, total: expenses.actual.refundsUnlinked.totalInWindow });
    }
    if (expenses.actual.unknownPendingCount > 0) {
      notInCalculations.push({ label: 'Imported lines still unknown or awaiting approval (never counted)', count: expenses.actual.unknownPendingCount, total: 0 });
    }
  } else {
    unavailable.push('expenses');
  }

  // Every other approved imported line (transfers, card repayments, cash,
  // investment funding, principal, asset sales): listed, labelled, not
  // income or spending.
  if (snapshot.ledger.status === 'ok') {
    const other = snapshot.ledger.value.lines.filter((l) => l.household && l.bucket !== 'spending' && l.bucket !== 'income' && l.bucket !== 'cost_of_debt');
    if (other.length > 0) {
      tables.push(table('other_imported_activity', 'Other imported activity (not income or spending)', 'transaction', other.map((l) => ({
        name: l.description ?? l.categoryLabel ?? 'Activity',
        detail: `${l.date} · ${NON_SPENDING_LABELS[l.bucket as NonSpendingBucket] ?? 'Not yet categorised'}`,
        amountNative: l.amountNative,
        currency: l.currency,
        amountReporting: l.amountReporting,
        provenance: l.provenance.label,
        counted: false,
        note: l.bucket === 'cash_withdrawal' ? 'Cash — spending unknown' : 'Not income or spending',
      }))));
    }
  }

  // ---- Balance sheet (Net Worth) ----------------------------------------------
  const { assets, investments, retirement, liabilities } = snapshot;
  if (assets.status === 'ok') {
    tables.push(table('assets', 'Assets', 'balance', assets.lines.map((l) => ({
      name: l.name, detail: l.assetClass, amountNative: l.value.amountNative, currency: l.value.currency, amountReporting: l.value.amountReporting,
      provenance: l.provenance.label, counted: l.value.amountReporting !== null, note: l.value.amountReporting === null ? 'Not counted: currency cannot be converted' : null,
    }))));
    if (assets.bankBalanceEvidence.accounts.length > 0) {
      notInCalculations.push({ label: assets.bankBalanceEvidence.label, count: assets.bankBalanceEvidence.accounts.length, total: assets.bankBalanceEvidence.total });
    }
  } else unavailable.push('assets');
  if (investments.status === 'ok') {
    tables.push(table('investments', 'Investments', 'balance', investments.lines.map((l) => ({
      name: l.name, detail: l.investmentType, amountNative: l.value.amountNative, currency: l.value.currency, amountReporting: l.value.amountReporting,
      provenance: l.provenance.label, counted: l.value.amountReporting !== null, note: l.value.amountReporting === null ? 'Not counted: currency cannot be converted' : null,
    }))));
    if (investments.unpublished.count > 0) {
      notInCalculations.push({ label: investments.unpublished.label, count: investments.unpublished.count, total: investments.unpublished.total });
    }
  } else unavailable.push('investments');
  if (retirement.status === 'ok') {
    tables.push(table('retirement', 'Retirement accounts', 'balance', retirement.lines.map((l) => ({
      name: l.name, detail: l.accountType, amountNative: l.balance.amountNative, currency: l.balance.currency, amountReporting: l.balance.amountReporting,
      provenance: l.provenance.label, counted: l.balance.amountReporting !== null, note: l.balance.amountReporting === null ? 'Not counted: currency cannot be converted' : null,
    }))));
  } else unavailable.push('retirement');
  if (liabilities.status === 'ok') {
    tables.push(table('liabilities', 'Liabilities', 'balance', liabilities.lines.map((l) => ({
      name: l.name, detail: l.debtType, amountNative: l.balance.amountNative, currency: l.balance.currency, amountReporting: l.balance.amountReporting,
      provenance: l.provenance.label, counted: l.balance.amountReporting !== null, note: l.balance.amountReporting === null ? 'Not counted: currency cannot be converted' : null,
    }))));
  } else unavailable.push('liabilities');
  if (assets.status === 'ok' && investments.status === 'ok' && retirement.status === 'ok' && liabilities.status === 'ok') {
    reconciliation.netWorth = { assets: assets.total, investments: investments.publishedTotal, retirement: retirement.totalBalance, liabilities: liabilities.totalBalance };
  }

  const expensesWindow = expenses.status === 'ok' ? expenses : null;
  return {
    version: CANONICAL_APPENDIX_VERSION,
    reportingCurrency: snapshot.fx.reportingCurrency,
    window: expensesWindow ? { from: expensesWindow.window.from, to: expensesWindow.window.to, coveredMonths: expensesWindow.coverage.coveredMonths } : { from: snapshot.window.from, to: snapshot.window.to, coveredMonths: [] },
    tables,
    reconciliation,
    notInCalculations,
    unavailable,
  };
}

/** Narrow a stored sectionData.canonical value (old reports have none). */
export function isCanonicalAppendix(value: unknown): value is CanonicalAppendix {
  return Boolean(value) && typeof value === 'object' && (value as { version?: unknown }).version === CANONICAL_APPENDIX_VERSION && Array.isArray((value as { tables?: unknown }).tables);
}
