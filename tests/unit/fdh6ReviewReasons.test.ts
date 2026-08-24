/**
 * FDH-6 — structured review-reason surfacing (gap G1, spec section 64).
 * Pure function, no database.
 */
import { describe, expect, it } from 'vitest';
import { deriveReviewReasons, FDH_REVIEW_REASON_CODES } from '@/lib/financial-data-hub/classification/reviewReasons';

const base = {
  reviewStatus: 'pending' as const,
  economicTransactionType: 'unknown' as const,
  classificationConfidence: null,
  openTransferLinkExists: false,
  pendingTransferLinkExists: false,
  pendingDuplicateCandidateExists: false,
  pendingRefundLinkExists: false,
};

describe('FDH-6 reviewReasons — deriveReviewReasons', () => {
  it('not_required and resolved rows need no explanation (spec section 19 — safe states, not second-guessed)', () => {
    expect(deriveReviewReasons({ ...base, reviewStatus: 'not_required' })).toEqual({ reasons: [], explanation: 'No review required.' });
    expect(deriveReviewReasons({ ...base, reviewStatus: 'resolved' })).toEqual({ reasons: [], explanation: 'No review required.' });
  });

  it('unknown economic type -> UNKNOWN_CLASSIFICATION', () => {
    const r = deriveReviewReasons(base);
    expect(r.reasons).toContain('UNKNOWN_CLASSIFICATION');
  });

  it('a rule-conflict source -> RULE_CONFLICT, NOT UNKNOWN_CLASSIFICATION (a conflict is a more specific, more actionable reason)', () => {
    const r = deriveReviewReasons({ ...base, classificationSourceKind: 'rule_conflict' });
    expect(r.reasons).toEqual(['RULE_CONFLICT']);
    expect(r.reasons).not.toContain('UNKNOWN_CLASSIFICATION');
  });

  it('an OPEN (no counterpart) transfer link -> MISSING_COUNTERPART_ACCOUNT, not the weaker POSSIBLE_TRANSFER', () => {
    const r = deriveReviewReasons({ ...base, openTransferLinkExists: true, pendingTransferLinkExists: true });
    expect(r.reasons).toContain('MISSING_COUNTERPART_ACCOUNT');
    expect(r.reasons).not.toContain('POSSIBLE_TRANSFER');
  });

  it('a pending (both-sides-present) transfer link with no open candidate -> POSSIBLE_TRANSFER', () => {
    const r = deriveReviewReasons({ ...base, pendingTransferLinkExists: true });
    expect(r.reasons).toContain('POSSIBLE_TRANSFER');
    expect(r.reasons).not.toContain('MISSING_COUNTERPART_ACCOUNT');
  });

  it('a pending duplicate candidate -> POSSIBLE_DUPLICATE', () => {
    const r = deriveReviewReasons({ ...base, pendingDuplicateCandidateExists: true });
    expect(r.reasons).toContain('POSSIBLE_DUPLICATE');
  });

  it('a pending refund link -> POSSIBLE_REFUND', () => {
    const r = deriveReviewReasons({ ...base, pendingRefundLinkExists: true });
    expect(r.reasons).toContain('POSSIBLE_REFUND');
  });

  it('LOW_CLASSIFICATION_CONFIDENCE only fires once SOME classification was reached (not for a bare unknown, which already has its own reason)', () => {
    const knownLowConfidence = deriveReviewReasons({ ...base, economicTransactionType: 'expense', classificationConfidence: 0.3 });
    expect(knownLowConfidence.reasons).toContain('LOW_CLASSIFICATION_CONFIDENCE');

    const unknownNeverLowConfidence = deriveReviewReasons({ ...base, economicTransactionType: 'unknown', classificationConfidence: 0.3 });
    expect(unknownNeverLowConfidence.reasons).not.toContain('LOW_CLASSIFICATION_CONFIDENCE');
  });

  it('HIGH confidence never triggers LOW_CLASSIFICATION_CONFIDENCE', () => {
    const r = deriveReviewReasons({ ...base, economicTransactionType: 'expense', classificationConfidence: 1 });
    expect(r.reasons).not.toContain('LOW_CLASSIFICATION_CONFIDENCE');
  });

  it('multiple simultaneous reasons are all surfaced, in the fixed deterministic order', () => {
    const r = deriveReviewReasons({
      ...base,
      classificationSourceKind: 'rule_conflict',
      openTransferLinkExists: true,
      pendingDuplicateCandidateExists: true,
      pendingRefundLinkExists: true,
    });
    expect(r.reasons).toEqual(['RULE_CONFLICT', 'MISSING_COUNTERPART_ACCOUNT', 'POSSIBLE_DUPLICATE', 'POSSIBLE_REFUND']);
  });

  it('explanation text is a deterministic, non-empty sentence (spec section 61 — never LLM prose, always reproducible)', () => {
    const r1 = deriveReviewReasons(base);
    const r2 = deriveReviewReasons(base);
    expect(r1.explanation).toBe(r2.explanation); // same input -> byte-identical output every time
    expect(r1.explanation.length).toBeGreaterThan(0);
    expect(r1.explanation.endsWith('.')).toBe(true);
  });

  it('every code in the closed vocabulary is actually reachable (no dead reason code)', () => {
    expect(FDH_REVIEW_REASON_CODES).toEqual([
      'UNKNOWN_CLASSIFICATION',
      'RULE_CONFLICT',
      'POSSIBLE_TRANSFER',
      'MISSING_COUNTERPART_ACCOUNT',
      'POSSIBLE_DUPLICATE',
      'LOW_CLASSIFICATION_CONFIDENCE',
      'POSSIBLE_REFUND',
    ]);
  });
});
