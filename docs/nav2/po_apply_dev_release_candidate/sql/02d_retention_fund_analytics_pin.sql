-- 02d (read only, needs migration 0261 applied). Does the retention function protect the price range a Fund analytics report is pinned to? Expect ONE row.
-- If no report exists yet there is no sample (pin_sample_found false) and that is not a failure: the PGlite proof covers the case with built-in rows.
-- Both answers must be false when a sample exists. The first date is inside the pinned range, the second is the last pinned date.
with c as (select date '2026-09-21' as changeover),
pinned as (select instrument_id as id, nav_date_from as d0, nav_date_to as d1 from public.nav2_report_nav_dependencies order by created_at desc limit 1)
select
  (select count(*) from pinned) = 1 as pin_sample_found,
  (select public.pc6_nav_row_is_candidate(id, coalesce(d0, d1), c.changeover) from pinned, c) as first_pinned_date_answer_expect_false,
  (select public.pc6_nav_row_is_candidate(id, d1, c.changeover) from pinned, c) as last_pinned_date_answer_expect_false;
