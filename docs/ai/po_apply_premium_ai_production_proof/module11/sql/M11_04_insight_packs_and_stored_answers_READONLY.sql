-- M11_04  READ ONLY  Insight Packs, the stored answers they feed, and how Standard questions and Explain have been answering. Writes nothing.
-- No question text, no answer text, no e-mail and no full user id appears in any result (ids are cut to 8 characters, counts and dates only).
-- WHAT IS THE STORED CONTENT. A monthly pack is saved in ai_insight_packs (one row) with its blocks in ai_insight_pack_blocks. Each grounded block is
-- ALSO written as a row of ai_insights (source_engine ai_insight_pack_service, metric_code is the intent, future_ai_explanation is the text). The Standard
-- questions and Explain buttons read ai_insights, not the pack table. A Standard question that needs an explanation shows the placeholder
-- Personalised insight is being prepared until a usable ai_insights row exists for every explanation it needs.
-- Blocks 1 to 3: packs. Blocks 4 to 6: stored answers. Block 7: coverage of Premium accounts. Blocks 8 and 9: what users were actually shown.
-- Blocks 10 and 11: the scheduler ledger. Dates are day first. Months are shown as MM/YYYY.
-- This file was linted for the SQL editor but NOT executed by its author. Evidence label: NOT PERFORMED until you run it.

-- Block 1: packs by UTC month and status
select to_char(date_trunc('month', p.created_at at time zone 'utc'), 'MM/YYYY') as month_utc,
       p.status, count(*) as packs, count(distinct p.user_id) as people
  from ai_insight_packs p
 group by date_trunc('month', p.created_at at time zone 'utc'), p.status
 order by date_trunc('month', p.created_at at time zone 'utc') desc, p.status;
----------------------------------------------------------------------------------------------------

-- Block 2: packs by prompt version, provider and model
select p.prompt_code, p.prompt_version, p.provider, p.model, p.status,
       count(*) as packs, count(distinct p.user_id) as people,
       round(coalesce(sum(p.estimated_cost_usd), 0), 6) as estimated_cost_usd,
       to_char(max(p.created_at) at time zone 'utc', 'DD/MM/YYYY HH24:MI') as newest_utc
  from ai_insight_packs p
 group by p.prompt_code, p.prompt_version, p.provider, p.model, p.status
 order by p.prompt_code, p.prompt_version desc, p.status;
----------------------------------------------------------------------------------------------------

-- Block 3: why packs failed (codes only)
select coalesce(p.failure_code, 'none') as failure_code, p.status, count(*) as packs
  from ai_insight_packs p
 where p.status in ('FAILED', 'PARTIAL', 'CANCELLED')
 group by p.failure_code, p.status
 order by packs desc;
----------------------------------------------------------------------------------------------------

-- Block 4: stored answers written by packs, by intent. text_chars_min should be well above 0. rows_with_number shows numeric binding (see block 5).
select i.metric_code as intent_code,
       count(*) as rows_total,
       count(distinct i.user_id) as people,
       count(*) filter (where i.current_value is not null) as rows_with_number,
       min(length(coalesce(i.future_ai_explanation, ''))) as text_chars_min,
       max(length(coalesce(i.future_ai_explanation, ''))) as text_chars_max,
       to_char(max(i.created_at) at time zone 'utc', 'DD/MM/YYYY HH24:MI') as newest_utc
  from ai_insights i
 where i.source_engine = 'ai_insight_pack_service'
 group by i.metric_code
 order by i.metric_code;
----------------------------------------------------------------------------------------------------

-- Block 5: stored answers that the code cannot serve. Reading the code shows a stored row that carries a number is served only when the live figure for that
-- intent can be read and equals it. The intents below have no live comparison in the code, so a row with a number is never shown. Expected: no rows.
-- If rows appear, those answers exist but Standard questions and Explain will keep saying they are being prepared.
select i.metric_code as intent_code, count(*) as rows_with_number, count(distinct i.user_id) as people
  from ai_insights i
 where i.source_engine = 'ai_insight_pack_service'
   and i.current_value is not null
   and i.metric_code not in ('SCORE_EXPLANATION', 'CASH_FLOW_EXPLANATION', 'SAVINGS_EXPLANATION', 'NET_WORTH_EXPLANATION',
                             'ASSET_CONCENTRATION_EXPLANATION', 'LIQUIDITY_EXPLANATION', 'DEBT_EXPLANATION', 'INVESTMENT_EXPLANATION',
                             'RETIREMENT_EXPLANATION', 'RESILIENCE_EXPLANATION')
 group by i.metric_code
 order by rows_with_number desc;
----------------------------------------------------------------------------------------------------

-- Block 6: stored answers that are empty or too short to be useful. Expected: 0.
select count(*) as stored_answers_shorter_than_40_characters
  from ai_insights i
 where i.source_engine = 'ai_insight_pack_service'
   and length(coalesce(i.future_ai_explanation, '')) < 40;
----------------------------------------------------------------------------------------------------

-- Block 7: coverage of current Premium accounts
with prem as (
  select e.user_id
    from user_entitlements e
   where e.plan_tier = 'premium'
     and (e.effective_from is null or e.effective_from <= current_date)
     and (e.effective_to is null or e.effective_to >= current_date)
)
select (select count(*) from prem) as premium_current,
       (select count(*) from prem p where exists (select 1 from ai_insight_packs k where k.user_id = p.user_id and k.status in ('READY', 'PARTIAL'))) as with_a_ready_or_partial_pack,
       (select count(*) from prem p where exists (select 1 from ai_insight_packs k where k.user_id = p.user_id and k.status in ('READY', 'PARTIAL')
                                                   and k.created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc')) as with_a_pack_created_this_utc_month,
       (select count(*) from prem p where exists (select 1 from ai_insights i where i.user_id = p.user_id and i.source_engine = 'ai_insight_pack_service'
                                                   and i.future_ai_explanation is not null and (i.valid_until is null or i.valid_until > now()))) as with_any_stored_answer;
----------------------------------------------------------------------------------------------------

-- Block 8: Standard questions over the last 14 days, by question code.
-- shown_stored: answered using a stored pack answer alone. shown_composed: answered by combining sources (the screen label is the combined one). In this catalogue every combined
-- answer that has an explanation part includes a stored pack answer. shown_other: answered by rules only. placeholder_or_unavailable: audit type UNAVAILABLE
-- (this includes the being-prepared placeholder, no data, not applicable). gated: refused because the account was not entitled.
select a.standard_question_code,
       count(*) as opened,
       count(*) filter (where a.resolution_type = 'DETERMINISTIC' and 'STORED_PERSONALISED' = any (a.answer_origins)) as shown_stored,
       count(*) filter (where a.resolution_type = 'DETERMINISTIC' and 'COMPOSED_ZERO_COST' = any (a.answer_origins)) as shown_composed,
       count(*) filter (where a.resolution_type = 'DETERMINISTIC' and not ('STORED_PERSONALISED' = any (a.answer_origins)) and not ('COMPOSED_ZERO_COST' = any (a.answer_origins))) as shown_other,
       count(*) filter (where a.resolution_type = 'UNAVAILABLE') as placeholder_or_unavailable,
       count(*) filter (where a.resolution_type = 'BLOCKED') as gated,
       count(*) filter (where a.resolution_type = 'UNSUPPORTED') as switched_off
  from ai_resolution_audit a
 where a.standard_question_code is not null
   and a.contextual_target_code is null
   and a.created_at > now() - interval '14 days'
 group by a.standard_question_code
 order by a.standard_question_code;
----------------------------------------------------------------------------------------------------

-- Block 9: Explain buttons over the last 14 days, by target
select a.contextual_target_code,
       count(*) as opened,
       count(*) filter (where a.resolution_type = 'DETERMINISTIC') as shown,
       count(*) filter (where a.resolution_type = 'UNAVAILABLE') as placeholder_or_unavailable,
       count(*) filter (where a.resolution_type = 'BLOCKED') as gated,
       count(*) filter (where a.resolution_type = 'UNSUPPORTED') as switched_off
  from ai_resolution_audit a
 where a.contextual_target_code is not null
   and a.created_at > now() - interval '14 days'
 group by a.contextual_target_code
 order by a.contextual_target_code;
----------------------------------------------------------------------------------------------------

-- Block 10: the 10 newest scheduler runs (empty while the scheduler has never run)
select to_char(r.started_at at time zone 'utc', 'DD/MM/YYYY HH24:MI') as started_utc,
       r.phase, r.triggered_by, r.status, r.dry_run, r.billing_period,
       r.discovered_count, r.skipped_count, r.submitted_count, r.reconciled_count, r.failed_count,
       left(coalesce(r.error_summary, ''), 80) as note
  from ai_insight_pack_scheduler_runs r
 order by r.started_at desc
 limit 10;
----------------------------------------------------------------------------------------------------

-- Block 11: the monthly ledger of who was picked, by month, status and skip reason
select j.billing_period, j.status, coalesce(j.skip_reason, 'none') as skip_reason, coalesce(j.failure_code, 'none') as failure_code, count(*) as people
  from ai_insight_pack_scheduler_jobs j
 group by j.billing_period, j.status, j.skip_reason, j.failure_code
 order by j.billing_period desc, j.status;
