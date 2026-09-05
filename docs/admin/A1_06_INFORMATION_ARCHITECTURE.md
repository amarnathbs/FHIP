# A1.2 — Information Architecture

**PO-2 status: APPROVED, with the consolidation the Product Owner specified — this document is updated to the final 8-area structure below, superseding A1's original 9-area hypothesis (`A1_19` PO-2).**

## 1. Final structure: 8 canonical top-level areas, PO-2-approved order

**Order (binding):** Home, Content, Recommendations, Data Governance, Operations, Analytics, Security & Support, Administration.

This differs from A1's original starting hypothesis in two respects, both by explicit Product Owner ruling, not by A1's own later judgment:

1. **"Reference Data & Benchmarks" is not a separate top-level area.** The Product Owner's PO-2 ruling places "Benchmarks, reference data and all FDH master-data/intelligence/parser/coverage governance" together under one area, **Data Governance** — collapsing what A1 had originally proposed as two areas (a live "Reference Data & Benchmarks" area today, and a future "Financial Data Governance" area for FDH-13) into one. The area count drops from A1's original 9 (including Home) to 8.
2. **"Financial Data Governance" is renamed "Data Governance"** — dropping the FDH-specific-sounding qualifier entirely, not merely avoiding an FDH-branded name (A1's original reasoning, §1.1 below) but now explicitly instructed to be the one shared home for Benchmarks governance too.
3. **"Security, Privacy & Support" is renamed "Security & Support"** — same area, shorter label, no scope change (privacy requests, security events, consented support, and break-glass activity all remain here per PO-2's placement rules).
4. **Ordering changes:** Operations now precedes Analytics (A1's original hypothesis had Analytics before Operations); this table and every other A1 document are updated to the PO-2 order.

## 2. Validating the structure against the real 46-task inventory

All 46 tasks from `A1_01` were placed into the 8 areas. **Result: the structure holds, zero orphaned tasks, zero double-counted tasks.**

### 2.1 The FDH/"no separate nav area" resolution — now PO-confirmed, not just A1's own reasoning

"Data Governance" is **not** an FDH-branded area — it is a canonical function name (governing structured master/reference data generally) that both the already-operational Benchmarks tasks (ADM-01,02,03) and FDH-13's future master-data/parser/candidate/kill-switch/operational-monitoring/export tasks tenant together, by the Product Owner's own explicit instruction (PO-2), not merely A1's speculative "a future non-FDH domain could tenant this area" reasoning from the original hypothesis (which is now moot — Benchmarks is that second tenant, today, not hypothetically). **FDH's privacy/support and analytics capabilities are deliberately NOT placed here** — they land in the dedicated canonical Security & Support and Analytics areas instead, per PO-2's own placement rules, exactly satisfying "FDH gets no separate navigation area — its capabilities land under the relevant canonical areas" (plural: distributed across areas by function, never consolidated under one FDH-owned area, branded or not). **PO-2 is explicit: "Do not create separate FDH or Analyst navigation systems."**

### 2.2 Task-to-area placement (all 46 tasks, PO-2 order and area names)

| Area | Tasks | Status today |
|---|---|---|
| **Home** | (role-aware work queue, not a task list — see `A1_09`, PO-3-approved) | Future |
| **Content** | ADM-07,08,09,11,12,13,14,15,16,17,21 (ADM-10 reserved, not shown until A3.1 ships) | Operational (11/12 tasks); 1 not operational |
| **Recommendations** | ADM-04,05 (ADM-06 withdrawn — no nav entry, honest unavailable note only, retained only inside the task manual, not in nav) | Operational (2/3); 1 withdrawn |
| **Data Governance** | ADM-01,02,03 (Benchmarks/reference data, operational today) **+** ADM-30,31,32,33,34,35,36,40 (FDH master-data/parser/candidate/operations/export governance, all future) | Operational for the Benchmarks portion (3/3); FDH-governance portion is **all future** — that portion does not render until at least one FDH task is operational (Wave B). The area itself is visible today (Benchmarks), just not the FDH sub-content |
| **Operations** | ADM-23 (AI kill switch), ADM-10 (future, A3.1) | ADM-23 operational-no-UI today; rest future |
| **Analytics** | ADM-19 (shell today), ADM-25 (AI cost/usage, operational-no-UI), ADM-37, ADM-46 | ADM-19/25 exist without a genuinely usable UI destination today; rest future. Per PO-2: **"Do not expose Analytics until it contains a genuinely functional authorized destination"** — today's shell/no-UI state means Analytics correctly stays unexposed in nav (§3 rule 1) |
| **Security & Support** | ADM-26 (AI safety events/config audit), ADM-38,39,42,43 | ADM-26 operational-no-UI today; rest future/reserved |
| **Administration** | ADM-18,20,22,24,27,28,29,41,44,45 | ADM-18,20,22,24,27,28,29 operational (mostly no-UI); ADM-41,44,45 future |

**Coverage check:** 46 tasks placed, zero orphaned, zero double-counted (ADM-21's queue view is Content's own operational surface, not duplicated into Operations — Operations is reserved for cross-domain monitoring/emergency control and imports/processing-status/system-health/scheduled-operations per PO-2's own placement rule, not routine queue-working, which is the correct read of the brief's Admin Home hypothesis, which pulls queue *alerts* onto Home without needing a permanent Operations nav destination for content-specific queues that already have a home in Content).

## 3. Navigation rules (binding, Standard §4 restated for nav specifically, PO-2 rules folded in)

1. **Only genuinely-usable destinations are shown.** A future/reserved task (ADM-06, ADM-10, ADM-19, and all Data-Governance-FDH-portion/most-Security-&-Support/most-Analytics tasks) does not get a nav entry until its underlying capability is implemented and at least one operator can act on it. This is why the Data Governance area's FDH-governance portion renders **no nav item at all today** — not a placeholder, not a disabled link, nothing (the Benchmarks portion of Data Governance does render, since it is operational).
2. **No empty groups.** A top-level area with zero currently-visible tasks for the caller does not render as a group with nothing inside it — it is omitted entirely, exactly as `buildAdminNavGroups()` already omits Analytics today for a non-Analyst/Resource-Admin/Super-Admin caller.
3. **Hide destinations the current user cannot use — not only whole groups.** PO-2 adds this explicitly: even inside a rendered group, an individual destination the caller lacks the capability for does not render as a disabled/greyed link. This generalises rule 2 (group-level) to the destination level.
4. **No dead links.** Every rendered nav entry resolves to a route that performs real work — ADM-19/25's routes are the accepted exceptions, and neither is a "dead link" but an **honest unavailable state** (a page that exists, is reachable, and says plainly that no data exists yet — see rule 5).
5. **No fake placeholders.** Where a destination is worth mentioning as "coming" (none currently is, per rule 1's stricter bar), an honest unavailable state is used, never a fake chart or fabricated figure.
6. **Analyst never sees mutation-oriented destinations.** Enforced by capability, not by which nav group Analyst happens to appear in — restated from Standard §5.
7. **Direct-route authorization is always server-side**, regardless of nav visibility (Standard §4) — a caller who guesses `/admin/data-governance/master-data` before it exists gets a 404 (route does not exist) or, once it exists but they lack the capability, a redirect — never a rendered-but-empty page.
8. **No separate FDH or Analyst navigation systems** (PO-2, verbatim) — every FDH capability lands inside one of the 8 canonical areas by function (Data Governance, Operations, Analytics, Security & Support), never a bespoke FDH-owned tree; Analyst's destinations likewise land inside the shared Analytics area, never a parallel Analyst-only nav root (also restated in `A1_17` §2).
9. **Do not expose Analytics until it contains a genuinely functional authorized destination** (PO-2, verbatim) — a stricter, PO-affirmed version of rule 1 specifically for the Analytics area, given it is the one area every persona table (`A1_07`) shows as visible-but-empty-of-real-data today.

## 4. PO-2's final ruling on the old "General" nav group (supersedes A1's original §3 proposal)

Wave 6's Handover flagged PO5-2 ("rename the 'General' nav group, holds Benchmarks + Recommendations, describes neither") as blocked on reopening the certified Analyst Wave 1 nav contract. **A1's original proposal (superseded):** split "General" into two new top-level areas, "Recommendations" and "Reference Data & Benchmarks." **The Product Owner did not adopt that split as proposed** — PO-2 approves splitting Recommendations out as its own area (unchanged from A1's proposal), but does **not** give Benchmarks/reference data a standalone area; instead PO-2 places it inside the same Data Governance area FDH-13 governance will eventually tenant (§1 above). This is a **better resolution of PO5-2 than A1's own proposal**, not merely a different label choice: it avoids introducing a fourth Resources-adjacent-but-not-Resources area (Benchmarks) that would sit awkwardly next to the future FDH area, and instead gives structured-reference-data governance exactly one home from day one. **Not implemented by A1** — this is the target design; A2 builds it, per PO-2's approval and `A1_20`'s roadmap.

## 5. What A1 does not change

No route moves in this stage. `A1_08_MIGRATION_MAP.md` is the literal current→future mapping for every existing page and API route, updated to the same PO-2 8-area structure; this document is the *shape* the migration map moves toward.
