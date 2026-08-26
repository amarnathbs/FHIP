/**
 * FDH-10 — Credit Cards & Loans Intelligence: LOAN REPAYMENT DECOMPOSITION.
 *
 * *** ONE OF THE TWO CONTROLS THE PRODUCT OWNER SAID THEY WILL SCRUTINISE
 * MOST HEAVILY (spec section 154, "the two controls to scrutinise most
 * heavily", control 2). ***
 *
 * THE RULE (spec sections 5, 30-38): a $2,000 bank debit that a loan
 * statement discloses as principal $1,550 + interest $430 + fee $20 must
 * become EXACTLY:
 *   - $1,550 liability reduction (`debt_principal` — never counted as
 *     ordinary expense),
 *   - $450 expense ($430 interest as `debt_interest` + $20 fee as `fee`),
 *   - $2,000 cash outflow (the untouched bank debit itself).
 *
 * It must NEVER become $2,000 flat expense (forbidden per spec section 5),
 * and never $2,450 (double-counting the principal AND the interest/fee on
 * top of a separately-counted full payment).
 *
 * REUSE, NOT A NEW LEDGER. The decomposition is expressed as
 * `fdh_transaction_allocations` rows against the SAME canonical
 * `fdh_transactions` row the bank statement already produced for that $2,000
 * debit (or, absent a bank statement, a single new `fdh_transactions` row
 * created for it — see FDH10_REPAYMENT_DECOMPOSITION.md §2). This is the
 * exact split mechanism FDH-1 built for "one supermarket debit may be part
 * groceries, part household goods, part gift" (migration 0047) — FDH-10 adds
 * no new splitting concept, only new inputs to it.
 *
 * LOAN DRAWDOWN IS NOT INCOME (spec section 30, mandatory negative control).
 * `classifyLoanAdvance` below can only ever produce `economicType: 'transfer'`
 * — there is no code path in this module that can label a drawdown 'income'.
 */

import { moneyEquals, sumMoney } from '../domain/money';
import type { FdhEconomicTransactionType } from '../constants/enums';

export interface LoanPaymentComponents {
  /** The exact bank/cash outflow for this payment event. */
  totalPayment: number;
  /** Statement-disclosed components. `undefined` when the statement did not
   * disclose that component — NEVER coerced to 0 by this function (a caller
   * that wants "0" must supply 0 explicitly; that is a materially different
   * fact from "not disclosed"). */
  principalComponent?: number;
  interestComponent?: number;
  feeComponent?: number;
  currencyCode: string;
}

export type DecompositionOutcome =
  | 'decomposed'
  /** Every component was supplied but they do not sum to `totalPayment`
   * within zero tolerance — the statement itself is internally inconsistent
   * (spec section 34: "don't assume repayment-minus-interest always equals
   * principal without checking adjustments/fees"). Never guessed past. */
  | 'component_mismatch'
  /** Not enough components were disclosed to decompose the payment at all —
   * the FULL PAYMENT MUST NOT be treated as ordinary expense in this case
   * either (spec section 5's forbidden outcome applies regardless of
   * evidence completeness); the caller surfaces this for manual review
   * rather than guessing a split. */
  | 'insufficient_evidence';

export interface DecomposedAllocation {
  economicType: 'debt_principal' | 'debt_interest' | 'fee';
  amount: number;
}

export interface LoanPaymentDecomposition {
  outcome: DecompositionOutcome;
  /** Present only when `outcome === 'decomposed'`. Sums, by construction, to
   * exactly `totalPayment` (spec section 5's "$2,000 cash outflow" — the
   * allocations never diverge from the parent transaction they split). */
  allocations: DecomposedAllocation[];
  /** Total of interest + fee components — THE expense figure for this
   * payment. Principal is deliberately excluded (spec section 5: "never
   * $2,450" — principal is a liability reduction, not an expense addend). */
  expenseTotal: number | null;
  /** The liability-reducing figure — principal only. */
  liabilityReductionTotal: number | null;
  warnings: string[];
}

/**
 * Decompose one loan repayment event.
 *
 * PRECEDENCE (spec section 34): "Statement-provided split takes precedence
 * over any certified amortisation engine's approximation" — this function
 * NEVER derives a principal/interest split from a rate/balance formula; it
 * only arranges statement-DISCLOSED components. A future amortisation-backed
 * fallback is an explicit, separate, disclosed capability (see
 * FDH10_REPAYMENT_DECOMPOSITION.md §4) — not implemented here, so an
 * under-disclosed statement correctly returns `insufficient_evidence` rather
 * than a fabricated number.
 */
export function decomposeLoanPayment(input: LoanPaymentComponents): LoanPaymentDecomposition {
  const warnings: string[] = [];
  const { totalPayment, principalComponent, interestComponent, feeComponent, currencyCode } = input;

  const disclosedCount = [principalComponent, interestComponent, feeComponent].filter((v) => v !== undefined).length;

  if (disclosedCount === 0) {
    return {
      outcome: 'insufficient_evidence',
      allocations: [],
      expenseTotal: null,
      liabilityReductionTotal: null,
      warnings: ['no_principal_interest_fee_split_disclosed'],
    };
  }

  // Every disclosed component defaults to 0 ONLY once at least one component
  // is known — a statement stating "principal $1,550, interest $430" with fee
  // unstated is read as fee=0, not as fee=unknown, because two of three
  // components plus the total already over-determines the third; requiring
  // every one of the three to be literally printed would reject statements
  // that simply have no fee line at all (the overwhelmingly common case).
  const principal = principalComponent ?? 0;
  const interest = interestComponent ?? 0;
  const fee = feeComponent ?? 0;

  const sum = sumMoney([principal, interest, fee], currencyCode);
  if (!moneyEquals(sum, totalPayment, currencyCode, 0)) {
    return {
      outcome: 'component_mismatch',
      allocations: [],
      expenseTotal: null,
      liabilityReductionTotal: null,
      warnings: [`components_sum_${sum}_does_not_equal_payment_${totalPayment}`],
    };
  }

  const allocations: DecomposedAllocation[] = [];
  if (principal > 0) allocations.push({ economicType: 'debt_principal', amount: principal });
  if (interest > 0) allocations.push({ economicType: 'debt_interest', amount: interest });
  if (fee > 0) allocations.push({ economicType: 'fee', amount: fee });

  if (allocations.length === 0) {
    // A $0 payment recorded as three zero components — structurally valid,
    // nothing to allocate, and certainly not an expense.
    warnings.push('zero_value_payment');
  }

  return {
    outcome: 'decomposed',
    allocations,
    expenseTotal: sumMoney([interest, fee], currencyCode),
    liabilityReductionTotal: principal,
    warnings,
  };
}

/**
 * LOAN DRAWDOWN IS NOT INCOME (spec section 30, mandatory negative control).
 *
 * A new/increased drawdown is cash/assets in, liability up, income = $0. The
 * return type is deliberately narrowed to exclude 'income' at the TYPE level
 * (not just by convention) — see `LoanAdvanceClassification` below — so this
 * control cannot regress via a careless edit; a future change that tried to
 * add 'income' as a possible economic type here would fail to typecheck
 * against `FdhEconomicTransactionType` only via the literal union declared
 * on this function's own return type.
 */
export type LoanAdvanceEconomicType = Extract<FdhEconomicTransactionType, 'transfer'>;

export interface LoanAdvanceClassification {
  economicType: LoanAdvanceEconomicType;
  /** Always 0 — a drawdown contributes nothing to income, by construction. */
  incomeContribution: 0;
  /** The liability increase this drawdown produces (a positive magnitude). */
  liabilityIncrease: number;
}

export function classifyLoanAdvance(drawdownAmount: number): LoanAdvanceClassification {
  if (!(drawdownAmount > 0)) {
    throw new RangeError(`classifyLoanAdvance: drawdownAmount must be a positive magnitude, received ${drawdownAmount}`);
  }
  return { economicType: 'transfer', incomeContribution: 0, liabilityIncrease: drawdownAmount };
}
