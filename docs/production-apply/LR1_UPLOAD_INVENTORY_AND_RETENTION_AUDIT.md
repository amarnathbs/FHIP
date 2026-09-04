# LR-1 — Upload Security, Strict Raw-File Deletion & Document Lifecycle
## Discovery: Inventory, Retention Audit, and Threat Table

Branch: `feature/lr-1-upload-security-lifecycle`, forked from `origin/main`
at `21839a8` (LR-FI-3 merge; LR-0/LR-FI-1/LR-FI-2/LR-FI-3 all confirmed on
`origin/main`, LR-FI-3 previously confirmed deployed as Amplify Deployment
116 per prior-track records).

Core decision governing everything below: **STRICT RAW-FILE DELETION +
STRUCTURED DATA / MINIMAL AUDIT METADATA ONLY.** No document evidence vault.

---

## 1. What FDH-3 already provides (do not rebuild)

FDH-3 (migration `0058`, `docs/financial-data-hub/FDH3_*`) already shipped a
complete Secure Document Lifecycle foundation:

- Private, non-public Supabase Storage bucket (`fdh-source-documents`),
  created via the Storage Admin API, never SQL.
- Opaque server-generated object paths: `{user_id}/{document_id}/{document_id}.bin`
  — never the original filename (which can carry PII).
- No storage credential (signed or otherwise) is ever returned to the
  browser — all writes are server-mediated through the service-role client
  after an explicit ownership check (`lib/financial-data-hub/services/storage.ts`).
- File-type validation by actual content/signature
  (`lib/financial-data-hub/domain/fileValidation.ts`), not extension or
  client-supplied MIME; explicit per-flow MIME allowlist
  (`application/pdf`, `text/csv`); size limits enforced server-side; a
  corrupt/mismatched/oversized/zero-byte file is rejected with a specific
  `failure_code` — all independently exercised by
  `tests/unit/fdh3UploadTestPack.test.ts` against real fixture files.
- Password-protected-PDF detection (flagged, not silently rejected).
- The document lifecycle state machine
  (`lib/financial-data-hub/domain/documentLifecycle.ts`) — a from/to
  transition table enforced in code, with a parallel `check` constraint in
  the DB for the vocabulary.
- A parallel purge state machine (`not_required → pending → in_progress →
  purged`, retryable `failed`, structurally-reserved `legal_hold`) and a
  fully-built, unit-tested, and (in isolation) live-DEV-proven purge
  operation: delete, then **independently verify absence via a separate
  `list()` call** — never inferred from the delete call's own success
  (`FDH3_PURGE_CERTIFICATION.md` section 4, run against real DEV project
  `vqycarelcoijzwlpkpcz`).
- An append-only, owner-read-only audit trail
  (`fdh_document_audit_events`) with a jsonb `metadata` column
  code-review-disciplined to never carry raw content, a signed URL, a
  password, or a stack trace.
- Admin boundary: no admin route/page/service anywhere reads a raw document,
  storage key, filename, or file hash (`constants/adminBoundary.ts`,
  mechanically enforced by `tests/unit/fdh1Isolation.test.ts`).
- Tenant-referential-integrity triggers (FDH1-F1 focused hardening) closing
  the FK-existence-without-ownership gap for the two relationships FDH-3
  introduces.
- A **hard, code-level production gate**
  (`lib/financial-data-hub/constants/featureFlags.ts#isFdhDocumentUploadEnabled`)
  that refuses real uploads outright unless the configured Supabase project
  is the one specific certified DEV project ref — independent of any env
  var, so a misconfigured flag cannot accidentally enable uploads in
  production. **Confirmed still in force; LR-1 does not touch this file and
  production uploads remain disabled.**

This is a strong foundation. LR-1 reuses every one of the above unchanged.

## 2. The gap LR-1 found and closed

FDH-3's original design intentionally kept the raw file through a multi-day
"evidence" grace window after approval (`FDH_DOCUMENT_RETENTION_DAYS.approved
= 7`), on the stated basis that FDH-3 itself implemented no extraction, so no
document could reach `approved` through real use — the multi-day constant
existed for completeness, not because anything called it. FDH-4 through
FDH-16 (see `MEMORY.md`/`scripts/fdh*`) subsequently built six real
ingestion pipelines on top of the FDH-1/FDH-3 schema — bank CSV, bank PDF,
payslip, AU investment statement, retirement statement, liability statement
— all of which write real bytes to `fdh-source-documents` today (subject to
the production gate above still being closed).

**Central finding (P1 — disclosed, not buried):** a repository-wide search
for every caller of the purge-execution functions
(`scheduleApprovedDocumentPurge`, `findDuePurges`, `runPurgeAttempt`,
`sweepAbandonedUploadSessions`) found **zero callers anywhere in application
code** — only test/certification scripts. Specifically confirmed by reading:

- `lib/financial-data-hub/services/approvalService.ts#approveStatement` —
  the single central approval path used by the bank-csv/bank-pdf
  transaction-review pipeline — advances `processing_status` to `approved`
  and persists the Approved Financial Summary, but never scheduled a purge.
- `app/api/financial-data-hub/investment-statement/[documentId]/apply/route.ts`,
  `.../retirement-statement/[documentId]/apply/route.ts`,
  `lib/financial-data-hub/services/investmentStatementProcessingService.ts`,
  `retirementStatementProcessingService.ts` — none reference purge at all.
- `lib/financial-data-hub/services/uploadLifecycle.ts#userDeleteDocument`
  (the explicit user-delete path) correctly marks
  `raw_document_purge_status = 'pending'` with `raw_document_purge_due_at =
  now()`, but that alone does not delete anything — nothing then calls
  `runPurgeAttempt` to actually execute it.
- No cron/scheduler endpoint of any kind existed for FDH purge (only
  `app/api/reports/cron/monthly-generate` exists, for an unrelated job).

**Practical effect before this fix:** in the current, running application, a
raw document that reached Supabase Storage had **no code path that would
ever automatically delete it** — not on approval, not on rejection, not on
an abandoned upload, and not from a scheduled sweep. `raw_document_purge_status`
would sit at `not_required` or `pending` indefinitely. This is exactly the
"indefinite raw retention contrary to policy" class of finding LR-1 exists
to catch. It is a **P1**, not a P0: it is not an active cross-user or public
exposure (storage RLS/ownership checks and the production upload gate are
both intact and unaffected), and given the production gate, it has zero
production impact today — it affects only DEV/local data. It is disclosed
here rather than buried in a general pass.

## 3. Fix implemented (Phase 2 — additive, reuses FDH-3 entirely, no migration)

No new table, no new column, no touch to migration `0058` or any historical
migration. Every change is additive:

1. **`lib/financial-data-hub/constants/retention.ts`** — rewritten from
   day-granularity ("evidence" grace windows) to minute-granularity, strict
   deletion: `approved: 0`, `rejected_or_failed: 0`,
   `abandoned_minutes: 20`. Added `FDH_DOCUMENT_RAW_MAX_LIFETIME_MINUTES =
   60`, the absolute hard backstop the LR-1 spec requires ("if none exists,
   implement a 60-minute maximum raw-file lifetime from receipt"). No
   existing shorter certified limit was found, so 60 minutes is the bound
   implemented. This is technically safe because Review/Approve/Apply were
   already confirmed (by reading every apply route) to operate only on
   structured staging tables (`fdh_transactions`, `fdh_investment_statement_activities/positions`,
   the Approved Financial Summary, etc.) — never the raw object — so a raw
   file becoming unavailable after 60 minutes cannot break any working
   review/approval/apply flow.
2. **`lib/financial-data-hub/domain/rawFileBackstop.ts`** (new, pure,
   no I/O) — `decideRawFileBackstopAction()`: given a document's current
   processing/purge status and receipt time, decides whether to force it
   into the purge lifecycle, mirroring `userDeleteDocument`'s own two
   branches (approved → `purge_pending`; anything else pre-terminal →
   `rejected`) but as a system actor driven by age rather than a user click.
   Fully unit-tested without a database — see `tests/unit/lr1UploadSecurityRawFileLifecycle.test.ts`.
3. **`lib/financial-data-hub/services/purge.ts`** —
   `enforceRawFileHardBackstop()` (new): the I/O wrapper around the above,
   querying `fdh_statement_uploads` for any row with a live storage
   reference not already purged/mid-purge, applying the pure decision, and
   recording an audit event when it forces a schedule. This is the universal
   safety net — it does not depend on any of the six ingestion pipelines
   individually remembering to call a purge-scheduling function, because it
   acts on the shared table generically by age.
4. **`lib/financial-data-hub/services/approvalService.ts#approveStatement`**
   — now calls `scheduleApprovedDocumentPurge(approvedStatement)`
   immediately after the Approved Financial Summary insert succeeds (i.e.
   **after** structured staging is durably written, **before** returning to
   the caller) — the LR-1 "critical ordering rule" applied at the one
   central approval path that actually reaches `processing_status =
   'approved'` today. Wrapped so a purge-scheduling failure never fails an
   otherwise-successful approval (the hard backstop above still catches the
   document regardless).
5. **`app/api/financial-data-hub/documents/cron/purge-sweep/route.ts`**
   (new) — the orphan janitor endpoint. Reuses the exact
   `x-cron-secret`/`CRON_SECRET` auth pattern already established by
   `app/api/reports/cron/monthly-generate/route.ts` (no new auth mechanism).
   In order: `sweepAbandonedUploadSessions()` →
   `enforceRawFileHardBackstop()` → `findDuePurges()` +
   `runPurgeAttempt()` per row. Response carries only counts and document
   ids — never a storage key, signed URL, or filename (verified by a
   dedicated test, see below). **No wrapper for `pg_cron`/`pg_net` scheduling
   was created** — the same disclosed gap FDH-3 already carried (a purge
   attempt must call the Storage HTTP API, which SQL/`pg_cron` cannot do
   directly); an external scheduler or manual/DEV-verification trigger is
   the documented invocation path, identical in shape to the existing
   reports cron.

None of the six ingestion pipelines' extraction/processing services were
modified — the hard backstop covers all of them uniformly without needing
per-pipeline changes, which keeps this the smallest fix that makes the
strict-deletion promise technically true, per the dispatch's explicit
preference.

## 4. Retained vs. deleted — exact breakdown

**Retained after purge** (unchanged from FDH-3's `buildStatementUploadPurgePatch`,
not modified by LR-1): `document_type`, `institution_id`, `country_code`,
`source_type`, `file_hash` (per-user duplicate detection only, never
cross-tenant, excluded from the admin allowlist), all processing/quality/
reconciliation status columns, all extracted structured data already written
to `fdh_transactions`/`fdh_investment_statement_activities`/`fdh_investment_statement_positions`/
`fdh_approved_financial_summaries`/equivalent per-pipeline staging tables,
and the audit trail (`fdh_document_audit_events`) — event type, actor,
timestamps, and a small non-sensitive jsonb `metadata` (counts and ids only,
never document content).

**Deleted** (nulled by the unmodified FDH-1 purge patch, and the underlying
object independently verified absent by `verifyDocumentObjectAbsent()`):
`raw_document_storage_reference`, `original_filename_sanitised`, and the
Storage object itself.

**Never persisted anywhere in this codebase** (confirmed by the structural
regression scan in section 6): a public bucket, a `raw_file`/`document_blob`/
`ocr_full_text`/`full_document_text` column, a document-evidence-vault
module, a permanently retained base64 copy, or a logged signed URL.

## 5. Threat table

| Threat | Existing control (FDH-3) | Gap found | LR-1 change | Verification |
|---|---|---|---|---|
| Cross-user object access | Storage SELECT policy scoped to `(storage.foldername(name))[1] = auth.uid()`; ownership check in every API route | None found | — | Code read; live-DEV re-proof requires credentials (see gaps, section 7) |
| Public bucket exposure | Bucket created private via Storage Admin API; no SQL ever marks it public | None found | Added a structural regression test asserting no migration ever sets `storage.buckets.public = true` | `tests/unit/lr1UploadSecurityRawFileLifecycle.test.ts` |
| Predictable object paths | Opaque `{user_id}/{document_id}/{document_id}.bin`, server-generated | None found | — | Code read (`services/storage.ts`) |
| Signed URL leakage | No signed URL for the upload path (server-mediated); read-path signed URLs short-lived | Not verified this session that a signed URL is never logged | Added a scan asserting the new cron route never calls `createSignedUrl` and never echoes one in its response | Test suite |
| Malicious PDF / active content | No JS/embedded-file execution from parsed documents (FDH doesn't render/execute document content, only extracts bytes for parsing) | Not independently re-verified this session | — | Disclosed as not re-verified (see section 7) |
| MIME spoofing | Content-signature validation (`fileValidation.ts`), not extension/client MIME | None found | — | `fdh3UploadTestPack.test.ts` (existing, re-run, passing) |
| Oversized files | Server-side size limit, authoritative | None found | — | `fdh3UploadTestPack.test.ts` |
| Archive bombs | No archive extraction anywhere in the FDH pipeline (PDF/CSV only) | N/A — no archive support to guard | — | Code read (MIME allowlist is `application/pdf`, `text/csv` only) |
| Parser crashes | `processing_status: 'failed'` transition exists | Not independently timeout-tested this session | — | Disclosed as not re-verified |
| SSRF via embedded URLs | No evidence FDH parsers follow embedded links | Not independently re-verified this session | — | Disclosed as not re-verified |
| Path traversal | Server-generated opaque keys; no user-supplied path segment ever reaches storage | None found | — | Code read |
| **Raw-file orphaning (indefinite retention)** | Purge state machine + verified delete existed but had **zero live callers** | **P1 — confirmed, see section 2** | Wired `scheduleApprovedDocumentPurge` into the central approval path; added `enforceRawFileHardBackstop` (60-min hard cap) + a cron janitor that actually invokes the sweep | `tests/unit/lr1UploadSecurityRawFileLifecycle.test.ts` (pure logic); live-DEV execution proof is a disclosed gap (section 7) |
| Deleted-but-versioned objects | Supabase Storage bucket not configured with object versioning (standard FHIP bucket pattern) | Not independently re-verified this session | — | Disclosed as not re-verified |
| Log leakage | `runPurgeAttempt`'s error path redacts URLs and caps length before persisting | None found | New cron route logs nothing beyond aggregate counts | Test suite |
| DB raw-content leakage | `metadata jsonb` columns code-review-disciplined, never a full-document column | None found | Added a migration-wide regression scan for forbidden raw-content column names | Test suite |
| Staging-to-canonical bypass | `applyAuStatementActivity`/`applyAuStatementPosition` are the only canonical-write paths (per-row atomic/idempotent) | Not touched by LR-1 | — | Unchanged |
| Replay/duplicate Apply | Existing `apply_status` per-row gating; `approveStatement` approval idempotent | Not touched by LR-1 | — | Unchanged |

## 6. Structural regression coverage (new)

`tests/unit/lr1UploadSecurityRawFileLifecycle.test.ts` (14 tests, all
passing) — pure decision-logic tests for the new backstop, plus a
source/repo-search-based architectural-invariant scan asserting: no
migration ever marks a bucket public; no migration adds a forbidden
raw-content column (`raw_file`, `document_blob`, `ocr_full_text`,
`full_document_text`, `document_bytes`, `raw_content`, `file_base64`); no
`*evidenceVault*`/`*documentVault*` module exists anywhere under `lib/` or
`app/`; the purge service's only captured raw error text goes through URL
redaction + a length cap and is never `console.log`'d; the new cron route
requires the shared secret and never echoes a storage key/signed
URL/filename in its response; and the retention module documents the
strict-deletion policy (no silent revert to the old day-based constant).

## 7. Aggregate DEV baseline counts (no PII)

Not obtained this session — this sandboxed worktree has no
`NEXT_PUBLIC_SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` configured (checked;
absent from both the shell environment and any `.env*` file present). See
section 8 for the full list of gates this blocks.

## 8. Evidence gaps — disclosed, not silently skipped

This sandboxed worktree has **no live Supabase DEV credentials** and **no
AWS Amplify console access** (the same class of gap disclosed on every prior
track in this project's history — see `MEMORY.md`). Concretely blocked by
this:

- Phase 1's aggregate DEV baseline counts (how many `fdh_statement_uploads`
  rows currently sit in each `raw_document_purge_status`/`processing_status`
  today) — cannot query DEV without credentials.
- Phase 4's six live-DEV fixtures (A-F), including the two real synthetic
  authenticated DEV users required for the cross-user tests, and the
  mandatory "raw object 404s, then Review still renders" proof.
- Verifying the new `documents/cron/purge-sweep` route actually executes
  end-to-end against live storage (fails-closed on a bad/missing secret is
  verifiable by inspection of the code — `secret !== process.env.CRON_SECRET`
  rejects any mismatch or absence with 401 — but the accepted-path execution
  needs a live call).
- Phase 5's production certification (synthetic marker-document round trip)
  and the Amplify-deployment-SHA proof.
- Independently re-verifying the "not independently re-verified this
  session" rows in the threat table (parser timeouts, SSRF-via-embedded-URL,
  storage object versioning) against live behavior rather than code reading
  alone.

**This audit and the Phase 2 fix are genuine, complete, and tested to the
limit of what static analysis, unit tests, `tsc`, `eslint`, and a full
`next build` compile can prove in this environment.** They do not
substitute for the live-DEV and production proof the dispatch requires
before a merge. See the final report for the resulting verdict.
