-- M11_06  READ ONLY  Duplicate generation, double charge and stuck work checks for Module 11. Writes nothing. Counts only.
-- Three database rules make a duplicate pack and a double charge impossible (see M11_01 block B):
--   1. one pack per person, data snapshot, data hash, schema and prompt version (unique index uq_ai_insight_packs_identity)
--   2. one admission per person and idempotency key, so a retry gets the first verdict and charges nothing more (unique index on ai_admission_events)
--   3. one scheduler job per person and month (unique constraint on the jobs table)
-- A result of 0 in blocks 1 to 4 proves the rules held in the data that exists. It does not prove they would hold under a future race: the unique
-- indexes are what guarantees that, and M11_01 block B shows they exist.
-- Blocks 5 to 7 are informational: read them, they are not pass or fail on their own.
-- Block 8: stuck work. Expected 0 in every column.
-- This file was linted for the SQL editor but NOT executed by its author. Evidence label: NOT PERFORMED until you run it.

-- Block 1: duplicate pack identities. Expected 0.
select count(*) as duplicate_pack_identity_groups
  from (select p.user_id, p.snapshot_id, p.financial_context_hash, p.context_schema_version, p.pack_schema_version, p.prompt_code, p.prompt_version,
               coalesce(p.country_context, '~') as country_key, p.language
          from ai_insight_packs p
         group by p.user_id, p.snapshot_id, p.financial_context_hash, p.context_schema_version, p.pack_schema_version, p.prompt_code, p.prompt_version,
                  coalesce(p.country_context, '~'), p.language
        having count(*) > 1) d;
----------------------------------------------------------------------------------------------------

-- Block 2: duplicate admission idempotency keys per person. Expected 0.
select count(*) as duplicate_admission_key_groups
  from (select e.user_id, e.idempotency_key
          from ai_admission_events e
         where e.idempotency_key is not null
         group by e.user_id, e.idempotency_key
        having count(*) > 1) d;
----------------------------------------------------------------------------------------------------

-- Block 3: duplicate scheduler jobs for one person and month. Expected 0.
select count(*) as duplicate_scheduler_job_groups
  from (select j.billing_period, j.user_id
          from ai_insight_pack_scheduler_jobs j
         group by j.billing_period, j.user_id
        having count(*) > 1) d;
----------------------------------------------------------------------------------------------------

-- Block 4: a pack admission that used a custom question, or a refused request that used one. Expected 0 in both columns.
select count(*) filter (where e.usage_outcome = 'BATCH_AI' and e.quota_consumed) as pack_admissions_that_used_a_custom_question,
       count(*) filter (where e.decision = 'denied' and e.quota_consumed) as refused_requests_that_used_a_custom_question
  from ai_admission_events e;
----------------------------------------------------------------------------------------------------

-- Block 5: informational. People who had a second pack started inside the last 24 hours. An admin forced regeneration or a data change can explain a 1 here.
select count(*) as people_with_more_than_one_pack_started_in_24h
  from (select p.user_id
          from ai_insight_packs p
         where p.created_at > now() - interval '24 hours'
         group by p.user_id
        having count(*) > 1) d;
----------------------------------------------------------------------------------------------------

-- Block 6: informational. How many ready or partial packs people hold per UTC month. More than 1 is allowed when the data or the prompt version changed.
select d.packs_in_month, count(*) as people
  from (select p.user_id, date_trunc('month', p.created_at at time zone 'utc') as m, count(*) as packs_in_month
          from ai_insight_packs p
         where p.status in ('READY', 'PARTIAL', 'SUPERSEDED')
         group by p.user_id, date_trunc('month', p.created_at at time zone 'utc')) d
 group by d.packs_in_month
 order by d.packs_in_month;
----------------------------------------------------------------------------------------------------

-- Block 7: informational. Pack cost seen three ways for the current UTC month. The three should be close. A large gap needs an explanation before more people are added.
select (select round(coalesce(sum(p.estimated_cost_usd), 0), 6) from ai_insight_packs p
         where p.created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc') as pack_rows_estimated_usd,
       (select round(coalesce(sum(r.estimated_cost_usd), 0), 6) from ai_runs r
         where r.request_type = 'monthly_insight_pack' and r.created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc') as provider_runs_estimated_usd,
       (select round(coalesce(sum(l.estimated_cost_usd), 0), 6) from ai_usage_ledger l
         where l.task_type = 'monthly_insight_pack' and l.billing_period = to_char(now() at time zone 'utc', 'YYYY-MM')) as usage_ledger_estimated_usd;
----------------------------------------------------------------------------------------------------

-- Block 8: stuck work older than one hour. Expected 0 in every column.
select (select count(*) from ai_insight_packs p where p.status in ('PENDING', 'QUEUED', 'GENERATING', 'PROVIDER_COMPLETE', 'VALIDATING') and p.created_at < now() - interval '1 hour') as packs_stuck_in_progress,
       (select count(*) from ai_admission_events e where e.execution_state = 'reserved' and e.lease_expires_at < now()) as admissions_reserved_past_their_lease,
       (select count(*) from ai_insight_pack_scheduler_runs r where r.status = 'RUNNING' and r.lease_until < now()) as scheduler_runs_running_past_their_lease,
       (select count(*) from ai_insight_pack_scheduler_jobs j where j.status = 'SUBMITTED' and j.updated_at < now() - interval '1 hour') as scheduler_jobs_submitted_over_an_hour_ago;
