-- B1b (writes six small backup tables, changes nothing else). Run BEFORE any migration, together with B1, when step 1b found that parts a, b and c of 0260 are already on production.
-- Production has NO managed backups, so this is the backup of the six risk-free tables that already exist (on 17-10-2026 they held 2 seed rows in the series table and no other row).
-- Safe to run twice: a second run keeps the first copy. The copies are locked to the service role (row level security on, no policy). Remove them with B3b once the release is confirmed.
create table if not exists public.nav2_backup_20261016_rf_series as select * from public.ii_risk_free_series;
create table if not exists public.nav2_backup_20261016_rf_batches as select * from public.ii_risk_free_batches;
create table if not exists public.nav2_backup_20261016_rf_observations as select * from public.ii_risk_free_observations;
create table if not exists public.nav2_backup_20261016_rf_review_items as select * from public.ii_risk_free_review_items;
create table if not exists public.nav2_backup_20261016_rf_corrections as select * from public.ii_risk_free_corrections;
create table if not exists public.nav2_backup_20261016_rf_state_log as select * from public.ii_risk_free_series_state_log;
alter table public.nav2_backup_20261016_rf_series enable row level security;
alter table public.nav2_backup_20261016_rf_batches enable row level security;
alter table public.nav2_backup_20261016_rf_observations enable row level security;
alter table public.nav2_backup_20261016_rf_review_items enable row level security;
alter table public.nav2_backup_20261016_rf_corrections enable row level security;
alter table public.nav2_backup_20261016_rf_state_log enable row level security;
revoke all on public.nav2_backup_20261016_rf_series from anon, authenticated;
revoke all on public.nav2_backup_20261016_rf_batches from anon, authenticated;
revoke all on public.nav2_backup_20261016_rf_observations from anon, authenticated;
revoke all on public.nav2_backup_20261016_rf_review_items from anon, authenticated;
revoke all on public.nav2_backup_20261016_rf_corrections from anon, authenticated;
revoke all on public.nav2_backup_20261016_rf_state_log from anon, authenticated;
