# FDH-3 — Document Lifecycle

## 1. The canonical state machine (reused from FDH-1, one addition)

`fdh_statement_uploads.processing_status`:
`created → uploaded → validating → queued → processing → extracted →
review_required → ready_for_approval → approved → purge_pending → purged`,
with `failed` reachable from every non-terminal stage and `rejected` as a
second, separate exit.

**FDH-3 addition:** `rejected` is now directly reachable from every
pre-approval stage (`created`, `uploaded`, `validating`, `queued`,
`processing`, `extracted`, `review_required`, `ready_for_approval`, `failed`),
not only from `validating`/`review_required`/`ready_for_approval`/`failed` as
FDH-1 originally defined it. FDH-1 shipped no upload route, so there was no
user action to cancel from the earlier stages. FDH-3 spec section 47
("allow the user to delete a document before processing/approval where
safe") requires exactly this. `approved` still never transitions directly to
`rejected` — deletion of an approved document goes straight to
`purge_pending`, preserving the original design intent that "rejected" means
a review decision, while the new edges add the separate "cancellation"
meaning. See `lib/financial-data-hub/domain/documentLifecycle.ts`'s inline
comment for the full rationale, and
`tests/unit/fdh3Domain.test.ts`("FDH-3 widened document lifecycle") for the
mechanical proof neither existing test nor existing behaviour regressed.

FDH-3 **actively drives** these transitions during upload:
`created → uploaded → validating → queued` (happy path),
`created/uploaded/validating → failed` (validation failure),
`validating → rejected` (password-required — see below),
any pre-approval stage `→ rejected` (user-initiated delete),
`approved → purge_pending → purged` (purge — not exercised live by FDH-3's
own flows since no parser reaches `approved` yet, but implemented and
certified for when FDH-4/5 do).

FDH-3 does **not** drive `queued → processing → extracted → review_required
→ ready_for_approval → approved` — those belong to the parser phases.

## 2. Upload substates (spec section 14) — display only

`FDH_UPLOAD_SUBSTATES` (`UPLOAD_CREATED`, `UPLOAD_IN_PROGRESS`,
`UPLOAD_COMPLETE`, `VALIDATION_PENDING`, `VALIDATED`, `FILE_REJECTED`) are
**derived**, never a new database column, computed by
`lib/financial-data-hub/domain/uploadSubstate.ts#deriveUploadSubstate()` from
the upload session's own status plus the document's `processing_status` and
`error_code`. The canonical `processing_status` enum is untouched by this.

## 3. Password-protected PDFs (spec section 22)

A PDF whose trailer contains an `/Encrypt` reference
(`domain/fileValidation.ts#isPdfLikelyPasswordProtected`) is a **valid**
upload — never `file_corrupt`. `completeUpload()` transitions it
`validating → rejected` with `error_code = 'password_required'` and
`review_status = 'pending'`, so it is visible to the user as "needs a
password" rather than silently failed. FDH-3 attempts no decryption, persists
no password anywhere, and logs nothing about document content.

## 4. Duplicate documents (spec section 21)

At `completeUpload()` time, the document's SHA-256 hash is compared against
the caller's own other documents (`user_id`-scoped, never cross-tenant). A
match sets `duplicate_of_document_id` — a soft pointer, never a block. FDH-1's
original hard uniqueness constraint on `(user_id, file_hash)` is deliberately
replaced (migration 0058) because a hard constraint cannot express "flag but
allow" — see the migration's own comment and
`FDH3_ARCHITECTURE.md`.

## 5. Processing-queue handoff (spec section 50)

Once a document reaches `queued`, `completeUpload()` inserts one
`fdh_ingestion_jobs` row (`job_type = 'document_extract'`, `status =
'queued'`, `attempt = 0`, `max_attempts = 3`) — the interface FDH-4/5's
future parser worker will consume. No raw file content, no signed URL and no
password is placed in the job row — only identifiers. No worker is
implemented; nothing ever transitions this job out of `queued` in FDH-3.

## 6. Retry policy (spec section 51)

`fdh_ingestion_jobs` already carries `attempt`/`max_attempts`/`error_code`/
`error_message_sanitised` (FDH-1). FDH-3 does not add a new retry mechanism
for parsing (there is no parser yet); the purge lifecycle has its own retry
counter (`purge_attempt_count`) instead — see `FDH3_PURGE_CERTIFICATION.md`.

## 7. Error taxonomy split (spec section 52)

Two independently-owned vocabularies, deliberately not merged:

- `fdh_statement_uploads.error_code` — the **frozen** FDH-1 14-value
  document-processing taxonomy (`unsupported_file_type`, `file_corrupt`,
  `password_required`, ..., `internal_error`). Unmodified in migration 0058 —
  editing it in place would have broken
  `tests/unit/fdh1SchemaContract.test.ts`'s byte-for-byte check against the
  original 0045-0048 migration text.
- `fdh_upload_sessions.failure_code` — a **new**, independently-owned
  upload-MECHANICS taxonomy (`unsupported_file_type`, `file_too_large`,
  `mime_mismatch`, `file_corrupt`, `password_required`, `upload_incomplete`,
  `storage_error`, `internal_error`), covering exactly the codes spec
  section 52 lists that the frozen document taxonomy has no room for
  (`file_too_large`, `mime_mismatch`, `upload_incomplete`, `storage_error`).

## 8. Audit events (spec section 56)

Every state transition FDH-3 drives writes one `fdh_document_audit_events`
row via `services/auditLog.ts`, attributed to `user` (an explicit user
action), `system` (an automatic consequence, e.g. validation completing) or
`service` (a scheduled sweep). The complete event taxonomy:
`document_upload_created`, `document_upload_completed`, `document_validated`,
`document_rejected`, `document_queued`, `document_user_deleted`,
`document_purge_scheduled`, `document_purged`, `document_purge_failed`.
