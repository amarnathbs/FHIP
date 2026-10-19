-- B1 (writes two small backup tables, changes nothing else). Run BEFORE 0294 on production. Production has NO managed backups.
-- It copies the series table (two rows) and the state log. Migration 0294 touches no table and no row, so this is a safety copy of the only two tables the new control writes.
-- Safe to run twice: a second run keeps the first copy. The copies are locked to the service role. Remove them with B3 once the release is confirmed, keep them at least a week.
create table if not exists public.nav2_backup_20261019_rf_series as select * from public.ii_risk_free_series;
create table if not exists public.nav2_backup_20261019_rf_state_log as select * from public.ii_risk_free_series_state_log;
alter table public.nav2_backup_20261019_rf_series enable row level security;
alter table public.nav2_backup_20261019_rf_state_log enable row level security;
revoke all on public.nav2_backup_20261019_rf_series from anon, authenticated;
revoke all on public.nav2_backup_20261019_rf_state_log from anon, authenticated;
