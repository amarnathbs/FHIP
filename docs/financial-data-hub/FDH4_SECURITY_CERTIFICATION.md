# FDH-4 — Security Certification

R7's security architecture (RLS + 10 forgery-hardening triggers, migration 0064 widened by 0065) is reused entirely unmodified. FDH-4 adds no new table, no new trigger, no new RLS policy. This document records **new live-DEV evidence gathered this session** with a self-contained script (`scripts/fdh4_live_dev_certification.ts`) rather than restating R7's own prior certification (`docs/r7-bank-csv-engine/R7_FINAL_SECURITY_VERIFICATION.md`), which stands independently.

## Why a new script, not a re-run of R7's own

R7's `scripts/r7final_live_security.mjs` depends on an uncommitted `.r7scratch/fixtures/dup_candidate.csv` scratch fixture (deliberately never committed — synthetic-fixture discipline, spec section 31) that did not exist in this fresh worktree. Reconstructing it blind produced a fixture whose implicit assumptions (same balance/reference shape as the real one, unknown) did not match the original script's ground-truth expectations, producing spurious `ALLOWED-UNEXPECTED`/`FAIL` results traced (this session) to test-harness assumptions, not real vulnerabilities — e.g. a same-value PATCH ("forging" a field to the value it already legitimately held) trivially "succeeds" under `IS DISTINCT FROM`-guarded triggers without proving anything, exactly the pitfall R7's own script comments warn against. Rather than guess at an unknown historical fixture, FDH-4 wrote a new, self-contained script that re-derives its own ground truth live, immediately before each forgery attempt, so every "away from ground truth" claim is provably true at run time.

## Live results — `scripts/fdh4_live_dev_certification.ts` against DEV (`vqycarelcoijzwlpkpcz`)

Two real authenticated DEV users (`fdh4-live-cert-a-*`, `fdh4-live-cert-b-*`), real app running locally against real DEV, real CBA fixture through the real upload → detect → process pipeline.

```
[PASS] FDH4-SETUP    Two real authenticated DEV sessions created
[PASS] FDH4-E2E-01   Secure upload into real DEV private storage
[PASS] FDH4-E2E-02   Detection: DETECTED, adapter=au_cba_debit_credit_v1, confidence=1
[PASS] FDH4-E2E-03   Processing creates 5 canonical transactions
[PASS] FDH4-E2E-04   Reconciliation exact (variance=0, RECONCILED)
[PASS] FDH4-E2E-05   Reprocessing same document twice: 5 transactions both times (idempotent)
[PASS] FDH4-SEC-01   Tenant B cannot read Tenant A's document/reconciliation/transactions (app API 404s + direct PostgREST: 0 rows)
[PASS] FDH4-SEC-02   Forged processing request: B submits A's real document_id to /process, /detect, /map — all rejected (404/404/422)
[PASS] FDH4-SEC-03   Tenant B cannot write/correct Tenant A's transactions; direct PostgREST PATCH returns 0 rows under RLS; ground truth unchanged
[PASS] FDH4-SEC-04   Same-user authoritative-field forgery blocked, ground truth re-derived live immediately before the attempt (not assumed)
[PASS] FDH4-PURGE-01 Raw CSV storage object purged; 5 transactions + 1 reconciliation result SURVIVE
[PASS] FDH4-PURGE-02 Second purge attempt on an already-purged document: idempotent (already_purged, no re-delete)
[PASS] FDH4-CLEANUP  All live test data + both test users deleted, re-queried as 0/gone
=== SUMMARY === Checks: 13, FAIL/ALLOWED-UNEXPECTED: 0
```

## Forged processing request (spec section 72 — explicitly required)

`FDH4-SEC-02` is the literal test the spec names: "Tenant B submitting `document_id = Tenant A's document`... must fail. Do not rely only on browser hiding identifiers." Confirmed live: `/process`, `/detect`, and `/map` on Tenant A's real `document_id`, submitted with Tenant B's own real authenticated session, all rejected (404/404/422 — RLS-scoped queries return "not found" rather than "forbidden," which is the stricter behaviour: it does not even confirm the resource exists to an unauthorised caller).

## Purge against a live, fully migrated row (closes FDH-3's own disclosed gap)

`docs/financial-data-hub/FDH3_PURGE_CERTIFICATION.md` section 8 explicitly listed as **not yet certified**: "Purge against a live, migrated `fdh_statement_uploads` row... because the tables aren't live yet [at FDH-3's own certification time]." Migrations are now live. `FDH4-PURGE-01`/`02` exercise the real `services/purge.ts` module (`scheduleApprovedDocumentPurge`, `runPurgeAttempt` — imported directly, not reimplemented) against a real processed document: raw storage reference nulled, `raw_document_purge_status = 'purged'`, and — the property spec section 76 explicitly requires — **the 5 canonical transactions and the reconciliation result are untouched**. A second purge attempt short-circuits to `already_purged` without a second delete call.

## Compiled client bundle (spec sections 73, 111)

`.next/static/**/*.js` (89 files) scanned this session for the literal service-role key value: **0 occurrences**. No server-only credential reaches the browser bundle.

## Admin boundary (unchanged, reused)

FDH-4 adds no admin route, no debug endpoint that surfaces raw CSV content. `lib/financial-data-hub/constants/adminBoundary.ts` is untouched.

## What this does NOT re-certify

R7's own 45/45 forgery negative-control suite (`scripts/r7_security_certification.mjs`, trigger-drop/restore RED/GREEN pairs) and its 9/9 same-user-forgery live matrix are R7's own certification record, standing independently — FDH-4 did not re-run the trigger-drop negative control (that would risk live tenant data on a shared DEV project without a scoped reason to repeat it) and instead re-verifies the *outcome* (forgery blocked) fresh, live, this session, via `FDH4-SEC-04`.
