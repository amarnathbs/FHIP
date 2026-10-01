-- =============================================================================
-- 0231 — Admin-allocated Premium (manual entitlement grants)
-- =============================================================================
--
-- PRODUCT OWNER REQUEST: "allocate the premium by admin also if the user not
-- used the online option by paying the premium as they are not yet activated.
-- this should have the option up to 1 year from date of allocation and
-- extended by admin."
--
-- WHAT THIS MIGRATION ADDS (all additive; nothing existing is dropped, no
-- CHECK constraint on an existing column is dropped/recreated, so no sibling
-- branch's values can be silently revoked):
--   1. user_entitlements.entitlement_source ('payment' | 'admin_grant',
--      default 'payment' so every existing row keeps its meaning) and
--      user_entitlements.admin_grant_ends_on (the end date of the admin grant,
--      retained even while a paid subscription is overriding it -- see 6).
--   2. admin_users.can_manage_premium_entitlements — a dedicated, separately
--      named capability (Admin Architecture Standard §2). NOT implied by being
--      in admin_users, NOT implied by Super Admin (§3: no implied inheritance
--      without explicit PO approval), NOT implied by any other capability.
--   3. admin_entitlement_events — an append-only audit trail (no existing
--      audit table fits: audit_events is owner-readable by RLS so a user would
--      see the reason an admin wrote about them; ai_config_audit /
--      resource_audit_log / benchmark_update_runs are domain-specific).
--   4. admin_manage_premium_entitlement() — the ONLY write path for grant /
--      extend / revoke. SECURITY DEFINER, internal capability check on
--      auth.uid(), row lock, server-side 365-day cap, mandatory reason, paid-
--      entitlement protection, and the audit insert in the SAME transaction.
--   5. Read RPCs for the admin UI (user search, grant list incl. expiring,
--      per-user history), each capability-checked inside the function.
--   6. apply_subscription_entitlement_event() — the webhook-side merge, so a
--      Stripe/Razorpay event can never shorten, cut off or silently downgrade
--      an admin grant (service_role only).
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO:
--   * It does not touch the 'users cannot write user_entitlements' boundary:
--     RLS on user_entitlements is unchanged (select-own only, no write policy).
--   * It does not change ai_entitlement_state()/ai_admit_request() (0115):
--     they already honour effective_from/effective_to, which is exactly how an
--     expired admin grant returns the user to Free.
--
-- DESIGN RULES (stated here so the SQL is reviewable against them):
--   * Window semantics are identical to 0115: a row confers Premium iff
--     plan_tier='premium' AND (effective_from is null or <= current_date) AND
--     (effective_to is null or >= current_date). effective_to is INCLUSIVE.
--   * Cap: a grant's end date must be <= current_date + 365 days. Default in
--     the UI is the cap. Enforced HERE (authoritative) and again in the route.
--   * Extension: each extension sets a new end date that must be <= the
--     extension date + 365 days (the cap restarts from the date of the
--     extension) and, for a still-active grant, strictly later than the
--     current end. Extending a lapsed grant re-activates it from today.
--   * Revoke: sets the row back to free (source reset to 'payment', window
--     cleared). It NEVER revokes a genuine paid/other-source Premium.
--   * An admin may not grant to a user who currently holds Premium that is not
--     an admin grant (paid, or manually set before this migration): REFUSED
--     (ENTITLEMENT_PAID_ACTIVE). Chosen over an "override" because an
--     override of a customer's paid entitlement is a one-way support mistake
--     waiting to happen; the safer behaviour is to refuse and let the PO
--     resolve it in SQL deliberately.
--   * An admin may not target their own account (separation of duties).
--   * Rejected requests write NO audit row (the transaction aborts); only
--     successful changes are audited.
--
-- ROLLBACK (safe while no grants exist; after grants exist it discards the
-- audit trail and the grant markers, so export admin_entitlement_events first):
--   drop function if exists public.apply_subscription_entitlement_event(uuid,text,text,text,boolean,text,text,timestamptz,boolean);
--   drop function if exists public.admin_premium_entitlement_history(uuid,int);
--   drop function if exists public.admin_list_premium_grants(text,int);
--   drop function if exists public.admin_search_premium_entitlement_users(text);
--   drop function if exists public.admin_manage_premium_entitlement(text,uuid,date,text);
--   drop table  if exists public.admin_entitlement_events;
--   drop function if exists public.is_premium_entitlement_admin();
--   alter table public.admin_users drop column if exists can_manage_premium_entitlements;
--   alter table public.user_entitlements drop constraint if exists user_entitlements_admin_grant_shape_check,
--     drop constraint if exists user_entitlements_entitlement_source_check,
--     drop column if exists admin_grant_ends_on, drop column if exists entitlement_source;
--
-- MIGRATION NUMBER: 0231. Highest on origin/main was 0227; unmerged sibling
-- branches/worktrees (local + remote) claim 0175-0178, 0228, 0229, 0230.
-- Re-verified by a scan of every ref and every worktree working directory on
-- 2026-10-01 immediately before commit (see docs/admin/ADMIN_PREMIUM_GRANT_REPORT.md).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Source tracking on user_entitlements
-- ---------------------------------------------------------------------------
alter table public.user_entitlements
  add column if not exists entitlement_source text not null default 'payment',
  add column if not exists admin_grant_ends_on date;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'user_entitlements_entitlement_source_check'
      and conrelid = 'public.user_entitlements'::regclass
  ) then
    alter table public.user_entitlements
      add constraint user_entitlements_entitlement_source_check
      check (entitlement_source in ('payment', 'admin_grant'));
  end if;

  -- An admin-grant row is by definition Premium and carries its end date.
  -- Existing rows are all 'payment', so this validates trivially.
  if not exists (
    select 1 from pg_constraint
    where conname = 'user_entitlements_admin_grant_shape_check'
      and conrelid = 'public.user_entitlements'::regclass
  ) then
    alter table public.user_entitlements
      add constraint user_entitlements_admin_grant_shape_check
      check (entitlement_source <> 'admin_grant' or (plan_tier = 'premium' and admin_grant_ends_on is not null));
  end if;
end $$;

comment on column public.user_entitlements.entitlement_source is
  'Admin Premium grant (0231): what currently confers this row''s tier. ''payment'' = Stripe/Razorpay (or a manually-set row that pre-dates 0231; those cannot be told apart); ''admin_grant'' = allocated by an FHIP admin via admin_manage_premium_entitlement(). Only meaningful when plan_tier=''premium''; free rows carry the default.';
comment on column public.user_entitlements.admin_grant_ends_on is
  'Admin Premium grant (0231): the end date (inclusive) of the admin grant. Retained while a paid subscription overrides the grant, so a later cancellation falls back to the unexpired remainder instead of silently losing it. NULL when no admin grant exists.';

-- ---------------------------------------------------------------------------
-- 2. The capability (Admin Architecture Standard §2 / §4 layer 1)
-- ---------------------------------------------------------------------------
alter table public.admin_users
  add column if not exists can_manage_premium_entitlements boolean not null default false;
comment on column public.admin_users.can_manage_premium_entitlements is
  'Admin Premium grant (0231): separately-named capability (Standard §2) authorising grant / extend / revoke of admin-allocated Premium and viewing its audit trail. Deliberately NOT implied by presence in admin_users or by Super Admin (Standard §3).';

create or replace function public.is_premium_entitlement_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admin_users
    where admin_users.user_id = auth.uid()
      and admin_users.can_manage_premium_entitlements = true
  );
$$;
comment on function public.is_premium_entitlement_admin() is
  'Admin Premium grant (0231): true only for an admin_users row with can_manage_premium_entitlements=true. auth.uid() is read inside; a caller-supplied identity is never accepted. Backs RLS and every RPC below (Standard §4 layer 1).';
revoke all on function public.is_premium_entitlement_admin() from public, anon;
grant execute on function public.is_premium_entitlement_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Append-only audit trail
-- ---------------------------------------------------------------------------
-- actor_user_id / target_user_id are plain uuids WITHOUT foreign keys, on
-- purpose. A FK with ON DELETE SET NULL would make an account deletion issue
-- an UPDATE on this table, which the append-only trigger must refuse -- so
-- account closure would either break or the trail could be edited. Retaining
-- the (pseudonymous) ids after an account is deleted is a retention decision
-- flagged for the Product Owner in the report; no email/name is stored here.
create table if not exists public.admin_entitlement_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  action text not null check (action in ('grant', 'extend', 'revoke')),
  actor_user_id uuid not null,
  target_user_id uuid not null,
  reason text not null
    check (char_length(btrim(reason)) >= 10 and char_length(reason) <= 1000),
  requested_ends_on date,
  before_plan_tier text,
  before_entitlement_source text,
  before_effective_from date,
  before_effective_to date,
  before_admin_grant_ends_on date,
  after_plan_tier text not null,
  after_entitlement_source text not null,
  after_effective_from date,
  after_effective_to date,
  after_admin_grant_ends_on date
);

create index if not exists idx_admin_entitlement_events_target
  on public.admin_entitlement_events (target_user_id, created_at desc);
create index if not exists idx_admin_entitlement_events_created
  on public.admin_entitlement_events (created_at desc);

comment on table public.admin_entitlement_events is
  'Admin Premium grant (0231): append-only audit of every successful admin grant/extend/revoke (actor, target, mandatory reason, before/after tier + dates). Written only inside admin_manage_premium_entitlement(); UPDATE/DELETE/TRUNCATE are refused by trigger. Rejected requests are not recorded.';

create or replace function public.admin_entitlement_events_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  raise exception 'admin_entitlement_events is append-only: % is not permitted', tg_op
    using errcode = '42501';
end;
$fn$;

drop trigger if exists trg_admin_entitlement_events_no_change on public.admin_entitlement_events;
create trigger trg_admin_entitlement_events_no_change
  before update or delete on public.admin_entitlement_events
  for each row execute function public.admin_entitlement_events_immutable();

drop trigger if exists trg_admin_entitlement_events_no_truncate on public.admin_entitlement_events;
create trigger trg_admin_entitlement_events_no_truncate
  before truncate on public.admin_entitlement_events
  for each statement execute function public.admin_entitlement_events_immutable();

alter table public.admin_entitlement_events enable row level security;

-- Read: only entitlement admins. Write: no policy at all, so no authenticated
-- or anon caller can insert; the SECURITY DEFINER RPC (owner) is the writer.
drop policy if exists "entitlement admin reads audit" on public.admin_entitlement_events;
create policy "entitlement admin reads audit" on public.admin_entitlement_events
  for select using (public.is_premium_entitlement_admin());

revoke all on public.admin_entitlement_events from anon, authenticated;
grant select on public.admin_entitlement_events to authenticated;

-- ---------------------------------------------------------------------------
-- 4. The single write path: grant / extend / revoke
-- ---------------------------------------------------------------------------
-- Error vocabulary (stable message codes the route maps to HTTP statuses):
--   42501  ENTITLEMENT_UNAUTHENTICATED | ENTITLEMENT_ADMIN_REQUIRED
--   22023  ENTITLEMENT_ACTION_INVALID | ENTITLEMENT_TARGET_REQUIRED |
--          ENTITLEMENT_REASON_REQUIRED | ENTITLEMENT_REASON_TOO_LONG |
--          ENTITLEMENT_END_DATE_REQUIRED | ENTITLEMENT_END_DATE_IN_PAST |
--          ENTITLEMENT_END_DATE_EXCEEDS_MAX
--   P0002  ENTITLEMENT_USER_NOT_FOUND
--   P0001  ENTITLEMENT_SELF_TARGET | ENTITLEMENT_PAID_ACTIVE |
--          ENTITLEMENT_GRANT_ALREADY_ACTIVE | ENTITLEMENT_NO_ADMIN_GRANT |
--          ENTITLEMENT_EXTENSION_NOT_LATER
create or replace function public.admin_manage_premium_entitlement(
  p_action text,
  p_target_user_id uuid,
  p_ends_on date,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor          uuid := auth.uid();
  v_today          date := current_date;
  v_max_days       constant int := 365;
  v_reason         text := btrim(coalesce(p_reason, ''));
  v_row            public.user_entitlements%rowtype;
  v_after          public.user_entitlements%rowtype;
  v_window_current boolean;
  v_active_premium boolean;
  v_paid_active    boolean;
  v_admin_active   boolean;
  v_event_id       uuid;
begin
  -- 1. Authorisation first, from the database's own view of the caller.
  if v_actor is null then
    raise exception 'ENTITLEMENT_UNAUTHENTICATED' using errcode = '42501';
  end if;
  if not public.is_premium_entitlement_admin() then
    raise exception 'ENTITLEMENT_ADMIN_REQUIRED' using errcode = '42501';
  end if;

  -- 2. Input validation (authoritative; the route repeats it for friendlier errors).
  if p_action is null or p_action not in ('grant', 'extend', 'revoke') then
    raise exception 'ENTITLEMENT_ACTION_INVALID' using errcode = '22023';
  end if;
  if p_target_user_id is null then
    raise exception 'ENTITLEMENT_TARGET_REQUIRED' using errcode = '22023';
  end if;
  if char_length(v_reason) < 10 then
    raise exception 'ENTITLEMENT_REASON_REQUIRED' using errcode = '22023';
  end if;
  if char_length(v_reason) > 1000 then
    raise exception 'ENTITLEMENT_REASON_TOO_LONG' using errcode = '22023';
  end if;
  if p_action in ('grant', 'extend') then
    if p_ends_on is null then
      raise exception 'ENTITLEMENT_END_DATE_REQUIRED' using errcode = '22023';
    end if;
    if p_ends_on < v_today then
      raise exception 'ENTITLEMENT_END_DATE_IN_PAST' using errcode = '22023';
    end if;
    -- THE 1-YEAR RULE. For a grant the reference date is the allocation date;
    -- for an extension it is the date of the extension. Both are "today".
    if p_ends_on > v_today + v_max_days then
      raise exception 'ENTITLEMENT_END_DATE_EXCEEDS_MAX' using errcode = '22023';
    end if;
  end if;
  if p_target_user_id = v_actor then
    raise exception 'ENTITLEMENT_SELF_TARGET' using errcode = 'P0001';
  end if;

  -- 3. Target must exist; ensure it has an entitlement row, then lock it.
  if not exists (select 1 from auth.users where id = p_target_user_id) then
    raise exception 'ENTITLEMENT_USER_NOT_FOUND' using errcode = 'P0002';
  end if;
  insert into public.user_entitlements (user_id) values (p_target_user_id)
    on conflict (user_id) do nothing;
  select * into v_row from public.user_entitlements
   where user_id = p_target_user_id for update;

  -- Same window predicate as ai_entitlement_state()/ai_admit_request() (0115).
  v_window_current := (v_row.effective_from is null or v_row.effective_from <= v_today)
                  and (v_row.effective_to   is null or v_row.effective_to   >= v_today);
  v_active_premium := v_row.plan_tier = 'premium' and v_window_current;
  v_paid_active    := v_active_premium and v_row.entitlement_source <> 'admin_grant';
  v_admin_active   := v_active_premium and v_row.entitlement_source  = 'admin_grant';

  -- 4. State machine.
  if p_action = 'grant' then
    if v_paid_active then
      raise exception 'ENTITLEMENT_PAID_ACTIVE' using errcode = 'P0001';
    end if;
    if v_admin_active then
      raise exception 'ENTITLEMENT_GRANT_ALREADY_ACTIVE' using errcode = 'P0001';
    end if;
    update public.user_entitlements
       set plan_tier = 'premium',
           entitlement_source = 'admin_grant',
           effective_from = v_today,
           effective_to = p_ends_on,
           admin_grant_ends_on = p_ends_on,
           updated_at = now()
     where user_id = p_target_user_id;

  elsif p_action = 'extend' then
    if v_paid_active then
      raise exception 'ENTITLEMENT_PAID_ACTIVE' using errcode = 'P0001';
    end if;
    if v_row.entitlement_source <> 'admin_grant' then
      raise exception 'ENTITLEMENT_NO_ADMIN_GRANT' using errcode = 'P0001';
    end if;
    if v_admin_active and p_ends_on <= v_row.effective_to then
      raise exception 'ENTITLEMENT_EXTENSION_NOT_LATER' using errcode = 'P0001';
    end if;
    update public.user_entitlements
       set plan_tier = 'premium',
           entitlement_source = 'admin_grant',
           -- A lapsed grant is re-activated from today; an active one keeps its start.
           effective_from = case when v_admin_active then v_row.effective_from else v_today end,
           effective_to = p_ends_on,
           admin_grant_ends_on = p_ends_on,
           updated_at = now()
     where user_id = p_target_user_id;

  else -- revoke
    if v_row.entitlement_source = 'admin_grant' then
      update public.user_entitlements
         set plan_tier = 'free',
             entitlement_source = 'payment',
             effective_to = null,
             admin_grant_ends_on = null,
             updated_at = now()
       where user_id = p_target_user_id;
    elsif v_paid_active
          and v_row.admin_grant_ends_on is not null
          and v_row.admin_grant_ends_on >= v_today then
      -- A paid subscription is currently overriding an unexpired admin grant.
      -- Revoking clears only the reserved grant; the paid entitlement is untouched.
      update public.user_entitlements
         set admin_grant_ends_on = null,
             updated_at = now()
       where user_id = p_target_user_id;
    elsif v_paid_active then
      raise exception 'ENTITLEMENT_PAID_ACTIVE' using errcode = 'P0001';
    else
      raise exception 'ENTITLEMENT_NO_ADMIN_GRANT' using errcode = 'P0001';
    end if;
  end if;

  select * into v_after from public.user_entitlements where user_id = p_target_user_id;

  -- 5. Audit, in the SAME transaction: no code path commits the change
  -- without its audit row, or an audit row without its change.
  insert into public.admin_entitlement_events (
    action, actor_user_id, target_user_id, reason, requested_ends_on,
    before_plan_tier, before_entitlement_source, before_effective_from, before_effective_to, before_admin_grant_ends_on,
    after_plan_tier, after_entitlement_source, after_effective_from, after_effective_to, after_admin_grant_ends_on
  ) values (
    p_action, v_actor, p_target_user_id, v_reason,
    case when p_action = 'revoke' then null else p_ends_on end,
    v_row.plan_tier, v_row.entitlement_source, v_row.effective_from, v_row.effective_to, v_row.admin_grant_ends_on,
    v_after.plan_tier, v_after.entitlement_source, v_after.effective_from, v_after.effective_to, v_after.admin_grant_ends_on
  ) returning id into v_event_id;

  return jsonb_build_object(
    'audit_id', v_event_id,
    'action', p_action,
    'target_user_id', p_target_user_id,
    'as_of', v_today,
    'plan_tier', v_after.plan_tier,
    'entitlement_source', v_after.entitlement_source,
    'effective_from', v_after.effective_from,
    'effective_to', v_after.effective_to,
    'admin_grant_ends_on', v_after.admin_grant_ends_on
  );
end;
$fn$;

comment on function public.admin_manage_premium_entitlement(text, uuid, date, text) is
  'Admin Premium grant (0231): the only write path for admin grant/extend/revoke. Capability-checked on auth.uid(), 365-day cap, mandatory reason, refuses to touch a paid/non-admin Premium, audit row written atomically.';
revoke all on function public.admin_manage_premium_entitlement(text, uuid, date, text) from public, anon;
grant execute on function public.admin_manage_premium_entitlement(text, uuid, date, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Read RPCs for the admin UI (capability-checked inside each function)
-- ---------------------------------------------------------------------------
-- User search. Minimal columns only: identity needed to pick the right person
-- (email) plus the entitlement state. No financial data of any kind. Requires
-- >= 3 characters (or a full user id) and returns at most 20 rows so it cannot
-- be used as a directory dump.
create or replace function public.admin_search_premium_entitlement_users(p_query text)
returns table (
  user_id uuid,
  email text,
  plan_tier text,
  entitlement_source text,
  effective_from date,
  effective_to date,
  admin_grant_ends_on date,
  subscription_status text,
  provider text,
  entitlement_active boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_q text := lower(btrim(coalesce(p_query, '')));
  v_today date := current_date;
begin
  if auth.uid() is null then
    raise exception 'ENTITLEMENT_UNAUTHENTICATED' using errcode = '42501';
  end if;
  if not public.is_premium_entitlement_admin() then
    raise exception 'ENTITLEMENT_ADMIN_REQUIRED' using errcode = '42501';
  end if;
  if char_length(v_q) < 3 then
    raise exception 'ENTITLEMENT_QUERY_TOO_SHORT' using errcode = '22023';
  end if;

  return query
    select u.id,
           u.email::text,
           coalesce(e.plan_tier, 'free'),
           coalesce(e.entitlement_source, 'payment'),
           e.effective_from,
           e.effective_to,
           e.admin_grant_ends_on,
           e.subscription_status,
           e.provider,
           coalesce(e.plan_tier = 'premium'
                    and (e.effective_from is null or e.effective_from <= v_today)
                    and (e.effective_to   is null or e.effective_to   >= v_today), false)
      from auth.users u
      left join public.user_entitlements e on e.user_id = u.id
     where (v_q ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' and u.id::text = v_q)
        or (strpos(lower(u.email::text), v_q) > 0)
     order by u.email
     limit 20;
end;
$fn$;
revoke all on function public.admin_search_premium_entitlement_users(text) from public, anon;
grant execute on function public.admin_search_premium_entitlement_users(text) to authenticated;

-- Grant list. filter: 'expiring' (active grants ending within p_within_days),
-- 'active' (all currently-active grants), 'lapsed' (grants whose end date has
-- passed and which have not been extended or revoked).
create or replace function public.admin_list_premium_grants(p_filter text default 'expiring', p_within_days int default 30)
returns table (
  user_id uuid,
  email text,
  effective_from date,
  effective_to date,
  days_remaining int,
  state text
)
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_today date := current_date;
  v_days int := least(greatest(coalesce(p_within_days, 30), 1), 365);
begin
  if auth.uid() is null then
    raise exception 'ENTITLEMENT_UNAUTHENTICATED' using errcode = '42501';
  end if;
  if not public.is_premium_entitlement_admin() then
    raise exception 'ENTITLEMENT_ADMIN_REQUIRED' using errcode = '42501';
  end if;
  if p_filter is null or p_filter not in ('expiring', 'active', 'lapsed') then
    raise exception 'ENTITLEMENT_FILTER_INVALID' using errcode = '22023';
  end if;

  return query
    select e.user_id,
           u.email::text,
           e.effective_from,
           e.effective_to,
           (e.effective_to - v_today)::int,
           case when e.effective_to < v_today then 'lapsed' else 'active' end
      from public.user_entitlements e
      left join auth.users u on u.id = e.user_id
     where e.entitlement_source = 'admin_grant'
       and e.plan_tier = 'premium'
       and e.effective_to is not null
       and (
            (p_filter = 'expiring' and e.effective_to >= v_today and e.effective_to <= v_today + v_days
                                   and (e.effective_from is null or e.effective_from <= v_today))
         or (p_filter = 'active'   and e.effective_to >= v_today
                                   and (e.effective_from is null or e.effective_from <= v_today))
         or (p_filter = 'lapsed'   and e.effective_to < v_today)
       )
     order by e.effective_to asc, u.email asc
     limit 200;
end;
$fn$;
revoke all on function public.admin_list_premium_grants(text, int) from public, anon;
grant execute on function public.admin_list_premium_grants(text, int) to authenticated;

-- Per-user history (newest first).
create or replace function public.admin_premium_entitlement_history(p_target_user_id uuid, p_limit int default 50)
returns table (
  id uuid,
  created_at timestamptz,
  action text,
  actor_user_id uuid,
  actor_email text,
  reason text,
  requested_ends_on date,
  before_plan_tier text,
  before_entitlement_source text,
  before_effective_from date,
  before_effective_to date,
  after_plan_tier text,
  after_entitlement_source text,
  after_effective_from date,
  after_effective_to date
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
    select ev.id, ev.created_at, ev.action, ev.actor_user_id, a.email::text, ev.reason, ev.requested_ends_on,
           ev.before_plan_tier, ev.before_entitlement_source, ev.before_effective_from, ev.before_effective_to,
           ev.after_plan_tier, ev.after_entitlement_source, ev.after_effective_from, ev.after_effective_to
      from public.admin_entitlement_events ev
      left join auth.users a on a.id = ev.actor_user_id
     where ev.target_user_id = p_target_user_id
     order by ev.created_at desc, ev.id desc
     limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$fn$;
revoke all on function public.admin_premium_entitlement_history(uuid, int) from public, anon;
grant execute on function public.admin_premium_entitlement_history(uuid, int) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Payment-webhook merge (service_role only)
-- ---------------------------------------------------------------------------
-- Replaces the webhook's blind UPDATE of plan_tier (lib/services/payments/
-- entitlementSync.ts) so a provider event interacts safely with an admin grant:
--
--   premium event (active/trialing/past_due):
--       payment WINS. plan_tier='premium', source='payment', effective_to=NULL
--       (a paid entitlement is governed by subscription status, so it must not
--       be cut off at the admin grant's end date -- the bug a plain UPDATE
--       would have: the grant's effective_to would survive and silently end a
--       paying customer's Premium on that date). admin_grant_ends_on is KEPT
--       as a reserve.
--   non-premium event (canceled/incomplete/unpaid/...):
--       if an unexpired admin grant is held in reserve, RESTORE it
--       (premium/admin_grant/effective_to=admin_grant_ends_on) -- a cancelled or
--       abandoned checkout must not take away what an admin granted. Otherwise
--       the pre-existing behaviour: plan_tier='free'.
--
-- Whether a status confers Premium is decided by the caller (single source of
-- truth: PREMIUM_SUBSCRIPTION_STATUSES in entitlementSync.ts) and passed in as
-- p_confers_premium; it is not re-derived here.
create or replace function public.apply_subscription_entitlement_event(
  p_user_id uuid,
  p_provider text,
  p_provider_customer_id text,
  p_provider_subscription_id text,
  p_confers_premium boolean,
  p_subscription_status text,
  p_price_id text,
  p_current_period_end timestamptz,
  p_cancel_at_period_end boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_today date := current_date;
  v_row   public.user_entitlements%rowtype;
  v_tier  text;
  v_src   text;
  v_from  date;
  v_to    date;
  v_restored boolean := false;
begin
  select * into v_row from public.user_entitlements where user_id = p_user_id for update;
  if not found then
    -- Same as the previous behaviour: an unknown user is a no-op, never an insert from webhook data.
    return jsonb_build_object('applied', false, 'reason', 'no_entitlement_row');
  end if;

  v_from := v_row.effective_from;
  v_to   := v_row.effective_to;

  if p_confers_premium then
    v_tier := 'premium';
    v_src  := 'payment';
    v_to   := null;
  elsif v_row.admin_grant_ends_on is not null and v_row.admin_grant_ends_on >= v_today then
    v_tier := 'premium';
    v_src  := 'admin_grant';
    v_to   := v_row.admin_grant_ends_on;
    v_from := least(coalesce(v_row.effective_from, v_today), v_today);
    v_restored := true;
  else
    v_tier := 'free';
    v_src  := 'payment';
  end if;

  update public.user_entitlements
     set plan_tier = v_tier,
         entitlement_source = v_src,
         effective_from = v_from,
         effective_to = v_to,
         provider = p_provider,
         provider_customer_id = p_provider_customer_id,
         provider_subscription_id = p_provider_subscription_id,
         subscription_status = p_subscription_status,
         price_id = p_price_id,
         current_period_end = p_current_period_end,
         cancel_at_period_end = p_cancel_at_period_end,
         updated_at = now()
   where user_id = p_user_id;

  return jsonb_build_object(
    'applied', true,
    'plan_tier', v_tier,
    'entitlement_source', v_src,
    'admin_grant_restored', v_restored
  );
end;
$fn$;
comment on function public.apply_subscription_entitlement_event(uuid, text, text, text, boolean, text, text, timestamptz, boolean) is
  'Admin Premium grant (0231): webhook-side entitlement merge. Payment wins over an admin grant (and clears its end date from the live window) but the grant is kept in reserve and restored if the subscription lapses before the grant does. service_role only.';
revoke all on function public.apply_subscription_entitlement_event(uuid, text, text, text, boolean, text, text, timestamptz, boolean) from public, anon, authenticated;
grant execute on function public.apply_subscription_entitlement_event(uuid, text, text, text, boolean, text, text, timestamptz, boolean) to service_role;
