# AIE-1 final production completion: release register

- **Date of the work:** 24–25 September 2026. The file name keeps the 24 September date given in the brief.
- **Branch:** `feat/aie1-final-production-completion`, taken from `origin/main` (215148b, then merged with 713561d). It is pushed and **not merged**.
- **Mode:** supervised. Production was read-only (GET requests only). Engineering, DEV verification and branch pushes were done here. Every production write, merge, deploy, flag change and activation is listed as a proposed action below.
- **Verdict at this stage:** **DEV CONDITIONAL PASS.** The DEV journeys below passed live. Three migrations (0195–0197) are written and PGlite-verified but not yet applied to DEV, so the parts that depend on them are only unit- or PGlite-verified until the PO applies them and the post-migration re-runs are done. **There is no production verification, and general availability is not claimed.**

---

## 0. Evidence standard

| Tag | Meaning |
|---|---|
| **LIVE-DEV** | Ran over real HTTP against the app on this branch. The app pointed at DEV Supabase, the DEV S3 bucket with the DEV GuardDuty plan, and real OpenAI where stated. Ground truth was read back from the database with the service role. |
| **LIVE-PROD-READ** | A read-only GET against production (PostgREST, `storage/object/info`, AWS read APIs). |
| **PGLITE** | Full migration chain replayed in PGlite. The old behaviour was run first as a negative control that must fail. |
| **UNIT** | vitest only. |
| **NOT VERIFIED** | Stated as such. |

The live scripts are on the branch and can be re-run:

- `scripts/aie1_final_dev_server.mjs`
- `scripts/aie1_final_live_dev_journeys.ts`
- `scripts/aie1_final_cost_cap_live_dev_check.ts`
- `scripts/aie1_malware_column_forgery_live_dev_probe.mjs`
- `scripts/aie1_final_accessibility_live_dev.ts`
- `scripts/aie1_masking_synthetic_pii_probe.ts`
- `scripts/aie1_final_dev_cleanup.ts`
- `scripts/aie1_0195|0196|0197_pglite_verification.mjs`

Every DEV write asserts the host `vqycarelcoijzwlpkpcz.supabase.co`. Every production script refuses any method other than GET.

---

## 1. Production state, re-confirmed read-only on 25 Sep (LIVE-PROD-READ)

- **Amplify** (`d3iiacugdm5tup`, app-level, no branch overrides):
  - `AIE_DOCUMENT_INTAKE_ENABLED`, `AIE_AI_FALLBACK_ENABLED`, `AIE_II_ADAPTER_ENABLED` and `AIE_REAL_MALWARE_SCAN_ENABLED` are all `true`.
  - Bucket, region, account, malware keys and `AIE_OPENAI_API_KEY` are set.
  - `AIE_PILOT_COHORT_ENFORCED=true`, with 2 emails.
  - The five per-class `AIE_*_AI_FALLBACK_ENABLED` flags are **unset**.
  - **Not set at all:** `AIE_AI_PROVIDER`, `AIE_MASK_TOKEN_ENCRYPTION_KEY`, `II_AI_FALLBACK_ENABLED`, `AIE_AI_MODEL`, `AIE_AI_COST_ALLOWANCE_USD`. See finding F-12.
- **Latest deploy:** job 229 at 215148b (24 Sep 13:44 UTC).
- **`aie_*` tables:** all 19 core tables have **0 rows**, including `aie_audit_event`. `aie_ai_cost_ledger` has 1 row: `global`, allowance 10, reserved 0, settled 0. `fdh_document_audit_events` holds no AI-fallback or malware event. **No OpenAI call has ever been made from production.**
- **Malware identity:** the production malware-scan keys belong to IAM user `arn:aws:iam::879807128139:user/Amar`. This is the same human IAM user as the operator CLI, with a different access key. It is a least-privilege concern: see PO item P-9.
- **Production S3 malware bucket** (versioning disabled): it holds **5 objects**. Four are the 21–22 Sep canary payslips (about 2.2 KB each) and one is a 0-byte object. **Nothing in the code ever deleted them** (finding F-6). The lifecycle configuration could not be read (`s3:GetLifecycleConfiguration` is denied).
- **Retained original PDFs** in `investment-source-documents` (finding F-7):
  - **4 real users' CAS PDFs** (134–209 KB) are still stored, confirmed by a metadata-only GET. They were uploaded 6–16 Sep.
  - 2 are `parsed` from before the purge fix, and 2 are `unsupported`/`uploaded`.
  - No content was read.
  - `fdh_statement_uploads` has no live storage reference.

---

## 2. Requirement register

| # | Requirement (PO brief) | Evidence before this work | What was missing | Work done | Verification | Result |
|---|---|---|---|---|---|---|
| R1 | GPT-4o mini only, no substitution or escalation | Model is set by `AIE_AI_MODEL`, default `gpt-4o-mini`. An unset `AIE_AI_PROVIDER` fell back to the **mock** provider, which is what production runs today. | Nothing enforced the model; a mock was substituted silently. | The gateway refuses any model except `gpt-4o-mini` or `gpt-4o-mini-2024-07-18` before it reserves budget. An unset provider outside tests is `unconfigured` and fails closed. | UNIT (`aie1FinalSafetyControls`). LIVE-DEV: every recorded call reports `ai_model=gpt-4o-mini`. | **PASS (DEV)** |
| R2 | GuardDuty Malware Protection for S3 on the exact bytes | Scan wired for FDH and AIE intake; proven in production once, on 22 Sep. | The **Investment Intelligence upload route (the only live II surface) had no real scan.** Pending or blocked FDH files could be re-processed. The verdict could be forged by the owner. | II scan gate added (`realScanAdmission.ts`, migration 0196 columns). Admission check added before every FDH byte read. Verdict guard added (0196). Pending-scan check added on the AIE II process route. | LIVE-DEV: real GuardDuty `NO_THREATS_FOUND` in 5–6 s for 8 documents (J1, J2, J4–J10), and a real `THREATS_FOUND` for EICAR (J4). PGLITE 0196 21/21. The **II real scan** is UNIT only until 0196 is in DEV. | **PASS (DEV), except the II scan, which is pending 0196** |
| R3 | Private quarantine → clean scan → isolated extraction | FDH parks the file in `validating` until the verdict is clean. | Re-processing a `failed` file skipped the scan (F-1). | `checkFdhDocumentMalwareAdmission` in all six FDH services. | LIVE-DEV J4: detect and process of the blocked file are refused (400), and nothing is written. UNIT, with a negative control that fails without the guard. | **PASS (DEV)** |
| R4 | Local PII masking; never send PDFs, images, URLs, passwords or token maps | Masks text only; `store:false` is sent. | **5 of 16** synthetic PII classes got through (bare `Name:`, `Account Name:`, Employee ID, AU landline, Medicare). | Four label-anchored rules added. | Local probe: **0 of 16** survive. LIVE-DEV J2 uses the same synthetic PII on the real request path. Unit egress suite green. | **PASS (DEV, probe-level)**. See §9 for what cannot be verified. |
| R5 | Deterministic parser first; AI only when the parse is incomplete | The payslip parser can only fail as `not_a_payslip` or `country_not_identified`. | **The payslip AI fallback could never run**: an unreadable payslip was saved as *empty* evidence (F-2). | An extraction with no gross and no net is treated as `layout_unsupported`, which makes it eligible for AI. | LIVE-DEV J2 and J3 | **PASS (DEV)** |
| R6 | Local schema validation of the AI output | Zod re-validation exists. | The live model answered absent fields as `(null, null)`, so **every realistic document was `schema_rejected` after a billed call** (F-3). | Money fields in the OpenAI strict schema are now `anyOf` two exact shapes, for payslip, bank, liability and retirement. | LIVE-DEV J2 (req_9df4a731… rejected before the fix; req_d23d5fbd…, req_ce51c32e… pass after it). UNIT drift tests updated. | **PASS (DEV, payslip)**. The other classes' AI paths are UNIT only (§5). |
| R7 | Deterministic reconciliation | Exists per class. | none | none | LIVE-DEV: J1 reconciled against the AU-01 oracle; J6 bank PDF `reconciled`. | **PASS (DEV)** |
| R8 | Durable structured extraction; accept without the PDF | Structured evidence is durable for native parses. **The AI draft existed only in the HTTP response.** The 50-minute backstop forced unreviewed documents to `rejected` (F-4; this is the cause of the 3 production rejections). | Durable AI draft; no forced rejection of documents that already have evidence. | Migration 0197 `fdh_ai_fallback_drafts` (server-written, confirm-once). The backstop now purges the file but keeps the status for `extracted`, `review_required` and `ready_for_approval` documents, and for documents with a pending draft. | LIVE-DEV J1: PDF purged and **absence verified**, document stays `extracted`, evidence survives. PGLITE 0197 17/17. The durable draft is UNIT/PGLITE only until 0197 is in DEV (J2 ran with the pre-0197 fallback, `draft_persisted:false`). | **PASS (DEV) for native; pending 0197 for the AI draft** |
| R9 | Delete the original or temporary PDF | FDH purge works. II deletes only after a successful parse. **S3 scan copies were never deleted** (F-6). FDH absence check treated a listing error as "absent" (F-8). | S3 delete and verify; II backstop; a strict absence check. | `deleteObjectFromS3` and `verifyS3ObjectAbsent`, which distinguish deleted, delete marker, access denied and error. Inline purge on the verdict, plus a sweep. II 24-hour backstop. Strict FDH absence check. | LIVE-DEV: FDH purge verified (J1, J4). II purge verified (J5). S3 delete **attempted and correctly classified `access_denied` / `unverifiable`** on the versioned DEV bucket (missing `s3:DeleteObjectVersion`). | **PASS (DEV) for FDH and II; S3 deletion blocked on IAM** (P-6) |
| R10 | User review and acceptance → canonical records through the certified writer | The payslip confirm route existed. | **The confirm call always failed with 422** (F-9). **Add-as-new-income always failed with `NO_FIELDS_SELECTED`** (F-10). | The draft sends only reviewable keys. The panel sends the reviewed field selection. | LIVE-DEV J1 and J2: approve → proposal → apply. Income rows 4150 and 3200, fortnightly. Replay returns 409, with no second row. | **PASS (DEV)** |
| R11 | Replay and concurrent acceptance write nothing twice | Idempotent `process`; proposal status gate. | none | Confirm-once claim (0197). | LIVE-DEV: replayed process (J1), confirm (J2) and apply (J1) all write nothing twice. PGLITE 0197 covers the concurrent claim. | **PASS (DEV)** |
| R12 | Hard spend cap, atomic, retry- and concurrency-safe | Atomic DB reservation (0152). | **D1** a replayed key is admitted again (unmetered call). **D2** same-key concurrency leaks a reservation. **D7** the caller can raise the cap. **Anon role can execute the RPCs.** Undersized reservation. Settle errors ignored. No request ID. | Migration 0195. Per-attempt keys. Reservation sized to the prompt and output budget × attempts. v2 settle with evidence. Stale-release sweep. | **LIVE-DEV negative controls: D1, D2 (12 admitted, 2 reservations), D7 and anon execute all demonstrated live on DEV today.** Exhaustion through the real app path returns `budget_exhausted` with no provider call. PGLITE 0195 33/33. | **Defects proven live; fix PGLITE-verified; post-0195 DEV re-run pending** |
| R13 | Request ID and token usage recorded | Only ledger totals. | Per-call record. | `x-request-id` captured per HTTP attempt. Payslip audit event records model, cost key, request IDs and tokens. 0195 adds the per-attempt columns. | LIVE-DEV J2: `req_ce51c32ef947490fa27cc3852c559dd4`, 2119 in / 402 out. | **PASS (DEV)** |
| R14 | Pilot cohort / entitlement | An email-only allowlist is used in production. | **Five FDH AI paths and Insurance checked the user ID only, so an email-only list denied everyone, pilots included** (F-11). | Server-side email resolution (`pilotCohortEmail.ts`). | LIVE-DEV: pilot admitted (J2). Outsider gets `cohort_denied` with no spend (J3). | **PASS (DEV)** |
| R15 | II adapter reached by the real UI route | The UI calls `/api/investment-intelligence/source-documents` → `processSourceDocument` (mechanism A). **No UI calls the AIE II adapter.** | See §4 | Real scan added to the real II route. The AIE II adapter route gained a pending-scan guard. **No new UI was built on the AIE II adapter** (see §4). | LIVE-DEV J5: the real II route parses the CAS fixture and matches the oracle (2 accounts, 2 transactions, 2 holdings). PDF purged. | **PASS for the real route; the AIE II adapter stays unreachable from the UI (disclosed)** |
| R16 | Accessibility | No axe coverage of the upload panels. | Automated check. | axe scan of 6 surfaces; fixed 1 critical issue. | LIVE-DEV: 6 of 6 surfaces have no serious or critical violations. Manual protocol in §11. | **Automated PASS; manual is PO only** |
| R17 | PC5 integration | PC5 exists (`lib/pc5/**`, `/investment-intelligence/resolutions`). `lib/pc5/decide.ts` uses the AIE interface. | none | none | Code read only. | **Dependency recorded** (§12) |

---

## 3. Document class × flag matrix (from code at this branch)

All flags are `=== 'true'` and fail closed, except `FDH_DOCUMENT_UPLOAD_ENABLED` (`!== 'false'`, combined with an allowlist of project refs that includes production).

**The AI gate for the five FDH classes applies, in order:**
1. the class flag;
2. `AIE_AI_FALLBACK_ENABLED`;
3. the AIE cohort (email now resolved);
4. at least 40 characters of text;
5. masking (fails closed without `AIE_MASK_TOKEN_ENCRYPTION_KEY`);
6. gateway: kill switch → permitted model → PII re-scan → cost reservation → provider (`AIE_AI_PROVIDER` must be `openai`).

| Class | UI entry (rendered) | Route | Adapter dispatched? | Deterministic parser | AI flag(s) | Canonical destination | Malware gate | Effective production today | Status |
|---|---|---|---|---|---|---|---|---|---|
| Payslip | `PayslipImportPanel` (/income) | upload-sessions → complete → `payslip/{id}/process` → `ai-fallback/confirm` → approve → proposal → `income-proposals/{id}/apply` | yes (`adapters/payslip`, from inside the service) | `parsePayslipText` | `AIE_PAYSLIP_AI_FALLBACK_ENABLED` | `income_sources` via `fdh9_apply_income_proposal` | yes; admission guard added | Native only. AI would stop at `adapter_disabled`. Even if enabled, the provider is unset and masking has no key (F-12). | Supported native; AI **DEV-proven**, not activated |
| Bank PDF | `BankStatementImportPanel` (/expenses) | `bank-pdf/upload` → `/process` → `ai-fallback/confirm` | yes (`adapters/bankStatement`) | `runBankPdfPipeline` | `AIE_BANK_STATEMENT_AI_FALLBACK_ENABLED` | `fdh_transactions` at processing time | yes; admission guard | Native only | Native LIVE-DEV (J6); AI UNIT only |
| Bank CSV | same panel | `bank-csv/upload` → detect → process | none (no AI path) | R7 adapters | none | `fdh_transactions` | yes; admission guard | Native only | Native LIVE-DEV (J7) |
| AU investment (FDH-11) | `AuInvestmentStatementImportPanel` (/investments) | `investment-statement/upload` → `/process` | yes (`adapters/auInvestment`), CSV only | CSV detection and extraction; **PDF fails immediately** | `AIE_INVESTMENT_STATEMENT_AI_FALLBACK_ENABLED` | `ii_*` via approve/apply | yes; admission guard | CSV native | CSV LIVE-DEV (J10); PDF deferred |
| Investment Intelligence (CAS) | `InvestmentIntelligenceClient` (/investment-intelligence/data) | `source-documents` → `{id}/process` | **Only mechanism A** (`processSourceDocument` + `aiFallbackDocumentExtraction`). The AIE II adapter is **not** dispatched. | `parseExtractedDocument` | `II_AI_FALLBACK_ENABLED` plus its own `II_AI_FALLBACK_PILOT_COHORT_*` (the AIE cohort does not apply) | `ii_*`. **AI results are auto-applied without review** (pre-existing; see F-13). | **Real scan added on this branch** (requires 0196) | Deterministic only (`II_AI_FALLBACK_ENABLED` is unset in production) | Supported deterministic; AI not activated |
| Investment (AIE II adapter) | **none** | `aie/investment-intelligence/intake` → `/process` → `aie/review/runs/{id}/accept` | yes, but only from these API routes | II parser | `AIE_II_ADAPTER_ENABLED`, `AIE_DOCUMENT_INTAKE_ENABLED`, cohort | `ii_*` (write flags off) | yes; **pending-scan guard added** | API reachable by the 2 pilots only. No UI. | **Deferred.** No UI; accept depends on the PDF. |
| Liability | `LiabilityImportPanel` (/liabilities) | `liability-statement/upload` → `/process` | yes (`adapters/liability`), CSV | `extractLiabilityStatement` | `AIE_LIABILITY_AI_FALLBACK_ENABLED` | `liabilities` via `fdh10_apply_liability_proposal` | yes | CSV native | CSV LIVE-DEV (J8) |
| Retirement / super | `RetirementStatementImportPanel` (/retirement) | `retirement-statement/upload` → `/process` | yes (`adapters/retirement`), CSV | retirement extraction; **PDF fails immediately** | `AIE_RETIREMENT_STATEMENT_AI_FALLBACK_ENABLED` | `retirement_accounts` via `fdh12_apply_retirement_proposal` | yes | CSV native | CSV LIVE-DEV (J9); PDF deferred |
| Insurance | **none** (grid page only) | `aie/insurance/intake` → review → accept | yes (from the route) | insurance parser | `AIE_INSURANCE_ADAPTER_ENABLED` (unset) | `insurance_policies` (write flags off) | yes | 403 (adapter flag unset) | **Deferred** (no UI) |

**Prohibited:** identity, medical and legal documents (register row 10).

**Pilot cohort semantics:**
- `AIE_PILOT_COHORT_ENFORCED` not `true`: everyone is admitted.
- Enforced with **both lists empty**: **no one** is admitted (fail closed).

**So general activation is `AIE_PILOT_COHORT_ENFORCED=false`, never an emptied list.**

---

## 4. The three rejected production uploads (23 Sep): finding

These are `c0a7db0e…`, `837223e7…` and `ec5ec40a…`. The finding comes from sanitised metadata and audit event types only; no content was read.

- **Route / adapter:** the FDH payslip session flow (`pdf_native`, `payslip`, AU). No AIE adapter was involved.
- **Stage reached:** all three completed the upload, were `validated` and `queued`, and ran through **`payslip_extraction_completed`**.
  - Two were `reconciled` with confidence 1.0.
  - One had a `variance` at confidence 0.55 and `review_status=pending`.
  - A `fdh_payroll_events` row exists for each.
  - **They were not rejected by validation, scanning or parsing.**
- **Why `rejected`:** the LR-1 raw-file hard backstop (`FDH_DOCUMENT_RAW_MAX_LIFETIME_MINUTES = 50`). Each document's `document_purge_scheduled` event carries `{reason: raw_retention_hard_backstop, max_age_minutes: 50}`. The backstop forces any non-approved document to `rejected` before purging it. Nobody approved these within 50 minutes, so successfully extracted evidence was stranded. No UI tells users about the window. This is defect **F-4**, fixed on this branch: the backstop now purges the file but keeps the status for documents that already have evidence.
- **Why `malware_scan_status = not_required`:** the uploads ran on Amplify build 218 (23 Sep 07:16 UTC). The FDH gate writes nothing when `AIE_REAL_MALWARE_SCAN_ENABLED` is off, and `not_required` is the column default. It is recorded that the flag was rolled back to `false` on 23 Sep and set to `true` again on 24 Sep, before builds 219 and later. **The build-time value cannot be proven from here** (`cloudtrail:LookupEvents` is denied). **There has been no production upload since the flag was set to `true`.**
  - Code proof that a valid PDF cannot bypass the scan while the flag is on: `initiateRealMalwareScan` returns `not_required` **only** when the flag is off.
  - The new admission check refuses `not_required` while the flag is on. This covers bytes uploaded before the switch.
- **Binaries:** all three are `raw_document_purge_status=purged`, and `document_purged` was recorded after deletion was verified. The FDH Supabase bucket has no live reference.
- **Reproduction in DEV:** J1 is the same payslip flow. It extracts, keeps the document `extracted` after the backstop purge, then approves and applies. This is proof of the fix.

---

## 5. DEV evidence per journey

Run IDs are `aie1final-<epoch>`. The evidence JSON is in the session scratchpad. All users and documents were synthetic and have been deleted (§13). Every scan below was a real GuardDuty verdict from DEV plan `7ad04d8fdccaad20ae8f`.

| Journey | What ran | Evidence | Result |
|---|---|---|---|
| **J1** native payslip (AU-01 oracle) | session → complete (`validating`) → sweep → `clean` in 5.6 s → process → approve → proposal → apply `add_new` → replay → 50-minute backstop → purge | doc `d5961c23-be64-4bd8-994d-7033f2a22503`. Payroll event `24ba33ef…`: gross 4450, net 3325, tax 1100, super 511.75, reconciled, fortnightly, all equal to the oracle. Income `6ef17293…`: 4150.00 fortnightly AUD. By hand: ordinary 4000 + allowance 150; overtime is excluded as variable pay. Replayed apply returns 409 `ALREADY_APPLIED`. PDF purged, absence verified, status stays `extracted`. | 13/13 PASS |
| **J2** payslip needing AI | synthetic prose payslip with planted PII → parser `layout_unsupported` → **real gpt-4o-mini** → draft → confirm → replay → approve → apply | doc `81785845-a07f-42bc-9df1-dbbbe862b939`, **request `req_ce51c32ef947490fa27cc3852c559dd4`**, **2119 input / 402 output tokens**. Reserved 0.002722, **settled US$0.000559**. Latency 8.2 s. Draft: gross 3200, tax 512, net 2488, fortnightly, paid 2026-08-15, all equal to the expected values. Replayed confirm returns 409. Evidence `parser_name=aie_payslip_ai_fallback_user_confirmed`. Income `5e6831dd…` 3200 fortnightly. The user ticked the "please confirm" frequency. | 10/10 PASS |
| **J3** cohort | outsider (not on the email list), same document | `payslip_ai_fallback_not_usable {reason: cohort_denied}`. Ledger `total_attempts` unchanged. | PASS |
| **J4** EICAR (as CSV, DEV bucket only) | upload → **real `THREATS_FOUND`** in 5.4 s → detect/process → purge sweep | doc `4a53b85a-f422-4706-a147-391ae9c36e77`: `malicious`, `failed`, `malware_detected`. Purge scheduled immediately (`malware_scan_blocked`). Detect and process return 400, 0 transactions. Bytes purged. **The owner's PATCH `malware_scan_status=clean` returned 200 and persisted** (F-5, fixed by 0196). The error-code check still blocked processing. | 5/5 PASS, plus the F-5 observation |
| **J5** II CAS | real II route: upload → process loop → parse | source doc `68bcf8fe-4e60-48ca-9018-8d1acd9e522b`, `parsed`. 2 accounts, 2 transactions, 2 holdings, equal to the `pc3-q01` oracle. `storage_purged_at` set. **Scan: structural only, because 0196 is not in DEV (columns absent).** | PASS; scan pending 0196 |
| **J6** bank PDF | synthetic CBA layout | doc `1c541d99…`: 3 transactions, debits 265.44, credits 500.00 (by hand: 1000 − 45.20 + 500 − 220.24 = 1234.56). `reconciled`. | PASS |
| **J7** bank CSV | certified CBA fixture | doc `071f36ac…`: detected, **5 of 5 rows**, `certified`. The first attempt hit a transient S3 `fetch failed` and was permanently rejected (**F-14**). Retry added, re-run clean. | PASS |
| **J8** credit-card CSV | scan → pending → resume `/process` | doc `f9b2472b…`: purchases 85.40, payment 200.00. (The fdh14 smoke fixture's `0.00` line causes a 500; see F-15.) | PASS |
| **J9** super CSV | inline | doc `83200949…`: amounts 500 and 200. Both are classified **`UNKNOWN`** (F-16, reported only). | PASS (amounts) |
| **J10** AU broker CSV | scan → resume | doc `781773ac…`: BUY 2000.00 (50 × 40), DIVIDEND 120.00 | PASS |
| **Cost cap, pre-0195** | `aie1_final_cost_cap_live_dev_check.ts pre-0195` | **D1** a settled key is re-admitted. **D2**: 12 concurrent same-key calls were all admitted, with 2 reservations (a leak). **D7**: the caller raised the allowance to 1000. **Anon key executes `aie_reserve_ai_cost` (HTTP 200).** **Exhaustion:** the real `requestPayslipAiExtraction` returned `budget_exhausted` with no request ID, and attempts stayed 9 → 9. The ledger was restored afterwards. | 5/5 (negative controls prove the defects are live in DEV) |
| **Verdict forgery, pre-0196** | `aie1_malware_column_forgery_live_dev_probe.mjs expect-open` | The owner can change FDH `malicious` → `clean` and clear `malware_detected` (both 200). `aie_document_intake` is already closed to the owner (0 rows). | Defect proven live |
| **Accessibility** | axe (WCAG 2.0/2.1 A and AA) on 6 upload surfaces | 1 critical (`select-name`, II data page) fixed. Re-run: 6/6 have no serious or critical violations. | PASS (automated) |
| **Masking** | synthetic PII probe | 5/16 got through before the fix, 0/16 after. The gateway re-scan was blind to all 5 (it shares the patterns). | PASS (local) |

**DEV OpenAI spend:**
- Ledger: 0 → US$0.00216, from 4 application-path calls: req_9df4a731… (schema-rejected before the fix, $0.000482), req_d23d5fbd…, req_b30f34a3… and req_ce51c32e….
- 2 direct diagnostic calls outside the ledger (req_f01b48ca…, req_85de8207…), estimated at about $0.0012.
- **Total about US$0.0034, against a US$10 allowance.**

**Only UNIT-verified (not live), with the reason:**
- AI fallback for bank PDF, liability, retirement and AU investment: not exercised live because of time and spend. The same gateway and schema fix apply.
- II AI fallback (mechanism A): `II_AI_FALLBACK_ENABLED` flows were not exercised.
- II real scan: needs 0196 in DEV.
- Durable AI draft: needs 0197 in DEV.
- 0195 behaviour: PGLITE only until applied.
- Concurrent acceptance: PGLITE 0197 claim; HTTP-level concurrency not exercised.

---

## 6. Findings (defects), all with a fix on the branch unless stated

| ID | Sev | Finding | Fix / status |
|---|---|---|---|
| F-1 | Critical | Payslip, bank PDF and bank CSV re-processed files the malware gate had **blocked** (and unscanned files) through `failed → queued` | Admission check in all six FDH services; LIVE-DEV J4; UNIT with negative control |
| F-2 | High | Payslip AI fallback unreachable: unreadable payslips were saved as empty evidence | `layout_unsupported` when neither gross nor net is found; LIVE-DEV J2/J3 |
| F-3 | High | Live gpt-4o-mini returned `(null, null)` for absent money fields, so every realistic document was `schema_rejected` **after a billed call** | Money fields in the strict schema are `anyOf`; LIVE-DEV J2 |
| F-4 | High | The 50-minute backstop rejected successfully extracted, unreviewed documents. This is the cause of the 3 production rejections. | Status kept when evidence or a pending draft exists; LIVE-DEV J1 |
| F-5 | High | The owner could forge the malware verdict and error code through PostgREST (RLS "own rows", no column guard) | 0196 trigger (PGLITE 21/21); live DEV proof before the fix. The code-level error-code check already blocks the processing path. |
| F-6 | High | S3 scan copies were never deleted, in any environment (production holds 5) | Delete + verify with outcome classes; inline purge + sweep. IAM needed (P-6). |
| F-7 | High | II original PDFs are kept forever unless parsing succeeds. **4 real users' PDFs are in production.** | 24-hour II backstop in the AIE purge sweep; production purge is a proposed action (A-7) |
| F-8 | Med | The FDH purge treated a failed storage listing as "absent" and could mark a row purged while the object remained | Strict absence check |
| F-9 | High | Every payslip AI confirm call returned 422 (the draft carried internal keys; the confirm schema is strict) | Reviewable-key projection; LIVE-DEV J2 |
| F-10 | High | "Add as new income" from a payslip always failed with `NO_FIELDS_SELECTED` | The panel sends the reviewed selection; LIVE-DEV J1/J2 |
| F-11 | High | The email-only pilot allowlist denied everyone on 5 FDH AI paths and Insurance | Email resolved server-side; LIVE-DEV J2/J3 |
| F-12 | High | Production has `AIE_AI_PROVIDER` unset (the old default was a **silent mock**) and **no `AIE_MASK_TOKEN_ENCRYPTION_KEY`**, so no AI fallback could really run there | Code now fails closed. Env is a PO action (A-9). |
| F-13 | Med | II mechanism-A AI results are **auto-applied without user review** (pre-existing, 20 Sep design) | **Not changed.** Recorded; recommend keeping `II_AI_FALLBACK_ENABLED` off until review-before-write exists. |
| F-14 | Med | One transient S3 network error permanently rejected a clean upload | Bounded retry on network errors and 5xx (not 4xx); UNIT + LIVE-DEV J7 |
| F-15 | Med (FDH-10, out of AIE scope) | A zero-amount liability CSV line violates `fdh_liability_statement_activities_amount_check`. The route returned 500 with no log, leaving an orphaned statement row and a document stuck in `queued`. | Logging added; **root cause not fixed** (certified writer) |
| F-16 | Low (FDH-12) | The fdh14 smoke super CSV classifies both lines `UNKNOWN` | Reported only |
| D1/D2/D5/D7 | High | Spend cap: replayed key admitted again; same-key concurrency leak; settle errors ignored; caller-controlled cap | 0195 + app changes; defects proven live in DEV |
| PRIV | High | `anon`/`authenticated` can **execute** the cost RPCs. DEV live: anon reserve returns 200. **Likely also in production** (same migrations). **Not probed there**, because that would be a write. | 0195 revokes |
| M1 | High | Masking gaps (5 classes) | 4 rules added |
| A11Y | Crit (axe) | Unlabelled II source select | Fixed |

---

## 7. Engineering done (commits on `feat/aie1-final-production-completion`)

| SHA | Summary |
|---|---|
| b1c60b3 | Safety checkpoint: 0195/0196/0197; malware admission; S3 scan-object purge; II real scan and retention backstop; cohort email; masking rules; provider and model guards; per-attempt cost keys; request-ID capture |
| (merge) | Merge of `origin/main` 713561d; re-verified with tsc and PGlite 0195/0196/0197 |
| 0fac395 | Payslip AI fallback reachable; `anyOf` money schema; add_new apply; call evidence; live harness |
| 720167f | Payslip AI draft limited to reviewable keys (confirm had always returned 422); gateway reports tokens on rejection |
| 1758f74 | S3 transient retry; liability 500 logging; statement journeys |
| dab61c4 | Live DEV spend-cap check |
| 7637da9 | Accessibility fix + axe scan |
| a359ead | DEV cleanup script |
| (final) | This register + build launcher mode |

**Gates:**

| Gate | Result |
|---|---|
| `tsc --noEmit` | clean |
| eslint (changed areas) | clean |
| New and updated unit tests | green: `aie1FinalMalwareAdmission` 8, `aie1FinalSafetyControls` 15, gateway/cost/payslip/unified/schema suites |
| Full unit suite | 8654 passed, 27 failed. 5 of the failing files pass in isolation (timeouts under parallel load, a known hazard). The rest (`adminAnalyticsPhaseAMeRoute` ×17, `aiResidualClosureFailClosed`, `countryGateAccessMatrix`, resources live-DEV/R1_1/R1_5) fail in isolation too and have **no file overlap** with this diff. They are admin-capability snapshot drift, Module 11, and resources live-DEV. |
| `next build` | see the build note at the end of this file |
| Migration collision scan | all remote branches; highest on main is 0194; 0195–0197 are free (claimed by this branch) |

**Admin Architecture Standard:** no Admin surface, role, capability, RLS or RPC used by Admin was created or changed. The cost-RPC grants in 0195 are service-role only. **No Admin exception is requested.**

---

## 8. Migrations to apply (the PO applies by hand; DEV first)

**Order:** 0195 → 0196 → 0197. All are additive. None drops or recreates a CHECK constraint. No per-environment data. None adds audit-event values, so no delta-map entry is needed.

| File | Purpose | Safety |
|---|---|---|
| `supabase/migrations/0195_aie_ai_cost_replay_refusal_and_call_evidence.sql` | Replay refused; key claimed first (concurrency); DB ceiling authoritative; zero amount refused; `aie_settle_ai_cost_v2` with evidence; stale release; **revoke anon/authenticated** | Same `aie_reserve_ai_cost` signature, so code already deployed benefits immediately. Old code's second AI attempt on the same document is refused (fail closed). PGLITE 33/33 with negative controls. |
| `supabase/migrations/0196_malware_scan_verdict_integrity_and_ii_scan_columns.sql` | Verdict guard trigger on `fdh_statement_uploads` and `ii_source_documents`; II scan columns | Server and service role unaffected; owner flows unaffected (PGLITE 21/21) |
| `supabase/migrations/0197_fdh_ai_fallback_drafts.sql` | Durable drafts table: owner read, server write, one pending per document, cascades | PGLITE 17/17 |

**Verification queries after each application** (read-only; the PO runs them):

```sql
select proname, has_function_privilege('anon', p.oid, 'execute') anon_exec
  from pg_proc p where proname like 'aie_%cost%';                       -- 0195: all false
select tgname from pg_trigger where tgname = 'trg_aie_guard_malware_scan_verdict';  -- 0196: 2 rows
select to_regclass('public.fdh_ai_fallback_drafts');                   -- 0197: not null
```

**DEV re-runs after application** (these complete the pending items):

```bash
npx tsx scripts/aie1_final_cost_cap_live_dev_check.ts post-0195
node scripts/aie1_malware_column_forgery_live_dev_probe.mjs expect-closed
node scripts/aie1_final_dev_server.mjs 3961 &
npx tsx scripts/aie1_final_live_dev_journeys.ts http://localhost:3961
```

The last command runs all journeys. Expected changes: J2 `draft_persisted:true`; J5 scan `clean`.

---

## 9. Privacy: what is and is not verifiable

- **Verified in code and live:** only masked text is sent (`messages` hold two strings). There are no files, images, base64, URLs, passwords or token maps. `store: false` is on every request. The model is pinned to gpt-4o-mini. The OpenAI `x-request-id` is recorded.
- **Verified locally:** masking of 16 synthetic PII classes (§5). The gateway's own pre-egress re-scan uses the **same patterns**, so it cannot catch a class the masker misses. It is defence in depth, not an independent check.
- **Not verifiable from code:**
  - `store:false` is **not** Zero Data Retention. OpenAI API data may still be kept for abuse monitoring (typically up to 30 days) unless ZDR is contracted.
  - Nothing here proves the project's retention, training or data-residency settings.
- **The PO must confirm in the OpenAI dashboard or terms (P-1..P-4):**
  - the organisation and project the `AIE_OPENAI_API_KEY` belongs to;
  - that data sharing and training are **off**;
  - whether **Zero Data Retention** is approved (otherwise, abuse-monitoring retention applies);
  - that the project's model allowlist includes `gpt-4o-mini`;
  - a project **monthly budget / hard limit** as a second line behind the app cap;
  - the data-residency region, if the privacy policy relies on one;
  - that the DPA / terms cover financial documents.

---

## 10. PROPOSED PRODUCTION ACTIONS (none executed; each needs PO approval)

| # | Action | Exact steps | Safety evidence | Rollback |
|---|---|---|---|---|
| A-1 | Apply **0195** to DEV, re-run `post-0195`, then apply to **production** | SQL editor: paste the file; run the §8 verification query | PGLITE 33/33; unchanged signature; live DEV defects shown | 0195 is additive. To roll back, re-apply 0152's function body (fails **open** on replay, so not recommended). Grants can be re-granted. |
| A-2 | Apply **0196** to DEV, run the `expect-closed` probe, then production | as above | PGLITE 21/21; server paths use service role | `drop trigger trg_aie_guard_malware_scan_verdict on …`; the columns are harmless |
| A-3 | Apply **0197** to DEV, re-run J2, then production | as above | PGLITE 17/17; code falls back if the table is missing | `drop table fdh_ai_fallback_drafts` (drafts are recoverable only by re-processing) |
| A-4 | Review, then **merge** `feat/aie1-final-production-completion` to `main` (auto-deploys) | PR, review, merge; confirm the Amplify job succeeds | tsc/lint clean; targeted suites green; failures pre-existing; **migrations first** (code tolerates their absence either way) | Revert the merge commit (Amplify redeploys) |
| A-5 | Production cron check: the AIE purge sweep must be scheduled and reach production. It now also runs the S3-copy purge, II backstop and stale-cost release. | PO query: `select jobname, schedule from cron.job where jobname like 'aie1-%'`; then `net._http_response` for recent 200s on `/api/aie/cron/purge-sweep` | Route is authenticated with `x-cron-secret` | Unschedule the job |
| A-6 | **IAM:** grant the malware identity `s3:DeleteObject` on the **production** bucket (unversioned) and confirm it. For DEV (versioned), grant `s3:DeleteObjectVersion` + `s3:GetObjectVersion`, **or** add a lifecycle rule expiring objects **and noncurrent versions** after 1 day on both buckets. **Keep production versioning off** unless `s3:GetObjectVersionTagging` is also granted. | IAM console / `put-bucket-lifecycle-configuration` | DEV live: plain delete leaves only a delete marker; version delete denied | Remove the rule or grant |
| A-7 | **Purge the 4 retained real-user II PDFs in production.** Either let the merged 24-hour II backstop do it on the first sweep after A-4/A-5, or run the delete manually. | After A-4: check `ii_source_documents.storage_purged_at` is set for `7dbe1b60…`, `91ec4378…`, `026369f4…`, `85196a18…` | Structured data is untouched; the bytes were kept by a defect | None (deletion is the goal); confirm the privacy policy |
| A-8 | Delete the **5 production S3 canary objects** (synthetic payslips from 21–22 Sep plus a 0-byte object) | `aws s3api delete-object` for each (unversioned bucket), then `head-object` returns 404 | They are synthetic canaries | none needed |
| A-9 | **Amplify env for real AI** (only at activation time, §14): `AIE_AI_PROVIDER=openai`; `AIE_MASK_TOKEN_ENCRYPTION_KEY=<64 hex, new secret>`; `AIE_AI_MODEL=gpt-4o-mini`; `AIE_AI_COST_ALLOWANCE_USD=10`. **Keep `AIE_PILOT_COHORT_ENFORCED=true`.** | Amplify console, then redeploy | Without these, AI fails closed (safe) | Unset and redeploy |
| A-10 | Production **allowance** US$10: the ledger row is already 10. After 0195 the DB row is the ceiling, and the env can only lower it. | none beyond A-1/A-9 | Live DEV exhaustion test | Lower `aie_ai_cost_ledger.allowance_usd` |
| A-11 | Production verification (§14 plan) by the orchestrator, with a **synthetic production account** created by the PO | See §14 | — | Delete the synthetic user and objects |
| A-12 | Least privilege: replace the human IAM user **Amar**'s key in Amplify with a dedicated role or user limited to `PutObject`/`GetObject`/`GetObjectTagging`/`DeleteObject` on the malware bucket | IAM, then Amplify env, then redeploy | Production keys currently resolve to `user/Amar` | Restore the old key |

---

## 11. Manual screen-reader protocol (PO only; cannot be automated here)

Tools: NVDA + Firefox (Windows) and VoiceOver + Safari (macOS/iOS). Keyboard only; do not use the mouse.

For each page (/income, /expenses, /liabilities, /retirement, /investments, /investment-intelligence/data):

1. Tab to the upload control. The label and accepted file types are announced.
2. Choose a file. Its name is announced.
3. Start the upload. The **"Scanning your document for safety…"** state is announced (live region) without moving focus.
4. For a blocked file (DEV EICAR), the refusal message is announced and does not reveal the verdict.
5. For the payslip AI draft, every field is reachable, has a label, and can be edited. The "please confirm" marker is announced for the frequency checkbox.
6. On the proposal table, each row's checkbox is announced as "Apply <field>". The decision radios are grouped under their legend.
7. The success or applied state is announced. Focus is not lost.
8. Repeat at 200% zoom and a 320px width.

Record pass or fail per step and page.

---

## 12. PC5 dependency

- PC5 exists: `lib/pc5/**`, `app/api/pc5/**`, `/investment-intelligence/resolutions`, migration 0153.
- `lib/pc5/decide.ts` consumes `recordGovernedResolutionForPc5` from `lib/aie/pc5/pc5ExceptionInterface.ts`. The header of that file saying "PC5 does not exist" is out of date.
- `listUnresolvedItemsForPc5` / `resolveUnresolvedItemForPc5` are used only by tests and a live-DEV script.
- PC5 consumes **AIE unresolved items**. These are produced only by the AIE intake pipeline (II adapter, Insurance, FDH-bank adapters), **none of which has a UI entry**. So in production the PC5 AIE feed is empty by construction.
- No AIE-owned integration surface was changed. **The dependency is honestly: PC5 is ready, and the AIE producers it needs are deferred.**

---

## 13. DEV artefact manifest and cleanup

- **Manifest:** `aie1_dev_manifest.jsonl` in the session scratchpad. It lists every synthetic user, document, payroll event, proposal and income row, with IDs.
- **Cleanup** (`aie1_final_dev_cleanup.ts`): **all 25 synthetic users were deleted.** An independent check found **0** remaining rows across 11 journey tables.
- **DEV S3 bucket:** 18 synthetic objects from this session, including 2 EICAR test files, plus older canary objects, are still **current**. Deleting them needs a version-aware delete (A-6). Their keys are listed in `aie1_dev_manifest.s3-keys.txt`.
- **DEV cost ledger:** settled US$0.00216 is kept as evidence. Probe attempt rows use the prefix `aie1-final-costprobe-`.
- **Nothing sensitive was retained:** no PDF, no document text, no secret. The evidence files hold IDs, request IDs, token counts, amounts and timestamps only.

---

## 14. Production verification plan (for the orchestrator after A-1…A-5 and PO approval)

**Account:** one synthetic production user, created by the PO, whose email is added to `AIE_PILOT_COHORT_EMAILS`. It never touches real users.

**Order and thresholds:**

1. **Native payslip (AU-01 PDF).**
   - Expect `validating` → `clean` in under 60 s, then `extracted`.
   - Evidence must equal the AU-01 oracle; Income is 4150 fortnightly.
   - Replayed apply returns 409.
   - After 50 minutes, the file is purged, the status stays `extracted`, and the S3 copy's purge record shows `verified: absent`.
   - **Fail** if any value differs, a scan exceeds 20 minutes, or any object remains.
2. **EICAR must not be used in production.** Instead, check the blocked path with the DEV evidence and the code; no production malware test.
3. **Bank CSV** (CBA fixture): certified, 5/5 rows.
4. **II CAS** (`pc3-q01`): `clean` → parsed, oracle counts equal, `storage_purged_at` set.
5. **AI payslip.** Enable in this order: A-9 env, then `AIE_PAYSLIP_AI_FALLBACK_ENABLED=true`, then redeploy.
   - Upload the J2 fixture.
   - **Pass:** a draft equal to the expected values, a `gpt-4o-mini` request ID recorded, settled under US$0.005, a persisted draft (0197), and confirm/apply/replay behaving as in DEV.
   - **Fail / stop:** `schema_rejected`, `masking_unavailable`, or settled over US$0.01. Unset the flag at once.
6. **Cost:** after the tests, the ledger's `reserved_usd` is 0 and `settled_usd` is under US$0.02.
7. **Cleanup:** delete the synthetic user, check that 0 rows remain, and check the S3 copies return 404.

**Per-class activation flags** (each in its own later window, after step 5 passes): bank statement, liability, retirement, AU investment. Each needs one live DEV AI journey first; those are **not yet run** (§5).

---

## 15. Activation and observation window (proposed; PO decision)

- **Activation:**
  - Keep the 2-email pilot for at least 7 days with only `AIE_PAYSLIP_AI_FALLBACK_ENABLED` on.
  - General activation is `AIE_PILOT_COHORT_ENFORCED=false`. **Never empty the list**, because empty plus enforced admits no one.
  - `II_AI_FALLBACK_ENABLED` stays **off** until II AI results are reviewed before they are written (F-13).
- **Observation criteria (daily):**
  - 0 documents stuck in `validating` for more than 20 minutes;
  - 0 `malware_scan_failed` caused by transient errors;
  - 0 `schema_rejected` above 10% of AI attempts;
  - `reserved_usd` returns to 0;
  - settled under 50% of the allowance;
  - 0 S3 copies older than 24 hours without `s3Purge.verified='absent'`;
  - 0 II PDFs older than 24 hours with `storage_purged_at is null`.
- **Rollback trigger:** any criterion breached. Unset the class flag (AI stops at once; native parsing continues).

---

## 16. PO-only items

- **P-1..P-4:** OpenAI dashboard and terms (§9).
- **P-5:** apply migrations 0195–0197 (DEV, then production).
- **P-6:** S3 IAM / lifecycle (A-6).
- **P-7:** the manual screen-reader protocol (§11).
- **P-8:** Amplify env changes (A-9) and the activation decisions (§15).
- **P-9:** the dedicated least-privilege malware identity (A-12).
- **P-10:** decide the F-13 II auto-apply design.
- **P-11:** decide whether to follow up on the FDH-10 zero-amount defect (F-15) and FDH-12 classification (F-16).

---

## 17. Interim verdicts

| Scope | Verdict |
|---|---|
| DEV: payslip (native + AI), bank PDF/CSV, liability/retirement/AU-investment CSV (native), II CAS (native), malware clean and malicious paths, cohort, spend-cap exhaustion, purge, accessibility (automated) | **PASS (live DEV)** |
| DEV: spend-cap fixes (0195), verdict integrity (0196), durable drafts (0197), II real scan | **PENDING DEV MIGRATION** (PGlite and unit verified only) |
| DEV: AI fallback for bank, liability, retirement, investment and II | **NOT LIVE-VERIFIED** (unit only) |
| Production | **NOT VERIFIED. Not live. No general availability.** |

---

### Build gate note (added at the end of the run)

- `next build --webpack` on this branch **compiled successfully in 58 s**.
- Next's route-export type validation then stopped at `app/api/admin/recommendations/gaps/route.ts`. That route exports non-route constants (`GAP_REVIEW_UNAVAILABLE_CODE`, `GAP_REVIEW_UNAVAILABLE_MESSAGE`).
- The file is **untouched by this branch**. It comes from `5aa878e` on `main`.
- Amplify builds `main` successfully (job 229) with the default Turbopack build. Turbopack cannot run locally here because `node_modules` is a junction, which Turbopack rejects.
- **Result: the build gate is not fully reproduced locally.** No route file changed on this branch adds a non-route export. The pre-existing admin route is reported as a follow-up.
- Whole-project `tsc --noEmit` is clean.
