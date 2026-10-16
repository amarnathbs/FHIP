-- ---------------------------------------------------------------------------
-- PART B starts here: who counts as staff, the guard on user_entitlements, the sync, the role triggers, the reconcile
-- ---------------------------------------------------------------------------

-- DEFINITION OF A STAFF ACCOUNT (decision D1 in the report). An account is staff while it has
--   a row in admin_users (Super Admin, with or without optional capabilities), or
--   an ACTIVE row in resource_user_roles for resource_admin or editor.
-- PO decision 16-10-2026 (D1): the other four Resources roles (author, compliance_reviewer, publisher, analyst) do NOT qualify. They can be
-- added later by editing the role list below and running the reconcile. Taking a role out of the list works the same way: the preview
-- then lists every account that would END.
-- This is the ONE place the rule lives. To narrow it, change this function and run the reconcile (the preview lists who would end).
create or replace function public.is_staff_premium_account(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select p_user_id is not null and (
    exists (select 1 from public.admin_users a where a.user_id = p_user_id)
    or exists (
      select 1 from public.resource_user_roles r
       where r.user_id = p_user_id and r.is_active
         and r.role in ('resource_admin', 'editor')
    )
  );
$fn$;
comment on function public.is_staff_premium_account(uuid) is
  'Staff admin Premium (0283): true while the account holds a row in admin_users or an active row in resource_user_roles. The only definition of a staff account for the entitlement. Mirrored by STAFF_PREMIUM_RESOURCE_ROLES in lib/services/staffPremium.ts (a test asserts they agree). Database roles only: never callable through the API.';
revoke all on function public.is_staff_premium_account(uuid) from public, anon, authenticated;
grant execute on function public.is_staff_premium_account(uuid) to service_role;

-- THE GUARD. Runs before every insert or update of a user_entitlements row, whoever writes it (payment webhook, promo
-- redemption, grant function, a hand written statement in the SQL editor). It is the reason the rule cannot be bypassed.
--   1. A staff_admin row may exist only for an account that is staff right now. Anything else is refused.
--   2. A staff row is never overwritten by an admin grant or a promo code (those would put an end date on it): refused.
--   3. A staff account whose row would otherwise be Free (or lapsed) is written as Staff Premium instead. This is what keeps staff
--      Premium after a cancelled or abandoned checkout, a revoked grant, or a lapsed promo.
--      A paid subscription that is Premium today is left alone: payment wins, exactly as it does for every other account.
--   4. A staff row is always Premium, open ended and free of any time limited reserve.
-- Counters used by the consumer rules (admin_lifetime_grant_units) are never touched here.
create or replace function public.staff_premium_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_today date := current_date;
  v_staff boolean;
  v_active boolean;
  v_old_staff boolean := false;
  v_old_tier text;
  v_old_source text;
  v_old_from date;
  v_old_to date;
  v_origin text := coalesce(nullif(current_setting('fhip.staff_premium_origin', true), ''), 'direct_write');
  v_replaced text;
  v_action text;
begin
  -- The origin is read off a session setting. Anything that is not one of the known values is recorded as a direct write, so a stray
  -- setting can never make the audit insert fail and block a legitimate write.
  if v_origin not in ('admin_users', 'resource_user_roles', 'backfill') then
    v_origin := 'direct_write';
  end if;

  -- An insert that will meet an existing row (insert with on conflict do nothing) changes nothing: stay out of the way.
  if tg_op = 'INSERT' and exists (select 1 from public.user_entitlements e where e.user_id = new.user_id) then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    v_old_tier := old.plan_tier;
    v_old_source := old.entitlement_source;
    v_old_from := old.effective_from;
    v_old_to := old.effective_to;
    v_old_staff := (v_old_source = 'staff_admin');
  end if;

  v_staff := public.is_staff_premium_account(new.user_id);

  if new.entitlement_source = 'staff_admin' and not v_staff then
    raise exception 'STAFF_PREMIUM_NOT_QUALIFIED' using errcode = 'P0001';
  end if;
  if v_staff and v_old_staff and new.entitlement_source in ('admin_grant', 'promo_code') then
    raise exception 'STAFF_PREMIUM_PROTECTED' using errcode = 'P0001';
  end if;

  if v_staff then
    v_active := new.plan_tier = 'premium'
      and (new.effective_from is null or new.effective_from <= v_today)
      and (new.effective_to is null or new.effective_to >= v_today);
    if new.entitlement_source <> 'staff_admin' and not (v_active and new.entitlement_source = 'payment') then
      v_replaced := case when v_old_tier = 'premium' then v_old_source
                         when new.plan_tier = 'premium' then new.entitlement_source
                         else null end;
      new.entitlement_source := 'staff_admin';
    end if;
    if new.entitlement_source = 'staff_admin' then
      new.plan_tier := 'premium';
      new.effective_to := null;
      new.admin_grant_ends_on := null;
      new.reserve_source := null;
      new.promo_code_id := null;
      if new.effective_from is null or new.effective_from > v_today or not v_old_staff then
        new.effective_from := v_today;
      end if;
      if not v_old_staff then
        new.admin_grant_extension_count := 0;
      end if;
      new.updated_at := now();
    end if;
  end if;

  -- Audit. Only a real change of source is recorded, so an ordinary update of a staff row writes nothing.
  v_action := case
    when new.entitlement_source = 'staff_admin' and not v_old_staff then 'start'
    when v_old_staff and new.entitlement_source <> 'staff_admin' and v_staff then 'paid_over'
    when v_old_staff and new.entitlement_source <> 'staff_admin' then 'end'
    else null end;
  if v_action is not null then
    insert into public.staff_premium_events (
      target_user_id, action, origin, replaced_source,
      before_plan_tier, before_entitlement_source, before_effective_from, before_effective_to,
      after_plan_tier, after_entitlement_source, after_effective_from, after_effective_to
    ) values (
      new.user_id, v_action, v_origin, case when v_action = 'start' then v_replaced else null end,
      v_old_tier, v_old_source, v_old_from, v_old_to,
      new.plan_tier, new.entitlement_source, new.effective_from, new.effective_to
    );
  end if;

  return new;
end;
$fn$;
comment on function public.staff_premium_guard() is
  'Staff admin Premium (0283): before insert or update on user_entitlements. Keeps every staff account on Staff Premium unless a paid subscription is Premium today, refuses a staff_admin row for a non-staff account, refuses an admin grant or promo over a staff row, and records start, end and paid_over events.';
revoke all on function public.staff_premium_guard() from public, anon, authenticated;

drop trigger if exists trg_staff_premium_guard on public.user_entitlements;
create trigger trg_staff_premium_guard
  before insert or update on public.user_entitlements
  for each row execute function public.staff_premium_guard();

-- THE SYNC. Brings ONE account in line with the definition. Idempotent: when nothing needs to change it writes nothing.
-- Returns what it found: started, kept, kept_paid, ended, noop or skipped.
create or replace function public.staff_premium_sync_user(p_user_id uuid, p_origin text default 'backfill')
returns text
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_today date := current_date;
  v_row record;
  v_had_row boolean;
  v_result text;
  v_origin text := case when p_origin in ('admin_users', 'resource_user_roles', 'backfill') then p_origin else 'backfill' end;
begin
  if p_user_id is null then
    return 'skipped';
  end if;
  -- An account that is being deleted (the role row went with it) has nothing to sync, and a row must never be created for it.
  if not exists (select 1 from auth.users u where u.id = p_user_id) then
    return 'skipped';
  end if;

  perform set_config('fhip.staff_premium_origin', v_origin, true);

  if public.is_staff_premium_account(p_user_id) then
    -- A brand new row is written as Staff Premium by the guard itself.
    v_had_row := exists (select 1 from public.user_entitlements e where e.user_id = p_user_id);
    insert into public.user_entitlements (user_id) values (p_user_id) on conflict (user_id) do nothing;
    select * into v_row from public.user_entitlements e where e.user_id = p_user_id for update;
    if not v_had_row then
      v_result := 'started';
    elsif v_row.entitlement_source = 'staff_admin' and v_row.plan_tier = 'premium' and v_row.effective_to is null
       and v_row.admin_grant_ends_on is null and v_row.reserve_source is null
       and (v_row.effective_from is null or v_row.effective_from <= v_today) then
      v_result := 'kept';
    elsif v_row.entitlement_source = 'payment' and v_row.plan_tier = 'premium'
          and (v_row.effective_from is null or v_row.effective_from <= v_today)
          and (v_row.effective_to is null or v_row.effective_to >= v_today) then
      v_result := 'kept_paid';
    else
      -- The guard rewrites the row to Staff Premium. This statement only gives it a row to rewrite.
      update public.user_entitlements e set plan_tier = e.plan_tier where e.user_id = p_user_id;
      v_result := 'started';
    end if;
  else
    select * into v_row from public.user_entitlements e where e.user_id = p_user_id for update;
    if found and v_row.entitlement_source = 'staff_admin' then
      update public.user_entitlements e
         set plan_tier = 'free', entitlement_source = 'payment', effective_to = null, admin_grant_ends_on = null,
             reserve_source = null, promo_code_id = null, admin_grant_extension_count = 0, updated_at = now()
       where e.user_id = p_user_id;
      v_result := 'ended';
    else
      v_result := 'noop';
    end if;
  end if;

  perform set_config('fhip.staff_premium_origin', '', true);
  return v_result;
end;
$fn$;
comment on function public.staff_premium_sync_user(uuid, text) is
  'Staff admin Premium (0283): brings one account in line with is_staff_premium_account(). Staff gets a Staff Premium row unless a paid subscription is Premium today. A non-staff account that still holds a staff row is returned to Free. Idempotent. Database roles only.';
revoke all on function public.staff_premium_sync_user(uuid, text) from public, anon, authenticated;
grant execute on function public.staff_premium_sync_user(uuid, text) to service_role;

-- THE TRIGGERS ON THE TWO ROLE TABLES. They fire for every path that changes a staff role: the Admin screens, the service role,
-- and a statement typed in the SQL editor.
create or replace function public.staff_premium_after_admin_users()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if tg_op = 'DELETE' then
    perform public.staff_premium_sync_user(old.user_id, 'admin_users');
  else
    perform public.staff_premium_sync_user(new.user_id, 'admin_users');
  end if;
  return null;
end;
$fn$;
revoke all on function public.staff_premium_after_admin_users() from public, anon, authenticated;

drop trigger if exists trg_staff_premium_admin_users on public.admin_users;
create trigger trg_staff_premium_admin_users
  after insert or delete on public.admin_users
  for each row execute function public.staff_premium_after_admin_users();

create or replace function public.staff_premium_after_resource_roles()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if tg_op = 'DELETE' then
    perform public.staff_premium_sync_user(old.user_id, 'resource_user_roles');
  else
    perform public.staff_premium_sync_user(new.user_id, 'resource_user_roles');
    if tg_op = 'UPDATE' then
      if old.user_id is distinct from new.user_id then
        perform public.staff_premium_sync_user(old.user_id, 'resource_user_roles');
      end if;
    end if;
  end if;
  return null;
end;
$fn$;
revoke all on function public.staff_premium_after_resource_roles() from public, anon, authenticated;

drop trigger if exists trg_staff_premium_resource_roles on public.resource_user_roles;
create trigger trg_staff_premium_resource_roles
  after insert or update of user_id, role, is_active or delete on public.resource_user_roles
  for each row execute function public.staff_premium_after_resource_roles();

-- THE RECONCILE: one row per account that is staff, or that still holds a staff row without being staff.
--   p_dry_run true  (the default)  READ ONLY. Lists who would be affected and how. Writes nothing.
--   p_dry_run false                runs the sync for each listed account (the backfill). Safe to repeat: a second run changes nothing.
-- planned: start (a Free or lapsed row becomes Staff Premium), start_replacing_admin_grant, start_replacing_promo_code
--          (an active time limited grant is replaced by Staff Premium), keep_staff, keep_paid (a paid subscription is Premium today and wins), end.
-- The e-mail is masked: the first two characters and the domain. Nothing else about the person is returned.
create or replace function public.staff_premium_reconcile(p_dry_run boolean default true)
returns table (
  user_id uuid,
  masked_email text,
  qualifies_via text,
  current_source text,
  current_plan_tier text,
  current_active boolean,
  planned text,
  result text
)
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_today date := current_date;
  r record;
  v_res text;
begin
  for r in
    select u.id as uid,
           left(coalesce(u.email::text, ''), 2) || '***@' || split_part(coalesce(u.email::text, ''), '@', 2) as masked,
           case when exists (select 1 from public.admin_users a where a.user_id = u.id) then 'admin_users'
                when public.is_staff_premium_account(u.id) then 'resource_user_roles'
                else 'none' end as via,
           e.entitlement_source as src,
           e.plan_tier as tier,
           coalesce(e.plan_tier = 'premium'
                    and (e.effective_from is null or e.effective_from <= v_today)
                    and (e.effective_to is null or e.effective_to >= v_today), false) as active,
           public.is_staff_premium_account(u.id) as staff
      from auth.users u
      left join public.user_entitlements e on e.user_id = u.id
     where public.is_staff_premium_account(u.id) or e.entitlement_source = 'staff_admin'
     order by u.id
  loop
    user_id := r.uid;
    masked_email := r.masked;
    qualifies_via := r.via;
    current_source := coalesce(r.src, 'no_row');
    current_plan_tier := coalesce(r.tier, 'no_row');
    current_active := r.active;
    planned := case
      when not r.staff then 'end'
      when r.src = 'staff_admin' and r.tier = 'premium' and r.active then 'keep_staff'
      when r.active and r.src = 'payment' then 'keep_paid'
      when r.active and r.src = 'admin_grant' then 'start_replacing_admin_grant'
      when r.active and r.src = 'promo_code' then 'start_replacing_promo_code'
      else 'start' end;
    if p_dry_run then
      result := 'dry_run';
    else
      v_res := public.staff_premium_sync_user(r.uid, 'backfill');
      result := v_res;
    end if;
    return next;
  end loop;
end;
$fn$;
comment on function public.staff_premium_reconcile(boolean) is
  'Staff admin Premium (0283): the preview (dry run, the default, read only) and the backfill (false). One row per staff account or stray staff row, e-mail masked. Idempotent. Database roles only: run it in the SQL editor, never in the application.';
revoke all on function public.staff_premium_reconcile(boolean) from public, anon, authenticated;
grant execute on function public.staff_premium_reconcile(boolean) to service_role;
