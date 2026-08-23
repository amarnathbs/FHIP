# R7 — Pagination Certification (spec §76)

## The recurring defect class this guards against

PostgREST caps an unbounded `select` at `db-max-rows` (1000 on this project) and reports truncation ONLY via the `Content-Range` response header — the Supabase JS client surfaces no error. This exact defect was independently rediscovered in Investment Intelligence R4, R5, and R6 before R6-P0 consolidated one trusted helper (`fetchAllRows`). R7 inherits the identical discipline via `lib/financial-data-hub/bank-csv/pagination.ts` — duplicated, not imported, from the II original, to respect the pre-existing FDH/II import-graph isolation boundary (`tests/unit/fdh1Isolation.test.ts`) — see `R7_TESTING_AND_VERIFICATION.md` §2 for the real regression this caused and fixed during the build.

## Where R7 uses it

| Read | File | Why it could exceed 1000 rows |
|---|---|---|
| `loadDedupIndexForAccount()` | `bank-csv/repository.ts` | An active account can accumulate far more than 1000 historical transactions across many imports |
| `loadPriorStatementDateRanges()` | `bank-csv/repository.ts` | Same account, same reasoning |

Both order by `(created_at/transaction_date ascending).order('id' ascending)` — a genuinely unique tie-breaker, never a bare non-unique column, per spec §76's explicit requirement.

## Behavioural-parity certification (`tests/unit/r7Pagination.test.ts`, 6 cases)

- Reads a 2500-row synthetic dataset in full via a fake `range()`-backed table (proves multi-page assembly).
- Terminates correctly on a short final page (1500 rows at page size 500 → 3 pages, last short).
- An exact-multiple-of-page-size dataset (1000 rows at page size 500) still terminates via the trailing empty page.
- A PostgREST error propagates as a thrown exception, never swallowed into a false "short page = end of data".
- Default page size is exactly 1000 (`POSTGREST_PAGE_SIZE`), matching this project's actual `db-max-rows`.
- The FDH copy exports its own distinctly-named `FdhPaginationCeilingExceededError` (not a re-export of II's) — a source-level proof of genuine duplication, not an accidental shared reference.

## End-to-end large-row proof (spec §75, §77)

`tests/unit/r7LargeFile.test.ts` runs the FULL in-memory pipeline (not just the pagination helper in isolation) at exactly **999, 1000, 1001, 2500, 5001, 10000** rows, plus the safe ceiling boundary (`CSV_MAX_ROWS` and `CSV_MAX_ROWS + 1`). For every size:

- `declaredRowCount === parsedRowCount === rowCount` (no truncation).
- Source row numbers are exactly `1..rowCount`, no gaps, no duplicates (no page-boundary loss or double-count).
- Every economic fingerprint is unique across the full set (`fingerprints.size === rowCount`) — no accidental page-boundary collision.
- The closing balance reconciles exactly — **and is only correct if every row beyond row 1000 was included** (each row debits exactly A$1.00 from a known starting balance; the reconciled closing balance is arithmetic proof the full row count, not a 1000-row-truncated prefix, was processed). This is the literal proof spec §77 asks for: *"Create at least one >1,000-row statement where the closing balance is only correct if rows beyond 1,000 are included."*

All 8 parameterised cases pass; the 10,000-row case runs in the vitest suite in well under 2 seconds (in-process, no DB round-trip — the pipeline itself has no row-count-dependent behaviour; the DB-read pagination is exercised separately by the 6 `r7Pagination.test.ts` cases above).

## Not yet independently re-proven against a REAL Supabase/PostgREST instance

The `>1,000-row statement` proof above is against the in-memory pipeline and a FAKE `range()`-backed table respectively — genuinely correct, but not the same as seeding 1500+ real rows into the live DEV `fdh_transactions` table and confirming a real PostgREST response's `Content-Range` header and the JS client's row count agree. That specific live proof is one of the 15 live-DEV cases blocked on migration application — see `R7_LIVE_DEV_VERIFICATION.md`.
