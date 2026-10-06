-- 0277 -- Planning Benchmarks: which metrics belong to which dataset (PO decision 07/10/2026: yes, add the metric mapping).
--
-- WHAT THIS DOES
--   Until now the database let any open dataset accept any registered metric, so an upload could put a metric
--   in a dataset it does not belong to. This adds the missing rule: a table that records, per dataset, the
--   metrics it may hold and which kind of file each applies to (observed values, planning target ranges, or
--   both). The staged upload of migration 0275 then refuses a row whose metric is not mapped to the dataset
--   for that kind of file, twice: when the rows are staged and again when the batch is activated.
--   Design and trade-offs: docs/planning-benchmarks/UPLOAD_DESIGN.md section 14.
--   The seeded rows are listed, with their evidence, in docs/planning-benchmarks/DATASET_METRIC_MAPPING.md.
--
-- WHAT THIS ADDS
--   1. benchmark_dataset_metrics: one row per dataset and metric pair, readable like the other benchmark
--      reference tables, written only by the two functions below (no insert, update or delete grant).
--   2. benchmark_dataset_metric_events: an append-only audit trail of every change to the mapping.
--   3. A trigger that refuses a staged row whose metric is not mapped, and a stricter pb_dataset_readiness
--      so a preview shows the problem and Activate refuses it (defence in depth).
--   4. Two functions to maintain the mapping without SQL, both needing the existing activate permission
--      (is_planning_benchmark_activator, migration 0275). No new capability is created.
--
-- WHAT THIS DOES NOT DO
--   It alters no existing table, drops and recreates no constraint, widens no shared check list, grants no
--   capability, loads no figure and changes no dataset. The seed runs only while the mapping table is empty,
--   so running this file again never undoes a change made through the screen.
--
-- ROLLBACK: see docs/planning-benchmarks/po_apply_mapping/README.md. All statements here are safe to run twice.
--
-- HAND-RUN SAFETY: this file avoids the constructs that broke a paste in the Supabase SQL editor before
-- (see tests/unit/planningBenchmarkDatasetMetricMapping.test.ts): ASCII only, no bare dollar quote, no
-- percent sign, no double quote, no semicolon or quote inside a comment, no statement word followed by a
-- name inside a comment or a string.

do $do$ begin
  if to_regclass('public.benchmark_datasets') is null or to_regclass('public.benchmark_metric_definitions') is null
     or to_regclass('public.benchmark_upload_batches') is null or to_regclass('public.benchmark_upload_rows') is null
     or to_regclass('public.admin_users') is null then
    raise exception 'the dataset metric mapping needs the benchmark tables of migration 0011 and the staged upload of migration 0275';
  end if;
end $do$;

-- ===========================================================================
-- 1. The mapping and its audit trail
-- ===========================================================================
create table if not exists benchmark_dataset_metrics (
  id uuid primary key default gen_random_uuid(),
  dataset_id uuid not null references benchmark_datasets(id),
  metric_definition_id uuid not null references benchmark_metric_definitions(id),
  applies_to_values boolean not null default false,
  applies_to_target_ranges boolean not null default false,
  evidence_note text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  constraint benchmark_dataset_metrics_one_pair unique (dataset_id, metric_definition_id),
  constraint benchmark_dataset_metrics_some_kind check (applies_to_values or applies_to_target_ranges)
);
create index if not exists idx_benchmark_dataset_metrics_metric on benchmark_dataset_metrics (metric_definition_id);

create table if not exists benchmark_dataset_metric_events (
  id uuid primary key default gen_random_uuid(),
  dataset_id uuid not null references benchmark_datasets(id),
  metric_definition_id uuid not null references benchmark_metric_definitions(id),
  dataset_name text not null,
  dataset_version text not null,
  metric_code text not null,
  action text not null check (action in ('added', 'changed', 'removed')),
  values_before boolean,
  ranges_before boolean,
  values_after boolean,
  ranges_after boolean,
  live_figures integer not null default 0,
  live_confirmed boolean not null default false,
  staged_batches integer not null default 0,
  reason text not null check (length(reason) between 3 and 500),
  actor_user_id uuid not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_benchmark_dataset_metric_events_recent on benchmark_dataset_metric_events (created_at desc);

alter table benchmark_dataset_metrics enable row level security;
alter table benchmark_dataset_metric_events enable row level security;
drop policy if exists benchmark_dataset_metrics_read on benchmark_dataset_metrics;
create policy benchmark_dataset_metrics_read on benchmark_dataset_metrics for select using (true);
drop policy if exists benchmark_dataset_metric_events_viewer_read on benchmark_dataset_metric_events;
create policy benchmark_dataset_metric_events_viewer_read on benchmark_dataset_metric_events for select using (public.is_planning_benchmark_viewer());
revoke all on table benchmark_dataset_metrics, benchmark_dataset_metric_events from anon, authenticated;
grant select on table benchmark_dataset_metrics to anon, authenticated;
grant select on table benchmark_dataset_metric_events to authenticated;

create or replace function benchmark_dataset_metric_events_append_only() returns trigger
language plpgsql set search_path = '' as $fn$
begin
  raise exception using errcode = '42501', message = 'benchmark_dataset_metric_events is append-only: ' || tg_op || ' is not permitted';
end;
$fn$;
drop trigger if exists trg_benchmark_dataset_metric_events_append_only on benchmark_dataset_metric_events;
create trigger trg_benchmark_dataset_metric_events_append_only before update or delete on benchmark_dataset_metric_events
  for each row execute function benchmark_dataset_metric_events_append_only();

-- ---------------------------------------------------------------------------
