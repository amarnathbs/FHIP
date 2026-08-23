# II-R10 — Report Architecture Discovery (P0)

Status: **DISCOVERY COMPLETE**. This document records what R10 found before writing any
implementation code, per spec sections 10-13.

## 1. Existing report infrastructure (mature, pre-dates R10)

Module 9 (`supabase/migrations/0010_module9_reports.sql`) already built a complete,
well-designed report data model, long before Investment Intelligence existed:

| Table | Purpose |
|---|---|
| `user_entitlements` | free/premium plan tier, effective-dated |
| `reports` | one row per generated report, versioned, `revises_report_id` chain, immutable-once-published |
| `report_sections` | structured per-section content (`section_data_json`, `narrative_text`, `chart_data_json`, `source_references_json`) |
| `report_snapshots` | explicit provenance rows: `snapshot_type`, `source_version`, `source_as_of_date` |
| `report_exports` | export/PDF request lifecycle, `render_token`/`render_token_expires_at` (added 0022/0024) |
| `report_generation_runs` | audit trail per generation attempt |
| `report_access_events` | view/print/export/download audit trail |

Subsequent work (visible in `git log`) already delivered a real PDF pipeline and a
"Free Report v2" redesign, confirming the orchestration context's note in section 11:

- `0d2b13a`, `e89e696`, `64b2bab` — Phase 0C completion-state UI + FX bug fixes touching reports
- `ebed8d3` "Free Report: fix pillar area-to-review duplication, compress to 10 pages"
- `d030766` "Free Report: fix pie-chart legend collision, add waterfall legend, compress layout"
- `124be2c` "Fix blank charts in every exported PDF report (recharts animation vs print timing)"
- `0626b52` "Report/Forecasting remediation... Report v3 content-library foundation"

**Existing report source files** (5,691 total lines across engines/services/components):

| File | Lines | Role |
|---|---|---|
| `lib/services/reportsData.ts` | 373 | Orchestrates generation, idempotency, versioning, publish/archive/retry |
| `lib/services/reportSnapshotResolver.ts` | 354 | Assembles `ReportSourceData` from canonical services — never recalculates |
| `lib/engines/reportSections.ts` | 838 | Free-report section builder |
| `lib/engines/reportSectionsPremium.ts` | 625 | Premium-report section builder |
| `lib/engines/reportEligibility.ts` | 159 | Section-level and report-level eligibility rules |
| `lib/engines/reportNarrative.ts` / `reportCopy.ts` / `reportInsights.ts` | 468 | Deterministic narrative/copy generation (content-library backed, not hardcoded per-component strings — Report v3 Phase 3a) |
| `lib/services/reportContentData.ts` | 87 | Loads `report_content_library` (governed storytelling layer, already exists) |
| `lib/services/reportPdfRenderer.ts` | 80 | Playwright headless-Chromium PDF renderer against the report's own print route |
| `components/reports/ReportPreview.tsx` | 1,350 | In-app preview — same presentation contract the PDF renders |
| `components/reports/ReportV2Charts.tsx` | 353 | Chart components |
| `app/api/reports/**` | 12 routes | generate/list/get/publish/revise/retry/sections/sources/methodology/exports |
| `app/(app)/reports/**`, `app/(print)/reports/**` | 3 routes | preview + print view (PDF source) |

`resolveReportSourceData` (the assembler) already threads a single `asOfDate`,
correctly separates free vs. premium queries (premium-only queries are skipped
entirely for free-tier users, not just hidden), and already reuses canonical
service functions (`loadDashboard`, `loadHealthScore`, `loadResilience`,
`loadFinancialDna`, `computeGoalsPagePayload`, `buildForecastReportData`,
`loadReportContent`, `buildReportActionMatches`) rather than querying raw
tables and recalculating — i.e. the "Report Data Assembler" the spec asks for
(section 14) already exists as a real, working component.

## 2. The real gap: zero Investment Intelligence integration

```
grep -rlE "r4_performance|r5_sip|r5_xray|r6_tax|review_centre|ii_r4|ii_r5|ii_r6|ii_r9|investment.?intelligence" \
  lib/engines/report*.ts lib/services/report*.ts components/reports/*.tsx
```
returns **zero matches**. None of R4 (Performance/Benchmark), R5 (SIP/X-Ray), R6
(Tax & Cost), or R9 (Goals/Forecasting/Review Centre) output is referenced
anywhere in the report engines, services, or components. The Premium report
today covers: financial position, income/expense, assets/liabilities,
investments (raw rows, no performance analytics), insurance, retirement,
goals (from the FHIP Goals module, not R9's forecast-integrated view), and
forecast (via `buildForecastReportData`, itself a separate, non-II
forecasting engine). This is the core scope gap R10 exists to close (spec
sections 3, 4, 19, 26-27, 37-50, 93) and was **not implemented this
session** — see `R10_ACCEPTANCE_REPORT.md` for the honest disclosure of why,
and `R10_REPORT_SOURCE_OF_TRUTH_MAP.md` for the concrete integration points
identified for whoever picks this up next.

## 3. A real, serious, pre-existing defect found during discovery

While auditing the reports table family's RLS (spec section 8's "audit...
subscriptions/entitlements, storage... migration namespace" and section
73-78's security mandate), discovery uncovered that
`reports`/`report_sections`/`report_snapshots`/`report_exports`/
`report_generation_runs`/`report_access_events` have carried a single
`for all using (auth.uid() = user_id) with check (auth.uid() = user_id)`
RLS policy since migration `0010` (pre-dates Investment Intelligence
entirely) — the exact same-user authoritative-write defect class this
project has already found and fixed repeatedly elsewhere (`ii_review_items`
0069, `ii_tax_lots`/`ii_capital_gains_computations` 0062,
`fdh_statement_uploads.reconciliation_status` 0065). This was reproduced
live against real DEV this session (5/5 attacks succeeded) and fixed —
see `R10_REPORT_SECURITY_MODEL.md` for full detail. This became the
session's primary substantive deliverable once found, both because it sits
squarely inside R10's own explicit security mandate and because sections
190-191 make it a hard, non-conditional blocking category.

## 4. Report calculation dependencies (as they exist today)

`ReportSourceData` already carries: `dashboard` (net worth, cash flow),
`healthScore`, `resilience`, `dna`, `goals` (FHIP Goals payload),
`financialTwin`, `planTier`, `premium.forecastReportData`,
`premium.goalsOnTrackHistory`, `commitments`, `content`
(`report_content_library`), `actionRecommendations`
(`action_recommendation_master`, pillar-triggered). None of these are
recalculated inside the report layer — every one is loaded via the same
`load*`/`compute*` function the source module's own page uses.

## 5. Subscription/entitlement model

`user_entitlements.plan_tier` (`free`/`premium`, effective-dated) is the
single canonical entitlement source. `lib/services/entitlements.ts` exposes
`getPlanTier()` (read) and `canExportReports()` (a stricter, PDF-specific
gate — see `app/api/reports/[id]/exports/route.ts`). No second billing/price
model exists in the reports code; R10 does not need to invent one (spec
sections 56-57 already satisfied by existing code).

## 6. Report versioning / storage / country formatting (as they exist today)

- Versioning: `version_number` + `revises_report_id` chain, `status` enum
  (`draft/queued/generating/ready/published/failed/revised/superseded/archived`),
  `template_version`/`disclaimer_version` columns — already matches spec
  sections 61-69's intent structurally.
- Storage: private `report-exports` Storage bucket, service-role-only
  uploads, owner-only `storage.objects` SELECT policy (migration `0022`) —
  already matches spec sections 70-71.
- Country formatting: `reportSourceData.currency`/`profile.preferredCurrency`
  threaded through `reportSectionsPremium.ts`'s FX-aware totals (the
  `fxRateAudInr` field exists specifically because of a prior P0 fix for
  cross-border investment totals — see `PremiumSourceData.fxRateAudInr`'s
  own code comment).

## 7. R10-P0 hard decision (spec section 13)

| Capability | Decision | Reason |
|---|---|---|
| Report data model (`reports`/`report_sections`/`report_snapshots`/`report_exports`/`report_generation_runs`/`report_access_events`) | **REUSE** (with security **EXTEND**) | Structurally sound, matches the spec's own target architecture; only RLS needed hardening |
| Report data assembler (`resolveReportSourceData`) | **REUSE / EXTEND** | Already the correct single assembler pattern; needs new fields added for II chapters, not a rewrite |
| Free report engine (`reportSections.ts`) | **REUSE** | Already went through a dedicated compression/redesign pass this project (`ebed8d3`, `d030766`) — out of scope to redo |
| Premium report engine (`reportSectionsPremium.ts`) | **EXTEND** (not done this session) | Needs new chapters for R4/R5/R6/R9 — zero conflicting/duplicate implementation exists to REPLACE |
| PDF renderer (`reportPdfRenderer.ts`, Playwright/Chromium) | **REUSE** | Already a real, working, print-route-driven pipeline; matches spec section 79's own preference for the existing stack |
| Storytelling layer (`report_content_library`, `reportContentData.ts`, `reportNarrative.ts`) | **REUSE** | Already the single governed narrative layer the spec asks for (section 33-36) |
| Entitlement/subscription model | **REUSE** | Already canonical, single-sourced; no duplicate billing logic to remove |
| Reports table RLS | **REPLACE** (done this session) | The single permissive policy was a genuine security defect, not a design to extend |

No competing/duplicate premium-report implementation was found anywhere in
the repository — there is exactly one `reportSectionsPremium.ts`.
