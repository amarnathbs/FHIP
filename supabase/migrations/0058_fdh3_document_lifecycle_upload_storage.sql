-- =============================================================================
-- Financial Data Hub (FDH) — FDH-3 Migration (0058): secure document-upload
-- session, private-storage handoff, document audit trail, and a focused
-- tenant-referential-integrity hardening for the relationships FDH-3
-- introduces or actively exercises for the first time.
-- =============================================================================
-- SCOPE. FDH-3 is the first phase that writes real bytes to private object
-- storage and the first phase to actually CREATE fdh_ingestion_jobs rows (the
-- FDH-1 schema defined the table; nothing wrote to it until now). It therefore
-- widens three things FDH-1/FDH-2 deliberately left alone:
--
--   1. Adds fdh_upload_sessions — a short-lived, single-document, opaque-path
--      upload credential record (never a reusable permanent credential).
--   2. Adds fdh_document_audit_events — an append-only lifecycle audit trail,
--      structurally identical to ii_audit_events (0036_ii_audit_events.sql):
--      owner-read-only RLS, insert only via the service-role client from
--      trusted server code (lib/financial-data-hub/services/auditLog.ts),
--      metadata jsonb that must never carry raw document content.
--   3. Widens fdh_statement_uploads with observability timestamps, a
--      storage_provider column, and a soft (non-blocking) duplicate-document
--      pointer — see "DUPLICATE DETECTION" below for why the FDH-1 hard
--      unique constraint is replaced rather than kept.
--
-- FDH1-F1 HARDENING (spec section 5). FDH-0 identified that PostgreSQL FK
-- existence checks alone permit a tenant-owned row to reference another
-- tenant's UUID — RLS prevents the resulting row from being *read* cross-
-- tenant, but does not stop it being *written*. This migration does the
-- FOCUSED, narrow hardening the FDH-3 spec asks for (not the full 85-FK
-- remediation): explicit BEFORE INSERT/UPDATE triggers that re-verify the
-- referencing row's user_id against the referenced parent's user_id, for
-- exactly the two relationships FDH-3 introduces or newly exercises —
-- fdh_upload_sessions -> fdh_statement_uploads and
-- fdh_ingestion_jobs -> fdh_statement_uploads. No other historical FK is
-- touched. The global FDH1-F1 finding remains OPEN for a dedicated later
-- hardening phase across the remaining ~85 relationships — see
-- docs/financial-data-hub/FDH3_SECURITY_THREAT_MODEL.md section "FDH1-F1".
--
-- STORAGE. The bucket itself ("fdh-source-documents") is created via the
-- Storage Admin API (supabase.storage.createBucket), not here — identical
-- precedent to 0022 (report-exports) and 0037 (investment-source-documents).
-- Object path convention: "{user_id}/{document_id}/{document_id}.bin" — a
-- server-generated opaque key (lib/financial-data-hub/services/storage.ts),
-- never a user-supplied filename, never an account number, never an email.
-- All writes happen via the service-role client after an explicit
-- authenticated + ownership check in the API route — no insert/update/delete
-- policy is defined for the authenticated role below, matching 0037's
-- identical pattern. A SELECT policy IS defined (defence in depth for the
-- rare direct-storage-read path; the shipped product surface always uses a
-- short-lived signed URL instead, see FDH3_STORAGE_SECURITY.md).
--
-- Governing docs: docs/financial-data-hub/FDH3_ARCHITECTURE.md,
-- FDH3_STORAGE_SECURITY.md, FDH3_DOCUMENT_LIFECYCLE.md,
-- FDH3_RLS_STORAGE_POLICIES.md.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- fdh_statement_uploads — additive widening only. No column is dropped, no
-- existing column's type or nullability is narrowed.
-- ---------------------------------------------------------------------------
alter table fdh_statement_uploads
  add column storage_provider text not null default 'supabase_storage',
  add column uploaded_at timestamptz,
  add column validated_at timestamptz,
  add column processing_started_at timestamptz,
  add column processing_completed_at timestamptz,
  add column purge_requested_at timestamptz,
  add column duplicate_of_document_id uuid references fdh_statement_uploads(id) on delete set null;

alter table fdh_statement_uploads
  add constraint chk_fdh_uploads_not_self_duplicate
    check (duplicate_of_document_id is null or duplicate_of_document_id <> id);

create index idx_fdh_uploads_duplicate_of on fdh_statement_uploads(duplicate_of_document_id)
  where duplicate_of_document_id is not null;

-- DUPLICATE DETECTION (spec section 21). FDH-1 shipped a HARD unique index
-- (user_id, file_hash) that would have made a second upload of the same file
-- fail outright. The FDH-3 product requirement is different and more
-- permissive: "Do not automatically delete the upload unless product
-- behaviour clearly permits it... allow user to understand: this file appears
-- to have been uploaded previously." A hard uniqueness constraint cannot
-- express a soft, user-visible flag — it can only refuse the write. FDH-1
-- shipped no upload route, so this was never exercised in production; FDH-3 is
-- the first phase to discover the conflict and corrects it deliberately, not
-- accidentally. The replacement is `duplicate_of_document_id` above (an
-- application-computed pointer to the earlier same-hash upload, populated by
-- lib/financial-data-hub/services/uploadLifecycle.ts at validation time) plus
-- a non-unique lookup index below.
drop index if exists uq_fdh_uploads_user_file_hash;
create index idx_fdh_uploads_user_file_hash on fdh_statement_uploads(user_id, file_hash)
  where file_hash is not null;


-- ---------------------------------------------------------------------------
-- fdh_upload_sessions — a short-lived, single-document upload credential.
--
-- Deliberately NOT a signed direct-to-storage PUT URL. FHIP's server-side
-- upload pattern (see 0022/report-exports and 0037/investment-source-
-- documents) always streams bytes through an authenticated Next.js API route
-- into storage via the service-role client, so no storage credential of any
-- kind is ever returned to the browser (spec section 26). The "session"
-- nonetheless models everything a signed-upload design would need: it is
-- single-document, restricted to one opaque storage_key, time-boxed, and
-- cannot be reused once completed or expired — see FDH3_ARCHITECTURE.md
-- section 4 for the explicit decision record.
-- ---------------------------------------------------------------------------
create table fdh_upload_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  document_id uuid not null references fdh_statement_uploads(id) on delete cascade,
  allowed_mime_type text not null check (allowed_mime_type in ('application/pdf', 'text/csv')),
  expected_max_size_bytes bigint not null check (expected_max_size_bytes > 0),
  storage_bucket text not null default 'fdh-source-documents',
  storage_key text not null unique,
  upload_status text not null default 'session_created'
    check (upload_status in (
      'session_created', 'upload_in_progress', 'upload_complete', 'expired', 'failed'
    )),
  -- SESSION-SCOPED error taxonomy (spec section 52), deliberately a NEW,
  -- independently-owned constraint rather than a widening of the FROZEN
  -- fdh_statement_uploads.error_code vocabulary from migration 0046 (which
  -- tests/unit/fdh1SchemaContract.test.ts asserts byte-for-byte against the
  -- ORIGINAL 0045-0048 create-table text and would break if that shared
  -- constraint were edited in place). Upload MECHANICS failures live here;
  -- document PROCESSING failures continue to use the existing, unmodified
  -- fdh_statement_uploads.error_code column and its original 14-value set.
  failure_code text
    check (failure_code is null or failure_code in (
      'unsupported_file_type', 'file_too_large', 'mime_mismatch', 'file_corrupt',
      'password_required', 'upload_incomplete', 'storage_error', 'internal_error'
    )),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  completed_at timestamptz,
  expired_at timestamptz,
  constraint chk_fdh_upload_sessions_completed_at
    check (completed_at is null or upload_status = 'upload_complete'),
  constraint chk_fdh_upload_sessions_expired_at
    check (expired_at is null or upload_status = 'expired'),
  constraint chk_fdh_upload_sessions_expiry_order check (expires_at > created_at),
  constraint chk_fdh_upload_sessions_failure_code
    check (failure_code is null or upload_status = 'failed')
);
create index idx_fdh_upload_sessions_user on fdh_upload_sessions(user_id);
create index idx_fdh_upload_sessions_document on fdh_upload_sessions(document_id);
-- Abandoned-upload sweep query: open sessions past their expiry.
create index idx_fdh_upload_sessions_sweep on fdh_upload_sessions(expires_at)
  where upload_status in ('session_created', 'upload_in_progress');
-- At most one LIVE session per document — a second concurrent createUploadSession
-- call for the same document must not silently race an existing one (spec
-- section 94, concurrency).
create unique index uq_fdh_upload_sessions_live_document on fdh_upload_sessions(document_id)
  where upload_status in ('session_created', 'upload_in_progress');

alter table fdh_upload_sessions enable row level security;
create policy "own rows - fdh_upload_sessions" on fdh_upload_sessions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- fdh_document_audit_events — append-only lifecycle audit trail.
--
-- Structurally identical to ii_audit_events (0036), which is the established
-- FHIP precedent for this exact shape. `metadata` is a safe, non-sensitive
-- jsonb blob and must NEVER carry document content, a signed URL, a password
-- or a stack trace — enforced by code review discipline plus
-- tests/unit/fdh3DocumentAuditLog.test.ts, not by a database constraint
-- (a constraint cannot inspect "is this string a signed URL").
-- ---------------------------------------------------------------------------
create table fdh_document_audit_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null, -- nullable: a system sweep event may outlive the reference
  document_id uuid references fdh_statement_uploads(id) on delete set null,
  event_type text not null check (event_type in (
    'document_upload_created', 'document_upload_completed', 'document_validated',
    'document_rejected', 'document_queued', 'document_user_deleted',
    'document_purge_scheduled', 'document_purged', 'document_purge_failed'
  )),
  actor_type text not null check (actor_type in ('user', 'system', 'service')),
  actor_id uuid,
  metadata jsonb,
  created_at timestamptz not null default now()
);
create index idx_fdh_doc_audit_user on fdh_document_audit_events(user_id) where user_id is not null;
create index idx_fdh_doc_audit_document on fdh_document_audit_events(document_id) where document_id is not null;
create index idx_fdh_doc_audit_event_type on fdh_document_audit_events(event_type, created_at desc);

alter table fdh_document_audit_events enable row level security;
-- Owner-read-only. No insert/update/delete policy for the authenticated role
-- at all — every insert happens through the service-role client from within
-- lib/financial-data-hub/services/auditLog.ts, never a direct user-facing
-- write, matching ii_audit_events exactly.
create policy "read own fdh_document_audit_events" on fdh_document_audit_events
  for select using (auth.uid() = user_id);


-- ---------------------------------------------------------------------------
-- FDH1-F1 focused hardening: tenant-scoped referential-integrity triggers.
--
-- A FOREIGN KEY only proves the referenced row EXISTS, not that it belongs to
-- the same tenant. RLS's `with check` on the referencing table's own user_id
-- prevents a row being SAVED under someone else's identity, but says nothing
-- about which OTHER tenant's row it points at. These triggers close that gap
-- for the two relationships FDH-3 introduces or newly exercises. They run
-- regardless of role — including the service-role path — so they harden the
-- same-tenant invariant independently of which client performed the write.
-- ---------------------------------------------------------------------------
create or replace function fdh3_assert_upload_session_owner() returns trigger as $$
declare
  doc_owner uuid;
begin
  select user_id into doc_owner from fdh_statement_uploads where id = new.document_id;
  if doc_owner is null then
    raise exception 'fdh_upload_sessions: document_id % does not exist', new.document_id;
  end if;
  if doc_owner <> new.user_id then
    raise exception 'fdh_upload_sessions: cross-tenant reference — document % belongs to a different user', new.document_id;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_fdh_upload_sessions_owner
  before insert or update of user_id, document_id on fdh_upload_sessions
  for each row execute function fdh3_assert_upload_session_owner();

create or replace function fdh3_assert_ingestion_job_owner() returns trigger as $$
declare
  doc_owner uuid;
begin
  select user_id into doc_owner from fdh_statement_uploads where id = new.statement_upload_id;
  if doc_owner is null then
    raise exception 'fdh_ingestion_jobs: statement_upload_id % does not exist', new.statement_upload_id;
  end if;
  if doc_owner <> new.user_id then
    raise exception 'fdh_ingestion_jobs: cross-tenant reference — statement_upload % belongs to a different user', new.statement_upload_id;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_fdh_ingestion_jobs_owner
  before insert or update of user_id, statement_upload_id on fdh_ingestion_jobs
  for each row execute function fdh3_assert_ingestion_job_owner();


-- ---------------------------------------------------------------------------
-- Storage RLS: private "fdh-source-documents" bucket.
--
-- Bucket creation itself happens via the Storage Admin API — see
-- scripts/fdh3_create_storage_bucket.mjs and
-- docs/financial-data-hub/FDH3_STORAGE_SECURITY.md for the exact verified
-- configuration (private, file_size_limit, allowed_mime_types) and live test
-- evidence once applied to DEV.
--
-- SELECT only. Object path convention "{user_id}/{document_id}/{document_id}
-- .bin" means (storage.foldername(name))[1] is the owning user's id. No
-- insert/update/delete policy exists for the authenticated role — every write
-- happens via the service-role client after an explicit ownership check in
-- the API route (lib/financial-data-hub/services/storage.ts), identical to
-- 0037_ii_storage_policy.sql's rationale.
-- ---------------------------------------------------------------------------
create policy "own fdh source document objects" on storage.objects
  for select using (
    bucket_id = 'fdh-source-documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
