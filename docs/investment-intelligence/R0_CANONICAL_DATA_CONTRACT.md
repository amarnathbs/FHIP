# R0 — Canonical Data Contract

Status: FINAL (R0) — architectural baseline only. **No migration exists or is created by this document.**
Depends on: `R0_CURRENT_STATE_DISCOVERY.md`, `R0_DOMAIN_ARCHITECTURE.md`

## 0. Naming decision

The spec's proposed `ii_*` prefix is **adopted as-is**. Rationale: every existing FHIP module uses a bare, module-specific prefix with no shared namespace (`forecast_*`, `resilience_*`, `goal_*`, `benchmark_*`, `financial_dna_*`, `financial_twin_*` — see `R0_CURRENT_STATE_DISCOVERY.md` section 2). Investment Intelligence is architecturally larger and more cross-cutting than any existing module (21 proposed entities vs. 5–12 for existing modules) and will eventually need to distinguish its own tables at a glance from the country-neutral vs. country-adapter split described in `R0_DOMAIN_ARCHITECTURE.md`. `ii_` is short, greppable, and does not collide with any existing table name found in `supabase/migrations/`. No name in the spec's proposed list is changed.

## 1. Cross-cutting conventions (apply to every entity below unless noted)

- **Primary key strategy**: `id uuid primary key default gen_random_uuid()` — identical to every existing FHIP table (`R0_CURRENT_STATE_DISCOVERY.md` section 2). No entity uses a natural/source key as its primary key (see `R0_CANONICAL_IDENTIFIER_STRATEGY.md` — source-provider identifiers are never primary keys).
- **Household/user relationship**: every entity carries `user_id uuid not null references auth.users(id) on delete cascade`, matching the existing owner-only RLS pattern exactly (`R0_CURRENT_STATE_DISCOVERY.md` section 10). No entity introduces a household-level (multi-user) ownership model — that does not exist anywhere in FHIP today and is out of scope for R0/R1 (see `R0_SECURITY_RLS_ARCHITECTURE.md`).
- **Owner relationship**: entities that represent a specific holding/position additionally carry an optional `owner_member_id uuid references household_members(id)` — reusing the exact table Goals already uses (`R0_CURRENT_STATE_DISCOVERY.md` section 6), not a new owner enum.
- **Country/currency**: `country_code char(2) references countries(country_code)` and `currency_code char(3) references currencies(currency_code)` on every entity that represents money or a jurisdiction-specific concept — reusing the existing `countries`/`currencies` reference tables (currently seeded `AU`/`IN`, `AUD`/`INR` only).
- **Created/updated/version fields**: `created_at timestamptz default now()`, `updated_at timestamptz default now()` on mutable entities. Immutable/append-only entities (transactions, snapshots, analytics results, audit events) use `created_at` only, matching the existing `goal_forecasts`/`goal_snapshots`/`forecast_results` immutable-row convention.
- **Source/provenance relationship**: every entity that can originate from an import carries `source_document_id uuid references ii_source_documents(id)` (nullable — manual entities have no source document) — see `R0_SOURCE_PROVENANCE_CONTRACT.md`.
- **Lifecycle/status**: entities that can be superseded or corrected carry a `status` column with an explicit `check` constraint (following the existing `user_goals.status` pattern) rather than a boolean `is_active` alone, wherever more than "active/archived" states are meaningful.
- **RLS**: owner-only (`auth.uid() = user_id`) on every user-owned entity, identical to the existing pattern — **no entity relies on client-side filtering** (`R0_SECURITY_RLS_ARCHITECTURE.md`). Reference-data entities (`ii_benchmarks`, `ii_tax_rule_versions`) are world-readable, admin-write-only, reusing the existing `admin_users`/`requireAdmin()` pattern.
- **Audit requirements**: every mutation-worthy lifecycle transition on every entity below must emit an `ii_audit_events` row per `R0_AUDIT_REQUIREMENTS.md` — not repeated per-entity below to avoid redundancy, but understood as universal.
- **Relationship with current FHIP tables**: only `ii_fhip_publications` (see below) has a direct FK relationship to `assets`/`investments`/`retirement_accounts`. Every other entity is fully contained within the Investment Intelligence schema — this is deliberate (`R0_DOMAIN_ARCHITECTURE.md` section 5: exactly one write path into the rest of FHIP).

## 2. Entity-by-entity specification

### `ii_sources`
**Purpose**: Catalogue of source *types* Investment Intelligence can ingest from (CAMS, KFintech, NSDL, CDSL, broker-X, manual, admin-correction, future API connector) — a reference/config table, not a per-upload record.
**PK strategy**: `id uuid`. **Household/user**: none — world-readable reference data (admin-write, mirrors `master_financial_items`/`goal_types`). **Owner**: n/a. **Country**: `country_code` nullable (e.g. `manual`/`admin_correction` are country-neutral; `CAMS`/`KFintech`/`NSDL`/`CDSL` are India-specific rows contributed by the India adapter). **Currency**: n/a. **Created/updated**: `created_at` only (rarely changes). **Provenance**: n/a (this table *is* the provenance vocabulary). **Lifecycle**: `is_active boolean`. **Required**: `source_key` (unique), `source_label`, `source_category` (`statement_provider|broker|manual|admin|api_connector`). **RLS**: world-readable. **Audit**: admin changes only, via `ii_audit_events`. **FHIP relationship**: none.

### `ii_source_documents`
**Purpose**: One row per uploaded/ingested evidence document (a CAS PDF, a broker contract note, a manual-entry event record). The root of the provenance chain (`R0_SOURCE_PROVENANCE_CONTRACT.md`).
**PK**: `id uuid`. **User**: `user_id`. **Owner**: `owner_member_id` nullable (the statement may cover a member not yet confirmed). **Country/currency**: `country_code` required (source jurisdiction). **Timestamps**: `created_at`, `updated_at`. **Provenance**: `source_id references ii_sources(id)`; this table is itself the provenance anchor for everything downstream. **Lifecycle/status**: `status` (`uploaded|parsing|parsed|parse_failed|superseded|archived`), `checksum` (to detect a re-upload of the identical file), `superseded_by_document_id` (self-FK — a refreshed statement never overwrites the prior one; see scenario 11 in `R0_NET_WORTH_DEDUP_CONTRACT.md`). **Required**: `storage_path` (private bucket, service-role-only write, signed-URL read — reusing the `report-exports` precedent, `R0_CURRENT_STATE_DISCOVERY.md` section 9), `original_filename`, `uploaded_at`. **Optional**: `parser_version`, `parse_completed_at`, `parse_error`. **RLS**: owner-only. **Audit**: upload/parse events. **FHIP relationship**: none directly — everything downstream traces back here.

### `ii_accounts`
**Purpose**: The account/folio/demat container a holding sits inside.
**PK**: `id uuid`. **User**: `user_id`. **Owner**: `owner_member_id` (once mapped; nullable until confirmed — see `R0_FHIP_PUBLISHING_CONTRACT.md` OWNER blocking rule). **Country/currency**: both required. **Timestamps**: standard. **Provenance**: `source_document_id` nullable (an account can be manually declared before any statement is uploaded). **Lifecycle**: `status` (`active|closed|archived`). **Required**: `account_type` (`demat|mf_folio|broker|retirement|bank_linked|other`), `institution_name`. **Optional**: `account_number_masked` (never store the full unmasked number in the core row — see `R0_SECURITY_RLS_ARCHITECTURE.md`), `folio_number` (India adapter attribute, kept in a nullable core column since "folio" is common enough across countries' managed-fund concepts to justify a core column rather than adapter-only; account-*number* formats stay adapter-side parsing concerns, not schema). **RLS**: owner-only. **FHIP relationship**: none directly (positions publish, not accounts).

### `ii_instruments`
**Purpose**: Country-neutral instrument master (a specific security/fund/scheme).
**PK**: `id uuid`. **User**: none — this is shared reference data across all users (an ISIN is the same instrument for everyone), **not** user-owned. **Owner**: n/a. **Country**: `country_of_domicile` required. **Currency**: `base_currency` required. **Timestamps**: standard, plus `is_active`. **Provenance**: `source_id references ii_sources(id)` nullable (an instrument may be first observed from a user's own statement before it exists in any master feed — see `R0_CANONICAL_IDENTIFIER_STRATEGY.md` on provisional instruments). **Lifecycle**: `status` (`provisional|verified|deprecated|merged`) — a provisional instrument created from one user's statement can later be merged into a verified master record without breaking the FK from existing `ii_transactions`/`ii_holding_snapshots` rows (merge target tracked via `merged_into_instrument_id`). **Required**: `instrument_name`, `instrument_class` (`equity|mutual_fund|etf|bond|fixed_deposit|gold|crypto|cash|other`). **Optional**: `isin`. **RLS**: world-readable (shared master), admin/system-write. **Audit**: creation/merge events. **FHIP relationship**: none directly.

### `ii_instrument_identifiers`
**Purpose**: External identifier/alias mapping, kept **separate from** the canonical instrument PK per spec Section 7 — an AMFI scheme code, a BSE/NSE symbol, a CUSIP, are all aliases onto one `ii_instruments.id`, never the identifier itself.
**PK**: `id uuid`. **User**: none (shared). **Country**: `country_code` (the jurisdiction the identifier scheme belongs to). **Timestamps**: standard. **Required**: `instrument_id references ii_instruments(id)`, `identifier_scheme` (`isin|amfi_scheme_code|nse_symbol|bse_code|sedol|internal_provisional`), `identifier_value`, `unique(identifier_scheme, identifier_value)` scoped per scheme where the scheme is globally unique (ISIN), or `unique(identifier_scheme, identifier_value, country_code)` where it is country-scoped (AMFI codes). **RLS**: world-readable. **FHIP relationship**: none.

### `ii_transactions`
**Purpose**: Canonical reconstructed transaction ledger (buy/sell/switch-in/switch-out/dividend/SIP-instalment/redemption/fee).
**PK**: `id uuid`. **User**: `user_id`. **Owner**: inherited via `account_id`. **Country/currency**: `currency_code` required (transaction's own currency — never pre-converted; see `R0_CROSS_BORDER_CONTRACT.md`). **Timestamps**: `created_at` only — **immutable**; a correction is a new row referencing the original (`corrects_transaction_id`), never an UPDATE, matching the existing `goal_contributions.reversal_of_id` precedent (`R0_CURRENT_STATE_DISCOVERY.md` section 6). **Provenance**: `source_document_id` required for imported rows, nullable for manual. **Lifecycle**: `status` (`parsed|reconciled|corrected|reversed`). **Required**: `account_id references ii_accounts(id)`, `instrument_id references ii_instruments(id)`, `transaction_type`, `transaction_date`, `units` (nullable for cash-only events), `price_per_unit` (nullable), `gross_amount`. **RLS**: owner-only via account ownership. **FHIP relationship**: none directly — feeds `ii_holding_snapshots`/`ii_tax_lots`.

### `ii_tax_lots`
**Purpose**: Lot-level acquisition record for cost-basis and future tax analytics (schema only — no tax *calculation* in R0/R1 per non-goals).
**PK**: `id uuid`. **User**: `user_id`. **Owner**: inherited via `account_id`. **Country/currency**: inherited. **Timestamps**: `created_at`; `closed_at` when fully disposed. **Provenance**: `opening_transaction_id references ii_transactions(id)`. **Lifecycle**: `status` (`open|partially_closed|closed`). **Required**: `account_id`, `instrument_id`, `acquisition_date`, `units_acquired`, `units_remaining`, `cost_per_unit`. **RLS**: owner-only. **FHIP relationship**: feeds the `investments.cost_base` publishing field (confidence-flagged when incomplete — see `R0_FHIP_PUBLISHING_CONTRACT.md` COST BASE).

### `ii_holding_snapshots`
**Purpose**: Point-in-time certified balance per account/instrument — the "current value" source of truth for publishing.
**PK**: `id uuid`. **User**: `user_id`. **Owner**: inherited via `account_id`. **Country/currency**: `currency_code` required (source-country value, never pre-converted). **Timestamps**: `created_at` only — immutable, one row per (account, instrument, as-of date); a newer valuation is a new row, never an update, so historical net worth is reconstructible. **Provenance**: `source_document_id` nullable (can also be derived by replaying `ii_transactions`). **Lifecycle**: `quality_status` (`certified|warning|incomplete`) — directly feeds the publishing CURRENT VALUE quality field. **Required**: `account_id`, `instrument_id`, `as_of_date`, `units`, `value`. **RLS**: owner-only. **FHIP relationship**: the direct input to `ii_fhip_publications`' CURRENT VALUE.

### `ii_prices_nav`
**Purpose**: Instrument-level price/NAV time series, decoupled from any one user's holdings.
**PK**: `id uuid`. **User**: none (shared reference data). **Country/currency**: `currency_code` required. **Timestamps**: `created_at`; `unique(instrument_id, price_date)`. **Provenance**: `source_id`. **Required**: `instrument_id`, `price_date`, `price`. **RLS**: world-readable, admin/system-write. **FHIP relationship**: none directly — used to independently value a holding when a fresh statement hasn't arrived (a "valuation refresh" without a new source document).

### `ii_benchmarks`
**Purpose**: Named benchmark definitions (Nifty 50, Sensex, a category-average benchmark) — mirrors the existing `benchmark_datasets`/`benchmark_sources` pattern from Module 8 (`R0_CURRENT_STATE_DISCOVERY.md` section 2) rather than reinventing it; Investment Intelligence's benchmark entities are a sibling of, not a replacement for, the existing Financial Twin benchmark infrastructure.
**PK**: `id uuid`. **User**: none (shared). **Country**: `country_code`. **Timestamps**: standard. **Required**: `benchmark_key`, `benchmark_label`, `benchmark_category` (`index|category_average|custom`). **RLS**: world-readable, admin-write. **FHIP relationship**: none.

### `ii_benchmark_series`
**Purpose**: Time series of values for one `ii_benchmarks` row.
**PK**: `id uuid`. **User**: none. **Timestamps**: `created_at`; `unique(benchmark_id, series_date)`. **Required**: `benchmark_id`, `series_date`, `value`. **RLS**: world-readable, admin-write. **FHIP relationship**: none.

### `ii_instrument_benchmarks`
**Purpose**: Declares which benchmark(s) an instrument should be compared against (a fund's stated benchmark, or a user-facing default).
**PK**: `id uuid`. **User**: none (shared reference mapping, editable by admin). **Timestamps**: standard. **Required**: `instrument_id`, `benchmark_id`, `relationship_type` (`primary|secondary|category_average`). **RLS**: world-readable, admin-write. **FHIP relationship**: none.

### `ii_fund_holdings`
**Purpose**: Look-through data — the underlying constituent holdings of a fund/ETF instrument, for future X-ray analytics (schema only; **no X-ray analytics built in R0/R1** per non-goals).
**PK**: `id uuid`. **User**: none (shared reference data per fund, sourced from AMC disclosures, not per-user). **Timestamps**: `created_at`; `unique(fund_instrument_id, underlying_instrument_id, disclosure_date)`. **Provenance**: `source_id`. **Required**: `fund_instrument_id references ii_instruments(id)`, `underlying_instrument_id references ii_instruments(id)` (nullable when the underlying can't be resolved to a known instrument — stored as free text `underlying_name` instead), `disclosure_date`, `weight_pct`. **RLS**: world-readable, admin/system-write. **FHIP relationship**: none.

### `ii_analytics_results`
**Purpose**: Deterministic, versioned computed metric results (concentration score, SIP consistency, performance vs. benchmark — **no analytics engine built in R0/R1**, this is the storage shape only).
**PK**: `id uuid`. **User**: `user_id`. **Owner**: inherited via subject entity. **Timestamps**: `created_at` only — immutable, one row per calculation run (mirrors `forecast_results`/`goal_forecasts`). **Provenance**: `input_snapshot jsonb` capturing exactly what was computed over, same pattern as `goal_forecasts.input_snapshot`. **Lifecycle**: n/a (immutable; latest-per-subject read pattern, same as `goal_forecasts`). **Required**: `subject_type` (`position|account|portfolio`), `subject_id`, `metric_key`, `metric_value`, `calculation_version`, `calculated_at`. **RLS**: owner-only. **FHIP relationship**: none directly — may feed future Insights and, later, investment-specific Forecasting *inputs* (never a competing forecast — `R0_FORECASTING_CONTRACT.md`).

### `ii_insights`
**Purpose**: Generated, classified insight rows (`R0_INSIGHT_CLASSIFICATION.md`).
**PK**: `id uuid`. **User**: `user_id`. **Timestamps**: `created_at`. **Provenance**: `evidence jsonb` (the analytics results / raw data the insight cites). **Lifecycle**: `status` (`active|dismissed|superseded|expired`). **Required**: `classification` (`observation|education|simulation|personalised_advice`), `rule_code`, `rule_version`, `severity`, `created_at`. **Gating**: `classification = 'personalised_advice'` rows must additionally carry `gated boolean not null default true` and a `compliance_approved_at` that must be non-null before such a row may ever be surfaced (enforced at the service layer, not just documented — R1 requirement). **RLS**: owner-only. **FHIP relationship**: none directly (surfaces in Investment Intelligence UI, not in existing FHIP screens).

### `ii_goal_allocations`
**Purpose**: The Investment-Intelligence-specific mirror of the existing `goal_funding_sources` mechanism — links one canonical published position to one or more FHIP goals. **Not a replacement for `goal_funding_sources`**; see `R0_GOAL_INTEGRATION_CONTRACT.md` for exactly how these two relate (the publishing layer keeps a `goal_funding_sources.linked_investment_id` row in sync, this table is Investment-Intelligence's own record of the same fact, keyed to the pre-publication canonical position rather than the post-publication `investments.id`, so history survives republication).
**PK**: `id uuid`. **User**: `user_id`. **Timestamps**: `created_at`, `updated_at`. **Lifecycle**: `status` (`active|superseded|removed`), `effective_from`, `effective_to` (nullable = current). **Required**: `investment_position_id` (the canonical `ii_holding_snapshots`-derived position, or `ii_fhip_publications.id` — see `R0_GOAL_INTEGRATION_CONTRACT.md`), `goal_id references user_goals(id)`, `allocation_type` (`percentage|fixed_amount|residual`), `allocation_value`, `source` (`user|system_suggested`). **RLS**: owner-only. **FHIP relationship**: `goal_id` is a direct FK into the existing `user_goals` table — Goals remains canonical (design principle 10).

### `ii_fhip_publications`
**Purpose**: The record of exactly which canonical Investment Intelligence position was published into which `investments`/`assets`/`retirement_accounts` row — the single mechanism preventing double counting (`R0_NET_WORTH_DEDUP_CONTRACT.md`). This is the **only** entity with a direct FK to existing FHIP register tables.
**PK**: `id uuid`. **User**: `user_id`. **Timestamps**: `published_at`, `last_republished_at`. **Lifecycle**: `status` (`published|unpublished|superseded`), `include_in_net_worth boolean not null default true` (the explicit, auditable dedup switch — see `ADR-004`). **Required**: `canonical_position_id` (references the `ii_holding_snapshots` this publication represents), `publication_target` (`assets|investments|retirement_accounts`), `published_row_id` (the actual `assets.id`/`investments.id`/`retirement_accounts.id` — a plain `uuid` column, not a single FK, since it points at one of three different tables; enforced at the application layer, same pattern as `goal_funding_sources.linked_asset_id`/`linked_investment_id`/`linked_retirement_id` being three separate nullable FK columns rather than one polymorphic column). **RLS**: owner-only. **FHIP relationship**: this is the bridge itself.

### `ii_reconciliation_cases`
**Purpose**: Tracks a detected mismatch (e.g. a refreshed statement disagrees with the previously certified holding) through to resolution — the layered-correction concept from spec Section 14.
**PK**: `id uuid`. **User**: `user_id`. **Timestamps**: `opened_at`, `resolved_at`. **Lifecycle**: `status` (`open|user_reviewing|resolved|dismissed`). **Required**: `subject_type` (`holding_snapshot|transaction|account`), `subject_id`, `discrepancy_type`, `discrepancy_details jsonb`. **RLS**: owner-only. **FHIP relationship**: none directly — a case must resolve (producing a new certified `ii_holding_snapshots` row) before republication.

### `ii_tax_rule_versions`
**Purpose**: Versioned reference data for future tax-analytics rule sets (STCG/LTCG bands, exit-load schedules) — **schema shape only, no rules populated or applied in R0/R1**.
**PK**: `id uuid`. **User**: none (shared reference). **Country**: `country_code` required. **Timestamps**: `effective_from`, `effective_to`. **Required**: `rule_set_key`, `version`, `rule_definition jsonb`. **RLS**: world-readable, admin-write. **FHIP relationship**: none.

### `ii_audit_events`
**Purpose**: Append-only audit log for every Investment-Intelligence lifecycle event listed in `R0_AUDIT_REQUIREMENTS.md`.
**PK**: `id uuid`. **User**: `user_id` nullable (system-initiated events, e.g. a scheduled NAV refresh, have no acting user). **Timestamps**: `created_at` only — immutable. **Required**: `event_type`, `subject_type`, `subject_id`, `actor_type` (`user|admin|system|professional`), `actor_id` nullable, `metadata jsonb`. **RLS**: owner-only `select` (never `update`/`delete` — enforced by omitting those operations from the policy, mirroring `audit_events`' existing `for select using (...)`-only policy, `R0_CURRENT_STATE_DISCOVERY.md` section 2). **FHIP relationship**: none directly, but this table is what makes every other entity's audit requirement real rather than aspirational — see `ADR-008` on why the existing dead `audit_events`/`financial_records_audit` tables are not simply reused as-is.

## 3. Summary table

| Entity | User-owned? | Immutable? | RLS | Direct FHIP FK |
|---|---|---|---|---|
| `ii_sources` | no (reference) | rare updates | world-read/admin-write | no |
| `ii_source_documents` | yes | append+status | owner-only | no |
| `ii_accounts` | yes | mutable | owner-only | no |
| `ii_instruments` | no (shared) | status-transitioned | world-read/admin-write | no |
| `ii_instrument_identifiers` | no (shared) | mutable | world-read | no |
| `ii_transactions` | yes | **immutable** | owner-only | no |
| `ii_tax_lots` | yes | mutable (lot depletion) | owner-only | no |
| `ii_holding_snapshots` | yes | **immutable** | owner-only | no |
| `ii_prices_nav` | no (shared) | append | world-read/admin-write | no |
| `ii_benchmarks` | no (shared) | rare updates | world-read/admin-write | no |
| `ii_benchmark_series` | no (shared) | append | world-read/admin-write | no |
| `ii_instrument_benchmarks` | no (shared) | mutable | world-read/admin-write | no |
| `ii_fund_holdings` | no (shared) | append | world-read/admin-write | no |
| `ii_analytics_results` | yes | **immutable** | owner-only | no |
| `ii_insights` | yes | status-transitioned | owner-only | no |
| `ii_goal_allocations` | yes | effective-dated | owner-only | **yes** (`goal_id → user_goals`) |
| `ii_fhip_publications` | yes | status-transitioned | owner-only | **yes** (`published_row_id → assets/investments/retirement_accounts`) |
| `ii_reconciliation_cases` | yes | status-transitioned | owner-only | no |
| `ii_tax_rule_versions` | no (reference) | effective-dated | world-read/admin-write | no |
| `ii_audit_events` | yes (nullable) | **immutable** | owner-read-only | no |

Only two entities (`ii_goal_allocations`, `ii_fhip_publications`) have a direct foreign key into an existing FHIP table — confirming the domain-architecture claim that Investment Intelligence has exactly one write path into the rest of FHIP.
