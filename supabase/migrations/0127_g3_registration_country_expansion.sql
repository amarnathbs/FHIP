-- =============================================================================
-- G3 — Registration and Existing-User Alignment
--
-- Extends REGISTRATION eligibility from the two FULL-experience countries
-- (AU, IN) to the four GENERIC-experience countries the G1 registry already
-- describes (GB, US, SG, AE), WITHOUT weakening the production-certified
-- Mandatory Country Confirmation (MCC) backstop and WITHOUT releasing
-- generic-experience users into AU/IN domestic functionality before G4's
-- capability layer exists.
--
-- THE CENTRAL DESIGN DECISION OF THIS MIGRATION
-- ---------------------------------------------
-- MCC's `is_country_confirmed()` (migration 0104) joins `countries.is_supported`
-- and backs the ~85-table trigger backstop. G1 (0122) deliberately seeded
-- GB/US/SG/AE with `is_supported = false`, so today those countries cannot be
-- confirmed at all.
--
-- The naive way to allow GB/US/SG/AE registration would be to flip
-- `is_supported` to true. That is REJECTED here: it would, in one statement,
-- grant generic-experience users write access to all ~85 financial tables --
-- exactly the "generic country inherits AU/IN domestic treatment" outcome G3
-- must prevent, and precisely what G4 has not yet certified.
--
-- Instead this migration introduces a SECOND, STRICTLY WEAKER predicate and
-- keeps the two tiers permanently distinct:
--
--   TIER 1  is_country_registration_confirmed(user)  -- NEW, weaker
--           "this user has explicitly confirmed a residence country that the
--            registry currently permits REGISTRATION for"
--           Backs only: cross_border_relationships, country_change_previews.
--
--   TIER 2  is_country_confirmed(user)               -- EXISTING, unchanged
--           "...AND that country is `is_supported`, i.e. FULL experience"
--           Backs: all ~85 financial tables (0104/0105/0108/0111). UNTOUCHED.
--
-- `countries.is_supported` therefore keeps its established meaning verbatim
-- ("residents of this country may hold financial data here") and stays
-- true for AU/IN only. The consequence is that the interim pre-G4 boundary
-- required by the G3 specification section 10 is enforced BY THE DATABASE,
-- for free, on every one of the ~85 tables, rather than by application code
-- that a forged PostgREST request could route around. A GB user who somehow
-- reached /api/assets directly would still be rejected with
-- COUNTRY_CONFIRMATION_REQUIRED (42501) by the pre-existing 0104 trigger.
--
-- WHAT THIS MIGRATION DOES NOT DO
-- --------------------------------
--   * Does not change is_country_confirmed() or any of its ~85 triggers.
--   * Never enables the financial-eligibility flag for any country -- that
--     column is not written anywhere in this file. (Deliberately phrased
--     without the literal assignment text, so that the automated guard in
--     tests/unit/g3RegistrationAlignment.test.ts, which asserts this file
--     contains no such assignment, cannot be defeated by its own comment.)
--   * Does not add, rename or remove a country row (all six already exist
--     from 0001/0122).
--   * Does not backfill, reset or read preferred_currency.
--   * Does not touch billing_country / billing_country_confirmed_at.
--   * Does not modify any financial table, FX row or report snapshot.
--   * Does not alter a single existing AU/IN user's row (the two UPDATE
--     statements below are capability-registry rows and additive column
--     defaults only -- no user row is written).
--
-- Replay-safe: every statement is guarded (if not exists / on conflict /
-- drop-if-exists-then-create / create or replace), matching this
-- repository's established convention.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Structural guard: 'GLOBAL'-style pseudo-buckets can never become countries
-- -----------------------------------------------------------------------------
-- `countries.country_code` is already char(2), so the literal string 'GLOBAL'
-- (6 chars) has never been storable -- tests/unit/g2GlobalNotACountry.test.ts
-- proves that by reading migrations 0001/0104/0122 directly, and every
-- authoritative country column (user_profiles.country_of_residence,
-- .primary_country, .billing_country, cross_border_relationships.country_code)
-- is a char(2) FK to this table.
--
-- What was NOT previously prevented is a future migration seeding a
-- TWO-letter catch-all bucket -- 'XX', 'ZZ', 'QQ' -- and calling it "rest of
-- world". G3 section 5.1 forbids exactly that ("Do not add a database country
-- called GLOBAL, OTHER, INTERNATIONAL, REST_OF_WORLD"). This constraint makes
-- that structurally impossible rather than a convention someone must remember.
--
-- 'XX' and 'ZZ' are the ISO 3166-1 user-assigned/"unknown" placeholders;
-- 'QM'-'QZ' and 'AA' are the other user-assignable ranges. None is a real
-- country, so none can ever be a legitimate residence.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'countries_country_code_is_real_iso_check'
  ) then
    alter table countries add constraint countries_country_code_is_real_iso_check
      check (
        country_code ~ '^[A-Z]{2}$'
        and country_code not in ('XX', 'ZZ', 'AA', 'QM', 'QN', 'QO', 'QP', 'QQ', 'QR', 'QS', 'QT', 'QU', 'QV', 'QW', 'QX', 'QY', 'QZ')
      );
  end if;
end$$;

comment on constraint countries_country_code_is_real_iso_check on countries is
  'G3 section 5.1: the countries registry may only ever hold genuine, uppercase two-letter ISO 3166-1 alpha-2 codes. Rejects the ISO user-assigned/unknown placeholder ranges (XX, ZZ, AA, QM-QZ) so no future migration can seed a GLOBAL/OTHER/REST_OF_WORLD catch-all bucket as if it were a country. ''GLOBAL'' itself was already unstorable (char(2)); this closes the two-letter variant of the same mistake.';

-- -----------------------------------------------------------------------------
-- 2. REGISTRATION capability for the four GENERIC countries
-- -----------------------------------------------------------------------------
-- country_capabilities is the registry G3 section 6.3 requires the server to
-- derive registration permission from. G1 seeded REGISTRATION = true for AU/IN
-- and false for GB/US/SG/AE. This is the ONE authoritative row change that
-- opens generic registration -- nothing else in this migration grants access.
--
-- Every OTHER capability for these four countries stays exactly as G1 left it
-- (UNIVERSAL_MODULES and CROSS_BORDER_RELATIONSHIPS true; the other eleven --
-- including DOMESTIC_CALCULATIONS, DOMESTIC_RETIREMENT, DOMESTIC_TAX_OUTPUTS,
-- APPROVED_BILLING, APPROVED_PRICING, FX_CONVERSION, REGULATORY_GUIDANCE --
-- false). No AU or IN capability row is touched by this migration at all.
insert into country_capabilities (country_code, capability, enabled)
values
  ('GB', 'REGISTRATION', true),
  ('US', 'REGISTRATION', true),
  ('SG', 'REGISTRATION', true),
  ('AE', 'REGISTRATION', true)
on conflict (country_code, capability) do update set
  enabled = excluded.enabled,
  updated_at = now();

-- -----------------------------------------------------------------------------
-- 3. Generic-disclosure acknowledgement (G3 section 7.2)
-- -----------------------------------------------------------------------------
-- "Require explicit acknowledgement before confirming a GENERIC country.
--  Record the disclosure version acknowledged, timestamp and user. Do not
--  place acceptance only in an unstructured client event... Use the existing
--  audit architecture and the smallest appropriate durable record."
--
-- The smallest appropriate DURABLE record is three additive columns on the
-- row that already owns country confirmation, not a new table with its own
-- RLS surface. The audit trail is the existing audit_events table (written
-- by lib/services/countryAudit.ts through the service-role client).
--
-- generic_disclosure_country is stored SEPARATELY from country_of_residence
-- on purpose: it pins the acknowledgement to the exact country it was shown
-- for, so a user who acknowledges for GB and later switches to US cannot
-- carry a stale acknowledgement across (see the trigger in section 4).
alter table user_profiles add column if not exists generic_disclosure_version text;
alter table user_profiles add column if not exists generic_disclosure_acknowledged_at timestamptz;
alter table user_profiles add column if not exists generic_disclosure_country char(2);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'user_profiles_generic_disclosure_country_fkey') then
    alter table user_profiles add constraint user_profiles_generic_disclosure_country_fkey
      foreign key (generic_disclosure_country) references countries(country_code);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'user_profiles_generic_disclosure_complete_check') then
    -- All three fields travel together or none do -- a version with no
    -- timestamp (or vice versa) is not an acknowledgement.
    alter table user_profiles add constraint user_profiles_generic_disclosure_complete_check
      check (
        (generic_disclosure_version is null
          and generic_disclosure_acknowledged_at is null
          and generic_disclosure_country is null)
        or
        (generic_disclosure_version is not null
          and generic_disclosure_acknowledged_at is not null
          and generic_disclosure_country is not null)
      );
  end if;
end$$;

comment on column user_profiles.generic_disclosure_version is
  'G3 section 7.2: the exact FULL/GENERIC coverage-disclosure version string the user explicitly acknowledged before a GENERIC residence country was confirmed. NULL for every FULL-experience (AU/IN) user -- the disclosure does not apply to them.';
comment on column user_profiles.generic_disclosure_acknowledged_at is
  'G3 section 7.2: when the generic-coverage disclosure was acknowledged. Always computed server-side (never client-supplied).';
comment on column user_profiles.generic_disclosure_country is
  'G3 section 7.2: the country the acknowledgement was shown FOR. Deliberately not assumed equal to country_of_residence so a stale acknowledgement cannot be carried across a country change -- trg_enforce_generic_disclosure re-checks the match on every write.';

-- -----------------------------------------------------------------------------
-- 3b. The reporting currency is AUD or INR — enforced by the database
-- -----------------------------------------------------------------------------
-- FOUND BY THIS PHASE'S OWN CERTIFICATION, not assumed.
--
-- user_profiles.preferred_currency is char(3) with an FK to currencies
-- (migration 0001). Until G1, that FK genuinely constrained it to AUD/INR,
-- because those were the only two rows in `currencies`. G1 (migration 0122)
-- then inserted GBP, USD, SGD and AED as descriptive reference rows for the
-- four new countries -- and in doing so silently widened what this column
-- could physically hold, from two values to six.
--
-- Nothing in the application does that: lib/validation/profile.ts's
-- z.enum(['AUD','INR']) rejects the other four. But user_profiles has an
-- owner RLS policy, so an authenticated client can PATCH its own row
-- directly through PostgREST, bypassing the route and its schema entirely.
-- The live PGlite certification for this phase did exactly that and the
-- write SUCCEEDED -- setting preferred_currency = 'USD' for a real user.
--
-- That matters because FHIP has no certified FX support for those currencies
-- (lib/engines/fx.ts's SupportedCurrency is 'AUD' | 'INR' only). A profile
-- carrying 'USD' would make every downstream total either fabricate a
-- conversion or mislabel an unconverted figure -- precisely what G3 section
-- 8.2 forbids ("Unsupported conversions must be disclosed rather than
-- fabricated").
--
-- Scoped deliberately to the REPORTING currency only. The per-record
-- currency columns (income_sources.currency_code and friends) are a
-- different concept with a different owner and are not touched here.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'user_profiles_preferred_currency_supported_check') then
    alter table user_profiles add constraint user_profiles_preferred_currency_supported_check
      check (preferred_currency is null or preferred_currency in ('AUD', 'INR'));
  end if;
end$$;

comment on constraint user_profiles_preferred_currency_supported_check on user_profiles is
  'G3 section 8.1/8.2: the user''s reporting currency may only ever be AUD or INR -- the two currencies lib/engines/fx.ts actually supports. The pre-existing FK to currencies stopped being sufficient when G1 (migration 0122) added GBP/USD/SGD/AED reference rows for the four new countries, which widened this column from two permitted values to six without anyone intending it. Enforced here rather than only in Zod because user_profiles carries an owner RLS policy, so a direct PostgREST write can reach this column without passing through any route.';

-- -----------------------------------------------------------------------------
-- 4. A GENERIC country cannot be confirmed without a matching acknowledgement
-- -----------------------------------------------------------------------------
-- This is the enforcement half of section 7.2, and it is deliberately at the
-- DATABASE layer rather than only in the confirm route. app/api/user/profile
-- (PUT) is intentionally NOT country-gated (it must stay reachable to fix an
-- unsupported country), and user_profiles has an owner RLS policy, so an
-- authenticated client can PATCH its own profile row directly through
-- PostgREST. Without this trigger, such a client could set
-- country_of_residence = 'GB' + country_confirmed_at = now() and obtain a
-- confirmed generic residence having never been shown the disclosure.
--
-- Fails CLOSED by construction: the acknowledgement must exist, must name the
-- same country being confirmed, and must carry a version string.
create or replace function public.enforce_generic_disclosure_acknowledgement()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_experience text;
begin
  -- Not a confirmed country yet -> nothing to enforce. (An unconfirmed
  -- generic country is simply "not confirmed"; MCC already blocks it.)
  if new.country_confirmed_at is null or new.country_of_residence is null then
    return new;
  end if;

  select c.experience_level into v_experience
  from countries c
  where c.country_code = new.country_of_residence;

  -- Unknown/absent registry row: not this trigger's failure mode -- the
  -- pre-existing FK on country_of_residence already makes it impossible.
  if v_experience is distinct from 'GENERIC' then
    return new;
  end if;

  if new.generic_disclosure_acknowledged_at is null
     or new.generic_disclosure_version is null
     or new.generic_disclosure_country is distinct from new.country_of_residence then
    raise exception
      'GENERIC_DISCLOSURE_ACKNOWLEDGEMENT_REQUIRED: country % has GENERIC experience level and cannot be confirmed without an explicit, matching coverage-disclosure acknowledgement',
      new.country_of_residence
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.enforce_generic_disclosure_acknowledgement() is
  'G3 section 7.2 database-level enforcement: a GENERIC-experience residence country can never be marked confirmed unless the same row carries a coverage-disclosure acknowledgement (version + timestamp) recorded for that exact country. Deliberately applies to service_role as well as authenticated writers -- there is no legitimate path, background job included, that should confirm a generic residence without the disclosure, and exempting service_role would leave the forgeable PostgREST path as the only thing this guards.';

drop trigger if exists trg_enforce_generic_disclosure on user_profiles;
create trigger trg_enforce_generic_disclosure
  before insert or update on user_profiles
  for each row execute function public.enforce_generic_disclosure_acknowledgement();

-- -----------------------------------------------------------------------------
-- 5. TIER 1 predicate: registration-level (not financial-level) confirmation
-- -----------------------------------------------------------------------------
-- Strictly weaker than is_country_confirmed(): it does NOT require
-- is_supported. It requires exactly what G3 section 6.3 says the server must
-- verify -- the country exists, is active, is inside its effective window, is
-- selectable, and the registry currently enables REGISTRATION for it -- plus
-- MCC's own non-negotiable requirement that confirmation be explicit
-- (country_confirmed_at is not null).
--
-- Note what is absent: no currency input, no locale input, no IP input, no
-- landing-cookie input, no client-supplied experience level. The only inputs
-- are the user's own confirmed profile row and the registry.
create or replace function public.is_country_registration_eligible(p_country_code char(2))
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from countries c
    join country_capabilities cc
      on cc.country_code = c.country_code
     and cc.capability = 'REGISTRATION'
     and cc.enabled
    where c.country_code = p_country_code
      and c.active
      and c.selectable
      and c.effective_from <= now()
      and (c.effective_to is null or c.effective_to > now())
  );
$$;

comment on function public.is_country_registration_eligible(char) is
  'G3 section 6.3: is this country one the registry currently permits registration for? Registry-derived only (countries.active/selectable/effective window + country_capabilities.REGISTRATION). Never consults currency, locale, IP or any client-supplied value. Strictly weaker than is_country_confirmed() -- being registration-eligible does NOT imply financial-data eligibility.';

create or replace function public.is_country_registration_confirmed(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from user_profiles up
    where up.user_id = p_user_id
      and up.country_confirmed_at is not null
      and up.country_of_residence is not null
      and public.is_country_registration_eligible(up.country_of_residence)
  );
$$;

comment on function public.is_country_registration_confirmed(uuid) is
  'G3 TIER 1 predicate. True when the user has explicitly confirmed a residence country the registry currently permits registration for -- INCLUDING the GENERIC countries (GB/US/SG/AE), which is_country_confirmed() deliberately still rejects. Backs only the two non-financial G1 tables (cross_border_relationships, country_change_previews). Never used by, and never weakens, the ~85-table financial backstop.';

-- -----------------------------------------------------------------------------
-- 6. TIER 1 trigger function
-- -----------------------------------------------------------------------------
-- A deliberate structural mirror of enforce_country_confirmed() as migration
-- 0111 left it -- same service_role bypass, same MCC-14 account-deletion
-- cascade exemption, same errcode -- differing in exactly one line: which
-- predicate it calls. Written as its own function rather than parameterising
-- the existing one so that the ~85-table financial backstop's definition is
-- byte-for-byte untouched by this migration.
create or replace function public.enforce_country_confirmed_registration()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
begin
  if TG_OP = 'DELETE' then v_user_id := old.user_id; else v_user_id := new.user_id; end if;

  if auth.role() = 'service_role' then
    if TG_OP = 'DELETE' then return old; else return new; end if;
  end if;

  -- MCC-14 (migration 0111): a DELETE whose owning auth.users row is already
  -- gone is part of that account's own deletion cascade, not an end-user
  -- write. Checked BEFORE the predicate, which reads user_profiles -- the
  -- exact table whose cascade ordering MCC-14 exploited.
  if TG_OP = 'DELETE' and not public._mcc_auth_user_exists(v_user_id) then
    return old;
  end if;

  if not public.is_country_registration_confirmed(v_user_id) then
    raise exception 'COUNTRY_CONFIRMATION_REQUIRED: user % has not confirmed a registration-eligible country of residence', v_user_id
      using errcode = '42501';
  end if;

  if TG_OP = 'DELETE' then return old; else return new; end if;
end;
$$;

comment on function public.enforce_country_confirmed_registration() is
  'G3 TIER 1 backstop for the two non-financial G1 tables only. Identical in structure to enforce_country_confirmed() (0104/0108/0111) -- service_role bypass, MCC-14 deletion-cascade exemption, errcode 42501 -- except that it gates on is_country_registration_confirmed() so a GENERIC-country user can declare cross-border relationships and preview a country change, which G3 sections 9 and 10 require. It is NEVER applied to a financial table.';

-- -----------------------------------------------------------------------------
-- 7. Repoint exactly two triggers (and no others) onto TIER 1
-- -----------------------------------------------------------------------------
-- These two tables were given trg_enforce_country_confirmed by migration 0122
-- (G1). Neither holds financial data:
--   * cross_border_relationships -- a DECLARATION of a foreign connection.
--     G3 section 9 is explicit that G3 collects the declaration only and
--     performs no cross-border calculation (that is G6).
--   * country_change_previews -- a 15-minute, single-use preview row consumed
--     by confirm_primary_country_change(). Read-only in effect.
--
-- The financial backstop tables are not enumerated here at all; their
-- triggers are not dropped, recreated or referenced by this migration.
drop trigger if exists trg_enforce_country_confirmed on cross_border_relationships;
drop trigger if exists trg_enforce_country_confirmed_registration on cross_border_relationships;
create trigger trg_enforce_country_confirmed_registration
  before insert on cross_border_relationships
  for each row execute function public.enforce_country_confirmed_registration();

drop trigger if exists trg_enforce_country_confirmed on country_change_previews;
drop trigger if exists trg_enforce_country_confirmed_registration on country_change_previews;
create trigger trg_enforce_country_confirmed_registration
  before insert on country_change_previews
  for each row execute function public.enforce_country_confirmed_registration();

-- -----------------------------------------------------------------------------
-- 8. Cross-border declarations may not name the user's own residence
-- -----------------------------------------------------------------------------
-- G3 section 9: "Prevent selecting the same country as the user's residence
-- where that relationship would be meaningless." A CHECK cannot reach another
-- table, so this is a trigger. It also re-validates the declared country
-- against the registry, so a forged PostgREST insert cannot declare a
-- relationship with a country the registry does not currently offer.
create or replace function public.enforce_cross_border_country_is_foreign()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_residence char(2);
begin
  select up.country_of_residence into v_residence
  from user_profiles up
  where up.user_id = new.user_id;

  if v_residence is not null and new.country_code = v_residence then
    raise exception
      'CROSS_BORDER_COUNTRY_IS_RESIDENCE: % is this user''s own country of residence; a cross-border relationship with it carries no meaning',
      new.country_code
      using errcode = '22023';
  end if;

  -- Registry availability is checked on INSERT only, deliberately. If a
  -- country were ever withdrawn from the registry, a user must still be able
  -- to END an existing declaration for it (an UPDATE setting status='ENDED');
  -- re-validating on UPDATE would trap them with an undeletable row.
  if TG_OP = 'INSERT' and not public.is_country_registration_eligible(new.country_code) then
    raise exception
      'CROSS_BORDER_COUNTRY_NOT_AVAILABLE: % is not a country this release offers cross-border declarations for',
      new.country_code
      using errcode = '22023';
  end if;

  return new;
end;
$$;

comment on function public.enforce_cross_border_country_is_foreign() is
  'G3 section 9: a declared cross-border country must be a genuinely foreign, registry-offered country. Rejects self-referential declarations (country_code = own country_of_residence) and any country the registry does not currently make available. Applies to service_role too -- a self-referential declaration is meaningless data regardless of who writes it. Purely a validity guard: it grants nothing and never changes residence, primary country, billing country or currency.';

drop trigger if exists trg_enforce_cross_border_country_is_foreign on cross_border_relationships;
create trigger trg_enforce_cross_border_country_is_foreign
  before insert or update on cross_border_relationships
  for each row execute function public.enforce_cross_border_country_is_foreign();

-- -----------------------------------------------------------------------------
-- 9. Confirmation becomes a controlled workflow (closes G3-R5)
-- -----------------------------------------------------------------------------
-- THE PROBLEM THIS CLOSES
--
-- Until now, country confirmation was written by the API route using the
-- CALLER'S OWN Supabase client. user_profiles carries an owner RLS policy
-- (auth.uid() = user_id), so an authenticated client could PATCH its own row
-- directly through PostgREST and set country_of_residence,
-- country_confirmed_at, country_source AND the three generic_disclosure_*
-- columns together — obtaining a confirmed GENERIC residence carrying a
-- self-asserted acknowledgement it had never been shown, and, critically,
-- WITHOUT the audit event. Section 4's trigger forced an acknowledgement row
-- to exist, but could not force it to be genuine or to be accompanied by an
-- audit record, because a BEFORE trigger on user_profiles cannot see whether
-- some other statement will write to audit_events.
--
-- Migration 0122 already solved the identical problem for primary/billing
-- country: a SECURITY DEFINER RPC sets a transaction-local GUC immediately
-- before its own UPDATE, and a trigger rejects any change to those columns
-- that did not arrive that way. This section applies that same, already
-- proven pattern to residence confirmation, and goes one step further by
-- making the audit event part of the SAME TRANSACTION as the profile write —
-- so a stored acknowledgement without its audit event is not merely
-- discouraged, it is unreachable.
--
-- WHY THE GUARD EXEMPTS NON-'authenticated' CALLERS
--
-- The threat is an authenticated browser/API client writing directly through
-- PostgREST under RLS. A migration, a psql session, a background job or a
-- service-role caller is already inside the trust boundary and is exempted
-- explicitly, exactly as MCC's enforce_country_confirmed() and G1's
-- enforce_controlled_country_columns() both do. In real Supabase, PostgREST
-- always stamps a role claim on an end-user request, so this fires precisely
-- where it must.

create or replace function public.confirm_country_of_residence(
  p_country_code char(2),
  p_disclosure_version text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_experience text;
  v_existing user_profiles%rowtype;
  v_now timestamptz := now();
begin
  if v_user is null then
    raise exception 'UNAUTHENTICATED' using errcode = '42501';
  end if;

  -- Registry authority. Never a client-supplied experience level, and never
  -- inferred from currency, locale, IP or a landing cookie -- none of which
  -- this function even accepts as a parameter.
  if not public.is_country_registration_eligible(p_country_code) then
    raise exception 'COUNTRY_REGISTRATION_NOT_PERMITTED: % is not a country this release accepts registrations for', p_country_code
      using errcode = '42501';
  end if;

  select c.experience_level into v_experience from countries c where c.country_code = p_country_code;

  if v_experience = 'GENERIC' and coalesce(p_disclosure_version, '') = '' then
    raise exception 'GENERIC_DISCLOSURE_ACKNOWLEDGEMENT_REQUIRED: country % has GENERIC experience level and cannot be confirmed without an explicit coverage-disclosure acknowledgement', p_country_code
      using errcode = '42501';
  end if;

  select * into v_existing from user_profiles where user_id = v_user;
  if not found then
    raise exception 'PROFILE_INCOMPLETE' using errcode = '42501';
  end if;

  -- Idempotent replay (spec section 6.3, scenario G3-25). Same country,
  -- already confirmed, and -- for a generic country -- the stored
  -- acknowledgement already matches this version FOR THIS COUNTRY. Nothing
  -- changes and NO second audit event is written.
  if v_existing.country_confirmed_at is not null
     and v_existing.country_of_residence = p_country_code
     and (v_experience is distinct from 'GENERIC'
          or (v_existing.generic_disclosure_version = p_disclosure_version
              and v_existing.generic_disclosure_country = p_country_code))
  then
    return jsonb_build_object(
      'country_of_residence', v_existing.country_of_residence,
      'country_confirmed_at', v_existing.country_confirmed_at,
      'country_source', v_existing.country_source,
      'generic_disclosure_version', v_existing.generic_disclosure_version,
      'experience_level', v_experience,
      'idempotent_replay', true
    );
  end if;

  -- Transaction-local (is_local = true), so it resets at transaction end and
  -- can never leak into a later statement. Not reachable by an ordinary
  -- PostgREST client: set_config() lives in pg_catalog and is never exposed
  -- as an RPC endpoint (only functions in the exposed `public` schema are).
  perform set_config('fhip.controlled_country_confirmation', 'on', true);

  update user_profiles set
    country_of_residence = p_country_code,
    country_confirmed_at = v_now,
    country_source = 'USER_CONFIRMED',
    country_updated_at = v_now,
    updated_at = v_now,
    -- Confirming a FULL country CLEARS any acknowledgement left over from a
    -- previous generic country, so no stale record survives that no longer
    -- describes anything true about this account.
    generic_disclosure_version = case when v_experience = 'GENERIC' then p_disclosure_version end,
    generic_disclosure_acknowledged_at = case when v_experience = 'GENERIC' then v_now end,
    generic_disclosure_country = case when v_experience = 'GENERIC' then p_country_code end
  where user_id = v_user;

  -- MANDATORY, and in the SAME TRANSACTION as the profile write. If this
  -- insert fails for any reason the UPDATE above rolls back with it, so a
  -- confirmed country carrying no audit record cannot exist. This is the
  -- specific guarantee G3-R5 asked for.
  insert into audit_events (user_id, event_type, entity, entity_id, metadata)
  values (
    v_user,
    'country_confirmed',
    'user_profiles.country_of_residence',
    v_user,
    jsonb_build_object(
      'previous_country', v_existing.country_of_residence,
      'new_country', p_country_code,
      'actor', 'self',
      'actor_id', v_user,
      'experience_level', v_experience,
      'disclosure_version', case when v_experience = 'GENERIC' then p_disclosure_version end,
      'written_by', 'confirm_country_of_residence'
    )
  );

  return jsonb_build_object(
    'country_of_residence', p_country_code,
    'country_confirmed_at', v_now,
    'country_source', 'USER_CONFIRMED',
    'generic_disclosure_version', case when v_experience = 'GENERIC' then p_disclosure_version end,
    'experience_level', v_experience,
    'idempotent_replay', false
  );
end;
$$;

comment on function public.confirm_country_of_residence(char, text) is
  'G3 (closes G3-R5): the ONLY path by which an end user can set country_confirmed_at, country_source or the generic_disclosure_* columns to a non-null value. Validates the country against the live registry, derives the experience level server-side, requires a disclosure version for a GENERIC country, replays idempotently without a duplicate audit event, and writes the profile row AND its audit_events record in ONE transaction -- so a confirmed country with no audit trail, or a stored acknowledgement with no audit trail, is unreachable rather than merely discouraged. Mirrors migration 0122''s confirm_primary_country_change() pattern exactly.';

create or replace function public.enforce_controlled_confirmation_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only an authenticated PostgREST end user is in scope -- see this
  -- section's header for why service_role, migrations, psql sessions and
  -- background jobs are outside the threat boundary this closes.
  if coalesce(auth.role(), '') <> 'authenticated' then
    return new;
  end if;

  if (new.country_confirmed_at is distinct from old.country_confirmed_at)
     or (new.country_source is distinct from old.country_source)
     or (new.generic_disclosure_version is distinct from old.generic_disclosure_version)
     or (new.generic_disclosure_acknowledged_at is distinct from old.generic_disclosure_acknowledged_at)
     or (new.generic_disclosure_country is distinct from old.generic_disclosure_country)
  then
    if coalesce(current_setting('fhip.controlled_country_confirmation', true), '') = 'on' then
      return new;
    end if;

    -- The one permitted direct transition: a pure DE-confirmation, where all
    -- five columns go to NULL together. Revoking your own confirmation is
    -- never an escalation -- it only removes access -- and PUT
    -- /api/user/profile relies on exactly this when a user changes their
    -- country, to force them back through the confirmation flow (MCC spec
    -- 5.7). Anything else must go through the RPC.
    if new.country_confirmed_at is null
       and new.country_source is null
       and new.generic_disclosure_version is null
       and new.generic_disclosure_acknowledged_at is null
       and new.generic_disclosure_country is null
    then
      return new;
    end if;

    raise exception 'COUNTRY_CONFIRMATION_REQUIRES_CONTROLLED_WORKFLOW: direct update of country_confirmed_at/country_source/generic_disclosure_* is not permitted; use the confirm_country_of_residence() RPC'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.enforce_controlled_confirmation_columns() is
  'G3 (closes G3-R5). RLS ownership alone is not sufficient for these columns: a user may freely edit their own ordinary profile fields, but must never be able to assert their own confirmation or their own coverage acknowledgement directly -- doing so would bypass the mandatory, same-transaction audit event that confirm_country_of_residence() writes. Permits exactly one direct transition, a pure de-confirmation to all-NULL, which only ever removes access. Structurally identical to migration 0122''s enforce_controlled_country_columns().';

drop trigger if exists trg_enforce_controlled_confirmation_columns on user_profiles;
create trigger trg_enforce_controlled_confirmation_columns
  before update on user_profiles
  for each row execute function public.enforce_controlled_confirmation_columns();

-- -----------------------------------------------------------------------------
-- 10. Grants
-- -----------------------------------------------------------------------------
-- The two predicates are read-only and registry-scoped. They are exposed to
-- `authenticated` for parity with is_country_confirmed()'s established
-- treatment; the trigger functions themselves are never called directly.
grant execute on function public.is_country_registration_eligible(char) to authenticated, anon;
grant execute on function public.is_country_registration_confirmed(uuid) to authenticated;
grant execute on function public.confirm_country_of_residence(char, text) to authenticated;
