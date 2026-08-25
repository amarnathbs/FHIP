/**
 * FDH-9 — gross-to-net reconciliation (spec section 19).
 *
 * "Exact, component-aware reconciliation — do not assume one formula fits
 * every payslip. Required statuses: RECONCILED, VARIANCE, INSUFFICIENT_DATA.
 * A 0.01 discrepancy must be detectable."
 *
 * EXACTNESS. All arithmetic goes through `domain/money.ts`'s integer
 * minor-unit primitives. The RECONCILED tolerance is ZERO minor units — not
 * "a cent or two" — precisely because the spec requires a 0.01 discrepancy to
 * surface. A one-cent rounding difference on a real payslip is therefore
 * reported as a VARIANCE of 0.01 for the user to glance at, which is the
 * intended behaviour, not a false alarm.
 *
 * WHY COMPONENT-LEVEL IS PREFERRED OVER HEADER TOTALS. Payslip header fields
 * overlap unpredictably between employers: on one payslip "Total Deductions"
 * includes salary sacrifice and employee super, on another it does not. Adding
 * `tax + deductions_total + salary_sacrifice + employee_super` would
 * DOUBLE-COUNT on the first and UNDER-COUNT on the second. Individual
 * component LINES, by contrast, are disjoint by construction — that is what a
 * line on a payslip means. So:
 *
 *   1. If we have real component lines, reconcile from them.
 *   2. Otherwise, reconcile from header totals ONLY when the deduction side is
 *      unambiguous (exactly one deduction total is disclosed).
 *   3. Otherwise INSUFFICIENT_DATA — which is a correct, first-class answer,
 *      not a failure to be papered over with a guess.
 *
 * EMPLOYER CONTRIBUTIONS NEVER ENTER THIS CALCULATION (spec section 39).
 * Employer super / employer PF / employer NPS are paid on top of, not out of,
 * the employee's pay. Including them would break every reconciliation.
 */

import { moneyEquals, sumMoney, toMinorUnits, fromMinorUnits } from '../domain/money';
import type { PayrollComponent, PayrollExtraction, PayrollReconciliationStatus } from './types';

export interface ReconciliationResult {
  status: PayrollReconciliationStatus;
  /** Signed: expectedNet - actualNet. Positive means the payslip's stated net
   * is LOWER than the components imply. Null when INSUFFICIENT_DATA. */
  variance: number | null;
  /** Which identity was used — recorded so a reviewer can see the reasoning. */
  method: 'components' | 'header_totals' | 'none';
  /** Machine-readable explanation. Never free prose in the database. */
  reasonCode:
    | 'reconciled_from_components'
    | 'reconciled_from_header_totals'
    | 'variance_from_components'
    | 'variance_from_header_totals'
    | 'no_net_pay'
    | 'no_earnings_evidence'
    | 'ambiguous_deduction_totals'
    | 'no_deduction_evidence';
  expectedNet: number | null;
  actualNet: number | null;
}

/** Current-period components only. YTD lines are evidence, never arithmetic
 * inputs (spec section 35). */
function currentPeriod(components: readonly PayrollComponent[]): PayrollComponent[] {
  return components.filter((c) => !c.isYearToDate);
}

export function reconcileGrossToNet(extraction: PayrollExtraction): ReconciliationResult {
  const currency = extraction.currencyCode;
  const net = extraction.netPay;

  if (net === undefined) {
    return {
      status: 'insufficient_data', variance: null, method: 'none',
      reasonCode: 'no_net_pay', expectedNet: null, actualNet: null,
    };
  }

  const lines = currentPeriod(extraction.components);
  const earnings = lines.filter((c) => c.side === 'earning');
  const deductions = lines.filter((c) => c.side === 'deduction');

  // ---- 1. Component-level identity ----------------------------------------
  // net = sum(earnings) - sum(deductions)
  //
  // Reimbursements ARE included on the earnings side here: they genuinely
  // reach the employee's bank account, so excluding them would create a false
  // variance. They are excluded from RECURRING INCOME separately, by the
  // income adapter (spec section 38) — a different question from what the
  // employee was paid this period.
  if (earnings.length > 0 && deductions.length > 0) {
    const totalEarnings = sumMoney(earnings.map((c) => c.amount), currency);
    const totalDeductions = sumMoney(deductions.map((c) => c.amount), currency);
    const expectedNet = fromMinorUnits(
      toMinorUnits(totalEarnings, currency) - toMinorUnits(totalDeductions, currency),
      currency,
    );
    const reconciled = moneyEquals(expectedNet, net, currency, 0);
    return {
      status: reconciled ? 'reconciled' : 'variance',
      variance: reconciled ? 0 : signedVariance(expectedNet, net, currency),
      method: 'components',
      reasonCode: reconciled ? 'reconciled_from_components' : 'variance_from_components',
      expectedNet,
      actualNet: net,
    };
  }

  // ---- 2. Header-total identity -------------------------------------------
  const gross = extraction.grossPay;
  if (gross === undefined) {
    return {
      status: 'insufficient_data', variance: null, method: 'none',
      reasonCode: 'no_earnings_evidence', expectedNet: null, actualNet: net,
    };
  }

  // Every disclosed deduction-side total. If MORE THAN ONE is present we
  // cannot know whether they overlap, and we refuse to guess.
  const deductionTotals = [
    extraction.employeeDeductionsTotal,
    extraction.taxWithheld,
    extraction.salarySacrifice,
    extraction.professionalTax,
    extraction.employeeRetirementContribution,
    extraction.employeeNpsContribution,
  ].filter((v): v is number => v !== undefined);

  if (deductionTotals.length === 0) {
    return {
      status: 'insufficient_data', variance: null, method: 'none',
      reasonCode: 'no_deduction_evidence', expectedNet: null, actualNet: net,
    };
  }
  if (deductionTotals.length > 1) {
    return {
      status: 'insufficient_data', variance: null, method: 'none',
      reasonCode: 'ambiguous_deduction_totals', expectedNet: null, actualNet: net,
    };
  }

  const reimbursements = extraction.reimbursementsTotal ?? 0;
  const expectedNet = fromMinorUnits(
    toMinorUnits(gross, currency)
      + toMinorUnits(reimbursements, currency)
      - toMinorUnits(deductionTotals[0], currency),
    currency,
  );
  const reconciled = moneyEquals(expectedNet, net, currency, 0);
  return {
    status: reconciled ? 'reconciled' : 'variance',
    variance: reconciled ? 0 : signedVariance(expectedNet, net, currency),
    method: 'header_totals',
    reasonCode: reconciled ? 'reconciled_from_header_totals' : 'variance_from_header_totals',
    expectedNet,
    actualNet: net,
  };
}

function signedVariance(expected: number, actual: number, currency: string): number {
  return fromMinorUnits(toMinorUnits(expected, currency) - toMinorUnits(actual, currency), currency);
}

/**
 * A SEPARATE consistency check: does the stated gross agree with the sum of
 * the earning lines?
 *
 * Deliberately not folded into the reconciliation status above. A payslip can
 * have a perfectly reconciling gross→net while its stated gross disagrees with
 * its own earning lines (usually because an earning line was not extractable),
 * and conflating the two would hide one problem behind the other.
 */
export function checkGrossAgainstComponents(
  extraction: PayrollExtraction,
): { checked: boolean; agrees: boolean; statedGross?: number; componentGross?: number } {
  const currency = extraction.currencyCode;
  const gross = extraction.grossPay;
  const earnings = currentPeriod(extraction.components).filter((c) => c.side === 'earning');
  if (gross === undefined || earnings.length === 0) {
    return { checked: false, agrees: false };
  }
  // Reimbursements are excluded: a payslip's stated GROSS EARNINGS figure
  // conventionally excludes expense reimbursements, which are a repayment
  // rather than remuneration.
  const componentGross = sumMoney(
    earnings.filter((c) => c.type !== 'reimbursement').map((c) => c.amount),
    currency,
  );
  return {
    checked: true,
    agrees: moneyEquals(componentGross, gross, currency, 0),
    statedGross: gross,
    componentGross,
  };
}
