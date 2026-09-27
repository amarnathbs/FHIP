Final-merged-branch re-run (feature/canonical-upload-cert @ 285ac01, migrations 0207-0214 + 0218 on DEV),
single fresh range-A user forecast.tc048@example.test, Household M then Household I sequentially per
neutralise.mjs's documented design (a prior attempt using two separate users -- tc017/tc025 -- was
abandoned because it confounded the comparison with each user's own unrelated standing fixture data; see
the mission report). RESULT: every headline consumer is $0 except Score and Twin -- see the note at the
bottom of this file for the root cause.

| Consumer | Metric | M | I | Diff |
|---|---|---|---|---|
| Income | gross monthly (Dashboard) | 6700 | 6700 | 0 |
| Income | net monthly (Dashboard) | 5000 | 5000 | 0 |
| Income | combined gross (income read model) | 6700 | 6700 | 0 |
| Income | combined net (income read model) | 5000 | 5000 | 0 |
| Expenses | combined monthly (Dashboard basis) | 2916.5517 | 2916.5517 | 0 |
| Expenses | combined monthly (expense read model) | 2916.5517 | 2916.5517 | 0 |
| Expenses | essential monthly | 2916.5517 | 2916.5517 | 0 |
| Expenses | lifestyle monthly | 0 | 0 | 0 |
| Expenses | planned monthly (M: typed; I: WP-15 averages applied) | 2916.5517 | 916.55 | -2000.0017 (explained: BASIS (contract section 5): M typed a PLAN; I has approved ACTUALS and applied the WP-15 average only for groceries (rent is category-only -- GP-O3). The combined basis every consumer uses is equal.) |
| Expenses | actual monthly (approved statements) | 0 | 2916.5517 | 2916.5517 (explained: BASIS: M has no statements by definition; the combined basis is equal.) |
| Assets | total assets (core) | 21807.58620689655 | 21807.58620689655 | 0 |
| Assets | assets + investments + retirement | 135951.33620689655 | 135951.33620689655 | 0 |
| Liabilities | total liabilities | 399950 | 399950 | 0 |
| Liabilities | debt service monthly (D-08/D-09) | 2000 | 2000 | 0 |
| Liabilities | register balance sum (Liabilities tab) | 399950 | 399950 | 0 |
| Investments | total investments | 12500 | 12500 | 0 |
| Investments | register value sum (Investments tab) | 12500 | 12500 | 0 |
| Investments | imported, not yet in Net Worth | 0 | 0 | 0 |
| Retirement | total retirement | 101643.75 | 101643.75 | 0 |
| Retirement | employer contribution monthly | 575 | 575 | 0 |
| Net Worth | Dashboard net worth | -263998.6637931034 | -263998.6637931034 | 0 |
| Cashflow | monthly surplus | 83.44830000000002 | 83.44830000000002 | 0 |
| Cashflow | savings rate | 0.016689660000000002 | 0.016689660000000002 | 0 |
| Cashflow | debt service ratio | 0.4 | 0.4 | 0 |
| Cashflow | debt to income | 4.974502487562189 | 4.974502487562189 | 0 |
| Cashflow | emergency fund months | 7.47718142863593 | 7.47718142863593 | 0 |
| Score | overall health score | 45.52100000000001 | 46.24400000000001 | 0.723 |
| DNA | primary profile | "future_ready_professional" | "future_ready_professional" | 0 |
| DNA | primary score | 90.89 | 90.89 | 0 |
| DNA | confidence | 79.9725 | 79.9725 | 0 |
| Resilience | overall score | 69.64 | 69.64 | 0 |
| Resilience | accessible liquid resources | 21807.58620689655 | 21807.58620689655 | 0 |
| Twin | metrics compared | 54 | 54 | 0 |
| Twin | ahead / aligned / behind | "8 / 0 / 23" | "8 / 0 / 22" | DIFFERENT |
| Twin | overall confidence | 55.9 | 55.9 | 0 |
| Forecast | net worth run input hash | "ed05089a02e6" | "ed05089a02e6" | 0 |
| Forecast | resilience run input hash | "21c828615cec" | "21c828615cec" | 0 |
| Forecast | retirement run input hash | "62236f10cf61" | "62236f10cf61" | 0 |
| Report | net worth (report net_worth section) | -263998.6637931034 | -263998.6637931034 | 0 |
| Liabilities | rows: type/balance/rate/repayment/min/limit/owner/currency | "\"credit_card\"|1500|null|0|30|5000|\"self\"|\"AUD\"|\"AU\" ; \"mortgage\"|398450|6.14|2000|null|null|\"self\"|\"AUD\"|\"AU\"" | "\"credit_card\"|1500|null|0|30|5000|\"self\"|\"AUD\"|\"AU\" ; \"mortgage\"|398450|6.14|2000|null|null|\"self\"|\"AUD\"|\"AU\"" | 0 |
| Assets | rows: class/value/currency/country/owner | "\"cash\"|20180|\"AUD\"|\"AU\"|\"self\" ; \"cash\"|94400|\"INR\"|\"IN\"|\"spouse\"" | "\"cash\"|20180|\"AUD\"|\"AU\"|\"self\" ; \"cash\"|94400|\"INR\"|\"IN\"|\"spouse\"" | 0 |
| Income | rows: type/gross/net/frequency/currency/owner | "\"salary\"|6700|5000|\"monthly\"|\"AUD\"|\"self\"" | "\"salary\"|6700|5000|\"monthly\"|\"AUD\"|\"self\"" | 0 |
| Retirement | rows: balance/currency/country/owner | "101643.75|\"AUD\"|\"AU\"|\"self\"" | "101643.75|\"AUD\"|\"AU\"|\"self\"" | 0 |
| Dashboard | liabilityByType (as a set) | "{\"debtType\":\"credit_card\",\"balance\":1500} ; {\"debtType\":\"mortgage\",\"balance\":398450}" | "{\"debtType\":\"credit_card\",\"balance\":1500} ; {\"debtType\":\"mortgage\",\"balance\":398450}" | 0 |
| Dashboard | assetsByCountry (as a set) | "{\"countryCode\":\"AU\",\"value\":20180} ; {\"countryCode\":\"IN\",\"value\":94400}" | "{\"countryCode\":\"AU\",\"value\":20180} ; {\"countryCode\":\"IN\",\"value\":94400}" | 0 |
| Dashboard | netWorthByCountryConverted (as a set) | "{\"countryCode\":\"AU\",\"value\":-278126.25} ; {\"countryCode\":\"IN\",\"value\":1627.5862068965516}" | "{\"countryCode\":\"AU\",\"value\":-278126.25} ; {\"countryCode\":\"IN\",\"value\":1627.5862068965516}" | 0 |
| Dashboard | countriesInUse (as a set) | "\"AU\" ; \"IN\"" | "\"AU\" ; \"IN\"" | 0 |
| Forecast | net worth projected results | "120 rows; sha 29706089977ad83a" | "120 rows; sha 29706089977ad83a" | 0 |
| Forecast | resilience projected results | "120 rows; sha face9ba970a6ff8e" | "120 rows; sha face9ba970a6ff8e" | 0 |
| Forecast | retirement projected results | "120 rows; sha 517d5c08f610ec8f" | "120 rows; sha 517d5c08f610ec8f" | 0 |
| Forecast | debt projected results | "240 rows; sha 671e9e26ce574695" | "240 rows; sha 671e9e26ce574695" | 0 |
| Forecast | investment projected results | "120 rows; sha 9def1dadb07c79c7" | "240 rows; sha 988ca7d1aa88c052" | DIFFERENT (explained: GRANULARITY (GP-O1): 1 manual portfolio line vs 2 imported holdings -> 120 vs 240 entity rows; per-period totals compared below.) |
| Forecast | cross-border projected results | "120 rows; sha 35ffc69d8633d791" | "120 rows; sha 35ffc69d8633d791" | 0 |
| DNA | propertyDebtBreakdown (as a set) | "{\"purpose\":\"consumer\",\"currencyCode\":\"AUD\",\"liabilityCount\":1,\"totalBalance\":1500} ; {\"purpose\":\"owner_occupied\",\"currencyCode\":\"AUD\",\"liabilityCount\":1,\"totalBalance\":398450}" | "{\"purpose\":\"consumer\",\"currencyCode\":\"AUD\",\"liabilityCount\":1,\"totalBalance\":1500} ; {\"purpose\":\"owner_occupied\",\"currencyCode\":\"AUD\",\"liabilityCount\":1,\"totalBalance\":398450}" | 0 |
| Forecast | net_worth per-period totals, 120 periods (max |diff| any column) | "120 periods" | "120 periods" | 0 |
| Forecast | resilience per-period totals, 120 periods (max |diff| any column) | "120 periods" | "120 periods" | 0 |
| Forecast | retirement per-period totals, 120 periods (max |diff| any column) | "120 periods" | "120 periods" | 0 |
| Forecast | debt per-period totals, 120 periods (max |diff| any column) | "120 periods" | "120 periods" | 0 |
| Forecast | investment per-period totals, 120 periods (max |diff| any column) | "120 periods" | "120 periods" | 0.04 (explained: CENT ROUNDING: each entity row is rounded to the cent every period; 2 rows vs 1 row compound to at most 4 cents over 120 months (period 1 and 120 checked by hand: 13.15 + 52.62 = 65.77; 4,692.80 + 18,771.44 = 23,464.24).) |
| Forecast | cross_border per-period totals, 120 periods (max |diff| any column) | "120 periods" | "120 periods" | 0 |

All other leaves: 4128 differing, 2169 identity/clock.
    85  REGISTER ROWS: same economics, different row shape (names, provenance labels, row order/granularity; I stores annual contributions and imported line-by-line rows)
   154  PROVENANCE / EVIDENCE VIEW: imported actual lines, statement links and import history exist only for I (M has none by definition)
    23  EVIDENCE VIEW: bank closing-balance proposals exist only for I (already applied, shown as "Already added")
     5  MANUAL-ENTRY LIMIT (GP-O1): M can hold ONE "groceries" catalogue row; the INR groceries is a custom row that the core-survival rule (keyed by master_item_key) does not recognise; I's INR groceries line is categorised groceries
     1  DESCRIPTOR: the part of combined expenses that came from statements (I 100%, M 0%); the combined total is equal
    48  PRESENTATION: top-N lists name planned ITEMS for M and canonical GROUPS for I; employer name read from the synthetic payslip as "PTY LTD" (parser observation GP-O2)
   128  UNEXPLAINED
     1  DISCLOSURE (D-09): I knows the 430 interest + 20 fee inside the 2,000 repayment from the loan statement; M cannot; debt service is 2,000 in both
     4  MANUAL-ENTRY LIMIT (GP-O1): M records the share portfolio as ONE catalogue line (100% "largest holding"); I imports two holdings (BHP 80%)
     4  FORECAST INPUT HASH: covers row names / row granularity (debt: liability names; investment: 1 vs 2 holdings); the projected results are compared leaf by leaf below
  3639  FORECAST RESULT ROWS: positional leaf diff of entity rows returned in a different order (and, for investment, 1 vs 2 holdings); certified by the order-independent row / per-period-total checks in the table
    36  CLOCK: data-quality "last updated" timestamps of each run
UNEXPLAINED GET /api/dashboard/summary :: data.snapshots[0].monthly_income  M=13750  I=6700
UNEXPLAINED GET /api/dashboard/summary :: data.snapshots[0].monthly_expenses  M=11810  I=4916.55
UNEXPLAINED GET /api/dashboard/summary :: data.snapshots[0].monthly_surplus  M=-535  I=83.45
UNEXPLAINED GET /api/dashboard/summary :: data.snapshots[0].savings_rate  M=-0.0475  I=0.0167
UNEXPLAINED GET /api/dashboard/summary :: data.snapshots[0].fx_rate_aud_inr  M=null  I=58
UNEXPLAINED GET /api/dashboard/summary :: data.snapshots[0].fx_rate_date  M=null  I="2026-09-27"
UNEXPLAINED GET /api/dashboard/summary :: data.dataStatus.window.coveredMonths  M="[]"  I=undefined
UNEXPLAINED GET /api/dashboard/summary :: data.dataStatus.window.coveredMonths[0]  M=undefined  I="2026-08"
UNEXPLAINED GET /api/health-score :: data.overallScore  M=45.52100000000001  I=46.24400000000001
UNEXPLAINED GET /api/health-score :: data.components[0].rawScore  M=48  I=52
UNEXPLAINED GET /api/health-score :: data.components[0].weightedContribution  M=8.675  I=9.398
UNEXPLAINED GET /api/health-score :: data.components[0].currentValue.deficitMonths  M=1  I=0
UNEXPLAINED GET /api/health-score :: data.recommendations[3].estimatedScoreImprovement  M=6.7  I=6
UNEXPLAINED GET /api/health-score :: data.scoreChange  M=-1.0289999999999893  I=-0.3059999999999903
UNEXPLAINED GET /api/health-score :: data.history[1].score_month  M=undefined  I="2026-09-01"
UNEXPLAINED GET /api/health-score :: data.history[1].rounded_score  M=undefined  I=46
UNEXPLAINED GET /api/intelligence/financial-dna :: data.profileChanged  M=true  I=false
UNEXPLAINED GET /api/intelligence/financial-dna :: data.history  M="[]"  I=undefined
UNEXPLAINED GET /api/intelligence/financial-dna :: data.history[0].profile_month  M=undefined  I="2026-09-01"
UNEXPLAINED GET /api/intelligence/financial-dna :: data.history[0].primary_profile_code  M=undefined  I="future_ready_professional"
UNEXPLAINED GET /api/intelligence/financial-dna :: data.history[0].secondary_profile_code  M=undefined  I="debt_constrained_builder"
UNEXPLAINED GET /api/intelligence/financial-dna :: data.history[0].confidence_score  M=undefined  I=79.97
UNEXPLAINED GET /api/resilience :: data.history  M="[]"  I=undefined
UNEXPLAINED GET /api/resilience :: data.history[0].score_month  M=undefined  I="2026-09-01"
UNEXPLAINED GET /api/resilience :: data.history[0].rounded_score  M=undefined  I=70
UNEXPLAINED POST /api/financial-twin/generate :: data.behindCount  M=23  I=22
UNEXPLAINED POST /api/financial-twin/generate :: data.notComparableCount  M=36  I=37
UNEXPLAINED POST /api/financial-twin/generate :: data.metrics[7].status  M="materially_behind"  I="context_required"
UNEXPLAINED POST /api/financial-twin/generate :: data.isFirstTwin  M=true  I=false
UNEXPLAINED POST /api/forecast/run net_worth :: data.reused  M=false  I=true
UNEXPLAINED POST /api/forecast/run resilience :: data.reused  M=false  I=true
UNEXPLAINED POST /api/forecast/run retirement :: data.reused  M=false  I=true
UNEXPLAINED POST /api/forecast/run debt :: data.reused  M=false  I=true
UNEXPLAINED POST /api/forecast/run investment :: data.reused  M=false  I=true
UNEXPLAINED POST /api/forecast/run cross_border :: data.reused  M=false  I=true
UNEXPLAINED POST /api/reports/generate :: data.sections[0].sectionData.metrics[0].current  M=45.52100000000001  I=46.24400000000001
UNEXPLAINED POST /api/reports/generate :: data.sections[0].sectionData.metrics[0].changeAbsolute  M=-1.0289999999999893  I=-0.3059999999999903
UNEXPLAINED POST /api/reports/generate :: data.sections[0].sectionData.metrics[0].changePercent  M=-2.210526315789451  I=-0.65735767991405
UNEXPLAINED POST /api/reports/generate :: data.sections[0].sectionData.metrics[0].displayText  M="−1"  I="−0"
UNEXPLAINED POST /api/reports/generate :: data.sections[0].sectionData.metrics[2].previous  M=-535  I=83.45
UNEXPLAINED POST /api/reports/generate :: data.sections[0].sectionData.metrics[2].changeAbsolute  M=618.4483  I=-0.0016999999999853799
UNEXPLAINED POST /api/reports/generate :: data.sections[0].sectionData.metrics[2].changePercent  M=115.59781308411215  I=-0.0020371479927925465
UNEXPLAINED POST /api/reports/generate :: data.sections[0].sectionData.metrics[2].direction  M="positive"  I="negative"
UNEXPLAINED POST /api/reports/generate :: data.sections[0].sectionData.metrics[2].displayText  M="+$618"  I="−$0"
UNEXPLAINED POST /api/reports/generate :: data.sections[0].sectionData.metrics[2].previousText  M="-$535"  I="$83"
UNEXPLAINED POST /api/reports/generate :: data.sections[0].sectionData.metrics[3].previous  M=-4.75  I=1.67
UNEXPLAINED POST /api/reports/generate :: data.sections[0].sectionData.metrics[3].changeAbsolute  M=6.418966  I=-0.0010339999999997573
UNEXPLAINED POST /api/reports/generate :: data.sections[0].sectionData.metrics[3].direction  M="positive"  I="negative"
UNEXPLAINED POST /api/reports/generate :: data.sections[0].sectionData.metrics[3].displayText  M="+6.4 percentage points"  I="−0.0 percentage points"
UNEXPLAINED POST /api/reports/generate :: data.sections[0].sectionData.metrics[3].previousText  M="-4.8%"  I="1.7%"
UNEXPLAINED POST /api/reports/generate :: data.sections[0].sectionData.metrics[4].previous  M=2.303030303030303  I=4.72636815920398
UNEXPLAINED POST /api/reports/generate :: data.sections[0].sectionData.metrics[4].changeAbsolute  M=2.671472184531886  I=0.24813432835820937
UNEXPLAINED POST /api/reports/generate :: data.sections[0].sectionData.metrics[4].displayText  M="+2.7×"  I="+0.2×"
UNEXPLAINED POST /api/reports/generate :: data.sections[0].sectionData.metrics[4].previousText  M="2.3×"  I="4.7×"
UNEXPLAINED POST /api/reports/generate :: data.sections[3].sectionData.overallScore  M=45.52100000000001  I=46.24400000000001
UNEXPLAINED POST /api/reports/generate :: data.sections[3].sectionData.scoreChange  M=-1.0289999999999893  I=-0.3059999999999903
UNEXPLAINED POST /api/reports/generate :: data.sections[3].sectionData.components[0].rawScore  M=48  I=52
UNEXPLAINED POST /api/reports/generate :: data.sections[3].sectionData.components[0].weightedContribution  M=8.675  I=9.398
UNEXPLAINED POST /api/reports/generate :: data.sections[3].sectionData.components[0].currentValue.deficitMonths  M=1  I=0
UNEXPLAINED POST /api/reports/generate :: data.sections[3].sectionData.recommendations[3].estimatedScoreImprovement  M=6.7  I=6
UNEXPLAINED POST /api/reports/generate :: data.sections[3].chartData.pillars[0].score  M=48  I=52
UNEXPLAINED POST /api/reports/generate :: data.sections[9].sectionData.behindCount  M=23  I=22
UNEXPLAINED POST /api/reports/generate :: data.sections[9].sectionData.insights[5].metricCode  M="positive_cashflow_consistency"  I="housing_cost_ratio"
UNEXPLAINED POST /api/reports/generate :: data.sections[9].sectionData.insights[5].title  M="Opportunity: positive cash-flow consistency"  I="Opportunity: housing-cost ratio"
UNEXPLAINED POST /api/reports/generate :: data.sections[9].sectionData.insights[5].explanation  M="Your positive cash-flow consistency is currently materially behind the available comparison."  I="Your housing-cost ratio is currently materially behind the available comparison."
UNEXPLAINED POST /api/reports/generate :: data.sections[9].narrativeText  M="Your Financial Twin compared 54 metrics against a synthetic peer profile and FHIP planning ranges:   I="Your Financial Twin compared 54 metrics against a synthetic peer profile and FHIP planning ranges: 
UNEXPLAINED GET /api/reports/[id] :: data.sections[0].sectionData.metrics[0].current  M=45.52100000000001  I=46.24400000000001
UNEXPLAINED GET /api/reports/[id] :: data.sections[0].sectionData.metrics[0].displayText  M="−1"  I="−0"
UNEXPLAINED GET /api/reports/[id] :: data.sections[0].sectionData.metrics[0].changePercent  M=-2.210526315789451  I=-0.65735767991405
UNEXPLAINED GET /api/reports/[id] :: data.sections[0].sectionData.metrics[0].changeAbsolute  M=-1.0289999999999893  I=-0.3059999999999903
UNEXPLAINED GET /api/reports/[id] :: data.sections[0].sectionData.metrics[2].previous  M=-535  I=83.45
UNEXPLAINED GET /api/reports/[id] :: data.sections[0].sectionData.metrics[2].direction  M="positive"  I="negative"
UNEXPLAINED GET /api/reports/[id] :: data.sections[0].sectionData.metrics[2].displayText  M="+$618"  I="−$0"
UNEXPLAINED GET /api/reports/[id] :: data.sections[0].sectionData.metrics[2].previousText  M="-$535"  I="$83"
UNEXPLAINED GET /api/reports/[id] :: data.sections[0].sectionData.metrics[2].changePercent  M=115.59781308411215  I=-0.0020371479927925465
UNEXPLAINED GET /api/reports/[id] :: data.sections[0].sectionData.metrics[2].changeAbsolute  M=618.4483  I=-0.0016999999999853799
UNEXPLAINED GET /api/reports/[id] :: data.sections[0].sectionData.metrics[3].previous  M=-4.75  I=1.67
UNEXPLAINED GET /api/reports/[id] :: data.sections[0].sectionData.metrics[3].direction  M="positive"  I="negative"
UNEXPLAINED GET /api/reports/[id] :: data.sections[0].sectionData.metrics[3].displayText  M="+6.4 percentage points"  I="−0.0 percentage points"
UNEXPLAINED GET /api/reports/[id] :: data.sections[0].sectionData.metrics[3].previousText  M="-4.8%"  I="1.7%"
UNEXPLAINED GET /api/reports/[id] :: data.sections[0].sectionData.metrics[3].changeAbsolute  M=6.418966  I=-0.0010339999999997573
UNEXPLAINED GET /api/reports/[id] :: data.sections[0].sectionData.metrics[4].previous  M=2.303030303030303  I=4.72636815920398
UNEXPLAINED GET /api/reports/[id] :: data.sections[0].sectionData.metrics[4].displayText  M="+2.7×"  I="+0.2×"
UNEXPLAINED GET /api/reports/[id] :: data.sections[0].sectionData.metrics[4].previousText  M="2.3×"  I="4.7×"
UNEXPLAINED GET /api/reports/[id] :: data.sections[0].sectionData.metrics[4].changeAbsolute  M=2.671472184531886  I=0.24813432835820937
UNEXPLAINED GET /api/reports/[id] :: data.sections[3].sectionData.components[0].rawScore  M=48  I=52
UNEXPLAINED GET /api/reports/[id] :: data.sections[3].sectionData.components[0].currentValue.deficitMonths  M=1  I=0
UNEXPLAINED GET /api/reports/[id] :: data.sections[3].sectionData.components[0].weightedContribution  M=8.675  I=9.398
UNEXPLAINED GET /api/reports/[id] :: data.sections[3].sectionData.scoreChange  M=-1.0289999999999893  I=-0.3059999999999903
UNEXPLAINED GET /api/reports/[id] :: data.sections[3].sectionData.overallScore  M=45.52100000000001  I=46.24400000000001
UNEXPLAINED GET /api/reports/[id] :: data.sections[3].sectionData.recommendations[3].estimatedScoreImprovement  M=6.7  I=6
UNEXPLAINED GET /api/reports/[id] :: data.sections[3].chartData.pillars[0].score  M=48  I=52
UNEXPLAINED GET /api/reports/[id] :: data.sections[9].sectionData.insights[5].title  M="Opportunity: positive cash-flow consistency"  I="Opportunity: housing-cost ratio"
UNEXPLAINED GET /api/reports/[id] :: data.sections[9].sectionData.insights[5].metricCode  M="positive_cashflow_consistency"  I="housing_cost_ratio"
UNEXPLAINED GET /api/reports/[id] :: data.sections[9].sectionData.insights[5].explanation  M="Your positive cash-flow consistency is currently materially behind the available comparison."  I="Your housing-cost ratio is currently materially behind the available comparison."
UNEXPLAINED GET /api/reports/[id] :: data.sections[9].sectionData.behindCount  M=23  I=22
UNEXPLAINED GET /api/reports/[id] :: data.sections[9].narrativeText  M="Your Financial Twin compared 54 metrics against a synthetic peer profile and FHIP planning ranges:   I="Your Financial Twin compared 54 metrics against a synthetic peer profile and FHIP planning ranges: 
UNEXPLAINED GET /api/reports/[id]/sections :: data[0].sectionData.metrics[0].current  M=45.52100000000001  I=46.24400000000001
UNEXPLAINED GET /api/reports/[id]/sections :: data[0].sectionData.metrics[0].displayText  M="−1"  I="−0"
UNEXPLAINED GET /api/reports/[id]/sections :: data[0].sectionData.metrics[0].changePercent  M=-2.210526315789451  I=-0.65735767991405
UNEXPLAINED GET /api/reports/[id]/sections :: data[0].sectionData.metrics[0].changeAbsolute  M=-1.0289999999999893  I=-0.3059999999999903
UNEXPLAINED GET /api/reports/[id]/sections :: data[0].sectionData.metrics[2].previous  M=-535  I=83.45
UNEXPLAINED GET /api/reports/[id]/sections :: data[0].sectionData.metrics[2].direction  M="positive"  I="negative"
UNEXPLAINED GET /api/reports/[id]/sections :: data[0].sectionData.metrics[2].displayText  M="+$618"  I="−$0"
UNEXPLAINED GET /api/reports/[id]/sections :: data[0].sectionData.metrics[2].previousText  M="-$535"  I="$83"
UNEXPLAINED GET /api/reports/[id]/sections :: data[0].sectionData.metrics[2].changePercent  M=115.59781308411215  I=-0.0020371479927925465
UNEXPLAINED GET /api/reports/[id]/sections :: data[0].sectionData.metrics[2].changeAbsolute  M=618.4483  I=-0.0016999999999853799
UNEXPLAINED GET /api/reports/[id]/sections :: data[0].sectionData.metrics[3].previous  M=-4.75  I=1.67
UNEXPLAINED GET /api/reports/[id]/sections :: data[0].sectionData.metrics[3].direction  M="positive"  I="negative"
UNEXPLAINED GET /api/reports/[id]/sections :: data[0].sectionData.metrics[3].displayText  M="+6.4 percentage points"  I="−0.0 percentage points"
UNEXPLAINED GET /api/reports/[id]/sections :: data[0].sectionData.metrics[3].previousText  M="-4.8%"  I="1.7%"
UNEXPLAINED GET /api/reports/[id]/sections :: data[0].sectionData.metrics[3].changeAbsolute  M=6.418966  I=-0.0010339999999997573
UNEXPLAINED GET /api/reports/[id]/sections :: data[0].sectionData.metrics[4].previous  M=2.303030303030303  I=4.72636815920398
UNEXPLAINED GET /api/reports/[id]/sections :: data[0].sectionData.metrics[4].displayText  M="+2.7×"  I="+0.2×"
UNEXPLAINED GET /api/reports/[id]/sections :: data[0].sectionData.metrics[4].previousText  M="2.3×"  I="4.7×"
UNEXPLAINED GET /api/reports/[id]/sections :: data[0].sectionData.metrics[4].changeAbsolute  M=2.671472184531886  I=0.24813432835820937
UNEXPLAINED GET /api/reports/[id]/sections :: data[3].sectionData.components[0].rawScore  M=48  I=52
UNEXPLAINED GET /api/reports/[id]/sections :: data[3].sectionData.components[0].currentValue.deficitMonths  M=1  I=0
UNEXPLAINED GET /api/reports/[id]/sections :: data[3].sectionData.components[0].weightedContribution  M=8.675  I=9.398
UNEXPLAINED GET /api/reports/[id]/sections :: data[3].sectionData.scoreChange  M=-1.0289999999999893  I=-0.3059999999999903
UNEXPLAINED GET /api/reports/[id]/sections :: data[3].sectionData.overallScore  M=45.52100000000001  I=46.24400000000001
UNEXPLAINED GET /api/reports/[id]/sections :: data[3].sectionData.recommendations[3].estimatedScoreImprovement  M=6.7  I=6
UNEXPLAINED GET /api/reports/[id]/sections :: data[3].chartData.pillars[0].score  M=48  I=52
UNEXPLAINED GET /api/reports/[id]/sections :: data[9].sectionData.insights[5].title  M="Opportunity: positive cash-flow consistency"  I="Opportunity: housing-cost ratio"
UNEXPLAINED GET /api/reports/[id]/sections :: data[9].sectionData.insights[5].metricCode  M="positive_cashflow_consistency"  I="housing_cost_ratio"
UNEXPLAINED GET /api/reports/[id]/sections :: data[9].sectionData.insights[5].explanation  M="Your positive cash-flow consistency is currently materially behind the available comparison."  I="Your housing-cost ratio is currently materially behind the available comparison."
UNEXPLAINED GET /api/reports/[id]/sections :: data[9].sectionData.behindCount  M=23  I=22
UNEXPLAINED GET /api/reports/[id]/sections :: data[9].narrativeText  M="Your Financial Twin compared 54 metrics against a synthetic peer profile and FHIP planning ranges:   I="Your Financial Twin compared 54 metrics against a synthetic peer profile and FHIP planning ranges: 
UNEXPLAINED HEADLINE Score / overall health score
UNEXPLAINED HEADLINE Twin / ahead / aligned / behind

RESULT: FAIL -- 2 headline + 128 leaf variances unexplained

## Score / Twin: root cause of the one remaining variance

Score (45.521 vs 46.244) and Twin ahead/aligned/behind (8/0/23 vs 8/0/22) are the only headline metrics
that did not reconcile. Every other consumer -- Income, Expenses (all bases), Assets, Liabilities,
Investments, Retirement, Net Worth, Cashflow (surplus/savings-rate/DSR/DTI/emergency-fund), DNA, Resilience,
all 6 forecast types (projected results + per-period totals), Report Net Worth -- is byte-identical.

Traced live to lib/engines/healthScore.ts's Cash-Flow-Stability component:
deficitMonths = d.snapshots.filter(s => s.monthly_surplus < 0).length, where d.snapshots is the last 12
rows of financial_snapshots (lib/services/dashboardData.ts). writeFinancialSnapshots() back-fills a
historical month's monthly_income/expenses/surplus columns from approved-statement cash flow ONLY for
months in coverage.coveredMonths (i.e. months a fully-approved bank/card/loan statement covers). Household
I's August bank/card/loan statements make August a covered month, so its PRE-EXISTING August
financial_snapshots row (this fixture user's own unrelated standing history, unconnected to the golden
economics) gets corrected to the real August cash flow. Household M's manual entries never produce a
covered month, so that same historical row is never touched and keeps whatever value it had before this run
-- confirmed live via data.dataStatus.window.coveredMonths: [] for M, ["2026-08"] for I.

financial_snapshots has no updated_at column, so residue.mjs cannot see or restore this drift, and
neutralise.mjs (which resets the CURRENT register rows: income_sources, expense_items, liabilities,
assets, investments, retirement_accounts) has no equivalent step for historical snapshot rows. This is
either (a) a gap in this certification harness (fixture users carry unrelated financial_snapshots history
that a from-scratch production user would never have), or (b) a genuine, narrow product asymmetry: an
approved-statement upload can retroactively correct a past month's recorded cash flow while manual entry
never can, so two households with identical CURRENT economics can score differently if either of them has
pre-existing historical snapshot noise for a covered month. Recommend a PO decision on which framing
applies and, if (b), whether it needs a fix; not fixed in this pass.
