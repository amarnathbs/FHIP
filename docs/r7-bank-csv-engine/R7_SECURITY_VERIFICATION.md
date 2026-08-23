# R7 — Security Verification

## Scope and method

R7's live-DEV Supabase project could not be schema-modified from this session (see `R7_LIVE_DEV_VERIFICATION.md` for the exact, disclosed reason). All security certification below is therefore against a **real PostgreSQL 18 engine** (PGlite/WASM, not a mock, not an ORM shim) rebuilt from the entire `supabase/migrations/` chain including 0064, with real seeded tenant data — the identical methodology `scripts/db-rebuild-check/rls.mjs` established and this project has relied on for prior migration-lineage certification. Script: `scripts/r7_security_certification.mjs`. **Result: 45/45 checks passed, 0 failed.**

## Cross-tenant isolation (8 R7-touched tables)

`fdh_financial_accounts`, `fdh_statement_uploads`, `fdh_transactions`, `fdh_duplicate_candidates`, `fdh_reconciliation_results`, `fdh_data_quality_results`, `fdh_csv_mapping_templates`, `fdh_transaction_corrections` — for two real tenants (A, B) each with a real seeded account/document/2 transactions/duplicate-candidate-pair/reconciliation-result/data-quality-result/mapping-template/correction:

- **Positive access**: 16/16 — each tenant reads exactly their own rows.
- **Cross-tenant read denial**: 8/8 — Tenant A sees zero of Tenant B's rows on every table.
- **Cross-tenant write denial**: 2/2 — Tenant A cannot UPDATE/DELETE Tenant B's mapping template / correction.

## Same-user forgery, using VALID OWN foreign keys (spec §52, §82)

The central lesson this project's R6-SECURITY-FINAL closure generalised — a test that fails only because of an FK constraint violation proves nothing; a real forgery test uses the attacker's own valid, owned IDs. Every case below uses Tenant A's own real account/document/transaction ids:

| # | Attempt | Result |
|---|---|---|
| 1 | INSERT a new `fdh_transactions` row directly, valid own account+statement FK | **BLOCKED** (`engine-authoritative`) |
| 2 | UPDATE own document's `certification_status` to `'certified'` | **BLOCKED** (`authoritative`) |
| 3 | UPDATE own document's `detection_confidence` to `1.0` | **BLOCKED** |
| 4 | INSERT a second `fdh_reconciliation_results` row with `status='reconciled'` | **BLOCKED** |
| 5 | INSERT a fabricated `fdh_duplicate_candidates` row with `status='auto_confirmed'` | **BLOCKED** |
| 6 | UPDATE own transaction's `dedup_status` directly to `'unique'` | **BLOCKED** |
| 7 | UPDATE own PENDING duplicate candidate to `not_duplicate` + resolve both transactions | **ALLOWED** (legitimate, spec-sanctioned) |
| 8 | Re-forge the now-resolved candidate to `'auto_confirmed'` | **BLOCKED** |
| 9 | UPDATE own transaction's `description_clean` (a genuine correction) | **ALLOWED** (legitimate) |

Cases 7 and 9 prove the boundary is genuinely narrow, not a blanket lockout — legitimate user actions (resolving your own duplicate, correcting your own transaction) continue to work.

## Service-write regression (spec §83)

After the lockdown, the exact three previously-blocked operations (insert transaction, set `certification_status`, insert reconciliation result) were re-attempted via the `service_role` connection (bypassing RLS, matching production's `createAdminClient()`) — **all three succeeded**, proving legitimate server-side processing is unaffected.

## Negative controls (proving the certification is not vacuous)

- RLS disabled on `fdh_transactions`/`fdh_statement_uploads`/`fdh_csv_mapping_templates` → Tenant A immediately sees Tenant B's rows (leak count ≥ 1) → RLS re-enabled → isolation restored. 6/6.
- The authoritative-field trigger dropped → the previously-blocked `detection_confidence` forgery now succeeds → trigger restored → forgery blocked again. 2/2.

## Storage security (spec §16-17, §49, §84)

Not independently re-verified live in this pass — R7 introduces no new storage bucket or upload mechanism; it reuses FDH-3's `fdh-source-documents` bucket, SELECT-only storage RLS policy, and server-mediated upload flow verbatim (`downloadDocumentObject()` added to `services/storage.ts` follows the identical "assumes the caller already verified ownership" discipline as every other function in that file). FDH-3's own live storage-security certification (owner/other-user/anonymous/trusted-service access) is documented in `docs/financial-data-hub/FDH3_STORAGE_SECURITY.md` and is unmodified by R7. This is a **carried-forward** guarantee, not a re-proven one — disclosed as a known limitation in `R7_ACCEPTANCE_REPORT.md`.

## Admin operational-metadata boundary (spec §17, §53)

Confirmed no ad-hoc admin role with standing table access was introduced (`pg_roles` query — 0 matches for `admin`/`fdh_admin`/`r7_admin`). R7 adds no admin route or admin-facing raw-content access path at all.

## Valid-FK discipline

Every forgery attempt above used a real UUID the attacking tenant genuinely owns (their own account, document, transaction, duplicate-candidate id) — never a foreign key that would fail on referential-integrity grounds alone. A test that "fails" only because of an FK violation is explicitly not counted as security evidence.
