-- Read-only check of migration 0280. It changes nothing. Every row must show PASS in the result column.
-- Run it after the three parts of the migration. The same query is safe to run again at any time.
select c.n, c.check_name, c.expected, c.actual, case when c.expected = c.actual then 'PASS' else 'FAIL' end as result
  from (
    select 1 as n, 'six new columns exist on the entitlement table' as check_name, '6' as expected,
           (select count(*)::text from information_schema.columns
             where table_schema = 'public' and table_name = 'ii_benchmark_entitlements'
               and column_name in ('supersedes_entitlement_id', 'superseded_by', 'superseded_at', 'revision_reason', 'edit_count', 'last_edited_at')) as actual
    union all
    select 2, 'four new checks exist', '4',
           (select count(*)::text from pg_constraint
             where conrelid = 'public.ii_benchmark_entitlements'::regclass
               and conname in ('ii_benchmark_entitlements_superseded_pair', 'ii_benchmark_entitlements_superseded_is_closed', 'ii_benchmark_entitlements_revision_reason', 'ii_benchmark_entitlements_no_self_link'))
    union all
    select 3, 'the shared status list was not widened (no superseded value in it)', 'false',
           (select (strpos(pg_get_constraintdef(oid), 'superseded') > 0)::text from pg_constraint
             where conrelid = 'public.ii_benchmark_entitlements'::regclass and conname = 'ii_benchmark_entitlements_status_check')
    union all
    select 4, 'the two unique indexes exist (one open revision per record, one successor per record)', '2',
           (select count(*)::text from pg_indexes
             where tablename = 'ii_benchmark_entitlements'
               and indexname in ('uq_ii_benchmark_entitlements_one_open_revision', 'uq_ii_benchmark_entitlements_superseded_by'))
    union all
    select 5, 'the five edit functions exist with the expected arguments', '5',
           (select (case when to_regprocedure('public.update_benchmark_entitlement_draft(uuid,jsonb,integer)') is null then 0 else 1 end
                  + case when to_regprocedure('public.propose_benchmark_entitlement_revision(uuid,jsonb,text)') is null then 0 else 1 end
                  + case when to_regprocedure('public.close_benchmark_entitlement_revision(uuid,text,text)') is null then 0 else 1 end
                  + case when to_regprocedure('public.approve_benchmark_entitlement(uuid,text,boolean,integer)') is null then 0 else 1 end
                  + case when to_regprocedure('public.revoke_benchmark_entitlement(uuid,text)') is null then 0 else 1 end)::text)
    union all
    select 6, 'exactly one approve function exists (the old three-argument one was replaced)', '1',
           (select count(*)::text from pg_proc where proname = 'approve_benchmark_entitlement' and pronamespace = 'public'::regnamespace)
    union all
    select 7, 'all five are security definer with a fixed search path', '5',
           (select count(*)::text from pg_proc
             where pronamespace = 'public'::regnamespace and prosecdef
               and strpos(array_to_string(proconfig, ','), 'search_path=public') > 0
               and proname in ('update_benchmark_entitlement_draft', 'propose_benchmark_entitlement_revision', 'close_benchmark_entitlement_revision', 'approve_benchmark_entitlement', 'revoke_benchmark_entitlement'))
    union all
    select 8, 'signed-in users can run the five functions and the anonymous role cannot', '5 and 0',
           (select count(*) filter (where has_function_privilege('authenticated', oid, 'execute'))::text || ' and ' || count(*) filter (where has_function_privilege('anon', oid, 'execute'))::text
              from pg_proc
             where pronamespace = 'public'::regnamespace
               and proname in ('update_benchmark_entitlement_draft', 'propose_benchmark_entitlement_revision', 'close_benchmark_entitlement_revision', 'approve_benchmark_entitlement', 'revoke_benchmark_entitlement'))
    union all
    select 9, 'the two internal helpers cannot be run by the API roles', '0',
           (select count(*)::text from pg_proc
             where pronamespace = 'public'::regnamespace
               and proname in ('ii_bm_entitlement_editable', 'ii_bm_entitlement_normalise')
               and (has_function_privilege('authenticated', oid, 'execute') or has_function_privilege('anon', oid, 'execute')))
    union all
    select 10, 'no record is both approved and superseded', '0',
           (select count(*)::text from public.ii_benchmark_entitlements where superseded_at is not null and status <> 'revoked')
    union all
    select 11, 'no superseded record grants calculation today', '0',
           (select count(*)::text from public.ii_benchmark_entitlements e
             where e.superseded_at is not null and public.benchmark_entitlement_grants(e, 'calculation', current_date))
    union all
    select 12, 'no record has more than one open revision', '0',
           (select count(*)::text from (
              select supersedes_entitlement_id from public.ii_benchmark_entitlements
               where supersedes_entitlement_id is not null and status = 'draft'
               group by supersedes_entitlement_id having count(*) > 1) x)
  ) c
 order by c.n;
