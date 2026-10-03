# Scheme-to-benchmark sources: where does each mutual fund scheme's benchmark come from?

Researched on 3 October 2026. Read-only: a handful of ordinary page views, no bulk download, no automation, no workaround of any restriction, nobody contacted. This note builds on `source_research/SOURCE_RESEARCH.md` (1 October 2026), which holds the index-owner (NSE, BSE, CRISIL) terms research; it does not repeat it.

Labels used throughout. **OBSERVED** = I read it myself in this session. **SECONDARY** = a search-result summary or a press article; not the owner's own page. **UNVERIFIED** = I did not observe it; do not rely on it.

## The PO question, answered plainly

"All schemes' category-wise benchmark is missing. Is it available from AMFI, CAMS or another site, or must it be calculated from stored index history?"

Two separate things are being called "the benchmark" and they have different answers:

1. **Which benchmark a scheme uses (a name).** This is a public regulatory disclosure by each fund house, in the scheme's own document (information document, KIM, factsheet, notice-cum-addendum when it changes). It does not need an index licence. It can be taken from those documents with the document cited as evidence. This is what the new mapping pipeline records.
2. **How that benchmark performed (index levels).** No source found allows FHIP to store and show daily index levels for commercial use (see `SOURCE_RESEARCH.md`). AMFI-style published benchmark returns are **fixed periods only** (1 year, 3 years, 5 years, since inception) and cannot serve an arbitrary holding period. So a comparison over a user's own holding period must be **computed by FHIP from index levels** (replaying the user's own purchases and sales into the benchmark), which needs a licensed or permitted level series. Where no such series exists FHIP shows "Benchmark data not available" and no number.

## What I actually viewed on 3 October 2026

| # | What | Result |
|---|---|---|
| 1 | `www.amfiindia.com/otherdata/listofbenchmarkindices` (fetch tool) | Connection refused. Nothing read. |
| 2 | `www.amfiindia.com/research-information/other-data/scheme-performance` (fetch tool) | Connection refused. Nothing read. |
| 3 | `www.amfiindia.com/polling/amfi/fund-performance` (fetch tool) | Connection refused. Nothing read. |
| 4 | `www.amfiindia.com/research-information/other-data/zcollatedprcbenchmarks` (fetch tool) | Connection refused. Nothing read. |
| 5 | The same first page in the Browser pane | The pane did not load it (it kept showing an unrelated site); nothing read. |
| 6 | `portal.amfiindia.com/spages/14110.pdf` (an AMFI-hosted copy of one scheme information document) | Read. Details below. |
| 7 | Two web searches (what the AMFI pages contain) | Search-result summaries only: SECONDARY. |
| 8 | One press article on AMFI's Tier-1 list (Cafemutual, 1 December 2021 release) | Read. SECONDARY. |

The earlier session (1 October 2026) had the same result for every AMFI website page (connection refused or timed out on every attempt), so **AMFI's own pages have now been unreadable from this environment on two separate days.** I have therefore not seen what the AMFI scheme-performance page, the Tier-1 benchmark list or the PRC (debt risk-class) list actually contain. Everything below about their contents is SECONDARY or UNVERIFIED.

## Per-candidate verdicts

### 1. The scheme's own document (information document / KIM / factsheet / addendum): the strongest source

* **Observed (item 6).** The AMFI-hosted information document for a multi-asset fund states its benchmark in three places (cover page, the key-information table and a "how will the scheme benchmark its performance" section), says the benchmark is the total-return variant, and says the trustee may change the benchmark later. The same document carries a scheme-versus-benchmark returns table for **fixed periods only** (last 1 year, last 3 years, last 5 years, since inception), with "not available" where the scheme is too young.
* **Observed (item 6), important finding.** That scheme's declared benchmark is a **composite** (65% Nifty 500 TRI, 25% Nifty Composite Debt Index, 10% price of domestic gold). One catalogue series cannot represent it, and a gold price is not an index. The mapping logic therefore reports such declarations as **unsupported** and never approximates them by one leg. Multi-asset funds will commonly be in this position.
* **Observed earlier (1 October).** SEBI circulars of 4 January 2018 (benchmarks must be total-return indices) and 27 October 2021 (two-tier benchmark; Tier-1 reflects the scheme category from a list AMFI publishes; Tier-2 optional). Benchmark changes are announced by addendum on the fund house's own site (a dated example exists for one large-cap fund).
* **Freshness.** Per document, dated by the document itself; changes arrive by addendum, so a mapping must carry an effective-from date and, once superseded, an effective-to date.
* **Downloadable file?** Public PDFs, one per scheme per document. No structured feed was found.
* **Terms.** The documents are public regulatory disclosures; I did not read each fund house's website terms, so whether extracting the benchmark name and date (with citation) is acceptable is **UNVERIFIED** and a question for counsel. Extracting a name and a date is a much lighter use than storing index levels.
* **Verdict.** Best available authority for the benchmark NAME. Use it with the document URL, document date and retrieval date as evidence. Not usable for performance figures.

### 2. AMFI per-scheme benchmark name (the AMFI scheme-performance page)

* **UNVERIFIED (SECONDARY only).** Search summaries say the page lists scheme performance with Tier-1 and Tier-2 benchmark returns for 1 year, 3 years, 5 years and since inception, and offers an Excel download. I could not open the page, so I cannot confirm that it names each scheme's benchmark in a usable field, how fresh it is, whether the download exists, or what its terms say.
* **What it could never do (reasoning, not observation).** Fixed periods cannot answer "how did this fund do against its benchmark over the years I held it".
* **Verdict.** Not verified usable. The pipeline treats this source as **skipped unless someone has opened the page, confirmed the field and marked it usable**. Until then it contributes nothing. PO action: someone with working access can open the page once and record the columns, the date shown and the page's terms.

### 3. AMFI SEBI-category recommended benchmark list (Tier-1 list, and the PRC list for open-ended debt)

* **SECONDARY.** A press article (read) says AMFI released the Tier-1 list on 1 December 2021, pairing NSE and BSE indices for equity categories, NSE and CRISIL for debt, and NSE and CRISIL for hybrids. Search summaries add that a separate AMFI page lists debt categories by potential risk class with CRISIL and NSE options. **The lists themselves were not read** (items 1 and 4).
* **Why it matters.** It is a category-level list. For most equity categories it allows **more than one** index (for example a large-cap fund may use an NSE or a BSE index), so it cannot tell you which one a given scheme uses. It is a proposal source only.
* **Verdict.** Category defaults built from it are UNVERIFIED and always LOW confidence. In the new pipeline they are only ever a **review-only proposal**, offered only when no scheme document exists, listing each permitted index as an alternative (never ranked), and never published without a named reviewer. Debt, gold, international, index-fund, fund-of-fund and sectoral categories have **no** default at all, because their choice depends on a list nobody read or on the scheme's own index or theme.

### 4. CAMS / KFin (the registrars)

* **UNVERIFIED.** I did not read any CAMS or KFin page this session, and nothing I read describes a registrar-published scheme-to-benchmark mapping. Registrar statements carry units and values, not benchmark names. I found no evidence that either holds an authoritative benchmark field.
* **Verdict.** No evidence of a usable source. Not pursued.

### 5. Index level history (for completeness; unchanged from 1 October)

NSE Indices, BSE Index Services and CRISIL all restrict their sites and data to personal or internal non-commercial use and prohibit automated collection; no open licence was found. That is why the entitlement gates (storage, calculation, display, export) stay exactly as they are and why a missing licensed series shows "Benchmark data not available".

## What this means for the build

* Mapping (name) is sourced from scheme documents, with evidence, ranked above everything else. It needs no index licence.
* The comparison is computed by FHIP from stored levels over the investor's own holding period, only where a verified catalogue entry has an approved entitlement. Otherwise: no number.
* Open items for the PO are listed in the engineering report that accompanies this note.

## Unverified items to close (suggested, none done)

1. Open the AMFI scheme-performance page and the Tier-1 and PRC benchmark lists in a normal browser; record the columns, the "as of" date, whether Excel download exists, and the page's own terms.
2. Counsel to confirm that recording each scheme's declared benchmark name and effective date from its public document, with citation, is acceptable.
3. Check the fund houses' own website terms for the documents already cited as evidence.
