# A1.1 — Canonical Task Catalogue

**Stage:** Admin A1 — Canonical Admin Architecture and Task-Based Information Architecture
**Status:** Architecture/documentation only. No route moved, no role created, no migration written.
**Governing standard:** `FHIP_ADMIN_ARCHITECTURE_STANDARD.md` v1.0 (binding on every task below).
**Baseline:** `origin/main` @ `21839a8`; Admin A0.2 Wave 6 consolidated inventory (unmerged, `docs/admin/A02_WAVE6_*` in worktree `agent-a490a0668360b4385`); FDH-13 integration baseline (unmerged, `docs/fdh13-admin-integration-baseline` @ `9fdce5d`); Analyst Analytics Wave 1 (unmerged, `feature/analyst-analytics-wave1-access`).

Every current and planned Admin function is named here as an **operator task** — a named thing a person does, in operator language, never a raw table or route name. `ADM-01` through `ADM-21` are the existing task IDs certified through Admin A0.2 Wave 6 and are **not renumbered** here (renumbering a certified ID would break every manual, help-registry entry, and certification report that cites it). New tasks continue the same flat `ADM-nn` sequence rather than starting a second scheme.

## 0. How to read this catalogue

Each task carries the fields the A1 dispatch requires. For the 21 tasks already certified through Wave 5/6, the full 24-field manual is authoritative and unchanged — this catalogue adds only the four fields those manuals do not carry (**Canonical Area**, **Required Capability** by its canonical name, **Future Stage**, and a restated **Mutation Authority**/**Audit Requirement**/**Privacy Classification** triple so every task in the whole platform, present and future, can be read from one table). For new tasks (AI Admin, FDH-13, and cross-cutting canonical tasks), this catalogue is itself the primary record — a fuller narrative for each group follows the summary table, and each remains explicitly a **design proposal**, not an implementation, until its own future stage is authorised.

**Field key** (15 fields per the A1 dispatch): Task name · Operator goal · Trigger · Prerequisite · Eligible roles · Required capability · Workflow · Review/approval steps · Mutation authority · Audit requirement · Privacy classification · Success/failure paths · Manual requirement · Current status · Future stage.

---

## 1. Content & Publishing (existing — Resources domain)

| ID | Task | Eligible roles | Capability | Mutation authority | Audit | Privacy | Status | Manual |
|---|---|---|---|---|---|---|---|---|
| ADM-07 | Use the Resources dashboard | Content-workflow staff, Resource Admin, Super Admin | `canViewResourceDashboard` | Read-only | N/A | Public operational | Operational | Wave 5 manual, complete |
| ADM-08 | Create/edit article/guide/explainer | Author, Editor, Resource Admin, Super Admin | `canCreateResource`/`isResourceStaff` | Direct write, service-role backed | `AUDIT_NOT_REQUIRED` (draft-level edit; publication is audited via ADM-09) | Internal non-personal | Operational | Wave 5 manual, complete |
| ADM-09 | Move content through publishing workflow | Author→Editor→Compliance Reviewer→Publisher chain, Resource Admin, Super Admin | workflow-state predicate, RPC-internal | **Pattern A RPC** `transition_resource_post_status` | `AUDITED_COMPLETE` (same-transaction `resource_workflow_history`+`resource_audit_log`) | Internal non-personal | Operational | Wave 5 manual, complete |
| ADM-11 | Add/edit a video | Author/Editor/Resource Admin/Super Admin | `canCreateSpecialistContent`/`isResourceStaff` | Direct write | `AUDIT_NOT_REQUIRED` | Internal | Operational | Wave 5 manual, complete |
| ADM-12 | Create/edit a glossary definition | same | same | Direct write | `AUDIT_NOT_REQUIRED` | Internal | Operational | Wave 5 manual, complete |
| ADM-13 | Create/edit a money update | same | same | Direct write | `AUDIT_NOT_REQUIRED` | Internal | Operational | Wave 5 manual, complete |
| ADM-14 | Create/edit/delete an FAQ | Resource Admin/Editor (`canManageFaqs`) | `canManageFaqs` | Direct write; DELETE blocked if linked | `AUDIT_NOT_REQUIRED` | Internal | Operational | Wave 5 manual, complete |
| ADM-15 | Create/edit/activate/deactivate a CTA | `canManageDiscovery` roles | `canManageDiscovery` | Direct write | `AUDIT_NOT_REQUIRED` | Internal | Operational | Wave 5 manual, complete |
| ADM-16 | Curate related content | `canManageDiscovery` roles | `canManageDiscovery` | **Pattern A RPC** `admin_reorder_related_content` (reorder); direct write (add/remove) | `AUDITED_COMPLETE` (reorder, implicit in ordering); `AUDIT_NOT_REQUIRED` (add/remove) | Internal | Operational | Wave 5 manual, complete |
| ADM-17 | Map a resource to an in-product context | `canManageDiscovery` roles | `canManageDiscovery` | Direct write | `AUDIT_NOT_REQUIRED` | Internal | Operational | Wave 5 manual, complete |
| ADM-21 | Work a content queue (drafts/review/scheduled/published/review-due/archived) | Content-workflow staff | `canViewResourceWorkflow`/`isResourceStaff` | Read-only (queue view); mutation via ADM-09 | N/A | Internal | Operational | Wave 5 manual, complete |
| ADM-10 | Schedule content for future publication | (n/a — not built) | (n/a) | (n/a) | (n/a) | Internal | **Not operational** — deferred to **A3.1** | Availability note only |

## 2. Benchmarks & Reference Data (existing — canonical area: **Data Governance**, PO-2)

Grouped here by domain for readability; per PO-2 (`A1_19`, `A1_06`), these three tasks share the **Data Governance** top-level nav area with the future FDH-governance tasks in §7 below — there is no separate "Reference Data & Benchmarks" nav area.

| ID | Task | Eligible roles | Capability | Mutation authority | Audit | Privacy | Status | Manual |
|---|---|---|---|---|---|---|---|---|
| ADM-01 | Approve/suspend/reinstate a benchmark source | Super Admin | `requireAdmin` (Super Admin gate; no finer-grained capability exists yet) | **Pattern A RPC** `admin_transition_benchmark_source` | `AUDITED_COMPLETE`, hard-immutable trigger | Public reference data | Operational | Wave 5 manual, complete |
| ADM-02 | Validate/activate/retire a benchmark dataset | Super Admin | `requireAdmin` | Direct write + `benchmark_update_runs` insert (non-atomic, pre-existing since migration `0011` — disclosed residual) | `AUDITED_COMPLETE` (both accept/reject paths) | Public reference data | Operational | Wave 5 manual, complete |
| ADM-03 | Review benchmark reference data / audit log | Super Admin | `requireAdmin` | Read-only | N/A (this is the audit-read surface) | Public reference data | Operational | Wave 5 manual, complete |

## 3. Recommendations (existing)

| ID | Task | Eligible roles | Capability | Mutation authority | Audit | Privacy | Status | Manual |
|---|---|---|---|---|---|---|---|---|
| ADM-04 | Create/edit/activate/deactivate a recommendation | Super Admin | `requireAdmin` | **Pattern B RPC** `admin_upsert_recommendation_atomic` | `AUDITED_COMPLETE` (RPC-internal) | Internal | Operational | Wave 5 manual, complete |
| ADM-05 | Bulk update recommendations from CSV | Super Admin | `requireAdmin` | **Pattern B RPC** `admin_import_recommendation_conditions` (conditions file); direct upsert (3 other file types) | `AUDITED_COMPLETE` (conditions); `AUDIT_NOT_REQUIRED` (other 3, disclosed residual) | Internal | Operational | Wave 5 manual, complete |
| ADM-06 | Review recommendation coverage gaps | — | — | — | — | Would have exposed identifiable individual financial figures | **Withdrawn on privacy grounds** (Wave 5, independently re-verified Wave 6) | Availability note only — see A1.3 §6, A1_15 |

## 4. Analytics (existing shell + future)

| ID | Task | Eligible roles | Capability | Mutation authority | Audit | Privacy | Status | Future stage |
|---|---|---|---|---|---|---|---|---|
| ADM-19 | View Resources analytics | Analyst, Resource Admin, Super Admin | `canViewResourceAnalytics` | Read-only | N/A | N/A — no data exists yet | **Not operational** — protected empty shell, hidden from nav | Analyst Analytics implementation track (separate, not A1) |
| ADM-46 | View canonical cross-domain Admin Analytics dashboards | Analyst, Resource Admin, Super Admin | `canViewCanonicalAnalytics` *(new, canonical)* | Read-only, aggregate-only RPC | N/A (read) | Pseudonymous aggregate, suppressed | **Future** | A4 — generalises ADM-19 once the canonical suppression engine (A1_15) is built |
| ADM-45 | Configure analytics suppression thresholds | Super Admin only | `canConfigureSuppressionThresholds` *(new)* | Config write, audited | `AUDITED_COMPLETE` | Internal (governs a privacy control, contains none itself) | **Future** | A4 — flagged for Product Owner (§ A1_19 PO-7) |

## 5. Administration (existing + future)

| ID | Task | Eligible roles | Capability | Mutation authority | Audit | Privacy | Status | Future stage |
|---|---|---|---|---|---|---|---|---|
| ADM-18 | Assign/remove a Resources role | `canManageResources` roles (today: Resource Admin, Super Admin) | `canManageResources` | Direct write, service-role only, self-lockout guard | `AUDITED_COMPLETE` (before/after, actor) | Internal (references a specific user account) | Operational | Wave 5 manual, complete |
| ADM-20 | Admin capability resolution (`GET /api/admin/me`) | Any authenticated caller (returns all-false if none) | none by design (documented exception) | Read-only | N/A | N/A | Operational, no UI | Wave 5 manual, complete |
| ADM-44 | Administer canonical Admin role assignment (beyond Resources) | Super Admin | `canManageAdminRoles` *(new, canonical)* | Direct write, audited | `AUDITED_COMPLETE` | Internal | **Future** | A2 — generalises ADM-18 to the full 7-role canonical model once non-Resources roles exist outside Resources' own table |
| ADM-41 | Review the canonical Admin audit log | Super Admin (broadest); domain-scoped view for Compliance Reviewer/Resource Admin within their own domain | `canViewAdminAuditLog` *(new)* | Read-only | N/A (this is the audit-read surface) | Internal, may contain pseudonymous subject references | **Future** | A1.3 — today audit is read per-domain (Benchmarks update-runs, Resources workflow history); this task is the canonical cross-domain successor |
| ADM-42 | Review canonical security events | Super Admin | `canViewSecurityEvents` *(new)* | Read-only | N/A | Internal | **Future** | A1.3/A4 — no security-event stream exists today (design only, A1_12) |

## 6. AI Admin (existing — Module 11 boundary; A1 documents, does not build UI)

Per the brief, A1 does not implement any Module 11 screen. These 8 grouped tasks record what already exists at the API layer today (19 route files, ~28 handlers, `requireAdmin()` throughout, zero pages — disposition `BACKEND_WITHOUT_UI`) so the canonical task inventory has no unowned surface. Building a UI for any of these remains Module 11's own roadmap decision, not A1's.

| ID | Task | Routes | Eligible roles today | Capability today | Mutation authority | Audit | Privacy | Status |
|---|---|---|---|---|---|---|---|---|
| ADM-22 | Configure AI platform controls (models/providers/entitlements/cost limits) | `ai/controls`, `ai/providers/[provider]`, `ai/entitlements`, `ai/cost-limits/[id]`, `ai/models`, `ai/models/[id]`, `ai/models/[id]/enable`, `ai/models/[id]/disable` | Super Admin | `requireAdmin` (broad — see A1_19 finding on Module 11's own pre-existing Standard §2 deviation) | Direct write | `AUDITED_COMPLETE` via `ai_config_audit` (trigger-written) | Internal | Operational, no UI |
| ADM-23 | Operate the AI kill switch | `ai/kill-switch` | Super Admin | `requireAdmin` | Direct write, mandatory reason | `AUDITED_COMPLETE`, dedicated `ai_operational_events` log | Internal | Operational, no UI |
| ADM-24 | Manage AI model & prompt registry | `ai/prompts`, `ai/prompts/[id]` | Super Admin | `requireAdmin` | Direct write | `AUDITED_COMPLETE` via `ai_config_audit` | Internal | Operational, no UI |
| ADM-25 | Review AI cost & usage reporting | `ai/costs`, `ai/usage` | Super Admin | `requireAdmin` | Read-only | N/A | Internal aggregate | Operational, no UI |
| ADM-26 | Review AI safety events & config audit | `ai/safety-events`, `ai/config-audit` | Super Admin | `requireAdmin` | Read-only | N/A (this is the audit/security read surface) | Internal | Operational, no UI |
| ADM-27 | Run AI evaluations | `ai/evaluations` | Super Admin | `requireAdmin` | Triggers a run | Not separately audited beyond the run record itself | Internal | Operational, no UI |
| ADM-28 | Manage AI insight packs | `ai/insight-packs`, `ai/insight-packs/generate` | Super Admin | `requireAdmin` | Triggers generation | Not separately audited | Internal | Operational, no UI |
| ADM-29 | Manage standard personalised question library | `ai/standard-questions` | Super Admin | `requireAdmin` | Direct write | Not separately audited (disclosed residual) | Internal | Operational, no UI |

**Cross-cutting AI Admin finding, carried forward (not fixed by A1):** all 8 tasks above share one broad `requireAdmin()` gate rather than named, independently-testable capabilities (Standard §2 requires separately named capabilities even where roles currently coincide). This is a pre-existing deviation Module 11 itself introduced, not something FDH-13 or A1 caused; it is recorded here as a finding for Module 11's own roadmap, not remediated by this stage (§14 of the Standard — no hidden scope expansion).

## 7. Data Governance — FDH Governance Tasks (future — FDH-13, design-only, not implemented; canonical area: **Data Governance**, PO-2, shared with §2's Benchmarks tasks)

The full 85-requirement mapping is `A1_16_FDH13_TRACEABILITY_MATRIX.md` (and its companion CSV). These 11 canonical tasks are the operator-language summary of that matrix's ~36 distinct proposed capabilities. **None is implemented, none has a route, none has a role holder beyond "Super Admin (interim)" — a temporary allocation, not a proposed permanent role; PO-1 (`A1_19`) has deferred the candidate-role decision named in each row below.**

| ID | Task | Eligible roles (interim) | Capability | Mutation authority | Audit | Privacy | Future wave |
|---|---|---|---|---|---|---|---|
| ADM-30 | View FDH master data (institutions/merchants/categories/MCC/parser registry) and the candidate queue | Super Admin (interim); Analyst if restricted to reference-level only (undecided) | `canViewFdhMasterData` | Read-only, aggregate/reference RPC | Read access logged | Internal reference | Wave A/B |
| ADM-31 | Propose an FDH master-data change or candidate promotion | Super Admin (interim); candidate role: Data Governance Contributor | `canProposeFdhMasterData` | Insert, validated (Zod schemas already exist, unwired) | `AUDITED_COMPLETE` (actor + before-state) | No user financial data by construction | Wave B |
| ADM-32 | Review an FDH master-data proposal (move to `admin_review`) | Super Admin (interim); candidate role: Data Governance Contributor | `canReviewFdhMasterData` | State transition | `AUDITED_COMPLETE` | Internal | Wave B |
| ADM-33 | Approve/activate/retire/merge/roll back an FDH master-data change | Super Admin (interim); candidate role: Data Governance Approver | `canApproveFdhMasterData` | **Pattern A RPC (proposed)**, proposer≠approver enforced in-transaction (REG-01, resolved) | `AUDITED_COMPLETE` | Internal | Wave B |
| ADM-34 | Manage the FDH parser registry (certify/version a parser) | Super Admin (interim); candidate: Data Governance Contributor, pending REG-06 | `canManageFdhParsers` | Direct write (today: migration-review act, not an Admin-role act) | `AUDITED_COMPLETE` | Internal | Wave C |
| ADM-35 | Operate the FDH processing/upload kill switch | Super Admin (interim); candidate: unnamed "Operational Emergency Control" | `canOperateFdhKillSwitch` | Direct write, mandatory reason | `AUDITED_COMPLETE` | Internal | Wave D |
| ADM-36 | View FDH operational metadata (ingestion/parsing/candidate health) | Super Admin (interim); candidate: Data Governance Contributor | `canViewFdhOperations` | Read-only, allow-listed projection | Read access logged | Internal, allowlisted | Wave D |
| ADM-37 | View FDH aggregate analytics (privacy-suppressed) | **Analyst** (clean fit) + Super Admin | `canViewFdhAnalytics` | Read-only, aggregate RPC | N/A | Pseudonymous aggregate, suppressed | Wave E — consumes the canonical suppression engine, does not build its own (REG-15) |
| ADM-38 | Access FDH support data (purpose-bound, not raw documents) | Super Admin (interim), gated on Wave F consent design; candidate: Support Access Grantee | `canAccessFdhSupportData` | Time-limited, purpose-bound read | `AUDITED_COMPLETE`, immutable | Sensitive financial (operational record, not raw document) | Wave F — not designed until then |
| ADM-39 | Exercise FDH break-glass raw-document access | **Reserved — no holder designed** | `canUseFdhBreakGlassAccess` | Time-boxed, auto-expiring | `AUDITED_COMPLETE`, immutable, cannot combine with any audit-editing capability | Raw uploaded documents | Wave F — hard PO boundary, not designed in this phase |
| ADM-40 | Export FDH governance/audit evidence | Super Admin (interim); candidate: Data Governance Approver, pending REG-04 | `canExportFdhGovernanceData` | Server-side generated export | `AUDITED_COMPLETE` (who exported what) | Internal, stricter than view/approve per REG-04 | Wave B/G |

## 8. Security & Support (future, cross-cutting; canonical area renamed from "Security, Privacy & Support" per PO-2)

| ID | Task | Eligible roles | Capability | Mutation authority | Audit | Privacy | Future stage |
|---|---|---|---|---|---|---|---|
| ADM-43 | Grant/revoke time-limited support access (general, cross-domain break-glass) | Super Admin only (grantor); candidate holder role: Support Access Grantee | `canGrantSupportAccess` / `canUseGrantedSupportAccess` *(new)* | Time-limited grant, auto-expiring | `AUDITED_COMPLETE`, immutable | Governs access to sensitive data, contains none itself | A4 — see A1_14 |

---

## 9. Reconciliation

- **21** existing certified tasks (ADM-01–ADM-21), unchanged in ID, all with dispositions reconfirmed at Wave 6.
- **8** existing-but-undocumented AI Admin tasks (ADM-22–ADM-29), newly named here in operator language for the first time — no code change, no route change, purely a naming/inventory act consistent with §14 of the Standard (no hidden scope expansion).
- **11** future FDH-13 tasks (ADM-30–ADM-40), design-only, gated behind the FDH-13 Wave A precondition (§ A1_19 PO-1).
- **6** future cross-cutting canonical tasks (ADM-41–ADM-46), design-only, owned by A1.3/A2/A4 as marked.

**Total canonical tasks: 46.** Every current Admin page (36) and API route file (74/106 handlers) maps to exactly one task above — see `A1_08_MIGRATION_MAP.md` for the page/route-level mapping and `A1_04_ROLE_CAPABILITY_MATRIX.md` for the role-to-capability grid these tasks draw on.
