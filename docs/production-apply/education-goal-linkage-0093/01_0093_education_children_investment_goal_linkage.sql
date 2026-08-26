-- Education Fund / Children Investment -> Goal Linkage (GL-2/GL-3/GL-6/GL-9).
-- Pure additive + one catalogue deactivation + one hardening trigger + one
-- conservative deterministic backfill. No existing column is dropped,
-- renamed or narrowed; no existing row's current_value/balance is touched.
--
-- NUMBERING NOTE (re-confirmed 2026-08-26 at final-DEV-application time):
-- canonical origin/main is now at ae3d6807 and has advanced past this
-- branch's original a7a86d2 integration point. Its migration ledger is
-- 0090, 0092 (feature/investment-intelligence-r12-wider-india-assets --
-- `0092_ii_r12_wider_india_assets_foundation.sql`, a genuine collision this
-- file's number originally shared before being renumbered 0092 -> 0093),
-- 0094, 0095. 0091 remains claimed only by the still-unmerged
-- `fdh9-payslip-income-intelligence` branch. `node scripts/check-migration-
-- versions-against-branch.mjs --against=origin/main` was re-run immediately
-- before this note was written and reports zero cross-branch collisions
-- for this branch's 0093 against origin/main's current ledger -- 0093 is
-- therefore still the correct, genuinely free number; no further renumber
-- is required. Per this project's binding numbering rule (docs/
-- architecture/ADR_MIGRATION_LINEAGE_RECONCILIATION.md): "never renumber a
-- migration that has already been applied to a shared environment", and
-- per that same ADR's finding that this project applies every migration by
-- hand-pasting SQL into the Supabase dashboard (no CLI project link, no
-- `supabase_migrations.schema_migrations` ledger is ever populated),
-- there is no technical ordering enforcement at all -- applying this
-- 0093-numbered file to an environment where higher-numbered 0094/0095
-- already ran is exactly as safe as applying it in strict numeric order,
-- provided (confirmed true here) every statement in it remains idempotent.
--
-- RELATIONSHIP TO 0095: this file's original section 2 (the
-- `gfs_enforce_ownership` trigger + `goal_funding_sources` RLS hardening)
-- was subsequently extracted verbatim into its own standalone migration,
-- `0095_goal_funding_sources_authoritative_forgery_hotfix.sql`, so that the
-- security fix could ship to production ahead of this feature's own
-- timeline (see 0095's header for the full rationale). 0095 is already
-- merged to `main` and live in production and DEV as of this writing --
-- confirmed live via `scripts/egl_live_dev_security_probe.mjs`, which now
-- observes the forged cross-tenant probe rejected with 0095's exact
-- `gfs_enforce_ownership` error text. This file's own copy of that same
-- section is INTENTIONALLY left in place rather than deleted: 0095's own
-- header explicitly anticipates and blesses this exact re-run ("Applying
-- 0093 in full at a later date... will re-run this same trigger-function/
-- trigger/policy definition... all safe to re-run"), every statement in it
-- is `create or replace` / `drop ... if exists` + `create`, and rewriting
-- this file to instead assert 0095 already ran would require restructuring
-- this feature's already-certified (32/32) PGlite harness for zero
-- additional safety -- 0095 is never weakened, narrowed, or diverged from
-- by keeping it. No second, different security mechanism is introduced.
--
-- Context: see GL-0 discovery findings (reported alongside this migration).
-- The core discovery is that the canonical Goal<->Investment funding
-- relationship this release needs ALREADY EXISTS, built in migration 0009
-- (goal_funding_sources: source_type/linked_investment_id/linked_asset_id/
-- linked_retirement_id/allocation_percentage) and already enforced against
-- double-allocation by lib/services/goalFundingAllocation.ts's
-- checkFundingAllocation() (<=100% cap per linked balance across goals).
-- Investment Intelligence R1/R9 already write through this exact mechanism
-- (ii_goal_allocations -> goal_funding_sources, migrations 0034/0067,
-- R0_GOAL_INTEGRATION_CONTRACT.md). Migration 0074 (Assets/Investments/
-- Retirement Consolidation) already identified education_fund and
-- children_investment as purpose labels, not asset classes, and explicitly
-- deferred retiring them "for future Goal-linkage refactor (spec s.63)" --
-- this migration is that refactor. No second Goal-linking system is
-- introduced; no new goal_funding_sources-equivalent table is created.
--
-- Idempotent: every statement is either IF NOT EXISTS/OR REPLACE DDL, a
-- plain UPDATE keyed on (category, item_key), or an INSERT..SELECT guarded
-- by NOT EXISTS.

begin;

-- ---------------------------------------------------------------------------
-- 1. Retire Education Fund / Children Investment from NEW investment
--    creation (spec s.12-13, s.23, s.65). Mirrors migration 0072/0074's own
--    is_active=false + governance_note pattern exactly. NOT deactivated:
--    any existing user row referencing these keys (FinancialDataGrid's
--    "orphaned rows" fallback -- built for this exact purpose during the
--    A/I/R consolidation -- continues to render, edit and count them; see
--    lib/services/masterItems.ts's listMasterItems(), which is the only
--    reader of is_active for the catalogue list new rows are offered from).
-- ---------------------------------------------------------------------------
update master_financial_items set
  is_active = false,
  governance_note = 'Retired from new-investment creation 2026-08-26 (Education/Children Investment -> Goal Linkage release, spec s.12-13/23/65): this item names a savings PURPOSE, not a financial instrument. The actual holding should be entered under its real investment type (Shares/ETF/Managed Fund/Term Deposit/Bond/Other Investment) and optionally linked to an Education/Family goal via goal_funding_sources (migration 0009), which already supports this relationship. Existing rows are preserved exactly as recorded -- see FinancialDataGrid.tsx orphaned-row rendering -- and continue to count in Investments/Net Worth unchanged; only new selection of this catalogue item is disabled.'
where category = 'investment' and item_key in ('education_fund', 'children_investment') and is_active = true;

-- ---------------------------------------------------------------------------
-- 2. goal_funding_sources ownership-validating trigger (spec s.60-61 --
--    "apply the security lesson learned from Property <-> Liability
--    Linking"). Migration 0009's original RLS policy is `auth.uid() =
--    user_id` only, on BOTH sides (using + with check) -- it never verifies
--    that goal_id, linked_asset_id, linked_investment_id or
--    linked_retirement_id actually belong to that same user_id. An attacker
--    whose own user_id is legitimately their own could still reference
--    another tenant's goal (writing a funding-source row that dangles off
--    someone else's goal_id) or another tenant's asset/investment/
--    retirement row (referencing a balance they do not own) purely by
--    guessing its UUID -- the FK only proves the row exists, not who owns
--    it (the exact PL-0 finding that produced the 0078 fix, section 60's
--    own explicit precedent).
--
--    A TRIGGER is used here rather than (only) an RLS WITH CHECK rewrite,
--    because two live write paths reach this table: the goals-side route
--    (app/api/goals/[id]/funding-sources, a normal RLS-governed
--    user-scoped client) AND the Investment-Intelligence-side sync
--    (lib/services/investment-intelligence/goalAllocations.ts, which
--    writes through the SERVICE-ROLE admin client and therefore bypasses
--    RLS entirely). RLS alone would leave the II write path unguarded at
--    the database layer (its existing app-layer assertOwnsInvestment()
--    check is real but is application code, not a database guarantee).
--    A BEFORE INSERT/UPDATE trigger fires for every role, service_role
--    included, so this is enforced regardless of which path performs the
--    write -- true defense in depth, matching spec s.61's "enforce at
--    canonical/server/database layer... do not rely solely on the UI."
--    Legitimate writes are unaffected: every existing caller (the goals
--    route, and goalAllocations.ts's own assertOwnsInvestment() check)
--    already only ever submits a goal_id/linked_*_id it has separately
--    verified belongs to the same user_id, so this trigger never rejects
--    real traffic -- only forged cross-tenant references.
--
--    NOTE: this section was later extracted verbatim into its own
--    standalone migration, 0095_goal_funding_sources_authoritative_
--    forgery_hotfix.sql, which shipped to DEV/production ahead of this
--    feature. Re-running it here is a deliberate, declared-safe no-op on
--    any environment where 0095 already ran (see the numbering note above)
--    -- it never introduces a second/different enforcement mechanism.
-- ---------------------------------------------------------------------------
create or replace function gfs_enforce_ownership() returns trigger as $$
begin
  if not exists (select 1 from user_goals where id = new.goal_id and user_id = new.user_id) then
    raise exception 'goal_funding_sources: goal % is not owned by user %', new.goal_id, new.user_id
      using errcode = '42501';
  end if;
  if new.linked_asset_id is not null and not exists (select 1 from assets where id = new.linked_asset_id and user_id = new.user_id) then
    raise exception 'goal_funding_sources: linked asset % is not owned by user %', new.linked_asset_id, new.user_id
      using errcode = '42501';
  end if;
  if new.linked_investment_id is not null and not exists (select 1 from investments where id = new.linked_investment_id and user_id = new.user_id) then
    raise exception 'goal_funding_sources: linked investment % is not owned by user %', new.linked_investment_id, new.user_id
      using errcode = '42501';
  end if;
  if new.linked_retirement_id is not null and not exists (select 1 from retirement_accounts where id = new.linked_retirement_id and user_id = new.user_id) then
    raise exception 'goal_funding_sources: linked retirement account % is not owned by user %', new.linked_retirement_id, new.user_id
      using errcode = '42501';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_gfs_enforce_ownership on goal_funding_sources;
create trigger trg_gfs_enforce_ownership
  before insert or update of goal_id, user_id, linked_asset_id, linked_investment_id, linked_retirement_id
  on goal_funding_sources
  for each row execute function gfs_enforce_ownership();

-- RLS WITH CHECK hardening (spec s.60) -- the same ownership checks as the
-- trigger above, expressed at the policy layer too, so a direct PostgREST
-- call under a real user JWT is rejected by RLS before it ever reaches the
-- trigger (belt and suspenders; identical semantics to property_liability_
-- links' own policy, migration 0078). USING is unchanged (auth.uid() =
-- user_id already correctly scopes reads/updates/deletes to one's own
-- rows); only WITH CHECK gains the referenced-row ownership clauses.
drop policy if exists "own goal funding sources" on goal_funding_sources;
create policy "own goal funding sources" on goal_funding_sources
  for all
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and goal_id in (select id from user_goals where user_id = auth.uid())
    and (linked_asset_id is null or linked_asset_id in (select id from assets where user_id = auth.uid()))
    and (linked_investment_id is null or linked_investment_id in (select id from investments where user_id = auth.uid()))
    and (linked_retirement_id is null or linked_retirement_id in (select id from retirement_accounts where user_id = auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- 3. Conservative, deterministic-only backfill (spec s.20, s.50 -- "Existing
--    Goal Takes Priority"). Auto-links ONLY when, for a given user: exactly
--    one active legacy Education/Children investment record exists, exactly
--    one active goal tagged goal_category='education' exists, currencies
--    match, and no funding-source link already exists for either side --
--    four independent corroborating signals, the same conservative bar
--    0078 set (never balance/name/creation-time alone). Any user with
--    two-or-more candidates on either side, a currency mismatch, or an
--    already-existing link is left entirely unlinked -- ambiguous cases are
--    never guessed (spec s.15 PROBABLE/UNKNOWN are preserved as-is, not
--    auto-converted). 100% allocation on the single matched investment is
--    the conservative default (spec s.9 exclusive-allocation model); the
--    user can repartition later via the Goals or Investments UI, both of
--    which now route through the very same checkFundingAllocation() cap.
-- ---------------------------------------------------------------------------
insert into goal_funding_sources
  (goal_id, user_id, source_type, linked_investment_id, allocated_amount, allocation_percentage, currency_code, is_active)
select g.id, i.user_id, 'investment', i.id, i.current_value, 100, i.currency_code, true
from investments i
join user_goals g
  on g.user_id = i.user_id
 and g.goal_category = 'education'
 and g.status = 'active'
 and g.currency_code = i.currency_code
where i.master_item_key in ('education_fund', 'children_investment')
  and i.is_active = true
  and (select count(*) from investments i2 where i2.user_id = i.user_id and i2.master_item_key in ('education_fund', 'children_investment') and i2.is_active = true) = 1
  and (select count(*) from user_goals g2 where g2.user_id = i.user_id and g2.goal_category = 'education' and g2.status = 'active') = 1
  and not exists (select 1 from goal_funding_sources x where x.linked_investment_id = i.id and x.is_active = true)
  and not exists (select 1 from goal_funding_sources x where x.goal_id = g.id and x.is_active = true and x.source_type = 'investment');

commit;
