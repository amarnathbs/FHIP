# FDH-14 — Live DEV Certification

Live DEV project: `vqycarelcoijzwlpkpcz` (the same hosted DEV Supabase project referenced by every prior FDH/II
certification round in this repository — read from this worktree's own `.env.local`, not guessed).

## 1. FRESH FDH-14 EXECUTION

### 1.1 Live schema-presence probe

Script: `scripts/fdh14_live_dev_schema_probe.mjs`. Read-only (`select * count=exact head=true` per table, no
row bodies fetched, no mutation). Run 2026-08-31.

**Result: 34/34 representative tables confirmed present**, spanning FDH-1 (`fdh_financial_accounts`,
`fdh_source_documents`, `fdh_processing_jobs`, `fdh_transactions`), FDH-2 (`fdh_categories`=25 rows,
`fdh_subcategories`=121, `fdh_mcc_codes`, `fdh_institutions`, `fdh_merchants`=123, `fdh_merchant_aliases`=198,
`fdh_classification_rules`=77, `fdh_user_classification_rules`), FDH-3 (`fdh_upload_sessions`,
`fdh_document_audit_events`=1,811 rows), R7/FDH-4 (`fdh_bank_statement_uploads`, `fdh_bank_transactions`),
R8/FDH-6 (`fdh_transaction_links`, `fdh_recurring_transactions`), FDH-7 (`fdh_transaction_allocations`), FDH-9
+ bridge (`fdh_payroll_events`, `fhip_import_proposals`, `fhip_import_applications`), FDH-10
(`fdh_liability_statements`, `fdh_liability_statement_transactions`), FDH-11 (`fdh_investment_statements`,
`fdh_investment_statement_activities`, `fdh_investment_statement_positions`), FDH-12
(`fdh_retirement_statements`, `fdh_retirement_statement_activities`), and the canonical modules FDH feeds
(`income_sources`=406 rows, `liabilities`=339, `retirement_accounts`=367, `ii_transactions`=96,
`ii_holding_snapshots`=0).

**Significance**: several individual module completion reports (FDH-2, FDH-3, FDH-7, FDH-9, FDH-10, R8) each
disclosed, at the time they were written, that their own migration had **not yet** been applied to DEV. This
fresh probe demonstrates that, as of the actual current state of the shared DEV project, **all of them now
are** — the Product Owner has since applied the outstanding migrations. This supersedes those specific
"not applied" residuals (they are RESOLVED at the schema-presence level); see `FDH14_RESIDUAL_RISK_REGISTER.md`
for which *behavioural* claims are still only reused-from-PGlite versus freshly re-proven live.

The non-trivial row counts on `income_sources` (406), `liabilities` (339), `retirement_accounts` (367) and
`fdh_document_audit_events` (1,811) confirm this is a **live, actively-used, shared DEV environment carrying
real prior test-fixture history** — consistent with this project's own 50-user regression-suite and multi-round
certification history. No row in any of these tables was read, modified, or deleted by this probe (head-only
count queries).

### 1.2 Live cross-tenant + same-tenant authority-forgery matrix

Script: `scripts/fdh14_cross_domain_security_certification.mjs`. Run 2026-08-31. Full detail in
`FDH14_SECURITY_CERTIFICATION.md` §1. **Result: 28/28 PASS.** Two fresh synthetic tenants per domain (6 total),
one seeded row per domain, all deleted and independently re-verified gone (see §3 below).

## 2. REUSED PRIOR CERTIFIED EVIDENCE (live-DEV rounds run by each module's own certification pass)

- FDH-1: live RLS 27/27 (closure re-run).
- R7: live 15/15; independent live reconciliation 10/10.
- FDH-4: live security 13/13; live scale 4/4 at 10,000 rows.
- FDH-5: live re-run (post-migration) 18/18.
- FDH-6: live 34/34 (closure re-run).
- FDH-8: live 44/45 PASS + 1 info.
- FDH-11: live 43/43.
- FDH-12: live round 3, 262/262 (after 2 real defects found in rounds 1-2 and fixed forward).

None of these were re-executed a second time inside FDH-14 — each is recent, against the same DEV project, on
a code path this pass confirmed (by `tsc`/`vitest`/source inspection) is unchanged since that module's own
round.

## 3. DEV cleanup verification (this pass's own fresh writes only)

Every row/user this pass itself created (6 synthetic auth users, 3 synthetic canonical rows, plus one
short-lived impersonation-insert attempt that was correctly rejected and so created nothing) was deleted, and
cleanup was independently re-verified by re-querying every id: **residue = 0**, confirmed by the script's own
final `CLEANUP` check (`PASS  CLEANUP: independent re-query confirms zero synthetic residue residue=0`). No
pre-existing DEV data (the 406/339/367/1,811-row tables noted above) was read, mutated or deleted at any point.

## 4. What this pass did NOT do live

A full five-domain, real-file-upload, single-household live browser E2E run (the "golden household" of spec
§19) was not built fresh in this pass. See `FDH14_SCOPE_AND_CERTIFICATION_PLAN.md` §4 and
`FDH14_RESIDUAL_RISK_REGISTER.md` item R-14-1 for why, and for exactly which per-domain live evidence is relied
on instead.
