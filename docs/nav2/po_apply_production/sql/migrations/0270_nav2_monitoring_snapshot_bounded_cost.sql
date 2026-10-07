-- 0270 -- the fund analytics monitoring snapshot answers inside the database time limit (Stage 3 finding).
--
-- Forward-only and idempotent (create or replace). HAND-OVER ARTEFACT: NOT APPLIED anywhere. Apply after 0262 and 0263.
--
-- FOUND ON DEV (Stage 3, 06-10-2026): the admin page Fund analytics health showed an error, because nav2_monitoring_snapshot() answered
-- canceling statement due to statement timeout (57014) for a signed-in administrator. Its three storage figures scanned the price table
-- (about three million rows) three times. This replaces only those three queries. Every figure keeps its meaning and its value. The
-- authorisation check, the suppression rule (a figure that comes out of the holdings of users and is below 5 is withheld) and the grants are unchanged.
-- It is proven equal to the 0262 function on a synthetic data set by tests/unit/nav2/nav2Stage3SqlFixes.test.ts. The timing itself can only
-- be shown on DEV: after applying, the monitoring page must load.
--
-- ROLLBACK: apply the function body of 0262 again (create or replace).

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

  -- COST. The three storage figures used to scan the whole price table three times and test every row against the held set. That passed
  -- the database statement time limit on a table of about three million rows. Now there is one count of the whole table, one count of the
  -- rows dated on or after the changeover (the date index), and the held instruments are counted one by one on the instrument and date key.
  -- The three figures keep their exact meaning. The non-held figure before the changeover is the total less the held rows less the
  -- non-held rows on or after the changeover.
  select count(*) into v_nav_rows from public.ii_prices_nav;
  select count(*) into v_nav_rows_post from public.ii_prices_nav p where p.price_date >= v_changeover;
  select coalesce(sum(c.n), 0), coalesce(sum(c.n_post), 0) into v_nav_rows_held, v_nav_rows_held_post
    from public.pc6_user_held_instrument_ids() h
    cross join lateral (
      select count(*) as n, count(*) filter (where p.price_date >= v_changeover) as n_post
        from public.ii_prices_nav p where p.instrument_id = h.instrument_id
    ) c;
  v_nav_rows_nonheld_prepolicy := v_nav_rows - v_nav_rows_held - (v_nav_rows_post - v_nav_rows_held_post);

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
end $fn$;

revoke all on function nav2_monitoring_snapshot() from public, anon;
grant execute on function nav2_monitoring_snapshot() to authenticated, service_role;
