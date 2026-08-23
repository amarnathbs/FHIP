# FDH-3 — Upload API

Five focused routes under `app/api/financial-data-hub/documents/**`, matching
the existing `report-exports` route-per-concern convention rather than one
giant endpoint (spec section 27).

## `POST /api/financial-data-hub/documents/upload-sessions`

`createUploadSession()`. Body: `{ document_type, source_type?, institution_id?,
country_code, currency_code?, declared_mime_type, declared_file_size_bytes }`
(validated by `validation/uploadSession.ts#fdhCreateUploadSessionSchema`,
including the per-type size limit). Requires auth (`requireUser()`) and the
`isFdhDocumentUploadEnabled()` feature gate. Creates a `fdh_statement_uploads`
row (`processing_status = 'created'`) and a `fdh_upload_sessions` row (15-minute
expiry). Returns `{ document_id, session_id, expires_at, allowed_mime_type,
max_size_bytes }` — **no storage credential of any kind**. Rate-limited (20
sessions/hour/user → HTTP 429).

## `POST /api/financial-data-hub/documents/upload-sessions/{sessionId}/complete`

`completeUpload()`. The request body **is** the file bytes (`Content-Type` set
to the declared MIME type). Requires auth + the feature gate. A hard,
pre-session-lookup `Content-Length` check refuses anything over the largest
allowed size (20 MB) before the body is even read into memory. Then:
session ownership + liveness check → `validateUploadedFile()` (allowlist,
size, magic bytes, MIME agreement, password-detection, hashing) → on failure,
session and document both marked failed with a controlled code, no storage
write attempted → on success, upload to storage → **verify the object
actually exists** (never trust the browser's claim) →
`uploaded → validating → queued` (or `→ rejected` if password-required) →
queue-handoff job created. Returns `{ document_id, processing_status,
error_code }`.

## `GET /api/financial-data-hub/documents`

`listDocuments()`. Auth only — **never gated by the upload feature flag**, so
a user can always see documents they already have. Returns each document plus
a user-facing status label (never a raw enum name).

## `GET /api/financial-data-hub/documents/{documentId}`

`getDocumentStatus()`. Auth + ownership (`getForUser`, RLS-scoped). Returns
the document row, the derived upload substate, and the status label.

## `DELETE /api/financial-data-hub/documents/{documentId}`

`userDeleteDocument()`. Auth + ownership. Never gated by the upload flag.
Transitions the document toward `rejected` (or `purge_pending` if already
`approved`) and schedules an immediate purge — see
`FDH3_DOCUMENT_LIFECYCLE.md` section 1 for the exact transition path. Refuses
with 409 if the document is already purged.

## `GET /api/financial-data-hub/documents/{documentId}/preview`

`requestDocumentPreview()`. Auth + ownership + not-purged check, then a 302
redirect to a 60-second signed Storage URL — the exact same pattern as the
existing `app/api/report-exports/[exportId]/download/route.ts`. Refuses
(404/410) once the document is purged or purge has begun.

## Authorization discipline (spec sections 28-29)

Every route calls `requireUser()` first and derives `user.id` from the
authenticated session — never from a client-supplied `user_id`/`household_id`
field (none of the request bodies above even accept one). Every downstream
repository call is scoped by that server-derived `user.id` via `getForUser`,
so even a forged `document_id`/`session_id` belonging to another tenant
resolves to "not found" (404), never another user's row — verified live via
`scripts/fdh3_rls_certification.mjs`'s tenant-isolation checks (the same RLS
these repositories rely on).

## What FDH-3 deliberately does not implement

No parser trigger endpoint, no classification endpoint, no admin document
endpoint. `services/index.ts#documentUploadService` is the only public
service surface; nothing in it accepts a caller-supplied ownership claim.
