# BENCH-1 — Stage B1 Discovery (2026-09-30)

> **2026-09-30 continuation addendum (same day, PO-authorized second pass) — read this first.**
> Everything below this notice is the ORIGINAL B1 pass and is left unedited for the record, but two
> of its findings turned out to be incomplete or wrong once more of the repository's history was
> read, and real B2-onward work was done in the same dispatch. Corrections and new work:
>
> 1. **A prior mission (PC6, 2026-09-15) already built almost all of BENCH-1's buildable B2-B4
>    scope to CONDITIONAL PASS**, blocked on the identical two decisions this mission calls
>    PO-PC6-1 (index licensing) and PO-PC6-2 (risk-free methodology). See
>    `docs/investment-intelligence/PC6_MARKET_DATA_CERTIFICATION_2026-09-15.md` — 174/174 tests,
>    real AMFI data, effective-dated mapping with audited override, quality/staleness/correction
>    machinery, a full provider registry (`lib/config/investment-intelligence/pc6ReferenceSources.ts`)
>    that already models `nse_index_tri`/`bse_index`/`india_risk_free` as governed BLOCKED sources,
>    and an eight-panel Admin surface (`app/(app)/admin/investment-intelligence/reference-data-quality`)
>    already compliant with the Admin standard. **This was not found in the original B1 pass** —
>    an important miss, since a future dispatch re-proposing this machinery from scratch would be
>    pure duplication. Read that certification document in full before writing any new benchmark
>    schema, adapter, or admin surface.
> 2. **Migration `0155` (PC6) is now applied to BOTH DEV and production** — re-verified this
>    session by selecting `return_type`/`licence_status`/`lifecycle_status` columns and the
>    `ii_benchmark_category_defaults`/`ii_risk_free_methodology` tables directly against production;
>    all returned HTTP 200. The original B1 finding (and PC6's own 2026-09-15 report) said 0155 was
>    NOT applied anywhere — an operator evidently applied `0153`-`0155` between then and now. This
>    resolves PC6's blocker C-1.
> 3. **The original B1 claim that `OverviewClient.tsx` has "no real benchmark wiring" was wrong.**
>    It already renders an honest benchmark-coverage sentence via the Performance card's `detail`
>    text (`lib/investment-intelligence/analysisAvailability.ts`'s `performanceAvailability()`,
>    driven by `overviewSummary.ts`'s already-existing `instrumentsWithBenchmarkCount` signal) —
>    e.g. *"Benchmark comparison is not available — none of your schemes is mapped to a benchmark."*
>    The original B1 grep only searched the component file itself for the literal word "benchmark"
>    and missed that the text is server-computed and passed through generically. No code change was
>    needed for Overview.
> 4. **DEV cleanup performed** (PO-authorized, with full trace/ledger): the 14 synthetic
>    `ii_benchmarks` + 199 `ii_benchmark_series` + 14 `ii_instrument_benchmarks` rows identified
>    below were deleted from DEV after a positive dependency trace confirmed no other row or table
>    referenced them. See `docs/investment-intelligence/evidence/bench1_dev_synthetic_cleanup_2026_09_30/MUTATION_LEDGER.md`.
>    DEV and production now both read 0 rows across all three tables.
> 5. **Real code shipped this dispatch** (B5 work, ahead of where B1 alone would leave things):
>    `lib/services/investment-intelligence/benchmarkCoverage.ts` (shared, batch-query benchmark
>    resolver reusing the certified R4 `benchmarkEngine`/`benchmarkService` — no arithmetic
>    reimplemented), wired into `HoldingsTable.tsx` (new Benchmark column, honest
>    unavailable states) and `PortfolioXrayClient.tsx` (scheme-level coverage sentence). Also
>    `lib/services/investment-intelligence/pc6/csvBenchmarkImporter.ts`, the licensed-CSV interim
>    ingestion channel mission §8/§13 asks for, with a licence-status gate that refuses to let a CSV
>    become a way around PO-PC6-1. See the commit history on this branch for full detail; not
>    repeated here to avoid the two documents drifting.
> 6. **Still not done**: an Admin route/UI/capability for the CSV importer (needs its own
>    four-layer Admin Standard compliance work); real vendor/licence procurement (still blocked,
>    web fetch to the three reference pages failed again on retry — see updated `SOURCE_DECISION.md`);
>    recurring cron ingestion (PC6 already built this machinery for NAV; a benchmark-specific
>    schedule was not built or re-verified this session, and none should be registered against a
>    still-licence-blocked source in any case).
>
> The rest of this document is the original, unedited B1 pass.

Branch: `feat/bench1-benchmark-data-discovery-20260930` (off `origin/main` @ `bbd63ce`).
Scope reached this dispatch: **B1 only** (discovery + baseline verification), plus the
source-decision scaffold (`SOURCE_DECISION.md`) that mission §3 asks for as an early artifact.
B2–B7 were **not** started this dispatch — see "What was not attempted and why" below. This is
stated plainly per the mission's own certification discipline (§16): do not claim a stage that
was not actually finished with evidence.

## 1. Baseline verification (mission §1's required first step)

Verified read-only via PostgREST with the service-role keys in `D:/FHIP/.env.local`, this session,
2026-09-30:

| Table | Production (twwpnltizhtjxhamyoxt) | DEV (vqycarelcoijzwlpkpcz) |
|---|---|---|
| `ii_benchmarks` | **0 rows** (HTTP 200, `Content-Range: */0`) | 14 rows |
| `ii_benchmark_series` | **0 rows** | 199 rows |
| `ii_instrument_benchmarks` | **0 rows** | 14 rows |
| `ii_sources` | 9 rows | 11 rows |
| `ii_scheme_master` | 14,401 rows | 14,374 rows |

The Product Owner's stated baseline (production benchmark tables empty) is **confirmed accurate**.

### Important finding: the DEV rows are not real benchmark data

The 14 DEV `ii_benchmarks` rows are **not** Nifty/Sensex/CRISIL indices. Their `benchmark_key`
values are machine-generated test identifiers, e.g. `VCVC031787569221393_BM`,
`MR1787578718134_BM`, `VCVC141787577719944_BM_INR` — the numeric suffixes are epoch-millisecond
timestamps and the prefixes match this repo's test-fixture naming conventions. The 199
`ii_benchmark_series` rows are synthetic (e.g. a flat `100.000000` opening value climbing to
`108.735594` — a textbook test-fixture growth curve, not an index history), and the 14
`ii_instrument_benchmarks` mappings carry `mapping_version: "vc-v1"` and point at those same
synthetic benchmark rows. This is DEV database pollution left behind by an automated test run that
hit the live DEV database rather than a mock (a hazard this repo's own memory already documents
for `scripts/` file artifacts — this is the same failure mode, but in DEV *data* rather than
checked-in files).

**Net effect: zero genuine benchmark catalogue, mapping, or series data exists anywhere in this
system today**, in DEV or production. The mission's premise ("production has zero rows, discovery
is a step not the deliverable") is correct in production; DEV's non-zero counts do not represent
real progress and should not be mistaken for a head start by a future dispatch. Recommend a
Product-Owner-authorized DEV cleanup of these 14+199+14 rows before any real seeding begins, so a
future certification pass isn't confused by leftover synthetic rows sharing the same tables.

## 2. Schema state (mission §5 "additive migrations" — much of this already exists)

Contrary to a from-scratch read of the mission, the `ii_benchmarks` / `ii_benchmark_series` /
`ii_instrument_benchmarks` schema has already been extended twice by earlier, already-merged work:

- `supabase/migrations/0031_ii_reference_foundation.sql` — original shape-only tables (R1, ADR-010):
  `benchmark_key`, `benchmark_label`, `benchmark_category` (index/category_average/custom),
  `country_code`, `is_active` on `ii_benchmarks`; plain `(benchmark_id, series_date, value)` on
  `ii_benchmark_series`; a simple `unique(instrument_id, benchmark_id, relationship_type)` on
  `ii_instrument_benchmarks`.
- `supabase/migrations/0043_ii_r4_performance_benchmark_reference_data.sql` (R4, memory: UNCONDITIONAL
  FULL PASS) — added `return_type` (`TRI`/`PRI`/`DEBT_INDEX`/`COMMODITY_GOLD`/`OTHER`) to
  `ii_benchmarks`; `currency_code`, `source_id`, `data_version`, `quality_status` to
  `ii_benchmark_series`; and, critically, **effective-dated mapping** (`effective_from`,
  `effective_to`, `mapping_version`, `quality_status`) plus a period-aware unique constraint on
  `ii_instrument_benchmarks` — this is most of what mission §6 asks for ("model effective-dated
  mapping history... current mapping must not silently apply to a 2006 investment").
- Confirmed live on DEV: the `ii_benchmarks` row fetched this session already carries
  `return_type`, `lifecycle_status`, `licence_status` columns, and the `ii_instrument_benchmarks`
  row carries `effective_from`, `mapping_basis`, `override_actor_admin_id`,
  `override_reason`, `override_recorded_at` — i.e. admin-override-with-audit (mission §6) also
  already has schema support.
- `supabase/migrations/0155_pc6_reference_market_data_foundation.sql` (PC6) additionally adds
  `ii_sources` as a reference-data-provider category (incl. an `amfi` row, already live in both
  DEV and production) and `ii_scheme_master`. Per its own header, **0155 was confirmed NOT applied
  via any live DDL execution** as of 2026-09-15 (no `exec_sql`/`DATABASE_URL`/management-token path
  existed then) and was instead verified only by a full PGlite replay — yet `ii_scheme_master` and
  the `amfi` source row demonstrably exist live in both DEV and production today (14,374 /
  14,401 rows). That means the actual DDL was applied to both databases by some other means between
  2026-09-15 and now (an operator, or a different migration path) — this dispatch has **no DDL
  execution capability either** (same `.env.local` keys, no `DATABASE_URL`/`SUPABASE_ACCESS_TOKEN`
  present), so it cannot confirm how, only that the end state matches 0155's intended shape for the
  tables it could inspect over PostgREST.

**Conclusion for B2:** most of the "additive migration + constraints" work mission §5/§6 asks for
already exists and is already live. What is missing from the schema, based on this session's
inspection, is metadata the mission explicitly lists that isn't yet present: provider symbol,
frequency/timezone/calendar, base date, history-start/launch/backtested-through dates, methodology
URL/version, and the source-entitlement fields beyond the `licence_status`/`lifecycle_status`
enums already seen. A future B2 dispatch should diff the mission's exact §5 field list against the
current live DEV column set (this dispatch did not do a full column-by-column diff — it inspected
one representative row's keys, not the full DDL history across every ALTER since 0043) before
writing a new migration, to add only what's truly missing rather than duplicating existing columns.

## 3. Existing benchmark logic and governance code (do not re-implement)

- `lib/engines/investment-intelligence/benchmarkEngine.ts` and `benchmarkService.ts` — the R4/R5
  certified engine: `resolveBenchmarkForDate`, `blendedBenchmarkReturn`, `activeReturn`. This is
  described in-code (see `lib/services/investment-intelligence/pc6/benchmarkGovernance.ts` header)
  as the authoritative arithmetic layer; a future dispatch must not duplicate XIRR/TWRR/benchmark
  math here.
- `lib/services/investment-intelligence/pc6/benchmarkGovernance.ts` (301 lines) — PC6's pure
  governance-decision logic for **which** benchmark a scheme is entitled to and on what authority
  (mapping rules version `pc6-benchmark-mapping-v1`), explicitly scoped to not re-implement R4/R5
  arithmetic. This looks like the natural home for mission §6's mapping-review/evidence logic.
- `lib/services/benchmarkGovernance.ts` (51 lines, repo root `lib/services/`, **not** under
  `investment-intelligence/`) is a **different, unrelated system** — it validates
  `benchmark_datasets`/`benchmark_sources` for a financial-planning-target Admin feature (DTI/DSR
  benchmark ranges), not investment index data. See `SOURCE_DECISION.md` §7 for the naming-collision
  writeup; a future dispatch should not conflate the two.
- `docs/investment-intelligence/R4_BENCHMARK_METHODOLOGY.md` and
  `R12_PERFORMANCE_AND_BENCHMARK_INTEGRATION.md` already document return-type/TRI handling and
  record that R12 (direct-equity) deliberately left `ii_instrument_benchmarks` untouched rather than
  inventing an equity benchmark — consistent with mission §5's "no automatic generic substitution."

## 4. The five consumer screens — current real state (mission §1/§12)

| File | Current benchmark wiring found |
|---|---|
| `components/investment-intelligence/PerformanceClient.tsx` | **Substantially wired.** Real typed fields: `blendedBenchmarkReturn`, `activeReturn` (with `benchmarkKey`), `performanceVsBenchmarkSeries`, `contributingBenchmarks`. This is R4/R5 output already flowing through, per memory ("Investment Intelligence R4/R5 — FULL PASS"). |
| `components/investment-intelligence/SipIntelligenceClient.tsx` | **Substantially wired.** `benchmarkSip` (rate/terminalValue/benchmarkKey/benchmarkReturnType) and `wealthComparison` (contributed/actual/benchmark ending value + difference) are real typed outcomes, with an explicit in-code comment that SIP benchmark comparison must only ever be shown as "excess return," never conflated with plain CAGR difference — matches mission §11's XIRR-vs-CAGR distinction. |
| `components/investment-intelligence/OverviewClient.tsx` | **Not wired.** Only descriptive marketing copy ("compare them with their benchmarks") — no real benchmark value, coverage state, or aggregate method is rendered here yet. This is the gap mission §12 calls "honest portfolio coverage and supported aggregate method." |
| `components/investment-intelligence/PortfolioXrayClient.tsx` | **Not wired.** Only one code comment referencing a past "0% holdings coverage must not render as [zero]" lesson; no actual benchmark context/coverage UI found. |
| `components/investment-intelligence/HoldingsTable.tsx` | **Not wired.** Full column header list inspected (Scheme, Folio, ISIN, Registrar, Cost value, Units, NAV date, NAV, Market value, Gain/Loss, Return %, XIRR, Data quality) — there is **no benchmark column at all**. Mission §12 requires "exact primary benchmark, comparable return, and unavailable reason" per row here; none of that exists yet. |

Net: 2 of 5 consumers (Performance, SIP) already have real, previously-certified benchmark
plumbing; the other 3 (Overview, Portfolio X-Ray, Holdings Table) have no real integration and are
where B5 consumer work genuinely needs to start once B2–B4 produce real data to show.

## 5. Source procurement (mission §2/§3)

See `SOURCE_DECISION.md`, written this session. Headline: all three official reference URLs the
mission lists failed to load in this environment (timeout / connection reset / connection refused)
on a genuine read-only fetch attempt — no terms or pricing were retrieved, and none are fabricated
here. The comparison matrix mission §3 asks for is deliberately left blank rather than invented.
This mission remains **source-blocked** for real ingestion until either a working fetch path to
those pages, or PO/manual retrieval of current terms, is available. No vendor outreach or purchase
was attempted or is recommended by this document, per this dispatch's own operating constraints.

## 6. Held-instrument demand (mission §6)

`ii_scheme_master` (14,374 rows in DEV, 14,401 in production) was inspected directly. It has
**no declared-benchmark field** — confirmed empirically, not assumed. Its columns are pure
identity/classification (AMFI code, ISIN, AMC name, category/sub-category, plan/option,
lifecycle/effective-dating). This validates the mission's own instruction not to assume NAV/scheme
master data carries a benchmark disclosure. A real mapping pass still needs AMC
factsheets/addenda as the authority, which was out of scope for this B1 dispatch.

## 7. Admin operations (mission §13) — read against the mandatory Admin standard

`docs/admin/FHIP_ADMIN_ARCHITECTURE_STANDARD.md` was read in full this session (required before any
Admin-touching work, per `AGENTS.md`/`CLAUDE.md`). Key controls a future B2/B3/B4 dispatch building
the benchmark Admin views must satisfy, specifically:
- §2/§5: a **new, separately named capability** (e.g. `benchmark_catalogue_admin`,
  `benchmark_mapping_review`) — not reuse of any existing broad Admin flag, and Analyst must remain
  read-only per §5's explicit "must not... alter Benchmarks" clause (note: that clause already
  anticipates *this* mission's benchmark domain, not just the unrelated `benchmark_datasets`
  system).
- §6: any cross-user aggregate (e.g. "N holdings mapped, M ambiguous") must go through a
  `SECURITY DEFINER` RPC with the full checklist in §6, not a bare view.
- §11: the CSV import/preview path mission §13 asks for must satisfy the export/import safe-data
  requirements (formula-injection neutralisation, column allow-list, audit).
No Admin code was written this dispatch — this section is scoping notes for the dispatch that
does write it.

## 8. What was not attempted and why

- **No migration was written or applied.** This dispatch has read-only PostgREST access only
  (confirmed: no `DATABASE_URL`/`SUPABASE_ACCESS_TOKEN`/management token in `.env.local`), and a
  full column-by-column diff against the mission's exact §5 metadata list was not completed in the
  time available — writing a migration without that diff risks re-adding columns that already
  exist (as very nearly happened here: 0043 already covers much of what a naive reading of §5 would
  re-propose).
- **No provider adapter, CSV importer, cron job, or Admin UI was built.** All of B4–B7 depend on
  either a real source decision (§5 above, blocked) or a completed B2 schema diff. Building ahead
  of either risks duplicating the existing `benchmarkEngine`/`benchmarkGovernance` work or the
  Admin-standard violations flagged in §7.
- **No DEV writes were made**, even though DEV read/write is authorized for this mission's B6
  stage — B6 (genuine DEV certification) is not reachable before B2–B4 produce something real to
  certify. The one DEV action worth doing now (Product-Owner-approved cleanup of the 14+199+14
  synthetic test rows) was **not** performed, since it is a write action beyond this dispatch's
  discovery scope and the mission's own escalation rule calls for naming it rather than guessing.

## 9. Decisions needed from the Product Owner before the next dispatch

1. **Source procurement**: authorize actually visiting/re-fetching the NSE Indices and AMFI pages
   (or provide current terms text), since automated fetch failed in this environment — this blocks
   real progress on §2/§3/§4 of the mission (source decision, adapters, ingestion).
2. **DEV cleanup**: approve deleting the 14 synthetic `ii_benchmarks` rows, 199 synthetic
   `ii_benchmark_series` rows, and 14 synthetic `ii_instrument_benchmarks` rows in DEV before any
   real catalogue seeding, so future certification isn't confused by leftover test pollution.
3. **Scope confirmation** on the naming collision in `SOURCE_DECISION.md` §7 — confirm the existing
   `benchmark_datasets`/`AdminBenchmarksClient.tsx` system should stay untouched and separate from
   this mission's `ii_benchmarks` Admin surface, per this dispatch's reading of mission §13.
