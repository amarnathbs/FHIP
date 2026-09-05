# A1.1 — Role-to-Capability Matrix

Union semantics throughout (Standard §3): a multi-role holder's total access is the union of each row they hold. **Y** = granted today (implemented). **(Y)** = would be granted once the capability is built (proposed, not implemented). **—** = never granted. **Interim** = resolves to Super Admin today per `A1_03` §3.

## 1. Implemented capabilities (CAP-01–CAP-18)

| Capability | Analyst | Author | Editor | Compliance Reviewer | Publisher | Resource Admin | Super Admin |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| CAP-01 `canViewResourceDashboard` | — | Y | Y | Y | Y | Y | Y |
| CAP-02 `canViewResourceContent` | — | Y | Y | Y | Y | Y | Y |
| CAP-03 `canViewResourceWorkflow` | — | Y | Y | Y | Y | Y | Y |
| CAP-04 `canViewResourceDiscovery` | — | Y | Y | Y | Y | Y | Y |
| CAP-05 `canViewResourceAnalytics` | **Y** | — | — | — | — | Y | Y |
| CAP-06 `canManageResources` | — | — | — | — | — | Y | Y |
| CAP-07 `isResourceStaff` | — | Y | Y | Y | Y | Y | Y |
| CAP-08 `canCreateResource` | — | Y | Y | — | — | Y | Y |
| CAP-09 `canReviewResource` | — | — | Y | Y | — | Y | Y |
| CAP-10 `canComplianceApproveResource` | — | — | — | Y | — | Y | Y |
| CAP-11 `canPublishResource` | — | — | — | — | Y | Y | Y |
| CAP-12 `canCreateSpecialistContent` | — | Y | Y | — | — | Y | Y |
| CAP-13 `canManageFaqs` | — | — | Y | — | — | Y | Y |
| CAP-14 `canManageDiscovery` | — | — | Y | — | — | Y | Y |
| CAP-15 `isResourceAnalyst` | Y | — | — | — | — | — | — |
| CAP-16 `requireAdmin` (Benchmarks/Recommendations/AI Admin) | — | — | — | — | — | — | Y |
| CAP-17 `adminRoute` (infrastructure) | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| CAP-18 `safeDbError` (infrastructure) | n/a | n/a | n/a | n/a | n/a | n/a | n/a |

## 2. Proposed capabilities — FDH-13 (CAP-19–CAP-29)

| Capability | Analyst | Author/Editor/Compliance Reviewer/Publisher | Resource Admin | Super Admin | Data Gov. Contributor (candidate) | Data Gov. Approver (candidate) | Support Access Grantee (candidate) |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| CAP-19 `canViewFdhMasterData` | possible future fit (undecided) | — | — | Interim (Y) | (Y) | — | — |
| CAP-20 `canProposeFdhMasterData` | — | — | — | Interim (Y) | (Y) | — | — |
| CAP-21 `canReviewFdhMasterData` | — | — | — | Interim (Y) | (Y) | — | — |
| CAP-22 `canApproveFdhMasterData` | — | — | — | Interim (Y), proposer≠approver enforced per-record | — | (Y) | — |
| CAP-23 `canManageFdhParsers` | — | — | — | Interim (Y) | (Y), pending REG-06 | — | — |
| CAP-24 `canOperateFdhKillSwitch` | — | — | — | Interim (Y) | — | — | — (would sit with the unnamed 4th candidate, not created) |
| CAP-25 `canViewFdhOperations` | — | — | — | Interim (Y) | (Y) | — | — |
| CAP-26 `canViewFdhAnalytics` | **(Y) — clean fit, no new role needed** | — | — | (Y) | — | — | — |
| CAP-27 `canAccessFdhSupportData` | — | — | — | Interim (Y), gated on Wave F design | — | — | (Y), not designed until Wave F |
| CAP-28 `canUseFdhBreakGlassAccess` | — | — | — | **Reserved — no holder** | — | — | (Y), narrower still, reserved |
| CAP-29 `canExportFdhGovernanceData` | — | — | — | Interim (Y) | — | (Y), pending REG-04 | — |

**Explicitly never granted, any row:** raw-document access to any role except the unimplemented, hard-restricted CAP-28 path; Analyst never gains CAP-19/20/21/22/27/28 (restated from the FDH-13 Privacy Standard and Standard §5).

## 3. Proposed capabilities — canonical cross-cutting (CAP-30–CAP-36)

| Capability | Analyst | Author/Editor/Compliance Reviewer/Publisher | Resource Admin | Super Admin |
|---|:--:|:--:|:--:|:--:|
| CAP-30 `canViewCanonicalAnalytics` | (Y) | — | (Y) | (Y) |
| CAP-31 `canConfigureSuppressionThresholds` | — | — | — | (Y) only |
| CAP-32 `canManageAdminRoles` | — | — | — | (Y) only |
| CAP-33 `canViewAdminAuditLog` | — (aggregate only, via CAP-30) | domain-scoped view once built (undecided which domains) | domain-scoped view once built | (Y), all domains |
| CAP-34 `canViewSecurityEvents` | — | — | — | (Y) only |
| CAP-35 `canGrantSupportAccess` | — | — | — | (Y) only, grantor |
| CAP-36 `canUseGrantedSupportAccess` | — | — | — | only while holding an active grant of their own |

## 4. Coverage check

- Every row (7 canonical roles) appears in every section above — no role is silently omitted from any capability's consideration.
- Every capability from `A1_02` appears in exactly one section above — no duplication, no capability appearing twice with different answers.
- **Analyst's column is read-only across every section** — the only "Y"/"(Y)" cells in Analyst's column are CAP-05/CAP-15 (implemented) and CAP-26/CAP-30 (proposed, both explicitly aggregate/suppressed-read capabilities) — consistent with Standard §5's binding read-only boundary.
- **Role-less / unauthenticated** is not a column — by construction every capability predicate returns `false`/403 for that caller (Standard §13, fail-closed), so a role-less row would be all-blank across every capability and is omitted as redundant, per the same convention `A1_07`'s persona walkthrough uses explicitly instead.
