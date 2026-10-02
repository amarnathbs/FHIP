# BENCH-1 - Source Decision (India benchmark index data) - Phase 2 update

Status: **EVIDENCE PACK + DECISION REQUEST. No commercial commitment, outreach, purchase or licence approval has been made, authorised or invented.**
Updated 2026-10-01 (this replaces the 2026-09-30 draft, which could not reach any owner page). Full research: `docs/investment-intelligence/bench1_phase2/source_research/SOURCE_RESEARCH.md` (with short evidence excerpts and the exact fetch log in `.../evidence/fetch_attempt_log.txt`).

## 1. The decision in one paragraph

**No public source was found that grants FHIP's intended use** (a commercial web application that shows customers a fund-versus-index comparison, computes returns, stores index history in its own database and puts comparisons into reports/exports). Every index owner whose terms were read (NSE Indices, BSE Index Services, CRISIL) restricts its site and data to personal / internal / non-commercial use and prohibits automated collection; written permission or a paid subscription/licence is the documented route. No open-data licence, attribution-only licence or redistribution rule for Indian index VALUES exists in anything read. Therefore **every index-value source stays `permissions not granted`**, recurring automation stays OFF, and ingestion is limited to **governed manual import against an approved entitlement record** that the Product Owner creates once rights exist in writing. The technical machinery for all of that is built and verified (see the Phase 2 report); the data and rights are the blocker.

What IS public and usable as evidence: each scheme's **declared benchmark** (name, tier, effective date) is a regulatory disclosure in the scheme's own SID/KIM/factsheet and in benchmark-change addenda. That is a different question from the index LEVELS, which are the owner's licensed data. The catalogue and mapping evidence in this repository uses only the former.

## 2. Source / permission decision matrix

Legend: V = verified first-hand on 2026-10-01; B = blocked; U = unavailable to this environment; C = awaiting owner clarification. "NS" = UNKNOWN - not stated in what was read. "Not granted" = the terms read restrict this and no permission was found. A successful fetch is not a licence; a failed fetch is not proof of unavailability.

| # | Owner / exact source | Data | Variant / currency | Coverage | Automation | Storage | Customer-visible derived comparison | Export / report | Status |
|---|---|---|---|---|---|---|---|---|---|
| S1 | AMC scheme documents (SID, KIM, factsheets, notice-cum-addenda), each AMC site | A scheme's DECLARED benchmark name/tier, effective date, scheme-vs-benchmark return table | Declared TRI (SEBI mandate); INR domestic | Scheme's own life | AMC terms NS (not read) | NS | NS | NS | V for documents; reuse terms **C** |
| S2 | AMFI-hosted SIDs `https://portal.amfiindia.com/spages/<n>.pdf` | Same content, stable numeric URLs | as S1 | as S1 | AMFI terms NS | NS | NS | NS | V (2 PDFs fetched); permissions **C** |
| S3/S4 | AMFI Tier-1 and PRC benchmark lists (`https://www.amfiindia.com/otherdata`, `/otherdata/listofbenchmarkindices`, `/research-information/other-data/zcollatedprcbenchmarks`) | Category -> permitted Tier-1 index names | Intended TRI | n/a | n/a | n/a | n/a | n/a | **B**: www.amfiindia.com refused every connection (ECONNREFUSED) on every attempt this session, through three tools. Contents, format and cadence are NOT first-hand |
| S5 | NSE Indices historical data page `https://www.niftyindices.com/reports/historical-data` | Price OHLC per index; a TRI tab with Total Returns Index AND Net Total Return Index; CSV output | Price / TRI / NTR; INR | Per-index; date-range limit per query NS; Nifty 50 history from 3 Jul 1990 (launch 22 Apr 1996, base 3 Nov 1995 = 1000); other TRI start dates NS | Prohibited without written consent | Not granted | Not granted (personal, non-commercial only) | Not granted | V metadata; permission **C**. No query was run and no file downloaded |
| S6 | NSE public PDFs (factsheets, benchmark codes list, monthly Benchmark Riskometer) | Factsheet returns, benchmark codes/names | Price / TRI / NTR | Monthly | Site terms apply | Not granted | Not granted | Not granted | V metadata; **C** |
| S7 | NSE data subscription `/offerings/data-subscription`; authorised vendors; licensing `/offerings/index-licensing` | EOD constituent data by subscription (written enquiry); index data via six named vendors; licence/prior approval when an institution benchmarks ITS product to an NSE index | NS | NS | Contractual - NS | NS | NS (the licensing page addresses AMCs; whether FHIP's display needs a licence is unknown) | NS | V (pages read); price/terms **C** |
| S8 | BSE Index Services Pvt Ltd (formerly Asia Index; renamed 2025-08-01) `https://www.bseindices.com/` | Public chart per index; subscriber area behind Client Access | Price Return and Gross TR in methodology; Net TR not stated for equity | Methodology lists launch/base dates (e.g. BSE 100 launched 3 Jan 1989) | Prohibited (robots, scrapers) | Prohibited (no "historical databases"; internal business purposes only) | Prohibited without written agreement | Prohibited | V; **C** |
| S9 | CRISIL Indices `https://intelligence.crisil.com/...indices.html` | Methodologies, factsheets, a public xlsx of daily values for index-linked products (headers only fetched; contents and licence unknown); client delivery by email/SFTP/API | Debt indices are TRI; INR | Base dates in methodology (e.g. Composite Bond Fund Index 31 Mar 2002) | Website bots prohibited; client API under contract | NS | NS | NS | V; **C** |
| S10 | S&P Dow Jones Indices | - | - | - | - | - | - | - | **U** (HTTP 403 on both pages) |
| S11 | MSCI end-of-day data | iframe app not opened; terms are a client contract | NS | NS | NS | NS | NS | NS | Not assessed |
| S12 | Licensed vendors (Bloomberg, FactSet, LSEG, MSCI, Rimes, S&P Global) | Index history via vendor feed | NS | NS | Contractual | Contractual | Contractual | Contractual | Categories named publicly by NSE; pricing and terms UNKNOWN. **Not contacted** |
| S13 | Open-data / attribution-based sources for Indian index values | - | - | - | - | - | - | - | **None found** |

Regulatory context (first-hand, SEBI): TRI benchmarking is mandatory for mutual-fund schemes (circular dated 2018-01-04, w.e.f. 2018-02-01; PRI-to-TRI composite where a TRI is missing for a period); two-tier benchmarks per the 2021-10-27 circular; benchmark changes are published as notice-cum-addenda and are effective-dated (example: DSP Large Cap moved BSE 100 TRI -> NIFTY 100 TRI w.e.f. 2026-05-16). Hence scheme-to-benchmark mapping is effective-dated in the data model.

## 3. Facts verified and recorded (not left blank for want of a price)

* Nifty 50: launch 22 Apr 1996; base 3 Nov 1995 = 1000; history available from 3 Jul 1990; Price, TRI and Net TRI exist (NSE factsheet dated 2026-09-30 and FAQ).
* BSE Index Services: renamed from Asia Index on 2025-08-01 (BSE press release); methodology defines Price Return and Gross Total Return; Net TR not mentioned for equity indices.
* CRISIL debt indices are total-return indices; client delivery is T+0 for values.
* NSE sells EOD constituent data by subscription and names six authorised vendors; price is not published anywhere read.

## 4. Unknowns (explicit; nothing is guessed)

Date-range limit per NSE query and history depth per index; TRI start dates for every index other than Nifty 50; whether BSE publishes TRI levels or Net TR publicly; the contents/licence of the CRISIL xlsx; **any price or fee for any product**; whether AMC-published scheme-vs-benchmark returns may be reused; the source of the "domestic price of physical gold/silver" benchmarks; international index owners' terms; the current SEBI master-circular clause numbers; the contents, format and cadence of the AMFI benchmark lists (unreachable).

## 5. What this means for the build (Phase 2)

* Catalogue and mapping: built from the scheme documents (evidence in `docs/investment-intelligence/bench1_phase2/mapping_evidence/`). Draft catalogue entries and mapping PROPOSALS only; verification is a human step.
* Entitlements: the gate is per-right (ingest, automation, storage, calculation, display, export) with date scope and expiry; **no entitlement record exists**, so every right is false today. A manual file upload is refused at publication until an approved record covers it.
* Recurring ingestion: shipped DISABLED; the adapter registry is EMPTY; every benchmark is in governed manual-import mode.
* The legacy India-branch Nifty 50 / Sensex price updater (`marketIndex/dailyFeed.ts`, NSE archive adapter) now additionally requires an approved `automation` + `storage` entitlement (database-enforced) and stays off.

## 6. Questions for the Product Owner to put to each owner (FHIP does not contact them)

Written clarification, in the owner's own channel, of: (1) whether displaying to FHIP's customers a fund-versus-index return comparison derived from index levels, in-app and in downloadable reports, requires a licence, and on what terms; (2) permission to store and cache daily levels (price, TRI, net TRI) in FHIP's database for calculation; (3) permission for automated daily retrieval and the documented method; (4) historical depth and TRI start dates available; (5) attribution wording; (6) post-termination retention of stored history; (7) fees, user-count limits and corrections delivery. Ask NSE Indices, BSE Index Services and CRISIL separately; ask an authorised vendor for the same list if a distributor is preferred. Record each answer as an entitlement record (Admin > Benchmark Data > Entitlements) with the written evidence reference; until then nothing publishes.

## 7. Category averages

A category-average benchmark needs a separately licensed peer dataset and is out of scope until a dedicated PO decision (unchanged).

## 8. Naming collision (unchanged)

`benchmark_datasets` / `lib/services/benchmarkGovernance.ts` and their Admin surface are the financial-planning benchmark system and are untouched. This work uses the distinct investment-index tables (`ii_benchmarks`, `ii_benchmark_series`, `ii_instrument_benchmarks`) and the "Benchmark Data" Admin surface under Investment Intelligence.
