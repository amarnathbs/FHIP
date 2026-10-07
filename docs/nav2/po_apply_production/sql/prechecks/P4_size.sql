-- P4 (read only). How big the database is and how big the price table is. NAV2 adds 12 small tables and a few functions, no price rows.
-- It uses the table statistics for the row count (never a full count, which is slow on the big price table).
-- Expect ONE row. Paste it back. The free disk space is read in the Supabase dashboard (Reports, Database, Disk size) and is not available here.
select
  pg_size_pretty(pg_database_size(current_database())) as database_size,
  pg_size_pretty(pg_total_relation_size('public.ii_prices_nav')) as price_table_total_size,
  (select c.reltuples::bigint from pg_class c where c.oid = 'public.ii_prices_nav'::regclass) as price_rows_estimate,
  (select count(*) from public.pc6_user_held_instrument_ids()) as held_funds_now;
