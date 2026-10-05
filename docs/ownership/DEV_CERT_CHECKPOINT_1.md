# Owner-before-upload: DEV certification, checkpoint 1 (06-10-2026)

Spec: `DEV_APPLICATION_AND_CERTIFICATION_SPEC_06-10-2026.md` (38 steps). This checkpoint covers steps 1 to 5 (repository and DEV truth, read only), the hand-over to the Product Owner, and the work that does not need the schema (steps 29, 30, documentation reconciliation, regression on the merged tree).

**Evidence labels used:** code-complete, unit-tested, PGlite-verified (in-memory PostgreSQL, not DEV), DEV-verified (database and API), DEV-browser-verified, production-verified. Nothing is rounded up. **No DEV-verified or browser-verified claim is made in this checkpoint beyond the read-only DEV facts in section 3.**

## 1. Step 1: repository truth

| Item | Value |
|---|---|
| Worktree | `D:\FHIP\.claude\worktrees\agent-ab5682bff0446d404` (its own toplevel, clean before work started) |
| HEAD at start (detached) | `b105cf48bcef8adb1e14d6f3c53ad3015c57e797` |
| `origin/main` | `b105cf48bcef8adb1e14d6f3c53ad3015c57e797` (04-10-2026), HEAD equals it |
| Ancestry | `2d09fb6` (final matrix, report, institution design) is an ancestor of `origin/main`. So are `a669ba1` (owner-edit merge), `06635e0` (reconciliation, one ownership model), `71b0942`, `5512b74` (institution slice, malware boundary), `9d23ff6` (AIE owner). |
| Stale worktree certified? | No: certification runs on a detached `origin/main`, then branch `fix/owner-before-upload-dev-cert-20261006` (not pushed) for repairs only. |
| Newer commits than the 06-10-2026 status | `main` holds 50 later commits (bench1, NAV remarks, promo e-mail, date format). No merge was needed. |

## 2. Step 2: migration collision re-scan

Every ref in this clone (833 refs, all branches and remotes) was searched for any file named `supabase/migrations/0236*` in any commit of history. Result: exactly one file has ever carried the number, `0236_owner_before_upload_phase1.sql`. No other merged or unmerged migration owns `0236`. **No rename.** (Merged neighbours: `0231`, `0232`, `0237`, `0238`, `0240`, `0241`, `0242`, `0250`, `0251`, `0252`; `0233` to `0235` unused.) The scan could not see branches that exist only on another machine.

## 3. Steps 3 and 4: DEV prerequisites and the state of 0236 (read only)

Tool: `scripts/canonical_cert/final/dev_0236_state_probe.mjs`. It prints and verifies the host (`vqycarelcoijzwlpkpcz.supabase.co`; the harness refuses any other project), reads the PostgREST OpenAPI document and calls only the pure function `owner_before_upload_allocation_ok`. No write of any kind. It has an anti-vacuity sentinel (a column that does not exist is reported missing).

**Prerequisites: all present.** `0032` (ii_source_documents.owner_member_id), `0140`, `0141`, `0142` (AIE tables), `0153` (`ii_ownership_allocation`), `0207` (`fdh_financial_accounts.owner_role`), `household_members`, `business_entities`, `smsf_funds`, `aie_document_intake`, `aie_extraction_run`. `0154` is not determinable through PostgREST (it changes a constraint). The institution master holds all 10 certified adapter codes (AU: cba, westpac, nab, anz, macquarie_bank; IN: sbi, hdfc_bank, icici_bank, axis_bank, kotak_mahindra_bank). Migrations `0197` to `0252` on `main` all show their visible objects present on DEV.

**Classification of 0236 on DEV: ALREADY APPLIED. Visible parts are an exact match; the invisible parts are proven by the PO's file 01.**

| What | Result on DEV |
|---|---|
| 11 new columns (5 on `fdh_statement_uploads`, 5 on `ii_source_documents`, 1 on `aie_document_intake`) | all 11 present, correct types (uuid, text, jsonb) |
| Foreign keys (3 new) | all point to `household_members` / `business_entities` |
| Column comments (5) | **word for word identical** to the migration |
| Function `owner_before_upload_allocation_ok` | present; 8 of 8 behaviour calls correct (6000+4000 accepted; 9999, 10001, one owner, duplicate owner, zero share, negative share, fractional share refused) |
| 13 constraints, 2 triggers, row security, indexes | **not visible through PostgREST.** Verified by `01_schema_inventory_BEFORE.sql` (PO paste). Classification stays "not yet proven exact" until that grid is back. |
| Backfill | **not run**: 3 of the 4 CAS documents and all 6 bank documents have NULL owner source |
| Evidence the app already used it | one CAS document created 05-10-2026 has `owner_role = self`, source `user_selected` (the new upload form worked on DEV) |

Row counts on DEV (read only): bank statement uploads 6, CAS source documents 4, accounts (`ii_accounts`) 21, `fdh_financial_accounts` 0, `ii_ownership_allocation` 0, `business_entities` 0, `aie_document_intake` 0, `household_members` 129, `user_profiles` 436. Note `business_entities` is empty on DEV: any Company, Trust or HUF step needs a synthetic entity created for the test user, and "only where valid entities already exist for the user" (step 15) will be satisfied by creating one per synthetic user.

Because 0236 is already on DEV, step 6's "apply once" is not possible. The spec's intent (no error, no duplicate object, no semantic change on re-apply) is covered by running the migration twice more and comparing the fingerprint of file 01 with file 03.

## 4. Step 5: constraint-count discrepancy (documentation reconciliation)

Read from `supabase/migrations/0236_owner_before_upload_phase1.sql` on `origin/main` (section D plus section F). **Authoritative count: 13.** Where the older document says 11, that was the Phase 1 count (before the AIE intake constraint and the FDH `owner_allocation` constraint were added); `OWNER_BEFORE_UPLOAD_PHASE1_REPORT.md` already says "11 at Phase 1, 13 now". `OWNER_BEFORE_UPLOAD_FINAL_REPORT.md` already says 13. The 06-10-2026 status is correct. No schema change was made to reach a count.

| # | Constraint name | Table | Purpose |
|---|---|---|---|
| 1 | `chk_fdh_uploads_owner_role_0236` | `fdh_statement_uploads` | owner_role is NULL or one of self, spouse, joint, child, family_trust, company, smsf, other |
| 2 | `chk_fdh_uploads_owner_source_0236` | `fdh_statement_uploads` | owner_selection_source is NULL or user_selected, backfill_from_account, backfill_from_document, legacy_unset |
| 3 | `chk_fdh_uploads_owner_one_kind_0236` | `fdh_statement_uploads` | at most one of member id / entity id (a document is never both) |
| 4 | `chk_fdh_uploads_owner_entity_role_0236` | `fdh_statement_uploads` | an entity id requires role family_trust, company or other |
| 5 | `chk_fdh_uploads_owner_chosen_has_role_0236` | `fdh_statement_uploads` | a user-selected owner must carry a role |
| 6 | `chk_fdh_uploads_owner_joint_alloc_0236` | `fdh_statement_uploads` | any stored split is valid: array of 2 or more distinct owners, whole-number basis points 1 to 10000, total exactly 10000 |
| 7 | `chk_ii_source_documents_owner_role_0236` | `ii_source_documents` | same role list as 1 |
| 8 | `chk_ii_source_documents_owner_source_0236` | `ii_source_documents` | same source list as 2 |
| 9 | `chk_ii_source_documents_owner_one_kind_0236` | `ii_source_documents` | same as 3 |
| 10 | `chk_ii_source_documents_owner_entity_role_0236` | `ii_source_documents` | same as 4 |
| 11 | `chk_ii_source_documents_owner_chosen_has_role_0236` | `ii_source_documents` | same as 5 |
| 12 | `chk_ii_source_documents_owner_joint_alloc_0236` | `ii_source_documents` | as 6, and additionally a user-selected joint document must carry a split |
| 13 | `chk_aie_intake_owner_selection_object_0236` | `aie_document_intake` | owner_selection is NULL or a JSON object |

Plus 2 triggers (`trg_fdh_statement_uploads_owner_0236`, `trg_ii_source_documents_owner_0236`, cross-tenant guard through `owner_before_upload_assert_owner`, security definer, not callable by anon or authenticated) and 2 functions. 6 + 6 + 1 = 13.

## 5. PO hand-over (the stop point)

Folder: `docs/ownership/po_apply_0236_dev/` (README in plain language, numbered steps, expected results, what to paste back).

| File | Kind |
|---|---|
| `01_schema_inventory_BEFORE.sql`, `03_schema_inventory_AFTER.sql` | read only, same query; ends in a FINGERPRINT row |
| `02_apply_0236_owner_before_upload_phase1.sql` | the migration, byte-identical to `main` (run twice) |
| `04_preview_counts_readonly.sql`, `08_preview_counts_readonly_AGAIN.sql` | read only; the six preview numbers as one visible grid |
| `05_backfill_PREVIEW_as_shipped_ROLLBACK.sql`, `09_...AGAIN...` | the shipped backfill, byte-identical, ends in ROLLBACK |
| `06_backfill_COMMIT.sql` | identical to 05 except the last statement is commit |
| `07_state_after_backfill_readonly.sql` | read only; owner state of every document |
| `10_cron_sweep_jobs_state_readonly.sql` | optional read only; which sweep jobs are scheduled on DEV |

Why separate read-only count files: the editor shows only the last result of a pasted file, and the shipped backfill ends in ROLLBACK, so its own preview is invisible there. The shipped file is still delivered unchanged and is what proves "persists nothing".

**Predicted preview on DEV (read by Claude today):** bank documents total 6, will copy 0, will be marked legacy_unset 6; CAS total 4, will copy 2 (both already have a real household member of relationship Self), will be marked legacy_unset 1; the 05-10-2026 user-selected document is excluded. After the commit: no unbackfilled row, every will-line 0.

PGlite proof of the pack: `scripts/owner_before_upload_0236_handover_pack_pglite_verification.mjs`, **35 checks, 0 failed**, with named controls (fingerprint changes when a constraint or a trigger is dropped, or a column type is altered, and returns on re-apply; the preview is not a constant; no document with no owner becomes Self; the user-selected row is byte-unchanged; a second commit run changes nothing). `tests/unit/ownerBeforeUploadHandoverPackSafety.test.ts` (10 tests): byte identity of the shipped copies, COMMIT copy differs only in the last statement, editor-hazard lint on the new read-only files with a control that proves the lint bites. The existing 55-check PGlite proof of the migration itself still passes.

### What I need from the PO

1. Run the steps in the README (about 10 pastes) on DEV `vqycarelcoijzwlpkpcz`, and paste back the grids of 01, 03, 04, 07, 08 (and 10) plus any red error text.
2. Nothing else for steps 6 to 9. After the paste I verify DEV rows myself, read only.

### PO actions that will be needed later (listed now so none is a surprise)

- Step 22 (bank account picker with a real PDF): the spec asks for a **real supported synthetic PDF**. I will generate synthetic bank PDFs from the repository's own fixture generators. If the generated ones are not accepted by a certified adapter and the PO wants real bank layouts tested, the PO must supply a real statement.
- Step 34 (screen reader): not certifiable without a real screen reader; keyboard, focus, reload, narrow width will be done in a DEV browser. Formal screen-reader certification is out of scope unless the PO does it.
- Anything that needs the PO's own signed-in browser session: none identified so far. All steps use synthetic fixture users (`scripts/canonical_cert`).

## 6. Step 29: AIE malware scheduler baseline

`aie1MalwareScanSweepSchedulerPglite.test.ts` failed 3 of 4 tests on `main` (reproduced today, before any change).

| Expected scheduler state | Migration history | Actual state | Correct action |
|---|---|---|---|
| The test expected, after the full chain, the 4 jobs `lr1-document-purge-sweep`, `aie1-document-purge-sweep`, `fdh3-malware-scan-sweep`, `aie1-malware-scan-sweep` to exist | `0135`, `0149`, `0174` register them with a placeholder URL. `0228` (PO review 01-10-2026) re-schedules them with the real production URL **only on a database that carries a `platform_deployment_environment = production` row**. `0229` (PO decision 01-10-2026) unschedules all four on a database that does **not** carry that row, and refuses to touch a database that does. | Full chain on a fresh or DEV-like database: 0 jobs (proved in PGlite). Full chain with the production marker: 4 jobs, all on the production URL, none removed by 0229 (proved in PGlite, also by the older `scripts/db-rebuild-check/verify_0228_0229_guard.mjs`, re-run, passes). | **Stale test, not a regression.** 0229 deliberately superseded the scheduler on DEV. Test updated: 0174's registration is proven on the chain before 0228, and the end state is asserted for both cases with the production case as the negative control (the DEV zero is the guard's doing). Security meaning: production keeps its sweeps behind the marker row; DEV never points at the production URL. |

Not verified: the actual `cron.job` content on DEV and on production (PostgREST cannot read it). File 10 of the hand-over lets the PO check DEV (expected: no rows). Production was not read. Before any future production upload activation, the production sweep jobs must be confirmed running (a PO or operator check, outside this mission).

## 7. Step 30: institution identity

State on `main`: design plus the narrow deterministic slice are in code (institution derived from the certified adapter code, looked up in the master by country and code, never free text; two banks with the same last digits stay two accounts; legacy accounts are never rewritten; only trailing 3 to 6 digits read or stored). The Expenses import panel still sends no canonical `institution_id` (confirmed: no `institution_id` or `institutionId` reference in `components/`). The DEV master holds all 10 adapter codes, so resolution will work live. **Statement for the final report: `INSTITUTION_ID — NOT YET COMPLETE FOR GENERAL PRODUCTION BANK INGESTION`**, a non-blocking production-activation prerequisite for the DEV verdict, provided steps 19 to 24 show deterministic and safe assignment with no duplication and last-digit privacy.

## 8. Regression on the merged tree (no schema needed)

All on the merged tree `origin/main` `b105cf4` (plus the repairs below). Label: **unit-tested / PGlite-verified only**.

**Targeted owner suites** (13 owner-before-upload and AIE owner files + `bankAccountAssignment`): 14 files, 315 tests, all pass. The repository-wide guard `ownerBeforeUploadScripts.test.ts` (no script may post to an owner-required route without naming an owner) passes inside the full run. PGlite proofs: migration 0236 (55 checks) and the new hand-over pack (35 checks), 0 failed.

**Full Vitest run, first pass** (`--testTimeout=90000`): 676 files, 649 passed, 26 failed, 1 skipped; 12,061 tests, 11,990 passed, 41 failed. Every failure was then re-run in isolation and against a clean detached `origin/main` for baseline proof:

| Failure | Cause | Baseline on `origin/main` | Action |
|---|---|---|---|
| 13 `benchmarkData*` files, `factsheetReaderAdminRoutes`, `schemeMappingProposals`, `resourcesDiscoveryR1_6LiveDev` (file-level) | `EPERM` opening a temporary vitest cache file under the Windows temp folder when the whole suite runs in parallel | pass in isolation (19 files, 966 tests green) | environment, none |
| `uploadFieldDispositionRegistry` (3) and `...AntiVacuity` (14) | **genuine defect of this programme**: the five 0236 columns on `fdh_statement_uploads` (`owner_member_id`, `owner_business_entity_id`, `owner_role`, `owner_selection_source`, `owner_allocation`) had no field disposition (R1 orphan, R7 strict) | failed on `main` | **fixed** (`3c7a167`): five D_METADATA entries, floor 67 to 72, registry doc regenerated; 28 tests green |
| `g2AmountColumnAlignment` (1) | **genuine defect of the owner-edit work**: `OwnerBreakupTable.tsx` printed each joint owner's amount in the left-aligned label cell | failed on `main` | **fixed** (`5f5c130`): the attribution moves into the right-aligned Value cell; `iiOwnerClassUi` 18 tests still green |
| `statementResumeListAndApplyOnce` (1) | stale test of the removed ownerless contract: it posted a retirement upload with no owner and now gets 422 `owner_required` | failed on `main` | **fixed** (`5f5c130`): the test names the user's own Self member and a control proves a missing owner is refused |
| `adminAnalyticsPhaseAMeRoute` (17) | admin `/api/admin/me` role resolution test out of step with later admin capability work | failed on `main` | not owner-before-upload; recorded |
| `aiResidualClosureFailClosed` (1, control A4) | AI context certification gate negative control | failed on `main` | not owner-before-upload; recorded |
| `countryGateAccessMatrix` (1) | an admin account-deletion route exists under `app/api/admin/` while the test says none does | failed on `main` | not owner-before-upload; recorded |
| `lr1UploadSecurityRawFileLifecycle` (1) | `console.error` added to `lib/financial-data-hub/services/purge.ts` by the AI-fallback confirm purge change | failed on `main` | not owner-before-upload; recorded |
| `m12cServerOnlySecretBoundary` (1) | `ENVIRONMENT_VARIABLES.md` forward list differs from `amplify.yml` | failed on `main` | not owner-before-upload; recorded |
| `resourcesP0ContentR1_7C` (file) | needs the untracked content file `D:\FHIP\content\consolidated\p0-content-normalized.json` | fails at import on `main` | environment |
| `resourcesR1_1` (1) | live-DEV-backed test, times out at 5 s under load | passed on the `main` baseline run, failed once here, so intermittent | environment |
| `aie1MalwareScanSweepSchedulerPglite` | see section 6 | failed on `main` in the earlier 06-10 run | **fixed** (`767c513`) |

After the repairs the remaining known failures on this branch are exactly the six not-owner-related rows above (23 tests) plus the two environment rows. A final full run follows the live certification, because more repairs may land first.

**tsc `--noEmit`** (8 GB heap; the default heap runs out of memory): one error, `tests/unit/canonicalCertResidueAllSql.test.ts(127,75)`, identical on `main` and already recorded on 02-10-2026. **ESLint** on `lib app components tests scripts/canonical_cert` plus the new script: 30 errors in 12 untouched files (`no-explicit-any`, `react-hooks` setState-in-effect, an `<a>` to `/goals/`, unescaped quotes); none in a file this work touched.

**Production build: NOT DONE, honest status.** `next build --webpack` (the only bundler that starts with a junctioned `node_modules`) compiled, then stopped in Next's own type validation: `app/api/admin/recommendations/gaps/route.ts` exports a non-route constant (`GAP_REVIEW_UNAVAILABLE_CODE`). That file is on `main` since 03-09-2026 and untouched here. Amplify's real build uses Turbopack, which logs "Skipping validation of types" (`_amplify_size_build_base.log`, EXIT=0 on 01-10-2026). So this is a baseline observation about the webpack path, not an owner-before-upload failure, and it is **not** evidence that the production build passes. A Turbopack build needs a real `node_modules` in the worktree (8.7 minutes in the earlier log); it will be run at the end of the mission.

## 9. What remains (all steps needing the schema or DEV browser)

Steps 6 to 28, 31 to 34 (live), 36 (residue), 37 and 38 (final documents and verdict) wait for the PO's paste. Honest status today: **DEV CERTIFIED: NO.** Production code deployed: not confirmed (main is on origin; no deployment evidence seen). Production DB: unknown, not read. Production upload: OFF, `isFdhDocumentUploadEnabled()` untouched.

## 10. Commits (branch `fix/owner-before-upload-dev-cert-20261006`, not pushed)

| SHA | Content |
|---|---|
| `767c513` | hand-over pack, DEV probe, PGlite pack proof, pack safety test, stale scheduler test updated (a test fix, with a named negative control) |
| `3c7a167` | register the five 0236 owner columns of `fdh_statement_uploads` in the field-disposition registry (tests failing on `main` now pass) |
| `5f5c130` | G2 right alignment of joint owner amounts in `OwnerBreakupTable`; stale retirement-upload test names an owner, with a refusal control |
| (this file) | `DEV_CERT_CHECKPOINT_1.md` committed after the hand-over note below |
