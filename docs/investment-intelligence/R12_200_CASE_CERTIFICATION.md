# R12 — Deterministic Certification

## Honest scope disclosure

Spec target: 200+ high-value deterministic cases (suggested distribution: 25/35/25/20/20/20/25/15/15).
**Actual delivered: 41 deterministic cases**, chosen for breadth across every family the frozen scope
(direct equity + equity-oriented ETF) actually touches, not padded with trivial duplicates, but
genuinely smaller than the spec's target given this round's realistic time budget (hard rule 4).

## Case distribution (actual)

| Family | Count | IDs |
|---|---|---|
| Instrument identity/dedup | 8 | ID-001..ID-008 |
| Holdings/transaction replay | 10 | HLD-001..HLD-010 |
| Tax/cost | 16 | TAX-001..TAX-016 |
| Publishing/no-duplication | 4 | PUB-001..PUB-004 |
| X-Ray/diversification | 3 | XRAY-001..XRAY-003 |
| **Total** | **41** | |

Not separately covered by a dedicated deterministic case (covered instead by targeted unit/integration
tests or live-DEV scripts, cross-referenced below): security/pagination (covered by
`R12_SECURITY_VERIFICATION.md` + `R12_PAGINATION_SCALE_CERTIFICATION.md`), goals/forecasting/review
(no new logic was added — see `R12_GOALS_FORECASTING_REVIEW_INTEGRATION.md` — nothing new to certify
against).

## Results

All 41 cases pass against the real, unmodified production engines (`tests/unit/iiR12IndependentOracle.test.ts`,
44/44 tests including 3 meta-tests). 0 unexplained mismatches. 2 genuine bugs were found and fixed
DURING certification construction (both in the oracle itself, not production code — see
`R12_INDEPENDENT_ORACLE_REPORT.md`): the grandfathering formula, and a missing country branch in the
`masterItemKey` oracle logic.

## What remains for a full 200-case pass (explicitly deferred, not silently dropped)

- Deeper holdings-replay coverage (fractional-unit edge cases, same-day buy+sell, multi-account same-instrument).
- More tax boundary cases around fiscal-year-end and rule-version transition dates (2024-07-23 indexation change).
- X-ray cases with real `ii_security_classifications` sector/market-cap data present vs. absent.
- Any bond/REIT/InvIT case (impossible — out of frozen scope).
