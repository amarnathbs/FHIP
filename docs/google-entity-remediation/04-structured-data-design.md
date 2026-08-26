# 04 — Structured Data Design (Phases 5-8)

Implemented in `lib/seo/entity.ts` (`buildFhipEntityJsonLd()`), emitted site-wide from
`app/layout.tsx` as a single `@graph` inside one `application/ld+json` script tag.

## The graph

```
Organization (@id: {appUrl}/#organization)
  name: "FHIP"
  alternateName: "Financial Health Intelligence Platform"
  url: "https://myfhip.com"
  logo: { ImageObject, url: {appUrl}/images/fhip-logo-mark.png }
  sameAs: ["{appUrl}"]
        ▲ publisher                              ▲ publisher
        │                                         │
WebSite (@id: {appUrl}/#website)          WebApplication (@id: {appUrl}/#webapp)
  name: "FHIP"                               name: "FHIP"
  alternateName: [                           alternateName: "Financial Health Intelligence Platform"
    "Financial Health Intelligence Platform",  url: "{appUrl}"
    "FHIP | Financial Health"                  applicationCategory: "FinanceApplication"
  ]                                            operatingSystem: "Web"
  url: "https://myfhip.com"                    isPartOf: { @id: {appUrl}/#website }
        ▲ isPartOf ───────────────────────────────┘
```

Where `{appUrl}` = `getFhipApplicationUrl()` = the resolved `APP_BASE_URL`
(`https://app.financialhealthplatform.com` in production).

## Why every `@id` is anchored on the application host, not myfhip.com

`@id` values should be dereferenceable/stable URLs under the publisher's control. `myfhip.com`
never serves a page of its own — it is a pure Cloudflare-level 301 redirect (live-verified, see
`01-domain-inventory.md`) — so anchoring `@id` there would point crawlers at a URL that can never
actually return this JSON-LD. Anchoring on the application host, which is where this markup is
genuinely served from, keeps the IDs stable and fetchable.

## Why `Organization.url` and `WebSite.url` are still `myfhip.com`

This is the deliberate design choice that does the actual entity-consolidation work. A structured
data node's `url` property declares what URL the *entity* (not the markup) considers its primary
address — it does not have to match the page's own canonical URL, and doing so is not the same
misuse Phase 9 warns against (that rule is about HTML `<link rel="canonical">` tags, which must
match the page actually being served; a JSON-LD entity's stated `url` is a different, and
legitimate, mechanism for exactly this "which domain represents this brand" signal). Per the
Product Owner's explicit intent (spec §4/§9): `myfhip.com` is the designated public brand entry
point. Declaring it as the `url` of the `Organization` and `WebSite` nodes is the correct,
non-manipulative way to tell Google "this entity's canonical public address is myfhip.com" without
touching the HTML canonical tag of the page that happens to be serving the markup.

## Why `WebApplication.url` is the application domain, not myfhip.com

The `WebApplication` node describes the actual running software, which genuinely lives at
`app.financialhealthplatform.com` — declaring it as `myfhip.com` would be inaccurate (myfhip.com
cannot run the application; it only redirects to it). This is the same principle as Phase 9's
`<link rel="canonical">` rule applied to structured data: don't claim a URL for an entity that
doesn't actually represent it.

## `sameAs` usage — deliberately narrow

`Organization.sameAs` contains exactly one URL: the application domain
(`https://app.financialhealthplatform.com`). Per Google's own Organization structured-data
guidance, `sameAs` should list "URLs of the item's official social media profiles... or other web
references that unambiguously indicate the item's identity." No social profiles are asserted here
because none have been established for this task to point to (no invented social profiles per the
hard rules) — see `37-external-entity-authority-plan` (folded into the final report's Phase 37
section) for a legitimate future plan. The one `sameAs` entry that does exist is FHIP's own,
FHIP-controlled application URL, which is a genuinely unambiguous identity reference, not a
third-party claim. `sameAs` is deliberately **not** used between `WebSite` and `WebApplication`
(they are different entity types describing different things — a website identity and a piece of
software — so declaring them "the same as" each other would be the kind of misuse Phase 8 warns
against). The relationship between them is instead expressed correctly via `isPartOf`/`publisher`.

## `isPartOf` / `publisher` — the chosen cross-domain relationship (Phase 8's central decision)

- `WebSite.publisher` → `Organization` (standard schema.org pattern: a website is published by an
  organization).
- `WebApplication.publisher` → the same `Organization` node (the application is published by the
  same organization as the website — this is the fact that ties `app.financialhealthplatform.com`
  and `myfhip.com` together as one entity's properties).
- `WebApplication.isPartOf` → `WebSite` (the running application is part of the broader FHIP web
  presence/product, whose stated `url` is `myfhip.com`).

This was chosen over the alternatives evaluated per Phase 8:

- **`mainEntity`**: rejected — that property is for a page's primary subject (e.g. a `WebPage`'s
  `mainEntity`), not for tying two top-level entities together at the site level.
- **A second `sameAs` between WebSite and WebApplication**: rejected as a misuse (see above).
- **Making the application's own canonical/`<link>` point at myfhip.com**: rejected per Phase 9's
  explicit rule against forcing application URLs to canonicalize to the marketing domain.

`isPartOf` + shared `publisher` is the combination Google's own documentation and common
real-world implementations use for "this application belongs to this broader site/brand," and it
requires no manipulative or unsupported claim.

## What was deliberately NOT added

- No `legalName`, `foundingDate`, `address`, `taxID`, `duns`, `numberOfEmployees`, or any other
  Organization property that would assert a corporate fact not established in this repository —
  per the hard rule against inventing corporate facts. If the Product Owner later establishes a
  registered legal entity, these can be added truthfully at that time.
- No `AggregateRating`/`Review` schema — no reviews exist; fabricating one would violate Google's
  structured-data guidelines and the standing hard rules.
- No `sameAs` entries for social profiles that do not exist.
- No claim of `FinancialProduct`, `BankOrCreditUnion`, `InsuranceAgency`, or any other regulated
  financial-entity schema.org type — FHIP is explicitly modelled as `WebApplication` with category
  `FinanceApplication` (a personal financial-information/analysis tool), not a financial
  institution, matching Phase 7's explicit constraint.
