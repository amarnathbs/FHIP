-- ---------------------------------------------------------------------------
-- PART C starts here: lifetime counter on user_entitlements
-- ---------------------------------------------------------------------------

alter table public.user_entitlements add column if not exists admin_lifetime_grant_units int not null default 0;
do $fn$
begin
  if not exists (select 1 from pg_constraint where conname = 'user_entitlements_lifetime_units_check' and conrelid = 'public.user_entitlements'::regclass) then
    alter table public.user_entitlements add constraint user_entitlements_lifetime_units_check check (admin_lifetime_grant_units >= 0);
  end if;
end $fn$;
comment on column public.user_entitlements.admin_lifetime_grant_units is
  'Hardening 0264 item 3: successful admin grant plus extend actions this user has ever received. Never reset by a revoke. Compared with premium_grant_lifetime_ceiling().';

-- Backfill the counter out of the append-only audit trail (grant and extend events per target).
-- Re-running is safe: the counter only ever moves up to the audited count.
update public.user_entitlements e
   set admin_lifetime_grant_units = c.units
  from (
    select ev.target_user_id as user_id, count(*)::int as units
      from public.admin_entitlement_events ev
     where ev.action in ('grant', 'extend')
     group by ev.target_user_id
  ) c
 where e.user_id = c.user_id and e.admin_lifetime_grant_units < c.units;
