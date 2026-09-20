-- FHIP Admin Redesign A2-A5, A4-WP "Audit retention controls" / "Security-event
-- operations" (A1_20_ROADMAP_A2_A5.md's A4.1/A4.2; docs/admin/A1_12_AUDIT_SECURITY_EVENT_STANDARD.md).
--
-- THIS MIGRATION HAS NOT BEEN APPLIED TO ANY ENVIRONMENT (DEV OR PRODUCTION).
-- Per this programme's own non-negotiable close and this repository's standing
-- rule, no migration may be applied without explicit Product Owner
-- authorization. This file is a reviewable design artefact only — see
-- docs/admin/A2A5_03_A4_DESIGN_AND_STATUS.md for full disclosure of what has
-- and has not been verified.
--
-- Builds the two canonical, cross-domain, append-only sinks A1_12 designed
-- and explicitly left unbuilt ("A1 does not create either table"):
--   1. admin_audit_events      — the canonical business-audit sink (A1_12 §2.1)
--   2. admin_security_events   — the canonical security-event stream (A1_12 §5.2)
--
-- Neither table replaces or migrates any existing domain audit table
-- (resource_audit_log, resource_workflow_history, benchmark_update_runs,
-- ai_config_audit, ai_safety_events, ai_operational_events) — A1_12 §2.3 is
-- explicit that "no existing audit table is migrated, replaced, or altered
-- in shape by A1", and this migration does not reopen that. Existing
-- domains keep writing their own tables; a future, separately-authorised
-- pass may additionally have them ALSO write here, per A1_12 §2.3's mapping
-- table — that dual-write is NOT part of this migration.

-- =====================================================================
-- 1. admin_audit_events — canonical business-audit sink (A1_12 §2.1)
-- =====================================================================

create table if not exists public.admin_audit_events (
  event_id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  domain text not null check (domain in ('resources', 'recommendations', 'benchmarks', 'ai', 'roles', 'fdh', 'security', 'support')),
  action text not null,
  actor_id uuid references auth.users(id),
  actor_type text not null check (actor_type in ('human_admin', 'service_role', 'system')),
  effective_capabilities jsonb,
  target_type text not null,
  target_id uuid,
  before_state jsonb,
  after_state jsonb,
  reason text,
  result text not null check (result in ('success', 'rejected', 'failed')),
  correlation_id uuid,
  jurisdiction text,
  privacy_classification text not null default 'none' check (privacy_classification in ('none', 'contains_pseudonymous_reference', 'contains_personal_data')),
  pseudonymous_subject_ref text,
  supersedes_event_id uuid references public.admin_audit_events(event_id),
  reverses_event_id uuid references public.admin_audit_events(event_id),
  metadata jsonb
);

comment on table public.admin_audit_events is
  'A4.1 — canonical, cross-domain, append-only Admin audit sink (A1_12 §2.1). Every field name and constraint here is taken verbatim from that design document; do not add columns without a corresponding A1_12 update (Standard §16.2).';

comment on column public.admin_audit_events.privacy_classification is
  'Admin audit rows are expected to be "none" or "contains_pseudonymous_reference" only. "contains_personal_data" should never actually occur in Admin audit (A1_12 §2.1) — its presence in the check constraint, rather than omitting the value entirely, is deliberate: it exists so a violation is machine-detectable (queryable) rather than silently impossible to record.';

create index if not exists idx_admin_audit_events_domain_occurred_at on public.admin_audit_events (domain, occurred_at desc);
create index if not exists idx_admin_audit_events_actor_id on public.admin_audit_events (actor_id);
create index if not exists idx_admin_audit_events_correlation_id on public.admin_audit_events (correlation_id) where correlation_id is not null;
create index if not exists idx_admin_audit_events_target on public.admin_audit_events (target_type, target_id) where target_id is not null;

alter table public.admin_audit_events enable row level security;

-- No policy grants SELECT/INSERT/UPDATE/DELETE to `authenticated` or `anon`
-- directly (Standard §6: "never a bare view, never a directly-grantable
-- table"). All access is via SECURITY DEFINER RPCs (not built by this
-- migration — see docs/admin/A2A5_03_A4_DESIGN_AND_STATUS.md §"Not built
-- by this migration"). RLS is enabled with zero policies as defence in
-- depth: even a future accidental GRANT would still deny all rows.

revoke all on public.admin_audit_events from public, anon, authenticated;
grant select, insert on public.admin_audit_events to service_role;

-- Append-only enforcement, mirroring the proven benchmark_update_runs
-- pattern (migration 0125) and ai_config_audit pattern (migration 0115):
-- an unconditional BEFORE UPDATE OR DELETE trigger that raises regardless
-- of caller, including service_role and the table owner. Corrections use
-- supersedes_event_id/reverses_event_id (a new row), never an UPDATE.
create or replace function public.admin_audit_events_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'admin_audit_events is append-only: % is not permitted', tg_op using errcode = '42501';
end;
$$;

drop trigger if exists trg_admin_audit_events_no_update on public.admin_audit_events;
create trigger trg_admin_audit_events_no_update
  before update or delete on public.admin_audit_events
  for each row execute function public.admin_audit_events_immutable();

comment on function public.admin_audit_events_immutable is
  'A4.1 — enforces admin_audit_events append-only posture at the database level, independent of RLS/grants and independent of caller (including service-role). Mirrors benchmark_update_runs_immutable() (migration 0125) and ai_config_audit_immutable() (migration 0115).';

-- =====================================================================
-- 2. admin_security_events — canonical security-event stream (A1_12 §5.2)
-- =====================================================================

create table if not exists public.admin_security_events (
  event_id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  severity text not null check (severity in ('info', 'warning', 'high', 'critical')),
  actor_id uuid references auth.users(id),
  actor_type text not null check (actor_type in ('human_admin', 'service_role', 'system', 'unauthenticated')),
  source text not null check (source in ('api', 'rpc', 'background')),
  domain text not null check (domain in ('resources', 'recommendations', 'benchmarks', 'ai', 'roles', 'fdh', 'security', 'support')),
  event_type text not null,
  target text,
  result text not null check (result in ('denied', 'allowed', 'error')),
  correlation_id uuid,
  safe_metadata jsonb,
  retention_classification text not null check (retention_classification in ('privileged_7y', 'governance_7y', 'routine_2y', 'diagnostic_1y', 'legal_hold')),
  alerting_eligibility boolean not null default false
);

comment on table public.admin_security_events is
  'A4.2 — canonical, cross-domain, append-only security-event stream (A1_12 §5.2). event_type values are NOT constrained by a check constraint here, deliberately: A1_12 §5.1''s taxonomy (AUTHZ_DENIED, repeated-denial, privilege-escalation-attempt, KILL_SWITCH, validation failure, infrastructure failure, etc.) is expected to grow as A4.2''s repeated-denial-detection and privilege-escalation-distinction logic (both explicitly "does not exist" per A1_12 §5.1 as of this migration) are actually built; a hard-coded enum would need a migration for every new event_type, which the append-only, evidence-first design of this table should not require.';

comment on column public.admin_security_events.safe_metadata is
  'Explicit allow-list only — NEVER a raw error object or raw request body (A1_12 §5.2). In particular this must never carry a raw error.message from a PostgREST/Postgres exception — that is exactly the CAP-17/D5-13 residual gap A1_02 recorded in the audit sink''s sibling concern; RPCs writing to this table must map errors the same way lib/services/adminAuth.ts''s safeDbError() already does for API responses before anything reaches this column.';

create index if not exists idx_admin_security_events_domain_occurred_at on public.admin_security_events (domain, occurred_at desc);
create index if not exists idx_admin_security_events_actor_id on public.admin_security_events (actor_id) where actor_id is not null;
create index if not exists idx_admin_security_events_severity on public.admin_security_events (severity, occurred_at desc) where severity in ('high', 'critical');
create index if not exists idx_admin_security_events_correlation_id on public.admin_security_events (correlation_id) where correlation_id is not null;

alter table public.admin_security_events enable row level security;
revoke all on public.admin_security_events from public, anon, authenticated;
grant select, insert on public.admin_security_events to service_role;

create or replace function public.admin_security_events_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'admin_security_events is append-only: % is not permitted', tg_op using errcode = '42501';
end;
$$;

drop trigger if exists trg_admin_security_events_no_update on public.admin_security_events;
create trigger trg_admin_security_events_no_update
  before update or delete on public.admin_security_events
  for each row execute function public.admin_security_events_immutable();

comment on function public.admin_security_events_immutable is
  'A4.2 — enforces admin_security_events append-only posture at the database level, independent of RLS/grants and independent of caller (including service-role). Same pattern as admin_audit_events_immutable() above.';

-- =====================================================================
-- 3. What this migration deliberately does NOT do (see A2A5_03 for detail)
-- =====================================================================
-- - No write RPC is created. Standard §6 requires every privileged write
--   path to be a narrowly-scoped SECURITY DEFINER RPC with a fixed,
--   explicit output-column allow-list and internal auth.uid()-based
--   authorization — designing that RPC correctly (in particular, ensuring
--   application code cannot forge actor_id/actor_type/privacy_classification)
--   deserves its own reviewed pass, not a same-migration afterthought.
-- - No read RPC (CAP-33/canViewAdminAuditLog, CAP-34/canViewSecurityEvents)
--   is created — both are still "Proposed" in A1_02, zero holders assigned.
-- - No existing route or domain table is changed to dual-write here.
-- - correlation_id threading through API -> RPC -> audit row (A1_12 §4,
--   named gap) is schema-ready (the column exists) but not implemented by
--   any call site in this migration.
-- - Repeated-denial detection and privilege-escalation distinction (A1_12
--   §5.1, both confirmed "does not exist" anywhere in this codebase) are
--   not implemented — admin_security_events can RECORD such an event once
--   something detects and classifies it, but nothing yet does that
--   detection.
