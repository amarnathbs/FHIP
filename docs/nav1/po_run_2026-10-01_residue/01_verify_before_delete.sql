-- NAV 1 -- daily-job pre-changeover residue (2026-10-01) -- PRODUCTION, READ-ONLY.
--
-- Run this FIRST, in the Supabase SQL Editor of project twwpnltizhtjxhamyoxt,
-- and read every result. Nothing here writes.
--
-- Do NOT run 02_delete_residue.sql until README.md step 3 is satisfied: the
-- fix (branch fix/nav1-daily-skip-pre-changeover-20261001) is merged AND
-- deployed AND a daily run has shown the skipped_pre_changeover counter.
-- Deleting before that is futile -- the next daily run re-inserts the rows.
--
-- The functions below are service_role-only (migration 0200). The SQL Editor
-- runs as the postgres role, which owns them and bypasses RLS, so they work
-- here; query 1 proves it (held instruments must be > 0, otherwise the
-- predicate cannot see holdings and its answers are not trustworthy).

-- 1. Identity and preconditions.
select current_database()                                                     as db,
       (select environment || ':' || changeover_date
          from ii_nav_retention_policy order by activated_at desc limit 1)    as policy_expect_production_2026_09_21,
       (select count(*) from pc6_user_held_instrument_ids())                  as held_instruments_expect_19_or_more_and_never_0,
       (select count(*) from ii_reference_import_batches
         where status = 'running')                                            as running_batches_expect_0,
       (select count(*) from ii_prices_nav)                                   as total_nav_rows_record_this;

-- 2. The residue, classified. Expected at the time of writing (2026-10-01,
--    verified read-only): residue_rows = 1276, candidate_rows = 1276,
--    protected_rows = 0, before_2026_09_01 = 1270, sep_01_to_20 = 6.
--    residue_rows may be a little LARGER if a daily run executed after
--    2026-10-01 WITHOUT the fix; that is fine (same cause) up to the 1,500
--    ceiling that 02 enforces. candidate_rows must equal residue_rows; any
--    difference means some of these rows are now protected -- STOP and report.
with residue as (
  select p.id, p.instrument_id, p.price_date, p.data_version
  from ii_prices_nav p
  where p.price_date < date '2026-09-21'
    and p.created_at >= timestamptz '2026-09-30 00:00:00+00'
)
select count(*)                                                                                   as residue_rows,
       count(*) filter (where pc6_nav_row_is_candidate(instrument_id, price_date, date '2026-09-21')) as candidate_rows,
       count(*) filter (where not pc6_nav_row_is_candidate(instrument_id, price_date, date '2026-09-21')) as protected_rows,
       count(*) filter (where price_date < date '2026-09-01')                                     as before_2026_09_01,
       count(*) filter (where price_date >= date '2026-09-01')                                    as sep_01_to_20,
       count(*) filter (where data_version like 'pc6-amfi-parser-v1:%')                           as written_by_daily_parser,
       count(distinct instrument_id)                                                              as distinct_instruments,
       min(price_date)                                                                            as oldest_price_date
from residue;

-- 3. Every candidate in the WHOLE table that is not a held instrument.
--    (Held instruments are excluded up front so the predicate is not evaluated
--    on their ~85k rows.) Expect the same number as residue candidates above:
--    every non-protected pre-changeover row in production IS the residue.
--    A larger number means other pre-changeover rows exist that this delete
--    deliberately does not touch (it is limited to rows created on/after
--    2026-09-30); report it, do not widen the delete.
select count(*) as non_held_pre_changeover_candidates
from ii_prices_nav p
where p.price_date < date '2026-09-21'
  and p.instrument_id not in (select instrument_id from pc6_user_held_instrument_ids())
  and pc6_nav_row_is_candidate(p.instrument_id, p.price_date, date '2026-09-21');

-- 4. The baseline the delete must not disturb: rows of held instruments.
--    Record the number. At 2026-10-01 it was 85485 for the 19 held
--    instruments; it may only have GROWN since (new daily / hydration
--    inserts), never shrunk.
select count(*) as held_instrument_rows_baseline_was_85485
from ii_prices_nav
where instrument_id in (select instrument_id from pc6_user_held_instrument_ids());
