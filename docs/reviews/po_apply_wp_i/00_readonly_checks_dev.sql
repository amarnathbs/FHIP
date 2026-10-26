-- WP-I step 1 (DEV ONLY, read only). Check the project reference in the address bar first: DEV is vqycarelcoijzwlpkpcz.
-- Production (twwpnltizhtjxhamyoxt) is never touched by this pack.

-- 1a. the earlier migrations this pack builds on are applied (expected: all true)
select to_regclass('public.entity_figure_mode_log') is not null as mode_log_0290_ok,
       to_regprocedure('public.business_entity_switch_mode(uuid,text,jsonb,jsonb,numeric,boolean)') is not null as switch_0297_ok,
       to_regprocedure('public.business_entity_derived_net(uuid)') is not null as derived_net_0297_ok,
       to_regclass('public.smsf_funds') is not null as smsf_funds_ok;

-- 1b. the new objects must NOT exist yet (expected: all false)
select to_regprocedure('public.fhip_retirement_declaration_blockers(uuid)') is not null as declaration_function_present,
       to_regprocedure('public.business_entity_undo_last_switch(uuid,boolean)') is not null as undo_function_present;

-- 1c. existing contradictions that 0298 will NOT touch (it only checks the moment a declaration becomes true).
--     Each row is a person who ticked I do not have any retirement savings and still has an active retirement account or SMSF.
--     Counts only, no names.
select count(*) as people_with_declaration_and_active_items
  from public.user_profiles p
 where p.not_applicable_retirement = true
   and (exists (select 1 from public.retirement_accounts a where a.user_id = p.user_id and a.is_active is not false and a.master_item_key is distinct from 'smsf')
        or exists (select 1 from public.smsf_funds f where f.user_id = p.user_id and f.is_active is not false));

-- 1d. entities whose newest history row is a switch (these are the ones the new Undo button can act on)
select count(*) as entities_with_undoable_switch
  from public.business_entities e
 where e.is_active
   and (select l.action from public.entity_figure_mode_log l where l.entity_id = e.id order by l.created_at desc, l.id desc limit 1) in ('to_itemised', 'to_net_only');
