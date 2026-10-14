-- MANUAL BACKUP of every entitlement record, to run on PRODUCTION before migration 0280 (production has no managed backups).
-- Read-only. Run it, then use the Export to CSV button of the SQL editor result and keep the file somewhere safe outside the project.
-- It returns every row and every column of the table, newest last. The table is small (two approved records at the time of writing).
select *
  from public.ii_benchmark_entitlements
 order by created_at, id;
