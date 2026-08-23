# FDH-3 — Architecture

Secure Document Lifecycle: the first FDH phase that introduces real
financial-document ingestion infrastructure. Follows FDH-0 (FULL PASS),
FDH-1 (FULL PASS), the migration-lineage reconciliation (FULL PASS), and
FDH-2 (TERMINAL FULL PASS). Built from `origin/main` at `c868de6`.

## 1. Scope

FDH-3 implements: secure upload, upload-session lifecycle, document
metadata registration, private object storage, file validation
(MIME/signature/size/hash), password-protected-PDF detection, duplicate-hash
flagging, the document lifecycle state machine (reused from FDH-1),
processing-queue handoff, purge lifecycle, audit logging, upload/status/delete
UX, and RLS/storage-policy enforcement.

FDH-3 explicitly does **not** implement document extraction, OCR, CSV row
interpretation, PDF text parsing, or any classification. Those are FDH-4
(Bank CSV Engine) and later.

## 2. What already existed (FDH-1) and what FDH-3 adds

FDH-1 (migrations 0045-0048) already shipped the complete metadata model for
this phase: `fdh_statement_uploads` (with its 13-state `processing_status`
enum and its 6-state `raw_document_purge_status` enum), `fdh_ingestion_jobs`,
the document lifecycle state machine
(`lib/financial-data-hub/domain/documentLifecycle.ts`), the purge-patch
builder (`domain/privacy.ts`), and the admin operational-metadata allowlist
(`constants/adminBoundary.ts`) — all built and tested with **no storage
backend and no upload route**, explicitly reserved for FDH-3.

FDH-3 (migration 0058) adds:

- `fdh_upload_sessions` — a short-lived, single-document upload credential.
- `fdh_document_audit_events` — an append-only lifecycle audit trail
  (identical shape to the existing `ii_audit_events`).
- 7 additive columns on `fdh_statement_uploads` (observability timestamps,
  `storage_provider`, a soft `duplicate_of_document_id` pointer).
- Two `before insert or update` triggers hardening tenant-referential
  integrity for the two relationships FDH-3 introduces/newly exercises
  (FDH1-F1 focused hardening — see `FDH3_SECURITY_THREAT_MODEL.md`).
- A `storage.objects` SELECT policy for the new private bucket.
- The real service layer: `services/storage.ts`, `services/auditLog.ts`,
  `services/uploadLifecycle.ts`, `services/purge.ts`.
- The real API surface: `app/api/financial-data-hub/documents/**`.
- The real UX surface: `app/(app)/financial-data-hub/page.tsx` +
  `components/financial-data-hub/FdhDocumentUploadClient.tsx`.

No parallel `documents_v2` model was created — everything above extends the
FDH-1 shape, per the spec's explicit instruction.

## 3. Storage technology decision

**Decision: Supabase Storage**, not AWS S3. This codebase already has two
private-bucket precedents doing exactly what FDH-3 needs —
`report-exports` (migration 0022) and `investment-source-documents`
(migration 0037, Investment Intelligence R1) — both using the identical
pattern: bucket created via the Storage Admin API (not SQL), objects written
only via the service-role client after an explicit ownership check, reads via
short-lived signed URLs. FDH-3 reuses this pattern exactly rather than
introducing a second storage technology. See `FDH3_STORAGE_SECURITY.md`.

## 4. Upload mechanics: server-mediated, not direct-to-storage signed PUT

The spec allows either a signed-upload design or an internal server-mediated
design ("If signed uploads are used: ..."). FDH-3 uses the **server-mediated**
design already established by `report-exports`' upload route
(`app/api/reports/[id]/exports/route.ts`): the browser POSTs bytes to an
authenticated Next.js API route, which validates them server-side and writes
to storage via the service-role client. No storage credential of any kind —
signed or otherwise — is ever returned to the browser. `fdh_upload_sessions`
still models everything a signed-upload design would: single-document,
opaque-path, time-boxed (15 minutes), non-reusable.

## 5. Tenancy model

This codebase's tenancy boundary is `user_id`, not `household_id` — FDH-0
verified this for all 77 pre-existing tables and FDH-1 carried it forward
(`household_id` is optional, non-authoritative context, never part of an RLS
predicate). FDH-3 follows the same convention: `fdh_upload_sessions` has no
`household_id` column at all, and the opaque storage-key convention is
`{user_id}/{document_id}/{document_id}.bin`, not a `household/...` path.

## 6. Module boundary discipline

Every FDH-1/FDH-2 isolation guarantee is preserved and mechanically tested
(`tests/unit/fdh1Isolation.test.ts`, updated for FDH-3's legitimate new
surface): no import of `lib/engines/**` or `lib/services/**`, no write to any
`FHIP_PROTECTED_INPUT_TABLES` register, no Investment Intelligence table or
column restated. The one genuinely new thing FDH-3 introduces is a
service-role client, confined to exactly three files
(`services/storage.ts`, `services/auditLog.ts`, `services/purge.ts`), each
documented and test-enforced. See `lib/financial-data-hub/repositories/base.ts`'s
module comment for the full rationale.
