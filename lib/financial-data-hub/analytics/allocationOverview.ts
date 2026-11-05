/**
 * Financial Data Hub -- the "Income and expense allocation" on the Overview page (PO 04-11-2026): one main table of where the money came from and where it
 * went, by category, with a plain-words analysis written from the SAME figures.
 *
 * Pure (no I/O). Two invariants this file keeps:
 *  1. APPROVED and WAITING lines are computed by two separate passes and shown in two separate columns. Nothing here adds an approved amount to a waiting one
 *     (the Overview page's standing rule, financialActivityAnalytics.ts file header).
 *  2. The same inclusion rules as the certified totals: a confirmed duplicate is left out, a split transaction counts through its allocations, and money in of a
 *     spending type is a refund, never income and never negative spending (lib/read-models/core/spendingRules.ts). A test holds this file's income and spending
 *     totals equal to computeApprovedFinancialSummary on the same lines.
 * Exact money: every sum goes through minor units. Nothing is blended across currencies.
 */

import { bucketForType, isDuplicateExcluded } from '@/lib/read-models/core/spendingRules';
import type { ApprovedSummaryTransaction } from '../domain/approvedSummary';
import { fromMinorUnits, toMinorUnits } from '../domain/money';
import type { FdhEconomicTransactionType } from '../constants/enums';

export type AllocationSection = 'income' | 'spending' | 'not_counted' | 'needs_category';

export const ALLOCATION_SECTION_ORDER: readonly AllocationSection[] = ['income', 'spending', 'not_counted', 'needs_category'];
export const ALLOCATION_SECTION_TITLE: Record<AllocationSection, string> = {
  income: 'Income',
  spending: 'Spending',
  not_counted: 'Not counted as income or spending',
  needs_category: 'Needs a category',
};
export const ALLOCATION_SECTION_NOTE: Record<AllocationSection, string> = {
  income: 'Money that came in.',
  spending: 'Money that went out on living costs, fees, tax and interest.',
  not_counted: 'Moves between your own accounts, loans, investments, cash, and refunds. They change where your money is, not what you earned or spent.',
  needs_category: 'Lines nobody has given a category yet. They are in none of the totals above until one is chosen.',
};

export interface AllocationInputAllocation {
  amount: number;
  currency: string;
  economicType: FdhEconomicTransactionType;
  categoryId: string | null;
  subcategoryId?: string | null;
}

export interface AllocationInputTxn {
  creditDebit: 'credit' | 'debit';
  currency: string;
  /** Unsigned, as stored. */
  amount: number;
  economicType: FdhEconomicTransactionType;
  categoryId: string | null;
  /** The optional type under the category (Income > Salary & Wages). Detail only: it never changes which section or category a line is in. */
  subcategoryId?: string | null;
  dedupStatus: ApprovedSummaryTransaction['dedup_status'];
  allocations: AllocationInputAllocation[];
}

/** One type under a category row. The types of a row add up to that row; a line with no type chosen is the "No specific type" entry (subcategoryId null). */
export interface AllocationSubRow {
  subcategoryId: string | null;
  label: string;
  approvedCount: number;
  approvedTotal: number;
  waitingCount: number;
  waitingTotal: number;
}

export interface AllocationRow {
  section: AllocationSection;
  /** Null for the "no category yet" row of a section. */
  categoryId: string | null;
  label: string;
  approvedCount: number;
  approvedTotal: number;
  /** Share of THIS section's approved total, 0-100, one decimal. Null when the section has no approved money. */
  approvedSharePct: number | null;
  waitingCount: number;
  waitingTotal: number;
  /** Empty unless at least one line in this row has a type chosen. Biggest first, "No specific type" last. */
  subRows: AllocationSubRow[];
}

export interface AllocationSectionResult {
  section: AllocationSection;
  rows: AllocationRow[];
  approvedCount: number;
  approvedTotal: number;
  waitingCount: number;
  waitingTotal: number;
}

export interface AllocationCurrencyResult {
  currency: string;
  sections: Record<AllocationSection, AllocationSectionResult>;
  /** Approved income minus approved spending, exact. */
  approvedNet: number;
  /** approvedNet as a share of approved income, one decimal. Null when there is no approved income. */
  approvedSavingsRatePct: number | null;
  hasApproved: boolean;
  hasWaiting: boolean;
}

export interface AllocationOverviewResult {
  currencies: AllocationCurrencyResult[];
}

interface Flat {
  currency: string;
  creditDebit: 'credit' | 'debit';
  amount: number;
  economicType: FdhEconomicTransactionType;
  categoryId: string | null;
  subcategoryId: string | null;
}

function flatten(txns: readonly AllocationInputTxn[]): Flat[] {
  const out: Flat[] = [];
  for (const t of txns) {
    if (isDuplicateExcluded(t.dedupStatus)) continue;
    if (t.allocations.length > 0) {
      for (const a of t.allocations) out.push({ currency: a.currency, creditDebit: t.creditDebit, amount: Math.abs(a.amount), economicType: a.economicType, categoryId: a.categoryId, subcategoryId: a.subcategoryId ?? null });
    } else {
      out.push({ currency: t.currency, creditDebit: t.creditDebit, amount: Math.abs(t.amount), economicType: t.economicType, categoryId: t.categoryId, subcategoryId: t.subcategoryId ?? null });
    }
  }
  return out;
}

export function sectionOf(economicType: FdhEconomicTransactionType, creditDebit: 'credit' | 'debit'): AllocationSection {
  if (economicType === 'unknown') return 'needs_category';
  const bucket = bucketForType(economicType, false, creditDebit);
  if (bucket === 'income') return 'income';
  if (bucket === 'spending') return 'spending';
  if (bucket === 'unknown') return 'needs_category';
  return 'not_counted';
}

interface Cell { count: number; minor: number }
type PassResult = Map<string, { section: AllocationSection; categoryId: string | null; cell: Cell; subs: Map<string, Cell> }>; // key: `${currency}|${section}|${categoryId ?? ''}`; subs key: subcategory id, '' = no type

/** ONE pass over ONE list (approved, or waiting). Never sees the other list. */
function pass(lines: readonly Flat[]): PassResult {
  const m: PassResult = new Map();
  for (const l of lines) {
    const section = sectionOf(l.economicType, l.creditDebit);
    const categoryId = section === 'needs_category' ? null : l.categoryId;
    const key = `${l.currency}|${section}|${categoryId ?? ''}`;
    const cur = m.get(key) ?? { section, categoryId, cell: { count: 0, minor: 0 }, subs: new Map<string, Cell>() };
    const minor = toMinorUnits(l.amount, l.currency);
    cur.cell.count += 1;
    cur.cell.minor += minor;
    // The type is detail under the row; a line with no category has no type to show.
    const subKey = categoryId === null ? '' : l.subcategoryId ?? '';
    const sub = cur.subs.get(subKey) ?? { count: 0, minor: 0 };
    sub.count += 1;
    sub.minor += minor;
    cur.subs.set(subKey, sub);
    m.set(key, cur);
  }
  return m;
}

/** The types under one category row, from the approved and the waiting pass of that row. Approved and waiting stay in their own fields. Empty when no line has a type. */
function buildSubRows(
  approvedSubs: Map<string, Cell> | undefined,
  waitingSubs: Map<string, Cell> | undefined,
  currency: string,
  label: ((id: string) => string | null) | undefined,
): AllocationSubRow[] {
  const keys = new Set<string>([...(approvedSubs?.keys() ?? []), ...(waitingSubs?.keys() ?? [])]);
  if (![...keys].some((k) => k !== '')) return [];
  const rows: AllocationSubRow[] = [...keys].map((k) => ({
    subcategoryId: k === '' ? null : k,
    label: k === '' ? 'No specific type' : label?.(k) ?? 'Other type',
    approvedCount: approvedSubs?.get(k)?.count ?? 0,
    approvedTotal: fromMinorUnits(approvedSubs?.get(k)?.minor ?? 0, currency),
    waitingCount: waitingSubs?.get(k)?.count ?? 0,
    waitingTotal: fromMinorUnits(waitingSubs?.get(k)?.minor ?? 0, currency),
  }));
  rows.sort((x, y) => Number(x.subcategoryId === null) - Number(y.subcategoryId === null) || y.approvedTotal - x.approvedTotal || y.waitingTotal - x.waitingTotal || x.label.localeCompare(y.label));
  return rows;
}

export function buildAllocationOverview(input: {
  approved: readonly AllocationInputTxn[];
  waiting: readonly AllocationInputTxn[];
  /** category id -> display name (active categories). */
  categoryLabel: (categoryId: string) => string | null;
  /** subcategory id -> display name. Optional: without it, types are labelled "Other type". */
  subcategoryLabel?: (subcategoryId: string) => string | null;
}): AllocationOverviewResult {
  const approvedPass = pass(flatten(input.approved));
  const waitingPass = pass(flatten(input.waiting));
  const currencies = new Set<string>();
  for (const k of [...approvedPass.keys(), ...waitingPass.keys()]) currencies.add(k.split('|')[0]);

  const results: AllocationCurrencyResult[] = [];
  for (const currency of [...currencies].sort()) {
    const sections = {} as Record<AllocationSection, AllocationSectionResult>;
    for (const section of ALLOCATION_SECTION_ORDER) {
      const keys = new Set<string>();
      for (const k of approvedPass.keys()) if (k.startsWith(`${currency}|${section}|`)) keys.add(k);
      for (const k of waitingPass.keys()) if (k.startsWith(`${currency}|${section}|`)) keys.add(k);

      let aMinor = 0, aCount = 0, wMinor = 0, wCount = 0;
      const rows: AllocationRow[] = [];
      for (const k of keys) {
        const a = approvedPass.get(k);
        const w = waitingPass.get(k);
        const categoryId = (a ?? w)!.categoryId;
        aMinor += a?.cell.minor ?? 0; aCount += a?.cell.count ?? 0;
        wMinor += w?.cell.minor ?? 0; wCount += w?.cell.count ?? 0;
        rows.push({
          section,
          categoryId,
          label: section === 'needs_category' || categoryId === null ? 'No category yet' : input.categoryLabel(categoryId) ?? 'Other category',
          approvedCount: a?.cell.count ?? 0,
          approvedTotal: fromMinorUnits(a?.cell.minor ?? 0, currency),
          approvedSharePct: null,
          waitingCount: w?.cell.count ?? 0,
          waitingTotal: fromMinorUnits(w?.cell.minor ?? 0, currency),
          subRows: buildSubRows(a?.subs, w?.subs, currency, input.subcategoryLabel),
        });
      }
      for (const r of rows) {
        r.approvedSharePct = aMinor > 0 && r.approvedCount > 0 ? Math.round((toMinorUnits(r.approvedTotal, currency) / aMinor) * 1000) / 10 : null;
      }
      // Biggest first (approved, then waiting), a "No category yet" row last.
      rows.sort((x, y) => Number(x.categoryId === null) - Number(y.categoryId === null) || y.approvedTotal - x.approvedTotal || y.waitingTotal - x.waitingTotal || x.label.localeCompare(y.label));
      sections[section] = { section, rows, approvedCount: aCount, approvedTotal: fromMinorUnits(aMinor, currency), waitingCount: wCount, waitingTotal: fromMinorUnits(wMinor, currency) };
    }
    const incomeMinor = toMinorUnits(sections.income.approvedTotal, currency);
    const spendMinor = toMinorUnits(sections.spending.approvedTotal, currency);
    const netMinor = incomeMinor - spendMinor;
    results.push({
      currency,
      sections,
      approvedNet: fromMinorUnits(netMinor, currency),
      approvedSavingsRatePct: incomeMinor > 0 ? Math.round((netMinor / incomeMinor) * 1000) / 10 : null,
      hasApproved: ALLOCATION_SECTION_ORDER.some((s) => sections[s].approvedCount > 0),
      hasWaiting: ALLOCATION_SECTION_ORDER.some((s) => sections[s].waitingCount > 0),
    });
  }
  return { currencies: results };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The analysis, in plain words. Deterministic: every sentence is built from the figures above, none is invented.
// ---------------------------------------------------------------------------------------------------------------------------------------------

const pct = (n: number): string => `${n.toFixed(1).replace(/\.0$/, '')}%`;
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** `fmt` formats an amount of the currency (the page passes formatMoney). */
export function describeAllocation(c: AllocationCurrencyResult, fmt: (amount: number) => string): string[] {
  const out: string[] = [];
  const { income, spending, not_counted: notCounted, needs_category: needs } = c.sections;

  if (income.approvedCount > 0 || spending.approvedCount > 0) {
    const kept = c.approvedNet >= 0;
    const rate = c.approvedSavingsRatePct;
    out.push(
      `In this period you received ${fmt(income.approvedTotal)} and spent ${fmt(spending.approvedTotal)}, so ${kept ? 'you kept' : 'you spent more than you received, by'} ${fmt(Math.abs(c.approvedNet))}` +
        (rate !== null ? (kept ? ` (${pct(rate)} of what you received).` : ` (${pct(Math.abs(rate))} more than you received).`) : '.'),
    );
  }

  const spendRows = spending.rows.filter((r) => r.approvedCount > 0 && r.approvedSharePct !== null).slice(0, 3);
  if (spendRows.length > 0) {
    const [a, b, d] = spendRows;
    out.push(
      `Your biggest spending is ${a.label} (${fmt(a.approvedTotal)}, ${pct(a.approvedSharePct!)} of your spending)` +
        (b ? `, then ${b.label} (${pct(b.approvedSharePct!)})` : '') +
        (d ? ` and ${d.label} (${pct(d.approvedSharePct!)})` : '') +
        '.',
    );
  }

  const incomeRows = income.rows.filter((r) => r.approvedCount > 0 && r.approvedSharePct !== null).slice(0, 2);
  if (incomeRows.length > 0) {
    const [a, b] = incomeRows;
    out.push(
      a.approvedSharePct! >= 50 || !b
        ? `Most of your income is ${a.label} (${fmt(a.approvedTotal)}, ${pct(a.approvedSharePct!)}).`
        : `Your income comes mainly from ${a.label} (${pct(a.approvedSharePct!)}) and ${b.label} (${pct(b.approvedSharePct!)}).`,
    );
  }

  if (notCounted.approvedCount > 0) {
    out.push(
      `${notCounted.approvedCount} ${plural(notCounted.approvedCount, 'line', 'lines')} (${fmt(notCounted.approvedTotal)}) ${plural(notCounted.approvedCount, 'is', 'are')} moves between your own accounts, loans, investments or cash, or refunds. ${plural(notCounted.approvedCount, 'It is', 'They are')} not counted as income or spending.`,
    );
  }

  if (needs.approvedCount > 0) {
    out.push(`${needs.approvedCount} approved ${plural(needs.approvedCount, 'line', 'lines')} (${fmt(needs.approvedTotal)}) ${plural(needs.approvedCount, 'has', 'have')} no category, so ${plural(needs.approvedCount, 'it is', 'they are')} in none of the figures above.`);
  }

  const waitingCount = ALLOCATION_SECTION_ORDER.reduce((n, s) => n + c.sections[s].waitingCount, 0);
  if (waitingCount > 0) {
    out.push(
      `${waitingCount} ${plural(waitingCount, 'line is', 'lines are')} still waiting for your approval. ${plural(waitingCount, 'It is', 'They are')} shown in the "Waiting for approval" column and ${plural(waitingCount, 'is', 'are')} not in any approved figure or in the sentences above.`,
    );
    const waitingNeeds = needs.waitingCount;
    if (waitingNeeds > 0) out.push(`${waitingNeeds} of those ${plural(waitingNeeds, 'needs', 'need')} a category before ${plural(waitingNeeds, 'it', 'they')} can be placed in the table.`);
  }

  if (out.length === 0) out.push('Nothing to analyse in this period yet. Upload a statement and approve it, and the table above fills in.');
  return out;
}
