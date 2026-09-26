-- =============================================================================
-- NAV 1 (2026-09-27) -- DEV, READ-ONLY verification after DEV_01..DEV_03.
-- Project vqycarelcoijzwlpkpcz. Paste every result grid back.
-- =============================================================================

-- V1 identity: expect 'dev:nav1-0189-user-held:2026-09-21' and nothing else.
select current_database() as db,
       (select string_agg(environment || ':' || policy_version || ':' || changeover_date, ', ') from ii_nav_retention_policy) as retention_policy,
       now() as at;

-- V2 0199: table present, RLS on. Expect 1 row, rls = true.
select c.relname, c.relrowsecurity as rls
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'ii_nav_hydration_attempts';

-- V3 0200: the predicate is the hardened one and only service_role may execute.
-- Expect comment starting 'NAV 1 (0189, hardened 0200)'; grantees: postgres
-- (owner) and service_role only; public_can_execute = false for all three.
select obj_description('pc6_nav_row_is_candidate(uuid, date, date)'::regprocedure) as predicate_comment;
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

-- V4 0201: both partial indexes exist and are VALID. Expect 2 rows, indisvalid = true.
select i.relname as index_name, x.indisvalid, x.indisready, pg_size_pretty(pg_relation_size(i.oid)) as size
from pg_index x join pg_class i on i.oid = x.indexrelid
where i.relname in ('idx_ii_prices_nav_superseded_by_id', 'idx_ii_prices_nav_correction_of_id');

-- V5 0194 environment isolation (P2 step 7): NO DEV cron job may call production.
-- Expect zero rows where targets_production = true, and no pc6-reference-ingest*,
-- pc6-scheme-master-weekly or pc6-selective-hydration job at all on DEV.
select jobid, jobname, schedule, active,
       command ilike '%app.financialhealthplatform.com%' as targets_production
from cron.job
order by jobname;
