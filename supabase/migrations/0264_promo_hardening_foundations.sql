-- 0264 promo and premium hardening, foundations (part A of D)
-- =============================================================================
-- NEW migration on top of 0263. The applied migrations 0231, 0237, 0238, 0242, 0250, 0251 and 0252 are
-- NOT edited. Every change to an object they created is a new object or a new overload here (nothing they created is dropped by 0264 to 0268).
--
-- WHAT THIS MIGRATION ADDS (item numbers refer to the hardening mission)
--   Item 2  access_end_date() and access_window_days(): one shared definition of an access window whose
--           two ends are both inclusive. A grant of D days starting on R ends on R plus D minus 1.
--   Item 3  a lifetime ceiling per user for admin grants and extensions, a separate capability for the
--           exceptional override, and an append-only record of every override.
--   Item 5  promo_normalise_email(): the SQL half of the one canonical address normalisation contract
--           (the TypeScript half is checked against the same test vector file).
--   Item 1  digest columns on promo_codes (hash only storage), column privileges that hide the plain
--           code and the digest at the API roles.
--   Items 7 and 9 a generic append-only monitoring event table used for alerts.
--
-- NOTHING IS SWITCHED ON. No job is scheduled here. No existing row is changed except the lifetime
-- counter backfill in part C, which is counted out of the existing audit trail.
--
-- EDITOR SAFETY. This file is ASCII only. No comment and no string contains one of the three statement
-- words (insert target, select source, join) followed by a name, because the SQL editor on DEV mis-parsed
-- such text. Hand-run parts A to D in order. Their concatenation is byte-equal to this file (a test proves it).
--
-- MIGRATION NUMBER 0264: highest found on every ref and every worktree was 0263 (NAV2).
-- =============================================================================

create or replace function public.access_end_date(p_start date, p_days int)
returns date
language sql
immutable
set search_path = ''
as $fn$
  select case when p_start is null or p_days is null or p_days < 1 then null else p_start + (p_days - 1) end;
$fn$;
comment on function public.access_end_date(date, int) is
  'Hardening 0264 item 2: the last day of an access window that starts on p_start and lasts p_days calendar days when BOTH ends are inclusive. 30 days from 2024-02-28 ends on 2024-03-28. Mirrored by accessEndDate in lib/services/entitlementWindow.ts.';
revoke all on function public.access_end_date(date, int) from public, anon;
grant execute on function public.access_end_date(date, int) to authenticated, service_role;

create or replace function public.access_window_days(p_from date, p_to date)
returns int
language sql
immutable
set search_path = ''
as $fn$
  select case when p_from is null or p_to is null then null else (p_to - p_from) + 1 end;
$fn$;
comment on function public.access_window_days(date, date) is
  'Hardening 0264 item 2: the length in calendar days of an inclusive window. The inverse of access_end_date.';
revoke all on function public.access_window_days(date, date) from public, anon;
grant execute on function public.access_window_days(date, date) to authenticated, service_role;

-- Canonical address normalisation: trim ASCII whitespace, lower case the ASCII letters A to Z only.
-- No other rewriting: no dot removal, no plus tag removal, no unicode folding.
create or replace function public.promo_normalise_email(p text)
returns text
language sql
immutable
set search_path = ''
as $fn$
  select translate(btrim(coalesce(p, ''), E' \t\r\n'), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz');
$fn$;
comment on function public.promo_normalise_email(text) is
  'Hardening 0264 item 5: the canonical address normalisation contract. Trim space, tab, CR and LF at both ends and lower case ASCII letters only. Mirrored by normaliseEmailAddress in lib/services/emailAddressContract.ts and checked against tests/fixtures/email-normalisation-vectors.json.';
revoke all on function public.promo_normalise_email(text) from public, anon;
grant execute on function public.promo_normalise_email(text) to authenticated, service_role;

-- Lifetime ceiling: admin grants plus extensions per user, never reset by a revoke.
create or replace function public.premium_grant_lifetime_ceiling()
returns int
language sql
immutable
set search_path = ''
as $fn$ select 10; $fn$;
comment on function public.premium_grant_lifetime_ceiling() is
  'Hardening 0264 item 3: the most admin grant and extend actions one user can ever receive. Mirrored by PREMIUM_GRANT_LIFETIME_CEILING in lib/services/premiumGrantAdmin.ts (a test asserts they agree). Going past it needs the separate override capability.';
revoke all on function public.premium_grant_lifetime_ceiling() from public, anon;
grant execute on function public.premium_grant_lifetime_ceiling() to authenticated, service_role;

-- Separate capability for the exceptional override. Not implied by any role, not implied by the two
-- existing capabilities, not granted by this migration to anyone.
alter table public.admin_users add column if not exists can_override_entitlement_limits boolean not null default false;
comment on column public.admin_users.can_override_entitlement_limits is
  'Hardening 0264 item 3: separately named capability that allows a grant or extension past the per grant cap or the lifetime ceiling, with a mandatory reason of 20 or more characters, an alert event and an audit row. NOT implied by Super Admin, by admin_users membership, by can_manage_premium_entitlements or by can_manage_promo_codes (Standard sections 2 and 3). The override call also needs can_manage_premium_entitlements.';

create or replace function public.is_entitlement_override_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1 from public.admin_users
    where admin_users.user_id = auth.uid() and admin_users.can_override_entitlement_limits = true
  );
$fn$;
revoke all on function public.is_entitlement_override_admin() from public, anon;
grant execute on function public.is_entitlement_override_admin() to authenticated;
-- ---------------------------------------------------------------------------
-- PART B starts here: append-only monitoring events and the override record
-- ---------------------------------------------------------------------------

create or replace function public.promo_hardening_append_only()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  raise exception 'this table is append-only' using errcode = '42501', detail = tg_op;
end;
$fn$;

-- Generic alert and monitoring rows. No address, no code and no secret is ever written here.
-- The event type is shape checked rather than listed, so a later feature adds a type without any
-- constraint change.
create table if not exists public.admin_monitoring_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  event_type text not null check (event_type ~ '^[a-z][a-z_]{2,59}$'),
  severity text not null default 'info' check (severity in ('info', 'warning', 'high')),
  actor_user_id uuid,
  details jsonb not null default '{}'::jsonb,
  dedupe_key text check (dedupe_key is null or char_length(dedupe_key) <= 200)
);
create unique index if not exists uq_admin_monitoring_dedupe on public.admin_monitoring_events (dedupe_key) where dedupe_key is not null;
create index if not exists idx_admin_monitoring_type_time on public.admin_monitoring_events (event_type, created_at desc);
comment on table public.admin_monitoring_events is
  'Hardening 0264: append-only alert and monitoring rows (promo e-mail volume, circuit breaker, limit overrides, retention runs). Carries counts, ids and flags only. Never an address, a code or a secret.';

drop trigger if exists trg_admin_monitoring_no_change on public.admin_monitoring_events;
create trigger trg_admin_monitoring_no_change before update or delete on public.admin_monitoring_events
  for each row execute function public.promo_hardening_append_only();
drop trigger if exists trg_admin_monitoring_no_truncate on public.admin_monitoring_events;
create trigger trg_admin_monitoring_no_truncate before truncate on public.admin_monitoring_events
  for each statement execute function public.promo_hardening_append_only();
alter table public.admin_monitoring_events enable row level security;
revoke all on public.admin_monitoring_events from anon, authenticated;

-- Every override of the per grant cap or the lifetime ceiling leaves one row here.
create table if not exists public.premium_entitlement_overrides (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  actor_user_id uuid not null,
  target_user_id uuid not null,
  action text not null check (action in ('grant', 'extend')),
  limit_hit text not null check (limit_hit in ('lifetime_ceiling', 'extension_cap', 'both')),
  reason text not null check (char_length(btrim(reason)) >= 20 and char_length(reason) <= 1000),
  units_before int not null,
  units_after int not null,
  extension_count_before int not null,
  requested_ends_on date not null
);
create index if not exists idx_premium_overrides_target on public.premium_entitlement_overrides (target_user_id, created_at desc);
comment on table public.premium_entitlement_overrides is
  'Hardening 0264 item 3: append-only record of every grant or extension that went past the per grant cap or the lifetime ceiling. Written only inside admin_manage_premium_entitlement with the override flag.';
drop trigger if exists trg_premium_overrides_no_change on public.premium_entitlement_overrides;
create trigger trg_premium_overrides_no_change before update or delete on public.premium_entitlement_overrides
  for each row execute function public.promo_hardening_append_only();
drop trigger if exists trg_premium_overrides_no_truncate on public.premium_entitlement_overrides;
create trigger trg_premium_overrides_no_truncate before truncate on public.premium_entitlement_overrides
  for each statement execute function public.promo_hardening_append_only();
alter table public.premium_entitlement_overrides enable row level security;
drop policy if exists entitlement_admin_reads_overrides on public.premium_entitlement_overrides;
create policy entitlement_admin_reads_overrides on public.premium_entitlement_overrides
  for select using (public.is_premium_entitlement_admin());
revoke all on public.premium_entitlement_overrides from anon, authenticated;
grant select on public.premium_entitlement_overrides to authenticated;

-- Read the latest alerts. Either capability may look. Nobody can write through the API.
create or replace function public.admin_list_monitoring_events(p_limit int default 100)
returns table (id uuid, created_at timestamptz, event_type text, severity text, actor_user_id uuid, details jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $fn$
begin
  if auth.uid() is null then raise exception 'PROMO_UNAUTHENTICATED' using errcode = '42501'; end if;
  if not (public.is_promo_code_admin() or public.is_premium_entitlement_admin()) then
    raise exception 'PROMO_ADMIN_REQUIRED' using errcode = '42501';
  end if;
  return query
    select e.id, e.created_at, e.event_type, e.severity, e.actor_user_id, e.details
      from public.admin_monitoring_events e
     order by e.created_at desc, e.id desc
     limit least(greatest(coalesce(p_limit, 100), 1), 500);
end;
$fn$;
revoke all on function public.admin_list_monitoring_events(int) from public, anon;
grant execute on function public.admin_list_monitoring_events(int) to authenticated;
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
-- ---------------------------------------------------------------------------
-- PART D starts here: hash only promo codes, columns and privileges
-- ---------------------------------------------------------------------------
-- Design (PO ruling, item 1): a code is looked up by a keyed digest (HMAC SHA 256 with a dedicated
-- versioned secret that never reaches the database). The plain code column stays for the migration window
-- only: part by part the backfill script digests every existing row, verifies the copy, and the finalise
-- function then blanks the plain value for verified rows. New codes never store a plain value.

alter table public.promo_codes add column if not exists code_digest text;
alter table public.promo_codes add column if not exists code_digest_version int;
alter table public.promo_codes add column if not exists code_digest_verified_at timestamptz;
alter table public.promo_codes add column if not exists anonymised_at timestamptz;
alter table public.promo_codes alter column code drop not null;

do $fn$
begin
  if not exists (select 1 from pg_constraint where conname = 'promo_codes_digest_shape' and conrelid = 'public.promo_codes'::regclass) then
    alter table public.promo_codes add constraint promo_codes_digest_shape
      check (code_digest is null or (code_digest ~ '^[0-9a-f]{64}$' and code_digest_version is not null and code_digest_version >= 1));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'promo_codes_has_identity' and conrelid = 'public.promo_codes'::regclass) then
    alter table public.promo_codes add constraint promo_codes_has_identity
      check (code is not null or code_digest is not null or anonymised_at is not null);
  end if;
end $fn$;

create unique index if not exists uq_promo_codes_digest on public.promo_codes (code_digest) where code_digest is not null;

comment on column public.promo_codes.code is
  'Hardening 0264: LEGACY plain code. Null for every code created after 0264 and blanked by promo_codes_finalise_hash_only() once the digest copy is verified. Not readable by API roles.';
comment on column public.promo_codes.code_digest is
  'Hardening 0264 item 1: hex HMAC SHA 256 of the normalised code under the versioned PROMO_CODE_DIGEST_SECRET (domain prefix promo-code:v then the version). The secret never reaches the database. Not readable by API roles.';
comment on column public.promo_codes.code_digest_version is
  'Hardening 0264 item 1: which key version produced code_digest. Used for the dual verify window during key rotation.';
comment on column public.promo_codes.code_digest_verified_at is
  'Hardening 0264 item 1: set only by the backfill script after it recomputed the digest of the plain value and compared. Required before the plain value can be blanked.';
comment on column public.promo_codes.anonymised_at is
  'Hardening 0264 item 7: set by the retention job when an old disabled or expired code was stripped of its note and digest. The row stays for the audit trail.';

-- API roles must not read the plain code, the digest or the bound address hash through the table.
-- (The admin functions are SECURITY DEFINER and are unaffected.)
revoke select on public.promo_codes from anon, authenticated;
grant select (id, code_hint, duration_days, max_redemptions, redemption_count, expires_on, note, status, created_by,
              created_at, disabled_by, disabled_at, disable_reason, anonymised_at)
  on public.promo_codes to authenticated;
