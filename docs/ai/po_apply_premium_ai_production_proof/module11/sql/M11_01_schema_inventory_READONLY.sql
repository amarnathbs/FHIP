-- M11_01  READ ONLY  Module 11 schema inventory. Run on production (and on DEV first if you like). It writes nothing.
-- Four blocks, each separated by a line of dashes. Paste ONE block at a time and press Run.
-- Block A: every table, function and column Module 11 needs. Every row must say present = true. A false row names the migration that adds it.
-- Block B: the database objects that make duplicate generation and double charging impossible. Every row must say present = true.
-- Block C: row level security and write policies on the AI tables. Governance tables must have policy_count 0. write_policy_count must be 0 everywhere.
-- Block D: who may run the admission and scheduler functions. The first column group must read false for anon and signed_in.
-- This file was linted for the SQL editor but NOT executed by its author. Evidence label: NOT PERFORMED until you run it.

-- Block A: objects needed
select check_name, added_by, present
  from (
    select 'table ai_model_registry' as check_name, '0110' as added_by, to_regclass('public.ai_model_registry') is not null as present
    union all select 'table ai_prompt_templates', '0110', to_regclass('public.ai_prompt_templates') is not null
    union all select 'table ai_runs', '0110', to_regclass('public.ai_runs') is not null
    union all select 'table ai_usage_ledger', '0110', to_regclass('public.ai_usage_ledger') is not null
    union all select 'table ai_answer_cache (Coach answers and history)', '0110', to_regclass('public.ai_answer_cache') is not null
    union all select 'table ai_insights (stored answers for Standard questions and Explain)', '0110', to_regclass('public.ai_insights') is not null
    union all select 'table ai_feedback', '0110', to_regclass('public.ai_feedback') is not null
    union all select 'table ai_platform_controls (kill switches and ceilings)', '0115', to_regclass('public.ai_platform_controls') is not null
    union all select 'table ai_task_cost_limits', '0115', to_regclass('public.ai_task_cost_limits') is not null
    union all select 'table ai_admission_events', '0115', to_regclass('public.ai_admission_events') is not null
    union all select 'table ai_provider_controls', '0115', to_regclass('public.ai_provider_controls') is not null
    union all select 'table ai_config_audit', '0115', to_regclass('public.ai_config_audit') is not null
    union all select 'table ai_operational_events', '0115', to_regclass('public.ai_operational_events') is not null
    union all select 'table ai_resolution_audit', '0117', to_regclass('public.ai_resolution_audit') is not null
    union all select 'table ai_insight_pack_batches', '0121', to_regclass('public.ai_insight_pack_batches') is not null
    union all select 'table ai_insight_packs', '0121', to_regclass('public.ai_insight_packs') is not null
    union all select 'table ai_insight_pack_blocks', '0121', to_regclass('public.ai_insight_pack_blocks') is not null
    union all select 'table ai_standard_questions', '0124', to_regclass('public.ai_standard_questions') is not null
    union all select 'table ai_contextual_explanation_targets', '0126', to_regclass('public.ai_contextual_explanation_targets') is not null
    union all select 'table ai_insight_pack_scheduler_runs', '0176', to_regclass('public.ai_insight_pack_scheduler_runs') is not null
    union all select 'table ai_insight_pack_scheduler_jobs', '0176', to_regclass('public.ai_insight_pack_scheduler_jobs') is not null
    union all select 'table ai_next_best_action_evaluations', '0178', to_regclass('public.ai_next_best_action_evaluations') is not null
    union all select 'function ai_admit_request', '0115', exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'ai_admit_request')
    union all select 'function ai_finalise_admission', '0115', exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'ai_finalise_admission')
    union all select 'function ai_refund_admission', '0115', exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'ai_refund_admission')
    union all select 'function ai_entitlement_state', '0115', exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'ai_entitlement_state')
    union all select 'function ai_billing_period_for', '0115', exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'ai_billing_period_for')
    union all select 'function ai_insight_pack_scheduler_claim', '0176', exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'ai_insight_pack_scheduler_claim')
    union all select 'function ai_insight_pack_scheduler_release', '0176', exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'ai_insight_pack_scheduler_release')
    union all select 'function is_ai_operations_viewer', '0177', exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'is_ai_operations_viewer')
    union all select 'function is_ai_operations_manager', '0177', exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'is_ai_operations_manager')
    union all select 'column ai_platform_controls.live_provider_enabled', '0115', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ai_platform_controls' and column_name = 'live_provider_enabled')
    union all select 'column ai_platform_controls.batch_generation_enabled', '0115', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ai_platform_controls' and column_name = 'batch_generation_enabled')
    union all select 'column ai_platform_controls.max_output_tokens', '0115', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ai_platform_controls' and column_name = 'max_output_tokens')
    union all select 'column ai_platform_controls.daily_live_ai_cost_limit_usd', '0115', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ai_platform_controls' and column_name = 'daily_live_ai_cost_limit_usd')
    union all select 'column ai_platform_controls.contextual_explanations_enabled', '0126', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ai_platform_controls' and column_name = 'contextual_explanations_enabled')
    union all select 'column ai_platform_controls.scheduler_enabled', '0176', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ai_platform_controls' and column_name = 'scheduler_enabled')
    union all select 'column ai_platform_controls.next_best_action_enabled', '0178', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ai_platform_controls' and column_name = 'next_best_action_enabled')
    union all select 'column ai_insight_packs.admission_id', '0176', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ai_insight_packs' and column_name = 'admission_id')
    union all select 'column ai_resolution_audit.standard_question_code', '0124', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ai_resolution_audit' and column_name = 'standard_question_code')
    union all select 'column admin_users.can_view_ai_operations', '0177', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'admin_users' and column_name = 'can_view_ai_operations')
    union all select 'column admin_users.can_manage_ai_operations', '0177', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'admin_users' and column_name = 'can_manage_ai_operations')
    union all select 'column user_entitlements.effective_from (Premium window)', '0010', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'user_entitlements' and column_name = 'effective_from')
    union all select 'column user_entitlements.effective_to (Premium window)', '0010', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'user_entitlements' and column_name = 'effective_to')
    union all select 'column income_sources.tax_amount (without it every AI answer fails closed)', '0285 on main', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'income_sources' and column_name = 'tax_amount')
  ) t
 order by present, added_by, check_name;
----------------------------------------------------------------------------------------------------

-- Block B: objects that guarantee no duplicate generation and no double charge
select check_name, present
  from (
    select 'unique index on pack identity: one pack per person, snapshot, data hash, schema, prompt version' as check_name,
           exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'uq_ai_insight_packs_identity' and position('UNIQUE' in indexdef) > 0) as present
    union all select 'unique index on admission idempotency key per user (a retried request returns the first verdict)',
           exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'idx_ai_admission_events_idempotency' and position('UNIQUE' in indexdef) > 0)
    union all select 'unique constraint on scheduler job per month and user (a person is picked at most once a month)',
           exists (select 1 from pg_constraint where conname = 'uq_ai_insight_pack_scheduler_jobs_period_subject' and contype = 'u')
    union all select 'unique partial index: only one RUNNING scheduler run per phase',
           exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'uq_ai_insight_pack_scheduler_runs_running' and position('UNIQUE' in indexdef) > 0)
    union all select 'check: a pack admission can never use a custom question',
           exists (select 1 from pg_constraint where conname = 'ai_admission_events_batch_never_consumes')
    union all select 'check: only a live answer can use a custom question',
           exists (select 1 from pg_constraint where conname = 'ai_admission_events_only_live_ai_consumes')
    union all select 'check: a READY pack must carry a passed grounding result',
           exists (select 1 from pg_constraint where conname = 'chk_ai_insight_packs_ready_requires_validation')
    union all select 'unique index: one ACTIVE prompt per prompt code',
           exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'idx_ai_prompt_templates_one_active' and position('UNIQUE' in indexdef) > 0)
  ) t
 order by present, check_name;
----------------------------------------------------------------------------------------------------

-- Block C: row level security and policies on the AI tables
-- Expected: row_security_on true everywhere, write_policy_count 0 everywhere (no signed in user may write), policy_count 0 on governance tables
-- (ai_platform_controls, ai_model_registry, ai_prompt_templates, ai_task_cost_limits, ai_provider_controls, ai_config_audit, ai_operational_events, scheduler tables).
-- On Supabase the privilege columns are usually true for the API roles. That is normal. Row level security with no write policy is what blocks them.
select c.relname as table_name,
       c.relrowsecurity as row_security_on,
       (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policy_count,
       (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname and p.cmd <> 'SELECT') as write_policy_count,
       has_table_privilege('anon', c.oid, 'select') as anon_has_select_privilege,
       has_table_privilege('authenticated', c.oid, 'update') as signed_in_has_update_privilege
  from pg_class c
 where c.relnamespace = 'public'::regnamespace
   and c.relkind = 'r'
   and c.relname in (
     'ai_model_registry', 'ai_prompt_templates', 'ai_runs', 'ai_usage_ledger', 'ai_answer_cache', 'ai_insights', 'ai_feedback',
     'ai_platform_controls', 'ai_task_cost_limits', 'ai_admission_events', 'ai_provider_controls', 'ai_config_audit', 'ai_operational_events',
     'ai_resolution_audit', 'ai_insight_pack_batches', 'ai_insight_packs', 'ai_insight_pack_blocks', 'ai_standard_questions',
     'ai_contextual_explanation_targets', 'ai_insight_pack_scheduler_runs', 'ai_insight_pack_scheduler_jobs', 'ai_next_best_action_evaluations')
 order by c.relname;
----------------------------------------------------------------------------------------------------

-- Block D: who may run the admission and scheduler functions
-- Expected: anon_can_execute and signed_in_can_execute are false for the first six functions. They are for the server only.
select p.proname as function_name,
       has_function_privilege('anon', p.oid, 'execute') as anon_can_execute,
       has_function_privilege('authenticated', p.oid, 'execute') as signed_in_can_execute,
       has_function_privilege('service_role', p.oid, 'execute') as server_can_execute
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and p.proname in ('ai_admit_request', 'ai_finalise_admission', 'ai_refund_admission', 'ai_entitlement_state',
                     'ai_insight_pack_scheduler_claim', 'ai_insight_pack_scheduler_release')
 order by p.proname;
