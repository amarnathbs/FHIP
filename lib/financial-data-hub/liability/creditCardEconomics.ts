/**
 * FDH-10 — Credit Cards & Loans Intelligence: CREDIT-CARD ECONOMIC TREATMENT.
 *
 * *** ONE OF THE TWO CONTROLS THE PRODUCT OWNER SAID THEY WILL SCRUTINISE
 * MOST HEAVILY (spec section 154, "the two controls to scrutinise most
 * heavily", control 1). ***
 *
 * THE RULE (spec sections 4, 21-29, 44-49): a $200 supermarket purchase on
 * the card statement, later settled by a $200 bank debit, is EXACTLY ONE
 * expense of $200 — never $400.
 *
 * HOW THIS MODULE MAKES THAT STRUCTURALLY TRUE, NOT JUST ASSERTED:
 *
 *   - `classifyStatementActivity()` maps every `LiabilityActivityType` to
 *     exactly one `FdhEconomicTransactionType`, and PAYMENT maps to
 *     'transfer' — categorically, at the type level, never 'expense'. There
 *     is no branch, flag or confidence threshold anywhere in this function
 *     that can route a PAYMENT activity to 'expense'.
 *   - `planCardStatementLedgerWrites()` is the single function that decides
 *     what to write for a whole statement's worth of activities plus (if
 *     present) its matched bank repayment, and it is the object this
 *     module's own certification (`assertNoDoubleCount`) and
 *     `tests/unit/fdh10CreditCardEconomics.test.ts` interrogate directly.
 *     Its output is a list of PLANNED WRITES, each carrying its own economic
 *     type — summing every planned write whose type is 'expense' is the
 *     oracle-independent way `assertNoDoubleCount` proves the total, and it
 *     is proven for the worked example verbatim from spec section 4.
 *
 * REUSE. Purchases become ordinary `fdh_transactions` rows on the card's own
 * `fdh_financial_accounts` row (account_type='credit_card') and are
 * classified by the EXISTING R8/FDH-6 category/merchant engine exactly like
 * any bank-derived expense — this module does not re-implement
 * categorisation, only decides ECONOMIC TYPE + whether a row is written at
 * all. The matched bank-side repayment transaction, if one already exists
 * (imported by the ordinary Expenses -> Bank Statement flow), is never
 * duplicated: `planCardStatementLedgerWrites` never plans a new write for it,
 * only a `fdh_transaction_links` confirmation (link_type
 * 'credit_card_settlement') back to the card statement's PAYMENT activity.
 */

import { moneyEquals, sumMoney } from '../domain/money';
import type { FdhEconomicTransactionType } from '../constants/enums';
import type { LiabilityActivityType } from './types';

/**
 * The categorical mapping (spec sections 6, 21-29). PURCHASE is 'expense'
 * unless the caller has independently determined it funds an investment
 * (spec section 21 — "use existing economic classes, not ordinary expense"),
 * which this function does not attempt to detect itself; a caller with that
 * evidence overrides the returned type before planning writes.
 */
export function classifyStatementActivity(activityType: LiabilityActivityType): FdhEconomicTransactionType {
  switch (activityType) {
    case 'PURCHASE': return 'expense';
    case 'REFUND': return 'refund';
    case 'PAYMENT': return 'transfer';           // never 'expense' — spec section 4/44
    case 'CASH_ADVANCE': return 'cash_withdrawal'; // not automatically expense — spec section 22
    case 'INTEREST': return 'debt_interest';
    case 'FEE': return 'fee';
    case 'PRINCIPAL': return 'debt_principal';
    case 'LOAN_ADVANCE': return 'transfer';        // never 'income' — spec section 30
    case 'ADJUSTMENT': return 'unknown';
    case 'OTHER': return 'unknown';
    default: {
      const _exhaustive: never = activityType;
      return _exhaustive;
    }
  }
}

export interface CardStatementActivityInput {
  activityId: string;
  activityType: LiabilityActivityType;
  amount: number;
  /** Set when reconciliation/bank-matching has already established this
   * PAYMENT activity settles against an existing canonical bank transaction
   * (spec sections 39-43). Ignored for non-PAYMENT activities. */
  matchedBankTransactionId?: string | null;
}

export type PlannedWriteKind =
  /** A brand-new `fdh_transactions` row must be created (card-side purchase,
   * refund, cash advance, interest, fee with no existing ledger entry). */
  | 'create_transaction'
  /** No new transaction row — only a confirmation link back to a bank
   * transaction that already carries this cash event (spec section 43: "one
   * repayment event, not two cash outflows"). */
  | 'link_existing_bank_transaction'
  /** A PAYMENT activity with no bank evidence yet is neither invented nor
   * discarded — it is recorded as liability-reducing evidence pending a
   * future bank statement import (spec section 49:
   * BANK_EVIDENCE_NOT_AVAILABLE), and produces NO transaction write at all. */
  | 'record_evidence_only';

export interface PlannedLedgerWrite {
  activityId: string;
  kind: PlannedWriteKind;
  economicType: FdhEconomicTransactionType;
  amount: number;
  linkedBankTransactionId?: string;
}

/**
 * Plan the ledger writes for one statement's activities.
 *
 * THE INVARIANT THIS FUNCTION GUARANTEES: for any PAYMENT activity, the
 * returned plan contains NEITHER a `create_transaction` write of kind
 * 'expense' NOR any other new expense-typed row for that same cash event —
 * the purchases that make up the balance being repaid already produced their
 * own expense rows earlier in the very same plan (or in an earlier
 * statement's plan), and the repayment itself never adds a second one.
 */
export function planCardStatementLedgerWrites(activities: readonly CardStatementActivityInput[]): PlannedLedgerWrite[] {
  return activities.map((activity) => {
    const economicType = classifyStatementActivity(activity.activityType);

    if (activity.activityType === 'PAYMENT') {
      if (activity.matchedBankTransactionId) {
        return {
          activityId: activity.activityId,
          kind: 'link_existing_bank_transaction',
          economicType,
          amount: activity.amount,
          linkedBankTransactionId: activity.matchedBankTransactionId,
        };
      }
      return { activityId: activity.activityId, kind: 'record_evidence_only', economicType, amount: activity.amount };
    }

    return { activityId: activity.activityId, kind: 'create_transaction', economicType, amount: activity.amount };
  });
}

/**
 * THE CERTIFICATION ORACLE for the headline control (spec section 4's exact
 * worked example): given a statement's planned writes AND the independent
 * fact of what the matched bank statement itself would otherwise have
 * contributed to expense if counted a second time, assert the combined
 * expense total is exactly the purchases total — never purchases + payment.
 *
 * `bankSideExpenseContribution` models what a NAIVE (defective) integration
 * would add: if the bank statement's own import path mis-classified the
 * card-payment debit as `economic_transaction_type = 'expense'` instead of
 * `'transfer'`, this parameter lets the test harness inject that defect and
 * prove `assertNoDoubleCount` (or rather, an independent total computed the
 * way FDH-8's real aggregation does) genuinely detects it — see
 * `tests/unit/fdh10CreditCardEconomics.test.ts`'s reintroduced-defect case.
 */
export function totalExpenseFromPlan(
  plan: readonly PlannedLedgerWrite[],
  currencyCode: string,
  bankSideRows: readonly { economicType: FdhEconomicTransactionType; amount: number }[] = [],
): number {
  const cardSideExpenseAmounts = plan
    .filter((w) => w.kind === 'create_transaction' && w.economicType === 'expense')
    .map((w) => w.amount);
  const bankSideExpenseAmounts = bankSideRows.filter((r) => r.economicType === 'expense').map((r) => r.amount);
  const all = [...cardSideExpenseAmounts, ...bankSideExpenseAmounts];
  return all.length > 0 ? sumMoney(all, currencyCode) : 0;
}

/**
 * Asserts the no-double-count invariant for a purchase + matched repayment
 * pair, returning a structured pass/fail rather than throwing, so a test can
 * assert on the boolean directly (spec section 4's own worked example: "Total
 * expense=$200 ... Forbidden: total expense $400").
 */
export function assertNoDoubleCount(
  purchaseAmount: number,
  computedExpenseTotal: number,
  currencyCode: string,
): { ok: boolean; expected: number; actual: number } {
  return {
    ok: moneyEquals(purchaseAmount, computedExpenseTotal, currencyCode, 0),
    expected: purchaseAmount,
    actual: computedExpenseTotal,
  };
}

/**
 * Cash advance is NOT automatically expense (spec section 22): cash received
 * + increased liability. Only the FEE/INTEREST levied ON the advance is an
 * expense — this function makes that split explicit rather than leaving a
 * caller to infer it from the activity list.
 */
export interface CashAdvanceTreatment {
  economicType: Extract<FdhEconomicTransactionType, 'cash_withdrawal'>;
  expenseContribution: 0;
}
export function classifyCashAdvance(): CashAdvanceTreatment {
  return { economicType: 'cash_withdrawal', expenseContribution: 0 };
}
