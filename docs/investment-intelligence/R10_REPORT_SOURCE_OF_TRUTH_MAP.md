# II-R10 — Report Source-of-Truth Map

Per spec section 17. Two parts: (A) metrics **already** wired into the report
today (verified against the real code path), and (B) metrics the spec
requires that are **not yet wired** — the concrete integration points a
future session needs, so the next pass doesn't have to re-derive them.

May R10 recalculate any of these? **No, for all rows in both tables** (spec
section 4). Everything below is "select, format, narrate, package" only.

## A. Already wired (verified in `reportSnapshotResolver.ts` / `reportSectionsPremium.ts`)

| Report metric | Canonical owner | API/service | Version field | Recalculated by R10? |
|---|---|---|---|---|
| Net worth, assets, liabilities | Dashboard/core | `loadDashboard()` | `report_snapshots.snapshot_type='financial'`, `source_version='dashboard-1.0.0'` | NO |
| Financial Health Score | Score engine | `loadHealthScore()` | `healthScore.modelVersion` → `report_snapshots` | NO |
| Resilience / emergency fund | Resilience engine | `loadResilience()` | `resilience.modelVersion` → `report_snapshots` | NO |
| Financial DNA | DNA engine | `loadFinancialDna()` | `dna.modelVersion` → `report_snapshots` | NO |
| Goals (FHIP Goals module) | Goals engine | `computeGoalsPagePayload()` | carried in `source.goals`, no separate snapshot row today (gap: goals has no `report_snapshots` row of its own — see part B) | NO |
| Forecast (non-II forecasting engine) | Forecasting engine | `buildForecastReportData()` | carried in `source.premium.forecastReportData` | NO |
| Investment holdings (raw list) | `investments` table | direct `.eq('user_id',...)` read | none — raw rows, not an analytics result | NO (not a calculation, a list) |
| Recommendations / actions | `action_recommendation_master` | `buildReportActionMatches()` | none recorded | NO |
| Report narrative copy | `report_content_library` | `loadReportContent()` | none recorded | NO |

## B. Required by spec, not yet wired (the real R10 scope gap)

| Report metric | Canonical owner (confirmed by discovery) | Concrete read path for the next session | May R10 recalculate? |
|---|---|---|---|
| XIRR / TWRR / CAGR / benchmark comparison | II-R4 Performance & Benchmark engine | `lib/services/investment-intelligence/analyticsRepository.ts::loadAnalyticsDataset()` (reads persisted `ii_analytics_results`-family rows — **never** call `lib/engines/investment-intelligence/PerformanceEngine.ts`/`xirr.ts`/`twrr.ts` directly, that would be recalculation) | **NO** |
| SIP consistency / interruption / SIP vs benchmark | II-R5 SIP Intelligence | `lib/services/investment-intelligence/r5Repository.ts` (persisted SIP analytics) | **NO** |
| Portfolio X-Ray (look-through, overlap, sector, concentration) | II-R5 X-Ray | `r5Repository.ts` X-Ray read functions | **NO** |
| Realised gains, STCG/LTCG, tax lots, exit-load exposure | II-R6 Tax & Cost engine | `lib/services/investment-intelligence/taxRepository.ts` | **NO** |
| Priority review items / severity / status | II-R9 Review Centre | `lib/services/investment-intelligence/reviewCentreData.ts` (already has the exact "read own, narrow authenticated-write trigger" RLS pattern R10's own security fix now mirrors on the reports family) | **NO** |
| Goal allocation ↔ investment linkage | II-R3 Publishing bridge | `lib/services/investment-intelligence/goalAllocations.ts` | **NO** |

## Integration shape for the next session (not implemented this session)

1. Extend `PremiumSourceData` (`reportSnapshotResolver.ts`) with five new
   optional fields — `investmentPerformance`, `sipAnalytics`, `xray`,
   `taxAndCost`, `reviewItems` — populated via the five read paths above,
   `null`/omitted per spec section 28 when the user has no data for that
   module (never a page of zeros).
2. For every populated field, insert one `report_snapshots` row recording
   `snapshot_type` (`'ii_performance'`/`'ii_sip'`/`'ii_xray'`/`'ii_tax'`/
   `'ii_review'`), the source service's own result/version id, and
   `source_as_of_date` — satisfying spec sections 66-68 (provenance) before
   a single new chapter is rendered.
3. Add corresponding chapter builders to `reportSectionsPremium.ts`,
   following the file's existing `BuiltSection` shape exactly (so PDF/preview
   parity — spec section 80 — is automatic, since both already render off
   the same `BuiltSection[]`).
4. Add data-assembly tests asserting `builtSection.sectionData.xirr ===
   liveAnalyticsRow.xirr` (byte-for-byte, not reformatted) — spec section
   112's "source-module assertion".
