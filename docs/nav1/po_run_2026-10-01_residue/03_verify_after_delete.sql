-- NAV 1 -- daily-job pre-changeover residue (2026-10-01) -- PRODUCTION, READ-ONLY.
-- Run AFTER 02_delete_residue.sql. Nothing here writes. It is also the
-- recurring check to run after every later daily run (README.md "Afterwards").

-- 1. Residue candidates remaining -- expect 0.
select count(*) as residue_candidates_remaining_expect_0
from ii_prices_nav p
where p.price_date < date '2026-09-21'
  and p.created_at >= timestamptz '2026-09-30 00:00:00+00'
  and pc6_nav_row_is_candidate(p.instrument_id, p.price_date, date '2026-09-21');

-- 2. Every non-held pre-changeover candidate in the whole table -- expect 0.
select count(*) as non_held_pre_changeover_candidates_expect_0
from ii_prices_nav p
where p.price_date < date '2026-09-21'
  and p.instrument_id not in (select instrument_id from pc6_user_held_instrument_ids())
  and pc6_nav_row_is_candidate(p.instrument_id, p.price_date, date '2026-09-21');

-- 3. Held instruments untouched -- expect >= the baseline recorded by 01
--    (85485 for 19 instruments on 2026-10-01). It may only have grown.
select (select count(*) from pc6_user_held_instrument_ids()) as held_instruments,
       count(*)                                              as held_instrument_rows_expect_ge_85485
from ii_prices_nav
where instrument_id in (select instrument_id from pc6_user_held_instrument_ids());

-- 4. The total. Expect  (total recorded in 01)  -  (rows 02 deleted, ~1276)
--    + (post-changeover rows the daily job has added since). A drop larger
--    than the deleted count would be a problem -- report it.
select count(*) as total_nav_rows from ii_prices_nav;

-- 5. The daily job's own record of what it skipped, latest runs first. After
--    the fix is deployed, every run that parsed the file shows
--    skipped_pre_changeover > 0 (about 1,276 + any newly dormant schemes) and
--    pre_changeover_filter.applied = true. applied = false means the filter
--    failed OPEN (reason says why: no_policy / invalid_policy /
--    policy_read_failed / protection_read_failed) -- rows may be re-created.
select started_at, status, as_of_date, rows_inserted,
       notes -> 'skipped_pre_changeover'            as skipped_pre_changeover,
       notes -> 'pre_changeover_filter'             as pre_changeover_filter
from ii_reference_import_batches
where batch_kind = 'daily_nav'
order by started_at desc
limit 10;

-- 6. Pre-changeover rows the daily parser wrote AFTER the fix went live.
--    Replace the timestamp with the moment the deploy finished (README step 2).
--    Expect 0 once the delete has run (and, before it, expect the same number
--    that 01 reported -- i.e. no new ones).
select count(*) as daily_parser_pre_changeover_since_deploy_expect_0
from ii_prices_nav p
where p.price_date < date '2026-09-21'
  and p.data_version like 'pc6-amfi-parser-v1:%'
  and p.created_at >= timestamptz '2026-10-01 00:00:00+00'  -- <-- set to the deploy-finished time (UTC)
  and pc6_nav_row_is_candidate(p.instrument_id, p.price_date, date '2026-09-21');
