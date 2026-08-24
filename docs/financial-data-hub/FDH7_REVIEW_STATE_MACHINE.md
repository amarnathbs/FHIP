# FDH-7 — Review & Approval State Machines

## Transaction-level

`fdh_transactions.review_status` (FDH-1, unchanged): `not_required -> pending/in_review -> resolved`. Reused verbatim — FDH-7 introduces no new value.

`fdh_transactions.approval_status` (FDH-7, new, additive): `pending -> approved` and `approved -> pending` (revert, used by statement reopen). Two states only — deliberately no "rejected" state at transaction level (spec 26: only a whole statement can be rejected, reusing the existing `processing_status = 'rejected'`).

Enforcement: `fdh7_guard_transaction_approval()` (migration 0076, BEFORE UPDATE OF `approval_status` trigger). Approving requires `fdh7_transaction_has_blocking_issue()` to return false AND `approved_by` to be supplied; both are re-validated by Postgres itself, not merely by the calling service.

## Statement-level (`processing_status`, FDH-3, unchanged transitions, newly DB-enforced)

```
created -> uploaded -> validating -> queued -> processing -> extracted
        -> review_required -> ready_for_approval -> approved -> purge_pending -> purged
(rejected reachable from every pre-terminal stage; failed recoverable via queued)
```

`fdh7_guard_document_processing_status()` (new, migration 0076) mirrors this table exactly in SQL — see `FDH7_REUSE_AND_GAP_AUDIT.md` Critical Finding 2 for why this was a real, closed gap.

## Statement approval gate (`approved_by`, FDH-7, new, additive)

`approved_by: null -> <user_id>` (approve) and `<user_id> -> null` (reopen). Enforcement: `fdh7_guard_statement_approval()`. Approving requires `fdh7_statement_has_blocking_issue()` to return false; `approval_version` increments on every genuine approval and is never decremented or reset by reopen.

## Blocking vs non-blocking (spec 53, centralised in `fdh7_transaction_has_blocking_issue`/`fdh7_statement_has_blocking_issue`, migration 0076)

**Blocking** (transaction level): `economic_transaction_type = 'unknown'`; an OPEN `severity = 'blocking'` review item; a still-PENDING transfer/refund/reversal/duplicate link; a still-PENDING duplicate candidate; allocations whose sum does not exactly equal the parent (exact `numeric(20,4)` comparison).

**Blocking** (statement level, additionally): an open `severity = 'blocking'` review item scoped to the statement; `fdh_reconciliation_results.status = 'failed'`; any transaction on the statement individually blocking (above).

**Non-blocking**: `severity IN ('info', 'warning')` review items (e.g. unconfirmed recurring pattern, merchant display uncertainty) — these never prevent approval, matching spec 53's own example list.

## Documented invalid-transition matrix (spec 109, all DB-tested — `scripts/fdh7_certification.mjs` section 4)

| From -> To | Result |
|---|---|
| `created -> approved` (skip pipeline) | REJECTED (raise exception) |
| `purged -> approved` | REJECTED (spec's own example) |
| `rejected -> approved` (no reopen) | REJECTED (spec's own example) |
| `approved -> processing` | REJECTED (not in the allowed-edge table) |
| `pending_review (review_required) -> purged` (bypass lifecycle) | REJECTED (`review_required` only reaches `ready_for_approval`/`rejected`/`failed`) |
| `created -> uploaded` (genuine legitimate edge) | ALLOWED (sanity/non-vacuous control) |

## Idempotency (spec 73)

Approving an already-approved transaction/statement is a harmless no-op (the trigger's `IF new... IS DISTINCT FROM old...` guard means a second identical UPDATE changes nothing and fires no exception) — DB-tested directly.
