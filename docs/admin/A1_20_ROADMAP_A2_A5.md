# A1.4 — A2 through A5 Implementation Roadmap

None of this is implemented by A1. Each package: objective, dependencies, included/excluded tasks, likely code areas, migration likelihood, privacy risk, authorization risk, test requirements, rollback strategy, entry/exit gates.

## A2 — Canonical Shell and Navigation

**Objective:** Build the 9-area nav shell (`A1_06`) and migrate existing pages under it per `A1_08`'s disposition — a UX/routing reorganisation, not a capability change.

**Dependencies:** `A1_19` PO-2 (final labels) resolved; none of A2 depends on A1.3/A4.

**Included:** Split "General" into Recommendations + Reference Data & Benchmarks; fold Workflow/Discovery into Content as sub-groups; build Admin Home per PO-3's resolved model; split `requireAdmin()` into named capabilities for Benchmarks/Recommendations/AI Admin (`A1_02` §2 finding) — this is the one capability-model change A2 makes, and it is additive (new named capabilities that initially resolve identically to the old broad check) not access-expanding; generalise `canManageAdminRoles` (CAP-32/ADM-44) as an additive role-management surface alongside (not replacing) `resources/users/roles`.

**Excluded:** Any FDH-13 route, any canonical audit sink, any suppression engine, any support/break-glass mechanism, any Analyst Analytics metric.

**Likely code areas:** `lib/admin/adminNav.ts`, `components/ui/AppShell.tsx`, `lib/services/adminAuth.ts` (capability split), a new `app/(app)/admin/home` route, `lib/resources/permissions.ts` (no change — Resources capabilities are untouched by a nav reorganisation).

**Migration likelihood:** None required for the nav split itself (nav is application-layer only, like Analyst Wave 1). A migration is needed only if `canManageAdminRoles` needs a new table/column to track cross-domain role types — likely **not required** if it initially only wraps existing `admin_users`/`resource_user_roles` reads.

**Privacy risk:** Low — no new data class is exposed; Home's queue sources are content/dataset/proposal-level, never personal (`A1_09` §3).

**Authorization risk:** Medium — splitting `requireAdmin()` into named capabilities is exactly the kind of refactor that risks accidentally narrowing or widening access if not tested with the full 9-caller-type matrix (`A02_WAVE6_FLAT_AUTHORIZATION_REGISTER.md` §1) before and after.

**Test requirements:** Full 9-caller-type re-run against every route that changes gate shape; a DOM-level nav test (a genuinely new capability for this codebase — Wave 1 disclosed no DOM test environment exists; A2 should add one rather than continue asserting nav decisions as pure functions only); direct-URL and direct-API tests for every re-gated route.

**Rollback strategy:** Application-layer only (like Analyst Wave 1) — revert commits, no migration to unwind, provided the capability split introduces no new table.

**Entry gate:** `A1_19` PO-2 resolved. **Exit gate:** 9-area nav renders correctly for all 8 personas + role-less (`A1_07` §3), zero regressions in the 9-caller-type matrix, Admin Home shows real queue data for at least the domains named in `A1_09` §2's "exists" rows.

---

## A3 — Domain Workflow Migration, in Bounded Packages

**Objective:** Move each domain's actual page/route implementation to match the target IA, in small packages (not one big-bang migration).

**Dependencies:** A2 complete (nav shell must exist first).

**Included, per bounded package:**
- **A3.1 — Scheduled publishing** (ADM-10): build the worker/queue/scheduling control; validation rule (Wave 2) is already correct, needs no rework.
- **A3.2 — Discovery/CTA consolidation**: physically reorganise Discovery under Content per A2's nav decision (route-level, not just nav-level).
- **A3.3 — `requireAdmin()` capability split, execution**: apply the A2-designed named capabilities to the actual route gates (Benchmarks/Recommendations/AI Admin).

**Excluded:** Anything FDH-13-owned, anything analytics/suppression-owned, anything support/break-glass-owned.

**Likely code areas:** `app/(app)/admin/**`, `app/api/admin/{benchmarks,recommendations,ai}/**`.

**Migration likelihood:** A3.1 needs a new table (scheduled-job queue) — **required**. A3.2/A3.3 — **not required** (route/gate-only changes).

**Privacy risk:** Low for A3.2/3.3; A3.1 needs a check that scheduled-but-unpublished content doesn't leak through any public read path before its scheduled time (a real, checkable requirement, not a hypothetical).

**Authorization risk:** Medium for A3.3 (same reasoning as A2's split, now applied for real) — mitigated by A2 already having proven the named capabilities behave identically to the old broad gate before A3.3 flips any route to use them exclusively.

**Test requirements:** A3.1 needs a scheduled-publish fault-injection test (a job that fails partway must not leave content in an inconsistent published/unpublished state); A3.3 needs the same before/after matrix as A2.

**Rollback strategy:** A3.1's migration must be reversible (drop the queue table, revert the worker) without affecting already-published content; A3.2/3.3 are application-layer, git-revertable.

**Entry gate:** A2 exit gate met. **Exit gate:** each sub-package independently passes its own certification; A3 as a whole does not require every sub-package to ship together.

---

## A4 — Analytics, Privacy and Support Capabilities

**Objective:** Build the canonical audit sink (`A1_12`), the canonical security-event stream (`A1_12` §5), the canonical suppression engine (`A1_15`), and the support/break-glass mechanism (`A1_14`) — the four biggest genuinely-new pieces of infrastructure this whole roadmap requires.

**Dependencies:** `A1_19` PO-4 (RPC pattern), PO-5 (retention), PO-6 (consent model), PO-7 (suppression thresholds beyond minimums) all resolved before their respective sub-piece starts (each can start independently once its own PO item resolves — they do not all block each other).

**Included:**
- **A4.1 — Canonical audit sink**: new table, `correlation_id` threading, migration of the `resource_audit_log`/`resource_workflow_history` deferral (compensating-events conversion + the 4 rollback scripts rewritten, per `A1_12` §3) with the hard immutability trigger finally applied.
- **A4.2 — Canonical security-event stream**: new table, repeated-denial detection (genuinely new functionality, not a migration of anything existing), privilege-escalation-attempt distinction.
- **A4.3 — Canonical suppression engine**: the actual `SECURITY DEFINER` aggregate RPC(s) implementing Standard §7 for the first time anywhere in FHIP, plus the Recommendations Gap Review aggregate replacement (ADM-06's real successor) and ADM-46.
- **A4.4 — Support/break-glass mechanism**: the actual grant/consent/expiry/audit implementation per `A1_14`'s 9 properties.

**Excluded:** FDH-13's own domain-specific master-data workflow (Wave B/C, separate) — A4 builds the *engines*, FDH-13 waves *consume* them (per `REG-15` for suppression, and the same principle applied to audit/security/support).

**Likely code areas:** New `supabase/migrations/*` (all four sub-pieces), `lib/admin/audit/**`, `lib/admin/security/**`, `lib/admin/analytics/**`, `lib/admin/support/**` (new modules), the 4 existing rollback scripts (rewritten).

**Migration likelihood:** **Required for all four sub-pieces** — this is the migration-heaviest package in the whole roadmap.

**Privacy risk:** **Highest in the roadmap** — A4.3 is literally the first implementation of the suppression model anywhere in FHIP; a defect here is exactly the class of defect that produced the Recommendations Gap Review incident. A4.4 handles support access to sensitive data by definition.

**Authorization risk:** High for A4.4 (a new access-grant mechanism is a new attack surface almost by definition); medium for A4.1-3 (new tables need their own RLS/RPC discipline from scratch, not inherited from an existing table).

**Test requirements:** A4.3 needs the full Standard §7 adversarial suite (reconstruction via totals/subtotals, filter-combination, repeated-query/differencing, cross-metric/cross-RPC, cached-result) before it is trusted with any real cohort; A4.4 needs the full 9-property proof (`A1_14` §3) plus a negative-control proving the audit-editing/break-glass-capability exclusion is a real DB constraint, not a convention; A4.1/4.2 need the same immutability-trigger fault-injection proof `admin_transition_benchmark_source` already established (audit-insert failure rolls back the mutation).

**Rollback strategy:** Every new table needs an explicit disablement path (a feature flag or capability that can be flipped off without a schema rollback) given how privacy-sensitive A4.3/4.4 are — a "we shipped it and need to turn it off fast" scenario is a real risk category for this package specifically, more than any other in the roadmap.

**Entry gate:** Each sub-piece's own PO item resolved. **Exit gate:** A4.3 passes the full adversarial suppression suite; A4.4 passes the 9-property proof; A4.1/4.2 pass fault-injection; FDH-13 Wave E (if authorised) successfully consumes A4.3 without building its own suppression logic (a real, checkable integration test, not an assertion).

---

## A5 — Final Consolidation and Release Certification

**Objective:** One consolidated certification pass (in the same spirit as Admin A0.2 Wave 6) over everything A2–A4 shipped, plus whatever FDH-13/Analyst Analytics waves ran concurrently, before any of it is presented as "canonical Admin architecture, complete."

**Dependencies:** A2, A3 (at least its authorised sub-packages), and A4 all merged.

**Included:** Full task-catalogue reconciliation (every one of the 46 `A1_01` tasks re-confirmed against real code, not carried figures); full 9-caller-type authorization re-verification; full persona walkthrough re-run live (not source-only, unlike this stage's own Wave-6-style constraints where credentials are unavailable); FDH-13 traceability re-score (this is the first point at which FDH-13 rows may legitimately move from MISSING/PARTIAL to IMPLEMENTED, if the relevant waves shipped); Analyst Analytics integration contract re-confirmed.

**Excluded:** Starting any new capability work — A5 is a certification pass, not a development package.

**Likely code areas:** None (a certification pass produces reports, not code) — except fixing anything the certification finds, per the same "fix only what's necessary to preserve the security boundary, else defer" rule as everywhere else in this program (Standard §14).

**Migration likelihood:** None, unless certification finds a defect requiring one.

**Privacy risk / Authorization risk:** Certification-dependent — this package's entire purpose is to surface and rate whatever risk remains, not introduce new risk.

**Test requirements:** Live-DEV, not source-only — this is the one package in the roadmap that should not accept a Wave-6-style "evidence-tier limitation" as a final answer, since it is the terminal release gate.

**Rollback strategy:** N/A (certification, not implementation) — though a FAIL verdict here should trigger rollback of whichever specific A2-A4 piece failed, not the whole program.

**Entry gate:** A2/A3/A4 merged. **Exit gate:** FULL PASS per the same verdict bar the original A1 dispatch defines (`A1_21` §Verdict) — every task has a disposition, no duplicate system, Analyst still read-only, Super Admin still not a privacy exemption, audit and mutation still atomic together, every material decision resolved or explicitly re-flagged.

---

## Cross-package sequencing note (resolves `A1_19` PO-8's concrete example)

A2 → (A3 and A4.1/4.2 may start concurrently once A2 ships, since neither depends on the other) → A4.3/4.4 (need A4.1's audit sink to log into) → A5. FDH-13 Wave A may start any time after A2's capability-split precedent exists (it needs a working example of the named-capability pattern, not A4's engines specifically) but **FDH-13 Wave E must wait for A4.3** unless explicitly authorised to build it instead, per `REG-15`.
