# 0058 reconciliation — FDH-3 schema manifest

Source: `supabase/migrations/0058_fdh3_document_lifecycle_upload_storage.sql`
(286 lines). Filename and content unchanged by the reconciliation; only the
file's header comment gained a collision note. Module: **Financial Data Hub
(FDH-3, document lifecycle)**.

## Objects touched

### New tables

| Table | Ownership | RLS | Purpose |
| --- | --- | --- | --- |
| `fdh_upload_sessions` | User-owned (`user_id`) | `for all using (auth.uid() = user_id) with check (...)` | Short-lived, single-document upload credential. Never a reusable storage credential — server-mediated upload only. |
| `fdh_document_audit_events` | User-owned, nullable `user_id` (system events may outlive the reference) | SELECT-only for owner; no insert/update/delete policy — writes are service-role only | Append-only lifecycle audit trail, structurally identical to `ii_audit_events` (0036). |

### Columns added to an existing table

`fdh_statement_uploads` (created in FDH-1's `0046`) gains 7 columns, all
additive/nullable-or-defaulted, no existing column dropped or narrowed:

- `storage_provider text not null default 'supabase_storage'`
- `uploaded_at timestamptz`
- `validated_at timestamptz`
- `processing_started_at timestamptz`
- `processing_completed_at timestamptz`
- `purge_requested_at timestamptz`
- `duplicate_of_document_id uuid references fdh_statement_uploads(id) on delete set null`

### Constraints

- `chk_fdh_uploads_not_self_duplicate` — `duplicate_of_document_id is null or duplicate_of_document_id <> id`
- `fdh_upload_sessions`: `chk_fdh_upload_sessions_completed_at`, `chk_fdh_upload_sessions_expired_at`, `chk_fdh_upload_sessions_expiry_order`, `chk_fdh_upload_sessions_failure_code` (all check constraints tying state-machine fields together)
- `allowed_mime_type` and `upload_status`/`failure_code` are constrained via inline `check (... in (...))` vocabularies

### Indexes

- `idx_fdh_uploads_duplicate_of` (partial, `where duplicate_of_document_id is not null`)
- `idx_fdh_uploads_user_file_hash` (replaces the dropped hard-unique index — see "Deliberate exception" below)
- `idx_fdh_upload_sessions_user`, `idx_fdh_upload_sessions_document`
- `idx_fdh_upload_sessions_sweep` (partial, abandoned-session sweep query)
- `uq_fdh_upload_sessions_live_document` (partial unique — at most one live session per document)
- `idx_fdh_doc_audit_user`, `idx_fdh_doc_audit_document`, `idx_fdh_doc_audit_event_type`

### Dropped

- `uq_fdh_uploads_user_file_hash` — a hard per-user-per-file-hash uniqueness constraint from FDH-1 (`0046`), replaced by the soft `duplicate_of_document_id` pointer + a non-unique lookup index. Disclosed, deliberate exception to "additive only": FDH-1 shipped no upload route so this constraint was never exercised in production before FDH-3 discovered the conflict between "hard uniqueness" and the product requirement "flag, don't block, a re-upload of the same file."

### Functions / triggers (FDH1-F1 tenant-referential-integrity hardening)

- `fdh3_assert_upload_session_owner()` + `trg_fdh_upload_sessions_owner` (before insert/update on `fdh_upload_sessions.user_id, document_id`) — re-verifies the referenced `fdh_statement_uploads` row belongs to the same `user_id`.
- `fdh3_assert_ingestion_job_owner()` + `trg_fdh_ingestion_jobs_owner` (before insert/update on the pre-existing `fdh_ingestion_jobs.user_id, statement_upload_id`) — same pattern, added to an existing table's write path, no schema change to that table.

Both are `security definer set search_path = public`, run regardless of
role (including service-role), and close the class of defect where a FK
proves referential existence but not same-tenant ownership.

### RLS / storage policy

- `storage.objects` gains one new SELECT policy: `"own fdh source document objects"`, scoped to `bucket_id = 'fdh-source-documents'` and `(storage.foldername(name))[1] = auth.uid()::text`. No insert/update/delete policy for the authenticated role — matches the `0037_ii_storage_policy.sql` precedent exactly (service-role-only writes after an explicit ownership check in the API route).
- Bucket creation itself is out-of-migration (Storage Admin API, `scripts/fdh3_create_storage_bucket.mjs`) — same precedent as `0022` and `0037`.

### Grants

None explicit beyond the RLS policies above (standard `authenticated` role via RLS, no `grant`/`revoke` statements in this file).

### Seed data

None. This migration is pure DDL.

## Dependencies

- `fdh_statement_uploads`, `fdh_ingestion_jobs` (FDH-1, `0046`/`0047`) — widened/exercised, not redefined.
- `auth.users` (Supabase built-in) — FK target for `user_id` columns.
- `storage.objects` (Supabase Storage built-in schema) — new policy only, table itself pre-exists.

## Classification (per spec section A)

| Object | Class |
| --- | --- |
| `fdh_upload_sessions` | `FDH_ONLY` |
| `fdh_document_audit_events` | `FDH_ONLY` |
| `fdh_statement_uploads` (7 new columns + 1 dropped index) | `FDH_ONLY` |
| `fdh_ingestion_jobs` (2 new triggers) | `FDH_ONLY` |
| `fdh3_assert_upload_session_owner()`, `fdh3_assert_ingestion_job_owner()` | `FDH_ONLY` |
| `storage.objects` SELECT policy `"own fdh source document objects"` | `FDH_ONLY` (bucket-scoped to `fdh-source-documents`, cannot affect any other bucket's rows) |

**Zero objects in this file are `II_ONLY`, `SHARED`, or `CONFLICTING`** with
the Investment Intelligence R6 migrations (0059-0063) — see
`0058_II_R6_MANIFEST.md`'s matching classification table and
`0058_CANONICAL_LINEAGE_DECISION.md` section "Confirmed: zero schema
overlap" for the cross-check.
