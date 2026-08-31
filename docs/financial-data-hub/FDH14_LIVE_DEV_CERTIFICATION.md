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
on instead. **This gap is closed by the TARGETED CLOSURE round below.**

## 5. TARGETED CLOSURE ROUND (2026-08-31) — five Product-Owner-named gaps

Reconciliation: `origin/main` had advanced by one commit
(`module11_1_live_dev_concurrency_verification.mjs`) since this branch's base; merged cleanly, zero conflicts.
`tsc` and both pre-existing FDH-14 scripts were re-run fresh post-merge and still pass identically (34/34,
28/28).

### 5.1 GAP 1 — fresh golden-household cross-domain E2E oracle

Script: `scripts/fdh14_golden_household_e2e_oracle.mjs`. One synthetic AU household (payslip income, bank
account, credit card, loan, AU brokerage, superannuation) built directly against live DEV via service-role
writes mirroring each domain's real Apply-function commit shape. **23/23 PASS**, including a genuine live
negative control (a second fund-contribution activity against the same payslip event rejected by the real
`uq_fdh_retirement_activities_payroll_event` unique index, HTTP 409/`23505`). Full detail:
`FDH14_ECONOMIC_EVENT_ORACLE.md` §"FRESH (closure round)".

### 5.2 GAP 2 — fresh foreign-canonical-target security certification

Script: `scripts/fdh14_foreign_canonical_target_certification.ts` (run via `tsx`, since one attack — FDH-11's
`canonical_account_id` forgery — requires invoking the real `applyAuStatementActivity()` TypeScript function
directly, the same code path the production Apply API route uses). **13/13 PASS.** Income/liability/retirement
targeting via `fhip_import_proposals` is blocked at INSERT time by a real DB trigger
(`fdh9_assert_proposal_owner`/`fdh9_assert_application_owner`). FDH-11 investment targeting has NO such DB
trigger (the bridge table is structurally never used for investment — confirmed by a live rejection with "no
implemented target guard"); its real targeting mechanism (`canonical_account_id`) is guarded only at the
application layer (`FOREIGN_ACCOUNT`), confirmed live by calling the real function directly and observing zero
`ii_transactions` rows created against the foreign account. Full detail: `FDH14_SECURITY_CERTIFICATION.md`
§"GAP 2 closure".

### 5.3 GAP 3 — full migration replay, today's chain

`node scripts/db-rebuild-check/replay.mjs` re-run fresh, post-reconciliation, against this branch's **current
111/111 migrations** (through `0115_module11_1_ai_entitlements_quotas_cost_controls.sql`). **Result: 111/111
migrations applied with zero manual intervention**, from empty, one file per version. Manifest: 216 tables (all
216 RLS-enabled, 0 disabled), 3,111 columns, 3,201 constraints, 709 indexes, 265 policies, 100 functions, 156
triggers. Two known platform substitutions only (`pg_cron`/`pg_net` no-ops in `0010`, unrelated to this round).
Re-verified 0116/0117 migration-number collision status: `D:/fhip-a02-wave2` (unmerged) still claims `0116`;
`0117` remains the next free number.

### 5.4 GAP 4 — fresh multi-account + cross-border boundary fixture

Script: `scripts/fdh14_multi_account_cross_border_certification.ts`. One synthetic AU-resident user: 2 bank
accounts, 1 credit card, 1 loan, 1 AU brokerage account, 1 AU super account, plus an India investment
relationship via the pre-existing `ii_accounts`/`ii_transactions` schema. **16/16 PASS**, including a real call
to `matchLiabilityFacility()` (not a stub) proving no wrong-facility matching, and a live DB CHECK-constraint
rejection proving FDH-11 structurally cannot accept `investment_jurisdiction='IN'`. Full detail:
`FDH14_JURISDICTION_CERTIFICATION.md` §"GAP 4 closure" and `FDH14_SCALE_CERTIFICATION.md` §"GAP 4 closure".

### 5.5 GAP 5 — UI/accessibility smoke over the five FDH entry surfaces

Real browser automation (Playwright, this repo's standing `tests/e2e/` tooling and config —
`playwright.config.ts`'s `webServer` runs `npm run dev`, which loads `.env.local` against the same DEV project)
against the actual running Next.js app. Spec: `tests/e2e/fdh14-ui-accessibility-smoke.spec.ts`. A synthetic,
fully-onboarded user was created via the Supabase admin API and logged in through the real `/login` form (not
an API bypass). See `FDH14_UI_ACCESSIBILITY_SMOKE.md` for the full per-surface result table and the two genuine
findings this pass surfaced (a payslip PDF-extraction timeout gap, and one non-ideal user-facing error string).
