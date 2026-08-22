# ADR-002: Canonical Identifiers

## Status
Accepted (R0)

## Context
Investment Intelligence must ingest data from multiple, format-inconsistent source providers (CAMS, KFintech, NSDL, CDSL, brokers, manual entry, and eventually Australian sources) while presenting one stable identity per instrument/account/transaction/position to the rest of the system. The spec explicitly warns a source-provider identifier must never become the sole primary identifier.

## Decision
Every canonical Investment Intelligence entity uses an internally-generated `uuid` primary key, matching the FHIP-wide convention already used by every existing table (`R0_CURRENT_STATE_DISCOVERY.md` section 2). External/provider identifiers (ISIN, AMFI scheme code, folio number, CAMS reference) are recorded as `(scheme, value)` alias rows in a dedicated mapping table (`ii_instrument_identifiers`, generalised to accounts per `R0_CANONICAL_IDENTIFIER_STRATEGY.md`), never substituted for the canonical PK. Full per-concept freeze is documented in `R0_CANONICAL_IDENTIFIER_STRATEGY.md`.

## Alternatives considered
1. **Use ISIN/AMFI code as the instrument primary key directly** — rejected: not every instrument observed (e.g. a first-seen holding from a user's own statement before reference-data enrichment) has a resolvable ISIN/AMFI code immediately; would block ingestion pending external enrichment, and would break if a provider ever reused/reformatted a code.
2. **Composite natural keys** (e.g. `(source_key, provider_reference)` as PK) — rejected: makes merging two records for the same real-world instrument first seen from two different providers (e.g. a broker feed and a later CAS import) require a PK change across every referencing row, instead of the chosen approach's non-destructive `merged_into_instrument_id` pointer.
3. **A single universal external-ID column on each entity** rather than a separate alias table — rejected: cannot represent an instrument having *multiple* valid identifiers simultaneously (ISIN **and** AMFI code **and** an internal provisional tag), which real Indian mutual fund data requires.

## Consequences
- Positive: onboarding a new source provider (including a future Australian one) never requires an identifier-strategy schema change — only new `ii_sources`/`identifier_scheme` rows.
- Positive: a provisional instrument can be created immediately from a user's own statement and later reconciled/merged into a verified master record without rewriting foreign keys.
- Negative: requires an explicit alias-resolution step wherever a provider reference needs to be matched back to a canonical `uuid` (a real implementation cost in R1, not free).

## Migration implications
`ii_instruments`, `ii_instrument_identifiers`, and the account-identifier equivalent are new tables — no existing table is altered. R1 must design de-duplication logic (matching an incoming provider reference to an existing alias before creating a new provisional instrument) as part of the ingestion pipeline, not the schema itself.

## Testing implications
R1 must include a test proving that the same instrument, first seen via one provider and later confirmed via a second provider with a different identifier scheme, resolves to the same `ii_instruments.id` rather than creating a duplicate — this is a design requirement now, an implementation-verified requirement at R1.
