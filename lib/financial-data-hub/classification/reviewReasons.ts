/**
 * FDH-6 — structured review-reason surfacing (spec section 64, gap G1 in
 * `docs/financial-data-hub/FDH6_R8_ADOPTION_AND_GAP_AUDIT.md`).
 *
 * "Transactions requiring review must surface why." `fdh_transactions.
 * review_status` already exists (FDH-1); what was missing was a structured
 * taxonomy of WHY a row is `pending`/`in_review`.
 *
 * DELIBERATELY NOT A NEW COLUMN. The classification engine is pure and
 * deterministic (spec section 62), so a reason is always reproducible from
 * already-persisted signals — there is nothing here a stored column would
 * capture that this function cannot recompute on demand from data R8/R7
 * already writes. This keeps FDH-6 migration-free for this capability
 * (spec section 114's own "if FDH-6 needs no schema migration at all, that
 * is a genuinely good outcome").
 *
 * PURE FUNCTION — no DB access. `services/classificationReviewService.ts`
 * gathers the inputs (from `fdh_transactions`, `fdh_transaction_links`,
 * `fdh_duplicate_candidates`) and calls this.
 */

import type { FdhEconomicTransactionType } from '../constants/enums';
import { CLASSIFICATION_CONFIDENCE_SCORE } from './thresholds';
import type { ClassificationSource } from './types';

export const FDH_REVIEW_REASON_CODES = [
  'UNKNOWN_CLASSIFICATION',
  'RULE_CONFLICT',
  'POSSIBLE_TRANSFER',
  'MISSING_COUNTERPART_ACCOUNT',
  'POSSIBLE_DUPLICATE',
  'LOW_CLASSIFICATION_CONFIDENCE',
  'POSSIBLE_REFUND',
] as const;
export type FdhReviewReasonCode = (typeof FDH_REVIEW_REASON_CODES)[number];

export interface ReviewReasonInput {
  reviewStatus: 'not_required' | 'pending' | 'in_review' | 'resolved';
  economicTransactionType: FdhEconomicTransactionType;
  /** `fdh_transactions.classification_confidence` as persisted — the
   * `numeric(5,4)` bucket value, not the `ClassificationConfidenceState`
   * label (spec section 18: confidence is not one number, but this specific
   * field IS a number by design). */
  classificationConfidence: number | null;
  /** Only present when the caller has a freshly-recomputed
   * `EconomicTypeResult` on hand (e.g. immediately after a classification
   * run) — a stored transaction row alone cannot distinguish "genuinely
   * unresolved" from "was a rule conflict", since both persist identically
   * as `economic_transaction_type = 'unknown'` /
   * `classification_method = 'unclassified'`. Omit when recomputing the
   * engine is not warranted just to explain an old row — the reason simply
   * degrades to the always-safe `UNKNOWN_CLASSIFICATION`. */
  classificationSourceKind?: ClassificationSource['kind'];
  /** An `fdh_transaction_links` row exists with this transaction as
   * `transaction_id_from`, `transaction_id_to IS NULL`, `status = 'pending'`
   * — the persistent MISSING_COUNTERPART_ACCOUNT pattern (spec section 26). */
  openTransferLinkExists: boolean;
  /** A `fdh_transaction_links` row exists with BOTH sides present,
   * `status = 'pending'`, `link_type` a transfer/settlement kind — proposed
   * but not yet confirmed/rejected by the user. */
  pendingTransferLinkExists: boolean;
  /** A `fdh_duplicate_candidates` row exists referencing this transaction
   * with `status = 'pending'` (R7 — spec section 31-34). */
  pendingDuplicateCandidateExists: boolean;
  /** A `fdh_transaction_links` row exists with `link_type IN
   * ('refund_original','reversal_original')`, `status = 'pending'`,
   * referencing this transaction. */
  pendingRefundLinkExists: boolean;
}

export interface ReviewReasonResult {
  reasons: FdhReviewReasonCode[];
  /** Concise, deterministic, machine-generated sentence (spec section 61) —
   * never LLM prose. */
  explanation: string;
}

const REASON_TEXT: Record<FdhReviewReasonCode, string> = {
  UNKNOWN_CLASSIFICATION: 'no rule or merchant match was found for this transaction',
  RULE_CONFLICT: 'two or more active rules matched with different outcomes at the same priority',
  POSSIBLE_TRANSFER: 'this looks like a transfer to/from another of your accounts, pending your confirmation',
  MISSING_COUNTERPART_ACCOUNT:
    'this looks like a transfer to/from another account, but the other side has not been imported yet',
  POSSIBLE_DUPLICATE: 'this transaction may be a duplicate of another one already recorded',
  LOW_CLASSIFICATION_CONFIDENCE: 'the automatic classification has low confidence',
  POSSIBLE_REFUND: 'this transaction may be a refund/reversal of an earlier purchase, pending your confirmation',
};

/** Below-or-equal-to the LOW confidence bucket (spec section 83: fuzzy text
 * alone never earns a high score; a LOW-bucket or unresolved classification
 * is exactly the case a reviewer should be told about). */
const LOW_CONFIDENCE_CEILING = CLASSIFICATION_CONFIDENCE_SCORE.LOW;

/**
 * Computes WHY a transaction is (or would be) in review, in a fixed,
 * deterministic priority order — never randomised, never LLM-generated.
 * Returns an empty reason list (and a "no review required" explanation)
 * for any row that is not `pending`/`in_review`, matching spec section 19:
 * `not_required`/`resolved` are themselves valid, safe states, not
 * something this function second-guesses.
 */
export function deriveReviewReasons(input: ReviewReasonInput): ReviewReasonResult {
  if (input.reviewStatus !== 'pending' && input.reviewStatus !== 'in_review') {
    return { reasons: [], explanation: 'No review required.' };
  }

  const reasons: FdhReviewReasonCode[] = [];

  if (input.classificationSourceKind === 'rule_conflict') {
    reasons.push('RULE_CONFLICT');
  } else if (input.economicTransactionType === 'unknown') {
    reasons.push('UNKNOWN_CLASSIFICATION');
  }

  if (input.openTransferLinkExists) {
    reasons.push('MISSING_COUNTERPART_ACCOUNT');
  } else if (input.pendingTransferLinkExists) {
    reasons.push('POSSIBLE_TRANSFER');
  }

  if (input.pendingDuplicateCandidateExists) reasons.push('POSSIBLE_DUPLICATE');
  if (input.pendingRefundLinkExists) reasons.push('POSSIBLE_REFUND');

  // Only meaningful once SOME classification was actually reached — an
  // already-UNKNOWN row has no confidence to be "low", it is simply unknown.
  if (
    input.economicTransactionType !== 'unknown'
    && input.classificationConfidence !== null
    && input.classificationConfidence <= LOW_CONFIDENCE_CEILING
  ) {
    reasons.push('LOW_CLASSIFICATION_CONFIDENCE');
  }

  // A row can legitimately be `pending` with none of the above yet detected
  // (e.g. `in_review` set for a reason this function's inputs do not cover
  // today) — fall back to the always-safe, always-true UNKNOWN_CLASSIFICATION
  // rather than returning an empty, unexplained reason list for a row that
  // IS pending.
  if (reasons.length === 0) reasons.push('UNKNOWN_CLASSIFICATION');

  const explanation = reasons.map((r) => REASON_TEXT[r]).join('; ');
  return { reasons, explanation: explanation.charAt(0).toUpperCase() + explanation.slice(1) + '.' };
}
