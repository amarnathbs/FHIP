-- =============================================================================
-- FDH-4 — Bank Adapter Coverage Expansion.
-- =============================================================================
-- PURE ADDITIVE SEED. FDH4-A's audit (docs/financial-data-hub/
-- FDH4_R7_ADOPTION_AUDIT.md) found R7's architecture, transaction model,
-- deduplication engine and reconciliation engine FULLY SATISFY FDH-4's
-- requirements. The only genuine gap was ADAPTER COVERAGE: R7 shipped 6
-- certified institution adapters (3 AU, 3 IN) against FDH-2's 30 AU+IN bank
-- entries. FDH-4 closes the priority-wave gap by adding 4 new certified
-- adapters — completing all 4 priority AU banks (CBA, ANZ, NAB, Westpac) and
-- all 4 priority IN banks (SBI, HDFC, ICICI, Axis) per spec sections 28-29 —
-- plus one secondary-wave bank per country (Macquarie, Kotak Mahindra) where
-- corroborated public evidence was found (spec section 30). No schema
-- change, no new table, no new engine — this migration only adds governance
-- rows mirroring lib/financial-data-hub/bank-csv/adapters/{auAdapters,
-- inAdapters}.ts and advances coverage_status for exactly these 4
-- institutions, following the EXACT precedent set by migration 0064's own
-- final block. No other institution's coverage_status changes.
--
-- Evidence provenance for the 4 new adapters (spec section 30, documented in
-- full with source URLs in docs/financial-data-hub/FDH4_AU_ADAPTERS.md and
-- FDH4_IN_ADAPTERS.md): column layouts are structural reproductions of each
-- institution's own publicly-documented CSV-export conventions, corroborated
-- across multiple independent third-party sources found via web search this
-- session. No real customer statement, account number or transaction
-- history is embedded here or in any fixture — all fixtures are synthetic
-- (tests/fixtures/r7-bank-csv/au_anz_debit_credit.csv,
-- au_macquarie_debit_credit.csv, in_axis_debit_credit.csv,
-- in_kotak_debit_credit.csv).
-- =============================================================================

insert into fdh_parser_registry (parser_key, institution_id, document_type, source_format, country_code, active)
select 'au_anz_debit_credit_v1', id, 'bank_statement', 'csv', 'AU', true from fdh_financial_institutions where institution_code = 'anz' and country_code = 'AU'
union all
select 'au_macquarie_debit_credit_v1', id, 'bank_statement', 'csv', 'AU', true from fdh_financial_institutions where institution_code = 'macquarie_bank' and country_code = 'AU'
union all
select 'in_axis_debit_credit_v1', id, 'bank_statement', 'csv', 'IN', true from fdh_financial_institutions where institution_code = 'axis_bank' and country_code = 'IN'
union all
select 'in_kotak_debit_credit_v1', id, 'bank_statement', 'csv', 'IN', true from fdh_financial_institutions where institution_code = 'kotak_mahindra_bank' and country_code = 'IN';

insert into fdh_parser_versions (parser_id, version, status, introduced_at, supported_layout_reference, notes)
select id, '1.0.0', 'certified', now(), 'synthetic structural fixture',
  'FDH-4 adapter-coverage expansion — certified against synthetic representative fixture (spec 63/FDH-4 spec 31). No real customer statement used. Format corroborated against multiple independent public sources; see FDH4_AU_ADAPTERS.md / FDH4_IN_ADAPTERS.md for evidence provenance.'
from fdh_parser_registry where parser_key in (
  'au_anz_debit_credit_v1', 'au_macquarie_debit_credit_v1',
  'in_axis_debit_credit_v1', 'in_kotak_debit_credit_v1'
);

-- The 4 institutions FDH-4 ships a certified adapter for move from FDH-2's
-- master_only to parser_certified, following migration 0064's exact
-- precedent. No other institution's coverage_status changes.
update fdh_financial_institutions set coverage_status = 'parser_certified'
where (country_code, institution_code) in (
  ('AU', 'anz'), ('AU', 'macquarie_bank'),
  ('IN', 'axis_bank'), ('IN', 'kotak_mahindra_bank')
);
