-- G5B — Generic Universal-Module Write Enablement (Product Owner authorisation,
-- 2026-09-05: "G5B AUTHORIZED — GENERIC UNIVERSAL-MODULE WRITE ENABLEMENT, DEV
-- ONLY"). DEV ONLY. Not applied by this task — prepared for Product Owner
-- review and manual application via the DEV Supabase SQL Editor.
--
-- ============================================================================
-- THE PROBLEM (see docs/jurisdiction-applicability/
-- G5B_Generic_Universal_Module_Write_Enablement_Scope.md for the full
-- derivation): migration 0104/0105's enforce_country_confirmed() is a single
-- shared BEFORE INSERT backstop applied to ~80 tables. It calls
-- is_country_confirmed(), which requires countries.is_supported = true — a
-- flag that is TRUE for AU/IN only. Every confirmed GENERIC-experience user
-- (GB/US/SG/AE) is therefore rejected with COUNTRY_CONFIRMATION_REQUIRED
-- (42501) on every INSERT into any of those tables, even though three of
-- them (income_sources, expense_items, insurance_policies) have been
-- independently re-verified by this migration's author (not merely inherited
-- from G4's manifest note — see the per-cell justification below) to have no
-- database-level or Postgres-trigger-level reason to keep GENERIC users out.
--
-- THIS MIGRATION does NOT change is_country_confirmed() or
-- enforce_country_confirmed() in any way — both are left byte-for-byte as
-- migration 0108 last defined them (0108 rewrote enforce_country_confirmed()
-- to be TG_OP-aware; see the SCOPE NOTE below for why this matters), and
-- continue to run unmodified on every table except the three named below. It
-- adds a NEW, additive predicate (is_write_permitted()) and a NEW trigger
-- function (enforce_write_permitted_g5b()), and repoints ONLY
-- income_sources, expense_items and insurance_policies at the new trigger.
-- Every other table's trigger (all ~79 of them, including the 5 other
-- foundational tables assets/liabilities/investments/retirement_accounts/
-- user_goals) is completely untouched by this file — verify with the
-- accompanying verification SQL's Part A6 (own trigger-name check) and Part
-- A7 (spot check of assets/households, which must show the ORIGINAL
-- trg_enforce_country_confirmed -> enforce_country_confirmed() unchanged).
--
-- WHY grep confirms no double-drift: is_country_confirmed(uuid) has exactly
-- one production caller family — enforce_country_confirmed() and its two
-- bespoke variants (enforce_country_confirmed_professional_notes(),
-- enforce_country_confirmed_via_twin_run()), originally defined in 0104/0105
-- and since rewritten (TG_OP-aware) by migration 0108 and referenced again by
-- migration 0111's cascade-delete fix — all of it untouched by this
-- migration. The only OTHER place "country confirmed" is evaluated is
-- lib/services/countryGate.ts's assertCountryConfirmedForUser(), which is a
-- fully independent TypeScript re-implementation that queries
-- user_profiles/countries/country_capabilities directly via the Supabase
-- client — it does NOT call this SQL function at all (grepped across
-- lib/**, app/**, scripts/** before writing this migration). It therefore
-- cannot silently drift just because a new SQL predicate is introduced
-- alongside is_country_confirmed(); it was never coupled to it in the first
-- place.
--
-- ============================================================================
-- PER-CELL JUSTIFICATION (9 cells: 3 tables x 3 operations). This migration
-- author independently re-read the live write surface before seeding any row
-- true — G4's own manifest note ("no country_code/currency_code field") was
-- NOT taken at face value; see the finding below, which is disclosed
-- separately (application-layer, out of this migration's scope to fix).
--
-- income_sources:
--   INSERT = true.  Real, exercised write path: app/api/income/route.ts POST
--     -> lib/services/registry.ts's save()/create() -> a genuine SQL INSERT.
--     No country_code column on this table at all (confirmed against
--     supabase/migrations/0003_module2.sql's original DDL and every later
--     ALTER). The only jurisdiction-restricted content is two AU-only
--     catalogue items (age_pension, family_tax_benefit), independently
--     gated per-row by assertItemCreationAllowedForUser() BEFORE this
--     migration and UNCHANGED by it — that gate re-resolves the caller's own
--     home country server-side and fails closed for a null/GENERIC country,
--     so it is not bypassed by opening the table-level INSERT gate. This is
--     the core problem G5B exists to fix.
--   UPDATE = true.  Real, exercised write path: app/api/income/[id]/route.ts
--     PATCH -> registry.update() -> a genuine SQL UPDATE, gated by the same
--     incomeSchema (partial()) as INSERT — no additional country/currency
--     hardcode introduced by the partial variant. Denying UPDATE while
--     allowing INSERT would let a GENERIC user create a row they could never
--     subsequently correct (e.g. a typo'd amount) — an inconsistent, user-
--     hostile half-feature with no safety benefit, since RLS already scopes
--     UPDATE to the caller's own row regardless of this trigger.
--   DELETE = false. The app's DELETE HTTP verb
--     (app/api/income/[id]/route.ts DELETE) calls registry.archive(), which
--     issues a SQL UPDATE (`set is_active = false`), never a literal SQL
--     DELETE. There is NO code path anywhere in this repository that issues
--     a real DELETE against income_sources. Marking DELETE true would grant
--     a permission the application never exercises and has never been
--     safety-reviewed for — pure unused attack surface. Denied per this
--     task's own instruction: "if a real ... delete path doesn't exist yet,
--     that is itself a legitimate reason to deny that operation". The
--     product's actual "delete" experience is unaffected (it runs through
--     the UPDATE path above, which is allowed).
--
-- expense_items: identical reasoning to income_sources in every respect —
--   app/api/expenses/route.ts (POST/INSERT), app/api/expenses/[id]/route.ts
--   (PATCH/UPDATE via registry.update(), DELETE via registry.archive()'s
--   UPDATE, never a literal DELETE). No catalogue-item per-row gate exists
--   or is needed for expenses (no AU/IN-restricted expense item found in
--   lib/validation/expense.ts or expenseGridConfig).
--   INSERT = true, UPDATE = true, DELETE = false.
--
-- insurance_policies: identical reasoning again —
--   app/api/insurance/route.ts (POST/INSERT), app/api/insurance/[id]/route.ts
--   (PATCH/UPDATE via registry.update(), DELETE via registry.archive()'s
--   UPDATE, never a literal DELETE). No AU/IN literal found in
--   lib/validation/insurance.ts, insuranceGridConfig or its routes.
--   INSERT = true, UPDATE = true, DELETE = false.
--
-- DISCLOSED FINDING (not fixed by this migration — out of its authorised
-- scope, which is the database write-permission plumbing, not application
-- validation vocabulary): lib/validation/income.ts, expense.ts and
-- insurance.ts each hardcode `currency_code: z.enum(['AUD', 'INR'])` with no
-- default and no `.optional()` — a REAL, previously undisclosed domestic
-- hardcode that G4's manifest note ("No country_code/currency_code field...")
-- did not catch, because it looked for a country_code field specifically and
-- this is a currency_code enum instead. This means a GENERIC user whose
-- reporting currency is GBP/USD/SGD/AED cannot submit a schema-valid
-- Income/Expense/Insurance payload through the real app route even after
-- this migration is applied and the application capability flag (below) is
-- turned on — their POST/PATCH would fail zod validation with a 422 before
-- ever reaching this migration's trigger. This is a genuine, separate,
-- pre-existing application-layer defect, disclosed here for the Product
-- Owner's own follow-up decision; it does not block this migration's
-- database-level correctness (the DB backstop's job is to prevent an
-- INSERT/UPDATE/DELETE regardless of currency, and it does so correctly),
-- and a direct-PostgREST test (bypassing zod) can still prove the database
-- layer works as designed. See this task's final report for the same
-- disclosure in full.
--
-- ============================================================================
-- SCOPE NOTE ON UPDATE/DELETE TRIGGER COVERAGE (CORRECTED from this
-- migration's own earlier draft after re-reading migration 0108, which this
-- author had NOT yet read when the first draft of this file's comments were
-- written — caught and fixed before hand-off, not after):
--
-- migration 0104/0105's original BEFORE INSERT-only scope ("existing rows,
-- and edits to them, are never touched") was ITSELF SUPERSEDED, well before
-- G5B, by migration 0108 ("CRUD and onboarding fix", Product Owner round-3
-- closure) — enforce_country_confirmed() was rewritten there to be
-- TG_OP-aware, and income_sources/expense_items/insurance_policies (along
-- with ~75 other tables) have ALREADY had a combined
-- `before insert or update or delete` trigger calling that function since
-- 0108, not just `before insert`. 0108 also narrowed the onboarding-
-- incomplete exemption from "every table" (0105's bug) to EXACTLY
-- `households` INSERT/UPDATE — income_sources/expense_items/
-- insurance_policies have carried NO onboarding exemption of any kind since
-- 0108. is_write_permitted() (below) reflects this correctly: it has no
-- onboarding-completed branch at all, because reintroducing one for these
-- three tables would reopen exactly the Gap 1 vulnerability 0108 fixed.
--
-- This migration therefore does NOT introduce new UPDATE/DELETE trigger
-- COVERAGE on these three tables — that already existed. What it changes is
-- narrower and more precise: it repoints the EXISTING
-- `before insert or update or delete` trigger on exactly these three tables
-- from enforce_country_confirmed() (blanket is_country_confirmed() check) to
-- the new enforce_write_permitted_g5b() (is_write_permitted() check), with
-- IDENTICAL operation coverage before and after. This is provably
-- behaviour-preserving for a confirmed FULL (AU/IN) user on all three
-- operations: is_write_permitted() delegates straight through to the
-- UNCHANGED is_country_confirmed(), which returns true unconditionally for
-- any confirmed AU/IN user regardless of table or operation — the exact
-- same outcome 0108's trigger already produced (see verification SQL Part B,
-- checks 1/3/4, which prove an AU control user's INSERT/UPDATE/DELETE all
-- still succeed post-migration). For a GENERIC user, DELETE=false in the
-- manifest means their literal SQL DELETE stays rejected exactly as under
-- 0108's trigger today (no change); INSERT/UPDATE=true is the one thing this
-- migration actually opens.

-- ============================================================================
-- 1. The capability manifest table.
-- ============================================================================
create table if not exists public.mcc_generic_write_capabilities (
  table_name text not null,
  operation text not null check (operation in ('INSERT', 'UPDATE', 'DELETE')),
  generic_write_allowed boolean not null default false,
  certified_at timestamptz not null default now(),
  certified_reason text not null,
  primary key (table_name, operation)
);

comment on table public.mcc_generic_write_capabilities is
  'G5B default-deny manifest: which (table, operation) pairs a confirmed GENERIC-experience user (country_confirmed_at set, country NOT is_supported) may additionally perform, beyond what is_write_permitted() already grants a confirmed FULL/AU-IN user unconditionally. Absence of a row (or generic_write_allowed=false) means DENIED — this is the literal default-deny mechanism, not a separate flag. Read only by is_write_permitted(); never queried directly by application code. A newly introduced table gets no automatic row here and is therefore denied by construction until a future migration explicitly certifies and seeds it.';
comment on column public.mcc_generic_write_capabilities.certified_reason is
  'Human-readable justification recorded at seed time — see this migration''s own header for the full per-cell justification these 9 rows were seeded from.';

alter table public.mcc_generic_write_capabilities enable row level security;
-- Deliberately NO policies: this table is never read directly by any
-- authenticated/anon client, only by the SECURITY DEFINER function
-- is_write_permitted() below, which bypasses RLS as its owner. No grants to
-- authenticated/anon either -- default-deny extends to "who can even query
-- this table", not just "what does it return".

insert into public.mcc_generic_write_capabilities (table_name, operation, generic_write_allowed, certified_reason) values
  ('income_sources', 'INSERT', true,
    'G4 evidence pass + this migration''s own re-verification: no country_code column, real exercised INSERT path (app/api/income/route.ts), the only jurisdiction-restricted content (2 AU-only catalogue items) is independently gated per-row by assertItemCreationAllowedForUser() and unaffected by this table-level gate.'),
  ('income_sources', 'UPDATE', true,
    'Real exercised UPDATE path (app/api/income/[id]/route.ts PATCH -> registry.update()), same validation schema family as INSERT (incomeSchema.partial()), no additional hardcode. Denying UPDATE while allowing INSERT would strand a GENERIC user unable to correct their own row.'),
  ('income_sources', 'DELETE', false,
    'No real DELETE path exists: the app''s DELETE verb (app/api/income/[id]/route.ts DELETE) issues registry.archive(), a SQL UPDATE (is_active=false), never a literal SQL DELETE. Denying an operation the application never performs closes unused, unreviewed attack surface with zero product impact.'),
  ('expense_items', 'INSERT', true,
    'No country_code/currency_code hardcode blocking table-level INSERT; real exercised path app/api/expenses/route.ts POST -> registry.save()/create(). No catalogue-item jurisdiction gate exists or is needed for expenses.'),
  ('expense_items', 'UPDATE', true,
    'Real exercised UPDATE path (app/api/expenses/[id]/route.ts PATCH -> registry.update()), same schema family as INSERT (expenseSchema.partial()).'),
  ('expense_items', 'DELETE', false,
    'No real DELETE path exists: app/api/expenses/[id]/route.ts DELETE issues registry.archive(), a SQL UPDATE, never a literal DELETE.'),
  ('insurance_policies', 'INSERT', true,
    'No country_code/currency_code hardcode blocking table-level INSERT; real exercised path app/api/insurance/route.ts POST -> registry.save()/create(). No AU/IN literal found in insuranceGridConfig, lib/validation/insurance.ts or its routes.'),
  ('insurance_policies', 'UPDATE', true,
    'Real exercised UPDATE path (app/api/insurance/[id]/route.ts PATCH -> registry.update()), same schema family as INSERT (insuranceSchema.partial()).'),
  ('insurance_policies', 'DELETE', false,
    'No real DELETE path exists: app/api/insurance/[id]/route.ts DELETE issues registry.archive(), a SQL UPDATE, never a literal DELETE.')
on conflict (table_name, operation) do nothing;

-- ============================================================================
-- 2. The new predicate. Does NOT redefine is_country_confirmed() -- that
--    function is left completely untouched (no `create or replace` on it
--    anywhere in this file). is_write_permitted() calls it as a black box.
-- ============================================================================
create or replace function public.is_write_permitted(p_user_id uuid, p_table_name text, p_operation text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_operation not in ('INSERT', 'UPDATE', 'DELETE') then
    raise exception 'is_write_permitted: unsupported operation "%": must be INSERT, UPDATE or DELETE', p_operation
      using errcode = '22023';
  end if;

  -- service_role bypass -- identical to enforce_country_confirmed()'s own
  -- rule (0104/0105/0108), preserved here so background jobs/admin
  -- remediation against these three tables are unaffected.
  if auth.role() = 'service_role' then
    return true;
  end if;

  -- NO onboarding-incomplete exemption here, deliberately. Migration 0108
  -- (Product Owner round-3 closure, Gap 1 fix) narrowed the ONLY legitimate
  -- onboarding-time exemption to `households` INSERT/UPDATE specifically --
  -- income_sources/expense_items/insurance_policies have carried NO
  -- onboarding exemption since 0108, and this predicate must not
  -- reintroduce one for them (that would silently reopen exactly the
  -- exploitable bypass 0108 fixed: a client with onboarding_completed=false
  -- writing straight into a financial table). See this migration's own
  -- header for the full corrected account.

  -- FULL (AU/IN, is_supported) confirmed users: delegate entirely to the
  -- UNCHANGED is_country_confirmed() -- byte-identical to today's behaviour
  -- for every operation, on every table, for these users. This is also the
  -- ONLY branch a confirmed FULL user can ever reach true through; the
  -- manifest below is consulted only when this returns false.
  if public.is_country_confirmed(p_user_id) then
    return true;
  end if;

  -- Not FULL. A genuinely confirmed country is still required for EVERY
  -- user regardless of experience level -- this is not a relaxation of
  -- "must be confirmed", only of "must be AU/IN". An unconfirmed user of any
  -- country is rejected here exactly as enforce_country_confirmed() rejects
  -- them today.
  if not exists (
    select 1 from public.user_profiles up
    where up.user_id = p_user_id and up.country_confirmed_at is not null
  ) then
    return false;
  end if;

  -- Confirmed but not FULL (i.e. GENERIC, or any other confirmed-but-not-
  -- is_supported case): additionally require a matching allowed row in the
  -- default-deny manifest for this exact (table, operation) pair. Absence of
  -- a row is denial, not an error -- coalesce to false.
  return coalesce((
    select generic_write_allowed
    from public.mcc_generic_write_capabilities
    where table_name = p_table_name and operation = p_operation
  ), false);
end;
$$;

comment on function public.is_write_permitted(uuid, text, text) is
  'G5B additive predicate -- does NOT replace or redefine is_country_confirmed(), which is called unchanged as a black box. FULL/AU-IN confirmed users: identical outcome to is_country_confirmed() alone, for every table/operation. GENERIC (confirmed, not is_supported) users: additionally gated per (table_name, operation) by mcc_generic_write_capabilities. Any user without country_confirmed_at set is rejected regardless of experience level, unless the service_role bypass applies. Deliberately carries NO onboarding-incomplete exemption -- migration 0108 narrowed that to households INSERT/UPDATE only, and income_sources/expense_items/insurance_policies must not regain one.';

grant execute on function public.is_write_permitted(uuid, text, text) to authenticated;

-- ============================================================================
-- 3. The new trigger function. Replaces enforce_country_confirmed() ONLY on
--    the three tables touched in section 4 below -- every other table keeps
--    calling the original, unmodified enforce_country_confirmed().
-- ============================================================================
create or replace function public.enforce_write_permitted_g5b()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
begin
  if tg_op = 'DELETE' then
    v_user_id := old.user_id;
  else
    v_user_id := new.user_id;
  end if;

  if not public.is_write_permitted(v_user_id, tg_table_name, tg_op) then
    raise exception 'COUNTRY_CONFIRMATION_REQUIRED: user % is not permitted to % %', v_user_id, tg_op, tg_table_name
      using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

comment on function public.enforce_write_permitted_g5b() is
  'G5B trigger function for income_sources/expense_items/insurance_policies ONLY. Calls is_write_permitted() instead of enforce_country_confirmed()/is_country_confirmed(). Raises the SAME error code (42501) and a near-identical message as the legacy trigger, so existing client-side error handling keyed on 42501/COUNTRY_CONFIRMATION_REQUIRED is unaffected.';

-- ============================================================================
-- 4. Repoint exactly these three tables' EXISTING trigger (already
--    `before insert or update or delete` since migration 0108 -- see this
--    file's header) from enforce_country_confirmed() to
--    enforce_write_permitted_g5b(), with IDENTICAL operation coverage.
--    Every other table's trg_enforce_country_confirmed trigger (all ~79 of
--    them, per 0108's own inventory) is untouched -- this migration issues
--    no DDL against any table other than the three named here and the new
--    manifest table above.
-- ============================================================================
drop trigger if exists trg_enforce_country_confirmed on income_sources;
drop trigger if exists trg_g5b_write_permitted on income_sources;
create trigger trg_g5b_write_permitted
  before insert or update or delete on income_sources
  for each row execute function public.enforce_write_permitted_g5b();

drop trigger if exists trg_enforce_country_confirmed on expense_items;
drop trigger if exists trg_g5b_write_permitted on expense_items;
create trigger trg_g5b_write_permitted
  before insert or update or delete on expense_items
  for each row execute function public.enforce_write_permitted_g5b();

drop trigger if exists trg_enforce_country_confirmed on insurance_policies;
drop trigger if exists trg_g5b_write_permitted on insurance_policies;
create trigger trg_g5b_write_permitted
  before insert or update or delete on insurance_policies
  for each row execute function public.enforce_write_permitted_g5b();

-- ============================================================================
-- ROLLBACK BOUNDARY
-- ============================================================================
-- Rollback notes (manual -- this repo has no down-migration runner). Running
-- the block below returns income_sources/expense_items/insurance_policies to
-- their exact pre-0129 state — the migration 0108 trigger DDL (`before
-- insert or update or delete`, calling the untouched, TG_OP-aware
-- enforce_country_confirmed()) — and removes every new object this migration
-- created. Safe to run at any time: no other table has a foreign key into
-- mcc_generic_write_capabilities, and no existing column on any table was
-- altered by this migration.
--
--   drop trigger if exists trg_g5b_write_permitted on income_sources;
--   create trigger trg_enforce_country_confirmed
--     before insert or update or delete on income_sources
--     for each row execute function public.enforce_country_confirmed();
--
--   drop trigger if exists trg_g5b_write_permitted on expense_items;
--   create trigger trg_enforce_country_confirmed
--     before insert or update or delete on expense_items
--     for each row execute function public.enforce_country_confirmed();
--
--   drop trigger if exists trg_g5b_write_permitted on insurance_policies;
--   create trigger trg_enforce_country_confirmed
--     before insert or update or delete on insurance_policies
--     for each row execute function public.enforce_country_confirmed();
--
--   drop function if exists public.enforce_write_permitted_g5b();
--   drop function if exists public.is_write_permitted(uuid, text, text);
--   drop table if exists public.mcc_generic_write_capabilities;
--
-- This rollback does NOT touch is_country_confirmed(), enforce_country_
-- confirmed(), or any trigger on any other table -- none of those were ever
-- modified by this migration, so none need to be restored.
