/**
 * FDH-12 — reconciling fund contribution evidence against FDH-9 payslip
 * evidence (spec sections 22-27, 64-67, 120).
 *
 * ============================================================================
 * THE HIGHEST-RISK RULE (spec sections 22, 120, 175)
 * ============================================================================
 *
 *   Payslip employer super           $1,000
 *   Fund statement employer contrib. $1,000
 *   -----------------------------------------
 *   CORRECT canonical contribution   $1,000
 *   FORBIDDEN                        $2,000
 *
 * These are TWO PIECES OF EVIDENCE FOR ONE ECONOMIC CONTRIBUTION.
 *
 * WHY $2,000 IS UNREACHABLE, in three independent layers:
 *
 *   1. NEITHER SOURCE POSTS TO CANONICAL. FDH-9 holds employer super in
 *      `fdh_payroll_events.employer_retirement_contribution` and writes it
 *      nowhere (certified by `tests/unit/fdh9DoubleCountCertification.test.ts`
 *      and by `fdh9_apply_income_proposal()`'s eight-column allow-list, which
 *      contains no retirement column). FDH-12 holds it as a statement activity
 *      and writes it nowhere either — canonical Retirement has no contribution
 *      ledger to write to. Two evidence stores, zero postings, so there is
 *      nothing to add up.
 *
 *   2. THE CANONICAL CONTRIBUTION IS A SINGLE PROPOSED FIELD. If the user
 *      chooses to update `retirement_accounts.employer_contribution`, that is
 *      ONE field taking ONE value from ONE proposal. It is an assignment, not
 *      an accumulation, so no arithmetic exists that could produce $2,000.
 *
 *   3. ONE PAYSLIP EVIDENCES AT MOST ONE FUND CONTRIBUTION. Migration 0112's
 *      `uq_fdh_retirement_activities_payroll_event` is a UNIQUE index on
 *      `matched_payroll_event_id`. Two fund activities cannot both claim the
 *      same payslip even if the matching code regressed.
 *
 * This module's job is therefore not to prevent the double count — that is
 * structural — but to RECOGNISE that the two records describe the same event,
 * so the UI can say "Matched payslip: Yes" and show one financial event rather
 * than two (spec section 148).
 *
 * ============================================================================
 * NEVER MATCH ON AMOUNT ALONE (spec sections 24, 26)
 * ============================================================================
 *
 * The key is (employer, amount, date-within-window). Spec section 26's
 * negative control — Employer A $1,000 vs Employer B $1,000 — fails to match
 * because employer is a REQUIRED component, not a tie-break. A candidate whose
 * employer cannot be compared at all is not a candidate.
 */

import { normaliseEmployerName } from '../payslip/normalise';
import { HUNDRED, ONE, ZERO, absMinorUnits, toMinorUnits, tryParseMoneyToMinorUnits } from './money';

/**
 * CONTRIBUTION TIMING WINDOW (spec sections 25, 67).
 *
 * Australian superannuation guarantee contributions are payable QUARTERLY —
 * an employer may lawfully remit a July pay period's super as late as 28
 * October. Requiring same-day equality would therefore produce a false
 * no-match on most real statements, and a window that is too tight is
 * indistinguishable in its effect from having no matching at all.
 *
 * 120 days forward covers the statutory quarterly cycle plus its 28-day
 * payment deadline plus clearing-house transit, with margin. 7 days backward
 * covers a fund crediting slightly ahead of the nominal pay date.
 *
 * The window is ASYMMETRIC on purpose: super arrives AFTER payroll, not
 * before, and a symmetric window would admit implausible backward matches for
 * no benefit.
 */
export const PAYSLIP_MATCH_WINDOW_DAYS_FORWARD = 120;
export const PAYSLIP_MATCH_WINDOW_DAYS_BACKWARD = 7;

/**
 * Amount tolerance: ZERO. Spec section 66 — payslip $1,000 vs fund $950 must
 * NOT be silently resolved to one of them. A difference is a variance the user
 * reviews, so there is deliberately no tolerance band that would absorb it.
 *
 * A near-miss still becomes a CANDIDATE (so the user can see the $50 gap and
 * decide); it simply never becomes an automatic `matched`.
 */
export const PAYSLIP_MATCH_AMOUNT_TOLERANCE_MINOR_UNITS = ZERO;

/** How close in amount a payslip must be to be offered as a variance
 * candidate at all. Beyond this it is a different contribution, not a
 * mismatched one. 20% keeps a $1,000-vs-$950 case visible while excluding
 * unrelated amounts. */
const VARIANCE_CANDIDATE_RELATIVE_TOLERANCE = 0.2;

export type PayslipMatchStatus =
  | 'matched'
  | 'no_match'
  | 'multiple_candidates'
  | 'not_attempted'
  | 'payslip_evidence_not_available'
  | 'variance_review_required';

/** The subset of an `fdh_payroll_events` row this module reads. FDH-12 never
 * writes to this table. */
export interface PayrollEventEvidence {
  id: string;
  employer_name: string | null;
  employer_normalised: string | null;
  pay_period_start: string | null;
  pay_period_end: string | null;
  payment_date: string | null;
  currency_code: string;
  /** The employer super / employer PF figure. FDH-9's own column name. */
  employer_retirement_contribution: string | number | null;
  employee_retirement_contribution: string | number | null;
}

/** The fund-side contribution being matched. */
export interface FundContributionEvidence {
  activityId?: string;
  /** EMPLOYER_CONTRIBUTION, SALARY_SACRIFICE or PERSONAL_CONTRIBUTION. */
  activityType: 'EMPLOYER_CONTRIBUTION' | 'SALARY_SACRIFICE' | 'PERSONAL_CONTRIBUTION';
  amount: string;
  currencyCode: string;
  /** When the fund credited it. */
  activityDate: string | null;
  /** The pay period the fund says it relates to, when the statement says. */
  effectivePeriodStart?: string | null;
  effectivePeriodEnd?: string | null;
  employerNameRaw?: string | null;
}

export interface PayslipMatchCandidate {
  payrollEventId: string;
  employerName: string | null;
  paymentDate: string | null;
  /** Minor units. Signed: fund minus payslip. */
  varianceMinorUnits: bigint;
  dayGap: number;
}

export interface PayslipMatchResult {
  status: PayslipMatchStatus;
  payrollEventId: string | null;
  varianceMinorUnits: bigint | null;
  candidates: PayslipMatchCandidate[];
  reason: string;
}

function daysBetween(a: string, b: string): number | null {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return Math.round((ta - tb) / 86_400_000);
}

/** Which payslip column corresponds to this fund activity type. */
function payslipAmountFor(
  activityType: FundContributionEvidence['activityType'],
  event: PayrollEventEvidence,
): string | number | null {
  // SALARY_SACRIFICE is an employer-routed concessional contribution, so it is
  // evidenced by the payslip's employer-retirement figure in FDH-9's model
  // (FDH-9 records `salary_sacrifice` separately as a DEDUCTION, which is the
  // payroll side of the same money; the amount that reaches the FUND is the
  // employer-retirement column). Spec section 31 forbids re-deriving gross or
  // tax from the statement, and this mapping deliberately does not.
  if (activityType === 'PERSONAL_CONTRIBUTION') return event.employee_retirement_contribution;
  return event.employer_retirement_contribution;
}

/**
 * Match one fund contribution against the user's payslip evidence.
 *
 * @param payrollEvents  every payslip in the reconciliation window. MUST
 *                       already be scoped to the owning user by the caller —
 *                       cross-tenant safety is enforced independently by
 *                       migration 0112's ownership trigger, but this function
 *                       is pure and does no I/O, so it trusts its input.
 */
export function matchContributionToPayslip(
  fund: FundContributionEvidence,
  payrollEvents: readonly PayrollEventEvidence[],
): PayslipMatchResult {
  // MISSING PAYSLIP IS NOT A FAILURE (spec section 65). A fund contribution
  // without a matching payslip is still perfectly valid retirement evidence.
  if (payrollEvents.length === 0) {
    return {
      status: 'payslip_evidence_not_available', payrollEventId: null,
      varianceMinorUnits: null, candidates: [],
      reason: 'no_payslip_evidence_on_file',
    };
  }

  const fundAmount = tryParseMoneyToMinorUnits(fund.amount);
  if (fundAmount === null) {
    return {
      status: 'no_match', payrollEventId: null, varianceMinorUnits: null, candidates: [],
      reason: 'fund_amount_unreadable',
    };
  }

  const fundEmployer = normaliseEmployerName(fund.employerNameRaw ?? null) ?? null;

  const candidates: PayslipMatchCandidate[] = [];
  for (const event of payrollEvents) {
    // Currency must agree (spec section 68).
    if (event.currency_code !== fund.currencyCode) continue;

    // --- EMPLOYER IS REQUIRED, NOT A TIE-BREAK (spec sections 24, 26) ------
    // A personal contribution is made by the member, not an employer, so it is
    // exempt from the employer requirement — its key is amount + date.
    if (fund.activityType !== 'PERSONAL_CONTRIBUTION') {
      const eventEmployer = event.employer_normalised
        ?? normaliseEmployerName(event.employer_name ?? null)
        ?? null;
      // No comparable employer on either side means this pair CANNOT be
      // matched on the required key. Falling through to amount+date here would
      // reintroduce exactly the amount-alone match spec section 26 forbids.
      if (!fundEmployer || !eventEmployer) continue;
      if (fundEmployer !== eventEmployer) continue;
    }

    const payslipAmount = toMinorUnits(payslipAmountFor(fund.activityType, event));
    if (payslipAmount === null || payslipAmount === ZERO) continue;

    // --- DATE WINDOW (spec sections 25, 67) --------------------------------
    // Measured from the payslip's payment date (or period end) to the fund's
    // credit date. Super arrives after payroll.
    const payslipDate = event.payment_date ?? event.pay_period_end ?? null;
    let dayGap = 0;
    if (fund.activityDate && payslipDate) {
      const gap = daysBetween(fund.activityDate, payslipDate);
      if (gap === null) continue;
      if (gap > PAYSLIP_MATCH_WINDOW_DAYS_FORWARD) continue;
      if (gap < -PAYSLIP_MATCH_WINDOW_DAYS_BACKWARD) continue;
      dayGap = gap;
    } else if (fund.effectivePeriodStart && event.pay_period_start) {
      // The statement stated the pay period it relates to — stronger evidence
      // than a credit date, and used in preference when a credit date is
      // absent.
      const gap = daysBetween(event.pay_period_start, fund.effectivePeriodStart);
      if (gap === null || Math.abs(gap) > 31) continue;
      dayGap = gap;
    } else {
      // Neither side gives a usable date. Amount + employer alone is not
      // enough to assert identity, so this is not a candidate.
      continue;
    }

    const variance = fundAmount - payslipAmount;
    // Beyond the relative band this is a different contribution entirely, not
    // a variance on the same one.
    const scale = payslipAmount === ZERO ? ONE : absMinorUnits(payslipAmount);
    const relativeNumerator = absMinorUnits(variance) * HUNDRED;
    if (relativeNumerator > scale * BigInt(Math.round(VARIANCE_CANDIDATE_RELATIVE_TOLERANCE * 100))) continue;

    candidates.push({
      payrollEventId: event.id,
      employerName: event.employer_name,
      paymentDate: event.payment_date,
      varianceMinorUnits: variance,
      dayGap,
    });
  }

  if (candidates.length === 0) {
    return {
      status: 'no_match', payrollEventId: null, varianceMinorUnits: null, candidates: [],
      reason: 'no_payslip_matches_this_contribution',
    };
  }

  const exact = candidates.filter(
    (c) => absMinorUnits(c.varianceMinorUnits) <= PAYSLIP_MATCH_AMOUNT_TOLERANCE_MINOR_UNITS,
  );

  // MULTIPLE PLAUSIBLE MATCHES -> REVIEW (spec section 27). Never the first,
  // never the closest.
  if (exact.length > 1) {
    return {
      status: 'multiple_candidates', payrollEventId: null, varianceMinorUnits: null,
      candidates, reason: 'multiple_payslips_match_this_contribution',
    };
  }
  if (exact.length === 1) {
    return {
      status: 'matched', payrollEventId: exact[0].payrollEventId,
      varianceMinorUnits: exact[0].varianceMinorUnits, candidates,
      reason: 'matched_on_employer_amount_and_date',
    };
  }

  // Only near-misses remain. Spec section 66: do not silently choose one.
  return {
    status: 'variance_review_required', payrollEventId: null,
    varianceMinorUnits: candidates[0].varianceMinorUnits, candidates,
    reason: 'payslip_and_fund_amounts_differ_review_required',
  };
}

/**
 * The reconciled economic contribution for a matched pair (spec sections 22,
 * 64, 120).
 *
 * Returns ONE amount. There is no code path in this module that returns a sum
 * of the two sources — the function does not even accept an "add" mode. When
 * both agree, the answer is that agreed amount. When they disagree, the answer
 * is `null` and the caller must raise a review; picking one silently is what
 * spec section 66 forbids.
 */
export function reconciledContributionMinorUnits(
  fundAmount: string,
  payslipAmount: string | number | null,
): bigint | null {
  const fund = tryParseMoneyToMinorUnits(fundAmount);
  if (fund === null) return null;
  const payslip = toMinorUnits(payslipAmount);
  // No payslip evidence: the fund statement stands on its own (spec 65).
  if (payslip === null || payslip === ZERO) return fund;
  if (fund === payslip) return fund;
  return null; // disagreement — the caller raises a variance review
}
