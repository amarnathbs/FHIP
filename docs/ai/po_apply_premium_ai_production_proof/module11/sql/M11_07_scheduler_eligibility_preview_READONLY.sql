-- M11_07  READ ONLY  Who the monthly Insight Pack scheduler would reach. Writes nothing. Counts only: no e-mail, no user id.
-- This repeats, in SQL, the selection the branch code makes before it asks for the data checks (lib/ai/insightPack/scheduler/schedulerDbClient.ts, listPremiumSubjects):
--   a user_entitlements row with plan_tier premium, validity dates including today (UTC), and no scheduler job yet for the current UTC month.
-- The code then re-checks each person (live entitlement check, a certified current snapshot, no equivalent pack) and writes ONE job row per person per month, even when the
-- person is skipped. That last part cannot be reproduced in SQL. The real dry run is the admin route described in README.md, journey e.
-- Block 1: the universe and how much of it is left to discover this month. Block 2: how many scheduler ticks that takes at several sizes.
-- Block 3: people already skipped this month, by reason (a skipped person is not tried again until next month). Block 4: premium people with no household row.
-- This file was linted for the SQL editor but NOT executed by its author. Evidence label: NOT PERFORMED until you run it.

-- Block 1: universe and remaining work for the current UTC month
with params as (
  select to_char(now() at time zone 'utc', 'YYYY-MM') as period, (now() at time zone 'utc')::date as today
),
universe as (
  select e.user_id
    from user_entitlements e, params p
   where e.plan_tier = 'premium'
     and (e.effective_from is null or e.effective_from <= p.today)
     and (e.effective_to is null or e.effective_to >= p.today)
)
select (select period from params) as billing_period_utc,
       (select count(*) from universe) as premium_in_window,
       (select count(*) from universe u where exists (select 1 from ai_insight_pack_scheduler_jobs j where j.billing_period = (select period from params) and j.user_id = u.user_id)) as already_picked_this_month,
       (select count(*) from universe u where not exists (select 1 from ai_insight_pack_scheduler_jobs j where j.billing_period = (select period from params) and j.user_id = u.user_id)) as left_to_discover,
       (select count(*) from universe u where not exists (select 1 from ai_insight_packs k where k.user_id = u.user_id and k.status in ('READY', 'PARTIAL'))) as have_no_ready_or_partial_pack,
       (select scheduler_enabled from ai_platform_controls where id = 'global') as scheduler_switch_on,
       (select batch_generation_enabled from ai_platform_controls where id = 'global') as pack_generation_switch_on;
----------------------------------------------------------------------------------------------------

-- Block 2: ticks needed to reach everyone left, at three sizes of people per tick. The branch default is 5 per tick in the default mode. One tick per 15 minutes is recommended.
with params as (
  select to_char(now() at time zone 'utc', 'YYYY-MM') as period, (now() at time zone 'utc')::date as today
),
left_over as (
  select count(*) as n
    from user_entitlements e, params p
   where e.plan_tier = 'premium'
     and (e.effective_from is null or e.effective_from <= p.today)
     and (e.effective_to is null or e.effective_to >= p.today)
     and not exists (select 1 from ai_insight_pack_scheduler_jobs j where j.billing_period = p.period and j.user_id = e.user_id)
)
select s.people_per_tick,
       l.n as left_to_discover,
       ceil(l.n / s.people_per_tick::numeric) as ticks_needed,
       round(ceil(l.n / s.people_per_tick::numeric) * 15 / 60.0, 1) as hours_at_one_tick_per_15_minutes
  from left_over l, (values (2), (5), (10)) as s(people_per_tick)
 order by s.people_per_tick;
----------------------------------------------------------------------------------------------------

-- Block 3: people already skipped this month, by reason
select j.billing_period, j.status, coalesce(j.skip_reason, 'none') as skip_reason, count(*) as people
  from ai_insight_pack_scheduler_jobs j
 where j.billing_period = to_char(now() at time zone 'utc', 'YYYY-MM')
 group by j.billing_period, j.status, j.skip_reason
 order by people desc;
----------------------------------------------------------------------------------------------------

-- Block 4: current Premium accounts that have no household row (these cannot produce a certified snapshot, so the scheduler would skip them)
select count(*) as premium_current_without_a_household
  from user_entitlements e
 where e.plan_tier = 'premium'
   and (e.effective_from is null or e.effective_from <= current_date)
   and (e.effective_to is null or e.effective_to >= current_date)
   and not exists (select 1 from households h where h.user_id = e.user_id);
