/**
 * FDH-12 — matching retirement activity to bank transaction evidence
 * (spec sections 38, 77-81, 126).
 *
 * ============================================================================
 * WHICH ACTIVITIES EVEN HAVE A BANK SIDE
 * ============================================================================
 *
 * Most retirement activity never touches household cash. Employer
 * contributions are remitted by the employer; earnings, fees, insurance
 * premiums, taxes and rollovers all move money INSIDE the fund or between
 * funds. `RETIREMENT_ACTIVITY_IS_INTERNAL` in `./types.ts` is the single
 * definition of which is which, and this module refuses to even look for a
 * bank match for an internal activity.
 *
 * That is spec section 81 ("Super statement remains valid without bank data.
 * Do not require corroborating bank transaction for employer contributions or
 * internal earnings") implemented as a hard gate rather than a lenient
 * default: an internal activity returns `not_expected`, which is a distinct
 * state from `no_match` and never raises a review item.
 *
 * ============================================================================
 * NEVER MATCH ON AMOUNT ALONE (spec section 77)
 * ============================================================================
 *
 * The key is (amount, date-within-window, direction, narrative evidence). Spec
 * section 79's negative control — the same $5,000 sent to a DIFFERENT fund —
 * fails to match because the narrative must corroborate the fund, and a
 * transaction whose narrative names a different fund is positively excluded
 * rather than merely not-preferred.
 *
 * ============================================================================
 * ONE ECONOMIC EVENT, NOT TWO (spec sections 38, 78, 126)
 * ============================================================================
 *
 * A confident match links the two records so the UI shows one transfer.
 * Neither record is created, deleted or reclassified — FDH-12 has no write
 * path to `fdh_transactions` at all. And critically, spec section 36: a
 * matched withdrawal is NOT thereby classified as ordinary income. This module
 * assigns no tax treatment, no income type and no economic class. It links,
 * and stops.
 */

import { RETIREMENT_ACTIVITY_IS_INTERNAL, type RetirementActivityType } from './types';
import { ZERO, absMinorUnits, toMinorUnits, tryParseMoneyToMinorUnits } from './money';

/**
 * Settlement window. A personal contribution or a withdrawal clears in days,
 * not months — a much tighter window than the payslip one, because there is no
 * quarterly statutory cycle involved.
 */
export const BANK_MATCH_WINDOW_DAYS = 10;

/** Zero tolerance: a bank transfer of $5,000 and a fund credit of $5,000 are
 * the same event; $4,950 is not, and deciding otherwise is not this module's
 * call to make. */
export const BANK_MATCH_AMOUNT_TOLERANCE_MINOR_UNITS = ZERO;

export type RetirementBankMatchStatus =
  | 'matched'
  | 'no_match'
  | 'multiple_candidates'
  | 'not_attempted'
  | 'bank_evidence_not_available'
  | 'not_expected';

/** The subset of an `fdh_transactions` row this module reads. FDH-12 never
 * writes to this table. */
export interface BankTransactionEvidence {
  id: string;
  transaction_date: string | null;
  amount_original: string | number | null;
  credit_debit: 'credit' | 'debit';
  /** `fdh_transactions.currency_original` (migration 0047). NOT
   * `currency_code` — that column does not exist on this table, and naming it
   * so was a real defect caught by the PGlite certification harness. */
  currency_original: string;
  /** `description_clean` where classification has run, falling back to
   * `description_raw`. Used only for narrative corroboration (spec 79). */
  description_clean: string | null;
  description_raw: string | null;
}

export interface RetirementBankMatchCandidate {
  transactionId: string;
  transactionDate: string | null;
  dayGap: number;
  narrativeCorroborates: boolean;
}

export interface RetirementBankMatchResult {
  status: RetirementBankMatchStatus;
  transactionId: string | null;
  candidates: RetirementBankMatchCandidate[];
  reason: string;
}

function daysBetween(a: string, b: string): number | null {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return Math.round((ta - tb) / 86_400_000);
}

function foldNarrative(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Significant tokens of a fund name, for narrative corroboration. Short and
 * generic words are dropped so "super" alone cannot corroborate anything. */
const GENERIC_FUND_WORDS = new Set([
  'super', 'superannuation', 'fund', 'pension', 'retirement', 'the', 'and',
  'pty', 'ltd', 'limited', 'trust', 'australia', 'australian',
]);

function fundTokens(fundName: string | null | undefined): string[] {
  return foldNarrative(fundName)
    .split(' ')
    .filter((t) => t.length >= 3 && !GENERIC_FUND_WORDS.has(t));
}

/**
 * The direction a bank transaction must have to corroborate this activity.
 *
 * PERSONAL_CONTRIBUTION: money leaves the bank        -> 'debit'
 * WITHDRAWAL / PENSION_PAYMENT: money arrives         -> 'credit'
 */
function expectedBankDirection(type: RetirementActivityType): 'credit' | 'debit' | null {
  if (type === 'PERSONAL_CONTRIBUTION') return 'debit';
  if (type === 'WITHDRAWAL' || type === 'PENSION_PAYMENT') return 'credit';
  return null;
}

export function matchRetirementActivityToBank(
  activity: {
    activityType: RetirementActivityType;
    amount: string;
    currencyCode: string;
    activityDate: string | null;
  },
  fundName: string | null,
  transactions: readonly BankTransactionEvidence[],
): RetirementBankMatchResult {
  // --- INTERNAL ACTIVITIES ARE NOT EXPECTED TO HAVE A BANK SIDE -----------
  // spec section 81. Returned as its own state so no review item is raised
  // and no UI ever asks the user to find a bank transaction that cannot exist.
  if (RETIREMENT_ACTIVITY_IS_INTERNAL[activity.activityType]) {
    return {
      status: 'not_expected', transactionId: null, candidates: [],
      reason: 'internal_fund_activity_no_household_cash_movement',
    };
  }

  const direction = expectedBankDirection(activity.activityType);
  if (direction === null) {
    return {
      status: 'not_expected', transactionId: null, candidates: [],
      reason: 'activity_type_has_no_defined_bank_side',
    };
  }

  if (transactions.length === 0) {
    return {
      status: 'bank_evidence_not_available', transactionId: null, candidates: [],
      reason: 'no_bank_transactions_on_file',
    };
  }

  const amount = tryParseMoneyToMinorUnits(activity.amount);
  if (amount === null) {
    return { status: 'no_match', transactionId: null, candidates: [], reason: 'activity_amount_unreadable' };
  }
  if (!activity.activityDate) {
    return { status: 'no_match', transactionId: null, candidates: [], reason: 'activity_has_no_date_to_match_on' };
  }

  const wantedTokens = fundTokens(fundName);

  const candidates: RetirementBankMatchCandidate[] = [];
  for (const txn of transactions) {
    if (txn.currency_original !== activity.currencyCode) continue;
    if (txn.credit_debit !== direction) continue;

    const txnAmount = toMinorUnits(txn.amount_original);
    if (txnAmount === null) continue;
    if (absMinorUnits(txnAmount - amount) > BANK_MATCH_AMOUNT_TOLERANCE_MINOR_UNITS) continue;

    if (!txn.transaction_date) continue;
    const gap = daysBetween(txn.transaction_date, activity.activityDate);
    if (gap === null || Math.abs(gap) > BANK_MATCH_WINDOW_DAYS) continue;

    const narrative = foldNarrative(txn.description_clean ?? txn.description_raw);
    const narrativeCorroborates = wantedTokens.length > 0
      && wantedTokens.some((t) => narrative.includes(t));

    candidates.push({
      transactionId: txn.id,
      transactionDate: txn.transaction_date,
      dayGap: gap,
      narrativeCorroborates,
    });
  }

  if (candidates.length === 0) {
    return { status: 'no_match', transactionId: null, candidates: [], reason: 'no_bank_transaction_matches' };
  }

  // --- WRONG-FUND NEGATIVE CONTROL (spec section 79) ----------------------
  // When we KNOW the fund's name, a narrative is required to corroborate it.
  // Amount + date + direction alone are not enough to assert that this
  // particular $5,000 went to THIS fund rather than another one, and asserting
  // it anyway is exactly the failure the spec names.
  if (wantedTokens.length > 0) {
    const corroborated = candidates.filter((c) => c.narrativeCorroborates);
    if (corroborated.length === 1) {
      return {
        status: 'matched', transactionId: corroborated[0].transactionId, candidates,
        reason: 'matched_on_amount_date_direction_and_fund_narrative',
      };
    }
    if (corroborated.length > 1) {
      return {
        status: 'multiple_candidates', transactionId: null, candidates: corroborated,
        reason: 'multiple_bank_transactions_match_this_activity',
      };
    }
    return {
      status: 'no_match', transactionId: null, candidates,
      reason: 'no_bank_transaction_narrative_corroborates_this_fund',
    };
  }

  // No fund name to corroborate against. A single amount+date+direction match
  // is acceptable; more than one is ambiguous (spec section 80).
  if (candidates.length === 1) {
    return {
      status: 'matched', transactionId: candidates[0].transactionId, candidates,
      reason: 'single_bank_transaction_matches_amount_date_and_direction',
    };
  }
  return {
    status: 'multiple_candidates', transactionId: null, candidates,
    reason: 'multiple_bank_transactions_match_this_activity',
  };
}
