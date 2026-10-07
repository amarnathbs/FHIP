-- DEV ONLY residue cleanup after the hardening proofs (hand-run on the DEV project, safe to repeat)
-- The proofs create probe codes, grants and alerts. Codes, audit rows and alert rows cannot be deleted by the application on purpose
-- (they are append-only). This file lets you, as the database owner on DEV, remove exactly what the PROOFS left behind and nothing else.
-- It refuses to run on a database that looks like production: the production marker row, or a scheduled job that calls the production site.
-- It is one block: if anything fails nothing is changed and the append-only protection stays on.
--
-- What it removes
--   probe codes (matched by the note text the proofs write), their events and redemptions.
--   Premium grant audit rows and override records where BOTH the administrator and the target no longer exist (the proof users were deleted).
--   e-mail request and send rows, redemption attempts and alert rows whose person no longer exists.
--   all alert rows and cleanup run evidence on DEV (they hold only counts).
-- What it never touches: any code whose note is not a proof note, any real user, any grant of a user that still exists.

do $fn$
begin
  if exists (select 1 from public.platform_deployment_environment where environment = 'production') then
    raise exception 'REFUSED: this database carries the production marker row. This file is for DEV only.';
  end if;
  if to_regclass('cron.job') is not null then
    if (select count(*) from cron.job where position('app.financialhealthplatform.com' in command) > 0) > 0 then
      raise exception 'REFUSED: a scheduled job here calls the production site. This file is for DEV only.';
    end if;
  end if;

  alter table public.promo_codes disable trigger user;
  alter table public.promo_code_events disable trigger user;
  alter table public.admin_entitlement_events disable trigger user;
  alter table public.premium_entitlement_overrides disable trigger user;
  alter table public.admin_monitoring_events disable trigger user;
  alter table public.promo_retention_runs disable trigger user;

  delete from public.promo_code_events
   where promo_code_id in (select id from public.promo_codes where note in ('promo hardening proof, safe to disable', 'DEV proof code', 'DEV proof default', 'old shape proof', 'browser certification code, safe to disable'));
  delete from public.promo_code_redemptions
   where promo_code_id in (select id from public.promo_codes where note in ('promo hardening proof, safe to disable', 'DEV proof code', 'DEV proof default', 'old shape proof', 'browser certification code, safe to disable'));
  delete from public.promo_codes
   where note in ('promo hardening proof, safe to disable', 'DEV proof code', 'DEV proof default', 'old shape proof', 'browser certification code, safe to disable');

  delete from public.admin_entitlement_events e
   where not exists (select 1 from auth.users u where u.id = e.actor_user_id)
     and not exists (select 1 from auth.users u where u.id = e.target_user_id);
  delete from public.premium_entitlement_overrides o
   where not exists (select 1 from auth.users u where u.id = o.actor_user_id)
     and not exists (select 1 from auth.users u where u.id = o.target_user_id);

  delete from public.promo_email_sends s where not exists (select 1 from auth.users u where u.id = s.admin_user_id);
  delete from public.promo_email_requests r where not exists (select 1 from auth.users u where u.id = r.admin_user_id);
  delete from public.promo_redemption_attempts a where not exists (select 1 from auth.users u where u.id = a.user_id);
  delete from public.admin_monitoring_events;
  delete from public.promo_retention_runs;
  update public.promo_email_circuit set consecutive_failures = 0, open_until = null, updated_at = now();

  alter table public.promo_retention_runs enable trigger user;
  alter table public.admin_monitoring_events enable trigger user;
  alter table public.premium_entitlement_overrides enable trigger user;
  alter table public.admin_entitlement_events enable trigger user;
  alter table public.promo_code_events enable trigger user;
  alter table public.promo_codes enable trigger user;
end $fn$;

select 'probe codes left' as what, (select count(*) from public.promo_codes where note in ('promo hardening proof, safe to disable', 'DEV proof code', 'DEV proof default', 'old shape proof', 'browser certification code, safe to disable'))::text as remaining
union all select 'alert rows left', (select count(*) from public.admin_monitoring_events)::text
union all select 'override records left', (select count(*) from public.premium_entitlement_overrides)::text
union all select 'append-only protection is back on (event trail triggers)', (select count(*) from pg_trigger where tgrelid = 'public.promo_code_events'::regclass and not tgisinternal and tgenabled = 'O')::text;
