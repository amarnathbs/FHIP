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
