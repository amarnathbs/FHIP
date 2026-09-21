# LR Missing / Regressed / Incomplete Requirements Register

**Audit date:** 2026-09-14 · **Baseline:** `origin/main` @ `ff35f54`
Severity per Section 35. "Live-proven" means reproduced today against a real database or the real production application.

Evidence script paths are relative to the repository root.

---

## P0 — BLOCKING, LIVE IN PRODUCTION

### P0-1 — An SMSF property loan is subtracted from Net Worth twice

**Classification:** REGRESSED AFTER PRIOR CERTIFICATION
**Original requirement:** §7.1 — "SMSF liabilities are not double-subtracted." LR-5/LR-6 certified this.
**Evidence:** `scripts/audit-lr/oracle2_smsf_networth_double_subtraction.ts` (live DEV, real engines)

Ground truth: an SMSF holding one property worth $500,000, financed by a $365,000 limited-recourse loan, nothing else. Correct Net Worth = **$135,000**.

| Stage | `totalRetirement` | `totalLiabilities` | Reported Net Worth | Error |
|---|---|---|---|---|
| Summary mode, net balance entered | 135,000 | 365,000 | **−230,000** | −365,000 |
| Detailed mode (system-computed) | 135,000 | 365,000 | **−230,000** | −365,000 |

**Mechanism.** `supabase/migrations/0084_geo_jurisdiction_smsf.sql:358-362`:
```sql
create or replace function smsf_compute_detailed_net_value(p_fund_id uuid) returns numeric as $$
begin
  return smsf_holdings_total_aud(p_fund_id) - smsf_linked_loans_total_aud(p_fund_id);
end;
```
That **net** figure is written to `retirement_accounts.current_balance` (`0084:389-392`), which `lib/engines/dashboard.ts:775` sums into `totalRetirement`. The same loan row is then summed into `totalLiabilities` at `dashboard.ts:776` and subtracted again at `dashboard.ts:781`:
```ts
const netWorth = totalAssets + totalInvestments + totalRetirement - totalLiabilities + businessEntityOwnershipValue;
```

The architecture **requires** the loan to exist as a `liabilities` row — `smsf_linked_loans_total_aud()` joins `property_liability_links → liabilities` — so the double subtraction is structural, not a data-entry mistake. In Detailed mode the user has no choice at all: the system computes the net figure itself.

`0084`'s own column comment asserts the opposite while describing exactly the two subtractions:
> `summary_balance` is "Net-SMSF-value (fund net assets) … The loan liability itself still appears once in totalLiabilities via its own liabilities row".

**Production exposure:** 2 active `property_liability_links` rows of `link_type='smsf_property_loan'`; 1 SMSF fund in Detailed mode.

**Remediation (PO decision required — two valid, opposite fixes):**
- **(a)** Exclude SMSF-linked liabilities from Net Worth's `totalLiabilities` (they are already netted inside the fund's valuation). Keeps the fund figure canonical; changes what `totalLiabilities` means.
- **(b)** Make the fund valuation **gross** (holdings only) and let the single `liabilities` row do the subtracting. Keeps `totalLiabilities` meaning what it says; changes `smsf_compute_detailed_net_value()` and the Summary-mode semantics the UI teaches.

Either way, re-run `oracle2` and require Net Worth = $135,000 in **both** modes.

---

### P0-2 — Migration `0137` broke the SMSF Detailed Holdings workspace

**Classification:** REGRESSED AFTER PRIOR CERTIFICATION
**Original requirement:** LR-5 — a usable SMSF Detailed Holdings workspace.
**Evidence:** `scripts/audit-lr/oracle5_smsf_0137_regression.ts` (live DEV)

Once a fund is in Detailed mode:

| Action | Result |
|---|---|
| Add a holding | `42501` — raw DB error |
| Edit a holding's value | `42501` |
| Remove (deactivate) a holding | `42501` |

**Mechanism.** `0090_smsf_current_balance_integrity_guard.sql:152-157` wraps the write:
```sql
perform set_config('fhip.smsf_balance_write', 'certified', true);
update retirement_accounts set current_balance = v_net, updated_at = now()
where id = v_retirement_account_id;
perform set_config('fhip.smsf_balance_write', '', true);
```
`0137_smsf_recompute_security_definer_cascade_fix.sql:66-69` re-declares the same function **from `0084`'s body** and the bracket is gone:
```sql
if v_mode = 'detailed' then
  update retirement_accounts set current_balance = v_net, updated_at = now()
  where id = v_retirement_account_id;
end if;
```
`retirement_accounts_smsf_balance_guard()` (`0090:83-118`, trigger still installed) raises `42501` unless that GUC reads `'certified'`. It fires only on a real change, which is why a no-op recompute still succeeds and masked the regression.

`0137`'s own header (`:42-43`) states "No change to any function's logic/body." That is false with respect to `0090`.

**Production exposure:** `0137` is applied to production. The one production SMSF fund is `mode='detailed'` with 3 holdings — confirmed by `scripts/audit-lr/a13_prod_smsf_state.mjs`.

**Remediation:** a new migration re-declaring `smsf_recompute_fund()` with **both** `0137`'s `security definer`/`set search_path` **and** `0090`'s `set_config` bracket. Then re-run `oracle5` (A/B/C must all succeed) and re-run the `0137` account-deletion reproduction to confirm the cascade fix still holds.

Also note, same family, not yet a live defect: `trg_smsf_funds_sync_summary_balance()` was not re-declared by `0137` and still lacks `security definer` while writing to `retirement_accounts`. It fires only on insert/update today.

---

## P1 — MUST FIX BEFORE ANY PRODUCTION CERTIFICATION

### P1-1 — Migration `0136` (LR-11B Family Trust) was never applied to production

**Classification:** APPLICATION CODE DEPLOYED — DATABASE MISSING
**Evidence:** `scripts/audit-lr/a09_migration_reconciliation.mjs`, `a10_family_trust_prod_confirm.mjs` (non-committing constraint probes against both databases)

| `entity_type` | DEV | PROD |
|---|---|---|
| `company` | CHECK passes (`23503` on the fake-user FK only) | CHECK passes |
| `family_trust` | CHECK passes | **`23514` — CHECK REJECTS** |
| `nonsense_type` | `23514` | `23514` |

Nothing was written: every probe row referenced a nonexistent user, and a follow-up query confirmed zero rows.

The deployed UI offers the option — `app/(app)/companies/page.tsx:164-173` renders `<option value="family_trust">Family Trust</option>` — and `lib/validation/businessEntity.ts:17` accepts it. A production user selecting Family Trust and pressing Create hits a database CHECK violation.

This is the **exact failure class Section 30 warns about, inverted**: last time the DB and a branch had it and `main` did not; this time `main` and production have the code and the production database does not.

**Remediation:** apply `supabase/migrations/0136_lr13_family_trust_entity_type.sql` to production, then re-run `a10`.

---

### P1-2 — LR-10 payments are entirely non-functional in production

**Classification:** APPLICATION CODE DEPLOYED — CONFIGURATION MISSING
**Evidence:** `scripts/audit-lr/a11_prod_payment_runtime_config.mjs` (live, unauthenticated, non-mutating)

```
POST https://app.financialhealthplatform.com/api/payments/stripe/webhook    -> 503 "Stripe not configured"
POST https://app.financialhealthplatform.com/api/payments/razorpay/webhook  -> 503 "Razorpay not configured"
```

Both routes fail closed *before* signature verification, which is the correct fail-closed behaviour — and is also proof that neither `STRIPE_WEBHOOK_SECRET` nor `RAZORPAY_WEBHOOK_SECRET` exists at runtime.

Root cause, `amplify.yml:46`:
```
- env | grep -e SUPABASE_SERVICE_ROLE_KEY -e CRON_SECRET -e APP_BASE_URL -e RESEND_API_KEY -e CONTACT_FROM_EMAIL -e G4_APP_CAPABILITY_LAYER_ENABLED -e G5B_GENERIC_WRITE_ENABLED -e G2_LANDING_LOCALISATION_ENABLED -e G2_ALLOW_TEST_DETECTION_HEADER -e ROLLOUT_ >> .env.production
```
No `STRIPE_`, no `RAZORPAY_`. Per that file's own header, server-only variables set in the Amplify console are `undefined` at runtime unless listed here. This is **the identical defect class the G8 closure found and fixed for G4/G5B** on 2026-09-13 — the fix was applied to those variables and not to these.

Corroboration from the production database: `payment_webhook_events` = 0 rows, all 7 `user_entitlements` are `plan_tier='free'` with `provider = NULL`. No payment has ever been processed in production.

**Remediation:** add `-e STRIPE_ -e RAZORPAY_` to the grep list, redeploy, re-run `a11` and require 400 "Missing signature" instead of 503.

---

### P1-3 — The Investment Intelligence upload route bypasses the production document-upload gate

**Classification:** IMPLEMENTED DIFFERENTLY — NO PO AUTHORIZATION FOUND (security-relevant)
**Evidence:** `scripts/audit-lr/a08_ii_upload_gate_bypass.mjs`; `a02_schema_drift.mjs`; source inspection

`app/api/investment-intelligence/source-documents/route.ts:24` accepts `multipart/form-data`, requires only `requireCountryConfirmedUser()`, and never calls `isFdhDocumentUploadEnabled()` or any equivalent. Nor does `app/api/investment-intelligence/source-documents/[id]/process/route.ts`, which downloads the stored bytes back and feeds them to `pdf-parse`/pdf.js with `maxDuration = 300`.

Every FDH upload surface (10 routes) checks the gate before touching bytes. This one does not. Repo-wide grep for the gate across `app/api/investment-intelligence/**` returns nothing.

Live production state:

| Fact | Value |
|---|---|
| `investment-source-documents` bucket in production | **present** (the only bucket that is) |
| `ii_source_documents` rows in production | **3** |
| `ii_document_parse_runs` in production | 34 |
| `ii_transactions` in production | 952 |
| Production route reachability | `POST /api/investment-intelligence/source-documents` → 401 (exists, auth-protected) |

Three compounding weaknesses on this one live path:

1. **No malware scanning anywhere in the codebase.** `'malware_detected'` exists as an enum constant in `lib/financial-data-hub/constants/enums.ts:250` and in two CHECK constraints; grep for `error_code: 'malware` returns zero assignments. The repo's own documents say so: `docs/financial-data-hub/FDH3_SECURITY_THREAT_MODEL.md:12`, `FDH11_COMPLETION_REPORT.md:208`.
2. **Weaker validation than FDH.** `lib/services/investment-intelligence/storage.ts:21-43` checks filename extension, the browser-declared MIME type and size — all client-supplied. FDH's `detectFileTypeFromBytes` magic-byte check has no equivalent here.
3. **No retention or purge.** The LR-1 janitor operates only on `fdh_statement_uploads` (`lib/financial-data-hub/services/purge.ts:180-189`). `deleteSourceDocumentObject()` (`storage.ts:80`) has **zero callers**. `ii_source_documents` has no purge status and no retention column. Raw uploaded PDFs are retained indefinitely, removed only by full account deletion.

**Consequence for the programme's own claims:** `docs/financial-data-hub/FDH14_RESIDUAL_RISK_REGISTER.md:10` and `FDH16_RESIDUAL_RISK_REGISTER.md:176` accept the missing scanner as "P2 (bounded — production uploads structurally disabled regardless)". That premise is false, so the risk acceptance does not hold.

**Remediation options (PO decision):** gate the route like every sibling; or consciously accept it as the one live ingestion path and (i) add magic-byte validation, (ii) extend the purge janitor to `ii_source_documents`, (iii) correct both residual-risk registers.

---

### P1-4 — The Financial Twin reports different household figures from the Dashboard

**Classification:** PARTIALLY IMPLEMENTED (LR-FI-1/LR-FI-2 fix never propagated)
**Evidence:** `scripts/audit-lr/oracle3_twin_vs_dashboard.ts` (live DEV, both loaders, same user, same instant)

**T1 — the PO's own oracle scenario** (income $10,000/mo; personal debt service $1,000/mo; SMSF property loan $2,000/mo linked via `property_liability_links`, not owner-tagged):

| Metric | Dashboard | Financial Twin |
|---|---|---|
| `debtServiceRatio` | **0.10** | **0.30** |
| `debtMonthlyRepayments` | 1,000 | 3,000 |
| `debtToIncome` | 0.167 | **3.208** |
| `householdLiabilityBalance` | 20,000 | 385,000 |
| `monthlySurplus` | 9,000 | 7,000 |

**T2 — a 50%-owned company with $400k assets and $100k liabilities:**

| Metric | Dashboard | Financial Twin |
|---|---|---|
| `netWorth` | 250,000 | **100,000** |
| `totalAssetsCombined` | 250,000 | **100,000** |

`lib/services/twinData.ts:255-289` re-implements the dashboard load and omits three things `lib/services/dashboardData.ts` does: it never fetches `property_liability_links` (and does not even select `liabilities.id`, so it structurally cannot apply the override), never passes `businessEntities` into `computeDashboard`, and does not use `fetchAllRows()` paging. Its own comment at `:260-261` claims "the Twin must never see a different household cash-flow figure from the Dashboard."

The LR-12R fix that produced the 30%→10% correction was applied to `dashboardData.ts` only.

**Remediation:** have `twinData.ts` call `loadDashboard()` rather than maintain a second loader. Then re-run `oracle3` and require MATCH on every row.

---

### P1-5 — Premium report PDF export is bypassable by a free user

**Classification:** PARTIALLY IMPLEMENTED (entitlement gate incomplete)
**Evidence:** source, deterministic

`lib/engines/reportExport.ts`:
```ts
export function isExportFormatImplemented(format: ExportFormat): boolean {
  return format === 'print' || format === 'pdf';
}
export function requiresPremiumEntitlement(format: ExportFormat): boolean {
  return format !== 'print';
}
```
`app/api/reports/[id]/exports/route.ts`:
```
:32  if (requiresPremiumEntitlement(format) && !(await canExportReports(...))) return bad(..., 403);
:43  const isImplemented = isExportFormatImplemented(format);
:63  if (!isImplemented) return ok(exportRow);
:66  const { buffer, checksum } = await renderReportToPdf(id, exportRow.id);
:69-71  admin.storage.from('report-exports').upload(storagePath, buffer, ...)
:74-84  status: 'ready', storage_path, checksum, ...
```
After line 43 the route never branches on format again. `format:'print'` skips the entitlement check at :32 and still reaches the renderer at :66, producing a stored, `status:'ready'` PDF. `app/api/report-exports/[exportId]/download/route.ts` then requires only ownership.

`tests/unit/reports.test.ts:78-80` asserts `requiresPremiumEntitlement('print') === false`, so the exemption is intentional for *browser* print — nobody noticed it also drives the server-side renderer.

Live end-to-end execution was attempted but blocked by a local dev-server module-resolution failure on this route (see the Final Report §6); the finding rests on three unambiguous lines of source.

**Remediation (PO decision on meaning):** either make `isExportFormatImplemented` return true only for `'pdf'`, or gate the renderer explicitly (`if (format !== 'pdf') return ok(exportRow)`). Then attempt the bypass as a free user and require 403 or a no-artifact response.

---

### P1-6 — The Consolidated Forecasting Report PDF export renders the login page

**Classification:** PARTIALLY IMPLEMENTED (premium feature non-functional)
**Evidence:** `scripts/audit-lr/a14_print_route_waiver.mjs`, `a15_print_waiver_local_vs_prod.mjs` (live, both environments)

`proxy.ts:107`:
```ts
const isTokenAuthorizedPrintRoute = /^\/reports\/[^/]+\/print$/.test(pathname) && request.nextUrl.searchParams.has('token');
```
`proxy.ts:62` includes `forecast` in `isAppRoute`, so `/forecast/report/print` is session-gated and **not** waived.

`lib/services/forecastReportPdfRenderer.ts:31-35` drives a session-less headless Chromium to exactly that URL:
```ts
const url = `${BASE_URL}/forecast/report/print?${params.toString()}`;
const response = await page.goto(url, { waitUntil: 'networkidle' });
if (!response || !response.ok()) throw new Error(...);
```
Playwright follows the 307 to `/login`, which returns 200, so `response.ok()` is **true** and nothing throws. The PDF is produced from the login page and returned to the user with HTTP 200 as `consolidated-forecast-report-*.pdf`.

**Live proof, both environments:**

| Request (unauthenticated) | Local (current `origin/main`) | Production |
|---|---|---|
| `/reports/{id}/print?token=…` | route reached (page-level 404/redirect) | route reached — **307 with a 13 KB body**, i.e. the page's own `redirect('/login')` at `app/(print)/reports/[id]/print/page.tsx:29`, so the waiver works |
| `/forecast/report/print?token=…` | **307 → /login, 6-byte body** (proxy-level redirect) | **307 → /login, 6-byte body** |

The body-size difference is what distinguishes the two: a proxy-level `NextResponse.redirect` returns an empty body; a page-level `redirect()` returns a rendered redirect document.

`tests/unit/forecastReportExportEntitlement.test.ts:24` mocks the renderer out entirely, so the suite proves the 403 path and nothing about the 200 path.

**Remediation:** widen the waiver, e.g. `/^\/(reports\/[^/]+|forecast\/report)\/print$/`. Then re-run `a15` and require the forecast row to reach the route.

Related, same area: the report render token is not consumed on read (`lib/services/reportsData.ts:407-423` is a plain SELECT) despite `reportPdfRenderer.ts:15-17` claiming single use, and it travels in a query string, so it reaches access logs and `Referer` headers. Tracked as P2-12.

---

### P1-7 — The Expenses bank-statement import journey dead-ends; the entire bank-adapter estate is unreachable

**Classification:** BACKEND EXISTS — NO USER ENTRY POINT
**Evidence:** source trace; `scripts/audit-lr/journey1_reports_and_premium.ts` (gate confirmed open in DEV)

`components/expenses/BankStatementImportPanel.tsx` makes exactly two calls (`:87`, `:102`): create an upload session, then complete it. `completeUpload()` (`lib/financial-data-hub/services/uploadLifecycle.ts:294-318`) sets `processing_status: 'queued'`, writes an `fdh_ingestion_jobs` row, and states in its own comment:

> "Processing-QUEUE HANDOFF (spec section 50) — the interface a future FDH-4/5 parser worker will consume. **No worker is implemented in FDH-3**; this only creates the job record."

No worker exists anywhere. `processBankCsvDocument` / `processBankPdfDocument` are called only from `app/api/financial-data-hub/bank-csv/[documentId]/process` and `bank-pdf/[documentId]/process`, and **no component anywhere calls those routes** — grep for `bank-csv|bank-pdf` across `components/**/*.tsx` and `app/(app)/**/*.tsx` returns zero matches.

Meanwhile the panel tells the user, at `:212-214`:
> "Uploaded. Your transactions are being extracted for review."

and links to a Review workspace that will never receive anything from this path.

**Scope consequence:** all 10 named bank CSV adapters (CBA, Westpac, NAB, ANZ, Macquarie, SBI, HDFC, ICICI, Axis, Kotak) and all 8 PDF adapters are unreachable code.

**On LR-3's own certification — the certified journey and the user journey are different journeys.**

`docs/live-recovery/LR3_BANK_IMPORT_ORACLE_LIVE_DEV_E2E.md:14` states the oracle uploaded a real ANZ-format CSV "through `upload → detect → process → categorise → approve`". The **`process`** step is exactly the call the Expenses panel never makes. The oracle drove the API directly; the UI cannot. So LR-3's closure evidence is genuine — for a journey no user can take.

Two further traceability problems with that evidence:
1. **The script is not in the repository.** `LR3_BANK_IMPORT_ORACLE_LIVE_DEV_E2E.md:9` names `scripts/lr3_bank_import_oracle_live_dev_e2e.mjs` as the proof artefact; `ls scripts | grep -i lr3` returns nothing. The closure evidence for a phase cannot be re-run.
2. The same document discloses that early runs of that script **orphaned uploaded CSVs in the DEV `fdh-source-documents` bucket** and that the residue could not be identified afterwards — an honest disclosure, and a reminder that the bucket in question does not exist in production at all (P1-9).

What *is* correct: once transactions do reach `fdh_transactions` with `approval_status='approved'`, `lib/services/dashboardData.ts:200-224` reads them into the Dashboard's expense and income totals, and `expense_items.superseded_by_bank_import` (migration `0131`) prevents double counting. The bridge LR-3 built is real; nothing can reach it through the UI.

**Remediation:** have the panel call the appropriate `process` route after `complete` (or implement the queue worker), then run the PO's $500→$700 oracle through the panel's own calls.

---

### P1-8 — Account deletion can be permanently blocked by a bare `NO ACTION` foreign key

**Classification:** PARTIALLY IMPLEMENTED
**Evidence:** `scripts/audit-lr/oracle6_security_deletion_residue.ts` (live DEV)

With one `benchmark_sources` row whose `created_by` referenced the user:
```
deleteUser(A) -> FAILED
business_entities cascade: 1 row(s) remain (expect 0)
tombstone after delete: user_id still populated, status still 'pending'
```
With the same row absent, the identical deletion succeeds.

15 columns across the schema reference `auth.users(id)` with neither `CASCADE` nor `SET NULL`, so Postgres defaults to `NO ACTION`:

`admin_users.granted_by`; `benchmark_sources.created_by`/`.approved_by`; `benchmark_datasets.approved_by`; `benchmark_update_runs.audit_user`; `resource_user_roles.assigned_by`; `professional_notes.author_user_id` (NOT NULL); `ai_model_registry.created_by`/`.approved_by`; `ai_prompt_templates.approved_by`; `ai_evaluations.reviewer_id`; `ai_platform_controls.updated_by`; `ai_task_cost_limits.updated_by`; `ai_provider_controls.updated_by`; `ai_config_audit.changed_by`.

These are staff columns, so an ordinary customer is unlikely to trip one — but **any administrator is near-certain to**, and two are un-clearable: `benchmark_update_runs` is protected by an immutability trigger that raises on UPDATE *and* DELETE, and `ai_config_audit` likewise while `ai_config_audit_capture()` keeps manufacturing new `changed_by` references.

`lib/services/accountDeletionOrchestration.ts:72` calls `deleteUser()` with no pre-delete cleanup.

**Remediation:** convert the 14 nullable columns to `ON DELETE SET NULL`; decide `professional_notes.author_user_id` (NOT NULL) separately; add a pre-flight check so the queue reports *which* reference blocked the deletion rather than an opaque failure. Also add a path to return a `failed` request to `pending` — today `app/api/admin/account-deletions/[id]/execute/route.ts:24-32` claims only `pending` rows, so a failed deletion is terminal.

---

### P1-9 — Two of the three purged storage buckets do not exist in production

**Classification:** APPLICATION CODE DEPLOYED — INFRASTRUCTURE MISSING
**Evidence:** `scripts/audit-lr/a04_bucket_existence.mjs`, `a03_storage_purge_reality.mjs` (live, both environments)

```
PROD  GET /bucket/fdh-source-documents      -> 400 {"code":"NoSuchBucket"}
PROD  GET /bucket/report-exports            -> 400 {"code":"NoSuchBucket"}
PROD  GET /bucket/investment-source-documents -> 200
```

Two consequences:

1. **Report PDF export cannot succeed in production.** `app/api/reports/[id]/exports/route.ts:69-71` uploads to `report-exports`. Production has never had a single `report_exports` row, so this has never been observed — and would fail if it were, on top of P1-5 and P1-6.
2. **LR-9's storage purge is vacuously "clean" for two of three buckets.** Supabase Storage returns `200 []` when listing a prefix in a bucket that does not exist — verified today — so `purgeNestedUserPrefix('fdh-source-documents', …)` and `…('report-exports', …)` both return `{objectsFound: 0, error: null}`. The corrected abort-on-failure invariant in `accountDeletionOrchestration.ts:60-69` can therefore **never trip** for a missing bucket, and the admin queue would show a clean purge.

LR-9's own live-DEV end-to-end script seeds and verifies **only** `fdh-source-documents` — the bucket production does not have. It never touches `investment-source-documents`, the only bucket production does have, and therefore the only one whose purge actually matters there.

**Remediation:** create both buckets in production with the same configuration as DEV (or remove the code that assumes them), and extend the deletion e2e to seed and verify `investment-source-documents`.

---

## P2 — SIGNIFICANT

| ID | Finding | Evidence | Remediation |
|---|---|---|---|
| **P2-1** | `ii_analytics_results.user_id` (migration `0043:223`) has **no foreign key** to `auth.users`. Live-proven: after `deleteUser()` the row survives with a dangling `user_id` while a control `assets` row cascades away. Contradicts the Privacy page's deletion claim. | `oracle7_ii_analytics_residue.ts` | Add `references auth.users(id) on delete cascade`, backfill-delete orphans |
| **P2-2** | Insurance `cover_type` is never collected by the grid (`lib/grid/configs.ts:228-243`) and, uniquely among the registers, has no `master_item_key` fallback in the engine. Live-proven: a policy added from the "Income Protection" catalogue item with a 90-day waiting period yields `incomeProtectionWaitingPeriodDays = null`. Breaks `hasIncomeProtection` in Health Score, Resilience and the Twin. | `oracle8_insurance_and_janitor.ts` | Add a `MASTER_INSURANCE_ITEM_TO_COVER_TYPE` map with `master_item_key ?? cover_type` precedence at `dashboard.ts:1012,1030` and `metricDerivation.ts:201,210,217` |
| **P2-3** | SMSF-linked retirement contributions leak into household figures. `lib/engines/forecast/smsfContributionGuard.ts` is applied only in the retirement-forecast branch; `dashboard.ts:986-993` sums `personal_contribution`/`employer_contribution` with no filter, and those feed `retirementContributionRate` and the Net Worth forecast's `householdFundedMonthlyContribution`. Live-proven (F7). The guard's own header says it exists "before any future feature could populate them and silently leak" — that leak is live. | `oracle4_forecast_exactly_once.ts` | Apply the same guard in `dashboardData.ts`, or filter in `computeDashboard` |
| **P2-4** | Net Worth allocation does not reconcile. With a 50%-owned entity, `netWorthAllocation` sums to 100,000 while `totalAssetsCombined` is 250,000 — a 150,000 gap with no bucket. `businessEntityOwnershipValue` also has **zero UI consumers**. | `oracle3_twin_vs_dashboard.ts` | Add an allocation bucket and surface the figure |
| **P2-5** | Legacy `owner='company'`/`'family_trust'` is hidden client-side only (`FinancialDataGrid.tsx:281-289`). All seven validators still accept the full `OWNER_VALUES` enum, and `householdContext.ts:60-71` deliberately leaves those rows in personal cash flow — so they enter DTI/DSR while the entity workspace's own liabilities do not. Asymmetric double-count. | source | Enforce server-side, or finish the entity semantics LR-FI-1 §19 deferred |
| **P2-6** | Privacy copy vs behaviour. `app/(marketing)/privacy/page.tsx:66-84` describes uploading bank/payslip/super statements and a raw-file retention policy. In production those uploads are gated off, and the retention policy does not apply at all to the one live upload path (P1-3). Also: Facebook sign-in is still listed (`:56-61`) though it was removed 2026-08-11; "Last updated" is `new Date()` at render time; the page still carries "Draft — pending legal review". | source + live page capture (`scripts/audit-lr/_out_privacy.txt`) | Correct the copy to match reality, or change reality |
| **P2-7** | Webhook idempotency. `claimWebhookEvent` is a plain INSERT returning `ALREADY_PROCESSED` on any `23505`, so a `'failed'` event is permanently dropped on retry — contradicting the route comment at `stripe/webhook/route.ts:58-60`. Razorpay's fallback key `${event}:${sub.id}:${sub.status}` is identical for every `subscription.charged` with status `active`, so **renewals are silently swallowed** and `current_period_end` never refreshes. | source | Re-claim `failed` rows; use a payment/invoice id in the Razorpay fallback |
| **P2-8** | `confirm_billing_country` is granted directly to `authenticated` (`0122:622`) and enforces no subscription check, so the `ACTIVE_SUBSCRIPTION_BLOCKS_COUNTRY_CHANGE` guard in the route is bypassable via PostgREST. | source | Move the check into the RPC |
| **P2-9** | No entitlement period-end reconciliation. `current_period_end` is written and displayed but never enforced; downgrade depends entirely on receiving a webhook. Compounds P2-7. | source | Add a scheduled reconciliation |
| **P2-10** | Editing an Investment-Intelligence-published investment POSTs instead of PATCHing (`FinancialDataGrid.tsx:412`) and `registry.save`'s `source_type='manual'` filter misses the published row, creating a **second** row with the same `master_item_key` — double-counting the holding. | source | Disable Save for published rows, or reject the POST server-side |
| **P2-11** | No explicit `Cache-Control` on any report-content JSON route or either print view. Repo-wide only three routes set it. Personal financial documents rely on a framework default that no test pins, behind CloudFront. | source | Set `private, no-store` in `lib/api.ts`'s `ok()` |
| **P2-12** | The report render token is not consumed on read and travels in a query string, so it is replayable within its window and reaches access logs and `Referer` headers. `reportPdfRenderer.ts:15-17` claims single use. | source | Consume-on-read; pass via `setExtraHTTPHeaders` |
| **P2-13** | `/admin/account-deletions` appears in no admin nav group and `can_manage_account_deletions` is not among the five capabilities `app/api/admin/me/route.ts` returns — a holder who is not also a Super Admin sees no Admin menu at all. | source | Add the nav entry and the capability |
| **P2-14** | `business_entities`/`_assets`/`_liabilities` were created after migrations `0104`/`0105`/`0108` and never retrofitted with the `is_country_confirmed()` backstop, nor with `is_write_permitted()` (`0129`). Country confirmation for these tables is enforced at the API layer only. | source | Retrofit the DB backstop |
| **P2-15** | `/companies` is missing from `NAV_HREF_MODULE_MAP` (`lib/nav/appNavCapability.ts:23-55`), so `isNavHrefVisible` returns `true` unconditionally for it — the one nav item outside G4's fail-closed model. The completeness test that exists to catch this has the same omission hardcoded in its expectation, so it passes. | source | Add the mapping; derive the test expectation |
| **P2-16** | A `failed` deletion request is terminal: the execute route claims only `pending` rows, and no path returns `failed` → `pending`. The storage-abort message says "retry once the storage issue is resolved" — there is no retry. | source | Add a requeue path |
| **P2-17** | Storage purge uses `{ limit: 1000 }` with no cursor at `accountDeletionStorage.ts:44,78,93`. A user with more than 1000 objects (or folders) silently leaves residue and still reports `error: null`, which under the corrected invariant lets `deleteUser()` proceed. | source | Paginate |
| **P2-18** | **Five form controls on `/profile` have no programmatic label** — full name, phone, date of birth, employment status, and new email address have no `<label for>`, no wrapping `<label>`, no `aria-label` and no `aria-labelledby`. Measured from the live DOM. The page looks labelled and announces as blank. This is the page hosting LR-9's own account-closure panel. | `LR_CONSOLIDATED_ACCESSIBILITY_MOBILE_SWEEP_2026_09_14_AUDIT.md` | Add `htmlFor`/`id` pairs in `app/(app)/profile/page.tsx` |

---

## P3 — MINOR / HYGIENE

- Three of the four report types (`financial_health_score`, `goal_progress`, `net_worth`) produce byte-identical sections: `generateReport()` never passes `reportType` to `buildReportSections()`. Only `monthly_financial_health` is reachable from the UI.
- 13 of 15 report API route files have no caller, including the entire publish/revise/retry versioning lifecycle.
- The Reports hub advertises "Report exports (PDF, CSV)" while `isExportFormatImplemented('csv')` is permanently false.
- `app/(app)/financial-data-hub/page.tsx` (the upload screen) has no nav link and no in-app link — direct URL only.
- `report_exports.expires_at` is never written; the expiry branch and the `'expired'` status are permanently dead. Exported PDFs never expire.
- `report_exports.file_name` is written but never applied: the download route creates a signed URL without `{ download: fileName }`, so the browser names the file from the storage path (`{export_id}.pdf`). The 302 `Location` also carries the user's auth UUID in the path.
- `'printed'` and `'exported'` report access events are never emitted.
- 17 `financial-data-hub` routes return `parsed.error.issues[0].message`, which is Zod's default text when the rule has no custom message. No register route is affected; the 59-route sweep in `7cbfa15` did land, but `lib/api.ts:22-26` still says it was "applied so far only to Retirement".
- Blanking an already-saved optional **text/date** field silently retains the old value (the field is omitted rather than nulled); number fields write `0` instead.
- The auto-retry in `FinancialDataGrid.tsx:443-453` can double-insert a **new custom** row if a POST succeeds but the response is lost — no idempotency key.
- Migration `0135`'s committed file still contains the literal placeholder `'<REPLACE_WITH_REACHABLE_DEV_APP_ORIGIN>/api/...'` as the cron target URL.
- The production database exposes an RPC `r12_production_precheck` that DEV does not — a leftover from LR-12 certification. Cleanup item.
- `/disclaimer` and `/accessibility` are footer-linked but excluded from `robots.ts`'s allowlist and the sitemap, so they are deliberately non-indexable — which cuts against the Privacy page's own stated reasoning.
- No legal page is linked from inside the authenticated app; the only footer lives on `/`. Signup and login carry no Privacy or Terms link at all.
- No accessibility tooling exists: no axe, jest-axe, pa11y or Lighthouse in `package.json`. `axe-core` appears only as a transitive dependency of `eslint-plugin-jsx-a11y`. One hand-rolled Playwright tab/overflow smoke covers 5 FDH screens. **No screen-reader evidence exists.**
- Goals' create wizard omits the `one_off` contribution frequency that its own edit panel and validator both accept.
- `country_code` validators accept six countries while the UI offers two, and `currencyMatchesCountry` short-circuits to `true` for the four generic countries, so a direct API call can set `country_code:'GB'` with `currency_code:'INR'` unflagged.
- Entity archive UX: no un-archive path, single-click archive with no confirmation, "Archive company" label shown for Family Trusts, child line items hard-deleted.
- `/login` is reachable while already authenticated (no redirect to `/dashboard`), unlike `/onboarding` which `proxy.ts:126-128` does redirect.
- Mobile layout is clean: no horizontal overflow measured at 375 px on `/companies`, `/retirement`, `/reports` or `/profile`; one sub-24px touch target on `/retirement`.

---

## Baseline Failure Register (Section 38)

`npx tsc --noEmit` — **clean, exit 0.**

`npx vitest run` — 6,416 passed / 14 failed / 23 skipped across 306 files. **All 14 failures are `Error: Test timed out in 5000ms`** with a transform time of 568 s, on a filesystem Next.js itself flagged ("Slow filesystem detected. The benchmark took 17251ms"). They are environmental, not code failures: none is an assertion failure, and the affected tests (`g3RegistrationAlignment`, `paymentProviderActivation`, `paymentsCheckoutRoute`, `paymentWebhookRoutes`) are dynamic-import-heavy. A re-run with `--testTimeout=60000` was started to confirm; that result is recorded in `LR_FULL_REQUIREMENTS_RECONCILIATION.md`.

**No source file was modified by this audit**, so no regression could have been introduced by it.
