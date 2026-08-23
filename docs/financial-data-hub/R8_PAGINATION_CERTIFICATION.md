# R8 — Pagination / Scale

## 1. Reused, not duplicated (spec section 20, 65)

`transactionClassificationService.ts#loadUserTransactions()` uses
`fetchAllRows()` (`lib/financial-data-hub/bank-csv/pagination.ts`) — R7's
existing "read past PostgREST's silent 1000-row `db-max-rows` cap" helper —
verbatim. No second pagination helper was written. `fetchAllRows()`'s own
contract (`POSTGREST_PAGE_SIZE = 1000`, `.range()`-looping,
`FETCH_ALL_ROWS_CEILING = 500_000`, throws `FdhPaginationCeilingExceededError`
rather than silently truncating) is unchanged by this release.

## 2. Deterministic ordering

`loadUserTransactions()` orders by `.order('transaction_date', {ascending:
true}).order('id', {ascending: true})` — a unique, stable sort, exactly the
requirement `fetchAllRows()`'s own header comment states
("deterministic, unique ordering ... never a bare non-unique column").

## 3. Why the matching algorithms themselves don't need their own paging

`matchInternalTransfers()`, `matchRefundsToOriginals()`, and
`detectRecurringSeries()` are pure, in-memory functions — they operate on
the array `loadUserTransactions()` already fetched in full (past the
1000-row cap, via `fetchAllRows`). The pagination boundary that matters
(spec section 66: "place the correct transfer counterpart after row 1,000
— production must still find it") is enforced at the FETCH layer, not
inside the matching algorithms — once the full array is in memory, an
O(n) amount-bucketing pass (see `R8_TRANSFER_DETECTION_METHODOLOGY.md`
section 2) finds a pair regardless of which row index either side landed
at during the original PostgREST read.

## 4. What was actually exercised this session (disclosed)

This session has no DDL-execution credential and therefore cannot apply
migration 0067 to real DEV, so a genuine 1k/5k/10k-row live-DEV pagination
run (spec sections 65/68) was **not performed**. What was verified:

- `tests/unit/r7Pagination.test.ts` (unmodified, still passing) already
  certifies `fetchAllRows()`'s own behaviour at 999/1000/1001/2500/5001/
  10000 rows in-memory — R8 reuses that exact function, so this coverage
  transfers directly rather than needing to be re-proven.
- The oracle comparison (`scripts/r8_oracle_compare.ts`) and unit tests
  exercise the matching algorithms directly against in-memory arrays large
  enough to contain multi-hundred-row amount buckets without measurable
  slowdown (sub-second for every test file).

**Open residual**: a genuine live-DEV run placing a transfer counterpart
past row 1,000 of a real paginated fetch (spec section 66) is not
performed in this session — carried forward exactly like every prior FDH
phase's disclosed "no DDL credential" gap.
