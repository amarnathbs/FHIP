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
