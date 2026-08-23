# ADR-005: Country-Neutral Core and Country Adapters

## Status
Accepted (R0)

## Context
India is the first Investment Intelligence country implementation; Australia must later reuse the same core without a schema rewrite (design principle 9). FHIP itself already supports exactly two country/currency pairs (`AU`/`AUD`, `IN`/`INR` — `R0_CURRENT_STATE_DISCOVERY.md` section 7), so the adapter boundary chosen here will be exercised by a second real country relatively soon, not a hypothetical far-future case.

## Decision
Every Investment Intelligence entity is designed to the test: *"would adding Australia require changing this table's core columns, or only adding adapter rows/config?"* Entities that fail this test (would need a schema change) push the country-specific part into a reference/config row (`ii_sources`, `ii_tax_rule_versions`, `ii_instrument_identifiers.identifier_scheme`) or an adapter-owned nullable column, never a required core column. Full per-concept application: `R0_DOMAIN_ARCHITECTURE.md` sections 2–3.

## Alternatives considered
1. **One shared schema with India-specific required columns (e.g. `amfi_scheme_code not null` on `ii_instruments`)** — rejected: would be meaningless/empty for a future Australian ASX-listed instrument, directly causing the schema rewrite principle 9 forbids.
2. **Fully separate schemas per country from the start** (`ii_instruments_in`, `ii_instruments_au`) — rejected: duplicates the entire core for every country, defeats the purpose of a shared core, and makes cross-border households (already a first-class FHIP concept, `R0_CROSS_BORDER_CONTRACT.md`) structurally awkward to query across.
3. **A single generic `attributes jsonb` bag on every core table for all country-specific data, no adapter-owned columns at all** — rejected as the *sole* mechanism: acceptable for genuinely rare/variable attributes, but would make well-known, heavily-queried adapter attributes (like `folio_number`) unindexable and untyped for no benefit, when a nullable typed column costs nothing extra for a second country that also happens to use the same concept (folios exist in more than one country's managed-fund industry).

## Consequences
- Positive: onboarding Australia is additive (new `ii_sources` rows, new `identifier_scheme` values, new `ii_tax_rule_versions` rows) rather than a migration of the core schema.
- Positive: cross-border households (already common in FHIP, per its own cross-border forecasting module) can hold both an Indian and (eventually) an Australian Investment Intelligence position under the same core tables.
- Negative: requires discipline during R1 implementation to keep resisting the temptation to add "just one" India-specific required column to a core table — an explicit review checklist item for any future migration touching `ii_*` core tables.

## Migration implications
None for R0 (no migration exists yet). This ADR is the standing test every future `ii_*` migration must be checked against before merging.

## Testing implications
No automated test can fully verify "no future schema rewrite will be needed" — this is a design discipline, not a testable property in the traditional sense. R1's acceptance gate substitutes a manual review: every new required (non-nullable) column added to a core `ii_*` table must have a written justification for why it is genuinely universal, not India-specific.
