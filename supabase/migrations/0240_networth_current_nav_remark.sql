-- Net Worth follows the latest eligible NAV for published mutual funds
-- (Product Owner decision 2026-10-01).
--
-- WHAT THIS ADDS (additive only; nothing existing is altered or dropped)
--   1. Six NULLABLE columns on `investments` recording WHAT the current-NAV
--      re-mark used for an Investment-Intelligence-published row, so every
--      screen can show "valued at NAV 112.00 dated 2026-09-30" instead of an
--      unlabelled number:
--        ii_value_as_of            the date the value is "as at" (the NAV's own
--                                  date, or the certified statement's date)
--        ii_valuation_basis        'market_nav' | 'statement' | 'redeemed'
--        ii_valuation_units        the units that were valued (the CERTIFIED
--                                  snapshot's units, never a later statement's)
--        ii_valuation_nav          NAV per unit that produced the value
--        ii_valuation_fingerprint  deterministic identity of the inputs; makes
--                                  the re-mark idempotent and compare-and-set
--        ii_valuation_remarked_at  when the re-mark last wrote this row
--      All are NULL for every manual row and for every published row until its
--      first re-mark. `current_value` itself keeps its meaning: the amount Net
--      Worth counts. Staleness is deliberately NOT stored (it is a function of
--      today's date).
--   2. `ii_investment_value_revisions`: an append-only revision log, one row
--      per landed change to a published row's value (previous value, new value,
--      basis, units, NAV, dates, reason, trigger, fingerprint, rule version).
--      Written by the service role only (no authenticated INSERT/UPDATE/DELETE
--      policy, exactly like ii_audit_events); the owner may read their own rows.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--   * It does not touch `ii_fhip_publications`: `published_value` stays the
--     immutable record of the certified statement value, and the unique
--     active-position index from 0042 (a position reaches `investments`
--     EXACTLY ONCE) is untouched.
--   * It does not recreate, widen or drop any CHECK constraint on an existing
--     column. The one CHECK below is on a column this migration itself creates,
--     under a new name, so there is no predecessor to derive and nothing a
--     sibling branch's widening could be silently revoked by (the
--     drop-and-recreate trap recorded in the migration ledger discipline).
--     `ii_audit_events.event_type` is NOT widened: the revision table is the
--     audit trail for this mechanism, so no shared constraint is involved.
--   * It does not backfill. Existing published rows are evaluated lazily by the
--     application on first read (the baseline revision records the value they
--     already had), so applying this file changes no number by itself.
--
-- DEPLOYMENT ORDER. The application reads the new columns with a fallback to the
-- old column list (lib/read-models/investments.ts) and the re-mark service
-- fails soft when they are missing, so deploying the code before this migration
-- degrades to the previous behaviour (frozen statement value) rather than
-- breaking Net Worth. Apply this file to DEV first.
--
-- NUMBERING. Chosen above every migration found on any local or remote branch
-- and in every worktree under .claude/worktrees at authoring time (highest in
-- flight: 0239); see docs/investment-intelligence/NETWORTH_NAV_REMARK_REPORT.md
-- section 7 for the scan evidence.
--
-- IDEMPOTENT: every statement is guarded (add column if not exists, create table
-- if not exists, guarded constraint/policy creation); applying it twice is a no-op.
-- Not applied to DEV or production by the author (no DDL channel in this
-- environment). Application is a Product Owner / operator action.

alter table investments add column if not exists ii_value_as_of date;
alter table investments add column if not exists ii_valuation_basis text;
alter table investments add column if not exists ii_valuation_units numeric(20, 6);
alter table investments add column if not exists ii_valuation_nav numeric(20, 6);
alter table investments add column if not exists ii_valuation_fingerprint text;
alter table investments add column if not exists ii_valuation_remarked_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'chk_investments_ii_valuation_basis' and conrelid = 'investments'::regclass
  ) then
    alter table investments
      add constraint chk_investments_ii_valuation_basis
      check (ii_valuation_basis is null or ii_valuation_basis in ('market_nav', 'statement', 'redeemed'));
  end if;
end
$$;

create table if not exists ii_investment_value_revisions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  investment_id uuid not null references investments(id) on delete cascade,
  publication_id uuid references ii_fhip_publications(id) on delete set null,
  instrument_id uuid references ii_instruments(id) on delete set null,
  reason text not null check (reason in ('baseline', 'nav_update', 'nav_correction', 'units_changed', 'drift_correction')),
  remark_trigger text not null check (remark_trigger in ('dashboard_read', 'investments_read', 'report_read', 'publish', 'refresh', 'republish', 'manual')),
  previous_value numeric(18, 2) not null,
  new_value numeric(18, 2) not null check (new_value >= 0),
  previous_basis text check (previous_basis is null or previous_basis in ('market_nav', 'statement', 'redeemed')),
  new_basis text not null check (new_basis in ('market_nav', 'statement', 'redeemed')),
  units numeric(20, 6) not null,
  nav numeric(20, 6),
  value_as_of date,
  statement_as_of date,
  statement_value numeric(18, 2),
  fingerprint text not null,
  rule_version text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_ii_investment_value_revisions_investment
  on ii_investment_value_revisions (investment_id, created_at desc);
create index if not exists idx_ii_investment_value_revisions_user
  on ii_investment_value_revisions (user_id);

alter table ii_investment_value_revisions enable row level security;

-- Read-only for the owner. No INSERT/UPDATE/DELETE policy exists for the
-- authenticated role at all: only the service role (which bypasses RLS) writes,
-- so a user can never forge or rewrite the history of what Net Worth used.
drop policy if exists "read own ii_investment_value_revisions" on ii_investment_value_revisions;
create policy "read own ii_investment_value_revisions" on ii_investment_value_revisions
  for select using (auth.uid() = user_id);
