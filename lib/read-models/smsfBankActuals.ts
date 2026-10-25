/**
 * SMSF bank actuals (DOCUMENT2 (4) review, WP-C, F23): what actually went through the fund's OWN bank accounts, from approved bank statements,
 * month by month. It reuses the one approved ledger (the Financial Data Hub lifecycle, owner-before-upload, approval) and keeps ONLY the lines on
 * accounts whose owner is the SMSF (fdh_financial_accounts.owner_role = smsf, migration 0207).
 *
 * FEEDS THE SMSF CASH FLOW ONLY. The household read models already treat those same lines as not the household's (ActualLine.household is false),
 * so they never reach personal Income, Expenses, Monthly Surplus, DTI or DSR; this selector is the other half: the same lines, and ONLY those,
 * become the fund's actuals. A line is in exactly one of the two worlds.
 *
 * NOT ADDED to the planned (recurring) income and expense records: the two are shown side by side and never summed, because a planned rent and
 * the rent that arrived in the bank are the same economic flow seen twice.
 *
 * MONEY IN is bucket income, MONEY OUT is bucket spending. The cost of debt on a facility is shown as its own figure. Everything else (transfers,
 * investment movements, cash withdrawals, refunds) is counted in `otherLineCount` and left out, never silently dropped or folded into spending.
 * Principal repayments therefore never appear as spending.
 *
 * PURE except the loader. A failed read is `{ status: 'unavailable' }`, never an empty success.
 */
import '@/lib/serverOnly';
import type { ActualLine, NormalisedLedger } from '@/lib/read-models/core/ledger';
import { loadApprovedLedger, normaliseLedger } from '@/lib/read-models/core/ledger';
import { loadFxContext } from '@/lib/read-models/core/currency';
import type { ReadModelClient } from '@/lib/read-models/core/paginate';
import { defaultWindowFor, type ReadWindow } from '@/lib/read-models/core/window';

export interface SmsfBankActualsMonth {
  month: string;
  incomeReporting: number;
  spendingReporting: number;
  costOfDebtReporting: number;
  /** income - spending - cost of debt. */
  netReporting: number;
  lineCount: number;
}

export interface SmsfBankActualsData {
  reportingCurrency: string;
  window: { from: string; to: string };
  months: SmsfBankActualsMonth[];
  totals: { incomeReporting: number; spendingReporting: number; costOfDebtReporting: number; netReporting: number };
  lineCount: number;
  /** Lines on SMSF accounts that are neither money in, spending nor cost of debt: shown as a count, left out of every figure. */
  otherLineCount: number;
  /** Lines in a currency that cannot be converted: left out and counted, never zeroed. */
  unconvertedCount: number;
  pendingApprovalCount: number;
}

export type SmsfBankActuals = ({ status: 'ok' } & SmsfBankActualsData) | { status: 'unavailable'; reason: string };

const cents = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** True for a ledger line on a bank account owned by the SMSF. Household lines never qualify. */
export function isSmsfLedgerLine(line: Pick<ActualLine, 'ownerRole' | 'household'>): boolean {
  return line.ownerRole === 'smsf' && !line.household;
}

export function computeSmsfBankActuals(ledger: NormalisedLedger, reportingCurrency: string): SmsfBankActualsData {
  const byMonth = new Map<string, SmsfBankActualsMonth>();
  const ensure = (month: string): SmsfBankActualsMonth => {
    let m = byMonth.get(month);
    if (!m) {
      m = { month, incomeReporting: 0, spendingReporting: 0, costOfDebtReporting: 0, netReporting: 0, lineCount: 0 };
      byMonth.set(month, m);
    }
    return m;
  };
  let otherLineCount = 0;
  let lineCount = 0;
  let unconvertedCount = 0;

  for (const line of ledger.lines) {
    if (!isSmsfLedgerLine(line)) continue;
    if (line.bucket !== 'income' && line.bucket !== 'spending' && line.bucket !== 'cost_of_debt') {
      otherLineCount += 1;
      continue;
    }
    if (line.amountReporting === null) {
      unconvertedCount += 1;
      continue;
    }
    const m = ensure(line.month);
    m.lineCount += 1;
    lineCount += 1;
    if (line.bucket === 'income') m.incomeReporting += line.amountReporting;
    else if (line.bucket === 'spending') m.spendingReporting += line.amountReporting;
    else m.costOfDebtReporting += line.amountReporting;
  }

  const months = [...byMonth.values()]
    .sort((a, b) => (a.month < b.month ? -1 : 1))
    .map((m) => ({
      ...m,
      incomeReporting: cents(m.incomeReporting),
      spendingReporting: cents(m.spendingReporting),
      costOfDebtReporting: cents(m.costOfDebtReporting),
      netReporting: cents(m.incomeReporting - m.spendingReporting - m.costOfDebtReporting),
    }));
  const sum = (f: (m: SmsfBankActualsMonth) => number) => cents(months.reduce((s, m) => s + f(m), 0));
  const income = sum((m) => m.incomeReporting);
  const spending = sum((m) => m.spendingReporting);
  const debt = sum((m) => m.costOfDebtReporting);

  return {
    reportingCurrency,
    window: { from: ledger.window.from, to: ledger.window.to },
    months,
    totals: { incomeReporting: income, spendingReporting: spending, costOfDebtReporting: debt, netReporting: cents(income - spending - debt) },
    lineCount,
    otherLineCount,
    unconvertedCount,
    pendingApprovalCount: ledger.pendingApprovalCount,
  };
}

export async function loadSmsfBankActuals(userId: string, client: ReadModelClient, window?: ReadWindow): Promise<SmsfBankActuals> {
  try {
    const fx = await loadFxContext(userId, client);
    const w = window ?? defaultWindowFor(fx.countryCode);
    const raw = await loadApprovedLedger(userId, client, w);
    const ledger = normaliseLedger(raw, fx, w, { invalidSplit: 'exclude_and_flag' });
    return { status: 'ok', ...computeSmsfBankActuals(ledger, fx.reportingCurrency) };
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof Error ? error.message : 'the approved bank ledger could not be read' };
  }
}
