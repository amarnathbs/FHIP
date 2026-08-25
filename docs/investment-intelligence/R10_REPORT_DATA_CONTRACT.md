# II-R10 — Report Data Contract

## Architecture (spec section 14, confirmed pre-existing + extended)

```
Canonical Engines (Dashboard, Health Score, Resilience, DNA, Goals,
Forecasting, II-R4/R5/R6/R9)
        |
        v
Report Data Assembler: resolveReportSourceData()  [lib/services/reportSnapshotResolver.ts]
   -> ReportSourceData { ..., premium: PremiumSourceData | null }
   -> PremiumSourceData now also carries (this session):
        investmentPerformance | sip | xray | taxAndCost | reviewItems
        (each null-safe, populated via lib/services/investmentIntelligenceReportData.ts)
        |
        v
Section Builders: buildReportSections() / buildPremiumSections()
   [lib/engines/reportSections.ts, lib/engines/reportSectionsPremium.ts]
   -> BuiltSection[] (18 Premium / 14 Free), including 5 new II chapters
        |
        v
Persistence: generateReport()  [lib/services/reportsData.ts]
   -> reports / report_sections / report_snapshots rows (service-role only,
      as of migration 0070)
        |
        v
Presentation: ReportPreview.tsx (in-app) <-- same BuiltSection[] --> print
   route --> Playwright PDF (reportPdfRenderer.ts)
```

One assembler, one snapshot, one presentation contract, consumed
identically by preview and PDF — unchanged principle from the pre-existing
architecture, now extended to cover 5 more domains.

## What R10 added this session

- 5 new fields on `PremiumSourceData` (nullable, independently populated in
  parallel via `Promise.all`, each internally fail-safe to `null`).
- 5 new `PremiumSectionCode` values + builder functions, all following the
  exact same `BuiltSection` contract as the 13 pre-existing chapters — no
  new data shape was invented.
- 5 new `report_snapshots` rows types (`ii_performance`/`ii_sip`/`ii_xray`/
  `ii_tax`/`ii_review`), following the exact same table/column contract as
  the 3 pre-existing snapshot types.

## What R10 did NOT change

- The `reports`/`report_sections`/`report_snapshots` table schemas
  themselves (no new columns, no new migration beyond the RLS-only
  `0070`).
- The report generation lifecycle/state machine.
- The Free report at all.
- The PDF renderer.
