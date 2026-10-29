/**
 * Balance rollforward for a statement that prints its running balance only at CHECKPOINTS (30-10-2026).
 *
 * `reconcileBalances` (bank-csv/reconciliation.ts) assumes every line carries a balance; with only some it answers `pending` and
 * the statement is never proven. NAB prints the balance on the last transaction of each day. That is still exact evidence: between two
 * printed balances the transactions in between must add up, line by line, to the difference. This checks, in statement order, with
 * zero tolerance in integer minor units:
 *
 *   opening (the first "Brought forward")  +  credits  -  debits  =  every printed balance, at the line that prints it
 *   the same arithmetic over the whole statement                    =  the closing balance the statement declares
 *   each page's "Carried forward"                                   =  the next page's "Brought forward"
 *   the statement's own "Total debits" / "Total credits"            =  the sums read
 *
 * Any difference is `failed` (never `pending`, never rounded away), with the first row at which the running balance broke. Only an
 * exact result is `reconciled`. Pure.
 */

import { moneyEquals, sumMoney } from '../domain/money';
import type { BalanceReconciliationResult } from '../bank-csv/reconciliation';

export interface CheckpointRow {
  sourceRowNumber: number;
  amountOriginal: number;
  creditDebit: 'credit' | 'debit';
  /** The balance printed on this line, or null. */
  balanceAfter: number | null;
}

export interface CheckpointReconciliationInput {
  rows: readonly CheckpointRow[];
  openingBalance: number;
  declaredClosingBalance: number;
  /** Balances printed on a narrative line (no amount): the running balance after `afterRowCount` rows must equal each. */
  standaloneBalances?: readonly { afterRowCount: number; balance: number }[];
  /** The statement's own totals, when it prints them. */
  declaredTotalDebits?: number | null;
  declaredTotalCredits?: number | null;
  /** A page's carried-forward balance that did not equal the next page's brought-forward balance. */
  forwardMismatch?: boolean;
  currencyCode: string;
}

export function reconcileWithCheckpoints(input: CheckpointReconciliationInput): BalanceReconciliationResult {
  const cur = input.currencyCode;
  let running = input.openingBalance;
  let firstBreakRowNumber: number | null = null;
  const standalone = input.standaloneBalances ?? [];
  const checkStandalone = (rowsSoFar: number, rowNumber: number | null) => {
    for (const s of standalone) {
      if (s.afterRowCount !== rowsSoFar || moneyEquals(running, s.balance, cur)) continue;
      if (firstBreakRowNumber === null) firstBreakRowNumber = rowNumber;
      running = s.balance;
    }
  };
  checkStandalone(0, input.rows[0]?.sourceRowNumber ?? null);
  input.rows.forEach((r, i) => {
    running = sumMoney([running, r.creditDebit === 'credit' ? r.amountOriginal : -r.amountOriginal], cur);
    if (r.balanceAfter !== null && !moneyEquals(running, r.balanceAfter, cur)) {
      if (firstBreakRowNumber === null) firstBreakRowNumber = r.sourceRowNumber;
      // Re-anchor on what the statement prints so one broken line is reported once, not on every line after it.
      running = r.balanceAfter;
    }
    checkStandalone(i + 1, r.sourceRowNumber);
  });
  const credits = input.rows.filter((r) => r.creditDebit === 'credit').map((r) => r.amountOriginal);
  const debits = input.rows.filter((r) => r.creditDebit === 'debit').map((r) => r.amountOriginal);
  const extractedCredits = credits.length ? sumMoney(credits, cur) : 0;
  const extractedDebits = debits.length ? sumMoney(debits, cur) : 0;
  const expectedClosingBalance = sumMoney([input.openingBalance, extractedCredits, -extractedDebits], cur);
  const variance = sumMoney([expectedClosingBalance, -input.declaredClosingBalance], cur);

  const totalsMatch =
    (input.declaredTotalDebits === null || input.declaredTotalDebits === undefined || moneyEquals(extractedDebits, input.declaredTotalDebits, cur)) &&
    (input.declaredTotalCredits === null || input.declaredTotalCredits === undefined || moneyEquals(extractedCredits, input.declaredTotalCredits, cur));

  const reconciled = firstBreakRowNumber === null && variance === 0 && totalsMatch && !input.forwardMismatch;
  return {
    status: reconciled ? 'reconciled' : 'failed',
    method: 'balance_rollforward',
    openingBalance: input.openingBalance,
    extractedCredits,
    extractedDebits,
    expectedClosingBalance,
    reportedClosingBalance: input.declaredClosingBalance,
    variance,
    varianceTolerance: 0,
    firstBreakRowNumber,
  };
}

/** True when some page's carried-forward balance differs from the following brought-forward balance. */
export function forwardBalancesDisagree(forwardLines: readonly { pageNumber: number; kind: 'brought' | 'carried'; balance: number }[], currencyCode: string): boolean {
  for (let i = 0; i < forwardLines.length - 1; i += 1) {
    const a = forwardLines[i];
    const b = forwardLines[i + 1];
    if (a.kind === 'carried' && b.kind === 'brought' && !moneyEquals(a.balance, b.balance, currencyCode)) return true;
  }
  return false;
}
