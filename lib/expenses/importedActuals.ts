/**
 * WP-07 -- the Expenses tab's "Actual (imported)" contract.
 *
 * ONE shape shared by the route (app/api/expenses/actuals/route.ts) and the
 * component (components/expenses/ImportedExpenseActuals.tsx), so the UI can
 * never read a field the route does not send (the snake_case/camelCase
 * blank-render trap -- tests/unit/expensesActualsRoute.test.ts pins it).
 *
 * The figures are the canonical Expense read model's (selectExpenses) and
 * nothing else: planned = expense_items, actual = approved imported
 * transactions, compared per canonical group and NEVER added (PO D-02).
 * Nothing here writes anything; an imported line is shown once, straight from
 * the approved transaction layer, and never copied into expense_items.
 *
 * Client-safe: type-only imports from the read models, plus pure builders.
 */
import type { ExpensesReadModelData } from '@/lib/read-models/expenses';
import type { NonSpendingBucket } from '@/lib/read-models/core/spendingRules';
import type { ProvenanceKind } from '@/lib/read-models/core/types';
import { fdhPages } from '@/lib/import-bridge/fdhRoutes';

export const DEFAULT_LINES_PAGE_SIZE = 100;
export const MAX_LINES_PAGE_SIZE = 500;

/** Expenses-tab wording for the non-spending buckets (never dropped, never summed into spending). */
export const EXPENSES_TAB_BUCKET_LABELS: Record<NonSpendingBucket, string> = {
  cash_withdrawal: 'Cash withdrawals — spending unknown',
  transfer: 'Transfers — not counted',
  cost_of_debt: 'Loan interest & fees — inside loan repayment',
  debt_principal: 'Loan principal repaid — reduces your debt, not spending',
  investment: 'Invested — not counted as spending',
  asset_purchase: 'Asset purchases — not counted as spending',
  asset_sale: 'Asset sales — not income',
};

export interface ImportedActualLineDto {
  key: string;
  date: string;
  month: string;
  description: string | null;
  group: string;
  groupLabel: string;
  categoryLabel: string | null;
  amount: number;
  currency: string;
  /** null = currency could not be converted; shown, never totalled. */
  amountReporting: number | null;
  /** 'covered' = inside a fully covered month (averaged); 'partial' = shown only. */
  coverage: 'covered' | 'partial';
  sourceKind: ProvenanceKind;
  sourceLabel: string;
  statementHref: string | null;
  accountName: string | null;
}

export interface ImportedActualGroupDto {
  group: string;
  label: string;
  /** null = no planned row in this group. */
  plannedMonthly: number | null;
  /** null = no covered actual activity in this group. */
  actualMonthly: number | null;
  /** actual - planned when both exist. */
  varianceMonthly: number | null;
  /** Which figure the household's combined view uses for this group (never both). */
  basis: 'actual' | 'planned' | 'none';
}

export interface ImportedActualBucketDto {
  bucket: NonSpendingBucket;
  label: string;
  monthly: number;
  totalInWindow: number;
  count: number;
}

export interface ImportedActualsOk {
  status: 'ok';
  reportingCurrency: string;
  window: { from: string; to: string; months: string[]; coveredMonths: string[]; partialMonths: string[] };
  groups: ImportedActualGroupDto[];
  totals: { plannedMonthly: number; actualMonthly: number; combinedMonthly: number; actualTotalInWindow: number };
  nonSpending: ImportedActualBucketDto[];
  refundsNetted: { count: number; totalInWindow: number };
  refundsUnlinked: { count: number; totalInWindow: number };
  unknownPendingCount: number;
  excludedDuplicates: number;
  partialLineCount: number;
  unconverted: { count: number; byCurrency: Record<string, number> };
  hasPlanned: boolean;
  hasActual: boolean;
  /** Filtered line count (before paging) and the page. */
  lineCount: number;
  page: number;
  pageSize: number;
  pageCount: number;
  /** Every month / group that has a line, for the filters. */
  lineMonths: string[];
  lineGroups: { group: string; label: string }[];
  lines: ImportedActualLineDto[];
}

export type ImportedActualsDto = ImportedActualsOk | { status: 'unavailable'; reason: string };

export interface LinesQuery {
  page?: number;
  pageSize?: number;
  group?: string | null;
  month?: string | null;
}

export function parseLinesQuery(params: URLSearchParams): Required<LinesQuery> {
  const page = Math.max(1, Math.floor(Number(params.get('page') ?? '1')) || 1);
  const rawSize = Math.floor(Number(params.get('pageSize') ?? String(DEFAULT_LINES_PAGE_SIZE))) || DEFAULT_LINES_PAGE_SIZE;
  const pageSize = Math.min(MAX_LINES_PAGE_SIZE, Math.max(1, rawSize));
  const group = params.get('group') || null;
  const month = params.get('month');
  return { page, pageSize, group, month: month && /^\d{4}-\d{2}$/.test(month) ? month : null };
}

/** Pure: read model -> the Expenses-tab DTO (one page of lines). */
export function toImportedActualsDto(data: ExpensesReadModelData, query: LinesQuery = {}): ImportedActualsOk {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(MAX_LINES_PAGE_SIZE, Math.max(1, query.pageSize ?? DEFAULT_LINES_PAGE_SIZE));
  const groupLabel = new Map<string, string>();
  for (const g of [...data.planned.byGroup, ...data.actual.byGroup, ...data.combined.byGroup]) groupLabel.set(g.group, g.label);

  const allLines = [...data.actual.lines].sort((a, b) => (a.date === b.date ? a.key.localeCompare(b.key) : a.date < b.date ? 1 : -1));
  const filtered = allLines.filter((l) => (!query.group || l.group === query.group) && (!query.month || l.month === query.month));
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const slice = filtered.slice((page - 1) * pageSize, page * pageSize);

  const groups: ImportedActualGroupDto[] = data.combined.byGroup.map((g) => {
    const planned = data.planned.byGroup.find((p) => p.group === g.group);
    const actual = data.actual.byGroup.find((a) => a.group === g.group && a.coveredLineCount > 0);
    return {
      group: g.group,
      label: g.label,
      plannedMonthly: planned ? planned.monthly : null,
      actualMonthly: actual ? actual.monthly : null,
      varianceMonthly: g.varianceMonthly,
      basis: g.basis,
    };
  });

  const seenGroups = new Map<string, string>();
  for (const l of allLines) if (!seenGroups.has(l.group)) seenGroups.set(l.group, groupLabel.get(l.group) ?? l.group);

  return {
    status: 'ok',
    reportingCurrency: data.reportingCurrency,
    window: { from: data.window.from, to: data.window.to, months: data.window.months, coveredMonths: data.coverage.coveredMonths, partialMonths: data.coverage.partialMonths },
    groups,
    totals: {
      plannedMonthly: data.planned.monthly,
      actualMonthly: data.actual.monthly,
      combinedMonthly: data.combined.monthly,
      actualTotalInWindow: data.actual.totalInWindow,
    },
    nonSpending: data.actual.nonSpending.map((b) => ({ bucket: b.bucket, label: EXPENSES_TAB_BUCKET_LABELS[b.bucket], monthly: b.monthly, totalInWindow: b.totalInWindow, count: b.count })),
    refundsNetted: { count: data.actual.refundsNetted.count, totalInWindow: data.actual.refundsNetted.totalInWindow },
    refundsUnlinked: { count: data.actual.refundsUnlinked.count, totalInWindow: data.actual.refundsUnlinked.totalInWindow },
    unknownPendingCount: data.actual.unknownPendingCount,
    excludedDuplicates: data.actual.excludedDuplicates,
    partialLineCount: data.actual.partialLineCount,
    unconverted: { count: data.actual.unconverted.count, byCurrency: { ...data.actual.unconverted.byCurrency } },
    hasPlanned: data.flags.hasPlanned,
    hasActual: data.flags.hasActual,
    lineCount: filtered.length,
    page: Math.min(page, pageCount),
    pageSize,
    pageCount,
    lineMonths: [...new Set(allLines.map((l) => l.month))].sort().reverse(),
    lineGroups: [...seenGroups.entries()].map(([group, label]) => ({ group, label })),
    lines: slice.map((l) => ({
      key: l.key,
      date: l.date,
      month: l.month,
      description: l.description,
      group: l.group,
      groupLabel: groupLabel.get(l.group) ?? l.group,
      categoryLabel: l.categoryLabel,
      amount: l.amountNative,
      currency: l.currency,
      amountReporting: l.amountReporting,
      coverage: l.coverage,
      sourceKind: l.provenance.kind,
      sourceLabel: l.provenance.label,
      statementHref: l.provenance.statementUploadId ? fdhPages.statementReview(l.provenance.statementUploadId, 'expenses') : null,
      accountName: l.accountName,
    })),
  };
}
