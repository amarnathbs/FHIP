-- AIE-1.1 — Shared Document Preprocessing, Masking & JSON-Schema Gateway.
--
-- NUMBERING NOTE: main's highest migration at the time this file was written
-- is 0137. Numbers 0138/0139 are already claimed by the (separate, unmerged)
-- `feature/lr-1-upload-security-lifecycle` branch's G6 contract-2/3 work
-- (0138_g6_contract2_country_code_columns.sql,
-- 0139_g6_contract3_snapshot_fx_lineage.sql) — confirmed by fetching that
-- branch directly, not by guesswork. This file is numbered 0140 to leave
-- that pending pair a clear slot and avoid a same-number collision when both
-- branches eventually merge, matching the documented cross-branch collision
-- history this repo has already hit twice (FDH-3/R6 at 0058, App Review at
-- 0031-0039 — see scripts/check-migration-versions-against-branch.mjs).
-- Re-run `npm run check:migrations:against-main` (and, if that branch is
-- still unmerged at merge time, a manual `--against=` check against it too)
-- before this branch is merged.
--
-- PRODUCTION AUTHORITY: NONE. This migration is held locally on
-- feature/aie-1-1-document-gateway and is NOT applied to any DEV or
-- production database as part of this pass — every one of the six AIE
-- source specifications repeats "no production migration ... without
-- separate authority" as a non-negotiable prohibition (AIE-1.1 section 4).
--
-- SCOPE. Implements the persistence layer for AIE-1.1's binding pipeline
-- (AIE-1.1 section 2): intake -> quarantine -> validation -> extraction ->
-- fingerprint/dedup -> deterministic parser -> PII masking -> gated AI
-- fallback -> JSON Schema validation -> reconciliation handoff -> typed
-- unresolved-item persistence. It does NOT implement any domain
-- reconciliation rule (that is AIE-1.2/1.3/1.4's job), and it creates NO
-- canonical financial data of its own — `aie_write_batch` is a scaffold a
-- future domain adapter will populate, not a canonical table.
--
-- ENTITY MAPPING (AIE-1.1 section 33's 18-entity minimum conceptual model
-- mapped onto the 15 real tables below — the spec explicitly permits this:
-- "Map to existing canonical equivalents where sound; do not duplicate
-- tables merely to match names."):
--   DocumentIntake        -> aie_document_intake
--   SourceArtifact         -> (not built this pass — see AIE_1_1_IMPLEMENTATION.md
--                              "deferred" section; extraction runs today operate
--                              on bytes held only in the quarantine object, not
--                              a separate derived-artifact row)
--   DocumentFingerprint    -> aie_document_fingerprint
--   ExtractionRun          -> aie_extraction_run
--   ProcessingTransition   -> aie_processing_transition
--   PageArtifact/TableArtifact -> (not built this pass — deferred, see above)
--   ParserAttempt          -> aie_parser_attempt
--   MaskingSummary         -> aie_masking_summary
--   MaskTokenMap           -> aie_mask_token_map
--   AICompletionAttempt    -> aie_ai_completion_attempt
--   SchemaValidationResult -> aie_schema_validation_result
--   FieldCandidate         -> aie_field_candidate
--   ReconciliationRun      -> aie_reconciliation_run
--   UnresolvedItem         -> aie_unresolved_item
--   UserReviewDecision     -> aie_review_decision
--   CanonicalWriteBatch    -> aie_write_batch (scaffold; unused until 1.2/1.3 exist)
--   AuditEvent             -> aie_audit_event
--   RetentionDisposition   -> aie_document_intake.retention_class / .deleted_at
--                              (folded into the intake row rather than a
--                              separate table — a deliberate simplification,
--                              disclosed here rather than silently done)
--
-- TENANT SCOPING. Follows this codebase's own FDH-3 precedent exactly:
-- `user_id` IS the tenant key (no separate household/tenant table is used by
-- the document-lifecycle precedent this migration extends). Every child
-- table denormalizes `intake_id` + `user_id` directly (rather than requiring
-- a join back to aie_document_intake for RLS) so that RLS policies stay
-- simple `using (user_id = auth.uid())` predicates, and a single shared
-- trigger function (`aie_assert_child_owner()`) enforces that the
-- denormalized user_id actually matches the intake's true owner — the same
-- defense-in-depth discipline as FDH-3's `fdh3_assert_upload_session_owner`
-- and `fdh3_assert_ingestion_job_owner` triggers (migration 0058).
--
-- WRITE DISCIPLINE. `aie_document_intake` allows an authenticated INSERT
-- (with check (user_id = auth.uid())) so a user can create their own intake
-- record via the normal RLS-scoped client (matching FDH-3's upload-session
-- pattern) — but NO UPDATE/DELETE policy exists for the authenticated role
-- on this table or any other AIE table. Every processing-state transition,
-- every child-table row, and every review decision is written exclusively
-- through the service-role client after the caller has already verified
-- ownership via an RLS-scoped read — identical discipline to
-- lib/financial-data-hub/services/storage.ts and services/auditLog.ts.
-- `aie_mask_token_map` goes further: it carries NO authenticated policy of
-- any kind (not even SELECT) and access is explicitly revoked, since it is
-- the one table holding reversible PII de-tokenisation material.

-- ---------------------------------------------------------------------------
-- 1. aie_document_intake
-- ---------------------------------------------------------------------------
create table aie_document_intake (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'received'
    check (status in ('received', 'quarantined', 'rejected', 'ready', 'cancelled', 'deleted')),
  declared_mime_type text not null,
  detected_mime_type text,
  byte_size bigint not null check (byte_size > 0),
  storage_key text unique,
  -- Sanitised, length-capped DISPLAY name only (UPL-08: "separate display
  -- filename from internal object identity + sanitise"). The internal
  -- object identity is `storage_key`, never derived from this column.
  display_filename text,
  -- Which future adapter (1.2/1.3/1.4) this document is destined for, if
  -- known at intake time. Nullable: AIE-1.1 itself never routes to a
  -- domain — this is metadata for a caller that already knows its own
  -- module, not an authority AIE-1.1 acts on.
  source_module_hint text check (source_module_hint in ('investment_intelligence', 'fdh_bank', 'other', null)),
  retention_class text not null default 'standard',
  version integer not null default 1,
  rejection_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index idx_aie_document_intake_user_status on aie_document_intake (user_id, status);

alter table aie_document_intake enable row level security;

create policy "select own aie_document_intake" on aie_document_intake
  for select using (user_id = auth.uid());

-- UPL-01/UPL-09: identity is server-derived (the API route sets user_id from
-- the authenticated session, never trusts a client-supplied value), but the
-- INSERT itself is allowed through the normal RLS-scoped client so intake
-- creation doesn't require a privileged credential — `with check` still
-- structurally prevents a user from creating a row owned by anyone else.
create policy "insert own aie_document_intake" on aie_document_intake
  for insert with check (user_id = auth.uid());

-- No update/delete policy for the authenticated role: every subsequent
-- status change goes through the service-role client (FSM-01: "enforce
-- transitions server/DB-side (not UI-trusted)").

-- ---------------------------------------------------------------------------
-- Shared cross-tenant integrity trigger (defense in depth beyond RLS —
-- FDH-3 precedent, migration 0058). Applied to every child table below.
-- ---------------------------------------------------------------------------
create or replace function aie_assert_child_owner()
returns trigger as $$
declare
  true_owner uuid;
begin
  select user_id into true_owner from aie_document_intake where id = new.intake_id;
  if true_owner is null then
    raise exception 'aie: intake % does not exist', new.intake_id;
  end if;
  if new.user_id is distinct from true_owner then
    raise exception 'aie: cross-tenant reference — intake % belongs to a different user', new.intake_id;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

-- ---------------------------------------------------------------------------
-- 2. aie_document_fingerprint
-- ---------------------------------------------------------------------------
create table aie_document_fingerprint (
  id uuid primary key default gen_random_uuid(),
  intake_id uuid not null references aie_document_intake(id) on delete cascade,
  user_id uuid not null,
  -- Exact byte-content SHA-256, computed only after the file is safely
  -- received (DUP-01). Never a weak/non-cryptographic hash (DUP-09).
  exact_sha256 text not null,
  -- Privacy-safe normalised-content hash for probable-duplicate detection
  -- across re-exports of the "same" document with different bytes (DUP-02).
  -- Nullable: computed only where cheap to do so; its absence never implies
  -- non-duplication (DUP-04: "do not treat equal page text as proof of
  -- equal ownership or canonical destination" applies equally to this
  -- signal — it is advisory, not authoritative).
  normalized_hash text,
  created_at timestamptz not null default now(),
  -- Scoped per-user (DUP-03: "scope checks by tenant/user/authorised
  -- account") — an identical document uploaded by two different users is
  -- NOT treated as a cross-user duplicate; each user gets their own intake
  -- lineage.
  unique (user_id, exact_sha256)
);

create index idx_aie_document_fingerprint_intake on aie_document_fingerprint (intake_id);

alter table aie_document_fingerprint enable row level security;
create policy "select own aie_document_fingerprint" on aie_document_fingerprint
  for select using (user_id = auth.uid());
create trigger trg_aie_document_fingerprint_owner
  before insert or update of intake_id, user_id on aie_document_fingerprint
  for each row execute function aie_assert_child_owner();

-- ---------------------------------------------------------------------------
-- 3. aie_extraction_run
-- ---------------------------------------------------------------------------
create table aie_extraction_run (
  id uuid primary key default gen_random_uuid(),
  intake_id uuid not null references aie_document_intake(id) on delete cascade,
  user_id uuid not null,
  run_number integer not null,
  status text not null default 'local_extracting' check (status in (
    'local_extracting', 'local_complete',
    'deterministic_complete', 'deterministic_partial',
    'masking', 'privacy_blocked',
    'ai_pending', 'ai_running', 'ai_complete',
    'schema_rejected',
    'reconciling', 'unresolved', 'awaiting_acceptance', 'accepted',
    'write_pending', 'completed',
    'failed_retryable', 'failed_terminal'
  )),
  ai_used boolean not null default false,
  deterministic_outcome text check (deterministic_outcome in ('not_applicable', 'complete', 'partial', 'failed', null)),
  error_code text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (intake_id, run_number)
);

create index idx_aie_extraction_run_intake on aie_extraction_run (intake_id);
create index idx_aie_extraction_run_user_status on aie_extraction_run (user_id, status);

alter table aie_extraction_run enable row level security;
create policy "select own aie_extraction_run" on aie_extraction_run
  for select using (user_id = auth.uid());
create trigger trg_aie_extraction_run_owner
  before insert or update of intake_id, user_id on aie_extraction_run
  for each row execute function aie_assert_child_owner();

-- ---------------------------------------------------------------------------
-- 4. aie_processing_transition — append-only audit of every FSM move.
-- ---------------------------------------------------------------------------
create table aie_processing_transition (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references aie_extraction_run(id) on delete cascade,
  intake_id uuid not null,
  user_id uuid not null,
  from_state text not null,
  to_state text not null,
  actor_type text not null check (actor_type in ('system', 'worker', 'user', 'admin')),
  actor_id uuid,
  reason text,
  created_at timestamptz not null default now()
);

create index idx_aie_processing_transition_run on aie_processing_transition (run_id, created_at);

alter table aie_processing_transition enable row level security;
create policy "select own aie_processing_transition" on aie_processing_transition
  for select using (user_id = auth.uid());
create trigger trg_aie_processing_transition_owner
  before insert or update of intake_id, user_id on aie_processing_transition
  for each row execute function aie_assert_child_owner();

-- ---------------------------------------------------------------------------
-- 5. aie_parser_attempt
-- ---------------------------------------------------------------------------
create table aie_parser_attempt (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references aie_extraction_run(id) on delete cascade,
  intake_id uuid not null,
  user_id uuid not null,
  adapter_id text not null,
  document_class text,
  outcome text not null check (outcome in ('not_applicable', 'complete', 'partial', 'failed')),
  fields_extracted integer not null default 0,
  -- Field NAMES only, never values (REG-08: prevent parser output leaking
  -- content on failure).
  fields_missing jsonb not null default '[]'::jsonb,
  parser_version text,
  created_at timestamptz not null default now()
);

create index idx_aie_parser_attempt_run on aie_parser_attempt (run_id);

alter table aie_parser_attempt enable row level security;
create policy "select own aie_parser_attempt" on aie_parser_attempt
  for select using (user_id = auth.uid());
create trigger trg_aie_parser_attempt_owner
  before insert or update of intake_id, user_id on aie_parser_attempt
  for each row execute function aie_assert_child_owner();

-- ---------------------------------------------------------------------------
-- 6. aie_masking_summary
-- ---------------------------------------------------------------------------
create table aie_masking_summary (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references aie_extraction_run(id) on delete cascade,
  intake_id uuid not null,
  user_id uuid not null,
  -- Counts by detected PII type only (e.g. {"tax_id": 2, "account_number": 1})
  -- — never the matched text itself (PII-11: "prevent raw/masked mapping
  -- appearing in errors/logs/traces/analytics").
  coverage_by_type jsonb not null default '{}'::jsonb,
  below_policy boolean not null default false,
  created_at timestamptz not null default now()
);

create index idx_aie_masking_summary_run on aie_masking_summary (run_id);

alter table aie_masking_summary enable row level security;
create policy "select own aie_masking_summary" on aie_masking_summary
  for select using (user_id = auth.uid());
create trigger trg_aie_masking_summary_owner
  before insert or update of intake_id, user_id on aie_masking_summary
  for each row execute function aie_assert_child_owner();

-- ---------------------------------------------------------------------------
-- 7. aie_mask_token_map — MOST sensitive table. No authenticated access at
-- all (PII-08: "encrypt reversible token maps separately with least-
-- privilege access"). `ciphertext` is application-layer-encrypted before
-- insert; the database never sees a plaintext PII value.
-- ---------------------------------------------------------------------------
create table aie_mask_token_map (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references aie_extraction_run(id) on delete cascade,
  token text not null,
  ciphertext bytea not null,
  created_at timestamptz not null default now(),
  unique (run_id, token)
);

alter table aie_mask_token_map enable row level security;
-- Deliberately zero policies: RLS with no policy denies all access to
-- non-service-role roles. Explicit revoke as well, matching the
-- belt-and-braces discipline documented in this migration's header.
revoke all on table aie_mask_token_map from authenticated, anon;

-- ---------------------------------------------------------------------------
-- 8. aie_ai_completion_attempt
-- ---------------------------------------------------------------------------
create table aie_ai_completion_attempt (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references aie_extraction_run(id) on delete cascade,
  intake_id uuid not null,
  user_id uuid not null,
  provider_name text not null,
  model text not null,
  schema_name text not null,
  schema_version text not null,
  -- Field NAMES requested only, never any content (PAY-01: "accept only
  -- requested-missing field identifiers").
  requested_fields jsonb not null default '[]'::jsonb,
  -- CST-05: collapses duplicate/concurrent identical attempts to one
  -- chargeable call.
  idempotency_key text not null unique,
  outcome text not null check (outcome in ('success', 'timeout', 'rate_limited', 'provider_error', 'schema_rejected', 'refused')),
  input_tokens integer,
  output_tokens integer,
  latency_ms integer,
  created_at timestamptz not null default now()
);

create index idx_aie_ai_completion_attempt_run on aie_ai_completion_attempt (run_id);

alter table aie_ai_completion_attempt enable row level security;
create policy "select own aie_ai_completion_attempt" on aie_ai_completion_attempt
  for select using (user_id = auth.uid());
create trigger trg_aie_ai_completion_attempt_owner
  before insert or update of intake_id, user_id on aie_ai_completion_attempt
  for each row execute function aie_assert_child_owner();

-- ---------------------------------------------------------------------------
-- 9. aie_schema_validation_result
-- ---------------------------------------------------------------------------
create table aie_schema_validation_result (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references aie_ai_completion_attempt(id) on delete cascade,
  intake_id uuid not null,
  user_id uuid not null,
  valid boolean not null,
  -- Error CODES/paths only (JSC-10: "store validation errors as codes/paths
  -- without logging sensitive values").
  error_codes jsonb,
  created_at timestamptz not null default now()
);

create index idx_aie_schema_validation_result_attempt on aie_schema_validation_result (attempt_id);

alter table aie_schema_validation_result enable row level security;
create policy "select own aie_schema_validation_result" on aie_schema_validation_result
  for select using (user_id = auth.uid());
create trigger trg_aie_schema_validation_result_owner
  before insert or update of intake_id, user_id on aie_schema_validation_result
  for each row execute function aie_assert_child_owner();

-- ---------------------------------------------------------------------------
-- 10. aie_field_candidate
-- ---------------------------------------------------------------------------
create table aie_field_candidate (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references aie_extraction_run(id) on delete cascade,
  intake_id uuid not null,
  user_id uuid not null,
  field_name text not null,
  -- Decimal/date/string VALUES are stored as text (NORM-01: "no binary
  -- floating-point conversion") — this is masked/normalised candidate data
  -- belonging to the future domain adapter's reconciliation step, not raw
  -- source bytes.
  value_raw text,
  source_method text not null check (source_method in ('deterministic', 'ai', 'ocr')),
  source_reference jsonb,
  is_null boolean not null default false,
  null_reason text,
  created_at timestamptz not null default now()
);

create index idx_aie_field_candidate_run on aie_field_candidate (run_id);

alter table aie_field_candidate enable row level security;
create policy "select own aie_field_candidate" on aie_field_candidate
  for select using (user_id = auth.uid());
create trigger trg_aie_field_candidate_owner
  before insert or update of intake_id, user_id on aie_field_candidate
  for each row execute function aie_assert_child_owner();

-- ---------------------------------------------------------------------------
-- 11. aie_reconciliation_run — persistence contract only. AIE-1.1 defines
-- the shape; it computes NO domain reconciliation rule itself (REC-13: "do
-- not call canonical write services in AIE-1.1"; reconciliation logic is
-- adapter-owned per AIE-1.2/1.3/1.4).
-- ---------------------------------------------------------------------------
create table aie_reconciliation_run (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references aie_extraction_run(id) on delete cascade,
  intake_id uuid not null,
  user_id uuid not null,
  rule_id text not null,
  rule_version text not null,
  outcome text not null check (outcome in ('pass', 'pass_with_tolerance', 'fail', 'indeterminate', 'not_applicable')),
  delta numeric,
  tolerance numeric,
  materiality text,
  created_at timestamptz not null default now()
);

create index idx_aie_reconciliation_run_run on aie_reconciliation_run (run_id);

alter table aie_reconciliation_run enable row level security;
create policy "select own aie_reconciliation_run" on aie_reconciliation_run
  for select using (user_id = auth.uid());
create trigger trg_aie_reconciliation_run_owner
  before insert or update of intake_id, user_id on aie_reconciliation_run
  for each row execute function aie_assert_child_owner();

-- ---------------------------------------------------------------------------
-- 12. aie_unresolved_item — the SINGLE unresolved-item/exception system
-- (EXC-09/EXC-12: "prove no second AIE-1.x exception system exists"; this
-- table is the one and only source of truth PC5 and AIE-1.5 will both
-- consume, never a per-adapter duplicate).
-- ---------------------------------------------------------------------------
create table aie_unresolved_item (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references aie_extraction_run(id) on delete cascade,
  intake_id uuid not null,
  user_id uuid not null,
  reason_code text not null,
  severity text not null check (severity in ('blocking', 'warning')),
  status text not null default 'open' check (status in ('open', 'in_review', 'resolved', 'rejected', 'deferred', 'superseded')),
  -- Privacy-safe display candidate only — never the protected evidence
  -- itself (EXC-03).
  display_candidate text,
  evidence_ref jsonb,
  permitted_action_types jsonb not null default '[]'::jsonb,
  -- Optimistic concurrency for AIE-1.5's future stale-decision rejection
  -- (EXC-05/AIE-1.5 VAL-05).
  item_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_aie_unresolved_item_run on aie_unresolved_item (run_id);
create index idx_aie_unresolved_item_user_status on aie_unresolved_item (user_id, status);

alter table aie_unresolved_item enable row level security;
create policy "select own aie_unresolved_item" on aie_unresolved_item
  for select using (user_id = auth.uid());
-- No insert/update/delete for authenticated (EXC-08: "prevent direct status
-- mutation from browser, adapter or PC5") — status changes ALWAYS go
-- through the service-role-backed decision service after ownership + item
-- version are checked.
create trigger trg_aie_unresolved_item_owner
  before insert or update of intake_id, user_id on aie_unresolved_item
  for each row execute function aie_assert_child_owner();

-- ---------------------------------------------------------------------------
-- 13. aie_review_decision — immutable audit trail of every decision made
-- against an aie_unresolved_item (EXC-08: "immutable decision/audit history
-- even as status changes"). AIE-1.1 builds this persistence + the
-- diagnostic decision service only; the real reviewer UI is AIE-1.5's job.
-- ---------------------------------------------------------------------------
create table aie_review_decision (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references aie_unresolved_item(id) on delete cascade,
  intake_id uuid not null,
  user_id uuid not null,
  item_version_at_decision integer not null,
  decision_type text not null,
  rationale text,
  idempotency_key text not null unique,
  actor_id uuid,
  created_at timestamptz not null default now()
);

create index idx_aie_review_decision_item on aie_review_decision (item_id, created_at);

alter table aie_review_decision enable row level security;
create policy "select own aie_review_decision" on aie_review_decision
  for select using (user_id = auth.uid());
create trigger trg_aie_review_decision_owner
  before insert or update of intake_id, user_id on aie_review_decision
  for each row execute function aie_assert_child_owner();

-- ---------------------------------------------------------------------------
-- 14. aie_audit_event — allowlisted, redacted audit trail (OBS-02: "redact
-- request bodies, document text, identifiers, prompts and provider output
-- from logs"). `metadata` must never carry raw document content, prompts,
-- provider payloads or PII — identical discipline to
-- fdh_document_audit_events (migration 0058).
-- ---------------------------------------------------------------------------
create table aie_audit_event (
  id uuid primary key default gen_random_uuid(),
  intake_id uuid,
  run_id uuid,
  user_id uuid,
  event_type text not null,
  actor_type text not null check (actor_type in ('system', 'worker', 'user', 'admin')),
  actor_id uuid,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index idx_aie_audit_event_intake on aie_audit_event (intake_id, created_at);
create index idx_aie_audit_event_user on aie_audit_event (user_id, created_at);

alter table aie_audit_event enable row level security;
create policy "select own aie_audit_event" on aie_audit_event
  for select using (user_id = auth.uid());
-- No insert policy for authenticated at all — identical precedent to
-- fdh_document_audit_events: every insert goes through the service-role
-- client only.

-- ---------------------------------------------------------------------------
-- 15. aie_write_batch — SCAFFOLD ONLY. Defines the handoff shape a future
-- AIE-1.2/1.3/1.4 domain adapter will populate when it calls its own
-- canonical-write service. AIE-1.1 core NEVER writes to this table itself
-- (architecture step 12: "domain-owned canonical write interface; no direct
-- write in core") — it exists now purely so the contract shape is reviewed
-- and frozen alongside the rest of this migration, not invented ad hoc by
-- whichever adapter phase ships first.
-- ---------------------------------------------------------------------------
create table aie_write_batch (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references aie_extraction_run(id) on delete cascade,
  intake_id uuid not null,
  user_id uuid not null,
  target_module text not null check (target_module in ('investment_intelligence', 'fdh_bank', 'other')),
  status text not null default 'pending' check (status in ('pending', 'committed', 'failed')),
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  committed_at timestamptz
);

create index idx_aie_write_batch_run on aie_write_batch (run_id);

alter table aie_write_batch enable row level security;
create policy "select own aie_write_batch" on aie_write_batch
  for select using (user_id = auth.uid());
create trigger trg_aie_write_batch_owner
  before insert or update of intake_id, user_id on aie_write_batch
  for each row execute function aie_assert_child_owner();

-- ---------------------------------------------------------------------------
-- Storage RLS: private "aie-document-quarantine" bucket.
--
-- Bucket creation itself happens via the Storage Admin API (Storage Admin
-- API operation, not SQL — identical precedent to 0058/fdh-source-documents,
-- 0037/investment-source-documents, 0022/report-exports) — see
-- scripts/aie1_1_create_storage_bucket.mjs, NOT run in this pass.
--
-- SELECT only. Object path convention "{user_id}/{intake_id}/{intake_id}.bin"
-- (lib/aie/storage.ts's buildQuarantineStorageKey) means
-- (storage.foldername(name))[1] is the owning user's id. No insert/update/
-- delete policy exists for the authenticated role — every write happens via
-- the service-role client in lib/aie/storage.ts, identical discipline to
-- FDH-3's services/storage.ts.
-- ---------------------------------------------------------------------------
create policy "own aie document quarantine objects" on storage.objects
  for select using (
    bucket_id = 'aie-document-quarantine'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
