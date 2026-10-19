-- M11_03  READ ONLY  Who is entitled to Module 11 today. Counts only: no e-mail, no name and no user id appears in any result. Writes nothing.
-- Premium means the single row in user_entitlements with plan_tier premium whose validity dates include today (UTC). The same rule is used by
-- ai_entitlement_state, ai_admit_request and the monthly scheduler, so these counts are the population that can reach the AI features.
-- Block 1: the population split. Block 2: when current Premium ends. Block 3: how many Premium accounts are outside the former two-address pilot.
-- Block 4: how many admins hold the AI Operations capabilities.
-- This file was linted for the SQL editor but NOT executed by its author. Evidence label: NOT PERFORMED until you run it.

-- Block 1: population split
select count(*) filter (where e.plan_tier = 'premium'
                          and (e.effective_from is null or e.effective_from <= current_date)
                          and (e.effective_to is null or e.effective_to >= current_date)) as premium_current,
       count(*) filter (where e.plan_tier = 'premium' and e.effective_to is not null and e.effective_to < current_date) as premium_lapsed,
       count(*) filter (where e.plan_tier = 'premium' and e.effective_from is not null and e.effective_from > current_date) as premium_not_started,
       count(*) filter (where e.plan_tier = 'free') as free_rows,
       count(*) as entitlement_rows,
       (select count(*) from auth.users) as sign_in_accounts,
       (select count(*) from auth.users u where not exists (select 1 from user_entitlements x where x.user_id = u.id)) as accounts_without_entitlement_row,
       to_char(now() at time zone 'utc', 'DD/MM/YYYY HH24:MI') as read_at_utc,
       to_char(current_date, 'DD/MM/YYYY') as today_by_database_clock
  from user_entitlements e;
----------------------------------------------------------------------------------------------------

-- Block 2: when current Premium ends
select case
         when e.effective_to is null then '1 open ended'
         when e.effective_to <= current_date + 7 then '2 ends within 7 days'
         when e.effective_to <= current_date + 30 then '3 ends within 30 days'
         else '4 ends later'
       end as premium_end_bucket,
       count(*) as accounts
  from user_entitlements e
 where e.plan_tier = 'premium'
   and (e.effective_from is null or e.effective_from <= current_date)
   and (e.effective_to is null or e.effective_to >= current_date)
 group by 1
 order by 1;
----------------------------------------------------------------------------------------------------

-- Block 3: Premium outside the former pilot. Replace the two placeholder words with the two former pilot addresses, in lower case.
-- The addresses stay in your editor. The result shows only counts. If the placeholders are left as they are, pilot_accounts_found is 0.
with pilot as (
  select u.id from auth.users u where lower(u.email) in ('paste-first-pilot-address', 'paste-second-pilot-address')
)
select (select count(*) from pilot) as pilot_accounts_found,
       count(*) as premium_current_total,
       count(*) filter (where e.user_id in (select id from pilot)) as premium_current_in_pilot,
       count(*) filter (where e.user_id not in (select id from pilot)) as premium_current_outside_pilot
  from user_entitlements e
 where e.plan_tier = 'premium'
   and (e.effective_from is null or e.effective_from <= current_date)
   and (e.effective_to is null or e.effective_to >= current_date);
----------------------------------------------------------------------------------------------------

-- Block 4: admin accounts holding the AI Operations capabilities (counts only)
select count(*) as admin_accounts,
       count(*) filter (where a.can_view_ai_operations) as can_view_ai_operations,
       count(*) filter (where a.can_manage_ai_operations) as can_manage_ai_operations
  from admin_users a;
