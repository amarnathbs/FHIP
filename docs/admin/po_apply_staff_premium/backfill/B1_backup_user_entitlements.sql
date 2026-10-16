-- B1 manual backup of user_entitlements, taken BEFORE the backfill (production has no managed backups)
-- Paste the whole file in the SQL editor and press Run. It makes a private copy of the whole table that no website user can read.
-- It refuses to run twice: if the copy already exists the editor shows relation already exists. That is correct, because a second copy
-- taken after the backfill would overwrite the restore point. Keep the copy until you are satisfied, then drop it (see the README).

create table private.bk_user_entitlements_before_staff_premium as
  select * from public.user_entitlements;

alter table private.bk_user_entitlements_before_staff_premium enable row level security;
revoke all on table private.bk_user_entitlements_before_staff_premium from public, anon, authenticated;

-- The two numbers must be equal. Send me this row.
select (select count(*) from private.bk_user_entitlements_before_staff_premium) as backed_up_rows,
       (select count(*) from public.user_entitlements) as live_rows,
       (select count(*) from private.bk_user_entitlements_before_staff_premium) = (select count(*) from public.user_entitlements) as ok;
