# R6-FINAL — Testing and Verification

Consolidated record of every test/certification surface for Investment
Intelligence R6 (India Tax & Cost Intelligence), across both the pre-DEV
closure pass (`R6_FINAL_PRE_DEV_CLOSURE_REPORT.md`) and this live-DEV
dispatch.

## Static verification (final, this dispatch)

| Check | Result |
|---|---|
| `tsc --noEmit` | Clean |
| `vitest run` | **1239 passed / 5 skipped (1244 total)** |
| `vitest run --no-file-parallelism` | Same: 1239/5/1244 |
| `eslint .` | 6 errors / 7 warnings — unchanged from baseline, all pre-existing/unrelated (`RecommendationsPanel.tsx`/`AppShell.tsx` set-state-in-effect, `ReportPreview.tsx`/`AppShell.tsx` no-img-element, `replay.mjs` unused var) |
| `npm run build` | Exit 0, all routes compiled incl. `/investment-intelligence/tax` and 5 new API routes |

## Hermetic certification packs (regenerated from scratch, Section 45)

| Pack | Cases | Comparisons | Result |
|---|---|---|---|
| R4 (50-case) | 50 | — | 50/50 |
| R5 (89-case) | 89 | 698 | 698/698 |
| R6 (132-case: 120 original + 12 closure) | 132 | 604 | 604/604 |

All three regenerated genuinely from `generate_cases.mjs` →
`ii_r{4,5,6p1}_independent_reconciliation.py` → vitest, on this run —
`git diff --stat` shows only the `comparison_report.json` timestamp fields
changed (2 lines each), confirming byte-identical, deterministic
regeneration with zero drift from the pre-DEV pass's own numbers.

## Live-DEV certification (this dispatch)

| Suite | Script | Result |
|---|---|---|
| Schema | `ii_r6p1_schema_probe.mjs` | Migration `0058` fully applied (4/4 new tables, 3/3 rule versions) |
| Reference data | `ii_r6_final_reference_seed.mjs` | 5 classification rows, 4 exit-load rows, 1 new real instrument, all live in DEV |
| 12 LIVE-R6 scenarios | `ii_r6_final_live_dev_cases.mjs` | **14/14 checks PASS** (12 scenarios + 2 DB/FIFO-order sub-checks), 10/12 independently recalculated |
| Security | `ii_r6_final_security.mjs` | 18/21 PASS, **3 genuine HARD-GATE FAILs** (same-user forgery — see `R6_FINAL_SECURITY_VERIFICATION.md`), fix drafted (`0061`), not yet applied |
| Atomicity/Idempotency/Staleness | `ii_r6_final_atomicity_idempotency_staleness.mjs` | 11/12 PASS, 1 honestly disclosed architecture gap (rule-version DB table not read) |

## Negative controls (pre-DEV pass, re-confirmed unaffected by this dispatch's changes)

6 negative controls (NC-1 through NC-6) from the pre-DEV pass all remain
valid — re-verified by the fact that the 132-case pack (which every NC's
failure count is keyed against) regenerated with zero drift, so the same
mutations would still be caught identically.

## New tests added this dispatch (hermetic)

| File | Tests | Purpose |
|---|---|---|
| `tests/unit/iiR6FinalTaxpayerContext.test.ts` | 9 | `resolveTaxpayerContext()` (RESIDENT_INDIVIDUAL/RESIDENT_HUF/NON_RESIDENT_INDIVIDUAL, UNKNOWN_PROFILE fail-safe) and its orchestrator wiring |
| `tests/unit/iiR6FinalTaxLotPersistenceFix.test.ts` | 4 | `deterministicLotId()`'s determinism/uniqueness properties (certifies the real defect fix) |

Total new hermetic tests this dispatch: 13 (1226 → 1239).

## Defects found and fixed this dispatch

1. **`ii_capital_gains_computations`/`ii_tax_lot_consumptions` persistence
   was completely broken** — a not-null FK to `ii_tax_lots`, which nothing
   ever populated, silently failed every real disposal's persistence
   attempt since R6-P1 shipped. Fixed via `persistTaxLots()` +
   `persistTaxLotConsumptions()` + `deterministicLotId()`.
2. **Same-user forgery on 3 tables** (`ii_capital_gains_computations`,
   `ii_tax_lot_consumptions`, `ii_tax_lots`) — `UPDATE`/`DELETE` on an
   already-owned row succeeded via raw PostgREST, bypassing the
   server-side engine entirely. Same defect class as R4's own
   previously-found-and-fixed issue. Fix drafted (migration `0061`), NOT
   yet applied — see `R6_FINAL_SECURITY_VERIFICATION.md`.

## Disclosed gaps (not defects, not fixed — genuinely out of architectural
scope for this dispatch)

- **TER (Total Expense Ratio) intelligence is not operational** — no
  reference-data source exists. `tax/cost-intelligence` route returns
  `available: false` honestly.
- **`ii_tax_rule_versions` is never read by the engine** — rule
  resolution is entirely in-code (`ALL_RULE_VERSIONS`); the DB table is a
  write-once audit record. Rewiring this would be a core-engine redesign,
  explicitly out of this dispatch's scope.
- **Pagination boundary matrix (999-5001 rows) remains synthetic-only** —
  DEV has nowhere near 1,000 rows in any relevant table as of this
  dispatch (confirmed via `Content-Range` headers).
- **Migrations `0060` (tax-profile persistence) and `0061` (RLS forgery
  fix) are drafted but not applied to DEV** — same DDL-capability
  limitation this session has had throughout (confirmed structurally via
  the DDL-capability probe).
