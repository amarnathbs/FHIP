/**
 * FDH-10 — Credit Cards & Loans Intelligence: statement balance reconciliation
 * (spec sections 36-38, 95-106's "exact-0.01-reconciliation" bar).
 *
 * EXACT MONEY (reuse, not reinvent). All arithmetic goes through
 * `lib/financial-data-hub/domain/money.ts` (`sumMoney`/`moneyEquals`) — the
 * same primitives R7's `reconciliation.ts` uses for bank-statement
 * roll-forward. No `+`/`-` on raw JS numbers appears below.
 *
 * NEVER SILENTLY PASS. A formula is only ever `reconciled` when every input
 * component the formula needs was actually supplied; a statement missing a
 * component the formula needs is `insufficient_data`, never `reconciled`
 * (spec section 38's own worked example: "interest generally must not alter
 * principal unless capitalised and explicitly evidenced").
 *
 * THE 0.01 NEGATIVE CONTROL (spec section 38). Both formulas below use exact
 * minor-unit comparison with ZERO tolerance — `moneyEquals(..., 0)` — so a
 * statement that reconciles exactly flips to `variance` the instant any ONE
 * component is off by a single cent. `tests/unit/fdh10StatementReconciliation
 * .test.ts` proves this is genuinely detectable, not merely asserted.
 */

import { moneyEquals, sumMoney } from '../domain/money';
import type { LiabilityReconciliationStatus } from './types';

export interface CreditCardReconciliationInput {
  openingBalance: number | null;
  purchasesTotal: number | null;
  cashAdvancesTotal: number | null;
  interestTotal: number | null;
  feesTotal: number | null;
  paymentsTotal: number | null;
  refundsTotal: number | null;
  adjustmentsTotal: number | null;
  closingBalance: number | null;
  currencyCode: string;
}

export interface ReconciliationResult {
  status: LiabilityReconciliationStatus;
  expectedClosingBalance: number | null;
  reportedClosingBalance: number | null;
  variance: number | null;
}

const zeroIfPresent = (v: number | null): number => v ?? 0;

/**
 * Credit-card formula (spec section 36):
 *   opening + purchases + cash advances + interest + fees
 *     - payments - refunds/credits ± adjustments = closing
 *
 * `insufficient_data` when opening or closing is missing — an activity total
 * defaulting to 0 is a legitimate "the statement had none of this activity",
 * but a missing BALANCE anchor is not something a formula may assume.
 */
export function reconcileCreditCardStatement(input: CreditCardReconciliationInput): ReconciliationResult {
  if (input.openingBalance === null || input.closingBalance === null) {
    return { status: 'insufficient_data', expectedClosingBalance: null, reportedClosingBalance: input.closingBalance, variance: null };
  }
  const expected = sumMoney(
    [
      input.openingBalance,
      zeroIfPresent(input.purchasesTotal),
      zeroIfPresent(input.cashAdvancesTotal),
      zeroIfPresent(input.interestTotal),
      zeroIfPresent(input.feesTotal),
      -zeroIfPresent(input.paymentsTotal),
      -zeroIfPresent(input.refundsTotal),
      zeroIfPresent(input.adjustmentsTotal),
    ],
    input.currencyCode,
  );
  const variance = sumMoney([expected, -input.closingBalance], input.currencyCode);
  return {
    status: moneyEquals(expected, input.closingBalance, input.currencyCode, 0) ? 'reconciled' : 'variance',
    expectedClosingBalance: expected,
    reportedClosingBalance: input.closingBalance,
    variance,
  };
}

export interface LoanReconciliationInput {
  openingPrincipal: number | null;
  drawdownsTotal: number | null;
  capitalisedTotal: number | null;
  principalRepaymentsTotal: number | null;
  adjustmentsTotal: number | null;
  closingPrincipal: number | null;
  currencyCode: string;
}

/**
 * Loan-principal formula (spec section 38):
 *   opening principal + drawdowns + capitalised items (if evidenced)
 *     - principal repayments ± adjustments = closing principal
 *
 * Interest is DELIBERATELY absent from this formula's inputs — ordinary
 * interest never alters principal (spec section 38); a statement that
 * capitalises interest must supply that fact via `capitalisedTotal`
 * explicitly, never inferred from the interest figure itself.
 */
export function reconcileLoanStatement(input: LoanReconciliationInput): ReconciliationResult {
  if (input.openingPrincipal === null || input.closingPrincipal === null) {
    return { status: 'insufficient_data', expectedClosingBalance: null, reportedClosingBalance: input.closingPrincipal, variance: null };
  }
  const expected = sumMoney(
    [
      input.openingPrincipal,
      zeroIfPresent(input.drawdownsTotal),
      zeroIfPresent(input.capitalisedTotal),
      -zeroIfPresent(input.principalRepaymentsTotal),
      zeroIfPresent(input.adjustmentsTotal),
    ],
    input.currencyCode,
  );
  const variance = sumMoney([expected, -input.closingPrincipal], input.currencyCode);
  return {
    status: moneyEquals(expected, input.closingPrincipal, input.currencyCode, 0) ? 'reconciled' : 'variance',
    expectedClosingBalance: expected,
    reportedClosingBalance: input.closingPrincipal,
    variance,
  };
}

// ---------------------------------------------------------------------------
// Statement TOTALS (WP-10, gap G5). One pure function computes every persisted
// per-type total AND the reconciliation verdict, so the persist path, its
// tests and the ledger-invariant test share one definition.
// ---------------------------------------------------------------------------

export interface StatementTotalsActivity {
  activityType: string;
  amount: number;
  principalComponent?: number;
  interestComponent?: number;
  feeComponent?: number;
}

export interface StatementTotals {
  purchasesTotal: number | null;
  cashAdvancesTotal: number | null;
  interestTotal: number | null;
  feesTotal: number | null;
  paymentsTotal: number | null;
  refundsTotal: number | null;
  /** SIGNED. Null when there are no ADJUSTMENT lines, or when their direction
   * cannot be established (see `adjustmentsSign`). */
  adjustmentsTotal: number | null;
  drawdownsTotal: number | null;
  /** Loan only: standalone INTEREST / FEE lines charged to the loan balance. */
  capitalisedTotal: number | null;
  /** PAYMENT principal components + standalone PRINCIPAL lines (+ a loan's
   * undecomposed PAYMENTs -- see computeStatementTotals). */
  principalRepaymentsTotal: number | null;
  reconciliation: ReconciliationResult;
  /** Visible warnings the totals themselves raise (persisted with the others). */
  warnings: string[];
}

/**
 * THE totals rule (G5). Before WP-10 the persist path dropped three things:
 * standalone PRINCIPAL lines were never summed, ADJUSTMENT lines were never
 * summed (both reconciliations were passed `null`), and a loan's redraw
 * (CASH_ADVANCE) and capitalised interest/fees were missing from the loan
 * identity, so a correct loan statement showed a variance.
 *
 * ADJUSTMENT lines carry a magnitude but no direction. Their sign is taken
 * from the balance identity ONLY when exactly one of +sum / -sum reconciles to
 * the cent; otherwise the total stays null, the statement cannot be
 * reconciled, and a warning says why. A reconciliation is never forced.
 *
 * LOAN TOTALS feed the certified loan identity DIRECTLY (so the correction
 * path, which re-runs `reconcileLoanStatement` on the stored totals, gets the
 * same answer as the persist path):
 *   drawdowns_total            = LOAN_ADVANCE + CASH_ADVANCE (a cash advance /
 *                                redraw on a loan is a drawdown);
 *   capitalised_total          = standalone INTEREST + FEE lines (charged to
 *                                the loan balance);
 *   principal_repayments_total = principal components + PRINCIPAL lines +
 *                                undecomposed PAYMENTs (a PAYMENT with no
 *                                principal/interest/fee disclosed reduces the
 *                                balance by its whole amount; the interest it
 *                                covers was charged as a separate INTEREST line);
 *   cash_advances_total        = null (folded into drawdowns).
 * A decomposed PAYMENT reduces principal by its principal component only.
 */
export function computeStatementTotals(input: {
  statementType: 'credit_card' | 'loan';
  activities: readonly StatementTotalsActivity[];
  opening: number | null;
  closing: number | null;
  currencyCode: string;
}): StatementTotals {
  const { activities, currencyCode } = input;
  const isCard = input.statementType === 'credit_card';
  const of = (type: string) => activities.filter((a) => a.activityType === type);
  const total = (list: readonly number[]): number | null => (list.length === 0 ? null : sumMoney(list, currencyCode));
  const sumType = (type: string) => total(of(type).map((a) => a.amount));
  const hasComponents = (a: StatementTotalsActivity) =>
    a.principalComponent !== undefined || a.interestComponent !== undefined || a.feeComponent !== undefined;

  const interestParts = [...of('INTEREST').map((a) => a.amount), ...activities.filter((a) => a.interestComponent !== undefined && a.interestComponent > 0).map((a) => a.interestComponent as number)];
  const feeParts = [...of('FEE').map((a) => a.amount), ...activities.filter((a) => a.feeComponent !== undefined && a.feeComponent > 0).map((a) => a.feeComponent as number)];
  const principalParts = [...of('PRINCIPAL').map((a) => a.amount), ...activities.filter((a) => a.principalComponent !== undefined && a.principalComponent > 0).map((a) => a.principalComponent as number)];

  const purchasesTotal = sumType('PURCHASE');
  const cashAdvancesTotal = isCard ? sumType('CASH_ADVANCE') : null;
  const paymentsTotal = sumType('PAYMENT');
  const refundsTotal = sumType('REFUND');
  const drawdownsTotal = isCard ? sumType('LOAN_ADVANCE') : total([...of('LOAN_ADVANCE'), ...of('CASH_ADVANCE')].map((a) => a.amount));
  const interestTotal = total(interestParts);
  const feesTotal = total(feeParts);
  const principalRepaymentsTotal = isCard
    ? total(principalParts)
    : total([...principalParts, ...of('PAYMENT').filter((a) => !hasComponents(a)).map((a) => a.amount)]);
  const capitalisedTotal = isCard ? null : total([...of('INTEREST'), ...of('FEE')].map((a) => a.amount));

  const warnings: string[] = [];
  const adjustmentMagnitude = sumType('ADJUSTMENT');
  const otherCount = of('OTHER').length;
  if (otherCount > 0) warnings.push(`other_activity_not_in_totals_${otherCount}`);

  const reconcileWith = (adjustments: number | null): ReconciliationResult =>
    isCard
      ? reconcileCreditCardStatement({
          openingBalance: input.opening, purchasesTotal, cashAdvancesTotal, interestTotal, feesTotal,
          paymentsTotal, refundsTotal, adjustmentsTotal: adjustments, closingBalance: input.closing, currencyCode,
        })
      : reconcileLoanStatement({
          openingPrincipal: input.opening,
          drawdownsTotal,
          capitalisedTotal,
          principalRepaymentsTotal,
          adjustmentsTotal: adjustments,
          closingPrincipal: input.closing,
          currencyCode,
        });

  let adjustmentsTotal: number | null = null;
  let reconciliation: ReconciliationResult;
  if (adjustmentMagnitude === null) {
    reconciliation = reconcileWith(null);
  } else {
    const plus = reconcileWith(adjustmentMagnitude);
    const minus = reconcileWith(-adjustmentMagnitude);
    if (plus.status === 'reconciled' && minus.status !== 'reconciled') {
      adjustmentsTotal = adjustmentMagnitude;
      reconciliation = plus;
      warnings.push('adjustment_sign_inferred_from_balance');
    } else if (minus.status === 'reconciled' && plus.status !== 'reconciled') {
      adjustmentsTotal = -adjustmentMagnitude;
      reconciliation = minus;
      warnings.push('adjustment_sign_inferred_from_balance');
    } else {
      // Direction unknown: the statement cannot be checked, and says so.
      warnings.push('adjustment_direction_unknown');
      reconciliation = { status: 'insufficient_data', expectedClosingBalance: null, reportedClosingBalance: input.closing, variance: null };
    }
  }

  return {
    purchasesTotal, cashAdvancesTotal, interestTotal, feesTotal, paymentsTotal, refundsTotal,
    adjustmentsTotal, drawdownsTotal, capitalisedTotal, principalRepaymentsTotal, reconciliation, warnings,
  };
}
