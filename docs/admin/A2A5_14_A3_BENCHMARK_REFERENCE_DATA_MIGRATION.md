# A3.3 — Benchmarks and Reference-Data Migration

This filename covers two genuinely different things this mission's own vocabulary conflates (per its Section 4.1 placement rule, "Benchmarks, reference data and FDH master-data... belong under Data Governance" — one nav area, two very different states of completion). Split below to avoid the same conflation the mission's own naming risks.

## Part A — Benchmarks: DONE

See `A2A5_11` §3/§4. `api/admin/benchmarks/**` (10 files) + 1 page, reachable under Data Governance (`lib/admin/adminAreas.ts`), gated by `requireBenchmarksAdmin()` (this dispatch's A3.3 capability split — behaviourally identical to the prior `requireAdmin()`, verified `A2A5_07` §8). `benchmark_update_runs`'s existing hard-immutability-trigger audit is unchanged.

Also DONE this dispatch (not originally scoped as "Benchmarks" but living in the same Data Governance area): the two PC6/PC7 Investment Intelligence destinations (Reference Data Quality, Fund Look-Through Quality) — these are pre-existing, PC6/PC7-built, already-authorized features that were missing a canonical-shell nav entry point until this dispatch's reconciliation fix (`A2A5_00`/`A2A5_07`). **These are not the same "Reference Data" as the A3-WP register's "Reference Data" area** (which refers to FDH-13's proposed master-data governance, Part B below) — an important naming collision this document exists to disambiguate. PC6/PC7's "reference data" is Investment Intelligence's market-data quality monitoring; FDH-13's "Reference Data" area is proposed institution/merchant/category/MCC master-data governance. They share a label by coincidence of terminology, not by shared implementation or shared authorization model.

## Part B — FDH-13 Reference Data / Master-Data Governance: NOT STARTED

CAP-19 through CAP-22 (`canViewFdhMasterData`, `canProposeFdhMasterData`, `canReviewFdhMasterData`, `canApproveFdhMasterData`) remain "Proposed" in `A1_02` with zero code anywhere in this repository. This is FDH-13's own separately-authorized workstream (Wave A/B), not started by this dispatch, consistent with `A1_20`'s cross-package sequencing note ("FDH-13 Wave A may start any time after A2's capability-split precedent exists... but FDH-13 Wave E must wait for A4.3"). The capability-split precedent A1_20 refers to now exists (this dispatch's A3.3 work) — that is a precedent FDH-13 Wave A could build from, not something this dispatch itself builds FDH-13 on top of without separate authorization.

## Still blocked (Part A only — Part B has no live gate to be blocked on, since nothing exists to test)

Live-DEV proof of the Benchmarks/PC6/PC7 migrated shell is part of the BLOCKED `A2A5_09` live-role matrix.
