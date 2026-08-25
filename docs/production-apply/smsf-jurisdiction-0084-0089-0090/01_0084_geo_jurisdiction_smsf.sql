-- GEO-1/GEO-2 Jurisdiction Applicability Foundation + SMSF-1/2/5/6 (AU-only)
-- Summary/Detailed Holdings.
--
-- NUMBERING NOTE: canonical origin/main (fbec286) ends at
-- 0077_retirement_member_target_age.sql at the time this file was written.
-- Live migration-numbering landscape re-verified directly (not assumed)
-- immediately before writing this file: 0078 (Property<->Liability Linking)
-- exists only on unmerged local branch worktree-agent-a0a30e8590a628cf5
-- (commit b99b5b2) -- NOT on origin/main, NOT pushed to any remote, and NOT
-- "already live in production" (a claim carried into this task's briefing
-- from a prior crashed attempt that this migration's author found to be
-- stale/incorrect on direct re-verification: `git merge-base --is-ancestor
-- b99b5b2 origin/main` returns false). 0079-0081 (App Review remainder) and
-- 0082-0083 (Investment Intelligence R11) likewise exist only on their own
-- unmerged branches. 0084 was the next free slot with zero collisions
-- across every live branch/worktree checked (including uncommitted working
-- trees, not just committed refs) at the time this file was finalised, and
-- was re-checked again immediately before this migration's DEV certification
-- run. This migration's own SMSF property/loan integration (section 4 below)
-- genuinely depends on the property_liability_links table, so
-- 0078_property_liability_linking.sql was copied byte-for-byte (verified via
-- `diff`, zero modifications) from the sibling branch into this branch's
-- migrations folder purely so this branch's own chain replays end-to-end in
-- isolation. This is NOT an attempt to claim authorship of that migration or
-- to merge branches -- when the property-liability branch and this branch
-- are eventually reconciled by a human/orchestrator merge step, the
-- duplicate 0078 file is byte-identical and trivially de-duplicates (same
-- established pattern as this project's prior FDH-3+R6 migration-lineage
-- reconciliation). If, by the time this reaches DEV, 0078-0083 have already
-- landed on canonical main under different numbers, this file renumbers to
-- the next free slot per this project's own established collision
-- precedent -- whichever migration is already live on DEV always keeps its
-- number.
--
-- Scope:
--   1. Canonical home-jurisdiction discovery recorded in comments (no schema
--      change needed -- user_profiles.country_of_residence already exists,
--      confirmed authoritative by direct read-site tracing: every country-
--      gating decision in the app already reads it directly; households.
--      primary_country is a passive one-way copy taken from it at onboarding
--      time (app/(onboarding)/onboarding/OnboardingWizard.tsx) and is never
--      independently read for logic branching anywhere in the app).
--   2. GEO-1 Applicability Model: extend master_financial_items with the
--      same country_applicability char(2)[] convention already established
--      (dormant) on goal_types (migration 0009) and fdh_categories/
--      fdh_subcategories/fdh_classification_rules (migration 0045) --
--      NULL = globally applicable, non-null = restricted to those ISO codes.
--      Unlike its two prior uses, this release actually wires runtime
--      filtering into the API layer that serves this catalogue (see
--      lib/services/masterItems.ts / app/api/master-items/route.ts) so the
--      column is not dead weight a third time.
--   3. GEO-2 SMSF AU Gate: SMSF (retirement/smsf) is the one catalogue item
--      this release has concrete evidence is Australia-specific. Server-side
--      enforcement via a BEFORE INSERT/UPDATE trigger on retirement_accounts
--      (not just the Next.js API route) so a forged direct PostgREST request
--      is rejected exactly the same as a request through the app's own API
--      (spec s.6-7, s.33, JUR-03).
--   4. SMSF-1/2/5/6: smsf_funds / smsf_fund_members / smsf_holdings --
--      genuinely separate Fund/Members/Holdings concepts (spec s.19-20),
--      reusing the certified retirement_members table for member identity
--      (no parallel member concept) and the certified property_liability_
--      links table for SMSF property<->loan relationships (no second
--      relationship mechanism; link_type='smsf_property_loan' and
--      linked_retirement_id were both already reserved in 0078 exactly for
--      this). retirement_accounts.current_balance remains the ONLY figure
--      computeDashboard() ever reads for Net Worth (lib/engines/dashboard.ts
--      is NOT modified by this migration) -- Summary/Detailed holdings feed
--      that single number via smsf_recompute_fund(), never in addition to
--      it, which is what makes "exactly one active valuation source"
--      structurally guaranteed rather than merely convention.
--
-- Idempotent: IF NOT EXISTS / OR REPLACE / ON CONFLICT DO NOTHING throughout;
-- backfills use NOT EXISTS guards.

begin;

-- ===========================================================================
-- PART 1 -- GEO-1 Applicability Model
-- ===========================================================================

alter table master_financial_items
  add column if not exists country_applicability char(2)[];

comment on column master_financial_items.country_applicability is
  'ISO-3166-1 alpha-2 codes this catalogue item is available for NEW creation in (same convention as goal_types.country_applicability [0009] and fdh_categories/fdh_subcategories.country_applicability [0045]). NULL = globally applicable to every supported country. Governs creation/UI-offer filtering only (lib/services/masterItems.ts) -- NEVER used to hide, delete, or stop counting a user''s already-existing rows toward Net Worth (spec s.39-42); existing rows remain fully readable/editable/summed regardless of the item''s current country_applicability or the user''s current country_of_residence.';

alter table master_financial_items drop constraint if exists chk_mfi_country_applicability_valid;
alter table master_financial_items
  add constraint chk_mfi_country_applicability_valid check (
    country_applicability is null
    or (array_length(country_applicability, 1) >= 1 and country_applicability <@ array['AU','IN']::char(2)[])
  );

-- Backfill: SMSF is the only catalogue item this release has concrete,
-- spec-mandated evidence is Australia-specific (spec s.6-7, s.18-31). Other
-- AU-flavoured retirement items (industry_super, retail_super,
-- defined_benefit, transition_to_retirement, allocated_pension,
-- account_based_pension) are deliberately left unrestricted (NULL) --
-- flagged instead in this release's country-segregation audit backlog
-- (spec s.36-38, s.53) pending an explicit product decision, per this
-- task's own instruction not to "automatically redesign every existing
-- module" or "claim regulatory classification where the catalogue doesn't
-- provide enough evidence."
update master_financial_items
set country_applicability = array['AU']::char(2)[]
where category = 'retirement' and item_key = 'smsf'
  and (country_applicability is null or country_applicability <> array['AU']::char(2)[]);

-- ===========================================================================
-- PART 2 -- GEO-2 SMSF Australia Gate (defence-in-depth: DB trigger, not
-- just application code, so a forged direct PostgREST request is blocked
-- the same as a request through the app's own API route).
-- ===========================================================================

create or replace function retirement_accounts_smsf_au_gate() returns trigger as $$
declare
  is_au boolean;
begin
  -- Only the transition INTO an active SMSF row is gated: a brand new
  -- INSERT, or an UPDATE that reactivates a previously-archived row
  -- (old.is_active = false -> new.is_active = true). Editing an
  -- ALREADY-active SMSF row's other fields (balance, notes, ...) is never
  -- blocked here regardless of the user's current country -- that is
  -- legitimate maintenance of a preserved historical holding (spec s.8,
  -- s.34-35: never hide or freeze an existing legitimate holding just
  -- because the user's home jurisdiction changed), not "creating a new
  -- country-specific product."
  if new.master_item_key = 'smsf' and new.is_active = true
     and (tg_op = 'INSERT' or (tg_op = 'UPDATE' and coalesce(old.is_active, false) = false)) then
    select (p.country_of_residence = 'AU') into is_au
    from user_profiles p
    where p.user_id = new.user_id;

    if coalesce(is_au, false) is not true then
      raise exception 'smsf: creating or reactivating an SMSF is only available to users whose home jurisdiction (country_of_residence) is Australia'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_retirement_accounts_smsf_au_gate on retirement_accounts;
create trigger trg_retirement_accounts_smsf_au_gate
  before insert or update of master_item_key, is_active on retirement_accounts
  for each row execute function retirement_accounts_smsf_au_gate();

comment on function retirement_accounts_smsf_au_gate() is
  'GEO-2 server-side jurisdiction gate (spec s.6-7, s.33, JUR-03). Runs as the invoking role (not SECURITY DEFINER): its own SELECT against user_profiles is itself RLS-scoped to auth.uid(), so a forged new.user_id belonging to a different tenant sees zero rows (is_au stays NULL) and is rejected the same as a genuine non-AU resident -- fails closed either way.';

-- ===========================================================================
-- PART 3 -- SMSF Fund / Members / Holdings model
-- ===========================================================================

create table if not exists smsf_funds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- The fund's single canonical Net Worth home (spec: "SMSF has exactly one
  -- canonical home: Retirement > SMSF", established by the AIR
  -- consolidation, migrations 0072-0074). Exactly one fund per retirement
  -- row; must be the catalogue's smsf row (enforced by trigger below, not
  -- just the FK, since the FK alone cannot check master_item_key).
  retirement_account_id uuid not null references retirement_accounts(id) on delete cascade,
  fund_name text not null,
  mode text not null default 'summary' check (mode in ('summary', 'detailed')),
  -- Summary Mode figures (spec s.20-22). Semantics: net-SMSF-value (fund's
  -- net assets), matching the same "current_balance is a net lump-sum"
  -- semantics retirement_accounts.current_balance already has for every
  -- other retirement item -- see comment below on why an SMSF loan is never
  -- separately subtracted from Net Worth again in Summary Mode.
  summary_balance numeric(18, 2) check (summary_balance >= 0),
  summary_balance_date date,
  -- Detailed Mode figures (spec s.23, computed by smsf_recompute_fund()).
  -- No >=0 check: this is a computed preview/actual net figure (holdings
  -- minus linked loans), not a directly-entered amount -- it is legitimately
  -- negative during the staged-reconciliation building process (e.g. a loan
  -- linked before its offsetting holdings are entered) and, in principle,
  -- for a fund that is genuinely underwater. Only smsf_holdings.value and
  -- liabilities.balance (the real entered amounts) are non-negative.
  detailed_net_value numeric(18, 2),
  activated_detailed_at timestamptz,
  -- Fund jurisdiction currency (always AUD -- an AU SMSF's own reporting
  -- currency). Individual holdings keep their own currency_code/country_code
  -- (spec s.32: "do not force all holdings to AUD merely because
  -- home_jurisdiction=AU").
  currency_code char(3) not null default 'AUD' references currencies(currency_code),
  notes text,
  is_active boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (retirement_account_id)
);

comment on column smsf_funds.summary_balance is
  'Net-SMSF-value (fund net assets), NOT gross-asset-value. A separately recorded SMSF property loan (liabilities row linked via property_liability_links, link_type=smsf_property_loan) is never additionally subtracted from Net Worth while mode=summary -- retirement_accounts.current_balance already carries the net figure exactly once (spec s.21-22 hard integrity requirement). The loan liability itself still appears once in totalLiabilities via its own liabilities row, exactly as any other liability does -- this comment concerns Net Worth double-subtraction, not the liability''s own single appearance.';

create or replace function smsf_funds_validate_retirement_link() returns trigger as $$
declare
  ra_key text;
  ra_user uuid;
begin
  select master_item_key, user_id into ra_key, ra_user
  from retirement_accounts where id = new.retirement_account_id;
  if ra_key is distinct from 'smsf' then
    raise exception 'smsf_funds: retirement_account_id must reference a retirement_accounts row with master_item_key = smsf' using errcode = '23514';
  end if;
  if ra_user is distinct from new.user_id then
    raise exception 'smsf_funds: retirement_account_id must belong to the same user' using errcode = '42501';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_smsf_funds_validate_link on smsf_funds;
create trigger trg_smsf_funds_validate_link
  before insert or update of retirement_account_id on smsf_funds
  for each row execute function smsf_funds_validate_retirement_link();

create index if not exists idx_smsf_funds_user on smsf_funds(user_id);

-- Members (spec s.19-20: reuse the certified retirement_members table --
-- no parallel member concept). member_interest_amount is informational
-- attribution only, exactly like property_liability_links.allocation_amount
-- -- it never itself feeds Net Worth; the fund's own summary_balance /
-- detailed_net_value is what is counted, exactly once, regardless of how
-- many members are attached (spec s.29-30 double-count negative control).
create table if not exists smsf_fund_members (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  smsf_fund_id uuid not null references smsf_funds(id) on delete cascade,
  retirement_member_id uuid not null references retirement_members(id) on delete cascade,
  member_interest_amount numeric(18, 2) check (member_interest_amount >= 0),
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (smsf_fund_id, retirement_member_id)
);

create index if not exists idx_smsf_fund_members_fund on smsf_fund_members(smsf_fund_id);
create index if not exists idx_smsf_fund_members_user on smsf_fund_members(user_id);

-- Holdings (spec s.23: Detailed Mode). holding_class groups the spec's five
-- buckets (Cash/Banking, Listed Investments, Fixed Income, Property, Other);
-- holding_type is the specific spec-listed type within that bucket.
create table if not exists smsf_holdings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  smsf_fund_id uuid not null references smsf_funds(id) on delete cascade,
  holding_class text not null check (holding_class in ('cash', 'listed_investment', 'fixed_income', 'property', 'other')),
  holding_type text not null check (holding_type in (
    'cash', 'cash_account', 'term_deposit',
    'au_shares', 'international_shares', 'etf', 'managed_fund', 'index_fund', 'reit',
    'government_bond', 'corporate_bond', 'other_bond',
    'residential_property', 'commercial_property', 'other_smsf_property',
    'gold_precious_metals', 'private_unlisted', 'crypto', 'other_smsf_asset'
  )),
  holding_name text not null,
  value numeric(18, 2) not null check (value >= 0),
  -- Multi-currency (spec s.32): each holding keeps its own currency/country,
  -- never forced to AUD merely because the fund's home jurisdiction is AU.
  currency_code char(3) not null references currencies(currency_code),
  country_code char(2) references countries(country_code),
  -- Rental income display-only reference (spec s.28: "may reference/display
  -- Rental Income, never create a second independent rental-income cash-flow
  -- source"). Only meaningful for holding_class='property'; the canonical
  -- income figure stays solely in income_sources, read-only from here.
  linked_income_source_id uuid references income_sources(id) on delete set null,
  notes text,
  is_active boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint chk_smsf_holdings_class_type check (
    (holding_class = 'cash' and holding_type in ('cash', 'cash_account', 'term_deposit'))
    or (holding_class = 'listed_investment' and holding_type in ('au_shares', 'international_shares', 'etf', 'managed_fund', 'index_fund', 'reit'))
    or (holding_class = 'fixed_income' and holding_type in ('government_bond', 'corporate_bond', 'other_bond'))
    or (holding_class = 'property' and holding_type in ('residential_property', 'commercial_property', 'other_smsf_property'))
    or (holding_class = 'other' and holding_type in ('gold_precious_metals', 'private_unlisted', 'crypto', 'other_smsf_asset'))
  ),
  constraint chk_smsf_holdings_income_link_property_only check (
    linked_income_source_id is null or holding_class = 'property'
  )
);

comment on column smsf_holdings.linked_income_source_id is
  'Read-only display reference to the canonical income_sources row for this SMSF property''s rental income (spec s.28). Never a second cash-flow source -- the income figure is only ever counted once, via income_sources, by the existing income engine.';

create index if not exists idx_smsf_holdings_fund on smsf_holdings(smsf_fund_id) where is_active;
create index if not exists idx_smsf_holdings_user on smsf_holdings(user_id);
create index if not exists idx_smsf_holdings_income on smsf_holdings(linked_income_source_id) where linked_income_source_id is not null;

-- ===========================================================================
-- PART 4 -- Valuation engine: exactly-one-active-valuation-source (spec
-- s.18, s.24-27, SMSF-6). retirement_accounts.current_balance is the ONLY
-- figure computeDashboard() reads (lib/engines/dashboard.ts is untouched by
-- this migration) -- these functions are the sole path by which Summary or
-- Detailed values ever reach it, which is what makes "never both
-- simultaneously" a structural guarantee rather than a convention every
-- future code path has to remember.
-- ===========================================================================

-- Sum of this fund's active holdings, converted to AUD, using the same
-- fx_rate_aud_inr convention as lib/engines/fx.ts (INR per 1 AUD; AUD value
-- = INR value / rate) so the DB-side computation can never quietly drift
-- from the TS-side one.
create or replace function smsf_holdings_total_aud(p_fund_id uuid) returns numeric as $$
declare
  fx numeric;
  total numeric;
begin
  select assumption_value into fx
  from forecast_global_assumptions
  where assumption_key = 'fx_rate_aud_inr' and country_code is null and is_active = true
  limit 1;
  fx := coalesce(fx, 56.0); -- matches 0016's own documented indicative default

  select coalesce(sum(
    case when currency_code = 'INR' then value / fx else value end
  ), 0) into total
  from smsf_holdings
  where smsf_fund_id = p_fund_id and is_active = true;

  return total;
end;
$$ language plpgsql stable;

-- Sum of liabilities linked to this fund as SMSF property loans (spec s.27:
-- "Property stays gross, loan stays a separate canonical liability" -- this
-- reads liabilities.balance directly, never a second stored copy of it),
-- converted to AUD the same way.
create or replace function smsf_linked_loans_total_aud(p_fund_id uuid) returns numeric as $$
declare
  fx numeric;
  total numeric;
  v_retirement_account_id uuid;
begin
  select retirement_account_id into v_retirement_account_id from smsf_funds where id = p_fund_id;

  select assumption_value into fx
  from forecast_global_assumptions
  where assumption_key = 'fx_rate_aud_inr' and country_code is null and is_active = true
  limit 1;
  fx := coalesce(fx, 56.0);

  select coalesce(sum(
    case when l.currency_code = 'INR' then l.balance / fx else l.balance end
  ), 0) into total
  from property_liability_links pll
  join liabilities l on l.id = pll.liability_id
  where pll.linked_retirement_id = v_retirement_account_id
    and pll.link_type = 'smsf_property_loan'
    and pll.is_active = true
    and l.is_active = true;

  return total;
end;
$$ language plpgsql stable;

create or replace function smsf_compute_detailed_net_value(p_fund_id uuid) returns numeric as $$
begin
  return smsf_holdings_total_aud(p_fund_id) - smsf_linked_loans_total_aud(p_fund_id);
end;
$$ language plpgsql stable;

-- Recompute + sync (spec s.18, s.24 step 3-4). While mode='summary', this
-- ONLY updates smsf_funds.detailed_net_value (a live preview used for the
-- staged reconciliation UI) -- retirement_accounts.current_balance is left
-- untouched, so Summary genuinely "remains canonical" while the user builds
-- up Detailed Holdings (spec s.24 steps 1-2). While mode='detailed', this
-- also writes the recomputed value into retirement_accounts.current_balance
-- -- Detailed is now the fund's one active source, and this keeps it in
-- sync as holdings/linked-loan balances change after the switch.
create or replace function smsf_recompute_fund(p_fund_id uuid) returns numeric as $$
declare
  v_mode text;
  v_retirement_account_id uuid;
  v_net numeric;
begin
  select mode, retirement_account_id into v_mode, v_retirement_account_id
  from smsf_funds where id = p_fund_id;

  if v_retirement_account_id is null then
    return null;
  end if;

  v_net := smsf_compute_detailed_net_value(p_fund_id);

  update smsf_funds set detailed_net_value = v_net, updated_at = now() where id = p_fund_id;

  if v_mode = 'detailed' then
    update retirement_accounts set current_balance = v_net, updated_at = now()
    where id = v_retirement_account_id;
  end if;

  return v_net;
end;
$$ language plpgsql;

-- Keep current_balance in sync with the Summary figure itself (distinct from
-- smsf_recompute_fund() above, which syncs Detailed figures). Whenever
-- summary_balance changes while mode='summary', retirement_accounts.
-- current_balance must track it -- this is what makes Summary Mode's own
-- balance editing actually reach Net Worth (spec s.20-22), symmetric with
-- how Detailed Mode's own value reaches it via smsf_recompute_fund().
create or replace function trg_smsf_funds_sync_summary_balance() returns trigger as $$
begin
  if new.mode = 'summary' then
    update retirement_accounts set current_balance = coalesce(new.summary_balance, 0), updated_at = now()
    where id = new.retirement_account_id;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_smsf_funds_sync_summary on smsf_funds;
create trigger trg_smsf_funds_sync_summary
  after insert or update of summary_balance, mode on smsf_funds
  for each row execute function trg_smsf_funds_sync_summary_balance();

-- Atomic new-fund creation (spec s.19-20): creates the retirement_accounts
-- row (master_item_key='smsf') and its smsf_funds row together in one
-- statement, so the app service layer never has a window where one exists
-- without the other. Runs as the invoking role (not SECURITY DEFINER) --
-- the retirement_accounts INSERT still passes through both RLS (owner-only)
-- and the GEO-2 AU gate trigger exactly as a direct insert would, so this
-- is convenience, not a privilege escalation path.
create or replace function smsf_create_fund(
  p_account_name text,
  p_fund_name text,
  p_summary_balance numeric,
  p_summary_balance_date date default null,
  p_owner text default 'self',
  p_currency_code char(3) default 'AUD',
  p_country_code char(2) default 'AU'
) returns table (retirement_account_id uuid, smsf_fund_id uuid) as $$
declare
  v_ra_id uuid;
  v_fund_id uuid;
begin
  insert into retirement_accounts (user_id, account_name, account_type, current_balance, currency_code, country_code, owner, master_item_key, is_active)
  values (auth.uid(), p_account_name, 'super', coalesce(p_summary_balance, 0), p_currency_code, p_country_code, p_owner, 'smsf', true)
  returning id into v_ra_id;

  insert into smsf_funds (user_id, retirement_account_id, fund_name, mode, summary_balance, summary_balance_date, currency_code)
  values (auth.uid(), v_ra_id, p_fund_name, 'summary', p_summary_balance, p_summary_balance_date, p_currency_code)
  returning id into v_fund_id;

  return query select v_ra_id, v_fund_id;
end;
$$ language plpgsql;

comment on function smsf_create_fund(text, text, numeric, date, text, char(3), char(2)) is
  'Atomic SMSF Fund creation (retirement_accounts + smsf_funds together). Still subject to the GEO-2 AU-only gate (trg_retirement_accounts_smsf_au_gate) and ownership RLS exactly as a direct insert would be -- a non-AU or forged-identity caller is rejected the same way.';

-- The hard mode-switch gate (spec s.24 steps 5-7, SMSF-6 hard test):
-- Summary -> Detailed is only permitted when the computed Detailed net
-- value matches the Summary balance to the cent. This is NOT a convenience
-- check the client can skip -- it is the sole path that flips mode, so an
-- unresolved variance can never silently enter Net Worth. On success, the
-- switch (mode flip + current_balance write) happens in the same statement
-- execution as this function call, i.e. atomically (spec s.24: "make the
-- switch atomic").
create or replace function smsf_switch_to_detailed(p_fund_id uuid) returns numeric as $$
declare
  v_mode text;
  v_summary numeric;
  v_retirement_account_id uuid;
  v_detailed numeric;
  v_variance numeric;
begin
  select mode, summary_balance, retirement_account_id into v_mode, v_summary, v_retirement_account_id
  from smsf_funds where id = p_fund_id;

  if v_retirement_account_id is null then
    raise exception 'smsf: fund % not found (or not visible to the current user)', p_fund_id using errcode = 'P0002';
  end if;
  if v_mode = 'detailed' then
    raise exception 'smsf: fund % is already in detailed mode', p_fund_id using errcode = '55000';
  end if;

  v_detailed := smsf_compute_detailed_net_value(p_fund_id);
  v_variance := round(coalesce(v_detailed, 0) - coalesce(v_summary, 0), 2);

  if v_variance <> 0 then
    raise exception 'smsf: cannot switch to detailed mode with an unresolved Net Worth variance of % (summary=%, detailed=%) -- resolve the difference in Detailed Holdings first', v_variance, v_summary, v_detailed
      using errcode = '23514';
  end if;

  update smsf_funds
  set mode = 'detailed',
      detailed_net_value = v_detailed,
      activated_detailed_at = now(),
      updated_at = now()
  where id = p_fund_id;

  update retirement_accounts
  set current_balance = v_detailed, updated_at = now()
  where id = v_retirement_account_id;

  return v_detailed;
end;
$$ language plpgsql;

comment on function smsf_switch_to_detailed(uuid) is
  'SMSF-6 hard financial-integrity gate. Runs as the invoking role (RLS-scoped): the initial SELECT only ever finds a fund row this user owns, so a forged fund id from another tenant behaves identically to "not found". Requires the computed Detailed net value to equal the Summary balance to the cent before flipping mode -- otherwise raises and leaves the fund in summary mode unchanged.';

-- Auto-recompute triggers: keep a detailed-mode fund's current_balance in
-- sync as its holdings, its linked-loan liability balance, or the link
-- itself change -- without requiring every future app code path to
-- remember to call smsf_recompute_fund() itself.
create or replace function trg_smsf_recompute_from_holding() returns trigger as $$
begin
  perform smsf_recompute_fund(coalesce(new.smsf_fund_id, old.smsf_fund_id));
  return coalesce(new, old);
end;
$$ language plpgsql;

drop trigger if exists trg_smsf_holdings_recompute on smsf_holdings;
create trigger trg_smsf_holdings_recompute
  after insert or update of value, currency_code, is_active or delete on smsf_holdings
  for each row execute function trg_smsf_recompute_from_holding();

create or replace function trg_smsf_recompute_from_link() returns trigger as $$
declare
  v_fund_id uuid;
  v_ra_id uuid;
begin
  v_ra_id := coalesce(new.linked_retirement_id, old.linked_retirement_id);
  if v_ra_id is not null and coalesce(new.link_type, old.link_type) = 'smsf_property_loan' then
    select id into v_fund_id from smsf_funds where retirement_account_id = v_ra_id;
    if v_fund_id is not null then
      perform smsf_recompute_fund(v_fund_id);
    end if;
  end if;
  return coalesce(new, old);
end;
$$ language plpgsql;

drop trigger if exists trg_pll_smsf_recompute on property_liability_links;
create trigger trg_pll_smsf_recompute
  after insert or update of allocation_percent, is_active, liability_id or delete on property_liability_links
  for each row execute function trg_smsf_recompute_from_link();

create or replace function trg_smsf_recompute_from_liability() returns trigger as $$
declare
  v_fund_id uuid;
begin
  select f.id into v_fund_id
  from property_liability_links pll
  join smsf_funds f on f.retirement_account_id = pll.linked_retirement_id
  where pll.liability_id = new.id and pll.link_type = 'smsf_property_loan' and pll.is_active = true
  limit 1;
  if v_fund_id is not null then
    perform smsf_recompute_fund(v_fund_id);
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_liabilities_smsf_recompute on liabilities;
create trigger trg_liabilities_smsf_recompute
  after update of balance, currency_code, is_active on liabilities
  for each row execute function trg_smsf_recompute_from_liability();

-- ===========================================================================
-- PART 5 -- RLS (spec s.45). Same owner-only pattern as every other
-- user-owned table, plus explicit cross-referenced ownership checks on
-- smsf_fund_members/smsf_holdings (same defence-in-depth precedent as
-- property_liability_links, migration 0078) so a correctly-auth'd attacker
-- cannot attach rows to another tenant's fund by guessing its UUID.
-- ===========================================================================

alter table smsf_funds enable row level security;
drop policy if exists "own rows - smsf funds" on smsf_funds;
create policy "own rows - smsf funds" on smsf_funds
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table smsf_fund_members enable row level security;
drop policy if exists "own rows - smsf fund members" on smsf_fund_members;
create policy "own rows - smsf fund members" on smsf_fund_members
  for all using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and smsf_fund_id in (select id from smsf_funds where user_id = auth.uid())
    and retirement_member_id in (select id from retirement_members where user_id = auth.uid())
  );

alter table smsf_holdings enable row level security;
drop policy if exists "own rows - smsf holdings" on smsf_holdings;
create policy "own rows - smsf holdings" on smsf_holdings
  for all using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and smsf_fund_id in (select id from smsf_funds where user_id = auth.uid())
  );

-- ===========================================================================
-- PART 6 -- SMSF-2 Legacy Migration: give every existing active SMSF
-- retirement_accounts row a corresponding smsf_funds row in Summary Mode
-- (spec s.8: preserve, never delete, never fabricate that it no longer
-- exists) so it is immediately visible/editable through the new Fund model
-- with zero data loss and zero Net Worth change (current_balance is not
-- touched by this backfill).
-- ===========================================================================

insert into smsf_funds (user_id, retirement_account_id, fund_name, mode, summary_balance, summary_balance_date, currency_code, notes)
select
  ra.user_id,
  ra.id,
  ra.account_name,
  'summary',
  ra.current_balance,
  null,
  case when ra.currency_code in ('AUD', 'INR') then ra.currency_code else 'AUD' end,
  'Backfilled by migration 0084 from the pre-existing retirement_accounts row (Summary Mode, value unchanged).'
from retirement_accounts ra
where ra.master_item_key = 'smsf'
  and ra.is_active = true
  and not exists (select 1 from smsf_funds f where f.retirement_account_id = ra.id);

-- Backfill fund-member links from retirement_member_id where one is already
-- set (migration 0077's own backfill/linkage), purely relational metadata --
-- no Net Worth effect, no member_interest_amount guessed.
insert into smsf_fund_members (user_id, smsf_fund_id, retirement_member_id)
select ra.user_id, f.id, ra.retirement_member_id
from retirement_accounts ra
join smsf_funds f on f.retirement_account_id = ra.id
where ra.retirement_member_id is not null
  and not exists (
    select 1 from smsf_fund_members m
    where m.smsf_fund_id = f.id and m.retirement_member_id = ra.retirement_member_id
  );

commit;
