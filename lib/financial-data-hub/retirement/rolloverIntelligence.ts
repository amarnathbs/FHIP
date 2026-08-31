/**
 * FDH-12 — rollover intelligence (spec sections 33-35, 122, 149).
 *
 * ============================================================================
 * THE HIGHEST-RISK RETIREMENT RULE (spec section 33)
 * ============================================================================
 *
 *   Old fund  -$100,000
 *   New fund  +$100,000
 *   ------------------------------------------
 *   CORRECT:  a ROLLOVER / TRANSFER
 *   FORBIDDEN: income $100,000
 *   FORBIDDEN: expense $100,000
 *   FORBIDDEN: household net worth +$100,000
 *
 * WHY EACH FORBIDDEN OUTCOME IS UNREACHABLE:
 *
 *   income / expense — FDH-12 has no write path to `income_sources`, to any
 *     expense register, or to `fdh_transactions`. There is no function, no
 *     allow-list entry and no column through which a rollover could become
 *     either. `tests/unit/fdh12Isolation.test.ts` asserts the absence
 *     mechanically over the real source tree.
 *
 *   net worth +$100,000 — net worth is `Σ retirement_accounts.current_balance`
 *     (`lib/engines/dashboard.ts:582`) and nothing else. A rollover changes
 *     which account holds the money; applying both statements sets Fund A's
 *     balance to its new (lower) closing figure and Fund B's to its new
 *     (higher) one. The sum is unchanged because each balance is ASSIGNED from
 *     its own statement's closing figure, never incremented.
 *
 * The double-count hazard spec section 34 describes — "Fund A = $0, Fund B =
 * $100,000, household $100,000, never $200,000" — therefore cannot arise from
 * applying, only from FAILING TO APPLY Fund A's statement while applying Fund
 * B's. That is a user-visible state (Fund A still shows its old balance), and
 * this module's job is to make it visible: a matched rollover pair tells the
 * UI to prompt for both sides.
 *
 * ============================================================================
 * PARTIAL ROLLOVERS (spec section 35)
 * ============================================================================
 *
 * Fund A $150,000, rolls out $50,000; Fund B receives $50,000. Final: A
 * $100,000, B $50,000, total $150,000. Nothing special is required — each
 * statement's own closing balance is the proposed value, and the arithmetic
 * takes care of itself precisely because balances are assigned rather than
 * adjusted. This module still pairs the two activities so the user understands
 * what happened.
 */

import { ZERO, absMinorUnits, tryParseMoneyToMinorUnits } from './money';
import type { RetirementActivityType } from './types';

/** How far apart the two legs of one rollover may be. Fund-to-fund transfers
 * clear through a clearing house and commonly show different dates on the two
 * statements; 30 days is generous enough for that without admitting unrelated
 * movements. */
export const ROLLOVER_PAIR_WINDOW_DAYS = 30;

export type RolloverMatchStatus = 'matched' | 'no_match' | 'multiple_candidates' | 'not_attempted';

export interface RolloverLeg {
  activityId: string;
  statementId: string;
  /** ROLLOVER_OUT or ROLLOVER_IN. */
  activityType: RetirementActivityType;
  amount: string;
  currencyCode: string;
  activityDate: string | null;
  /** The fund this leg belongs to, for display. */
  fundName: string | null;
  /** The canonical account this leg's statement resolved to, when known. */
  canonicalAccountId: string | null;
}

export interface RolloverPairResult {
  status: RolloverMatchStatus;
  counterpartActivityId: string | null;
  candidates: { activityId: string; fundName: string | null; dayGap: number }[];
  reason: string;
}

function daysBetween(a: string, b: string): number | null {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return Math.round((ta - tb) / 86_400_000);
}

/**
 * Pair one rollover leg with its counterpart among the user's other retirement
 * statement activities.
 *
 * Matching key: opposite direction, equal amount, same currency, DIFFERENT
 * canonical account, within the window. The different-account requirement is
 * what stops a fund's own internal switch (which some statements report as a
 * paired out/in) being read as an inter-fund rollover.
 */
export function matchRolloverCounterpart(
  leg: RolloverLeg,
  otherLegs: readonly RolloverLeg[],
): RolloverPairResult {
  if (leg.activityType !== 'ROLLOVER_IN' && leg.activityType !== 'ROLLOVER_OUT') {
    return { status: 'not_attempted', counterpartActivityId: null, candidates: [], reason: 'not_a_rollover_activity' };
  }
  const wantedType: RetirementActivityType =
    leg.activityType === 'ROLLOVER_OUT' ? 'ROLLOVER_IN' : 'ROLLOVER_OUT';

  const amount = tryParseMoneyToMinorUnits(leg.amount);
  if (amount === null) {
    return { status: 'no_match', counterpartActivityId: null, candidates: [], reason: 'rollover_amount_unreadable' };
  }

  const candidates: { activityId: string; fundName: string | null; dayGap: number }[] = [];
  for (const other of otherLegs) {
    if (other.activityId === leg.activityId) continue;
    if (other.activityType !== wantedType) continue;
    if (other.currencyCode !== leg.currencyCode) continue;
    // Must be a DIFFERENT account — an intra-fund switch is not a rollover.
    if (leg.canonicalAccountId && other.canonicalAccountId
        && leg.canonicalAccountId === other.canonicalAccountId) continue;
    // Nor the same statement.
    if (other.statementId === leg.statementId) continue;

    const otherAmount = tryParseMoneyToMinorUnits(other.amount);
    if (otherAmount === null) continue;
    // Exact equality. A partial rollover has equal legs too — $50,000 out and
    // $50,000 in — so no tolerance is needed or wanted.
    if (absMinorUnits(otherAmount - amount) !== ZERO) continue;

    let dayGap = 0;
    if (leg.activityDate && other.activityDate) {
      const gap = daysBetween(other.activityDate, leg.activityDate);
      if (gap === null || Math.abs(gap) > ROLLOVER_PAIR_WINDOW_DAYS) continue;
      dayGap = gap;
    }
    candidates.push({ activityId: other.activityId, fundName: other.fundName, dayGap });
  }

  if (candidates.length === 0) {
    // A rollover with no visible counterpart is still perfectly valid
    // evidence: the user may simply not have uploaded the other fund's
    // statement. Not an error, and never a reason to reclassify the activity.
    return { status: 'no_match', counterpartActivityId: null, candidates: [], reason: 'counterpart_statement_not_available' };
  }
  if (candidates.length > 1) {
    return {
      status: 'multiple_candidates', counterpartActivityId: null, candidates,
      reason: 'multiple_rollover_counterparts_review_required',
    };
  }
  return {
    status: 'matched', counterpartActivityId: candidates[0].activityId, candidates,
    reason: 'matched_opposite_leg_same_amount_and_period',
  };
}

/**
 * The household-level assertion behind spec sections 34 and 122, exposed as a
 * function so the certification harness can call it directly rather than
 * asserting on a prose claim.
 *
 * Given the balances a set of retirement statements would produce if applied,
 * the household total is their SUM — because each is an assignment. This
 * function exists to be tested against the forbidden $200,000 answer.
 */
export function householdRetirementTotalMinorUnits(
  proposedClosingBalances: readonly string[],
): bigint | null {
  let total = ZERO;
  for (const b of proposedClosingBalances) {
    const parsed = tryParseMoneyToMinorUnits(b);
    if (parsed === null) return null;
    total += parsed;
  }
  return total;
}
