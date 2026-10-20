-- M11_05  READ ONLY  Module 11 usage, cost and refusal picture. Writes nothing. Counts, money and dates only: no question text, no e-mail, ids cut to 8 characters.
-- Money is the conservative estimate that every ceiling is checked against (US dollars). Days are UTC and shown day first.
-- Block 1: provider runs per day and task. Block 2: the usage ledger per month. Block 3: admission decisions per day (allowed and refused, with the reason).
-- Block 4: spend against the three ceilings now. Block 5: the ten biggest users this month. Block 6: how close anyone is to the hourly rate limit.
-- Block 7: operational events (soft thresholds, ceilings reached, kill switches hit) over 14 days.
-- This file was linted for the SQL editor but NOT executed by its author. Evidence label: NOT PERFORMED until you run it.

-- Block 1: provider runs per day, last 30 days. refused_or_failed are billed calls whose answer was not shown (grounding refusal, schema, timeout).
select to_char(date_trunc('day', r.created_at at time zone 'utc'), 'DD/MM/YYYY') as day_utc,
       r.request_type, r.provider, r.model,
       count(*) as runs,
       count(*) filter (where r.execution_status = 'success') as success_runs,
       count(*) filter (where r.execution_status <> 'success') as refused_or_failed,
       sum(r.input_token_count) as input_tokens,
       sum(r.output_token_count) as output_tokens,
       round(coalesce(sum(r.estimated_cost_usd), 0), 6) as estimated_cost_usd
  from ai_runs r
 where r.created_at > now() - interval '30 days'
 group by date_trunc('day', r.created_at at time zone 'utc'), r.request_type, r.provider, r.model
 order by date_trunc('day', r.created_at at time zone 'utc') desc, r.request_type;
----------------------------------------------------------------------------------------------------

-- Block 2: usage ledger per billing month and task. custom_questions is the monthly allowance used. A pack never adds to it.
select l.billing_period, l.task_type, l.provider, l.model,
       count(distinct l.user_id) as people,
       sum(l.live_call_count) as live_calls,
       sum(l.batch_call_count) as batch_calls,
       sum(l.cached_answer_count) as cached_answers,
       sum(l.custom_question_count) as custom_questions_used,
       sum(l.refunded_question_count) as custom_questions_refunded,
       round(coalesce(sum(l.estimated_cost_usd), 0), 6) as estimated_cost_usd
  from ai_usage_ledger l
 group by l.billing_period, l.task_type, l.provider, l.model
 order by l.billing_period desc, l.task_type;
----------------------------------------------------------------------------------------------------

-- Block 3: admission decisions per day, last 14 days. Every Coach and pack request passes ai_admit_request, so refusals show their reason here.
select to_char(date_trunc('day', e.created_at at time zone 'utc'), 'DD/MM/YYYY') as day_utc,
       e.usage_outcome, e.decision, coalesce(e.deny_reason, 'none') as deny_reason,
       count(*) as requests,
       count(*) filter (where e.quota_consumed) as used_a_custom_question,
       count(*) filter (where e.refunded_at is not null) as refunded
  from ai_admission_events e
 where e.created_at > now() - interval '14 days'
 group by date_trunc('day', e.created_at at time zone 'utc'), e.usage_outcome, e.decision, e.deny_reason
 order by date_trunc('day', e.created_at at time zone 'utc') desc, e.usage_outcome, e.decision;
----------------------------------------------------------------------------------------------------

-- Block 4: spend against the ceilings now
select c.per_user_monthly_cost_ceiling_usd,
       c.per_user_soft_cost_threshold_usd,
       c.platform_monthly_cost_ceiling_usd,
       c.daily_live_ai_cost_limit_usd,
       c.max_cost_per_request_usd,
       c.monthly_custom_question_allowance,
       c.rate_limit_max_requests,
       c.rate_limit_window_seconds,
       (select round(coalesce(sum(l.estimated_cost_usd), 0), 6) from ai_usage_ledger l where l.billing_period = to_char(now() at time zone 'utc', 'YYYY-MM')) as platform_spend_this_month_usd,
       (select round(coalesce(sum(e.estimated_cost_usd), 0), 6) from ai_admission_events e
         where e.decision = 'allowed' and e.execution_state <> 'released'
           and e.usage_outcome in ('LIVE_AI', 'STANDARD_PERSONALISED', 'ADMIN_EVALUATION')
           and e.created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc') as live_spend_today_usd,
       (select round(coalesce(max(s.spend), 0), 6)
          from (select sum(l.estimated_cost_usd) as spend from ai_usage_ledger l
                 where l.billing_period = to_char(now() at time zone 'utc', 'YYYY-MM') group by l.user_id) s) as highest_single_user_spend_this_month_usd
  from ai_platform_controls c
 where c.id = 'global';
----------------------------------------------------------------------------------------------------

-- Block 5: the ten biggest users this month (id cut to 8 characters)
select left(l.user_id::text, 8) as user_id8,
       sum(l.custom_question_count) as custom_questions_used,
       sum(l.live_call_count) as live_calls,
       sum(l.batch_call_count) as batch_calls,
       round(sum(l.estimated_cost_usd), 6) as estimated_cost_usd,
       round(sum(l.estimated_cost_usd) / nullif((select c.per_user_monthly_cost_ceiling_usd from ai_platform_controls c where c.id = 'global'), 0), 4) as share_of_user_ceiling
  from ai_usage_ledger l
 where l.billing_period = to_char(now() at time zone 'utc', 'YYYY-MM')
 group by l.user_id
 order by sum(l.estimated_cost_usd) desc
 limit 10;
----------------------------------------------------------------------------------------------------

-- Block 6: hourly rate limit pressure (the limit is rate_limit_max_requests per rolling window)
select coalesce(max(d.n), 0) as highest_requests_in_last_hour,
       count(*) filter (where d.n >= 8) as people_at_8_or_more,
       count(*) as people_with_any_request_in_last_hour
  from (select e.user_id, count(*) as n
          from ai_admission_events e
         where e.counts_toward_rate_limit and e.created_at > now() - interval '1 hour'
         group by e.user_id) d;
----------------------------------------------------------------------------------------------------

-- Block 7: operational events over 14 days
select e.event_type, e.severity, count(*) as events, count(distinct e.user_id) as people,
       to_char(max(e.created_at) at time zone 'utc', 'DD/MM/YYYY HH24:MI') as newest_utc
  from ai_operational_events e
 where e.created_at > now() - interval '14 days'
 group by e.event_type, e.severity
 order by e.severity, e.event_type;
