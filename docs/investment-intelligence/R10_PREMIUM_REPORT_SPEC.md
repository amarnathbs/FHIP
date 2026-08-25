# II-R10 — Premium Report Spec (as-built)

## Chapter list (18 sections, `lib/engines/reportSectionsPremium.ts::buildPremiumSections`)

Pre-existing (13, unchanged this session): 12-Month Trends, Full Health
Score Diagnostic, Full Financial DNA, Investment Analysis, Retirement
Readiness, Insurance Analysis, Detailed Goal Forecasting, Scenario
Forecasting, Full Financial Twin, Full Cross-Border Wealth, Financial
Stress Testing, Your Personal Action Plan, Appendices.

New this session (5, Investment Intelligence — the primary R10 objective):

| # | Chapter | Section code | Consumes | Displays |
|---|---|---|---|---|
| 14 | Investment Performance | `investment_performance` | II-R4 `runAnalytics()` | XIRR/TWRR/benchmark per currency portfolio |
| 15 | Contribution (SIP) Behaviour | `sip_contribution` | II-R5 `runSipAnalytics()` | Recurring-contribution consistency + engine observations |
| 16 | Portfolio X-Ray & Diversification | `portfolio_xray` | II-R5 `runXrayAnalytics()` | Sector/security/scheme concentration |
| 17 | Tax & Cost Intelligence | `tax_and_cost` | II-R6 `runTaxSimulation()` | Disposal-level capital gains, exit-load observations |
| 18 | Priority Review Items | `priority_review_items` | II-R9 `listReviewItems()` | Open review items, engine's own severity ordering |

Every new chapter degrades to `sectionStatus: 'unavailable'` with an
explicit `limitationText` when the user has no data for that module (spec
section 28, 39-40) — live-verified this session
(`LIVE-R10-A3`, `R10_ACCEPTANCE_REPORT.md`).

## Executive Financial Review (spec section 16, 29)

Not extended this session — the existing `executive_summary` (Free
section, shared by Premium) does not yet reference the 5 new II chapters'
findings (e.g. does not surface "1 open review item" or "your portfolio's
XIRR is X%" in the opening chapter). This is a genuine gap: the new
chapters exist as standalone content but are not yet cross-referenced from
the report's opening page.

## PDF/preview parity

Both consume the exact same `BuiltSection[]` (spec section 80) — no
separate rendering path exists. Live-verified this session (497KB real PDF
generated with all 18 chapters present, including the 5 new ones in their
`unavailable` state).
