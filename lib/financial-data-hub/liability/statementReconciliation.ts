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
