-- PRODUCTION precheck for migration 0280. Read-only: it changes nothing. Run it on PRODUCTION before applying 0280.
-- Every row must show PASS. If any row shows FAIL, do not apply 0280 and send me the rows.
-- The results column called actual says what is really there. Row 8 expects the two approved records you told me about.
select c.n, c.check_name, c.expected, c.actual, case when c.expected = c.actual then 'PASS' else 'FAIL' end as result
  from (
    select 1 as n, 'the entitlement table exists' as check_name, 'true' as expected,
           (to_regclass('public.ii_benchmark_entitlements') is not null)::text as actual
    union all
    select 2, 'the table has exactly the 34 columns of migration 0241 (before 0280)', '34',
           (select count(*)::text from information_schema.columns where table_schema = 'public' and table_name = 'ii_benchmark_entitlements')
    union all
    select 3, 'none of the six 0280 columns exists yet', '0',
           (select count(*)::text from information_schema.columns
             where table_schema = 'public' and table_name = 'ii_benchmark_entitlements'
               and column_name in ('supersedes_entitlement_id', 'superseded_by', 'superseded_at', 'revision_reason', 'edit_count', 'last_edited_at'))
    union all
    select 4, 'none of the 0280 checks or indexes exists yet', '0',
           ((select count(*) from pg_constraint
              where conrelid = to_regclass('public.ii_benchmark_entitlements')
                and conname in ('ii_benchmark_entitlements_superseded_pair', 'ii_benchmark_entitlements_superseded_is_closed', 'ii_benchmark_entitlements_revision_reason', 'ii_benchmark_entitlements_no_self_link'))
           + (select count(*) from pg_indexes
               where tablename = 'ii_benchmark_entitlements'
                 and indexname in ('uq_ii_benchmark_entitlements_one_open_revision', 'uq_ii_benchmark_entitlements_superseded_by', 'idx_ii_benchmark_entitlements_supersedes')))::text
    union all
    select 5, 'none of the five new 0280 functions exists yet', '0',
           (select count(*)::text from pg_proc
             where pronamespace = 'public'::regnamespace
               and proname in ('update_benchmark_entitlement_draft', 'propose_benchmark_entitlement_revision', 'close_benchmark_entitlement_revision', 'ii_bm_entitlement_editable', 'ii_bm_entitlement_normalise'))
    union all
    select 6, 'exactly one approve function exists and it has the three older arguments', '1 with 3 arguments',
           (select count(*)::text || ' with ' || coalesce(max(pronargs)::text, '0') || ' arguments' from pg_proc
             where pronamespace = 'public'::regnamespace and proname = 'approve_benchmark_entitlement')
    union all
    select 7, 'the revoke function exists with its two arguments and the audit helper and the two capability checks exist', '4',
           (select (case when to_regprocedure('public.revoke_benchmark_entitlement(uuid,text)') is null then 0 else 1 end
                  + case when to_regprocedure('public.ii_bm_log_event(text,text,uuid,jsonb,jsonb,text)') is null then 0 else 1 end
                  + case when to_regprocedure('public.is_benchmark_catalogue_admin()') is null then 0 else 1 end
                  + case when to_regprocedure('public.is_benchmark_entitlement_approver()') is null then 0 else 1 end)::text)
    union all
    select 8, 'the number of approved entitlement records is the two you told me about', '2',
           (select count(*)::text from public.ii_benchmark_entitlements where status = 'approved')
    union all
    select 9, 'every record is draft, approved or revoked (nothing else can exist yet)', '0',
           (select count(*)::text from public.ii_benchmark_entitlements where status not in ('draft', 'approved', 'revoked'))
    union all
    select 10, 'the append-only audit log exists', 'true',
           (to_regclass('public.ii_benchmark_governance_events') is not null)::text
  ) c
 order by c.n;
