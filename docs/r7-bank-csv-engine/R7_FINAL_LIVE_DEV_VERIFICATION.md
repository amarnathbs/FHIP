# R7-FINAL — Live DEV Verification

## Status: PERFORMED — migration 0064 confirmed live, 15/15 cases executed for real

This supersedes `R7_LIVE_DEV_VERIFICATION.md` (which was correctly BLOCKED at the time — no DDL credential existed to apply migration 0064). Migration 0064 was independently confirmed live on DEV (`vqycarelcoijzwlpkpcz`) earlier the same day this pass ran (both new tables present with all columns, `fdh_parser_registry`/`fdh_parser_versions` carrying their 8 new rows each, a live anon-key write probe against the new table returning a genuine `42501` RLS rejection). This pass re-confirmed it is live by simply running every case successfully against it.

**Branch**: `feature/r7-live-dev-verification`, off `feature/r7-bank-csv-engine` @ `06750c7`. App server: real `next dev` (Turbopack) on `http://localhost:3199`, pointed at the real DEV project via this worktree's own `.env.local`. Test users: `r7-live-cert-{a,b}-<timestamp>@test.fhip.internal`, created via `/auth/v1/admin/users`, deleted at the end of every run (verified 0 rows / 404 afterwards — see Cleanup below).

## A genuine live-only defect blocked EVERY case on the first attempt

The very first `/process` call returned `400 {"error":"column fdh_transactions.reference_raw does not exist"}` — **100% of live processing was broken**. Root cause: `lib/financial-data-hub/bank-csv/repository.ts`'s `loadDedupIndexForAccount()` selected a column `reference_raw`; the real column (confirmed both by the live error and by migration 0047's own source) is `source_reference`. This function is called by every `/process` request, so nothing could be certified live until it was fixed.

This was invisible to every prior certification method:
- The 198 in-memory vitest cases call `runBankCsvPipeline()` directly — they never touch the database read path at all.
- `r7_security_certification.mjs` (PGlite) seeds fixture rows directly via SQL/service-role, never through `processBankCsvDocument()`.
- `tsc --noEmit` cannot catch a wrong string literal inside a `.select('...')` call — it's a runtime-only Postgres schema mismatch.

**Fixed**: `lib/financial-data-hub/bank-csv/repository.ts` (3 lines: interface field, `.select()` string, comparison). Re-verified: `tsc` clean, full 1938/1943-test suite still green, 174/174 oracle comparisons still 0 discrepancies, then the live case succeeded (`PROCESS 200 {"certification_status":"certified", ...}`).

Two more live-only defects were found and fixed during the run — both documented in full in `R7_FINAL_ACCEPTANCE_REPORT_ADDENDUM.md`'s defect log and summarised in `R7_ACCEPTANCE_REPORT.md`:
- Within-file duplicate candidates never got a real `fdh_duplicate_candidates` row (a `pending-row-N` in-memory placeholder was never resolved to the real post-insert id) — `bankCsvProcessingService.ts`, fixed.
- The generic repository's `update()` unconditionally injected `updated_at`, which `fdh_duplicate_candidates`/`fdh_transaction_corrections` don't have — silently broke every legitimate duplicate-resolution while the API still reported `{resolved: true}` — `repositories/base.ts` + 2 call sites, fixed.

## The 15 live cases — all executed for real, all PASS (final run)

Script: `scripts/r7final_live_dev_certification.mjs`. Each case: uploads a real fixture via `POST /bank-csv/upload`, calls `/detect`, `/map` where needed, `/process`, independently computes the expected canonical rows via `scripts/r7_independent_bank_csv_oracle.py` (or, for two cases the oracle's whole-file model doesn't fit, an inline from-scratch recomputation — see the two RECON notes below), reads the persisted rows back via the service-role client, and diffs.

| Case | Fixture | What was proven | Result |
|---|---|---|---|
| LIVE-R7-001 | `au_nab_debit_credit.csv`, uploaded twice | 1st import: 3 created (=oracle). 2nd identical import: 0 new, 3 `duplicate_confirmed`. | PASS |
| LIVE-R7-002 | `overlap_stmt_a.csv` + `overlap_stmt_b.csv` (custom, Jan 5–31 then Jan 15–Feb 20, 3-row overlap) | A: 4 created. B: 2 new + 3 confirmed duplicates. 6 total distinct economic transactions, never 9. | PASS |
| LIVE-R7-003 | `au_cba_debit_credit.csv` (debit/credit columns) | All 5 rows' amount/direction/date match the independent oracle exactly. | PASS |
| LIVE-R7-004 | `au_westpac_single_signed.csv` | Same canonical sign convention as R7-003 (positive magnitude + separate direction column) verified on all 3 rows. | PASS |
| LIVE-R7-005 | `in_sbi_dr_cr.csv` (DR/CR indicator) | Direction and signed value correct on all 3 rows. | PASS |
| LIVE-R7-006 | `generic_ambiguous.csv` (custom, unrecognised header, date `01/02/2026`) | `detect` → `manual_mapping_required`; `/process` without a mapping → `400 mapping_required`. Never silently guessed. | PASS |
| LIVE-R7-007 | same fixture, mapped | `/map` with explicit `date_format: DD/MM/YYYY` → row 1 persists as `2026-02-01` (1 Feb), not `2026-01-02`. Mapping template real and tenant-scoped (`fdh_csv_mapping_templates.user_id` = the uploading user). | PASS |
| LIVE-R7-008 | `in_hdfc_debit_credit.csv` | Independently computed opening+credits−debits=closing matches; R7 returns `reconciled`. | PASS |
| LIVE-R7-009 | `recon_fail.csv` (custom, balance deliberately off by $10) | Independent variance = −$10.00; R7 returns `failed`, never `certified`/`reconciled`. | PASS |
| LIVE-R7-010 | `dup_candidate.csv` (custom, 2 identical rows, no reference/balance) | 1st occurrence `unique`, 2nd `duplicate_candidate`; a real `fdh_duplicate_candidates` row (status `pending`) backs it. | PASS |
| LIVE-R7-011 | `dup_legit.csv` (custom, same date/amount/description, distinct `Ref No`) | 2 canonical transactions, both `unique`, distinct fingerprints — reference number alone disambiguates. | PASS |
| LIVE-R7-012 | `multi_account_1/2.csv` (custom, identical row, 2 masked identifiers) | 2 distinct accounts, 1 row each, both `unique`, distinct fingerprints (account id is part of the fingerprint). | PASS |
| LIVE-R7-013 | `au_westpac_single_signed.csv` (AUD) + `in_icici_debit_credit.csv` (INR) | Distinct accounts; currency retained per row; `amount_reporting_currency`/`fx_rate` both null on every row (no conversion). | PASS |
| LIVE-R7-014 | `large_2500.csv` (custom, 2500 rows) | Exactly 2500 persisted, source rows 1..2500 with no gaps/dupes, unique ids, `reconciled`, `certified_row_count=2500` — proves no PostgREST 1000-row default-page truncation live. | PASS |
| LIVE-R7-015 | `unsupported.txt` (custom, non-CSV prose) | `detection_status: invalid` — never fabricates a format match. (First attempt accidentally began with `%PDF-1.4`, which the app's real magic-byte sniffer correctly identified as an actual PDF — a fixture-design mistake on this session's part, not a defect; corrected.) | PASS |

## Boundary checks (spec §33–37)

| Check | What was proven | Result |
|---|---|---|
| §35 reimport idempotency | Retrying `/process` on an already-certified document: persisted row count unchanged (5→5), same `certification_status`, no second `fdh_reconciliation_results` row. | PASS |
| §36 partial-failure atomicity | `partial_fail.csv` (2 valid + 1 row missing its date): `certification_status='partial'`, 2 valid rows persisted, 1 rejected — never silently `certified`. | PASS |
| §37 classification-ready contract | A certified live transaction carries `transaction_date`, `description_raw`/`_clean`, `amount_original`, `credit_debit`, `currency_original`, `transaction_type_hint`, `financial_account_id`, `statement_upload_id` — no raw-CSV reopen needed. | PASS |
| §33 bank→investment boundary | `in_hdfc_debit_credit.csv` row 3 ("SIP MUTUAL FUND ABC") persists with `transaction_type_hint='investment_transfer_candidate'`; live query of `ii_transactions`/`ii_tax_lots`/`ii_holding_snapshots` for the uploading user: 0/0/0 new rows. | PASS |
| §34 FDH canonical ownership | Live schema probes for `ii_bank_transactions`/`ii_cash_transactions`/`ii_bank_statements` all return PostgREST `404` (relation does not exist). | PASS |

## Cleanup — verified, not assumed

Every run's cleanup step deletes rows from `fdh_transaction_corrections`, `fdh_duplicate_candidates`, `fdh_data_quality_results`, `fdh_data_provenance`, `fdh_reconciliation_results`, `fdh_transactions`, `fdh_review_items`, `fdh_csv_mapping_templates`, `fdh_statement_uploads`, `fdh_financial_accounts` scoped to the 2 test users, then **re-queries every one of those tables for both users and asserts 0 rows** (not "the DELETE call didn't error" — an actual re-read), then deletes both auth users via `/auth/v1/admin/users/{id}` and **re-queries them, asserting 404**. Both checks passed on the final definitive run. No pre-existing DEV data was touched — every write this session made carried a `r7-live-cert-*@test.fhip.internal` user id, and only rows scoped to those exact user ids were ever deleted.

## Honest scope note

Two independent full runs were executed after all fixes landed (`live_run3` and the definitive final run) — both produced identical results (35/35 checks, 10/10 independent reconciliations, 0 failures). The security dimension of live-DEV testing (§24-32) is documented separately in `R7_FINAL_SECURITY_VERIFICATION.md` — it found one genuine, unresolved forgery gap (`reconciliation_status`), which is why this release's overall verdict is **not** UNCONDITIONAL FULL PASS despite every one of the 15 functional cases above passing cleanly.
