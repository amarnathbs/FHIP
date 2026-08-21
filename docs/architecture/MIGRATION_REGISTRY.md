# Migration registry

The single source of truth for allocated migration versions. **Record an
allocation here before writing the migration file.**

Allocate with:

```sh
node scripts/check-migration-versions.mjs   # reports the next free version
```

The same check runs inside `npm test` (`tests/unit/migrationVersions.test.ts`)
and fails the build if two active migrations ever share a version again.

- **Next free version: `0058`**
- Active migrations: 57 (`0001`-`0057`), one file per version
- Archived historical artefacts: 10 (see `supabase/migration_archive/README.md`) — never executed

## Allocated versions

| Version | File | Module | Status |
|---|---|---|---|
| 0001-0030 | (see `supabase/migrations/`) | Core platform | Applied to DEV, merged to `main` |
| 0031 | `0031_ii_reference_foundation.sql` | Investment Intelligence R1 | Applied to DEV |
| 0032 | `0032_ii_source_documents_accounts.sql` | Investment Intelligence R1 | Applied to DEV |
| 0033 | `0033_ii_transactions_holdings.sql` | Investment Intelligence R1 | Applied to DEV |
| 0034 | `0034_ii_publishing_goal_allocations.sql` | Investment Intelligence R1 | Applied to DEV |
| 0035 | `0035_ii_analytics_insights_reconciliation.sql` | Investment Intelligence R1 | Applied to DEV |
| 0036 | `0036_ii_audit_events.sql` | Investment Intelligence R1 | Applied to DEV |
| 0037 | `0037_ii_storage_policy.sql` | Investment Intelligence R1 | Applied to DEV |
| 0038 | `0038_ii_india_adapter_seed.sql` | Investment Intelligence R1 | Applied to DEV |
| 0039 | `0039_ii_r2_audit_and_document_lifecycle.sql` | Investment Intelligence R2 | Applied to DEV |
| 0040 | `0040_ii_r2_transaction_lineage_and_dedup.sql` | Investment Intelligence R2 | Applied to DEV |
| 0041 | `0041_ii_r2_scheme_resolution_and_portfolio_truth.sql` | Investment Intelligence R2 | Applied to DEV |
| 0042 | `0042_ii_r3_fhip_publishing_bridge.sql` | Investment Intelligence R3 | Applied to DEV |
| 0043 | `0043_ii_r4_performance_benchmark_reference_data.sql` | Investment Intelligence R4 | Applied to DEV |
| 0044 | `0044_ii_r5_sip_xray_holdings.sql` | Investment Intelligence R5 | Applied to DEV |
| 0045 | `0045_fdh_reference_foundation.sql` | Financial Data Hub FDH-1 | Applied to DEV |
| 0046 | `0046_fdh_accounts_documents_jobs.sql` | Financial Data Hub FDH-1 | Applied to DEV |
| 0047 | `0047_fdh_transactions_and_classification.sql` | Financial Data Hub FDH-1 | Applied to DEV |
| 0048 | `0048_fdh_review_quality_provenance.sql` | Financial Data Hub FDH-1 | Applied to DEV |
| 0049 | `0049_reconcile_phase0c_resources_lineage.sql` | Cross-stream reconciliation | Applied to DEV |
| 0050 | `0050_fdh2_taxonomy_mcc_foundation.sql` | Financial Data Hub FDH-2 | NOT yet applied to DEV — delivered to Product Owner for manual application |
| 0051 | `0051_fdh2_institution_and_payment_rail_foundation.sql` | Financial Data Hub FDH-2 | NOT yet applied to DEV |
| 0052 | `0052_fdh2_merchant_and_governance_foundation.sql` | Financial Data Hub FDH-2 | NOT yet applied to DEV |
| 0053 | `0053_fdh2_taxonomy_and_mcc_seed.sql` | Financial Data Hub FDH-2 (generated seed) | NOT yet applied to DEV |
| 0054 | `0054_fdh2_institution_and_payment_rail_seed.sql` | Financial Data Hub FDH-2 (generated seed) | NOT yet applied to DEV |
| 0055 | `0055_fdh2_merchant_seed.sql` | Financial Data Hub FDH-2 (generated seed) | NOT yet applied to DEV |
| 0056 | `0056_fdh2_classification_rule_seed.sql` | Financial Data Hub FDH-2 (generated seed) | NOT yet applied to DEV |
| 0057 | `0057_fdh2_closure_research_corrections.sql` | Financial Data Hub FDH-2 (closure-research corrections, hand-written, additive/corrective only) | NOT yet applied to DEV — delivered to Product Owner for manual application alongside 0050-0056 |

**0049 detail** — Purpose: canonical forward re-emission of the archived
Phase 0C and Resources lineage (the ten displaced `0031`-`0040` files listed
below), so a fresh database can be rebuilt deterministically from a single
`0001`-`0049` chain without any duplicate version. **Applied to DEV
(`vqycarelcoijzwlpkpcz`) 2026-08-21, independently verified live**
post-application (idempotent no-op against existing data: `user_financial_section_status`
row count unchanged, new `resource_posts`/`resource_faqs` columns present and
functional, `search_resource_posts` RPC callable by `anon`, public settings
policy and staff-only workflow-history policy both behave correctly). See
`docs/database-reconciliation/MIGRATION_LINEAGE_COMPLETION_REPORT.md` for the
full pre- and post-application evidence package. Production
(`twwpnltizhtjxhamyoxt`) has never received any migration from this
reconciliation and was never touched.

## Historical collision — RECONCILED (2026-08-21)

Versions 0031-0040 were each claimed by two files. Investment Intelligence is
the canonical active owner; the Phase 0C and Resources counterparts are archived
and their effects re-emitted by `0049`. See
`docs/architecture/ADR_MIGRATION_LINEAGE_RECONCILIATION.md`.

| Legacy version | Investment Intelligence file (canonical, active) | Displaced file (archived) | Displaced module | Both applied to DEV? | Re-emitted by |
|---|---|---|---|---|---|
| 0031 | `0031_ii_reference_foundation.sql` | `0031_financial_section_status.sql` | Phase 0C | Yes | 0049 |
| 0032 | `0032_ii_source_documents_accounts.sql` | `0032_section_status_reviewed_with_data.sql` | Phase 0C | Yes | 0049 |
| 0033 | `0033_ii_transactions_holdings.sql` | `0033_resources_foundation.sql` | Resources | Yes | 0049 |
| 0034 | `0034_ii_publishing_goal_allocations.sql` | `0034_resources_seed.sql` | Resources | Yes | 0049 |
| 0035 | `0035_ii_analytics_insights_reconciliation.sql` | `0035_resources_analyst_role_delta.sql` | Resources | Yes | 0049 |
| 0036 | `0036_ii_audit_events.sql` | `0036_resources_anon_function_grants_fix.sql` | Resources | Yes | 0049 |
| 0037 | `0037_ii_storage_policy.sql` | `0037_resources_editor_support.sql` | Resources | Yes | 0049 |
| 0038 | `0038_ii_india_adapter_seed.sql` | `0038_resources_specialist_content_support.sql` | Resources | Yes | 0049 |
| 0039 | `0039_ii_r2_audit_and_document_lifecycle.sql` | `0039_resources_public_settings_read.sql` | Resources | Yes | 0049 |
| 0040 | `0040_ii_r2_transaction_lineage_and_dedup.sql` | `0040_resources_discovery_context_support.sql` | Resources | Yes | 0049 |

## Module ownership boundaries

Investment Intelligence is the canonical owner of investment accounts,
securities, holdings, investment transactions, valuations, portfolio
calculations, performance data (XIRR/TWRR/CAGR), benchmarks, risk and
investment analytics. These are never moved into Resources or FDH and are never
renamed to resolve numbering.

## FDH-1 migrations in detail

(Carried forward from FDH-1's original registry entry — not duplicated
elsewhere.)

| File | Tables created | Existing tables altered |
| --- | --- | --- |
| `0045_fdh_reference_foundation.sql` | `fdh_source_types`, `fdh_financial_institutions`, `fdh_categories`, `fdh_subcategories`, `fdh_merchants`, `fdh_merchant_aliases`, `fdh_classification_rules`, `fdh_parser_registry`, `fdh_parser_versions` | **none** |
| `0046_fdh_accounts_documents_jobs.sql` | `fdh_financial_accounts`, `fdh_statement_uploads`, `fdh_ingestion_jobs` | **none** |
| `0047_fdh_transactions_and_classification.sql` | `fdh_transactions`, `fdh_transaction_allocations`, `fdh_transaction_links`, `fdh_duplicate_candidates`, `fdh_user_classification_rules`, `fdh_classification_history`, `fdh_recurring_transactions` | **none** |
| `0048_fdh_review_quality_provenance.sql` | `fdh_review_items`, `fdh_reconciliation_results`, `fdh_data_quality_results`, `fdh_data_provenance`, `fdh_evidence_links` | **none** |

All four are additive. They contain no `alter table` against any pre-existing
table, no `drop`, and no `update`/`delete` of any existing row. They reference
`auth.users`, `countries`, `currencies` and `households` by foreign key only.

## FDH-2 — Australia & India Category, MCC, Institution & Merchant Intelligence Foundation

Base branch: `feature/financial-data-hub-fdh-2-master-data`, created 2026-08-21
by merging `feature/financial-data-hub-fdh-1-foundation` (`7a7e53a`, full FDH-1
application code + migrations `0045`-`0048`) with `fix/migration-lineage-ii-resources`
(`76b40f4`, the certified migration-lineage reconciliation, migrations
`0031`-`0044` + `0049` + the collision guard). These were sibling branches off
the same point in `main` (`fe7a094`) — neither contained the other — so this
merge was required before any FDH-2 migration could be safely allocated.
`0045`-`0048` were confirmed byte-identical between both branches before
merging (verified via SHA-256, not assumed).

**Allocation.** The migration guard was re-run live on this integration
branch before any FDH-2 file was written: `OK: 49 active migrations, one
file per version, next version is 0050.` Seven versions were allocated,
`0050`-`0056` — three schema migrations (additive `alter table` on FDH-1
tables plus eight brand-new FDH-2 tables) and four generated seed
migrations (idempotent `insert ... on conflict (...) do nothing`, produced
deterministically by `scripts/fdh2_generate_master_data_migration.mjs` from
the version-controlled source data in `data/financial-data-hub/*.mjs`). The
guard was re-run after allocation: `OK: 56 active migrations, one file per
version, next version is 0057.`

| File | Tables created | Existing tables altered (additive only) |
| --- | --- | --- |
| `0050_fdh2_taxonomy_mcc_foundation.sql` | `fdh_source_registry`, `fdh_economic_transaction_types`, `fdh_mcc_master`, `fdh_mcc_category_map` | `fdh_categories` (+9 columns, 3 constraints, widened `essential_discretionary`), `fdh_subcategories` (+8 columns, 2 constraints, widened `essential_discretionary`) |
| `0051_fdh2_institution_and_payment_rail_foundation.sql` | `fdh_institution_capabilities`, `fdh_institution_aliases`, `fdh_payment_rail_master` | `fdh_financial_institutions` (+5 columns, widened `institution_type` to add `government_payment_source`/`payment_processor`) |
| `0052_fdh2_merchant_and_governance_foundation.sql` | `fdh_global_learning_candidates` | `fdh_merchants` (+10 columns, 1 constraint), `fdh_classification_rules` + `fdh_user_classification_rules` (widened `rule_type` to add `narrative_pattern`/`payment_rail_narrative`) |
| `0053_fdh2_taxonomy_and_mcc_seed.sql` | — (seed only) | 11 source-registry rows, 13 economic-type rows, 25 categories, 121 subcategories, 87 MCCs, 87 MCC-category mappings |
| `0054_fdh2_institution_and_payment_rail_seed.sql` | — (seed only) | 47 institutions (22 AU + 25 IN), 3 institution capabilities, 98 institution aliases, 20 payment rails |
| `0055_fdh2_merchant_seed.sql` | — (seed only) | 123 merchants (69 AU + 54 IN), 198 merchant aliases |
| `0056_fdh2_classification_rule_seed.sql` | — (seed only) | 60 classification-rule pattern seeds |

All seven files are additive: every `alter table` either adds a nullable/
defaulted column or performs the sanctioned `drop constraint if exists
<name>` + `add constraint <same name>` additive-widening idiom (verified by
`tests/unit/fdh2SchemaContract.test.ts`, which fails if any dropped
constraint is not re-added under the identical name). No `drop table`, no
`drop column`, no `update`, no `delete from` appears anywhere in the three
schema migrations. Every seed-migration INSERT uses
`on conflict (<stable key>) do nothing` — proven idempotent by
`scripts/fdh2_certify_master_data.mjs` (the four seed migrations were
re-applied a second time against an already-seeded database with zero row
count change).

**Status as of this dispatch: NOT yet applied to DEV or production.**
Delivered to the orchestrating session as complete migration SQL, per this
project's established controlled manual-application process (Product Owner
applies via the Supabase Dashboard SQL editor) — this agent has no DDL
execution capability against any live environment.
