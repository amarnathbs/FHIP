# LR Production Upload Readiness

**Date:** 2026-09-14 · **Baseline:** `origin/main` @ `ff35f54`

## 2026-09-21 ADDENDUM — the gate this document describes has since been intentionally opened

Everything below this line was true on 2026-09-14 and is preserved as the historical record. As of commit `c4891185` (2026-09-20, on `origin/main`, confirmed as an explicit, direct Product Owner instruction), **row 1 of the matrix in §1 below ("FDH generic `documents/upload-sessions` + `/complete`") and every other FDH-3 row are no longer "Correctly disabled" against production** — `isFdhDocumentUploadEnabled()`'s hard project-ref allowlist (`lib/financial-data-hub/constants/featureFlags.ts`) now includes the real production Supabase project ref (`twwpnltizhtjxhamyoxt`) alongside DEV. Every column to the *left* of "Production gate" in that matrix is otherwise **unchanged from 2026-09-14** — in particular, **"Malware scan: No" is still accurate for every row**, because nothing was added to any FDH-3 route between 09-14 and 09-20 other than the allowlist entry itself. Re-read §1's matrix with "Production gate" recoloured to **OFF→ON** for all ten FDH surfaces and "Production user can upload" recoloured to **YES** for all ten, while every other column (Malware scan, Production DB/storage ready, Load test complete) stays exactly as recorded below.

This is the exact configuration Section 13 of the governing spec anticipated and named as a legitimate but risk-bearing outcome, provided it is disclosed rather than mislabelled — see the required wording in the companion `LR_2026_09_21_RECONCILIATION_ADDENDUM.md` and in the addendum at the top of `LR_FINAL_INDEPENDENT_AUDIT_REPORT.md`. It is not classified as a defect in the gate itself (the gate mechanism worked exactly as designed and still cannot be opened by an env var alone); it is classified as **"PRODUCTION DOCUMENT UPLOAD — SECURITY PREREQUISITE INCOMPLETE"** made live by an informed, explicit PO risk acceptance, which is a materially different, and more urgent, situation than "gate correctly closed, prerequisites merely unfinished." Two additional 2026-09-21 findings not in the 09-14 version of this document:

- **The `fdh-source-documents` production bucket's current existence was not re-verified in this pass** (would require a live, read-only production storage probe with the current `.env.local`, which was not carried into this audit worktree — see the reconciliation addendum's Cannot-Verify register). If it is still absent, as it was on 09-14, then production FDH-3 uploads are enabled at the code-gate level but would fail at the first storage write — a functional (not security) gap that itself needs a live check before this can be called "working in production" rather than merely "unblocked in production."
- The Investment Intelligence path described throughout this document as "ungated" **remains ungated and unchanged** as of 2026-09-21. Its own code (`lib/aie/adapters/investment-intelligence/dispatch.ts:51-62`) now explicitly documents, in its own header, that the originally-planned S3+GuardDuty malware scanning "remains blocked infrastructure" — confirming, from the codebase's own words, that §3 below ("no real production-grade malware scanner exists anywhere in this codebase") is still accurate for the *entire system*, not only for FDH.

---

## Required Section 13.7 statement

> **PRODUCTION DOCUMENT INGESTION — DELIBERATELY DISABLED; ENABLEMENT PREREQUISITES OUTSTANDING**

**With one mandatory qualification that changes what that sentence means in practice:**

> The statement is true for all ten Financial Data Hub upload surfaces. It is **false** for the Investment Intelligence upload surface, which is not gated by anything, is reachable by any authenticated production user from a first-class navigation item, and has already accepted **3 real documents** which produced **952 transactions** in the production database.

Never use a bare "upload security FULL PASS" for this programme.

---

## 1. Mandatory Production Upload Readiness Matrix (Section 43)

| Surface | Architecture implemented | DEV works | Malware scan | Production DB/storage ready | Load test complete | Raw deletion certified | Janitor certified | Production gate | Production user can upload | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| FDH generic `documents/upload-sessions` + `/complete` | Yes | Yes | **No** | **No** (bucket absent) | **No** | Yes | Yes | **ON (correctly closed)** | No | Correctly disabled |
| Expenses bank statement (CSV/PDF) — the panel's own path | Yes | **Upload only — nothing parses it** | **No** | **No** | **No** | Yes | Yes | ON (closed) | No | **Broken even in DEV** (P1-7) |
| `bank-csv/upload` + `/process` (API-only) | Yes | Yes | **No** | **No** | **No** | Yes | Yes | ON (closed) | No | Correctly disabled; **no UI reaches it** |
| `bank-pdf/upload` + `/process` (API-only) | Yes (no OCR) | Yes | **No** | **No** | **No** | Yes | Yes | ON (closed) | No | Correctly disabled; **no UI reaches it** |
| Payslip (`documents/upload-sessions` → `payslip/[id]/process`) | Yes | Yes | **No** | **No** | **No** | Yes | Yes | ON (closed) | No | Correctly disabled |
| Liability statement (CSV) | Yes | Yes | **No** | **No** | **No** | Yes | Yes | ON (closed) | No | Correctly disabled |
| Investment statement AU (CSV) | Yes | Yes | **No** | **No** | **No** | Yes | Yes | ON (closed) | No | Correctly disabled |
| Retirement statement (CSV) | Yes | Yes | **No** | **No** | **No** | Yes | Yes | ON (closed) | No | Correctly disabled |
| **Investment Intelligence source documents (India CAS/KFintech)** | Yes | Yes | **No** | **Yes** (bucket present) | **No** | **No — no purge exists** | **No — not covered by the janitor** | **NONE** | **YES** | **LIVE AND UNGATED** |
| Insurance documents | — | — | — | — | — | — | — | — | No | **Does not exist** |
| SMSF / entity documents | — | — | — | — | — | — | — | — | No | **Does not exist** |
| Admin recommendations CSV import | n/a (JSON text, never stored) | Yes | n/a | Yes | n/a | n/a | n/a | Admin capability | Admin only | Out of scope |

---

## 2. Section 13.5 — the controls, reported independently

| Control | Status | Evidence |
|---|---|---|
| Secure transient architecture | **PASS** | `uploadLifecycle.ts` never returns a storage credential; the session id is paired with a separate complete call |
| Strict raw-file deletion | **PASS (FDH only)** | `purge.ts:127-137` never marks a row purged until the delete succeeded **and** was independently verified absent |
| Autonomous janitor | **PASS** | Live production call today returned `200` with a correct sweep result — see §5 |
| Cross-tenant storage security | **PASS** | Every bucket is private; keys are `${userId}/…`; two-user isolation proven at the row layer |
| Malware protection | **NOT READY — none exists** | See §3 |
| Production document DB/storage readiness | **NOT READY** | `fdh-source-documents` bucket absent; `aie_document_intake` purge columns absent |
| Load / performance readiness | **NOT READY — never attempted** | See §4 |
| Production upload gate | **PASS for FDH — correctly OFF** / **ABSENT for Investment Intelligence** | See §6 |
| **User can upload documents in production** | **YES — via one ungated path** | 3 `ii_source_documents` rows, 952 `ii_transactions` in production |

The last row is the one Section 13.5 forbids converting to PASS merely because the gate works. Here it must not be converted to **NO** either: a production user genuinely can upload, through a path the gate never sees.

---

## 3. §13.1 — Malware / virus scanning

**No real production-grade malware scanner exists anywhere in this codebase.**

Repo-wide search over `app`, `lib`, `components`, `supabase` for `malware|clamav|antivirus|virus|guardduty|quarantine|infected` returns four hits, all the same unused enum constant:

- `lib/financial-data-hub/constants/enums.ts:250` — `'malware_detected'` in `FDH_ERROR_CODES`
- `supabase/migrations/0046_fdh_accounts_documents_jobs.sql:183`, `:258` and `0071_fdh5_bank_pdf_engine_foundation.sql:103` — the same value inside CHECK constraints

A targeted search for `error_code: 'malware` across `lib` and `app` returns **zero assignments**. The value is declared and constrained and never set by any code path. `docs/financial-data-hub/FDH1_STATE_MACHINES.md:195` describes it as "flagged by scanning" — describing a scanner that was never built. The repository's own documents confirm the absence: `FDH3_SECURITY_THREAT_MODEL.md:12` ("No malware/AV scanner integrated"), `FDH11_COMPLETION_REPORT.md:208` ("no scanner exists anywhere in this codebase"), `FDH5_COMPLETION_REPORT.md:87` ("PDF structural validation is explicitly not malware scanning").

### What exists instead, and why none of it is scanning

`lib/financial-data-hub/domain/fileValidation.ts:112-136` — its own header says "no parsing of document CONTENT":
MIME allowlist; size caps (20 MB PDF / 10 MB CSV); `%PDF-` magic bytes; a printable-byte heuristic for CSV; SHA-256; a capped literal search for `/Encrypt`. Per Section 13.1, none of these is malware scanning.

The Investment Intelligence validator is **weaker still** — `lib/services/investment-intelligence/storage.ts:21-43` checks only the filename extension, the browser-declared `file.type`, and size. Both are client-supplied. Its comment claims it "closes the 'rename a .exe to .pdf' gap"; it does not, because it never inspects a byte.

### Pipeline ordering (Section 13.1's specific question)

**FDH:** bytes in → session liveness → ownership → `validateUploadedFile` → storage write → existence verify → duplicate-hash check → `queued` → (parser, when invoked).
**Investment Intelligence:** multipart in → extension/MIME/size check → SHA-256 → storage write (service role) → *separate request* → download bytes back → `pdf-parse` / pdf.js → CAS parser.

**Untrusted bytes reach the parser before any scan on both pipelines, because no scan exists at any point.** On the II pipeline they additionally reach persistent storage without any byte-level type detection.

### The orchestrator's note about S3 + GuardDuty

A real AWS S3 bucket with a GuardDuty Malware Protection Plan has been verified end-to-end outside this repository. **The application does not use it.** Repo-wide search for `aws-sdk|@aws-sdk|S3Client|PutObjectCommand|amazonaws` across `app`, `lib`, `components`, `supabase` and `package.json` returns **zero** matches. All object storage is Supabase Storage. The AIE pipeline that was intended to consume it is not present on `origin/main` at all (`aie_document|aie-document` returns zero matches in tracked source), although `aie_*` tables do exist in both databases.

**Classification: `PRODUCTION DOCUMENT UPLOAD — SECURITY PREREQUISITE INCOMPLETE`.** The gate must stay OFF for FDH — and the Investment Intelligence path is currently outside that protection.

---

## 4. §13.2 / §13.3 — Database and load prerequisites

### Database / storage

| Requirement | DEV | PROD |
|---|---|---|
| `fdh_statement_uploads` with full purge columns | Yes | Yes |
| `fdh_upload_sessions` | Yes | Yes |
| `fdh_ingestion_jobs` | Yes | Yes |
| `fdh_document_audit_events` | Yes | Yes |
| `fdh-source-documents` bucket | **Yes** | **ABSENT** |
| `report-exports` bucket | **Yes** | **ABSENT** |
| `aie-document-quarantine` bucket | Yes | **ABSENT** |
| `aie_document_intake` purge columns (`purge_status`, `purge_due_at`, `purge_attempt_count`, `purged_at`, `purge_reason`, `last_purge_error_sanitised`) | **Yes** | **ABSENT** |
| `aie_ai_cost_ledger` / `aie_ai_cost_attempt` | Yes | **ABSENT** |
| `aie_reserve_ai_cost` / `aie_settle_ai_cost` RPCs | Yes | **ABSENT** |
| `0135` purge-sweep scheduler | Yes | Yes (endpoint live-proven) |

The FDH tables are present in production; the **bucket they write to is not**. Enabling the gate today would fail at the first storage write.

**Classification: `PRODUCTION DOCUMENT UPLOAD — DATABASE PREREQUISITE INCOMPLETE`.** No migration was applied by this audit.

### Load / performance

**Never attempted, by anyone.** No load harness exists under `scripts/`; no concurrency, burst, parser-timeout, provider-latency, purge-backlog or janitor-throughput measurement exists in any report. The 50-minute raw-file hard backstop (`lib/financial-data-hub/constants/retention.ts:39`) and the 5-minute sweep cadence (`0135:138`) give a designed worst case of 55 minutes — **a design figure, never measured under load.**

**Classification: `PRODUCTION DOCUMENT UPLOAD — OPERATIONAL READINESS INCOMPLETE`.**

This audit did not design and execute a load certification. That is a multi-day engineering exercise requiring a non-production environment with a public URL — which does not exist (DEV has no deployed public URL; that limitation is what drove the earlier tunnel plan). It is named here as outstanding rather than silently skipped.

---

## 5. The janitor — live production proof

`scripts/audit-lr/oracle8_insurance_and_janitor.ts`, run today against `https://app.financialhealthplatform.com`:

```
POST /api/financial-data-hub/documents/cron/purge-sweep   (no secret)   -> 401 {"error":"Unauthorized"}
POST /api/financial-data-hub/documents/cron/purge-sweep   (real secret) -> 200
   {"data":{"abandoned_sessions_swept":0,"hard_backstop_scanned":0,"hard_backstop_forced":0,
            "due_purges_attempted":0,"purged":0,"already_purged":0,"skipped_no_object":0,"failed":0}}
```

Production holds zero `fdh_statement_uploads` and zero `fdh_upload_sessions`, so this was a genuine no-op sweep: it proves the endpoint is live, authorised and correctly shaped **without purging anything real**.

**What remains unverified:** whether `pg_cron` actually invokes it on schedule, and with what URL. `cron.*` is not exposed through PostgREST, and migration `0135`'s committed file still carries the literal placeholder `'<REPLACE_WITH_REACHABLE_DEV_APP_ORIGIN>/api/financial-data-hub/documents/cron/purge-sweep'` at `:141`, with an operator note that the value must be hand-substituted per environment. One SQL query as the database owner would close this.

---

## 6. §13.4 — Gate invariant re-test

`lib/financial-data-hub/constants/featureFlags.ts:28-50`:

```ts
const FDH3_CERTIFIED_DEV_PROJECT_REF = 'vqycarelcoijzwlpkpcz';
export function isKnownNonProductionSupabaseProject(): boolean {
  return (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').includes(FDH3_CERTIFIED_DEV_PROJECT_REF);
}
function isEnvFlagEnabled(): boolean {
  return process.env.FDH_DOCUMENT_UPLOAD_ENABLED !== 'false';
}
export function isFdhDocumentUploadEnabled(): boolean {
  return isEnvFlagEnabled() && isKnownNonProductionSupabaseProject();
}
```

**This is a good control.** The hard half is an allowlist on one certified project ref, so a missing or empty `NEXT_PUBLIC_SUPABASE_URL` yields `false`. There is no env override that can open it in production. The env-flag half fails open by design but cannot open the gate alone.

Gate coverage, verified surface by surface:

**Gated, before `req.arrayBuffer()` is ever called (10):** `documents/upload-sessions`, `documents/upload-sessions/[sessionId]/complete`, `bank-csv/upload`, `bank-pdf/upload`, `bank-pdf/[documentId]/process`, `investment-statement/upload`, `liability-statement/upload`, `retirement-statement/upload`, `payslip/[documentId]/process`, `upload-status`.

**Ungated (1): `app/api/investment-intelligence/source-documents/route.ts`** — and its companion `.../[id]/process/route.ts`. Its only precondition is `requireCountryConfirmedUser()`. A search for `isFdhDocumentUploadEnabled|isKnownNonProductionSupabaseProject` returns 22 hits across 11 files in `app/`, **none** under `app/api/investment-intelligence/**` or `app/(app)/investment-intelligence/**`.

Corroborating UI signal: every FDH import panel polls `/api/financial-data-hub/upload-status` and disables its submit button. `components/investment-intelligence/InvestmentIntelligenceClient.tsx` is the **only** file-upload panel in the app that never does. The recent commit `c0b9e2b` ("extend upload-disabled disclosure to the 4 remaining import panels") covered the FDH panels and missed this one.

**A production route bypassing the gate is a P1 security/release defect** — Section 13.4's own words. Recorded as P1-3.

---

## 7. §13.6 — Original-scope reconciliation

For LR-1, LR-3 and LR-4, was the PO-authorised intended outcome **(A)** architecture/security certification with production upload deliberately disabled, or **(B)** actual live production document upload?

**Finding: no explicit Product Owner authority for either was found in this repository.** The original LR master prompts are not committed here. The evidence available is Tier 3 and Tier 4 only:

- Tier 3 (code): `isFdhDocumentUploadEnabled()` has existed and fails closed since FDH-3. The disclosure banners added in `a5c1146`/`25f1c74`/`c0b9e2b` tell users "Statement import isn't turned on in this environment yet", which is behaviour consistent with (A).
- Tier 4 (phase reports): LR-1's report certifies architecture and deletion, not production availability.
- Against (A): the LR-3 and LR-4 prompts as restated in this audit's own brief describe end-to-end user journeys ending in canonical writes, and the Privacy page published to real users describes uploading real statements — copy that only makes sense under (B).

Per Section 13.6's instruction where live production upload appears to have been required and no explicit deferment exists, the correct classification for the affected requirements is:

> **PARTIALLY IMPLEMENTED — PRODUCTION ACTIVATION PREREQUISITES OUTSTANDING**

This is flagged for a Product Owner ruling rather than resolved by inference.

---

## 8. What must be true before the gate is opened

1. A real malware scanner in the path, before parser/OCR/AI extraction — for **both** pipelines, not only FDH.
2. The `fdh-source-documents` bucket created in production with DEV's configuration.
3. A non-production load/performance certification per §13.3, with the 50-minute hard backstop shown to hold under expected load.
4. The Investment Intelligence path brought inside the same controls, or a documented PO decision accepting it as an exception — with the two residual-risk registers corrected either way.
5. The Expenses import journey actually connected to a parser (P1-7); opening the gate today would let a user upload a statement that still nothing reads.
