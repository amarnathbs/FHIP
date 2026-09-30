-- NAV 1 -- daily-job pre-changeover residue (2026-10-01) -- PRODUCTION, DELETE.
--
-- *** DO NOT RUN BEFORE the fix is merged AND deployed AND a daily run has
-- *** shown a non-zero skipped_pre_changeover counter (README.md step 3).
-- *** Before that, the next daily run simply re-inserts every row this deletes.
--
-- One statement (a DO block), hence ONE transaction: it either deletes all of
-- the rows described below and passes every self-check, or it raises and
-- deletes nothing. Idempotent: run again and it finds 0 rows and deletes 0.
--
-- WHAT IT DELETES -- only rows that satisfy ALL of:
--   (i)  pc6_nav_row_is_candidate(instrument_id, price_date, changeover) is
--        true, evaluated LIVE inside the DELETE (migration 0200's fail-closed
--        predicate: before the changeover AND not user-held, benchmarked,
--        report-pinned, under an open hold, or in the merge family of one), so
--        a row that became protected since 01 was run is skipped, not deleted;
--   (ii) price_date < 2026-09-21 (the policy changeover C) AND
--        created_at >= 2026-09-30 00:00 UTC (the known residue window: rows the
--        daily job re-created after Stage E cleaned the table).
-- Nothing else is touched. No other table is written.
--
-- SELF-CHECKS (any failure raises and rolls the whole statement back):
--   * the predicate can see holdings at all (held instruments > 0);
--   * the production policy row says changeover 2026-09-21;
--   * at most 1,500 rows match (residue was 1,276; more means the fix is not
--     deployed or something else is creating rows -- stop and investigate);
--   * zero deleted rows belong to a held instrument;
--   * the held instruments' row count is identical before and after. (If this
--     trips by a small positive difference, a daily/hydration insert landed
--     between the two counts: just re-run outside 03:25-04:45 UTC.)
--
-- Why one transaction and no batching: 1,276 rows is tiny (Stage E needed
-- 500-row batches for 22 million). Migration 0201's self-FK indexes exist in
-- production, so each deleted row costs an index probe, not a table scan. The
-- predicate is the slow part (a few ms per row): expect roughly 5-20 seconds;
-- the 120 s statement_timeout below is generous headroom. lock_timeout 5 s
-- means it gives up rather than queue behind a long writer.
--
-- The functions are service_role-only (0200); the SQL Editor runs as the
-- postgres role, which owns them and bypasses RLS.

do $$
declare
  c                 constant date := date '2026-09-21';
  v_found           integer;
  v_deleted         integer;
  v_held_hit        integer;
  v_held_before     bigint;
  v_held_after      bigint;
begin
  perform set_config('lock_timeout', '5s', true);
  perform set_config('statement_timeout', '120s', true);

  if (select count(*) from pc6_user_held_instrument_ids()) = 0 then
    raise exception 'REFUSING: pc6_user_held_instrument_ids() is empty - the predicate cannot see holdings, its verdicts are untrustworthy';
  end if;
  if not exists (select 1 from ii_nav_retention_policy where environment = 'production' and changeover_date = c) then
    raise exception 'REFUSING: no production ii_nav_retention_policy row with changeover_date = %', c;
  end if;

  select count(*) into v_found
  from ii_prices_nav p
  where p.price_date < c
    and p.created_at >= timestamptz '2026-09-30 00:00:00+00'
    and pc6_nav_row_is_candidate(p.instrument_id, p.price_date, c);
  if v_found > 1500 then
    raise exception 'REFUSING: % candidate rows exceed the 1500 ceiling (expected ~1276). Is the fix deployed? Is something else creating pre-changeover rows?', v_found;
  end if;

  select count(*) into v_held_before
  from ii_prices_nav where instrument_id in (select instrument_id from pc6_user_held_instrument_ids());

  with gone as (
    delete from ii_prices_nav p
    where p.price_date < c
      and p.created_at >= timestamptz '2026-09-30 00:00:00+00'
      and pc6_nav_row_is_candidate(p.instrument_id, p.price_date, c)
    returning p.instrument_id
  )
  select count(*),
         count(*) filter (where instrument_id in (select instrument_id from pc6_user_held_instrument_ids()))
    into v_deleted, v_held_hit
  from gone;

  select count(*) into v_held_after
  from ii_prices_nav where instrument_id in (select instrument_id from pc6_user_held_instrument_ids());

  if v_held_hit <> 0 then
    raise exception 'ABORT (rolled back): % deleted rows belonged to a held instrument', v_held_hit;
  end if;
  if v_held_after <> v_held_before then
    raise exception 'ABORT (rolled back): held-instrument rows changed from % to % during the delete', v_held_before, v_held_after;
  end if;

  raise notice 'NAV1 residue delete OK: % rows matched, % deleted, held-instrument rows % -> % (unchanged)', v_found, v_deleted, v_held_before, v_held_after;
end
$$;
