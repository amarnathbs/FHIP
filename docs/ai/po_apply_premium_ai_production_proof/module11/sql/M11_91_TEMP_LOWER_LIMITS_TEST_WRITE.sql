-- M11_91  WRITE FILE  NOT READ ONLY  Prove the refusal paths (quota, per request cost, per user monthly cost, platform monthly cost, daily cost, hourly rate)
-- WITHOUT spending money: lower ONE control to a tiny value, ask one question as your own proof account, read the refusal, then RESTORE the control at once.
-- Why no money is spent: every Coach and pack request is checked by ai_admit_request BEFORE any call to OpenAI. A refused request makes no provider call.
-- The single exception is the hourly rate test, which needs one real earlier request in the same hour (see its block).
-- READ THIS BEFORE USING IT.
--   1. DO IT ON DEV FIRST (project vqycarelcoijzwlpkpcz). On production only inside a short quiet window, because every control here is platform wide: there is no per user
--      knob, so while a control is lowered EVERY Premium user is refused in the same way. Check M11_05 block 6 and block 3 for activity first.
--   2. Take the backup first: blocks B1 to B5 of M11_90_ROLLBACK_SWITCHES_WRITE.sql. The restore blocks below read the saved values out of that copy.
--      If the copy already exists after an earlier run, check that its taken_at is recent (B5) and that it holds the values you want back.
--   3. Run one LOWER block, do the browser step, run the matching RESTORE block, then run M11_02 block 1 and confirm the value is back. Never leave two lowered at once.
--   4. The per user cap and every other ceiling must end exactly as they started. This file never raises a ceiling above its saved value.
-- Each lowering is recorded by the audit trigger in ai_config_audit (read it with M11_02 block 8).
-- This file was linted for the SQL editor but NOT executed by its author. Evidence label: NOT PERFORMED.

-- T1 LOWER, monthly custom question allowance to 0. Expect: a new Coach question is refused as quota_exhausted. In the browser the answer says the allowance is used,
-- the API returns HTTP 429 with error custom_question_limit_reached. Standard questions, Explain and Next Best Action keep working because they use no allowance.
update public.ai_platform_controls
   set monthly_custom_question_allowance = 0,
       updated_at = now()
 where id = 'global';
----------------------------------------------------------------------------------------------------

-- T1 RESTORE
update public.ai_platform_controls c
   set monthly_custom_question_allowance = (b.controls ->> 'monthly_custom_question_allowance')::int,
       updated_at = now()
  from private.bkp_m11proof_state b
 where c.id = 'global';
----------------------------------------------------------------------------------------------------

-- T2 LOWER, per request cost ceiling to one millionth of a dollar. Expect: refused as request_cost_limit, shown to the user with the public error code invalid_request.
update public.ai_platform_controls
   set max_cost_per_request_usd = 0.000001,
       updated_at = now()
 where id = 'global';
----------------------------------------------------------------------------------------------------

-- T2 RESTORE
update public.ai_platform_controls c
   set max_cost_per_request_usd = (b.controls ->> 'max_cost_per_request_usd')::numeric,
       updated_at = now()
  from private.bkp_m11proof_state b
 where c.id = 'global';
----------------------------------------------------------------------------------------------------

-- T3 LOWER step 1 of 2, remove the per user soft warning threshold. The database refuses a hard ceiling that sits below its soft threshold, so the soft one goes first.
update public.ai_platform_controls
   set per_user_soft_cost_threshold_usd = null,
       updated_at = now()
 where id = 'global';
----------------------------------------------------------------------------------------------------

-- T3 LOWER step 2 of 2, per user monthly ceiling to one millionth of a dollar. Expect: refused as user_cost_ceiling, API HTTP 503 with error cost_limit_reached.
update public.ai_platform_controls
   set per_user_monthly_cost_ceiling_usd = 0.000001,
       updated_at = now()
 where id = 'global';
----------------------------------------------------------------------------------------------------

-- T3 RESTORE step 1 of 2, the hard per user ceiling goes back FIRST (the soft threshold must not sit above it)
update public.ai_platform_controls c
   set per_user_monthly_cost_ceiling_usd = (b.controls ->> 'per_user_monthly_cost_ceiling_usd')::numeric,
       updated_at = now()
  from private.bkp_m11proof_state b
 where c.id = 'global';
----------------------------------------------------------------------------------------------------

-- T3 RESTORE step 2 of 2, the soft per user threshold goes back (null stays null)
update public.ai_platform_controls c
   set per_user_soft_cost_threshold_usd = (b.controls ->> 'per_user_soft_cost_threshold_usd')::numeric,
       updated_at = now()
  from private.bkp_m11proof_state b
 where c.id = 'global';
----------------------------------------------------------------------------------------------------

-- T4 LOWER step 1 of 2, remove the platform soft warning threshold
update public.ai_platform_controls
   set platform_soft_cost_threshold_usd = null,
       updated_at = now()
 where id = 'global';
----------------------------------------------------------------------------------------------------

-- T4 LOWER step 2 of 2, platform monthly ceiling to one millionth of a dollar. Expect: refused as platform_cost_ceiling, API HTTP 503 with error cost_limit_reached.
-- Pack generation is refused too while this is lowered.
update public.ai_platform_controls
   set platform_monthly_cost_ceiling_usd = 0.000001,
       updated_at = now()
 where id = 'global';
----------------------------------------------------------------------------------------------------

-- T4 RESTORE step 1 of 2, the hard platform ceiling goes back FIRST
update public.ai_platform_controls c
   set platform_monthly_cost_ceiling_usd = (b.controls ->> 'platform_monthly_cost_ceiling_usd')::numeric,
       updated_at = now()
  from private.bkp_m11proof_state b
 where c.id = 'global';
----------------------------------------------------------------------------------------------------

-- T4 RESTORE step 2 of 2, the soft platform threshold goes back
update public.ai_platform_controls c
   set platform_soft_cost_threshold_usd = (b.controls ->> 'platform_soft_cost_threshold_usd')::numeric,
       updated_at = now()
  from private.bkp_m11proof_state b
 where c.id = 'global';
----------------------------------------------------------------------------------------------------

-- T5 LOWER, daily live AI limit to one millionth of a dollar. Expect: a Coach question is refused as daily_cost_limit, API HTTP 503 with error cost_limit_reached.
-- The daily limit applies to live answers only. Insight Pack generation is not counted against it.
update public.ai_platform_controls
   set daily_live_ai_cost_limit_usd = 0.000001,
       updated_at = now()
 where id = 'global';
----------------------------------------------------------------------------------------------------

-- T5 RESTORE
update public.ai_platform_controls c
   set daily_live_ai_cost_limit_usd = (b.controls ->> 'daily_live_ai_cost_limit_usd')::numeric,
       updated_at = now()
  from private.bkp_m11proof_state b
 where c.id = 'global';
----------------------------------------------------------------------------------------------------

-- T6 LOWER, hourly rate limit to 1 request. Needs ONE real earlier request by your proof account inside the last hour (for example journey a), which costs about
-- one tenth of a cent and one allowance unit. Then ask a DIFFERENT new question: expect rate_limited, API HTTP 429 with Retry-After 60 and error rate_limit_reached.
update public.ai_platform_controls
   set rate_limit_max_requests = 1,
       updated_at = now()
 where id = 'global';
----------------------------------------------------------------------------------------------------

-- T6 RESTORE
update public.ai_platform_controls c
   set rate_limit_max_requests = (b.controls ->> 'rate_limit_max_requests')::int,
       updated_at = now()
  from private.bkp_m11proof_state b
 where c.id = 'global';
