# R0 — Canonical Identifier Strategy

Status: FINAL (R0)
Depends on: `R0_CANONICAL_DATA_CONTRACT.md`

## 1. Principle

A source-provider identifier (a CAMS folio-transaction reference, an NSDL/CDSL demat client ID, an AMFI scheme code, a broker's own trade ID) must **never** become the sole primary identifier of any canonical entity. Every canonical entity uses an internally-generated `uuid` primary key (matching the existing FHIP-wide convention — `R0_CURRENT_STATE_DISCOVERY.md` section 2). External identifiers are recorded as **aliases**, mapped to the canonical `uuid` through a dedicated mapping table or column, never substituted for it. This is the same separation `ii_instrument_identifiers` already enforces for instruments (`R0_CANONICAL_DATA_CONTRACT.md`) and is generalised here to every identifier category the spec lists.

Rationale, grounded in discovery: no existing FHIP table uses a natural key as its primary key anywhere in the schema (`R0_CURRENT_STATE_DISCOVERY.md` section 2) — every table, including reference tables like `countries` (which does use `country_code char(2)` as PK, the one deliberate exception, a genuinely stable ISO code) and `currencies`, is either a `uuid` PK or a truly-immutable external standard code. Source-provider identifiers (CAMS reference numbers, broker trade IDs) are neither internally generated nor standards-stable — CAMS can and does reformat its own reference schemes across statement versions, and the same physical folio can appear under superficially different reference strings between CAMS and KFintech for the same investor. Freezing on a provider ID as PK would make Investment Intelligence brittle to exactly the kind of provider-format change that already motivated `R0_SOURCE_PROVENANCE_CONTRACT.md`'s layered-correction design.

## 2. Identifier freeze, per concept

| Concept | Canonical identifier | External identifier handling |
|---|---|---|
| Investment position | `ii_holding_snapshots.id` (latest certified snapshot for an account+instrument) is the position's identity for a given as-of date; the **stable cross-time identity** of "this economic position" is `(account_id, instrument_id)`, not a single row id, since each snapshot is a new immutable row (`R0_CANONICAL_DATA_CONTRACT.md`). Downstream consumers (goal allocation, publishing) reference the position via `(account_id, instrument_id)` and resolve "current" by picking the latest snapshot. | n/a — this is a derived identity, not sourced externally. |
| Account | `ii_accounts.id` (uuid) | Provider account/folio/demat numbers stored as `folio_number`/`account_number_masked` columns and, where multiple provider-format variants of the same number appear across statements, as rows in a general-purpose `external_identifier` pattern identical to `ii_instrument_identifiers` (reused structurally, scoped to accounts instead of instruments — same table shape, different subject). |
| Folio | Same as Account — a folio *is* an `ii_accounts` row with `account_type='mf_folio'`; no separate folio table (see `R0_CANONICAL_DATA_CONTRACT.md` `ii_accounts`). | Folio number is a provider-format alias, per above. |
| Instrument | `ii_instruments.id` (uuid) | ISIN, AMFI scheme code, NSE/BSE symbol, SEDOL — all recorded in `ii_instrument_identifiers`, never as the instrument PK. A **provisional** instrument (first seen only in one user's own statement, no ISIN/AMFI code resolvable yet) still gets a real `ii_instruments.id` immediately (`status='provisional'`) so transactions/snapshots can reference it without waiting on reference-data enrichment; it is reconciled/merged into a verified master record later via `merged_into_instrument_id` without needing to rewrite any FK that already points at the provisional row. |
| Transaction | `ii_transactions.id` (uuid) | Provider transaction reference stored in `metadata`/a dedicated `source_reference` column (not yet named as a required column in R0 — an R1 implementation decision, `R1_IMPLEMENTATION_SPEC.md`), used for de-duplication (the same transaction re-appearing in a refreshed statement must resolve to the same canonical row, not a duplicate) but never as the PK. |
| Tax lot | `ii_tax_lots.id` (uuid) | Derived internally from `ii_transactions`; no external identifier exists for a tax lot in any source document. |
| Source document | `ii_source_documents.id` (uuid) | `checksum` (content hash) is the de-duplication key for "is this the same file re-uploaded" — not the PK, but the mechanism that decides whether an upload creates a new row or is recognised as already-seen. |
| Import | An import is one `ii_source_documents` row moving through its `status` lifecycle (`uploaded → parsing → parsed`) plus the set of `ii_transactions`/`ii_holding_snapshots` rows carrying that `source_document_id` — **no separate `ii_imports` table** is introduced; the spec's "import" identifier need is fully covered by `ii_source_documents.id`, avoiding a redundant entity. |
| Reconciliation case | `ii_reconciliation_cases.id` (uuid) | n/a — internally raised. |
| Publication | `ii_fhip_publications.id` (uuid) | n/a — internally raised; `published_row_id` is the external-to-Investment-Intelligence reference (into `assets`/`investments`/`retirement_accounts`), handled as described in `R0_CANONICAL_DATA_CONTRACT.md`. |
| Analytics result | `ii_analytics_results.id` (uuid), immutable per calculation run | n/a. |
| Insight | `ii_insights.id` (uuid) | n/a. |
| Goal allocation | `ii_goal_allocations.id` (uuid) | n/a — `goal_id` is the existing `user_goals.id`. |
| Reference-data version | `ii_tax_rule_versions.id` (uuid), `ii_benchmark_series` rows keyed `(benchmark_id, series_date)`, `ii_prices_nav` rows keyed `(instrument_id, price_date)` | Provider series identifiers (if any) recorded as reference columns, never as PK. |

## 3. Multi-source support

The identifier strategy above is designed to support, without schema change, every source type the spec lists: CAMS, KFintech, NSDL, CDSL, broker sources, manual sources, and future Australian sources. This works because:

1. No canonical PK anywhere encodes a source-specific format assumption (e.g. no PK is "the CAMS folio string").
2. External identifiers are always modelled as *(scheme, value)* pairs in a mapping table (`ii_instrument_identifiers`, and its generalised sibling for accounts described above), so adding a new scheme (an ASX HIN for a future Australian broker, say) is a new `identifier_scheme` enum value and new rows, never a new column or table.
3. `ii_sources` (the source-type catalogue) is itself a reference table a new provider is added to as a row, not a schema change (`R0_CANONICAL_DATA_CONTRACT.md`).

## 4. What R0 explicitly does NOT freeze

- The exact column name/shape for transaction-level source-reference de-duplication (noted above) — deferred to `R1_IMPLEMENTATION_SPEC.md` as an implementation detail that doesn't affect the PK/alias separation this document freezes.
- Any actual CAMS/KFintech/NSDL/CDSL identifier *format* parsing rules — that is India-adapter reference data/logic, not an R0 architectural decision, and explicitly not built in R0 (no CAS parser — see the task's non-goals).
