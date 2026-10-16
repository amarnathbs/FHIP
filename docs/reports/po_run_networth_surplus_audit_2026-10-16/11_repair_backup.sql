-- WRITES ONE NEW TABLE (a copy of one row). Production. STEP 2 of 5. Production has no managed backups, so this is the backup.
-- Run only after step 1 showed ok_values_match = yes. Safe to run once: it stops with an error if the backup already exists.
-- It does not touch income_sources. Keep the backup table until you have checked the report; step 5 restores it if needed.
create table public.zz_backup_income_sources_20261016 as
select * from public.income_sources where id = '63d26f07-a799-4286-bdb6-38f324c87428';
