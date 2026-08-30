/**
 * FDH-12 — retirement balance reconciliation (spec sections 46-49, 127-128).
 *
 * ============================================================================
 * THE IDENTITY
 * ============================================================================
 *
 *   opening
 *     + contributions (employer, personal, salary sacrifice, government)
 *     + rollovers in
 *     + earnings / interest / distributions
 *     - rollovers out
 *     - withdrawals / pension payments
 *     - fees
 *     - insurance premiums
 *     - taxes
 *     ± adjustments
 *   = closing
 *
 * Every term is an EXACT INTEGER of minor units (`./money.ts`). No IEEE-754
 * value participates at any point, which is what makes spec section 48's
 * one-cent negative control meaningful: a $0.01 discrepancy survives to the
 * result rather than being absorbed by float noise (spec section 142).
 *
 * ============================================================================
 * NEVER FORCE A RECONCILIATION (spec sections 47, 49)
 * ============================================================================
 *
 * INSUFFICIENT_DATA is a first-class answer and is returned whenever the
 * statement did not give enough to compute the identity — most commonly when
 * it shows a closing balance but no opening balance, which is completely
 * normal for a first member statement. FDH-12 does NOT invent an opening
 * balance of 0 in that case: doing so would produce a fabricated VARIANCE
 * equal to the whole account, and would be exactly the "invent opening
 * balance" spec section 49 forbids. The closing balance remains perfectly good
 * evidence and still drives the proposal.
 *
 * ============================================================================
 * SUMMARY TOTALS ARE NOT ACTIVITIES (spec sections 116-118)
 * ============================================================================
 *
 * `reconcileFromActivities` filters out every row flagged `isSummaryTotal` or
 * `isYearToDate` before summing. This is the single most important line in the
 * file: an annual statement that prints "Total employer contributions 12,000"
 * above twelve monthly lines of 1,000 would otherwise reconcile to 24,000. The
 * filter is asserted by a dedicated negative control in
 * `tests/unit/fdh12BalanceReconciliation.test.ts`.
 */

import {
  RETIREMENT_ACTIVITY_DIRECTION,
  type RetirementActivityEvidence,
  type RetirementActivityType,
  type RetirementReconciliationStatus,
  type RetirementStatementExtraction,
} from './types';
import { ZERO, absMinorUnits, toMinorUnits, tryParseMoneyToMinorUnits } from './money';

export interface RetirementReconciliationResult {
  status: RetirementReconciliationStatus;
  /** Signed: computed closing minus stated closing, in minor units. Null when
   * the identity could not be computed at all. */
  varianceMinorUnits: bigint | null;
  /** Which inputs were available. Surfaced in the review UI so the user can
   * see WHY a statement is INSUFFICIENT_DATA rather than just being told. */
  detail: {
    hasOpening: boolean;
    hasClosing: boolean;
    movementTermCount: number;
    /** Rows excluded because they are printed subtotals or YTD figures. */
    excludedSummaryRows: number;
    excludedYtdRows: number;
    /** Rows whose activity type has no defined balance direction
     * (UNKNOWN/OTHER/ADJUSTMENT-without-sign). Any of these makes a clean
     * RECONCILED impossible. */
    undirectedRows: number;
    unparseableRows: number;
  };
}

/** Tolerance is ZERO minor units. Spec section 48: a one-cent mismatch is a
 * VARIANCE, full stop. A tolerance constant here would be the exact "silently
 * round away a material source mismatch" the spec forbids, so there is not
 * one — this named constant exists so that fact is visible rather than
 * implicit. */
export const RETIREMENT_RECONCILIATION_TOLERANCE_MINOR_UNITS = ZERO;

function signedContribution(
  type: RetirementActivityType,
  magnitude: bigint,
): bigint | null {
  const direction = RETIREMENT_ACTIVITY_DIRECTION[type];
  if (direction === null) return null;
  return direction === 'credit' ? magnitude : -magnitude;
}

/**
 * Reconcile from the statement's own ACTIVITY LINES.
 *
 * Preferred over the summary-total path when line detail exists, because it is
 * the stronger evidence.
 */
export function reconcileFromActivities(
  openingBalance: string | null | undefined,
  closingBalance: string | null | undefined,
  activities: readonly RetirementActivityEvidence[],
): RetirementReconciliationResult {
  const opening = openingBalance == null ? null : tryParseMoneyToMinorUnits(openingBalance);
  const closing = closingBalance == null ? null : tryParseMoneyToMinorUnits(closingBalance);

  // SUBTOTAL / YTD EXCLUSION — see the file header.
  const excludedSummaryRows = activities.filter((a) => a.isSummaryTotal).length;
  const excludedYtdRows = activities.filter((a) => !a.isSummaryTotal && a.isYearToDate).length;
  const economic = activities.filter((a) => !a.isSummaryTotal && !a.isYearToDate);

  let movement = ZERO;
  let undirectedRows = 0;
  let unparseableRows = 0;
  let movementTermCount = 0;

  for (const a of economic) {
    const magnitude = tryParseMoneyToMinorUnits(a.amount);
    if (magnitude === null) { unparseableRows += 1; continue; }
    const signed = signedContribution(a.activityType, magnitude);
    if (signed === null) { undirectedRows += 1; continue; }
    movement += signed;
    movementTermCount += 1;
  }

  const detail = {
    hasOpening: opening !== null,
    hasClosing: closing !== null,
    movementTermCount,
    excludedSummaryRows,
    excludedYtdRows,
    undirectedRows,
    unparseableRows,
  };

  // Cannot compute the identity without both endpoints.
  if (opening === null || closing === null) {
    return { status: 'insufficient_data', varianceMinorUnits: null, detail };
  }
  // No movement detail at all: opening and closing alone prove nothing about
  // whether the movement is explained (spec section 47).
  if (movementTermCount === 0) {
    return { status: 'insufficient_data', varianceMinorUnits: null, detail };
  }
  // A row we could not direct or could not parse means the identity is
  // incomplete by construction. Reporting RECONCILED here would be a false
  // pass; reporting VARIANCE would blame the fund for our own gap. The honest
  // answer is that we do not have enough to say.
  if (undirectedRows > 0 || unparseableRows > 0) {
    return { status: 'insufficient_data', varianceMinorUnits: null, detail };
  }

  const variance = (opening + movement) - closing;
  return {
    status: absMinorUnits(variance) <= RETIREMENT_RECONCILIATION_TOLERANCE_MINOR_UNITS
      ? 'reconciled'
      : 'variance',
    varianceMinorUnits: variance,
    detail,
  };
}

/**
 * Reconcile from the statement's printed PERIOD MOVEMENT TOTALS.
 *
 * Used when a member/annual statement gives summary figures but no line
 * detail. The totals and the activity lines are NEVER combined — spec section
 * 118's distinction between a summary total and an individual activity is
 * exactly what makes them alternative evidence for the same movement, not two
 * movements. `reconcileStatement` below picks one path or the other, never
 * both.
 */
export function reconcileFromSummaryTotals(
  extraction: Pick<
    RetirementStatementExtraction,
    | 'openingBalance' | 'closingBalance' | 'employerContributions' | 'personalContributions'
    | 'salarySacrifice' | 'governmentContributions' | 'rolloversIn' | 'rolloversOut'
    | 'withdrawals' | 'pensionPayments' | 'investmentEarnings' | 'fees'
    | 'insurancePremiums' | 'tax'
  >,
): RetirementReconciliationResult {
  const opening = extraction.openingBalance == null ? null : tryParseMoneyToMinorUnits(extraction.openingBalance);
  const closing = extraction.closingBalance == null ? null : tryParseMoneyToMinorUnits(extraction.closingBalance);

  const credits: (string | undefined)[] = [
    extraction.employerContributions, extraction.personalContributions,
    extraction.salarySacrifice, extraction.governmentContributions,
    extraction.rolloversIn, extraction.investmentEarnings,
  ];
  const debits: (string | undefined)[] = [
    extraction.rolloversOut, extraction.withdrawals, extraction.pensionPayments,
    extraction.fees, extraction.insurancePremiums, extraction.tax,
  ];

  let movement = ZERO;
  let movementTermCount = 0;
  let unparseableRows = 0;

  for (const v of credits) {
    if (v == null) continue;
    const parsed = tryParseMoneyToMinorUnits(v);
    if (parsed === null) { unparseableRows += 1; continue; }
    movement += parsed;
    movementTermCount += 1;
  }
  for (const v of debits) {
    if (v == null) continue;
    const parsed = tryParseMoneyToMinorUnits(v);
    if (parsed === null) { unparseableRows += 1; continue; }
    movement -= parsed;
    movementTermCount += 1;
  }

  const detail = {
    hasOpening: opening !== null,
    hasClosing: closing !== null,
    movementTermCount,
    excludedSummaryRows: 0,
    excludedYtdRows: 0,
    undirectedRows: 0,
    unparseableRows,
  };

  if (opening === null || closing === null || movementTermCount === 0 || unparseableRows > 0) {
    return { status: 'insufficient_data', varianceMinorUnits: null, detail };
  }

  const variance = (opening + movement) - closing;
  return {
    status: absMinorUnits(variance) <= RETIREMENT_RECONCILIATION_TOLERANCE_MINOR_UNITS
      ? 'reconciled'
      : 'variance',
    varianceMinorUnits: variance,
    detail,
  };
}

/**
 * The entry point the processing service calls.
 *
 * PICKS EXACTLY ONE EVIDENCE PATH. Line detail wins when it is present and
 * usable; otherwise the printed totals are used. The two are never summed —
 * that would be the spec-section-116/118 double count.
 */
export function reconcileStatement(
  extraction: RetirementStatementExtraction,
): RetirementReconciliationResult {
  const economicRows = extraction.activities.filter((a) => !a.isSummaryTotal && !a.isYearToDate);
  if (economicRows.length > 0) {
    const byActivity = reconcileFromActivities(
      extraction.openingBalance, extraction.closingBalance, extraction.activities,
    );
    // Fall through to summary totals only when the activity path could not
    // produce an answer at all — never to "try the other one until one says
    // RECONCILED", which would be shopping for a pass.
    if (byActivity.status !== 'insufficient_data') return byActivity;
    if (byActivity.detail.movementTermCount > 0) return byActivity;
  }
  return reconcileFromSummaryTotals(extraction);
}

/**
 * Current canonical balance vs statement closing balance (spec section 55).
 *
 * A DISPLAY comparison, not a reconciliation: it answers "what would change if
 * I applied this?", which is a different question from "does this statement
 * add up?". Returned to the review UI so it can render
 * Current / Statement / Difference.
 */
export interface CurrentVsStatement {
  currentMinorUnits: bigint | null;
  statementMinorUnits: bigint | null;
  differenceMinorUnits: bigint | null;
  /** True when applying would not change the canonical value at all. */
  identical: boolean;
}

export function compareCurrentVsStatement(
  canonicalBalance: string | number | null | undefined,
  statementClosingBalance: string | null | undefined,
): CurrentVsStatement {
  const current = toMinorUnits(canonicalBalance ?? null);
  const statement = statementClosingBalance == null
    ? null
    : tryParseMoneyToMinorUnits(statementClosingBalance);
  if (current === null || statement === null) {
    return { currentMinorUnits: current, statementMinorUnits: statement, differenceMinorUnits: null, identical: false };
  }
  const difference = statement - current;
  return {
    currentMinorUnits: current,
    statementMinorUnits: statement,
    differenceMinorUnits: difference,
    identical: difference === ZERO,
  };
}
