# FDH-7 — Transaction Split Workflow

## Reused (spec 44-47)

Schema: `fdh_transaction_allocations` (FDH-1, migration 0047), RLS-enabled, indexed, `uq_fdh_allocation_sequence` unique per transaction. Validator: `domain/allocations.ts#checkAllocationsReconcile`/`assertAllocationsReconcile`/`isValidAllocationDraft` (FDH-1) — exact minor-unit arithmetic, unmodified.

## New in FDH-7: the write path

`POST /api/financial-data-hub/bank-transactions/{transactionId}/split` — `services/transactionSplitService.ts#splitTransaction`. Confirmed by inspection (see `FDH7_REUSE_AND_GAP_AUDIT.md`) that no prior phase ever wrote to this table.

**Replace, not append.** Each call replaces the transaction's FULL allocation set (delete-then-insert, both scoped by `transaction_id AND user_id` through the ordinary RLS-scoped client). The parent transaction row's own `amount_original`/`credit_debit` are never touched (spec 28).

**Draft vs finalize** (spec 46): `{ finalize: false }` accepts an incomplete draft (validated only for internal consistency — no negative amounts, no duplicate sequence, never MORE than the parent); `{ finalize: true }` requires exact reconciliation and is rejected with the precise shortfall/overage otherwise (`FDH7_FINANCIAL_INTEGRITY_CERTIFICATION.md`'s split negative control: 220.00+79.99 vs 300.00 parent → rejected; 220.00+80.00 → accepted).

## Transfer split guard (spec 48)

Splitting a transaction that is the CONFIRMED side of an `internal_transfer`/`credit_card_settlement` link into anything other than 100% `transfer`-typed allocations is refused (`TransactionSplitError('transfer_conflict', ...)`) — the transfer relationship must be rejected first. Deterministic: checked by looking up the caller's own confirmed links before validating amounts.

## Parent never double-counted (spec 47, 59, FAIL condition spec 153)

`domain/approvedSummary.ts` sums a split transaction via its allocations ONLY — the parent's own `amount_original`/`economic_transaction_type` is never also summed when `allocations.length > 0`. Dedicated unit test: a $300 parent split 220/80 across two categories produces `expense_total = 300`, not `600`.

## Categories per allocation (spec 47)

Each allocation carries its own `economic_transaction_type`, `category_id`, `subcategory_id`, `note` — reusing the exact `fdh_transaction_allocations` columns FDH-1 shipped; no new table.

## Audit trail

`transaction_split_created` (new FDH-7 event type, migration 0076) records `transaction_id`, `allocation_count`, `finalized` — never allocation amounts or descriptions.
