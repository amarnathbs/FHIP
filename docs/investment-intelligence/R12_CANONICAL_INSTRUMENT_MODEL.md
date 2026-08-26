# R12 — Canonical Instrument Model

## Reuse decision (spec section 22)

R12 makes **zero changes** to `ii_instruments.instrument_class` — `'equity'` and `'etf'` were already
valid values (migration 0031, R1). No new instrument table, no new enum value. This is the single
biggest architecture-discovery finding of this round (see `R12_WIDER_INDIA_ASSETS_ARCHITECTURE_DISCOVERY.md`
section 2.1): the instrument model was already future-proofed for exactly this expansion.

## Identifier model (spec sections 24-27)

Reused unchanged from `ii_instrument_identifiers` (migration 0031):

| Scheme | Uniqueness scope | R12 usage |
|---|---|---|
| `isin` | Global (`uidx_ii_instrument_identifiers_global`) | Preferred canonical identity for equity/ETF, required by `iiManualDirectPositionSchema` |
| `nse_symbol` | Country-scoped | Optional, for display/lookup convenience |
| `bse_code` | Country-scoped | Optional, for display/lookup convenience |

**Duplicate prevention (spec section 27) — live-proven, not just structural**: `scripts/r12_live_dev_verification.mjs`
(LIVE-R12-04) created one instrument with all three identifiers (ISIN + NSE + BSE) on real DEV, then
attempted to mint a second instrument claiming the same ISIN — blocked with HTTP 409 by the existing
global unique index. `scripts/r12_post_migration_pglite_verification.mjs` (NC1) reproduces the same
result on a fresh rebuild. `resolveInstrumentIdFromIdentifiers` (pure function, `identifiers.ts`) is
exercised by 8 of the 41 independent-oracle cases (`ID-001`..`ID-008`).

## Instrument master resolution (spec section 26)

Unchanged: `resolveOrCreateInstrument()` (`identifiers.ts`) — deterministic signal matching only
(exact identifier match within the correct uniqueness scope), never symbol-only fuzzy matching. R12's
manual-entry service (`manualDirectPositionService.ts`) calls this via the existing
`importManualFixture()` pipeline, unchanged.

## Exchange identity (spec section 25)

NSE and BSE symbols for the same ISIN resolve to the same `ii_instruments.id` — proven live (LIVE-R12-04)
and in PGlite (NC1). R12 does not introduce a second "economic instrument" per exchange listing.

## What R12 actually added to the schema (migration 0092)

1. `ii_transactions.transaction_type` gains `'sale'` (equity/ETF market disposal, distinct from a
   mutual-fund `'redemption'`).
2. `ii_holding_snapshots` gains a nullable `price_source` column (price provenance — see
   `R12_MARKET_DATA_AND_PRICE_PROVENANCE.md`).
3. `ii_scheme_tax_classification.basis` gains `'direct_listed_security_rule'` (see
   `R12_INDIA_TAX_AND_COST_INTEGRATION.md`).
4. `ii_holding_snapshots` RLS: the pre-existing same-user authoritative-forgery gap found during
   R12-P0 discovery is fixed (SELECT-only for the authenticated role, matching the post-0087
   `ii_transactions` shape).

No `ii_instruments`/`ii_instrument_identifiers`/`ii_accounts` schema changes were needed — `equity`,
`etf`, and `demat` account type already existed.

## Manual-entry orchestration (new, spec section 20)

`R12_WIDER_INDIA_ASSETS_ARCHITECTURE_DISCOVERY.md` section 2.6 found there was **no live user-facing
manual-entry API for any asset class before R12** — `manualImporter.ts`'s `importManualFixture()` was
a certification-fixture loader, never exposed via an `app/api` route. R12 builds the first one:
`POST /api/investment-intelligence/positions/manual` → `submitManualDirectPosition()` →
`importManualFixture()` (unchanged). The route is generically reusable — a future release adding a
new instrument class can build its own thin request-shaping layer on top of the same importer,
without a new ingestion pipeline.
