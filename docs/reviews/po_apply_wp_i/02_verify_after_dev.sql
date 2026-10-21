-- WP-I step 3 (DEV ONLY, read only). Run after 0298 and 0299 were applied on DEV.

-- 3a. objects present (expected: all true)
select to_regprocedure('public.fhip_retirement_declaration_blockers(uuid)') is not null as blockers_function,
       to_regprocedure('public.fhip_guard_retirement_declaration_profile()') is not null as profile_guard_function,
       to_regprocedure('public.fhip_guard_retirement_declaration_section()') is not null as section_guard_function,
       to_regprocedure('public.business_entity_undo_last_switch(uuid,boolean)') is not null as undo_function;

-- 3b. the two triggers exist and are enabled (expected: two rows, tgenabled O)
select tgname, tgenabled from pg_trigger
 where tgname in ('trg_guard_retirement_declaration_profile', 'trg_guard_retirement_declaration_section') order by tgname;

-- 3c. the undo function is executable by signed in people only (expected: authenticated true, anon false)
select has_function_privilege('authenticated', 'public.business_entity_undo_last_switch(uuid,boolean)', 'execute') as authenticated_can_run,
       has_function_privilege('anon', 'public.business_entity_undo_last_switch(uuid,boolean)', 'execute') as anon_can_run;
