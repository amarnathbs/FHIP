# R12 — Manual Reconciliation

Spec suggests 20/20 (5 equities, 3 ETFs, 3 debt/bonds, 2 REIT/InvIT, 2 mixed portfolios, 2 tax-heavy, 1
goal-heavy, 1 missing-data, 1 cross-currency), explicitly "adjust to frozen R12 asset scope." Because
debt/bonds/REIT/InvIT are deferred and cross-currency/goal-heavy scenarios were not separately built
this cycle, this doc delivers **8 real, hand-computed worked examples** covering every family the
frozen scope actually touches, each independently verifiable against the code cited.

## 1. Equity — simple LTCG (TAX-004)

Buy 20 units @ Rs 150 on 2020-03-01. Sell all 20 @ Rs 800 on 2025-08-26.
- Holding period: anniversary of 2020-03-01 + 12 months = 2021-03-01. Disposal 2025-08-26 is strictly
  after → **LTCG**.
- Sale value = 20 × 800 = **Rs 16,000**. Cost basis = 20 × 150 = **Rs 3,000**. No FMV supplied →
  grandfathering not applicable (acquired after 1-Feb-2018 anyway). **Taxable gain = Rs 13,000.**
- Matches `computeDisposalTax()` output exactly (`tests/unit/iiR12IndependentOracle.test.ts`, `TAX-004`).

## 2. Equity — STCG at the exact 12-month boundary (TAX-002)

Buy 10 units @ Rs 200 on 2024-01-15. Sell all 10 @ Rs 500 on **2025-01-15** (exactly 12 months later).
- Anniversary = 2025-01-15. Disposal is NOT strictly after the anniversary (equal) → **STCG**, by the
  code's own documented rule ("strictly after"). One day later (`TAX-001`, disposal 2025-01-16) flips
  to LTCG. This boundary pair proves the anniversary rule is inclusive-of-exactly-12-months as
  short-term, matching Section 2(42A)'s "more than" (not "at least") 12-month long-term threshold.

## 3. Equity — genuine loss, grandfathering must NOT erase it (TAX-016)

Buy 10 units @ Rs 500 on 2015-01-01 (pre-grandfathering-cutoff). Sell all 10 @ Rs 90 on 2026-08-26.
31-Jan-2018 FMV = Rs 180/unit.
- Long-term (2015-01-01 + 12mo anniversary is 2016-01-01, long since passed).
- Grandfathering three-way test: `max(actualCost=500, min(fmv=180, salePrice=90))` = `max(500, 90)` =
  **500** — actual cost dominates, basis is NOT stepped up.
- Sale value = 10 × 90 = Rs 900. Cost basis = 10 × 500 = Rs 5,000. **Taxable "gain" = Rs -4,100 (a real
  loss, correctly preserved.)**
- This is the exact case that distinguishes the correct formula from the "classic wrong
  implementation" `min(max(fmv,cost),sale)`, which would incorrectly compute basis=90 and report a
  gain of Rs 0, erasing the real loss. See `R12_INDIA_TAX_AND_COST_INTEGRATION.md` and the oracle
  script's own comments for the full legal citation (Section 55(2)(ac)).

## 4. Equity-oriented ETF — declared vs undeclared

Same instrument, `instrument_class='etf'`. Declared `isEquityOriented: true` → `classifyDirectListedSecurity()`
returns `classification: 'equity_oriented'`, feeding the same gains engine as equity. Declared `false`
(or omitted) → `classification: 'unresolved'`, excluded from any confident tax figure. Verified in
`tests/unit/iiR12WiderIndiaAssets.test.ts`.

## 5. Instrument identity — same ISIN, two exchanges (ID-005 / LIVE-R12-04)

One instrument, identifiers: ISIN `INF204KB14I2` + NSE `NIFTYBEES`, and separately ISIN `INF204KB14I2`
+ BSE `590103` (a real NiftyBees-style ETF pattern). Independent oracle: union-find over identifier
keys collapses this to **1 distinct instrument** (both share the same globally-unique ISIN). Reused,
end-to-end, on real DEV: `scripts/r12_live_dev_verification.mjs` LIVE-R12-04 created exactly this shape
against the real hosted database and confirmed a single `instrument_id` for all three identifier rows,
then confirmed a **second** instrument could not claim the same ISIN (HTTP 409).

## 6. Holdings replay — buy, partial sell, buy again (HLD-008)

Buy 100, buy 50 (running 150), sell 75 (running 75), buy 25 (running 100). Frozen price Rs 3,000/unit.
- `unitDeltaForTransaction` replay: +100 +50 −75 +25 = **100 units**. Value = 100 × 3,000 = **Rs 300,000**.
- Matches the independent oracle (`HLD-008`) and the real `unitDeltaForTransaction()` function exactly.

## 7. X-Ray — direct equity plus a fund that also discloses the same security (integration test, not a bare oracle case)

Portfolio: Mutual Fund A (value Rs 60,000) discloses 50% weight in Security X. Direct holding of
Security X (value Rs 40,000, synthesized as its own 100%-weight self-disclosure).
- Total portfolio value = Rs 60,000 + Rs 40,000 = **Rs 100,000** (not Rs 100,000 + Rs 40,000 —
  look-through is attribution, not additional wealth).
- Effective exposure to Security X = (60,000/100,000 × 50%) + (40,000/100,000 × 100%) = 30% + 40% =
  **70%**, effective value = **Rs 70,000**, with `contributingFunds` correctly listing 2 distinct
  paths (never merged into a single unexplained number). Verified in
  `tests/unit/iiR12WiderIndiaAssets.test.ts` against the real, unmodified `calculatePortfolioLookThrough()`.

## 8. Missing/incomplete data — undeclared ETF tax basis

An equity-oriented-eligible ETF entered without the `isEquityOriented` declaration produces
`classification: 'unresolved'` and `computeDisposalTax()` short-circuits to `gainType: 'unresolved'`,
`taxableGain: null` — never a fabricated cost basis or a silently-assumed equity treatment. This is
the R12 instance of the pre-existing "tax basis incomplete, not invented cost" principle (spec section
60), reused unchanged.
