-- PC6 daily NAV ingest -- exact (instrument_id, price_date) pair lookup.
--
-- WHY. The daily ingest (lib/services/investment-intelligence/pc6/
-- referenceIngestJob.ts) must know, before it writes, which NAV rows already
-- exist. It asked PostgREST for
--     instrument_id IN (100 ids)  AND  price_date IN (every NAV date in the file)
-- AMFI's NAVAll.txt carries 831 distinct NAV dates (2008-2026): ~8,700 rows
-- on the current date plus dormant schemes whose last NAV is years old. That
-- cross product is not the set of pairs the file contains -- with full
-- history stored (~22.4M rows) one batch of 100 instruments returned 50,000-
-- 69,000 rows (51-69 pages, 20-23 s, measured read-only against production
-- on 2026-09-25), for ~144 batches. The production run took 1,212 s; the
-- hosting platform kills every request at 28 s, so the scheduled run never
-- finished.
--
-- WHAT. One read-only function that returns exactly the stored rows for the
-- (instrument_id, price_date) pairs it is given -- a join of the two
-- parallel arrays (unnest) against the table's unique (instrument_id,
-- price_date) key. Each pair matches at most one row, so N pairs return at
-- most N rows; the job calls it with <= 1000 pairs per call, which keeps
-- every response inside PostgREST's 1000-row cap with no paging.
--
-- SECURITY. Reference market data only (no user data, no tenancy column).
-- SECURITY INVOKER: it reads with the caller's own rights and bypasses
-- nothing. EXECUTE is revoked from PUBLIC, anon and authenticated and
-- granted to service_role only -- the ingest job's own role. A fixed
-- search_path, no dynamic SQL, and a fixed return shape (returns table).
--
-- ARRAYS OF DIFFERENT LENGTH are refused with an exception rather than
-- silently padded with NULLs by unnest() -- a padded pair would match
-- nothing and quietly report "no existing row", which is the kind of silent
-- wrong answer this function exists to remove.
--
-- Verification: scripts/pc6_0204_pglite_verification.mjs.

create or replace function public.ii_prices_nav_existing_pairs(
  p_instrument_ids uuid[],
  p_price_dates date[]
)
returns table (
  instrument_id uuid,
  price_date date,
  price numeric,
  record_checksum text,
  quality_status text
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $fn$
#variable_conflict use_column
begin
  if coalesce(cardinality(p_instrument_ids), 0) <> coalesce(cardinality(p_price_dates), 0) then
    raise exception 'ii_prices_nav_existing_pairs: p_instrument_ids (%) and p_price_dates (%) must have the same length',
      coalesce(cardinality(p_instrument_ids), 0), coalesce(cardinality(p_price_dates), 0)
      using errcode = '22023';
  end if;

  return query
    select n.instrument_id, n.price_date, n.price, n.record_checksum, n.quality_status
    from unnest(p_instrument_ids, p_price_dates) as k(k_instrument_id, k_price_date)
    join public.ii_prices_nav n
      on n.instrument_id = k.k_instrument_id
     and n.price_date = k.k_price_date;
end;
$fn$;

comment on function public.ii_prices_nav_existing_pairs(uuid[], date[]) is
  'PC6 daily NAV ingest: stored ii_prices_nav rows for exactly the given (instrument_id, price_date) pairs (parallel arrays of equal length). At most one row per pair. service_role only. Migration 0204.';

revoke all on function public.ii_prices_nav_existing_pairs(uuid[], date[]) from public;
revoke all on function public.ii_prices_nav_existing_pairs(uuid[], date[]) from anon;
revoke all on function public.ii_prices_nav_existing_pairs(uuid[], date[]) from authenticated;
grant execute on function public.ii_prices_nav_existing_pairs(uuid[], date[]) to service_role;

-- PostgREST caches the schema; ask it to reload so the new function is
-- callable immediately rather than 404ing until the next reload.
notify pgrst, 'reload schema';
