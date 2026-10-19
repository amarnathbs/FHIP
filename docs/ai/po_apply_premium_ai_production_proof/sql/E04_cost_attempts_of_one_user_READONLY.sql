-- E04 READ-ONLY. Every AI cost attempt of ONE account today (UTC day) and how it settled. This is the cost evidence.
-- Replace the all-zero id with the user id of the proof account (Authentication, Users, copy the id).
-- Expected after one good reading: one admitted attempt, model gpt-4o-mini, a request id, tokens, settled below 0.01.
-- A refused reading shows admission_outcome user_daily_cap_reached or budget_exhausted with reserved 0 and no request id.

with p as (select '00000000-0000-0000-0000-000000000000'::uuid as user_id)
select left(a.idempotency_key, 8) as key_prefix,
       a.created_at,
       a.admission_outcome,
       a.reserved_usd,
       a.settled_usd,
       a.model,
       a.input_tokens,
       a.output_tokens,
       a.call_outcome,
       a.billing_uncertain,
       coalesce(array_length(a.provider_request_ids, 1), 0) as provider_request_id_count,
       sum(coalesce(a.settled_usd, a.reserved_usd)) over (order by a.created_at) as running_counted_usd_today
  from aie_ai_cost_attempt a
  join p on p.user_id = a.user_id
 where a.created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'
 order by a.created_at asc;
