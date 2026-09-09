# A1.3 — Privacy and Access Standard

Extends `FHIP_ADMIN_ARCHITECTURE_STANDARD.md` §9/§10 with the classification scheme the brief requires. Does not weaken or duplicate the existing Standard — where this document and the Standard could be read differently, the Standard controls.

## 1. Data classification (at least 7 classes, per the brief)

| Class | Examples | Standing Admin access today |
|---|---|---|
| **Public operational** | Published Resources content, active benchmark values, public glossary terms | Read: everyone (site); write: content-workflow roles |
| **Internal non-personal** | Draft content, recommendation library, CTA config, discovery mappings | Content-workflow roles / Super Admin, per capability |
| **Pseudonymous aggregate** | A future suppressed metric ("N users completed onboarding this week") | **None exists yet** — this class has zero live examples; `A1_15` is where it would first exist |
| **Personal profile** | A user's name/email/role assignment metadata | Only via `resources/users` (Resources roles only) — Super Admin/Resource Admin |
| **Sensitive financial** | Account balances, transaction detail, net worth, forecast figures | **No standing Admin access exists anywhere today** — the one surface that ever exposed this (Recommendations Gap Review) is withdrawn |
| **Raw uploaded documents** | Bank statements, CAS statements, payslips | **No standing Admin access exists anywhere today** — `adminBoundary.ts`'s own Product Owner Decision 3: *"a normal application administrator has NO standing access to raw user financial documents"* |
| **Credentials/secrets** | API keys, service-role keys, session tokens | Never Admin-surfaced; infrastructure-only |

## 2. Binding rules (restated from the Standard, cross-referenced, not weakened)

1. **No standing Admin access to raw financial documents** — confirmed zero exceptions in the current tree; the only ever-designed path (FDH-13 break-glass, CAP-28) is explicitly reserved, not built, and structurally barred from combining with any audit-editing capability.
2. **No standing individual-profile browsing** — the closest thing that ever existed (Recommendations Gap Review) is withdrawn on exactly this ground and stays withdrawn until a genuine aggregate replacement exists (`A1_15`).
3. **Super Admin is not a privacy exemption** — every proposed FDH-13 capability that touches sensitive financial or document-level data (CAP-27/28) is explicitly gated on a not-yet-designed consent/support architecture, not granted to Super Admin by default merely because Super Admin holds every other capability. Restated as a first-class rule here because it is easy to misread "Super Admin (interim)" in `A1_02`/`A1_03` as an exemption — it is not: "interim" names the current fallback *role*, never a privacy carve-out, and CAP-27/28 remain undesigned/reserved regardless of which role would eventually hold them.
4. **Client-side masking is insufficient** — every suppression/redaction decision must be evaluated server-side/DB-side (Standard §6/§7); this is why the Recommendations Gap Review fix removed the database client from the route entirely rather than merely hiding fields in the UI.
6. **Keyed HMAC is the approved pseudonymization direction** — resolved by `REG-10` (binding): a keyed HMAC pseudonym derived server-side, secret held outside the database in the approved secrets facility, versioned key identifier, no raw user UUID ever in an Admin-visible result, no reversible lookup exposed to any administrator, documented rotation/historical-comparison behaviour. Suppression still applies on top — pseudonymization is not a substitute for aggregation. **Design ruling only, not built.**
7. **Recommendations Gap Review stays withdrawn** until `A1_15`'s suppression engine produces a genuine aggregate replacement — restated as a hard gate, not a preference.

## 3. Jurisdiction (Standard §10, applied)

Every future task touching personal/behavioural data (ADM-26, 30-40, 42-46) must, before implementation, pass through: AU Privacy Act/APP review, India DPDP Act 2023/Rules 2025 review (checked against then-current commencement status), collection-notice/purpose-compatibility, retention/deletion design, hosting/cross-border review, minors consideration, and a decision on whether a formal PIA is required. **A1 does not perform any of these reviews** — it records the requirement so no future implementation wave skips it. `REG-14` (audit-evidence retention period) **now has Product Owner-approved interim design defaults** (`A1_12` §2.4, PO-5) — a tiered 7/7/2/1-year (plus hold-based) schedule — but those numbers are explicitly marked interim and still require exactly this kind of jurisdiction review before A4 production activation; the jurisdiction review itself remains not performed, and the interim numbers are not a substitute for it.

## 4. Application to the 7-class scheme

| Future task | Class(es) touched | Standing access proposed? |
|---|---|---|
| ADM-30 (view FDH master data) | Internal reference | No new standing access beyond reference data (world-readable already) |
| ADM-37 (FDH aggregate analytics) | Pseudonymous aggregate | Yes, but only the aggregate class, suppressed |
| ADM-38 (FDH support data) | Sensitive financial (operational, not document) | **No standing access** — purpose-bound, time-limited only, per `A1_14` |
| ADM-39 (FDH break-glass) | Raw uploaded documents | **No standing access, ever** — time-boxed emergency-only, per `A1_14` |
| ADM-46 (canonical analytics) | Pseudonymous aggregate | Yes, aggregate/suppressed only |

No future task in the catalogue proposes standing access to Sensitive financial or Raw uploaded documents classes — every touchpoint on those two classes routes through the not-yet-designed Pattern D (consented, time-limited) access model.
