# R12 — Market Data & Price Provenance

See `R12_HOLDINGS_AND_VALUATION.md` sections "Listed security valuation" / "Price provenance" / "Stale
price" for the full detail. Summary for this dedicated doc:

- **No live market-data service exists or is invented.** R12-P0 classified valuation sources per spec
  section 37 and found only `MANUAL_PRICE` is available/appropriate this cycle.
- **Every valuation retains price, price date, price source, and quality/status** (spec section 38):
  `ii_holding_snapshots.value` (implies price via `value/units`), `.as_of_date`, `.price_source`
  (new), `.quality_status` (existing — always `'warning'` for a manual entry, never `'certified'`,
  since no independent verification exists for a user-typed number).
- **Staleness is never silently substituted with 0 or a fabricated current value** — see
  `priceFreshness.ts`. A stale valuation is still returned with its real (old) value, tagged `STALE`.
- **Future-compatible**: `price_source` already accepts `'admin_reference'` and `'certified_market_data'`
  as valid values (migration 0092's check constraint) — a future release wiring in a real NSE/BSE price
  feed writes into the same column, same table, no schema change.
