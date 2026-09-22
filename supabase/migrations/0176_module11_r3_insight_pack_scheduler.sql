-- Module 11 AI Remediation Programme (2026-09-22) — R3: real async batch
-- + monthly Insight Pack scheduler (brief sections 22-33; ADR-M11-002,
-- docs/ai/module11-remediation-2026-09-22/ADR-M11-002-monthly-insight-pack-scheduling.md).
--
-- MIGRATION NUMBER: 0176 — next after this programme's own 0175; 0173/0174
-- remain held by unmerged AIE branches (see 0175's header).
--
-- ADDITIVE ONLY. No Module 1-10 table is touched. Every new table is
-- governance-only (RLS enabled, ZERO policies — service-role only), matching
-- ai_insight_pack_batches / ai_model_registry / ai_platform_controls.
--
-- NO pg_cron SCHEDULE IS REGISTERED HERE. Exactly as migrations 0155/0166
-- (NAV1) decided under the same binding override: an autonomous agent does
-- not activate a scheduled job. The exact cron.schedule(...) statement and
-- the Vault secret an operator must create are in the ADR's runbook section.
-- Everything this migration creates is inert until (a) an operator registers
-- the schedule AND (b) ai_platform_controls.scheduler_enabled is flipped ON
-- (it ships OFF, fail-closed).

-- ---------------------------------------------------------------------------
-- A. Scheduler kill switch (brief section 36 "batch switch"; ADR decision 6).
-- Separate from batch_generation_enabled on purpose: batch_generation_enabled
-- governs whether ANY pack generation may be admitted (single-call admin
-- generations included); scheduler_enabled governs only whether the
-- unattended monthly job may START. Ships false. Migration 0115's generic
-- jsonb-diff audit trigger records every change to it in ai_config_audit.
-- ---------------------------------------------------------------------------
alter table ai_platform_controls
  add column if not exists scheduler_enabled boolean not null default false;
comment on column ai_platform_controls.scheduler_enabled is
  'Module 11 R3: whether the unattended monthly Insight Pack scheduler may run at all. Ships false. Independent of batch_generation_enabled (which gates every pack admission).';

-- ---------------------------------------------------------------------------
-- B. Provider-batch bookkeeping on ai_insight_pack_batches (ADR decisions 3,
-- 5, 7). A real provider batch is ASYNC: the submit call returns a provider
-- batch id and the results arrive later, so the id (and the provider's own
-- status/file ids) must be persisted for a LATER reconcile invocation.
-- ---------------------------------------------------------------------------
alter table ai_insight_pack_batches
  add column if not exists provider_batch_id text,
  add column if not exists provider_input_file_id text,
  add column if not exists provider_output_file_id text,
  add column if not exists provider_status text,
  add column if not exists poll_count integer not null default 0 check (poll_count >= 0),
  add column if not exists next_poll_at timestamptz,
  add column if not exists cost_pricing_basis text check (cost_pricing_basis is null or cost_pricing_basis in ('standard', 'batch'));
create index if not exists idx_ai_insight_pack_batches_open on ai_insight_pack_batches (status, next_poll_at) where status = 'SUBMITTED';

-- The admission reservation must survive until reconciliation so it can be
-- finalised (success) or refunded (failure) in a DIFFERENT process from the
-- one that admitted it.
alter table ai_insight_packs
  add column if not exists admission_id uuid;
comment on column ai_insight_packs.admission_id is
  'Module 11 R3: the ai_admission_events reservation this pack holds while a provider batch is in flight; finalised or refunded at reconciliation.';

-- ---------------------------------------------------------------------------
-- C. Scheduler runs — one row per invocation of a phase, with a lease-based
-- claim so two overlapping cron ticks (or a cron tick and an admin manual
-- run) cannot both execute the same phase (ADR decision 4: locking).
-- ---------------------------------------------------------------------------
create table if not exists ai_insight_pack_scheduler_runs (
  id uuid primary key default gen_random_uuid(),
  phase text not null check (phase in ('submit', 'reconcile')),
  triggered_by text not null check (triggered_by in ('cron', 'admin', 'dev')),
  status text not null default 'RUNNING' check (status in ('RUNNING', 'COMPLETED', 'FAILED', 'SKIPPED', 'LEASE_EXPIRED')),
  dry_run boolean not null default false,
  billing_period text not null,
  started_at timestamptz not null default now(),
  lease_until timestamptz not null,
  finished_at timestamptz,
  discovered_count integer not null default 0,
  skipped_count integer not null default 0,
  submitted_count integer not null default 0,
  reconciled_count integer not null default 0,
  failed_count integer not null default 0,
  batch_id uuid references ai_insight_pack_batches(id) on delete set null,
  error_summary text,
  created_at timestamptz not null default now()
);
-- At most ONE RUNNING run per phase at any time — the DB is the lock.
create unique index if not exists uq_ai_insight_pack_scheduler_runs_running on ai_insight_pack_scheduler_runs (phase) where status = 'RUNNING';
create index if not exists idx_ai_insight_pack_scheduler_runs_period on ai_insight_pack_scheduler_runs (billing_period, phase, started_at desc);
alter table ai_insight_pack_scheduler_runs enable row level security;

-- ---------------------------------------------------------------------------
-- D. Scheduler jobs — one row per (billing_period, subject). This is the
-- duplicate-suppression ledger (ADR decision 2 / brief section 27): a
-- subject is DISCOVERED at most once per billing period no matter how many
-- ticks run, and its terminal state is recorded here independently of the
-- pack row (a pack may be superseded later; the job record stays).
-- ---------------------------------------------------------------------------
create table if not exists ai_insight_pack_scheduler_jobs (
  id uuid primary key default gen_random_uuid(),
  billing_period text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  household_id uuid references households(id) on delete cascade,
  status text not null default 'DISCOVERED' check (status in ('DISCOVERED', 'SKIPPED', 'SUBMITTED', 'READY', 'PARTIAL', 'FAILED')),
  skip_reason text,
  failure_code text,
  pack_id uuid references ai_insight_packs(id) on delete set null,
  batch_id uuid references ai_insight_pack_batches(id) on delete set null,
  run_id uuid references ai_insight_pack_scheduler_runs(id) on delete set null,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_ai_insight_pack_scheduler_jobs_period_subject unique (billing_period, user_id)
);
create index if not exists idx_ai_insight_pack_scheduler_jobs_status on ai_insight_pack_scheduler_jobs (billing_period, status);
alter table ai_insight_pack_scheduler_jobs enable row level security;

-- ---------------------------------------------------------------------------
-- E. Claim / release — SECURITY DEFINER so the claim is atomic and cannot be
-- forged from application code. Service-role only: EXECUTE revoked from
-- PUBLIC, anon AND authenticated (this is an internal job control, not an
-- end-user or admin-analytics RPC, so the Admin Standard's section 6 aggregate
-- rules do not apply — but its least-privilege rules are honoured anyway).
--
-- ai_insight_pack_scheduler_claim(): expires any RUNNING run of this phase
-- whose lease has passed (a crashed worker), then tries to insert a new
-- RUNNING run. The partial unique index makes a concurrent second claim
-- raise unique_violation, which is caught and returned as NULL = "somebody
-- else holds the lease". No advisory locks (they are session-scoped and
-- PostgREST connections are pooled), no application-side mutex.
-- ---------------------------------------------------------------------------
create or replace function ai_insight_pack_scheduler_claim(
  p_phase text,
  p_triggered_by text,
  p_billing_period text,
  p_lease_seconds integer default 900,
  p_dry_run boolean default false
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_phase not in ('submit', 'reconcile') then
    raise exception 'invalid phase %', p_phase using errcode = '22023';
  end if;
  if p_lease_seconds <= 0 or p_lease_seconds > 3600 then
    raise exception 'lease must be 1..3600 seconds' using errcode = '22023';
  end if;

  update public.ai_insight_pack_scheduler_runs
     set status = 'LEASE_EXPIRED', finished_at = now(), error_summary = coalesce(error_summary, 'lease expired without release')
   where phase = p_phase and status = 'RUNNING' and lease_until < now();

  begin
    insert into public.ai_insight_pack_scheduler_runs (phase, triggered_by, billing_period, lease_until, dry_run)
    values (p_phase, p_triggered_by, p_billing_period, now() + make_interval(secs => p_lease_seconds), p_dry_run)
    returning id into v_id;
  exception when unique_violation then
    return null;
  end;
  return v_id;
end;
$$;

create or replace function ai_insight_pack_scheduler_release(
  p_run_id uuid,
  p_status text,
  p_counts jsonb default '{}'::jsonb,
  p_error text default null,
  p_batch_id uuid default null
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated integer;
begin
  if p_status not in ('COMPLETED', 'FAILED', 'SKIPPED') then
    raise exception 'invalid release status %', p_status using errcode = '22023';
  end if;
  update public.ai_insight_pack_scheduler_runs
     set status = p_status,
         finished_at = now(),
         discovered_count = coalesce((p_counts->>'discovered')::integer, discovered_count),
         skipped_count = coalesce((p_counts->>'skipped')::integer, skipped_count),
         submitted_count = coalesce((p_counts->>'submitted')::integer, submitted_count),
         reconciled_count = coalesce((p_counts->>'reconciled')::integer, reconciled_count),
         failed_count = coalesce((p_counts->>'failed')::integer, failed_count),
         error_summary = p_error,
         batch_id = coalesce(p_batch_id, batch_id)
   where id = p_run_id and status = 'RUNNING';
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

revoke execute on function ai_insight_pack_scheduler_claim(text, text, text, integer, boolean) from public, anon, authenticated;
revoke execute on function ai_insight_pack_scheduler_release(uuid, text, jsonb, text, uuid) from public, anon, authenticated;
grant execute on function ai_insight_pack_scheduler_claim(text, text, text, integer, boolean) to service_role;
grant execute on function ai_insight_pack_scheduler_release(uuid, text, jsonb, text, uuid) to service_role;

comment on function ai_insight_pack_scheduler_claim(text, text, text, integer, boolean) is
  'Module 11 R3: atomic lease claim for one scheduler phase. NULL = another run holds the lease. Service-role only.';
comment on function ai_insight_pack_scheduler_release(uuid, text, jsonb, text, uuid) is
  'Module 11 R3: releases a claimed run with its terminal status and counts. Service-role only.';
