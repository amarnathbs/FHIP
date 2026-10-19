-- M11_90  WRITE FILE  NOT READ ONLY  Module 11 own stop switches and the way back. Changes DATA in the database. Run ONE block at a time, never the whole file.
-- WHEN TO USE: only when you decide to slow down or stop Module 11. Every stop block takes effect on the next request, with no deploy. Every stop block is reversible.
-- BACKUP FIRST. Production has no managed backups. Run blocks B1 to B5 once, before the first stop block. They save one small row set (controls, model rows, prompt
-- statuses, provider switches) inside the private schema, which the API never serves. The copy is tiny. Drop it later with the last block of this file when things are stable.
-- WHAT THIS FILE NEVER TOUCHES: the cost ceilings, the per user monthly cap, the daily and per request limits, the hourly rate limit, the monthly allowance, the
-- tables and the functions. Those are the spending protection. Never drop or empty ai_platform_controls, ai_task_cost_limits, ai_admission_events, ai_usage_ledger or the
-- function ai_admit_request, and never raise a ceiling to make a problem go away. The ceilings stay in force through every stop and restore below.
-- WHAT DOES NOT CONTROL MODULE 11: the variables AIE_AI_FALLBACK_ENABLED and II_AI_FALLBACK_ENABLED stop the document reading feature, not the Coach, the
-- Insight Pack, Next Best Action, Standard questions or Explain. Do not use them as a Module 11 switch.
-- DO NOT STOP MODULE 11 BY REMOVING THE AMPLIFY VARIABLE MODULE11_AI_PROVIDER. With it unset the built-in mock provider is used and, while a prompt is active, the Coach
-- would answer with the mock text, which looks like an AI answer and is not one. Use the switch blocks here instead.
-- After any block, run M11_02 block 1 (read only) and keep the result with the date and the reason.
-- This file was linted for the SQL editor but NOT executed by its author. Evidence label: NOT PERFORMED. Rehearse every block on DEV first (project vqycarelcoijzwlpkpcz).

-- B1: private schema for the backup copy
create schema if not exists private;
----------------------------------------------------------------------------------------------------

-- B2: the backup copy (one row). If this fails because the table already exists, an earlier copy is still there. Keep it, or run the final block first.
create table private.bkp_m11proof_state as
select now() as taken_at,
       (select to_jsonb(c) from public.ai_platform_controls c where c.id = 'global') as controls,
       (select coalesce(jsonb_agg(to_jsonb(m)), '[]'::jsonb) from public.ai_model_registry m) as models,
       (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'prompt_code', p.prompt_code, 'version', p.version, 'status', p.status)), '[]'::jsonb) from public.ai_prompt_templates p) as prompts,
       (select coalesce(jsonb_agg(to_jsonb(pc)), '[]'::jsonb) from public.ai_provider_controls pc) as providers;
----------------------------------------------------------------------------------------------------

-- B3: row level security on the copy
alter table private.bkp_m11proof_state enable row level security;
----------------------------------------------------------------------------------------------------

-- B4: no API privilege on the copy
revoke all on private.bkp_m11proof_state from public, anon, authenticated;
----------------------------------------------------------------------------------------------------

-- B5: check the copy. controls_saved must be true and the counts must be above 0.
select to_char(b.taken_at at time zone 'utc', 'DD/MM/YYYY HH24:MI') as taken_at_utc,
       (b.controls is not null) as controls_saved,
       jsonb_array_length(b.models) as model_rows_saved,
       jsonb_array_length(b.prompts) as prompt_rows_saved,
       jsonb_array_length(b.providers) as provider_rows_saved
  from private.bkp_m11proof_state b;
----------------------------------------------------------------------------------------------------

-- STOP 1 EVERYTHING GOVERNED: ai_globally_enabled false. Stops the Coach, Insight Packs, Explain, Next Best Action and Standard questions at once. No OpenAI call is possible.
update public.ai_platform_controls
   set ai_globally_enabled = false,
       kill_switch_reason = 'Switched off by the Product Owner in the SQL editor: global',
       updated_at = now()
 where id = 'global';
----------------------------------------------------------------------------------------------------

-- STOP 2 PAID CALLS ONLY: live_provider_enabled false. Stops every request that would reach OpenAI (Coach questions and pack generation). Rule based features keep working:
-- Next Best Action, rule based Standard questions, stored answers already written, Explain over stored answers. This is the narrowest way to stop spending.
update public.ai_platform_controls
   set live_provider_enabled = false,
       kill_switch_reason = 'Switched off by the Product Owner in the SQL editor: live provider',
       updated_at = now()
 where id = 'global';
----------------------------------------------------------------------------------------------------

-- STOP 3 TYPED QUESTIONS: custom_ai_enabled false. WARNING, found by reading the code and not tested on a real account: the entitlement function ai_entitlement_state also reports
-- not eligible (ai_temporarily_disabled) while this is false, and Standard questions, Explain, Next Best Action and the scheduler all ask that function. So this switch is
-- NOT as narrow as the branch pack file off_coach.sql says: expect those features to show their gated state for Premium users too. Rehearse on DEV before relying on it.
update public.ai_platform_controls
   set custom_ai_enabled = false,
       kill_switch_reason = 'Switched off by the Product Owner in the SQL editor: typed questions',
       updated_at = now()
 where id = 'global';
----------------------------------------------------------------------------------------------------

-- STOP 4 PACK GENERATION: batch_generation_enabled false. Stops every Insight Pack generation (scheduled and admin triggered). The Coach is not affected.
update public.ai_platform_controls
   set batch_generation_enabled = false,
       kill_switch_reason = 'Switched off by the Product Owner in the SQL editor: pack generation',
       updated_at = now()
 where id = 'global';
----------------------------------------------------------------------------------------------------

-- STOP 5 UNATTENDED MONTHLY RUN: scheduler_enabled false. Stops only the cron triggered run. Packs already submitted are still collected. Admin triggered runs are still possible.
update public.ai_platform_controls
   set scheduler_enabled = false,
       kill_switch_reason = 'Switched off by the Product Owner in the SQL editor: scheduler',
       updated_at = now()
 where id = 'global';
----------------------------------------------------------------------------------------------------

-- STOP 6 NEXT BEST ACTION: next_best_action_enabled false. Stops Next Best Action and the two Standard questions that read it. Free of cost either way.
update public.ai_platform_controls
   set next_best_action_enabled = false,
       kill_switch_reason = 'Switched off by the Product Owner in the SQL editor: next best action',
       updated_at = now()
 where id = 'global';
----------------------------------------------------------------------------------------------------

-- STOP 7 EXPLAIN BUTTONS: contextual_explanations_enabled false. Stops the Explain and Why buttons. Standard questions keep working.
update public.ai_platform_controls
   set contextual_explanations_enabled = false,
       kill_switch_reason = 'Switched off by the Product Owner in the SQL editor: explain',
       updated_at = now()
 where id = 'global';
----------------------------------------------------------------------------------------------------

-- STOP 8 THE OPENAI PROVIDER: ai_provider_controls enabled false for openai. Every OpenAI bound request is refused as provider unavailable. Independent of the model row.
update public.ai_provider_controls
   set enabled = false,
       disabled_reason = 'Switched off by the Product Owner in the SQL editor: openai provider',
       updated_at = now()
 where provider = 'openai';
----------------------------------------------------------------------------------------------------

-- STOP 9 THE MODEL: active false on the OpenAI model row. Coach and pack requests then fail closed (no approved model) before any provider call.
update public.ai_model_registry
   set active = false,
       updated_at = now()
 where provider = 'openai' and model_identifier = 'gpt-4o-mini';
----------------------------------------------------------------------------------------------------

-- PROMPTS: to withdraw or roll back the Coach and Insight Pack prompts use the branch pack files 80, 81 and 82 under docs/ai/po_apply_module11_production/sql/ on branch
-- integration/module11-0-to-11-7-20261014 (they are not copied here so that there is one source). Switch blocks above are the faster first move.

-- RESTORE 1 SWITCHES: put every Module 11 switch back to the value saved in the copy. Ceilings and limits are not touched.
update public.ai_platform_controls c
   set ai_globally_enabled = (b.controls ->> 'ai_globally_enabled')::boolean,
       custom_ai_enabled = (b.controls ->> 'custom_ai_enabled')::boolean,
       live_provider_enabled = (b.controls ->> 'live_provider_enabled')::boolean,
       batch_generation_enabled = (b.controls ->> 'batch_generation_enabled')::boolean,
       scheduler_enabled = (b.controls ->> 'scheduler_enabled')::boolean,
       next_best_action_enabled = (b.controls ->> 'next_best_action_enabled')::boolean,
       contextual_explanations_enabled = (b.controls ->> 'contextual_explanations_enabled')::boolean,
       kill_switch_reason = b.controls ->> 'kill_switch_reason',
       updated_at = now()
  from private.bkp_m11proof_state b
 where c.id = 'global';
----------------------------------------------------------------------------------------------------

-- RESTORE 2 MODEL ROWS: put active and approved back to the values saved in the copy
update public.ai_model_registry m
   set active = (x.j ->> 'active')::boolean,
       approved = (x.j ->> 'approved')::boolean,
       updated_at = now()
  from (select jsonb_array_elements(b.models) as j from private.bkp_m11proof_state b) x
 where m.id = (x.j ->> 'id')::uuid;
----------------------------------------------------------------------------------------------------

-- RESTORE 3 PROVIDER SWITCHES: put enabled back to the values saved in the copy
update public.ai_provider_controls pc
   set enabled = (x.j ->> 'enabled')::boolean,
       disabled_reason = x.j ->> 'disabled_reason',
       updated_at = now()
  from (select jsonb_array_elements(b.providers) as j from private.bkp_m11proof_state b) x
 where pc.provider = x.j ->> 'provider';
----------------------------------------------------------------------------------------------------

-- CLEAN UP: drop the copy once Module 11 has been stable for some days. The database is over its plan size, so do not keep copies forever.
drop table private.bkp_m11proof_state;
