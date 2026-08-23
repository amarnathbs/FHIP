# R1 — Source Storage Report

Status: FINAL
Governing docs: `R0_SOURCE_PROVENANCE_CONTRACT.md` section 4, `R1_IMPLEMENTATION_SPEC.md` section 4, spec sections 14-15.

## 1. What was actually created

A real, private Supabase Storage bucket, **`investment-source-documents`**, created live on the DEV project (`vqycarelcoijzwlpkpcz`) via the Storage Admin API (`POST /storage/v1/bucket`, using the service-role key) — **not** a design description, an actually-existing bucket. This mirrors the exact precedent set by the pre-existing `report-exports` bucket, whose own migration comment (`0022_report_pdf_export.sql`) explicitly notes bucket creation "isn't a SQL-editor operation" — bucket creation in this project has never been done via SQL, in R1 or in any prior release.

Verified live configuration (`GET /storage/v1/bucket/investment-source-documents`, run 2026-08-19):

```json
{
  "id": "investment-source-documents",
  "name": "investment-source-documents",
  "public": false,
  "file_size_limit": 20971520,
  "allowed_mime_types": ["application/pdf", "text/csv"]
}
```

## 2. Why this was possible despite the "no DDL on DEV" constraint

Bucket creation and object upload/download go through Supabase's **Storage REST API**, a separate HTTP subsystem from raw Postgres DDL execution. The standing project constraint ("no direct Postgres connection string to DEV, no Supabase CLI project link") blocks `CREATE TABLE`/`ALTER TABLE`/RLS-policy SQL — it does not block calling the Storage Admin API with the service-role key, which is exactly the mechanism the existing codebase already uses for buckets (confirmed above). This was verified directly before relying on it: `GET /rest/v1/countries` (200, real data returned), `GET /storage/v1/bucket` (200, listed the pre-existing `report-exports` bucket), `GET /rest/v1/ii_sources` (404, `PGRST205` — confirming the DDL wall is real and this Storage-API path is a genuinely separate capability, not an accidental workaround of the same wall).

## 3. Object path convention

`{user_id}/{randomUUID()}.{ext}` — a **server-generated canonical key**, never a user-provided filename (spec section 14). Implemented in `lib/services/investment-intelligence/storage.ts`'s `generateObjectKey()`. Scoping by `user_id` first means an accidental cross-user path guess is non-functional even before RLS/signed-URL protection is considered, matching `report-exports`' identical `"{user_id}/{report_id}/{export_id}.pdf"` convention.

## 4. File validation

`lib/services/investment-intelligence/storage.ts`'s `validateUploadedFile()` (pure, unit-tested in `tests/unit/iiStorage.test.ts`) checks, in order: extension is in the allowlist (`pdf`, `csv`), declared MIME type is in the allowlist (`application/pdf`, `text/csv`), extension and MIME type **agree** with each other (closes the "rename a `.exe` to `.pdf`" gap — neither is trusted alone), file is non-empty, file is within the 20MB limit. This is enforced **twice**: once in the API route before any Storage call, and again by the bucket's own `allowed_mime_types`/`file_size_limit` configuration at the Storage layer itself — confirmed live (STOR-003, STOR-004 below).

## 5. Upload/download lifecycle

- **Upload**: `app/api/investment-intelligence/source-documents/route.ts` (`POST`) — authenticated (`requireUser()`) → file validated → checksum computed (`sha256`) → re-upload dedup check (`unique(user_id, checksum)` — this half is DB-dependent, currently BLOCKED, see below) → service-role upload to the private bucket → `ii_source_documents` row created (also DB-dependent, BLOCKED) → audit event emitted.
- **Download**: no direct-download route was built in R1 (not required by the acceptance checklist — R1 is a data foundation, not a UI release); `lib/services/investment-intelligence/storage.ts`'s `createSourceDocumentSignedUrl()` exists and is ready for a future download route, mirroring `report-exports`' proven `createSignedUrl(path, 60)` pattern exactly (60-second expiry).
- **Delete**: `deleteSourceDocumentObject()` exists; no route wires it to a user-facing action in R1 (archive/retention UX is R2+ scope per the spec's own "document lifecycle" framing — the underlying storage primitive is proven live, see STOR-008 below).

## 6. Live storage security test results (run via `scripts/ii_r1_live_dev_security_tests.mjs`, 2026-08-19)

| Test | Result | Evidence |
|---|---|---|
| STOR-001 (unauthenticated cannot access private file) | **PASS** | Anon-key request to the object with no session → HTTP 400 |
| STOR-002 (User A cannot access User B's file) | **PASS** (partial — see caveat) | User B's authenticated request to User A's object → HTTP 400. Caveat: this currently passes because *no* non-service-role principal has any grant yet (migration `0037` not applied) — it does not yet separately prove "User A CAN read their own object via a direct request." The actual production read path (signed URL) already works correctly today regardless (see STOR-006) since it doesn't depend on this policy. |
| STOR-003 (invalid MIME rejected) | **PASS** | Uploading `application/x-msdownload` content → HTTP 400 from the bucket's own `allowed_mime_types` |
| STOR-004 (oversized file rejected) | **PASS** | Uploading 20MB+1KB → HTTP 400 from the bucket's own `file_size_limit` |
| STOR-005 (object references correct household/source document) | **BLOCKED** | Needs `ii_source_documents` table (migration `0032`) to verify the linkage row |
| STOR-006 (signed URL expires per design) | **PASS** | A 2-second-TTL signed URL: immediate fetch → HTTP 200; fetch after 3.5s → HTTP 400 |
| STOR-007 (public URL cannot be generated accidentally) | **PASS** | Bucket config confirmed `public: false` |
| STOR-008 (delete/archive lifecycle follows retention policy) | **PASS** (storage half) / **BLOCKED** (retention-policy half) | Service-role delete then fetch → object genuinely gone (HTTP 400). The *policy* tie-in to `ii_source_documents.status` transitions needs that table. |

Full raw output and the exact HTTP statuses are reproducible by running `node scripts/ii_r1_live_dev_security_tests.mjs` from the repo root (requires `.env.local`).

## 7. What is NOT yet proven (honest gap)

- STOR-005 and the retention-policy half of STOR-008 require `ii_source_documents` to exist on DEV.
- The "true owner can read their own object" half of STOR-002/SEC-007 requires migration `0037`'s RLS policy applied — the storage-layer isolation proven above is a **superset**-safe state (nobody but service-role can read anything yet), not yet the final steady state (owner can, others can't).
- No end-to-end upload → parse → certify → publish flow was exercised against a real uploaded PDF byte stream in this sandbox — the manual test importer (which does exercise the full downstream chain) uses fixture JSON, not a real file, by design (spec section 8 — it is explicitly not the CAS parser).
