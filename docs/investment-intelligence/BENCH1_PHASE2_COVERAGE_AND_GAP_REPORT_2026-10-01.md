# BENCH-1 Phase 2 - Coverage and gap report

Date: 2026-10-01. Basis: read-only inventory of DEV and PRODUCTION (`docs/investment-intelligence/bench1_phase2/inventory/`), scheme documents (`.../mapping_evidence/`), and the existing engines' own date rules. All figures are aggregates over public scheme identifiers.

## 1. Current state (verified 2026-10-01)

| Item | DEV | PRODUCTION |
|---|---|---|
| `ii_benchmarks` rows | 0 | 0 |
| `ii_benchmark_series` rows | 0 | 0 |
| `ii_instrument_benchmarks` rows | 0 | 0 |
| `ii_benchmark_category_defaults` rows | 0 | 0 |
| Held instrument rows (inventory) | 39 (35 are test fixtures; 4 real) | 19 |
| Real held scheme rows combined (deduplicated by AMFI code, then ISIN) | 22 rows / 20 families | |
| Held rows with a benchmark mapping | 0 | 0 |
| Benchmark comparisons available to any user | **none** | **none** |

Migration 0241 (and 0232) are not applied to either database; no benchmark data has been published anywhere by this work.

## 2. Demand: what real holdings require

* 11 distinct single-index benchmark identities are demanded by evidenced mappings (see the matrix): NIFTY 100 TRI (3 rows), NIFTY 500 TRI (5), NIFTY Midcap 150 TRI (3), BSE 100 TRI (2), and one each of BSE 500 TRI, BSE 250 SmallCap TRI, NIFTY LargeMidcap 250 TRI, NIFTY Infrastructure TRI, NIFTY MNC TRI, NIFTY 50 Hybrid Composite Debt 50:50 TRI, NIFTY Corporate Bond Index A-II.
* 2 held schemes declare benchmarks one series cannot represent (SBI Multi Asset composite; HDFC Gold ETF FoF "domestic gold price"): **unsupported / source-blocked**, not approximated.
* Owners: NSE Indices (8 of the 11 identities), BSE Index Services (3). None of the 11 has a verified automation, storage, display or export right (SOURCE_DECISION.md).
* Not "a generic 10-15 benchmark list": the list is exactly what the 22 held rows declare.

## 3. Required history windows (selective, not full-universe)

Two rules, both derived from the engines (not invented), reported side by side:

| Rule | Definition | Where it comes from | Effect on demand |
|---|---|---|---|
| Investor rule | first transaction date of the position, minus the engines' 10-day alignment lookback | holdings repository / blended-benchmark start / SIP date alignment (MAX_BACKWARD_SEARCH_DAYS = 10) | earliest 2007-12-07 (Infrastructure) to 2026-01-02 (Small Cap) in PRODUCTION |
| Engine since-inception rule | earliest NAV on file, minus the same lookback (funds are hydrated from inception / 2006-04-01) | per-scheme since-inception active return (analyticsOrchestrator) | **11 of 19 PRODUCTION schemes need levels back to 2006-03-24**; latest start 2014-06-20 |

Therefore the largest history request is ~20 years for NIFTY 100 / NIFTY 500 / NIFTY Midcap 150 / BSE 100 / BSE 500 / NIFTY MNC / NIFTY Infrastructure / Hybrid; shorter for the others (see the matrix columns). `ii_benchmark_history_demand` stores the per-benchmark minimum once (shared across schemes and families), and **expands** automatically when an older transaction or a newly approved mapping appears (a mapping that ended before a scheme's history began creates no demand; unheld schemes create none). The investor-rule column is what a "my investments only" comparison needs; the engine rule is what the existing per-scheme since-inception comparison asks for - the PO may choose to demand only the investor rule first.

## 4. Gaps

| Gap | Status | Needed to close |
|---|---|---|
| Index level history for all 11 benchmarks | **0% covered** | A permitted source and an approved entitlement (PO action); then an upload per benchmark |
| Official identifiers, base/launch/TRI start dates for the 11 | Unverified (left null in draft catalogue) | Owner pages (NSE Indices / BSE Index Services) reachable by a human; only Nifty 50 facts are verified |
| Benchmark change history before the documents' dates | Mostly undocumented (only HDFC/Franklin/Kotak/ICICI/UTI addenda searched) | Per-AMC addenda; effective-dated mappings start at the evidence document date and leave earlier windows honestly incomplete |
| UTI MNC, ICICI Dividend Yield, Kotak Mid Cap | Factsheet-level / 2022 evidence only | Current SID/KIM; routed to admin review |
| ICICI Corporate Bond (ISIN only; no AMFI code) | Index identity and plan mapping unverified | Scheme master linkage |
| Composite / commodity-price benchmarks | Unsupported | PO decision on a gold/silver price series and a blended-benchmark definition |
| AMFI Tier-1 / PRC lists | Unreadable from this environment | A human visit; cross-check of the 22 declared benchmarks against the AMFI list (category guidance is not scheme evidence anyway) |
| Calendar | No exchange holiday source | Operator-supplied holiday set or a licensed calendar; until then 3-weekday tolerance |
| Pre-inception levels | Never reconstructed | Distinguish published backtested history from live history (`history_class` on benchmark and series rows); an index's own launch/back-test boundary must come from the owner |

## 5. How gaps are shown to users and operators

Users: Holdings/Performance/SIP/X-Ray/Overview show blocked (no entitlement), history-incomplete or mapping-missing states with the specific reason, never 0%. Operators: Admin > Benchmark Data shows per benchmark `no_data / history_missing / stale / current / blocked_no_entitlement`, the demand floor, the four watermarks and the pending-import task list.
