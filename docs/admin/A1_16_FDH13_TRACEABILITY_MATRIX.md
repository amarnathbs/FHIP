# A1 — Updated FDH-13 Traceability Matrix

**Source:** `FHIP_FDH13_Traceability_Matrix.csv` (85 rows × 18 columns), `docs/fdh13-admin-integration-baseline` @ `9fdce5d` (unmerged branch tip, `D:/fhip-fdh13-admin-baseline`), reconfirmed unchanged by Admin A0.2 Wave 6's own `A02_WAVE6_FDH13_TRACEABILITY_MATRIX.md`.
**What changed here:** three columns layered onto the baseline's own 18 — **Canonical Area**, **Canonical Task (operator language)**, and **Canonical role (interim, per REG-16 pending)** — computed mechanically from the existing `Governance domain`/`Proposed capability` columns (script: reproducible, deterministic, no row re-scored). **No status cell (`Status`, `Blocks FDH-13 closure`, `Product Owner decision`) is changed from the baseline.** The full 15-column reconciled table is `A1_16_FDH13_TRACEABILITY_MATRIX.csv` (companion to this file); this document is its per-area summary.

**Per A02_WAVE6_FDH13_TRACEABILITY_MATRIX.md's own scope note, restated:** this reconciliation certifies FDH-13's *integration into the canonical Admin architecture*, not its implementation. No FDH-13 wave (A–G) has begun. No row's status is reopened, re-scored, or improved by this document.

**Canonical Area values updated for PO-2 (both this document and the companion CSV):** "Financial Data Governance" → **Data Governance** (34 rows); "Security, Privacy & Support" → **Security & Support** (14 rows) — a pure rename to match `A1_06`'s PO-2-approved 8-area structure; no row's area *membership* changes, only the label. "Administration (Audit)" (12 rows) and "Analytics" (12 rows) are unchanged, already matching PO-2's naming.

**Canonical role (interim) column status per PO-1:** every "Super Admin (interim)" and "candidate: Data Governance Contributor/Approver/Support Access Grantee" entry throughout §2 below names a **deferred** decision (`A1_19` PO-1) — none of the three candidate roles is approved, rejected, or created by this document or by A1. "Super Admin (interim)" remains explicitly a temporary allocation, not a settled permanent assignment, until PO-1 resolves.

## 1. Row totals (unchanged from the baseline, re-verified, not re-scored)

| Canonical Area | FDH-13 origin domain(s) | Rows | Implemented | Partial | Missing | Conflicting | N/A |
|---|---|--:|--:|--:|--:|--:|--:|
| Data Governance | Master-data (MD), Intelligence-candidate (IC), Parser/coverage (PC) | 34 | 10 | 12 | 12 | 0 | 0 |
| Operations | Operational monitoring (OM) | 13 | 0 | 4 | 9 | 0 | 0 |
| Security & Support | Privacy/support access (PR) | 14 | 6 | 2 | 6 | 0 | 0 |
| Administration (Audit) | Audit/evidence (AE) | 12 | 0 | 5 | 7 | 0 | 0 |
| Analytics | Analytics/reporting (AR) | 12 | 1 | 1 | 7 | 0 | 3 |
| **Total** | | **85** | **17** | **24** | **41** | **0** | **3** |

(Unchanged from the baseline's own 7-domain totals — MD 0/6/6, IC 5/3/3, PC 5/3/3 Implemented/Partial/Missing — re-grouped by canonical area rather than FDH-13's own domain scheme: 34-row Data Governance = MD+IC+PC = 10 Implemented + 12 Partial + 12 Missing. Grand total 17/24/41/0/3 = 85, identical to the baseline and to Wave 6's own re-verification.)

## 2. Per-area detail

### Data Governance (34 requirements)

| Req ID | Canonical Task | Capability | Role (interim) | Stage | Wave | Blocks closure |
|---|---|---|---|---|---|---|
| FDH13-MD-001 | VIEW institutions/merchants/categories/MCC/parser master data | canViewFdhMasterData | Super Admin (interim); candidate: Data Governance Contributor | MISSING | Wave B | No |
| FDH13-MD-002 | PROPOSE a new or changed master-data record | canProposeFdhMasterData | Super Admin (interim); candidate: Data Governance Contributor | PARTIAL | Wave B | No |
| FDH13-MD-003 | REVIEW a proposed master-data change | canReviewFdhMasterData | Super Admin (interim); candidate: Data Governance Contributor | PARTIAL | Wave B | No |
| FDH13-MD-004 | APPROVE a proposed master-data change (promote to canonical) | canApproveFdhMasterData | Super Admin (interim); candidate: Data Governance Approver | MISSING | Wave B | Yes |
| FDH13-MD-005 | ACTIVATE a master-data version (set effective_from / active=true) | canApproveFdhMasterData (activation folded into approval) | Super Admin (interim); candidate: Data Governance Approver | PARTIAL | Wave B | No |
| FDH13-MD-006 | RETIRE/deprecate a master-data record | canApproveFdhMasterData | Super Admin (interim); candidate: Data Governance Approver | PARTIAL | Wave B | No |
| FDH13-MD-007 | ROLL BACK an approved master-data change | canApproveFdhMasterData (rollback modelled as a new approval reversing the prior one -- see REG-02) | Super Admin (interim); candidate: Data Governance Approver | MISSING | Wave B | Yes |
| FDH13-MD-008 | Master data retains VERSION HISTORY (not just a current row) | canViewFdhMasterData (view history) / canApproveFdhMasterData (write a new version) | Super Admin (interim); candidate: Data Governance Approver | PARTIAL | Wave B | No |
| FDH13-MD-009 | Every master-data fact has recorded PROVENANCE | canViewFdhMasterData | Super Admin (interim); candidate: Data Governance Contributor | PARTIAL | Wave B | No |
| FDH13-MD-010 | EXPORT master-data governance data (CSV) | canExportFdhGovernanceData | Super Admin (interim); candidate: Data Governance Approver (pending REG-04) | MISSING | Wave B/G | No |
| FDH13-MD-011 | Every master-data ADMIN MUTATION is audited with an admin actor | (enforced automatically by every write capability above, not a capability itself) | N/A - cross-cutting control, not a standing role grant | MISSING | Wave A/B | Yes |
| FDH13-MD-012 | Propose and approve the SAME master-data change must not be performable by the same per... | (cross-cutting constraint on canProposeFdhMasterData + canApproveFdhMasterData) | N/A - cross-cutting control, not a standing role grant | MISSING | Wave B | Yes |
| FDH13-IC-001 | A CANDIDATE table exists for new merchants / aliases / institutions / classification ru... | canViewFdhMasterData (candidate queue is part of the same view) | Super Admin (interim); candidate: Data Governance Contributor | IMPLEMENTED | Wave B | No |
| FDH13-IC-002 | Candidate carries evidence (independent-user count / corrections / matching aliases) ra... | canReviewFdhMasterData | Super Admin (interim); candidate: Data Governance Contributor | IMPLEMENTED | Wave B | No |
| FDH13-IC-003 | PII / personal-payee screening gate blocks approval of an unscreened or flagged candidate | canApproveFdhMasterData (gate is automatic, not a separate capability) | Super Admin (interim); candidate: Data Governance Approver | IMPLEMENTED | Wave B | No |
| FDH13-IC-004 | Candidate REVIEW status transition (open -> admin_review) requires a real reviewer iden... | canReviewFdhMasterData | Super Admin (interim); candidate: Data Governance Contributor | PARTIAL | Wave B | Yes |
| FDH13-IC-005 | No candidate may be promoted automatically on confidence threshold alone (negative cont... | N/A (this is an absence-of-capability control) | N/A - cross-cutting control, not a standing role grant | IMPLEMENTED | None (already closed) | No |
| FDH13-IC-006 | Candidate PROMOTION writes the approved fact into canonical master data (fdh_merchants ... | canApproveFdhMasterData (promotion is the terminal effect of approval) | Super Admin (interim); candidate: Data Governance Approver | MISSING | Wave B | Yes |
| FDH13-IC-007 | Duplicate-candidate detection and merge | canReviewFdhMasterData / canApproveFdhMasterData | Super Admin (interim); candidate: Data Governance Approver | PARTIAL | Wave B | No |
| FDH13-IC-008 | Candidate decisions are VERSIONED (a later re-review does not silently overwrite the ea... | canReviewFdhMasterData | Super Admin (interim); candidate: Data Governance Contributor | MISSING | Wave B | No |
| FDH13-IC-009 | A promoted candidate can be ROLLED BACK | canApproveFdhMasterData | Super Admin (interim); candidate: Data Governance Approver | MISSING | Wave B | Yes |
| FDH13-IC-010 | Candidate lifecycle is fully audited end to end (open/admin_review/approved/rejected/me... | (cross-cutting -- see MD-011) | N/A - cross-cutting control, not a standing role grant | PARTIAL | Wave A/B | Yes |
| FDH13-IC-011 | No candidate becomes canonical merely because it exists in the candidate table (structu... | N/A (structural control, not a capability) | N/A - cross-cutting control, not a standing role grant | IMPLEMENTED | None (already closed) | No |
| FDH13-PC-001 | A PARSER REGISTRY records parser identity, institution, document type and format | canViewFdhOperations | Super Admin (interim); candidate: Data Governance Contributor | IMPLEMENTED | Wave C | No |
| FDH13-PC-002 | Each parser VERSION has a certification status (development / certified / deprecated / ... | canManageFdhParsers (write) / canViewFdhOperations (read) | Super Admin (interim); candidate: Data Governance Contributor (pending REG-06) | IMPLEMENTED | Wave C | No |
| FDH13-PC-003 | Institution-level COVERAGE STATUS (master_only / parser_planned / parser_certified) is ... | canViewFdhOperations | Super Admin (interim); candidate: Data Governance Contributor | PARTIAL | Wave C | No |
| FDH13-PC-004 | Parser certification is backed by a FIXTURE/regression pack with provenance | canViewFdhOperations | Super Admin (interim); candidate: Data Governance Contributor | IMPLEMENTED | Wave C | No |
| FDH13-PC-005 | A COVERAGE DASHBOARD shows certified vs. total institutions per country | canViewFdhAnalytics | Analyst (+ Super Admin) | MISSING | Wave C/E | No |
| FDH13-PC-006 | False-positive / false-negative parser detection is monitored | canViewFdhAnalytics | Analyst (+ Super Admin) | MISSING | Wave C/D | No |
| FDH13-PC-007 | Unsupported format/institution is detected at upload time and never silently guessed | N/A | N/A - cross-cutting control, not a standing role grant | IMPLEMENTED | N/A -- NOT_APPLICABLE to FDH-13's Admin scope | No |
| FDH13-PC-008 | A RELEASE GATE exists before a parser version is marked certified | canManageFdhParsers | Super Admin (interim); candidate: Data Governance Contributor (pending REG-06) | PARTIAL | Wave C | No |
| FDH13-PC-009 | A certified parser version can be ROLLED BACK to the prior certified version | canManageFdhParsers | Super Admin (interim); candidate: Data Governance Contributor (pending REG-06) | PARTIAL | Wave C | No |
| FDH13-PC-010 | A parser is bounded to its certified country/currency and never applied outside it | N/A | N/A - cross-cutting control, not a standing role grant | IMPLEMENTED | N/A | No |
| FDH13-PC-011 | VIEW/MANAGE the parser registry (list, inspect version history, see certification evide... | canManageFdhParsers (write) / canViewFdhOperations (read) | Super Admin (interim); candidate: Data Governance Contributor (pending REG-06) | MISSING | Wave C | Yes |

### Operations (13 requirements)

| Req ID | Canonical Task | Capability | Role (interim) | Stage | Wave | Blocks closure |
|---|---|---|---|---|---|---|
| FDH13-OM-001 | Upload volume is monitored | canViewFdhAnalytics | Analyst (+ Super Admin) | MISSING | Wave D | No |
| FDH13-OM-002 | Parse success/failure is monitored | canViewFdhAnalytics | Analyst (+ Super Admin) | MISSING | Wave D | No |
| FDH13-OM-003 | Reconciliation failures are monitored in aggregate | canViewFdhAnalytics | Analyst (+ Super Admin) | MISSING | Wave D/E | No |
| FDH13-OM-004 | Duplicate-detection volume is monitored in aggregate | canViewFdhAnalytics | Analyst (+ Super Admin) | MISSING | Wave D/E | No |
| FDH13-OM-005 | Categorisation-confidence trend is monitored | canViewFdhAnalytics | Analyst (+ Super Admin) | MISSING | Wave D/E | No |
| FDH13-OM-006 | Approval/apply failures are monitored | canViewFdhAnalytics | Analyst (+ Super Admin) | MISSING | Wave D | No |
| FDH13-OM-007 | Processing latency and queue/backlog are monitored | canViewFdhAnalytics | Analyst (+ Super Admin) | PARTIAL | Wave D | No |
| FDH13-OM-008 | Provider/storage failures are monitored | canViewFdhAnalytics | Analyst (+ Super Admin) | MISSING | Wave D | No |
| FDH13-OM-009 | FDH-specific SECURITY EVENTS are monitored and distinguished from ordinary failures | canViewFdhAnalytics / canAccessFdhSupportData (for detail drill-down) | Analyst (+ Super Admin) | MISSING | Wave D/F | No |
| FDH13-OM-010 | Synthetic-test-data residue and cleanup failures are detected | canViewFdhOperations | Super Admin (interim); candidate: Data Governance Contributor | PARTIAL | Wave D | No |
| FDH13-OM-011 | An ADMIN-CONTROLLED kill switch exists for FDH upload/processing (not only an env var) | canManageFdhParsers or a dedicated canOperateFdhKillSwitch (PO to confirm which -- REG-08) | Super Admin (interim); candidate: Data Governance Contributor (pending REG-06) | PARTIAL | Wave D | No |
| FDH13-OM-012 | Alert ownership is assigned per failure category | N/A (operational/organisational, not a software capability) | N/A - cross-cutting control, not a standing role grant | MISSING | Wave D/G | No |
| FDH13-OM-013 | Failures are classified as user-correctable / parser defect / data-quality warning / in... | canViewFdhAnalytics | Analyst (+ Super Admin) | PARTIAL | Wave D | No |

### Security & Support (14 requirements)

| Req ID | Canonical Task | Capability | Role (interim) | Stage | Wave | Blocks closure |
|---|---|---|---|---|---|---|
| FDH13-PR-001 | Admin has NO standing access to raw user financial documents (Product Owner Decision 3) | N/A | N/A - cross-cutting control, not a standing role grant | IMPLEMENTED | None (already closed) | No |
| FDH13-PR-002 | Admin-visible fields are an explicit ALLOWLIST of operational metadata (never a denylist) | canViewFdhOperations | Super Admin (interim); candidate: Data Governance Contributor | IMPLEMENTED | None (already closed) | No |
| FDH13-PR-003 | Forbidden columns are named with an explicit REASON (not merely omitted) | N/A | N/A - cross-cutting control, not a standing role grant | IMPLEMENTED | None (already closed) | No |
| FDH13-PR-004 | Any admin projection of user-owned data uses a PSEUDONYMOUS reference, never a direct u... | canViewFdhOperations | Super Admin (interim); candidate: Data Governance Contributor | PARTIAL | Wave A/B | Yes |
| FDH13-PR-005 | A hard list of tables admin has NO standing access to at ANY granularity (not even aggr... | N/A | N/A - cross-cutting control, not a standing role grant | IMPLEMENTED | None (already closed) | No |
| FDH13-PR-006 | Analyst receives AGGREGATED, privacy-safe FDH metrics only -- no row-level access | canViewFdhAnalytics | Analyst (+ Super Admin) | MISSING | Wave E | No |
| FDH13-PR-007 | Support access to identifiable FDH data requires its OWN explicit capability (not infer... | canAccessFdhSupportData | Super Admin (interim) - gated on Wave F consent design; candidate: Support Access Grantee | MISSING | Wave F | Yes |
| FDH13-PR-008 | Support access is PURPOSE-BOUND and every use is logged with purpose + target | canAccessFdhSupportData | Super Admin (interim) - gated on Wave F consent design; candidate: Support Access Grantee | MISSING | Wave F | Yes |
| FDH13-PR-009 | A TIME-BOXED / break-glass access mechanism exists for exceptional raw-document access | canUseFdhBreakGlassAccess | RESERVED - Wave F only, no holder designed yet | MISSING | Wave F | Yes |
| FDH13-PR-010 | FDH governance exports are server-side generated, authorised, and audited (never a raw ... | canExportFdhGovernanceData | Super Admin (interim); candidate: Data Governance Approver (pending REG-04) | MISSING | Wave B/G | No |
| FDH13-PR-011 | Support-access grants have a defined RETENTION and eventual deletion policy | (governs canAccessFdhSupportData / canUseFdhBreakGlassAccess) | RESERVED - Wave F only, no holder designed yet | MISSING | Wave F | Yes |
| FDH13-PR-012 | Sensitive values are REDACTED in any admin-visible metadata or log | (cross-cutting) | N/A - cross-cutting control, not a standing role grant | PARTIAL | Wave F | No |
| FDH13-PR-013 | Admin UI must never become an RLS bypass -- cross-tenant access stays blocked at the da... | (cross-cutting -- applies to every FDH-13 capability) | N/A - cross-cutting control, not a standing role grant | IMPLEMENTED | Wave A (as a build-time constraint on every later wave) | No |
| FDH13-PR-014 | Country-confirmation status (MCC) is never conflated with Admin authorisation or suppor... | N/A | N/A - cross-cutting control, not a standing role grant | IMPLEMENTED | None (already closed; must not be reopened per PO spec section 2 'Do not reopen or modify MCC') | No |

### Administration (Audit) (12 requirements)

| Req ID | Canonical Task | Capability | Role (interim) | Stage | Wave | Blocks closure |
|---|---|---|---|---|---|---|
| FDH13-AE-001 | Every FDH governance audit event records an ADMIN actor (not only user/system/service) | (enforced automatically by every write capability) | N/A - cross-cutting control, not a standing role grant | MISSING | Wave A | Yes |
| FDH13-AE-002 | Audit event records which CAPABILITY/operation was exercised | (enforced automatically) | N/A - cross-cutting control, not a standing role grant | PARTIAL | Wave A/B | Yes |
| FDH13-AE-003 | Audit event records the TARGET generically (not only a document_id) | (enforced automatically) | N/A - cross-cutting control, not a standing role grant | MISSING | Wave A | Yes |
| FDH13-AE-004 | Audit event captures BEFORE/AFTER state | (enforced automatically) | N/A - cross-cutting control, not a standing role grant | PARTIAL | Wave B | No |
| FDH13-AE-005 | Audit event captures a REASON for the governance action | (enforced automatically for reject/retire/rollback/kill-switch specifically) | N/A - cross-cutting control, not a standing role grant | PARTIAL | Wave A/B | No |
| FDH13-AE-006 | Audit event links to the approval that authorised it | (enforced automatically) | N/A - cross-cutting control, not a standing role grant | MISSING | Wave A/B | No |
| FDH13-AE-007 | Audit events are IMMUTABLE (append-only, no update/delete, for any role including the a... | (enforced automatically) | N/A - cross-cutting control, not a standing role grant | PARTIAL | Wave A | Yes |
| FDH13-AE-008 | Audit events carry a CORRELATION IDENTIFIER linking a multi-step workflow (propose -> r... | (enforced automatically) | N/A - cross-cutting control, not a standing role grant | MISSING | Wave A/B | No |
| FDH13-AE-009 | Sensitive values are redacted before ever reaching an audit-event metadata payload | (enforced automatically) | N/A - cross-cutting control, not a standing role grant | PARTIAL | Wave A/B | No |
| FDH13-AE-010 | FDH governance audit events have a defined RETENTION policy | (governs export/retention, not a standalone view capability) | Super Admin (interim) - no existing canonical role fits (gap disclosed, not filled) | MISSING | Wave G | No |
| FDH13-AE-011 | FDH governance audit evidence can be EXPORTED for external review | canExportFdhGovernanceData | Super Admin (interim); candidate: Data Governance Approver (pending REG-04) | MISSING | Wave G | No |
| FDH13-AE-012 | Audit records carry ROLLBACK LINKAGE (which event undid which) | (enforced automatically once rollback exists) | N/A - cross-cutting control, not a standing role grant | MISSING | Wave B | Yes |

### Analytics (12 requirements)

| Req ID | Canonical Task | Capability | Role (interim) | Stage | Wave | Blocks closure |
|---|---|---|---|---|---|---|
| FDH13-AR-001 | Parser coverage (certified vs. total institutions per country) is reported | canViewFdhAnalytics | Analyst (+ Super Admin) | MISSING | Wave E | No |
| FDH13-AR-002 | Import volume / success rate / failure rate is reported | canViewFdhAnalytics | Analyst (+ Super Admin) | MISSING | Wave E | No |
| FDH13-AR-003 | Master-data/candidate APPROVAL RATE is reported | canViewFdhAnalytics | Analyst (+ Super Admin) | NOT_APPLICABLE | Wave E (strictly after Wave B) | No |
| FDH13-AR-004 | Candidate BACKLOG (open + admin_review counts) is reported | canViewFdhAnalytics | Analyst (+ Super Admin) | PARTIAL | Wave E | No |
| FDH13-AR-005 | Category-confidence trend is reported | canViewFdhAnalytics | Analyst (+ Super Admin) | MISSING | Wave E | No |
| FDH13-AR-006 | Institution/country coverage is reported | canViewFdhAnalytics | Analyst (+ Super Admin) | MISSING | Wave E | No |
| FDH13-AR-007 | Support-access FREQUENCY is reported (how often break-glass/support capability was used) | canViewFdhAnalytics (aggregate) / canAccessFdhSupportData is a DIFFERENT capability from viewing its frequency | Analyst (+ Super Admin) | NOT_APPLICABLE | Wave G (strictly after Wave F) | No |
| FDH13-AR-008 | FDH security events are reported in aggregate | canViewFdhAnalytics | Analyst (+ Super Admin) | NOT_APPLICABLE | Wave E (after OM-009 in Wave D) | No |
| FDH13-AR-009 | Data-quality trend is reported | canViewFdhAnalytics | Analyst (+ Super Admin) | MISSING | Wave E | No |
| FDH13-AR-010 | Release readiness (parser/master-data certification status ahead of a release) is reported | canViewFdhAnalytics | Analyst (+ Super Admin) | MISSING | Wave E | No |
| FDH13-AR-011 | All FDH analytics apply the canonical Admin Architecture Standard section 7 privacy-sup... | canViewFdhAnalytics | Analyst (+ Super Admin) | MISSING | Wave E | Yes |
| FDH13-AR-012 | No user-level FDH transaction data is ever exposed to the Analyst role (negative control) | N/A | N/A - cross-cutting control, not a standing role grant | IMPLEMENTED | None (already closed) | No |

## 3. What changed vs. what did not

**Changed:** three new columns added (Canonical Area, Canonical Task, Canonical Role interim), computed mechanically. **Unchanged:** every `Status`, `Blocks FDH-13 closure`, `Product Owner decision`, `Segregation requirement`, `Audit requirement`, `Data sensitivity`, `Future Admin wave`, and `Certification evidence` cell is copied verbatim from the baseline CSV — this reconciliation re-derives placement, not verdicts. No historical FDH-13 status is changed without evidence, per the brief's own binding rule.

## 4. Standing prohibitions, reconfirmed (not reopened)

- No `isFdhAdmin`, `fdh_admin`, `fdh_super_admin`, or any domain-suffixed role name — reconfirmed zero matches beyond 2 known negative controls (Wave 6).
- No separate FDH role/nav/audit-sink/analytics-engine — every capability above lands in a canonical area (§1) and consumes canonical audit (`A1_12`)/suppression (`A1_15`) infrastructure, never a bespoke FDH one.
- No standing raw-document access — `FDH13-PR-001` remains `IMPLEMENTED` (Product Owner Decision 3, closed) and is not reopened.
- MCC (country confirmation) is never conflated with Admin authorization — `FDH13-PR-014` remains `IMPLEMENTED`, explicitly flagged in the baseline itself as "must not be reopened," and A1 does not reopen it.

## 5. Rows blocking FDH-13 closure (`Blocks FDH-13 closure = Yes`), unaffected by A1

20 rows carry this flag in the baseline (`MD-004,007,011,012`, `IC-004,006,009,010`, `PC-011`, `PR-004,007,008,009,011`, `AE-001,003,007,012`, `AR-011` — 18 shown in the per-area tables above plus `IC-010`/`AE-007` already counted). None depends on Recommendations, Benchmarks, or the Resources UX surface Admin A0.2 certified — confirmed independently by Wave 6, reconfirmed here by inspection of each flagged row's own Canonical Area (all fall in Data Governance's FDH-governance rows specifically, Security & Support, Administration-Audit, or Analytics — never Content, Recommendations, or the Benchmarks/reference-data rows of Data Governance).
