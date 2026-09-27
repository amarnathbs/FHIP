# Production Import Propagation Certification -- PLAN (not yet run)

Approved Upload -> Canonical User Data programme. Prepared 2026-09-27 by the stage-3 consolidation.
**Status: NOT RUN. Production has not been touched by any agent (not even reads).** Every step below is run
by the PO. This document is the plan and the checklist; the certification is complete only when the PO has
run it and every "expected" result was observed.

Release content: branch `feature/canonical-upload-cert` (the consolidated, DEV-certified tree) -> `main`.
Migrations: `0207`..`0214` and `0218`, all additive (new columns, functions, triggers, indexes, CHECK
widenings that revoke no existing value -- derived from the migration ledger by the security review).

## 0. Deploy blockers -- resolve BEFORE the sitting

| # | Blocker | Why | What closes it |
|---|---|---|---|
| B1 | `GET /api/dashboard/summary` took 23-39 s on localhost against DEV (about 110 Supabase round trips at ~166 ms), against the 28 s Amplify request limit | a Dashboard that times out in production shows no figures at all | measure it in a production-like deploy (Amplify preview or staging against DEV) with a user that has imported statements; if p95 is not comfortably under 28 s, cut round trips (batch the per-section reads) before release |
| B2 | 0218 is not applied on DEV yet | DEV must run the exact release schema before production does | PO runs `docs/financial-data-hub/po_run/DEV_apply_0218.sql` on DEV (guarded; proven in PGlite) |
| B3 | Release PR must include current `main` | `main` is 6 commits ahead (NAV1 only, no migrations); `git merge-tree` reports a clean merge | merge `origin/main` into the release branch, re-run tsc + the programme suites |
| B4 | Open PO decisions that change what users see (FINAL_COMPLETION_REPORT.md, "Open PO decisions") | in particular: the combined expense basis replaces a whole planned group by that group's actuals (live on DEV: 16,875/month of planned "other" replaced by 220 of card purchases) | PO decides ship-as-is or change before release |

## 1. Preflight (read-only), a day before AND at the start of the sitting

Run `docs/financial-data-hub/po_run/PRODUCTION_preflight_READ_ONLY.sql` in the production SQL editor.
Proven in PGlite: on a pre-0207 chain every `has_*` is false; on the full chain every `has_*` is true.

| Query | Expected before the sitting |
|---|---|
| Q0 `ii_nav_retention_policy` | exactly one row, `environment = 'production'` |
| Q1 migration presence | every `has_0207` .. `has_0218` = false |
| P1 liability statements sharing a document (0208) | 0 rows |
| P2 bank debit matched by several activities (0208) | 0 rows |
| P3 statements with several ready/applied proposals (0209) | 0 rows |
| P4 payroll events with several Income applications (0210) | 0 rows (else STOP: `scripts/fdh9_0210_duplicate_income_applications_report.sql`) |
| P5 cross-tenant II rows (0213) | 0 and 0 |
| P6 cross-tenant split lines (0218 pre-check) | 0 (0218 refuses to apply otherwise) |
| P7 table sizes | informational (timing) |
| P8 `pg_graphql` installed? | informational; tell Claude if present (the GUC analysis assumed GraphQL is not reachable) |

Any unexpected result: STOP and send it to Claude. Do not improvise a fix in production.

## 2. Deploy-order hazards (security review, S8) -- why it is ONE sitting

| If ... | What breaks |
|---|---|
| **Code deployed before the migrations** | card/loan statement extraction and Apply fail (0208/0209 RPCs missing); retirement and AU broker uploads fail (0207 `extraction_warnings`); publish / matcher audit rows are silently dropped (0207 event types); the AU imported-statements panel returns 500 (0213 column); retirement evidence matching is silently skipped (0211) |
| **Migrations applied, old code still live** | **0209 CRITICAL silent double count**: the old 3-argument Apply now writes ledger rows that the legacy Dashboard ALSO adds to monthly_repayment / expenses; **0213 HIGH**: $0 holding snapshots can overwrite same-date snapshots; 0210: review-pending payslips cannot be approved; 0208: orphan partial statement edge case |

So: apply 0207..0214 then 0218 in one sitting, reload the PostgREST schema, and have the new code live
within minutes. Both windows are silent-damage windows for users who Apply a card/loan or AU statement
inside them; section 5 has the detection queries.

## 3. The sitting (low-traffic time; PO + someone who can watch the Amplify build)

1. Re-run the preflight (section 1). All expected.
2. Merge the release PR to `main`. Amplify auto-deploys on push to `main`; note the start time and the
   typical build duration from the last builds (B).
3. While the build runs, time the migrations so they FINISH just before the build goes live (window target:
   under 5 minutes of "new schema, old code"). In the production SQL editor, each file pasted WHOLE, one at a
   time, in this order, checking each succeeds before the next:
   1. `supabase/migrations/0207_canonical_upload_schema_foundation.sql`
   2. `supabase/migrations/0208_fdh10_atomic_liability_statement_persist.sql`
   3. `supabase/migrations/0209_fdh10_liability_apply_ledger.sql`
   4. `supabase/migrations/0210_fdh9_income_apply_guards.sql`
   5. `supabase/migrations/0211_fdh12_retirement_apply_guards.sql`
   6. `supabase/migrations/0212_fdh_bank_approval_integrity.sql`
   7. `supabase/migrations/0213_fdh11_investment_integrity.sql`
   8. `supabase/migrations/0214_canonical_wp15_input_population_proposals.sql`
   9. `supabase/migrations/0218_canonical_security_review_hardening.sql`
   10. `notify pgrst, 'reload schema';`
   Record T_mig (time the last file finished) and T_live (time the new build went live).
   Each migration refuses (and rolls itself back) rather than revoke a sibling value or apply over bad data
   (0207, 0210, 0214, 0218 pre-checks); a refusal means STOP -- send the message to Claude.
   Large tables: no index is built on `fdh_transactions` (the biggest FDH table). The 9 new indexes are on
   assets, fdh_financial_accounts, fdh_liability_statements (1), fdh_liability_statement_activities (3),
   fhip_import_applications (1) and fhip_import_proposals (2); they are plain (non-CONCURRENT) builds that
   briefly block writes to that table, which is acceptable at those sizes. New NOT NULL columns use constant
   defaults (`'[]'::jsonb`, `'not_applied'`, `'manual'`), which PostgreSQL adds without rewriting the table.
   P7 gives the sizes (DEV apply durations were not recorded, so time the first file). 0213 back-fills never-applicable positions to 'pending' in its own transaction. If P7 shows any FDH
   table above ~1M rows, tell Claude before the sitting.
4. Re-run Q1: every `has_*` = true. Re-run P6: 0.

## 4. Post-deploy smoke (within 15 minutes of T_live)

| # | Check | Expected |
|---|---|---|
| S1 | open the app, Dashboard for the PO's test account; note the load time (browser network tab) | 200, under 28 s (B1) |
| S2 | `/financial-data-hub` | redirects to the domain import panels (D-13) |
| S3 | Expenses -> "Import bank statement" and Retirement -> "Import statement" are visible | present |
| S4 | SQL: `select has_function_privilege('anon','fdh15_apply_asset_proposal(uuid, text, text[])','execute'), has_function_privilege('anon','fdh15_apply_expense_proposals(jsonb)','execute');` | false, false (SR-04) |
| S5 | SQL: `select count(*) from pg_trigger where tgname in ('trg_fdh_liability_statements_authoritative_insert_0218','trg_fdh_liability_activities_authoritative_insert_0218','trg_fdh_allocations_same_tenant_0218');` | 3 |
| S6 | Amplify / CloudWatch logs for the upload and apply routes | no 5xx spike, no 504 |
| S7 | window detection (section 5) | 0 and 0 |

## 5. Window detection (run after S1-S6; replace the two timestamps)

```sql
-- Card/loan Applies inside the migration-first window (possible 0209 double count). Expected 0.
select count(*) from fhip_import_applications
 where target_domain = 'liability' and applied_at between '<T_mig>' and '<T_live>';
-- Holding snapshots with value 0 written inside the window (possible 0213 $0 snapshot). Expected 0.
select count(*) from ii_holding_snapshots where value = 0 and created_at between '<T_mig>' and '<T_live>';
```
Any non-zero count: send the rows' ids to Claude; do not edit them by hand.

## 6. Synthetic production journey (the PO, with a DISPOSABLE test account)

Use a production test account created by the PO for this purpose only, holding no real finances, and
documents built by `npx tsx scripts/canonical_cert/documents/build_documents.ts --salt P --month <last complete month>`
(fictional "FHIP Test Bank", "FHIP Test Card", "FHIP Test Broker", "FHIP Test Super Fund A/B",
"Test Person Alpha"; manifest.json lists the expected numbers). Never a real person's documents.

| Step | Do | Expected (change against the account's starting figures) |
|---|---|---|
| J1 | confirm country (AU) | uploads allowed |
| J2 | Expenses -> Import bank statement: the oracle bank CSV with its period; review; approve all | Expenses tab shows the imported actuals next to planned with the "Imported from bank statement" badge; before approval the Dashboard did not change |
| J3 | Liabilities -> import the card CSV (purchases 200 + 20, payment 220); approve; Apply | card liability = statement closing, badge + statement history; household spending +220, **never +440** |
| J4 | Liabilities -> import the loan CSV (payment 2,000 = 1,550 + 430 + 20); approve; Apply | liability -1,550; cost of debt 450; the 2,000 counted once |
| J5 | Income -> import the payslip PDF; Apply | gross 6,700 / net 5,000; the matching bank salary credit does not add a second 5,000 |
| J6 | Retirement -> import the fund A statement; confirm the account; Apply | the confirmed account's balance updated; statement evidence visible on the Retirement tab |
| J7 | Investments -> import the AU broker CSVs; "Imported, not yet in Net Worth" -> Add to Net Worth | holdings appear in the Investments tab; Dashboard investments equal the tab; BUY funding is not spending, SELL proceeds are not income, the dividend counts once |
| J8 | Assets -> "Add your bank balance to Assets" | cash asset with the account's country; the "Bank balance -- not in Net Worth" note disappears |
| J9 | repeat one Apply of each kind | "already applied"; no figure changes |
| J10 | time the Dashboard after J2-J8 | under 28 s |
| J11 | delete the test account (account deletion) | every row goes (applied card/loan chains cannot be deleted row by row, but account deletion removes them -- proven on the real migration chain, `tests/unit/gpImportChainDeletion.test.ts`) |

## 7. Rollback

- The migrations are additive and have no down-migrations; rolling the schema back is not planned. The
  preferred response to a defect is a roll-forward fix.
- Reverting the CODE alone (revert the merge on `main` -> Amplify redeploys the old build) re-opens the
  "migrations applied, old code live" hazards of section 2 (0209 double count, 0213 $0 snapshots) for as
  long as the old code is live. If a code revert is unavoidable: also stop FDH uploads for that period (the
  `FDH_DOCUMENT_UPLOAD_ENABLED=false` environment variable, which needs Amplify console access and a
  redeploy), and run the section 5 queries over the whole reverted period afterwards.
- A migration that refuses in step 3 has already rolled itself back; stop the sitting there. If the build
  had already gone live with some migrations missing, the section 2 "code first" failures are loud (uploads
  fail); finish the migrations or revert the code as above.

## 8. What "production certified" will mean

Every preflight result as expected, all 10 migration steps succeeded, S1-S7 as expected, J1-J11 as expected,
and B1 measured under the limit. Record the results (with times) and send them to Claude for the terminal
report; until then the programme's production status is "NOT CERTIFIED".
