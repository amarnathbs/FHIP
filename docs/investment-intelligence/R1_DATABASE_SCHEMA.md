# R1 — Database Schema

Status: FINAL
Source of truth: `supabase/migrations/0031` through `0038`. This document describes what those files actually contain — every claim below was checked against the migration text, not asserted from the R0 design docs alone.

Legend for **Ownership**: `shared (world-read)` = no `user_id` column, RLS is `for select using (true)`, writes are admin/service-role only. `owner-only` = `user_id not null`, RLS is `for all using (auth.uid() = user_id) with check (auth.uid() = user_id)`. `owner-read-only` = `user_id` nullable, RLS is `for select using (auth.uid() = user_id)` with no insert/update/delete policy for any authenticated role.

## Migration 0031 — reference/catalogue foundation

### `ii_sources`
- **Purpose**: catalogue of source *types* (CAMS, KFintech, manual, etc.) — reference data, not per-upload records.
- **PK**: `id uuid`. **Ownership**: shared (world-read).
- **Important columns**: `source_key` (unique), `source_label`, `source_category` (check: `statement_provider|broker|manual|admin|api_connector`), `country_code` (nullable FK → `countries`), `is_active`, `parser_available` (always `false` in R1 — no parser exists), `metadata jsonb`.
- **FKs**: `country_code → countries(country_code)`.
- **Unique**: `source_key`.
- **Indexes**: none beyond the PK/unique (small, rarely-scanned table).
- **RLS**: `for select using (true)`; no write policy for any authenticated role.
- **Lifecycle**: `is_active` boolean; rarely changes.
- **Country applicability**: global table; India-adapter rows contributed as data (migration `0038`), not schema.
- **R2+ usage**: source-type lookups for the real parser pipeline.

### `ii_instruments`
- **Purpose**: country-neutral instrument master (a specific security/fund/scheme). Shared reference data, **not** user-owned.
- **PK**: `id uuid`. **Ownership**: shared (world-read).
- **Important columns**: `instrument_name`, `instrument_class` (check: `equity|mutual_fund|etf|bond|fixed_deposit|gold|crypto|cash|other`), `country_of_domicile` (FK, not null), `base_currency` (FK, not null), `isin` (nullable), `status` (check: `provisional|verified|deprecated|merged`), `merged_into_instrument_id` (self-FK), `source_id` (nullable FK), `is_active`.
- **FKs**: `country_of_domicile → countries`, `base_currency → currencies`, `merged_into_instrument_id → ii_instruments(id)`, `source_id → ii_sources(id)`.
- **Unique**: none at the instrument-row level (identifiers carry uniqueness — see `ii_instrument_identifiers`).
- **Indexes**: `idx_ii_instruments_class`.
- **RLS**: world-read, admin/system-write.
- **Lifecycle**: `status` transitions `provisional → verified/deprecated/merged`; a provisional instrument gets a real `id` immediately (ADR-002) and is reconciled into a verified record later via `merged_into_instrument_id` without breaking existing FKs.
- **Country applicability**: global core table — no India-only required column (ADR-005 test).
- **R2+ usage**: real AMFI/ISIN master-feed reconciliation, X-ray/analytics subject.

### `ii_instrument_identifiers`
- **Purpose**: external identifier/alias mapping (ADR-002) — never the canonical PK.
- **PK**: `id uuid`. **Ownership**: shared (world-read).
- **Important columns**: `instrument_id`, `identifier_scheme` (check: `isin|amfi_scheme_code|nse_symbol|bse_code|sedol|internal_provisional`), `identifier_value`, `country_code`, `effective_from`/`effective_to`, `is_active`.
- **FKs**: `instrument_id → ii_instruments(id) on delete cascade`, `country_code → countries`.
- **Unique**: two **partial** unique indexes — `(identifier_scheme, identifier_value)` where scheme ∈ `{isin, sedol}` (globally unique); `(identifier_scheme, identifier_value, country_code)` where scheme ∈ `{amfi_scheme_code, nse_symbol, bse_code, internal_provisional}` (country-scoped). A `check` constraint additionally requires `country_code is not null` whenever the scheme is one of the four country-scoped ones.
- **Indexes**: `idx_ii_instrument_identifiers_instrument`, plus the two unique indexes above.
- **RLS**: world-read, admin/system-write.
- **Lifecycle**: mutable (`is_active`, `effective_to`).
- **Country applicability**: `country_code` generic FK; India-scoped rows are data (migration `0038`), not schema.
- **R2+ usage**: alias resolution for real parser output.

### `ii_benchmarks` / `ii_benchmark_series` / `ii_instrument_benchmarks`
- **Purpose**: reference-data **shape** only (ADR-010) — no benchmark content populated in R1.
- **PK**: `id uuid` each. **Ownership**: shared (world-read).
- `ii_benchmarks`: `benchmark_key` (unique), `benchmark_label`, `benchmark_category` (check: `index|category_average|custom`), `country_code`.
- `ii_benchmark_series`: `benchmark_id` FK (cascade), `series_date`, `value`; **unique** `(benchmark_id, series_date)` (also the lookup index).
- `ii_instrument_benchmarks`: `instrument_id` FK (cascade), `benchmark_id` FK (cascade), `relationship_type` (check: `primary|secondary|category_average`); **unique** `(instrument_id, benchmark_id, relationship_type)`.
- **RLS**: world-read, admin/system-write, all three.
- **R2+ usage**: real benchmark-comparison analytics (out of scope in R1).

### `ii_fund_holdings`
- **Purpose**: look-through data shape only — no X-ray analytics in R1.
- **PK**: `id uuid`. **Ownership**: shared (world-read).
- **Important columns**: `fund_instrument_id` FK (cascade), `underlying_instrument_id` FK (nullable — free-text `underlying_name` when unresolved), `disclosure_date`, `weight_pct` (0-100 check), `source_id`.
- **Unique**: `(fund_instrument_id, underlying_instrument_id, disclosure_date)`.
- **Indexes**: `idx_ii_fund_holdings_fund`.
- **RLS**: world-read, admin/system-write.
- **R2+ usage**: X-ray/look-through analytics.

### `ii_tax_rule_versions`
- **Purpose**: versioned reference-data shape only — no STCG/LTCG/exit-load rules populated in R1.
- **PK**: `id uuid`. **Ownership**: shared (world-read).
- **Important columns**: `rule_set_key`, `version`, `country_code` (not null), `rule_definition jsonb` (not null), `effective_from` (not null), `effective_to`.
- **Unique**: `(rule_set_key, version)`.
- **Indexes**: `idx_ii_tax_rule_versions_country`.
- **RLS**: world-read, admin/system-write.
- **R2+ usage**: future tax-analytics engine.

## Migration 0032 — provenance anchor + account foundation

### `ii_source_documents`
- **Purpose**: one row per uploaded/ingested evidence document — the root of the provenance chain. Immutable content: a revised statement is a **new** row, never an edit.
- **PK**: `id uuid`. **Ownership**: owner-only (`user_id not null`).
- **Important columns**: `owner_member_id` (nullable FK → `household_members`), `country_code` (not null), `source_id` (FK, nullable), `status` (check: `uploaded|parsing|parsed|parse_failed|superseded|archived`), `checksum`, `superseded_by_document_id` (self-FK), `storage_path` (not null, service-role-generated), `original_filename`, `mime_type`, `file_size`, `uploaded_at`, `document_type` (check enum), `statement_period_start`/`_end`, `statement_as_of_date`, `parser_version`, `parse_completed_at`, `parse_error`.
- **FKs**: `user_id → auth.users(id) on delete cascade`, `owner_member_id → household_members(id)`, `country_code → countries`, `source_id → ii_sources(id)`, `superseded_by_document_id → ii_source_documents(id)`.
- **Unique**: `(user_id, checksum)` where `checksum is not null` — re-upload detection.
- **Indexes**: `idx_ii_source_documents_user`, `idx_ii_source_documents_status`.
- **RLS**: owner-only.
- **Lifecycle**: `status` state machine `uploaded → parsing → parsed | parse_failed → [superseded] → [archived]`.
- **Country applicability**: `country_code` generic.
- **R2+ usage**: the real parser's evidence input.

### `ii_accounts`
- **Purpose**: the account/folio/demat container a holding sits inside.
- **PK**: `id uuid`. **Ownership**: owner-only.
- **Important columns**: `owner_member_id` (nullable FK — the OWNER-mapping gate), `country_code`/`currency_code` (both not null), `source_document_id` (nullable FK), `status` (check: `active|closed|archived`), `account_type` (check: `demat|mf_folio|broker|retirement|bank_linked|other`), `institution_name` (not null), `account_number_masked`, `folio_number`.
- **FKs**: `user_id`, `owner_member_id → household_members`, `country_code → countries`, `currency_code → currencies`, `source_document_id → ii_source_documents`.
- **Indexes**: `idx_ii_accounts_user`, `idx_ii_accounts_source_document`.
- **RLS**: owner-only.
- **Lifecycle**: `status`.
- **Country applicability**: generic core columns; `folio_number` deliberately kept as a nullable core column since it's common across countries' managed-fund concepts (not India-only per ADR-005's own reasoning).
- **R2+ usage**: real account matching/reconciliation against re-uploaded statements.

## Migration 0033 — transaction/tax-lot/holding structural foundation + NAV

### `ii_transactions`
- **Purpose**: canonical reconstructed transaction ledger. **Immutable** — corrections are new rows (`corrects_transaction_id`), never UPDATEs.
- **PK**: `id uuid`. **Ownership**: owner-only.
- **Important columns**: `account_id`/`instrument_id` (not null), `source_document_id` (nullable), `currency_code` (not null, never pre-converted), `status` (check: `parsed|reconciled|corrected|reversed`), `transaction_type` (check, 11 values), `transaction_date`, `units` (nullable — cash-only events), `price_per_unit`, `gross_amount` (not null), `corrects_transaction_id` (self-FK), `source_reference` (provider transaction reference — the R1-named de-dup column R0 explicitly deferred).
- **FKs**: `account_id → ii_accounts(id) on delete cascade`, `instrument_id → ii_instruments(id)`, `source_document_id → ii_source_documents(id)`, `currency_code → currencies`, `corrects_transaction_id → ii_transactions(id)`.
- **Unique**: `(account_id, source_document_id, source_reference)` where both are not null — idempotent re-parse de-dup.
- **Indexes**: `idx_ii_transactions_user`, `idx_ii_transactions_account_date` on `(account_id, transaction_date)`.
- **RLS**: owner-only.
- **Lifecycle**: immutable (`created_at` only).
- **R2+ usage**: real parser output target; XIRR/performance engine input.

### `ii_tax_lots`
- **Purpose**: lot-level acquisition record for cost basis — schema only, no tax calculation in R1.
- **PK**: `id uuid`. **Ownership**: owner-only.
- **Important columns**: `account_id`/`instrument_id` (not null), `opening_transaction_id` (FK), `status` (check: `open|partially_closed|closed`), `acquisition_date`, `units_acquired`/`units_remaining` (≥0 checks), `cost_per_unit` (≥0 check), `closed_at`.
- **Indexes**: `idx_ii_tax_lots_user`, `idx_ii_tax_lots_account_instrument`.
- **RLS**: owner-only.
- **R2+ usage**: `investments.cost_base` publishing field, future tax-lot-aware capital-gains logic.

### `ii_holding_snapshots`
- **Purpose**: point-in-time certified balance per account/instrument — the "current value" source of truth for publishing. **Immutable**, one row per `(account, instrument, as_of_date)`.
- **PK**: `id uuid`. **Ownership**: owner-only.
- **Important columns**: `account_id`/`instrument_id` (not null), `source_document_id` (nullable), `currency_code` (not null, source-country value), `quality_status` (check: `certified|warning|incomplete`), `as_of_date`, `units`, `value` (both not null).
- **Unique**: `(account_id, instrument_id, as_of_date)`.
- **Indexes**: `idx_ii_holding_snapshots_user`, `idx_ii_holding_snapshots_account_instrument_date` on `(account_id, instrument_id, as_of_date desc)` — the "latest snapshot" lookup.
- **RLS**: owner-only.
- **Lifecycle**: immutable.
- **R2+ usage**: direct input to `ii_fhip_publications`' CURRENT VALUE once real publishing is activated.

### `ii_prices_nav`
- **Purpose**: instrument-level price/NAV time series, decoupled from any one user's holdings. No AMFI feed populated in R1.
- **PK**: `id uuid`. **Ownership**: shared (world-read).
- **Important columns**: `instrument_id` (FK, cascade), `source_id` (FK), `currency_code` (not null), `price_date`, `price` (≥0 check).
- **Unique**: `(instrument_id, price_date)` (also the lookup index).
- **RLS**: world-read, admin/system-write.
- **R2+ usage**: valuation refresh without a new source document.

## Migration 0034 — FHIP publishing bridge + goal-allocation mirror

### `ii_fhip_publications`
- **Purpose**: records exactly which canonical position was published into which FHIP register row — the **only** entity with a direct FK relationship to existing FHIP tables (by design, one write path into FHIP). **R1: structural only — `published_row_id` is always `null`, no cross-register write ever happens.**
- **PK**: `id uuid`. **Ownership**: owner-only.
- **Important columns**: `canonical_position_id` (FK → `ii_holding_snapshots`, not null), `publication_target` (check: `assets|investments|retirement_accounts`), `published_row_id` (plain `uuid`, app-validated, never a single FK — same pattern as `goal_funding_sources`' three nullable linked-id columns), `status` (check: `published|unpublished|superseded`), `include_in_net_worth` (not null, default `true` — the ADR-004 dedup off-switch), `published_at`, `last_republished_at`.
- **Unique**: `canonical_position_id` — the ADR-004 database-level dedup guarantee: a refresh UPDATEs this row's linkage, never INSERTs a second publication for the same position.
- **Indexes**: `idx_ii_fhip_publications_user`, `idx_ii_fhip_publications_published_row`.
- **RLS**: owner-only.
- **R2+ usage**: activating the real `published_row_id` write into `assets`/`investments`/`retirement_accounts` is explicit R2+ scope.

### `ii_goal_allocations`
- **Purpose**: Investment-Intelligence-side mirror of `goal_funding_sources`, anchored to the **pre-publication** canonical position so allocation history survives a republish/relink.
- **PK**: `id uuid`. **Ownership**: owner-only.
- **Important columns**: `investment_position_id` (plain `uuid`, no hard FK — may point at an `ii_holding_snapshots.id` pre-publication or an `ii_fhip_publications.id` post-publication), `goal_id` (FK → `user_goals(id) on delete cascade` — the one enforced FK, since Goals remains canonical), `allocation_type` (check: `percentage|fixed_amount|residual`), `allocation_value` (nullable for `residual`), `source` (check: `user|system_suggested`), `status` (check: `active|superseded|removed`), `effective_from`/`effective_to`.
- **Indexes**: `idx_ii_goal_allocations_user`, `idx_ii_goal_allocations_goal`, `idx_ii_goal_allocations_position`.
- **RLS**: owner-only.
- **R2+ usage**: live write-through to `goal_funding_sources.linked_investment_id` once real publishing exists (R1 only performs this sync when a caller already supplies a real `linked_investment_id` — see `lib/services/investment-intelligence/goalAllocations.ts`).

## Migration 0035 — analytics/insights/reconciliation

### `ii_analytics_results`
- **Purpose**: deterministic, versioned computed metric result storage shape — no analytics engine in R1.
- **PK**: `id uuid`. **Ownership**: owner-only.
- **Important columns**: `subject_type` (check: `position|account|portfolio`), `subject_id` (plain `uuid`, polymorphic, no hard FK), `metric_key`, `metric_value`, `calculation_version` (not null), `calculated_at`, `input_snapshot jsonb`.
- **Indexes**: `idx_ii_analytics_results_user`, `idx_ii_analytics_results_subject`.
- **RLS**: owner-only. **Lifecycle**: immutable.
- **R2+ usage**: the real analytics engine's write target.

### `ii_insights`
- **Purpose**: generated, classified insight rows with a **structural** advice gate (ADR-007).
- **PK**: `id uuid`. **Ownership**: owner-only.
- **Important columns**: `classification` (check: `observation|education|simulation|personalised_advice`), `rule_code`/`rule_version` (not null), `severity` (check enum), `evidence jsonb`, `status` (check: `active|dismissed|superseded|expired`), `gated` (not null, default `true`), `compliance_approved_at`.
- **Constraint**: `chk_ii_insights_advice_gated` — `classification <> 'personalised_advice' or gated = true`, making it **impossible** to insert an ungated advice row at the database level. `lib/services/investment-intelligence/insights.ts`'s `filterConsumerVisibleInsights()` is the second, independent enforcement layer at read time.
- **Indexes**: `idx_ii_insights_user`.
- **RLS**: owner-only.
- **R2+ usage**: the real insight-generation rule engine's write target.

### `ii_reconciliation_cases`
- **Purpose**: tracks a detected mismatch through to resolution.
- **PK**: `id uuid`. **Ownership**: owner-only.
- **Important columns**: `subject_type` (check: `holding_snapshot|transaction|account`), `subject_id` (polymorphic), `status` (check: `open|user_reviewing|resolved|dismissed`), `discrepancy_type`, `discrepancy_details jsonb`, `opened_at`, `resolved_at`.
- **Indexes**: `idx_ii_reconciliation_cases_user`.
- **RLS**: owner-only.
- **R2+ usage**: real discrepancy-detection logic opens these automatically; R1's manual importer opens them only when a fixture explicitly declares a `reconciliation` block.

## Migration 0036 — audit

### `ii_audit_events`
- **Purpose**: append-only audit log for every Investment-Intelligence lifecycle event.
- **PK**: `id uuid`. **Ownership**: owner-read-only (`user_id` **nullable** — system events own no specific user).
- **Important columns**: `event_type` (check, 19 values — every type `R0_AUDIT_REQUIREMENTS.md` section 2 names, minus `parser_version` which is a field, not an event), `subject_type`/`subject_id`, `actor_type` (check: `user|admin|system|professional`), `actor_id`, `metadata jsonb`.
- **FKs**: `user_id → auth.users(id) on delete set null` (deliberately not `cascade` — audit should outlive the deleted account where feasible).
- **Indexes**: `idx_ii_audit_events_user` (partial, `where user_id is not null`), `idx_ii_audit_events_subject`, `idx_ii_audit_events_event_type`.
- **RLS**: `for select using (auth.uid() = user_id)` **only** — no insert/update/delete policy for any authenticated role. Every insert happens through `lib/services/investment-intelligence/audit.ts`'s `emitAuditEvent()`, using the service-role client.
- **Lifecycle**: immutable, append-only.
- **R2+ usage**: unchanged — this is the permanent audit sink for every future release's Investment Intelligence event.

## Migration 0037 — storage policy

`storage.objects` gets one additional `for select` policy scoped to `bucket_id = 'investment-source-documents'` and `(storage.foldername(name))[1] = auth.uid()::text` — the owner-only read policy, identical in shape to the existing `report-exports` bucket's policy. No insert/update/delete policy for the authenticated role — all writes are service-role-only, after an explicit authenticated + ownership check in the API route (`app/api/investment-intelligence/source-documents/route.ts`).

## Migration 0038 — India adapter seed

Data only, no schema. 8 `ii_sources` rows, 5 `ii_instruments` fixture rows (clearly `status='provisional'`, not verified master data), and their `ii_instrument_identifiers` (`TESTFIX-` prefixed, explicitly non-authoritative). See migration file comments for the full reasoning, including why NPS is seeded with `instrument_class='other'` rather than a dedicated retirement value.

## Country applicability summary (ADR-005 test)

Every `ii_*` table's `country_code`/`currency_code` columns are generic `char(2)`/`char(3)` FKs into the existing `countries`/`currencies` tables — never an `IN`-only or `INR`-only check constraint anywhere in migrations `0031`-`0038`. `countries`/`currencies` already carry both `IN`/`INR` and `AU`/`AUD` (pre-existing, migration `0001`). See `IN-006` in `R1_TESTING_AND_VERIFICATION.md` for the live-verified half of this claim and the honestly-flagged blocked half (row-level insertion proof, pending migration application).
