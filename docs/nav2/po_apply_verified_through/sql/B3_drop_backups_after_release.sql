-- B3. Run ONLY after the release is confirmed and you no longer need the copies of B1. It removes the two backup tables of B1 and nothing else. Keep them at least a week.
drop table if exists public.nav2_backup_20261019_rf_series;
drop table if exists public.nav2_backup_20261019_rf_state_log;
