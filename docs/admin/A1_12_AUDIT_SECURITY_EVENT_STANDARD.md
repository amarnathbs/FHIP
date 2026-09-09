# A1.3 — Shared Audit and Security-Event Standard

**PO-5: APPROVED as an interim tiered retention standard**, subject to later legal/privacy validation — see §2.4 for the design defaults now adopted. This resolves `REG-14`'s prior "no recommendation" status to a concrete, applicable-today set of periods; it does **not** resolve the underlying jurisdiction-review requirement (`A1_13` §3), which stays open and must complete before A4 production activation.

## 1. Current state (fragmented, confirmed by direct source read)

| Table | Domain | Immutability | Read access |
|---|---|---|---|
| `resource_audit_log` | Resources | RLS + zero write-capable policy for `authenticated` (no hard trigger) | `requireAdmin`/`canManageResources`-gated, no domain-scoped finer access |
| `resource_workflow_history` | Resources | Same | Same |
| `benchmark_update_runs` | Benchmarks | **Hard immutable trigger** (`trg_benchmark_update_runs_no_update`, raises `42501` on any UPDATE/DELETE, proven against the owning/superuser session too) | `requireAdmin`-gated |
| `ai_config_audit` | AI (Module 11) | Hard immutable trigger (the pattern `benchmark_update_runs` copied) | `requireAdmin`-gated |
| `ai_safety_events` | AI (Module 11) | Not independently verified this stage; closer in shape to a security-event table than an audit table (`event_type`, `severity` columns) | `requireAdmin`-gated |
| `ai_operational_events` | AI (Module 11) | Kill-switch/config events | `requireAdmin`-gated |

**No table today carries a `domain` column.** Audit is genuinely fragmented per-domain, not merely differently named.

## 2. Target design (A1.3 build-out — not implemented by this stage)

Adopts Wave 4's own design package (`docs/admin/A02_WAVE4_AUTHORIZATION_AUDIT_RESULTSTATE_REPORT.md` §8) wholesale, resolved by the FDH-13 Product Owner Decision Register's `REG-05` (binding): **one shared, cross-domain canonical Admin audit sink**, `domain` as a row attribute, not a separate table per domain.

### 2.1 Contract fields

`event_id` (uuid PK) · `occurred_at` (server-set) · `domain` (text: `resources`, `recommendations`, `benchmarks`, `ai`, `roles`, `fdh`, …) · `action` (stable machine code) · `actor_id` (uuid FK → `auth.users`, always server-derived from `auth.uid()`, never a request-body field) · `actor_type` (`human_admin`/`service_role`/`system`) · `effective_capabilities` (jsonb snapshot of the authorization context at the time) · `target_type` · `target_id` (nullable) · `before_state`/`after_state` (jsonb, nullable) · `reason` (nullable, mandatory at specific call sites) · `result` (`success`/`rejected`/`failed` — **a failed/rejected mutation must still produce a row**) · `correlation_id` (nullable — not implemented anywhere in this codebase today, a genuine platform-wide gap, see §4) · `jurisdiction` (nullable) · `privacy_classification` (`none`/`contains_pseudonymous_reference`/`contains_personal_data` — the last should never actually occur in Admin audit; the field exists so a violation is machine-detectable) · `pseudonymous_subject_ref` (nullable) · `supersedes_event_id`/`reverses_event_id` (nullable, for reinstatement/correction chains — REG-02's forward-only correction model) · `metadata` (jsonb, allow-listed, non-personal-financial-data only).

### 2.2 Append-only protection

Database-level guarantee (`REVOKE UPDATE, DELETE` explicit, not merely "nobody happens to call it"), generalising `benchmark_update_runs`'/`ai_config_audit`'s existing hard-trigger pattern to every domain.

### 2.3 Migration path for existing tables

| Existing table | Maps to canonical `domain` | Path |
|---|---|---|
| `resource_audit_log` | `resources` | Closest in shape already; needs `correlation_id`, `result`, `supersedes_event_id` added |
| `resource_workflow_history` | `resources` (workflow supplement) | May remain a domain-specific *supplement* alongside the canonical table rather than being replaced — richer supplementary records are allowed to coexist |
| `benchmark_update_runs` | `benchmarks` | Needs `correlation_id`, `actor_type`, `privacy_classification`; `approval_status` maps to canonical `action`/`result` |
| `ai_config_audit`/`ai_operational_events` | `ai` | Not schema-assessed in detail this stage — flagged for the future canonical-migration exercise |

**No existing audit table is migrated, replaced, or altered in shape by A1.**

### 2.4 Retention periods (PO-5, interim design defaults — marked "interim—legal/privacy validation required before A4 production activation")

| Event class | Retention period | Applies to (examples) |
|---|---|---|
| Privilege, role, privacy, support-access, break-glass and high-risk governance events | **7 years** | Role grants/revocations (ADM-18/44), support-access grants (CAP-27/35/36), break-glass events (CAP-28), any `critical`-severity security event |
| Content approval, publication, recommendation and master-data governance events | **7 years** | `transition_resource_post_status` audit rows, `admin_upsert_recommendation_atomic`/`admin_import_recommendation_conditions` audit rows, FDH master-data propose/review/approve events (ADM-31/32/33) |
| Routine operational and processing events | **2 years** | Ingestion/parse-run events, queue-processing events, ordinary (non-privileged) content-workflow reads |
| Low-level failed-authentication and diagnostic security events | **1 year**, unless escalated into an investigation | `AUTHZ_DENIED` (§5.1), validation failures, ordinary `422`/`500` events |
| Security incidents or legal holds | **Retain until the hold is formally released** | Any event subject to an active investigation or legal hold, regardless of its own class's default period |

**Binding conditions on every retention period above (restated from PO-5, verbatim in substance):** audit records must use minimised metadata and must not retain raw documents, secrets, or unnecessary financial figures — this is not a new rule (Standard §9/§7, `A1_12` §5.2's `safe_metadata` allow-list already required it) but PO-5 reconfirms it applies identically across every retention tier, not only the longest one.

**What "interim" means here, precisely:** these periods are the design defaults A1.3's build-out (`A1_20` A4.1) should implement first. They are **not** a substitute for the AU Privacy Act/APP and India DPDP Act jurisdiction review `A1_13` §3 already requires — that review may later shorten, lengthen, or further split any of the five tiers above. No retention period in this table may be treated as final before that review completes and before A4's production activation gate, whichever is later.

## 3. The Wave 4 deferral on `resource_audit_log`/`resource_workflow_history` — carried forward exactly, not reopened

**Exact status:** these two tables lack a hard immutability trigger because four existing, working service-role maintenance/rollback scripts (`scripts/resources/p0-content/r17d-cleanup-duplicate-run.ts`, `r17d-stale-approval-regression.ts`, `rollback-safety-proof.ts`, `rollback-r0a.ts`) legitimately call `.delete()` on them as part of certification-fixture cleanup; an unconditional trigger would silently break that tooling. The Product Owner's ruling: **`APPROVED DEFERRAL TO A1.3 — CANONICAL AUDIT ARCHITECTURE`**, all 9 required conditions already proven live (Wave 4 R3.2).

**A1.3's own target, stated explicitly (per the brief):** convert those four scripts' legitimate deletes into **compensating append-only events** (a correction/rollback becomes a new row that supersedes the original, per `REG-02`'s forward-only model — §2.1's `supersedes_event_id`/`reverses_event_id` fields exist specifically for this), then apply the same hard trigger `benchmark_update_runs`/`ai_config_audit` already use. **A1 defines this target and does not implement the conversion** — implementing it (rewriting the four scripts, adding the trigger, re-proving the same 9 conditions against the new shape) is A1.3's own bounded build task, sequenced in `A1_20`.

## 4. `correlation_id` threading — carried forward as a named gap

Not implemented anywhere in this codebase today (confirmed by Wave 4's own audit). A1.3 build-out includes adding it to the canonical sink's contract (§2.1) and threading a request-scoped id through API → RPC → audit row, so one operator action spanning multiple writes can be reconstructed as one event. Not built by A1.

## 5. Canonical security-event structure (design only — `REG-07` resolved)

**Resolved:** one canonical, `domain`-classified security-event structure, not an FDH-only or AI-only system — binding Product Owner ruling, no technical evidence found that would justify a domain-siloed exception.

### 5.1 Event-class taxonomy

| Class | Example today | Notes |
|---|---|---|
| Business audit event | A role assignment, a source suspension | Goes to the domain audit table (§2), not this stream |
| Authorization denial | `requireAdmin()`'s 403, `canManageResources()`'s 403 | `AUTHZ_DENIED`, low severity unless repeated |
| Suspicious repeated denial | **Does not exist** — no repeated-denial detection anywhere in this codebase (confirmed by grep) | Requires a new counter/window mechanism — not built by A1; the canonical platform is the natural place to build it |
| Privilege escalation attempt | The existing self-escalation defence in `resources/users/roles` (a non-`canManageResources()` caller gets 403 before any role read/write) | Currently indistinguishable from an ordinary denial; the canonical stream would flag it as a distinct, higher-severity `event_type` |
| Raw-data access attempt | N/A — no raw-data-shaped surface exists yet | Reserved for when Analytics/FDH support-access are real |
| Export event | N/A — no export route exists yet | Reserved |
| Kill-switch action | `ai/kill-switch` | Already has `ai_operational_events`; would feed the canonical stream as `event_type: KILL_SWITCH, domain: ai` |
| Break-glass event | N/A | Reserved; explicitly not built until `A1_14`/Wave F |
| Validation failure | Every `422` | Low-severity, high-volume; should not alert by default |
| Infrastructure failure | Every `500` from `adminRoute()`'s catch-all | The canonical design must not let a raw `error.message` reach `safe_metadata` unfiltered — a concrete instance of this risk (`bad(error.message)` used verbatim in several Benchmarks routes) is a known, disclosed, unfixed residual (D5-13/PO5-6, `A1_02` §2) |

### 5.2 Contract fields

`severity` (`info`/`warning`/`high`/`critical`) · `actor` (same trusted-actor discipline as the audit sink) · `source` (`api`/`rpc`/`background`) · `domain` · `event_type` · `target` (nullable) · `result` · `correlation_id` · `safe_metadata` (explicit allow-list, never a raw error object or request body) · `retention_classification` · `alerting_eligibility` (boolean — most validation failures should not page anyone) · `redaction_requirements` (no secrets, no raw documents, no transaction descriptions, no unnecessary personal financial data — restating Standard §9/§7).

## 6. What A1 builds vs. defers

A1 **defines** both structures completely (this document). A1 **does not create either table**, does not migrate any existing table, does not implement `correlation_id` threading, and does not build repeated-denial detection. All of that is A1.3's own bounded implementation scope, sequenced in `A1_20`.
