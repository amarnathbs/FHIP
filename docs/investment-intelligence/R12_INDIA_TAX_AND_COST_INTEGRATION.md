# R12 — India Tax & Cost Integration (R6)

## R6 remains the tax authority (spec section 53)

**No new tax calculator.** R12 adds exactly one new, small, non-look-through classifier
(`classifyDirectListedSecurity()`, `schemeClassification.ts`) that feeds the **unmodified**
`computeDisposalTax()` (`capitalGainsEngine.ts`) — the same FIFO/holding-period/grandfathering/
gains engine every certified mutual fund disposal already goes through.

## Tax rule discovery (spec section 54)

**Equity (Section 111A/112A)**: a direct listed equity share and an equity-oriented mutual fund/ETF
unit are taxed identically under Indian law — same 12-month STCG/LTCG holding-period threshold, same
rate structure, same Section 55(2)(ac) 31-Jan-2018 FMV grandfathering scope (grandfathering was never
mutual-fund-specific; the statute covers "an equity share... or a unit... in respect of which
securities transaction tax has been paid"). This is not new research this cycle — it is the same legal
basis already cited and researched in `capitalGainsEngine.ts`'s own header comments and
`docs/investment-intelligence/R6_TAX_LEGAL_SOURCE_REGISTER.md` from prior R6 rounds; R12 applies the
existing, already-cited authority to a new instrument shape rather than researching new law.

**ETF tax heterogeneity (spec section 57)**: not every ETF has equity treatment (gold ETF, debt ETF,
international ETF each have distinct rules). R12 does **not** infer tax classification from
`instrument_class='etf'` alone — `classifyDirectListedSecurity()` requires an explicit `isEquityOriented`
declaration at entry time (surfaced in the manual-entry UI as a checkbox), and refuses to classify
(`unresolved`) an ETF not declared equity-oriented. Non-equity ETFs remain `instrument_class='etf'`-representable
but are excluded from confident tax figures — "tax basis incomplete", never guessed.

## Effective-dated rules (spec section 55)

Unchanged: `ruleVersions.ts`'s existing effective-dated `TaxRuleVersion` resolution (`resolveRuleVersion()`)
governs every R12 disposal exactly as it governs mutual fund disposals — R12 introduces no new
timeless-constant tax logic. The direct-security classifier only decides `classification`/`basis`; the
rate/threshold/grandfathering logic downstream is 100% pre-existing, effective-dated, and untouched.

## New DB row: `ii_scheme_tax_classification.basis = 'direct_listed_security_rule'`

Migration 0092 adds this one new allowed `basis` value (additive, all 4 existing values unchanged).
`manualDirectPositionService.ts`'s `ensureDirectSecurityTaxClassification()` seeds exactly one row per
new instrument, computed by `classifyDirectListedSecurity()`:

| `instrumentClass` | `isEquityOriented` | Result |
|---|---|---|
| `equity` | (ignored) | `classification='equity_oriented'`, `domesticEquityPct=100`, statute-based, not look-through |
| `etf` | `true` | Same as equity |
| `etf` | `false`/undeclared | `classification='unresolved'` — excluded from confident tax figures |

Never overwrites an existing classification row (could be admin-curated) — `ensureDirectSecurityTaxClassification`
checks for an existing row first.

## Bond tax (spec section 59) / REIT/InvIT tax (spec section 58)

Not applicable — both deferred scope (`R12_ASSET_CLASS_SCOPE_MATRIX.md`).

## Tax basis incomplete (spec section 60)

Unchanged principle, reused: insufficient classification (undeclared ETF, or any future instrument
without a `ii_scheme_tax_classification` row) → `classification: 'unresolved'` in
`computeDisposalTax()`'s output, excluded from confident tax figures, never an invented cost basis.

## Certification

- `tests/unit/iiR12WiderIndiaAssets.test.ts`: LTCG/STCG classification for direct equity, ETF
  declared/undeclared equity-oriented, feeding the unmodified `computeDisposalTax()`.
- Independent oracle: 16 tax cases (`TAX-001`..`TAX-016`), 96 atomic comparisons, including the
  grandfathering loss-preservation distinguishing case (`TAX-016`) that caught a real bug in the
  oracle's OWN first draft — see `R12_INDEPENDENT_ORACLE_REPORT.md`.
- NC4 negative control: proves the engine's result is genuinely classification-driven (a deliberately
  wrong classification produces a materially different, wrong result) — the correctness burden sits
  in the classifier, which is tested separately above.
