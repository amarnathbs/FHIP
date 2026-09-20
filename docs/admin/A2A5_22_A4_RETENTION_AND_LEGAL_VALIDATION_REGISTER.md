# A4 — Audit Retention and Legal Validation Register

## 1. Interim retention defaults (mission §10.6, matching `A1_12` §2.4 exactly — no deviation)

| Event class | Retention | Applies to |
|---|---|---|
| Privilege, role, privacy, support, break-glass and high-risk governance | 7 years | Role grants/revocations, support-access grants, break-glass events, `critical`-severity security events |
| Content approval, publication, Recommendations and master-data governance | 7 years | `transition_resource_post_status` audit rows, Recommendations atomic-upsert audit rows, FDH master-data propose/review/approve events |
| Routine operational and processing | 2 years | Ingestion/parse-run events, queue-processing events, ordinary content-workflow reads |
| Low-level failed authentication and diagnostic security events | 1 year, unless escalated | `AUTHZ_DENIED`, validation failures, ordinary 422/500 events |
| Legal hold/security investigation | Until formally released | Any event under active investigation or legal hold, regardless of its own class's default |

**Every period above is marked, per mission §10.6's own required wording: "Interim — legal and privacy validation required before A4 production activation."** No deviation from this wording is made anywhere in this report set.

## 2. Implementation status

**NOT STARTED.** No retention-automation code exists (nothing to automate — the tables themselves are unapplied, `A2A5_18`). The `admin_security_events` table's schema (migration `0165`) includes a `retention_classification` column with a `CHECK` constraint enumerating these exact 5 tiers, ready for a future pass to populate. The `admin_audit_events` table does **not** yet have an equivalent column — see `A2A5_18` §1 item 8 for the disclosed gap and why it was not unilaterally added.

## 3. Required legal/privacy validation before any production activation (mission's own explicit, binding requirement)

- Australian Privacy Act / APP review.
- India DPDP Act 2023 / DPDP Rules 2025 review, evaluated against their *then-current* commencement status at implementation time (Standard §10 — not assumed static).
- Formal PIA before any telemetry/behavioural-instrumentation collection begins (Standard §10's own "Required, at minimum" list).
- Qualified Australian/Indian legal review.

**None of this has been performed or requested as part of this dispatch.** This dispatch has no legal authority and no mandate to perform or substitute for legal review — recording this requirement accurately, and refusing to treat the interim numbers as final, is the correct and complete action available to this dispatch.

## 4. Automated production deletion

**Not built, not enabled, and per mission §10.6's own explicit prohibition ("Do not activate automated production deletion without legal/privacy approval"), correctly not attempted.**

## 5. Verdict

**NOT STARTED (retention automation). Interim schedule correctly carried forward, unmodified, and correctly labelled as interim in every document in this set that references it (`A1_12`, `A2A5_03`, `A2A5_18`, this document).** No legal/privacy validation has occurred — this is a named, standing Product Owner decision point (see `A2A5_31_TERMINAL_CERTIFICATION_REPORT.md` for the consolidated list of decisions required).
