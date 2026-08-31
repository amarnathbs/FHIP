/**
 * FDH-11 — Australia BANK <-> BROKER matching (spec sections 28-31, 66-71,
 * 100-102, 110-113).
 *
 * NEVER AMOUNT ALONE (spec section 66, mandatory negative control: same
 * amount / wrong broker must NOT auto-match — spec section 67). Every
 * candidate is scored on THREE independent signals — amount, date proximity,
 * and institution/narrative/known-linked-account evidence — and a candidate
 * that matches on amount alone can never reach `matched`.
 *
 * MULTIPLE PLAUSIBLE CANDIDATES -> REVIEW_REQUIRED (spec section 68). Never
 * auto-picks the highest-scored candidate when more than one clears the
 * threshold.
 *
 * NO BANK EVIDENCE -> BANK_EVIDENCE_NOT_AVAILABLE, not a parsing failure
 * (spec section 69) — this module's caller is responsible for choosing this
 * outcome when there are zero candidates to even score, distinct from
 * `no_match` (candidates existed but none scored).
 *
 * Structurally identical in spirit to
 * `lib/financial-data-hub/liability/bankMatching.ts` (FDH-10) — reimplemented
 * independently per this repo's isolation-discipline precedent (each
 * FDH sub-module keeps its own small, independently-tested copy of matching
 * logic rather than importing a sibling's, per
 * `FDH10_REUSE_AND_GAP_AUDIT.md`'s "isolation discipline" section).
 */

export interface BankTransactionCandidate {
  transactionId: string;
  amount: number;
  transactionDate: string; // YYYY-MM-DD
  /** True when the bank transaction's own institution/narrative names the
   * SAME broker/account the statement evidence belongs to. */
  institutionOrNarrativeMatches: boolean;
  /** True when the bank transaction's narrative positively names a
   * DIFFERENT broker than the one being matched — spec section 67's negative
   * control signal; this is what makes "same amount, wrong broker"
   * categorically unable to match. */
  positivelyWrongBroker: boolean;
}

export interface BankMatchQuery {
  amount: number;
  eventDate: string; // YYYY-MM-DD
  currencyCode: string;
  dateToleranceDays?: number;
}

export type BankMatchOutcome = 'matched' | 'no_match' | 'multiple_candidates' | 'bank_evidence_not_available';

export interface BankMatchResult {
  outcome: BankMatchOutcome;
  matchedTransactionId: string | null;
  candidates: { transactionId: string; score: number }[];
}

function daysBetween(a: string, b: string): number {
  const ms = Math.abs(new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime());
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

function scoreCandidate(
  query: Required<Pick<BankMatchQuery, 'dateToleranceDays'>> & BankMatchQuery,
  candidate: BankTransactionCandidate,
): number | null {
  if (candidate.positivelyWrongBroker) return null;
  if (Math.round(candidate.amount * 100) !== Math.round(query.amount * 100)) return null;
  const days = daysBetween(query.eventDate, candidate.transactionDate);
  if (days > query.dateToleranceDays) return null;
  // Amount + date alone is NEVER enough (spec section 66) — an institution/
  // narrative signal must also be present.
  if (!candidate.institutionOrNarrativeMatches) return null;

  let score = 50;
  score += Math.max(0, 20 - days * 4);
  score += 20; // institution/narrative confirmed
  return score;
}

const MATCH_SCORE_THRESHOLD = 60;

export function matchBankBrokerEvent(
  query: BankMatchQuery,
  candidates: readonly BankTransactionCandidate[],
): BankMatchResult {
  if (candidates.length === 0) {
    return { outcome: 'bank_evidence_not_available', matchedTransactionId: null, candidates: [] };
  }
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
  return { outcome: 'multiple_candidates', matchedTransactionId: null, candidates: scored };
}
