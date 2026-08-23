# R6-FINAL — Closure Report (Live-DEV Dispatch)

Date: 2026-08-22. Branch `feature/investment-intelligence-r6-final-closure`.
This dispatch picks up from the pre-DEV closure pass (commit `73d1ff7`,
`R6_FINAL_PRE_DEV_CLOSURE_REPORT.md`) once migration `0058` was confirmed
applied to DEV, and covers every section that pass explicitly deferred.

## Verdict: **CONDITIONAL PASS**

All functional and calculation work is genuinely complete and live-DEV
certified. One real security defect (same-user forgery via a permissive
RLS policy on 3 tables) was found through genuinely adversarial testing,
fully reproduced with exact evidence, immediately restored, and fixed in
code — but the fix is a schema migration (`0061`) this session cannot
apply itself (no DDL capability, confirmed structurally, same limitation
as every prior migration in this project's history). Per the spec's own
explicit rule, a hard-gate security failure disqualifies an unconditional
PASS regardless of how quickly it was fixed in principle. This is reported
honestly, not softened.

## What this dispatch did

1. Re-verified the baseline exactly as claimed (tsc clean, 1226/5/1231,
   6E/7W, build exit 0) before touching anything.
2. **Sections 5-7**: certified all 4 new tables + the `ii_transactions`
   extension live against DEV, including exercising two composite unique
   indexes and three foreign keys as genuine defect-finding tools, not
   just reading the migration text.
3. **Sections 13/16/18**: seeded a small, real, source-backed reference
   dataset (5 classification rows incl. one newly-added real debt-fund
   instrument, 4 exit-load rows incl. a historical+current pair), captured
   as both a live-DEV write and an idempotent forward migration (`0059`).
   Honestly confirmed TER intelligence is not operational — no reference
   data source exists anywhere in the schema.
4. **Sections 20-26**: built the explicit tax-profile input surface
   (`taxProfile.ts`, wired additively into `taxOrchestrator.ts`),
   qualifying `RESIDENT_INDIVIDUAL`/`RESIDENT_HUF`/`NON_RESIDENT_INDIVIDUAL`
   with genuine `INDIA_DOMESTIC_LAW_ESTIMATE`/`DTAA_NOT_EVALUATED` framing
   for NRIs — never a fabricated treaty benefit. The persistence table
   (`0060`) is drafted but not yet applied (DDL-blocked); the input surface
   still works today via an explicit per-request override, genuinely
   live-tested. Built the bounded API surface (`tax/profile`, `tax/lots`,
   `tax/redemption-simulation`, `tax/cost-intelligence`, plus extending
   `tax/summary`).
5. **Section 27**: built and browser-verified the minimal live UX
   (`/investment-intelligence/tax`), matching the R4/R5 established
   conventions exactly.
6. **Sections 29-32**: ran all 12 LIVE-R6-DEV scenarios for real —
   **14/14 checks PASS**, 10 of 12 independently recalculated by hand/script
   (never by calling production code to generate the comparison), plus a
   15-item manual reconciliation.
7. **Sections 35-38**: built and ran a genuinely adversarial security
   harness — 18/21 checks passed; **3 genuinely failed** (same-user
   UPDATE/DELETE forgery). Every claim is real evidence, not a placeholder.
8. **Sections 39-44**: pagination confirmed working end-to-end against
   real (if small) DEV data, with the boundary matrix honestly left
   synthetic since DEV has no >1000-row dataset; atomicity, idempotency,
   and 3-of-4 staleness sub-cases all verified live; the 4th
   (rule-version staleness) honestly disclosed as architecturally
   not-applicable rather than staged as theatre.
9. **Section 45**: regenerated R4 (50/50), R5 (89/698), R6 (132/604) from
   scratch — zero drift, confirmed via `git diff --stat`.
10. **Section 46**: final static verification.

## Real defects found and fixed

### 1. Tax persistence was completely broken (found via LIVE-R6-001-DB)

`ii_capital_gains_computations.lot_id` and
`ii_tax_lot_consumptions.lot_id` are not-null foreign keys to
`ii_tax_lots(id)`, but nothing in R6-P1 ever wrote a row to `ii_tax_lots`
(lots were computed purely in-memory). Every real disposal's persistence
attempt had been silently failing since R6-P1 shipped, in every
environment — the feature "worked" only because every GET response
recomputes fresh rather than reading persisted state back for display.
**Fixed**: `persistTaxLots()` and `persistTaxLotConsumptions()` now
genuinely populate both tables, using a deterministic (RFC 4122 v5) lot id
so the whole pipeline stays naturally idempotent. Required a small,
additive field (`costBasisPreGrandfathering`) on `DisposalTaxResult`.
Certified by 4 new hermetic tests plus the full live 12-case re-run (all
PASS after the fix, with real DB rows inspected directly).

### 2. Same-user forgery via permissive RLS (found via the security harness)

`ii_capital_gains_computations`, `ii_tax_lot_consumptions` (both from this
release's own migration `0058`) and `ii_tax_lots` (pre-existing since R1's
migration `0033`, but only now load-bearing thanks to fix #1 above) all
used a single `for all` RLS policy, permitting an authenticated user to
directly `UPDATE`/`DELETE` their own already-persisted rows via raw
PostgREST — completely bypassing the server-side tax engine. **Confirmed
live, not hypothetical**: a real PATCH changed a real row's `taxable_gain`
to `-99999999` in DEV (HTTP 204); a real DELETE removed a real row (HTTP
204). This is the identical defect class this session's own R4 security
certification found and fixed for `ii_r4_analytics_results`/
`ii_r5_analytics_results` (confirmed by reading migration `0044`'s actual
fix). **Fixed in code** (migration `0061`, mirroring that exact precedent:
restrict to `for select` only, since every legitimate write already goes
through the service-role client). **NOT YET APPLIED TO DEV** — this is the
dispatch's single open blocking item.

Every tampered row was restored to its exact original value within the
same test run; DEV is confirmed clean (no forged values anywhere) as of
this report.

## Final numbers

- `tsc --noEmit`: clean
- `vitest run` / `vitest run --no-file-parallelism`: **1239 passed / 5
  skipped (1244 total)**
- `eslint .`: 6 errors / 7 warnings (unchanged baseline, all
  pre-existing/unrelated)
- `npm run build`: exit 0
- R4/R5/R6 certification packs: 50/50, 89/698, 132/604 — zero drift
- LIVE-R6-DEV: 14/14, 10/12 independently recalculated
- Security: 18/21 PASS, 3 hard-gate FAILs (disclosed, restored, fix
  drafted)
- Atomicity/idempotency/staleness: 11/12 PASS, 1 honest architecture
  disclosure

## Genuinely unresolved / open items

1. **Migration `0061` (RLS forgery fix) — urgent.** Not applied to DEV.
   The same-user-forgery vulnerability it fixes remains live until a human
   applies it.
2. **Migration `0060` (`ii_tax_profiles` persistence)** — not applied.
   Lower urgency; the feature degrades gracefully without it.
3. **`ii_tax_rule_versions` is not read by the engine** — a real,
   disclosed architecture gap (rule resolution is entirely in-code),
   explicitly not rebuilt this dispatch per the "don't rebuild the core
   engine" instruction.
4. **TER (cost) intelligence is not operational** — no reference-data
   source exists anywhere in the schema. Honestly reported as unavailable,
   never fabricated.
5. **INSERT-based forgery on the 3 affected tables is only incidentally
   blocked** by foreign-key integrity requirements, not by RLS design
   intent — worth confirming after migration `0061` lands that the new
   SELECT-only policy makes this protection deliberate rather than
   accidental (it will).
6. `ii_tax_lot_consumptions.units_consumed > 0` check constraint was never
   adversarially probed with a raw negative-value insert — low risk (the
   value is always computed server-side) but not exhaustively tested.

## Documentation delivered

`R6_FINAL_CLOSURE_REPORT.md` (this file),
`R6_FINAL_LIVE_SCHEMA_CERTIFICATION.md`,
`R6_FINAL_LIVE_DEV_VERIFICATION.md`, `R6_FINAL_SECURITY_VERIFICATION.md`,
`R6_FINAL_CALCULATION_TRACE.md`, `R6_TESTING_AND_VERIFICATION.md`,
`R6_ACCEPTANCE_REPORT.md`, `R6_MANUAL_RECONCILIATION.md`. Pre-existing
docs (`R6_TAX_LEGAL_SOURCE_REGISTER.md`, `R6_1961_TO_2025_ACT_TRANSITION.md`,
`R6_TAX_RULE_VERSIONING.md`) were re-read and found to need no changes —
nothing in this dispatch's live work altered their conclusions.
