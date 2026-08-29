-- Mandatory Country Confirmation (Product Owner decision, 2026-08-29).
--
-- Migration number note: origin/main's head at the time this was authored is
-- 0102 (0102_g0_wave2_catalogue_applicability.sql). A local, UNMERGED hotfix
-- commit (2fa2090, branch fix/g0-wave2-closure-hotfix) claims 0103
-- (0103_g0_wave2_australian_shares_country_consistency.sql) but that commit
-- has explicitly NOT been authorised, pushed, merged or applied anywhere —
-- per this task's own instructions it must not be built on, cherry-picked,
-- or have its number reused. This migration is therefore numbered 0104 to
-- avoid a future collision with that reserved-but-unauthoritative number,
-- and does not touch 0102 or anything from the hotfix.
--
-- Scope (Gate A only — see docs/jurisdiction-applicability/
-- Mandatory_Country_Confirmation_Beta_Cleanup_Report_2026-08-29.md):
--   1. Additive columns on user_profiles recording EXPLICIT confirmation
--      evidence, kept structurally distinct from the pre-existing
--      country_of_residence value (which alone has never proven the user
--      actively chose it — see report section F on existing-user provenance).
--   2. A single shared is_country_confirmed()/enforce_country_confirmed()
--      function pair, applied as a BEFORE INSERT backstop to the 8
--      foundational user-owned financial input tables named explicitly in
--      the Product Owner's access-control list (Income, Expenses, Assets,
--      Liabilities, Investments, Retirement, Insurance, Goals) — the exact
--      tables created in 0003_module2.sql plus user_goals from
--      0001_foundation.sql. This is a deliberately BOUNDED backstop, not a
--      blanket trigger across every financial table added by the 100+
--      migrations since 0003 — see the report's honest disclosure of this
--      scope boundary (Gate A verdict: CONDITIONAL PASS).
--
-- Explicitly NOT done here (out of authorised scope for this task):
--   * No NOT NULL constraint on country_of_residence — user_profiles rows
--     are created (0002_module1.sql's handle_new_user trigger) BEFORE the
--     user ever sees a country selector, so a NOT NULL constraint would
--     break signup itself (hard-stop condition, spec section 10).
--   * No change to countries/currencies reference data, no new supported
--     country, no change to 0102, no Wave 2 catalogue work, no SMSF change.
--   * No cross-border holding-country store (explicitly deferred).

-- 1. Canonical confirmation-evidence columns --------------------------------
alter table user_profiles
  add column if not exists country_confirmed_at timestamptz,
  add column if not exists country_source text,
  add column if not exists country_updated_at timestamptz;

alter table user_profiles
  add constraint user_profiles_country_source_check
  check (country_source is null or country_source in ('USER_CONFIRMED', 'ADMIN_CORRECTED'));

-- A confirmation timestamp is only ever meaningful alongside an actual
-- country value — this does NOT require country_of_residence to be set
-- before country_confirmed_at can be null (the common case for every
-- existing row), only the reverse.
alter table user_profiles
  add constraint user_profiles_country_confirmed_requires_country
  check (country_confirmed_at is null or country_of_residence is not null);

comment on column user_profiles.country_confirmed_at is
  'Set only by the compulsory country-confirmation flow (app/api/user/country/confirm) or an authorised admin correction. NULL means unconfirmed regardless of whether country_of_residence itself is set — see lib/services/countryGate.ts.';
comment on column user_profiles.country_source is
  'Provenance of the current country_of_residence value: USER_CONFIRMED (explicit end-user action) or ADMIN_CORRECTED (authorised remediation). NULL for every pre-existing row until re-confirmed — provenance for historical AU/IN values could not be established from application data alone (see closure report section F).';
comment on column user_profiles.country_updated_at is
  'Last time country_of_residence itself changed (distinct from country_confirmed_at, which tracks confirmation of whatever the current value is).';

-- 2. Shared confirmation-state predicate -------------------------------------
-- Mirrors lib/services/countryGate.ts's classification exactly: a country is
-- "confirmed" only when it is a well-formed, currently-supported code AND
-- country_confirmed_at is set. Never treats currency, household data or any
-- other signal as evidence of country.
create or replace function public.is_country_confirmed(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from user_profiles up
    join countries c on c.country_code = up.country_of_residence and c.is_supported
    where up.user_id = p_user_id
      and up.country_confirmed_at is not null
  );
$$;

comment on function public.is_country_confirmed(uuid) is
  'Shared predicate backing both the trigger backstop below and lib/services/countryGate.ts''s application-layer classification. SECURITY DEFINER only to read user_profiles/countries consistently regardless of caller RLS context; performs no writes.';

-- 3. Shared BEFORE INSERT trigger function -----------------------------------
create or replace function public.enforce_country_confirmed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Service-role writes (background jobs, admin remediation, seed/migration
  -- scripts, the FDH/Investment-Intelligence pipelines) are not subject to
  -- this end-user gate — spec section 5.6: "Do not block administrators from
  -- performing separately authorised remediation" and "do not duplicate
  -- country rules independently" into every background pipeline. The
  -- end-user-facing bypass this exists to close is an AUTHENTICATED
  -- browser/API client writing directly against these tables under RLS.
  if auth.role() = 'service_role' then
    return new;
  end if;

  if not public.is_country_confirmed(new.user_id) then
    raise exception 'COUNTRY_CONFIRMATION_REQUIRED: user % has not confirmed a supported country of residence', new.user_id
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.enforce_country_confirmed() is
  'Database-level backstop for direct-Supabase-client writes that bypass the application API/route guard. Blocks INSERT only (existing rows, and edits to them, are never touched — spec section 1.3/5.6). Applied to the 8 foundational financial input tables only; see migration header for the disclosed scope boundary.';

-- 4. Apply the backstop to the 8 foundational financial input tables --------
drop trigger if exists trg_enforce_country_confirmed on income_sources;
create trigger trg_enforce_country_confirmed
  before insert on income_sources
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on expense_items;
create trigger trg_enforce_country_confirmed
  before insert on expense_items
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on assets;
create trigger trg_enforce_country_confirmed
  before insert on assets
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on liabilities;
create trigger trg_enforce_country_confirmed
  before insert on liabilities
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on investments;
create trigger trg_enforce_country_confirmed
  before insert on investments
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on retirement_accounts;
create trigger trg_enforce_country_confirmed
  before insert on retirement_accounts
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on insurance_policies;
create trigger trg_enforce_country_confirmed
  before insert on insurance_policies
  for each row execute function public.enforce_country_confirmed();

drop trigger if exists trg_enforce_country_confirmed on user_goals;
create trigger trg_enforce_country_confirmed
  before insert on user_goals
  for each row execute function public.enforce_country_confirmed();

-- 5. Grants -------------------------------------------------------------
-- is_country_confirmed() is read by the application via RPC-style calls in
-- some paths and indirectly via the trigger in all paths; the authenticated
-- role needs EXECUTE to call it directly if a future guard wants a single
-- round trip, but does NOT get any new table privilege — RLS on
-- user_profiles/countries is completely unchanged by this migration.
grant execute on function public.is_country_confirmed(uuid) to authenticated;
