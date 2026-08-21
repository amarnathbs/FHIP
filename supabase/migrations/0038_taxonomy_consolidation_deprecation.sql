-- Chunk 3b — Assets/Investments/Retirement taxonomy consolidation.
-- Deprecates the ~28 duplicate/overlapping catalogue rows identified by
-- AR-0's discovery doc (§3.6) and Chunk 3a's design pass, per the "FHIP —
-- Assets, Investments & Retirement" spec ("Spec 2") §6/§7 rules. Full
-- old->new mapping table: docs/app-review-2026-08/CHUNK3B_TAXONOMY_MAPPING.md.
-- Real-DEV-data audit backing every decision below:
-- docs/app-review-2026-08/CHUNK3B_MIGRATION_AUDIT.md.
--
-- DISCIPLINE (matches migration 0031's own precedent exactly): additive
-- only. Deprecated items are set is_active = false, never deleted or
-- renamed. Every canonical destination item referenced below already
-- exists and is already active — no inserts are needed in this migration
-- (unlike 0031, which also had to add a corrected-spelling row).
--
-- CRITICAL — this migration was NOT safe to apply until the grid's
-- orphaned-master_item_key gap was fixed (see components/grid/
-- FinancialDataGrid.tsx's load(), lib/grid/rowMerge.ts, and
-- tests/unit/rowMerge.test.ts, all part of this same Chunk 3b commit). That
-- fix ships in the same commit as this migration, so by the time this file
-- is actually applied to a database, every affected user's saved row will
-- render as a clearly-marked "Archived item" — visible, editable,
-- deletable — instead of silently disappearing (0031's own disclosed risk,
-- now resolved for both 0031 and every deprecation below).
--
-- NO EXISTING USER ROW IS TOUCHED by the deprecations below (this is a
-- deliberate, disclosed scope decision — see the audit doc's "why no
-- physical/table-level data migration" section): a user's `assets` row
-- keeps its own current_value, currency_code, owner, etc., completely
-- unchanged, and keeps counting toward whichever table's total
-- (totalAssets/totalInvestments/totalRetirement) it always has —
-- computeDashboard() sums each of those three totals independently by
-- TABLE, not by catalogue is_active or master_item_key, so Net Worth is
-- structurally invariant under this migration for every existing row
-- (verified with real DEV data in the audit doc's zero-Net-Worth-variance
-- reconciliation, and with computeDashboard()-level tests in
-- tests/unit/dashboard.test.ts's "pure-reclassification zero-variance"
-- suite). The only thing this migration changes is which catalogue item a
-- *new, not-yet-saved* tick shows up under going forward.
--
-- Two exceptions to "no existing row is touched", both same-table,
-- same-category master_item_key relabels with zero external code
-- dependency (grep-verified: no lib/ file references either old key) and
-- therefore zero risk of changing any computed total:
--  - retirement.allocated_pension -> retirement.account_based_pension
--    (item 7 — confirmed genuine AU pre-/post-2007 terminology duplicate,
--    Spec 2 §37 names Account Based Pension as canonical)
--  - retirement.retirement_savings -> retirement.other_retirement_assets
--    (item 8 — genuinely redundant vague catch-all, consolidated into the
--    existing catch-all rather than left as a second one)

-- =============================================================================
-- 1. Assets<->Investments exact-key (Class B) duplicates — Investments
--    canonical (Spec 2 §17-25). NOTE: gold/silver are deliberately EXCLUDED
--    here — Chunk 3a's migration 0034 already gave both the asset-side
--    ('personal') and investment-side ('investment') rows a distinct
--    purpose_dimension, which is the correct handling per Spec 2 §26's
--    personal-vs-investment-purpose distinction. Flattening them into one
--    side here would destroy that distinction, not fix a duplicate.
-- =============================================================================
update master_financial_items
set is_active = false
where category = 'asset'
  and item_key in ('term_deposits', 'cryptocurrency', 'shares', 'etfs', 'managed_funds', 'bonds', 'private_equity', 'commercial_property');

-- =============================================================================
-- 2. Assets<->Retirement exact-key (Class B) duplicates — Retirement
--    canonical (matches the discovery doc's Retirement-side classification
--    exactly; the Retirement-side items are untouched, still active).
-- =============================================================================
update master_financial_items
set is_active = false
where category = 'asset'
  and item_key in ('industry_super', 'retail_super', 'defined_benefit');

-- =============================================================================
-- 3. Three-way SMSF overlap — most severe single item. Retirement's `smsf`
--    is canonical (Chunk 3a's Summary/Detailed structured model lives
--    there). Both the Assets- and Investments-side flat duplicates are
--    deprecated.
-- =============================================================================
update master_financial_items
set is_active = false
where (category = 'asset' and item_key = 'smsf_balance')
   or (category = 'investment' and item_key = 'smsf_investments');

-- =============================================================================
-- 4. Class-C conceptual duplicates (different spelling/keys across
--    modules) — Investments canonical per Spec 2's business/private-market
--    and property hierarchies. (collectables -> collectibles is already
--    handled by Chunk 1's migration 0031 and is NOT repeated here — see the
--    mapping doc for the consistency confirmation.)
-- =============================================================================
update master_financial_items
set is_active = false
where category = 'asset'
  and item_key in ('business_ownership', 'partnership_interest', 'trust_assets', 'investment_property');

-- =============================================================================
-- 5. Reversed-direction Class-C duplicate — cash accounts belong in Assets,
--    not Investments (Spec 2's explicit rule; this is the one pair where
--    Assets, not Investments, is canonical — do not flip this direction).
--    NOTE: investment.cash_investments is a related but DISTINCT catalogue
--    row not enumerated in this sub-chunk's mapping and is deliberately
--    left untouched here — see the mapping doc's "flagged, not actioned"
--    section for why.
-- =============================================================================
update master_financial_items
set is_active = false
where category = 'investment'
  and item_key = 'high_interest_savings';

-- =============================================================================
-- 6. Class-E items that are Goals, not asset classes (Spec 2 §28). Existing
--    rows are NOT reclassified to a specific investment type — the real-DEV
--    audit found only generic/synthetic evidence (see the audit doc), so
--    per this sub-chunk's own discipline ("if none, leave flagged rather
--    than guess") they are left exactly as saved, now surfaced via the
--    grid's "Archived item" fallback pending a future Goal-linking phase.
-- =============================================================================
update master_financial_items
set is_active = false
where category = 'investment'
  and item_key in ('education_fund', 'children_investment');

-- =============================================================================
-- 7. Class-F contribution-flow items (Spec 2 §34-36) — these are future-
--    flow inputs, not standalone balances; the actual structural fix lives
--    in lib/engines/dashboard.ts's isRetirementContributionRow() exclusion
--    (shipped in this same commit, keys off master_item_key directly so it
--    protects a legacy row even before this migration is applied) and in
--    migration 0039's retirement_contributions backfill for the rows with
--    high-confidence evidence of their parent account. Deprecating these 6
--    catalogue items here stops any NEW phantom-balance row from being
--    created going forward.
-- =============================================================================
update master_financial_items
set is_active = false
where category = 'retirement'
  and item_key in (
    'employer_contributions', 'salary_sacrifice', 'personal_concessional',
    'non_concessional', 'government_co_contribution', 'spouse_contribution'
  );

-- =============================================================================
-- 8. allocated_pension -> account_based_pension (item 7) — confirmed
--    genuine AU pre-/post-2007 terminology duplicate (Chunk 3a §6). Same-
--    table, same-category relabel of the 10 real existing rows found in
--    DEV (see audit doc) — zero external code dependency on either key
--    (grep-verified), so this cannot change any computed total.
-- =============================================================================
update retirement_accounts
set master_item_key = 'account_based_pension'
where master_item_key = 'allocated_pension';

update master_financial_items
set is_active = false
where category = 'retirement'
  and item_key = 'allocated_pension';

-- =============================================================================
-- 9. retirement_savings -> other_retirement_assets (item 8) — genuinely
--    redundant vague catch-all, consolidated into the existing catch-all.
--    Same-table, same-category relabel of the 28 real existing rows found
--    in DEV (see audit doc) — zero external code dependency on either key.
-- =============================================================================
update retirement_accounts
set master_item_key = 'other_retirement_assets'
where master_item_key = 'retirement_savings';

update master_financial_items
set is_active = false
where category = 'retirement'
  and item_key = 'retirement_savings';

-- =============================================================================
-- Explicitly NOT deprecated by this migration, with reasons (see the
-- mapping doc for the full table):
--  - asset.gold / asset.silver / investment.gold / investment.silver — kept
--    both active, distinguished by purpose_dimension (Chunk 3a §2).
--  - asset.holiday_home / vacant_land / farm — genuinely ambiguous
--    personal-vs-investment purpose, no existing signal to disambiguate
--    (Chunk 3a §2's own disclosed judgement call); no module move made.
--  - asset.intellectual_property — low-priority ambiguous case, left as-is.
--  - investment.cash_investments — Class D per discovery, not enumerated
--    in this sub-chunk's explicit item list; flagged for a future pass.
--  - retirement.transition_to_retirement — confirmed genuinely distinct
--    product (Chunk 3a §6), not a duplicate; untouched.
--  - retirement.smsf, industry_super, retail_super, defined_benefit,
--    account_based_pension, other_retirement_assets — canonical
--    destinations, already active, untouched.
-- =============================================================================
