-- M11_08  READ ONLY  One test account, before and after each browser step. Writes nothing.
-- In EVERY block below, replace PASTE-TEST-ACCOUNT-ADDRESS with the address of the proof account you are testing (lower case is fine). The address stays in your editor.
-- Results show counts, states, 8 character ids and dates only: no question text, no answer text, no address.
-- Block 1 is the before and after snapshot. Nine blocks in all. Compare the numbers around each journey step, as README.md says.
-- Block 2: newest provider runs. Block 3: newest admission decisions. Block 4: newest packs. Block 5: the stored answer for each explanation intent
-- (this is the check that a Standard question or Explain has useful content to show). Block 6: Coach answers kept in history. Block 7: Next Best Action checks.
-- Block 8: Standard question and Explain outcomes for this account over the last 7 days. Block 9 follows: the monthly scheduler jobs for this account.
-- This file was linted for the SQL editor but NOT executed by its author. Evidence label: NOT PERFORMED until you run it.

-- Block 1: snapshot (run before and after a step and compare)
with p as (select u.id as uid from auth.users u where lower(u.email) = lower('PASTE-TEST-ACCOUNT-ADDRESS') limit 1)
select (select count(*) from p) as account_found,
       (select e.plan_tier from user_entitlements e, p where e.user_id = p.uid) as plan_tier,
       to_char((select e.effective_from from user_entitlements e, p where e.user_id = p.uid), 'DD/MM/YYYY') as premium_from,
       to_char((select e.effective_to from user_entitlements e, p where e.user_id = p.uid), 'DD/MM/YYYY') as premium_to,
       (select ai_entitlement_state(p.uid) ->> 'eligible' from p) as entitlement_eligible,
       (select ai_entitlement_state(p.uid) ->> 'reason' from p) as entitlement_reason,
       (select ai_entitlement_state(p.uid) -> 'custom_questions' ->> 'used' from p) as quota_used,
       (select ai_entitlement_state(p.uid) -> 'custom_questions' ->> 'remaining' from p) as quota_remaining,
       (select count(*) from ai_runs r, p where r.user_id = p.uid and r.provider = 'openai') as openai_runs,
       (select count(*) from ai_runs r, p where r.user_id = p.uid and r.provider = 'openai' and r.request_type = 'general_coach') as openai_coach_runs,
       (select count(*) from ai_runs r, p where r.user_id = p.uid and r.provider = 'openai' and r.request_type = 'monthly_insight_pack') as openai_pack_runs,
       (select coalesce(sum(l.live_call_count), 0) from ai_usage_ledger l, p where l.user_id = p.uid) as ledger_live_calls,
       (select round(coalesce(sum(l.estimated_cost_usd), 0), 6) from ai_usage_ledger l, p where l.user_id = p.uid) as ledger_estimated_usd_all_time,
       (select count(*) from ai_admission_events a, p where a.user_id = p.uid and a.decision = 'allowed' and a.quota_consumed and a.refunded_at is null) as admissions_that_used_a_custom_question,
       (select count(*) from ai_admission_events a, p where a.user_id = p.uid and a.decision = 'denied') as admissions_refused,
       (select count(*) from ai_insight_packs k, p where k.user_id = p.uid and k.status in ('READY', 'PARTIAL')) as ready_or_partial_packs,
       (select count(*) from ai_insights i, p where i.user_id = p.uid and i.source_engine = 'ai_insight_pack_service' and i.future_ai_explanation is not null) as stored_answers,
       (select count(*) from ai_answer_cache c, p where c.user_id = p.uid and c.intent_code = 'COACH_FREE_TEXT') as coach_answers_in_history,
       (select count(*) from ai_next_best_action_evaluations n, p where n.user_id = p.uid) as next_best_action_evaluations,
       to_char(now() at time zone 'utc', 'DD/MM/YYYY HH24:MI:SS') as read_at_utc;
----------------------------------------------------------------------------------------------------

-- Block 2: the 10 newest provider runs for this account
with p as (select u.id as uid from auth.users u where lower(u.email) = lower('PASTE-TEST-ACCOUNT-ADDRESS') limit 1)
select left(r.id::text, 8) as run_id8,
       to_char(r.created_at at time zone 'utc', 'DD/MM/YYYY HH24:MI:SS') as at_utc,
       r.request_type, r.provider, r.model, r.prompt_version, r.execution_status, r.grounding_status, r.error_code,
       r.input_token_count, r.output_token_count, r.estimated_cost_usd
  from ai_runs r, p
 where r.user_id = p.uid
 order by r.created_at desc
 limit 10;
----------------------------------------------------------------------------------------------------

-- Block 3: the 15 newest admission decisions for this account (every Coach question and every pack passes here)
with p as (select u.id as uid from auth.users u where lower(u.email) = lower('PASTE-TEST-ACCOUNT-ADDRESS') limit 1)
select left(a.id::text, 8) as admission_id8,
       to_char(a.created_at at time zone 'utc', 'DD/MM/YYYY HH24:MI:SS') as at_utc,
       a.task_type, a.usage_outcome, a.decision, coalesce(a.deny_reason, 'none') as deny_reason,
       a.quota_consumed, a.refunded_at is not null as refunded, a.execution_state, a.estimated_cost_usd,
       left(coalesce(a.idempotency_key, ''), 13) as key_kind
  from ai_admission_events a, p
 where a.user_id = p.uid
 order by a.created_at desc
 limit 15;
----------------------------------------------------------------------------------------------------

-- Block 4: the 5 newest packs for this account
with p as (select u.id as uid from auth.users u where lower(u.email) = lower('PASTE-TEST-ACCOUNT-ADDRESS') limit 1)
select left(k.id::text, 8) as pack_id8,
       to_char(k.created_at at time zone 'utc', 'DD/MM/YYYY HH24:MI') as created_utc,
       k.status, k.grounding_status, k.prompt_code, k.prompt_version, k.provider, k.model, k.failure_code, k.estimated_cost_usd,
       (select count(*) from ai_insight_pack_blocks b where b.pack_id = k.id and b.status = 'GROUNDED') as grounded_blocks,
       (select count(*) from ai_insight_pack_blocks b where b.pack_id = k.id) as all_blocks
  from ai_insight_packs k, p
 where k.user_id = p.uid
 order by k.created_at desc
 limit 5;
----------------------------------------------------------------------------------------------------

-- Block 5: useful content check. One row per explanation intent: is there a stored answer, how long, can the code serve it.
-- verdict missing: nothing stored, so a question that needs it shows the being-prepared placeholder.
-- verdict cannot be served by code: the row carries a number but the code has no live figure to compare it with (see README, finding 5).
-- verdict can be served if the figure is unchanged: shown when nothing it was built on has moved since the pack was made.
-- Correct only if the account holds the data that intent covers: an intent about a domain the account has no data in is not a failure.
with p as (select u.id as uid from auth.users u where lower(u.email) = lower('PASTE-TEST-ACCOUNT-ADDRESS') limit 1),
intents(intent_code, live_comparison_in_code) as (
  values ('SCORE_EXPLANATION', true), ('OVERALL_FINANCIAL_SUMMARY_EXPLANATION', false), ('STRENGTHS_EXPLANATION', false),
         ('PRIORITY_REVIEW_AREAS_EXPLANATION', false), ('SCORE_CHANGE_EXPLANATION', false), ('CASH_FLOW_EXPLANATION', true),
         ('SAVINGS_EXPLANATION', true), ('EXPENSE_EXPLANATION', false), ('NET_WORTH_EXPLANATION', true),
         ('ASSET_CONCENTRATION_EXPLANATION', true), ('LIQUIDITY_EXPLANATION', true), ('DEBT_EXPLANATION', true),
         ('INVESTMENT_EXPLANATION', true), ('RETIREMENT_EXPLANATION', true), ('INSURANCE_EXPLANATION', false),
         ('GOAL_RISK_EXPLANATION', false), ('FORECAST_SUMMARY_EXPLANATION', false), ('TWIN_SUMMARY_EXPLANATION', false),
         ('CROSS_BORDER_SUMMARY_EXPLANATION', false), ('DATA_QUALITY_SUMMARY_EXPLANATION', false), ('REPORT_READING_EXPLANATION', false)
)
select t.intent_code,
       t.live_comparison_in_code,
       s.id is not null as stored_row_present,
       left(s.id::text, 8) as row_id8,
       coalesce(length(s.future_ai_explanation), 0) as text_chars,
       s.current_value is not null as row_has_number,
       case
         when s.id is null then 'missing'
         when s.current_value is null or t.live_comparison_in_code then 'can be served if the figure is unchanged'
         else 'cannot be served by code'
       end as verdict,
       to_char(s.created_at at time zone 'utc', 'DD/MM/YYYY HH24:MI') as written_utc
  from intents t
  left join lateral (
    select i.id, i.future_ai_explanation, i.current_value, i.created_at
      from ai_insights i, p
     where i.user_id = p.uid and i.metric_code = t.intent_code and i.future_ai_explanation is not null
     order by i.created_at desc
     limit 1) s on true
 order by t.intent_code;
----------------------------------------------------------------------------------------------------

-- Block 6: Coach answers kept in history (question text is NOT shown). question_id8 is the id the browser response carries as question_id.
with p as (select u.id as uid from auth.users u where lower(u.email) = lower('PASTE-TEST-ACCOUNT-ADDRESS') limit 1)
select left(coalesce(c.answer_json ->> 'question_id', ''), 8) as question_id8,
       to_char(c.created_at at time zone 'utc', 'DD/MM/YYYY HH24:MI:SS') as created_utc,
       c.prompt_version, c.model_version,
       left(coalesce(c.answer_json ->> 'ai_run_id', ''), 8) as ai_run_id8,
       jsonb_typeof(c.answer_json -> 'answer') as answer_is_object
  from ai_answer_cache c, p
 where c.user_id = p.uid and c.intent_code = 'COACH_FREE_TEXT'
 order by c.created_at desc
 limit 10;
----------------------------------------------------------------------------------------------------

-- Block 7: Next Best Action evaluations for this account (the 5 newest). action_count 0 with candidate_count 0 is the safe empty state.
with p as (select u.id as uid from auth.users u where lower(u.email) = lower('PASTE-TEST-ACCOUNT-ADDRESS') limit 1)
select left(n.id::text, 8) as evaluation_id8,
       to_char(n.evaluated_at at time zone 'utc', 'DD/MM/YYYY HH24:MI:SS') as at_utc,
       n.trigger, n.rules_version, n.ranking_policy_version, n.candidate_count, n.suppressed_count, n.action_count,
       array_to_string(n.action_codes, ',') as action_codes
  from ai_next_best_action_evaluations n, p
 where n.user_id = p.uid
 order by n.evaluated_at desc
 limit 5;
----------------------------------------------------------------------------------------------------

-- Block 8: Standard question and Explain outcomes for this account over the last 7 days. Block 9 follows: the monthly scheduler jobs for this account.
-- outcome shown: answered. unavailable: no answer (this includes the being-prepared placeholder). gated: refused as not entitled. switched off: a kill switch.
with p as (select u.id as uid from auth.users u where lower(u.email) = lower('PASTE-TEST-ACCOUNT-ADDRESS') limit 1)
select coalesce(a.contextual_target_code, a.standard_question_code) as question_or_target,
       case a.resolution_type when 'DETERMINISTIC' then 'shown' when 'UNAVAILABLE' then 'unavailable' when 'BLOCKED' then 'gated' when 'UNSUPPORTED' then 'switched off' else a.resolution_type end as outcome,
       ('STORED_PERSONALISED' = any (a.answer_origins) or 'COMPOSED_ZERO_COST' = any (a.answer_origins)) as stored_or_combined_answer,
       count(*) as times,
       to_char(max(a.created_at) at time zone 'utc', 'DD/MM/YYYY HH24:MI') as newest_utc
  from ai_resolution_audit a, p
 where a.user_id = p.uid
   and a.created_at > now() - interval '7 days'
   and (a.standard_question_code is not null or a.contextual_target_code is not null)
 group by coalesce(a.contextual_target_code, a.standard_question_code), a.resolution_type, ('STORED_PERSONALISED' = any (a.answer_origins) or 'COMPOSED_ZERO_COST' = any (a.answer_origins))
 order by max(a.created_at) desc;
----------------------------------------------------------------------------------------------------

-- Block 9: scheduler jobs for this account (one row per UTC month at most). A row proves the monthly scheduler selected this account. A SKIPPED row names the reason.
with p as (select u.id as uid from auth.users u where lower(u.email) = lower('PASTE-TEST-ACCOUNT-ADDRESS') limit 1)
select j.billing_period, j.status, coalesce(j.skip_reason, 'none') as skip_reason, coalesce(j.failure_code, 'none') as failure_code,
       left(coalesce(j.pack_id::text, ''), 8) as pack_id8,
       to_char(j.created_at at time zone 'utc', 'DD/MM/YYYY HH24:MI') as picked_utc,
       (select r.triggered_by from ai_insight_pack_scheduler_runs r where r.id = j.run_id) as picked_by_run_type
  from ai_insight_pack_scheduler_jobs j, p
 where j.user_id = p.uid
 order by j.created_at desc;
