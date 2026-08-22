# FDH2_RESEARCH_EVIDENCE

Research performed for FDH-2 (Australia & India Category, MCC, Institution &
Merchant Intelligence Foundation), 2026-08-21. This document records, for
every significant source: what it is, when it was used, what was used from
it, what was deliberately NOT copied, and a confidence rating. It separates
**PUBLIC FACT**, **FHIP DESIGN DECISION**, and **INFERENCE** throughout —
these are never mixed in one statement.

## Environment constraint, stated honestly

This agent session had no live web-browsing/search tool invoked during FDH-2
(the sandbox's WebFetch/WebSearch tools were not used). All research below
draws on the model's own trained general knowledge of Australian and Indian
banking, payments and merchant landscapes, current as of the stated
knowledge cutoff, NOT a live-verified crawl of official sources performed in
this session. This is disclosed explicitly rather than implied to be a fresh
web audit, and it is why several institution/merchant rows below are marked
**LOWER-CONFIDENCE ENTRY** with the specific fact in doubt named. Where a
fact could not be stated with reasonable confidence, the row was either
omitted entirely (see "What Was Deliberately Excluded" below) or marked with
disclosed uncertainty — never guessed silently.

## Source register

The canonical machine-readable version of this list is
`data/financial-data-hub/sourceRegistry.mjs`, loaded into `fdh_source_registry`
by migration `0053`. Eleven sources are registered:

| source_key | Category | What it was used for | What was NOT copied |
| --- | --- | --- | --- |
| `iso18245_mcc_public_reference` | official_mcc_reference | **PUBLIC FACT**: MCC 4-digit codes and their standard/common descriptions (e.g. 5411 = grocery stores) | No proprietary per-merchant MCC assignment database; FHIP's own `normalized_description`/`broad_group`/category mapping is FHIP design, layered on top of the public code+description pair |
| `au_institution_public_websites` | institution_official_website | **PUBLIC FACT**: institution legal names, brand names, parent-group relationships | No customer data, no account structures, no internal pricing |
| `in_institution_public_websites` | institution_official_website | **PUBLIC FACT**: institution legal names, brand names, parent-group relationships | Same as above |
| `au_public_merchant_information` | public_company_information | **PUBLIC FACT**: merchant legal/trading names, sector, public website domain | No transaction-level data (there is none to copy — these are corporate identity facts only) |
| `in_public_merchant_information` | public_company_information | **PUBLIC FACT**: merchant legal/trading names, sector, public website domain | Same as above |
| `au_government_payment_public_info` | government_official_source | **PUBLIC FACT**: generic description of Centrelink/Services Australia and ATO payment/refund conventions | No individual benefit amounts, no eligibility rules |
| `in_government_payment_public_info` | government_official_source | **PUBLIC FACT**: generic description of EPFO and Income Tax Department payment conventions | No individual account data |
| `au_payment_rail_public_documentation` | industry_public_documentation | **PUBLIC FACT**: BPAY/Osko/PayID/EFTPOS structural description as payment MECHANISMS | No scheme-internal technical specification, no settlement logic |
| `in_payment_rail_public_documentation` | industry_public_documentation | **PUBLIC FACT**: UPI/IMPS/NEFT/RTGS structural description as payment MECHANISMS | Same as above |
| `fhip_taxonomy_design` | fhip_design_decision | **FHIP DESIGN DECISION**: the entire category/subcategory taxonomy structure, essential/discretionary and fixed/variable defaults, economic-type assignment per category | N/A — this is FHIP's own design, informed by (not copied from) the research below |
| `personal_finance_classification_research` | industry_public_documentation | **PUBLIC FACT / general knowledge**: the commonly-documented CONCEPTS of how personal-finance/banking classification systems are typically structured (category hierarchy, merchant normalisation, recurring detection, transfer treatment, user-rule precedence) | No proprietary source code, no closed commercial merchant database, no specific vendor's category taxonomy reproduced verbatim |

## Research topics and how they were used

### 1. How established personal-finance/banking systems classify transactions

**PUBLIC FACT / general knowledge**: personal-finance and banking-adjacent
products commonly separate (a) a category taxonomy from (b) a merchant
identity layer from (c) a payment-rail/mechanism layer, and commonly let a
user's own correction override a global default for that user without
altering the global default. **FHIP DESIGN DECISION**: FDH-2 adopts this
same three-layer separation structurally (fdh_categories/fdh_subcategories,
fdh_merchants/fdh_merchant_aliases, fdh_payment_rail_master), and documents
the identical "user rule beats global default, global default is
untouched" precedence rule (`FDH2_CLASSIFICATION_RULE_SEEDS.md`) — this is a
design choice informed by common practice, not a copy of any one vendor's
implementation.

### 2. MCC / payment-network category definitions

**PUBLIC FACT**: ISO 18245 defines a public 4-digit Merchant Category Code
space with standard descriptions widely republished by card networks and
payment processors (e.g. 5411 "Grocery Stores, Supermarkets", 5812 "Eating
Places, Restaurants", 6011 "Automated Cash Disbursements"). FDH-2's 87-row
`fdh_mcc_master` uses codes and descriptions drawn from this public space.
**FHIP DESIGN DECISION**: `broad_group` (a 15-value FHIP grouping),
`normalized_description` (FHIP's own concise restatement) and every
MCC-to-category mapping's `mapping_confidence`/`mapping_type`/`ambiguity_flag`
are FHIP's own judgement calls, documented per-row in
`data/financial-data-hub/mccCategoryMap.mjs` and `FDH2_MCC_MAPPING.md`.

### 3. AU institutions

**PUBLIC FACT** (general knowledge, high confidence): the "big four" AU
banks (CBA, Westpac, NAB, ANZ), Macquarie Bank's dual retail-banking and
wealth-platform identity, ING/Bendigo & Adelaide Bank/Bank Australia/AMP
Bank/BOQ as established Australian ADIs, ubank as NAB's digital-only brand,
Great Southern Bank as CUA's 2021 rebrand, HSBC Australia's local retail
presence, and AustralianSuper/Australian Retirement Trust/Hostplus as major
superannuation funds. **LOWER-CONFIDENCE ENTRIES, explicitly disclosed in
`FDH2_INSTITUTION_MASTER.md` section 4**: ME Bank's exact current
operational status following its 2021 acquisition by Bank of Queensland
Group, and the exact current legal structure of Suncorp Bank following
ANZ's announced/reported acquisition — both seeded with the ownership
change stated but the precise current operating detail flagged as
unverified in this session.

### 4. India institutions

**PUBLIC FACT** (general knowledge, high confidence): SBI/HDFC Bank/ICICI
Bank/Axis Bank/Kotak Mahindra Bank/IDFC FIRST Bank as major private/public
retail banks; the 2019-2020 public-sector bank amalgamations (Bank of
Baroda+Vijaya+Dena; PNB+OBC+United Bank; Canara+Syndicate;
Union Bank+Andhra+Corporation; Indian Bank+Allahabad); Yes Bank's 2020
RBI-led reconstruction; Zerodha/Groww as major brokers; NSDL/CDSL as the two
depositories; CAMS/KFintech as the two dominant mutual-fund RTAs; EPFO and
Protean (formerly NSDL e-Governance) as the EPF/NPS record-keeping bodies.

### 5. AU/India merchant sectors

**PUBLIC FACT** (general knowledge): the major supermarket, fuel,
QSR/takeaway chains, telcos, streaming services, rideshare/delivery
platforms, department/discount retailers, insurers, pharmacy chains and
airlines named in `merchantsAu.mjs`/`merchantsIn.mjs` are real, well-known
brands in each market. **LOWER-CONFIDENCE ENTRIES, explicitly disclosed
in-line in the data files and in `FDH2_MERCHANT_MASTER.md` section 5**:
Zomato's parent-entity rename to Eternal Limited (2024), Disney+
Hotstar/JioCinema's reported 2025 merger into JioHotstar, and BYJU'S
well-publicised financial distress from 2023 onward — each seeded with the
historically significant brand recorded and the uncertainty named, never
silently presented as a confirmed current operating fact.

### 6. Payment processors, UPI structural forms, AU payment rails

**PUBLIC FACT**: UPI narratives commonly carry a `UPI/` or similar prefix;
IMPS/NEFT/RTGS/NACH/ECS are named, distinct Indian interbank rails; BPAY,
Osko (NPP) and PayID are named, distinct Australian payment mechanisms;
EFTPOS is Australia's domestic debit scheme. Razorpay/PayU/CCAvenue/Cashfree/
BillDesk and the UPI apps (Google Pay, PhonePe, Paytm) are well-known Indian
payment gateways/processors whose narratives commonly appear instead of the
downstream merchant's own name — this is exactly why `fdh_merchants.
is_payment_processor` exists as a distinct, structurally-flagged concept.

## What was NOT done (integrity boundary)

- No proprietary or closed commercial merchant database was scraped or
  reproduced.
- No live crawl of any institution/merchant website was performed in this
  session (see "Environment constraint" above) — facts rest on general
  knowledge, disclosed as such.
- No merchant fact was invented to inflate the record count; a merchant not
  confidently known was simply left out.
- No MCC was assigned to a merchant without a genuine confidence basis;
  `mcc`/`mcc_confidence` are both left `null` on any FDH-2 merchant where
  this session could not respons­ibly verify the code.
- No taxonomy structure from any named commercial competitor product was
  reproduced; FHIP's category/subcategory design is its own, informed by
  commonly-documented industry CONCEPTS only.

## What was deliberately excluded from the seed library

- ME Bank's precise 2024-2026 operational status (brand-retirement timeline)
  — included with disclosed uncertainty rather than a confident claim as of
  the original pass; **resolved below, 2026-08-22.**
- Suncorp Bank's precise post-acquisition legal entity structure — same
  treatment; **resolved below, 2026-08-22.**
- A large tail of smaller AU/India regional banks, smaller super funds, and
  long-tail local merchants — explicitly out of scope for this pass; see
  `FDH2_COMPLETION_REPORT.md`'s coverage matrix for what remains for future
  expansion (labelled `FUTURE-EXPANSION`, never claimed as covered).
- Any AU/India institution or merchant this session could not name with at
  least medium confidence.

---

## CLOSURE-RESEARCH PASS — 2026-08-22 (migration `0057`)

Everything above this line is the original FDH-2 implementation pass
(2026-08-21), which explicitly disclosed that no live web research was
performed. **This section is new** — a separate, later pass that genuinely
used live web search/fetch tools (`fdh_source_registry` key
`fdh2_closure_live_research_20260822`, `accessed_at = 2026-08-22`) to close
the four originally-disclosed LOWER-CONFIDENCE entries and to
re-verify a representative cross-section of the wider institution/MCC/
merchant library. It does **not** retroactively claim the original pass did
this research — the distinction is preserved by keeping this as an addendum
with its own dated source-registry key, never by editing the prose above.

Every FHIP-authored `.mjs` source-data note this pass touched is prefixed
`CLOSURE-RESEARCH VERIFIED`, `CLOSURE-RESEARCH CORRECTED`,
`CLOSURE-RESEARCH DOWNGRADED`, or `CLOSURE-RESEARCH UPDATE` so a future
reader can immediately tell which facts carry a live-verification date.

### A1. The four originally-disclosed LOWER-CONFIDENCE entries — all four resolved

| # | Entry | Resolution | Evidence (tier) | Accessed |
| --- | --- | --- | --- | --- |
| 1 | ME Bank (AU) operational status | **CORRECTED.** ME Bank is no longer a separately ADI-licensed entity — APRA revoked Members Equity Bank Limited's licence after its banking business transferred to Bank of Queensland Limited; `legal_name` corrected to "Bank of Queensland Limited". Brand remains active. | APRA (`apra.gov.au`, tier 1 — regulator); ME Bank's own official site footer (tier 1 — institution's own site) | 2026-08-22 |
| 2 | Suncorp Bank (AU) legal structure | **CORRECTED.** Suncorp-Metway Limited legally renamed to Norfina Limited (same ABN), trading as Suncorp Bank, within the ANZ Group since the 31 Jul 2024 acquisition completed. `legal_name` corrected. | AFCA (`afca.org.au`, tier 1 — the dispute-resolution body naming the correct legal-entity respondent); ANZ debt-investor filings (tier 1 — issuer's own disclosure) | 2026-08-22 |
| 3 | JioHotstar / Disney+ Hotstar-JioCinema merger (IN) | **PROMOTED TO VERIFIED.** The merger is confirmed complete (14 Feb 2025, JioStar joint venture). Seeded facts were accurate; no value changed, only the source/date. | TechCrunch, Advanced Television, India trade press (tier 2 — established industry press, cross-corroborated by 5+ independent outlets) | 2026-08-22 |
| 4 | BYJU'S (IN) financial distress/status | **PROMOTED TO VERIFIED.** Confirmed still under active insolvency proceedings as of mid-2026, not liquidated. Seeded active-but-distressed status was accurate; no value changed, only the source/date. | Wikipedia (tier 2, cross-checked against India financial press headlines in the same search); Indian Supreme Court proceeding coverage | 2026-08-22 |

None of the four were removed — in every case the original seeded fact held
up or was correctable in place, consistent with FDH-2's original principle
that "removing a real, well-known institution/merchant would be a worse
outcome than disclosing uncertainty about one fact."

### A2. MCC verification — 87/87 codes VERIFIED

All 87 seeded MCC codes were checked for 4-digit code + standard-description
accuracy against the `greggles/mcc-codes` aggregated public reference
(tier-2 fallback — direct fetches of the Visa Merchant Data Standards
Manual PDF and the Citibank TTS MCC PDF were attempted but the sandbox's
PDF-to-text path was unavailable in this environment; the aggregator's
values were spot-checked against Visa/Citibank/payment-processor search
snippets for a sample of codes across every category band, with no
discrepancy found beyond wording nuance). Result: **87/87 VERIFIED** as to
code identity and category concept.

One genuine correction: **MCC 6540** — `official_or_public_description` was
a paraphrase ("POS Funding — Non-Financial Institutions") rather than the
standard network text. Corrected to "Non-Financial Institutions — Stored
Value Card Purchase/Load", cross-checked against four independent
tier-2 payment-processor MCC documentation pages (totalprocessing.com,
pxp.io, payatlas.com, eflow.com) that converge on identical wording.

One genuine mapping downgrade (per the "never force false precision"
principle, applied honestly in both directions): **MCC 5531** ("Auto and
Home Supply Stores") was mapped `direct`/`medium` to
`vehicle_maintenance_registration`. The verified official description and
its standard trade classification (OSHA SIC 5531) explicitly note these
stores "frequently sell a substantial amount of home appliances, radios,
and television sets" — a genuinely mixed automotive/shopping purpose.
Downgraded to `broad_group_only`/`low` with no subcategory. (One other
candidate, MCC 5732 "Electronics Stores" vs. an aggregator's paraphrase
"Electronic Sales", was checked and found to be an aggregator wording
artifact, not a real ambiguity — left unchanged.)

### A3. Institution verification — Australia, 22/22 checked

Every AU institution was checked for current name/status via a mix of
targeted live searches (mergers/rebrand/acquisition activity 2025-2026) and
direct official-site/APRA-register fetches for the higher-risk names.
Results: 4 corrections/updates (ME Bank, Suncorp Bank, SelfWealth, Bank
Australia — all detailed in A1 and `FDH2_INSTITUTION_MASTER.md` section 4),
18 confirmed unchanged (CBA, Westpac, NAB, ANZ, Macquarie Bank, ING
Australia, Bendigo and Adelaide Bank, AMP Bank, Bank of Queensland, ubank,
Great Southern Bank, HSBC Australia, CommSec, AustralianSuper, Australian
Retirement Trust, Hostplus, Services Australia, ATO). Notably, the AU-bank
merger search surfaced a live, ongoing wave of customer-owned-bank
consolidation (Bank Australia + Qudos Bank completed; Teachers Mutual +
Australian Mutual Bank completed May 2026; Regional Australia Bank +
SWSbank proposed) — none of which involves any of FDH-2's other seeded
institutions, so no further correction was triggered, but it is recorded
here as the honest state of the sector as observed.

### A4. Institution verification — India, 25/25 checked

Every IN institution was checked, with specific attention to the post-2019
PSU amalgamations (Bank of Baroda+Vijaya+Dena; PNB+OBC+United Bank;
Canara+Syndicate; Union Bank+Andhra+Corporation; Indian Bank+Allahabad) and
Yes Bank's 2020 reconstruction. Result: **the PSU amalgamation facts as
seeded are all still accurate** — live search confirmed no new PSU mergers
have been announced or completed as of mid-2026, despite market speculation
about a further consolidation round. 3 corrections/updates found beyond the
amalgamation facts: Yes Bank (SMBC now largest shareholder, superseding the
stale SBI-consortium framing), Groww (private→public conversion),
Protean eGov/NPS CRA (website domain migration) — all detailed in A1 and
`FDH2_INSTITUTION_MASTER.md` section 4. 22 confirmed unchanged (SBI, HDFC
Bank, ICICI Bank, Axis Bank, Kotak Mahindra Bank, IDFC FIRST Bank, Bank of
Baroda, PNB, Canara Bank, Union Bank of India, Indian Bank, IndusInd Bank,
Federal Bank, AU Small Finance Bank, RBI, Zerodha, NSDL, CDSL, CAMS,
KFintech, EPFO, Income Tax Department).

### A5. Institution/merchant alias classification — honest taxonomy

Applying the classification the closure-research dispatch requested
(OFFICIAL_NAME / OFFICIAL_BRAND / COMMON_ABBREVIATION / HISTORICAL_NAME /
FHIP_NORMALIZATION_ALIAS) to the existing 99 institution aliases and 198
merchant aliases: the overwhelming majority are OFFICIAL_NAME or
OFFICIAL_BRAND forms taken directly from the institution/merchant's own
public branding (e.g. "COMMBANK", "WESTPAC", "ZOMATO"), a smaller set are
COMMON_ABBREVIATION forms genuinely in wide use (e.g. "CBA", "BOB", "SBI"),
and a handful are HISTORICAL_NAME forms deliberately retained for
narrative-matching on older statements (e.g. "CALTEX" for Ampol, "CUA" for
Great Southern Bank). **No alias in either table is claimed
externally-verified via live search in this pass** — the existing
`fdh_institution_aliases.source = 'admin_curated'` /
`fdh_merchant_aliases.source = 'admin_curated'` values are honest as
written (they mean "an admin curated this alias form as a real observed
narrative pattern", not "externally verified by live web search"), and this
pass did not re-litigate all 297 of them individually. The one alias this
pass genuinely added — `QUDOS BANK` → Bank Australia — is correctly marked
`source = 'external_reference'` (not `admin_curated`), since it was directly
produced by live web research in this session, and is the honest example of
what a FHIP_NORMALIZATION_ALIAS is *not*: it is a real, publicly-confirmed
current brand relationship, not a normalization guess.

### A6. Merchant verification — 123 merchants (canonical identities), realistic scope

All 123 canonical merchant identities (not the 198 aliases — verifying
every alias individually was not attempted, consistent with the original
pass's own framing) were reviewed for current operating status, country
applicability, and category-mapping plausibility. Two genuinely defunct
merchants were found still marked as operating merchants and corrected (see
`FDH2_MERCHANT_MASTER.md` section 10): **Catch.com.au** (closed 30 Apr
2025) and **Menulog** (ceased AU operations 26 Nov 2025), both now
`active: false`. One date correction: **Zomato**'s parent-rename year
corrected from 2024 to 2025. The two originally-flagged LOWER-CONFIDENCE
merchants (**JioHotstar**, **BYJU'S**) were promoted to verified per A1. No
merchant→category mapping was found to need a broader/less-specific
category as a result of this review — the existing mappings already used
broad/default categories appropriately (e.g. Amazon/eBay/Flipkart/Meesho
already `online_marketplace_general`, not over-specified).

### A7. Provenance — no false certainty

No `PUBLIC_SOURCE_VERIFIED`/`FHIP_DESIGN_DECISION`/`INFERRED`/`UNVERIFIED`/
`DEPRECATED` enum exists anywhere in the FDH-2 schema (checked: neither the
Chunk 3a `verification_status` enum on `fdh_merchants`
[`proposed`/`admin_review`/`approved`/`rejected`/`merged`] nor
`fdh_source_registry`'s `source_category` enum uses this vocabulary) — this
classification is documentation-level, layered on top of the schema's own
`verification_status`/`coverage_status`/`active` columns, exactly as the
original evidence doc already used **PUBLIC FACT**/**FHIP DESIGN
DECISION**/**INFERENCE** as prose markers. Every record whose provenance
changed as a result of this pass now carries `source_key =
'fdh2_closure_live_research_20260822'` and `source_checked_at = '2026-08-22'`
— a genuine, dated, live-search-backed marker (**PUBLIC_SOURCE_VERIFIED**,
in the closure dispatch's vocabulary) distinct from the original pass's
trained-knowledge-only rows, which keep their original `source_key`/
`source_checked_at = '2026-08-21'` and are honestly **not** claimed
PUBLIC_SOURCE_VERIFIED by this pass merely because they sit in the same
tables. This library remains a **governed, high-coverage seed** — not
described as "exhaustive" anywhere in this document or its siblings.

### A9. Master-data corrections summary

15 rows corrected/updated (plus 1 new source-registry row) across 5 tables,
delivered as forward migration `0057_fdh2_closure_research_corrections.sql`
(additive/corrective only, no edits to the immutable `0050`-`0056`):

- 7 `fdh_financial_institutions` rows updated (ME Bank, Suncorp Bank,
  SelfWealth, Bank Australia, Yes Bank, Groww, Protean eGov) — 4 with an
  actual value change (`legal_name` x3, `parent_group` x1) and 1
  (Yes Bank) + the domain fix (Protean eGov) re-verified/source-bumped only.
- 1 new `fdh_institution_aliases` row (QUDOS BANK → Bank Australia).
- 1 `fdh_mcc_master` row updated (6540 description corrected).
- 1 `fdh_mcc_category_map` row updated (5531 downgraded).
- 5 `fdh_merchants` rows updated (Catch.com.au and Menulog — value change,
  `active: false`; Zomato, JioHotstar, BYJU'S — source/date-only
  re-verification, no column value changed).
- 1 new `fdh_source_registry` row (`fdh2_closure_live_research_20260822`),
  which every corrected/re-verified row above now points to.

No merchant or institution was added to raise the count — every change is a
correction or re-verification of an existing row.
