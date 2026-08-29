# FDH-11 — Scale Certification (spec sections 90, 92-95)

## What was done

**Pagination correctness fix applied to every FDH-11 read path that iterates a per-statement or per-user row set**, following this repository's own established `fetchAllRows` pattern (the same defect class R2/R4/R5/R6/R7 all independently discovered and fixed — PostgREST silently truncates an unbounded `.select()` at `db-max-rows`, 1000, with no error surfaced):

- `GET /investment-statement/{documentId}` — positions/activities reads, ordered `(source_row_number, id)`.
- `POST /investment-statement/{documentId}/apply` — pending-rows reads, ordered `id`.
- `matchAuStatementActivitiesToBank()` — both the eligible-activities read and the household's bank-transaction read, ordered `id`.

`fetchAllRows` (`lib/financial-data-hub/bank-csv/pagination.ts`) throws `FdhPaginationCeilingExceededError` rather than silently truncating past `FETCH_ALL_ROWS_CEILING` (500,000) — the same fail-loud discipline the rest of this codebase applies.

## What was NOT done — honestly disclosed

**No actual 100/500/1000/1001/5000/10000-row scale test was executed** against either PGlite or live DEV. This mirrors FDH-10's own disclosed precedent ("Scale certification (100→10,000 rows) and the 150+ scenario volume target were not executed at full count" — `FDH10_REUSE_AND_GAP_AUDIT.md`), for the same reason: this pass prioritised the headline financial-integrity/security/idempotency controls (all independently proven — see `FDH11_SECURITY_CERTIFICATION.md`, `FDH11_FINANCIAL_INTEGRITY_CERTIFICATION.md`) within the time available, and the pagination-truncation bug class this fixes is a *known, independently-recurring* defect in this codebase — the fix's correctness rests on reusing an already-certified, already-tested helper (`tests/unit/r7Pagination.test.ts` covers `fetchAllRows`' own contract), not on a fresh scale run of FDH-11's specific new call sites.

**The pagination negative control (spec section 93 — artificially truncate at 1,000, prove the harness catches it, then restore and prove 1001/5000/10000 pass) was not run.** This is a genuine gap against the spec's explicit instruction, not a silent omission — recorded here and in the completion report's residuals rather than fabricated.

**Portfolio-size tests (10/100/500/1000 holdings) were not run** for the same reason.

## Assessment

The fix applied is the right *shape* of fix (proven-pattern reuse, not a novel untested mechanism), but "the code now uses a certified-safe helper" is a different, weaker claim than "this was tested at 5,000 rows and confirmed correct." This section reports the weaker, honest claim.
