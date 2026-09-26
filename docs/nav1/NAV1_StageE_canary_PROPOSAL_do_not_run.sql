-- =============================================================================
-- NAV 1 Stage E -- CANARY DELETION, PROPOSAL ONLY.
--
-- DO NOT RUN before explicit written PO authorization naming:
--   manifest  NAV1-D10-production-2026-09-25-ffdff57ed75a
--   canary    6,705 rows (4 funds proven recoverable from AMFI), primary-key md5 ec137c8b2bb59bcc93342b0f94f63086
--   ceiling   6,705 rows
-- and NOT before migrations 0200 (fail-closed predicate) and 0201 (self-FK
-- indexes) are applied to production. Without 0201 every deleted row costs two
-- full scans of the 22.4M-row table.
--
-- Design:
--   * deletes ONLY ids from the named canary list (canary_revised_ids.txt, 6,705 ids);
--   * every row is re-checked against the LIVE fail-closed predicate inside
--     the DELETE itself, so a row that became protected since the manifest
--     was generated is skipped, not deleted;
--   * one batch of at most 500 ids per transaction, short lock and statement
--     timeouts, stop on the first anomaly;
--   * pre- and post-checks by count; nothing is inferred.
-- Validated in PGlite: scripts/nav1_stageE_canary_sql_pglite_check.mjs
-- =============================================================================

-- 0. Identity and preconditions (run first; every value must match the package).
select current_database(),
       (select environment || ':' || changeover_date from ii_nav_retention_policy where environment = 'production') as policy,
       (select count(*) from pg_indexes where indexname in ('idx_ii_prices_nav_superseded_by_id', 'idx_ii_prices_nav_correction_of_id')) as fk_indexes_present_expect_2,
       (select count(*) from ii_reference_import_batches where status = 'running') as running_batches_expect_0,
       (select count(*) from pc6_user_held_instrument_ids()) as held_instruments_expect_17;

-- 1. Load the canary list into a temp table (paste canary_ids.txt as VALUES rows),
--    and a work queue each batch consumes, so every id is visited exactly once.
create temp table nav1_canary_ids (id uuid primary key);
-- insert into nav1_canary_ids (id) values ('...'), ('...'), ...;   -- 6,705 rows from canary_revised_ids.txt
select count(*) as loaded_expect_6705, md5(string_agg(id::text, E'\n' order by id)) as md5_expect_ec137c8b2bb59bcc93342b0f94f63086
from nav1_canary_ids;
create temp table nav1_canary_queue as select id from nav1_canary_ids;
create temp table nav1_canary_log (batch_no serial, taken int, deleted int, at timestamptz default clock_timestamp());

-- 2. Pre-check: every canary id exists, is before the changeover, and is a
--    candidate under the live predicate. All three must equal 6,705.
select count(*) filter (where p.id is not null) as exist,
       count(*) filter (where p.price_date < date '2026-09-21') as pre_changeover,
       count(*) filter (where pc6_nav_row_is_candidate(p.instrument_id, p.price_date, date '2026-09-21')) as candidates
from nav1_canary_ids c left join ii_prices_nav p on p.id = c.id;

-- 3. One batch: take the next 500 ids off the queue (whatever happens to them),
--    delete those still eligible, log taken vs deleted. Repeat until the queue
--    is empty. A skipped id (taken but not deleted) is NOT retried: any
--    batch with deleted < taken is an anomaly -- STOP and report it.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';
with taken as (
  delete from nav1_canary_queue q
  where q.id in (select id from nav1_canary_queue order by id limit 500)
  returning q.id
), gone as (
  delete from ii_prices_nav p
  using taken t
  where p.id = t.id
    and p.price_date < date '2026-09-21'
    and pc6_nav_row_is_candidate(p.instrument_id, p.price_date, date '2026-09-21')
  returning p.id
)
insert into nav1_canary_log (taken, deleted)
select (select count(*) from taken), (select count(*) from gone)
returning batch_no, taken, deleted;
-- If deleted <> taken, or anything errors: ROLLBACK and stop.
commit;

-- 4. Post-check: canary fully gone; protected set untouched.
select (select count(*) from nav1_canary_ids c join ii_prices_nav p on p.id = c.id) as canary_rows_left_expect_0,
       (select count(*) from ii_prices_nav where instrument_id in (select instrument_id from pc6_user_held_instrument_ids())) as held_rows_expect_unchanged;
