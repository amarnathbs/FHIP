-- ---------------------------------------------------------------------------
-- PART B starts here: bring the lifetime counter up to the audit trail and leave evidence
-- ---------------------------------------------------------------------------
-- While the old release was live, its grant function did not count toward the lifetime ceiling. Count it now,
-- out of the append-only audit trail. Safe to repeat: the counter only ever moves up to the audited count.

update public.user_entitlements e
   set admin_lifetime_grant_units = c.units
  from (
    select ev.target_user_id as user_id, count(*)::int as units
      from public.admin_entitlement_events ev
     where ev.action in ('grant', 'extend')
     group by ev.target_user_id
  ) c
 where e.user_id = c.user_id and e.admin_lifetime_grant_units < c.units;

insert into public.admin_monitoring_events (event_type, severity, details)
values ('promo_hardening_legacy_cleanup', 'info', jsonb_build_object('migration', '0279'));
