# R11 Independent Oracle Report

Spec sections 96-101.

## Two independent oracles, each in two parts (deliberately)

Following the same split every prior release's oracle used (R7's `r7_independent_bank_csv_oracle.py` + `r7_oracle_compare.ts`; R9's standalone `.mjs`): a pure oracle file that computes expected values with ZERO production imports, plus a separate comparison file that is the only place production code is ever touched.

### 1. Multi-source identity oracle

- **Oracle (no production imports)**: `scripts/r11_independent_multisource_oracle.mjs` — `independentClassify`/`independentResolve`, a from-scratch re-implementation of "same account+instrument+date+type, amount/units within tolerance, reference agreement" using its OWN naive string-to-micros decimal parser (not `lib/services/investment-intelligence/decimal.ts`). 31 hand-labelled cases, self-checked for internal consistency (`node scripts/r11_independent_multisource_oracle.mjs` — exits 0, "31 cases, 31 internally consistent, 0 inconsistent").
- **Comparison (imports both)**: `tests/unit/r11IndependentOracleComparison.test.ts` — runs every one of the 31 oracle cases through the REAL `resolveCrossSourceTransactionMatch`. **Result: 34/34 tests pass (31 per-case + 3 summary/sanity), 0 discrepancies.**

### 2. Professional security oracle

- **Oracle (no production imports)**: `scripts/r11_professional_security_oracle.mjs` — `independentDecide`, a from-scratch re-implementation of the ALLOW/DENY decision directly from the spec's plain-English rules (relationship exists → same pair → not revoked/declined/expired-status → not pending → not time-expired → active → professional active → scope granted → scope not revoked → ALLOW). 22 hand-labelled scenarios, self-checked (`node scripts/r11_professional_security_oracle.mjs` — exits 0, "22 scenarios, all internally consistent").
- **Comparison (imports both)**: `tests/unit/r11ProfessionalSecurityOracleComparison.test.ts` — maps every scenario onto real `RelationshipRecord`/`ScopeGrantRecord` inputs and calls the REAL `checkProfessionalAccess`. **Result: 24/24 tests pass (22 per-scenario + 2 summary/sanity), 0 discrepancies.**

## Why this is genuine independence, not the same code twice

- Neither oracle file imports `crossSourceIdentity.ts` or `permissions.ts` — verified by inspection (`grep -n "^import" scripts/r11_independent_multisource_oracle.mjs scripts/r11_professional_security_oracle.mjs` shows zero imports from `lib/`).
- The multi-source oracle's decimal handling is a SEPARATE, simpler implementation (string-splitting to integer micro-units) from production's `decimal.ts` scaled-`bigint` module — a shared bug in `decimal.ts` could not silently agree with a shared bug in the oracle, because they share no code.
- The professional-security oracle's rule ordering was written directly from the spec's prose (sections 43-71), not by reading `permissions.ts`'s source and transcribing its `if` statements.

## Result

**0 discrepancies found across both oracles' full corpus (53 independently-authored cases/scenarios, 58 total test executions including summary checks).** No fix was required in either production module as a result of this comparison — both matched the independent expectation on every case on the first run after the two real bugs found DURING test-authoring (see `R11_TESTING_AND_VERIFICATION.md`) were already fixed.
