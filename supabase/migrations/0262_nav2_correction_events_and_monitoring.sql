-- 0262 -- NAV2 Stage 2: the correction listener (events raised when a NAV, benchmark or risk-free
-- value is corrected) and the aggregate-only monitoring snapshot (spec 15).
--
-- Forward-only, additive, idempotent. HAND-OVER ARTEFACT: NOT APPLIED anywhere. Apply AFTER 0260 and 0261.
--
-- THE LISTENER. A NAV correction is an in-place UPDATE of ii_prices_nav plus an append-only row in
-- ii_reference_corrections (the unique (instrument_id, price_date) key forbids a second row). This migration
-- adds an AFTER INSERT trigger on that ledger (and on ii_risk_free_corrections) which records ONE
-- event per correction in nav2_correction_events. The NAV2 correction worker (a service-role cron route, shipped
-- OFF behind the job-control row nav2_correction_worker) reads the unprocessed events and invalidates exactly the
-- cache entries a change can affect. The trigger never touches the correction ledger rows themselves.
--
-- MONITORING (Admin Architecture Standard sections 7, 8, 9, 12). nav2_monitoring_snapshot() is an aggregate-only
-- SECURITY DEFINER function authorised INSIDE by the existing named capability behind the PC6 reference-data
-- quality surface (is_pc6_reference_data_admin(): this is a read-only health view of that same surface, so no
-- new capability is created). Every figure derived from user holdings is suppressed below 5 (state 'suppressed',
-- label "Insufficient data to display safely.") and an absent source is 'unavailable', never a bare 0.

-- ---------------------------------------------------------------------------
-- 1. Correction events
-- ---------------------------------------------------------------------------
create table if not exists nav2_correction_events (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('nav_correction', 'benchmark_correction', 'risk_free_correction')),
  source_correction_id uuid not null,
  instrument_id uuid,
  benchmark_id uuid,
  series_id text,
  event_date date not null,
  created_at timestamptz not null default now(),
  processed_at timestamp with time zone,
  entries_invalidated integer check (entries_invalidated is null or entries_invalidated >= 0),
  constraint nav2_correction_events_unique unique (kind, source_correction_id)
);
create index if not exists idx_nav2_correction_events_unprocessed on nav2_correction_events (created_at) where processed_at is null;
alter table nav2_correction_events enable row level security;
revoke all on nav2_correction_events from anon, authenticated;

create or replace function nav2_capture_reference_correction() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_inst uuid;
  v_bench uuid;
  v_date date;
begin
  if new.target_table = 'ii_prices_nav' then
    select p.instrument_id, p.price_date into v_inst, v_date from public.ii_prices_nav p where p.id = new.target_row_id;
    if v_inst is not null then
      insert into public.nav2_correction_events (kind, source_correction_id, instrument_id, event_date)
      values ('nav_correction', new.id, v_inst, v_date) on conflict do nothing;
    end if;
  elsif new.target_table = 'ii_benchmark_series' then
    select s.benchmark_id, s.series_date into v_bench, v_date from public.ii_benchmark_series s where s.id = new.target_row_id;
    if v_bench is not null then
      insert into public.nav2_correction_events (kind, source_correction_id, benchmark_id, event_date)
      values ('benchmark_correction', new.id, v_bench, v_date) on conflict do nothing;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_nav2_capture_reference_correction on ii_reference_corrections;
create trigger trg_nav2_capture_reference_correction after insert on ii_reference_corrections
  for each row execute function nav2_capture_reference_correction();

create or replace function nav2_capture_risk_free_correction() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.nav2_correction_events (kind, source_correction_id, series_id, event_date)
  values ('risk_free_correction', new.id, new.series_id, new.observation_date) on conflict do nothing;
  return new;
end $$;
drop trigger if exists trg_nav2_capture_risk_free_correction on ii_risk_free_corrections;
create trigger trg_nav2_capture_risk_free_correction after insert on ii_risk_free_corrections
  for each row execute function nav2_capture_risk_free_correction();

-- ---------------------------------------------------------------------------
-- 2. Monitoring snapshot
-- ---------------------------------------------------------------------------
create or replace function nav2_monitor_cell(p_value bigint, p_user_derived boolean) returns jsonb
language sql immutable as $$
  select case
    when p_value is null then jsonb_build_object('state', 'unavailable', 'value', null, 'label', 'Not available.')
    when p_user_derived and p_value < 5 then jsonb_build_object('state', 'suppressed', 'value', null, 'label', 'Insufficient data to display safely.')
    else jsonb_build_object('state', 'ok', 'value', p_value)
  end;
$$;

create or replace function nav2_monitoring_snapshot() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_held bigint;
  v_held_no_nav bigint;
  v_held_stale bigint;
  v_failing bigint;
  v_unresolvable bigint;
  v_oldest_attempt_days bigint;
  v_corr_7d bigint;
  v_lag_seconds bigint;
  v_cache_total bigint;
  v_cache_invalid bigint;
  v_nav_rows bigint;
  v_nav_rows_held bigint;
  v_nav_rows_nonheld_prepolicy bigint;
  v_reports_30d bigint;
  v_state_counts jsonb;
  v_series jsonb;
  v_bench_total bigint;
  v_bench_with_series bigint;
  v_changeover constant date := date '2026-09-21';
begin
  if auth.uid() is null or not public.is_pc6_reference_data_admin() then
    raise exception 'nav2 monitoring: not authorised' using errcode = '42501';
  end if;

  select count(*) into v_held from public.pc6_user_held_instrument_ids();
  select count(*) into v_held_no_nav from public.pc6_user_held_instrument_ids() h
    where not exists (select 1 from public.ii_prices_nav p where p.instrument_id = h.instrument_id);
  select count(*) into v_held_stale from public.pc6_user_held_instrument_ids() h
    where (select max(p.price_date) from public.ii_prices_nav p where p.instrument_id = h.instrument_id) < current_date - 7;
  select count(*) filter (where consecutive_failures > 0),
         count(*) filter (where last_outcome = 'unresolvable_identifier'),
         extract(day from now() - min(last_attempted_at))::bigint
    into v_failing, v_unresolvable, v_oldest_attempt_days
    from public.ii_nav_hydration_attempts;
  select count(*) into v_corr_7d from public.nav2_correction_events where kind = 'nav_correction' and created_at > now() - interval '7 days';
  select extract(epoch from now() - min(created_at))::bigint into v_lag_seconds from public.nav2_correction_events where processed_at is null;
  select count(*), count(*) filter (where invalidated_at is not null) into v_cache_total, v_cache_invalid from public.nav2_result_cache;

  select count(*) into v_nav_rows from public.ii_prices_nav;
  select count(*) into v_nav_rows_held from public.ii_prices_nav p where p.instrument_id in (select instrument_id from public.pc6_user_held_instrument_ids());
  select count(*) into v_nav_rows_nonheld_prepolicy from public.ii_prices_nav p
    where p.price_date < v_changeover and p.instrument_id not in (select instrument_id from public.pc6_user_held_instrument_ids());

  select count(*) into v_reports_30d from public.nav2_fund_analytics_reports where created_at > now() - interval '30 days';
  select coalesce(jsonb_object_agg(k, s), '{}'::jsonb) into v_state_counts from (
    select e.key as k, sum((e.value)::bigint) as s
      from public.nav2_fund_analytics_reports r, jsonb_each_text(r.state_counts) e
     where r.created_at > now() - interval '30 days' group by e.key
  ) t;

  select coalesce(jsonb_agg(jsonb_build_object(
      'series_id', s.series_id,
      'enabled', s.enabled,
      'terms_review_status', s.terms_review_status,
      'cadence', s.cadence,
      'stale_after_days', s.max_staleness_days,
      'last_observation_date', o.last_date,
      'verified_through_date', s.verified_through_date,
      'days_since', case
          when s.cadence = 'policy_change' then (case when s.verified_through_date is null then null else (current_date - s.verified_through_date) end)
          else (case when o.last_date is null then null else (current_date - o.last_date) end) end
    ) order by s.series_id), '[]'::jsonb) into v_series
    from public.ii_risk_free_series s
    left join lateral (select max(observation_date) as last_date from public.ii_risk_free_observations x where x.series_id = s.series_id and x.kind = 'value') o on true;

  select count(*), count(*) filter (where exists (select 1 from public.ii_benchmark_series bs where bs.benchmark_id = b.id))
    into v_bench_total, v_bench_with_series from public.ii_benchmarks b;

  return jsonb_build_object(
    'generated_at', now(),
    'held_instruments', public.nav2_monitor_cell(v_held, true),
    'held_instruments_without_any_nav', public.nav2_monitor_cell(v_held_no_nav, true),
    'held_instruments_with_stale_nav', public.nav2_monitor_cell(v_held_stale, true),
    'hydration_instruments_failing', public.nav2_monitor_cell(v_failing, true),
    'hydration_repeated_identifier_failures', public.nav2_monitor_cell(v_unresolvable, true),
    'hydration_oldest_attempt_age_days', public.nav2_monitor_cell(v_oldest_attempt_days, false),
    'nav_corrections_last_7_days', public.nav2_monitor_cell(v_corr_7d, false),
    'correction_processing_lag_seconds', case when v_lag_seconds is null then jsonb_build_object('state', 'ok', 'value', 0, 'label', 'No unprocessed correction.') else public.nav2_monitor_cell(v_lag_seconds, false) end,
    'cache_entries', public.nav2_monitor_cell(v_cache_total, false),
    'cache_entries_invalidated', public.nav2_monitor_cell(v_cache_invalid, false),
    'reports_last_30_days', public.nav2_monitor_cell(v_reports_30d, true),
    'result_states_last_30_days', case when v_reports_30d < 5 then jsonb_build_object('state', 'suppressed', 'value', null, 'label', 'Insufficient data to display safely.') else jsonb_build_object('state', 'ok', 'value', v_state_counts) end,
    'risk_free_series', jsonb_build_object('state', case when jsonb_array_length(v_series) = 0 then 'unavailable' else 'ok' end, 'value', v_series),
    'benchmarks_in_catalogue', public.nav2_monitor_cell(v_bench_total, false),
    'benchmarks_with_any_series', public.nav2_monitor_cell(v_bench_with_series, false),
    'storage', jsonb_build_object(
      'nav_rows_total', public.nav2_monitor_cell(v_nav_rows, false),
      'nav_rows_of_held_instruments', case when v_held < 5 then jsonb_build_object('state', 'suppressed', 'value', null, 'label', 'Insufficient data to display safely.') else public.nav2_monitor_cell(v_nav_rows_held, false) end,
      'nav_rows_non_held_before_policy_changeover', case when v_held < 5 then jsonb_build_object('state', 'suppressed', 'value', null, 'label', 'Insufficient data to display safely.') else public.nav2_monitor_cell(v_nav_rows_nonheld_prepolicy, false) end
    )
  );
end $$;
revoke all on function nav2_monitoring_snapshot() from public, anon;
grant execute on function nav2_monitoring_snapshot() to authenticated, service_role;
revoke all on function nav2_monitor_cell(bigint, boolean) from public, anon;
grant execute on function nav2_monitor_cell(bigint, boolean) to authenticated, service_role;

-- ROLLBACK: drop the two triggers and trigger functions, nav2_monitoring_snapshot(), nav2_monitor_cell() and nav2_correction_events.
