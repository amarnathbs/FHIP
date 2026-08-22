# FDH-3 — Storage Security

## 1. Bucket

`fdh-source-documents`, created via the Storage Admin API
(`scripts/fdh3_create_storage_bucket.mjs`), **not** SQL — identical
precedent to `report-exports` and `investment-source-documents`.

Live configuration on DEV (project `vqycarelcoijzwlpkpcz`), verified
2026-08-22:

| Property | Value |
| --- | --- |
| `public` | `false` |
| `file_size_limit` | `20971520` (20 MB) |
| `allowed_mime_types` | `["application/pdf", "text/csv"]` |

Verified live with `scripts/fdh3_dev_certification.mjs` (11/11 passing): the
bucket's own public URL does not serve an uploaded object (HTTP 400), and an
anonymous-key `download()` call is refused.

## 2. Object key convention (spec section 12)

`{user_id}/{document_id}/{document_id}.bin` — two UUIDs FHIP already
controls. No filename, institution, account number or email address ever
appears in a storage key. Built by
`lib/financial-data-hub/domain/uploadSession.ts#buildOpaqueStorageKey`,
unit-tested to assert the key never matches `/statement|bank|@|\.pdf$|\.csv$/i`.

## 3. Who can write

**Nobody, from the browser.** The bucket has exactly one `storage.objects`
policy — a SELECT policy scoped to the caller's own folder
(`(storage.foldername(name))[1] = auth.uid()::text`). There is no
INSERT/UPDATE/DELETE policy for the `authenticated` role at all. Every write
(`upload`, `remove`) goes through the service-role client in
`lib/financial-data-hub/services/storage.ts`, and that file is called only
after `services/uploadLifecycle.ts` or `services/purge.ts` has already
established ownership through the normal RLS-scoped repositories.
`tests/unit/fdh3SchemaContract.test.ts` asserts the storage-policy list
literally equals `['select']`.

## 4. Who can read

- **The owning user, indirectly, via a short-lived signed URL** —
  `createDocumentPreviewUrl()` (60-second TTL, matching the existing
  `report-exports` download route exactly), issued only after
  `requestDocumentPreview()` confirms the caller owns the document and it has
  not been purged or begun purging.
- **The owning user, directly, via the SELECT policy** — defence in depth;
  the shipped product surface never exercises this path (it always goes
  through the signed-URL route), but it is there and tested
  (`scripts/fdh3_rls_certification.mjs`) so a future direct-read need does
  not require a schema change.
- **Nobody else.** No admin route, no admin viewer, no download-by-admin
  function exists anywhere (Product Owner Decision 3) —
  `tests/unit/fdh1Isolation.test.ts`'s "confines storage/signed-URL access to
  services/storage.ts" test greps the entire FDH tree for this.

## 5. Browser security (spec section 26)

`SUPABASE_SERVICE_ROLE_KEY` is read only inside
`lib/supabase/admin.ts#createAdminClient()`, a server-only module. Static
scan (`git grep`) over `app/` and `components/` for `SUPABASE_SERVICE_ROLE_KEY`,
`service_role` and `storage admin` outside `lib/supabase/admin.ts` and the
three approved FDH-3 service files returns zero matches — see
`FDH3_COMPLETION_REPORT.md` section "Security Static Analysis" for the exact
command and result.

## 6. Malware / unsafe-file handling (spec section 23)

**Current control:** a strict allowlist (PDF, CSV only — no EXE, JS, HTML,
ZIP, RAR, DOCM), magic-byte verification that the bytes actually match the
declared type (`lib/financial-data-hub/domain/fileValidation.ts`), no
automatic execution of any uploaded content, no HTML rendering of raw
bytes, and no inline browser execution path (the preview flow — not built in
FDH-3 beyond the signed-URL primitive — would render a PDF through the
browser's native PDF viewer via `<a>`/redirect, never `dangerouslySetInnerHTML`
or an `<iframe srcDoc>`).

**Residual risk:** no third-party malware/AV scanning engine is integrated.
A PDF or CSV that passes magic-byte and structural checks but embeds a
malicious payload (e.g. a PDF with an exploit targeting a vulnerable reader)
would not be caught. This is honestly disclosed, not hidden — see
`FDH3_SECURITY_THREAT_MODEL.md`, threat "malicious file upload".

**Future integration point:** `services/uploadLifecycle.ts#completeUpload()`
has one clearly-marked call site (immediately after `validateUploadedFile()`
and before `uploadDocumentObject()`) where a scanning call would slot in
without restructuring the pipeline.

## 7. Rate limiting (spec section 93)

20 upload-session creations per rolling hour per user
(`MAX_UPLOAD_SESSIONS_PER_HOUR` in `services/uploadLifecycle.ts`), checked by
counting the caller's own recent `fdh_upload_sessions` rows (RLS-scoped, no
service-role needed for this check). Chosen as generously above any
legitimate single-sitting document-upload session while still bounding
storage-abuse/flooding risk. Not an enterprise quota system by design.
