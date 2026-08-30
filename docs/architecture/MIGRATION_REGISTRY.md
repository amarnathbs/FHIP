# Migration registry

The single source of truth for allocated migration versions. **Record an
allocation here before writing the migration file.**

Allocate with:

```sh
node scripts/check-migration-versions.mjs   # reports the next free version
```

The same check runs inside `npm test` (`tests/unit/migrationVersions.test.ts`)
and fails the build if two active migrations ever share a version again.

**Cross-branch collision guard (added 2026-08-23, after the FDH-3/R6 `0058`
collision).** The single-working-tree check above cannot catch two
*different, unmerged* branches independently allocating the same version —
that is exactly the failure mode that produced the `0058` collision
documented below, and `check-migration-versions.mjs` could not have caught
it because neither branch's checkout ever contained the other branch's file.
Before merging any branch that carries a new migration:

```sh
npm run check:migrations:against-main
# equivalent to:
node scripts/check-migration-versions-against-branch.mjs --against=origin/main
```

This diffs `supabase/migrations` on your branch against `origin/main` (or
any `--against=<ref>`) via `git ls-tree`/blob comparison — no checkout of the
other ref required. A version claimed by two different filenames, or by the
same filename with different content, fails the build; a version that
matches byte-for-byte (legitimate shared ancestry after a real merge) does
not. See `scripts/check-migration-versions-against-branch.mjs`,
`tests/unit/migrationVersionsCrossBranch.test.ts`, and
`docs/architecture/ADR_0058_FDH3_II_R6_RECONCILIATION.md` "Future
prevention". This is currently a required **manual** pre-merge step (run it
yourself before opening/merging a migration-carrying PR) — there is no CI
pipeline in this repository to wire it into automatically yet.

- **Next free version: `0064`**
- Active migrations: 63 (`0001`-`0063`), one file per version
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

## FDH-3 — Secure Document Lifecycle (migration 0058)

**Allocation.** Built from `origin/main` at `c868de6` (57 active migrations).
The migration collision guard was run before allocation:
`OK: 57 active migrations, one file per version, next version is 0058.` One
file was allocated — `0058_fdh3_document_lifecycle_upload_storage.sql` — and
the guard was re-run after: `OK: 58 active migrations, one file per version,
next version is 0059.`

| File | Tables created | Existing tables altered (additive) |
| --- | --- | --- |
| `0058_fdh3_document_lifecycle_upload_storage.sql` | `fdh_upload_sessions`, `fdh_document_audit_events` | `fdh_statement_uploads` (+7 columns: `storage_provider`, `uploaded_at`, `validated_at`, `processing_started_at`, `processing_completed_at`, `purge_requested_at`, `duplicate_of_document_id`), `fdh_ingestion_jobs` (+1 trigger, no new column) |

**Additive-only, with two disclosed, deliberate exceptions:**
1. `drop index if exists uq_fdh_uploads_user_file_hash` — replaces a hard
   per-user uniqueness constraint (which would have made a second upload of
   the same file fail outright) with a soft `duplicate_of_document_id`
   pointer, because the FDH-3 spec requires duplicate detection to be a
   user-visible FLAG, never an automatic block. FDH-1 shipped no upload
   route, so this constraint was never exercised in production before FDH-3
   discovered the conflict. See the migration's own "DUPLICATE DETECTION"
   comment for the full rationale.
2. Two `before insert or update` triggers are added to the EXISTING
   `fdh_ingestion_jobs` table (FDH1-F1 tenant-referential-integrity
   hardening, spec section 5) — no column changes, additive in the sense
   that no existing write path is narrowed; only cross-tenant writes that
   were never valid in the first place are now refused at the database
   layer as well as by RLS.

No `drop table`, no `drop column`, no `delete from`, no destructive
`update` — verified by `tests/unit/fdh3SchemaContract.test.ts`.

**Governance note — collision happened exactly as anticipated, now resolved
(2026-08-23).** This section originally predicted that unmerged Investment
Intelligence R6 branches had independently allocated `0058` too. What
actually happened during the FDH-3 + Investment Intelligence R6 lineage
reconciliation: both versions of "0058" — this file and
`0058_ii_r6_p1_tax_engine.sql` on `feature/investment-intelligence-r6-
security-final` — had by then already been independently applied to the
SAME shared DEV database, each under its own original filename, before
either branch was merged with the other. Product Owner decision (explicit,
reasoned): **FDH-3 keeps `0058`** — it was built directly from canonical
`main`'s own certified chain through `0057`, giving it the stronger claim
as the natural continuation of that lineage, whereas R6's branch had forked
from an earlier ancestor of `main` that predates FDH-3's fork point.
Investment Intelligence R6's entire displaced 5-migration chain (originally
`0058`-`0062`) was shifted forward by one slot each, to `0059`-`0063` — see
the Investment Intelligence R6 section below and
`docs/database-reconciliation/0058_CANONICAL_LINEAGE_DECISION.md` for the
full reasoning. This is the fifth occurrence of this collision class in
this project (`ADR_MIGRATION_LINEAGE_RECONCILIATION.md`).

**Status: applied to DEV (2026-08-23) and independently re-verified live**
(see `financial_data_hub_fdh3` memory / `FDH3_COMPLETION_REPORT.md`). The
private storage bucket (`fdh-source-documents`) was already live in DEV
before this migration — created via the Storage Admin API
(`scripts/fdh3_create_storage_bucket.mjs`), independently of the SQL
migration. Once this migration applied, the `storage.objects` SELECT
policy, the two new tables, and the two FDH1-F1 triggers all went live and
were re-verified against real DEV data: real cross-tenant storage read/
delete attempts correctly blocked (404/403, ground-truth confirmed
untouched), and a real cross-tenant `fdh_upload_sessions` insert correctly
rejected by the FDH1-F1 trigger while the same-tenant case correctly
succeeded.

## Investment Intelligence R6 (migrations `0059`-`0063`, originally `0058`-`0062`)

Displaced by the collision above and shifted forward by one slot each
during the same reconciliation (2026-08-23). SQL content byte-identical to
the original files in every case except the renumbering headers and a
handful of internal prose cross-references between the five files
themselves (updated for accuracy, not functionally load-bearing).

| Current file | Originally | Purpose |
| --- | --- | --- |
| `0059_ii_r6_p1_tax_engine.sql` | `0058_ii_r6_p1_tax_engine.sql` | R6-P1 tax-lot/FIFO schema (4 tables + seed) |
| `0060_ii_r6_final_reference_seed.sql` | `0059_ii_r6_final_reference_seed.sql` | R6-FINAL reference-data seed |
| `0061_ii_r6_final_tax_profile.sql` | `0060_ii_r6_final_tax_profile.sql` | New `ii_tax_profiles` table |
| `0062_ii_r6_final_rls_forgery_fix.sql` | `0061_ii_r6_final_rls_forgery_fix.sql` | Same-user UPDATE/DELETE forgery fix |
| `0063_ii_r6_debt_fund_fix_reference_seed.sql` | `0062_ii_r6_debt_fund_fix_reference_seed.sql` | Debt-fund acquisition-date rule metadata sync |

**Status: all five already applied to DEV under their original numbers**
(confirmed independently live multiple times across this project's history
under those original filenames — see `investment_intelligence_r6` memory).
This renumbering is a pure repository-bookkeeping fix: DEV was never
tracking a filename, only the SQL text it already ran, and that SQL is
unchanged here. **No re-application to DEV is needed or intended for these
five files** — they are already live under their effects, just now
correctly numbered in the repository so a fresh clean-rebuild replay is
deterministic (`node scripts/db-rebuild-check/replay.mjs`: 63/63, verified).

## FDH-12 — Retirement Statement Intelligence (migration `0111`)

**Allocated 2026-08-30.** `0111_fdh12_retirement_statement_intelligence.sql`.

### Why 0111 and not 0107

`scripts/check-migration-versions.mjs` reported "next version is 0107", because
that tool only sees the current branch plus `origin/main` (whose chain tops out
at `0106`, the FDH-11 merge). **0107 is not safe.** A fresh scan of every
commit reachable from every local branch and every origin ref
(`git log --all --name-only -- 'supabase/migrations/*.sql'`), plus the working
directory of every `git worktree list` entry, found these already claimed above
`0106`:

| Number | File | Where |
| --- | --- | --- |
| `0107` | `admin_recommendations_conditions_import_integrity.sql` | unmerged branch |
| `0107` | `mandatory_country_confirmation_crud_and_onboarding_fix.sql` | unmerged branch — a **seventh occurrence** of this project's recurring collision class, already present in history before FDH-12 existed; resolved on that branch by renumbering to `0108` |
| `0108` | `mandatory_country_confirmation_crud_and_onboarding_fix.sql` | unmerged branch (`D:/fhip-country-confirm`) |
| `0109` | `admin_recommendation_upsert_atomicity.sql` | unmerged branch (`D:/fhip-admin-a02-wave1`) |
| `0110` | `module11_ai_foundation.sql` | unmerged branch (`D:/fhip-module11`) |

`0111` is the lowest number claimed by no branch, no worktree and no remote
ref. FDH-12 takes it and leaves `0103`-`0105` and `0107`-`0110` to their
owners.

### What it contains

Additive only. No `drop table`, no `drop column`.

* **PART A** — widens `fdh_document_audit_events.event_type` with 11 FDH-12
  event types (mirrored by `FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH12_ADDED`), and
  widens `retirement_accounts.source_type` with
  `'retirement_statement_import'`.
* **PARTS B/C/D** — three evidence tables:
  `fdh_retirement_statements`, `fdh_retirement_statement_activities`,
  `fdh_retirement_statement_positions`, each with RLS and owner-scoped
  read/insert/update policies (no DELETE policy, matching the 0106 shape).
* **PART E** — three ownership-guard triggers (cross-tenant FK forgery).
* **PART F** — three authoritative-write triggers (same-tenant column forgery),
  FDH-11 `auth.role()` style.
* **PART G** — generic-bridge extension: `source_retirement_statement_id` on
  `fhip_import_proposals` and `fhip_import_applications`,
  `last_import_application_id` / `last_imported_at` on `retirement_accounts`,
  and **re-creation of `fdh9_assert_proposal_owner()` /
  `fdh9_assert_application_owner()` with a `retirement` branch** (both fail
  closed on an unknown `target_domain`, exactly as 0091 intended and 0096
  extended for `liability`).
* **PART H** — `fdh12_approve_retirement_statement()`.
* **PART I** — `fdh12_apply_retirement_proposal()`, the only path from
  retirement statement evidence to canonical Retirement.
* **PART J** — durable table/function comments recording the boundaries.

### Status

**NOT APPLIED to DEV. NOT APPLIED to production.**

Certified in PGlite only: full 101-migration clean-rebuild replay PASS
(`node scripts/db-rebuild-check/replay.mjs`), and 53/53 DB-level security and
apply checks (`node scripts/fdh12_certification.mjs`), including an
anti-vacuity self-check.

Live DEV was introspected read-only on 2026-08-30 and confirmed **not** to
carry any of the three tables — evidence that no migration was applied by the
implementer, per this project's standing convention that only the Product
Owner applies migrations.
