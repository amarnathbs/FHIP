# FDH-12 — India Retirement Scope

Spec sections 7, 9, 68-70, 136.

## The discipline

> "Do not invent India retirement architecture if it does not exist."
> "Do not build an India-specific retirement calculation engine merely to parse
> a statement."
> "If canonical India retirement functionality itself is missing, document the
> gap."

## What canonical FHIP actually has

**Catalogue support only.** Migration
`0100_app_review_tier2_india_retirement_catalogue.sql` added three
`master_financial_items` rows in the `retirement` category — `epf`, `ppf`,
`nps` — with `country_applicability` left NULL (globally creatable, deliberate).
`lib/validation/retirement.ts` accepts `account_type` values `EPF`, `PPF`, `NPS`.

That is the whole of it. There is:

* no EPF interest model,
* no NPS Tier I / Tier II structure (disclosed by 0100's own header),
* no PPF maturity or lock-in logic,
* no India-specific retirement projection,
* no India retirement tax treatment.

An India retirement account is, canonically, a `current_balance` in INR that is
summed into net worth exactly like an Australian one.

## What FDH-12 built

**One adapter, no engine.** `fdh12_generic_epf_passbook_csv_v1` reads an EPF
passbook export (`Date`, `Particulars`, `Amount`) into the SAME evidence tables
as an AU super statement, using the same classification rules with three
India-specific label additions (employer share, employer PF, employer NPS, and
their employee counterparts), gated to the `IN` jurisdiction.

The extraction result type is byte-identical to the AU one — asserted by a test
that compares the key sets. There is no second India engine, only an adapter.

## Status, stated per spec 136

| Capability | Status |
| --- | --- |
| Canonical India retirement capability | **CATALOGUE-ONLY** (pre-existing; see the gap register) |
| FDH-12 India statement ingestion | **PARTIAL** — EPF passbook CSV certified; NPS and PPF statement layouts NOT implemented |
| India retirement calculation engine | **NOT BUILT, deliberately** (spec 9) |

No unbuilt India parser is pretended to exist.

## Currency (spec 68)

`retirement_jurisdiction` and `currency_code` are both explicit on every
statement. The upload route refuses an AU/INR or IN/AUD combination. Account
matching never crosses currencies. AUD and INR are never summed by FDH-12 —
the existing dashboard FX treatment is untouched.

## Cross-border (spec 69-70)

**Residence does not determine retirement jurisdiction.** An Australian
resident may hold an Indian EPF account and an Indian resident may retain
Australian super. Nothing in FDH-12 consults `country_of_residence` to accept
or reject a statement — stated in the upload route's own comment and true by
the absence of any such read. Country may control default visibility elsewhere
in the app; FDH-12 erases no legitimate foreign retirement holding.

The one jurisdiction gate FDH-12 respects is the pre-existing SMSF AU gate,
which belongs to the SMSF module.
