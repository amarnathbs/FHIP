/**
 * Financial Data Hub — the complete list of tables this module owns.
 *
 * Used by the repository layer (so no FDH query can name a table outside the
 * module by accident) and by `tests/unit/fdh1SchemaContract.test.ts`, which
 * asserts that the migrations create exactly this set, that each user-owned
 * table has RLS enabled and an owner-only policy, and that no table outside
 * this set is touched by any FDH migration.
 */

/**
 * Shared reference/master data created by FDH-1 (migration 0045). No
 * `user_id`. Read-only through RLS. FROZEN — `tests/unit/fdh1SchemaContract
 * .test.ts` scopes its "creates exactly this set" / "RLS enabled" / "read-only
 * policy" assertions to migrations 0045-0048 only, so this list must stay
 * exactly what FDH-1 shipped. FDH-2's own additions live in
 * `FDH2_MASTER_DATA_TABLES_ADDED` below and are checked by
 * `tests/unit/fdh2SchemaContract.test.ts` against migrations 0050-0056.
 */
export const FDH1_MASTER_DATA_TABLES = [
  'fdh_source_types',
  'fdh_financial_institutions',
  'fdh_categories',
  'fdh_subcategories',
  'fdh_merchants',
  'fdh_merchant_aliases',
  'fdh_classification_rules',
  'fdh_parser_registry',
  'fdh_parser_versions',
] as const;

/** New master-data tables FDH-2 creates (migrations 0050-0052). All
 * `for select using (true)`, no write policy. */
export const FDH2_MASTER_DATA_TABLES_ADDED = [
  'fdh_source_registry',
  'fdh_economic_transaction_types',
  'fdh_mcc_master',
  'fdh_mcc_category_map',
  'fdh_institution_capabilities',
  'fdh_institution_aliases',
  'fdh_payment_rail_master',
] as const;

/** The complete current master-data table set (FDH-1 + FDH-2). Used by the
 * repository layer's allow-list; NOT used by fdh1SchemaContract.test.ts,
 * which is intentionally frozen to FDH1_MASTER_DATA_TABLES — see above. */
export const FDH_MASTER_DATA_TABLES = [
  ...FDH1_MASTER_DATA_TABLES,
  ...FDH2_MASTER_DATA_TABLES_ADDED,
] as const;
export type FdhMasterDataTable = (typeof FDH_MASTER_DATA_TABLES)[number];

/**
 * FDH-2 addition. MORE restricted than FDH_MASTER_DATA_TABLES: these tables
 * have RLS enabled but carry NO policy of any kind for anon/authenticated —
 * only the service role (which bypasses RLS) can read or write them. Pending
 * governance-workflow data is not settled public reference data — see
 * migration 0052_fdh2_merchant_and_governance_foundation.sql.
 */
export const FDH_ADMIN_ONLY_TABLES = ['fdh_global_learning_candidates'] as const;
export type FdhAdminOnlyTable = (typeof FDH_ADMIN_ONLY_TABLES)[number];

/** FROZEN — household financial data as FDH-1 shipped it (migrations
 * 0045-0048). Every one carries `user_id` and owner-only RLS. Used by
 * `tests/unit/fdh1SchemaContract.test.ts` and
 * `tests/unit/fdh2SchemaContract.test.ts`, both correctly scoped to migrations
 * that predate FDH-3 — this list must stay exactly what FDH-1 shipped. FDH-3's
 * own additions live in `FDH3_USER_OWNED_TABLES_ADDED` below. */
export const FDH_USER_OWNED_TABLES = [
  'fdh_financial_accounts',
  'fdh_statement_uploads',
  'fdh_ingestion_jobs',
  'fdh_transactions',
  'fdh_transaction_allocations',
  'fdh_transaction_links',
  'fdh_duplicate_candidates',
  'fdh_user_classification_rules',
  'fdh_classification_history',
  'fdh_recurring_transactions',
  'fdh_review_items',
  'fdh_reconciliation_results',
  'fdh_data_quality_results',
  'fdh_data_provenance',
  'fdh_evidence_links',
] as const;
export type FdhUserOwnedTable = (typeof FDH_USER_OWNED_TABLES)[number];

/**
 * New user-scoped tables FDH-3 creates (migration 0058). Both carry `user_id`
 * and owner-scoped RLS, but `fdh_document_audit_events` is MORE restricted
 * than the generic user-owned shape: owner SELECT only, no user-facing
 * INSERT/UPDATE/DELETE policy at all — every insert happens through the
 * service-role client from `lib/financial-data-hub/services/auditLog.ts`
 * (same precedent as `ii_audit_events`). It therefore gets a bespoke
 * repository in `repositories/index.ts` rather than
 * `makeUserOwnedRepository`, and is tracked separately from
 * `FDH_APPEND_ONLY_TABLES` (append-only there still means user-insertable).
 */
export const FDH3_USER_OWNED_TABLES_ADDED = ['fdh_upload_sessions'] as const;
export const FDH3_SERVICE_ROLE_INSERT_ONLY_TABLES = ['fdh_document_audit_events'] as const;

/**
 * New user-scoped tables R7 creates (migration 0064). Both are ordinary
 * owner-scoped `for all` tables — no service-role carve-out needed, unlike
 * FDH-3's audit/session tables.
 */
export const R7_USER_OWNED_TABLES_ADDED = [
  'fdh_csv_mapping_templates',
  'fdh_transaction_corrections',
] as const;

/**
 * New user-scoped table FDH-7 creates (migration 0076). Ordinary owner-scoped
 * `for all` table — no service-role carve-out needed. See
 * FDH7_APPROVED_FINANCIAL_SUMMARY.md.
 */
export const FDH7_USER_OWNED_TABLES_ADDED = ['fdh_approved_financial_summaries'] as const;

/** The complete current user-owned table set (FDH-1 + FDH-3 + R7 + FDH-7).
 * Used by the repository layer and by any FDH-3/R7/FDH-7-scoped test; NOT
 * used by the frozen FDH-1/FDH-2 schema-contract tests above. */
export const FDH_ALL_USER_OWNED_TABLES = [
  ...FDH_USER_OWNED_TABLES,
  ...FDH3_USER_OWNED_TABLES_ADDED,
  ...FDH3_SERVICE_ROLE_INSERT_ONLY_TABLES,
  ...R7_USER_OWNED_TABLES_ADDED,
  ...FDH7_USER_OWNED_TABLES_ADDED,
] as const;
export type FdhAllUserOwnedTable = (typeof FDH_ALL_USER_OWNED_TABLES)[number];

/** FROZEN — the complete table set FDH-1 shipped (migrations 0045-0048).
 * Used only by fdh1SchemaContract.test.ts's "creates exactly this set" and
 * "RLS enabled on every table" checks, which are correctly scoped to those
 * four files only. */
export const FDH1_TABLES = [...FDH1_MASTER_DATA_TABLES, ...FDH_USER_OWNED_TABLES] as const;

export const FDH_TABLES = [
  ...FDH_MASTER_DATA_TABLES,
  ...FDH_USER_OWNED_TABLES,
  ...FDH_ADMIN_ONLY_TABLES,
  ...FDH3_USER_OWNED_TABLES_ADDED,
  ...FDH3_SERVICE_ROLE_INSERT_ONLY_TABLES,
  ...R7_USER_OWNED_TABLES_ADDED,
  ...FDH7_USER_OWNED_TABLES_ADDED,
] as const;
export type FdhTable = (typeof FDH_TABLES)[number];

/**
 * The one user-owned FDH table that is append-only: SELECT + INSERT policies
 * only, no UPDATE and no DELETE policy, so a user cannot rewrite their own
 * classification audit trail.
 */
export const FDH_APPEND_ONLY_TABLES = ['fdh_classification_history'] as const;

/**
 * Existing FHIP tables the Financial Data Hub must NEVER write to in any
 * phase before FDH-15 (the Input Data Bridge). Asserted by
 * `tests/unit/fdh1Isolation.test.ts`, which greps the whole FDH source tree
 * for any of these names.
 */
export const FHIP_PROTECTED_INPUT_TABLES = [
  'income_sources',
  'expense_items',
  'assets',
  'liabilities',
  'investments',
  'retirement_accounts',
  'insurance_policies',
] as const;

/**
 * Canonical Investment Intelligence entities. Product Owner Decision 2:
 * Investment Intelligence owns the canonical investment ledger; the Financial
 * Data Hub owns investment DOCUMENT acquisition only. FDH must never create a
 * competing equivalent, and FDH-1 creates none — asserted by
 * `tests/unit/fdh1InvestmentBoundary.test.ts`.
 */
export const II_OWNED_CANONICAL_ENTITIES = [
  'ii_instruments',
  'ii_instrument_identifiers',
  'ii_accounts',
  'ii_transactions',
  'ii_holding_snapshots',
  'ii_tax_lots',
  'ii_prices_nav',
] as const;

/**
 * The subset of the above for which an FDH table of the same stem would be an
 * unambiguous duplication of the canonical investment ledger.
 *
 * `ii_transactions` and `ii_accounts` are deliberately NOT in this list, and
 * the reason matters. An Investment Intelligence transaction is a UNIT
 * movement in a scheme — it carries units, NAV, folio and a tax lot. An FDH
 * transaction is a CASH movement on a bank or card statement; it has no
 * instrument, no units and no valuation, and its account is a document source
 * rather than a holding. They share an English word, not an entity.
 *
 * The real, non-linguistic guarantee is the column-level assertion in
 * `tests/unit/fdh1Isolation.test.ts` ("creates no units, NAV, ISIN, folio or
 * quantity column anywhere"), which no amount of renaming can satisfy.
 */
export const II_ENTITIES_FDH_MUST_NOT_RESTATE = [
  'ii_instruments',
  'ii_instrument_identifiers',
  'ii_holding_snapshots',
  'ii_tax_lots',
  'ii_prices_nav',
] as const;

/**
 * Table-name fragments that would indicate FDH had started building its own
 * canonical investment ledger. Any FDH table matching one of these is a
 * boundary violation.
 */
export const FORBIDDEN_FDH_INVESTMENT_TABLE_PATTERNS = [
  'holding',
  'security_master',
  'securities',
  'valuation',
  'portfolio',
  'nav',
  'folio',
  'instrument',
] as const;
