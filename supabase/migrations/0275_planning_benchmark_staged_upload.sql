-- 0275 -- Planning Benchmarks staged upload (PO finding F5).
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
-- PART B starts here
-- ---------------------------------------------------------------------------
-- ===========================================================================
-- 3. Internal helpers (no EXECUTE for API roles - only the RPCs below call them)
-- ===========================================================================

-- The live band tiers of a target-range group that a batch would replace as a set but does not restate.
create or replace function pb_removed_band_ids(p_batch uuid) returns uuid[]
language sql stable security definer set search_path = '' as $fn$
  select coalesce(array_agg(tr.id order by tr.id), '{}'::uuid[])
    from public.benchmark_target_ranges tr
   where (tr.effective_to is null or tr.effective_to > current_date)
     and exists (
       select 1 from public.benchmark_upload_rows r
        where r.batch_id = p_batch
          and (r.payload ->> 'metric_definition_id')::uuid = tr.metric_definition_id
          and nullif(r.payload ->> 'country_code', '') is not distinct from tr.country_code::text
          and nullif(r.payload ->> 'life_stage', '') is not distinct from tr.life_stage
          and nullif(r.payload ->> 'household_type', '') is not distinct from tr.household_type)
     and not exists (
       select 1 from public.benchmark_upload_rows r
        where r.batch_id = p_batch
          and (r.payload ->> 'metric_definition_id')::uuid = tr.metric_definition_id
          and nullif(r.payload ->> 'country_code', '') is not distinct from tr.country_code::text
          and nullif(r.payload ->> 'life_stage', '') is not distinct from tr.life_stage
          and nullif(r.payload ->> 'household_type', '') is not distinct from tr.household_type
          and (r.payload ->> 'band_tier')::integer = tr.band_tier);
$fn$;

-- Classify every staged row of a batch against the CURRENT live tables. Pure read.
--   new        no live figure for the key
--   unchanged  exactly one live figure, same dataset, same content (it is left alone, never duplicated)
--   changed    one or more live figures that this row replaces (they are end-dated on activation)
--   conflict   a live figure for the key belongs to another dataset (or a cohort differs, or the live
--              bands are cited by another source). A batch with a conflict cannot be activated.
create or replace function pb_classify_rows(p_batch uuid)
returns table (row_no integer, cls text, live_ids uuid[], detail text)
language plpgsql stable security definer set search_path = '' as $fn$
declare
  b record;
begin
  select * into b from public.benchmark_upload_batches where id = p_batch;
  if not found then return; end if;

  if b.kind = 'values' then
    return query
    select r.row_no,
           case
             when coalesce(bool_or(d.dataset_name <> b.dataset_name), false) then 'conflict'
             when count(v.id) = 0 then 'new'
             when count(v.id) = 1 and coalesce(bool_and(v.dataset_id = b.dataset_id
                   and v.value_numeric = round((r.payload ->> 'value_numeric')::numeric, 4)
                   and v.unit is not distinct from (r.payload ->> 'unit')
                   and v.original_currency::text is not distinct from nullif(r.payload ->> 'original_currency', '')
                   and v.base_date is not distinct from nullif(r.payload ->> 'base_date', '')::date), false) then 'unchanged'
             else 'changed'
           end,
           coalesce(array_agg(v.id order by v.id) filter (where v.id is not null), '{}'::uuid[]),
           case
             when coalesce(bool_or(d.dataset_name <> b.dataset_name), false)
               then 'A live figure for this metric, cohort and statistic belongs to another dataset: ' || coalesce(string_agg(distinct d.dataset_name, ', ') filter (where d.dataset_name <> b.dataset_name), '')
             when count(v.id) > 1 then 'More than one live figure exists for this key. All of them are replaced.'
             else null
           end
      from public.benchmark_upload_rows r
      left join public.benchmark_values v
        on v.metric_definition_id = (r.payload ->> 'metric_definition_id')::uuid
       and v.cohort_id is not distinct from nullif(r.payload ->> 'cohort_id', '')::uuid
       and v.statistic_type = r.payload ->> 'statistic_type'
       and (v.effective_to is null or v.effective_to > current_date)
      left join public.benchmark_datasets d on d.id = v.dataset_id
     where r.batch_id = p_batch
     group by r.row_no, r.payload;

  elsif b.kind = 'target_ranges' then
    return query
    select r.row_no,
           case
             when exists (
               select 1 from public.benchmark_target_ranges g
                where (g.effective_to is null or g.effective_to > current_date)
                  and g.metric_definition_id = (r.payload ->> 'metric_definition_id')::uuid
                  and g.country_code::text is not distinct from nullif(r.payload ->> 'country_code', '')
                  and g.life_stage is not distinct from nullif(r.payload ->> 'life_stage', '')
                  and g.household_type is not distinct from nullif(r.payload ->> 'household_type', '')
                  and g.benchmark_source_id is not null
                  and g.benchmark_source_id is distinct from (r.payload ->> 'source_id')::uuid) then 'conflict'
             when count(t.id) = 0 then 'new'
             when count(t.id) = 1 and coalesce(bool_and(t.band_label = (r.payload ->> 'band_label')
                   and t.lower_bound is not distinct from nullif(r.payload ->> 'lower_bound', '')::numeric
                   and t.upper_bound is not distinct from nullif(r.payload ->> 'upper_bound', '')::numeric
                   and t.direction = (r.payload ->> 'direction')
                   and t.evidence_level = (r.payload ->> 'evidence_level')
                   and t.model_version = (r.payload ->> 'model_version')
                   and t.benchmark_source_id is not distinct from (r.payload ->> 'source_id')::uuid), false) then 'unchanged'
             else 'changed'
           end,
           coalesce(array_agg(t.id order by t.id) filter (where t.id is not null), '{}'::uuid[]),
           case
             when exists (
               select 1 from public.benchmark_target_ranges g
                where (g.effective_to is null or g.effective_to > current_date)
                  and g.metric_definition_id = (r.payload ->> 'metric_definition_id')::uuid
                  and g.country_code::text is not distinct from nullif(r.payload ->> 'country_code', '')
                  and g.life_stage is not distinct from nullif(r.payload ->> 'life_stage', '')
                  and g.household_type is not distinct from nullif(r.payload ->> 'household_type', '')
                  and g.benchmark_source_id is not null
                  and g.benchmark_source_id is distinct from (r.payload ->> 'source_id')::uuid)
               then 'The live bands for this group are cited by a different source.'
             when count(t.id) > 1 then 'More than one live band exists for this tier. All of them are replaced.'
             else null
           end
      from public.benchmark_upload_rows r
      left join public.benchmark_target_ranges t
        on t.metric_definition_id = (r.payload ->> 'metric_definition_id')::uuid
       and t.country_code::text is not distinct from nullif(r.payload ->> 'country_code', '')
       and t.life_stage is not distinct from nullif(r.payload ->> 'life_stage', '')
       and t.household_type is not distinct from nullif(r.payload ->> 'household_type', '')
       and t.band_tier = (r.payload ->> 'band_tier')::integer
       and (t.effective_to is null or t.effective_to > current_date)
     where r.batch_id = p_batch
     group by r.row_no, r.payload;

  else
    return query
    select r.row_no,
           case
             when c.id is null then 'new'
             when c.country_code::text is not distinct from nullif(r.payload ->> 'country_code', '')
              and c.region_code is not distinct from nullif(r.payload ->> 'region_code', '')
              and c.urban_rural is not distinct from nullif(r.payload ->> 'urban_rural', '')
              and c.age_band is not distinct from nullif(r.payload ->> 'age_band', '')
              and c.income_band is not distinct from nullif(r.payload ->> 'income_band', '')
              and c.household_type is not distinct from nullif(r.payload ->> 'household_type', '')
              and c.life_stage is not distinct from nullif(r.payload ->> 'life_stage', '')
              and c.housing_tenure is not distinct from nullif(r.payload ->> 'housing_tenure', '')
              and c.employment_type is not distinct from nullif(r.payload ->> 'employment_type', '')
              and c.dependant_band is not distinct from nullif(r.payload ->> 'dependant_band', '')
              and c.financial_dna_code is not distinct from nullif(r.payload ->> 'financial_dna_code', '')
              and c.cross_border_flag = (r.payload ->> 'cross_border_flag')::boolean
              and c.cohort_tier = (r.payload ->> 'cohort_tier')::integer
              and c.sample_size is not distinct from nullif(r.payload ->> 'sample_size', '')::integer
              and c.cohort_description = (r.payload ->> 'cohort_description') then 'unchanged'
             else 'conflict'
           end,
           case when c.id is null then '{}'::uuid[] else array[c.id] end,
           case when c.id is not null and not (
               c.country_code::text is not distinct from nullif(r.payload ->> 'country_code', '')
               and c.cohort_tier = (r.payload ->> 'cohort_tier')::integer
               and c.cohort_description = (r.payload ->> 'cohort_description')
               and c.age_band is not distinct from nullif(r.payload ->> 'age_band', '')
               and c.region_code is not distinct from nullif(r.payload ->> 'region_code', '')
               and c.urban_rural is not distinct from nullif(r.payload ->> 'urban_rural', '')
               and c.income_band is not distinct from nullif(r.payload ->> 'income_band', '')
               and c.household_type is not distinct from nullif(r.payload ->> 'household_type', '')
               and c.life_stage is not distinct from nullif(r.payload ->> 'life_stage', '')
               and c.housing_tenure is not distinct from nullif(r.payload ->> 'housing_tenure', '')
               and c.employment_type is not distinct from nullif(r.payload ->> 'employment_type', '')
               and c.dependant_band is not distinct from nullif(r.payload ->> 'dependant_band', '')
               and c.financial_dna_code is not distinct from nullif(r.payload ->> 'financial_dna_code', '')
               and c.cross_border_flag = (r.payload ->> 'cross_border_flag')::boolean
               and c.sample_size is not distinct from nullif(r.payload ->> 'sample_size', '')::integer)
             then 'A cohort with this code already exists with different details. Cohorts cannot be edited here.'
             else null end
      from public.benchmark_upload_rows r
      left join public.benchmark_cohorts c on c.cohort_code = (r.payload ->> 'cohort_code')
     where r.batch_id = p_batch;
  end if;
end;
$fn$;

-- The digest an Activate is bound to: batch identity plus every row, its CURRENT classification, the live
-- rows it would replace and the bands that would be removed. If live data moves, the digest moves.
create or replace function pb_batch_digest(p_batch uuid) returns text
language sql stable security definer set search_path = '' as $fn$
  select encode(sha256(convert_to(
    coalesce((select b.kind || '|' || b.dataset_id::text || '|' || b.file_sha256 || '|' || b.template_version from public.benchmark_upload_batches b where b.id = p_batch), '')
    || chr(10) ||
    coalesce((select string_agg(r.row_no::text || ',' || c.cls || ',' || r.payload::text || ',' || coalesce(array_to_string(c.live_ids, ','), ''), chr(10) order by r.row_no)
                from public.benchmark_upload_rows r
                join public.pb_classify_rows(p_batch) c on c.row_no = r.row_no
               where r.batch_id = p_batch), '')
    || chr(10) || 'removed:' || coalesce(array_to_string(public.pb_removed_band_ids(p_batch), ','), ''),
    'UTF8')), 'hex');
$fn$;

-- Readiness of the target dataset for activation: the rules of validateDatasetForActivation
-- (lib/services/benchmarkGovernance.ts) with two deliberate differences. The source must be approved
-- or active (the original lets an under-review or superseded source through although its own message
-- says approved or active) and a suspended, archived or superseded dataset is refused. The rule that an
-- observed or regulatory dataset needs at least one value is met by the staged values themselves,
-- which is what lets a first load activate.
create or replace function pb_dataset_readiness(p_dataset uuid, p_batch uuid) returns text[]
language plpgsql stable security definer set search_path = '' as $fn$
declare
  d record;
  s record;
  b record;
  errs text[] := '{}';
  v_live integer;
  v_staged integer;
begin
  select * into d from public.benchmark_datasets where id = p_dataset;
  if not found then return array['Dataset not found.']; end if;
  select * into s from public.benchmark_sources where id = d.benchmark_source_id;
  if not found then
    errs := array_append(errs, 'No source is linked to this dataset.');
  else
    if s.citation_text is null or length(trim(s.citation_text)) = 0 then errs := array_append(errs, 'Source citation is missing.'); end if;
    if s.publication_date is null and s.reference_period_start is null then errs := array_append(errs, 'Source period is missing.'); end if;
    if s.status not in ('approved', 'active') then
      errs := array_append(errs, 'Source status is ' || s.status || ' - it must be approved or active before this dataset can activate.');
    end if;
  end if;
  if d.data_status in ('suspended', 'archived', 'superseded') then
    errs := array_append(errs, 'Dataset status is ' || d.data_status || ' - it cannot receive an upload.');
  end if;
  if d.source_period is null or length(trim(d.source_period)) = 0 then errs := array_append(errs, 'Dataset source period is missing.'); end if;
  if d.geography_level is null or length(trim(d.geography_level)) = 0 then errs := array_append(errs, 'Dataset geography level is missing.'); end if;
  if d.statistic_coverage is null or length(trim(d.statistic_coverage)) = 0 then errs := array_append(errs, 'Dataset statistic coverage is missing.'); end if;
  if d.benchmark_class in ('observed_market', 'regulatory_statutory') then
    select count(*) into v_live from public.benchmark_values where dataset_id = p_dataset;
    select * into b from public.benchmark_upload_batches where id = p_batch;
    v_staged := 0;
    if found and b.kind = 'values' then
      select count(*) into v_staged from public.benchmark_upload_rows where batch_id = p_batch;
    end if;
    if v_live = 0 and v_staged = 0 then errs := array_append(errs, 'No benchmark value has been recorded for this dataset yet.'); end if;
  end if;
  return errs;
end;
$fn$;

-- Recompute and store the classification of every staged row. Used only while staging.
create or replace function pb_store_classification(p_batch uuid) returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  v_counts jsonb;
begin
  update public.benchmark_upload_rows r
     set classification = c.cls, live_ids = c.live_ids, detail = c.detail
    from public.pb_classify_rows(p_batch) c
   where r.batch_id = p_batch and r.row_no = c.row_no;
  select jsonb_build_object(
           'new', count(*) filter (where classification = 'new'),
           'changed', count(*) filter (where classification = 'changed'),
           'unchanged', count(*) filter (where classification = 'unchanged'),
           'conflict', count(*) filter (where classification = 'conflict'),
           'removed', coalesce(cardinality(public.pb_removed_band_ids(p_batch)), 0))
    into v_counts
    from public.benchmark_upload_rows where batch_id = p_batch;
  return v_counts;
end;
$fn$;

revoke all on function pb_removed_band_ids(uuid), pb_classify_rows(uuid), pb_batch_digest(uuid), pb_dataset_readiness(uuid, uuid), pb_store_classification(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- PART C starts here
-- ---------------------------------------------------------------------------
-- ===========================================================================
-- 4. RPC: stage
-- ===========================================================================
-- p keys: kind, dataset_name, dataset_version, file_name, file_sha256, file_bytes, template_version,
-- rows (array of objects keyed by the template column names, plus row_no).
create or replace function stage_planning_benchmark_upload(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid uuid := auth.uid();
  v_kind text := p ->> 'kind';
  v_id uuid := gen_random_uuid();
  d record;
  v_rows jsonb := p -> 'rows';
  v_n integer;
  v_cnt integer;
  v_sha text := p ->> 'file_sha256';
  v_existing record;
  v_counts jsonb;
  v_digest text;
  v_expected_marker text;
begin
  if v_uid is null or not public.is_planning_benchmark_uploader() then
    raise exception using errcode = '42501', message = 'PB_E_DENIED: the planning benchmark upload permission is required';
  end if;
  if v_kind is null or v_kind not in ('values', 'target_ranges', 'cohorts') then
    raise exception using errcode = '22023', message = 'PB_E_INPUT: unknown upload kind';
  end if;
  v_expected_marker := case v_kind when 'values' then 'FHIP-PB-VALUES-1' when 'target_ranges' then 'FHIP-PB-RANGES-1' else 'FHIP-PB-COHORTS-1' end;
  if p ->> 'template_version' is distinct from v_expected_marker then
    raise exception using errcode = '22023', message = 'PB_E_INPUT: the template version marker does not match this upload kind';
  end if;
  if v_sha is null or v_sha !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'PB_E_INPUT: the file hash is missing or malformed';
  end if;
  if coalesce((p ->> 'file_bytes')::integer, 0) <= 0 or length(coalesce(p ->> 'file_name', '')) not between 1 and 255 then
    raise exception using errcode = '22023', message = 'PB_E_INPUT: the file name or size is missing';
  end if;
  if v_rows is null or jsonb_typeof(v_rows) <> 'array' then
    raise exception using errcode = '22023', message = 'PB_E_INPUT: rows must be an array';
  end if;
  v_n := jsonb_array_length(v_rows);
  if v_n < 1 or v_n > 5000 then
    raise exception using errcode = '22023', message = 'PB_E_INPUT: between 1 and 5000 rows are required';
  end if;

  select * into d from public.benchmark_datasets where dataset_name = p ->> 'dataset_name' and version = p ->> 'dataset_version';
  if not found then
    raise exception using errcode = '22023', message = 'PB_E_DATASET: no dataset exists with that name and version. An upload never creates a dataset';
  end if;
  if d.data_status in ('suspended', 'archived', 'superseded') then
    raise exception using errcode = '55000', message = 'PB_E_DATASET: the dataset is ' || d.data_status || ' and cannot receive an upload';
  end if;

  -- Every row must name the same dataset as the file.
  select count(*) into v_cnt from jsonb_to_recordset(v_rows) as r(dataset_name text, dataset_version text)
   where r.dataset_name is distinct from d.dataset_name or r.dataset_version is distinct from d.version;
  if v_cnt > 0 then
    raise exception using errcode = '22023', message = 'PB_E_ROWS: ' || v_cnt::text || ' row(s) name a different dataset than the file';
  end if;
  select count(*) into v_cnt from jsonb_to_recordset(v_rows) as r(row_no integer) where r.row_no is null or r.row_no < 1;
  if v_cnt > 0 then
    raise exception using errcode = '22023', message = 'PB_E_ROWS: every row needs a positive row number';
  end if;
  select count(*) - count(distinct r.row_no) into v_cnt from jsonb_to_recordset(v_rows) as r(row_no integer);
  if v_cnt > 0 then
    raise exception using errcode = '22023', message = 'PB_E_ROWS: duplicate row numbers';
  end if;

  -- Duplicate protection (idempotency per file hash).
  select id, activated_at into v_existing from public.benchmark_upload_batches
   where file_sha256 = v_sha and kind = v_kind and dataset_id = d.id and status = 'activated' limit 1;
  if found then
    raise exception using errcode = '23505', message = 'PB_E_DUPLICATE: this exact file was already activated for this dataset on ' || to_char(v_existing.activated_at, 'DD/MM/YYYY') || ' (batch ' || v_existing.id::text || ')';
  end if;
  select id, staged_at into v_existing from public.benchmark_upload_batches
   where file_sha256 = v_sha and kind = v_kind and dataset_id = d.id and status = 'staged' and expires_at > now() order by staged_at desc limit 1;
  if found then
    return jsonb_build_object('status', 'already_staged', 'batch_id', v_existing.id);
  end if;

  if v_kind = 'values' then
    select count(*) into v_cnt from jsonb_to_recordset(v_rows) as r(metric_code text)
     where not exists (select 1 from public.benchmark_metric_definitions m where m.metric_code = r.metric_code);
    if v_cnt > 0 then raise exception using errcode = '22023', message = 'PB_E_ROWS: ' || v_cnt::text || ' row(s) name a metric that is not registered'; end if;
    select count(*) into v_cnt from jsonb_to_recordset(v_rows) as r(metric_code text, unit text)
      join public.benchmark_metric_definitions m on m.metric_code = r.metric_code where m.unit is distinct from r.unit;
    if v_cnt > 0 then raise exception using errcode = '22023', message = 'PB_E_ROWS: ' || v_cnt::text || ' row(s) have a unit that differs to the unit the metric is defined in'; end if;
    select count(*) into v_cnt from jsonb_to_recordset(v_rows) as r(cohort_code text)
     where nullif(r.cohort_code, '') is not null and not exists (select 1 from public.benchmark_cohorts c where c.cohort_code = r.cohort_code);
    if v_cnt > 0 then raise exception using errcode = '22023', message = 'PB_E_ROWS: ' || v_cnt::text || ' row(s) name a cohort that does not exist'; end if;
    select count(*) into v_cnt from jsonb_to_recordset(v_rows) as r(statistic_type text, value_numeric numeric, unit text, original_currency text, effective_from date, base_date date)
     where r.statistic_type is null or r.statistic_type not in ('mean', 'median', 'p10', 'p20', 'p25', 'p50', 'p75', 'p80', 'p90', 'target_min', 'target_max', 'threshold', 'rate', 'share')
        or r.value_numeric is null or abs(r.value_numeric) >= 100000000000000 or r.value_numeric <> round(r.value_numeric, 4)
        or r.unit is null or r.unit not in ('currency', 'percentage', 'months', 'ratio', 'count', 'years', 'days')
        or (r.unit = 'currency' and (r.original_currency is null or r.original_currency !~ '^[A-Z]{3}$'))
        or (r.unit <> 'currency' and nullif(r.original_currency, '') is not null)
        or r.effective_from > current_date or r.base_date > current_date;
    if v_cnt > 0 then raise exception using errcode = '22023', message = 'PB_E_ROWS: ' || v_cnt::text || ' row(s) break a value rule (statistic, number, unit, currency or a date in the future)'; end if;
    select count(*) into v_cnt from (
      select 1 from jsonb_to_recordset(v_rows) as r(cohort_code text, metric_code text, statistic_type text)
       group by coalesce(r.cohort_code, ''), r.metric_code, r.statistic_type having count(*) > 1) x;
    if v_cnt > 0 then raise exception using errcode = '22023', message = 'PB_E_ROWS: the file repeats a metric, cohort and statistic key'; end if;

    insert into public.benchmark_upload_batches (id, kind, dataset_id, dataset_name, dataset_version, file_name, file_sha256, file_bytes, template_version, row_count, staging_digest, staged_by)
    values (v_id, v_kind, d.id, d.dataset_name, d.version, p ->> 'file_name', v_sha, (p ->> 'file_bytes')::integer, v_expected_marker, v_n, 'pending', v_uid);
    insert into public.benchmark_upload_rows (batch_id, row_no, payload, classification)
    select v_id, r.row_no,
           jsonb_build_object(
             'metric_definition_id', m.id, 'metric_code', m.metric_code, 'cohort_id', c.id, 'cohort_code', nullif(r.cohort_code, ''),
             'statistic_type', r.statistic_type, 'value_numeric', r.value_numeric, 'unit', r.unit, 'original_currency', nullif(r.original_currency, ''),
             'base_date', r.base_date, 'effective_from', r.effective_from, 'is_derived', coalesce(r.is_derived, false),
             'derivation_method', nullif(r.derivation_method, ''), 'confidence_score', r.confidence_score, 'value_text', left(r.value_text, 1000),
             'provenance', jsonb_build_object('source_release', r.source_release, 'observation_period_start', r.observation_period_start,
               'observation_period_end', r.observation_period_end, 'source_file', r.source_file, 'source_locator', r.source_locator, 'retrieval_date', r.retrieval_date)),
           'new'
      from jsonb_to_recordset(v_rows) as r(row_no integer, cohort_code text, metric_code text, statistic_type text, value_numeric numeric, unit text, original_currency text,
             base_date date, effective_from date, is_derived boolean, derivation_method text, confidence_score numeric, value_text text, source_release text,
             observation_period_start date, observation_period_end date, source_file text, source_locator text, retrieval_date date)
      join public.benchmark_metric_definitions m on m.metric_code = r.metric_code
      left join public.benchmark_cohorts c on c.cohort_code = nullif(r.cohort_code, '');

  elsif v_kind = 'target_ranges' then
    select count(*) into v_cnt from jsonb_to_recordset(v_rows) as r(metric_code text)
     where not exists (select 1 from public.benchmark_metric_definitions m where m.metric_code = r.metric_code);
    if v_cnt > 0 then raise exception using errcode = '22023', message = 'PB_E_ROWS: ' || v_cnt::text || ' row(s) name a metric that is not registered'; end if;
    select count(*) into v_cnt from jsonb_to_recordset(v_rows) as r(source_name text)
     where (select count(*) from public.benchmark_sources s where s.source_name = r.source_name) <> 1
        or not exists (select 1 from public.benchmark_sources s where s.source_name = r.source_name and s.id = d.benchmark_source_id);
    if v_cnt > 0 then raise exception using errcode = '22023', message = 'PB_E_ROWS: ' || v_cnt::text || ' row(s) cite a source that is not the one source of the dataset'; end if;
    select count(*) into v_cnt from jsonb_to_recordset(v_rows) as r(country_code text)
     where nullif(r.country_code, '') is not null and not exists (select 1 from public.countries c where c.country_code::text = r.country_code);
    if v_cnt > 0 then raise exception using errcode = '22023', message = 'PB_E_ROWS: ' || v_cnt::text || ' row(s) name an unknown country'; end if;
    select count(*) into v_cnt from jsonb_to_recordset(v_rows) as r(band_label text, band_tier integer, lower_bound numeric, upper_bound numeric, direction text, evidence_level text, model_version text, effective_from date)
     where nullif(r.band_label, '') is null or r.band_tier is null or r.band_tier not between 1 and 4
        or (r.lower_bound is null and r.upper_bound is null)
        or abs(coalesce(r.lower_bound, 0)) >= 100000000000000 or abs(coalesce(r.upper_bound, 0)) >= 100000000000000
        or r.lower_bound <> round(r.lower_bound, 4) or r.upper_bound <> round(r.upper_bound, 4)
        or r.lower_bound > r.upper_bound
        or r.direction is null or r.direction not in ('higher_better', 'lower_better', 'target_range')
        or r.evidence_level is null or r.evidence_level not in ('official_statistical', 'regulatory', 'research_informed', 'platform_derived')
        or nullif(r.model_version, '') is null or r.effective_from > current_date;
    if v_cnt > 0 then raise exception using errcode = '22023', message = 'PB_E_ROWS: ' || v_cnt::text || ' row(s) break a band rule (tier, bounds, direction, evidence level or a date in the future)'; end if;
    select count(*) into v_cnt from (
      select 1 from jsonb_to_recordset(v_rows) as r(metric_code text, country_code text, life_stage text, household_type text, band_tier integer)
       group by r.metric_code, coalesce(r.country_code, ''), coalesce(r.life_stage, ''), coalesce(r.household_type, ''), r.band_tier having count(*) > 1) x;
    if v_cnt > 0 then raise exception using errcode = '22023', message = 'PB_E_ROWS: the file repeats a band key'; end if;

    insert into public.benchmark_upload_batches (id, kind, dataset_id, dataset_name, dataset_version, file_name, file_sha256, file_bytes, template_version, row_count, staging_digest, staged_by)
    values (v_id, v_kind, d.id, d.dataset_name, d.version, p ->> 'file_name', v_sha, (p ->> 'file_bytes')::integer, v_expected_marker, v_n, 'pending', v_uid);
    insert into public.benchmark_upload_rows (batch_id, row_no, payload, classification)
    select v_id, r.row_no,
           jsonb_build_object(
             'metric_definition_id', m.id, 'metric_code', m.metric_code, 'source_id', d.benchmark_source_id, 'country_code', nullif(r.country_code, ''),
             'life_stage', nullif(r.life_stage, ''), 'household_type', nullif(r.household_type, ''), 'band_label', r.band_label, 'band_tier', r.band_tier,
             'lower_bound', r.lower_bound, 'upper_bound', r.upper_bound, 'direction', r.direction, 'explanation', nullif(r.explanation, ''),
             'evidence_level', r.evidence_level, 'model_version', r.model_version, 'effective_from', r.effective_from,
             'provenance', jsonb_build_object('source_release', r.source_release, 'observation_period_start', r.observation_period_start,
               'observation_period_end', r.observation_period_end, 'source_file', r.source_file, 'source_locator', r.source_locator, 'retrieval_date', r.retrieval_date)),
           'new'
      from jsonb_to_recordset(v_rows) as r(row_no integer, metric_code text, country_code text, life_stage text, household_type text, band_label text, band_tier integer,
             lower_bound numeric, upper_bound numeric, direction text, explanation text, evidence_level text, model_version text, effective_from date,
             source_release text, observation_period_start date, observation_period_end date, source_file text, source_locator text, retrieval_date date)
      join public.benchmark_metric_definitions m on m.metric_code = r.metric_code;

  else
    select count(*) into v_cnt from jsonb_to_recordset(v_rows) as r(cohort_code text, country_code text, urban_rural text, cohort_tier integer, cohort_description text, sample_size integer)
     where r.cohort_code is null or r.cohort_code !~ '^[A-Za-z0-9_]+$' or r.cohort_tier is null or r.cohort_tier not between 1 and 5
        or nullif(r.cohort_description, '') is null
        or (nullif(r.urban_rural, '') is not null and r.urban_rural not in ('urban', 'rural', 'metro', 'regional'))
        or (nullif(r.country_code, '') is not null and not exists (select 1 from public.countries c where c.country_code::text = r.country_code))
        or r.sample_size < 0;
    if v_cnt > 0 then raise exception using errcode = '22023', message = 'PB_E_ROWS: ' || v_cnt::text || ' row(s) break a cohort rule (code, tier, description, urban or rural value, country or sample size)'; end if;
    select count(*) - count(distinct r.cohort_code) into v_cnt from jsonb_to_recordset(v_rows) as r(cohort_code text);
    if v_cnt > 0 then raise exception using errcode = '22023', message = 'PB_E_ROWS: the file repeats a cohort code'; end if;

    insert into public.benchmark_upload_batches (id, kind, dataset_id, dataset_name, dataset_version, file_name, file_sha256, file_bytes, template_version, row_count, staging_digest, staged_by)
    values (v_id, v_kind, d.id, d.dataset_name, d.version, p ->> 'file_name', v_sha, (p ->> 'file_bytes')::integer, v_expected_marker, v_n, 'pending', v_uid);
    insert into public.benchmark_upload_rows (batch_id, row_no, payload, classification)
    select v_id, r.row_no,
           jsonb_build_object(
             'cohort_code', r.cohort_code, 'country_code', nullif(r.country_code, ''), 'region_code', nullif(r.region_code, ''), 'urban_rural', nullif(r.urban_rural, ''),
             'age_band', nullif(r.age_band, ''), 'income_band', nullif(r.income_band, ''), 'household_type', nullif(r.household_type, ''), 'life_stage', nullif(r.life_stage, ''),
             'housing_tenure', nullif(r.housing_tenure, ''), 'employment_type', nullif(r.employment_type, ''), 'dependant_band', nullif(r.dependant_band, ''),
             'financial_dna_code', nullif(r.financial_dna_code, ''), 'cross_border_flag', coalesce(r.cross_border_flag, false), 'cohort_tier', r.cohort_tier,
             'sample_size', r.sample_size, 'cohort_description', r.cohort_description,
             'provenance', jsonb_build_object('source_release', r.source_release, 'source_file', r.source_file, 'source_locator', r.source_locator)),
           'new'
      from jsonb_to_recordset(v_rows) as r(row_no integer, cohort_code text, country_code text, region_code text, urban_rural text, age_band text, income_band text,
             household_type text, life_stage text, housing_tenure text, employment_type text, dependant_band text, financial_dna_code text, cross_border_flag boolean,
             cohort_tier integer, sample_size integer, cohort_description text, source_release text, source_file text, source_locator text);
  end if;

  v_counts := public.pb_store_classification(v_id);
  v_digest := public.pb_batch_digest(v_id);
  update public.benchmark_upload_batches set counts = v_counts, staging_digest = v_digest where id = v_id;
  insert into public.benchmark_upload_events (batch_id, event_type, actor_user_id, detail)
  values (v_id, 'staged', v_uid, jsonb_build_object('kind', v_kind, 'dataset', d.dataset_name, 'dataset_version', d.version, 'rows', v_n, 'counts', v_counts, 'file_sha256', v_sha));
  return jsonb_build_object('status', 'staged', 'batch_id', v_id, 'counts', v_counts, 'staging_digest', v_digest);
end;
$fn$;

-- ===========================================================================
-- 5. RPC: get (preview with the diff against live values)
-- ===========================================================================
create or replace function get_planning_benchmark_upload(p_batch uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $fn$
declare
  b record;
  v_rows jsonb;
  v_removed jsonb;
  v_ready text[];
  v_blockers text[] := '{}';
  v_digest_now text;
  v_conflicts integer;
begin
  if auth.uid() is null or not public.is_planning_benchmark_viewer() then
    raise exception using errcode = '42501', message = 'PB_E_DENIED: the planning benchmark upload permission is required';
  end if;
  select * into b from public.benchmark_upload_batches where id = p_batch;
  if not found then
    raise exception using errcode = 'P0002', message = 'PB_E_NOT_FOUND: that upload does not exist';
  end if;
  v_ready := public.pb_dataset_readiness(b.dataset_id, p_batch);
  v_blockers := v_blockers || v_ready;
  select count(*) into v_conflicts from public.benchmark_upload_rows where batch_id = p_batch and classification = 'conflict';
  if v_conflicts > 0 then
    v_blockers := array_append(v_blockers, v_conflicts::text || ' row(s) conflict with live data and must be fixed in the file.');
  end if;
  if b.status = 'staged' then
    v_digest_now := public.pb_batch_digest(p_batch);
    if v_digest_now <> b.staging_digest then
      v_blockers := array_append(v_blockers, 'Live data changed after this upload was staged. Discard it and stage the file again.');
    end if;
    if b.expires_at <= now() then v_blockers := array_append(v_blockers, 'This staged upload expired. Discard it and stage the file again.'); end if;
  else
    v_blockers := array_append(v_blockers, 'This upload is ' || b.status || '.');
  end if;

  select coalesce(jsonb_agg(x.j order by x.rn), '[]'::jsonb) into v_rows from (
    select r.row_no as rn,
           jsonb_build_object(
             'row_no', r.row_no, 'classification', r.classification, 'detail', r.detail,
             'metric_code', r.payload ->> 'metric_code', 'cohort_code', r.payload ->> 'cohort_code', 'statistic_type', r.payload ->> 'statistic_type',
             'unit', r.payload ->> 'unit', 'band_label', r.payload ->> 'band_label', 'band_tier', r.payload ->> 'band_tier',
             'country_code', r.payload ->> 'country_code', 'life_stage', r.payload ->> 'life_stage', 'household_type', r.payload ->> 'household_type',
             'new_value', r.payload ->> 'value_numeric', 'new_lower', r.payload ->> 'lower_bound', 'new_upper', r.payload ->> 'upper_bound',
             'cohort_tier', r.payload ->> 'cohort_tier', 'cohort_description', r.payload ->> 'cohort_description',
             'live_value', (select v.value_numeric::text from public.benchmark_values v where v.id = r.live_ids[1]),
             'live_lower', (select t.lower_bound::text from public.benchmark_target_ranges t where t.id = r.live_ids[1]),
             'live_upper', (select t.upper_bound::text from public.benchmark_target_ranges t where t.id = r.live_ids[1])) as j
      from public.benchmark_upload_rows r
     where r.batch_id = p_batch
     order by r.row_no
     limit 1000) x;

  select coalesce(jsonb_agg(jsonb_build_object(
           'metric_code', m.metric_code, 'band_label', t.band_label, 'band_tier', t.band_tier, 'lower', t.lower_bound::text, 'upper', t.upper_bound::text,
           'country_code', t.country_code::text, 'life_stage', t.life_stage, 'household_type', t.household_type) order by m.metric_code, t.band_tier), '[]'::jsonb)
    into v_removed
    from public.benchmark_target_ranges t
    join public.benchmark_metric_definitions m on m.id = t.metric_definition_id
   where t.id = any (public.pb_removed_band_ids(p_batch));

  return jsonb_build_object(
    'batch', jsonb_build_object(
      'id', b.id, 'kind', b.kind, 'dataset_id', b.dataset_id, 'dataset_name', b.dataset_name, 'dataset_version', b.dataset_version, 'file_name', b.file_name,
      'file_sha256', b.file_sha256, 'file_bytes', b.file_bytes, 'template_version', b.template_version, 'status', b.status, 'row_count', b.row_count,
      'counts', b.counts, 'staging_digest', b.staging_digest, 'staged_by_me', b.staged_by = auth.uid(), 'staged_at', b.staged_at, 'expires_at', b.expires_at,
      'activated_at', b.activated_at, 'self_activated', b.self_activated, 'discarded_at', b.discarded_at, 'discard_reason', b.discard_reason, 'result', b.result),
    'readiness_errors', to_jsonb(v_ready),
    'blockers', to_jsonb(v_blockers),
    'rows', v_rows,
    'rows_truncated', b.row_count > 1000,
    'removed', v_removed);
end;
$fn$;

-- ===========================================================================
-- 6. RPC: activate (atomic apply)
-- ===========================================================================
-- p keys: expected_sha256, expected_digest, expected_counts (object), self_activation_ack (boolean).
create or replace function activate_planning_benchmark_upload(p_batch uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid uuid := auth.uid();
  b record;
  d record;
  v_digest text;
  v_ready text[];
  v_conflicts integer;
  v_ended integer := 0;
  v_inserted integer := 0;
  v_removed_ids uuid[];
  v_removed integer := 0;
  v_counts jsonb;
  v_prev_versions text;
  v_run uuid;
  v_result jsonb;
begin
  if v_uid is null or not public.is_planning_benchmark_activator() then
    raise exception using errcode = '42501', message = 'PB_E_DENIED: the planning benchmark activate permission is required';
  end if;
  -- One activation at a time, whatever the batch (taken before any row lock to keep one lock order).
  perform pg_advisory_xact_lock(hashtext('fhip_planning_benchmark_upload_activate'));
  select * into b from public.benchmark_upload_batches where id = p_batch for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'PB_E_NOT_FOUND: that upload does not exist';
  end if;
  if b.status = 'activated' then
    return jsonb_build_object('status', 'already_activated', 'batch_id', b.id, 'result', b.result);
  end if;
  if b.status <> 'staged' then
    raise exception using errcode = '55000', message = 'PB_E_STATE: this upload is ' || b.status || ' and cannot be activated';
  end if;
  if b.expires_at <= now() then
    raise exception using errcode = '55000', message = 'PB_E_EXPIRED: this staged upload expired. Discard it and stage the file again';
  end if;
  if p ->> 'expected_sha256' is distinct from b.file_sha256 or p ->> 'expected_digest' is distinct from b.staging_digest then
    raise exception using errcode = '22023', message = 'PB_E_BINDING: the activation is not bound to the file and preview that were reviewed. Reload the preview';
  end if;
  if (p -> 'expected_counts') is distinct from b.counts then
    raise exception using errcode = '22023', message = 'PB_E_BINDING: the previewed counts differ than the staged counts. Reload the preview';
  end if;
  if b.staged_by = v_uid and coalesce((p ->> 'self_activation_ack')::boolean, false) is not true then
    raise exception using errcode = '42501', message = 'PB_E_SELF: you staged this upload. Activating it yourself needs the explicit self-activation acknowledgement';
  end if;

  v_digest := public.pb_batch_digest(p_batch);
  if v_digest <> b.staging_digest then
    raise exception using errcode = '55000', message = 'PB_E_STALE: live benchmark data changed after this upload was staged. Discard it and stage the file again';
  end if;
  select count(*) into v_conflicts from public.pb_classify_rows(p_batch) where cls = 'conflict';
  if v_conflicts > 0 then
    raise exception using errcode = '22023', message = 'PB_E_CONFLICT: ' || v_conflicts::text || ' row(s) conflict with live data';
  end if;
  v_ready := public.pb_dataset_readiness(b.dataset_id, p_batch);
  if coalesce(cardinality(v_ready), 0) > 0 then
    raise exception using errcode = '22023', message = 'PB_E_NOT_READY: ' || array_to_string(v_ready, ' ');
  end if;
  select * into d from public.benchmark_datasets where id = b.dataset_id for update;

  if b.kind = 'values' then
    select string_agg(distinct dd.version, ', ') into v_prev_versions
      from public.benchmark_values v join public.benchmark_datasets dd on dd.id = v.dataset_id
     where v.id in (select unnest(r.live_ids) from public.benchmark_upload_rows r where r.batch_id = p_batch and r.classification = 'changed');
    update public.benchmark_values v set effective_to = current_date
     where v.id in (select unnest(r.live_ids) from public.benchmark_upload_rows r where r.batch_id = p_batch and r.classification = 'changed');
    get diagnostics v_ended = row_count;
    insert into public.benchmark_values (dataset_id, cohort_id, metric_definition_id, statistic_type, value_numeric, value_text, unit, original_currency, base_date,
                                         is_derived, derivation_method, confidence_score, effective_from, version)
    select b.dataset_id, nullif(r.payload ->> 'cohort_id', '')::uuid, (r.payload ->> 'metric_definition_id')::uuid, r.payload ->> 'statistic_type',
           (r.payload ->> 'value_numeric')::numeric, nullif(r.payload ->> 'value_text', ''), r.payload ->> 'unit', nullif(r.payload ->> 'original_currency', ''),
           nullif(r.payload ->> 'base_date', '')::date, (r.payload ->> 'is_derived')::boolean, nullif(r.payload ->> 'derivation_method', ''),
           nullif(r.payload ->> 'confidence_score', '')::numeric, coalesce(nullif(r.payload ->> 'effective_from', '')::date, current_date),
           1 + coalesce((select max(o.version) from public.benchmark_values o where o.id = any (r.live_ids)), 0)
      from public.benchmark_upload_rows r
     where r.batch_id = p_batch and r.classification in ('new', 'changed');
    get diagnostics v_inserted = row_count;

  elsif b.kind = 'target_ranges' then
    v_removed_ids := public.pb_removed_band_ids(p_batch);
    v_removed := coalesce(cardinality(v_removed_ids), 0);
    update public.benchmark_target_ranges t set effective_to = current_date
     where t.id in (select unnest(r.live_ids) from public.benchmark_upload_rows r where r.batch_id = p_batch and r.classification = 'changed')
        or t.id = any (v_removed_ids);
    get diagnostics v_ended = row_count;
    insert into public.benchmark_target_ranges (metric_definition_id, benchmark_source_id, country_code, life_stage, household_type, band_label, band_tier,
                                                lower_bound, upper_bound, direction, explanation, evidence_level, model_version, effective_from)
    select (r.payload ->> 'metric_definition_id')::uuid, (r.payload ->> 'source_id')::uuid, nullif(r.payload ->> 'country_code', ''), nullif(r.payload ->> 'life_stage', ''),
           nullif(r.payload ->> 'household_type', ''), r.payload ->> 'band_label', (r.payload ->> 'band_tier')::integer,
           nullif(r.payload ->> 'lower_bound', '')::numeric, nullif(r.payload ->> 'upper_bound', '')::numeric, r.payload ->> 'direction', nullif(r.payload ->> 'explanation', ''),
           r.payload ->> 'evidence_level', r.payload ->> 'model_version', coalesce(nullif(r.payload ->> 'effective_from', '')::date, current_date)
      from public.benchmark_upload_rows r
     where r.batch_id = p_batch and r.classification in ('new', 'changed');
    get diagnostics v_inserted = row_count;

  else
    insert into public.benchmark_cohorts (dataset_id, cohort_code, country_code, region_code, urban_rural, age_band, income_band, household_type, life_stage, housing_tenure,
                                          employment_type, dependant_band, financial_dna_code, cross_border_flag, cohort_tier, sample_size, cohort_description)
    select b.dataset_id, r.payload ->> 'cohort_code', nullif(r.payload ->> 'country_code', ''), nullif(r.payload ->> 'region_code', ''), nullif(r.payload ->> 'urban_rural', ''),
           nullif(r.payload ->> 'age_band', ''), nullif(r.payload ->> 'income_band', ''), nullif(r.payload ->> 'household_type', ''), nullif(r.payload ->> 'life_stage', ''),
           nullif(r.payload ->> 'housing_tenure', ''), nullif(r.payload ->> 'employment_type', ''), nullif(r.payload ->> 'dependant_band', ''),
           nullif(r.payload ->> 'financial_dna_code', ''), (r.payload ->> 'cross_border_flag')::boolean, (r.payload ->> 'cohort_tier')::integer,
           nullif(r.payload ->> 'sample_size', '')::integer, r.payload ->> 'cohort_description'
      from public.benchmark_upload_rows r
     where r.batch_id = p_batch and r.classification = 'new';
    get diagnostics v_inserted = row_count;
  end if;

  -- The dataset becomes active (a first load cannot be activated by the existing button because it has no values yet).
  update public.benchmark_datasets set
    data_status = 'active',
    effective_from = case when d.data_status = 'active' and d.effective_from is not null then d.effective_from else current_date end,
    review_due_at = (current_date + interval '1 year')::date,
    approved_by = case when d.data_status = 'active' then d.approved_by else v_uid end,
    approved_at = case when d.data_status = 'active' then d.approved_at else now() end,
    updated_at = now()
  where id = b.dataset_id;

  -- Older versions of the same dataset left with no live value are marked superseded.
  if b.kind = 'values' then
    update public.benchmark_datasets o set data_status = 'superseded', effective_to = current_date, updated_at = now()
     where o.dataset_name = b.dataset_name and o.id <> b.dataset_id and o.data_status = 'active'
       and not exists (select 1 from public.benchmark_values v where v.dataset_id = o.id and (v.effective_to is null or v.effective_to > current_date));
  end if;

  v_counts := b.counts;
  insert into public.benchmark_update_runs (source_id, dataset_id, rows_imported, rows_rejected, validation_results, approval_status, previous_version, new_version, effective_date, audit_user, event_type)
  values (d.benchmark_source_id, b.dataset_id, v_inserted, 0,
          jsonb_build_object('upload_batch_id', b.id, 'kind', b.kind, 'file_sha256', b.file_sha256, 'counts', v_counts, 'rows_end_dated', v_ended, 'bands_removed', v_removed),
          'approved', v_prev_versions, d.version, current_date, v_uid, 'DATASET_IMPORT')
  returning id into v_run;

  v_result := jsonb_build_object('rows_inserted', v_inserted, 'rows_end_dated', v_ended, 'bands_removed', v_removed, 'counts', v_counts, 'update_run_id', v_run, 'dataset_status', 'active');
  update public.benchmark_upload_batches set
    status = 'activated', activated_by = v_uid, activated_at = now(), self_activated = (b.staged_by = v_uid), result = v_result, update_run_id = v_run
  where id = p_batch;
  insert into public.benchmark_upload_events (batch_id, event_type, actor_user_id, detail)
  values (p_batch, 'activated', v_uid, v_result || jsonb_build_object('self_activated', b.staged_by = v_uid));
  return jsonb_build_object('status', 'activated', 'batch_id', p_batch, 'result', v_result);
end;
$fn$;

-- ===========================================================================
-- 7. RPC: discard
-- ===========================================================================
create or replace function discard_planning_benchmark_upload(p_batch uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid uuid := auth.uid();
  b record;
  v_reason text := nullif(left(trim(coalesce(p_reason, '')), 500), '');
begin
  if v_uid is null or not public.is_planning_benchmark_viewer() then
    raise exception using errcode = '42501', message = 'PB_E_DENIED: the planning benchmark upload permission is required';
  end if;
  select * into b from public.benchmark_upload_batches where id = p_batch for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'PB_E_NOT_FOUND: that upload does not exist';
  end if;
  -- An uploader may discard only a batch they staged. An activator may discard any batch.
  if not public.is_planning_benchmark_activator() and b.staged_by <> v_uid then
    raise exception using errcode = '42501', message = 'PB_E_DENIED: you may discard only an upload you staged';
  end if;
  if b.status = 'discarded' then
    return jsonb_build_object('status', 'already_discarded', 'batch_id', b.id);
  end if;
  if b.status <> 'staged' then
    raise exception using errcode = '55000', message = 'PB_E_STATE: this upload is ' || b.status || ' and cannot be discarded';
  end if;
  update public.benchmark_upload_batches set status = 'discarded', discarded_by = v_uid, discarded_at = now(), discard_reason = v_reason where id = p_batch;
  insert into public.benchmark_upload_events (batch_id, event_type, actor_user_id, detail)
  values (p_batch, 'discarded', v_uid, jsonb_build_object('reason', v_reason));
  return jsonb_build_object('status', 'discarded', 'batch_id', p_batch);
end;
$fn$;

revoke all on function stage_planning_benchmark_upload(jsonb), get_planning_benchmark_upload(uuid), activate_planning_benchmark_upload(uuid, jsonb), discard_planning_benchmark_upload(uuid, text) from public, anon;
grant execute on function stage_planning_benchmark_upload(jsonb), get_planning_benchmark_upload(uuid), activate_planning_benchmark_upload(uuid, jsonb), discard_planning_benchmark_upload(uuid, text) to authenticated;
