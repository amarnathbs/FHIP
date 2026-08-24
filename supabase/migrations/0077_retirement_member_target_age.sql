-- Retirement Member UI -- Self/Spouse Target Retirement Age.
--
-- NUMBERING NOTE: canonical origin/main (6efae97, re-fetched and confirmed
-- immediately before this file was written) ends at
-- 0075_fdh6_economic_class_gap_closure_rule_seed.sql. This file originally
-- claimed 0076, but FDH-7 (Reconciliation, Transaction Review & User
-- Approval Workflow) independently claimed 0076 too from the same base
-- commit and had its own certification independently re-verified first, so
-- per this project's established collision precedent this file renumbered
-- to 0077 on 2026-08-24, before either migration reached DEV.
--
-- Context: see RM-0 discovery findings (reported alongside this migration).
-- retirement_members (migration 0072) already exists with RLS and a
-- unique(user_id, member_type) constraint preventing duplicate active
-- SELF/SPOUSE rows (spec s.51) -- no schema change needed for that. This
-- migration is purely additive: two new nullable-safe columns plus a
-- deterministic, evidence-based backfill from legacy
-- retirement_accounts.target_retirement_age. No existing row is deleted, no
-- existing column dropped, no existing constraint loosened.
--
-- Live DEV audit (2026-08-24, read-only REST query, see RM-0 report):
--   366 active retirement_accounts rows, 285 distinct (user_id, self|spouse)
--   groups with >=1 such row. Of those: 182 have a single consistent age
--   (99 self, 83 spouse) with ZERO internal conflicts; 103 have retirement
--   accounts but no target_retirement_age recorded at all (102 self, 1
--   spouse); 0 groups have genuinely CONFLICTING ages (no Case D instances
--   exist in DEV today). 0 retirement_accounts rows already reference
--   retirement_member_id. 0 retirement_members rows exist yet.
--
-- Because production may differ from DEV (spec s.57 "do not assume
-- production matches DEV"), the backfill logic below is written to handle
-- Case D (genuine conflict) correctly and safely even though DEV currently
-- has none: a conflicting group gets a retirement_members row with
-- target_retirement_age left NULL and age_source='needs_confirmation',
-- with every distinct legacy value it saw preserved verbatim in notes --
-- never averaged, never "most common wins", never highest/lowest. This is
-- the same logic that will need to run again (unmodified) against
-- production's real distribution per spec s.57.
begin;

-- ---------------------------------------------------------------------------
-- 1. New columns on retirement_members (spec s.11, s.25, s.39).
-- ---------------------------------------------------------------------------
alter table retirement_members
  -- Non-destructive removal path (spec s.11): a spouse retirement-member
  -- row is never deleted merely because household composition changes --
  -- it is only ever deactivated. Defaults true so every pre-existing/newly
  -- backfilled row starts active. Also lets this table use the same
  -- generic is_active-based registry pattern (lib/services/registry.ts)
  -- every other financial-data table already uses.
  add column if not exists is_active boolean not null default true,
  -- Distinguishes "the user actually confirmed this age" from "this is an
  -- unconfirmed suggestion/default" from "legacy data conflicted and needs
  -- the user's input" (spec s.23-25, s.39). target_retirement_age itself
  -- stays nullable (already true pre-migration) so an unconfirmed member
  -- can exist with no age at all (spec s.26, Case E/F).
  add column if not exists age_source text not null default 'user_confirmed'
    check (age_source in ('user_confirmed', 'suggested_default', 'needs_confirmation'));

comment on column retirement_members.is_active is
  'False when a member (typically spouse) has been removed from active planning without destroying its historical data (spec s.11). Never set true->false by this migration.';
comment on column retirement_members.age_source is
  'Provenance of target_retirement_age: user_confirmed (the user set/kept it), suggested_default (country default shown but not yet confirmed), needs_confirmation (legacy data conflicted -- age is NULL until the user picks one). Spec s.23-25/s.39.';

-- ---------------------------------------------------------------------------
-- 2. Deterministic backfill from retirement_accounts.target_retirement_age
--    into retirement_members, one (user_id, member_type) group at a time.
--    Only owner IN ('self','spouse') rows are considered -- joint/SMSF/other
--    owners do not map to a single individual's retirement age (spec s.18;
--    live DEV audit found 0 such rows anyway, but production is not
--    assumed to match).
-- ---------------------------------------------------------------------------
do $$
declare
  grp record;
  distinct_ages int[];
  distinct_count int;
  legacy_summary text;
begin
  for grp in
    select
      ra.user_id,
      ra.owner as member_type,
      array_agg(distinct ra.target_retirement_age) filter (where ra.target_retirement_age is not null) as ages,
      array_agg(distinct ra.country_code) filter (where ra.country_code is not null) as countries
    from retirement_accounts ra
    where ra.is_active = true
      and ra.owner in ('self', 'spouse')
    group by ra.user_id, ra.owner
  loop
    -- Skip if a retirement_members row already exists for this
    -- (user_id, member_type) -- idempotent re-run safety, and this
    -- migration must never overwrite a value a user has already confirmed
    -- through the new UI ahead of this migration being applied.
    if exists (select 1 from retirement_members rm where rm.user_id = grp.user_id and rm.member_type = grp.member_type) then
      continue;
    end if;

    distinct_ages := grp.ages;
    distinct_count := coalesce(array_length(distinct_ages, 1), 0);

    if distinct_count = 1 then
      -- Case A/B: consistent legacy age across every account for this
      -- member. Safe, unambiguous backfill.
      insert into retirement_members (user_id, member_type, target_retirement_age, country_code, age_source, notes)
      values (
        grp.user_id,
        grp.member_type,
        distinct_ages[1],
        case when grp.countries is not null and array_length(grp.countries, 1) = 1 then grp.countries[1] else null end,
        'user_confirmed',
        format('Backfilled by migration 0077 from %s consistent legacy retirement_accounts.target_retirement_age value(s) of %s.', distinct_count, distinct_ages[1])
      );
    elsif distinct_count > 1 then
      -- Case D: genuine conflict. Never average/mode/min/max (spec s.24).
      -- Preserve every legacy value, leave the canonical age unconfirmed,
      -- and flag for user confirmation.
      legacy_summary := array_to_string(distinct_ages, ', ');
      insert into retirement_members (user_id, member_type, target_retirement_age, country_code, age_source, notes)
      values (
        grp.user_id,
        grp.member_type,
        null,
        case when grp.countries is not null and array_length(grp.countries, 1) = 1 then grp.countries[1] else null end,
        'needs_confirmation',
        format('Migration 0077: legacy retirement_accounts.target_retirement_age values conflicted across this member''s accounts (%s). No value was guessed -- please confirm your target retirement age.', legacy_summary)
      );
    else
      -- Case E: this member has retirement accounts but no legacy age was
      -- ever recorded on any of them. Create the member record so the
      -- account-linkage backfill below can attach to it, but leave the age
      -- itself unconfirmed -- the UI computes and displays a live
      -- suggested country default without ever writing it into this row
      -- as if it were user data (spec s.25).
      insert into retirement_members (user_id, member_type, target_retirement_age, country_code, age_source, notes)
      values (
        grp.user_id,
        grp.member_type,
        null,
        case when grp.countries is not null and array_length(grp.countries, 1) = 1 then grp.countries[1] else null end,
        'suggested_default',
        'Migration 0077: this member has retirement account(s) but no legacy target retirement age was ever recorded. Age left unconfirmed.'
      );
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Link existing retirement_accounts rows to their retirement_member
--    (spec s.18, s.28). Purely relational -- does not touch current_balance,
--    contribution fields, or any other value; zero effect on Net Worth
--    (spec s.46).
-- ---------------------------------------------------------------------------
update retirement_accounts ra
set retirement_member_id = rm.id
from retirement_members rm
where ra.is_active = true
  and ra.owner in ('self', 'spouse')
  and ra.retirement_member_id is null
  and rm.user_id = ra.user_id
  and rm.member_type = ra.owner;

commit;
