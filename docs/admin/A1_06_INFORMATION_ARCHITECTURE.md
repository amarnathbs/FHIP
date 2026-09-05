# A1.2 — Information Architecture

## 1. Validating the starting hypothesis against the real 46-task inventory

The dispatch's starting hypothesis — Home / Content / Recommendations / Reference Data & Benchmarks / Financial Data Governance / Analytics / Operations / Security-Privacy-Support / Administration — was tested by placing all 46 tasks from `A1_01` into it. **Result: the hypothesis holds, with one clarifying rule adopted before it is treated as final.**

### 1.1 The FDH/"no separate nav area" resolution

"Financial Data Governance" is **not** an FDH-branded area — it is a canonical function name (governing structured master/reference data generally) that FDH-13's master-data/parser/candidate/kill-switch/operational-monitoring/export tasks happen to be the first tenant of. This is the same reasoning the FDH-13 baseline itself used to justify the `Data Governance Contributor`/`Data Governance Approver` role candidates as domain-neutral (`A1_03` §2) — a future non-FDH structured-reference-data domain (e.g. a Benchmarks catalogue revision workflow) could tenant the same area without renaming it. **FDH's privacy/support and analytics capabilities are deliberately NOT placed here** — they land in the dedicated canonical Security-Privacy-Support and Analytics areas instead, exactly satisfying the brief's "FDH gets no separate navigation area — its capabilities land under the relevant canonical areas" (plural: distributed across areas by function, not consolidated under one FDH-owned area, branded or not).

### 1.2 Task-to-area placement (all 46 tasks)

| Area | Tasks | Status today |
|---|---|---|
| **Home** | (role-aware queue, not a task list — see `A1_09`) | Future |
| **Content** | ADM-07,08,09,11,12,13,14,15,16,17,21 (ADM-10 reserved, not shown until A3.1 ships) | Operational (11/12 tasks); 1 not operational |
| **Recommendations** | ADM-04,05 (ADM-06 withdrawn — no nav entry, honest unavailable note only, retained only inside the task manual, not in nav) | Operational (2/3); 1 withdrawn |
| **Reference Data & Benchmarks** | ADM-01,02,03 | Operational |
| **Financial Data Governance** | ADM-30,31,32,33,34,35,36,40 | **All future** — area does not render until at least one task is operational (Wave B) |
| **Analytics** | ADM-19 (shell today), ADM-37, ADM-46, ADM-25 (AI cost/usage) | ADM-19 shell only; rest future |
| **Operations** | ADM-23 (AI kill switch), ADM-10 (future, A3.1) | ADM-23 operational-no-UI today; rest future |
| **Security, Privacy & Support** | ADM-26 (AI safety events/config audit), ADM-38,39,42,43 | ADM-26 operational-no-UI today; rest future/reserved |
| **Administration** | ADM-18,20,22,24,27,28,29,41,44,45 | ADM-18,20,22,24,27,28,29 operational (mostly no-UI); ADM-41,44,45 future |

**Coverage check:** 46 tasks placed, zero orphaned, zero double-counted (ADM-21's queue view is Content's own operational surface, not duplicated into Operations — Operations is reserved for cross-domain monitoring/emergency control, not routine queue-working, which is the correct read of the brief's Admin Home hypothesis, which pulls queue *alerts* onto Home without needing a permanent Operations nav destination for content-specific queues that already have a home in Content).

## 2. Navigation rules (binding, Standard §4 restated for nav specifically)

1. **Only genuinely-usable destinations are shown.** A future/reserved task (ADM-06, ADM-10, ADM-19, and all Financial-Data-Governance/most-Security-Privacy-Support/most-Analytics tasks) does not get a nav entry until its underlying capability is implemented and at least one operator can act on it. This is why Financial Data Governance renders **no nav item at all today** — not a placeholder, not a disabled link, nothing.
2. **No empty groups.** A top-level area with zero currently-visible tasks for the caller does not render as a group with nothing inside it — it is omitted entirely, exactly as `buildAdminNavGroups()` already omits Analytics today for a non-Analyst/Resource-Admin/Super-Admin caller.
3. **No dead links.** Every rendered nav entry resolves to a route that performs real work — ADM-19's route is the one accepted exception, and it is not a "dead link" but an **honest unavailable state** (a page that exists, is reachable, and says plainly that no data exists yet — see rule 4).
4. **No fake placeholders.** Where a destination is worth mentioning as "coming" (none currently is, per rule 1's stricter bar), an honest unavailable state is used, never a fake chart or fabricated figure.
5. **Analyst never sees mutation-oriented destinations.** Enforced by capability, not by which nav group Analyst happens to appear in — restated from Standard §5.
6. **Direct-route authorization is always server-side**, regardless of nav visibility (Standard §4) — a caller who guesses `/admin/fdh/master-data` before it exists gets a 404 (route does not exist) or, once it exists but they lack the capability, a redirect — never a rendered-but-empty page.

## 3. Resolving PO5-2 (the "General" nav group)

Wave 6's Handover flagged PO5-2 ("rename the 'General' nav group, holds Benchmarks + Recommendations, describes neither") as blocked on reopening the certified Analyst Wave 1 nav contract. **A1's resolution: split it.** Recommendations and Reference Data & Benchmarks become two separate top-level areas (§1.2), each named for what it actually is, rather than one renamed catch-all. This is the natural consequence of moving from a Resources-centric nav (today's actual code) to a task-based canonical nav (A1's own mandate) — it is not a narrower fix bolted onto the old shape. **Not implemented by A1** — this is the target design; A2 builds it. Flagged for final-label sign-off in `A1_19` (PO-2), since the brief requires final nav labels to be a PO decision.

## 4. What A1 does not change

No route moves in this stage. `A1_08_MIGRATION_MAP.md` is the literal current→future mapping for every existing page and API route; this document is the *shape* the migration map moves toward.
