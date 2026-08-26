# R12 — Holdings & Valuation

## Holdings engine (spec section 36)

Reused unchanged: `ii_holding_snapshots` — the same immutable, one-row-per-(account, instrument,
as_of_date) certified-balance table mutual funds already use. `manualDirectPositionService.ts` computes
the position's `unitsAfter`/`valueAfter` after each buy/sale/dividend/reprice action and writes a new
snapshot row via `importManualFixture()`'s existing upsert path — no new holdings table.

Quantity semantics: `unitsAfter = previousUnits ± actionUnits` (buy adds, sale subtracts — validated
against the latest known position so a sale can never take units negative). Cost basis is tracked at
the transaction level (`ii_transactions.price_per_unit`/`gross_amount`/`fees`/`taxes`); lot-level FIFO
cost basis for gains computation is the existing `ii_tax_lots`/`taxLotEngine.ts` machinery, unmodified.

## Listed security valuation (spec section 37)

**No live market-data feed exists anywhere in this repository** (confirmed during architecture
discovery — `ii_prices_nav` is R1-era reference-data SHAPE only, never populated by any AMFI/exchange
feed). R12 does not invent one. Valuation source is classified explicitly as `MANUAL_PRICE`:

| Valuation source | Status |
|---|---|
| Existing certified market data | Not available (no feed exists) |
| Manual price | **R12's only source** — user enters units + price per unit, or a current total value |
| Statement price | Not used by R12 (no broker statement parser — deferred, spec section 19) |
| Admin/reference data | Not used by R12 |
| Future integration | `price_source` column (migration 0092) is designed to accept `'certified_market_data'`/`'admin_reference'` values a future release can start writing without a schema change |

## Price provenance (spec section 38)

`ii_holding_snapshots.price_source` (new, migration 0092) is set to `'manual_entry'` for every R12
write (`manualDirectPositionService.ts`). Pre-R12 (CAS-statement) rows have `price_source = null` —
deliberately untouched, not retroactively backfilled with a guess.

## Stale price (spec section 39)

`lib/engines/investment-intelligence/valuation/priceFreshness.ts` — pure `resolvePriceFreshness(asOfDate,
today, thresholdDays=5)`. A `manual_entry`-sourced valuation older than 5 calendar days is `STALE`;
`shouldPresentAsCurrentValue()` returns `false` for it. Wired into
`GET /api/investment-intelligence/positions` (additive `priceFreshness` field, computed **only** for
`price_source='manual_entry'` rows — CAS-derived mutual fund rows are left untouched, since their NAV
freshness is a different T+1-disclosure concept this module does not govern). Never substitutes 0 for
a stale value — the raw `value` is still returned, tagged `STALE`, for the caller to render
appropriately ("Stale valuation — last updated {date}"), never silently as today's price.

Tested: `tests/unit/iiR12WiderIndiaAssets.test.ts` (boundary at exactly 5/6 days),
`scripts/r12_post_migration_pglite_verification.mjs` NC5 equivalent reasoning documented in
`R12_NEGATIVE_CONTROL_CERTIFICATION.md`.

## Bond valuation (spec section 40)

Not applicable — bonds are deferred scope (`R12_ASSET_CLASS_SCOPE_MATRIX.md`). No par-vs-market
valuation methodology decision was needed or made.

## Maturity (spec section 41)

Not applicable to equity/ETF (no maturity concept). A full `sale` (units reduced to 0) correctly stops
the position from appearing in `GET /api/investment-intelligence/positions` (which collapses to the
latest snapshot per position — a 0-unit latest snapshot is still returned today with `units: 0`,
identical to how a fully-redeemed mutual fund already behaves; R12 introduces no new behaviour here).
