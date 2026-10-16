-- 01 PRECHECK. READ ONLY. Writes nothing. Run it first and keep the whole result.
-- It shows what is in place today (migration 0195 must be) and that migration 0284 is NOT applied yet.
-- Every row in the first table must say ok = true. The later tables are facts for the record.

select n, check_name, ok
from (
  select 1 as n, 'ledger row global exists' as check_name, exists (select 1 from public.aie_ai_cost_ledger where id = 'global') as ok
  union all select 2, 'attempt table exists', to_regclass('public.aie_ai_cost_attempt') is not null
  union all select 3, 'migration 0195 reserve function present', to_regprocedure('public.aie_reserve_ai_cost(text,numeric,numeric,text)') is not null
  union all select 4, 'migration 0195 settle v2 function present', to_regprocedure('public.aie_settle_ai_cost_v2(text,text,numeric,bigint,bigint,text,text[],text,boolean)') is not null
  union all select 5, 'migration 0195 stale release function present', to_regprocedure('public.aie_release_stale_ai_cost_reservations(integer)') is not null
  union all select 6, 'migration 0195 column admission_outcome present', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'aie_ai_cost_attempt' and column_name = 'admission_outcome')
  union all select 7, 'migration 0284 NOT applied yet: ledger cap column absent', not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'aie_ai_cost_ledger' and column_name = 'user_daily_cap_usd')
  union all select 8, 'migration 0284 NOT applied yet: attempt user column absent', not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'aie_ai_cost_attempt' and column_name = 'user_id')
  union all select 9, 'migration 0284 NOT applied yet: v2 function absent', to_regprocedure('public.aie_reserve_ai_cost_v2(text,numeric,numeric,text,uuid,numeric)') is null
) c
order by n;

-- Facts: the global ledger today.
select id, allowance_usd, reserved_usd, settled_usd, (allowance_usd - reserved_usd - settled_usd) as remaining_usd, total_attempts
from public.aie_ai_cost_ledger
where id = 'global';

-- Facts: the size of the table this change alters, and which database this is.
select (select count(*) from public.aie_ai_cost_attempt) as attempt_rows,
       (select count(*) from public.aie_ai_cost_attempt where settled_usd is null and admission_outcome = 'admitted') as unsettled_reservations,
       pg_size_pretty(pg_total_relation_size('public.aie_ai_cost_attempt')) as attempt_table_size,
       current_database() as database_name;
