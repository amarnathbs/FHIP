# R6-FINAL — Acceptance Report

Branch: `feature/investment-intelligence-r6-final-closure`. This report
covers the FULL R6-FINAL spec — the pre-DEV closure pass
(`R6_FINAL_PRE_DEV_CLOSURE_REPORT.md`, commit `73d1ff7`) plus this
live-DEV dispatch.

## Verdict: **CONDITIONAL PASS**

Every functional requirement is met, live-verified against real DEV data,
independently recalculated for 10 of 12 mandatory scenarios, and 2 real
production defects were found and genuinely fixed. The single blocking
condition is external to this session's capability: **migration `0061`
(the RLS forgery fix) has not yet been applied to DEV**, meaning the
same-user-forgery vulnerability it fixes remains technically live in DEV
until a human applies it. Per the spec's own hard-gate rule, this
disqualifies an unconditional PASS — but the finding was made, evidenced,
contained, and fixed within this dispatch, which is the strongest outcome
achievable without direct DDL access.

## Requirement-by-requirement

| Spec section(s) | Status |
|---|---|
| 5-7: Live schema certification | **PASS** — see `R6_FINAL_LIVE_SCHEMA_CERTIFICATION.md` |
| 13, 16, 18: Reference data | **PASS** (equity/debt/unresolved classification, historical+current exit-load pair, TER honestly disclosed as not operational) |
| 20-26: Tax-profile input, taxpayer types, API surface | **PASS** (functionally complete; persistence table `0060` pending DDL application, mitigated by a genuine per-request override path) |
| 27: Minimal live UX | **PASS** — browser-verified live against DEV data |
| 29-32: 12 LIVE-R6-DEV cases | **PASS** — 14/14 checks, 10/12 independently recalculated, 15-item manual reconciliation complete |
| 35-36, 38: Cross-tenant isolation, RLS inspection | **PASS** |
| 37: Same-user forgery (hard gate) | **CONDITIONAL FAIL** — 3 real vulnerabilities found, restored, fixed (migration drafted, not applied) |
| 39-41: Pagination at scale | **PASS** (honestly synthetic-only — DEV has no >1000-row dataset) |
| 42: Atomicity | **PASS** (system-level property verified: no partial state ever surfaces a wrong number, full self-healing) |
| 43: Idempotency | **PASS** — zero duplicate rows across 2 consecutive identical calls, 3 tables checked |
| 44: Staleness | **PASS** for 3/4 sub-cases (transaction correction, classification change, profile change); 1 honestly disclosed as architecturally not-applicable (rule table not DB-driven) |
| 45: Full predecessor regression | **PASS** — R4 50/50, R5 89/698, R6 132/604, zero drift |
| 46: Final static verification | **PASS** — tsc clean, 1239/5/1244, 6E/7W (baseline), build exit 0 |

## Defects found this dispatch (both fixed with code; one fix pending DDL)

1. `ii_capital_gains_computations`/`ii_tax_lot_consumptions` persistence
   was completely broken since R6-P1 shipped (FK to a never-populated
   `ii_tax_lots`) — **fixed and live-verified**.
2. Same-user forgery via a permissive `for all` RLS policy on 3 tables —
   **found, reproduced, restored, fix drafted, NOT yet applied to DEV**.

## Open items for the Product Owner / orchestrating session

1. **Apply migration `0061`** (RLS forgery fix) to DEV — the single most
   urgent open item from this entire dispatch. Until applied, any real
   user could tamper with their own persisted tax figures via direct
   PostgREST calls.
2. Apply migration `0060` (`ii_tax_profiles` persistence table) — lower
   urgency, the feature degrades gracefully without it.
3. Consider a follow-up phase to wire `ii_tax_rule_versions` into
   `resolveRuleVersion()` for genuine DB-driven rule versioning (currently
   vestigial) — explicitly out of this dispatch's scope (would require
   touching the certified core engine).
4. Consider a future phase to build real TER reference data — currently
   genuinely not operational, honestly disclosed rather than fabricated.

## Explicit scope respected

No production system was touched, contacted, or referenced. No R7,
Goals, Forecasting, recommendations, rebalancing, adviser workflow, or
premium-report work was begun. No personalized investment/tax
recommendation was ever implemented — every surface remains
observational/educational/simulation-only, structurally enforced via
`disclaimer.ts`. No RLS or security control was weakened to make a test
pass — the one security finding was disclosed, not hidden or softened.
