-- READ ONLY. Changes nothing. Run on PRODUCTION (twwpnltizhtjxhamyoxt) first, in a new empty SQL tab.
-- Expected: every row has ok = true. If any row is false, stop and send me the result before going on.
select 'switch row exists' as check_name,
       exists (select 1 from public.ii_reference_job_control where job_key = 'nav2_risk_free_weekly_refresh') as ok
union all
select 'switch is OFF at the moment (expected before step 2)',
       coalesce((select not enabled from public.ii_reference_job_control where job_key = 'nav2_risk_free_weekly_refresh'), false)
union all
select 'attempt log table exists (0263)', to_regclass('public.ii_risk_free_refresh_attempts') is not null
union all
select 'step table exists (0318, apply 1b_APPLY_0318_stage_table.sql first if this says false)', to_regclass('public.ii_risk_free_refresh_stage') is not null
union all
select 'refresh write function exists (0260)',
       exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'record_risk_free_refresh_results')
union all
select 'pg_cron is installed', exists (select 1 from pg_extension where extname = 'pg_cron')
union all
select 'pg_net is installed', exists (select 1 from pg_extension where extname = 'pg_net')
union all
select 'cron secret is in the vault', exists (select 1 from vault.secrets where name = 'pc6_reference_ingest_cron_secret')
union all
select 'this database is marked production', exists (select 1 from public.platform_deployment_environment where environment = 'production')
union all
select 'no refresh schedule registered yet', not exists (select 1 from cron.job where starts_with(jobname, 'nav2-risk-free-refresh'));
