-- WRITES ONE VALUE IN ONE ROW. Production. STEP 5 of 5, ONLY IF you want the repair undone. Normally you do not run this.
-- Puts net_amount back to the value saved in the step 2 backup table (3,975.43) and refreshes updated_at.
-- It only acts when the backup row exists and the record still holds the repaired value 103,361.18.
update public.income_sources t
set net_amount = b.net_amount,
    updated_at = now()
from public.zz_backup_income_sources_20261016 b
where t.id = b.id
  and t.id = '63d26f07-a799-4286-bdb6-38f324c87428'
  and t.net_amount = 103361.18
returning t.id, t.source_name, t.frequency, t.net_amount as net_after_rollback;
