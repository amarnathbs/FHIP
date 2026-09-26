/**
 * selectExpenses -- THE canonical Expense read model (WP-02; contract:
 * CANONICAL_EXPENSE_DATA_CONTRACT.md (in the FDH docs folder)).
 *
 *  - PLANNED = expense_items, the manual recurring assumptions. Unchanged by
 *    any import (nothing is ever copied into expense_items -- PO D-02).
 *  - ACTUAL  = approved fdh_transactions (+ allocations and links), through
 *    core/spendingRules, averaged over COMPLETE covered months in the window.
 *  - COMBINED = per canonical group, actual when the group has covered actual
 *    lines, otherwise planned. NEVER planned + actual for the same group.
 *
 * Every consumer picks its basis explicitly (the contract lists who uses
 * which). `computeExpenses` is pure and is what the oracle tests exercise;
 * `selectExpenses` only loads rows and calls it.
 */
import '@/lib/serverOnly';
import { toMonthly, type Frequency } from '@/lib/engines/money';
import { isDuplicateDebtServiceExpense, servicedDebtFamilies } from '@/lib/engines/debtServiceContext';
import { CANONICAL_EXPENSE_GROUPS, EXPENSE_GROUP_LABELS, groupForExpenseItem, type CanonicalExpenseGroup } from './core/categoryGroups';
import { resolveContext, type ReadModelOptions } from './core/context';
import { liabilitiesWithOwnerOverride, loadLiabilityRows, type LiabilityRow, type LoadedLiabilities } from './liabilities';
import { toReporting, type FxContext, type ReportingCurrency } from './core/currency';
import { coveredMonthlyAverage, type ActualLine, type NormalisedLedger, type RefundNetting } from './core/ledger';
import { fetchAllRows, type ReadModelClient } from './core/paginate';
import { NON_SPENDING_BUCKETS, NON_SPENDING_LABELS, type NonSpendingBucket } from './core/spendingRules';
import { addUnconverted, emptyUnconverted, isHouseholdOwner, provenance, roundMoney, toUnavailable, type Provenance, type ReadModelResult, type UnconvertedTally } from './core/types';
import type { AccountMonthCoverage } from './core/coverage';
import type { ReadWindow } from './core/window';

export type ExpenseBasis = 'planned' | 'actual' | 'combined';

export interface ExpenseItemRow {
  id: string;
  expense_name: string;
  expense_category: string | null;
  amount: number;
  frequency: string;
  currency_code: string;
  is_essential: boolean;
  master_item_key: string | null;
  owner: string | null;
  superseded_by_bank_import: boolean | null;
}

export type PlannedExclusion = 'superseded_by_bank_import' | 'smsf_owned' | 'debt_service_duplicate' | 'unconverted';

export interface PlannedExpenseLine {
  id: string;
  name: string;
  group: CanonicalExpenseGroup;
  groupUnmapped: boolean;
  essential: boolean;
  frequency: string;
  owner: string | null;
  amountNative: number;
  currency: string;
  monthlyNative: number;
  monthlyReporting: number | null;
  /** null = counted. Otherwise why this row is left out of every planned total. */
  excludedReason: PlannedExclusion | null;
  provenance: Provenance;
}

export interface GroupFigure {
  group: CanonicalExpenseGroup;
  label: string;
  monthly: number;
  essentialMonthly: number;
  lifestyleMonthly: number;
}

export interface CombinedGroupFigure extends GroupFigure {
  /** Which side the combined figure took (never both). */
  basis: 'actual' | 'planned' | 'none';
  plannedMonthly: number;
  actualMonthly: number;
  /** actual - planned, when both sides exist; null otherwise. For display only. */
  varianceMonthly: number | null;
}

export interface BucketFigure {
  bucket: NonSpendingBucket;
  label: string;
  monthly: number;
  totalInWindow: number;
  count: number;
}

export interface ExpensesReadModelData {
  window: ReadWindow;
  reportingCurrency: ReportingCurrency;
  planned: {
    lines: PlannedExpenseLine[];
    byGroup: GroupFigure[];
    monthly: number;
    essentialMonthly: number;
    lifestyleMonthly: number;
    unconverted: UnconvertedTally;
  };
  actual: {
    /** Counted household spending lines (covered and partial months). */
    lines: ActualLine[];
    byGroup: (GroupFigure & { coveredLineCount: number })[];
    /** Monthly average over covered months (the figure consumers use). */
    monthly: number;
    essentialMonthly: number;
    lifestyleMonthly: number;
    /** Sum of every counted spending line in the window, covered or partial. */
    totalInWindow: number;
    partialLineCount: number;
    refundsNetted: { count: number; monthly: number; totalInWindow: number; items: RefundNetting[] };
    refundsUnlinked: { count: number; totalInWindow: number; lines: ActualLine[] };
    nonSpending: BucketFigure[];
    /** Interest + fees on card/loan facilities: shown as "Cost of debt", counted once via debt service. */
    costOfDebtLines: ActualLine[];
    /** Approved 'unknown' parts + rows still awaiting approval: never counted, never categorised. */
    unknownPendingCount: number;
    excludedDuplicates: number;
    /** Lines on SMSF-owned accounts: the fund's, not the household's. */
    excludedNonHouseholdCount: number;
    unconverted: UnconvertedTally;
    ownerAttributionAvailable: boolean;
  };
  combined: {
    byGroup: CombinedGroupFigure[];
    monthly: number;
    essentialMonthly: number;
    lifestyleMonthly: number;
  };
  coverage: { rows: AccountMonthCoverage[]; coveredMonths: string[]; partialMonths: string[] };
  flags: { hasPlanned: boolean; hasActual: boolean; hasAny: boolean };
  /** Convenience: the figures for the basis the caller asked for. */
  selected: { basis: ExpenseBasis; monthly: number; essentialMonthly: number; lifestyleMonthly: number };
}

export type ExpensesReadModel = ReadModelResult<ExpensesReadModelData>;

const r = roundMoney;

// ---------------------------------------------------------------------------
// Pure computation
// ---------------------------------------------------------------------------

export function computePlannedExpenses(
  rows: readonly ExpenseItemRow[],
  liabilities: readonly Pick<LiabilityRow, 'debt_type' | 'master_item_key' | 'monthly_repayment' | 'owner'>[],
  fx: FxContext,
): ExpensesReadModelData['planned'] {
  const householdLiabilities = liabilities.filter((l) => isHouseholdOwner(l.owner));
  const serviced = servicedDebtFamilies(householdLiabilities);
  const unconverted = emptyUnconverted();
  const lines: PlannedExpenseLine[] = rows.map((row) => {
    const { group, unmapped } = groupForExpenseItem(row.master_item_key, row.expense_category);
    const monthlyNative = r(toMonthly(Number(row.amount), row.frequency as Frequency) || 0);
    const monthlyReporting = toReporting(monthlyNative, row.currency_code, fx);
    let excludedReason: PlannedExclusion | null = null;
    if (row.superseded_by_bank_import) excludedReason = 'superseded_by_bank_import';
    else if (!isHouseholdOwner(row.owner)) excludedReason = 'smsf_owned';
    else if (isDuplicateDebtServiceExpense(row, serviced)) excludedReason = 'debt_service_duplicate';
    else if (monthlyReporting === null) excludedReason = 'unconverted';
    if (excludedReason === 'unconverted') addUnconverted(unconverted, row.currency_code, monthlyNative);
    return {
      id: row.id, name: row.expense_name, group, groupUnmapped: unmapped, essential: Boolean(row.is_essential), frequency: row.frequency,
      owner: row.owner, amountNative: Number(row.amount), currency: row.currency_code, monthlyNative, monthlyReporting, excludedReason,
      provenance: provenance('manual'),
    };
  });
  const byGroup = new Map<CanonicalExpenseGroup, GroupFigure>();
  for (const l of lines) {
    if (l.excludedReason || l.monthlyReporting === null) continue;
    const g = byGroup.get(l.group) ?? { group: l.group, label: EXPENSE_GROUP_LABELS[l.group], monthly: 0, essentialMonthly: 0, lifestyleMonthly: 0 };
    g.monthly = r(g.monthly + l.monthlyReporting);
    if (l.essential) g.essentialMonthly = r(g.essentialMonthly + l.monthlyReporting);
    else g.lifestyleMonthly = r(g.lifestyleMonthly + l.monthlyReporting);
    byGroup.set(l.group, g);
  }
  const groups = orderGroups([...byGroup.values()]);
  return {
    lines,
    byGroup: groups,
    monthly: r(groups.reduce((s, g) => s + g.monthly, 0)),
    essentialMonthly: r(groups.reduce((s, g) => s + g.essentialMonthly, 0)),
    lifestyleMonthly: r(groups.reduce((s, g) => s + g.lifestyleMonthly, 0)),
    unconverted,
  };
}

function orderGroups<T extends { group: CanonicalExpenseGroup }>(list: T[]): T[] {
  return [...list].sort((a, b) => CANONICAL_EXPENSE_GROUPS.indexOf(a.group) - CANONICAL_EXPENSE_GROUPS.indexOf(b.group));
}

export function computeActualExpenses(ledger: NormalisedLedger): ExpensesReadModelData['actual'] {
  const householdLines = ledger.lines.filter((l) => l.household);
  const spending = householdLines.filter((l) => l.bucket === 'spending');
  const netted = ledger.nettedRefunds.filter((n) => n.refund.household);
  const excludedNonHouseholdCount = ledger.lines.filter((l) => !l.household).length;

  // Per-group averages: spending lines (+) and netted refunds (-) of that group.
  const groups = new Set<CanonicalExpenseGroup>([...spending.map((l) => l.group), ...netted.map((n) => n.group)]);
  const byGroup: (GroupFigure & { coveredLineCount: number })[] = [];
  for (const group of groups) {
    const lines = spending.filter((l) => l.group === group);
    // A netted refund reduces its ORIGINAL purchase's group and essential flag.
    const entries = [
      ...lines.map((l) => ({ accountId: l.accountId, coverage: l.coverage, household: l.household, amountReporting: l.amountReporting, essential: l.essential })),
      ...netted.filter((n) => n.group === group).map((n) => ({
        accountId: n.refund.accountId, coverage: n.refund.coverage, household: n.refund.household,
        amountReporting: n.refund.amountReporting === null ? null : -n.refund.amountReporting, essential: n.essential,
      })),
    ];
    const monthly = coveredMonthlyAverage(ledger, entries);
    const essentialMonthly = coveredMonthlyAverage(ledger, entries.filter((e) => e.essential));
    byGroup.push({
      group,
      label: EXPENSE_GROUP_LABELS[group],
      monthly,
      essentialMonthly,
      lifestyleMonthly: r(monthly - essentialMonthly),
      coveredLineCount: lines.filter((l) => l.coverage === 'covered').length,
    });
  }
  const orderedGroups = orderGroups(byGroup);
  const nettedLines = netted.map((n) => n.refund);
  const nonSpending: BucketFigure[] = NON_SPENDING_BUCKETS.map((bucket) => {
    const ls = householdLines.filter((l) => l.bucket === bucket);
    return {
      bucket,
      label: NON_SPENDING_LABELS[bucket],
      monthly: coveredMonthlyAverage(ledger, ls),
      totalInWindow: r(ls.reduce((s, l) => s + (l.amountReporting ?? 0), 0)),
      count: ls.length,
    };
  });
  return {
    lines: spending,
    byGroup: orderedGroups,
    monthly: r(orderedGroups.reduce((s, g) => s + g.monthly, 0)),
    essentialMonthly: r(orderedGroups.reduce((s, g) => s + g.essentialMonthly, 0)),
    lifestyleMonthly: r(orderedGroups.reduce((s, g) => s + g.lifestyleMonthly, 0)),
    totalInWindow: r(spending.reduce((s, l) => s + (l.amountReporting ?? 0), 0) - nettedLines.reduce((s, l) => s + (l.amountReporting ?? 0), 0)),
    partialLineCount: spending.filter((l) => l.coverage === 'partial').length,
    refundsNetted: {
      count: nettedLines.length,
      monthly: coveredMonthlyAverage(ledger, nettedLines),
      totalInWindow: r(nettedLines.reduce((s, l) => s + (l.amountReporting ?? 0), 0)),
      items: netted,
    },
    refundsUnlinked: {
      count: ledger.unlinkedRefunds.filter((l) => l.household).length,
      totalInWindow: r(ledger.unlinkedRefunds.filter((l) => l.household).reduce((s, l) => s + (l.amountReporting ?? 0), 0)),
      lines: ledger.unlinkedRefunds.filter((l) => l.household),
    },
    nonSpending,
    costOfDebtLines: householdLines.filter((l) => l.bucket === 'cost_of_debt'),
    unknownPendingCount: ledger.unknownLineCount + ledger.pendingApprovalCount,
    excludedDuplicates: ledger.excludedDuplicates,
    excludedNonHouseholdCount,
    unconverted: ledger.unconverted,
    ownerAttributionAvailable: ledger.ownerAttributionAvailable,
  };
}

export function computeCombinedExpenses(planned: ExpensesReadModelData['planned'], actual: ExpensesReadModelData['actual']): ExpensesReadModelData['combined'] {
  const groups = new Set<CanonicalExpenseGroup>([...planned.byGroup.map((g) => g.group), ...actual.byGroup.map((g) => g.group)]);
  const byGroup: CombinedGroupFigure[] = [];
  for (const group of groups) {
    const p = planned.byGroup.find((g) => g.group === group);
    const a = actual.byGroup.find((g) => g.group === group);
    // PO D-02: a group with covered actual activity uses the actual average;
    // otherwise the plan. Never both.
    const useActual = Boolean(a && a.coveredLineCount > 0);
    const side = useActual ? a! : p;
    byGroup.push({
      group,
      label: EXPENSE_GROUP_LABELS[group],
      basis: useActual ? 'actual' : p ? 'planned' : 'none',
      monthly: side?.monthly ?? 0,
      essentialMonthly: side?.essentialMonthly ?? 0,
      lifestyleMonthly: side?.lifestyleMonthly ?? 0,
      plannedMonthly: p?.monthly ?? 0,
      actualMonthly: a?.monthly ?? 0,
      varianceMonthly: p && a && a.coveredLineCount > 0 ? r(a.monthly - p.monthly) : null,
    });
  }
  const ordered = orderGroups(byGroup);
  return {
    byGroup: ordered,
    monthly: r(ordered.reduce((s, g) => s + g.monthly, 0)),
    essentialMonthly: r(ordered.reduce((s, g) => s + g.essentialMonthly, 0)),
    lifestyleMonthly: r(ordered.reduce((s, g) => s + g.lifestyleMonthly, 0)),
  };
}

export interface ComputeExpensesInput {
  plannedRows: readonly ExpenseItemRow[];
  liabilities: readonly Pick<LiabilityRow, 'debt_type' | 'master_item_key' | 'monthly_repayment' | 'owner'>[];
  ledger: NormalisedLedger;
  fx: FxContext;
  basis?: ExpenseBasis;
}

export function computeExpenses(input: ComputeExpensesInput): ExpensesReadModelData {
  const planned = computePlannedExpenses(input.plannedRows, input.liabilities, input.fx);
  const actual = computeActualExpenses(input.ledger);
  const combined = computeCombinedExpenses(planned, actual);
  const basis = input.basis ?? 'combined';
  const pick = basis === 'planned' ? planned : basis === 'actual' ? actual : combined;
  const hasPlanned = planned.lines.some((l) => l.excludedReason === null);
  const hasActual = actual.lines.length > 0;
  return {
    window: input.ledger.window,
    reportingCurrency: input.fx.reportingCurrency,
    planned,
    actual,
    combined,
    coverage: { rows: input.ledger.coverage.rows, coveredMonths: input.ledger.coverage.coveredMonths, partialMonths: input.ledger.coverage.partialMonths },
    flags: { hasPlanned, hasActual, hasAny: hasPlanned || hasActual },
    selected: { basis, monthly: pick.monthly, essentialMonthly: pick.essentialMonthly, lifestyleMonthly: pick.lifestyleMonthly },
  };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loadExpenseItems(userId: string, client: ReadModelClient): Promise<ExpenseItemRow[]> {
  return fetchAllRows<ExpenseItemRow>('expense_items', (from, to) =>
    client
      .from('expense_items')
      .select('id, expense_name, expense_category, amount, frequency, currency_code, is_essential, master_item_key, owner, superseded_by_bank_import')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('id', { ascending: true })
      .range(from, to));
}

/**
 * THE Expense selector. Loads planned rows, the household's liabilities (for
 * the debt-service duplicate rule) and the shared ledger, then computes.
 * Any failed read -> { status: 'unavailable' }, never zeros.
 */
export async function selectExpenses(
  userId: string,
  opts: ReadModelOptions & { basis?: ExpenseBasis; liabilities?: LoadedLiabilities },
): Promise<ExpensesReadModel> {
  try {
    const ctx = await resolveContext(userId, opts);
    const [plannedRows, loadedLiabilities, ledger] = await Promise.all([
      loadExpenseItems(userId, ctx.client),
      opts.liabilities ? Promise.resolve(opts.liabilities) : loadLiabilityRows(userId, ctx.client),
      ctx.ledger(),
    ]);
    return {
      status: 'ok',
      ...computeExpenses({ plannedRows, liabilities: liabilitiesWithOwnerOverride(loadedLiabilities), ledger, fx: ctx.fx, basis: opts.basis }),
    };
  } catch (error) {
    return toUnavailable(error, 'selectExpenses');
  }
}
