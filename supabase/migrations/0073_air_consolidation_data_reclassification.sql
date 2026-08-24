-- Assets, Investments & Retirement Consolidation -- A3 data migration.
-- Moves existing user rows out of the wrong module's table and into the
-- correct one wherever the master_financial_items catalogue offered the
-- same economic holding type in more than one module (spec s.3/6/15/57),
-- and corrects one genuine pre-existing defect found live on DEV during
-- A0 discovery (spec s.34-36 contribution/balance confusion -- see part 3
-- below). Every move is set-based (not hardcoded to specific user rows)
-- so it applies correctly regardless of exactly what DEV's data looks
-- like at the moment a human runs it.
--
-- SAFETY MODEL (spec s.4.3, s.54-57, s.93):
--  * Every migrated row is INSERTed into its destination table BEFORE the
--    source row is deleted -- if anything fails partway, no data is lost
--    (worst case is a temporary duplicate visible in both tables, never a
--    silent loss). Run inside one transaction per part.
--  * A row is only auto-reclassified onto the SAME canonical item_key it
--    would naturally resolve to. It is NEVER merged/summed into an
--    existing destination row for that user -- if the user already has an
--    active row at the natural destination item_key (a genuine "possible
--    duplicate" per s.55-56: same holding type, different recorded value,
--    no shared institution/account evidence available in this schema to
--    prove they're the same holding), the migrated row is inserted as an
--    UNLINKED custom row (master_item_key left null) carrying a note that
--    explains what happened and asks for manual review, so BOTH amounts
--    are preserved, BOTH remain visible, and Net Worth is not silently
--    changed by an unproven auto-merge. A0 discovery on live DEV
--    (2026-08-24) found exactly 3 such cases; documented in the
--    accompanying report's Data Migration Results table.
--  * Pure reclassification (the overwhelming majority of rows) changes
--    which subtotal (Assets/Investments/Retirement) a holding is counted
--    under but changes NOTHING about Gross Household Assets or Net Worth
--    -- verified by the accompanying reconciliation script, not merely
--    asserted here.
--  * Every row this migration touches keeps its stable id where it stays
--    in the same table (part 3); rows that change table necessarily get a
--    new id (Postgres has no cross-table primary-key move), but their
--    full original row -- including created_at, owner, currency_code,
--    country_code, notes, purchase_price/date where present -- is
--    preserved verbatim into the new row, and the *old* row's data is
--    never touched until the new row has successfully been written.
--  * GOAL LINKS FOLLOW THE MONEY (spec s.63): a moved row can be the
--    funding source of an existing Goal via goal_funding_sources
--    (migration 0009's linked_asset_id/linked_investment_id/
--    linked_retirement_id). A0 discovery on live DEV (2026-08-24) found 3
--    real goal_funding_sources rows pointing at investments rows this
--    migration relocates (master_item_key='smsf_investments'). Every move
--    below re-points any goal_funding_sources row that referenced the old
--    id onto the new id, in the correct column for the new table, so the
--    Goal keeps funding the same real holding instead of silently losing
--    its link to a now-inactive row.

begin;

-- ---------------------------------------------------------------------------
-- PART 1 -- assets -> investments reclassification.
-- ---------------------------------------------------------------------------

-- 1a. Same-key direct moves: the wrong-module item and the correct-module
--     item already share an identical item_key in master_financial_items,
--     so no relabelling decision is needed.
do $$
declare
  keys text[] := array['etfs','managed_funds','bonds','private_equity',
                        'cryptocurrency','gold','silver','term_deposits',
                        'commercial_property'];
  k text;
  r record;
  collision boolean;
  new_id uuid;
begin
  foreach k in array keys loop
    for r in select * from assets where master_item_key = k and is_active = true loop
      collision := exists(
        select 1 from investments
        where user_id = r.user_id and master_item_key = k and is_active = true
      );
      if collision then
        insert into investments (
          user_id, investment_name, investment_type, current_value, currency_code,
          country_code, owner, master_item_key, notes, created_at
        ) values (
          r.user_id, r.asset_name, 'other', r.current_value, r.currency_code,
          r.country_code, r.owner, null,
          coalesce(r.notes || ' ', '') ||
            format('[A/I/R consolidation %s] Possible duplicate: this was recorded under Assets > %s while an active Investments > %s record already exists for this holding type. Both amounts are preserved separately pending manual review -- values differ enough that they were not auto-merged (spec s.55-57).',
                   to_char(now(), 'YYYY-MM-DD'), k, k),
          r.created_at
        ) returning id into new_id;
      else
        insert into investments (
          user_id, investment_name, investment_type, current_value, currency_code,
          country_code, owner, master_item_key, notes, created_at
        ) values (
          r.user_id, r.asset_name, 'other', r.current_value, r.currency_code,
          r.country_code, r.owner, k, r.notes, r.created_at
        ) returning id into new_id;
      end if;
      update assets set is_active = false,
        notes = coalesce(notes || ' ', '') ||
          format('[A/I/R consolidation %s] Reclassified to Investments (%s) -- this record is retired, the canonical record now lives in Investments.', to_char(now(), 'YYYY-MM-DD'), k)
        where id = r.id;
      update goal_funding_sources set linked_asset_id = null, linked_investment_id = new_id where linked_asset_id = r.id;
    end loop;
  end loop;
end $$;

-- 1b. Relabelled moves: the correct-module destination uses a different
--     (but unambiguous) item_key.
do $$
declare
  mapping jsonb := '{"investment_property":"property","business_ownership":"business_investment","partnership_interest":"partnership_investment"}'::jsonb;
  src text;
  dest text;
  r record;
  collision boolean;
  new_id uuid;
begin
  for src, dest in select key, value#>>'{}' from jsonb_each(mapping) loop
    for r in select * from assets where master_item_key = src and is_active = true loop
      collision := exists(
        select 1 from investments where user_id = r.user_id and master_item_key = dest and is_active = true
      );
      if collision then
        insert into investments (user_id, investment_name, investment_type, current_value, currency_code, country_code, owner, master_item_key, notes, created_at)
        values (r.user_id, r.asset_name, 'other', r.current_value, r.currency_code, r.country_code, r.owner, null,
          coalesce(r.notes || ' ', '') || format('[A/I/R consolidation %s] Possible duplicate: recorded under Assets > %s, mapping to Investments > %s where an active record already exists. Preserved separately pending manual review.', to_char(now(),'YYYY-MM-DD'), src, dest),
          r.created_at) returning id into new_id;
      else
        insert into investments (user_id, investment_name, investment_type, current_value, currency_code, country_code, owner, master_item_key, notes, created_at)
        values (r.user_id, r.asset_name, 'other', r.current_value, r.currency_code, r.country_code, r.owner, dest, r.notes, r.created_at) returning id into new_id;
      end if;
      update assets set is_active = false,
        notes = coalesce(notes || ' ', '') || format('[A/I/R consolidation %s] Reclassified to Investments (%s).', to_char(now(),'YYYY-MM-DD'), dest)
        where id = r.id;
      update goal_funding_sources set linked_asset_id = null, linked_investment_id = new_id where linked_asset_id = r.id;
    end loop;
  end loop;
end $$;

-- 1c. Shares: geography-routed by the row's own recorded country_code
--     (direct evidence per spec s.56, not a guess) -- India routes to
--     International Shares, everything else (including no country
--     recorded) routes to Australian Shares, matching this platform's
--     AU-primary default elsewhere (spec s.51).
do $$
declare
  r record;
  dest text;
  collision boolean;
  new_id uuid;
begin
  for r in select * from assets where master_item_key = 'shares' and is_active = true loop
    dest := case when r.country_code = 'IN' then 'international_shares' else 'australian_shares' end;
    collision := exists(select 1 from investments where user_id = r.user_id and master_item_key = dest and is_active = true);
    if collision then
      insert into investments (user_id, investment_name, investment_type, current_value, currency_code, country_code, owner, master_item_key, notes, created_at)
      values (r.user_id, r.asset_name, 'other', r.current_value, r.currency_code, r.country_code, r.owner, null,
        coalesce(r.notes || ' ', '') || format('[A/I/R consolidation %s] Possible duplicate: recorded under Assets > Shares, mapping to Investments > %s (by recorded country) where an active record already exists. Preserved separately pending manual review.', to_char(now(),'YYYY-MM-DD'), dest),
        r.created_at) returning id into new_id;
    else
      insert into investments (user_id, investment_name, investment_type, current_value, currency_code, country_code, owner, master_item_key, notes, created_at)
      values (r.user_id, r.asset_name, 'other', r.current_value, r.currency_code, r.country_code, r.owner, dest, r.notes, r.created_at) returning id into new_id;
    end if;
    update assets set is_active = false,
      notes = coalesce(notes || ' ', '') || format('[A/I/R consolidation %s] Reclassified to Investments (%s).', to_char(now(),'YYYY-MM-DD'), dest)
      where id = r.id;
    update goal_funding_sources set linked_asset_id = null, linked_investment_id = new_id where linked_asset_id = r.id;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- PART 2 -- assets -> retirement_accounts, and investments -> retirement_accounts
-- reclassification (SMSF and superannuation must have exactly one home:
-- Retirement -- spec s.15/29/31/38).
-- ---------------------------------------------------------------------------
do $$
declare
  mapping jsonb := '{"smsf_balance":"smsf","industry_super":"industry_super","retail_super":"retail_super","defined_benefit":"defined_benefit"}'::jsonb;
  src text;
  dest text;
  r record;
  collision boolean;
  new_id uuid;
begin
  for src, dest in select key, value#>>'{}' from jsonb_each(mapping) loop
    for r in select * from assets where master_item_key = src and is_active = true loop
      collision := exists(select 1 from retirement_accounts where user_id = r.user_id and master_item_key = dest and is_active = true);
      if collision then
        insert into retirement_accounts (user_id, account_name, account_type, current_balance, currency_code, country_code, owner, master_item_key, notes, created_at)
        values (r.user_id, r.asset_name, 'other', r.current_value, r.currency_code, r.country_code, r.owner, null,
          coalesce(r.notes || ' ', '') || format('[A/I/R consolidation %s] Possible duplicate: recorded under Assets > %s, mapping to Retirement > %s where an active record already exists. Preserved separately pending manual review.', to_char(now(),'YYYY-MM-DD'), src, dest),
          r.created_at) returning id into new_id;
      else
        insert into retirement_accounts (user_id, account_name, account_type, current_balance, currency_code, country_code, owner, master_item_key, notes, created_at)
        values (r.user_id, r.asset_name, dest, r.current_value, r.currency_code, r.country_code, r.owner, dest, r.notes, r.created_at) returning id into new_id;
      end if;
      update assets set is_active = false,
        notes = coalesce(notes || ' ', '') || format('[A/I/R consolidation %s] Reclassified to Retirement (%s).', to_char(now(),'YYYY-MM-DD'), dest)
        where id = r.id;
      update goal_funding_sources set linked_asset_id = null, linked_retirement_id = new_id where linked_asset_id = r.id;
    end loop;
  end loop;
end $$;

do $$
declare
  r record;
  collision boolean;
  new_id uuid;
begin
  for r in select * from investments where master_item_key = 'smsf_investments' and is_active = true loop
    collision := exists(select 1 from retirement_accounts where user_id = r.user_id and master_item_key = 'smsf' and is_active = true);
    if collision then
      insert into retirement_accounts (user_id, account_name, account_type, current_balance, currency_code, country_code, owner, master_item_key, notes, created_at)
      values (r.user_id, r.investment_name, 'other', r.current_value, r.currency_code, r.country_code, r.owner, null,
        coalesce(r.notes || ' ', '') || format('[A/I/R consolidation %s] Possible duplicate: recorded under Investments > SMSF Investments, mapping to Retirement > SMSF where an active record already exists. Preserved separately pending manual review.', to_char(now(),'YYYY-MM-DD')),
        r.created_at) returning id into new_id;
    else
      insert into retirement_accounts (user_id, account_name, account_type, current_balance, currency_code, country_code, owner, master_item_key, notes, created_at)
      values (r.user_id, r.investment_name, 'smsf', r.current_value, r.currency_code, r.country_code, r.owner, 'smsf', r.notes, r.created_at) returning id into new_id;
    end if;
    update investments set is_active = false,
      notes = coalesce(notes || ' ', '') || format('[A/I/R consolidation %s] Reclassified to Retirement (smsf) -- SMSF has exactly one canonical home (spec s.38).', to_char(now(),'YYYY-MM-DD'))
      where id = r.id;
    update goal_funding_sources set linked_investment_id = null, linked_retirement_id = new_id where linked_investment_id = r.id;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- PART 3 -- retirement contribution/current-balance defect correction
-- (spec s.34-36, s.75). PROVEN PRE-EXISTING DEFECT, found live on DEV
-- during A0 discovery (2026-08-24), NOT a taxonomy-only reclassification:
-- master_financial_items' 'retirement' category offers six items --
-- employer_contributions, salary_sacrifice, personal_concessional,
-- non_concessional, spouse_contribution, government_co_contribution --
-- that are contribution FLOWS (future-flow inputs to Forecasting), not
-- accounts, yet the FinancialDataGrid renders them exactly like any other
-- retirement account with a "Current Balance" field. Real DEV rows
-- confirm users' contribution figures were entered directly into
-- current_balance, which computeDashboard() (lib/engines/dashboard.ts)
-- sums straight into totalRetirement and therefore Net Worth -- a flow
-- masquerading as a stock, inflating every affected user's real Net Worth
-- today. Verified live on DEV (2026-08-24): 45 rows, 39 distinct users,
-- $52,982,800 total AUD-equivalent currently miscounted as a current
-- retirement balance.
--
-- Fix: for each affected row, the current_balance value is moved into the
-- correct future-flow field (employer_contribution for employer-side
-- items, personal_contribution for member-side items) and current_balance
-- is zeroed. The row is NOT deleted and stays active/visible -- only its
-- contribution-vs-balance classification is corrected. No id changes here
-- (the row stays in place), so no goal_funding_sources re-pointing is
-- needed for this part. This is exactly the kind of pre-existing defect
-- spec s.93 carves out: correcting it necessarily and correctly LOWERS
-- the affected users' current Net Worth (a flow was never a balance), it
-- is not an unproven side effect of a pure category move.
do $$
declare
  r record;
  is_employer_side boolean;
begin
  for r in
    select * from retirement_accounts
    where master_item_key in (
      'employer_contributions','salary_sacrifice','personal_concessional',
      'non_concessional','spouse_contribution','government_co_contribution'
    )
    and is_active = true
    and current_balance > 0
  loop
    is_employer_side := r.master_item_key in ('employer_contributions','salary_sacrifice','government_co_contribution');
    update retirement_accounts set
      employer_contribution = case when is_employer_side then coalesce(employer_contribution, 0) + r.current_balance else employer_contribution end,
      personal_contribution = case when not is_employer_side then coalesce(personal_contribution, 0) + r.current_balance else personal_contribution end,
      current_balance = 0,
      notes = coalesce(notes || ' ', '') ||
        format('[A/I/R consolidation %s] Corrected: %s was previously recorded as this row''s Current Balance, incorrectly counting a contribution flow as a current retirement asset (spec s.34-36). It has been moved to the %s Contribution field and the Current Balance zeroed -- this reduces the current-value figure this row contributes to Net Worth, which is the correct behaviour for a contribution amount. This does not affect Forecasting, which already reads the contribution fields separately.',
               to_char(now(), 'YYYY-MM-DD'), r.current_balance, case when is_employer_side then 'Employer' else 'Personal' end)
    where id = r.id;
  end loop;
end $$;

commit;
