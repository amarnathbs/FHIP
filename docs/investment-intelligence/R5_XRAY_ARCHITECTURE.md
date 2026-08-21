# R5 — Portfolio X-Ray Architecture, Look-Through and Overlap Methodology

Every formula, threshold, and suppression condition used by R5's look-through
analytics. Nothing important about this methodology exists only in code.

Governing versions (embedded in every persisted result):

| Component | Version constant |
| --- | --- |
| Engine | `xray-engine-r5-v1` |
| Security resolution | `security-resolution-identifier-first-r5-v1` |
| Look-through | `lookthrough-weighted-r5-v1` |
| Overlap | `overlap-min-weight-r5-v1` |
| Concentration | `concentration-r5-v1` |
| Exposure aggregation | `exposure-aggregation-r5-v1` |
| Debt | `debt-xray-r5-v1` |
| Thresholds | `xray-thresholds-r5-v1` |

---

## 1. Why new schema was required

R1's `ii_fund_holdings` (migration 0031) is explicitly "look-through data shape
only". Inspected before designing anything, it has:

* `fund_instrument_id`, `underlying_instrument_id`, `underlying_name`,
  `disclosure_date`, `weight_pct`, `source_id`

and therefore **no** snapshot versioning, no market value or quantity, no
sector/industry/market-cap classification, no credit rating, no maturity, no
duration, no issuer, no ingestion timestamp, no source document version, and no
quality status. Its `unique(fund, underlying, disclosure_date)` constraint also
cannot dedupe unresolved lines, because Postgres treats NULLs as distinct.

Migration **0044** adds the versioned structures R5 needs, additively. R1's
table is left untouched.

## 2. Holdings snapshot architecture

`ii_fund_holdings_snapshots` (headers) + `ii_fund_holdings_lines` (detail).

Fields carried where the source provides them: fund instrument, underlying
canonical security, underlying source identifier, holding name, ISIN, issuer,
quantity, market value, portfolio weight, sector, industry, market-cap
classification, security type, credit rating, maturity date, coupon, modified
duration, source, source document/data version, holdings as-of date, ingestion
timestamp, quality status.

Nothing requires an unavailable field. Absence means **unavailable**, never zero.

### Snapshots are preserved, never overwritten

A new snapshot never destroys an older one. Each disclosure is its own
immutable row. `superseded_at` is informational only; superseded rows are
retained and remain auditable.

### As-of selection (no look-ahead)

`selectSnapshotAsOf()` uses the **latest eligible snapshot at or before the
analytics as-of date**, tie-broken by snapshot id for determinism.

A **future snapshot is never used to describe an earlier portfolio date.**
Asserted directly: given snapshots dated 2024-01-31, 2024-05-31 and 2024-09-30,
an as-of of 2024-06-30 selects 2024-05-31, and an as-of of 2024-02-15 selects
2024-01-31 — the older snapshot is still there and still correct for its date.

### Ingestion architecture

`FundHoldingsProvider`-shaped: the schema and repository are not coupled to any
one external website. Permitted initial implementations are a controlled admin
import, an approved structured source, or a versioned seed/test source, each
recorded via `source_id` + `source_data_version`. R5 does **not** scrape
unstable websites and does not claim production coverage for an unverified
source.

## 3. Canonical underlying-security resolution

**A display name is never an identity.** There is no edit-distance matching, no
token-overlap scoring and no "close enough" threshold anywhere in
`securityResolution.ts`.

Strict priority, first match wins:

1. **ISIN** — globally unique, strongest identity
2. **Exchange/security identifier** — NSE symbol, BSE code (country-scoped)
3. **Approved provider identifier** — e.g. an AMFI scheme code
4. **Controlled alias** — a curated, admin-approved exact string in
   `ii_security_aliases`. This is the *only* place a name participates in
   identity, and only because a human approved that exact string. Unique on
   `alias_normalised`, so one name can never map to two securities.
5. **Exact deterministic map** — a source-specific exact identifier map
6. **UNRESOLVED** — surfaced for reconciliation

Alias normalisation is minimal and lossless in intent: uppercase, collapse
internal whitespace, trim, drop a trailing period. It deliberately does **not**
strip corporate suffixes — "LTD" and "LIMITED" are *not* unified by code. That
unification is precisely what the curated alias table exists for, so a human
decides it rather than a heuristic.

Proven by test: with no curated alias, `"RELIANCE INDUSTRIES LTD."` resolves
**UNRESOLVED** even when a `Reliance Industries Limited` security exists. With
an approved alias it resolves via `CONTROLLED_ALIAS`. With an ISIN it resolves
via `ISIN` regardless of the printed name.

### Country neutrality

`CanonicalSecurity` carries country, exchange, security type, currency, issuer,
identifiers and classification as first-class concepts. India-specific facts
live in `sourceMetadata`. An Australian holding (ASX code, AUD, GICS sector)
fits without a schema change.

## 4. The core look-through formula

```
Effective_Exposure_ij = Portfolio_Weight_i × Fund_Holding_Weight_ij
Effective_Exposure_j  = Σ_i Effective_Exposure_ij
```

Worked example, asserted verbatim in test:

> Fund A is 40% of the portfolio and holds 8% Reliance → 0.40 × 0.08 = **3.2%**
> Fund B contributes a further **2.0%**
> Total effective Reliance exposure = **5.2%**

And the exact identity test:

> Fund A = 60% holding X at 10%; Fund B = 40% holding X at 20%
> → 0.06 + 0.08 = **exactly 14%** (tolerance 1e-8)

## 5. No double-counting

**Look-through is attribution, not additional wealth.** A ₹1,000,000
mutual-fund investment looked through into its underlying securities is still
₹1,000,000 — never ₹1,000,000 of fund *plus* ₹1,000,000 of securities.

Structurally enforced: every returned weight is a fraction of the whole
portfolio, and

```
Σ exposures + cash + derivatives + other + unresolved
            + noSnapshot + undisclosedRemainder  ==  1
```

is asserted by test to 1e-8, as is the fact that effective *values* sum back to
the original portfolio value.

R5 writes nothing to any financial register. It cannot change net worth.

## 6. Coverage — no blind rescaling

Real disclosure files do not sum to exactly 100%: cash, derivatives, unlisted
holdings, receivables and rounding all intervene.

Per fund:

```
disclosedWeightTotal     = resolved + unresolved + cash + derivative + other
reportedHoldingsCoverage = min(1, disclosedWeightTotal)
undisclosedRemainder     = max(0, 1 − disclosedWeightTotal)
```

A file summing to 100.02% is rounding noise (tolerance ±0.5pp) and produces no
negative remainder. **An 87% disclosure stays 87%**, with 13% retained as an
explicit remainder. It is *never* rescaled up to 100%.

Portfolio level:

```
schemeCoverage                = Σ portfolio weight of funds with a usable snapshot
holdingsCoverageWithinSchemes = value-weighted mean reportedHoldingsCoverage
effectiveCoverage             = schemeCoverage × holdingsCoverageWithinSchemes
```

`effectiveCoverage` is the **headline figure every X-Ray view must display**.
Partial look-through is never presented as complete.

Cash, derivatives, other, unresolved and undisclosed weight are **preserved and
reported separately**, never redistributed across disclosed equities.

## 7. Freshness

| Status | Age of the oldest contributing snapshot |
| --- | --- |
| `CURRENT` | ≤ 45 days |
| `ACCEPTABLE` | ≤ 100 days |
| `STALE` | ≤ 210 days |
| `VERY_STALE` | > 210 days |
| `MISSING` | absent, or dated after the as-of date |

Portfolio freshness is governed by the **oldest** contributing snapshot — the
weakest link, never the most flattering one. Old data is never labelled current.

## 8. Mixed holdings dates

The newest and oldest contributing dates and their spread are always returned.
Beyond **45 days** an explicit mixed-date warning is raised; beyond **185 days**
the portfolio-level conclusion is suppressed. Both dates, and the portfolio
positions as-of date, are displayed separately in the UI — they legitimately
differ and that difference must be visible.

## 9. Concentration

Top-1 / top-5 / top-10 effective exposure, plus HHI.

**HHI convention (versioned):** `HHI = Σ w_i²` over **decimal weights (0..1)**.
One security at 100% → 1.0. Ten equal securities → 0.1. Asserted by test so it
cannot silently drift to the 0..10000 percentage convention without a version
bump.

R5 never labels a concentration level good or bad, and never infers
"diversified" from a scheme count.

## 10. Classification exposure

* **Sector** — aggregated over a canonical versioned taxonomy. Two taxonomies
  are never mixed without version metadata.
* **Industry** — produced **only** where a genuine industry classification
  exists. Never derived from sector-only data.
* **Market cap** — from the **security's own** versioned classification only.
  R5 never infers a security's market-cap class from the fund's category label:
  a "Large & Mid Cap Fund" name is not proof about any individual holding.

Unclassified weight is retained and reported, never spread across the
classified buckets. With holdings present but no classification, sector and
market-cap both report **unavailable with zero buckets** — not zero-valued
buckets.

## 11. Fund overlap

```
Weighted_Overlap(A, B) = Σ_j min( weight_A,j , weight_B,j )
```

over securities held by both. Worked example, asserted in test:

> Fund A holds Security X at 5%, Fund B at 8% → X contributes **exactly 5%**.

### Matching rules

* Matching is by **canonical security identity only**. Name-only matching is
  never performed.
* An **unresolved** holding is never treated as matched — not even against
  another unresolved holding with an identical printed name, because identical
  names are not evidence of identical securities. Proven: two funds each 100%
  unresolved overlap **0%**.
* Cash and derivatives never participate in security overlap.
* Unresolved weight on each side, and `comparableCoverage = min(coverage_A,
  coverage_B)`, are reported so the figure is never mistaken for whole-fund
  overlap.

### Mathematical identities (asserted)

* **Symmetry** — `Overlap(A,B) === Overlap(B,A)` exactly (min is commutative)
* **Bounds** — `0 ≤ overlap ≤ 1`
* Identical portfolios → exactly 100%; disjoint portfolios → exactly 0%
* The full matrix is symmetric, bounded, and has a diagonal of 1

The matrix computes only the upper triangle and mirrors it, so cost is
n(n−1)/2 pair computations. Pairwise overlap is naturally ~O(n²) in fund count;
this is acknowledged and left efficient rather than prematurely optimised.

### Interpretation discipline

R5 reports the overlap percentage and the common holdings driving it. It never
classifies an overlap level as good or bad and never suggests selling a fund.
The heatmap uses a single-hue ramp deliberately, so no colour reads as a
warning or an endorsement.

## 12. AMC and fund-manager concentration

AMC concentration is by portfolio **value**, not scheme count — a scheme count
says nothing about how much money is exposed. It needs no look-through data and
remains available even with zero holdings coverage.

**Fund-manager concentration is DEFERRED.** No reliable, versioned fund-manager
metadata source is available, and inferring a manager from scheme names would
not be dependable. It is explicitly deferred and stated as such in the UI,
rather than estimated. This is a bounded, disclosed non-core gap.

## 13. Debt X-Ray

Only genuinely supportable measures are produced. Equity-style sector analysis
is not forced onto debt instruments.

### Credit quality

Approved bands: `SOVEREIGN`, `AAA`, `AA`, `A`, `BELOW_A`, `UNRATED`,
`OTHER_UNCLASSIFIED`.

**A missing rating is not a rating.** It maps to `UNRATED`, which is a statement
about *data availability*, not creditworthiness. R5 never converts "we don't
know" into "AAA", and never into "below A" either. The rendered label is
explicit: "Unrated (no rating available in source data)".

**Multi-agency ratings are never arbitrarily collapsed.** When a security
carries conflicting ratings from several agencies and no approved consolidation
methodology is configured, R5 **retains the agency-specific values and
suppresses the consolidated credit-quality assessment**. It never quietly takes
the most favourable rating — nor the least favourable, since either choice
would be an unapproved methodology. No consolidation methodology is currently
approved, so `creditConsolidationMethodology` is `null`.

### Maturity buckets (deterministic, versioned)

`< 1y` · `1–3y` · `3–5y` · `5–10y` · `> 10y` · `Perpetual/Unknown`,
lower-inclusive / upper-exclusive. Already-matured or unmatched instruments are
not forced into a band; they are counted as uncovered.

### Duration

**Never estimated from maturity.** A bond's duration depends on its coupon and
yield, not only its maturity, so inferring one from the other would fabricate
precision. Modified duration is shown only where the source provides it, and
only when source coverage is ≥ 80% of the debt book — below that the figure is
suppressed with the true coverage stated.

### Issuer concentration

By effective portfolio weight, with unattributed weight reported separately.

## 14. Data-quality vocabulary

`COMPLETE` · `PARTIAL_COVERAGE` · `STALE_HOLDINGS` · `MISSING_HOLDINGS` ·
`UNDERLYING_UNRESOLVED` · `CLASSIFICATION_INCOMPLETE` · `MIXED_AS_OF_DATES` ·
`DEBT_METADATA_INCOMPLETE` · `INSUFFICIENT_COVERAGE`

Coverage below **50%** additionally suppresses portfolio-level conclusions.
A result that is genuinely unavailable never returns zero.

## 15. The no-fabricated-charts rule

Directly extending R4's own already-fixed benchmark-coverage lesson:

**0% holdings coverage must never render as "all sectors = 0%".**

The API returns `available: false` and **omits the analytic payloads entirely**
(`topHoldings`, `sectorExposure`, `marketCapExposure`, `securityConcentration`,
`preservedBuckets`, `debt`), carrying `unavailableReason` instead. A consumer
rendering only present fields cannot draw a fabricated chart.

Verified in a real browser at 0% coverage: **0 recharts wrappers, 0 SVG
elements, 0 tables, 0 occurrences of "0.00%"**, two explicit unavailable
blocks, coverage displayed as "0.0%", and both as-of dates shown separately.

## 16. Versioning and staleness

Every persisted X-Ray result carries: methodology version, engine version,
portfolio snapshot/as-of, constituent holding snapshot ids, holdings source
versions, classification version, input hash, calculation timestamp, coverage
and quality status.

Recalculation triggers: a current portfolio holding changes; R2/R3 positions
change; a new fund-holdings snapshot arrives; a security mapping changes; a
classification changes; a methodology version changes.

Historical results remain auditable; only a non-stale result is displayed as
current. Determinism is proven by the input fingerprint: identical certified
inputs reproduce an identical hash and identical results.
