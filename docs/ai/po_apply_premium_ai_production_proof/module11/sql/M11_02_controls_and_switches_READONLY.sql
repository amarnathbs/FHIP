-- M11_02  READ ONLY  Module 11 kill switches, ceilings, model and prompt state. Writes nothing. Shows no credential (none is stored in the database).
-- Paste ONE block at a time. Keep every result: block 1 is your before picture for any change you make later.
-- Block 1: every key of the platform controls row, switches and ceilings, as text.
-- Block 2: one row that answers: can the Coach answer, can a pack be generated, which features are switched on. It cannot see the Amplify variables.
-- Block 3: model registry. Block 4: prompts with a short text hash. Block 5: provider switches. Block 6: per task cost limits.
-- Block 7: how many Standard questions and Explain targets are enabled. Block 8: the 15 newest configuration changes.
-- This file was linted for the SQL editor but NOT executed by its author. Evidence label: NOT PERFORMED until you run it.

-- Block 1: all platform control keys
select e.key as setting, e.value as current_value
  from ai_platform_controls c, jsonb_each_text(to_jsonb(c)) as e
 where c.id = 'global'
   and e.key <> 'updated_by'
 order by e.key;
----------------------------------------------------------------------------------------------------

-- Block 2: feature readiness as the database sees it (the Amplify variables are checked by the provider health call, not here)
select c.ai_globally_enabled as global_on,
       c.custom_ai_enabled as typed_questions_on,
       c.live_provider_enabled as live_provider_on,
       c.batch_generation_enabled as pack_generation_on,
       c.scheduler_enabled as scheduler_on,
       c.next_best_action_enabled as next_best_action_on,
       c.contextual_explanations_enabled as explain_on,
       exists (select 1 from ai_model_registry m where m.provider = 'openai' and m.active and m.approved and 'general_coach' = any (m.task_types)) as openai_coach_model_ready,
       exists (select 1 from ai_model_registry m where m.provider = 'openai' and m.active and m.approved and 'monthly_insight_pack' = any (m.task_types)) as openai_pack_model_ready,
       exists (select 1 from ai_model_registry m where m.provider = 'mock' and m.active and m.approved and 'general_coach' = any (m.task_types)) as mock_coach_model_still_active,
       exists (select 1 from ai_prompt_templates p where p.prompt_code = 'PR-AI-010' and p.status = 'ACTIVE') as coach_prompt_active,
       exists (select 1 from ai_prompt_templates p where p.prompt_code = 'PR-AI-013' and p.status = 'ACTIVE') as pack_prompt_active,
       coalesce((select pc.enabled from ai_provider_controls pc where pc.provider = 'openai'), true) as openai_provider_enabled,
       (c.max_output_tokens >= 3000) as output_budget_fits_a_pack,
       c.max_output_tokens
  from ai_platform_controls c
 where c.id = 'global';
----------------------------------------------------------------------------------------------------

-- Block 3: model registry
select m.provider, m.model_identifier, m.internal_tier, m.active, m.approved,
       array_to_string(m.task_types, ',') as task_types,
       m.max_input_tokens, m.max_output_tokens,
       m.cost_input_per_1k_usd, m.cost_output_per_1k_usd,
       to_char(m.approved_at at time zone 'utc', 'DD/MM/YYYY HH24:MI') as approved_at_utc
  from ai_model_registry m
 order by m.provider, m.model_identifier;
----------------------------------------------------------------------------------------------------

-- Block 4: prompts. PR-AI-010 is the Coach, PR-AI-013 is the monthly Insight Pack. Exactly one ACTIVE row per code is expected once live.
select p.prompt_code, p.version, p.status, p.task_type,
       left(md5(p.system_prompt || p.developer_prompt), 8) as text_hash8,
       to_char(p.updated_at at time zone 'utc', 'DD/MM/YYYY HH24:MI') as updated_at_utc
  from ai_prompt_templates p
 order by p.prompt_code, p.version;
----------------------------------------------------------------------------------------------------

-- Block 5: provider switches
select pc.provider, pc.enabled, pc.monthly_cost_limit_usd, pc.disabled_reason,
       to_char(pc.updated_at at time zone 'utc', 'DD/MM/YYYY HH24:MI') as updated_at_utc
  from ai_provider_controls pc
 order by pc.provider;
----------------------------------------------------------------------------------------------------

-- Block 6: per task cost limits
select l.task_type, l.model_identifier, l.max_cost_per_request_usd, l.max_internal_tier, l.max_monthly_cost_usd, l.active
  from ai_task_cost_limits l
 order by l.task_type, l.model_identifier nulls first;
----------------------------------------------------------------------------------------------------

-- Block 7: content catalogues
select (select count(*) from ai_standard_questions) as standard_questions_total,
       (select count(*) from ai_standard_questions q where q.enabled) as standard_questions_enabled,
       (select count(*) from ai_contextual_explanation_targets t) as explain_targets_total,
       (select count(*) from ai_contextual_explanation_targets t where t.enabled) as explain_targets_enabled;
----------------------------------------------------------------------------------------------------

-- Block 8: the 15 newest configuration changes (the user column is left out on purpose, the SQL editor has no app user)
select to_char(a.changed_at at time zone 'utc', 'DD/MM/YYYY HH24:MI') as changed_at_utc,
       a.config_table, a.field, left(a.previous_value, 60) as previous_value, left(a.new_value, 60) as new_value, a.operation, left(a.reason, 80) as reason
  from ai_config_audit a
 order by a.changed_at desc
 limit 15;
