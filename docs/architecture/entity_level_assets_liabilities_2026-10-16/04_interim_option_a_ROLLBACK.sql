-- 04 ROLLBACK for 03 (WRITES). Puts the SMSF fund row back exactly as the copy made by 03 recorded it.
-- Nothing else is touched. The copy tables are kept (drop them yourself only when you are sure).
begin;
do $$
begin
  if to_regclass('public.zz_backup_20261016_retirement_accounts') is null then
    raise exception 'no backup found: 03 was not run';
  end if;
  update retirement_accounts r set is_active = b.is_active, current_balance = b.current_balance, updated_at = now()
    from public.zz_backup_20261016_retirement_accounts b where r.id = b.id;
  update smsf_funds f set is_active = b.is_active, updated_at = now()
    from public.zz_backup_20261016_smsf_funds b where f.id = b.id;
end $$;
commit;
