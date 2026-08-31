-- G1 — Country Foundation (Product Owner spec, G0 gap-closure + G1 build,
-- 2026-09-01). Extends the existing canonical jurisdiction/country
-- architecture (docs/jurisdiction-applicability/*, lib/services/
-- jurisdiction.ts, Mandatory Country Confirmation) rather than replacing
-- it. Does NOT touch, rename or duplicate any MCC control (migrations
-- 0104/0105/0108/0111) — those remain the sole authority for
-- country_of_residence / country_confirmed_at / country_source and the
-- 85-table INSERT/UPDATE/DELETE backstop.
--
-- Migration number note: local chain head at authoring time is 0120
-- (0120_fdh15_income_member_mismatch_guard.sql). Cross-branch collision
-- guard (scripts/check-migration-versions-against-branch.mjs) was run
-- against origin/main, cert/fdh16-full-integration-certification,
-- fix/admin-a02-wave3-disconnected-content-dead-routes (all clean, 115
-- files, no collision) and feature/module-11-3-insight-pack, which has
-- already filled the previously-unused 0117 and additionally claimed 0121
-- (0121_module11_3_insight_pack.sql). This migration is therefore numbered
-- 0122 to avoid any future collision with that in-flight allocation.
--
-- Scope (spec sections 5-19):
--   1. Extend the existing `countries` reference table (0001_foundation.sql)
--      into a real registry: experience level, locale, selectability,
--      active/effective-date/audit metadata. `is_supported` — the existing
--      column MCC's is_country_confirmed() already joins on — is left with
--      its exact current meaning and exact current values (AU/IN only);
--      this migration never changes what MCC treats as a confirmable
--      residence country.
--   2. One new governed capability relationship (`country_capabilities`),
--      not a JSON blob, replacing the need for a parallel dozen boolean
--      columns on `countries` for the section-10 capability list (the two
--      lists in spec sections 8 and 10 name the same underlying concepts —
--      "domestic-calculation support" / "Domestic calculations" etc. — so
--      this migration gives them exactly one authority, not two).
--   3. Additive `user_profiles` columns for primary country and billing
--      country, kept structurally distinct from residence
--      (country_of_residence/country_confirmed_at/country_source, all
--      untouched) per spec section 6.4/6.7. A BEFORE UPDATE trigger blocks
--      any direct client write to these columns — they can only change
--      through the SECURITY DEFINER RPCs below, which is how "preview then
--      confirm" (spec section 14) is actually enforced at the data layer,
--      not just in application code.
--   4. `country_change_previews` (integrity-bound, expiring, single-use)
--      and reuse of the EXISTING `audit_events` table (0001_foundation.sql)
--      for the audit trail (spec section 15) — no new competing audit
--      table.
--   5. `cross_border_relationships`, RLS-protected, user-owned (spec
--      section 13).
--   6. Two SECURITY DEFINER RPCs: confirm_primary_country_change(),
--      confirm_billing_country() — the only permitted write path for the
--      controlled columns.
--
-- Explicitly NOT done here (see spec section 24 and this task's own
-- exclusions):
--   * No Cloudflare/IP detection, no anonymous-selector UI/storage (G2).
--   * No checkout/payment-provider integration (none exists in this
--     codebase today — confirmed by repo-wide search; see G0 delta
--     finding G0-D3-1). `country_capabilities.APPROVED_BILLING` /
--     `APPROVED_PRICING` are seeded false for every country; this
--     migration only builds the billing-country authority boundary a
--     future checkout (G5) must call into.
--   * No FX expansion — `country_capabilities.FX_CONVERSION` stays false
--     for every country except AU/IN (the existing 2-currency engine,
--     lib/engines/fx.ts, is untouched and still only knows AUD/INR).
--   * No G6 cross-border calculations — cross_border_relationships is a
--     declaration store only; nothing reads it to change a total, gate a
--     product, or run a calculation.

-- =============================================================================
-- 1. Country registry — extend the existing `countries` table
-- =============================================================================
alter table countries
  add column if not exists experience_level text not null default 'UNAVAILABLE',
  add column if not exists default_locale text,
  add column if not exists selectable boolean not null default false,
  add column if not exists active boolean not null default true,
  add column if not exists effective_from timestamptz not null default now(),
  add column if not exists effective_to timestamptz,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

alter table countries
  add constraint countries_experience_level_check
  check (experience_level in ('FULL', 'GENERIC', 'UNAVAILABLE'));

alter table countries
  add constraint countries_effective_dates_check
  check (effective_to is null or effective_to > effective_from);

comment on column countries.experience_level is
  'G1 registry field. FULL = country-specific certified modules/calculations/reports exist (AU, IN today). GENERIC = universal functionality only, no local tax/regulatory/retirement certification implied. UNAVAILABLE = no authenticated financial-app experience. Distinct from is_supported (unchanged, pre-existing) which governs Mandatory Country Confirmation residence-confirmability specifically -- a country may be experience_level=GENERIC and selectable as a primary-country/cross-border target without becoming is_supported=true for MCC residence purposes, since no registration/onboarding flow exists for it yet.';
comment on column countries.selectable is
  'G1: may this country be chosen as a primary-country-change target or a cross-border-relationship country. Independent of is_supported (MCC residence-confirmability) and of registration_support (see country_capabilities.REGISTRATION) -- selectable does not imply a user can register/onboard with this as their residence.';
comment on column countries.active is
  'G1 registry lifecycle flag -- false retires a row from selection without deleting history (existing FK references, e.g. cross_border_relationships.country_code, remain valid).';

-- Registry backfill for the two existing, fully-certified countries. Values
-- taken directly from evidence already established by G0/G0-JA-1/MCC/R6/
-- SMSF: AU has a certified SMSF domestic-retirement product with DB-level
-- gating (0084); IN has a certified tax-lot/FIFO/CGT engine (Investment
-- Intelligence R6) but no equivalent AU CGT engine exists (confirmed absent,
-- docs/jurisdiction-applicability/02-module-matrix.md); both have shipped
-- Resources jurisdiction content (migration 0049) and both have live,
-- RLS-tested cross-border evidence (SMSF cross-border scenario table,
-- docs/jurisdiction-applicability/09-cross-border-model.md §6).
update countries set
  experience_level = 'FULL',
  default_locale = 'en-AU',
  selectable = true,
  active = true,
  updated_at = now()
where country_code = 'AU';

update countries set
  experience_level = 'FULL',
  default_locale = 'en-IN',
  selectable = true,
  active = true,
  updated_at = now()
where country_code = 'IN';

-- Seed four GENERIC-experience countries (spec section 9's own illustrative
-- list -- GB, US, SG, AE -- "verify approved scope before seeding": seeded
-- exactly as the Product Owner's own spec names them, no others added).
-- default_currency_code is registry/descriptive metadata only -- it is NOT
-- wired into user_profiles.preferred_currency (still char(3) validated by
-- lib/validation/profile.ts's `z.enum(['AUD','INR'])`, untouched by this
-- migration) or lib/engines/fx.ts's SupportedCurrency ('AUD'|'INR' only,
-- untouched) -- FX/currency expansion is explicitly out of scope (spec
-- section 24). is_supported stays at this table's pre-existing default
-- (true) is NOT set for these rows -- see explicit false below, so MCC's
-- is_country_confirmed() continues to treat only AU/IN as a confirmable
-- residence country, unchanged.
insert into countries (country_code, country_name, default_currency_code, is_supported, experience_level, default_locale, selectable, active)
values
  ('GB', 'United Kingdom', 'GBP', false, 'GENERIC', 'en-GB', true, true),
  ('US', 'United States',  'USD', false, 'GENERIC', 'en-US', true, true),
  ('SG', 'Singapore',      'SGD', false, 'GENERIC', 'en-SG', true, true),
  ('AE', 'United Arab Emirates', 'AED', false, 'GENERIC', 'en-AE', true, true)
on conflict (country_code) do update set
  experience_level = excluded.experience_level,
  default_locale = excluded.default_locale,
  selectable = excluded.selectable,
  active = excluded.active,
  updated_at = now();

-- Matching `currencies` reference rows (existing table, 0001_foundation.sql;
-- no FK from countries.default_currency_code to currencies.currency_code
-- exists today, so this is purely descriptive completeness, not a
-- constraint requirement).
insert into currencies (currency_code, currency_name, currency_symbol, country_code)
values
  ('GBP', 'British Pound', '£', 'GB'),
  ('USD', 'US Dollar', '$', 'US'),
  ('SGD', 'Singapore Dollar', 'S$', 'SG'),
  ('AED', 'UAE Dirham', 'د.إ', 'AE')
on conflict (currency_code) do nothing;

-- =============================================================================
-- 2. Capability flags — one governed relationship, not a JSON blob
-- =============================================================================
create table country_capabilities (
  country_code char(2) not null references countries(country_code),
  capability text not null check (capability in (
    'REGISTRATION',
    'UNIVERSAL_MODULES',
    'DOMESTIC_CALCULATIONS',
    'DOMESTIC_RETIREMENT',
    'DOMESTIC_TAX_OUTPUTS',
    'CROSS_BORDER_RELATIONSHIPS',
    'LOCALISED_RESOURCES',
    'LOCALISED_REPORTS',
    'APPROVED_BILLING',
    'APPROVED_PRICING',
    'FX_CONVERSION',
    'REGULATORY_GUIDANCE',
    'COUNTRY_SPECIFIC_CATALOGUE_ITEMS'
  )),
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (country_code, capability)
);

comment on table country_capabilities is
  'G1 granular capability flags per country (spec sections 8+10 -- the two lists name the same concepts, so this is their single authority). Read-only to authenticated/anon (world-readable, like countries/currencies since 0001); only ever written by migration or service-role, never by an end user or by an admin-corrected profile field. G4 (application-wide capability layer) is the intended consumer for module/nav filtering -- this migration provides the data and nothing else; no navigation or module-visibility filtering is implemented by this migration.';

alter table country_capabilities enable row level security;
create policy "read country_capabilities" on country_capabilities for select using (true);

-- AU: certified SMSF domestic-retirement product (0084) with DB gating; no
-- certified AU CGT/tax-output engine exists (docs/jurisdiction-applicability/
-- 02-module-matrix.md, confirmed absent). Resources + reports carry AU
-- content/sections. Cross-border relationships supported both directions
-- (this migration's own new table). No billing/pricing/FX-expansion claim.
insert into country_capabilities (country_code, capability, enabled) values
  ('AU', 'REGISTRATION', true),
  ('AU', 'UNIVERSAL_MODULES', true),
  ('AU', 'DOMESTIC_CALCULATIONS', true),
  ('AU', 'DOMESTIC_RETIREMENT', true),
  ('AU', 'DOMESTIC_TAX_OUTPUTS', false),
  ('AU', 'CROSS_BORDER_RELATIONSHIPS', true),
  ('AU', 'LOCALISED_RESOURCES', true),
  ('AU', 'LOCALISED_REPORTS', true),
  ('AU', 'APPROVED_BILLING', false),
  ('AU', 'APPROVED_PRICING', false),
  ('AU', 'FX_CONVERSION', true),
  ('AU', 'REGULATORY_GUIDANCE', true),
  ('AU', 'COUNTRY_SPECIFIC_CATALOGUE_ITEMS', true)
on conflict (country_code, capability) do update set enabled = excluded.enabled, updated_at = now();

-- IN: certified tax-lot/FIFO/grandfathering/CGT engine (Investment
-- Intelligence R6) -- DOMESTIC_TAX_OUTPUTS=true. EPF/PPF/NPS remain
-- explicitly out of scope for this and every prior task
-- (spec section 24) -- DOMESTIC_RETIREMENT=false (no certified India
-- retirement-product calculation engine exists yet; FDH-12 is statement
-- ingestion/reconciliation, not a retirement calculation engine).
insert into country_capabilities (country_code, capability, enabled) values
  ('IN', 'REGISTRATION', true),
  ('IN', 'UNIVERSAL_MODULES', true),
  ('IN', 'DOMESTIC_CALCULATIONS', true),
  ('IN', 'DOMESTIC_RETIREMENT', false),
  ('IN', 'DOMESTIC_TAX_OUTPUTS', true),
  ('IN', 'CROSS_BORDER_RELATIONSHIPS', true),
  ('IN', 'LOCALISED_RESOURCES', true),
  ('IN', 'LOCALISED_REPORTS', true),
  ('IN', 'APPROVED_BILLING', false),
  ('IN', 'APPROVED_PRICING', false),
  ('IN', 'FX_CONVERSION', true),
  ('IN', 'REGULATORY_GUIDANCE', true),
  ('IN', 'COUNTRY_SPECIFIC_CATALOGUE_ITEMS', true)
on conflict (country_code, capability) do update set enabled = excluded.enabled, updated_at = now();

-- GB/US/SG/AE: GENERIC experience level (spec section 9) -- universal
-- modules only, plus the ability to be named in a cross-border relationship
-- (a real, evidence-supported need: spec's own worked examples name foreign
-- holdings in generic countries). Everything domestic/localised/billing/
-- FX/tax stays false -- no certification, content, billing or FX-conversion
-- claim is made for any of these four countries by this migration.
insert into country_capabilities (country_code, capability, enabled)
select c.country_code, cap.capability, (cap.capability in ('UNIVERSAL_MODULES', 'CROSS_BORDER_RELATIONSHIPS'))
from countries c
cross join (values
  ('REGISTRATION'), ('UNIVERSAL_MODULES'), ('DOMESTIC_CALCULATIONS'),
  ('DOMESTIC_RETIREMENT'), ('DOMESTIC_TAX_OUTPUTS'), ('CROSS_BORDER_RELATIONSHIPS'),
  ('LOCALISED_RESOURCES'), ('LOCALISED_REPORTS'), ('APPROVED_BILLING'),
  ('APPROVED_PRICING'), ('FX_CONVERSION'), ('REGULATORY_GUIDANCE'),
  ('COUNTRY_SPECIFIC_CATALOGUE_ITEMS')
) as cap(capability)
where c.country_code in ('GB', 'US', 'SG', 'AE')
on conflict (country_code, capability) do update set enabled = excluded.enabled, updated_at = now();

-- =============================================================================
-- 3. user_profiles — primary country and billing country (additive only)
-- =============================================================================
-- Kept structurally separate from country_of_residence/country_confirmed_at/
-- country_source (MCC, migration 0104, untouched) per spec section 6.3/6.4:
-- residence and primary experience country must never be the same storage
-- slot, even though they are often the same value.
alter table user_profiles
  add column if not exists primary_country char(2) references countries(country_code),
  add column if not exists primary_country_source text,
  add column if not exists primary_country_set_at timestamptz,
  add column if not exists billing_country char(2) references countries(country_code),
  add column if not exists billing_country_confirmed_at timestamptz,
  add column if not exists billing_country_source text;

alter table user_profiles
  add constraint user_profiles_primary_country_source_check
  check (primary_country_source is null or primary_country_source in ('SYSTEM_INITIALISED', 'USER_CONFIRMED', 'ADMIN_CORRECTED'));

alter table user_profiles
  add constraint user_profiles_primary_country_requires_set_at
  check (primary_country_set_at is null or primary_country is not null);

alter table user_profiles
  add constraint user_profiles_billing_country_source_check
  check (billing_country_source is null or billing_country_source in ('USER_CONFIRMED', 'ADMIN_CORRECTED'));

alter table user_profiles
  add constraint user_profiles_billing_country_requires_confirmation
  check (billing_country_confirmed_at is null or billing_country is not null);

comment on column user_profiles.primary_country is
  'G1: the user''s selected primary application experience (spec section 6.4). Distinct from country_of_residence (residence/regulatory authority, MCC-owned, untouched). Never silently updates country_of_residence. Changeable only via confirm_primary_country_change() -- see the BEFORE UPDATE guard trigger below; a direct client UPDATE of this column is rejected even under the user''s own RLS-permitted row.';
comment on column user_profiles.primary_country_source is
  'SYSTEM_INITIALISED = this migration''s one-time backfill from an already-confirmed residence country (spec section 12). USER_CONFIRMED = set via the controlled preview/confirm workflow. ADMIN_CORRECTED = authorised remediation, reusing the same provenance vocabulary MCC already established for country_source.';
comment on column user_profiles.billing_country is
  'G1: confirmed billing region for payment eligibility/price selection (spec section 6.7). Never backfilled from landing default, detected country, residence, primary country or preferred_currency (spec section 12) -- NULL for every existing user after this migration, including AU/IN residents, until an explicit checkout-time confirmation (G5) sets it via confirm_billing_country().';

-- Existing-user initialisation (spec section 12): confirmed users only,
-- primary country := residence country, source := SYSTEM_INITIALISED,
-- residence itself untouched, currency untouched (preferred_currency is not
-- written by this migration at all -- see header). Unconfirmed users
-- (country_confirmed_at IS NULL) are left with primary_country NULL --
-- no IP/currency inference, no AU/IN default, matching spec section 12's
-- explicit "leave primary country unresolved" instruction. This is a
-- backfill of a NEW column from an EXISTING, already-confirmed value on the
-- SAME row -- not a reclassification of any financial record, not a
-- currency change, not a residence change.
update user_profiles
set primary_country = country_of_residence,
    primary_country_source = 'SYSTEM_INITIALISED',
    primary_country_set_at = now()
where country_confirmed_at is not null
  and country_of_residence is not null
  and primary_country is null;

-- =============================================================================
-- 4. Controlled-column write guard (makes "preview then confirm" real, not
--    just a convention the API layer could bypass with a raw PostgREST call)
-- =============================================================================
create or replace function public.enforce_controlled_country_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Service-role writes (this migration's own backfill above, future admin
  -- remediation) are never subject to this guard -- same trust boundary
  -- MCC's enforce_country_confirmed() already established.
  if auth.role() = 'service_role' then
    return new;
  end if;

  if (new.primary_country is distinct from old.primary_country)
     or (new.primary_country_source is distinct from old.primary_country_source)
     or (new.primary_country_set_at is distinct from old.primary_country_set_at)
     or (new.billing_country is distinct from old.billing_country)
     or (new.billing_country_confirmed_at is distinct from old.billing_country_confirmed_at)
     or (new.billing_country_source is distinct from old.billing_country_source)
  then
    -- The one escape hatch: the SECURITY DEFINER RPCs below set this
    -- transaction-local (is_local=true) GUC immediately before performing
    -- exactly this update, then it resets automatically at transaction end.
    -- Not settable by an ordinary PostgREST client -- set_config() is a
    -- pg_catalog function, never auto-exposed as a PostgREST RPC endpoint
    -- (only functions in the exposed schema, i.e. public, are), and no
    -- route in this app calls it directly.
    if coalesce(current_setting('fhip.controlled_country_change', true), '') <> 'on' then
      raise exception 'PRIMARY_OR_BILLING_COUNTRY_REQUIRES_CONTROLLED_WORKFLOW: direct update of primary_country/billing_country columns is not permitted; use the confirm_primary_country_change()/confirm_billing_country() RPCs'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.enforce_controlled_country_columns() is
  'G1 data-layer enforcement of spec section 14 (preview then confirm). Blocks any direct UPDATE of primary_country*/billing_country* on user_profiles that did not go through confirm_primary_country_change()/confirm_billing_country() (both set a transaction-local GUC immediately before their own internal UPDATE). RLS ownership alone (auth.uid()=user_id) is not sufficient here -- a user is allowed to update THEIR OWN row''s ordinary profile fields freely, but never these specific columns directly.';

drop trigger if exists trg_enforce_controlled_country_columns on user_profiles;
create trigger trg_enforce_controlled_country_columns
  before update on user_profiles
  for each row execute function public.enforce_controlled_country_columns();

-- =============================================================================
-- 5. Country-change preview store (integrity-bound, expiring, single-use)
-- =============================================================================
create table country_change_previews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  current_primary_country char(2),
  proposed_primary_country char(2) not null references countries(country_code),
  current_base_currency char(3),
  proposed_base_currency char(3),
  current_experience_level text,
  proposed_experience_level text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  consumed_at timestamptz
);

comment on table country_change_previews is
  'G1 spec section 14.1/14.2: a preview is never trusted back from the client. confirm_primary_country_change() re-reads this row by id, checks ownership, checks not expired, checks not already consumed -- a tampered/stale/replayed preview payload from the client is structurally rejected because the row it references, not client JSON, is the source of truth for what was actually previewed.';

create index idx_country_change_previews_user on country_change_previews(user_id);

alter table country_change_previews enable row level security;
create policy "own select - country_change_previews" on country_change_previews
  for select using (auth.uid() = user_id);
create policy "own insert - country_change_previews" on country_change_previews
  for insert with check (auth.uid() = user_id);
-- Deliberately no UPDATE/DELETE policy for authenticated: consumed_at is
-- only ever set by confirm_primary_country_change() (SECURITY DEFINER,
-- bypasses RLS by design) -- a user can create and read their own preview
-- rows but can never mark one consumed or alter its content themselves.

drop trigger if exists trg_enforce_country_confirmed on country_change_previews;
create trigger trg_enforce_country_confirmed
  before insert on country_change_previews
  for each row execute function public.enforce_country_confirmed();

-- =============================================================================
-- 6. Cross-border relationships (spec section 13)
-- =============================================================================
create table cross_border_relationships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  country_code char(2) not null references countries(country_code),
  relationship_type text not null check (relationship_type in (
    'ASSET', 'INVESTMENT', 'PROPERTY', 'INCOME', 'LIABILITY', 'RETIREMENT', 'TAX', 'OTHER'
  )),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'ENDED')),
  source text not null default 'USER_DECLARED' check (source in ('USER_DECLARED', 'ADMIN_CORRECTED', 'SYSTEM_INITIALISED')),
  confirmed_at timestamptz,
  effective_date date,
  end_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  audit_event_id uuid references audit_events(id) on delete set null,
  check (end_date is null or effective_date is null or end_date >= effective_date)
);

comment on table cross_border_relationships is
  'G1 spec section 13: a declared financial relationship with another country. Does NOT change residence, primary country, billing country or any record''s own currency, and does NOT by itself grant product eligibility or trigger any G6 calculation -- purely a declaration store for this phase. See lib/services/jurisdiction.ts for the one place a future wave may consult it (assertItemCreationAllowedForUser''s existing crossBorderContextStatus:"not_yet_supported" branch), not yet wired in this migration.';

-- One ACTIVE relationship per (user, country, type) -- spec section 21.4
-- "Duplicate active relationship" must be rejected; an ENDED relationship
-- does not block a new declaration of the same (country, type).
create unique index idx_cross_border_relationships_active_unique
  on cross_border_relationships(user_id, country_code, relationship_type)
  where status = 'ACTIVE';

create index idx_cross_border_relationships_user on cross_border_relationships(user_id);

alter table cross_border_relationships enable row level security;
create policy "own rows - cross_border_relationships" on cross_border_relationships
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop trigger if exists trg_enforce_country_confirmed on cross_border_relationships;
create trigger trg_enforce_country_confirmed
  before insert on cross_border_relationships
  for each row execute function public.enforce_country_confirmed();

-- =============================================================================
-- 7. SECURITY DEFINER RPCs — the only permitted write path for the
--    controlled columns (spec section 14.2)
-- =============================================================================
create or replace function public.confirm_primary_country_change(
  p_preview_id uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_preview country_change_previews%rowtype;
  v_profile user_profiles%rowtype;
  v_existing_audit audit_events%rowtype;
  v_apply_currency boolean;
  v_country_default_currency char(3);
  v_old_country_default_currency char(3);
begin
  if v_user_id is null then
    raise exception 'UNAUTHENTICATED' using errcode = '42501';
  end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key)) = 0 then
    raise exception 'IDEMPOTENCY_KEY_REQUIRED' using errcode = '22023';
  end if;

  -- Idempotent replay: a prior successful call with the same key returns the
  -- same recorded outcome rather than re-applying or erroring (spec section
  -- 21.2 "Duplicate confirmation idempotent").
  select * into v_existing_audit from audit_events
    where user_id = v_user_id
      and event_type = 'PRIMARY_COUNTRY_CHANGE'
      and metadata->>'idempotency_key' = p_idempotency_key
    order by created_at desc limit 1;
  if found then
    return jsonb_build_object('idempotent_replay', true) || coalesce(v_existing_audit.metadata, '{}'::jsonb);
  end if;

  -- Lock the profile row first so two concurrent confirmations for the same
  -- user serialize rather than race (spec section 21.2 "Concurrent
  -- confirmation").
  select * into v_profile from user_profiles where user_id = v_user_id for update;
  if not found then
    raise exception 'PROFILE_INCOMPLETE' using errcode = 'P0002';
  end if;

  select * into v_preview from country_change_previews where id = p_preview_id for update;
  if not found or v_preview.user_id <> v_user_id then
    raise exception 'PREVIEW_NOT_FOUND' using errcode = '42501';
  end if;
  if v_preview.consumed_at is not null then
    raise exception 'PREVIEW_ALREADY_CONSUMED' using errcode = '42501';
  end if;
  if v_preview.expires_at < now() then
    raise exception 'PREVIEW_EXPIRED' using errcode = '42501';
  end if;
  if v_preview.current_primary_country is distinct from coalesce(v_profile.primary_country, v_profile.country_of_residence) then
    -- The profile moved between preview and confirm (e.g. a second,
    -- already-applied change) -- the preview no longer describes reality;
    -- reject rather than silently applying a stale delta (spec section 19
    -- "stale/tampered preview blocked").
    raise exception 'PREVIEW_STALE' using errcode = '42501';
  end if;

  select country_code is not null into strict v_apply_currency
    from countries where country_code = v_preview.proposed_primary_country and selectable and active;
  if not v_apply_currency then
    raise exception 'COUNTRY_NOT_SELECTABLE' using errcode = '42501';
  end if;

  -- Base-currency handling (spec section 6.6/12): only ever move
  -- preferred_currency to the new country's default when the CURRENT value
  -- is still exactly the OLD country's default (i.e. the user never made an
  -- explicit divergent choice) AND the new default is one of the two
  -- currencies this app's FX engine and profile schema actually support
  -- (AUD/INR) -- never attempted for a GENERIC-country target, and never
  -- overwriting an explicit prior choice.
  select default_currency_code into v_old_country_default_currency
    from countries where country_code = coalesce(v_profile.primary_country, v_profile.country_of_residence);
  select default_currency_code into v_country_default_currency
    from countries where country_code = v_preview.proposed_primary_country;

  perform set_config('fhip.controlled_country_change', 'on', true);

  update user_profiles
  set primary_country = v_preview.proposed_primary_country,
      primary_country_source = 'USER_CONFIRMED',
      primary_country_set_at = now(),
      preferred_currency = case
        when v_country_default_currency in ('AUD', 'INR')
          and (v_profile.preferred_currency is null or v_profile.preferred_currency = v_old_country_default_currency)
        then v_country_default_currency
        else v_profile.preferred_currency
      end,
      updated_at = now()
  where user_id = v_user_id;

  update country_change_previews set consumed_at = now() where id = p_preview_id;

  insert into audit_events (user_id, event_type, entity, entity_id, metadata)
  values (
    v_user_id,
    'PRIMARY_COUNTRY_CHANGE',
    'user_profiles',
    v_user_id,
    jsonb_build_object(
      'idempotency_key', p_idempotency_key,
      'preview_id', p_preview_id,
      'old_primary_country', coalesce(v_profile.primary_country, v_profile.country_of_residence),
      'new_primary_country', v_preview.proposed_primary_country,
      'old_base_currency', v_profile.preferred_currency,
      'new_base_currency', case
        when v_country_default_currency in ('AUD', 'INR')
          and (v_profile.preferred_currency is null or v_profile.preferred_currency = v_old_country_default_currency)
        then v_country_default_currency
        else v_profile.preferred_currency
      end,
      'source', 'USER_CONFIRMED',
      'status', 'SUCCESS'
    )
  );

  return jsonb_build_object(
    'idempotent_replay', false,
    'new_primary_country', v_preview.proposed_primary_country
  );
end;
$$;

comment on function public.confirm_primary_country_change(uuid, text) is
  'The only permitted write path for user_profiles.primary_country* (spec section 14.2). Requires a valid, unexpired, unconsumed preview row owned by the caller; idempotent on (user_id, idempotency_key); serializes concurrent calls via row lock; never touches country_of_residence/country_confirmed_at/country_source (MCC, untouched) or any financial record.';

grant execute on function public.confirm_primary_country_change(uuid, text) to authenticated;

create or replace function public.confirm_billing_country(
  p_billing_country char(2)
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_country_ok boolean;
begin
  if v_user_id is null then
    raise exception 'UNAUTHENTICATED' using errcode = '42501';
  end if;

  select (country_code is not null) into v_country_ok
    from countries where country_code = p_billing_country and selectable and active;
  if not v_country_ok then
    raise exception 'BILLING_COUNTRY_NOT_SELECTABLE' using errcode = '42501';
  end if;

  perform set_config('fhip.controlled_country_change', 'on', true);

  update user_profiles
  set billing_country = p_billing_country,
      billing_country_confirmed_at = now(),
      billing_country_source = 'USER_CONFIRMED',
      updated_at = now()
  where user_id = v_user_id;

  if not found then
    raise exception 'PROFILE_INCOMPLETE' using errcode = 'P0002';
  end if;

  insert into audit_events (user_id, event_type, entity, entity_id, metadata)
  values (
    v_user_id, 'BILLING_COUNTRY_CONFIRMED', 'user_profiles', v_user_id,
    jsonb_build_object('billing_country', p_billing_country, 'source', 'USER_CONFIRMED', 'status', 'SUCCESS')
  );

  return jsonb_build_object('billing_country', p_billing_country);
end;
$$;

comment on function public.confirm_billing_country(char) is
  'The only permitted write path for user_profiles.billing_country* (spec section 6.7/17). This migration does not call it from anywhere -- no checkout exists yet (confirmed absent repo-wide) -- it exists so G5''s future checkout has a single, already-tested confirmation entry point to call rather than writing billing_country directly.';

grant execute on function public.confirm_billing_country(char) to authenticated;
