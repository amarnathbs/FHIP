-- B3. Run ONLY after the release is confirmed (step 7 smoke checks passed) and you no longer need the copies. It removes the four backup tables of B1 and nothing else.
-- The saved function text is the 0219 or 0261 text, so the rollback files in sql/rollback restore it without these copies. Keep the copies for at least a week.
drop table if exists public.nav2_backup_20261016_admin_users;
drop table if exists public.nav2_backup_20261016_job_control;
drop table if exists public.nav2_backup_20261016_function_text;
drop table if exists public.nav2_backup_20261016_corrections_size;
