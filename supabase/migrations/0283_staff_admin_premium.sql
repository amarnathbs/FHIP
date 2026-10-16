-- 0283 staff admin Premium, part A of C: the new source value, its shape rule and the audit table
-- =============================================================================
-- PRODUCT OWNER DECISION 16-10-2026: the admin user should also be a premium user, not the normal user.
-- FHIP staff accounts (see the definition in part B) hold a REAL Premium entitlement row in user_entitlements, written by the
-- database itself. This replaces the earlier rule that admin status alone must not give consumer Premium. What did NOT change:
-- the consumer Premium checks (financial import, Premium AI, report export, the SQL AI functions) still read ONLY the
-- entitlement row. No check anywhere looks at an admin role. A test fails if one ever does.
--
-- WHY A NEW SOURCE VALUE (staff_admin) AND NOT admin_grant
--   An admin grant is capped at 365 days, may be extended at most 5 times, counts against a lifetime ceiling of 10 per person,
--   sends expiry e-mails and shows in the expiry summary. Staff Premium has no end date: it lasts while the account holds a staff
--   role. Using admin_grant would either break those consumer rules or make staff Premium expire. A separate source keeps both
--   rule sets intact: staff rows are invisible to the grant ceilings, the extension cap, the expiry summary, the reminder e-mails
--   and the promo counters, and the grant functions refuse to touch them.
--
-- WHAT THIS MIGRATION ADDS (nothing existing is dropped or edited, except the two CHECK constraints below, which are widened)
--   Part A  source value staff_admin, its shape rule, the append-only audit table staff_premium_events.
--   Part B  the definition of a staff account, the guard trigger on user_entitlements, the sync function, the triggers on the
--           two role tables, the reconcile function (read-only preview and the backfill).
--   Part C  two read functions for the Admin Premium Access screen (capability can_manage_premium_entitlements, already existing).
--
-- NOTHING IS BACKFILLED BY THIS MIGRATION. Existing staff accounts stay as they are until the PO runs the backfill step after the
-- read-only preview. Once the triggers exist, a NEW staff role assignment creates the entitlement and removing the
-- last staff role ends it.
--
-- CONSTRAINT PREDECESSORS (read off the migration ledger, and no other branch changes them)
--   user_entitlements_entitlement_source_check       0237: payment, admin_grant, promo_code        -> adds staff_admin
--   user_entitlements_managed_source_shape_check     0237: source = payment, or premium with admin_grant_ends_on set
--                                                          -> or premium with source staff_admin
--
-- EDITOR SAFETY. ASCII only. No comment and no string contains one of the three statement words followed by a name.
-- Hand-run parts A to C in order. Their concatenation is byte-equal to this file (a test proves it). Every part can be run again.
--
-- MIGRATION NUMBER 0283: highest on origin/main 0280. NAV2 (not on main) claims 0281 and 0282. Checked on every ref and every
-- worktree on 16-10-2026.
--
-- ROLLBACK: docs/admin/po_apply_staff_premium/rollback (R1 data, R2 schema). Both are proven by a test on a copy.
-- =============================================================================

-- Precondition: the objects this migration builds on must exist (0231 and 0237). A clear message beats a half applied migration.
do $fn$
begin
  if to_regprocedure('public.is_premium_entitlement_admin()') is null then
    raise exception 'STAFF_PREMIUM_PREREQUISITE_MISSING: migration 0231 is not applied' using errcode = 'P0001';
  end if;
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'user_entitlements'
         and column_name in ('entitlement_source', 'admin_grant_ends_on', 'reserve_source', 'promo_code_id', 'admin_grant_extension_count')) <> 5 then
    raise exception 'STAFF_PREMIUM_PREREQUISITE_MISSING: migration 0237 is not applied' using errcode = 'P0001';
  end if;
  if to_regclass('public.resource_user_roles') is null or to_regclass('public.admin_users') is null then
    raise exception 'STAFF_PREMIUM_PREREQUISITE_MISSING: the role tables are missing' using errcode = 'P0001';
  end if;
end
$fn$;

-- 1. The new source value.
alter table public.user_entitlements drop constraint if exists user_entitlements_entitlement_source_check;
alter table public.user_entitlements
  add constraint user_entitlements_entitlement_source_check
  check (entitlement_source in ('payment', 'admin_grant', 'promo_code', 'staff_admin'));

alter table public.user_entitlements drop constraint if exists user_entitlements_managed_source_shape_check;
alter table public.user_entitlements
  add constraint user_entitlements_managed_source_shape_check
  check (entitlement_source = 'payment' or (plan_tier = 'premium' and (admin_grant_ends_on is not null or entitlement_source = 'staff_admin')));

-- 2. A staff row is Premium, open ended and carries no time limited reserve.
alter table public.user_entitlements drop constraint if exists user_entitlements_staff_source_shape_check;
alter table public.user_entitlements
  add constraint user_entitlements_staff_source_shape_check
  check (entitlement_source <> 'staff_admin' or (plan_tier = 'premium' and effective_to is null and admin_grant_ends_on is null and reserve_source is null));

comment on column public.user_entitlements.entitlement_source is
  'What currently confers this tier. payment = Stripe or Razorpay (or a manually set row that pre-dates 0231). admin_grant = allocated by an FHIP admin (0231). promo_code = a redeemed promo code (0237). staff_admin = automatic Premium for an FHIP staff account (0283): no end date, ends when the last staff role is removed, never counted against grant or promo limits. Only meaningful when plan_tier is premium.';

-- 3. Append-only audit of every start, end and payment takeover of staff Premium. Written only by the guard trigger.
-- target_user_id is a plain uuid without a foreign key on purpose (same reason as admin_entitlement_events): an account deletion must
-- not be able to edit an append-only trail. No e-mail and no name is stored here.
create table if not exists public.staff_premium_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  target_user_id uuid not null,
  action text not null check (action in ('start', 'end', 'paid_over')),
  origin text not null check (origin in ('admin_users', 'resource_user_roles', 'backfill', 'direct_write')),
  replaced_source text,
  before_plan_tier text,
  before_entitlement_source text,
  before_effective_from date,
  before_effective_to date,
  after_plan_tier text not null,
  after_entitlement_source text not null,
  after_effective_from date,
  after_effective_to date
);

create index if not exists idx_staff_premium_events_target on public.staff_premium_events (target_user_id, created_at desc);

comment on table public.staff_premium_events is
  'Staff admin Premium (0283): append-only audit. start = a staff row was written, end = it was removed because the last staff role went, paid_over = a paid subscription took the place of the staff row. origin says which path caused it. Updates, deletes and truncate are refused by trigger.';

create or replace function public.staff_premium_events_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  raise exception 'staff_premium_events is append-only' using errcode = '42501', detail = tg_op;
end;
$fn$;

drop trigger if exists trg_staff_premium_events_no_change on public.staff_premium_events;
create trigger trg_staff_premium_events_no_change
  before update or delete on public.staff_premium_events
  for each row execute function public.staff_premium_events_immutable();

drop trigger if exists trg_staff_premium_events_no_truncate on public.staff_premium_events;
create trigger trg_staff_premium_events_no_truncate
  before truncate on public.staff_premium_events
  for each statement execute function public.staff_premium_events_immutable();

alter table public.staff_premium_events enable row level security;

drop policy if exists staff_premium_events_admin_read on public.staff_premium_events;
create policy staff_premium_events_admin_read on public.staff_premium_events
  for select using (public.is_premium_entitlement_admin());

revoke all on public.staff_premium_events from anon, authenticated;
grant select on public.staff_premium_events to authenticated;
-- ---------------------------------------------------------------------------
-- PART B starts here: who counts as staff, the guard on user_entitlements, the sync, the role triggers, the reconcile
-- ---------------------------------------------------------------------------

-- DEFINITION OF A STAFF ACCOUNT (decision D1 in the report). An account is staff while it has
--   a row in admin_users (Super Admin, with or without optional capabilities), or
--   an ACTIVE row in resource_user_roles for any of the six Resources roles. Every one of them opens the Admin area.
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
         and r.role in ('resource_admin', 'author', 'editor', 'compliance_reviewer', 'publisher', 'analyst')
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
-- ---------------------------------------------------------------------------
-- PART C starts here: two read functions for the Admin Premium Access screen
-- ---------------------------------------------------------------------------
-- Capability: can_manage_premium_entitlements (the existing, separately named capability), checked inside each function on
-- auth.uid(). No new capability is created and nobody is granted anything by this migration. Both are read only.
-- Returned: the e-mail address the Premium Access screen already shows to this capability, the staff role names, and the entitlement
-- state. No financial data of any kind.

create or replace function public.admin_list_staff_premium()
returns table (
  user_id uuid,
  email text,
  roles text,
  plan_tier text,
  entitlement_source text,
  effective_from date,
  entitlement_active boolean,
  state text
)
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_today date := current_date;
begin
  if auth.uid() is null then
    raise exception 'ENTITLEMENT_UNAUTHENTICATED' using errcode = '42501';
  end if;
  if not public.is_premium_entitlement_admin() then
    raise exception 'ENTITLEMENT_ADMIN_REQUIRED' using errcode = '42501';
  end if;

  return query
    select u.id,
           u.email::text,
           nullif(concat_ws(', ',
             case when exists (select 1 from public.admin_users a where a.user_id = u.id) then 'Super Admin' end,
             (select string_agg(r.role, ', ' order by r.role) from public.resource_user_roles r where r.user_id = u.id and r.is_active)
           ), ''),
           coalesce(e.plan_tier, 'free'),
           coalesce(e.entitlement_source, 'payment'),
           e.effective_from,
           coalesce(e.plan_tier = 'premium'
                    and (e.effective_from is null or e.effective_from <= v_today)
                    and (e.effective_to is null or e.effective_to >= v_today), false),
           case
             when not public.is_staff_premium_account(u.id) then 'stray_staff_row'
             when e.entitlement_source = 'staff_admin' and e.plan_tier = 'premium' then 'staff_premium'
             when e.plan_tier = 'premium' and e.entitlement_source = 'payment'
                  and (e.effective_from is null or e.effective_from <= v_today)
                  and (e.effective_to is null or e.effective_to >= v_today) then 'paid_subscription'
             else 'not_applied' end
      from auth.users u
      left join public.user_entitlements e on e.user_id = u.id
     where public.is_staff_premium_account(u.id) or e.entitlement_source = 'staff_admin'
     order by u.email
     limit 500;
end;
$fn$;
comment on function public.admin_list_staff_premium() is
  'Staff admin Premium (0283): staff accounts and their entitlement state for the Premium Access screen. state is staff_premium, paid_subscription (a paid plan wins), not_applied (the backfill has not run for this account) or stray_staff_row (a staff row on an account that is no longer staff). Capability can_manage_premium_entitlements, checked on auth.uid().';
revoke all on function public.admin_list_staff_premium() from public, anon;
grant execute on function public.admin_list_staff_premium() to authenticated;

create or replace function public.admin_staff_premium_history(p_target_user_id uuid, p_limit int default 50)
returns table (
  id uuid,
  created_at timestamptz,
  action text,
  origin text,
  replaced_source text,
  before_plan_tier text,
  before_entitlement_source text,
  after_plan_tier text,
  after_entitlement_source text
)
language plpgsql
stable
security definer
set search_path = ''
as $fn$
begin
  if auth.uid() is null then
    raise exception 'ENTITLEMENT_UNAUTHENTICATED' using errcode = '42501';
  end if;
  if not public.is_premium_entitlement_admin() then
    raise exception 'ENTITLEMENT_ADMIN_REQUIRED' using errcode = '42501';
  end if;
  if p_target_user_id is null then
    raise exception 'ENTITLEMENT_TARGET_REQUIRED' using errcode = '22023';
  end if;

  return query
    select ev.id, ev.created_at, ev.action, ev.origin, ev.replaced_source,
           ev.before_plan_tier, ev.before_entitlement_source, ev.after_plan_tier, ev.after_entitlement_source
      from public.staff_premium_events ev
     where ev.target_user_id = p_target_user_id
     order by ev.created_at desc, ev.id desc
     limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$fn$;
comment on function public.admin_staff_premium_history(uuid, int) is
  'Staff admin Premium (0283): the start, end and paid_over events of one account, newest first. Capability can_manage_premium_entitlements, checked on auth.uid().';
revoke all on function public.admin_staff_premium_history(uuid, int) from public, anon;
grant execute on function public.admin_staff_premium_history(uuid, int) to authenticated;
