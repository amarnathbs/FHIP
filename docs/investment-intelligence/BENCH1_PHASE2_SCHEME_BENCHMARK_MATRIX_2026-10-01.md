# BENCH-1 Phase 2 - Held-scheme to required-benchmark matrix (REAL demand)

Date: 2026-10-01. Source of demand: a read-only inventory of DEV and PRODUCTION (public scheme identifiers and aggregates only; no user, account, folio, unit or amount data). Source of benchmarks: each scheme's OWN public document (SID/KIM/factsheet) - AMFI category guidance is not used as evidence.

* Held, eligible scheme rows (real, excluding DEV test fixtures): **22** across **20** scheme families. All are Indian mutual funds in INR.
* Distinct benchmark identities demanded by evidenced single-index mappings: **11**. Two further schemes declare benchmarks that one catalogue series cannot represent (see Unsupported).
* Every held scheme is currently **unmapped**; `ii_benchmarks`, `ii_benchmark_series` and `ii_instrument_benchmarks` hold zero rows in DEV and production (verified 2026-10-01).
* Required-from dates: the *engine rule* (first transaction or earliest NAV on file, minus the 10-day alignment lookback the SIP/benchmark engines already use) and the narrower *investor rule* (first transaction only) are both shown; see the coverage report.

## Distinct required benchmarks

| Catalogue key (proposed) | Official name in scheme documents | Owner (inferred) | Variant | Scheme rows | Families | Required from (engine rule) | Required from (investor rule) |
|---|---|---|---|---|---|---|---|
| `IN_BSE_100_TRI` | BSE 100 TRI | BSE Index Services Private Limited | total return (TRI) | 2 | 2 | 2006-03-24 | 2013-09-07 |
| `IN_BSE_250_SMALLCAP_TRI` | BSE 250 SmallCap TRI | BSE Index Services Private Limited | total return (TRI) | 1 | 1 | 2014-06-20 | 2026-01-02 |
| `IN_BSE_500_TRI` | BSE 500 TRI | BSE Index Services Private Limited | total return (TRI) | 1 | 1 | 2006-03-24 | 2022-11-21 |
| `IN_NIFTY50_HYBRID_COMP_DEBT_5050_TRI` | NIFTY 50 Hybrid Composite Debt 50:50 Index TRI | NSE Indices Limited | total return (TRI) | 1 | 1 | 2006-03-24 | 2018-05-22 |
| `IN_NIFTY_100_TRI` | NIFTY 100 TRI | NSE Indices Limited | total return (TRI) | 3 | 2 | 2006-03-24 | 2015-08-11 |
| `IN_NIFTY_500_TRI` | Nifty 500 TRI | NSE Indices Limited | total return (TRI) | 5 | 4 | 2006-03-24 | 2022-11-27 |
| `IN_NIFTY_CORPORATE_BOND_A2_TRI` | NIFTY Corporate Bond Index A-II (TRI per SID heading) | NSE Indices Limited | total return (TRI) | 1 | 1 |  | 2018-12-22 |
| `IN_NIFTY_INFRASTRUCTURE_TRI` | Nifty Infrastructure TRI | NSE Indices Limited | total return (TRI) | 1 | 1 | 2006-03-24 | 2007-12-07 |
| `IN_NIFTY_LARGEMIDCAP_250_TRI` | Nifty LargeMidcap 250 TRI | NSE Indices Limited | total return (TRI) | 1 | 1 | 2012-12-23 | 2025-01-22 |
| `IN_NIFTY_MIDCAP_150_TRI` | Nifty Midcap 150 TRI | NSE Indices Limited | total return (TRI) | 3 | 3 | 2006-03-24 | 2015-08-11 |
| `IN_NIFTY_MNC_TRI` | Nifty MNC TRI | NSE Indices Limited | total return (TRI) | 1 | 1 | 2006-03-24 | 2015-09-26 |

## Scheme -> benchmark matrix

| Scheme (plan/option) | AMFI code | Category | Declared benchmark (scheme document) | Variant | Evidence | Proposed key | Current mapping | Earliest tx | Required from (engine) |
|---|---|---|---|---|---|---|---|---|---|
| Aditya Birla Sun Life Large Cap Fund (regular/growth) | 103174 | Large Cap Fund | NIFTY 100 TRI | total_return | verified_scheme_document | IN_NIFTY_100_TRI | unmapped | 2015-08-21 | 2006-03-24 |
| Axis Large Cap Fund (regular/growth) | 112277 | Large Cap Fund | BSE 100 TRI | total_return | verified_scheme_document | IN_BSE_100_TRI | unmapped | 2013-09-17 | 2009-12-28 |
| Franklin India Flexi Cap Fund (regular/growth) | 100520 | Flexi Cap Fund | Nifty 500 (shown under 'Benchmark (Total Return Index)'; Tie | total_return | verified_scheme_document | IN_NIFTY_500_TRI | unmapped | 2022-12-12 | 2006-03-24 |
| Franklin India Mid Cap Fund (regular/growth) | 100473 | Mid Cap Fund | Nifty Midcap 150 (shown under 'Benchmark (Total Return Index | total_return | verified_scheme_document | IN_NIFTY_MIDCAP_150_TRI | unmapped | 2015-08-21 | 2006-03-24 |
| HDFC Balanced Advantage Fund (regular/growth) | 100119 | Dynamic Asset Allocation or Balanced Advantage | NIFTY 50 Hybrid Composite Debt 50:50 Index (TRI) | total_return | verified_scheme_document | IN_NIFTY50_HYBRID_COMP_DEBT_5050_TRI | unmapped | 2018-06-01 | 2006-03-24 |
| HDFC Flexi Cap Fund (direct/growth) | 118955 | Flexi Cap Fund | NIFTY 500 Index (TRI) | total_return | verified_scheme_document | IN_NIFTY_500_TRI | unmapped | 2026-08-01 | 2026-07-26 |
| HDFC Flexi Cap Fund (regular/growth) | 101762 | Flexi Cap Fund | NIFTY 500 Index (TRI) | total_return | verified_scheme_document | IN_NIFTY_500_TRI | unmapped | 2022-12-12 | 2006-03-24 |
| HDFC Gold ETF Fund of Fund (regular/growth) | 115934 | FoF Domestic | Domestic price of physical gold | price | verified_scheme_document | UNSUPPORTED | unmapped | 2026-01-16 | 2011-10-23 |
| HDFC Large Cap Fund (direct/growth) | 119018 | Large Cap Fund | NIFTY 100 Total Returns Index (TRI) | total_return | verified_scheme_document | IN_NIFTY_100_TRI | unmapped | 2019-10-22 | 2012-12-22 |
| HDFC Large Cap Fund (regular/growth) | 102000 | Large Cap Fund | NIFTY 100 Total Returns Index (TRI) | total_return | verified_scheme_document | IN_NIFTY_100_TRI | unmapped | 2022-08-16 | 2006-03-24 |
| HDFC Mid Cap Fund (regular/growth) | 105758 | Mid Cap Fund | NIFTY MIDCAP 150 (TRI) | total_return | verified_scheme_document | IN_NIFTY_MIDCAP_150_TRI | unmapped | 2026-01-21 | 2007-06-25 |
| HDFC Small Cap Fund (regular/growth) | 130502 | Small Cap Fund | BSE 250 SmallCap Index (TRI) | total_return | verified_scheme_document | IN_BSE_250_SMALLCAP_TRI | unmapped | 2026-01-12 | 2014-06-20 |
| ICICI Prudential Dividend Yield Fund (regular/growth) | 129310 | Dividend Yield Fund | Nifty 500 TRI | total_return | factsheet_only | IN_NIFTY_500_TRI | unmapped | 2022-12-07 | 2014-05-09 |
| Kotak Mid Cap Fund (regular/growth) | 104908 | Mid Cap Fund | NIFTY Midcap 150 TRI (Tier 1) | total_return | factsheet_only | IN_NIFTY_MIDCAP_150_TRI | unmapped | 2022-08-23 | 2007-03-23 |
| Mirae Asset Large & Midcap Fund (direct/growth) | 118834 | Large & Mid Cap Fund | Nifty Large Midcap 250 Index (TRI) | total_return | verified_scheme_document | IN_NIFTY_LARGEMIDCAP_250_TRI | unmapped | 2025-02-01 | 2012-12-23 |
| Nippon India Power & Infra Fund (regular/growth) | 101262 | Sectoral Fund | Nifty Infrastructure TRI | total_return | verified_scheme_document | IN_NIFTY_INFRASTRUCTURE_TRI | unmapped | 2007-12-17 | 2006-03-24 |
| Parag Parikh Flexi Cap Fund (direct/growth) | 122639 | Flexi Cap Fund | Nifty 500 TRI (AMFI Tier I) | total_return | verified_scheme_document | IN_NIFTY_500_TRI | unmapped | 2023-04-03 | 2013-05-18 |
| SBI CONTRA FUND (regular/growth) | 102414 | Contra Fund | BSE 500 TRI Index (AMFI Tier I; 'S&P BSE 500 TRI Index' in t | total_return | verified_scheme_document | IN_BSE_500_TRI | unmapped | 2022-12-01 | 2006-03-24 |
| SBI Large Cap Fund (regular/growth) | 103504 | Large Cap Fund | BSE 100 TRI (AMFI Tier I; 'S&P BSE 100 TRI' in older docs) | total_return | verified_scheme_document | IN_BSE_100_TRI | unmapped | 2022-02-01 | 2006-03-24 |
| SBI MULTI ASSET ALLOCATION FUND (regular/growth) | 103408 | Multi Asset Allocation | 45% BSE 500 TRI + 40% CRISIL Composite Bond Fund Index + 10% | mixed: total_ret | verified_scheme_document | UNSUPPORTED | unmapped | 2026-02-05 | 2006-03-24 |
| ICICI Prudential Corporate Bond Fund - Growth (Direct Plan) (/) | ISIN INF109KA1Z62 |  | NIFTY Corporate Bond Index A-II | total_return | verified_scheme_document | IN_NIFTY_CORPORATE_BOND_A2_TRI | unmapped | 2019-01-01 |  |
| UTI - MNC Fund (regular/growth) | 100740 | Sectoral/ Thematic | Nifty MNC TRI | total_return | factsheet_only | IN_NIFTY_MNC_TRI | unmapped | 2015-10-06 | 2006-03-24 |

## Unsupported / source-blocked (not approximated)

* AMFI 103408: Composite benchmark (45% BSE 500 TRI + 40% CRISIL Composite Bond Fund Index + 10% domestic gold + 5% domestic silver). One ii_benchmarks series cannot represent it: it needs a blended-benchmark definition and four component series (one CRISIL, two commodity price series whose source no document names). Not built; shown as UNSUPPORTED, never approximated by its equity leg.
* AMFI 115934: Benchmark is the "domestic price of physical gold" - not an index and no scheme document names the price source. Needs a PO decision on a permitted gold-price series. Shown as source-blocked.

## Reading the evidence status

* `verified_scheme_document`: the benchmark is stated in the scheme's own SID/KIM. Plans/options of one scheme share it.
* `factsheet_only`: only a monthly factsheet or AMC scheme page was found (ICICI Dividend Yield, Kotak Mid Cap, UTI MNC); UTI MNC evidence is from 2022. These go to admin review, never auto-publish.
* The full per-scheme evidence (document URLs, document dates, retrieval dates, excerpts, benchmark-change history) is in `docs/investment-intelligence/bench1_phase2/mapping_evidence/`.
* Known benchmark CHANGES (effective-dated mappings are required): SBI Multi Asset (2023-10-31), ICICI Corporate Bond (2024-03-12), ICICI Dividend Yield (2022-01-01), DSP Large Cap (2026-05-16, not currently held), Franklin Mid (2018, effective date unverified).
