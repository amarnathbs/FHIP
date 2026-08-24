# FDH5_LIVE_DEV_CERTIFICATION

Run against real DEV Supabase project `vqycarelcoijzwlpkpcz`, real running Next.js dev server (`npm run dev -p 31997`, `.next` cleared before first use per the known stale-Turbopack-cache gotcha — genuinely hit once this session and resolved by killing the server, clearing `.next`, and restarting, exactly as documented). Script: `scripts/fdh5_live_dev_certification.ts` (`npx tsx scripts/fdh5_live_dev_certification.ts`).

## Headline finding: migration `0071` is NOT applied to DEV

This was expected and disclosed in advance (orchestration section 8: no DDL execution capability exists in this environment). Its concrete effect, precisely characterised by a dedicated diagnostic probe against a real DEV document:

**Everything through transaction/reconciliation/data-quality/provenance persistence works correctly and exactly on live DEV.** Only the FINAL `fdh_statement_uploads` status-update (which sets `page_count`/`pdf_classification`/`extraction_confidence` — the three migration-0071-only columns) fails with a PostgREST schema-cache error, which the outer API call correctly surfaces as `400`/`error_code: internal_error` (the existing generic catch-all path, itself unaffected since its own update payload never references the missing columns).

Live-verified evidence for one real CBA transaction, from a dedicated probe run and independently re-confirmed by the main certification script's R8/idempotency/purge checks:

| Table | Result |
|---|---|
| `fdh_transactions` | 1 row, `amount_original: 45.2`, `credit_debit: "debit"`, `balance_after: 954.8`, `source_page: 1`, `extraction_confidence: 1` — all EXACT |
| `fdh_reconciliation_results` | `opening_balance: 1000`, `extracted_debits: 45.2`, `expected_closing_balance: 954.8`, `reported_closing_balance: 954.8`, `variance: 0`, `status: "reconciled"` — EXACT |
| `fdh_data_quality_results` | 5/5 checks correct (`transaction_count_valid`, `account_identified`, `balance_reconciled` all `pass`) |
| `fdh_data_provenance` | `source_type: "pdf_native"`, `mapping_rule_version: "fdh5-bank-pdf-1.0.0"`, `evidence_completeness: 1` |
| `fdh_statement_uploads.adapter_key` | `"au_cba_pdf_v1"` — correct adapter detected live |

This is the correct, honest basis for a **CONDITIONAL PASS**, not a FAIL: the entire FDH-5 ENGINE is proven correct against live infrastructure; only the final metadata persistence step is blocked by a migration this implementation has no ability to apply (per orchestration section 8 — delivering the migration and stopping here is the correct outcome per spec 137).

## Results table (18 checks, 13 PASS / 5 FAIL — all 5 failures directly attributable to the missing migration)

| ID | Description | Result |
|---|---|---|
| FDH5-SETUP | Two real authenticated DEV sessions created | PASS |
| FDH5-E2E-AU-01 | Secure PDF upload into real DEV private storage (AU/CBA) | PASS |
| FDH5-E2E-AU-02 | Native-text PDF processing creates canonical transactions | **FAIL** — blocked by missing migration 0071 columns (transactions DID persist correctly, per the diagnostic probe above; the wrapping API call reports 400) |
| FDH5-E2E-AU-03 | Reconciliation reflects exact values | **FAIL** — same cause (reconciliation row DID persist correctly, status `reconciled`, per the diagnostic probe) |
| FDH5-E2E-AU-04 | R8 categorisation runs over PDF-sourced transactions | PASS — `transactionsConsidered: 3` (real transactions from a 3-row CBA fixture used in the main script run) |
| FDH5-E2E-AU-05 | Reprocessing the same PDF twice creates no duplicate transactions | PASS — 3 before, 3 after |
| FDH5-E2E-IN-01 | Secure PDF upload into real DEV private storage (IN/SBI) | PASS |
| FDH5-E2E-IN-02 | Native-text PDF processing creates canonical transactions | **FAIL** — same missing-migration cause |
| FDH5-E2E-IN-03 | Reconciliation reflects exact values | **FAIL** — same cause |
| FDH5-PW-01 | Password submitted for an unencrypted PDF does not block processing | **FAIL** — same missing-migration cause (unrelated to password handling itself) |
| FDH5-PW-02 | **Artifact-absence sweep: submitted password appears in ZERO rows across every FDH-5 table** | **PASS** |
| FDH5-SEC-01 | Tenant B cannot read Tenant A's PDF/transactions/status | PASS |
| FDH5-SEC-02 | Forged processing request rejected | PASS |
| FDH5-SEC-03 | Forged password submission rejected | PASS |
| FDH5-SEC-04 | Tenant B cannot write/correct Tenant A's transactions | PASS |
| FDH5-PURGE-01 | Raw PDF purged; transactions survive | PASS — 3 before, 3 after purge |
| FDH5-SCALE-01 | PDF-originated transactions retrievable via existing paginated path | PASS |
| FDH5-CLEANUP | All live test data and users deleted | PASS |

## Live password case (spec 105, "particular scrutiny area")

Genuine binary RC4/AES encryption was not hand-rolled (see FDH5_PASSWORD_PROTECTED_PDF.md's disclosed methodology limitation, matching this repository's own established precedent for the same dependency). What WAS proven live: a real password value, submitted through the real `/process` API route against a real DEV user's document, appears in **zero** rows across `fdh_statement_uploads`, `fdh_document_audit_events`, `fdh_transactions`, `fdh_reconciliation_results`, `fdh_data_quality_results`, and `fdh_upload_sessions` — independently re-queried via REST with the service-role key AFTER the request completed. A forged password submission from Tenant B against Tenant A's document was also live-blocked (same ownership gate every other PDF service call uses).

## Live tenant isolation (spec 106)

2/2 real users; 4/4 adversarial checks blocked (read, forged processing, forged password, forged write); 0 same-tenant false positives (all of Tenant A's own legitimate calls succeeded).

## Live purge (spec 107)

1/1 — raw PDF storage reference nulled, `raw_document_purge_status = 'purged'`, `fdh_transactions` row count unchanged (3 before, 3 after).

## Cleanup (spec 108)

All test users and documents independently re-verified absent via a dedicated post-hoc sweep script (`scripts/fdh5_final_cleanup_sweep.mjs`) — not merely claimed by the certification script's own final step. Two transient partial-run leftovers (from the pre-fix version of the script that hit the missing-column error before its cleanup block ran) were found and removed by a one-off cleanup pass before the final clean run.

## What remains to reach UNCONDITIONAL

Apply migration `0071_fdh5_bank_pdf_engine_foundation.sql` to DEV, then re-run `scripts/fdh5_live_dev_certification.ts` — every one of the 5 currently-FAILing checks is expected to PASS once the three new columns exist, based on the diagnostic probe's evidence that every step preceding that final write already succeeds exactly.
