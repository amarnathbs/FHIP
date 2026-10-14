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
-- PART B starts here
-- ---------------------------------------------------------------------------
-- ===========================================================================
-- 2. The seed (only while the table is empty). Every pair and its evidence is in
--    docs/planning-benchmarks/DATASET_METRIC_MAPPING.md and a test keeps the two equal.
-- ===========================================================================
do $do$ begin
  if not exists (select 1 from public.benchmark_dataset_metrics) then
    insert into public.benchmark_dataset_metrics (dataset_id, metric_definition_id, applies_to_values, applies_to_target_ranges, evidence_note)
    select d.id, m.id, s.applies_values, s.applies_ranges, s.evidence
      from (values
        ('FHIP dependant-band household benchmark model', '1.0', 'discretionary_expense_ratio', true, false, 'DEV holds 18 live values (6 cohorts x 3 dependant bands) and the schema map lists these 11 metrics'),
        ('FHIP dependant-band household benchmark model', '1.0', 'emergency_fund_months', true, false, 'DEV holds 18 live values (6 cohorts x 3 dependant bands) and the schema map lists these 11 metrics'),
        ('FHIP dependant-band household benchmark model', '1.0', 'essential_expense_ratio', true, false, 'DEV holds 18 live values (6 cohorts x 3 dependant bands) and the schema map lists these 11 metrics'),
        ('FHIP dependant-band household benchmark model', '1.0', 'expense_growth_12m', true, false, 'DEV holds 18 live values (6 cohorts x 3 dependant bands) and the schema map lists these 11 metrics'),
        ('FHIP dependant-band household benchmark model', '1.0', 'fixed_commitment_ratio', true, false, 'DEV holds 18 live values (6 cohorts x 3 dependant bands) and the schema map lists these 11 metrics'),
        ('FHIP dependant-band household benchmark model', '1.0', 'housing_cost_ratio', true, false, 'DEV holds 18 live values (6 cohorts x 3 dependant bands) and the schema map lists these 11 metrics'),
        ('FHIP dependant-band household benchmark model', '1.0', 'income_interruption_coverage', true, false, 'DEV holds 18 live values (6 cohorts x 3 dependant bands) and the schema map lists these 11 metrics'),
        ('FHIP dependant-band household benchmark model', '1.0', 'monthly_surplus', true, false, 'DEV holds 18 live values (6 cohorts x 3 dependant bands) and the schema map lists these 11 metrics'),
        ('FHIP dependant-band household benchmark model', '1.0', 'savings_rate', true, false, 'DEV holds 18 live values (6 cohorts x 3 dependant bands) and the schema map lists these 11 metrics'),
        ('FHIP dependant-band household benchmark model', '1.0', 'surplus_margin', true, false, 'DEV holds 18 live values (6 cohorts x 3 dependant bands) and the schema map lists these 11 metrics'),
        ('FHIP dependant-band household benchmark model', '1.0', 'total_expense_ratio', true, false, 'DEV holds 18 live values (6 cohorts x 3 dependant bands) and the schema map lists these 11 metrics'),
        ('AU household asset composition', '1.0', 'property_concentration', true, false, 'DEV holds 1 live value and first-load file 02 carries it'),
        ('AU household asset composition', '1.0', 'total_assets', true, false, 'first-load file 02 (ABS 2019-20 Table 2.4), not yet loaded on DEV'),
        ('AU household wealth distribution', '1.0', 'net_worth', true, false, 'DEV holds 4 live values (median, mean, p20, p80) and first-load file 03 carries 6'),
        ('AU net worth and income by age band', '1.0', 'gross_household_income', true, false, 'DEV holds 7 live values per metric (one per age cohort) and first-load file 04'),
        ('AU net worth and income by age band', '1.0', 'net_worth', true, false, 'DEV holds 7 live values per metric (one per age cohort) and first-load file 04'),
        ('AU high-DTI mortgage threshold', '1.0', 'debt_to_income', true, false, 'DEV holds 1 live value (threshold) and first-load file 05'),
        ('AU average superannuation balance', '1.0', 'retirement_balance', true, false, 'DEV holds 1 live value and first-load file 06'),
        ('AU household debt context', '1.0', 'debt_to_asset_ratio', true, false, 'first-load file 07 only. The dataset is superseded, so it is closed to upload'),
        ('India household assets and debt (rural/urban)', '1.0', 'total_assets', true, false, 'DEV holds 2 live values (urban, rural) and first-load file 09'),
        ('India household assets and debt (rural/urban)', '1.0', 'debt_to_asset_ratio', true, false, 'first-load file 09 (2 rows), not yet loaded on DEV'),
        ('India EPF/EPS contribution structure', '1.0', 'retirement_contribution_rate', true, false, 'DEV holds 1 live value (rate) and first-load file 10'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'asset_class_diversification', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'country_concentration', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'credit_utilization', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'currency_mismatch', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'debt_service_ratio', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'debt_to_income', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'depreciating_asset_ratio', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'discretionary_expense_ratio', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'emergency_fund_months', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'essential_expense_ratio', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'fixed_commitment_ratio', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'goal_allocation_burden', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'goal_contribution_adequacy', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'goal_progress', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'high_interest_debt_share', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'home_loan_lvr', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'housing_cost_ratio', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'immediate_liquidity_ratio', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'income_concentration', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'income_interruption_coverage', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'income_protection_alignment', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'investable_assets_ratio', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'investment_contribution_rate', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'largest_holding_concentration', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'life_cover_adequacy', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'liquid_asset_share', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'major_asset_coverage', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'near_liquid_coverage', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'net_worth_growth_12m', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'offshore_liquidity_access', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'on_track_goal_percentage', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'passive_income_ratio', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'policy_completeness', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'portfolio_cost_ratio', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'positive_cashflow_consistency', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'productive_asset_ratio', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'projected_retirement_readiness', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'property_concentration', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'refinance_exposure_24m', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'remittance_burden', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'retirement_contribution_rate', false, true, 'DEV holds 8 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'savings_rate', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'speculative_asset_ratio', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'surplus_margin', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'total_expense_ratio', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'tpd_cover_adequacy', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'unsecured_debt_ratio', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('FHIP Planning Benchmarks v1.0', '1.0', 'variable_rate_exposure', false, true, 'DEV holds 4 live bands (no source recorded) and draft file 11 carries them'),
        ('AU ASFA retirement standard', '1.0', 'retirement_balance', false, true, 'DEV holds 4 live bands cited to the ASFA source and first-load file 12')
      ) as s(dataset_name, dataset_version, metric_code, applies_values, applies_ranges, evidence)
      join public.benchmark_datasets d on d.dataset_name = s.dataset_name and d.version = s.dataset_version
      join public.benchmark_metric_definitions m on m.metric_code = s.metric_code
    on conflict (dataset_id, metric_definition_id) do nothing;
  end if;
end $do$;

-- ===========================================================================
-- 3. Staging refuses a metric that is not mapped (the rows are inserted by stage_planning_benchmark_upload)
-- ===========================================================================
create or replace function pb_enforce_dataset_metric() returns trigger
language plpgsql security definer set search_path = '' as $fn$
declare
  b record;
  v_metric uuid;
  v_ok boolean;
  v_allowed text;
begin
  select dataset_id, kind, dataset_name into b from public.benchmark_upload_batches where id = new.batch_id;
  if not found or b.kind not in ('values', 'target_ranges') then
    return new;
  end if;
  v_metric := (new.payload ->> 'metric_definition_id')::uuid;
  select exists (
    select 1 from public.benchmark_dataset_metrics x
     where x.dataset_id = b.dataset_id and x.metric_definition_id = v_metric
       and case when b.kind = 'values' then x.applies_to_values else x.applies_to_target_ranges end) into v_ok;
  if v_ok then
    return new;
  end if;
  select string_agg(q.metric_code, ', ' order by q.metric_code) into v_allowed from (
    select m.metric_code
      from public.benchmark_dataset_metrics x
      join public.benchmark_metric_definitions m on m.id = x.metric_definition_id
     where x.dataset_id = b.dataset_id and case when b.kind = 'values' then x.applies_to_values else x.applies_to_target_ranges end
     order by m.metric_code limit 12) q;
  raise exception using errcode = '22023',
    message = 'PB_E_MAPPING: the metric ' || coalesce(new.payload ->> 'metric_code', 'unknown') || ' is not mapped to the dataset ' || b.dataset_name
      || ' for ' || case when b.kind = 'values' then 'observed values' else 'planning target ranges' end
      || ' files. Metrics allowed for it: ' || coalesce(v_allowed, 'none yet');
end;
$fn$;
drop trigger if exists trg_benchmark_upload_rows_dataset_metric on benchmark_upload_rows;
create trigger trg_benchmark_upload_rows_dataset_metric before insert on benchmark_upload_rows
  for each row execute function pb_enforce_dataset_metric();

-- Readiness of the target dataset for activation: the rules of migration 0275 unchanged, plus the mapping rule, so a
-- preview lists the problem as a blocker and the Activate function refuses it again (defence in depth). A batch staged
-- before this migration, or one whose mapping was removed afterwards, is caught here.
create or replace function pb_dataset_readiness(p_dataset uuid, p_batch uuid) returns text[]
language plpgsql stable security definer set search_path = '' as $fn$
declare
  d record;
  s record;
  b record;
  errs text[] := '{}';
  v_live integer;
  v_staged integer;
  v_unmapped text;
  v_unmapped_n integer;
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
  select * into b from public.benchmark_upload_batches where id = p_batch;
  if found and b.kind in ('values', 'target_ranges') then
    select count(*), string_agg(distinct r.payload ->> 'metric_code', ', ' order by r.payload ->> 'metric_code')
      into v_unmapped_n, v_unmapped
      from public.benchmark_upload_rows r
     where r.batch_id = p_batch
       and not exists (
         select 1 from public.benchmark_dataset_metrics x
          where x.dataset_id = p_dataset and x.metric_definition_id = (r.payload ->> 'metric_definition_id')::uuid
            and case when b.kind = 'values' then x.applies_to_values else x.applies_to_target_ranges end);
    if v_unmapped_n > 0 then
      errs := array_append(errs, 'Metric mapping: ' || v_unmapped_n::text || ' row(s) use a metric that is not mapped to this dataset for this kind of file (' || v_unmapped
        || '). Fix the file, or ask a holder of the activate permission to map the metric on the Upload tab.');
    end if;
  end if;
  if d.benchmark_class in ('observed_market', 'regulatory_statutory') then
    select count(*) into v_live from public.benchmark_values where dataset_id = p_dataset;
    v_staged := 0;
    if b.kind = 'values' then
      select count(*) into v_staged from public.benchmark_upload_rows where batch_id = p_batch;
    end if;
    if v_live = 0 and v_staged = 0 then errs := array_append(errs, 'No benchmark value has been recorded for this dataset yet.'); end if;
  end if;
  return errs;
end;
$fn$;
revoke all on function pb_enforce_dataset_metric(), pb_dataset_readiness(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- PART C starts here
-- ---------------------------------------------------------------------------
-- ===========================================================================
-- 4. Maintaining the mapping without SQL (the existing activate permission, audited)
-- ===========================================================================
-- Live figures a dataset and metric pair holds, by kind of file. Observed values are tied to the dataset. Planning bands
-- have no dataset column, so the bands of the metric that cite the dataset source, or cite no source, are counted.
create or replace function pb_live_figures(p_dataset uuid, p_metric uuid, p_kind text) returns integer
language sql stable security definer set search_path = '' as $fn$
  select case when p_kind = 'values' then
           (select count(*)::integer from public.benchmark_values v
             where v.dataset_id = p_dataset and v.metric_definition_id = p_metric and (v.effective_to is null or v.effective_to > current_date))
         else
           (select count(*)::integer from public.benchmark_target_ranges t
             where t.metric_definition_id = p_metric and (t.effective_to is null or t.effective_to > current_date)
               and (t.benchmark_source_id is null or t.benchmark_source_id = (select d.benchmark_source_id from public.benchmark_datasets d where d.id = p_dataset)))
         end;
$fn$;

-- Staged batches that use the pair and are still waiting (they would be refused at Activate once the pair is gone).
create or replace function pb_staged_batches_using(p_dataset uuid, p_metric uuid) returns integer
language sql stable security definer set search_path = '' as $fn$
  select count(distinct b.id)::integer
    from public.benchmark_upload_batches b
    join public.benchmark_upload_rows r on r.batch_id = b.id
   where b.dataset_id = p_dataset and b.status = 'staged' and b.expires_at > now()
     and b.kind in ('values', 'target_ranges')
     and (r.payload ->> 'metric_definition_id')::uuid = p_metric;
$fn$;
revoke all on function pb_live_figures(uuid, uuid, text), pb_staged_batches_using(uuid, uuid) from public, anon, authenticated;

-- Add a metric to a dataset, or change which kinds of file it applies to.
create or replace function set_planning_benchmark_dataset_metric(p_dataset uuid, p_metric text, p_values boolean, p_ranges boolean, p_reason text, p_confirm_live boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid uuid := auth.uid();
  v_reason text := nullif(left(trim(coalesce(p_reason, '')), 500), '');
  v_values boolean := coalesce(p_values, false);
  v_ranges boolean := coalesce(p_ranges, false);
  d record;
  m record;
  cur record;
  v_live integer := 0;
  v_staged integer := 0;
  v_action text;
begin
  if v_uid is null or not public.is_planning_benchmark_activator() then
    raise exception using errcode = '42501', message = 'PB_E_DENIED: the planning benchmark activate permission is required';
  end if;
  if v_reason is null or length(v_reason) < 3 then
    raise exception using errcode = '22023', message = 'PB_E_INPUT: a reason of at least 3 characters is required';
  end if;
  if not (v_values or v_ranges) then
    raise exception using errcode = '22023', message = 'PB_E_INPUT: choose at least one kind of file. To take a metric away use the remove action';
  end if;
  select * into d from public.benchmark_datasets where id = p_dataset;
  if not found then
    raise exception using errcode = 'P0002', message = 'PB_E_NOT_FOUND: that dataset does not exist';
  end if;
  select * into m from public.benchmark_metric_definitions where metric_code = p_metric;
  if not found then
    raise exception using errcode = 'P0002', message = 'PB_E_NOT_FOUND: that metric is not registered. A metric cannot be created here';
  end if;
  perform pg_advisory_xact_lock(hashtext('fhip_planning_benchmark_dataset_metric'));
  select * into cur from public.benchmark_dataset_metrics where dataset_id = d.id and metric_definition_id = m.id for update;
  if not found then
    insert into public.benchmark_dataset_metrics (dataset_id, metric_definition_id, applies_to_values, applies_to_target_ranges, evidence_note, created_by, updated_by)
    values (d.id, m.id, v_values, v_ranges, 'Added on the Upload tab: ' || v_reason, v_uid, v_uid);
    v_action := 'added';
  else
    if cur.applies_to_values = v_values and cur.applies_to_target_ranges = v_ranges then
      return jsonb_build_object('status', 'unchanged', 'dataset_id', d.id, 'metric_code', m.metric_code);
    end if;
    if cur.applies_to_values and not v_values then v_live := v_live + public.pb_live_figures(d.id, m.id, 'values'); end if;
    if cur.applies_to_target_ranges and not v_ranges then v_live := v_live + public.pb_live_figures(d.id, m.id, 'target_ranges'); end if;
    if v_live > 0 and not coalesce(p_confirm_live, false) then
      raise exception using errcode = '55000', message = 'PB_E_LIVE: ' || v_live::text || ' live figure(s) exist for this metric in this dataset and kind of file. Changing the mapping does not delete them, but a corrected upload of this metric would be refused. Tick the confirmation to continue';
    end if;
    v_staged := public.pb_staged_batches_using(d.id, m.id);
    update public.benchmark_dataset_metrics set applies_to_values = v_values, applies_to_target_ranges = v_ranges, updated_by = v_uid, updated_at = now() where id = cur.id;
    v_action := 'changed';
  end if;
  insert into public.benchmark_dataset_metric_events (dataset_id, metric_definition_id, dataset_name, dataset_version, metric_code, action, values_before, ranges_before, values_after, ranges_after, live_figures, live_confirmed, staged_batches, reason, actor_user_id)
  values (d.id, m.id, d.dataset_name, d.version, m.metric_code, v_action, cur.applies_to_values, cur.applies_to_target_ranges, v_values, v_ranges, v_live, coalesce(p_confirm_live, false), v_staged, v_reason, v_uid);
  return jsonb_build_object('status', v_action, 'dataset_id', d.id, 'metric_code', m.metric_code, 'applies_to_values', v_values, 'applies_to_target_ranges', v_ranges, 'live_figures', v_live, 'staged_batches', v_staged);
end;
$fn$;

-- Remove the mapping of a metric to a dataset. Live figures are never deleted. A pair that still has live figures needs the explicit confirmation.
create or replace function remove_planning_benchmark_dataset_metric(p_dataset uuid, p_metric text, p_reason text, p_confirm_live boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid uuid := auth.uid();
  v_reason text := nullif(left(trim(coalesce(p_reason, '')), 500), '');
  d record;
  m record;
  cur record;
  v_live integer := 0;
  v_staged integer := 0;
begin
  if v_uid is null or not public.is_planning_benchmark_activator() then
    raise exception using errcode = '42501', message = 'PB_E_DENIED: the planning benchmark activate permission is required';
  end if;
  if v_reason is null or length(v_reason) < 3 then
    raise exception using errcode = '22023', message = 'PB_E_INPUT: a reason of at least 3 characters is required';
  end if;
  select * into d from public.benchmark_datasets where id = p_dataset;
  if not found then
    raise exception using errcode = 'P0002', message = 'PB_E_NOT_FOUND: that dataset does not exist';
  end if;
  select * into m from public.benchmark_metric_definitions where metric_code = p_metric;
  if not found then
    raise exception using errcode = 'P0002', message = 'PB_E_NOT_FOUND: that metric is not registered';
  end if;
  perform pg_advisory_xact_lock(hashtext('fhip_planning_benchmark_dataset_metric'));
  select * into cur from public.benchmark_dataset_metrics where dataset_id = d.id and metric_definition_id = m.id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'PB_E_NOT_FOUND: that metric is not mapped to that dataset';
  end if;
  if cur.applies_to_values then v_live := v_live + public.pb_live_figures(d.id, m.id, 'values'); end if;
  if cur.applies_to_target_ranges then v_live := v_live + public.pb_live_figures(d.id, m.id, 'target_ranges'); end if;
  if v_live > 0 and not coalesce(p_confirm_live, false) then
    raise exception using errcode = '55000', message = 'PB_E_LIVE: ' || v_live::text || ' live figure(s) exist for this metric in this dataset. Removing the mapping does not delete them, but a corrected upload of this metric would be refused. Tick the confirmation to continue';
  end if;
  v_staged := public.pb_staged_batches_using(d.id, m.id);
  delete from public.benchmark_dataset_metrics where id = cur.id;
  insert into public.benchmark_dataset_metric_events (dataset_id, metric_definition_id, dataset_name, dataset_version, metric_code, action, values_before, ranges_before, values_after, ranges_after, live_figures, live_confirmed, staged_batches, reason, actor_user_id)
  values (d.id, m.id, d.dataset_name, d.version, m.metric_code, 'removed', cur.applies_to_values, cur.applies_to_target_ranges, false, false, v_live, coalesce(p_confirm_live, false), v_staged, v_reason, v_uid);
  return jsonb_build_object('status', 'removed', 'dataset_id', d.id, 'metric_code', m.metric_code, 'live_figures', v_live, 'staged_batches', v_staged);
end;
$fn$;

revoke all on function set_planning_benchmark_dataset_metric(uuid, text, boolean, boolean, text, boolean), remove_planning_benchmark_dataset_metric(uuid, text, text, boolean) from public, anon;
grant execute on function set_planning_benchmark_dataset_metric(uuid, text, boolean, boolean, text, boolean), remove_planning_benchmark_dataset_metric(uuid, text, text, boolean) to authenticated;
