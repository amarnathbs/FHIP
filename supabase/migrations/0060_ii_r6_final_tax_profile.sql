-- Investment Intelligence R6-FINAL — persisted explicit tax-profile input
-- (spec Sections 20-23). Forward-only.
--
-- DDL STATUS AS OF THIS DISPATCH (2026-08-22): NOT YET APPLIED TO DEV. This
-- session has no DDL capability against DEV (confirmed structurally, same
-- limitation disclosed throughout this project's history — see e.g.
-- migration 0058's own header before it was applied out-of-band by the
-- orchestrating session). Unlike 0059 (pure DML into already-existing
-- tables, which this session COULD and did apply directly via the
-- service-role key), this migration CREATEs a new table, which genuinely
-- requires DDL this session cannot execute.
--
-- CONSEQUENCE, DISCLOSED: until a human applies this migration, the tax-
-- profile GET/PUT persistence route
-- (app/api/investment-intelligence/tax/profile/route.ts) degrades
-- gracefully — GET returns "no profile on record", PUT returns an explicit
-- 503-style "not yet available in this environment" rather than crashing or
-- silently no-op'ing — and the LIVE-R6-011/012 test scenarios exercise an
-- EXPLICIT PER-REQUEST override (taxProfile passed directly in the
-- tax/summary request body/query) instead of a persisted profile, which is
-- still a genuine, deliberate, explicit user input per the spec's own
-- requirement — it just doesn't survive across sessions yet. See
-- docs/investment-intelligence/R6_FINAL_LIVE_DEV_VERIFICATION.md for the
-- live evidence of this exact degradation path.
--
-- One profile per user (not per household/account) — tax residency is a
-- property of the taxpayer, not of a specific investment account.

create table ii_tax_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  taxpayer_type text not null check (taxpayer_type in ('RESIDENT_INDIVIDUAL', 'RESIDENT_HUF', 'NON_RESIDENT_INDIVIDUAL')),
  tax_residency_status text not null check (tax_residency_status in ('RESIDENT', 'NON_RESIDENT')),
  tax_year text, -- e.g. "2025-26" — informational only, never used as a rate-lookup key (rule version is always resolved by the disposal's own date)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table ii_tax_profiles enable row level security;
create policy "own ii_tax_profiles" on ii_tax_profiles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- No default row is ever seeded for any user — absence of a row IS the
-- "no explicit tax profile declared yet" state the engine already handles
-- via taxProfile.ts's UNKNOWN_PROFILE branch (fail-safe, not guessed).
