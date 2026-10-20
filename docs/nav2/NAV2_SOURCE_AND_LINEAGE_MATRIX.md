# NAV2 - Source and lineage matrix

Evidence label: read from the repository at `bf2e101` (code and migrations); nothing was queried in any database. Where this matrix says what a table "does", it is from the migration and code, not from observing DEV or production.

## 1. NAV observation lineage (spec 6)

Table `ii_prices_nav` (migrations 0033, 0043, 0155, 0166-0167, 0187, 0201, 0204, 0219). Public reference data: RLS `select using (true)`, no `user_id`.

| Spec 6 requirement | Where it lives today | NAV2 use |
|---|---|---|
| canonical instrument ID | `instrument_id` (FK `ii_instruments`) | series identity; foreign-instrument rows are rejected |
| scheme code / identifier used | `ii_scheme_master.amfi_scheme_code`, resolved at fetch (`fetchAdapterIdentifier`) | not stored per row; the provider identifier is in the batch |
| NAV date | `price_date` (a trigger rejects more than today + 1 day, 0155) | window and boundary rules |
| NAV value | `price numeric(24,10)` (0155, widened from 20,6 because AMFI publishes 8 dp) | parsed from the exact string at the boundary |
| currency | `currency_code` | wrong-currency rows excluded; all-wrong = `currency_mismatch` |
| provider | the adapter that supplied the row is stamped in `data_version` (AMFI primary, TIGZIG fallback; TIGZIG stays candidate data labelled as TIGZIG) | not used in calculations; available for audit |
| source retrieval timestamp / checksum | `source_timestamp` (set on insert and on correction), `record_checksum` (content hash), `import_batch_id` -> `ii_reference_import_batches` (`started_at`, `finished_at`, counts, `notes.perInstrument`) | series checksum (NAV2) is separate: a hash of the effective series, not of the source payload |
| data version | `data_version` | audit |
| correction / replacement lineage | columns `superseded_by_id`, `correction_of_id` (0155); the ledger `ii_reference_corrections` (target row, previous value, new value, actor, reason, batch) | see 2 |
| quality status | `quality_status in ('ok','suspicious_jump','stale','superseded')` (0043) | only `ok` (or null) is eligible; the SAME rule the valuation uses (`isNavQualityEligible`) |
| ingestion batch ID | `import_batch_id` | audit |
| one value per (instrument, date) | `unique (instrument_id, price_date)` (0033); `ii_prices_nav_existing_pairs` (0204) assumes at most one row per pair | the effective series has one value per date |

Rejected or quarantined at write time (spec 6): non-positive NAV (price check), impossible or future dates (date trigger), wrong currency (adapter / write rows), unresolved mapping (no identifier -> `unresolvable_identifier` outcome), disagreeing duplicate (becomes a correction, below), extreme movement (`suspicious_jump` status until reconciled). NAV2 re-applies the read-side equivalents in `prepareSeries` so a bad row that reached the table by any path is still never used.

## 2. How a correction actually lands (a finding that shapes NAV2)

`decideUpsert` returns `supersede` when a re-fetched value has a different checksum. The reconciliation sweep (`navReconciliationSweep.ts`) and the ingest implement `supersede` as an **in-place UPDATE plus a row in `ii_reference_corrections`**, not as an inserted second row (the unique constraint forbids two rows for a date). Consequences:

- The effective series always has exactly one value per date. `prepareSeries` additionally honours `superseded_by_id` / `correction_of_id` lineage and quarantines two disagreeing rows for one date, as a defensive rule for any path that does populate those columns (admin corrections, future inserts); both behaviours are tested.
- The PRE-correction value survives only in `ii_reference_corrections.previous_value`. NAV2 needs no old value to recompute (it recomputes from the current series); a finalised report keeps its own frozen output (below).
- The event NAV2 must react to is an `ii_reference_corrections` insert with `target_table = 'ii_prices_nav'`. **Stage 2 must add the listener** that turns such a row into `InvalidationEvent { kind: 'nav_correction', instrumentId, date }` (the row id resolves to instrument and date). Until then a correction is still safe: the series checksum changes, so a cache key built from it changes and no stale entry can be served (tested).

## 3. Report pinning (spec 13, 12.2)

- `reports` / `report_sections` store FROZEN output (`section_data_json` written once); revisions insert a new row (`version_number`, `revises_report_id`, `status='superseded'`). A later NAV correction cannot change an issued report's stored numbers.
- `ii_report_nav_dependencies` (0172) pins the NAV RANGE a report used (compact range manifest), protecting it from Stage-E deletion; `ii_report_nav_dependency_alerts` (0223) records when a pinned range later loses coverage (alert only, never recalculates). The writer is `reportNavDependencyWriter.ts`.
- Gap found for Stage 2: the manifest records a range, not the NAV values or a checksum. For a NAV2 section to prove "this exact input produced this number", the section's stored data should carry the `Nav2Provenance.navSeries.checksum` and the policy / definition versions (already in every result). Stage 2 decides whether to extend the manifest or rely on the stored provenance.
- The legacy manifest basis value `twr_since_opening_balance` is constrained by a CHECK in 0172 and is on the repo's TWRR guard allow-list; NAV2 never writes it.

## 4. Other sources NAV2 reads or depends on

| Data | Table / module | Private? | Notes |
|---|---|---|---|
| held schemes, earliest held date | `ii_transactions` (usable = not `reversed`, not `review_required`), `ii_holding_snapshots`, `ii_investment_date_inputs` (`awaiting_nav`, `applied`), via `loadUserHeldFundDates` | **private** (user_id) | the only user-private input to Phase B; every read is `user_id = caller` |
| coverage | `ii_prices_nav` earliest, `ii_nav_history_floors` (0190) | public | via `loadCoverage` |
| attempts / fairness | `ii_nav_hydration_attempts` (0198 / 0199) | operational | via `loadAttempts` |
| confirmed unrecoverable gaps | `ii_nav_source_coverage_gaps` (0219; e.g. HSBC AMFI 151069) | operational | disclosed as `unrecoverable_history_period` when a window overlaps; the loader that feeds `knownCoverageGaps` into `prepareSeries` is Stage 2 |
| benchmark levels | `ii_benchmark_series` (0043 / 0155), catalogue `ii_benchmarks` (`catalogue_status`, return type), mappings `ii_instrument_benchmarks`, entitlement `benchmark_entitled_actions` (0241) | public reference | currently NO licensed series (PO); category reference (`categoryReference.ts`, read-time, never stored) |
| risk-free | NEW governed dataset (Stage 2 storage; first-load CSVs from the PO; weekly refresh job); the old `ii_risk_free_rates` (0043) holds only the self-declared DEV seed and is NOT read by NAV2 | public reference | see the dependency register |
| scheme category for ranking | `ii_scheme_master` (`sub_category`, `category_header_raw`) via `categoryReference.ts` `resolveFundCategory` | public | Stage 2 loader |
| Premium entitlement | `user_entitlements` via `getPlanTier` / `canViewPremiumReport` (honours the validity window, admin grants) | private | Stage 2 gate on the report and its endpoint |

## 5. Retention (spec 12.1)

Retention is unchanged by Stage 1. A held scheme's NAV history is kept in full by migration 0189 / 0200 / 0219 (`pc6_nav_row_is_candidate`); benchmark schemes, report-pinned ranges, open retention holds and coverage-gap ranges are also protected. NAV2 adds no retention rule; the open policy question (NAV1 keeps and hydrates from inception, NAV2 spec wants bounded) is in the window policy document, section 7.
