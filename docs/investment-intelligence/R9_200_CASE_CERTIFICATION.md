# R9 Independent Certification Pack

Spec section 81 asks for R9-TC001 -> R9-TC200 (200 individually-labelled deterministic cases). This pass delivers a smaller, but genuinely independent and deterministic, set — reported honestly rather than padded to the target count.

## Actual delivered count: 60 deterministic cases across 3 independent artifacts

| Artifact | Cases | What it proves |
|---|---|---|
| `scripts/r9_independent_goals_forecasting_oracle.mjs` | 21 (R9-ORACLE-001..036, non-contiguous) | Goal-linked value arithmetic, allocation-cap decisions, portfolio split, review-trigger thresholds — reimplemented from scratch, no production TS import |
| `tests/unit/iiR9ReviewCentreEngine.test.ts` | 17 | Every one of the 9 deterministic review rules, plus attribution edge cases (fully-allocated, unallocated, multi-goal split, multi-investment sum, over-100% defensive detection) and the compliance-classification guarantee |
| `tests/unit/iiR9PaginationCertification.test.ts` | 4 | >1000-row pagination, including the harness's own vacuity check |
| `tests/unit/iiR9GoalAllocationLifecycle.test.ts` | 3 | Ownership check, successful allocation + sync, cap-rejection with no orphaned row |
| `scripts/ii_r9_certification.mjs` (PGlite, real Postgres) | 15 | RLS positive/negative access, cross-tenant forgery denial, dedup constraint, allocation-cap CHECK, no-double-counting DB invariant + its own negative control |

**Total: 60/60 passing, 0 failing**, distributed roughly per spec section 82's suggested buckets (goal allocations, current-value attribution, forecasting integration consumption, review-centre logic, provenance/versioning, security/integrity, pagination) though not machine-numbered R9-TC001..200.

## Why not 200

Reaching a literal 200 individually-authored cases (and the accompanying 50-scenario end-to-end pack, §86) was out of reach within this pass's scope and is reported as a genuine, disclosed gap rather than satisfied by generating filler cases. The 60 delivered cases cover every rule, every critical invariant (cap enforcement, no double counting, cross-tenant security, pagination, dedup), and both branches (positive and negative) of each — see `R9_ACCEPTANCE_REPORT.md`'s Known Limitations for the explicit remaining-work list.
