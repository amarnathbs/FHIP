# A1.1 — Canonical Role Model and FDH-13 Role-Fit Assessment

**PO-1 status: DEFERRED.** The Product Owner has not approved or rejected any of the three candidates in §2 — a decision is pending the exact role names, capability bundles, and A1's own per-candidate recommendation, all surfaced verbatim in §2 below (`A1_19` PO-1). **Until PO-1 resolves, this document's continued use of "Super Admin (interim)" throughout §1's table and §2's candidate analysis names a temporary allocation, never a proposed permanent role** — no capability currently resolving to Super Admin (interim) should be read as "settled to stay with Super Admin," only as "not yet moved to a role that does not exist yet."

## 1. The canonical role model, as implemented today

Two mechanisms, confirmed by direct source read (Admin A0.2 Wave 6, re-confirmed for this stage):

1. **`resource_user_roles`** (migration `0049`) — a 6-value CHECK constraint: `role in ('resource_admin', 'author', 'editor', 'compliance_reviewer', 'publisher', 'analyst')`.
2. **`admin_users`** table membership — confers the 7th role, **Super Admin**, checked via `requireAdmin()` (route/API layer) and `getCurrentResourceRoles().isSuperAdmin` (capability layer). Super Admin is not a `resource_user_roles` row; it is a separate table, and every capability predicate short-circuits `current.isSuperAdmin || ...`.

| Role | Table | Scope today | Read-only? |
|---|---|---|---|
| Analyst | `resource_user_roles` | Resources analytics shell only (CAP-05) | **Yes — binding, Standard §5** |
| Author | `resource_user_roles` | Content creation | No |
| Editor | `resource_user_roles` | Content creation, review, FAQ/Discovery management | No |
| Compliance Reviewer | `resource_user_roles` | Compliance-approve content | No |
| Publisher | `resource_user_roles` | Publish content | No |
| Resource Admin | `resource_user_roles` | Full Resources CRUD + role assignment | No |
| Super Admin | `admin_users` | Everything not gated by a Resources-specific predicate — Benchmarks, Recommendations, AI Admin, role assignment | No |

**Composition rule (Standard §3, verified in code):** every predicate tests role membership, so a multi-role holder receives the **union**. `CONTENT_WORKFLOW_ROLES` deliberately excludes `analyst`; `SPECIALIST_CREATE_ROLES`/`DISCOVERY_MANAGE_ROLES` are narrower still. No role automatically inherits another's authority except Super Admin's own explicit, separate check at every gate — and even that is not a hierarchy in the Standard §3 sense (it is 7 independent gates that happen to all include an `isSuperAdmin` clause, not one gate that implies the other 6).

**Binding constraints, verified never violated in the current tree:**
- Analyst holds zero raw personal-financial-data access and zero mutation/approval capability (`CONTENT_WORKFLOW_ROLES`, `SPECIALIST_CREATE_ROLES`, `DISCOVERY_MANAGE_ROLES` all exclude it; confirmed by direct source read, Wave 6 §5/§6).
- Role-less authenticated users receive zero Admin capability (`getCurrentResourceRoles()` fail-closed default; `NO_ADMIN_CAPABILITIES` frozen all-false nav default).
- No FDH-specific role, `isFdhAdmin`, or separate FDH authentication path exists anywhere (repo-wide grep, zero matches beyond 2 known negative controls).
- No automatic role hierarchy exists beyond Super Admin's own per-gate check, and no change to that has been proposed by A1.

## 2. FDH-13's three proposed domain-neutral role candidates — tested against the full task inventory

Source: `FHIP_FDH13_Governance_Capability_Model.md` §3 (`D:/fhip-fdh13-admin-baseline`), unmerged, `docs/fdh13-admin-integration-baseline` @ `9fdce5d`. **None of the three is created, granted, coded, or implemented by A1.** This section is the A1.1-required test of each against the full 46-task catalogue (`A1_01`), not a re-derivation of the FDH-13 baseline's own reasoning.

### 2.1 `Data Governance Contributor`

- **Would cover:** CAP-19 (`canViewFdhMasterData`), CAP-20 (`canProposeFdhMasterData`), CAP-21 (`canReviewFdhMasterData`), CAP-25 (`canViewFdhOperations`), possibly CAP-23 (`canManageFdhParsers`, pending REG-06).
- **Tested against the 46-task catalogue:** touches only ADM-30, 31, 32, 34, 36 — all Data Governance area tasks (the FDH-governance portion, per PO-2's consolidation, `A1_06`), all currently unimplemented. No overlap with any Resources, Benchmarks, Recommendations, or AI Admin task. No conflict found with any existing role's charter.
- **Reusability test (required before any new role, per the binding PO ruling):** the propose→review shape is structurally identical to Investment Intelligence's `ii_review_items.superseded_by_id` pattern and to a plausible future Benchmarks-catalogue revision workflow — genuinely domain-neutral, not an FDH-specific name in substance.
- **Least-privilege test:** must never inherit Analyst's aggregate-analytics scope (different risk tier — raw reference-level detail vs. suppressed aggregate) or any Resources editorial capability.
- **Recommendation: APPROVE-IN-PRINCIPLE, subject to Product Owner decision.** The role is domain-neutral, fills a genuine gap (no existing role safely covers "propose/review structured reference data without terminal approval authority"), and is not required for any Wave A precondition. **A1 does not create it** — flagged in `A1_19` (PO-1) for explicit approval before FDH-13 Wave B.

### 2.2 `Data Governance Approver`

- **Would cover:** CAP-22 (`canApproveFdhMasterData`), possibly CAP-29 (`canExportFdhGovernanceData`, pending REG-04).
- **Tested against the 46-task catalogue:** touches only ADM-33, 40. Terminal approval authority; must never be inferred from Resources' `publisher`/`compliance_reviewer` (those approve *content*, not financial master data — a substance distinction, restated from the FDH-13 baseline and independently re-confirmed here: no task in the Content & Publishing area (§1 of `A1_01`) shares a data-sensitivity classification with ADM-33).
- **Segregation-of-duty test (REG-01, already resolved by binding PO ruling):** a person may hold both Contributor- and Approver-shaped access, but may not approve, activate, merge, retire, or roll back a proposal they personally created — enforced per-record inside the authoritative database transaction, never by role exclusivity alone. This is consistent with the A1.1 SoD requirement for "FDH master-data proposals vs. approvals" (`A1_05`).
- **Recommendation: APPROVE-IN-PRINCIPLE, subject to Product Owner decision.** Same reusability logic as §2.1 (parser certification, a future Benchmarks/Recommendations approval gate). Not required for Wave A. Flagged in `A1_19` (PO-1).

### 2.3 `Support Access Grantee`

- **Would cover:** CAP-27 (`canAccessFdhSupportData`), and — held even more narrowly — CAP-28 (`canUseFdhBreakGlassAccess`).
- **Tested against the 46-task catalogue:** touches ADM-38, 39, and the cross-cutting ADM-43 (general support/break-glass, `A1_14`) — this is the **one candidate whose evidence of necessity is explicitly cross-domain already**, not merely a future possibility: Investment Intelligence's raw CAS-statement documents (R2) are "a structurally identical sensitivity class" to FDH's raw bank statements, and `adminBoundary.ts`'s own comment anticipates "a future temporary support-access mechanism" in domain-neutral language.
- **Least-privilege test:** must never be inferred from any other role or capability; must never combine with any capability that can edit or delete an audit record (structural DB-level guarantee, not a role-assignment convention — binding PO ruling, restated).
- **Recommendation: APPROVE-IN-PRINCIPLE FOR THE ROLE SHAPE, DEFER ACTUAL CREATION TO WAVE F / A4.** This candidate is the most clearly justified of the three on reusability grounds, but its capabilities (CAP-27/28) are **not designed yet** (Wave F's own first deliverable) — creating the role before the access model it holds exists would be premature. Flagged in `A1_19` (PO-1) as approve-the-shape-now, create-the-grant-later.

### 2.4 A fourth, lower-confidence candidate noted for completeness

`Operational Emergency Control` (for CAP-24, `canOperateFdhKillSwitch`) is named in the FDH-13 baseline as a possible future role that would also fix Module 11.1's own pre-existing kill-switch gap (currently gated only by the broad `requireAdmin()`, not a distinct role — see `A1_02` §2's CAP-16 finding). **Not recommended for creation now** — it would touch already-shipped Module 11 code outside this stage's authority, and no task inventory pressure requires it before FDH-13 Wave D. Recorded, not proposed, per this document's own discipline against silently expanding the candidate list.

## 3. Why none of the three is a Wave-A dependency

Every capability in the FDH-13 model resolves today via **Super Admin (interim)** — the same fallback every other currently-unassigned Admin capability in this codebase already uses (CAP-16 covers Benchmarks/Recommendations/AI Admin the same way). Creating any of the three candidates is a separate, later Product Owner decision (`REG-16`), never a prerequisite for FDH-13 Wave A, which builds only the capability-resolution and audit-sink foundation and touches no proposal-approval RPC at all.

## 4. Summary table for the Product Owner

| Candidate | Recommendation | Blocking anything now? | Owner decision |
|---|---|---|---|
| Data Governance Contributor | Approve-in-principle | No | `A1_19` PO-1 |
| Data Governance Approver | Approve-in-principle | No | `A1_19` PO-1 |
| Support Access Grantee | Approve-the-shape, defer the grant mechanism to Wave F/A4 | No | `A1_19` PO-1 |
| Operational Emergency Control (unnamed 4th) | Not recommended for creation now | No | Noted only |

**A1 creates none of these roles.** This document exists so Wave A (or A2, if the canonical role-assignment task ADM-44 lands first) inherits a reviewed recommendation rather than an invented one under implementation pressure.
