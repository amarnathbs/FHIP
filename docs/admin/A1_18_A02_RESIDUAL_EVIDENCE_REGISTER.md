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
