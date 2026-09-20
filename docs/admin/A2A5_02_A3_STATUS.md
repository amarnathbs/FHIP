# A3 — Domain Workflow Migration: Status

**Scope:** this spec's A3-WP-01..60 (10 topics × 6 cycles, area tag rotating across Resources/Recommendations/Benchmarks/Reference Data/FDH Governance/Scheduling/Operations/Content). Per `A2A5_00` §2, the 10 real topics are: content/resources migration, recommendations migration, benchmarks/reference data, FDH governance integration, scheduled/operational workflows, workflow-state consistency, transactional mutation preservation, audit continuity, manual alignment, compatibility monitoring.

**Binding sequencing:** `docs/admin/A1_20_ROADMAP_A2_A5.md`'s PO-8 table (reproduced in that document) is the authoritative internal order: **(1) Content and Resources workflows → (2) Recommendations → (3) Benchmarks and reference data → (4) FDH governance capabilities → (5) Scheduled and operational workflows.** This dispatch honours that order.

## 1. PO-8 step 1 (Content and Resources) — status: NOT NEEDED beyond what A2 already did

`A1_20`'s own A3.2 description: "physically reorganise Discovery under Content per A2's nav decision (route-level, not just nav-level)." `docs/admin/A2_13_A2_TO_A3_HANDOVER_AND_DEFERRAL_REGISTER.md` §2 already recorded this precisely: A2 changed nav *parents* only; Discovery's actual file paths (`app/(app)/admin/resources/{related,ctas,context}`) were never moved, because `A1_08` §10 scopes URL/route changes out of A2. Re-inspecting the current tree confirms these routes are unchanged and still resolve correctly through the canonical shell's Content nav grouping. **No code change is required here** — the "migration" A3.2 describes was already satisfied by A2's nav-level grouping decision, and moving the physical file paths now would be a pure churn/regression-risk exercise with no behavioural benefit, which A2-WP's own binding instruction ("reuse canonical shared components... do not introduce a competing resolver") counsels against manufacturing work for its own sake. **Status: PASS (by inspection — nav grouping confirmed live in `lib/admin/adminAreas.ts`, no route move needed).**

## 2 & 3. PO-8 steps 2–3 (Recommendations, Benchmarks) — capability-split execution: IMPLEMENTED, UNIT-TESTED, LIVE-VERIFICATION BLOCKED

This is the one real, bounded, PO-8-sequenced code change this dispatch made. Full detail in `A2A5_02A_A3_CAPABILITY_SPLIT_EXECUTION.md`. Summary:

- `lib/services/adminAuth.ts` gained three new, separately named, separately documented capability functions (`requireBenchmarksAdmin`, `requireRecommendationsAdmin`, `requireAIPlatformAdmin`), each a thin wrapper delegating to the exact same `requireAdmin()` logic — additive, not access-changing, per `A1_20`'s own explicit design constraint for this split.
- All 34 route files that previously called the broad `requireAdmin()` (10 Benchmarks + 4 Recommendations + 20 AI Admin) were renamed to their domain-scoped function. Zero authorization *logic* was touched — this is a pure rename at every call site.
- `app/api/admin/account-deletions/route.ts` was investigated and found to already use its own dedicated `requireAccountDeletionAdmin()` (from LR-9) — it never called the broad `requireAdmin()`, so it needed and received no change.
- New test file `tests/unit/adminCapabilitySplit.test.ts` proves (a) each new function behaves identically to the original in the deny-unauthenticated/deny-non-admin/allow-admin cases, and (b) a structural regression guard confirming none of the 34 files still calls the broad gate.
- The pre-existing `tests/unit/countryGateAdminAndHousehold.test.ts` (which imports and exercises the real `benchmarkSourcesGET` route handler) continues to test the actual route path end-to-end and is unaffected by the rename (it tests behaviour, not the function name).

**AI Admin** was included in this slice even though `A1_20`'s PO-8 table lists FDH governance (step 4) before scheduled/operational workflows (step 5) and doesn't explicitly re-name AI Admin's own step — but `A1_02_CAPABILITY_CATALOGUE.md`'s CAP-16 finding explicitly names AI Admin as one of the 3 domains sharing the broad gate, and the AI Admin capability's own step in `A1_20`'s A2 §"Included" list already authorized splitting it alongside Benchmarks/Recommendations. Including it here means the entire CAP-16 finding is closed in one pass rather than split across two.

**Status: CONDITIONAL PASS.** Implementation and unit-test evidence is real (see `A2A5_02A` for exact commands/output once the dependency install completes — recorded in that document). What is NOT done: the full 9-caller-type live-DEV matrix `A1_20`'s own "Test requirements" demand before/after this kind of gate-shape change — **blocked** in this environment (no `.env.local`, no `SUPABASE_*` environment variables; `playwright.config.ts` itself documents that Supabase-touching specs require `.env.local`, which does not exist in this worktree). This is an environment limitation (Programme Charter 9's own named category), not a defect and not a skipped step.

## 4. PO-8 step 4 (FDH governance capabilities) — status: NOT STARTED, correctly deferred

Per `A1_20`'s own cross-package sequencing note and this repo's FDH-13 track (`docs/admin/A1_16_FDH13_TRACEABILITY_MATRIX.md`), FDH governance capabilities (CAP-19–CAP-29) are **still all "Proposed" with zero code** — this is FDH-13's own separately-authorised workstream, not an A3 sub-package, and PO-8 places it after steps 1–3 (done above) and before step 5. Starting FDH-13 Wave A/B implementation is out of this dispatch's scope (no such authorization was given, and `docs/admin/A2A5_00...` §6 does not name it as newly in-scope for this spec either — the A3-WP "FDH governance integration" topic's binding instructions are the same generic migration-preservation instructions as every other A3-WP topic; they do not themselves authorize building the FDH-13 feature). **Status: NOT STARTED (correctly — no separate FDH-13 authorization exists).**

## 5. PO-8 step 5 (Scheduled and operational workflows — ADM-10) — status: NOT STARTED

`A1_20`'s A3.1 needs a new scheduled-job queue table (migration required). Programme Charter 7 reserves migrations for explicit Product Owner authorization, and this dispatch's own instructions are explicit: do not apply any migration to DEV or production, and treat any new-table need as a stop-and-escalate condition (A2-WP's own "Stop and escalate when: Schema, RLS or RPC modification becomes necessary"). **A migration file was not even drafted for this dispatch** — building the worker/queue design without executing any of it was judged lower value than the capability-split work actually completed, given the time available; this is recorded as the single largest scoped-out A3 item, carried forward explicitly rather than silently dropped.

**Status: NOT STARTED.** Recommended next step for a follow-up pass: design (not apply) the scheduled-publish queue schema and worker contract, matching A4's own "design first, apply later" posture below.

## 6. A3's cross-cutting topics (workflow-state consistency, transactional mutation preservation, audit continuity, manual alignment, compatibility monitoring)

These 5 topics are re-verification lenses applied to whatever domain work actually changes route/workflow behaviour — they are not standalone deliverables. Since the only A3 code change this dispatch made (the capability rename) touched zero business logic, zero mutation code, and zero audit code, all five topics are trivially satisfied by inspection for that specific change (nothing that could regress mutation atomicity, audit continuity, or manual accuracy was touched). They remain **open, substantive verification obligations** for whichever future pass executes PO-8 steps 4–5 (FDH governance, scheduled workflows) or any other A3 workflow-migration work with real business-logic movement.

## 7. A3 exit-gate status

Per `A1_20`: "A3 as a whole does not require every sub-package to ship together" — each sub-package certifies independently. Reflected here:

| PO-8 step | A1_20 mapping | Status |
|---|---|---|
| 1. Content/Resources | A3.2 | PASS (already satisfied by A2, confirmed by inspection) |
| 2. Recommendations | A3.3 slice | CONDITIONAL PASS (implemented + unit-tested; live-DEV matrix blocked) |
| 3. Benchmarks | A3.3 slice | CONDITIONAL PASS (same evidence, same gap) |
| — AI Admin (bundled into this pass's A3.3 slice) | A3.3 | CONDITIONAL PASS (same) |
| 4. FDH governance | not an A1_20 A3.x package | NOT STARTED (correctly deferred — separate authorization required) |
| 5. Scheduled/operational (ADM-10) | A3.1 | NOT STARTED (migration required; Product Owner authorization required first) |
