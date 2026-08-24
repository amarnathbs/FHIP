/**
 * FDH-6 — centralised classification/matching thresholds (spec section 84).
 *
 * PURE REFACTOR, NO BEHAVIOUR CHANGE. Every value here is copied verbatim
 * from the local `const`s R8 already scattered across `transferMatching.ts`,
 * `refundReversalMatching.ts`, `recurringDetection.ts` and
 * `classification/types.ts` — this module does not change a single default,
 * it only gives them one importable home so a future threshold review has
 * one file to read instead of four. `tests/unit/fdh6Thresholds.test.ts`
 * pins every value below to the exact number the pre-refactor modules used,
 * and R8's own pre-existing unit suite (`r8TransferRefundRecurring.test.ts`
 * etc.) is re-run unchanged after this refactor to prove it — same pass
 * count, same assertions, same numbers in, same numbers out.
 *
 * Documented in `docs/financial-data-hub/FDH6_CONFIDENCE_AND_REVIEW.md`.
 */

/** Transfer/settlement/loan-payment candidate matching (transferMatching.ts,
 * spec sections 23-24). */
export const TRANSFER_THRESHOLDS = {
  /** Maximum days between a debit and its opposite-direction, same-amount
   * candidate before the pair is no longer considered (spec section 24 —
   * "narrowly justified date window"). */
  DATE_WINDOW_DAYS: 3,
  /** A pair within this many days (or sharing a source reference) earns
   * HIGH confidence; anything wider (but still inside DATE_WINDOW_DAYS)
   * earns MEDIUM. */
  HIGH_CONFIDENCE_DAY_THRESHOLD: 1,
  CONFIDENCE_SCORE: { HIGH: 1, MEDIUM: 0.6 } as const,
  /** Confidence recorded for an OPEN candidate link with no counterpart
   * found yet (spec section 26, MISSING_COUNTERPART_ACCOUNT). Deliberately
   * low — this is a structural hint, not a matched pair. */
  OPEN_CANDIDATE_CONFIDENCE: 0.3,
} as const;

/** Refund/reversal linkage (refundReversalMatching.ts, spec section 36). */
export const REFUND_THRESHOLDS = {
  /** How far back from a refund-classified transaction to look for its
   * original (spec section 36 — "bounded lookback window"). */
  LOOKBACK_DAYS: 90,
  /** An exact-amount match within this many days earns full (1.0)
   * confidence; a partial refund, or one further out, earns 0.6. */
  HIGH_CONFIDENCE_DAY_THRESHOLD: 7,
  CONFIDENCE_SCORE: { FULL_MATCH: 1, PARTIAL_OR_WIDER: 0.6 } as const,
} as const;

/** Recurring/subscription series detection (recurringDetection.ts, spec
 * sections 41-46). Ordered narrowest-first so a 7-day cadence is never
 * mis-bucketed as "monthly" by a wider tolerance matching first. */
export const RECURRING_FREQUENCY_BUCKETS = [
  { frequency: 'weekly', nominalDays: 7, toleranceDays: 2 },
  { frequency: 'fortnightly', nominalDays: 14, toleranceDays: 3 },
  { frequency: 'monthly', nominalDays: 30, toleranceDays: 5 },
  { frequency: 'quarterly', nominalDays: 91, toleranceDays: 10 },
  { frequency: 'annual', nominalDays: 365, toleranceDays: 15 },
] as const;

export const RECURRING_THRESHOLDS = {
  /** Fewer occurrences than this and a series is real evidence but stays
   * `insufficientHistory` (spec section 53's INSUFFICIENT_HISTORY state)
   * rather than being treated as an established pattern. */
  MIN_OCCURRENCES_FOR_ESTABLISHED: 3,
  /** A series' amount spread must be within this fraction of the mean
   * amount (or one cent, whichever is larger) to earn HIGH confidence —
   * anything wider but still inside its frequency bucket's own tolerance
   * earns MEDIUM (spec section 45's separate recurring-confidence). */
  TIGHT_AMOUNT_RATIO: 0.01,
  TIGHT_AMOUNT_FLOOR: 0.01,
  /** A series more than this many cycles overdue moves from `active` to
   * `possibly_paused` — never `ended` automatically (spec section 53's own
   * "never declares ended after a single missed occurrence"). */
  PAUSED_AFTER_CYCLE_MULTIPLE: 1.5,
} as const;

/** Deterministic confidence STATE → persisted numeric(5,4) score bucket
 * (classification/types.ts, spec section 44). Never a fake percentage. */
export const CLASSIFICATION_CONFIDENCE_SCORE = {
  HIGH: 1,
  MEDIUM: 0.6,
  LOW: 0.3,
  UNRESOLVED: 0,
} as const;
