# FDH-4 — Scale Certification

R7 already proved 999/1000/1001/2500/5001/10000-row correctness in-memory (`tests/unit/r7LargeFile.test.ts`) and 2,500-row correctness live against DEV (`R7_TERMINAL_COMPLETION_REPORT.md:90`). Spec section 52 requires the full 10,000-row target proven live, not just locally — this was the one genuine gap in R7's own scale evidence. Closed this session.

## Live-DEV 10,000-row certification — `scripts/fdh4_live_scale_certification.ts`

Real DEV project (`vqycarelcoijzwlpkpcz`), real authenticated user, real app, real CBA-format synthetic fixture (10,000 rows, internally consistent balance chain, generated for this run only — not committed to git, per spec section 31's synthetic-not-persisted discipline for bulk test data).

```
Fixture: 378536 bytes
Upload:  200  (7.7s)
Detect:  200  status=detected adapter=au_cba_debit_credit_v1 rows=10000  (4.3s)
Process: 200  (34.5s)  {"transactions_created":10000,"declared_row_count":10000,
                        "parsed_row_count":10000,"rejected_rows":0,
                        "reconciliation_status":"reconciled"}

Row integrity (declared=parsed=created=10000, rejected=0):        PASS
DB retrieval count (Content-Range, not a naive .length):          PASS — exact 10000
Reconciliation exact at 10,000 rows (variance=0):                 PASS
Cleanup verified (0 remaining):                                   PASS
```

## What "DB retrieval count" actually proves (spec section 51 — the specific failure mode)

The count was read via `Prefer: count=exact` + `Range: 0-0` against `/rest/v1/fdh_transactions`, parsing the `Content-Range` response header (`0-0/10000`) — an exact server-side count, not `.length` on a possibly-paginated array. This is the check that would catch PostgREST's default 1000-row page size silently truncating a naive `select('*')` fetch — exactly the FAIL condition spec section 114 names ("1000-row retrieval limit truncates results"). It did not truncate: **10,000 exact**, both in the count and in `transactions_created`/`parsed_row_count` returned by the processing endpoint itself.

## Correctness, not performance (spec section 52 explicit)

Processing time (34.5s for 10,000 rows through the real HTTP API, including per-row normalization, dedup-fingerprint computation, and reconciliation) is reported for completeness only. No performance/concurrency claim is made — see `FDH4_COMPLETION_REPORT.md` open residuals, "concurrency/load: OPEN."

## In-memory scale coverage (unchanged, R7's own, re-confirmed passing)

`tests/unit/r7LargeFile.test.ts` — 999/1000/1001/2500/5001/10000-row in-memory pipeline correctness, plus the `CSV_MAX_ROWS` boundary (50,000 accepted, 50,001 rejected outright — never truncated). Full regression this session: **1958/1958 tests pass** (see `FDH4_TEST_CERTIFICATION.md`), including this file unmodified.

## Pagination unit coverage (unchanged, reused)

`lib/financial-data-hub/bank-csv/pagination.ts` — `fetchAllRows()` pages until a short page, `FETCH_ALL_ROWS_CEILING=500_000`, throws rather than silently truncating. `tests/unit/r7Pagination.test.ts` (6 cases) unmodified, passing.
