-- V1. VERIFY after the 0289 and 0290 parts (READ ONLY, one select). Every row must say ok = true. If one is false, stop and send the output.

select 'smsf_liabilities exists with row level security' as check_name,
       coalesce((select relrowsecurity from pg_class where relname = 'smsf_liabilities' and relkind = 'r'), false) as ok
union all
select 'entity_figure_mode_log exists with row level security',
       coalesce((select relrowsecurity from pg_class where relname = 'entity_figure_mode_log' and relkind = 'r'), false)
union all
select 'the fund net function exists', exists (select 1 from pg_proc where proname = 'smsf_fund_counted_net')
union all
select 'the data quality function exists', exists (select 1 from pg_proc where proname = 'smsf_mode_rule_violations')
union all
select 'the five fund switch functions exist',
       (select count(*) = 5 from pg_proc where proname in ('smsf_entity_switch_mode', 'smsf_entity_undo_last_switch', 'smsf_entity_retire_typed_net', 'smsf_entity_move_linked_loan', 'smsf_entity_adopt_register_rows'))
union all
select 'the three either-or rule triggers exist and are enabled',
       (select count(*) = 3 from pg_trigger where tgname in ('trg_smsf_funds_mode_rule', 'trg_smsf_holdings_mode_rule', 'trg_smsf_liabilities_mode_rule') and tgenabled <> 'D')
union all
select 'the recompute trigger on smsf_liabilities exists', exists (select 1 from pg_trigger where tgname = 'trg_smsf_liabilities_recompute')
union all
select 'the history table cannot be rewritten (append-only trigger)', exists (select 1 from pg_trigger where tgname = 'trg_entity_figure_mode_log_no_update')
union all
select 'the switch function is not callable by anon',
       not has_function_privilege('anon', 'smsf_entity_switch_mode(uuid, text, jsonb, jsonb, numeric, date, boolean)', 'execute')
union all
select 'the switch function is callable by signed in users',
       has_function_privilege('authenticated', 'smsf_entity_switch_mode(uuid, text, jsonb, jsonb, numeric, date, boolean)', 'execute')
union all
select 'smsf_create_fund has the new eight argument form only',
       (select count(*) = 1 from pg_proc where proname = 'smsf_create_fund')
order by 1;
