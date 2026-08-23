# R7 — Bank CSV Engine: Implementation Report

## What was built

A complete, deterministic pipeline turning heterogeneous bank CSV exports into certified canonical `fdh_transactions` rows: safe CSV intake (encoding/delimiter/header detection, safety limits, formula-injection guard) → institution/format detection (8-adapter registry, 6 certified) → generic column mapping for the unrecognised case → canonical normalisation (exact-Decimal-equivalent amounts, deterministic dates, structural type hints) → 4-layer deduplication (economic fingerprinting, account-scoped, cross-import) → balance/date-coverage reconciliation → a 4-state certification decision (`certified`/`partial`/`review_required`/`rejected`) → provenance/audit → a bounded API surface → user-facing duplicate-resolution and correction actions.

## Numbers

- **1 migration** (`0064`, additive-only): 2 new tables, ~30 new columns across `fdh_statement_uploads`/`fdh_transactions`, 1 widened check constraint (audit event types), 10 new triggers (forgery hardening), 8 parser-registry seed rows, 6 institution `coverage_status` updates.
- **~20 new library files** under `lib/financial-data-hub/bank-csv/` and 3 new service files.
- **9 new API routes** across `bank-csv/*` and `bank-transactions/*`.
- **198 new vitest certification cases** (0 failures) across 10 test files, +198 to the repo total with 0 regressions.
- **174 independent-oracle atomic comparisons**, 0 discrepancies.
- **45 real-Postgres security certification checks**, 0 failures, including 9 same-user forgery attempts using valid own foreign keys.
- **4 real bugs found and fixed** during this build's own certification (see `R7_TESTING_AND_VERIFICATION.md` §2).

## Architectural decisions of note

1. **Extended, did not duplicate, FDH-1's existing-but-writer-less schema.** `fdh_transactions`, `fdh_duplicate_candidates`, `fdh_reconciliation_results`, `fdh_data_quality_results`, and `fdh_data_provenance` were all created by FDH-1 with no engine ever writing to them. R7 is that engine — see `R7_BANK_CSV_ARCHITECTURE.md` §1.
2. **`certification_status` is a new column, deliberately separate from `processing_status`.** The FDH-1 lifecycle machine tracks workflow position; R7's certification is a conclusion reached (or not) once processing finishes. Conflating the two would have required editing the frozen FDH-1 lifecycle transition table.
3. **Reused frozen vocabularies instead of widening them wherever the headroom already existed** (`error_code`, `review_type`, `data_quality check_code`) — only `fdh_document_audit_events.event_type` genuinely needed new values, widened via the exact `drop constraint`/`add constraint` precedent FDH-2 set for `institution_type`/`rule_type`, verified by a new `r7SchemaContract.test.ts` scoped to migration 0064 only (the frozen `fdh3SchemaContract.test.ts` assertion for migration 0058 is untouched).
4. **Discovered and closed a same-user forgery gap the FDH-1 architecture would otherwise have carried forward.** `fdh_transactions`/`fdh_statement_uploads` inherited FDH-1's broad `for all` RLS policy, which was never exercised before R7 (no writer existed). R7 introduces genuinely authoritative columns onto both — without new triggers, an authenticated user could have directly forged their own certification/reconciliation/dedup state via a raw PostgREST call. Closed via 10 new triggers + a documented third service-role carve-out file, with zero regression risk to any pre-R7 functionality (verified: those 5 tables/columns had no prior writer). See `R7_BANK_CSV_ARCHITECTURE.md` §4, `R7_SECURITY_VERIFICATION.md`.
5. **Duplicated, not imported, the FDH/II pagination contract**, respecting a pre-existing import-graph isolation test that R7's first draft violated and that the full-suite regression run caught (§2 of `R7_TESTING_AND_VERIFICATION.md`).
6. **No dependency added.** The existing hand-rolled RFC4180 parser pattern (`lib/utils/csv.ts`) was extended, not replaced with a new npm package — see `bank-csv/csv.ts`'s header comment for the explicit dependency-review reasoning.

## Commit sequence (branch `feature/r7-bank-csv-engine`, off `feature/r7-baseline-integration` @ `8023832`)

Scoped commits following the requested convention: schema/migration, CSV intake + detection, canonical normalisation, deduplication engine, reconciliation engine, API/services, certification tests, docs. (Exact SHAs recorded at commit time — see `git log feature/r7-bank-csv-engine`.)

## What is explicitly NOT done (out of scope, per the spec's own stop rule)

Transaction categorisation, merchant enrichment, recurring-payment detection, budgeting, cash-flow recommendations, open banking, bank PDF parsing, broker/investment CSV parsing, Investment Intelligence publishing from bank data. No file under this release touches any of those areas.
