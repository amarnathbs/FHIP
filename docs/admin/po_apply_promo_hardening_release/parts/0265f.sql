-- ---------------------------------------------------------------------------
-- PART F starts here: reminder claim measures a window with the shared definition
-- ---------------------------------------------------------------------------
-- Same function, same signature, same grants as 0238. Two changes:
--   1. a threshold of t days applies to a window that is LONGER than t days, and the length is
--      access_window_days (both ends inclusive), so a 30 day promo is a 30 day window and is not told it has
--      30 days left on the day it starts.
--   2. a LESS urgent threshold is never claimed once a MORE urgent one exists for the same window. This is what
--      makes the optional seven day reminder safe: after a seven day e-mail, turning that switch back off can
--      never produce a late thirty day e-mail about the same expiry.

create or replace function public.premium_reminder_claim(
  p_today date,
  p_thresholds int[],
  p_batch int default 50,
  p_max_attempts int default 3,
  p_retry_after_minutes int default 60,
  p_only_user uuid default null          -- targeted and test runs only, the cron route never passes it
)
returns table (
  ledger_id uuid, user_id uuid, email text, country text,
  entitlement_source text, ends_on date, threshold_days int, attempt int
)
language plpgsql security definer set search_path = '' as $fn$
declare
  v_batch int := least(greatest(coalesce(p_batch, 50), 1), 500);
  v_new_count int;
  v_ids uuid[] := '{}';
begin
  if p_today is null or p_thresholds is null or coalesce(array_length(p_thresholds, 1), 0) = 0 then
    raise exception 'REMINDER_ARGUMENTS_INVALID' using errcode = '22023';
  end if;

  -- Outcome unknown (worker died between send and record): never re-send.
  update public.premium_expiry_email_ledger l
     set status = 'unknown'
   where l.status = 'pending' and l.last_attempt_at < now() - interval '30 minutes'
     and (p_only_user is null or l.user_id = p_only_user);

  -- A failed row whose entitlement is no longer the same managed window is voided, not retried.
  update public.premium_expiry_email_ledger l
     set status = 'void'
   where l.status = 'failed'
     and (p_only_user is null or l.user_id = p_only_user)
     and not exists (
       select 1 from public.user_entitlements e
        where e.user_id = l.user_id and e.entitlement_source = l.entitlement_source
          and e.plan_tier = 'premium' and e.effective_to = l.ends_on
          and e.effective_to >= p_today and (e.effective_from is null or e.effective_from <= p_today));

  -- NEW reminders: only rows THIS call inserts are returned. Existing keys are excluded up front so
  -- already-sent windows never consume the batch, ON CONFLICT is the race-safe backstop.
  with due as (
    select e.user_id, e.entitlement_source, e.effective_to as ends_on,
           (select min(x) from unnest(p_thresholds) x
             where (e.effective_to - p_today) <= x and public.access_window_days(coalesce(e.effective_from, p_today), e.effective_to) > x) as threshold
      from public.user_entitlements e
     where e.plan_tier = 'premium'
       and e.entitlement_source in ('admin_grant', 'promo_code')
       and e.effective_to is not null and e.effective_to >= p_today
       and (e.effective_from is null or e.effective_from <= p_today)
       and (p_only_user is null or e.user_id = p_only_user)
       and exists (select 1 from auth.users u where u.id = e.user_id and u.email is not null and btrim(u.email) <> '')
  ), ins as (
    insert into public.premium_expiry_email_ledger (user_id, entitlement_source, ends_on, threshold_days, status, attempts, last_attempt_at)
    select d.user_id, d.entitlement_source, d.ends_on, d.threshold, 'pending', 1, now()
      from due d
     where d.threshold is not null
       and not exists (select 1 from public.premium_expiry_email_ledger x
                        where x.user_id = d.user_id and x.entitlement_source = d.entitlement_source
                          and x.ends_on = d.ends_on and x.threshold_days = d.threshold)
       -- A LESS urgent threshold is never claimed once a MORE urgent one exists for the same window (so a seven day
       -- reminder that was sent can never be followed by a late thirty day one when the switch is turned back off).
       and not exists (select 1 from public.premium_expiry_email_ledger y
                        where y.user_id = d.user_id and y.entitlement_source = d.entitlement_source
                          and y.ends_on = d.ends_on and y.threshold_days < d.threshold and y.status <> 'void')
     order by d.ends_on asc
     limit v_batch
    on conflict on constraint uq_premium_expiry_email_window do nothing
    returning id
  )
  select coalesce(array_agg(id), '{}'::uuid[]) into v_ids from ins;
  v_new_count := coalesce(array_length(v_ids, 1), 0);

  -- RETRIES of failed sends (bounded attempts, delayed), still-valid windows only.
  with retry as (
    select l.id from public.premium_expiry_email_ledger l
     where l.status = 'failed' and l.attempts < p_max_attempts and l.next_attempt_at <= now()
       and (p_only_user is null or l.user_id = p_only_user)
       and exists (
         select 1 from public.user_entitlements e
          where e.user_id = l.user_id and e.entitlement_source = l.entitlement_source
            and e.plan_tier = 'premium' and e.effective_to = l.ends_on
            and e.effective_to >= p_today and (e.effective_from is null or e.effective_from <= p_today))
     order by l.next_attempt_at
     limit greatest(v_batch - v_new_count, 0)
     for update skip locked
  ), upd as (
    update public.premium_expiry_email_ledger l
       set status = 'pending', attempts = l.attempts + 1, last_attempt_at = now()
      from retry r where l.id = r.id
    returning l.id
  )
  select v_ids || coalesce(array_agg(id), '{}'::uuid[]) into v_ids from upd;

  return query
    select l.id, l.user_id, u.email::text, p.country_of_residence::text,
           l.entitlement_source, l.ends_on, l.threshold_days, l.attempts
      from public.premium_expiry_email_ledger l
      join auth.users u on u.id = l.user_id
      left join public.user_profiles p on p.user_id = l.user_id
     where l.id = any(v_ids)
     order by l.ends_on, l.id;
end;
$fn$;
revoke all on function public.premium_reminder_claim(date, int[], int, int, int, uuid) from public, anon, authenticated;
grant execute on function public.premium_reminder_claim(date, int[], int, int, int, uuid) to service_role;
