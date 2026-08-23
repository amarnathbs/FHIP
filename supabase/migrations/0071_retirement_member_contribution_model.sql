-- Chunk 3a items 4-5 (Spec 1 §22, Spec 2 §29-36): retirement member-level
-- target retirement age, account-vs-contribution separation, and spouse
-- contribution modeled as a relationship rather than a standalone asset
-- class.
--
-- MEMBER-CONCEPT INSPECTION (parallel to item 1's identity inspection,
-- explicitly invited by the task brief): before adding a new
-- `retirement_members` table, this migration checked whether households/
-- user_profiles/existing owner-modeling already has a clean per-member
-- concept to reuse. It does: `household_members`
-- (0009_module7_goals.sql:11-22) already has exactly the identity shape
-- Spec 2 §30 needs — a stable `id`, `user_id`, and a
-- `relationship` enum that includes 'self'/'spouse'/'partner' alongside
-- child/parent/other — but it currently has ZERO consumers anywhere in the
-- app (no page renders it, no engine reads it, confirmed via a full-repo
-- grep at review time; its API routes exist but nothing calls them). Rather
-- than build a second, competing `retirement_members` table, this migration
-- adds `target_retirement_age` directly onto `household_members` — a
-- person-level planning fact belongs on the person-identity row, not on a
-- retirement-module-specific shadow table — and links `retirement_accounts`
-- to it via a new nullable `household_member_id` FK.
--
-- Backward compatibility: `retirement_accounts.target_retirement_age`
-- (0004_financial_data_grid.sql) is NOT dropped or renamed — every existing
-- account keeps its own per-account value exactly as saved, and the
-- Financial Twin (lib/services/twinData.ts, lib/engines/twin/
-- metricDerivation.ts) keeps reading it unchanged. household_member_id is
-- nullable and defaults to null for every existing row. Wiring the app's
-- consumers over to read the new per-member value instead is explicitly
-- left to 3b/3c (see the handoff section of
-- docs/app-review-2026-08/CHUNK3A_CANONICAL_SCHEMA.md) — this sub-chunk
-- only adds the schema.

alter table household_members
  add column if not exists target_retirement_age int
    check (target_retirement_age is null or (target_retirement_age > 0 and target_retirement_age < 120));

comment on column household_members.target_retirement_age is
  'Chunk 3a (Spec 1 §22, Spec 2 §30): captured once per member (Self/Spouse), not per retirement account. Null until the member sets it; UI should only surface a spouse/partner''s field when a relationship = ''spouse''/''partner'' row genuinely exists for this household.';

alter table retirement_accounts
  add column if not exists household_member_id uuid references household_members(id) on delete set null;

comment on column retirement_accounts.household_member_id is
  'Chunk 3a (Spec 2 §30): optional link from an account to the household_members row whose target_retirement_age governs it. Null for every existing account (this sub-chunk does not backfill/migrate existing data) and for accounts not yet associated with a specific member.';

-- Account-vs-contribution separation (Spec 2 §34-36) and spouse-contribution-
-- as-relationship (Spec 1 §21, Spec 2 §36): a contribution is a future-flow
-- input linked to the RECEIVING account, not a standalone top-level holding
-- equivalent to a real account balance. `contributor` records WHO is making
-- the contribution (including 'spouse', which is what makes a spouse
-- contribution a relationship attribute rather than its own asset class —
-- Spec 2's "who contributes to whose account" framing: retirement_account_id
-- is the recipient member's account, contributor='spouse' says who paid into
-- it). See lib/engines/retirementAccounts.ts for the pure function proving
-- these rows are never summed into an account's current value.
create table retirement_contributions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  retirement_account_id uuid not null references retirement_accounts(id) on delete cascade,
  contribution_type text not null
    check (contribution_type in (
      'employer_contributions', 'salary_sacrifice', 'personal_concessional',
      'non_concessional', 'government_co_contribution', 'spouse_contribution'
    )),
  amount numeric(18,2) not null check (amount >= 0),
  frequency text not null
    check (frequency in ('weekly', 'fortnightly', 'monthly', 'quarterly', 'annually', 'one_off')),
  contributor text not null default 'self' check (contributor in ('self', 'spouse')),
  is_active boolean not null default true,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_retirement_contributions_user on retirement_contributions(user_id);
create index idx_retirement_contributions_account on retirement_contributions(retirement_account_id);

alter table retirement_contributions enable row level security;
create policy "own rows - retirement contributions" on retirement_contributions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
