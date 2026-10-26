-- V3. VERIFY after 0298, 0299 and 0304 (READ ONLY, one select). Every row must say ok = true. If one is false, stop and send the output.

select 'the retirement declaration guard functions exist' as check_name,
       (select count(*) = 3 from pg_proc where proname in ('fhip_retirement_declaration_blockers', 'fhip_guard_retirement_declaration_profile', 'fhip_guard_retirement_declaration_section')) as ok
union all
select 'the two declaration triggers exist and are enabled',
       (select count(*) = 2 from pg_trigger where tgname in ('trg_guard_retirement_declaration_profile', 'trg_guard_retirement_declaration_section') and tgenabled <> 'D')
union all
select 'the company undo function exists', exists (select 1 from pg_proc where proname = 'business_entity_undo_last_switch')
union all
select 'the company undo function is not callable by anon',
       not has_function_privilege('anon', 'business_entity_undo_last_switch(uuid, boolean)', 'execute')
union all
select 'the company undo function is callable by signed in users',
       has_function_privilege('authenticated', 'business_entity_undo_last_switch(uuid, boolean)', 'execute')
union all
select 'retirement_contributions exists with row level security',
       coalesce((select relrowsecurity from pg_class where relname = 'retirement_contributions' and relkind = 'r'), false)
union all
select 'retirement_contributions has its owner policy',
       exists (select 1 from pg_policies where tablename = 'retirement_contributions' and policyname = 'own rows - retirement_contributions')
union all
select 'one row per payslip and contribution type is enforced',
       exists (select 1 from pg_indexes where indexname = 'uq_retirement_contributions_payslip')
union all
select 'the destination validation trigger exists',
       exists (select 1 from pg_trigger where tgname = 'trg_retirement_contributions_validate')
union all
select 'retirement_contributions has the expected columns',
       (select count(*) = 8 from information_schema.columns
        where table_name = 'retirement_contributions'
          and column_name in ('retirement_account_id', 'destination_kind', 'contribution_type', 'amount', 'source_type', 'source_payroll_event_id', 'status', 'is_active'))
order by 1;
