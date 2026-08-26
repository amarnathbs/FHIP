/**
 * FDH-10 — Credit Cards & Loans Intelligence: BANK PAYMENT MATCHING (spec
 * sections 39-43).
 *
 * NEVER AMOUNT ALONE (spec section 39, mandatory negative control: "same
 * amount / wrong lender must NOT auto-match"). Every candidate is scored on
 * FOUR independent signals — amount, date proximity, institution/narrative,
 * and facility identity (masked identifier / account) — and a candidate that
 * matches on amount alone (no institution/facility signal at all) can never
 * reach `matched`; it is filtered out as `no_match` rather than surviving on
 * a weak score, and a same-amount candidate that positively points at the
 * WRONG facility is rejected outright, not merely deprioritised (spec's own
 * "must NOT auto-match" framing — silently ranking it a distant #2 candidate
 * while still exposing it as selectable would not satisfy that).
 *
 * MULTIPLE PLAUSIBLE CANDIDATES -> REVIEW_REQUIRED (spec section 41). This
 * module never auto-picks the first or highest-scored candidate when more
 * than one clears the match threshold — ties and near-ties both count.
 *
 * ONE REPAYMENT EVENT (spec section 43). This module only ever proposes a
 * link between a statement PAYMENT activity and an EXISTING bank transaction
 * — it creates no transaction of its own, so "matched" can never itself cause
 * a second cash outflow to be recorded.
 */

export interface BankTransactionCandidate {
  transactionId: string;
  amount: number;
  transactionDate: string; // YYYY-MM-DD
  /** True when the transaction's own institution/account is the account the
   * user has already told FHIP services this facility's repayments come
   * from (spec section 39's "known repayment account" signal), OR the
   * transaction's narrative names the lender/facility. */
  institutionOrNarrativeMatches: boolean;
  /** True when the transaction's narrative/reference positively names a
   * DIFFERENT facility/lender than the one being matched — a strong negative
   * signal, not merely the absence of a positive one. */
  positivelyWrongFacility: boolean;
  /** True when this transaction is part of an established recurring pattern
   * for this facility (spec section 39's "recurring pattern" signal). */
  recurringPatternMatch?: boolean;
}

export interface BankMatchQuery {
  paymentAmount: number;
  paymentDate: string; // YYYY-MM-DD
  currencyCode: string;
  /** Maximum days between the statement's payment date and a candidate's
   * transaction date to be considered at all. */
  dateToleranceDays?: number;
}

export type BankMatchOutcome = 'matched' | 'no_match' | 'multiple_candidates';

export interface BankMatchResult {
  outcome: BankMatchOutcome;
  matchedTransactionId: string | null;
  /** Every candidate that cleared the minimum bar, for REVIEW_REQUIRED UX
   * (spec section 68's compare view) — empty when `outcome === 'no_match'`. */
  candidates: { transactionId: string; score: number }[];
}

function daysBetween(a: string, b: string): number {
  const ms = Math.abs(new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime());
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

/**
 * Score one candidate against the query. Returns `null` when the candidate
 * must not be considered at all — amount mismatch, date outside tolerance, or
 * a POSITIVE wrong-facility signal (spec section 39's mandatory negative
 * control: this is what makes "same amount, wrong lender" categorically
 * unable to match, not merely score lower).
 */
function scoreCandidate(query: Required<Pick<BankMatchQuery, 'dateToleranceDays'>> & BankMatchQuery, candidate: BankTransactionCandidate): number | null {
  if (candidate.positivelyWrongFacility) return null;
  // Amount must match exactly (statement and bank currencies are assumed
  // reconciled to the same settlement currency by the caller — spec 74).
  if (Math.round(candidate.amount * 100) !== Math.round(query.paymentAmount * 100)) return null;
  const days = daysBetween(query.paymentDate, candidate.transactionDate);
  if (days > query.dateToleranceDays) return null;

  // Amount + date alone is NEVER enough (spec section 39) — a genuine
  // institution/narrative or recurring-pattern signal must also be present.
  if (!candidate.institutionOrNarrativeMatches && !candidate.recurringPatternMatch) return null;

  let score = 50; // base: amount + date within tolerance
  score += Math.max(0, 20 - days * 4); // closer date, higher score
  if (candidate.institutionOrNarrativeMatches) score += 20;
  if (candidate.recurringPatternMatch) score += 10;
  return score;
}

const MATCH_SCORE_THRESHOLD = 60;

export function matchBankPayment(
  query: BankMatchQuery,
  candidates: readonly BankTransactionCandidate[],
): BankMatchResult {
  const q = { dateToleranceDays: query.dateToleranceDays ?? 5, ...query };
  const scored = candidates
    .map((c) => ({ transactionId: c.transactionId, score: scoreCandidate(q, c) }))
    .filter((s): s is { transactionId: string; score: number } => s.score !== null && s.score >= MATCH_SCORE_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return { outcome: 'no_match', matchedTransactionId: null, candidates: [] };
  }
  if (scored.length === 1) {
    return { outcome: 'matched', matchedTransactionId: scored[0].transactionId, candidates: scored };
  }
  // More than one candidate cleared the bar — even if one scores higher,
  // spec section 41 requires REVIEW_REQUIRED rather than auto-picking the
  // top score, so both/all are surfaced and none is selected automatically.
  return { outcome: 'multiple_candidates', matchedTransactionId: null, candidates: scored };
}
