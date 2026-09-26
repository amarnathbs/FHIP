/**
 * WP-03: maps ONE CanonicalFinancialSnapshot (lib/read-models) into the plain
 * CanonicalCashFlowInput the Dashboard engine takes.
 *
 * The engine (lib/engines/dashboard.ts) is imported by client components, so
 * it can never import a read model at runtime; this server-only adapter is
 * the single place the read models' shapes are translated for it. It does no
 * arithmetic of its own beyond regrouping the selectors' already-computed
 * figures -- every total is the selector's.
 *
 * Bases (CANONICAL_EXPENSE_DATA_CONTRACT.md, consumer table):
 *   income   -> selectIncome().combined (planned + counted actual + D-06 variable pay)
 *   expenses -> selectExpenses().combined (per group: actual when covered, else planned)
 *   debt     -> selectLiabilities().householdDebtServiceMonthly (D-08 / D-09)
 */
import '@/lib/serverOnly';
import {
  CORE_SURVIVAL_EXPENSE_KEYS,
  type CanonicalCashFlowInput,
  type CanonicalExpenseFigures,
  type CanonicalExpenseLine,
  type CanonicalIncomeFigures,
  type CanonicalIncomeLine,
  type CanonicalUnavailable,
} from '@/lib/engines/dashboard';
import type { CanonicalFinancialSnapshot, CanonicalFinancialSnapshotResult } from '@/lib/read-models/snapshot';
import type { ExpensesReadModelData } from '@/lib/read-models/expenses';
import type { IncomeReadModelData } from '@/lib/read-models/income';
import { householdDebtServiceUnderD08 } from '@/lib/read-models/liabilities';
import { groupForExpenseItem, type CanonicalExpenseGroup } from '@/lib/read-models/core/categoryGroups';
import { coveredMonthlyAverage, type NormalisedLedger } from '@/lib/read-models/core/ledger';
import { roundMoney, type ReadModelUnavailable } from '@/lib/read-models/core/types';

const unavailable = (u: ReadModelUnavailable): CanonicalUnavailable => ({ status: 'unavailable', reason: u.reason, source: u.source });

/** The canonical groups the Dashboard's core-survival master items fall in. */
export const CORE_SURVIVAL_GROUPS: ReadonlySet<CanonicalExpenseGroup> = new Set(
  [...CORE_SURVIVAL_EXPENSE_KEYS].map((key) => groupForExpenseItem(key).group),
);

function mergeUnconverted(...tallies: { count: number; byCurrency: Record<string, number> }[]) {
  const out = { count: 0, byCurrency: {} as Record<string, number> };
  for (const t of tallies) {
    out.count += t.count;
    for (const [code, amount] of Object.entries(t.byCurrency)) out.byCurrency[code] = roundMoney((out.byCurrency[code] ?? 0) + amount);
  }
  return out;
}

export function incomeFigures(income: IncomeReadModelData, ledger: NormalisedLedger | null): CanonicalIncomeFigures {
  const counted = income.planned.lines.filter((l) => l.excludedReason === null);
  const lines: CanonicalIncomeLine[] = counted.map((l) => ({
    name: l.name,
    monthly: l.grossMonthly ?? 0,
    employerName: l.employerName,
    masterItemKey: l.masterItemKey,
    source: 'planned',
  }));
  // Imported credits: one line per category label, averaged over covered months.
  const countedActual = income.actual.lines.filter((l) => l.treatment === 'counted');
  if (ledger) {
    const byLabel = new Map<string, typeof countedActual>();
    for (const l of countedActual) {
      const label = l.categoryLabel ?? 'Income';
      if (!byLabel.has(label)) byLabel.set(label, []);
      byLabel.get(label)!.push(l);
    }
    for (const [label, ls] of byLabel) {
      const monthly = coveredMonthlyAverage(ledger, ls);
      if (monthly !== 0) lines.push({ name: `${label} (imported)`, monthly, employerName: null, masterItemKey: null, source: 'actual' });
    }
  }
  if (income.actual.variablePay.grossMonthly > 0) {
    lines.push({ name: 'Variable pay (payslip)', monthly: income.actual.variablePay.grossMonthly, employerName: null, masterItemKey: null, source: 'variable_pay' });
  }
  // hasIncome keeps the pre-programme meaning for planned rows (any household,
  // non-superseded row -- even one whose currency cannot be converted) and
  // adds imported income that actually reaches the figure (a covered month).
  const plannedPresent = income.planned.lines.some((l) => l.excludedReason === null || l.excludedReason === 'unconverted');
  const actualPresent = countedActual.some((l) => l.coverage === 'covered') || income.actual.variablePay.lines.length > 0;
  return {
    status: 'ok',
    grossMonthly: income.combined.grossMonthly,
    netKnownMonthly: income.combined.netKnownMonthly,
    netUnknownComponents: income.combined.netUnknownComponents,
    grossIncludesNetFloor: income.combined.grossIncludesNetFloor,
    importedMonthly: income.actual.countedMonthly,
    lines,
    present: plannedPresent || actualPresent,
    possibleDuplicateCount: income.actual.possibleDuplicateCount,
    representedCount: income.actual.representedCount,
    unconverted: mergeUnconverted(income.planned.unconverted, income.actual.unconverted),
  };
}

export function expenseFigures(expenses: ExpensesReadModelData): CanonicalExpenseFigures {
  const lines: CanonicalExpenseLine[] = [];
  let coreSurvival = 0;
  let imported = 0;
  for (const g of expenses.combined.byGroup) {
    if (g.basis === 'actual') {
      imported += g.monthly;
      if (g.monthly !== 0) lines.push({ name: g.label, monthly: g.monthly, source: 'actual' });
      if (CORE_SURVIVAL_GROUPS.has(g.group)) coreSurvival += g.essentialMonthly;
    } else if (g.basis === 'planned') {
      for (const l of expenses.planned.lines) {
        if (l.group !== g.group || l.excludedReason !== null || l.monthlyReporting === null) continue;
        lines.push({ name: l.name, monthly: l.monthlyReporting, source: 'planned' });
        if (l.essential && l.masterItemKey && CORE_SURVIVAL_EXPENSE_KEYS.has(l.masterItemKey)) coreSurvival += l.monthlyReporting;
      }
    }
  }
  // hasExpenses: any household, non-superseded planned row (as before -- a
  // debt-service duplicate or an unconvertible row is still "on file"), or
  // imported spending that reaches the figure (a group with covered lines).
  // Partial-month-only imports are shown on the Expenses tab, never averaged,
  // so on their own they do not make a $0 expense figure look real.
  const plannedPresent = expenses.planned.lines.some((l) => l.excludedReason === null || l.excludedReason === 'debt_service_duplicate' || l.excludedReason === 'unconverted');
  const actualPresent = expenses.actual.byGroup.some((g) => g.coveredLineCount > 0);
  return {
    status: 'ok',
    monthly: expenses.combined.monthly,
    essentialMonthly: expenses.combined.essentialMonthly,
    lifestyleMonthly: expenses.combined.lifestyleMonthly,
    coreSurvivalMonthly: roundMoney(coreSurvival),
    importedMonthly: roundMoney(imported),
    lines,
    present: plannedPresent || actualPresent,
    unconverted: mergeUnconverted(expenses.planned.unconverted, expenses.actual.unconverted),
    unknownPendingCount: expenses.actual.unknownPendingCount,
    excludedDuplicates: expenses.actual.excludedDuplicates,
    partialLineCount: expenses.actual.partialLineCount,
    unlinkedRefundCount: expenses.actual.refundsUnlinked.count,
  };
}

/** D-08's premise: the household's consumption is counted as expense somewhere. */
export function consumptionCounted(expenses: Pick<ExpensesReadModelData, 'planned' | 'actual'>): boolean {
  return expenses.planned.lines.some((l) => l.excludedReason === null) || expenses.actual.byGroup.some((g) => g.coveredLineCount > 0);
}

/** Every cash-flow section unavailable for the same reason (e.g. the FX/profile read failed). */
export function allUnavailableCashFlow(u: ReadModelUnavailable): CanonicalCashFlowInput {
  const x = unavailable(u);
  return {
    income: x,
    expenses: x,
    debtService: x,
    window: null,
    otherUnavailable: [{ section: 'balance_sheet', reason: u.reason, source: u.source }],
    importedNotInNetWorth: null,
    bankBalanceEvidence: null,
  };
}

export function toCanonicalCashFlow(snapshot: CanonicalFinancialSnapshotResult): CanonicalCashFlowInput {
  if (snapshot.status !== 'ok') return allUnavailableCashFlow(snapshot);
  const s: CanonicalFinancialSnapshot = snapshot;
  const ledger = s.ledger.status === 'ok' ? s.ledger.value : null;
  const otherUnavailable: CanonicalCashFlowInput['otherUnavailable'] = [];
  for (const [section, model] of [['investments', s.investments], ['retirement', s.retirement], ['assets', s.assets]] as const) {
    if (model.status !== 'ok') otherUnavailable.push({ section, reason: model.reason, source: model.source });
  }
  return {
    income: s.income.status === 'ok' ? incomeFigures(s.income, ledger) : unavailable(s.income),
    expenses: s.expenses.status === 'ok' ? expenseFigures(s.expenses) : unavailable(s.expenses),
    debtService: s.liabilities.status === 'ok'
      ? {
        status: 'ok',
        householdMonthly: householdDebtServiceUnderD08(s.liabilities, s.expenses.status === 'ok' ? consumptionCounted(s.expenses) : true),
        costOfDebtMonthly: s.liabilities.householdCostOfDebtMonthly,
        principalMonthly: s.liabilities.householdPrincipalMonthly,
      }
      : unavailable(s.liabilities),
    window: { from: s.window.from, to: s.window.to, months: s.window.months, coveredMonths: ledger ? ledger.coverage.coveredMonths : [] },
    otherUnavailable,
    importedNotInNetWorth: s.investments.status === 'ok' && s.investments.unpublished.count > 0
      ? { label: s.investments.unpublished.label, count: s.investments.unpublished.count, total: s.investments.unpublished.total }
      : null,
    bankBalanceEvidence: s.assets.status === 'ok' && s.assets.bankBalanceEvidence.accounts.length > 0
      ? { label: s.assets.bankBalanceEvidence.label, count: s.assets.bankBalanceEvidence.accounts.length, total: s.assets.bankBalanceEvidence.total }
      : null,
  };
}
