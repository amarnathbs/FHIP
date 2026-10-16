-- 05 VERIFY after the apply. READ ONLY. Every ok must be true.

select n, check_name, ok
from (
  select 1 as n, 'ledger column user_daily_cap_usd exists' as check_name, exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'aie_ai_cost_ledger' and column_name = 'user_daily_cap_usd') as ok
  union all select 2, 'attempt column user_id exists', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'aie_ai_cost_attempt' and column_name = 'user_id')
  union all select 3, 'index idx_aie_ai_cost_attempt_user_day exists', exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'idx_aie_ai_cost_attempt_user_day')
  union all select 4, 'v2 function exists with the exact signature', to_regprocedure('public.aie_reserve_ai_cost_v2(text,numeric,numeric,text,uuid,numeric)') is not null
  union all select 5, 'anon cannot execute the v2 function', not has_function_privilege('anon', 'public.aie_reserve_ai_cost_v2(text,numeric,numeric,text,uuid,numeric)', 'execute')
  union all select 6, 'authenticated cannot execute the v2 function', not has_function_privilege('authenticated', 'public.aie_reserve_ai_cost_v2(text,numeric,numeric,text,uuid,numeric)', 'execute')
  union all select 7, 'service_role can execute the v2 function', has_function_privilege('service_role', 'public.aie_reserve_ai_cost_v2(text,numeric,numeric,text,uuid,numeric)', 'execute')
  union all select 8, 'the 0195 reserve function is still present (older code keeps working)', to_regprocedure('public.aie_reserve_ai_cost(text,numeric,numeric,text)') is not null
  union all select 9, 'the 0195 settle and stale release functions are untouched', to_regprocedure('public.aie_settle_ai_cost_v2(text,text,numeric,bigint,bigint,text,text[],text,boolean)') is not null and to_regprocedure('public.aie_release_stale_ai_cost_reservations(integer)') is not null
  union all select 10, 'stored per-user daily cap is the documented default 1.00', (select user_daily_cap_usd = 1.0 from public.aie_ai_cost_ledger where id = 'global')
) c
order by n;

-- Facts: the two ceilings now in force.
select id, allowance_usd as global_allowance_usd, user_daily_cap_usd as per_user_daily_cap_usd, reserved_usd, settled_usd
from public.aie_ai_cost_ledger
where id = 'global';
