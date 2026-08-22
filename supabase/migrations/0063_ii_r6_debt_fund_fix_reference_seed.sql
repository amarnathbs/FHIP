-- Investment Intelligence R6-DEBTFIX (2026-08-22) — reference-data sync.
--
-- RENUMBERED 0062 -> 0063 (2026-08-23, FDH-3 + Investment Intelligence R6
-- lineage reconciliation) — see the (now-)0059 file's header for the full
-- reasoning. SQL content unchanged.
--
-- Pure DML (UPDATE against existing rows), no DDL. Forward-only, idempotent
-- (each UPDATE is a full-value overwrite of `rule_definition`, safe to
-- rerun). Mirrors the SAME data-mirroring precedent as migration `0060`
-- (originally `0059`):
-- the live-DEV UPDATE happened first via the service-role key (this
-- session has no DDL capability, but plain DML against already-existing
-- tables/rows needs none), and this migration captures the identical
-- change for reproducibility in a fresh environment.
--
-- WHAT CHANGED AND WHY: capitalGainsEngine.ts's `debt_specified` branch was
-- fixed to actually READ `DebtSpecifiedRules.specifiedFundAcquiredOnOrAfter`
-- as a per-lot acquisition-date gate (previously documented but never
-- consumed — a real, live-DEV-confirmed defect that forced every
-- debt/specified lot to always-STCG regardless of its own acquisition
-- date). `ruleVersions.ts` gained a new `debtSpecified.legacyRegime` field
-- describing the pre-existing (pre-2023) debt-fund treatment for lots
-- acquired before the cutoff. `ii_tax_rule_versions.rule_definition` is
-- pure REFERENCE/DOCUMENTATION data — the engine computes from the
-- ruleVersions.ts in-memory constants directly, never from this table (see
-- that file's own module header) — but this migration keeps the DB mirror
-- honest and in sync with the corrected engine, per this module's own
-- stated design goal ("the three surfaces ... can be diffed against one
-- canonical source").
--
-- See lib/engines/investment-intelligence/tax/ruleVersions.ts and
-- docs/investment-intelligence/R6_DEBT_FUND_ACQUISITION_DATE_FIX.md for the
-- full defect history, legal research, and citations.

update ii_tax_rule_versions
set rule_definition = '{
  "placeholder": false,
  "sourceNote": "Income-tax Act 1961 as amended by Finance Act 2023 (specified mutual fund short-term rule, effective FY2023-24) and pre-Budget-2024 Section 112A rates. R6-DEBTFIX (2026-08-22): debtSpecified.legacyRegime for lots acquired before 2023-04-01 researched and verified 20% LTCG with CII indexation, 36-month threshold, under Section 112 as it stood before Budget 2024 (ClearTax, ICICI Direct, ValueResearchOnline - see R6_TAX_LEGAL_SOURCE_REGISTER.md Section 4a).",
  "debtSpecified": {"specifiedFundAcquiredOnOrAfter": "2023-04-01", "alwaysShortTerm": true, "indexationAllowed": false, "taxedAtSlabRate": true, "legacyRegime": {"ltcgHoldingPeriodMonths": 36, "ltcgRatePct": 20, "indexationAllowed": true, "stcgTaxedAtSlabRate": true}},
  "equityOriented": {"domesticEquityThresholdPct": 65, "stcgHoldingPeriodMonths": 12, "stcgRatePct": 15, "ltcgRatePct": 10, "ltcgExemptionThresholdInr": 100000, "indexationAllowed": false}
}'::jsonb
where rule_set_key = 'in_mutual_fund_capital_gains' and version = '1961_act_pre_20240723';

update ii_tax_rule_versions
set rule_definition = '{
  "placeholder": false,
  "sourceNote": "Finance (No. 2) Act, 2024, effective for transfers on/after 23 July 2024: equity STCG raised to 20%, LTCG raised to 12.5%, Section 112A exemption raised to Rs 1,25,000/FY. Debt/specified-fund short-term-always rule (FY2023-24 Finance Act) unchanged. R6-DEBTFIX (2026-08-22): debtSpecified.legacyRegime for lots acquired before 2023-04-01 changed on this SAME 23-Jul-2024 boundary - Budget 2024 shortened the non-equity/debt-fund LTCG holding threshold from 36 to 24 months AND removed indexation, replacing 20%-with-indexation with a flat 12.5%-no-indexation rate (mandatory for this disposal-date window, NOT the optional 20%-indexed/12.5%-unindexed CHOICE Budget 2024 separately granted for land/building - confirmed distinct, see R6_TAX_LEGAL_SOURCE_REGISTER.md Section 4a).",
  "debtSpecified": {"specifiedFundAcquiredOnOrAfter": "2023-04-01", "alwaysShortTerm": true, "indexationAllowed": false, "taxedAtSlabRate": true, "legacyRegime": {"ltcgHoldingPeriodMonths": 24, "ltcgRatePct": 12.5, "indexationAllowed": false, "stcgTaxedAtSlabRate": true}},
  "equityOriented": {"domesticEquityThresholdPct": 65, "stcgHoldingPeriodMonths": 12, "stcgRatePct": 20, "ltcgRatePct": 12.5, "ltcgExemptionThresholdInr": 125000, "indexationAllowed": false}
}'::jsonb
where rule_set_key = 'in_mutual_fund_capital_gains' and version = '1961_act_post_20240723';

update ii_tax_rule_versions
set rule_definition = '{
  "placeholder": false,
  "sourceNote": "Income-tax Act, 2025 [30 of 2025], effective 1 April 2026 (Tax Year 2026-27). Section 196 (STCG) and Section 198 (LTCG) re-enact Sections 111A/112A of the 1961 Act with no rate/threshold change: equity/equity-oriented-fund STCG 20 percent, LTCG 12.5 percent above Rs 1,25,000/tax year, no indexation. Debt/specified-mutual-fund always-short-term-at-slab-rate rule (Finance Act 2023) continues unchanged. Verified 2026-08-22 against indiankanoon.org transcription of the enacted Act text plus five corroborating secondary sources - see R6_TAX_LEGAL_SOURCE_REGISTER.md. R6-DEBTFIX (2026-08-22): debtSpecified.legacyRegime figures (24-month/12.5%/no-indexation) carried forward UNCHANGED from the post-23-Jul-2024 1961-Act row by INFERENCE, not independently section-cited - a disclosed open item, same class of gap as grandfathering continuity into the 2025 Act.",
  "debtSpecified": {"specifiedFundAcquiredOnOrAfter": "2023-04-01", "alwaysShortTerm": true, "indexationAllowed": false, "taxedAtSlabRate": true, "legacyRegime": {"ltcgHoldingPeriodMonths": 24, "ltcgRatePct": 12.5, "indexationAllowed": false, "stcgTaxedAtSlabRate": true}},
  "equityOriented": {"domesticEquityThresholdPct": 65, "stcgHoldingPeriodMonths": 12, "stcgRatePct": 20, "ltcgRatePct": 12.5, "ltcgExemptionThresholdInr": 125000, "indexationAllowed": false}
}'::jsonb
where rule_set_key = 'in_mutual_fund_capital_gains' and version = '2025_act_post_20260401';
