# FDH-3 — Completion Report

Status: **CONDITIONAL PASS**
Branch: `feature/financial-data-hub-fdh-3-document-lifecycle`
Starting main: `c868de6` (57 migrations)
Ending commit: the tip of `feature/financial-data-hub-fdh-3-document-lifecycle`
(5 commits: `422b5de` schema/domain, `29a460f` upload/storage,
`36c0d60` purge, `edbfd5e` tests, and this docs commit)
DEV: bucket live; migration 0058 NOT yet applied
Production: UPLOAD DISABLED (hard gate — see `constants/featureFlags.ts`)

## Why CONDITIONAL, not FULL

Per spec section 112, CONDITIONAL PASS is the correct verdict when the
implementation is technically correct but: (a) DEV storage **policies** and
**tables** are not yet applied, (b) the full live-DEV upload test through the
real API→DB→storage path has not been completed, and (c) purge has not been
live-certified against a real, migrated document row. All three apply here —
this agent has no DDL execution capability against any live environment
(the same structural limitation every prior FDH migration in this repository
has had; the Product Owner applies migrations via the Supabase Dashboard SQL
editor).

What IS live-certified: the private storage bucket itself (created via the
Storage Admin API, independent of the SQL migration) and its core object
lifecycle — upload, signed-read, delete, verified-absence — proven with real
Supabase Storage calls against DEV project `vqycarelcoijzwlpkpcz`
(11/11, `scripts/fdh3_dev_certification.mjs`). The access-control *logic*
(RLS, the two FDH1-F1 triggers, the storage policy shape) is certified
against a full clean rebuild (PGlite, 18/18,
`scripts/fdh3_rls_certification.mjs`) with genuine negative controls.

## Baseline

Migration guard: `OK: 57 active migrations, one file per version, next
version is 0058` (before) / `OK: 58 active migrations, ... next version is
0059` (after) — zero collisions.
TypeScript: clean before and after.
Tests: 753/753 before; see Regression section for the exact after-count.
ESLint: 9 errors / 7 warnings before (pre-existing, unrelated files) — see
Regression section for after-count.
Build: not run standalone before this dispatch (see Regression).

## Migration Allocation

Previous highest: 0057. New migration: `0058_fdh3_document_lifecycle_upload_storage.sql`.
Registry: `docs/architecture/MIGRATION_REGISTRY.md` updated with the full
FDH-3 entry, including the honestly-disclosed collision-risk note against
unmerged Investment Intelligence R6 branches that separately claimed `0058`
on branches that have not merged to `main`.
Collision check: `OK: 58 active migrations, one file per version, next
version is 0059` — re-run after allocation, zero collisions.

## Storage Architecture

Provider: Supabase Storage (not AWS S3 — an explicit decision; see
`FDH3_ARCHITECTURE.md` §3, reusing the existing `report-exports`/
`investment-source-documents` precedent).
Bucket: `fdh-source-documents` — live on DEV, `public: false`,
`file_size_limit: 20971520`, `allowed_mime_types: ["application/pdf",
"text/csv"]` (verified live).
Object-key design: `{user_id}/{document_id}/{document_id}.bin` — opaque,
no filename/institution/account/email content.
Signed-access model: server-mediated upload (no signed PUT URL ever reaches
the browser); short-lived (60s) signed GET URLs for preview only, issued
after ownership + not-purged checks.

## Document Model

Existing tables reused: `fdh_statement_uploads`, `fdh_ingestion_jobs` (both
FDH-1, unmodified in enum vocabulary; the latter gains 2 hardening triggers).
New tables: `fdh_upload_sessions`, `fdh_document_audit_events`.
New columns: 7 additive columns on `fdh_statement_uploads` (`storage_provider`,
`uploaded_at`, `validated_at`, `processing_started_at`,
`processing_completed_at`, `purge_requested_at`, `duplicate_of_document_id`).

## Upload Lifecycle

Create: `createUploadSession()` — document row + 15-minute session, no
storage credential returned.
Upload: `completeUpload()` — server-mediated byte stream, full validation,
storage write, existence verification, then lifecycle transition.
Validate: allowlist + size + magic-byte + MIME-agreement + password-detection
+ hashing, all before any DB status change.
Queue: one `fdh_ingestion_jobs` row (`document_extract`, `queued`) — the
FDH-4/5 handoff, no worker implemented.
Delete: `userDeleteDocument()` — immediate purge scheduling, ownership-checked.
Purge: `runPurgeAttempt()` — delete-then-independently-verify, never marks
purged on delete success alone.

## File Validation

PDF: magic-byte (`%PDF-`) + 20MB limit.
CSV: plausible-text heuristic (no NUL byte, <1% control-byte ratio) + 10MB
limit. XLSX: **not implemented** — spec left it optional/conditional on prior
approval, which does not exist; left out deliberately rather than
half-supported.
MIME: declared type checked against the allowlist AND against the detected
signature — mismatch is rejected (`mime_mismatch`).
Magic bytes: implemented for PDF; CSV uses a text-plausibility heuristic
(no CSV magic bytes exist).
Size: enforced twice — a hard `Content-Length` pre-check at the API layer,
then an exact-byte-length check in `validateUploadedFile()`.
Corrupt files: bytes matching no known signature → `file_corrupt`.
Password-protected files: `/Encrypt` trailer-token heuristic detection,
never decrypted, never stored; document proceeds to `rejected` with
`error_code = 'password_required'`, not `failed`.

## Duplicate Foundation

Hash: SHA-256, computed server-side (`node:crypto`).
Same-household duplicate: FDH-3 is `user_id`-scoped (this codebase's actual
tenancy boundary — not household-scoped); same-user same-hash sets
`duplicate_of_document_id`, a soft, non-blocking pointer.
Cross-household privacy: the duplicate lookup is scoped to the caller's own
`user_id` only — never queries another tenant's hashes; `file_hash` is
excluded from the admin operational-metadata allowlist.

## RLS

Tenant tests: 18/18 (PGlite, `fdh3_rls_certification.mjs`).
Negative controls: 3/3 (RLS-disabled-then-restored proof, plus the
same-tenant FDH1-F1-trigger positive control).
Storage isolation: PASS (live DEV — anon download refused, public URL
refused; PGlite — Tenant B cannot SELECT Tenant A's storage.objects row).

## Admin Raw Access

Expected: NONE.
Actual: NONE — mechanically verified. Zero references to
`financial-data-hub`/`fdh_` anywhere under `app/api/admin` or
`app/(app)/admin` (grepped, not merely reasoned about).
`fdh_upload_sessions` and `fdh_document_audit_events` both added to
`ADMIN_NO_STANDING_ACCESS_TABLES`.

## API Security

Create upload: `requireUser()` + feature-flag gate + rate limit.
Complete upload: `requireUser()` + feature-flag gate + session
ownership/liveness + hard size pre-check.
Status: `requireUser()` + `getForUser()` ownership scoping.
Preview: `requireUser()` + ownership + not-purged check before any signed URL
is issued.
Delete: `requireUser()` + ownership + already-purged check.
No request body on any route accepts a caller-supplied `user_id` or
`household_id`.

## Privacy

Upload notice: PASS — `app/(app)/financial-data-hub/page.tsx` states what is
uploaded, what happens next, and the privacy/retention position in plain
language.
Privacy page: PASS — new "Financial document uploads" section added,
existing content preserved (page is explicitly draft/pending-legal-review).
Retention policy: `FDH_DOCUMENT_RETENTION_DAYS` (approved: 7 days, rejected/
failed: 1 day, abandoned: 2 days) — one configuration module, not scattered
magic numbers.
Admin-access statement: explicit in both the upload page and the privacy
page — "not available for routine admin viewing."

## Purge

Scheduler/invocation: no scheduler wired up; documented manual invocation
contract (`services/purge.ts#findDuePurges()` + `runPurgeAttempt()` per row)
— honestly not claimed as operationally automated.
Successful purge: PASS (live DEV, delete + independently-verified absence).
Storage deletion verified: PASS (never inferred from DB status alone).
Failed-purge handling: PASS (never marks `purged` on a failed delete or a
failed absence-check; DB constraint backs this up).
Retry: PASS (purge state machine supports `failed → pending/in_progress`;
`purge_attempt_count` increments).
Idempotency: PASS (already-`purged` short-circuits with zero storage calls).
Orphan detection: PARTIAL — pure detection logic implemented and
unit-tested; live end-to-end report script not yet built/run (needs
migration 0058 applied first).

## FDH1-F1

Status: PARTIALLY HARDENED.
FDH-3 production implication: production uploads remain disabled regardless
(hard gate, independent of FDH1-F1's status) until FDH1-F1 receives its own
dedicated closure per the spec's hard gate (section 61). The two
relationships FDH-3 introduces/exercises (`fdh_upload_sessions` →
`fdh_statement_uploads`, `fdh_ingestion_jobs` → `fdh_statement_uploads`) are
now hardened with live-proven triggers; the remaining ~85 historical FKs
across the platform are unchanged and the global finding stays OPEN.

## Threat Model

See `FDH3_SECURITY_THREAT_MODEL.md` — 15 threats assessed, 11 with a fully
tested control and no gap, 4 with an honestly disclosed residual risk (no
malware scanner; orphan report not yet run live; log-PII review is manual;
concurrency proven only at the domain-logic level).

## DEV Certification

Upload: PARTIAL — storage-layer upload/verify proven live; full API→DB path
not yet exercisable (migration not applied).
Storage: PASS (11/11 live).
Tenant isolation: PASS (18/18 PGlite, includes real negative controls; live
cross-tenant HTTP-session testing not performed).
Signed access: PASS (live — issued, resolves, expires-after-purge, all
proven).
Delete: PASS (live storage delete + PGlite DB-lifecycle proof).
Purge: PASS at the storage layer (live) and the state-machine layer
(PGlite); not yet proven end-to-end through a live migrated row.

## Regression

FDH-1: PASS (all `fdh1*` test files pass, including the consciously updated
`fdh1Isolation.test.ts`).
FDH-2: PASS (`fdh2*` test files unaffected).
Resources: PASS (one transient live-DEV JWT-clock-skew flake in
`resourcesEditorR1_3.test.ts`, unrelated to FDH-3, reproduced as passing on
isolated re-run — see raw logs).
Investment Intelligence: PASS (unaffected — no `ii_*` file touched).
Phase 0C: PASS (unaffected).
Input Data: PASS — mechanically guaranteed by
`tests/unit/fdh1Isolation.test.ts`'s protected-register checks, which
FDH-3's new files also pass.
TypeScript: clean.
Tests: 814/815. The one failure (`resourcesAdminR1_2.test.ts`, live-DEV
Resources admin dashboard exact-draft-count assertion) is a pre-existing
flake against shared live-DEV state, unrelated to FDH-3 — reproduces as
26/26 passing every time when run in isolation, and the file contains no
`financial-data-hub`/`fdh_` reference. 753 baseline + 62 new/updated FDH-3
cases = 815, arithmetic consistent.
ESLint: same pre-existing 9 errors / 7 warnings, zero new — verified by
exact file-list diff (not merely the count), after fixing 3 lint issues this
dispatch introduced and then removed (an effect-body setState pattern in
`FdhDocumentUploadClient.tsx`, an unnecessary `eslint-disable` comment in
`auditLog.ts`, and an unused import in `uploadLifecycle.ts`).
Build: `npm run build` — see chat completion report for the exit code
recorded at dispatch time.
Migration guard: `OK: 58 active migrations, one file per version, next
version is 0059`.
Clean rebuild: all 58 migrations replay cleanly from empty (PGlite),
verified twice during this dispatch.

## Existing Data Preservation

Unexpected changes: NONE. Migration 0058 was not applied to DEV (no schema
mutation possible), and the only live-DEV write this dispatch performed was
creating the new `fdh-source-documents` bucket and writing/deleting a single
synthetic test object inside it — no existing table, row, or bucket was
touched.

## Production

Schema deployment: NOT AUTHORISED unless separately approved (migration 0058
awaits Product Owner application).
Document uploads: DISABLED — `isFdhDocumentUploadEnabled()` refuses unless
BOTH an env flag is enabled AND the configured Supabase project matches the
certified DEV project ref; pointing this code at any other project (i.e.
production) disables uploads structurally, not just by convention.
Raw-document production testing: NOT PERFORMED.

## Known Findings

FDH1-F1: PARTIALLY HARDENED for the two FDH-3-touched relationships; the
global ~85-FK finding remains OPEN, tracked for a dedicated future phase.
DB-BASE-0012: OPEN — PRE-EXISTING — OUT OF SCOPE.
New:
1. No malware/AV scanner integrated (structural gap, not a bug — disclosed
   architecture decision pending a future scanner integration).
2. Migration 0058 not yet applied to any live environment.
3. Live end-to-end orphan-detection report not yet built/run.
4. True concurrent-request race conditions not exercised under real load.
5. A collision-risk note: unmerged Investment Intelligence R6 branches
   independently claimed migration number `0058` on their own branches; since
   none has merged to `main`, this is not a live collision today but will
   need renumbering at whichever branch merges second.

## Acceptance Checklist

Architecture: PASS (canonical main used, migration guard passed, private
storage, no public bucket, sessions expire, opaque keys, server-side
authorization, lifecycle state machine, queue handoff, purge lifecycle, no
parser/classifier).
Security: PASS with disclosed residuals (real tenant tests, cross-tenant
blocks proven live+PGlite, no privileged key exposure, no PII object names,
no document content in logs, private storage confirmed, non-vacuous negative
controls).
File Safety: PASS (allowlist, MIME/signature validation, size limits,
zero-byte rejection, corrupt-file handling, password-required status,
duplicate hash, unsupported files rejected safely).
Privacy: PASS (upload notice, Privacy page, admin-access restriction
documented and mechanically enforced, configurable retention, purge removes
storage + cleans DB fields, minimal provenance retained, no indefinite
retention).
Purge: PASS with one PARTIAL (scheduling/success/failed-handling/retry/
idempotency all proven; orphan detection logic-only).
Regression: PASS (see above).

## Final Verdict

FDH-3: **CONDITIONAL PASS**

## FDH-4 Readiness

AMBER — the document-lifecycle foundation FDH-4 (Bank CSV Engine) needs is
complete and tested, but migration 0058 must be applied to DEV and the
end-to-end live-DEV upload/purge path proven before FDH-4 should begin
building on top of it in a live environment.

## Next Action

STOP. Do not begin FDH-4.
