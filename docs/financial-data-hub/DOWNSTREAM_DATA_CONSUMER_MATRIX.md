# DOWNSTREAM_DATA_CONSUMER_MATRIX (first version, WP-02)

This matrix lists every downstream consumer of household financial data, what it reads today on `origin/main` `a115ee5`, and which canonical selector it must switch to. The file:line references come from the stage-1 consumer map (APPROVED_UPLOAD_CANONICAL_DATA_FLOW_MATRIX.md section 8).

**WP-02 switched no consumer.** Status legend: **open** means the consumer still reads the legacy source; **ready** means the selector it needs now exists in `lib/read-models`.

## Selectors (all in `lib/read-models`, server-only)

| Selector | Returns | Notes |
|---|---|---|
| `selectIncome(userId, opts)` | `IncomeReadModel` | Planned `income_sources` plus actual approved bank credits. A payslip and its matched bank credit count as one income event (GAP-01). Variable pay is D-06; unlinked credits are D-07. A null net is unknown (GAP-09). |
| `selectExpenses(userId, { basis })` | `ExpensesReadModel` | Planned, actual and combined figures (see CANONICAL_EXPENSE_DATA_CONTRACT.md). |
| `selectLiabilities(userId, opts)` | `LiabilitiesReadModel` | Balances for every owner. Household debt service is counted once (D-08, D-09). |
| `selectInvestments(userId, opts)` | `InvestmentsReadModel` | The published total, plus an "Imported, not yet in Net Worth" bucket (D-05). |
| `selectRetirement(userId, opts)` | `RetirementReadModel` | Converted balances. A contribution with a null frequency is unknown, not monthly. |
| `selectAssets(userId, opts)` | `AssetsReadModel` | The register, plus a "Bank balance per statement — not in Net Worth" evidence bucket (D-04). |
| `buildCanonicalFinancialSnapshot(userId, opts)` | every selector above | Loads one FX rate, one window and one ledger per request. Each section is separately ok or unavailable. |

## Consumers

| Consumer | Meaning | Legacy source (a115ee5) | Canonical source | Basis | Gap | Owner | Status |
|---|---|---|---|---|---|---|---|
| Dashboard `loadDashboard` / `computeDashboard` | gross / net income | `income_sources` (dashboardData.ts:130, no currency) + current-month bank income added to gross and net | `selectIncome().combined` | combined | DC-01, DC-02, GAP-01, GAP-03, GAP-09 | WP-03 | ready |
| Dashboard | expenses, surplus, savings rate, essential / lifestyle, top expenses | `expense_items` + current-month bank actuals, ignoring dedup, allocations and refund links (dashboardData.ts:203-213, 266-280) | `selectExpenses({ basis: 'combined' })` | combined | DC-01, DC-02, DC-03, DC-11, EXP-G2..G9 | WP-03 | ready |
| Dashboard | debt service / DSR | `monthly_repayment` + bank interest and fees (dashboard.ts:735, 743) | `selectLiabilities().householdDebtServiceMonthly` | actual replaces contractual | DC-06, EXP-G7, G9 | WP-03 | ready |
| Dashboard | assets / investments / retirement / Net Worth | registers, partly converted (dashboard.ts:816-853) | `selectAssets`, `selectInvestments().publishedTotal`, `selectRetirement` | — | DC-08, DC-12, DC-16 | WP-03 | ready |
| Dashboard | `hasIncome` / `hasExpenses` | manual rows only (dashboard.ts:1302-1303) | `flags.hasAny` on the income and expense models | — | DC-05, EXP-G6 | WP-03 | ready |
| Dashboard | `financial_snapshots` history | upserted on every load, errors ignored (dashboardData.ts:308-330) | combined values over complete covered months | combined | DC-01, DC-14 | WP-03 | ready |
| Health Score, DNA, Resilience, Goals, Recommendations, AI context, section status | everything above | `loadDashboard` called up to twice per request (healthScoreData.ts:64, 70; resilienceData.ts:68) | `buildCanonicalFinancialSnapshot` | combined | DC-14, DC-15, DC-18 | WP-04 | ready |
| Financial Twin / benchmark | income band, expense ratio, housing, remittance, Net Worth | private loader (twinData.ts:137-144, 255-289), no bank data, no superseded flag, raw currency sums | snapshot; expenses by group | combined | DC-04, DC-13, GAP-02, EXP-G10 | WP-05 | ready |
| Forecast | baseline income and expense, contributions | `loadDashboard`; contributions not converted; null frequency treated as monthly (forecastData.ts:403, 691, 922, 1500-1552) | snapshot: planned basis for projection, actual for variance display, combined essentials for the resilience baseline | planned / actual | DC-13, DC-14, GAP-RET-02 | WP-05 | ready |
| Reports (free + premium) | appendix line items, Net Worth, staleness | reportSnapshotResolver.ts:345-371 (includes superseded rows, no bank, no currency); freshness from manual registers only (:158-166, 203-207) | snapshot; appendix lists planned and actual lines with provenance; staleness includes `approved_at`, allocations, ii publications, applications | combined | DC-09, DC-10, EXP-G11 | WP-06 | ready |
| Expenses tab | imported actuals shown alongside the plan | `expense_items` grid only (expenses/page.tsx:12-17, 55) | `selectExpenses().actual` + `combined.byGroup[].varianceMonthly` | actual | EXP-G1, DC-17 | WP-07 | ready |
| Income tab | payslip provenance badge, "Actual income" section | grid only (income/page.tsx:57) | `selectIncome().planned.lines[].provenance`, `.actual.lines` | actual | GAP-06 | WP-07, WP-09 | ready |
| Liabilities tab | statement provenance, due date, masked identifier | grid only | `selectLiabilities().lines[].provenance` | — | G7 | WP-07, WP-11 | ready |
| Investments tab | imported but not yet published | `investments` only | `selectInvestments().unpublished` | — | INV-G1, DC-08 | WP-12 | ready |
| Retirement tab | imported provenance, contribution history | grid only | `selectRetirement().lines[].provenance`; history is WP-13 evidence | — | GAP-RET-03, GAP-RET-08 | WP-07, WP-13 | ready (badge) |
| FDH Activity / Category review | one spending and refund rule | own constants (categoryReview.ts:73, 437; approvedSummary.ts) | import `lib/read-models/core/spendingRules` | actual | EXP-G9 | WP-08 | ready |

## Direct `fdh_*` reads outside the FDH module

| Reader | Tables | Justification / plan |
|---|---|---|
| `lib/services/dashboardData.ts:205, 216, 268` | `fdh_transactions` | To be removed by WP-03, which switches to `lib/read-models`. |
| `lib/read-models/core/ledger.ts`, `corroboration.ts`, `assets.ts` | `fdh_transactions`, `fdh_transaction_allocations`, `fdh_transaction_links`, `fdh_financial_accounts`, `fdh_statement_uploads`, `fdh_categories`, `fdh_subcategories`, `fdh_reconciliation_results`, `fdh_payroll_events`, `fdh_*_statement_activities`, `fdh_*_statements` | **Justified.** These are the canonical approved-event layer and its evidence, read through one audited module. Every read is paged and user-scoped, and a failure returns `unavailable`. The only import from the FDH module is its economic-type vocabulary (`core/spendingRules.ts`, one fdh1Isolation allow-list entry). |
