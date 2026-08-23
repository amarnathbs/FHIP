-- ============================================================================
-- 0057 — FDH-2 closure-research corrections (live web-verification pass,
-- 2026-08-22)
-- ============================================================================
--
-- WHY THIS MIGRATION EXISTS
--
-- FDH-2's original implementation (migrations 0050-0056, "FDH-2 Live Research,
-- DEV Application Prep & Closure" dispatch) disclosed that no live web
-- research was performed — every institution/MCC/merchant fact rested on the
-- model's trained knowledge, with four specific entries flagged
-- LOWER-CONFIDENCE (ME Bank, Suncorp Bank, JioHotstar/Disney+ Hotstar
-- merger, BYJU'S). This migration is the result of a genuine live
-- web-research closure pass against those four facts plus a broader
-- institution/MCC/merchant re-verification sweep (APRA ADI register, RBI
-- published bank lists, official institution/merchant sites, and
-- payment-network MCC references). See
-- docs/financial-data-hub/FDH2_RESEARCH_EVIDENCE.md's closure-research
-- section (dated 2026-08-22) for the full source-by-source evidence this
-- migration's changes are drawn from.
--
-- MIGRATION-IMMUTABILITY COMPLIANCE (docs/architecture/MIGRATION_REGISTRY.md)
--
-- 0050-0056 are NOT edited in place. Every correction here is a fresh
-- forward UPDATE (or a conflict-guarded INSERT for the two genuinely new
-- rows) against the rows those migrations already seeded.
--
-- SAFETY PROPERTIES
--
--  * Additive/corrective only. No DROP, no DELETE, no destructive rewrite of
--    any existing table, policy, or Investment Intelligence/Resources/
--    Input-Data object. Touches only fdh_financial_institutions,
--    fdh_institution_aliases, fdh_mcc_master, fdh_mcc_category_map,
--    fdh_merchants, and fdh_source_registry — all FDH-2's own tables.
--  * Idempotent. Every UPDATE re-applies the same target value if run twice
--    (no relative/incremental logic). The two INSERTs are ON CONFLICT DO
--    NOTHING guarded.
--  * Every UPDATE is scoped by primary/natural key (country_code +
--    institution_code, mcc [+ country_code], or country_code +
--    canonical_name) so a miss is a silent no-op, never a wrong-row write.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- New source-registry entry documenting this closure-research pass, so every
-- row corrected/re-verified below can carry an honest source_key rather than
-- being left pointing at the original un-verified "trained knowledge" source.
-- ---------------------------------------------------------------------------
insert into fdh_source_registry (source_key, source_name, source_category, source_reference_note, accessed_at, notes)
values (
  'fdh2_closure_live_research_20260822',
  'FDH-2 closure-research live web-verification pass (2026-08-22)',
  'other',
  $lit$APRA ADI register (apra.gov.au); RBI-published bank information; ANZ/AFCA/Suncorp Bank/ME Bank official pages; Groww IPO prospectus + ROC filing coverage; Protean eGov official site; Wikipedia (Byju's, Merchant category code); TechCrunch/Business Standard/BusinessNewsAustralia/ABC News press coverage; greggles/mcc-codes aggregated MCC reference cross-checked against Visa/Citibank/payment-processor MCC documentation.$lit$,
  '2026-08-22',
  $lit$Live web search/fetch performed to close FDH-2's four originally-disclosed LOWER-CONFIDENCE entries (ME Bank, Suncorp Bank, JioHotstar merger, BYJU'S) plus a broader institution/MCC/merchant re-verification sweep. See FDH2_RESEARCH_EVIDENCE.md closure-research section for the full per-claim evidence.$lit$
)
on conflict (source_key) do nothing;


-- ---------------------------------------------------------------------------
-- fdh_financial_institutions corrections
-- ---------------------------------------------------------------------------

-- ME Bank (AU): resolves the LOWER-CONFIDENCE entry. APRA revoked Members
-- Equity Bank Limited's ADI licence after its banking business transferred to
-- Bank of Queensland Limited; ME Bank's own site now states it is "a division
-- of Bank of Queensland Limited". legal_name corrected accordingly.
update fdh_financial_institutions
set legal_name = 'Bank of Queensland Limited',
    source_key = 'fdh2_closure_live_research_20260822',
    source_checked_at = '2026-08-22'
where country_code = 'AU' and institution_code = 'me_bank';

-- Suncorp Bank (AU): resolves the LOWER-CONFIDENCE entry. Suncorp-Metway
-- Limited legally renamed to Norfina Limited (same ABN 66 010 831 722) as
-- part of the completed ANZ acquisition (31 July 2024), continuing to trade
-- as "Suncorp Bank".
update fdh_financial_institutions
set legal_name = 'Norfina Limited',
    source_key = 'fdh2_closure_live_research_20260822',
    source_checked_at = '2026-08-22'
where country_code = 'AU' and institution_code = 'suncorp_bank';

-- SelfWealth (AU): 2025 takeover contest resolved in favour of Syfe (via
-- Svava Pte Ltd); SelfWealth delisted from the ASX and now trades as
-- "Selfwealth by Syfe". parent_group corrected from null.
update fdh_financial_institutions
set parent_group = 'Syfe (Svava Pte Ltd)',
    source_key = 'fdh2_closure_live_research_20260822',
    source_checked_at = '2026-08-22'
where country_code = 'AU' and institution_code = 'selfwealth';

-- Bank Australia (AU): completed its merger with Qudos Bank on 1 July 2025;
-- both retail brands now operate under the single Bank Australia Ltd legal
-- entity. Re-verification timestamp bumped; the new QUDOS BANK alias is
-- inserted below.
update fdh_financial_institutions
set source_key = 'fdh2_closure_live_research_20260822',
    source_checked_at = '2026-08-22'
where country_code = 'AU' and institution_code = 'bank_australia';

-- Yes Bank (IN): promoted to verified. The originally-seeded "SBI-led
-- consortium" ownership fact was accurate as of 2020 but is now stale — SMBC
-- (Sumitomo Mitsui Banking Corporation) has since become Yes Bank's largest
-- shareholder (~24.2%) via a 2025 secondary purchase from SBI and other
-- lenders. No parent_group is set (SMBC's stake is not a majority/
-- controlling holding), so no column value actually changes here beyond the
-- re-verification timestamp/source.
update fdh_financial_institutions
set source_key = 'fdh2_closure_live_research_20260822',
    source_checked_at = '2026-08-22'
where country_code = 'IN' and institution_code = 'yes_bank';

-- Groww (IN): the holding company converted from a private to a public
-- limited company ahead of its November 2025 IPO (fresh certificate of
-- incorporation 11 Apr 2025). legal_name corrected.
update fdh_financial_institutions
set legal_name = 'Billionbrains Garage Ventures Limited',
    source_key = 'fdh2_closure_live_research_20260822',
    source_checked_at = '2026-08-22'
where country_code = 'IN' and institution_code = 'groww';

-- Protean eGov Technologies / NPS CRA (IN): the NPS CRA informational site
-- migrated from the legacy npscra.nsdl.co.in domain to npscra.proteantech.in.
update fdh_financial_institutions
set website_domain = 'npscra.proteantech.in',
    source_key = 'fdh2_closure_live_research_20260822',
    source_checked_at = '2026-08-22'
where country_code = 'IN' and institution_code = 'protean_enps';


-- ---------------------------------------------------------------------------
-- fdh_institution_aliases — new alias created by the Bank Australia / Qudos
-- Bank merger (a statement narrative showing "QUDOS BANK" now resolves to
-- the same legal entity as Bank Australia).
-- ---------------------------------------------------------------------------
insert into fdh_institution_aliases (institution_id, alias, alias_normalized, source, confidence, verified)
values (
  (select id from fdh_financial_institutions where country_code = 'AU' and institution_code = 'bank_australia'),
  'QUDOS BANK', 'QUDOS BANK', 'external_reference', 0.90, true
)
on conflict (institution_id, alias_normalized) do nothing;


-- ---------------------------------------------------------------------------
-- fdh_mcc_master correction
-- ---------------------------------------------------------------------------

-- MCC 6540: official_or_public_description was a paraphrase ("POS Funding —
-- Non-Financial Institutions") rather than the standard network text.
-- Corrected to the verified standard description, cross-checked against
-- multiple independent payment-processor MCC references.
update fdh_mcc_master
set official_or_public_description = 'Non-Financial Institutions — Stored Value Card Purchase/Load',
    source_version = '2026-08-22-closure-verified'
where mcc = '6540';


-- ---------------------------------------------------------------------------
-- fdh_mcc_category_map correction
-- ---------------------------------------------------------------------------

-- MCC 5531 ("Auto and Home Supply Stores"): the verified official
-- description and its standard trade classification confirm these
-- establishments commonly also sell home appliances/electronics alongside
-- automotive parts — genuinely spanning transport and shopping household
-- purposes. Downgraded from direct/medium (with a
-- vehicle_maintenance_registration subcategory) to broad_group_only/low with
-- no subcategory, per the "never force false precision" principle.
update fdh_mcc_category_map
set subcategory_id = null,
    mapping_confidence = 'low',
    mapping_type = 'broad_group_only',
    ambiguity_flag = true,
    requires_additional_context = true,
    notes = $lit$CLOSURE-RESEARCH DOWNGRADED 2026-08-22 (live web search): the verified official description ("Auto and Home Supply Stores") explicitly notes these establishments frequently also sell home appliances, radios and televisions alongside automotive parts — a genuinely mixed-purpose store type, not a reliable direct signal for vehicle_maintenance_registration alone.$lit$
where mcc = '5531' and country_code is null;


-- ---------------------------------------------------------------------------
-- fdh_merchants corrections
-- ---------------------------------------------------------------------------

-- Catch.com.au (AU): Wesfarmers permanently closed Catch.com.au, last
-- trading day 30 April 2025, after sustained losses. Marked inactive rather
-- than silently left as an operating merchant; kept seeded for
-- narrative-matching on older statements.
update fdh_merchants
set active = false,
    source_key = 'fdh2_closure_live_research_20260822',
    source_checked_at = '2026-08-22'
where country_code = 'AU' and canonical_name = 'catch_au';

-- Menulog (AU): ceased Australian operations 26 November 2025 (Just Eat
-- Takeaway.com exited the Australian market). Marked inactive.
update fdh_merchants
set active = false,
    source_key = 'fdh2_closure_live_research_20260822',
    source_checked_at = '2026-08-22'
where country_code = 'AU' and canonical_name = 'menulog';

-- Zomato (IN): parent-entity rename to Eternal Limited verified — the
-- previously-seeded "2024" rename year is corrected to the confirmed 2025
-- timeline (board approval 6 Feb 2025, effective March 2025). No column
-- value changes (parent_company_name was already 'Eternal Limited'); only
-- the re-verification timestamp/source is bumped, since the year detail
-- lives only in the source-data documentation, not a DB column.
update fdh_merchants
set source_key = 'fdh2_closure_live_research_20260822',
    source_checked_at = '2026-08-22'
where country_code = 'IN' and canonical_name = 'zomato';

-- JioHotstar (IN): resolves the LOWER-CONFIDENCE entry. The Disney+
-- Hotstar/JioCinema merger into JioHotstar (14 Feb 2025, under the JioStar
-- joint venture) is confirmed complete. Seeded facts were accurate; no
-- column value changes beyond the re-verification timestamp/source.
update fdh_merchants
set source_key = 'fdh2_closure_live_research_20260822',
    source_checked_at = '2026-08-22'
where country_code = 'IN' and canonical_name = 'jiohotstar';

-- BYJU'S (IN): resolves the LOWER-CONFIDENCE entry. Confirmed still under
-- active insolvency proceedings as of mid-2026 (not liquidated/dissolved),
-- so it remains seeded and active for narrative-matching. No column value
-- changes beyond the re-verification timestamp/source.
update fdh_merchants
set source_key = 'fdh2_closure_live_research_20260822',
    source_checked_at = '2026-08-22'
where country_code = 'IN' and canonical_name = 'byjus';
