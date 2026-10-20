-- E10 READ-ONLY. The plan of ONE proof account, so the evidence says which kind of account it was.
-- Replace the all-zero id with the user id (Authentication, Users, copy the id). No e-mail address is shown.

select left(e.user_id::text, 8) as user_prefix,
       e.plan_tier,
       e.effective_from,
       e.effective_to,
       e.entitlement_source,
       (e.plan_tier = 'premium' and (e.effective_from is null or e.effective_from <= current_date) and (e.effective_to is null or e.effective_to >= current_date)) as premium_today
  from user_entitlements e
 where e.user_id = '00000000-0000-0000-0000-000000000000'::uuid;
