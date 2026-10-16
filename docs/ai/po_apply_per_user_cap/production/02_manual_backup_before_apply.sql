-- 02 MANUAL BACKUP of the two tables migration 0284 alters. PRODUCTION ONLY (optional on DEV).
-- Production has no managed backups, so these copies are the restore point. Run this BEFORE the apply file.
-- The copies live in the private schema, which the API never serves, with row level security on and every API
-- privilege revoked. Safe to run twice: a copy is created only when it does not exist yet. To take a fresh copy,
-- run 09_drop_backups.sql first. Both tables are small (a few hundred rows at most).

create schema if not exists private;

create table if not exists private.bkp_aiecap_ai_cost_attempt as table public.aie_ai_cost_attempt;
create table if not exists private.bkp_aiecap_ai_cost_ledger as table public.aie_ai_cost_ledger;

alter table private.bkp_aiecap_ai_cost_attempt enable row level security;
alter table private.bkp_aiecap_ai_cost_ledger enable row level security;
revoke all on private.bkp_aiecap_ai_cost_attempt from public, anon, authenticated;
revoke all on private.bkp_aiecap_ai_cost_ledger from public, anon, authenticated;

-- Check: live and backup row counts must be equal. READ ONLY. Every ok must be true.
select check_name, live_rows, backup_rows, (live_rows = backup_rows) as ok
from (
  select 'aie_ai_cost_attempt' as check_name, (select count(*) from public.aie_ai_cost_attempt) as live_rows, (select count(*) from private.bkp_aiecap_ai_cost_attempt) as backup_rows
  union all select 'aie_ai_cost_ledger', (select count(*) from public.aie_ai_cost_ledger), (select count(*) from private.bkp_aiecap_ai_cost_ledger)
) c;
