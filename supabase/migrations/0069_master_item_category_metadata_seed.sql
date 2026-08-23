-- Chunk 3a item 1: populate the category-metadata columns (0068) for the
-- CURRENT, unmerged catalogue — 39 asset + 32 investment + 17 retirement
-- items (88 rows total), matching the discovery doc's
-- (docs/app-review-2026-08/AR0_DISCOVERY_AND_BASELINE.md §2.13-2.14/§3.6)
-- per-item classification. This is metadata population, not taxonomy
-- consolidation: every item_key below is updated in place, none are
-- added/renamed/deprecated (the sole exception is the two brand-new India
-- rows added by migration 0072, which is a separate, later file). income/
-- expense/liability/insurance rows are intentionally left at 0068's
-- defaults — out of this sub-chunk's scope.
--
-- Deliberate, disclosed judgement calls (flagged, not silently picked):
--  - requires_purchase_date / requires_purchase_price are left FALSE for
--    every single item in this seed, even where supports_* is true. These
--    fields are optional today for every asset type (lib/validation/
--    asset.ts has no .required() on either), and per this chunk's backward-
--    compatibility constraint ("do not make a currently-optional field
--    suddenly required"), turning any of them into a hard requirement is a
--    business-rule decision for the Product Owner, not something this
--    schema-design pass should default to true unilaterally. The
--    requires_* columns are wired end-to-end (see FinancialDataGrid.tsx /
--    fieldVisibility.ts) and ready to flip per item_key later with a single
--    UPDATE — no code change needed at that point.
--  - purpose_dimension is left NULL for holiday_home, vacant_land and farm.
--    The discovery doc explicitly flags these three as "ambiguous...needs a
--    purpose field, not necessarily a module move" with no existing signal
--    to disambiguate at the catalogue level (unlike gold/silver/
--    collectibles, which have a same-key row in the other module to anchor
--    the classification against). A future phase could add a genuine
--    per-user-row purpose toggle for these three; this migration does not
--    invent one.

-- === Assets (39 rows) =======================================================

-- Cash & banking — balance-style, no purchase concept.
update master_financial_items set
  current_value_source = 'balance', supports_purchase_date = false, supports_purchase_price = false
where category = 'asset' and item_key in ('wallet_cash', 'savings_account', 'cheque_account', 'offset_account', 'foreign_currency');

-- Term deposits — balance-style but has a meaningful "date opened".
update master_financial_items set
  current_value_source = 'balance', supports_purchase_date = true, supports_purchase_price = false
where category = 'asset' and item_key = 'term_deposits';

-- Gold / silver — personal-purpose on the Assets side (mirrored investment.*
-- rows below carry purpose_dimension = 'investment').
update master_financial_items set
  current_value_source = 'market_value', supports_purchase_date = true, supports_purchase_price = true,
  purpose_dimension = 'personal'
where category = 'asset' and item_key in ('gold', 'silver');

-- Cryptocurrency — market-value, no personal/investment duality to encode.
update master_financial_items set
  current_value_source = 'market_value', supports_purchase_date = true, supports_purchase_price = true
where category = 'asset' and item_key = 'cryptocurrency';

-- Listed/traded securities held directly as assets.
update master_financial_items set
  current_value_source = 'market_value', supports_purchase_date = true, supports_purchase_price = true
where category = 'asset' and item_key in ('shares', 'etfs', 'managed_funds', 'bonds', 'private_equity');

-- Private-market ownership stakes — valuation is estimated, not a quoted price.
update master_financial_items set
  current_value_source = 'calculated', supports_purchase_date = true, supports_purchase_price = true
where category = 'asset' and item_key in ('business_ownership', 'partnership_interest');

-- SMSF-in-Assets / super-in-Assets (Class B/D duplicates per discovery §3.6,
-- left exactly as-is — not touched beyond metadata) — balance-style.
update master_financial_items set
  current_value_source = 'balance', supports_purchase_date = false, supports_purchase_price = false
where category = 'asset' and item_key in ('smsf_balance', 'industry_super', 'retail_super', 'defined_benefit');

-- Investment property (Assets-side) — investment-purpose, income+liability linkable.
update master_financial_items set
  current_value_source = 'market_value', supports_purchase_date = true, supports_purchase_price = true,
  purpose_dimension = 'investment', supports_income_link = true, supports_liability_link = true
where category = 'asset' and item_key = 'investment_property';

-- Principal residence — personal-purpose, liability-linkable (home loan), no rental income link.
update master_financial_items set
  current_value_source = 'market_value', supports_purchase_date = true, supports_purchase_price = true,
  purpose_dimension = 'personal', supports_liability_link = true
where category = 'asset' and item_key = 'principal_residence';

-- Ambiguous personal-vs-investment property types — see the disclosed
-- judgement call above; purpose_dimension intentionally left null.
update master_financial_items set
  current_value_source = 'market_value', supports_purchase_date = true, supports_purchase_price = true,
  supports_income_link = true, supports_liability_link = true
where category = 'asset' and item_key in ('holiday_home', 'vacant_land', 'farm');

-- Commercial property — virtually always investment-purpose per discovery §3.6.
update master_financial_items set
  current_value_source = 'market_value', supports_purchase_date = true, supports_purchase_price = true,
  purpose_dimension = 'investment', supports_income_link = true, supports_liability_link = true
where category = 'asset' and item_key = 'commercial_property';

-- Vehicles — personal-purpose, market-value, has a purchase date/price.
update master_financial_items set
  current_value_source = 'market_value', supports_purchase_date = true, supports_purchase_price = true,
  purpose_dimension = 'personal'
where category = 'asset' and item_key in ('motor_vehicle', 'motorcycle', 'boat', 'caravan');

-- Collectables (deprecated misspelling, migration 0066) / collectibles /
-- jewellery / art / watches / wine — personal-purpose valuables.
update master_financial_items set
  current_value_source = 'market_value', supports_purchase_date = true, supports_purchase_price = true,
  purpose_dimension = 'personal'
where category = 'asset' and item_key in ('collectables', 'collectibles', 'jewellery', 'art', 'watches', 'wine_collection');

-- Intellectual property — no clean purchase-event concept, estimated valuation.
update master_financial_items set
  current_value_source = 'calculated', supports_purchase_date = false, supports_purchase_price = false
where category = 'asset' and item_key = 'intellectual_property';

-- Loans receivable — balance owed to the user, no purchase concept.
update master_financial_items set
  current_value_source = 'balance', supports_purchase_date = false, supports_purchase_price = false
where category = 'asset' and item_key = 'loans_receivable';

-- Trust assets — estimated/derived valuation, no single purchase event.
update master_financial_items set
  current_value_source = 'calculated', supports_purchase_date = false, supports_purchase_price = false
where category = 'asset' and item_key = 'trust_assets';

-- Other assets — heterogeneous catch-all, keep both fields available.
update master_financial_items set
  current_value_source = 'market_value', supports_purchase_date = true, supports_purchase_price = true
where category = 'asset' and item_key = 'other_assets';

-- === Investments (32 rows) ==================================================

update master_financial_items set
  current_value_source = 'market_value', supports_purchase_date = true, supports_purchase_price = true
where category = 'investment' and item_key in (
  'australian_shares', 'international_shares', 'index_funds', 'government_bonds', 'corporate_bonds',
  'bonds', 'etfs', 'managed_funds', 'private_equity', 'cryptocurrency', 'reits', 'commodities',
  'options', 'futures', 'forex', 'other_investments'
);

-- Gold / silver / commercial property / property — investment-purpose mirror
-- of the Assets-side rows above.
update master_financial_items set
  current_value_source = 'market_value', supports_purchase_date = true, supports_purchase_price = true,
  purpose_dimension = 'investment'
where category = 'investment' and item_key in ('gold', 'silver');

update master_financial_items set
  current_value_source = 'market_value', supports_purchase_date = true, supports_purchase_price = true,
  purpose_dimension = 'investment', supports_income_link = true, supports_liability_link = true
where category = 'investment' and item_key in ('commercial_property', 'property');

-- Collectibles (investment-purpose mirror of asset.collectibles).
update master_financial_items set
  current_value_source = 'market_value', supports_purchase_date = true, supports_purchase_price = true,
  purpose_dimension = 'investment'
where category = 'investment' and item_key = 'collectibles';

-- Term deposits (investment-side mirror) — same balance-style profile as Assets.
update master_financial_items set
  current_value_source = 'balance', supports_purchase_date = true, supports_purchase_price = false
where category = 'investment' and item_key = 'term_deposits';

-- Cash-like items filed under Investments (Class D per discovery §3.6, left
-- exactly as-is) — genuinely balance-style, no purchase concept.
update master_financial_items set
  current_value_source = 'balance', supports_purchase_date = false, supports_purchase_price = false
where category = 'investment' and item_key in ('cash_investments', 'high_interest_savings');

-- Illiquid/private-market investments — estimated valuation.
update master_financial_items set
  current_value_source = 'calculated', supports_purchase_date = true, supports_purchase_price = true
where category = 'investment' and item_key in ('angel_investments', 'venture_capital', 'business_investment', 'partnership_investment', 'trust_investment');

-- SMSF-in-Investments (3-way overlap per discovery §3.6, left as-is) — balance-style.
update master_financial_items set
  current_value_source = 'balance', supports_purchase_date = false, supports_purchase_price = false
where category = 'investment' and item_key = 'smsf_investments';

-- Education fund / children investment (Class E — not-an-asset-type per
-- discovery §3.6; left exactly as-is, this is 3b/Goals-integration
-- territory) — balance-style savings pot, no purchase concept.
update master_financial_items set
  current_value_source = 'balance', supports_purchase_date = false, supports_purchase_price = false
where category = 'investment' and item_key in ('education_fund', 'children_investment');

-- === Retirement (17 rows) ===================================================

-- Account-style holdings — balance-style, no purchase concept.
update master_financial_items set
  current_value_source = 'balance', supports_purchase_date = false, supports_purchase_price = false
where category = 'retirement' and item_key in (
  'industry_super', 'retail_super', 'smsf', 'defined_benefit',
  'transition_to_retirement', 'allocated_pension', 'account_based_pension', 'annuity',
  'overseas_pension', 'other_retirement_assets', 'retirement_savings'
);

-- Class-F contribution-flow items (discovery §3.6) — these are future-flow
-- inputs, not current-value holdings at all (Spec 2 §34-36/§52). Marked
-- future_flow_source = true and current_value_source left NULL deliberately
-- (a flow has no "current value"). Not deprecated/restructured in this
-- migration — see migration 0071's new retirement_contributions table for
-- the actual structural fix; these catalogue rows are untouched per this
-- chunk's constraints.
update master_financial_items set
  current_value_source = null, future_flow_source = true,
  supports_purchase_date = false, supports_purchase_price = false
where category = 'retirement' and item_key in (
  'employer_contributions', 'salary_sacrifice', 'personal_concessional',
  'non_concessional', 'government_co_contribution', 'spouse_contribution'
);
