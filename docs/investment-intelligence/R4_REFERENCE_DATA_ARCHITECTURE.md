# R4 — Reference Data Architecture

## Scope actually delivered this session

R4 delivers the **schema and provider abstraction** for NAV history,
benchmark series, benchmark mapping, and risk-free rates. It does **not**
ingest any live market-data feed — no AMFI NAV download, no index-provider
API call, no scraping. This matches R1's own explicit non-goal ("no
Nifty/Sensex download") and the spec's own permitted fallback (section
20): "if direct production ingestion isn't approved/available in this
sandbox, support controlled admin/imported certified NAV files and keep
the provider interface ready for later." No such approval or credential
was available in this session, so only the interface and schema are
delivered; a certified-file importer (analogous to R2's manual CAS
importer) is explicitly **not built** this session — see Known
Limitations in `R4_ACCEPTANCE_REPORT.md`.

## NavDataProvider abstraction

Not yet implemented as a concrete class this session (no real feed to
build a real provider against) — documented here as the target shape, so
a future release building the concrete provider has an agreed contract
rather than inventing one ad hoc:

```ts
interface NavDataProvider {
  fetchSeries(instrumentId: string, from: Date, to: Date): Promise<NavPoint[]>;
  validateSeries(series: NavPoint[]): ValidationResult; // duplicate dates, out-of-order, missing/invalid NAV, suspicious jumps
  persistSeries(series: NavPoint[]): Promise<void>; // writes ii_prices_nav via service role only
  getDataQuality(instrumentId: string): Promise<DataQualityAnnotation>;
}
```

## Schema (migration `0043_ii_r4_performance_benchmark_reference_data.sql`)

All tables/columns below are **additive** — no already-applied migration
(`0001`-`0042`) is modified.

1. **`ii_prices_nav`** (existing R1 table) + `source_timestamp`,
   `data_version`, `quality_status` (`ok` / `suspicious_jump` / `stale` /
   `superseded`).
2. **`ii_benchmarks`** (existing R1 table) + `return_type` (`TRI` / `PRI`
   / `DEBT_INDEX` / `COMMODITY_GOLD` / `OTHER`).
3. **`ii_benchmark_series`** (existing R1 table) + `currency_code`,
   `source_id`, `data_version`, `quality_status`.
4. **`ii_instrument_benchmarks`** (existing R1 table) + `effective_from`
   (not null, defaults to `1900-01-01` for backfilled rows),
   `effective_to` (nullable = still current), `source_id`,
   `mapping_version`, `quality_status`. The original
   `unique(instrument_id, benchmark_id, relationship_type)` constraint
   (which would incorrectly forbid a scheme re-adopting a benchmark after
   an intervening change) is replaced with
   `unique(instrument_id, benchmark_id, relationship_type, effective_from)`,
   located and dropped dynamically via `pg_constraint` lookup rather than
   a hard-coded guessed name (this migration has never been run against
   the real database in this sandbox to confirm the exact 0031-era
   auto-generated constraint name — see Known Limitations).
5. **`ii_risk_free_rates`** (new) — `country_code`, `period_start`,
   `period_end`, `annualised_rate`, `source`, `method`, `version`. World-
   readable (`select using (true)`), no authenticated-write policy — only
   a service-role process can write it.
6. **`ii_analytics_results`** (new) — persisted derived analytics with
   full versioning metadata (`metric_key`, `metric_version`,
   `engine_version`, `data_as_of_date`, `input_snapshot_version`,
   `benchmark_mapping_version`, `nav_data_version`,
   `benchmark_data_version`, `risk_free_version`, `quality_status`,
   `quality_reason`, `result_value jsonb`). SELECT restricted to
   `auth.uid() = user_id`; **no** authenticated INSERT/UPDATE/DELETE
   policy exists — a user cannot insert a fabricated analytics result for
   themselves or anyone else at the database level, independent of any
   application-layer check. This is the DB-level backing for the
   mandatory "fake-analytics-insertion rejection" security test (spec
   section 95) — see `R4_SECURITY_VERIFICATION.md` for why that test was
   **not** actually executed live this session, and what evidence exists
   in its place.

## No parallel transaction/holding ledger

R4 reads existing `ii_transactions` / `ii_holding_snapshots` /
`ii_prices_nav` directly; it introduces no duplicate ledger, matching
spec section 69.

## Migration application status: BLOCKED

This session has no DDL execution capability — identical constraint to
every prior Investment Intelligence release. `0043` has NOT been applied
to DEV. It has been written, read back for self-consistency, and its SQL
syntax has been reviewed by hand, but it has **not** been executed
against any real Postgres instance in this session, so its exact runtime
behaviour (in particular the dynamic constraint-lookup `DO` block in step
4 above) is unverified. The user must run this migration against DEV and
confirm success before any R4 code path that reads/writes these new
columns/tables can be exercised live.
