# R12 — Deterministic Certification

## Status: target met (2026-08-27 terminal certification continuation)

Spec target: 200+ high-value deterministic cases (suggested distribution: 25/35/25/20/20/20/25/15/15
across categories this round's frozen scope only partially maps onto — see mapping note below).
**Actual delivered: 336 deterministic cases** (41 original + 295 added in this continuation via
`scripts/r12-certification/generate_expanded_cases.py`), exceeding the 200 target by 68%.

## Case distribution (actual)

| Family | Count | IDs | Spec category mapping |
|---|---|---|---|
| Instrument identity/dedup | 33 | ID-001..ID-041 (non-contiguous) | Instrument identity/ISIN/NSE-BSE |
| Holdings/transaction replay | 110 | HLD-001..HLD-120 (non-contiguous) | Direct-equity + Equity-ETF transactions, Holdings/valuation |
| Tax/cost | 140 | TAX-001..TAX-138 (non-contiguous) | R6 tax/cost, plus anniversary-boundary and grandfathering-formula depth |
| Publishing/no-duplication | 20 | PUB-001..PUB-020 (non-contiguous) | R9/R10 integration (no-duplication) |
| X-Ray/diversification | 33 | XRAY-001..XRAY-033 (non-contiguous) | R5 diversification |
| **Total** | **336** | | |

(IDs are non-contiguous because new cases were numbered continuing from each family's existing max,
not renumbering the original 41 — preserves every original case's identity unchanged.)

Not separately covered by a dedicated deterministic-oracle case (covered instead by targeted
unit/integration tests, the live-DEV suite, or genuinely out of frozen scope): security/pagination
(covered by `R12_SECURITY_VERIFICATION.md` + `R12_PAGINATION_SCALE_CERTIFICATION.md` + TAX-138's
25,000-unit deterministic analogue, see `R12_MANUAL_RECONCILIATION.md` case 19), R4 performance
(R12 contributes cash flows to the canonical R4 engine rather than exercising a local
identity/holdings/tax/publishing/xray family — see `R12_PERFORMANCE_AND_BENCHMARK_INTEGRATION.md`),
goals/forecasting/review (no new logic was added — see `R12_GOALS_FORECASTING_REVIEW_INTEGRATION.md`
— nothing new to certify against), any bond/REIT/InvIT case (impossible — out of frozen scope).

## Results

All 336 cases pass against the real, unmodified production engines
(`tests/unit/iiR12IndependentOracle.test.ts`, 339/339 tests including 3 meta-tests, 1,212 atomic
comparisons). 0 unexplained mismatches. 2 genuine bugs were found and fixed DURING the original
certification construction (both in the oracle itself, not production code — see
`R12_INDEPENDENT_ORACLE_REPORT.md`): the grandfathering formula, and a missing country branch in the
`masterItemKey` oracle logic. One additional oracle-construction correction made during this
continuation (also not a production defect — see `R12_INDEPENDENT_ORACLE_REPORT.md`'s "one correction"
note): the initial anniversary-boundary sweep generated disposal dates outside the real engine's
covered tax-rule-version range, correctly rejected by the engine's own defensive
`NoApplicableRuleVersionError` — the sweep's acquisition anchors were moved forward so every generated
case falls inside the engine's real covered range.

## What remains beyond this pass (honestly disclosed, not silently dropped)

- X-ray cases with real `ii_security_classifications` sector/market-cap data present vs. absent
  (this round's X-Ray cases exercise weighted-attribution arithmetic only, via the synthesized
  self-disclosure snapshots already used by the original 3 cases).
- Any bond/REIT/InvIT case (impossible — out of frozen scope).
