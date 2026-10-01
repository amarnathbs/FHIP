-- =============================================================================
-- 0237 — Promo codes, per-grant extension cap, expiry summary
-- =============================================================================
--
-- THIS IS A NEW MIGRATION ON TOP OF 0231. 0231 may already have been applied on
-- DEV, so 0231 was NOT edited. Everything here is additive or a
-- CREATE OR REPLACE / DROP-and-recreate of objects 0231 itself introduced:
--
--   * New columns on user_entitlements (extension counter, reserve source, promo id).
--   * Two CHECK constraints that 0231 created are DROPPED and RECREATED:
--       user_entitlements_entitlement_source_check   ('payment','admin_grant')
--         -> adds 'promo_code'
--       user_entitlements_admin_grant_shape_check
--         -> replaced by user_entitlements_managed_source_shape_check
--     PREDECESSOR DERIVED FROM THE LEDGER (the known recreate-a-CHECK trap): both
--     constraints are defined by 0231 and by no other migration on any ref or
--     worktree (verified by grep over supabase/migrations and the cross-branch
--     scan in docs/admin/ADMIN_PREMIUM_GRANT_REPORT.md), and the only values they
--     ever admitted are 'payment' and 'admin_grant', both retained below. No
--     existing CHECK on a table owned by another module is touched.
--   * Four 0231 read functions whose RETURN TYPE changes are dropped and
--     recreated (CREATE OR REPLACE cannot change a return type); the manage and
--     webhook functions keep their signature and are replaced in place.
--
-- WHAT THIS ADDS
--   1. EXTENSION CAP. At most premium_grant_max_extensions() (= 5) admin
--      extensions per grant. Definitions, stated precisely:
--        * "A grant" = one allocation: created by an admin Grant OR by a promo
--          redemption. It starts with extension_count = 0.
--        * "An extension" = one SUCCESSFUL admin 'extend' action on that grant,
--          including re-activating a lapsed grant. Rejected attempts do not count.
--        * The counter RESETS TO 0 when a new grant starts: an admin Grant after
--          a Revoke (or after the previous grant lapsed), or a promo redemption.
--          It is also cleared by Revoke. REVOKE + RE-GRANT BY AN ADMIN IS ALLOWED
--          and is the sanctioned way past the cap; both actions are audited.
--        * A paying subscription keeps the counter (the grant is held in reserve
--          and restored if the subscription lapses first).
--        * An admin extending a PROMO-sourced entitlement converts it to
--          'admin_grant' (an admin now decides its length) and counts as
--          extension 1.
--      The limit lives in ONE SQL function (premium_grant_max_extensions) and ONE
--      TypeScript constant (MAX_EXTENSIONS_PER_GRANT); a test asserts they match.
--      It is enforced in the SECURITY DEFINER function (authoritative) and in the
--      route (early, clear error).
--   2. PROMO CODES: promo_codes, promo_code_redemptions, append-only
--      promo_code_events, promo_redemption_attempts (rate limiting); a dedicated
--      capability admin_users.can_manage_promo_codes (separate from
--      can_manage_premium_entitlements, Standard §3; nobody holds it by default);
--      admin create / disable / list / events functions; and
--      redeem_promo_code_for_user() (service_role only, called by the
--      authenticated /api/payments/promo/redeem route).
--   3. EXPIRY SUMMARY: admin_entitlement_expiry_summary() — time-limited
--      entitlements that EXPIRED this month and that EXPIRE in the rest of this
--      month, filterable by source.
--   4. Webhook merge updated so a payment still wins over a PROMO entitlement and
--      the reserve is restored with its original source.
--
-- PROMO DESIGN RULES
--   * A code is stored normalised (upper-case, whitespace/hyphen/underscore
--     removed) from an unambiguous 31-character alphabet (no 0/O/1/I/L), 6-24
--     chars. Admin-chosen codes obey the same alphabet; generated ones are 10
--     chars from the database's CSPRNG (gen_random_uuid).
--   * duration_days is 1..365 (default 365). A redemption on date R ends on
--     R + duration_days (inclusive) — the same convention as the 365-day admin cap.
--   * max_redemptions: a finite number, or NULL = unlimited ONLY when the admin
--     chose "unlimited" explicitly (p_unlimited). Same for expiry (p_no_expiry).
--   * Redemption is atomic: the promo row and the user's entitlement row are
--     locked (FOR UPDATE, always user row first, then promo row) so
--     max_redemptions cannot be exceeded under concurrency; a CHECK
--     (redemption_count <= max_redemptions) is a second, independent backstop.
--   * One redemption per user per code (unique index).
--   * User holds ACTIVE PAID/other Premium -> REFUSED (PROMO_PAID_ACTIVE); never
--     clobbered, never stacked.
--   * User holds an active admin/promo entitlement: the later end date wins and
--     it is never shortened. If the code would not extend it, the response is the
--     same generic "cannot be used" (a distinct message would be an oracle for
--     whether a code is valid) and NO redemption is consumed.
--   * ABUSE CONTROLS: 10 attempts per user and 30 per IP-equivalent per 15
--     minutes (attempts are recorded even when they fail, because failures are
--     RETURNED as a verdict rather than raised, so the transaction commits).
--     Non-existent / disabled / expired / exhausted / no-benefit all return the
--     identical PROMO_CODE_UNUSABLE verdict through the same code path. Only an
--     "already redeemed by YOU" and a "paid Premium" verdict differ, and neither
--     reveals anything about a code the caller has not already redeemed. No code
--     value is written to promo_code_events, attempts, or any log: events carry
--     the code id and a masked hint only.
--   * Disabling a code stops FUTURE redemptions; it does not revoke Premium
--     already granted (an admin can Revoke individually).
--
-- ROLLBACK (discards the promo audit trail; export promo_code_events first):
--   drop function if exists public.redeem_promo_code_for_user(uuid,text,text);
--   drop function if exists public.admin_promo_code_events(uuid,int);
--   drop function if exists public.admin_list_promo_codes();
--   drop function if exists public.admin_disable_promo_code(uuid,text);
--   drop function if exists public.admin_create_promo_code(text,int,int,boolean,date,boolean,text);
--   drop function if exists public.admin_entitlement_expiry_summary(text);
--   drop table if exists public.promo_redemption_attempts, public.promo_code_events,
--     public.promo_code_redemptions;
--   alter table public.user_entitlements drop column if exists promo_code_id;
--   drop table if exists public.promo_codes;
--   (then re-run 0231's function definitions to restore the 0231 behaviour)
--   alter table public.admin_users drop column if exists can_manage_promo_codes;
--
-- MIGRATION NUMBER: 0237 — highest claimed anywhere at the time of writing was
-- 0236 (owner-before-upload); 0232 is claimed by the India market-index branch.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. user_entitlements: extension counter, reserve source, promo id
-- ---------------------------------------------------------------------------
alter table public.user_entitlements
  add column if not exists admin_grant_extension_count int not null default 0,
  add column if not exists reserve_source text,
  add column if not exists promo_code_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'user_entitlements_extension_count_check' and conrelid = 'public.user_entitlements'::regclass) then
    alter table public.user_entitlements add constraint user_entitlements_extension_count_check check (admin_grant_extension_count >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'user_entitlements_reserve_source_check' and conrelid = 'public.user_entitlements'::regclass) then
    alter table public.user_entitlements add constraint user_entitlements_reserve_source_check check (reserve_source is null or reserve_source in ('admin_grant', 'promo_code'));
  end if;
end $$;

comment on column public.user_entitlements.admin_grant_extension_count is
  'Promo/grant (0237): successful admin extensions of the CURRENT grant. Reset to 0 when a new grant starts (admin Grant, promo redemption) and cleared by Revoke. Capped by premium_grant_max_extensions().';
comment on column public.user_entitlements.reserve_source is
  'Promo/grant (0237): which time-limited source admin_grant_ends_on belongs to (admin_grant | promo_code), so a lapsed subscription restores the grant with its ORIGINAL source.';
comment on column public.user_entitlements.promo_code_id is
  'Promo/grant (0237): the promo code that created the current promo entitlement (id only; the code value is never copied onto the entitlement).';
comment on column public.user_entitlements.admin_grant_ends_on is
  'Admin grant (0231) / promo (0237): end date (inclusive) of the time-limited entitlement (admin grant OR promo code; see reserve_source). Retained while a paid subscription overrides it.';

-- Rows written by 0231 only ever carried the admin_grant source.
update public.user_entitlements
   set reserve_source = 'admin_grant'
 where admin_grant_ends_on is not null and reserve_source is null;

-- Predecessor (0231): entitlement_source in ('payment','admin_grant'); shape check
-- "source <> 'admin_grant' or (plan_tier='premium' and admin_grant_ends_on is not null)".
alter table public.user_entitlements drop constraint if exists user_entitlements_entitlement_source_check;
alter table public.user_entitlements
  add constraint user_entitlements_entitlement_source_check
  check (entitlement_source in ('payment', 'admin_grant', 'promo_code'));

alter table public.user_entitlements drop constraint if exists user_entitlements_admin_grant_shape_check;
alter table public.user_entitlements drop constraint if exists user_entitlements_managed_source_shape_check;
alter table public.user_entitlements
  add constraint user_entitlements_managed_source_shape_check
  check (entitlement_source = 'payment' or (plan_tier = 'premium' and admin_grant_ends_on is not null));

-- ---------------------------------------------------------------------------
-- 2. Extension limit (single SQL source of truth)
-- ---------------------------------------------------------------------------
create or replace function public.premium_grant_max_extensions()
returns int
language sql
immutable
set search_path = ''
as $$ select 5; $$;
comment on function public.premium_grant_max_extensions() is
  'Promo/grant (0237): maximum successful admin extensions per grant. Mirrored by MAX_EXTENSIONS_PER_GRANT in lib/services/premiumGrantAdmin.ts (a test asserts they agree).';
grant execute on function public.premium_grant_max_extensions() to authenticated, service_role;
revoke all on function public.premium_grant_max_extensions() from anon;

-- extension_count_after on the audit trail
alter table public.admin_entitlement_events add column if not exists extension_count_after int;

-- ---------------------------------------------------------------------------
-- 3. Promo capability
-- ---------------------------------------------------------------------------
alter table public.admin_users add column if not exists can_manage_promo_codes boolean not null default false;
comment on column public.admin_users.can_manage_promo_codes is
  'Promo codes (0237): separately-named capability (Standard §2) authorising creating, listing and disabling promo codes and reading their audit trail. NOT implied by presence in admin_users, by Super Admin, or by can_manage_premium_entitlements (Standard §3).';

create or replace function public.is_promo_code_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admin_users
    where admin_users.user_id = auth.uid() and admin_users.can_manage_promo_codes = true
  );
$$;
revoke all on function public.is_promo_code_admin() from public, anon;
grant execute on function public.is_promo_code_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Promo tables
-- ---------------------------------------------------------------------------
create table if not exists public.promo_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null check (code ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6,24}$'),
  code_hint text not null,
  duration_days int not null default 365 check (duration_days between 1 and 365),
  max_redemptions int check (max_redemptions is null or max_redemptions between 1 and 1000000),
  redemption_count int not null default 0 check (redemption_count >= 0),
  expires_on date,
  note text check (note is null or char_length(note) <= 500),
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  disabled_by uuid,
  disabled_at timestamptz,
  disable_reason text,
  -- Second, independent guard against over-redemption (the first is the row lock + check in the function).
  constraint promo_codes_redemptions_within_max check (max_redemptions is null or redemption_count <= max_redemptions)
);
create unique index if not exists uq_promo_codes_code on public.promo_codes (code);

comment on table public.promo_codes is
  'Promo codes (0237). Readable only by promo-code admins (RLS); end users can never read or enumerate it. Rows are never deleted (trigger).';

create or replace function public.promo_codes_no_delete()
returns trigger language plpgsql set search_path = public, pg_temp as $fn$
begin
  raise exception 'promo_codes rows are never deleted: disable the code instead' using errcode = '42501';
end;
$fn$;
drop trigger if exists trg_promo_codes_no_delete on public.promo_codes;
create trigger trg_promo_codes_no_delete before delete on public.promo_codes
  for each row execute function public.promo_codes_no_delete();

alter table public.promo_codes enable row level security;
drop policy if exists "promo admin reads codes" on public.promo_codes;
create policy "promo admin reads codes" on public.promo_codes for select using (public.is_promo_code_admin());
revoke all on public.promo_codes from anon, authenticated;
grant select on public.promo_codes to authenticated;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'user_entitlements_promo_code_id_fkey' and conrelid = 'public.user_entitlements'::regclass) then
    alter table public.user_entitlements
      add constraint user_entitlements_promo_code_id_fkey foreign key (promo_code_id) references public.promo_codes(id);
  end if;
end $$;

create table if not exists public.promo_code_redemptions (
  id uuid primary key default gen_random_uuid(),
  promo_code_id uuid not null references public.promo_codes(id),
  user_id uuid not null references auth.users(id) on delete cascade,
  redeemed_at timestamptz not null default now(),
  entitlement_ends_on date not null,
  constraint uq_promo_redemption_user_code unique (promo_code_id, user_id)
);
create index if not exists idx_promo_redemptions_code on public.promo_code_redemptions (promo_code_id);
alter table public.promo_code_redemptions enable row level security;
drop policy if exists "promo admin reads redemptions" on public.promo_code_redemptions;
create policy "promo admin reads redemptions" on public.promo_code_redemptions for select using (public.is_promo_code_admin());
revoke all on public.promo_code_redemptions from anon, authenticated;
grant select on public.promo_code_redemptions to authenticated;

-- Append-only audit of create / disable / redeem. NO code value, only id + masked hint.
create table if not exists public.promo_code_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  event_type text not null check (event_type in ('create', 'disable', 'redeem')),
  actor_user_id uuid not null,
  promo_code_id uuid not null references public.promo_codes(id),
  code_hint text not null,
  details jsonb not null default '{}'::jsonb,
  reason text
);
create index if not exists idx_promo_code_events_code on public.promo_code_events (promo_code_id, created_at desc);

create or replace function public.promo_code_events_immutable()
returns trigger language plpgsql set search_path = public, pg_temp as $fn$
begin
  raise exception 'promo_code_events is append-only: % is not permitted', tg_op using errcode = '42501';
end;
$fn$;
drop trigger if exists trg_promo_code_events_no_change on public.promo_code_events;
create trigger trg_promo_code_events_no_change before update or delete on public.promo_code_events
  for each row execute function public.promo_code_events_immutable();
drop trigger if exists trg_promo_code_events_no_truncate on public.promo_code_events;
create trigger trg_promo_code_events_no_truncate before truncate on public.promo_code_events
  for each statement execute function public.promo_code_events_immutable();

alter table public.promo_code_events enable row level security;
drop policy if exists "promo admin reads events" on public.promo_code_events;
create policy "promo admin reads events" on public.promo_code_events for select using (public.is_promo_code_admin());
revoke all on public.promo_code_events from anon, authenticated;
grant select on public.promo_code_events to authenticated;

-- Rate-limit ledger. No code value. user_id has no FK on purpose (no cascade edits).
create table if not exists public.promo_redemption_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  ip_hash text,
  attempted_at timestamptz not null default now(),
  succeeded boolean not null default false
);
create index if not exists idx_promo_attempts_user on public.promo_redemption_attempts (user_id, attempted_at desc);
create index if not exists idx_promo_attempts_ip on public.promo_redemption_attempts (ip_hash, attempted_at desc) where ip_hash is not null;
create index if not exists idx_promo_attempts_time on public.promo_redemption_attempts (attempted_at);
alter table public.promo_redemption_attempts enable row level security;   -- no policies: service/definer only
revoke all on public.promo_redemption_attempts from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Code normalisation / generation helpers
-- ---------------------------------------------------------------------------
create or replace function public.promo_normalise_code(p text)
returns text language sql immutable set search_path = '' as $$
  select upper(regexp_replace(coalesce(p, ''), '[\s\-_]', '', 'g'));
$$;
grant execute on function public.promo_normalise_code(text) to authenticated, service_role;
revoke all on function public.promo_normalise_code(text) from anon;

-- 10 characters from the 31-char alphabet using the CSPRNG behind gen_random_uuid().
-- Bytes 6 and 8 of a v4 uuid carry fixed version/variant bits, so they are skipped;
-- bytes >= 248 are rejected so every character is equally likely (no modulo bias).
create or replace function public.promo_generate_code()
returns text language plpgsql volatile set search_path = '' as $fn$
declare
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_out text := '';
  v_bytes bytea;
  v_i int;
  v_b int;
begin
  while char_length(v_out) < 10 loop
    v_bytes := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
    for v_i in 0..15 loop
      continue when v_i in (6, 8);
      v_b := get_byte(v_bytes, v_i);
      continue when v_b >= 248;
      v_out := v_out || substr(v_alphabet, (v_b % 31) + 1, 1);
      exit when char_length(v_out) >= 10;
    end loop;
  end loop;
  return v_out;
end;
$fn$;
revoke all on function public.promo_generate_code() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Admin promo functions (capability checked inside)
-- ---------------------------------------------------------------------------
create or replace function public.admin_create_promo_code(
  p_code text, p_duration_days int, p_max_redemptions int, p_unlimited boolean,
  p_expires_on date, p_no_expiry boolean, p_note text
) returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  v_actor uuid := auth.uid();
  v_today date := current_date;
  v_code text;
  v_duration int := coalesce(p_duration_days, 365);
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_id uuid;
  v_hint text;
  v_try int := 0;
begin
  if v_actor is null then raise exception 'PROMO_UNAUTHENTICATED' using errcode = '42501'; end if;
  if not public.is_promo_code_admin() then raise exception 'PROMO_ADMIN_REQUIRED' using errcode = '42501'; end if;

  if v_duration < 1 or v_duration > 365 then raise exception 'PROMO_DURATION_INVALID' using errcode = '22023'; end if;
  if coalesce(p_unlimited, false) then
    if p_max_redemptions is not null then raise exception 'PROMO_MAX_INVALID' using errcode = '22023'; end if;
  else
    if p_max_redemptions is null or p_max_redemptions < 1 or p_max_redemptions > 1000000 then raise exception 'PROMO_MAX_INVALID' using errcode = '22023'; end if;
  end if;
  if coalesce(p_no_expiry, false) then
    if p_expires_on is not null then raise exception 'PROMO_EXPIRY_INVALID' using errcode = '22023'; end if;
  else
    if p_expires_on is null or p_expires_on < v_today or p_expires_on > v_today + 3650 then raise exception 'PROMO_EXPIRY_INVALID' using errcode = '22023'; end if;
  end if;
  if v_note is not null and char_length(v_note) > 500 then raise exception 'PROMO_NOTE_INVALID' using errcode = '22023'; end if;

  if p_code is not null and btrim(p_code) <> '' then
    v_code := public.promo_normalise_code(p_code);
    if v_code !~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6,24}$' then raise exception 'PROMO_CODE_INVALID' using errcode = '22023'; end if;
  end if;

  loop
    v_try := v_try + 1;
    if v_code is null or v_try > 1 then
      if p_code is not null and btrim(p_code) <> '' then raise exception 'PROMO_CODE_EXISTS' using errcode = 'P0001'; end if;
      v_code := public.promo_generate_code();
    end if;
    v_hint := substr(v_code, 1, 2) || repeat('*', greatest(char_length(v_code) - 4, 2)) || substr(v_code, char_length(v_code) - 1, 2);
    begin
      insert into public.promo_codes (code, code_hint, duration_days, max_redemptions, expires_on, note, created_by)
      values (v_code, v_hint, v_duration, case when coalesce(p_unlimited, false) then null else p_max_redemptions end,
              case when coalesce(p_no_expiry, false) then null else p_expires_on end, v_note, v_actor)
      returning id into v_id;
      exit;
    exception when unique_violation then
      if v_try >= 6 or (p_code is not null and btrim(p_code) <> '') then raise exception 'PROMO_CODE_EXISTS' using errcode = 'P0001'; end if;
    end;
  end loop;

  insert into public.promo_code_events (event_type, actor_user_id, promo_code_id, code_hint, details)
  values ('create', v_actor, v_id, v_hint, jsonb_build_object(
    'duration_days', v_duration,
    'max_redemptions', case when coalesce(p_unlimited, false) then null else p_max_redemptions end,
    'unlimited', coalesce(p_unlimited, false),
    'expires_on', case when coalesce(p_no_expiry, false) then null else p_expires_on end,
    'no_expiry', coalesce(p_no_expiry, false),
    'has_note', v_note is not null));

  return jsonb_build_object('id', v_id, 'code', v_code, 'code_hint', v_hint, 'duration_days', v_duration,
    'max_redemptions', case when coalesce(p_unlimited, false) then null else p_max_redemptions end,
    'expires_on', case when coalesce(p_no_expiry, false) then null else p_expires_on end);
end;
$fn$;
revoke all on function public.admin_create_promo_code(text,int,int,boolean,date,boolean,text) from public, anon;
grant execute on function public.admin_create_promo_code(text,int,int,boolean,date,boolean,text) to authenticated;

create or replace function public.admin_disable_promo_code(p_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  v_actor uuid := auth.uid();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_row public.promo_codes%rowtype;
begin
  if v_actor is null then raise exception 'PROMO_UNAUTHENTICATED' using errcode = '42501'; end if;
  if not public.is_promo_code_admin() then raise exception 'PROMO_ADMIN_REQUIRED' using errcode = '42501'; end if;
  if char_length(v_reason) < 10 or char_length(v_reason) > 1000 then raise exception 'PROMO_REASON_REQUIRED' using errcode = '22023'; end if;
  select * into v_row from public.promo_codes where id = p_id for update;
  if not found then raise exception 'PROMO_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_row.status = 'disabled' then raise exception 'PROMO_CODE_ALREADY_DISABLED' using errcode = 'P0001'; end if;
  update public.promo_codes set status = 'disabled', disabled_by = v_actor, disabled_at = now(), disable_reason = v_reason where id = p_id;
  insert into public.promo_code_events (event_type, actor_user_id, promo_code_id, code_hint, details, reason)
  values ('disable', v_actor, p_id, v_row.code_hint, jsonb_build_object('redemption_count', v_row.redemption_count), v_reason);
  return jsonb_build_object('id', p_id, 'status', 'disabled');
end;
$fn$;
revoke all on function public.admin_disable_promo_code(uuid, text) from public, anon;
grant execute on function public.admin_disable_promo_code(uuid, text) to authenticated;

create or replace function public.admin_list_promo_codes()
returns table (
  id uuid, code text, code_hint text, duration_days int, max_redemptions int, redemption_count int,
  expires_on date, note text, status text, state text, created_at timestamptz, created_by_email text
)
language plpgsql stable security definer set search_path = '' as $fn$
declare v_today date := current_date;
begin
  if auth.uid() is null then raise exception 'PROMO_UNAUTHENTICATED' using errcode = '42501'; end if;
  if not public.is_promo_code_admin() then raise exception 'PROMO_ADMIN_REQUIRED' using errcode = '42501'; end if;
  return query
    select p.id, p.code, p.code_hint, p.duration_days, p.max_redemptions, p.redemption_count, p.expires_on, p.note, p.status,
           case when p.status = 'disabled' then 'disabled'
                when p.expires_on is not null and p.expires_on < v_today then 'expired'
                when p.max_redemptions is not null and p.redemption_count >= p.max_redemptions then 'exhausted'
                else 'active' end,
           p.created_at, u.email::text
      from public.promo_codes p left join auth.users u on u.id = p.created_by
     order by p.created_at desc limit 500;
end;
$fn$;
revoke all on function public.admin_list_promo_codes() from public, anon;
grant execute on function public.admin_list_promo_codes() to authenticated;

create or replace function public.admin_promo_code_events(p_promo_id uuid default null, p_limit int default 100)
returns table (
  id uuid, created_at timestamptz, event_type text, actor_user_id uuid, actor_email text,
  promo_code_id uuid, code_hint text, details jsonb, reason text
)
language plpgsql stable security definer set search_path = '' as $fn$
begin
  if auth.uid() is null then raise exception 'PROMO_UNAUTHENTICATED' using errcode = '42501'; end if;
  if not public.is_promo_code_admin() then raise exception 'PROMO_ADMIN_REQUIRED' using errcode = '42501'; end if;
  return query
    select e.id, e.created_at, e.event_type, e.actor_user_id, a.email::text, e.promo_code_id, e.code_hint, e.details, e.reason
      from public.promo_code_events e left join auth.users a on a.id = e.actor_user_id
     where p_promo_id is null or e.promo_code_id = p_promo_id
     order by e.created_at desc, e.id desc
     limit least(greatest(coalesce(p_limit, 100), 1), 500);
end;
$fn$;
revoke all on function public.admin_promo_code_events(uuid, int) from public, anon;
grant execute on function public.admin_promo_code_events(uuid, int) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. User redemption (service_role only; identity is supplied by the
--    authenticated route, never by the client)
-- ---------------------------------------------------------------------------
-- Returns a jsonb VERDICT instead of raising for every business outcome, so the
-- attempt row (written first) COMMITS even when the attempt fails — otherwise a
-- failed attempt would roll back its own rate-limit record.
create or replace function public.redeem_promo_code_for_user(p_user_id uuid, p_code text, p_ip_hash text)
returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  v_today date := current_date;
  v_norm text := public.promo_normalise_code(p_code);
  v_row public.user_entitlements%rowtype;
  v_promo public.promo_codes%rowtype;
  v_found boolean;
  v_attempt uuid;
  v_user_attempts int;
  v_ip_attempts int;
  v_active_premium boolean;
  v_paid_active boolean;
  v_managed_active boolean;
  v_end date;
  v_from date;
begin
  if p_user_id is null then raise exception 'PROMO_USER_REQUIRED' using errcode = '22023'; end if;
  if not exists (select 1 from auth.users where id = p_user_id) then raise exception 'PROMO_USER_NOT_FOUND' using errcode = 'P0002'; end if;

  delete from public.promo_redemption_attempts where attempted_at < now() - interval '2 days';

  select count(*) into v_user_attempts from public.promo_redemption_attempts
   where user_id = p_user_id and attempted_at > now() - interval '15 minutes';
  v_ip_attempts := 0;
  if p_ip_hash is not null then
    select count(*) into v_ip_attempts from public.promo_redemption_attempts
     where ip_hash = p_ip_hash and attempted_at > now() - interval '15 minutes';
  end if;
  insert into public.promo_redemption_attempts (user_id, ip_hash) values (p_user_id, p_ip_hash) returning id into v_attempt;
  if v_user_attempts >= 10 or v_ip_attempts >= 30 then
    return jsonb_build_object('ok', false, 'code', 'PROMO_RATE_LIMITED');
  end if;

  -- Lock order: the user's entitlement row first, then the promo row.
  insert into public.user_entitlements (user_id) values (p_user_id) on conflict (user_id) do nothing;
  select * into v_row from public.user_entitlements where user_id = p_user_id for update;
  v_active_premium := v_row.plan_tier = 'premium'
    and (v_row.effective_from is null or v_row.effective_from <= v_today)
    and (v_row.effective_to is null or v_row.effective_to >= v_today);
  v_paid_active := v_active_premium and v_row.entitlement_source = 'payment';
  v_managed_active := v_active_premium and v_row.entitlement_source in ('admin_grant', 'promo_code');

  -- Independent of the code, so it reveals nothing about any code.
  if v_paid_active then
    return jsonb_build_object('ok', false, 'code', 'PROMO_PAID_ACTIVE');
  end if;

  select * into v_promo from public.promo_codes where code = v_norm for update;
  v_found := found;

  if v_found and exists (select 1 from public.promo_code_redemptions where promo_code_id = v_promo.id and user_id = p_user_id) then
    return jsonb_build_object('ok', false, 'code', 'PROMO_ALREADY_REDEEMED');
  end if;

  v_end := case when v_found then v_today + v_promo.duration_days else null end;

  -- ONE generic verdict for: no such code, disabled, expired, exhausted, or a code that
  -- would not extend an admin/promo entitlement the user already holds longer.
  if not v_found
     or v_promo.status <> 'active'
     or (v_promo.expires_on is not null and v_promo.expires_on < v_today)
     or (v_promo.max_redemptions is not null and v_promo.redemption_count >= v_promo.max_redemptions)
     or (v_managed_active and v_row.effective_to >= v_end) then
    return jsonb_build_object('ok', false, 'code', 'PROMO_CODE_UNUSABLE');
  end if;

  v_from := case when v_managed_active then coalesce(v_row.effective_from, v_today) else v_today end;

  update public.user_entitlements
     set plan_tier = 'premium', entitlement_source = 'promo_code',
         effective_from = v_from, effective_to = v_end,
         admin_grant_ends_on = v_end, reserve_source = 'promo_code',
         admin_grant_extension_count = 0, promo_code_id = v_promo.id,
         updated_at = now()
   where user_id = p_user_id;

  update public.promo_codes set redemption_count = redemption_count + 1 where id = v_promo.id;
  insert into public.promo_code_redemptions (promo_code_id, user_id, entitlement_ends_on) values (v_promo.id, p_user_id, v_end);
  insert into public.promo_code_events (event_type, actor_user_id, promo_code_id, code_hint, details)
  values ('redeem', p_user_id, v_promo.id, v_promo.code_hint,
          jsonb_build_object('ends_on', v_end, 'before_source', v_row.entitlement_source, 'before_plan_tier', v_row.plan_tier,
                             'extended_existing', v_managed_active));
  update public.promo_redemption_attempts set succeeded = true where id = v_attempt;

  return jsonb_build_object('ok', true, 'ends_on', v_end, 'started_on', v_from);
end;
$fn$;
revoke all on function public.redeem_promo_code_for_user(uuid, text, text) from public, anon, authenticated;
grant execute on function public.redeem_promo_code_for_user(uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 8. Manage function: extension cap + promo-sourced entitlements
--    (same signature as 0231 -> replaced in place)
-- ---------------------------------------------------------------------------
-- Extra error: P0001 ENTITLEMENT_EXTENSION_LIMIT_REACHED
create or replace function public.admin_manage_premium_entitlement(
  p_action text, p_target_user_id uuid, p_ends_on date, p_reason text
) returns jsonb
language plpgsql security definer set search_path = '' as $fn$
declare
  v_actor          uuid := auth.uid();
  v_today          date := current_date;
  v_max_days       constant int := 365;
  v_max_ext        int := public.premium_grant_max_extensions();
  v_reason         text := btrim(coalesce(p_reason, ''));
  v_row            public.user_entitlements%rowtype;
  v_after          public.user_entitlements%rowtype;
  v_window_current boolean;
  v_active_premium boolean;
  v_paid_active    boolean;
  v_managed_active boolean;
  v_managed_source boolean;
  v_event_id       uuid;
begin
  if v_actor is null then raise exception 'ENTITLEMENT_UNAUTHENTICATED' using errcode = '42501'; end if;
  if not public.is_premium_entitlement_admin() then raise exception 'ENTITLEMENT_ADMIN_REQUIRED' using errcode = '42501'; end if;

  if p_action is null or p_action not in ('grant', 'extend', 'revoke') then raise exception 'ENTITLEMENT_ACTION_INVALID' using errcode = '22023'; end if;
  if p_target_user_id is null then raise exception 'ENTITLEMENT_TARGET_REQUIRED' using errcode = '22023'; end if;
  if char_length(v_reason) < 10 then raise exception 'ENTITLEMENT_REASON_REQUIRED' using errcode = '22023'; end if;
  if char_length(v_reason) > 1000 then raise exception 'ENTITLEMENT_REASON_TOO_LONG' using errcode = '22023'; end if;
  if p_action in ('grant', 'extend') then
    if p_ends_on is null then raise exception 'ENTITLEMENT_END_DATE_REQUIRED' using errcode = '22023'; end if;
    if p_ends_on < v_today then raise exception 'ENTITLEMENT_END_DATE_IN_PAST' using errcode = '22023'; end if;
    if p_ends_on > v_today + v_max_days then raise exception 'ENTITLEMENT_END_DATE_EXCEEDS_MAX' using errcode = '22023'; end if;
  end if;
  if p_target_user_id = v_actor then raise exception 'ENTITLEMENT_SELF_TARGET' using errcode = 'P0001'; end if;

  if not exists (select 1 from auth.users where id = p_target_user_id) then raise exception 'ENTITLEMENT_USER_NOT_FOUND' using errcode = 'P0002'; end if;
  insert into public.user_entitlements (user_id) values (p_target_user_id) on conflict (user_id) do nothing;
  select * into v_row from public.user_entitlements where user_id = p_target_user_id for update;

  v_window_current := (v_row.effective_from is null or v_row.effective_from <= v_today)
                  and (v_row.effective_to   is null or v_row.effective_to   >= v_today);
  v_active_premium := v_row.plan_tier = 'premium' and v_window_current;
  v_managed_source := v_row.entitlement_source in ('admin_grant', 'promo_code');
  v_paid_active    := v_active_premium and not v_managed_source;
  v_managed_active := v_active_premium and v_managed_source;

  if p_action = 'grant' then
    if v_paid_active then raise exception 'ENTITLEMENT_PAID_ACTIVE' using errcode = 'P0001'; end if;
    if v_managed_active then raise exception 'ENTITLEMENT_GRANT_ALREADY_ACTIVE' using errcode = 'P0001'; end if;
    -- A NEW grant: the extension counter starts again (see header).
    update public.user_entitlements
       set plan_tier = 'premium', entitlement_source = 'admin_grant',
           effective_from = v_today, effective_to = p_ends_on,
           admin_grant_ends_on = p_ends_on, reserve_source = 'admin_grant',
           admin_grant_extension_count = 0, promo_code_id = null,
           updated_at = now()
     where user_id = p_target_user_id;

  elsif p_action = 'extend' then
    if v_paid_active then raise exception 'ENTITLEMENT_PAID_ACTIVE' using errcode = 'P0001'; end if;
    if not v_managed_source then raise exception 'ENTITLEMENT_NO_ADMIN_GRANT' using errcode = 'P0001'; end if;
    -- THE EXTENSION CAP.
    if v_row.admin_grant_extension_count >= v_max_ext then raise exception 'ENTITLEMENT_EXTENSION_LIMIT_REACHED' using errcode = 'P0001'; end if;
    if v_managed_active and p_ends_on <= v_row.effective_to then raise exception 'ENTITLEMENT_EXTENSION_NOT_LATER' using errcode = 'P0001'; end if;
    update public.user_entitlements
       set plan_tier = 'premium', entitlement_source = 'admin_grant',
           effective_from = case when v_managed_active then v_row.effective_from else v_today end,
           effective_to = p_ends_on, admin_grant_ends_on = p_ends_on, reserve_source = 'admin_grant',
           admin_grant_extension_count = v_row.admin_grant_extension_count + 1,
           updated_at = now()
     where user_id = p_target_user_id;

  else -- revoke
    if v_managed_source then
      update public.user_entitlements
         set plan_tier = 'free', entitlement_source = 'payment', effective_to = null,
             admin_grant_ends_on = null, reserve_source = null,
             admin_grant_extension_count = 0, promo_code_id = null,
             updated_at = now()
       where user_id = p_target_user_id;
    elsif v_paid_active and v_row.admin_grant_ends_on is not null and v_row.admin_grant_ends_on >= v_today then
      update public.user_entitlements
         set admin_grant_ends_on = null, reserve_source = null, admin_grant_extension_count = 0,
             promo_code_id = null, updated_at = now()
       where user_id = p_target_user_id;
    elsif v_paid_active then raise exception 'ENTITLEMENT_PAID_ACTIVE' using errcode = 'P0001';
    else raise exception 'ENTITLEMENT_NO_ADMIN_GRANT' using errcode = 'P0001';
    end if;
  end if;

  select * into v_after from public.user_entitlements where user_id = p_target_user_id;

  insert into public.admin_entitlement_events (
    action, actor_user_id, target_user_id, reason, requested_ends_on,
    before_plan_tier, before_entitlement_source, before_effective_from, before_effective_to, before_admin_grant_ends_on,
    after_plan_tier, after_entitlement_source, after_effective_from, after_effective_to, after_admin_grant_ends_on,
    extension_count_after
  ) values (
    p_action, v_actor, p_target_user_id, v_reason, case when p_action = 'revoke' then null else p_ends_on end,
    v_row.plan_tier, v_row.entitlement_source, v_row.effective_from, v_row.effective_to, v_row.admin_grant_ends_on,
    v_after.plan_tier, v_after.entitlement_source, v_after.effective_from, v_after.effective_to, v_after.admin_grant_ends_on,
    v_after.admin_grant_extension_count
  ) returning id into v_event_id;

  return jsonb_build_object(
    'audit_id', v_event_id, 'action', p_action, 'target_user_id', p_target_user_id, 'as_of', v_today,
    'plan_tier', v_after.plan_tier, 'entitlement_source', v_after.entitlement_source,
    'effective_from', v_after.effective_from, 'effective_to', v_after.effective_to,
    'admin_grant_ends_on', v_after.admin_grant_ends_on,
    'extension_count', v_after.admin_grant_extension_count,
    'extensions_remaining', greatest(v_max_ext - v_after.admin_grant_extension_count, 0)
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 9. Read functions whose return type changes: drop + recreate (0231 owns them)
-- ---------------------------------------------------------------------------
drop function if exists public.admin_search_premium_entitlement_users(text);
create function public.admin_search_premium_entitlement_users(p_query text)
returns table (
  user_id uuid, email text, plan_tier text, entitlement_source text,
  effective_from date, effective_to date, admin_grant_ends_on date,
  subscription_status text, provider text, entitlement_active boolean,
  extension_count int, extensions_remaining int
)
language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_q text := lower(btrim(coalesce(p_query, '')));
  v_today date := current_date;
  v_max int := public.premium_grant_max_extensions();
begin
  if auth.uid() is null then raise exception 'ENTITLEMENT_UNAUTHENTICATED' using errcode = '42501'; end if;
  if not public.is_premium_entitlement_admin() then raise exception 'ENTITLEMENT_ADMIN_REQUIRED' using errcode = '42501'; end if;
  if char_length(v_q) < 3 then raise exception 'ENTITLEMENT_QUERY_TOO_SHORT' using errcode = '22023'; end if;
  return query
    select u.id, u.email::text, coalesce(e.plan_tier, 'free'), coalesce(e.entitlement_source, 'payment'),
           e.effective_from, e.effective_to, e.admin_grant_ends_on, e.subscription_status, e.provider,
           coalesce(e.plan_tier = 'premium'
                    and (e.effective_from is null or e.effective_from <= v_today)
                    and (e.effective_to   is null or e.effective_to   >= v_today), false),
           coalesce(e.admin_grant_extension_count, 0),
           greatest(v_max - coalesce(e.admin_grant_extension_count, 0), 0)
      from auth.users u
      left join public.user_entitlements e on e.user_id = u.id
     where (v_q ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' and u.id::text = v_q)
        or (strpos(lower(u.email::text), v_q) > 0)
     order by u.email limit 20;
end;
$fn$;
revoke all on function public.admin_search_premium_entitlement_users(text) from public, anon;
grant execute on function public.admin_search_premium_entitlement_users(text) to authenticated;

drop function if exists public.admin_list_premium_grants(text, int);
create function public.admin_list_premium_grants(p_filter text default 'expiring', p_within_days int default 30)
returns table (
  user_id uuid, email text, entitlement_source text, effective_from date, effective_to date,
  days_remaining int, state text, extension_count int, extensions_remaining int
)
language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_today date := current_date;
  v_days int := least(greatest(coalesce(p_within_days, 30), 1), 365);
  v_max int := public.premium_grant_max_extensions();
begin
  if auth.uid() is null then raise exception 'ENTITLEMENT_UNAUTHENTICATED' using errcode = '42501'; end if;
  if not public.is_premium_entitlement_admin() then raise exception 'ENTITLEMENT_ADMIN_REQUIRED' using errcode = '42501'; end if;
  if p_filter is null or p_filter not in ('expiring', 'active', 'lapsed') then raise exception 'ENTITLEMENT_FILTER_INVALID' using errcode = '22023'; end if;
  return query
    select e.user_id, u.email::text, e.entitlement_source, e.effective_from, e.effective_to,
           (e.effective_to - v_today)::int,
           case when e.effective_to < v_today then 'lapsed' else 'active' end,
           e.admin_grant_extension_count, greatest(v_max - e.admin_grant_extension_count, 0)
      from public.user_entitlements e left join auth.users u on u.id = e.user_id
     where e.entitlement_source in ('admin_grant', 'promo_code')
       and e.plan_tier = 'premium' and e.effective_to is not null
       and (
            (p_filter = 'expiring' and e.effective_to >= v_today and e.effective_to <= v_today + v_days
                                   and (e.effective_from is null or e.effective_from <= v_today))
         or (p_filter = 'active'   and e.effective_to >= v_today and (e.effective_from is null or e.effective_from <= v_today))
         or (p_filter = 'lapsed'   and e.effective_to < v_today))
     order by e.effective_to asc, u.email asc limit 200;
end;
$fn$;
revoke all on function public.admin_list_premium_grants(text, int) from public, anon;
grant execute on function public.admin_list_premium_grants(text, int) to authenticated;

-- ---------------------------------------------------------------------------
-- 10. Current-month expiry summary
-- ---------------------------------------------------------------------------
-- bucket 'expired_this_month'  : end date in [first of this month, yesterday]
-- bucket 'expiring_this_month' : end date in [today, last day of this month]
-- Revoked entitlements are not "expired" (they are no longer time-limited rows).
-- A paying customer (source 'payment') never appears, even with a grant in reserve.
create or replace function public.admin_entitlement_expiry_summary(p_source text default null)
returns table (
  user_id uuid, email text, entitlement_source text, effective_to date, days_remaining int,
  bucket text, extension_count int, extensions_remaining int
)
language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_today date := current_date;
  v_month_start date := date_trunc('month', current_date)::date;
  v_month_end date := (date_trunc('month', current_date) + interval '1 month - 1 day')::date;
  v_max int := public.premium_grant_max_extensions();
begin
  if auth.uid() is null then raise exception 'ENTITLEMENT_UNAUTHENTICATED' using errcode = '42501'; end if;
  if not public.is_premium_entitlement_admin() then raise exception 'ENTITLEMENT_ADMIN_REQUIRED' using errcode = '42501'; end if;
  if p_source is not null and p_source not in ('admin_grant', 'promo_code') then raise exception 'ENTITLEMENT_FILTER_INVALID' using errcode = '22023'; end if;
  return query
    select e.user_id, u.email::text, e.entitlement_source, e.effective_to, (e.effective_to - v_today)::int,
           case when e.effective_to < v_today then 'expired_this_month' else 'expiring_this_month' end,
           e.admin_grant_extension_count, greatest(v_max - e.admin_grant_extension_count, 0)
      from public.user_entitlements e left join auth.users u on u.id = e.user_id
     where e.entitlement_source in ('admin_grant', 'promo_code')
       and e.plan_tier = 'premium' and e.effective_to is not null
       and e.effective_to >= v_month_start and e.effective_to <= v_month_end
       and (p_source is null or e.entitlement_source = p_source)
     order by e.effective_to asc, u.email asc limit 1000;
end;
$fn$;
revoke all on function public.admin_entitlement_expiry_summary(text) from public, anon;
grant execute on function public.admin_entitlement_expiry_summary(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 11. Webhook merge: same as 0231, but the reserve is restored with its ORIGINAL source
-- ---------------------------------------------------------------------------
create or replace function public.apply_subscription_entitlement_event(
  p_user_id uuid, p_provider text, p_provider_customer_id text, p_provider_subscription_id text,
  p_confers_premium boolean, p_subscription_status text, p_price_id text,
  p_current_period_end timestamptz, p_cancel_at_period_end boolean
) returns jsonb
language plpgsql security definer set search_path = '' as $fn$
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
    return jsonb_build_object('applied', false, 'reason', 'no_entitlement_row');
  end if;
  v_from := v_row.effective_from;
  v_to   := v_row.effective_to;

  if p_confers_premium then
    v_tier := 'premium'; v_src := 'payment'; v_to := null;
  elsif v_row.admin_grant_ends_on is not null and v_row.admin_grant_ends_on >= v_today then
    v_tier := 'premium';
    v_src  := coalesce(v_row.reserve_source, 'admin_grant');
    v_to   := v_row.admin_grant_ends_on;
    v_from := least(coalesce(v_row.effective_from, v_today), v_today);
    v_restored := true;
  else
    v_tier := 'free'; v_src := 'payment';
  end if;

  update public.user_entitlements
     set plan_tier = v_tier, entitlement_source = v_src, effective_from = v_from, effective_to = v_to,
         provider = p_provider, provider_customer_id = p_provider_customer_id,
         provider_subscription_id = p_provider_subscription_id, subscription_status = p_subscription_status,
         price_id = p_price_id, current_period_end = p_current_period_end,
         cancel_at_period_end = p_cancel_at_period_end, updated_at = now()
   where user_id = p_user_id;

  return jsonb_build_object('applied', true, 'plan_tier', v_tier, 'entitlement_source', v_src, 'admin_grant_restored', v_restored);
end;
$fn$;
