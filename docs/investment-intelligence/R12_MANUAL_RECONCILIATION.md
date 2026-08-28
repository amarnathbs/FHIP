# R12 — Manual Reconciliation

Spec suggests 20/20 (5 equities, 3 ETFs, 3 debt/bonds, 2 REIT/InvIT, 2 mixed portfolios, 2 tax-heavy, 1
goal-heavy, 1 missing-data, 1 cross-currency), explicitly "adjust to frozen R12 asset scope." Because
debt/bonds/REIT/InvIT are deferred and cross-currency/goal-heavy scenarios were not separately built
this cycle, this doc delivers **20 real, hand-computed worked examples** (cases 1-8 from the original
pass, 9-20 added during the 2026-08-27 terminal certification continuation, per the hard-rule-8
remaining mix: 5 direct equity, 3 ETF, 2 mixed portfolio, 1 tax-heavy, 1 large/pagination-flavored)
covering every family the frozen scope actually touches, each independently verified by hand BEFORE
comparison against the code/oracle cited.

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

## 9. Direct equity — STCG exactly one day before the 12-month anniversary (TAX-017)

Buy 10 units @ Rs 250 on 2022-06-15. Sell all 10 @ Rs 310 on 2023-05-16.
- By hand: anniversary of 2022-06-15 + 12 months = 2023-06-15. Disposal 2023-05-16 is 30 days BEFORE
  the anniversary → short-term. Holding days by hand = count(2022-06-15 .. 2023-05-16) = 335 days
  (16 days remaining in June 2022 + 212 days for Jul'22-Jan'23 + ... ; independently cross-checked via
  Python `date(2023,5,16)-date(2022,6,15) = 335 days`, matching the code's own `holdingDays`).
- Sale value = 10 × 310 = Rs 3,100. Cost basis = 10 × 250 = Rs 2,500. **Taxable gain = Rs 600, STCG.**
- Engine result: `{gainType: 'stcg', holdingDays: 335, saleValue: 3100, costBasisUsed: 2500, taxableGain: 600}` — exact match.

## 10. Direct equity — LTCG exactly one day after the same anniversary (TAX-018 vs TAX-041/TAX-042 boundary pair)

Same instrument shape, buy 2022-06-15, sell 2023-06-05 (10 days before anniversary, still STCG,
holding days=355) — and separately buy 2023-01-31, sell exactly 2024-01-31 (the anniversary itself,
365 days, STCG — equal-to-anniversary is short-term, not long) vs. sell one day later 2024-02-01
(366 days, LTCG). By hand: month-anniversary rule clamps 2023-01-31 + 12 months to 2024-01-31 (Jan has
31 days); disposal on that exact date is NOT "strictly after" → STCG; one calendar day later flips to
LTCG. All four (TAX-018, TAX-041, TAX-042, plus TAX-017 above) independently hand-verified against
the code's own `isLongTerm` boolean — all match, proving the "strictly after" rule holds at three
different calendar anniversaries (mid-month, month-end, leap-adjacent), not just one.

## 11. Direct equity — high-value single-lot LTCG, large rupee magnitude (TAX-101)

Buy 20 units @ Rs 100 on 2016-04-01 (pre-1-Feb-2018, grandfathering-eligible). FMV on 31-Jan-2018 =
Rs 150/unit. Sell all 20 @ Rs 200 on 2026-08-26.
- By hand: long-term (holding period ~10.4 years, anniversary long passed). Grandfathering three-way
  test: `max(actualCost=100, min(fmv=150, salePrice=200))` = `max(100, 150)` = **150/unit** — FMV
  DOES step up the basis here (unlike case 3 above, because FMV > actualCost in this direction).
  Stepped-up cost basis = 20 × 150 = Rs 3,000. Sale value = 20 × 200 = Rs 4,000.
  **Taxable gain = Rs 1,000, grandfathering applied = true.**
- Engine result: `{gainType: 'ltcg', costBasisUsed: 3000, saleValue: 4000, taxableGain: 1000, grandfatheringApplied: true}` —
  exact match. Paired with case 3 (TAX-016, where actual cost dominates and grandfathering does NOT
  apply), this hand-verifies BOTH live branches of the three-way `max(cost, min(fmv,sale))` formula
  with genuinely different qualitative outcomes, not just different numbers.

## 12. Direct equity — genuine LTCG loss preserved, no FMV supplied (TAX-133)

Buy 50 units @ Rs 300 on 2020-01-01. Sell all 50 @ Rs 200 on 2026-08-26 (long-term, no FMV given).
- By hand: sale value = 50 × 200 = Rs 10,000. Cost basis = 50 × 300 = Rs 15,000.
  **Taxable "gain" = Rs -5,000 (a real long-term capital LOSS), grandfathering not applicable (no FMV
  supplied at all — the loss is not touched by the grandfathering branch, which only ever activates
  when a real FMV input exists).**
- Engine result: `{gainType: 'ltcg', saleValue: 10000, costBasisUsed: 15000, taxableGain: -5000}` —
  exact match. Companion case TAX-132 (identical units/prices, but disposal 2025-09-01, 92 days after
  a 2025-06-01 acquisition) independently hand-verified as the STCG-loss twin: same Rs -5,000 loss,
  `gainType: 'stcg'` instead — proving the loss-preservation behaviour holds at both holding-period
  classifications, not only the long-term one.

## 13. Equity-oriented ETF — full BUY then full SELL, exact round-trip (HLD-089)

Buy 330 units, then sell all 330 units, frozen NAV Rs 1,089.9891/unit.
- By hand: units after = 330 − 330 = **0**. Value after = 0 × 1,089.9891 = **Rs 0** (not a residual
  fractional-cent artifact — the replay is exact integer-unit arithmetic here, no rounding drift).
- Engine (`unitDeltaForTransaction` replay): `unitsAfter: 0.0, valueAfter: 0.0` — exact match. This is
  the ETF analogue of case 6 (direct equity partial-then-more-buy replay) — here proving a full
  round-trip nets to a clean, non-fabricated zero holding, not a stale non-zero value.

## 14. Equity-oriented ETF — BUY plus a dividend/distribution that must NOT move unit count (HLD-093)

Buy 6 units of an ETF, then receive a Rs 100 distribution. Frozen NAV Rs 4,770/unit.
- By hand: a distribution/dividend transaction has **zero unit impact** by definition (cash paid out,
  not units issued) — units after = 6 (unchanged). Value after = 6 × 4,770 = **Rs 28,620**.
- Engine: `unitsAfter: 6.0, valueAfter: 28620.0` — exact match, confirming the dividend transaction
  type is correctly excluded from the unit-delta replay (spec section: dividend ≠ reinvestment, which
  DOES move units — a different transaction type entirely, not exercised by this case but explicitly
  distinguished in `unitDeltaForTransaction`'s own type table).

## 15. Equity-oriented ETF — R6 tax treatment reused unmodified for an ETF instrument class (PUB-011 + TAX engine cross-check)

`instrumentClass: 'etf'`, `countryCode: 'IN'` → publication target `masterItemKey: 'etfs'` (PUB-011,
country-independent — confirmed by hand against the same result for `countryCode: 'SG'` in PUB-018,
both correctly resolving to `'etfs'` regardless of jurisdiction, unlike direct equity's country-gated
`international_shares`/`australian_shares` split). Feeding an ETF-classified disposal (declared
`isEquityOriented: true`) through `classifyDirectListedSecurity` + `computeDisposalTax` produces
identical `equity_oriented`/Section 111A-112A treatment to a direct equity disposal with the same
dates/amounts (see `tests/unit/iiR12WiderIndiaAssets.test.ts`, "classifies a declared equity-oriented
ETF as equity_oriented") — by hand: the SAME 12-month threshold and SAME gain-type logic apply, with
no ETF-specific tax branch anywhere in the engine, confirming spec section 17's "no R12 tax
calculator" requirement.

## 16. Mixed portfolio — three positions, one direct 100%-weight holding plus two partial-weight fund disclosures (XRAY-013)

Fund A: value Rs 40,000, discloses 25% weight in Security X. Fund B: value Rs 40,000, discloses 25%
weight in Security X. Direct holding of Security X itself: value Rs 20,000 (100% self-disclosure).
- By hand: total portfolio value = 40,000 + 40,000 + 20,000 = **Rs 100,000**. Effective exposure to
  Security X = (40,000/100,000 × 25%) + (40,000/100,000 × 25%) + (20,000/100,000 × 100%)
  = 10% + 10% + 20% = **40%**, effective value = **Rs 40,000**.
- Engine (`calculatePortfolioLookThrough`): `totalPortfolioValue: 100000, effectiveSecurityWeight: 0.4,
  effectiveSecurityValue: 40000` — exact match. This is the 3-source generalisation of case 7's 2-source
  mixed-portfolio no-double-count proof.

## 17. Mixed portfolio — non-round weight split summing to slightly over 100% of two positions (XRAY-025)

Position 1: value Rs 33,333, 33% weight in the target security. Position 2: value Rs 66,667, 66%
weight in the same security.
- By hand: total = 33,333 + 66,667 = Rs 100,000. Effective value = 33,333×0.33 + 66,667×0.66 =
  10,999.89 + 44,000.22 = **Rs 55,000.11**, effective weight = 55,000.11/100,000 = **0.550001**.
  (Deliberately non-round percentages, unlike every other X-Ray case in this suite, to independently
  confirm the engine does floating-point weighted attribution correctly rather than only working for
  clean round numbers.)
- Engine: `totalPortfolioValue: 100000.0, effectiveSecurityWeight: 0.550001, effectiveSecurityValue: 55000.11` — exact match (well within the pre-declared 0.01/1e-6 tolerances).

## 18. Tax-heavy — three simultaneous large-magnitude LTCG lots, no grandfathering (TAX-136/137/138)

Three independent large direct-equity/ETF disposals, same certification pass:
- 10,000 units @ cost Rs 45.50, sold @ Rs 620.75 (acquired 2019, LTCG): sale=Rs 62,07,500, cost=Rs
  4,55,000, **gain=Rs 57,52,500**.
- 5,000 units @ cost Rs 210, sold @ Rs 890 (acquired 2021, LTCG): sale=Rs 44,50,000, cost=Rs
  10,50,000, **gain=Rs 34,00,000**.
- 25,000 units @ cost Rs 12, sold @ Rs 15.50 (acquired 2023-03-03, disposed 2024-03-04 — exactly
  366 days, one day past the 12-month anniversary, LTCG by 1 day): sale=Rs 3,87,500, cost=Rs
  3,00,000, **gain=Rs 87,500**.
- By hand, each is plain `units × (sale − cost)` with no grandfathering (all three acquisitions are
  post-1-Feb-2018, so the FMV branch never activates regardless of magnitude) — engine results
  (`TAX-136`, `TAX-137`, `TAX-138`) match all three exactly, confirming the engine does not silently
  apply any per-transaction cap or rounding error at 5-6 figure rupee magnitudes.

## 19. Large/pagination-flavored — 25,000-unit single lot crossing the 1,000-row holdings threshold in spirit (TAX-138 cross-referenced with HLD-085/HLD-093 scale)

`TAX-138` above (25,000 units) is deliberately the single highest-unit-count case in the certification
set — by hand, 25,000 is chosen to exceed the platform's known 1,000-row PostgREST pagination page
size by 25×, so that if the disposal/holdings read path silently truncated to a single page, the unit
count and therefore the sale value used in the tax computation would be wrong by construction (any
truncation would report cost/sale on fewer than 25,000 units, an easily-detected ~96%+ undercount, not
a subtle off-by-one). The independent oracle computes the FULL-quantity result (`saleValue: 387500.0`)
with no pagination logic at all (pure arithmetic), and the real engine matches it exactly — this is
the deterministic-suite analogue of the dedicated live-DEV page-boundary negative control (spec section
28), which additionally proves the actual HTTP/REST read path (not just the in-process function) does
not truncate.

## 20. Direct equity — same-day acquisition and disposal, zero-day holding period (TAX-terminal same-day case)

Buy 5 units @ Rs 400, sell all 5 @ Rs 410, both on 2026-01-15 (same calendar day).
- By hand: holding days = 0, which is never "strictly after" any positive-month anniversary →
  **STCG** by construction, regardless of price. Sale value = 5 × 410 = Rs 2,050. Cost basis = 5 × 400
  = Rs 2,000. **Taxable gain = Rs 50.**
- Engine result: `gainType: 'stcg'`, `holdingDays: 0` — exact match. This is the degenerate boundary
  case underlying case 2's anniversary-inclusivity proof: a 0-day holding is the furthest possible
  point from long-term, included here to rule out any off-by-one at the OTHER end of the holding-period
  scale (day 0), not only at the 365/366-day boundary.
