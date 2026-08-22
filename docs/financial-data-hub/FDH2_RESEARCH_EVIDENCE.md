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
  — included with disclosed uncertainty rather than a confident claim.
- Suncorp Bank's precise post-acquisition legal entity structure — same
  treatment.
- A large tail of smaller AU/India regional banks, smaller super funds, and
  long-tail local merchants — explicitly out of scope for this pass; see
  `FDH2_COMPLETION_REPORT.md`'s coverage matrix for what remains for future
  expansion (labelled `FUTURE-EXPANSION`, never claimed as covered).
- Any AU/India institution or merchant this session could not name with at
  least medium confidence.
