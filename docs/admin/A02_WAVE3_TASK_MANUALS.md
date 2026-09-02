# Admin A0.2 Wave 3 — Task Index and Operator Manuals

**Status:** Initial current-state manuals, per this Wave's own mandate. A0.2 Wave 5 will validate and standardise them; a later canonical redesign phase will update them again for the final Admin. **Nothing below describes a placeholder as operational** — PLC-1 (Analytics) is explicitly marked non-operational in its own entry.

Each task below carries a stable identifier (`ADM-nn`) for the central index. "Last certification phase" cites the Wave that most recently verified the task; where this Wave (3) verified it fresh, that is stated explicitly.

---

## Central task index

| ID | Task | Capability | Status | Last certified |
|---|---|---|---|---|
| ADM-01 | Manage Benchmark Sources (propose/approve/suspend/reinstate) | `isAdmin` | Operational | **Wave 3** |
| ADM-02 | Manage Benchmark Datasets (validate/activate/retire) | `isAdmin` | Operational | **Wave 3** (validate is new) |
| ADM-03 | View Benchmark Cohorts/Values/Target-Ranges/Update-Runs | `isAdmin` | Operational (read-only) | Pre-existing, re-confirmed Wave 3 |
| ADM-04 | Manage Recommendations (create/edit/activate) | `isAdmin` | Operational | Wave 1/1B |
| ADM-05 | Bulk-import Recommendation Conditions | `isAdmin` | Operational | Wave 1 |
| ADM-06 | View Recommendation Coverage Gaps | `isAdmin` | Operational | Wave 1 |
| ADM-07 | Resources Admin Dashboard | `resourcesDashboard` | Operational | R1.2 |
| ADM-08 | Create/Edit Article, Guide or FHIP Explainer | `resourceContentAdmin` | Operational | R1.3 |
| ADM-09 | Content Workflow (Submit/Approve/Publish/Archive) | `resourceWorkflowAdmin` | Operational | R1.3/Wave 2 |
| ADM-10 | Schedule Content for Future Publication | `resourceWorkflowAdmin` | **Not operational — see status note** | Wave 2 (validation only) |
| ADM-11 | Create/Edit Video | `resourceContentAdmin` | Operational | R1.4 |
| ADM-12 | Create/Edit Glossary Definition | `resourceContentAdmin` | Operational | R1.4 |
| ADM-13 | Create/Edit Money Update (incl. from template) | `resourceContentAdmin` | Operational | R1.4 |
| ADM-14 | Create/Edit FAQ (incl. linking to related content) | `resourceContentAdmin` | Operational | R1.4 |
| ADM-15 | Create/Edit Call-to-Action (CTA) | `resourceDiscoveryAdmin` | Operational | R1.5/1.6 |
| ADM-16 | Manage Related Content (add/reorder/remove) | `resourceDiscoveryAdmin` | Operational | Wave 2 |
| ADM-17 | Manage Context Mapping ("What does this mean?" links) | `resourceDiscoveryAdmin` | Operational | R1.6 |
| ADM-18 | Manage Resources Users & Roles (assign/revoke) | Super Admin (write) / `isResourceStaff` (read) | Operational | R1.2 |
| ADM-19 | View Resources Analytics | `resourceAnalytics` | **Shell only, hidden from normal navigation — see status note** | Analyst Wave 1; nav visibility updated Wave 3 closure round |
| ADM-20 | View Admin Capabilities (`/api/admin/me`) | none (self-resolution) | Operational | Analyst Wave 1 |

Tasks **not** in this index because they have no discoverable Admin entry point today (BACKEND_WITHOUT_UI, deferred — see the Discovery register): the 17-route AI Admin surface. Per this Wave's own rule, a task manual is not written for a surface that isn't reachable — writing one would itself misrepresent it as operational. (`GET /api/admin/resources/glossary/terms`, previously listed here, was removed in the closure round as a confirmed duplicate of the Glossary editor's own Related Terms picker — see the Certification Report §2.4 — so there is no longer a surface here to document at all.)

---

## ADM-01 — Approve, Suspend or Reinstate a Benchmark Source

1. **Purpose.** Move a benchmark source through its governance lifecycle (`draft`/`under_review` → `approved` → `suspended` → reinstated) so datasets that cite it can pass activation validation.
2. **Eligible role/capability.** Super Admin only (`isAdmin`, `admin_users` membership).
3. **Prerequisites.** The source row must already exist (created via the "add source" inline form on the same tab).
4. **Navigation path.** Admin menu → General → Benchmarks → **Sources** tab.
5. **Procedure.**
   - Draft/under-review source: click **Approve**.
   - Approved/active source: click **Suspend** (confirmation dialog shown — this can break dataset validation for anything citing it).
   - Suspended source: click **Reinstate** (returns it to `approved`).
6. **Required fields.** None beyond the existing row — this action only changes `status` (and, on approval, sets `approved_by`/`approved_at` from the caller's own session).
7. **Validation rules.** `status` must be one of `draft, under_review, approved, active, superseded, suspended, archived` (enforced server-side; invalid values are rejected with 422, never silently coerced).
8. **Success confirmation.** The Sources table reloads from the server; the row's Status column reflects the new value.
9. **Common errors.** "Could not update source" (network/server error, shown via `alert()`) — no partial state is left; retry is safe. **(Wave 4)** Acting on a source that no longer exists now returns a clean, explicit 404 ("Benchmark source not found.") instead of a raw database error string mapped to a generic 400 — distinguishable from a validation failure (422) or a permission denial (403).
10. **Recovery.** Re-run the action; it is idempotent (re-approving an already-approved source is a no-op write — and, per **(Wave 4)** below, a true no-op: resubmitting the same status writes no additional audit row either).
11. **Audit evidence.** `approved_by`/`approved_at` columns on the row itself remain the record for approval specifically. **(Wave 4 — supersedes Wave 3's "no separate audit-log row" note above, which was a real gap, not a design choice):** every genuine status **transition** (approve/suspend/reinstate — i.e. `status` actually changes) now additionally inserts a `benchmark_update_runs` row (`source_id`, `previous_version`/`new_version` carrying the old/new status text, `audit_user` = the trusted actor from `requireAdmin()`, migration `0125`), mirroring the sibling Dataset lifecycle's own long-standing audit trail (ADM-02). Re-classified from `NOT_AUDITED_NOT_REQUIRED` to `AUDITED_COMPLETE`. Editing a non-status field (e.g. methodology notes) or resubmitting the same status still writes no audit row — neither is a lifecycle event. An audit-log write failure does not fail the underlying status change (it is logged server-side and the response still reflects the already-committed update).
12. **Rollback/reversal.** Suspend → Reinstate reverses a suspension. There is no automated way to return an `approved` source to `draft`; that would require a direct database action (not exposed in Admin by design — approval is meant to be forward-moving except for the suspend/reinstate safety valve). **(Wave 4)** The new audit rows do not yet record a `supersedes`/`reverses` link back to the event they undo (e.g. a Reinstate's row does not point back at the Suspend row it reverses) — a named residual for the future canonical audit design (see the Wave 4 report §8), not implemented this round.
13. **Jurisdiction/privacy cautions.** None — this table holds no personal or financial data, only citation metadata for published benchmark figures.
14. **Related task / next step.** ADM-02 (a dataset citing this source can only activate once the source is `approved` or `active`).
15. **Functionality status.** Operational, connected Wave 3; audit-evidence gap closed Wave 4 (not yet live-DEV-verified — see the Wave 4 report's Gate G1).
16. **Last certification phase/date.** Wave 3, 2026-09-01. **Audit evidence updated Wave 4, 2026-09-02 (docs/admin/A02_WAVE4_AUTHORIZATION_AUDIT_RESULTSTATE_REPORT.md) — CONDITIONAL, pending live-DEV verification.**

## ADM-02 — Validate, Activate or Retire a Benchmark Dataset

1. **Purpose.** Move a dataset from draft data into the live benchmark figures the product serves, with a pre-flight check of the same rule the commit step enforces.
2. **Eligible role/capability.** Super Admin only (`isAdmin`).
3. **Prerequisites.** The dataset's linked source should be `approved` or `active` (ADM-01); at least one `benchmark_values` row must exist for market/regulatory-class datasets.
4. **Navigation path.** Admin menu → General → Benchmarks → **Datasets** tab.
5. **Procedure.** Click **Validate** to preview readiness (no data changes). Click **Activate** to commit (sets `data_status='active'`, a 1-year `review_due_at`). Click **Retire** on an active dataset (confirmation dialog shown) to take it out of service.
6. **Required fields.** None beyond the existing row.
7. **Validation rules.** Source must be linked and not `draft`/`suspended`/`archived`; source citation and period must be present; dataset's own `source_period`/`geography_level`/`statistic_coverage` must be present; market/regulatory-class datasets need at least one recorded value.
8. **Success confirmation.** Validate shows a plain-language pass/fail dialog listing every failing rule. Activate/Retire reload the Datasets table from the server; the Status column and Actions button (Activate ↔ Retire) reflect the committed state.
9. **Common errors.** "Cannot activate: <specific reasons>" (422) — nothing is changed on a rejected activation; a `benchmark_update_runs` row records the rejection with the exact validation result.
10. **Recovery.** Fix the underlying Source/Dataset/Values data (outside this UI, via the Sources tab or direct data entry), then Validate again.
11. **Audit evidence.** `benchmark_update_runs` gets one row per Activate attempt (approved or rejected), including the full validation result — `AUDITED_COMPLETE`. Validate (preview) itself writes nothing — `NOT_AUDITED_NOT_REQUIRED` (no state change to audit).
12. **Rollback/reversal.** Retire reverses Activate. There is no "un-retire" button; reactivating requires clicking Activate again (which re-validates from scratch).
13. **Jurisdiction/privacy cautions.** None.
14. **Related task / next step.** ADM-01 if validation fails on the source; ADM-03 to see the resulting values feeding the failing check.
15. **Functionality status.** Operational; Validate is new this Wave, Activate/Retire pre-existing and unchanged.
16. **Last certification phase/date.** Wave 3, 2026-09-01 (Validate); pre-existing (Activate/Retire).

## ADM-03 — View Benchmark Cohorts, Observed Values, Planning Target Ranges, Update/Audit Log

1. **Purpose.** Read-only inspection of the reference data underlying Benchmarks (no write action on these four tabs).
2. **Eligible role/capability.** Super Admin only (`isAdmin`).
3. **Prerequisites.** None.
4. **Navigation path.** Admin menu → General → Benchmarks → Cohorts / Observed Values / Planning Target Ranges / Update / Audit Log tabs.
5. **Procedure.** Click the tab; the table loads automatically.
6-9. Not applicable — read-only.
10. **Common errors.** "Admin access required" if the session's admin flag has expired — sign in again.
11. **Recovery.** Reload the tab.
12. **Audit evidence.** N/A — no mutation.
13. **Rollback.** N/A.
14. **Jurisdiction/privacy cautions.** None — aggregate reference data only, no personal records.
15. **Related task.** ADM-02 (Update/Audit Log shows the exact history Activate/Retire produce).
16. **Functionality status.** Operational.
17. **Last certification phase/date.** Pre-existing, re-confirmed reachable this Wave.

## ADM-04 through ADM-18

These 15 tasks (Recommendations management, the full Resources content-type CRUD set, Related Content, Context Mapping, and Users & Roles) were not modified by Wave 3 and remain exactly as certified by their own owning Wave (cited in the index table above). Per this Wave's own instruction not to reopen certified work without a direct regression, and per the "no hidden scope expansion" principle, this Wave does not re-author their manuals from zero — each is already documented in its own Wave's completion report, cross-referenced here so the central index is complete. **This is a disclosed scoping decision**, not an omission: reproducing 15 already-accurate manuals verbatim would not improve their accuracy, and this Wave's incremental budget is better spent verifying and completing the surfaces that were actually broken. A0.2 Wave 5 (per the programme schedule) is the phase explicitly named for standardising every manual into one consistent format — this Wave defers that formatting pass rather than duplicating it early.

## ADM-19 — View Resources Analytics (status: shell only, not operational, hidden from normal navigation)

1. **Purpose.** Intended future home for Resources usage/engagement analytics.
2. **Eligible role/capability.** `resourceAnalytics` (Analyst, Resource Admin, Super Admin).
3. **Prerequisites.** None.
4. **Navigation path.** **No longer in normal navigation as of the Wave 3 closure round** (Product Owner ruling: a destination that completes no task should not be a clickable nav item). Reachable only by direct URL (`/admin/resources/analytics`) for a caller who holds the capability. An Analyst-only caller (whose only capability is `resourceAnalytics`, and who would otherwise see zero Admin destinations) instead sees a fixed, non-interactive note in the Admin menu: *"Admin analytics access is confirmed for your account. No analytics features are available yet."*
5. **Procedure.** Opening the page (by direct URL) shows a title and one sentence stating this is a read-only area with no analytics yet.
6-10. **Not applicable — there is no metric, chart, filter, export or control on this page.** No figure of any kind is rendered (tested by Wave 1's own assertion that the page contains no digit).
11. **Audit evidence.** None — no data is read or written beyond the access-gate check itself.
12. **Rollback.** N/A.
13. **Jurisdiction/privacy cautions.** None yet — no data surfaced.
14. **Related task / next step.** None yet.
15. **Functionality status.** **Not operational.** This is the one visible destination in the entire Admin surface that does not complete a task, by explicit design (Wave 1) and disclosed tension (see Discovery register PLC-1) rather than by omission.
16. **Last certification phase/date.** Analyst Wave 1 (shell certified); re-confirmed unchanged Wave 3.

## ADM-20 — Admin Capability Resolution (`/api/admin/me`)

1. **Purpose.** Not a task an administrator performs directly — the shared endpoint every Admin page and the nav itself calls to resolve "what can this caller do."
2. **Eligible role/capability.** None — callable by any authenticated (or anonymous) session; always returns `200` with an honest, all-`false` capability set for a caller with none.
3-9. Not applicable (no user-facing procedure).
10. **Common errors.** None documented — fails closed to all-`false` capabilities on any parse failure, per Wave 1's own contract.
11. **Audit evidence.** None required — a read-only capability check.
12. **Rollback.** N/A.
13. **Jurisdiction/privacy cautions.** None.
14. **Related task.** Underlies every other task's step 1-2 (capability check, nav visibility).
15. **Functionality status.** Operational.
16. **Last certification phase/date.** Analyst Wave 1.

---

## Contextual Help linkage

No in-app "Help" affordance currently links out to any manual (searched `components/ui/AppShell.tsx` and the Admin layout for a help/documentation link — none exists). Adding one is a UI-affordance change beyond a discovery-and-completion Wave's bounded mandate and is recorded as a deferred finding (see the Certification Report's Deferred register) rather than added here.
