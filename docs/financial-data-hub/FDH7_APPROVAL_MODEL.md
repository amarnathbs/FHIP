# FDH-7 — Approval Model

## The trust boundary (spec 159)

```
RAW SOURCE -> EXTRACTED -> RECONCILED -> AUTOMATICALLY CLASSIFIED
  -> [USER TRUST GATE] -> REVIEWED -> CORRECTED/CONFIRMED -> APPROVED
  -> APPROVED FINANCIAL DATA
```

`approved_by` (new, additive, migration 0076) is the trust gate. See `FDH7_REUSE_AND_GAP_AUDIT.md` Critical Finding 1 for why this is a structurally SEPARATE signal from `processing_status = 'approved'`, which pre-dates FDH-7 and means something narrower ("R7/FDH-5 certified this import as clean").

## Two levels (spec 52)

**Transaction approval** — `fdh_transactions.approval_status: pending -> approved`. Gated by `fdh7_transaction_has_blocking_issue()`.

**Statement approval** — `fdh_statement_uploads.approved_by: null -> <user_id>`. Gated by `fdh7_statement_has_blocking_issue()`. `approveStatement()` (service) performs, in order: (1) cascade-approve every currently-clean transaction; (2) re-check the statement-level gate; (3) advance `processing_status` to `approved` via the reused, unmodified `assertDocumentTransition()`; (4) stamp `approved_by` (DB trigger stamps `approved_at`, increments `approval_version`); (5) compute and persist the Approved Financial Summary.

## Server-side, not UI decoration (spec 55, 108-110)

Every precondition is re-verified by the DB trigger regardless of what the calling service already checked — `scripts/fdh7_certification.mjs` proves this directly (dropping the trigger and showing the SAME forged approval that was blocked now succeeds, then restoring it and showing it blocks again).

## Explicit reasons on block (spec 54)

`ApprovalError('blocked', message, { blocked_transaction_ids })` — the statement-approval API route returns the exact blocked transaction ids in its error body, never a bare "denied".

## Idempotency (spec 73)

Approving an already-approved transaction/statement returns the existing state with no duplicate audit row, no duplicate summary row, no error.

## Reopen & versioning (spec 63-64)

`reopenStatement()`: marks the current `fdh_approved_financial_summaries` row `superseded = true` (never deleted — spec 63); reverts every approved transaction on the statement to `pending`; clears `approved_by` (trigger clears `approved_at`, stamps `reopened_at`). `approval_version` is NEVER decremented — the next approval increments it again, so `1 -> reopened -> 2 -> reopened -> 3...` fully preserves history. `processing_status` deliberately stays `'approved'` throughout reopen (see Critical Finding 1) — the document WAS genuinely, successfully processed; only the FDH-7 approval gate itself moves.

## Rule changes after approval (spec 65-66)

No FDH-7 code path re-runs classification on an approved transaction. A later global-rule change or reprocessing run (not implemented by any phase to date) would need to explicitly reopen the statement first — approved data is never silently rewritten.
