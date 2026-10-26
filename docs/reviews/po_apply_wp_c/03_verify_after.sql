-- WP-C verification, read only. Run after migrations 0295, 0296 and 0297. Every row must say ok = true.

select 'smsf_liabilities has the canonical columns' as check_name,
       (select count(*) = 6 from information_schema.columns
        where table_name = 'smsf_liabilities'
          and column_name in ('interest_rate_type', 'fixed_rate_expiry', 'masked_identifier', 'due_date', 'smsf_holding_id', 'source_type')) as ok
union all
select 'smsf_liabilities masked identifier rule exists',
       exists (select 1 from pg_constraint where conname = 'chk_smsf_liabilities_masked_identifier')
union all
select 'smsf_liabilities property link trigger exists',
       exists (select 1 from pg_trigger where tgname = 'trg_smsf_liabilities_holding_link')
union all
select 'entity_income_items exists with row level security',
       coalesce((select relrowsecurity from pg_class where relname = 'entity_income_items' and relkind = 'r'), false)
union all
select 'entity_expense_items exists with row level security',
       coalesce((select relrowsecurity from pg_class where relname = 'entity_expense_items' and relkind = 'r'), false)
union all
select 'entity_change_log exists with row level security',
       coalesce((select relrowsecurity from pg_class where relname = 'entity_change_log' and relkind = 'r'), false)
union all
select 'one active rent record per property is enforced',
       exists (select 1 from pg_indexes where indexname = 'uq_entity_income_rent_per_smsf_asset')
union all
select 'there is no loan repayment expense type',
       not exists (select 1 from pg_constraint c
                   where c.conrelid = 'entity_expense_items'::regclass and c.contype = 'c'
                     and position('loan' in lower(pg_get_constraintdef(c.oid))) > 0)
union all
select 'move function exists and is not callable by anon',
       exists (select 1 from pg_proc where proname = 'smsf_entity_move_personal_cash_flow')
       and not has_function_privilege('anon', 'smsf_entity_move_personal_cash_flow(uuid, text, uuid, boolean)', 'execute')
union all
select 'business entity lines have the new columns',
       (select count(*) = 13 from information_schema.columns
        where (table_name = 'business_entity_assets' and column_name in ('asset_type', 'as_at_date', 'country_code', 'source_type', 'is_active'))
           or (table_name = 'business_entity_liabilities' and column_name in ('liability_type', 'lender', 'interest_rate', 'monthly_repayment', 'as_at_date', 'country_code', 'source_type', 'is_active')))
union all
select 'business entity mode rule triggers exist',
       (select count(*) = 3 from pg_trigger
        where tgname in ('trg_business_entities_mode_rule', 'trg_business_entity_assets_mode_rule', 'trg_business_entity_liabilities_mode_rule'))
union all
select 'business entity switch function exists and is not callable by anon',
       exists (select 1 from pg_proc where proname = 'business_entity_switch_mode')
       and not has_function_privilege('anon', 'business_entity_switch_mode(uuid, text, jsonb, jsonb, numeric, boolean)', 'execute')
union all
select 'audit triggers exist on every entity line table',
       (select count(*) = 6 from pg_trigger
        where tgname in ('trg_entity_income_audit', 'trg_entity_expense_audit', 'trg_business_entity_assets_audit', 'trg_business_entity_liabilities_audit', 'trg_smsf_holdings_audit', 'trg_smsf_liabilities_audit'))
order by 1;
