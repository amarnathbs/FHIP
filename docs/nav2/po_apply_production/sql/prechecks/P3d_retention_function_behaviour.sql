-- P3d (read only). What the retention function really answers, on real rows. Expect ONE row. Each case picks one real sample if there is one.
-- This file works BEFORE migration 0261 (it names no fund analytics table). A case with no sample says sample_found false for itself (that is not a failure: the PGlite proof covers every case with built-in rows).
-- Every answer that is present must equal its expected value. changeover is the date the retention policy uses (21-09-2026).
-- The function is called as the database owner here. In the application only the service role can call it.
with c as (select date '2026-09-21' as changeover),
held as (select h.instrument_id as id from public.pc6_user_held_instrument_ids() h limit 1),
hold as (select instrument_id as id from public.ii_nav_retention_holds where released_at is null and (expires_at is null or expires_at > now()) limit 1),
pinned as (select instrument_id as id, nav_date_to as d from public.ii_report_nav_dependencies limit 1),
gap as (select instrument_id as id, gap_from as d from public.ii_nav_source_coverage_gaps where resolved_at is null limit 1),
plain as (
  select i.id from public.ii_instruments i
  where not exists (select 1 from public.ii_nav_retention_holds h where h.instrument_id = i.id)
    and not public.pc6_instrument_is_user_held(i.id)
    and not exists (select 1 from public.ii_instrument_benchmarks b where b.instrument_id = i.id)
    and not exists (select 1 from public.ii_report_nav_dependencies d where d.instrument_id = i.id)
    and not exists (select 1 from public.ii_nav_source_coverage_gaps g where g.instrument_id = i.id)
    and i.merged_into_instrument_id is null
    and not exists (select 1 from public.ii_instruments j where j.merged_into_instrument_id = i.id)
  limit 1
)
select
  (select count(*) from held) = 1 as held_sample_found,
  (select public.pc6_nav_row_is_candidate(id, date '2020-01-01', c.changeover) from held, c) as held_answer_expect_false,
  (select count(*) from hold) = 1 as hold_sample_found,
  (select public.pc6_nav_row_is_candidate(id, date '2020-01-01', c.changeover) from hold, c) as held_by_hold_answer_expect_false,
  (select count(*) from pinned) = 1 as report_pin_sample_found,
  (select public.pc6_nav_row_is_candidate(id, d, c.changeover) from pinned, c) as report_pinned_answer_expect_false,
  (select count(*) from gap) = 1 as gap_sample_found,
  (select public.pc6_nav_row_is_candidate(id, d, c.changeover) from gap, c) as gap_protected_answer_expect_false,
  (select public.pc6_nav_row_is_candidate(id, date '2026-10-01', c.changeover) from plain, c) as after_changeover_answer_expect_false,
  (select count(*) from plain) = 1 as unprotected_sample_found,
  (select public.pc6_nav_row_is_candidate(id, date '2020-01-01', c.changeover) from plain, c) as unprotected_old_row_answer_expect_true,
  public.pc6_nav_row_is_candidate(null, null, null) as null_input_answer_expect_false;
