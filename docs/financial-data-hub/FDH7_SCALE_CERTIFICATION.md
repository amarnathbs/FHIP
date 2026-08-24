# FDH-7 — Scale Certification

## Pagination safeguard (spec 68, 94, 127)

The review-queue list (`GET /review-queue`) is deterministically keyset-paginated (`transaction_date desc, id desc`, identical stable tie-breaker convention to `bank-transactions/route.ts`) — requesting a page beyond 1,000 is expected, correct behaviour, not a truncation defect.

**Counts** (the class of defect FDH-6 found and fixed in `listForUser()`'s row-returning methods) use Supabase `count: 'exact', head: true`, which executes a genuine server-side `SELECT count(*)` and is **not** subject to PostgREST's default row-return cap. This is the deliberate fix pattern: every section count in `review-queue`'s response (`needs_attention`, `transfers`, `possible_duplicates`, `uncategorised`, `low_confidence`, `recurring_candidates`, `ready_to_approve`) is a `count`-mode query, never a `.length` on a possibly-capped row array.

## Approved summary aggregation at scale

`computeApprovedFinancialSummary` is a pure, synchronous, single-pass function over an array the CALLER already fetched — `approveStatement()` fetches a statement's transactions via a plain `.eq('statement_upload_id', ...)` query (bounded by realistic per-statement transaction counts, not the household's whole history) rather than any method subject to the 1,000-row household-wide cap FDH-6 fixed elsewhere. Allocations are fetched via `.in('transaction_id', ids)`, also statement-scoped.

## What was tested (this phase)

The pure-function oracle (`tests/unit/fdh7ApprovedSummaryOracle.test.ts`) includes a 1,000-transaction summation case (exact-money drift test) — 1,000 distinct $0.10 transactions sum to exactly $100.00. This exercises the arithmetic at the 1,000-row boundary spec 68 names, though it is not a live-DB round-trip test (no DEV migration applied — see `FDH7_LIVE_DEV_CERTIFICATION.md`).

## What was NOT separately re-certified this phase (spec 94's own boundary — "do not claim full load/concurrency certification from this alone")

A live 5,000/10,000-row round-trip through the real `review-queue`/`approve` endpoints against DEV — blocked by the same CONDITIONAL migration-application gap as every other new FDH-7 endpoint. Concurrent-edit optimistic-concurrency handling (spec 72) is not separately implemented in this phase — every write is a single atomic `UPDATE ... WHERE id = ... AND user_id = ...`, which is safe against lost updates in the sense that a stale client's write still lands correctly (last-write-wins per row, standard Postgres MVCC), but no `updated_at`-based optimistic-lock check was added; disclosed as an Open Residual.
