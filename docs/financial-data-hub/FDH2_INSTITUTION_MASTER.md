# FDH2_INSTITUTION_MASTER

## 1. Coverage

22 AU institutions + 25 India institutions = 47 total (`fdh_financial_
institutions`), plus 99 aliases (`fdh_institution_aliases`) and 3
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

## 4. Known lower-confidence entries — RESOLVED 2026-08-22 (closure-research pass)

Two institutions originally carried an explicit `notes` disclosure because
FDH-2's initial implementation had no live web access. A dedicated
closure-research pass (migration `0057`, see `FDH2_RESEARCH_EVIDENCE.md`'s
closure-research section) genuinely live-verified both:

- **ME Bank (AU)** — APRA revoked Members Equity Bank Limited's ADI licence
  after its banking business transferred to Bank of Queensland Limited
  following BOQ's 2021 acquisition; ME Bank's own official site now states
  it is "a division of Bank of Queensland Limited". `legal_name` corrected
  from the pre-acquisition "Members Equity Bank Pty Limited" to the current
  licence holder, "Bank of Queensland Limited". The ME retail brand remains
  actively operated.
- **Suncorp Bank (AU)** — ANZ completed its acquisition on 31 July 2024.
  Suncorp-Metway Limited legally renamed to **Norfina Limited** (same ABN
  66 010 831 722) as part of the transition, continuing to trade as
  "Suncorp Bank" (AFCA confirms complaints are filed against Norfina
  Limited). It remains a separate ADI within the ANZ Group pending an
  eventual single-licence merger. `legal_name` corrected accordingly.

Both facts are now sourced to a live, dated verification rather than
trained-knowledge recall — see `fdh_source_registry` key
`fdh2_closure_live_research_20260822`.

### Additional corrections/updates from the same pass

- **SelfWealth (AU)** — acquired by Syfe (Singapore fintech, via Svava Pte
  Ltd) in 2025 after a competing takeover contest against Bell Financial
  Group and AxiCorp; delisted from the ASX. `parent_group` added.
- **Bank Australia (AU)** — completed its merger with Qudos Bank on 1 July
  2025; both retail brands now operate under the single Bank Australia Ltd
  legal entity. A `QUDOS BANK` alias was added so that narrative resolves
  to this institution. A further prospective merger with P&N Group is under
  member consideration (vote expected 2027) and is deliberately **not**
  reflected as complete.
- **Yes Bank (IN)** — the originally-seeded SBI-led-consortium ownership
  fact was accurate as of 2020 but had gone stale: Sumitomo Mitsui Banking
  Corporation (SMBC) has since become Yes Bank's largest shareholder
  (~24.2%, 2025) via a secondary purchase from SBI and other lenders. Not a
  majority/controlling stake, so `parent_group` is deliberately left null.
- **Groww (IN)** — the holding company converted from a private to a public
  limited company ahead of its November 2025 IPO. `legal_name` corrected
  from "...Private Limited" to "...Limited".
- **Protean eGov Technologies / NPS CRA (IN)** — the NPS CRA informational
  site migrated from `npscra.nsdl.co.in` to `npscra.proteantech.in`.
  `website_domain` corrected.

## 5. Alias library

99 aliases across 47 institutions (avg. ~2.1 per institution — 98 from the original seed plus 1 added by the 2026-08-22 closure-research pass, QUDOS BANK -> Bank Australia), covering the
common short forms and legal-name variants actually seen in the wild (CBA /
COMMBANK / COMMONWEALTH BANK / COMMONWEALTH BANK OF AUSTRALIA all resolving
to one institution; SBI / STATE BANK OF INDIA; etc.). Zero speculative
aliases — every alias is a form this session holds real confidence is
actually used. `scripts/fdh2_certify_master_data.mjs` proves zero aliases
collide across two different institutions.
