-- Assets, Investments & Retirement Consolidation -- A1 canonical taxonomy
-- lock, applied to the live catalogue. Must run AFTER 0073 (which has
-- already moved or deactivated every user row that referenced any item
-- being retired below) -- so deactivating an item here can never orphan a
-- still-visible user row: FinancialDataGrid only ever renders rows where
-- is_active=true on the underlying assets/investments/retirement_accounts
-- record (lib/services/registry.ts's list()), and 0073 already set
-- is_active=false on every source row it moved or flagged. This migration
-- only ever touches master_financial_items (the catalogue), never a user
-- row.
--
-- Idempotent: every statement is a plain UPDATE keyed on (category,
-- item_key), safe to re-run.

begin;

-- ---------------------------------------------------------------------------
-- 1. Deprecate cross-module duplicate items -- retired from the WRONG
--    module now that every existing reference has been reclassified
--    (0073). Each item's canonical home is recorded via
--    superseded_by_category/superseded_by_item_key (added in 0072) so the
--    catalogue itself documents where the economic holding type now
--    lives, not just this migration's prose.
-- ---------------------------------------------------------------------------
update master_financial_items set
  is_active = false,
  superseded_by_category = 'investment',
  superseded_by_item_key = item_key,
  governance_note = 'Retired from Assets: this holding type is canonically an Investment (spec s.15-25). Existing user rows reclassified by migration 0073.'
where category = 'asset' and item_key in
  ('shares','etfs','managed_funds','bonds','private_equity','cryptocurrency','gold','silver','term_deposits','commercial_property');

update master_financial_items set
  is_active = false,
  superseded_by_category = 'investment',
  superseded_by_item_key = 'property',
  governance_note = 'Retired from Assets: Investment Property is canonically an Investment (spec s.21). Existing user rows reclassified by migration 0073 into Investments > Property.'
where category = 'asset' and item_key = 'investment_property';

update master_financial_items set
  is_active = false,
  superseded_by_category = 'investment',
  superseded_by_item_key = 'business_investment',
  governance_note = 'Retired from Assets: canonically an Investment (spec s.24). Existing user rows reclassified by migration 0073 into Investments > Business Investment.'
where category = 'asset' and item_key = 'business_ownership';

update master_financial_items set
  is_active = false,
  superseded_by_category = 'investment',
  superseded_by_item_key = 'partnership_investment',
  governance_note = 'Retired from Assets: canonically an Investment (spec s.24). Existing user rows reclassified by migration 0073 into Investments > Partnership Investment.'
where category = 'asset' and item_key = 'partnership_interest';

update master_financial_items set
  is_active = false,
  superseded_by_category = 'retirement',
  superseded_by_item_key = 'smsf',
  governance_note = 'Retired from Assets: SMSF has exactly one canonical home, Retirement (spec s.38). Existing user rows reclassified by migration 0073 into Retirement > SMSF.'
where category = 'asset' and item_key = 'smsf_balance';

update master_financial_items set
  is_active = false,
  superseded_by_category = 'retirement',
  superseded_by_item_key = item_key,
  governance_note = 'Retired from Assets: canonically a Retirement holding (spec s.15/29-31). Existing user rows reclassified by migration 0073.'
where category = 'asset' and item_key in ('industry_super','retail_super','defined_benefit');

update master_financial_items set
  is_active = false,
  superseded_by_category = 'retirement',
  superseded_by_item_key = 'smsf',
  governance_note = 'Retired from Investments: SMSF has exactly one canonical home, Retirement (spec s.38), whether summary balance or underlying holdings. Existing user rows reclassified by migration 0073 into Retirement > SMSF.'
where category = 'investment' and item_key = 'smsf_investments';

-- ---------------------------------------------------------------------------
-- 2. Retirement contribution items (spec s.34-36): these are future-flow
--    inputs, never current-balance accounts. They are NOT deactivated --
--    doing so would orphan the 45 real rows migration 0073 just corrected
--    (they stay valid, visible retirement_accounts rows; only their
--    current_balance/contribution split was fixed). Instead they are
--    flagged as future-flow-only in the catalogue metadata so any future
--    UI work (grid conditional-fields, spec s.47) can hide/relabel their
--    "Current Balance" column, and relabelled to make the distinction
--    explicit to users going forward.
-- ---------------------------------------------------------------------------
update master_financial_items set
  is_current_value_source = false,
  is_future_flow_source = true,
  is_retirement_specific = true,
  governance_note = 'This is a contribution flow, not an account balance (spec s.34-36). A pre-existing defect (found live on DEV 2026-08-24) let users enter a contribution amount into this row''s Current Balance, incorrectly counting it as current Net Worth; migration 0073 corrected every existing affected row. Prefer recording contributions on the actual retirement account they belong to via its own Employer/Personal Contribution fields.'
where category = 'retirement' and item_key in
  ('employer_contributions','salary_sacrifice','personal_concessional','non_concessional','spouse_contribution','government_co_contribution');

update master_financial_items set item_label = 'Employer Contributions (contribution amount, not a balance)'
  where category = 'retirement' and item_key = 'employer_contributions';
update master_financial_items set item_label = 'Salary Sacrifice (contribution amount, not a balance)'
  where category = 'retirement' and item_key = 'salary_sacrifice';
update master_financial_items set item_label = 'Personal Concessional (contribution amount, not a balance)'
  where category = 'retirement' and item_key = 'personal_concessional';
update master_financial_items set item_label = 'Non-Concessional (contribution amount, not a balance)'
  where category = 'retirement' and item_key = 'non_concessional';
update master_financial_items set item_label = 'Spouse Contribution (contribution amount, not a balance)'
  where category = 'retirement' and item_key = 'spouse_contribution';
update master_financial_items set item_label = 'Government Co-Contribution (contribution amount, not a balance)'
  where category = 'retirement' and item_key = 'government_co_contribution';

-- ---------------------------------------------------------------------------
-- 3. Relabel (item_key stable, label clarified only -- spec s.21).
-- ---------------------------------------------------------------------------
update master_financial_items set item_label = 'Residential Investment Property'
  where category = 'investment' and item_key = 'property';

-- ---------------------------------------------------------------------------
-- 4. Classification metadata for every remaining active item (spec s.46,
--    s.52). Everything not explicitly a contribution/flow item above is a
--    current-value source by column default (set in 0072); this section
--    only needs to mark the exceptions: retirement-specific flags for
--    items that stay superannuation/pension-type regardless of category,
--    and personal-use defaults for items that are plausibly not
--    investment-purpose by default (spec s.26).
-- ---------------------------------------------------------------------------
update master_financial_items set is_retirement_specific = true
  where category = 'retirement' and item_key in
    ('industry_super','retail_super','smsf','defined_benefit','transition_to_retirement',
     'allocated_pension','account_based_pension','annuity','overseas_pension','retirement_savings','other_retirement_assets');

update master_financial_items set is_personal_use_default = true
  where category = 'asset' and item_key in
    ('principal_residence','holiday_home','vacant_land','farm','motor_vehicle','motorcycle','boat','caravan',
     'collectables','jewellery','art','watches','wine_collection','intellectual_property');

-- Education Fund / Children Investment (spec s.28): these are purposes,
-- not asset classes -- flagged for future Goal-linkage refactor (spec
-- s.63) rather than physically moved, since the money is already counted
-- correctly today (Investments) and no user row needs to change table.
-- Not deactivated: removing them would orphan real recorded holdings with
-- no non-destructive canonical replacement item yet defined.
update master_financial_items set
  governance_note = 'This represents a purpose (spec s.28), not a distinct asset class -- the underlying holding should ideally be entered as its actual investment type (e.g. Managed Fund) with a Goal link (spec s.63), which goal_funding_sources (migration 0009) already supports architecturally. Retained as-is for this release: money already recorded here counts correctly today, and no user data was moved.'
where category = 'investment' and item_key in ('education_fund','children_investment');

commit;
