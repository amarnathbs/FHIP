-- B3b. Run ONLY after the release is confirmed and you no longer need the copies of B1b. It removes the six backup tables of B1b and nothing else. Keep them at least a week.
drop table if exists public.nav2_backup_20261016_rf_series;
drop table if exists public.nav2_backup_20261016_rf_batches;
drop table if exists public.nav2_backup_20261016_rf_observations;
drop table if exists public.nav2_backup_20261016_rf_review_items;
drop table if exists public.nav2_backup_20261016_rf_corrections;
drop table if exists public.nav2_backup_20261016_rf_state_log;
