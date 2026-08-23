-- Phase 0C: canonical per-user, per-section review status.
--
-- Phase 0B found that healthScore.ts and resilience.ts were inferring
-- "confirmed zero debt" / "confirmed no insurance" purely from an absence
-- of rows plus a loose hasEngaged() heuristic — the user never actually
-- confirmed either. This table lets a household explicitly confirm
-- "I have none of this" (reviewed_zero) or "this doesn't apply to me"
-- (not_applicable), distinct from simply not having gotten to a section
-- yet. It is intentionally sparse: 'reviewed_with_data' and 'not_started'
-- are never persisted here — they're derived at read time from whether
-- real rows exist for that category (see lib/engines/financialSectionStatus.ts),
-- so this table only ever needs to hold the two states that can't be
-- inferred from row presence alone.
--
-- Additive only. Does not touch, rename, or drop any existing column or
-- table. user_profiles.not_applicable_{investments,retirement,insurance}
-- (migration 0029) are left in place for backwards compatibility and are
-- read once, below, only to seed this table for users who already set them
-- — they are not otherwise written to going forward; the section-status
-- table becomes the canonical source engines read from.
create table user_financial_section_status (
  user_id uuid not null references auth.users(id) on delete cascade,
  section text not null check (section in (
    'household', 'income', 'expenses', 'assets', 'liabilities',
    'investments', 'retirement', 'insurance'
  )),
  -- Only these two states are ever written here — see comment above.
  status text not null check (status in ('reviewed_zero', 'not_applicable')),
  updated_at timestamptz not null default now(),
  primary key (user_id, section)
);

alter table user_financial_section_status enable row level security;

create policy "own financial section status" on user_financial_section_status
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Backfill: seed 'not_applicable' rows from the existing opt-out booleans so
-- no user who already confirmed "I don't have investments/retirement/
-- insurance" loses that confirmation when the engines switch over to
-- reading this table. Deliberately does NOT infer 'reviewed_zero' for
-- liabilities/insurance from an absence of rows anywhere in this backfill —
-- per the Phase 0C decision, ambiguous historical absence must stay
-- unconfirmed (derived as 'not_started'/'in_progress' at read time) rather
-- than being auto-confirmed as zero.
insert into user_financial_section_status (user_id, section, status)
select user_id, 'investments', 'not_applicable' from user_profiles where not_applicable_investments = true
on conflict (user_id, section) do nothing;

insert into user_financial_section_status (user_id, section, status)
select user_id, 'retirement', 'not_applicable' from user_profiles where not_applicable_retirement = true
on conflict (user_id, section) do nothing;

insert into user_financial_section_status (user_id, section, status)
select user_id, 'insurance', 'not_applicable' from user_profiles where not_applicable_insurance = true
on conflict (user_id, section) do nothing;

-- Rollback notes (manual — this repo has no down-migration runner):
--   drop policy "own financial section status" on user_financial_section_status;
--   drop table user_financial_section_status;
-- Safe to run at any time: no other table has a foreign key into this one,
-- and no existing column was altered by this migration, so rolling it back
-- returns the schema exactly to its pre-0031 state with no data loss
-- outside this table itself.
