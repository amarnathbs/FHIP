-- =============================================================================
-- NAV 1 (2026-09-27) -- PRODUCTION, READ-ONLY. Project twwpnltizhtjxhamyoxt.
-- Every statement is a SELECT. Paste each result grid back (counts, names and
-- timestamps only -- none returns personal data).
-- Supersedes the stale Q2b expectations in NAV1_D10_manifest_sql_for_PO.sql
-- (0205 replaced the 0187/0188 job names and schedules).
-- =============================================================================

-- P1 identity. Expect 'production:nav1-0189-user-held:2026-09-21'.
select current_database() as db,
       (select string_agg(environment || ':' || policy_version || ':' || changeover_date, ', ') from ii_nav_retention_policy) as retention_policy,
       now() as at;

-- P2 cron (P2 step 8): each NAV job registered EXACTLY ONCE and active.
-- Expected 4 rows, n = 1 each, active = true:
--   pc6-reference-ingest        30-58/2 3 * * 2-6
--   pc6-reference-ingest-0400   0-30/2 4 * * 2-6
--   pc6-scheme-master-weekly    0-28/2 3 * * 2      (Tuesday -> first window Tue 29 Sep)
--   pc6-selective-hydration     */30 * * * *        (0193; verify the exact text)
-- and every one targets the production URL.
select jobname, schedule, active, count(*) over (partition by jobname) as n,
       command ilike '%app.financialhealthplatform.com%' as targets_production
from cron.job
where jobname like 'pc6-%'
order by jobname;

-- P3 0200 grants (P5 fail-closed; F-2): expect grantees postgres + service_role
-- only, and public_can_execute = false for all three functions.
select p.proname, r.rolname
from pg_proc p
cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
join pg_roles r on r.oid = a.grantee
where p.proname in ('pc6_nav_row_is_candidate', 'pc6_instrument_is_user_held', 'pc6_user_held_instrument_ids')
  and a.privilege_type = 'EXECUTE'
order by 1, 2;
select p.proname, bool_or(a.grantee = 0) as public_can_execute
from pg_proc p cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
where p.proname in ('pc6_nav_row_is_candidate', 'pc6_instrument_is_user_held', 'pc6_user_held_instrument_ids')
group by 1;

-- P4 0201 indexes valid (operator-confirmed by screenshot 26 Sep; this is the
-- text form for the record). Expect 2 rows, indisvalid = true.
select i.relname as index_name, x.indisvalid, x.indisready, pg_size_pretty(pg_relation_size(i.oid)) as size
from pg_index x join pg_class i on i.oid = x.indexrelid
where i.relname in ('idx_ii_prices_nav_superseded_by_id', 'idx_ii_prices_nav_correction_of_id');

-- P5 0168 trigger present (the rolled-back behavioural proof is Q7 in
-- NAV1_D10_manifest_sql_for_PO.sql -- run that block too). Expect 1.
select count(*) as trigger_present
from pg_trigger where tgname = 'trg_pc6_hold_on_statement_acceptance' and not tgisinternal;

-- P6 size baseline (P9 item 10 / P11). Physical sizes are not readable over
-- PostgREST; this is the only measured baseline the package can carry.
select pg_size_pretty(pg_database_size(current_database())) as database_size,
       pg_database_size(current_database()) as database_bytes,
       pg_size_pretty(pg_total_relation_size('ii_prices_nav')) as nav_total,
       pg_total_relation_size('ii_prices_nav') as nav_total_bytes,
       pg_size_pretty(pg_relation_size('ii_prices_nav')) as nav_heap,
       pg_size_pretty(pg_indexes_size('ii_prices_nav')) as nav_indexes;
select relname, n_live_tup, n_dead_tup, last_autovacuum, last_autoanalyze
from pg_stat_user_tables where relname = 'ii_prices_nav';

-- P7 HTTP layer of the most recent scheduled calls (the batch table is the
-- authoritative record; this shows status codes / timeouts at pg_net).
select id, status_code, timed_out, created, left(error_msg, 160) as err
from net._http_response
where created > now() - interval '6 hours'
order by created desc
limit 20;
