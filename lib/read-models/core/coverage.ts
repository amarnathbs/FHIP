/**
 * Statement coverage: which calendar months each imported account has a
 * COMPLETE approved record for (DC-01 / EXP-G3).
 *
 * WHY IT MATTERS. An average over months the statements do not cover is a
 * fiction: a statement for 10-31 July says nothing about 1-9 July. A month is
 * therefore "covered" for an account only when the union of that account's
 * approved statement periods contains every day of the month. Months the
 * statements only touch are "partial": their lines are shown (and counted in
 * the window totals) but never averaged.
 *
 * PERIOD SOURCE. fdh_statement_uploads.statement_period_start/end; when a
 * statement has no declared period (PDF/AI periods were not persisted before
 * WP-08), the min/max approved transaction date of that statement is used --
 * a conservative fallback that can only under-cover, never over-cover.
 *
 * AVERAGING (the per-account rule). Each account's covered spending is divided
 * by THAT account's covered-month count, and the household figure is the sum
 * over accounts. Two accounts with different coverage (a card with 3 months,
 * a savings account with 1) therefore each contribute their own monthly rate
 * instead of one being diluted by months it has no record for.
 */
import { monthEnd, monthStart, type IsoDate, type MonthKey, type ReadWindow } from './window';

export interface StatementPeriod {
  statementUploadId: string;
  accountId: string;
  periodStart: IsoDate | null;
  periodEnd: IsoDate | null;
  /** Min/max approved transaction date on the statement (fallback). */
  fallbackStart?: IsoDate | null;
  fallbackEnd?: IsoDate | null;
}

export type CoverageState = 'covered' | 'partial';

export interface AccountMonthCoverage {
  accountId: string;
  month: MonthKey;
  state: CoverageState;
  statementIds: string[];
}

export interface CoverageIndex {
  rows: AccountMonthCoverage[];
  /** accountId -> covered months (inside the window). */
  covered: Map<string, Set<MonthKey>>;
  /** accountId -> partial months (inside the window). */
  partial: Map<string, Set<MonthKey>>;
  /** Months covered by at least one account, oldest first. */
  coveredMonths: MonthKey[];
  /** Months only partially covered by every account that touches them. */
  partialMonths: MonthKey[];
}

function nextDay(d: IsoDate): IsoDate {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

/** Merges [start, end] day intervals (inclusive) that overlap or touch. */
export function mergeIntervals(intervals: readonly [IsoDate, IsoDate][]): [IsoDate, IsoDate][] {
  const sorted = [...intervals].filter(([s, e]) => s <= e).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const out: [IsoDate, IsoDate][] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= nextDay(last[1])) {
      if (e > last[1]) last[1] = e;
    } else {
      out.push([s, e]);
    }
  }
  return out;
}

export function periodOf(p: StatementPeriod): [IsoDate, IsoDate] | null {
  const start = p.periodStart ?? p.fallbackStart ?? null;
  const end = p.periodEnd ?? p.fallbackEnd ?? null;
  if (!start || !end || start > end) return null;
  return [start, end];
}

export function computeCoverage(periods: readonly StatementPeriod[], window: ReadWindow): CoverageIndex {
  const byAccount = new Map<string, StatementPeriod[]>();
  for (const p of periods) {
    if (!byAccount.has(p.accountId)) byAccount.set(p.accountId, []);
    byAccount.get(p.accountId)!.push(p);
  }
  const rows: AccountMonthCoverage[] = [];
  const covered = new Map<string, Set<MonthKey>>();
  const partial = new Map<string, Set<MonthKey>>();
  for (const [accountId, list] of byAccount) {
    const withPeriod = list.map((p) => ({ p, iv: periodOf(p) })).filter((x): x is { p: StatementPeriod; iv: [IsoDate, IsoDate] } => x.iv !== null);
    const merged = mergeIntervals(withPeriod.map((x) => x.iv));
    const cov = new Set<MonthKey>();
    const par = new Set<MonthKey>();
    for (const month of window.months) {
      const ms = monthStart(month);
      const me = monthEnd(month);
      const touching = withPeriod.filter((x) => x.iv[0] <= me && x.iv[1] >= ms).map((x) => x.p.statementUploadId);
      if (touching.length === 0) continue;
      const full = merged.some(([s, e]) => s <= ms && e >= me);
      (full ? cov : par).add(month);
      rows.push({ accountId, month, state: full ? 'covered' : 'partial', statementIds: [...new Set(touching)].sort() });
    }
    covered.set(accountId, cov);
    partial.set(accountId, par);
  }
  const coveredMonths = window.months.filter((m) => [...covered.values()].some((s) => s.has(m)));
  const partialMonths = window.months.filter((m) => !coveredMonths.includes(m) && [...partial.values()].some((s) => s.has(m)));
  rows.sort((a, b) => (a.accountId === b.accountId ? (a.month < b.month ? -1 : 1) : a.accountId < b.accountId ? -1 : 1));
  return { rows, covered, partial, coveredMonths, partialMonths };
}

export function isCovered(index: CoverageIndex, accountId: string, month: MonthKey): boolean {
  return index.covered.get(accountId)?.has(month) ?? false;
}

export function coveredMonthCount(index: CoverageIndex, accountId: string): number {
  return index.covered.get(accountId)?.size ?? 0;
}
