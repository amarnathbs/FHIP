# A3 — Complete Work-Item Register (Exact Enumeration)

**Mission requirement:** "The expected approximately 59 deferred items must be enumerated exactly. Do not retain 'approximately 59' in the terminal report." This document is that exact enumeration, built from the source spec's own A3-WP-01 through A3-WP-60 (60 items total, not 59 — see §1), cross-referenced against this repository's real `A1_01`/`A1_08`/`A1_16`/`A1_20` architecture documents and the actual current codebase, not against the source document's generic per-item boilerplate alone.

## 1. Why the register is 60 items, not "approximately 59"

`docs/admin/A2A5_00_PROGRAMME_RECONCILIATION.md` §2 already established that the source spec's A3-WP-01..60 is a template: 10 distinct topic labels × 6 cycles, each row additionally tagged with one of 8 canonical areas on a rotating offset. Direct re-inspection of the source extraction (`a2a5_full_structured.txt`) confirms every one of the 60 items' actual "Outcome" line reads **"Migrate the {AREA} operator journey into the canonical shell without weakening its certified business, authorization, audit or transactional behaviour"** — keyed by the row's AREA tag only. The topic label in the title (e.g. "Workflow-state consistency," "Audit continuity") does not change the binding instructions, required evidence, or stop conditions text at all — confirmed identical across every one of the 60 items by direct comparison. This means:

- The **exact count is 60**, not "approximately 59." One item (the equivalent of the capability-split slice, A3-WP-02/03's Recommendations/Benchmarks framing) is fully closed by this dispatch's prior commit (`1e38609`); the "approximately 59" figure in the follow-on mission's own framing appears to derive from treating that as "1 of 60 done, ~59 remain" — which this register now replaces with an exact, area-by-area accounting (§3) rather than a single undifferentiated count, because **the real disposition is not uniform across the 59** — 30 of them are ALSO already done (they map to areas A2 already migrated), and only 29 are genuinely not started.
- The true independent variable across all 60 rows is **which of the 8 canonical areas** a row is tagged with, not which of the 10 topic labels heads it — since the actual content is area-keyed, not topic-keyed. §3 groups by area for this reason; §2 gives the full 60-row raw enumeration the mission's own wording literally asks for.

## 2. Full 60-row enumeration

| A3-WP | Topic | Area | Status |
|---|---|---|---|
| A3-WP-01 | Content and Resources migration | Resources | DONE |
| A3-WP-02 | Recommendations migration | Recommendations | DONE |
| A3-WP-03 | Benchmarks and reference data | Benchmarks | DONE |
| A3-WP-04 | FDH governance integration | Reference Data | NOT STARTED |
| A3-WP-05 | Scheduled and operational workflows | FDH Governance | NOT STARTED |
| A3-WP-06 | Workflow-state consistency | Scheduling | NOT STARTED |
| A3-WP-07 | Transactional mutation preservation | Operations | NOT STARTED |
| A3-WP-08 | Audit continuity | Content | DONE |
| A3-WP-09 | Manual alignment | Resources | DONE |
| A3-WP-10 | Compatibility monitoring | Recommendations | DONE |
| A3-WP-11 | Content and Resources migration | Benchmarks | DONE |
| A3-WP-12 | Recommendations migration | Reference Data | NOT STARTED |
| A3-WP-13 | Benchmarks and reference data | FDH Governance | NOT STARTED |
| A3-WP-14 | FDH governance integration | Scheduling | NOT STARTED |
| A3-WP-15 | Scheduled and operational workflows | Operations | NOT STARTED |
| A3-WP-16 | Workflow-state consistency | Content | DONE |
| A3-WP-17 | Transactional mutation preservation | Resources | DONE |
| A3-WP-18 | Audit continuity | Recommendations | DONE |
| A3-WP-19 | Manual alignment | Benchmarks | DONE |
| A3-WP-20 | Compatibility monitoring | Reference Data | NOT STARTED |
| A3-WP-21 | Content and Resources migration | FDH Governance | NOT STARTED |
| A3-WP-22 | Recommendations migration | Scheduling | NOT STARTED |
| A3-WP-23 | Benchmarks and reference data | Operations | NOT STARTED |
| A3-WP-24 | FDH governance integration | Content | DONE |
| A3-WP-25 | Scheduled and operational workflows | Resources | DONE |
| A3-WP-26 | Workflow-state consistency | Recommendations | DONE |
| A3-WP-27 | Transactional mutation preservation | Benchmarks | DONE |
| A3-WP-28 | Audit continuity | Reference Data | NOT STARTED |
| A3-WP-29 | Manual alignment | FDH Governance | NOT STARTED |
| A3-WP-30 | Compatibility monitoring | Scheduling | NOT STARTED |
| A3-WP-31 | Content and Resources migration | Operations | NOT STARTED |
| A3-WP-32 | Recommendations migration | Content | DONE |
| A3-WP-33 | Benchmarks and reference data | Resources | DONE |
| A3-WP-34 | FDH governance integration | Recommendations | DONE |
| A3-WP-35 | Scheduled and operational workflows | Benchmarks | DONE |
| A3-WP-36 | Workflow-state consistency | Reference Data | NOT STARTED |
| A3-WP-37 | Transactional mutation preservation | FDH Governance | NOT STARTED |
| A3-WP-38 | Audit continuity | Scheduling | NOT STARTED |
| A3-WP-39 | Manual alignment | Operations | NOT STARTED |
| A3-WP-40 | Compatibility monitoring | Content | DONE |
| A3-WP-41 | Content and Resources migration | Resources | DONE |
| A3-WP-42 | Recommendations migration | Recommendations | DONE |
| A3-WP-43 | Benchmarks and reference data | Benchmarks | DONE |
| A3-WP-44 | FDH governance integration | Reference Data | NOT STARTED |
| A3-WP-45 | Scheduled and operational workflows | FDH Governance | NOT STARTED |
| A3-WP-46 | Workflow-state consistency | Scheduling | NOT STARTED |
| A3-WP-47 | Transactional mutation preservation | Operations | NOT STARTED |
| A3-WP-48 | Audit continuity | Content | DONE |
| A3-WP-49 | Manual alignment | Resources | DONE |
| A3-WP-50 | Compatibility monitoring | Recommendations | DONE |
| A3-WP-51 | Content and Resources migration | Benchmarks | DONE |
| A3-WP-52 | Recommendations migration | Reference Data | NOT STARTED |
| A3-WP-53 | Benchmarks and reference data | FDH Governance | NOT STARTED |
| A3-WP-54 | FDH governance integration | Scheduling | NOT STARTED |
| A3-WP-55 | Scheduled and operational workflows | Operations | NOT STARTED |
| A3-WP-56 | Workflow-state consistency | Content | DONE |
| A3-WP-57 | Transactional mutation preservation | Resources | DONE |
| A3-WP-58 | Audit continuity | Recommendations | DONE |
| A3-WP-59 | Manual alignment | Benchmarks | DONE |
| A3-WP-60 | Compatibility monitoring | Reference Data | NOT STARTED |

**Totals: 31 DONE, 29 NOT STARTED, 60 total.**

## 3. Grouped by area (the real independent variable) — stable IDs, routes, capability, evidence

| Area | A3-WP rows | Status | Route(s) | Capability | Audit requirement | Compatibility disposition | Evidence |
|---|---|---|---|---|---|---|---|
| **Resources** | 01,09,17,25,33,41,49,57 (8 rows) | **DONE** | `admin/resources/**` (36 pages, per `A1_08`) | `resourcesDashboard`/`resourceContentAdmin`/etc. (unchanged) | Pre-existing A0.2 `resource_audit_log`/`resource_workflow_history` (unchanged) | `A1_08` §10: zero URL changes; nothing to compatibility-monitor | `A2_01`–`A2_14`, this dispatch's `A2A5_00`–`A2A5_08` |
| **Recommendations** | 02,10,18,26,34,42,50,58 (8 rows) | **DONE** | `api/admin/recommendations/**` (4 files) + 1 page | `requireRecommendationsAdmin` (this dispatch, A3.3) | Existing `admin_upsert_recommendation_atomic`/`admin_import_recommendation_conditions` audit (unchanged) | Gap route (`ADM-06`) remains a permanent withdrawn 503 stub per PO-9's privacy-unsafe carve-out (`A1_08` §2) | `A2A5_02A_A3_CAPABILITY_SPLIT_EXECUTION.md`, `tests/unit/adminCapabilitySplit.test.ts` |
| **Benchmarks** | 03,11,19,27,35,43,51,59 (8 rows) | **DONE** | `api/admin/benchmarks/**` (10 files) + 1 page | `requireBenchmarksAdmin` (this dispatch, A3.3) | Existing `benchmark_update_runs` immutable-trigger audit (unchanged) | None needed; no URL change | Same as Recommendations |
| **Content** | 08,16,24,32,40,48,56 (7 rows) | **DONE** | `admin/resources/{content,videos,glossary,money-updates,faqs}/**` (23 API files, ~28 pages) + Discovery sub-group | Existing content-workflow capabilities (unchanged) | Pre-existing A0.2 audit (unchanged) | None needed; `A1_08` §5/§6 confirm nav-parent-only changes | `A1_08` §5/§6, `A2_03` |
| **Reference Data** | 04,12,20,28,36,44,52,60 (8 rows) | **NOT STARTED** | None exist — CAP-19-22 (`canViewFdhMasterData`, `canProposeFdhMasterData`, `canReviewFdhMasterData`, `canApproveFdhMasterData`) are all "Proposed," zero code | N/A — not yet designed into any route | N/A | N/A — nothing to migrate because nothing exists | `A1_02` §CAP-19-22, `A1_16` FDH-13 traceability |
| **FDH Governance** | 05,13,21,29,37,45,53 (7 rows) | **NOT STARTED** | None exist — CAP-23-29 (parser registry, kill-switch, ops view, analytics, support/break-glass) all "Proposed" | N/A | N/A | N/A | `A1_02` §CAP-23-29, `A1_16` |
| **Scheduling** | 06,14,22,30,38,46,54 (7 rows) | **NOT STARTED** | None exists — `ADM-10` scheduled publishing has no operational feature yet (`A1_02` §"Tasks with no capability") | N/A — needs a new queue table (`A1_20` A3.1) | N/A | `admin/resources/content/scheduled/page.tsx` stays `hide-until-ready` (`A1_08` §6) | `A1_08` §6, `A1_20` A3.1 |
| **Operations** | 07,15,23,31,39,47,55 (7 rows) | **NOT STARTED** | None exists — confirmed live by `A2_09`: "no persona ever sees Operations... no genuinely usable destination exists yet" | N/A | N/A | N/A | `A2_09_TEST_AND_REGRESSION_REPORT.md` |

Row counts per area sum to 60 (8+8+8+7+8+7+7+7 = 60), matching the 8-area rotation over 60 rows (some areas get 8 occurrences, some get 7, since 60 is not evenly divisible by 8).

## 4. What "DONE" means precisely for the 4 completed areas

For Resources/Recommendations/Benchmarks/Content, "DONE" means specifically:
1. The operator journey is reachable under the canonical 8-area shell (A2, `c87c111`/`fb4f78c`) — confirmed by direct code inspection, not merely asserted.
2. No physical route/URL changed (`A1_08` §10/§11 confirm zero URL changes across all 110 pre-existing route artifacts) — so there is no compatibility-route risk to monitor for these areas.
3. Existing, pre-A2 mutation/audit invariants (A0.2 Waves 1–5's own certified atomicity and audit-on-mutation guarantees) are unchanged — verified by inspection that none of A2's or this dispatch's commits touched any mutation-path or audit-path source file for these domains (confirmed: `git diff --stat` for `1e38609` shows only `adminAuth.ts`'s new wrapper functions and 34 mechanical renames — zero business-logic files).
4. Recommendations and Benchmarks additionally have the CAP-16 capability split executed (A3.3).

**What "DONE" does not mean:** it does not mean a live-DEV, real-browser proof exists for these journeys under the new shell — that remains part of the still-BLOCKED live-role matrix (`A2A5_09`), same root cause (no DEV credentials) as everywhere else in this report set.

## 5. What "NOT STARTED" means precisely for the 4 unstarted areas

For Reference Data/FDH Governance/Scheduling/Operations, "NOT STARTED" means: zero code exists, zero migration exists, and (for Reference Data/FDH Governance specifically) starting them requires a **separate FDH-13 authorization** this dispatch was never given (per the original dispatching session's own explicit scope boundary, and per this mission's own §4.4 "no separate FDH systems" — which is about integration architecture, not authorization to build FDH-13's substantive features here). For Scheduling, starting it requires a new migration, which requires explicit Product Owner authorization before any schema work begins (mission §10.1's own migration-authorization gate, applied by the same logic to any new schema, not only migration `0165`). For Operations, there is not yet even a defined feature to migrate — A2's own live-tested finding (`A2_09`) is that no persona sees anything under this nav area today, so "migrating" it has no concrete referent yet.

None of these four are silently incomplete — each is **explicitly outside this dispatch's authorized scope**, satisfying the mission's own A3 FULL PASS bar: "remaining items, if any, are explicitly outside approved scope rather than silently incomplete" (§15.2).

## 6. Cross-reference to FDH-13's 85 requirements

See `A2A5_29_FINAL_FDH13_TRACEABILITY.md` for the full reconciliation against `A1_16_FDH13_TRACEABILITY_MATRIX.md`'s existing traceability rows. Summary: Reference Data + FDH Governance areas above (15 of the 60 A3-WP rows) are exactly the two areas FDH-13's 85 requirements would eventually occupy; none of the 85 is implemented by this dispatch, consistent with §5 above.
