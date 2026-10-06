-- 0270 -- Planning Benchmarks staged upload (PO finding F5).
--
-- WHAT THIS DOES
--   Adds the staging layer for uploading Planning Benchmark figures. Uploaded rows land in staging
--   tables and are previewed. Only an explicit, separately authorised Activate makes them live, in one
--   transaction, end-dating the figures they replace (effective_to) and never duplicating a live row.
--   Design and trade-offs: docs/planning-benchmarks/UPLOAD_DESIGN.md.
--
-- WHAT THIS ADDS
--   1. Two separately named capabilities on admin_users, both default false, granted to nobody here:
--        can_upload_planning_benchmarks    stage, preview, discard own batch
--        can_activate_planning_benchmarks  activate a staged batch, discard any batch
--      and three predicates (uploader, activator, viewer = either).
--   2. Three tables with RLS on: benchmark_upload_batches, benchmark_upload_rows and the append-only
--      benchmark_upload_events.
--   3. Internal helper functions (no EXECUTE for API roles) and four RPCs: stage, get, activate,
--      discard. Every RPC authorises with auth.uid() and the capability itself.
--
-- WHAT THIS DOES NOT DO
--   It alters no existing table except adding two columns to admin_users. It drops and recreates no
--   constraint, widens no shared check list, adds no unique key to the live benchmark tables, grants no
--   capability, loads no figure and activates nothing.
--
-- ROLLBACK: see docs/planning-benchmarks/po_apply_upload/README.md (drop the three tables, the
-- functions and the two columns). All statements here are safe to run twice.
--
-- HAND-RUN SAFETY: this file avoids the constructs that broke a paste in the Supabase SQL editor
-- before (see tests/unit/planningBenchmarkUploadMigration.test.ts): ASCII only, no bare dollar quote,
-- no percent sign, no double quote, no semicolon or quote inside a comment or string.

do $do$ begin
  if to_regclass('public.benchmark_datasets') is null or to_regclass('public.benchmark_values') is null
     or to_regclass('public.benchmark_target_ranges') is null or to_regclass('public.benchmark_cohorts') is null
     or to_regclass('public.benchmark_update_runs') is null or to_regclass('public.admin_users') is null then
    raise exception 'planning benchmark upload needs the benchmark tables of migration 0011 and admin_users';
  end if;
end $do$;

-- ===========================================================================
-- 1. Capabilities
-- ===========================================================================
alter table admin_users add column if not exists can_upload_planning_benchmarks boolean not null default false;
alter table admin_users add column if not exists can_activate_planning_benchmarks boolean not null default false;
comment on column admin_users.can_upload_planning_benchmarks is 'F5: authorises staging a Planning Benchmarks upload, viewing previews and discarding the batch the holder staged. Separately named. Not implied by any other can_ column or by Super Admin.';
comment on column admin_users.can_activate_planning_benchmarks is 'F5: authorises ACTIVATING a staged Planning Benchmarks upload (making it live) and discarding any batch. Separately named. Not implied by any other can_ column or by Super Admin.';

create or replace function is_planning_benchmark_uploader() returns boolean
language sql stable security definer set search_path = '' as $fn$
  select exists (select 1 from public.admin_users u where u.user_id = auth.uid() and u.can_upload_planning_benchmarks = true);
$fn$;
create or replace function is_planning_benchmark_activator() returns boolean
language sql stable security definer set search_path = '' as $fn$
  select exists (select 1 from public.admin_users u where u.user_id = auth.uid() and u.can_activate_planning_benchmarks = true);
$fn$;
create or replace function is_planning_benchmark_viewer() returns boolean
language sql stable security definer set search_path = '' as $fn$
  select exists (select 1 from public.admin_users u where u.user_id = auth.uid() and (u.can_upload_planning_benchmarks = true or u.can_activate_planning_benchmarks = true));
$fn$;
revoke all on function is_planning_benchmark_uploader(), is_planning_benchmark_activator(), is_planning_benchmark_viewer() from public, anon;
grant execute on function is_planning_benchmark_uploader(), is_planning_benchmark_activator(), is_planning_benchmark_viewer() to authenticated, service_role;

-- ===========================================================================
-- 2. Staging tables
-- ===========================================================================
create table if not exists benchmark_upload_batches (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('values', 'target_ranges', 'cohorts')),
  dataset_id uuid not null references benchmark_datasets(id),
  dataset_name text not null,
  dataset_version text not null,
  file_name text not null check (length(file_name) between 1 and 255),
  file_sha256 text not null check (length(file_sha256) = 64),
  file_bytes integer not null check (file_bytes > 0),
  template_version text not null,
  status text not null default 'staged' check (status in ('staged', 'activated', 'discarded')),
  row_count integer not null check (row_count > 0),
  counts jsonb not null default '{}'::jsonb,
  staging_digest text not null,
  staged_by uuid not null,
  staged_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '14 days'),
  activated_by uuid,
  activated_at timestamptz,
  self_activated boolean not null default false,
  discarded_by uuid,
  discarded_at timestamptz,
  discard_reason text,
  result jsonb,
  update_run_id uuid references benchmark_update_runs(id),
  constraint benchmark_upload_batches_state_attributed check (
    (status = 'staged' and activated_at is null and discarded_at is null)
    or (status = 'activated' and activated_by is not null and activated_at is not null and result is not null)
    or (status = 'discarded' and discarded_by is not null and discarded_at is not null)
  )
);
create unique index if not exists benchmark_upload_batches_one_activation on benchmark_upload_batches (file_sha256, kind, dataset_id) where status = 'activated';
create index if not exists idx_benchmark_upload_batches_recent on benchmark_upload_batches (staged_at desc);
create index if not exists idx_benchmark_upload_batches_sha on benchmark_upload_batches (file_sha256, kind, dataset_id) where status = 'staged';

create table if not exists benchmark_upload_rows (
  batch_id uuid not null references benchmark_upload_batches(id) on delete cascade,
  row_no integer not null check (row_no >= 1),
  payload jsonb not null,
  classification text not null check (classification in ('new', 'changed', 'unchanged', 'conflict')),
  detail text,
  live_ids uuid[] not null default '{}',
  primary key (batch_id, row_no)
);

create table if not exists benchmark_upload_events (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references benchmark_upload_batches(id),
  event_type text not null check (event_type in ('staged', 'activated', 'discarded')),
  actor_user_id uuid not null,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_benchmark_upload_events_batch on benchmark_upload_events (batch_id, created_at);

alter table benchmark_upload_batches enable row level security;
alter table benchmark_upload_rows enable row level security;
alter table benchmark_upload_events enable row level security;
drop policy if exists benchmark_upload_batches_viewer_read on benchmark_upload_batches;
create policy benchmark_upload_batches_viewer_read on benchmark_upload_batches for select using (public.is_planning_benchmark_viewer());
drop policy if exists benchmark_upload_rows_viewer_read on benchmark_upload_rows;
create policy benchmark_upload_rows_viewer_read on benchmark_upload_rows for select using (public.is_planning_benchmark_viewer());
drop policy if exists benchmark_upload_events_viewer_read on benchmark_upload_events;
create policy benchmark_upload_events_viewer_read on benchmark_upload_events for select using (public.is_planning_benchmark_viewer());
revoke all on table benchmark_upload_batches, benchmark_upload_rows, benchmark_upload_events from anon, authenticated;
grant select on table benchmark_upload_batches, benchmark_upload_rows, benchmark_upload_events to authenticated;

create or replace function benchmark_upload_events_append_only() returns trigger
language plpgsql set search_path = '' as $fn$
begin
  raise exception using errcode = '42501', message = 'benchmark_upload_events is append-only: ' || tg_op || ' is not permitted';
end;
$fn$;
drop trigger if exists trg_benchmark_upload_events_append_only on benchmark_upload_events;
create trigger trg_benchmark_upload_events_append_only before update or delete on benchmark_upload_events
  for each row execute function benchmark_upload_events_append_only();

create or replace function benchmark_upload_batches_no_delete() returns trigger
language plpgsql set search_path = '' as $fn$
begin
  raise exception using errcode = '42501', message = 'benchmark_upload_batches rows are never deleted. Discard the batch instead.';
end;
$fn$;
drop trigger if exists trg_benchmark_upload_batches_no_delete on benchmark_upload_batches;
create trigger trg_benchmark_upload_batches_no_delete before delete on benchmark_upload_batches
  for each row execute function benchmark_upload_batches_no_delete();

-- ---------------------------------------------------------------------------
