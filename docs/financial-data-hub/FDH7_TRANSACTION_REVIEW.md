# FDH-7 — Transaction Review

## Reused wholesale (spec 26-31)

- **Accept**: reaching `approval_status = 'approved'` on an already-correctly-classified row IS the accept action — no separate "accept" endpoint was needed since approval already re-validates and stamps provenance.
- **Correct**: `bankTransactionActionsService.ts#correctTransaction` (R7), unmodified. Writes `fdh_transaction_corrections` (previous + corrected value, reason, timestamp) before applying the new value, and sets `user_override = true`.
- **Source-value immutability (spec 28)**: `FDH_TRANSACTION_CORRECTION_FIELDS` never includes `description_raw`/`merchant_raw`; `amount_original`, `credit_debit`, `transaction_date` ARE correctable (spec 29's explicitly-permitted path) but always through the same append-only correction-first mechanism — the previous value survives in `fdh_transaction_corrections`, never silently overwritten with no trace.
- **User rules**: `classificationReviewService.ts#createPersonalClassificationRule` (R8), unmodified — never auto-invoked from a correction (spec 31-32).
- **Review reasons/explanations**: `classification/reviewReasons.ts#deriveReviewReasons` (FDH-6), unmodified.

## New in FDH-7

Nothing new was required for the correction/accept mechanism itself. What FDH-7 adds on top is the **approval** action (`POST /bank-transactions/{id}/approve`) — a structurally separate concept from "reviewed"/"corrected": a transaction can be `review_status: resolved` (nothing left to look at) yet still `approval_status: pending` (the user has not taken the deliberate approval action, spec 55).

## Audit trail (spec 74-75)

Every FDH-7 action records a `fdh_document_audit_events` row via the existing `recordDocumentAuditEvent()` (FDH-3): `transaction_approved`, `transaction_split_created`, `statement_approved`, `statement_reopened`, `bulk_review_action_completed` (new); `transaction_link_reviewed`, `transaction_duplicate_resolved`, `recurring_series_reviewed`, `transaction_corrected` (all reused, unmodified). No event carries a raw transaction description or amount — only ids, counts, and decision codes.

## Confidence display (spec 90)

`classification_confidence` is exposed as the raw `numeric(5,4)` value in API responses (for internal/debugging use) — the review-queue route additionally exposes a `low_confidence` COUNT bucket (threshold ≤ 0.6, consistent with FDH-6's own `CLASSIFICATION_CONFIDENCE_SCORE.LOW` boundary) so a UI can render "Needs review" rather than a raw decimal, while the machine value remains available.
