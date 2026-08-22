# FDH2_INSTITUTION_MASTER

## 1. Coverage

22 AU institutions + 25 India institutions = 47 total (`fdh_financial_
institutions`), plus 98 aliases (`fdh_institution_aliases`) and 3
multi-capability rows (`fdh_institution_capabilities`).

**AU (22)**: CBA, Westpac, NAB, ANZ, Macquarie Bank (+broker/
investment_platform capabilities), ING Australia, Bendigo and Adelaide
Bank, Bank Australia, AMP Bank, Bank of Queensland, ME Bank, ubank, Great
Southern Bank, HSBC Australia, Suncorp Bank — 15 banks — plus CommSec and
SelfWealth (brokers), AustralianSuper/Australian Retirement Trust/Hostplus
(super funds), and Services Australia/ATO (government payment sources).

**India (25)**: SBI, HDFC Bank, ICICI Bank, Axis Bank, Kotak Mahindra Bank,
IDFC FIRST Bank, Bank of Baroda, PNB, Canara Bank, Union Bank of India,
Indian Bank, IndusInd Bank, Federal Bank, Yes Bank, AU Small Finance Bank —
15 banks — plus RBI (government payment source), Zerodha and Groww
(brokers, Groww also carries a `mutual_fund_platform` capability), NSDL and
CDSL (depositories), CAMS and KFintech (mutual-fund platforms/RTAs), EPFO
and Protean eGov Technologies (retirement providers), and the Income Tax
Department (government payment source).

Every institution meets or exceeds the specification's stated minimum list
(CBA/Westpac/NAB/ANZ for AU; SBI/HDFC/ICICI/Axis/Kotak Mahindra/IDFC FIRST/
Bank of Baroda/PNB for India) and evaluates every additionally-named
candidate (Macquarie/ING/Bendigo/Bank Australia/AMP Bank/BOQ/ME/ubank/Great
Southern Bank; Canara/Union Bank of India/Indian Bank/IndusInd/Federal
Bank/Yes Bank/AU Small Finance Bank) — all were included.

## 2. Institution types and capabilities

`institution_type` (widened, migration `0051`, additive: adds
`government_payment_source` and `payment_processor` to FDH-1's original 11
values) is the institution's PRIMARY declared identity. Where an
institution genuinely holds a second capability (Macquarie Bank: bank +
broker + investment_platform; Groww: broker + mutual_fund_platform),
`fdh_institution_capabilities` records the extras — the institution row is
never duplicated to express a second capability.

## 3. Coverage status — no premature parser claim

`coverage_status` (new column, default `master_only`) uses the six-value
enum `master_only`/`parser_planned`/`parser_in_development`/
`parser_certified`/`connected_data_future`/`deprecated`. **All 47 seeded
institutions are `master_only`** — verified structurally by
`tests/unit/fdh2SchemaContract.test.ts`'s "no institution is seeded above
master_only coverage" check, which scans every seed migration's literal
coverage-status values. No FDH-2 institution implies parser support exists;
none does (FDH-3+).

## 4. Known lower-confidence entries (disclosed, not hidden)

Two institutions carry an explicit `notes` disclosure because this
session's research had no live web access (see `FDH2_RESEARCH_EVIDENCE.md`):

- **ME Bank (AU)** — acquired by Bank of Queensland Group in 2021; the
  precise current operational status of the ME retail brand (continued
  independent operation vs. full migration into BOQ's platforms) could not
  be independently re-verified. Seeded as a historically significant
  institution with the ownership change stated and the operational detail
  flagged uncertain.
- **Suncorp Bank (AU)** — ANZ's acquisition was publicly announced in 2022
  and reported completed in 2024; the precise current legal/operational
  structure could not be re-verified. Same treatment.

Both remain seeded (removing a real, well-known institution would be a
worse outcome than disclosing uncertainty about one fact), and both are
flagged for a future research pass with live web access before any
downstream phase treats their `parent_group`/status as settled fact.

## 5. Alias library

98 aliases across 47 institutions (avg. ~2.1 per institution), covering the
common short forms and legal-name variants actually seen in the wild (CBA /
COMMBANK / COMMONWEALTH BANK / COMMONWEALTH BANK OF AUSTRALIA all resolving
to one institution; SBI / STATE BANK OF INDIA; etc.). Zero speculative
aliases — every alias is a form this session holds real confidence is
actually used. `scripts/fdh2_certify_master_data.mjs` proves zero aliases
collide across two different institutions.
