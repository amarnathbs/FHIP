# BENCH-1 Phase 2 - Public-information-first source research (benchmark index data, India)

Researched 2026-10-01. No code, no outreach, no purchases, no sign-ups. Evidence excerpts are in `evidence/` (paraphrase and short quotes only). Every "verified" below means: the owner page/document was read first-hand on 2026-10-01 and the statement is as written there. A successful fetch does NOT prove commercial reuse rights; a failed fetch does NOT prove the source is unavailable elsewhere.

Intended FHIP use (for reference): commercial web app; show customers fund-vs-index comparison; compute returns; store history in FHIP's database; produce customer reports/exports.

## 0. Headline findings

1. **No public source found that grants FHIP's intended use.** Every index owner whose terms were read (NSE Indices, BSE Index Services, CRISIL) restricts the website/data to personal / internal / non-commercial use and prohibits automated collection, and requires written permission or a licence for anything else. No open-data licence, attribution-only licence or published redistribution rule for Indian index history was found. (Search was not exhaustive; S&P DJI pages returned 403 and MSCI's terms are a client contract.)
2. **A scheme's declared benchmark is a public regulatory disclosure by the AMC** (SID/KIM/factsheet; changes via notice-cum-addendum). The benchmark NAME for a scheme can therefore be sourced from AMC/AMFI-hosted documents; this is a different question from the index VALUE history, which is the owner's licensed data.
3. **NSE Indices explicitly offers a paid-looking data channel** (EOD data subscription via email enquiry, plus six named authorised vendors) and a licensing page. Prices are UNKNOWN - not stated anywhere read.
4. **AMFI's own pages (www.amfiindia.com) were unreachable from this environment on every attempt**, so what the AMFI benchmark lists contain/format/cadence is NOT first-hand. The regulatory basis (SEBI circulars) IS first-hand.
5. NSE publishes real Price / Total Return / Net Total Return variants and the historical-data page offers a CSV-style output - but the same site's terms forbid automated collection and non-personal use, so that page is not a usable FHIP feed without written consent.

## 1. Regulatory context (first-hand, SEBI documents)

| Item | Detail | Evidence |
|---|---|---|
| TRI benchmark mandate | SEBI circular SEBI/HO/IMD/DF3/CIR/P/2018/04 dated 4 Jan 2018 "Benchmarking of Scheme's performance to Total Return Index": scheme performance to be benchmarked to the TRI variant of the chosen index; applicable to all MF schemes **w.e.f. 1 Feb 2018**. Where TRI is not available for a period, funds use a composite CAGR of PRI until the TRI start date and TRI after, with a mandatory disclosure footnote. Funds must disclose benchmark name(s) in scheme documents. | https://www.sebi.gov.in/legal/circulars/jan-2018/benchmarking-of-scheme-s-performance-to-total-return-index_37273.html ; PDF https://www.sebi.gov.in/sebi_data/attachdocs/jan-2018/1515066187290.pdf (read 2026-10-01) |
| Two-tier benchmark | SEBI/HO/IMD/IMD-II DF3/P/CIR/2021/652 dated 27 Oct 2021: Tier 1 reflects scheme category (list published by AMFI), Tier 2 optional (style/strategy); all benchmarks must be TRI. Equity/debt: one broad index per index provider per category; hybrid/solution: single; thematic/sectoral: single; index funds/ETFs: single (replicated index); FoF: underlying scheme's benchmark if single-fund else broad market index. AMFI to publish Tier-1 lists; effective 1 Dec 2021 (general) and 1 Jan 2022 (open-ended debt PRC matrix). | https://www.sebi.gov.in/legal/circulars/oct-2021/guiding-principles-for-bringing-uniformity-in-benchmarks-of-mutual-fund-schemes_53539.html ; PDF https://www.sebi.gov.in/sebi_data/attachdocs/oct-2021/1635332770473.pdf |
| Later consolidation | A 2025 SID cites "clause 1.9 of SEBI master circular dated June 27, 2024" for first-tier benchmark selection. Search summaries (secondary, unverified) mention a SEBI master circular dated 20 Mar 2026 and new SEBI (Mutual Funds) Regulations 2026 effective 1 Apr 2026; the current governing clause numbers should be re-confirmed from SEBI directly. | evidence/amfi_hosted_sid_benchmark_disclosure.txt ; evidence/sebi_circulars_text_excerpts.txt |
| AMFI Tier-1 list release | Secondary only: CafeMutual says AMFI released the first-tier list on 1 Dec 2021; Outlook Business (1 Apr 2022, updated 7 Jul 2023) says 67 scheme types, NSE and S&P BSE indices (CRISIL for debt/hybrid). AMFI said to host it at amfiindia.com/research-information/other-data and /importantupdates (per search summaries). **Not read first-hand.** | https://cafemutual.com/news/industry/23378-amfi-releases-tier-1-benchmark-list-for-mutual-fund-schemes ; https://www.outlookbusiness.com/news/amfi-lists-out-tier-one-benchmarks-for-67-types-of-mf-schemes-news-189589 |

Implication: because the Tier-1 list changes (e.g. an AMC can move a scheme between BSE and NSE benchmarks), per-scheme benchmark mapping must be **effective-dated**. First-hand example: DSP Large Cap Fund moved from BSE 100 TRI to NIFTY 100 Index TRI w.e.f. 16 May 2026 (https://www.dspim.com/downloads/20.-notice-cum-addendum-to-sid-kim-change-in-benchmark-and-fund-manager.pdf, dated 6 May 2026).

## 2. Decision matrix (summary)

Legend: V = verified first-hand; B = blocked; U = unavailable; C = awaiting owner clarification. "NS" = UNKNOWN - not stated (in what was read). "Not granted" = the terms read restrict this and no permission found.

| # | Source (owner / URL) | Data | TRI? | Automation | Storage | Customer display | Export/report | Status |
|---|---|---|---|---|---|---|---|---|
| S1 | AMC SID / KIM / factsheet / addenda (each AMC site) | Scheme's DECLARED benchmark name, effective date, scheme-vs-benchmark return table | Declared as TRI (SEBI mandate) | AMC terms NS (not read) | NS | NS (AMC doc terms not read) | NS | V (docs read); reuse terms C |
| S2 | AMFI-hosted SIDs: `https://portal.amfiindia.com/spages/<n>.pdf` | Same SID content, AMFI-hosted, stable numeric URLs | as S1 | AMFI terms NS (www unreachable) | NS | NS | NS | V (2 PDFs fetched); permissions C |
| S3 | AMFI Tier-1 benchmark list `https://www.amfiindia.com/otherdata` , `/otherdata/listofbenchmarkindices` , `/research-information/other-data` | Category -> allowed Tier-1 index names | Intended TRI | n/a | n/a | n/a | n/a | **B** (all connects refused/timed out) |
| S4 | AMFI PRC benchmark list `https://www.amfiindia.com/research-information/other-data/zcollatedprcbenchmarks` | Open-ended debt category -> CRISIL / NSE index names | Intended TRI | n/a | n/a | n/a | n/a | **B** (existence per search listing only) |
| S5 | NSE Indices historical data page `https://www.niftyindices.com/reports/historical-data` | Per-index Price OHLC; separate TRI tab with Total Returns Index AND Net Total Return Index columns; CSV output | Yes (TRI + NTR tab) | Prohibited without written consent | Not granted ("aggregate, copy or duplicate") | Not granted (personal non-commercial only) | Not granted | V metadata / **C** permission |
| S6 | NSE public PDFs: factsheets `/Factsheet/*.pdf`, benchmark codes list, monthly Benchmark Riskometer | Factsheet returns (Price/TRI/NTR), base/launch dates, benchmark code list | Yes (factsheet rows) | Same site terms apply | Not granted | Not granted | Not granted | V metadata / **C** |
| S7 | NSE Indices data subscription `/offerings/data-subscription`; vendors `/resources/authorized-data-vendors`; licensing `/offerings/index-licensing` | EOD index constituent data (subscription) ; index data via Bloomberg, FactSet, IHS Markit, MSCI, Rimes, Thomson Reuters | NS (subscription page speaks of constituent data) | Contractual - NS | NS | NS | NS | V (pages read); price/terms **C** |
| S8 | BSE Index Services Pvt. Ltd. (formerly Asia Index) `https://www.bseindices.com/` | Public chart per index (index levels), factsheet/annual return controls; subscriber area behind "Client Access" | PR and Gross TR calculated (methodology) ; Net TR not stated for equity | Prohibited (robots/scrapers, "automatic devices") | Prohibited ("historical databases"; "internal business purposes" only) | Prohibited (no disclose/display/redistribute) | Prohibited / written consent | V / **C** |
| S9 | CRISIL Indices `https://intelligence.crisil.com/en/homepage/what-we-do/research/indices.html` | Methodologies, factsheets, notices, public xlsx for index-linked products; client delivery of index values by email/SFTP/API/web upload | Debt indices are TRI | Website bots prohibited; client API exists (contract) | NS (website licence is personal/non-sublicensable) | NS | NS | V / **C** |
| S10 | S&P Dow Jones Indices (S&P 500 etc.) `spglobal.com/spdji` | - | - | - | - | - | - | **U** (HTTP 403 on both pages tried) |
| S11 | MSCI end-of-day data `msci.com/end-of-day-data-search` | Page is an iframe to app2.msci.com (not opened) | NS | NS | NS | NS | NS | Not assessed; TOU read is a client contract |
| S12 | Licensed vendors (Bloomberg, FactSet, LSEG/Thomson Reuters, MSCI, Rimes, S&P Global) | Index history via vendor feed | NS | contractual | contractual | contractual | contractual | Categories named by NSE; pricing/terms UNKNOWN - not stated |

Open-data / explicit-permission sources (item 4): **none found.** No attribution-based or open licence for NSE/BSE/CRISIL index values was located in any page read.

## 3. Per-source detail

### S1/S2 - AMC scheme documents (declared benchmark) and AMFI-hosted copies
- Owner: each AMC; AMFI hosts copies of SIDs at `https://portal.amfiindia.com/spages/<number>.pdf`.
- What was read: `https://portal.amfiindia.com/spages/13662.pdf` (360 ONE Flexicap Fund SID Section I, 59 pp., HTTP 200). It states benchmark in the key-information table ("As per AMFI Tier I Benchmark i.e. BSE 500") and in Section "How will the scheme benchmark its performance" (BSE 500 TRI, chosen from AMFI's first-tier list per SEBI master circular clause 1.9), and shows a scheme-vs-benchmark return table (1Y/3Y/5Y/since inception). `https://portal.amfiindia.com/spages/CompositeBondIndex.pdf` (CRISIL index note) also HTTP 200.
- Benchmark change disclosure: notice-cum-addendum on the AMC site (example above; DSP). AMC addenda URLs are AMC-specific; stability not assessed. Other examples found by search (not opened): LIC MF addendum list `https://www.licmf.com/assets/downloads/addendum_notice/2025-2026/Addendum%20no%2059.pdf`, Taurus `https://www.taurusmutualfund.com/sites/default/files/2026-03/addendum_30_03_2026.pdf`, Nippon `https://mf.nipponindiaim.com/investor-service/quick-links/notice-addendum`.
- Factsheets: monthly AMC factsheet PDFs exist (e.g. Tata `https://www.tatamutualfund.com/system/files/2026-08/TataMF%20Factsheet%20-%20July%202026.pdf`, Invesco, Mahindra Manulife, found via search, not opened). Monthly cadence per URLs; SEBI factsheet disclosure content per secondary search summary only.
- Return variant: TRI (mandated). Currency: INR for domestic benchmarks; international benchmarks are in their own currency, conversion basis NS here.
- Historical coverage: only the scheme's own period; reproduces benchmark RETURNS (not index levels).
- Access: public PDF download, no login observed. Automation / storage / display / export permission: **UNKNOWN - not stated** (AMC site terms and AMFI terms not read; AMFI www unreachable). The SEBI mandate makes these public disclosures, but that is not a copyright/reuse licence.
- Status: verified (documents); reuse terms awaiting clarification (low-risk candidate: extract the benchmark NAME and effective date only, with the SID as cited source).

### S3/S4 - AMFI benchmark lists
- URLs as in matrix. **Blocked on every attempt** (see section 6). First-hand facts: none beyond the SEBI circular that requires AMFI to publish them.
- Secondary (unverified): search-listing summary says the PRC list covers Overnight, Liquid, Money Market, Ultra Short, Low/Short/Medium/Medium-to-Long/Long Duration, Credit Risk, Corporate Bond, Banking & PSU, Gilt, Dynamic Bond, 10-yr Constant Maturity Gilt, Floater, each with CRISIL and NSE options and A-I/B-I/C-I PRC variants. Format (HTML/XLS/PDF), TRI/PRI labelling, per-scheme mapping and cadence: **UNKNOWN - not read**. A per-scheme benchmark mapping published by AMFI was NOT found; search snippets only mention scheme performance and tracking-error/difference disclosures on AMFI (https://www.amfiindia.com/polling/amfi/fund-performance, unread).
- Status: blocked.

### S5 - NSE Indices historical data page
- Owner: NSE Indices Limited (formerly IISL). URL `https://www.niftyindices.com/reports/historical-data` (HTTP 200 via curl; WebFetch timed out).
- Data: tabs - Historical Index Data (Date, Open, High, Low, Close; price index); Archives of Daily/Monthly Reports; P/E, P/B & Dividend Yield; **Total returns Index Values** (Date, Total Returns Index, Net Total Return Index). Selectors: index type, sub-type, index, from/to dates, Submit; output labelled "csv format". Page footnote: all fixed-income indices except Nifty 10 yr Benchmark G-Sec (Clean Price) are Total Return. Currency INR for domestic indices (not stated explicitly on the page).
- Date-range limit per query / max history served: **UNKNOWN - not stated** on the page. No query was run and no file downloaded (to stay within terms).
- Historical coverage verified elsewhere on the owner site: Nifty 50 factsheet (30 Sep 2026): launch 22 Apr 1996, base 3 Nov 1995 = 1000; FAQ: Nifty 50 history available from 3 Jul 1990; Nifty 50 and Nifty 50 TR share base 3 Nov 1995. TRI start dates for other indices: **UNKNOWN - not stated**.
- Frequency/timing: end-of-day; publication time NS. Factsheets monthly (dated 30 Sep 2026); Benchmark Riskometer monthly (Aug and Jul 2026 listed).
- Terms (https://www.niftyindices.com/terms-of-use, https://www.niftyindices.com/disclaimer): site "for personal, non-commercial use only"; no "systematic or automated data collection ... (including scraping ...)" without express written consent; no "Aggregate, copy or duplicate" site content; no material copied/republished/distributed without prior written permission; disclaimer says index data may not be stored in a retrieval system without written permission and that use/distribution of index data requires a licence. Attribution/entitlement-expiry rules for a consenting arrangement: **UNKNOWN - not stated**. robots.txt allows `/` with a few specific Disallow paths, but that does not override the Terms of Use.
- Automation: not permitted without written consent. Storage: not granted. Customer-visible derived comparison: not granted (non-commercial only). Export/report: not granted.
- Status: verified (metadata, terms); permission **awaiting owner clarification**.

### S6 - NSE public PDFs
- `https://www.niftyindices.com/Factsheet/ind_nifty50.pdf` (30 Sep 2026): shows Price Return / Total Return / Net Total Return performance rows and index variants (TR Gross and Net, USD, JPY). `https://www.niftyindices.com/BenchmarkCodes/nifty_indices_benchmark_codes.pdf` ("As on September 30, 2026"): list of NSE benchmark codes and names (e.g. NSE_E_63 Nifty 500, NSE_E_59 Nifty 100). `https://www.niftyindices.com/reports/benchmark-riskometer`: monthly PDFs. Menu links `reports/benchmark-codes` and `reports/eod-index-file` return a 404 error body (not live pages).
- Permissions: same site terms; nothing more specific stated on the PDFs beyond a reference-only disclaimer. Status: verified metadata / C.

### S7 - NSE data subscription, vendors, licensing
- `https://www.niftyindices.com/offerings/data-subscription`: end-of-day index constituent data (names, identifiers, market cap, weights, prices); subscription by writing to an address printed on the page; also via Bloomberg, FactSet, IHS Markit, MSCI, Rimes, Thomson Reuters. `https://www.niftyindices.com/resources/authorized-data-vendors` lists the same six vendors. Price, term, display/redistribution/storage/export rights: **UNKNOWN - not stated**.
- `https://www.niftyindices.com/offerings/index-licensing`: a licence is required to create a product based on or linked to NSE indices; "prior approval is required" (with fees where applicable) when an institution benchmarks ITS PRODUCT to NSE indices; this is addressed to AMCs/institutions, not to a downstream app showing the comparison. Whether FHIP's comparison display counts as a licensed use: **UNKNOWN - to be asked**.
- Status: verified; commercial terms C.

### S8 - BSE Index Services Pvt. Ltd. (formerly Asia Index Pvt. Ltd.)
- Owner facts: renamed 1 Aug 2025 (press release https://www.bseindices.com/Downloads/MediaRelease/PRESS_RELEASE_BSE_Index_20250108.pdf); wholly owned subsidiary of BSE Limited. (A search summary claiming a May 2026 rename conflicts with the owner document.) Older "S&P BSE" branding reflects the former S&P DJI partnership; current methodology (Sept-2026, https://www.bseindices.com/Downloads/BSE_Indices_Methodology.pdf) says the indices are published by BISPL.
- Data: public per-index pages show a chart and constituents; "Annual Return" and "Factsheet" controls; subscriber login "Client Access". Return types per methodology: Price Return and Gross Total Return (dividends reinvested at ex-date close, no withholding tax); Net TR not mentioned for equity indices. Methodology has a Launch/First-Value/Base-date table (e.g. BSE 100 launched 3 Jan 1989; BSE 500 first value 1 Feb 1999 base 100; BSE 150 MidCap/250 SmallCap first value 16 Sep 2005) - **PDF table text extraction is misaligned; verify visually before use.** TRI history start dates: **UNKNOWN - not stated**.
- Terms (https://www.bseindices.com/terms-of-use, read rendered): personal, internal, non-commercial only; no scraping/robots/automatic devices; BISPL data "solely for internal business purposes" unless otherwise permitted; may not create indices or "historical databases", create derived data without written consent, or disclose/display/redistribute to third parties. Written agreements (order forms) supplement these terms.
- Permissions: automation prohibited; storage prohibited; customer display prohibited; export prohibited - absent a written agreement. Status: verified; awaiting owner clarification.

### S9 - CRISIL Indices
- `https://intelligence.crisil.com/en/homepage/what-we-do/research/indices.html` (redirect from crisil.com indices page): 142 standard + 100+ customised Indian indices; notices; methodology PDF; list of all final indices PDF; benchmark code PDF; monthly dashboard; public xlsx "Daily Portfolio Parameters and Index Values" and "Historical Portfolios" for index-linked products (HEAD only: HTTP 200, 21,865 bytes, last modified 30 Sep 2026; content not downloaded or assessed; whether it contains a usable history is **UNKNOWN**).
- Variant: debt indices described as Total Return Indices; base dates in the methodology doc (e.g. Composite Bond Fund Index 31 Mar 2002). Currency INR. Net TR: not stated.
- Delivery to clients: values T+0 (same working day before 23:59), constituents T+1, via email, SFTP, API, web upload (client contract).
- Terms (https://www.crisil.com/en/home/website-terms-of-use.html): limited, personal, non-transferable, non-sublicensable, revocable licence; no robots/scrapers; no ML-training or generative-AI derivative compilations from site data. AMFI-hosted CRISIL note says no reproduction without prior written approval.
- Status: verified metadata; permissions awaiting owner clarification.

### S10/S11 - S&P DJI and MSCI (only for international-fund benchmarks)
- S&P DJI pages returned HTTP 403 (status: unavailable to this environment; nothing assessed). MSCI: end-of-day search is an embedded app (not opened); MSCI's terms page is a client-contract TOU that conditions use on the order form. Status: not assessed beyond that.

### S12 - Licensed owner/distributor data (categories only)
- Categories publicly named by NSE: Bloomberg, FactSet, IHS Markit (now S&P Global), MSCI, Rimes, Thomson Reuters (LSEG). Direct-from-owner subscription via NSE Indices (EOD constituent data) and CRISIL client delivery (email/SFTP/API) also exist. Pricing, redistribution/display/storage terms: **UNKNOWN - not stated**; not contacted.

## 4. Likely index owners by Indian MF category (map only; each scheme's own SID decides)

Regulatory basis (first-hand): SEBI 2021 circular categories and examples. Index names/owners marked (S) come from secondary press/search summaries of the AMFI list and from SID/AMC examples; verify against the AMFI list when reachable.

| Category | Typical Tier-1 / declared benchmark families | Likely owner(s) |
|---|---|---|
| Large cap | NIFTY 100 TRI / BSE 100 TRI (circular cites BSE 100 or NSE 100) | NSE Indices; BSE Index Services |
| Mid cap | NIFTY Midcap 150 / BSE 150 MidCap (S) | NSE; BSE |
| Small cap | NIFTY Smallcap 250 / BSE 250 SmallCap (S) | NSE; BSE |
| Flexi / multi cap / ELSS | BSE 500 TRI, NIFTY 500 TRI, NIFTY500 Multicap 50:25:25 (S; BSE 500 TRI confirmed in one flexicap SID) | NSE; BSE |
| Index funds / ETFs | The replicated index itself (single benchmark per circular) | Whichever owner licensed the index (NSE, BSE, S&P DJI, Nasdaq, MSCI, others) |
| Hybrid / balanced advantage / arbitrage | NIFTY 50 Hybrid Composite Debt 50:50, CRISIL Hybrid 50+50 Moderate, NIFTY 50 Arbitrage (S) ; composite blends | NSE; CRISIL; custom composites |
| Liquid / overnight / ultra short / low / short / medium / long duration | NIFTY or CRISIL indices per PRC category, e.g. CRISIL Liquid Overnight, NIFTY 1D Rate, A-I/B-I/C-I variants (S; listing summary) | NSE; CRISIL |
| Gilt / dynamic bond / corporate bond / banking & PSU | NIFTY and CRISIL equivalents (S) ; CRISIL Composite Bond Fund Index confirmed on CRISIL/AMFI-hosted docs | NSE; CRISIL |
| Gold / silver | "Domestic price of physical gold/silver" (price series, not an index family) for gold/silver ETFs (S: AMC pages); gold-silver FoF 50:50 blend (S) | Price source per SID (not identified here) |
| International / FoF | Single-fund FoF: underlying scheme's benchmark (SEBI 2021); multi-fund FoF: broad market index; international funds commonly S&P 500 TRI, NASDAQ-100 TRI, MSCI indices (S, general knowledge, not verified) | S&P DJI, Nasdaq, MSCI, others |
| Thematic / sectoral | Single benchmark; secondary sources say NSE sector index as Tier-1 (e.g. Nifty Pharma) with BSE sector index second tier (S) | NSE; BSE |

## 5. Gaps and unknowns (explicit)

- AMFI list content/format/cadence/per-scheme mapping: UNKNOWN (site unreachable).
- NSE per-query date-range limit, history depth per index, TRI start dates per index, publication time: UNKNOWN.
- BSE public site: no download control observed; whether TRI levels are shown publicly and their history: UNKNOWN. Net TR for BSE: UNKNOWN.
- CRISIL xlsx content and any public historical index-value feed: UNKNOWN.
- Any price/fee for any owner/vendor product: UNKNOWN - not stated. Nothing was priced.
- Whether AMC-published scheme-vs-benchmark RETURNS (in SIDs/factsheets) may be re-used by FHIP: UNKNOWN (AMC terms not read; legal question).
- Gold/silver price source for "domestic price" benchmarks: not researched.
- International index owners' public terms: S&P DJI blocked (403), MSCI contract-only.
- Undocumented endpoints used by third-party scripts exist for niftyindices.com; deliberately NOT used or tested.

## 6. Fetch outcomes (exact)
See `evidence/fetch_attempt_log.txt`. Summary: www.amfiindia.com - ECONNREFUSED (WebFetch x4) and connect timeouts (curl x10, different paths/hosts incl. apex and http), Browser pane denied; portal.amfiindia.com root is the member-login page (200) but its /spages PDFs fetch fine. niftyindices.com - WebFetch timed out x3, curl and Browser pane succeeded. bseindices.com - static fetch returns an empty shell; Browser pane renders. crisil.com / intelligence.crisil.com - OK. spglobal.com SPDJI - 403 x2.

## 7. Recommended next actions for the PO (no outreach was done; these are suggestions for the PO/legal)

A. Decide scope before asking: (i) is it enough to show the fund's own published benchmark RETURNS (from AMC documents) next to the fund, or (ii) does the product need index LEVEL history to compute rolling/period returns? (ii) needs owner data rights.

B. Written clarification to **NSE Indices Limited** (data/licensing contact printed on https://www.niftyindices.com/offerings/data-subscription; do not use scraping while asking):
 1. "FHIP is a commercial web application for retail investors. Is displaying the Price, TRI and Net TRI return of an NSE index next to a mutual fund's return, computed from daily index values, a licensed use? If so, which licence/subscription category applies?"
 2. "May we store daily index values (history since the index's TRI start date) in our database, and for how long after a subscription ends?"
 3. "May customers export a report/PDF/CSV containing the index values or index-derived returns?"
 4. "Does niftyindices.com historical data download permit programmatic or batch retrieval under a written consent? If not, which file/API delivery product (EOD index file) covers TRI and NTR history for all Nifty indices, with what fee and entitlement terms?"
 5. "What attribution/trademark wording is required, and what is the earliest available date for TRI and NTR for each index?"

C. **BSE Index Services Pvt. Ltd.** (contact printed on https://www.bseindices.com/terms-of-use): same questions 1-3 and 5; additionally: "Terms say data is for internal business purposes and prohibits historical databases and derived data. What written agreement permits a customer-facing comparison and storage of BSE index TRI history?" and "Is a Net TRI published?".

D. **CRISIL (Indices)**: "Which licence covers a customer-facing app displaying CRISIL debt index TRI returns versus scheme returns, and storing daily values? Does the client API/SFTP delivery include full TRI history? Is the public xlsx of daily index values for index-linked products licensed for reuse?"

E. **AMFI**: when reachable, have the PO or an operator open https://www.amfiindia.com/otherdata and /otherdata/listofbenchmarkindices in a browser and record format, last-updated date, TRI naming and whether any per-scheme benchmark mapping is published; also check AMFI's website terms for data reuse.

F. **AMCs / legal counsel**: confirm that extracting each scheme's declared benchmark name and effective date from public SIDs/KIMs/addenda, with source citation, is acceptable, and decide whether the AMC's published benchmark returns may be shown. This does not need index-owner licences if no index values are stored (counsel to confirm).

G. If the product needs international benchmarks, repeat B for S&P DJI (pages blocked here) and MSCI/Nasdaq, or ask a licensed distributor (the six named by NSE) for a multi-owner data licence; compare against owner-direct rates.

H. Engineering guardrails until rights are in writing: no scraping/automated pulling from niftyindices.com, bseindices.com or crisil.com; do not use undocumented endpoints; store benchmark mapping with source URL, document date and effective date; keep any index-value ingestion behind a source record whose permissions flags default to "not granted".
