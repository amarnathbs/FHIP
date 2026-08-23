/**
 * R7 — Bank CSV Engine: reconciliation & data-quality (spec sections 42-46).
 *
 * NEVER SILENTLY PASS (spec 43, mirroring `fdh_reconciliation_results`'s own
 * DB constraint `chk_fdh_recon_reconciled`). `reconcileBalances()` only ever
 * returns `reconciled` when a variance was actually computed and falls
 * within an explicit, non-negative tolerance; every other case is `partial`,
 * `not_available` or `failed`.
 */

import { sumMoney, moneyEquals } from '../domain/money';
import type { FdhReconciliationMethod, FdhReconciliationStatus } from '../constants/enums';

export interface ReconciliationTxnInput {
  sourceRowNumber: number;
  amountOriginal: number;
  creditDebit: 'credit' | 'debit';
  balanceAfter: number | null;
}

export interface BalanceReconciliationResult {
  status: FdhReconciliationStatus;
  method: FdhReconciliationMethod;
  openingBalance: number | null;
  extractedCredits: number;
  extractedDebits: number;
  expectedClosingBalance: number | null;
  reportedClosingBalance: number | null;
  variance: number | null;
  varianceTolerance: number;
  /** 1-based source row number of the first running-balance break, if any. */
  firstBreakRowNumber: number | null;
}

/**
 * Row-level running-balance continuity + opening/closing rollforward (spec
 * 42-43), evaluated in SOURCE ROW ORDER (the order the statement itself
 * prints transactions in — the only order a running balance is meaningful
 * in). `transactions` must already be sorted by `sourceRowNumber` ascending.
 */
export function reconcileBalances(transactions: readonly ReconciliationTxnInput[], currencyCode: string): BalanceReconciliationResult {
  const varianceTolerance = 0;
  const withBalance = transactions.filter((t) => t.balanceAfter !== null);

  const credits = transactions.filter((t) => t.creditDebit === 'credit').map((t) => t.amountOriginal);
  const debits = transactions.filter((t) => t.creditDebit === 'debit').map((t) => t.amountOriginal);
  const extractedCredits = credits.length ? sumMoney(credits, currencyCode) : 0;
  const extractedDebits = debits.length ? sumMoney(debits, currencyCode) : 0;

  if (transactions.length === 0) {
    return {
      status: 'not_available',
      method: 'none',
      openingBalance: null,
      extractedCredits: 0,
      extractedDebits: 0,
      expectedClosingBalance: null,
      reportedClosingBalance: null,
      variance: null,
      varianceTolerance,
      firstBreakRowNumber: null,
    };
  }

  if (withBalance.length === 0) {
    return {
      status: 'not_available',
      method: 'none',
      openingBalance: null,
      extractedCredits,
      extractedDebits,
      expectedClosingBalance: null,
      reportedClosingBalance: null,
      variance: null,
      varianceTolerance,
      firstBreakRowNumber: null,
    };
  }

  const partialCoverage = withBalance.length < transactions.length;

  // Running-balance continuity, row by row, in source order.
  let firstBreakRowNumber: number | null = null;
  let prevBalance: number | null = null;
  for (const t of transactions) {
    if (t.balanceAfter === null) {
      // A gap in balance coverage breaks the rollforward chain from here.
      prevBalance = null;
      continue;
    }
    if (prevBalance !== null) {
      const signed = t.creditDebit === 'credit' ? t.amountOriginal : -t.amountOriginal;
      const expected = sumMoney([prevBalance, signed], currencyCode);
      if (!moneyEquals(expected, t.balanceAfter, currencyCode) && firstBreakRowNumber === null) {
        firstBreakRowNumber = t.sourceRowNumber;
      }
    }
    prevBalance = t.balanceAfter;
  }

  const firstWithBalance = withBalance[0];
  const openingBalance = sumMoney(
    [firstWithBalance.balanceAfter as number, firstWithBalance.creditDebit === 'credit' ? -firstWithBalance.amountOriginal : firstWithBalance.amountOriginal],
    currencyCode,
  );
  const reportedClosingBalance = withBalance[withBalance.length - 1].balanceAfter;
  const expectedClosingBalance = sumMoney([openingBalance, extractedCredits, -extractedDebits], currencyCode);
  const variance =
    reportedClosingBalance !== null ? sumMoney([expectedClosingBalance, -reportedClosingBalance], currencyCode) : null;

  if (partialCoverage) {
    // fdh_reconciliation_results.status (frozen migration 0048) has no
    // 'partial' member — its closed vocabulary is 'not_available' / 'pending'
    // / 'reconciled' / 'failed' / 'user_accepted_exception'. Partial balance
    // COVERAGE (some rows have a balance, some do not) is reported as
    // 'pending' — reconciliation genuinely could not be concluded either way
    // from the evidence available, which is exactly what 'pending' means
    // here; it is never reported as 'reconciled'. The DOCUMENT-level
    // certification_status (spec 45's separate four-state vocabulary,
    // 'certified'/'partial'/'review_required'/'rejected' — a brand-new R7
    // column) is where "partial" as a first-class outcome actually lives;
    // see R7_RECONCILIATION_METHODOLOGY.md.
    return {
      status: 'pending',
      method: 'balance_rollforward',
      openingBalance,
      extractedCredits,
      extractedDebits,
      expectedClosingBalance,
      reportedClosingBalance,
      variance,
      varianceTolerance,
      firstBreakRowNumber,
    };
  }

  if (firstBreakRowNumber !== null) {
    return {
      status: 'failed',
      method: 'balance_rollforward',
      openingBalance,
      extractedCredits,
      extractedDebits,
      expectedClosingBalance,
      reportedClosingBalance,
      variance,
      varianceTolerance,
      firstBreakRowNumber,
    };
  }

  const reconciled = variance !== null && Math.abs(variance) <= varianceTolerance;
  return {
    status: reconciled ? 'reconciled' : 'failed',
    method: 'balance_rollforward',
    openingBalance,
    extractedCredits,
    extractedDebits,
    expectedClosingBalance,
    reportedClosingBalance,
    variance,
    varianceTolerance,
    firstBreakRowNumber,
  };
}

// ---------------------------------------------------------------------------
// Date-coverage reconciliation (spec section 44)
// ---------------------------------------------------------------------------

export interface DateCoverageResult {
  earliestDate: string | null;
  latestDate: string | null;
  withinDeclaredPeriod: boolean | null;
}

export function computeDateCoverage(
  transactionDates: readonly string[],
  declaredPeriodStart: string | null,
  declaredPeriodEnd: string | null,
): DateCoverageResult {
  if (transactionDates.length === 0) {
    return { earliestDate: null, latestDate: null, withinDeclaredPeriod: null };
  }
  const sorted = [...transactionDates].sort();
  const earliestDate = sorted[0];
  const latestDate = sorted[sorted.length - 1];
  let withinDeclaredPeriod: boolean | null = null;
  if (declaredPeriodStart && declaredPeriodEnd) {
    withinDeclaredPeriod = earliestDate >= declaredPeriodStart && latestDate <= declaredPeriodEnd;
  }
  return { earliestDate, latestDate, withinDeclaredPeriod };
}

export interface DateRange {
  start: string;
  end: string;
}

/** Does [a.start, a.end] overlap [b.start, b.end] (inclusive)? Pure interval
 * arithmetic — the caller supplies prior statements' own earliest/latest
 * transaction dates for the same account (spec 44's "overlap with prior
 * imports"), fetched via a paginated repository query in the service layer. */
export function rangesOverlap(a: DateRange, b: DateRange): boolean {
  return a.start <= b.end && b.start <= a.end;
}
