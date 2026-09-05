# A1.1 — Canonical Capability Catalogue

Every capability gating an Admin action, present and proposed. Per Standard §2: a capability is independently named, independently documented, independently tested — never a broad boolean. Fields: **ID · Name · Description · Domain · Permitted actions · Assigned roles · Prohibited roles · Affected tasks · Current auth helper · Applicable routes/RPCs · Audit requirement · Privacy classification · Implementation state.**

## 1. Implemented capabilities (Resources domain, `lib/resources/permissions.ts`)

| ID | Name | Description | Assigned roles | Prohibited | Affected tasks | Helper | Routes/RPCs | Audit | Privacy | State |
|---|---|---|---|---|---|---|---|---|---|---|
| CAP-01 | `canViewResourceDashboard` | View the Resources admin landing/summary | Content-workflow staff, Resource Admin, Super Admin | Analyst-only, role-less | ADM-07 | `lib/resources/permissions.ts` | `app/(app)/admin/resources/page.tsx` | N/A | Public operational | Implemented |
| CAP-02 | `canViewResourceContent` | View Content nav group (list/new/edit for all content types) | Content-workflow staff | Analyst-only, role-less | ADM-08,11,12,13,14 | same | `admin/resources/{content,videos,glossary,money-updates,faqs}/**` | N/A | Internal | Implemented |
| CAP-03 | `canViewResourceWorkflow` | View Workflow nav group (6 queues) | Content-workflow staff | Analyst-only, role-less | ADM-21 | same | `admin/resources/content/{drafts,review,scheduled,published,review-due,archived}` | N/A | Internal | Implemented |
| CAP-04 | `canViewResourceDiscovery` | View Discovery nav group (Related, CTAs, Context) | Content-workflow staff | Analyst-only, role-less | ADM-15,16,17 | same | `admin/resources/{related,ctas,context}` | N/A | Internal | Implemented |
| CAP-05 | `canViewResourceAnalytics` | View the Analytics nav group + the analytics route (currently a shell) | Analyst, Resource Admin, Super Admin | Author/Editor/Compliance Reviewer/Publisher alone | ADM-19 | same | `admin/resources/analytics` | N/A | N/A (no data) | Implemented (route is a non-operational shell) |
| CAP-06 | `canManageResources` | Full Resources CRUD, incl. role assignment | Resource Admin, Super Admin | Author/Editor/Compliance Reviewer/Publisher/Analyst | ADM-18, all content-mutation tasks | same | `resources/users`, `resources/users/roles`, most `resources/**` mutation routes | `AUDITED_COMPLETE` for role changes | Internal (references specific accounts) | Implemented |
| CAP-07 | `isResourceStaff` | Baseline "is any content-workflow role" gate; underlies list/view routes | Author, Editor, Compliance Reviewer, Publisher, Resource Admin, Super Admin | Analyst-only, role-less | Most GET list/view routes across ADM-08–17,21 | same | 8 corrected routes (Wave 1: content/videos/glossary/faqs/money-updates/tags/authors/categories) + many more | N/A | Internal | Implemented |
| CAP-08 | `canCreateResource` | Create generic content | Author, Editor, Resource Admin, Super Admin | Compliance Reviewer, Publisher (create ≠ their function), Analyst | ADM-08 | same | `resources/content` POST | `AUDIT_NOT_REQUIRED` | Internal | Implemented |
| CAP-09 | `canReviewResource` | Move content into/through review | Editor, Compliance Reviewer, Resource Admin, Super Admin | Analyst | ADM-09 (partial — RPC is authoritative) | same | via `transition_resource_post_status` | `AUDITED_COMPLETE` (RPC) | Internal | Implemented |
| CAP-10 | `canComplianceApproveResource` | Compliance-approve content (GREEN/AMBER/RED matrix) | Compliance Reviewer, Resource Admin, Super Admin | Author, Editor, Publisher, Analyst | ADM-09 | same | via RPC | `AUDITED_COMPLETE` | Internal | Implemented |
| CAP-11 | `canPublishResource` | Publish content | Publisher, Resource Admin, Super Admin | Author, Editor, Compliance Reviewer, Analyst | ADM-09 | same | via RPC | `AUDITED_COMPLETE` | Internal | Implemented |
| CAP-12 | `canCreateSpecialistContent` | Create video/glossary/money-update | Author, Editor, Resource Admin, Super Admin | Compliance Reviewer, Publisher, Analyst | ADM-11,12,13 | same | `resources/{videos,glossary,money-updates}` POST | `AUDIT_NOT_REQUIRED` | Internal | Implemented |
| CAP-13 | `canManageFaqs` | Full FAQ CRUD + link management | Resource Admin, Editor, Super Admin | Analyst, Author (create-only elsewhere but not FAQs) | ADM-14 | same | `resources/faqs/**` | `AUDIT_NOT_REQUIRED` | Internal | Implemented |
| CAP-14 | `canManageDiscovery` | Manage Related Content, CTAs, Context Mapping | Resource Admin, Editor, Super Admin | Analyst | ADM-15,16,17 | same | `resources/{related,ctas,context}/**` | `AUDITED_COMPLETE` (reorder only) / `AUDIT_NOT_REQUIRED` (else) | Internal | Implemented |
| CAP-15 | `isResourceAnalyst` | Identifies an Analyst-role holder specifically | Analyst | — (identity check, not a grant) | Used to compute CAP-05's union | same | — | N/A | N/A | Implemented |

## 2. Implemented capabilities (Super Admin domain, `lib/services/adminAuth.ts`)

| ID | Name | Description | Assigned roles | Prohibited | Affected tasks | Helper | Routes/RPCs | Audit | Privacy | State |
|---|---|---|---|---|---|---|---|---|---|---|
| CAP-16 | `requireAdmin` | The single broad Super-Admin-membership gate | Super Admin only | every other role | ADM-01,02,03,04,05,06(withdrawn),20-partial,22-29 | `lib/services/adminAuth.ts` | Benchmarks (10 files), Recommendations (4 files), AI Admin (19 files) | Varies by route (see A1_11) | Varies | Implemented |
| CAP-17 | `adminRoute` (wrapper) | Route-handler wrapper standardising the `requireAdmin` call + error mapping | N/A (infrastructure, not itself a grant) | N/A | all of CAP-16's routes | same | same | N/A | N/A | Implemented — **known gap**: catch-all forwards a thrown error's raw `message` (D5-13/PO5-6, LOW severity, needs a formal §16.1 exception or fix) |
| CAP-18 | `safeDbError` | Raw-Postgres-error redaction helper | N/A (infrastructure) | N/A | all mutation routes | same | same | N/A | N/A | Implemented |

**Finding — Standard §2 violation, pre-existing, not caused by A1:** CAP-16 (`requireAdmin`) is one broad boolean gating **33 distinct route files across 3 functional domains** (Benchmarks, Recommendations, AI Admin) that Standard §2 requires to be independently named and independently tested. This is recorded as a **carried finding**, not fixed by A1 (§14 — no hidden scope expansion): splitting `requireAdmin()` into named capabilities (`canManageBenchmarks`, `canManageRecommendations`, `canManageAiPlatform`, etc.) is a genuine, bounded A2/A3 candidate, flagged in `A1_20_ROADMAP_A2_A5.md`.

## 3. Proposed capabilities — FDH-13 (design only, none implemented)

Full detail: `A1_16_FDH13_TRACEABILITY_MATRIX.md`. Summary of the ~11 distinct proposed capability names (36 CSV cells reduce to these, several rows being cross-cutting constraints rather than new capabilities):

| ID | Name | Description | Interim role | Candidate role | Affected tasks | Audit | Privacy | State |
|---|---|---|---|---|---|---|---|---|
| CAP-19 | `canViewFdhMasterData` | View institutions/merchants/categories/MCC/parser master data + candidate queue | Super Admin | Data Governance Contributor | ADM-30 | Read access logged | Internal reference | Proposed |
| CAP-20 | `canProposeFdhMasterData` | Create a master-data proposal | Super Admin | Data Governance Contributor | ADM-31 | `AUDITED_COMPLETE` | No user financial data | Proposed |
| CAP-21 | `canReviewFdhMasterData` | Move a proposal to `admin_review` | Super Admin | Data Governance Contributor | ADM-32 | `AUDITED_COMPLETE` | Internal | Proposed |
| CAP-22 | `canApproveFdhMasterData` | Approve/activate/retire/merge/roll back | Super Admin (proposer≠approver, in-transaction) | Data Governance Approver | ADM-33 | `AUDITED_COMPLETE` | Internal | Proposed |
| CAP-23 | `canManageFdhParsers` | Register/update parser registry | Super Admin | Data Governance Contributor (pending REG-06) | ADM-34 | `AUDITED_COMPLETE` | Internal | Proposed |
| CAP-24 | `canOperateFdhKillSwitch` | Flip the FDH upload/processing kill switch | Super Admin | unnamed 4th candidate ("Operational Emergency Control") | ADM-35 | `AUDITED_COMPLETE` | Internal | Proposed |
| CAP-25 | `canViewFdhOperations` | View allow-listed operational metadata | Super Admin | Data Governance Contributor | ADM-36 | Read access logged | Internal, allow-listed | Proposed |
| CAP-26 | `canViewFdhAnalytics` | View aggregate, suppressed FDH metrics | **Analyst** (clean fit) + Super Admin | — (no new role needed) | ADM-37 | N/A | Pseudonymous aggregate | Proposed |
| CAP-27 | `canAccessFdhSupportData` | Purpose-bound access to one user's FDH operational record | Super Admin (gated on Wave F design) | Support Access Grantee | ADM-38 | `AUDITED_COMPLETE`, immutable | Sensitive financial (operational, not document) | Proposed, not designed until Wave F |
| CAP-28 | `canUseFdhBreakGlassAccess` | Time-boxed raw-document access in a genuine incident | **Reserved — no holder** | Support Access Grantee (narrower) | ADM-39 | `AUDITED_COMPLETE`, immutable | Raw uploaded documents | Reserved name only, not designed |
| CAP-29 | `canExportFdhGovernanceData` | Export governance/audit evidence | Super Admin | Data Governance Approver (pending REG-04) | ADM-40 | `AUDITED_COMPLETE` | Internal, stricter than view/approve | Proposed |

## 4. Proposed capabilities — canonical cross-cutting (design only, this stage's own proposals)

| ID | Name | Description | Assigned roles | Prohibited | Affected tasks | Audit | Privacy | State |
|---|---|---|---|---|---|---|---|---|
| CAP-30 | `canViewCanonicalAnalytics` | View cross-domain Admin Analytics (successor to CAP-05 once real) | Analyst, Resource Admin, Super Admin | Author/Editor/Compliance Reviewer/Publisher alone | ADM-46 | N/A | Pseudonymous aggregate, suppressed | Proposed — depends on A1_15's suppression engine existing |
| CAP-31 | `canConfigureSuppressionThresholds` | Change the suppression engine's minimum-cell/minimum-distinct-person thresholds | Super Admin only | every other role | ADM-45 | `AUDITED_COMPLETE` | Internal (governs a privacy control) | Proposed — flagged for PO (A1_19 PO-7) |
| CAP-32 | `canManageAdminRoles` | Assign/remove any of the 7 canonical roles (not only Resources') | Super Admin only | every other role (no self-escalation) | ADM-44 | `AUDITED_COMPLETE` | Internal | Proposed — generalises CAP-06's role-management slice |
| CAP-33 | `canViewAdminAuditLog` | Read the canonical cross-domain audit sink | Super Admin (all domains); Compliance Reviewer/Resource Admin (own domain only, once domain-scoped views exist) | Analyst (aggregate only, via CAP-30, not raw audit rows), role-less | ADM-41 | N/A (is the audit-read surface) | Internal, may carry pseudonymous subject refs | Proposed — depends on A1_12's sink being built |
| CAP-34 | `canViewSecurityEvents` | Read the canonical security-event stream | Super Admin only | every other role | ADM-42 | N/A | Internal | Proposed — depends on A1_12 |
| CAP-35 | `canGrantSupportAccess` | Grant a time-limited support-access window to another operator | Super Admin only (grantor) | every other role | ADM-43 | `AUDITED_COMPLETE`, immutable | Governs access, contains none itself | Proposed — depends on A1_14 |
| CAP-36 | `canUseGrantedSupportAccess` | Exercise a support-access grant already issued | Support Access Grantee (candidate role) holder currently under an active, unexpired grant | anyone without an active grant, including Super Admin absent a grant of their own | ADM-43 | `AUDITED_COMPLETE`, immutable | Sensitive (whatever the grant scopes) | Proposed — depends on A1_14 |

## 5. Duplicate-capability, orphan-capability and mismatch audit

**Duplicates found: none.** Every capability above governs a distinct action class. CAP-08/CAP-12 (`canCreateResource`/`canCreateSpecialistContent`) look similar but are deliberately separate per Standard §2's own closing paragraph — a future change to specialist-content creation rules must not silently change generic-content creation rules.

**Capabilities with no task:** none — every capability above is cited by at least one task in `A1_01_TASK_CATALOGUE.md`.

**Tasks with no capability (real gap, disclosed, not invented around):** ADM-10 (scheduled publishing — not operational, no capability exists because no feature exists) and ADM-06 (withdrawn — its former capability was deliberately removed, not merely unassigned). Both are correctly capability-less because the underlying feature does not exist / was withdrawn, not because a capability was forgotten.

**UI-vs-backend rule mismatches, carried forward:**
1. **CAP-16 (`requireAdmin`) is a single broad boolean covering 3 unrelated functional domains** (Benchmarks/Recommendations/AI Admin) where Standard §2 requires independent capabilities — see §2 above. Pre-existing, not an A1-introduced defect; flagged for A2/A3.
2. **CAP-17's error-forwarding gap (D5-13/PO5-6)** — the route wrapper's diagnosability convenience is currently informal, not a recorded §16.1 exception. Flagged for PO in `A1_19`.
3. **No route currently implements CAP-19–CAP-36** — every FDH-13 and cross-cutting capability above is a named proposal with zero code. This is not a mismatch (nothing to enforce yet); it is recorded here so a future implementer cannot accidentally treat "capability is named in this catalogue" as "capability already exists."
