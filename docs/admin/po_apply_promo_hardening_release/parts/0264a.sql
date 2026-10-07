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
