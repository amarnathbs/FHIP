# FDH-6 — Confidence & Review

## Three distinct confidences, never merged (spec section 18, unchanged since FDH-1)

- `extraction_confidence` — "did we read the document correctly?"
- `classification_confidence` — "did we categorise it correctly?"
- `reconciliation_status` — a STATE, not a confidence, on `fdh_statement_uploads`.

FDH-6 adds no new confidence dimension. `ClassificationConfidenceState` (`HIGH/MEDIUM/LOW/UNRESOLVED`, R8) maps to `CLASSIFICATION_CONFIDENCE_SCORE` (now centralised in `thresholds.ts`, values unchanged: 1/0.6/0.3/0).

## UNKNOWN is valid (spec section 19)

`economic_transaction_type = 'unknown'` + `review_status = 'pending'` remains the safe default for anything the deterministic engine cannot resolve — including, as of FDH-6, a genuine `RULE_CONFLICT`. FDH-6 never forces a guess where the evidence does not support one (proven throughout the certification pack — e.g. `[FDH6-IN-08]`'s bare `"EMI"` narrative, `[AU-02]`'s salary-sacrifice exclusion).

## Review reasons — FDH-6's new capability (gap G1, spec section 64)

`lib/financial-data-hub/classification/reviewReasons.ts`'s `deriveReviewReasons()` computes a structured `FdhReviewReasonCode[]` — `UNKNOWN_CLASSIFICATION`, `RULE_CONFLICT`, `POSSIBLE_TRANSFER`, `MISSING_COUNTERPART_ACCOUNT`, `POSSIBLE_DUPLICATE`, `LOW_CLASSIFICATION_CONFIDENCE`, `POSSIBLE_REFUND` — from signals ALREADY persisted (`review_status`, open/pending `fdh_transaction_links`, pending `fdh_duplicate_candidates`, `classification_confidence`). No new column, no new migration: the classification engine is pure and deterministic, so any reason is reproducible on demand.

Priority order (fixed, deterministic, never randomised):
1. `RULE_CONFLICT` (if the classification source was a genuine conflict) else `UNKNOWN_CLASSIFICATION` (if still unknown)
2. `MISSING_COUNTERPART_ACCOUNT` (open link) else `POSSIBLE_TRANSFER` (pending link, both sides present)
3. `POSSIBLE_DUPLICATE`
4. `POSSIBLE_REFUND`
5. `LOW_CLASSIFICATION_CONFIDENCE` (only once SOME classification was reached — an already-`unknown` row has no confidence to be "low")

`explainTransactionReviewReasons(userId, transactionId)` (`classificationReviewService.ts`) wires this to real repositories — RLS-scoped, structurally incapable of reading another tenant's data.

## Explanation (spec section 61)

`EconomicTypeResult.explanation` remains a deterministic, machine-generated sentence (R8) — never LLM prose. FDH-6's `deriveReviewReasons()` follows the same discipline: a fixed lookup table (`REASON_TEXT`) of one sentence fragment per code, joined deterministically — proven byte-identical across repeated calls with the same input in `tests/unit/fdh6ReviewReasons.test.ts`.

## Confidence certification (spec section 83)

The certification pack never asserts a HIGH confidence result from fuzzy/weak evidence alone — every HIGH-confidence assertion in the pack corresponds to a case with a strong, disclosed reason (exact narrative match, matching source_reference, tight amount clustering with 3+ occurrences). Ambiguous/conflicting cases (`RULE_CONFLICT`, `unknown`) always resolve to `UNRESOLVED`, never an inflated score.
