-- 0271 -- the fund analytics monitoring snapshot no longer counts the whole price table exactly (Stage 3 finding, second step).
--
-- Forward-only and idempotent (create or replace). HAND-OVER ARTEFACT: NOT APPLIED anywhere. Apply after 0270.
--
-- FOUND ON DEV (06-10-2026), after 0270 was applied: the admin page still answered canceling statement due to statement timeout (57014) for an
-- administrator. One exact count of the price table (about three million rows) takes about 3.7 seconds on DEV even as the service role, and
-- the signed-in role has a shorter limit, so even one table-wide count is too much inside this function.
--
-- This replaces that one count by the database own row estimate (pg_class.reltuples, kept fresh by autovacuum) and says so in the cells it
-- feeds: nav_rows_total and the non-held figure before the changeover carry approximate = true and a note. The held figure stays exact (it is
-- counted one held instrument at a time on the instrument and date key) and the post-changeover count stays exact (date index). When the
-- table has never been analysed the estimate is not usable and both approximate cells are shown as unavailable, never as a number.
-- Authorisation, suppression below 5 and the grants are unchanged.
--
-- ROLLBACK: apply the function body of 0270 again.

create or replace function nav2_monitoring_snapshot() returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
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
  v_nav_rows_held_post bigint;
  v_nav_rows_post bigint;
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

  -- COST. One exact count of the whole price table is already too slow here, so the total is the database row estimate and the two figures
  -- built on it are marked approximate. The held rows are counted one held instrument at a time on the instrument and date key, and the rows
  -- dated on or after the changeover use the date index. The non-held figure before the changeover is the estimated total less the held rows
  -- less the non-held rows on or after the changeover.
  select case when c.reltuples >= 0 then c.reltuples::bigint else null end into v_nav_rows from pg_class c where c.oid = 'public.ii_prices_nav'::regclass;
  select count(*) into v_nav_rows_post from public.ii_prices_nav p where p.price_date >= v_changeover;
  select coalesce(sum(c.n), 0), coalesce(sum(c.n_post), 0) into v_nav_rows_held, v_nav_rows_held_post
    from public.pc6_user_held_instrument_ids() h
    cross join lateral (
      select count(*) as n, count(*) filter (where p.price_date >= v_changeover) as n_post
        from public.ii_prices_nav p where p.instrument_id = h.instrument_id
    ) c;
  v_nav_rows_nonheld_prepolicy := case when v_nav_rows is null then null else greatest(0, v_nav_rows - v_nav_rows_held - (v_nav_rows_post - v_nav_rows_held_post)) end;

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
      'nav_rows_total', public.nav2_monitor_cell(v_nav_rows, false) || jsonb_build_object('approximate', true, 'note', 'Approximate, taken out of the database table statistics.'),
      'nav_rows_of_held_instruments', case when v_held < 5 then jsonb_build_object('state', 'suppressed', 'value', null, 'label', 'Insufficient data to display safely.') else public.nav2_monitor_cell(v_nav_rows_held, false) end,
      'nav_rows_non_held_before_policy_changeover', case when v_held < 5 then jsonb_build_object('state', 'suppressed', 'value', null, 'label', 'Insufficient data to display safely.') else public.nav2_monitor_cell(v_nav_rows_nonheld_prepolicy, false) || jsonb_build_object('approximate', true, 'note', 'Approximate, taken out of the database table statistics.') end
    )
  );
end $fn$;


revoke all on function nav2_monitoring_snapshot() from public, anon;
grant execute on function nav2_monitoring_snapshot() to authenticated, service_role;
