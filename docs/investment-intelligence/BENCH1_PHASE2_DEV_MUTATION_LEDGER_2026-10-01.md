# BENCH-1 Phase 2 - DEV mutation and fixture-cleanup ledger

Date: 2026-10-01.

## Result: ZERO writes to DEV or production

| Environment | Project ref | Writes by this mission | Reads by this mission |
|---|---|---|---|
| PRODUCTION | twwpnltizhtjxhamyoxt | **None** (no INSERT/UPDATE/DELETE/RPC/DDL) | HTTP GET only, via PostgREST with the repository's existing server-side key from `.env.local` (never printed or stored): row counts of `ii_instruments`, `ii_benchmarks`, `ii_benchmark_series`, `ii_instrument_benchmarks`, `ii_holding_snapshots`, `ii_transactions`, `ii_scheme_master`; and the read-only held-scheme inventory below |
| DEV | vqycarelcoijzwlpkpcz | **None** | The same, plus a read of the PostgREST schema listing to confirm no SQL-execution RPC exists |

The read-only inventory (`scripts/bench1_held_scheme_inventory.mjs dev|prod`, GET only) read the seven user-scoped tables behind `pc6_user_held_instrument_ids()` (`ii_transactions`, `ii_holding_snapshots`, `ii_portfolio_truth_status`, `ii_tax_lots`, `ii_sip_series`, `ii_capital_gains_computations`, `ii_fhip_publications`), `ii_instruments`, `ii_scheme_master`, `ii_prices_nav` bounds, and the three benchmark tables. User-scoped rows were aggregated **in memory**; the outputs contain only public scheme identifiers, dates and counts (a pattern scan found no user, account, folio, member, email, unit or amount data). No data was sent to any external host: the public-source and scheme-document research made requests containing only public index/scheme names and URLs.

## Why nothing was written

1. Migration 0241 (and 0232) are **not applied to DEV or production**, and this environment has no DDL path (no database URL, no management token, no SQL-execution RPC - verified against the DEV PostgREST listing). Every governed write path (staging, publish, entitlements, mapping, ingestion state) is an RPC created by 0241, so none exists to call.
2. Writing synthetic benchmark rows straight into the existing tables would bypass the governance this mission builds and would repeat the DEV pollution the 2026-09-30 cleanup removed (14 benchmarks / 199 series rows / 14 mappings).
3. There is no permitted real source file (no entitlement exists), so no real data could be published.

## Fixture cleanup

None required. All fixtures live inside in-memory PGlite databases and vitest doubles (`scripts/bench1_phase2_0241_pglite_verification.mjs`, `tests/unit/benchmarkData*.test.ts`) and are discarded with the process. No fixture, synthetic level or test file was committed as market data. Nothing needs deleting from DEV or production.

## What the PO runs to produce live DEV evidence (a mutation ledger for that run must be recorded then)

1. `scripts/bench1_phase2_po_apply_0241.sql` steps 0-2 on DEV (apply 0232 first if absent).
2. Grant capabilities to named administrators (step 3).
3. Optionally the draft seed `docs/admin/po_apply_bench1_phase2/03_seed_catalogue_and_mapping_proposals.sql`.
4. Create and approve an entitlement ONLY if rights exist in writing; then upload a **permitted real file** for one benchmark and walk the five screens (checklist in the release package). Any synthetic file used for a code-path rehearsal must carry `history_class = unknown`, a source reference of "synthetic rehearsal", be rolled back through the Jobs tab and recorded here; it must never be published to production.
