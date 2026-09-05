# A1 — Admin A0.2 Residual Evidence Register

Every finding carried from Admin A0.2 Waves 1–6, reproduced from `A02_WAVE6_HANDOVER_TO_A1.md` (unmerged, `docs/admin/` in worktree `agent-a490a0668360b4385`) with an explicit **A1-stage disposition** column added — accepted-as-is, addressed-by-this-stage's-design, or still-owed-to-a-later-stage. **No item's Wave 6 owner assignment is changed; this register only confirms A1 received it.**

| Finding | Wave 6 owner | A1-stage disposition |
|---|---|---|
| Nav-item/group count staleness (W6-1: 18/5, not 19/6) | A1 | **Accepted, corrected everywhere in this stage's own documents** (`A1_06`, `A1_07`) |
| Handler-count arithmetic (W6-2: 106, not 105) | A1 | **Accepted, corrected** (`A1_08` §11 reconciliation) |
| `context/[id]` PATCH and `faqs/[id]/links` DELETE zero-row contract | A1 | **Not resolved by this stage** — needs one platform-wide DELETE/zero-row ruling; flagged `A1_19` PO-8 |
| `correlation_id` threading (G5/DEF4-5) | A1 | **Design completed this stage** (`A1_12` §2.1/§4) — implementation still owed to A1.3 build-out |
| Canonical shared audit-sink design (Wave 4 §8) | A1 | **Adopted wholesale, extended** (`A1_12` §2) — not implemented |
| Canonical shared security-event design (Wave 4 §9) | A1 | **Adopted wholesale, extended** (`A1_12` §5) — not implemented |
| `resource_audit_log`/`resource_workflow_history` lack a hard immutability trigger | A1.3 | **Target defined** (`A1_12` §3: compensating append-only events + script conversion) — conversion itself owed to A1.3 build-out |
| `benchmark_update_runs`'s hard trigger | A1.3 (reference pattern) | **Confirmed as the generalisation template** (`A1_12` §2.2) |
| Analytics shell non-operational (ADM-19) | Analyst Analytics track | **Untouched by A1**, per its own separate-workstream boundary (`A1_17`) |
| Recommendations Gap Review's aggregate replacement | Canonical Analytics/Privacy architecture | **Design boundary confirmed** (`A1_15` §4) — owned by A4, not FDH-13, not Analyst Analytics |
| 41 MISSING / 24 PARTIAL rows of the 85-row FDH-13 matrix | FDH-13 Waves A–G | **Unchanged, not reopened** (`A1_16`) |
| Wave A's own precondition (prove capability-to-role fit before permanent Super-Admin-interim allocation) | FDH-13 Wave A | **Still outstanding; still the correct gate** — `A1_03` performs the capability-to-role fit test but does not itself satisfy the precondition (that requires PO approval, `A1_19` PO-1) |
| ADM-10 non-operational (scheduled publishing) | A3.1 | **Unchanged, correctly deferred**, sequenced in `A1_20` |
| Suppression model (Standard §7) never implemented anywhere | Canonical Analytics/Privacy architecture, or FDH-13 Wave E per REG-15 | **Boundary formalised** (`A1_15`) |
| 20 AI Admin routes, 0 pages (BWU-4/DEF-1/DEF4-8) | Module 11 roadmap | **Unchanged**; named in `A1_01` §6 as ADM-22–29 so it has a canonical task identity, UI ownership stays with Module 11 |
| PO5-2 (rename "General" nav group) | Needs PO decision | **Resolved — Product Owner ruled (`A1_19` PO-2, APPROVED with consolidation):** "General" splits into a standalone "Recommendations" area and Benchmarks folds into the new "Data Governance" area (not a standalone "Reference Data & Benchmarks" area as A1 had originally proposed — the Product Owner's actual structure differs from A1's own proposal; see `A1_06` §4) |
| PO5-3 (rename "Add @GKTC Video") | Needs PO decision | **Not addressed** — cosmetic, out of A1's architecture scope, flagged `A1_19` PO-2 for whichever wave touches that component next |
| PO5-4 (CSV import confirmation) | Needs PO decision | **Not addressed** — workflow-safety UX decision, not an architecture question; carried forward, not flagged again separately (already on record in Wave 6) |
| D5-8 (CTA form conflict handling) | Needs PO decision | **Not addressed** — flagged in `A1_10` pattern 3 as a known gap in the Create/Edit pattern; the `expectedUpdatedAt` contract decision itself stays with the PO |
| D5-5 (content-editor Cancel control) | Needs PO decision | **Not addressed** — same reasoning as D5-8 |
| PO4-2 (dedicated audit tables per domain vs. reuse) | Needs PO decision, ahead of A1's canonical design | **Resolved by this stage's own design**: one shared canonical sink, domain-classified (`A1_12` §2) — this supersedes the need for a per-domain decision going forward, though it does not retroactively rebuild `benchmark_update_runs`'s dedicated-table shape (Standard §1.2, no retroactive rebuild required) |
| D5-13/PO5-6 (`adminRoute()`'s error-message forwarding) | Needs PO decision | **Not fixed by A1** (§14, no hidden scope expansion) — flagged `A1_19` PO-9 for a formal §16.1 exception record or a fix |
| DEF-1/D-1 (22 duplicate-`sort_order` Related Content rows) | Offered as bounded cleanup | **Not addressed** — one-off DB cleanup, not an architecture question; remains available for a bounded fix whenever a session has live-DEV access |
| D-2 (leftover R1.1 test fixture) | Needs live-DEV access | **Not addressed** — same reasoning |

## Reconciliation

Every row in Wave 6's own Handover document (`A02_WAVE6_HANDOVER_TO_A1.md` §1–§8) appears above with an A1-stage disposition. Nothing is silently dropped. Items marked "Not addressed" are exactly the ones the brief's own scope boundary places outside A1 (UI copy/cosmetic decisions, one-off DB cleanups requiring live-DEV access, PO-only calls) — each still has its Wave 6 owner intact, and none is presented here as resolved when it is not.

---

## A0.2 Wave 6 evidence-tier closure (this pass, 2026-09-05)

Per the Product Owner's explicit follow-up — three items, verbatim: (1) correct and rerun the Wave 2 certification harness against a fixed baseline SHA; (2) reconcile the full-suite arithmetic exactly, including passed/failed/skipped counts; (3) confirm the locations and commit SHA of all 10 required Wave 6 deliverables — this pass independently reproduced each rather than trusting Wave 6's own report text. The Product Owner's separate ruling that "the absence of repeat live-DEV browser testing may remain a disclosed evidence-tier limitation" is accepted as-is and was **not** re-attempted (§4 below).

### 1. Wave 2 certification harness — correction independently re-run

Wave 6's own report (`A02_WAVE6_CONSOLIDATED_CERTIFICATION_REPORT.md` §5; `A02_WAVE6_HANDOVER_TO_A1.md` §1, item W6-5) diagnosed and fixed a real harness bug: SECTION 7 of `scripts/admin_a02_wave2_certification.mjs` read a **moving** `origin/main` ref as its "pre-Wave-2" baseline, which silently stopped reproducing the pre-fix defect once `origin/main` absorbed Wave 2's own fix. Wave 6 pinned SECTION 7 to `1b40b0be0bbb6b7d67b611e08ca255e68562abf1` — independently confirmed by this pass to (a) exist as a real commit ("Merge Wave 0: permanent FHIP Admin Architecture Standard") and (b) match `A02_WAVE2_WORKFLOW_ORDERING_INTEGRITY_CERTIFICATION.md` §2's own recorded value of "`origin/main` at report time" — the correct, principled baseline choice, not an arbitrary pin.

**This pass independently re-ran the corrected harness** (not merely read Wave 6's report) in the Wave 6 worktree (`D:/FHIP/.claude/worktrees/agent-a490a0668360b4385`, HEAD `d03d4dba41060382279ad0dcf2442bd48a68a556`, which carries the fix): `node scripts/admin_a02_wave2_certification.mjs` → **352 passed, 0 failed, exit 0**, reproduced fresh. SECTION 7's own output confirms the fix: `PASS baseline route sources readable from the fixed pre-Wave-2 SHA (1b40b0be0bbb6b7d67b611e08ca255e68562abf1)`, followed by all 7 pre-fix defect-signature checks passing.

**Residual gap found this pass, not previously disclosed anywhere:** the fix exists only inside this unmerged Wave 6 worktree/branch. This pass independently discovered that **the Wave 2 implementation itself (`D:/fhip-a02-wave2`, branch `fix/admin-a02-wave2-workflow-ordering-integrity`, tip `80a2e4f36184b9a155c489826f13e26cb5d5291a`) has already been merged into `origin/main`**, at merge commit `6fdcf7e61e9fc7e6f514edb0d823ca395b7853dd` ("merge: Admin A0.2 Wave 2 — Workflow & Ordering Integrity — FULL PASS", 2026-08-31, author `amarnathbs`) — confirmed via `git merge-base --is-ancestor 6fdcf7e origin/main` → true, and migration `0116_admin_a02_wave2_related_reorder_and_scheduling_integrity.sql` present at `origin/main`'s current tip. **`origin/main`'s own copy of `scripts/admin_a02_wave2_certification.mjs` (inherited via that merge) still contains the original, unfixed SECTION 7** — `git show origin/main:scripts/admin_a02_wave2_certification.mjs` still reads a moving `origin/main` ref, confirmed directly. Wave 6's fix was never cherry-picked back into the canonical branch that actually shipped. **This is a genuine, still-open residual**, distinct from what Wave 6 itself reported as closed: the corrected harness is proven correct (352/352 against the intended fixed baseline) but that correction has not yet landed anywhere on `origin/main`. Recommended follow-up (outside A1's own documentation-only mandate to perform): a single-file, low-risk cherry-pick of Wave 6's SECTION 7 fix onto `origin/main` — test-harness only, no application-code change — flagged here for Product Owner authorisation.

### 2. Full-suite arithmetic — independently re-run, not copied

Wave 6's own report claimed, against its own `b4b4340` tree: Files 247 = 232 passed + 13 failed + 2 skipped; Tests 5871 = 5847 passed + 6 failed + 18 skipped — while separately disclosing that 5 further files hit a Vitest worker-start infrastructure timeout under shared-machine contention and were excluded from that count entirely.

**This pass independently re-ran the full deterministic suite** (`npx vitest run`) in the same worktree, same commit (`d03d4dba41060382279ad0dcf2442bd48a68a556`), with no worker-start infrastructure failure this time: **Files: 252 = 239 passed + 11 failed + 2 skipped** (239+11+2=252, verified). **Tests: 5941 = 5920 passed + 3 failed + 18 skipped** (5920+3+18=5941, verified). The skipped count (18) matches Wave 6's own figure exactly, consistent with the same two deliberate live-DEV skip-guard files (`iiR4LiveIntegration.test.ts` [5 tests] + `resourcesR1_7DFinalLiveDev.test.ts` [13 tests]).

**Reconciliation of the discrepancy (252 vs. 247 files; 5941 vs. 5871 tests):** the +5 files and +70 tests are exactly the 5 files Wave 6 itself disclosed as dropped by its own worker-start timeout (uncounted in either of its totals) — they ran cleanly, with no infrastructure failure, in this pass's rerun. Of this pass's 11 failed files: 9 crash at import for lack of live-DEV credentials (`resourcesAdminR1_2.test.ts`, `resourcesAdminRoleCtaHotfixLiveDev.test.ts`, `resourcesEditorR1_3.test.ts`, `resourcesDiscoveryR1_6LiveDev.test.ts`, `resourcesP0ContentR1_7CLiveDev.test.ts`, `resourcesPublicR1_5.test.ts`, `resourcesImportR1_7LiveDev.test.ts`, `resourcesR1_1.test.ts`, `resourcesR1_4LiveDev.test.ts` — 0 tests counted for any of the 9, matching Wave 6's own disclosed credential-absence pattern exactly); `aiResidualClosureFailClosed.test.ts` (2 of 18 failed: tests A1 and A4); `fdh11Isolation.test.ts` (1 of 11 failed: a 5-second timeout on "no engine, report or dashboard queries fdh_investment_statement_* directly"). That is 3 failed tests total, fewer than Wave 6's own 6 — consistent with Wave 6's own disclosure that "10 of the 11 [failed/timed-out tests] pass cleanly outside contention" and that only `aiResidualClosureFailClosed.test.ts` test A4 "remains flaky even alone": this pass's independent rerun reproduces exactly that pattern (A4 failed again here, unprompted). **Zero net Admin-attributable regression** — none of the 11 failing files touches the Admin surface (`app/api/admin`, `app/(app)/admin`, `lib/resources/permissions.ts`, `lib/services/adminAuth.ts`); every failure is a pre-existing, already-disclosed live-DEV-credential or shared-machine-contention condition, not a new defect.

### 3. Wave 6 deliverables — locations and commit SHA confirmed

All 10 required deliverables independently confirmed present via `git ls-tree -r --long`, at:

**Worktree:** `D:/FHIP/.claude/worktrees/agent-a490a0668360b4385`
**Branch:** `worktree-agent-a490a0668360b4385` (local only — not pushed to `origin`)
**Commit:** `d03d4dba41060382279ad0dcf2442bd48a68a556` (one commit ahead of `2262808144f4749b72e0cf19edcd24e08137c803`, the original Wave 6 certification commit; `d03d4db` is a documentation-only follow-up correcting a self-referential SHA in the report's own text, per its own commit message — no deliverable content changed)

| # | File | Blob SHA |
|---|---|---|
| 1 | `docs/admin/A02_WAVE6_ADMIN_SURFACE_INVENTORY.md` | `e1576b4395cc6cbf1dd0b15e409777a47582c40a` |
| 2 | `docs/admin/A02_WAVE6_CONSOLIDATED_CERTIFICATION_REPORT.md` | `722a682dc82eeb3dae3f858a4f3a6a40cf4f8ee1` |
| 3 | `docs/admin/A02_WAVE6_FDH13_TRACEABILITY_MATRIX.md` | `666635fb7f7ccd627e83039f269938b6ab2969d7` |
| 4 | `docs/admin/A02_WAVE6_FLAT_AUTHORIZATION_REGISTER.md` | `671b3a14fba0d066b9b580841e53e3bbcd1bd6ce` |
| 5 | `docs/admin/A02_WAVE6_HANDOVER_TO_A1.md` | `3b3e2224c8ba5aea8f32cb4d5e36745ddd237616` |
| 6 | `docs/admin/A02_WAVE6_KNOWN_DEFERRALS_RESIDUAL_RISK_REGISTER.md` | `b43a558f57e9501d42a07f0000b9a61106401233` |
| 7 | `docs/admin/A02_WAVE6_MUTATION_RPC_AUDIT_REGISTER.md` | `829924e06e17c2f9155f2174ba3845805a0316b7` |
| 8 | `docs/admin/A02_WAVE6_TASK_MANUAL_INDEX.md` | `d361c73201c24b6817cc48b6da28e4075485bb5c` |
| 9 | `docs/admin/A02_WAVE6_TEST_AND_LIVE_EVIDENCE_INDEX.md` | `9e07e38ac5b8426db1bb659a112d0bbacb9edcd2` |
| 10 | `docs/admin/A02_WAVE6_WAVES1-5_TRACEABILITY_MATRIX.md` | `0fdb8066718a030b005419c65517fa4bced1c4de` |

Not merged, not pushed to `origin/main` — the same status Wave 6 itself recorded; unchanged by this pass.

### 4. Live-DEV browser recertification (Waves 3–5) — accepted, not attempted

Per the Product Owner's explicit instruction, the absence of repeat live-DEV browser recertification remains a disclosed evidence-tier limitation and was **not** re-attempted in this pass: Waves 3–5 already supplied live evidence and no relevant Admin implementation has changed since (confirmed again by this pass — see Task B's `git diff --stat` finding of zero application-code drift since the last reconciliation). This item is closed by the Product Owner's own statement, not by new evidence, and is not reopened here.
