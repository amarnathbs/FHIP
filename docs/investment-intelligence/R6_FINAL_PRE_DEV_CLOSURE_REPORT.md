# R6-FINAL — Pre-DEV Closure Report

Branch: `feature/investment-intelligence-r6-final-closure`
Dispatch scope: everything in the R6-FINAL spec NOT requiring migration
`0058` to be live in DEV (per the spec's own Section 5 hard gate). Migration
`0058` was NOT applied during this dispatch — no DDL capability exists in
this sandbox, confirmed structurally.

Report date: 2026-08-22.

## Baseline reproduction (Section 4)

Re-verified from a clean state at the start of this dispatch, exactly as
claimed in the dispatch brief, then again after every change in this pass:

| Check | Result |
|---|---|
| `tsc --noEmit` | Clean (0 errors), throughout |
| `vitest run` (start of dispatch) | 1183 passed / 5 skipped (1188 total) |
| `vitest run` (end of dispatch) | **1226 passed / 5 skipped (1231 total)** |
| `eslint .` | 6 errors / 7 warnings, unchanged before and after (all pre-existing, unrelated to this dispatch — `RecommendationsPanel.tsx`, `AppShell.tsx` set-state-in-effect; `ReportPreview.tsx`/`AppShell.tsx` no-img-element warnings; `replay.mjs` unused var) |
| `npm run build` | **Newly confirmed this pass**: exit 0, all routes compiled, once `.env.local` (copied from the parent repo's dev credentials, not committed) supplied the Supabase env vars this worktree lacked. Without those vars the build fails at static-page prerender with a Supabase-client-construction error — an environment-configuration gap in this fresh worktree, not a code defect (confirmed by the build succeeding cleanly once the vars were present). |

## Section 8 — 2025 Act placeholder resolved via legal research

**Outcome: CERTIFIED, not a placeholder anymore.** Independent web research
(2026-08-22) found the Income-tax Act, 2025's capital-gains provisions for
equity/equity-oriented-fund/business-trust disposals (Sections 196 STCG,
198 LTCG) are a **renumbering of the 1961 Act's Sections 111A/112A with NO
rate or threshold change** — same 20% STCG, 12.5% LTCG above Rs 1,25,000,
no indexation, same ≥65% equity-oriented-fund test. Corroborated by 4-6
independent, mutually-consistent secondary sources per rule (ebizfiling.com,
TaxGuru, ClearTax, Bajaj Finserv, finnovate.in, mstock.com, taxclue.in) plus
search-indexed citations from indiankanoon.org's transcription of the
enacted Act text (direct fetch of indiankanoon.org and
incometaxindia.gov.in both returned HTTP 403 to this session's tooling —
disclosed, not worked around by treating a secondary source as primary).

The debt/"specified mutual fund" always-short-term rule (Finance Act 2023)
was independently confirmed to continue unchanged into the 2025 Act era.

**One narrower item remains genuinely open** (disclosed, not blocking): no
source found explicitly confirms which 2025-Act provision re-enacts the
31-Jan-2018 grandfathering FMV step-up (originally a proviso to Section
55(2)(ac)) for disposals occurring after the 2025 Act takes effect.
`grandfathering.ts` applies the rule unconditionally by acquisition date
(not gated on which Act governs the disposal), which is almost certainly
correct — no source suggests repeal, and the 2025 Act was consistently
characterised as a consolidation exercise — but this specific continuity is
"reasonably certain by inference," not independently section-cited. Full
detail: `docs/investment-intelligence/R6_TAX_LEGAL_SOURCE_REGISTER.md`,
"Open items."

Files changed: `ruleVersions.ts` (`RULE_2025_ACT_PLACEHOLDER` →
`RULE_2025_ACT_POST_20260401`, `placeholder: true` → `false`), migration
`0058`'s seed (mirrored), `disclaimer.ts` (comment updated — mechanism kept,
now dormant), `taxVersioning.ts` (`TAX_ENGINE_VERSION` bumped v1→v2 to force
recomputation of any previously-placeholder-flagged cached result),
`tests/unit/iiR6P1Certification.test.ts`, `scripts/ii_r6p1_independent_reconciliation.py`.

## Section 9 — placeholder/TODO sweep

`grep -rn -i "placeholder|TODO|unverified|pending|temporary|assumed rate"` across
`lib/engines/investment-intelligence/tax/` and `taxRepository.ts` found 4
hits, all in the `ruleVersions.ts` → `taxOrchestrator.ts` →
`capitalGainsEngine.ts` → `disclaimer.ts` → `taxRepository.ts` placeholder
plumbing chain resolved by Section 8 above. **No assumed-current-law rate
survives.** The structural `placeholder`/`RULE_NOT_CERTIFIED`-style
mechanism is intentionally kept (not deleted) for a future genuinely-
uncertifiable rule change — see `R6_TAX_RULE_VERSIONING.md`.

## Section 10 — 1961→2025 Act transition certification

6 new oracle-compared cases (`ACTTRANS-001`..`006`, 3 identical-facts pairs
straddling 2026-03-31/2026-04-01) added to the certification pack, plus 2
dedicated adversarial assertions proving (a) the rule VERSION differs but
the taxable-gain AMOUNT is identical across the pair (the correct,
counter-intuitive behaviour given Section 8's finding of no rate change),
and (b) a disposal dated 2026-03-31 is invariant under repeated resolution
(no wall-clock dependency, no retroactive re-rating). All pass. Full
detail: `docs/investment-intelligence/R6_1961_TO_2025_ACT_TRANSITION.md`.

## Section 11 — effective-date boundary re-verification

| Boundary | Re-verified real? | Notes |
|---|---|---|
| 2018-01-31/02-01 (grandfathering) | Yes | 6 new oracle-compared cases (`GRANDBOUND-001`..`006`), disposal dated under the 2025 Act to also exercise continuity |
| 2023-03-31/04-01 (specified mutual fund) | Yes | Confirmed real via research; **also discovered** the engine does not enforce this as a per-lot gate (pre-existing R6-P1 scope limitation, already disclosed in `ruleVersions.ts`'s own comment) — documented as current, tested behaviour in `tests/unit/iiR6FinalDebtFundBoundary.test.ts`, not silently left unchecked |
| 2024-07-22/23 (Budget 2024) | Yes | Already covered by the pre-existing `RATE-*` family; re-confirmed via fresh research this pass — this is a REAL boundary, no correction needed |
| 2026-03-31/04-01 (Act transition) | Yes | See Section 10 |

No additional legally-significant boundary was found for this domain.

## Sections 14-15 — canonical-instrument and same-name adversarial tests

`tests/unit/iiR6FinalCanonicalInstrument.test.ts` (8 tests), hermetic
(mocked Supabase, no live DEV), covering:
- a >1,000-row identifier universe with the target's own identifier row
  past the first PostgREST page — found correctly, zero new instruments
  minted, real pagination confirmed (>1 page request)
- RED reproduction of the original unpaged-read defect on the identical
  fixture (proves the risk is real, not hypothetical)
- a genuinely-absent identifier correctly creates exactly ONE new instrument
  (documented as `resolveOrCreateInstrument`'s correct, by-design ADR-002
  behaviour — distinct from the pure `resolveScheme()` resolver, which
  explicitly returns `unresolved` and performs no I/O at all)
- two same-named instruments resolved to two different canonical ids via
  ISIN, never merged by name; a name-only ambiguous query correctly reports
  `ambiguous` rather than guessing
- FIFO tax lots, classification, grandfathering, and exit-load all proven
  to stay separated by canonical `instrumentKey` for two same-named
  instruments run through the real R6-P1 engines end-to-end

## Section 33 — six negative controls (all reproduced, all restored)

Each mutation was applied, the relevant test(s) run to confirm failure,
then reverted and re-confirmed green (`git diff` on the mutated file showed
zero residual diff after restoration in every case).

| # | Mutation | Failures | Restored green? |
|---|---|---|---|
| NC-1 | FIFO → LIFO (`taxLotEngine.ts` sort direction) | **22** (20 `FIFO-*` cert cases + comparison-report meta-assertion + the Section-40 >1000-txn adversarial test) | Yes |
| NC-2 | Grandfathering "classic wrong" formula (`min(max(cost,fmv),salePrice)`) | **4** (`GRAND-013`, `GRAND-014`, the dedicated real-loss-preserved test, comparison-report meta-assertion) | Yes |
| NC-3 | Grandfathering cutoff shifted 1 day (2018-02-01→02-02) | **4** (`GRANDBOUND-002/004/006` + comparison-report meta-assertion) | Yes |
| NC-4 | LTCG exemption applied per-fund instead of per-taxpayer-per-year | **1** — caught ONLY by a new dedicated multi-fund test (`iiR6FinalTaxpayerLevelAggregation.test.ts`); **finding**: the existing 120-case pack's `fy_aggregation`/`cross_fy` families use a single synthetic `instrumentKey='X'` throughout and cannot distinguish per-fund from per-taxpayer aggregation — closed by this new test | Yes |
| NC-5 | Current exit-load schedule applied to a historical lot | **2** — caught by `iiR6FinalExitLoadEffectiveDating.test.ts`; **finding**: `taxOrchestrator.ts`'s schedule selection had NO effective-date check at all (a bare `.find()`), a genuine pre-existing defect fixed in this same pass (see below) | Yes |
| NC-6 | Reference-data resolution by display name instead of canonical ID (`schemeResolution.ts` priority reordered) | **1** — the Section 15 same-name adversarial test | Yes |

## Real defects found and fixed this pass (beyond Section 8/9's scope)

Two genuine, previously-undetected defects were found while building the
Section 33/39-41 controls and fixed within this dispatch's narrow mandate
(certification/closure, not a redesign — both are small, isolated fixes):

1. **`taxRepository.ts`: four unbounded PostgREST reads.**
   `ii_instruments`, `ii_scheme_tax_classification`, `ii_prices_nav`, and
   `ii_exit_load_schedules` were all read via bare `.in(...)` selects with
   no pagination — R6-P0's own module-wide pagination audit predates this
   file's existence. The `ii_prices_nav` case was the sharpest: a single
   long-lived equity fund's pre-2018 daily NAV history can itself exceed
   1000 rows, and truncation there can make a LATER instrument's real
   31-Jan-2018 FMV vanish entirely, reported as `fmv_unavailable` — silently
   denying a real grandfathering tax benefit with no error anywhere. Fixed:
   all four now use `fetchAllRows()` with a deterministic, unique-key order.
   Certified by `tests/unit/iiR6FinalTaxPaginationAudit.test.ts` (13 tests:
   boundary matrix at 999/1000/1001/2500/5001 rows, a RED/GREEN pair
   reproducing the FMV-loss scenario, and the Section-40 >1000-transaction
   adversarial case where the DISPOSAL ITSELF sits at transaction #1500).
2. **`taxOrchestrator.ts`: exit-load schedule selection had no effective-date
   check.** A scheme can have more than one exit-load schedule version over
   time (migration `0058`'s own `unique(instrument_id, effective_from)`
   anticipates this). The original code picked whichever schedule row
   happened to be first for the instrument, regardless of the disposal's own
   date — i.e. exactly Section 33's NC-5 defect shape. Fixed to select the
   schedule version actually in force on the disposal date. Certified by
   `tests/unit/iiR6FinalExitLoadEffectiveDating.test.ts` (3 tests).

Both are disclosed here explicitly, consistent with this session's standing
practice of surfacing real defects found during closure passes rather than
only claiming what the spec asked for.

## Sections 39-41 — pagination audit extended

`taxRepository.ts` (R6-P1's own new repository code, written after R6-P0's
module-wide audit) was audited specifically and all four gaps fixed (see
above). `tests/unit/iiR6FinalTaxPaginationAudit.test.ts` extends R6-P0's own
boundary-matrix pattern (999/1000/1001/2500/5001 rows) to the new tax
tables' read paths, using the same hermetic mocked-Supabase approach — no
live DEV involved. 13 tests, all passing.

## Section 45 — full predecessor regression, regenerated from scratch

| Pack | Regenerated | Result |
|---|---|---|
| R4 (50-case) | `generate_cases.mjs` → `ii_r4_independent_reconciliation.py` → vitest | **50/50** |
| R5 (89-case) | `generate_cases.mjs` → `ii_r5_independent_reconciliation.py` → vitest | **89 cases / 698/698 comparisons** |
| R6 (120+12=132-case) | `generate_cases.mjs` → `ii_r6p1_independent_reconciliation.py` → vitest | **132 cases / 604/604 comparisons**. The original 120 cases are unchanged and pass unmodified (verified: `originalCount === 120` assertion in the harness); the 12 new closure cases (Sections 10 & 11) were added to the SAME pack per the spec's Section 34 instruction, not a competing one. |

All three regenerated genuinely from the generator scripts on this run (not
reused from checked-in output) — timestamps in each `comparison_report.json`
confirm fresh generation during this dispatch.

## Small discrepancy caught and fixed during this pass

Regenerating the R4/R5/R6 certification packs on this Windows sandbox
initially produced `oracle_results.json` files with CRLF line endings —
Python's `open(..., "w")` / `Path.write_text()` perform universal-newline
translation by default, turning `json.dump`'s `\n` separators into `\r\n` on
Windows, contrary to this repo's LF convention (flagged in the dispatch
brief as a known prior hazard: "a prior CRLF issue broke an exact-match test
elsewhere in this repo's history"). Caught via `git diff --stat` showing an
implausible whole-file rewrite for a supposedly-deterministic regeneration.
Fixed by adding `newline=""` to all three Python scripts' output-file opens
(`ii_r4_independent_reconciliation.py`, `ii_r5_independent_reconciliation.py`,
`ii_r6p1_independent_reconciliation.py`) and regenerating again — the R4/R5
files are then confirmed **byte-identical** to the pre-dispatch committed
versions (zero diff besides the `comparison_report.json` timestamp field),
proving the regeneration was genuinely deterministic and no case/value
actually changed.

## Final state

- `tsc --noEmit`: clean
- `vitest run`: **1226 passed / 5 skipped (1231 total)**
- `eslint .`: 6 errors / 7 warnings (unchanged, all pre-existing/unrelated)
- `npm run build`: exit 0 (with dev-worktree env vars supplied)
- Migration `0058`: still NOT applied to DEV (unchanged from dispatch start;
  this session has no DDL capability)

## Explicit PENDING list — every spec section awaiting migration `0058` application

Per the dispatch brief, these were correctly NOT attempted and remain
PENDING until the orchestrating session confirms `0058` is live in DEV:

- **Sections 5-7**: live reference-data population (`ii_scheme_tax_classification`,
  `ii_exit_load_schedules` seeded from real disclosures)
- **Section 13, 16, 18**: live reference-data-dependent work
- **Sections 20-27**: tax-residency wiring completion, API surface
  completion, browser/UX verification against a live app
- **Sections 29-38** (excluding 33, done above): the 12 LIVE-R6-DEV
  certification cases, live schema certification against the actually-
  applied migration, the live security/RLS harness
- **Sections 42-44**: atomicity, idempotency, and staleness-detection
  behaviour that require real DEV writes to test meaningfully

Nothing in the above was simulated, mocked, or claimed complete. This
dispatch's scope — Sections 4, 8, 9, 10, 11, 14, 15, 33, 39-41, 45, and
documentation — is complete as of this report.
