# A4 — Analytics, Privacy and Support Capabilities: Design and Status

**Scope:** this spec's A4-WP-01..50 (10 topics × 5 cycles): privacy-safe analytics, suppression/differencing defence, support-access workflow, break-glass governance, audit retention controls, security-event operations, consent/approval evidence, export parity, pseudonymization controls, privacy review workflow. Maps onto `A1_20`'s four sub-packages: **A4.1 canonical audit sink, A4.2 canonical security-event stream, A4.3 canonical suppression engine, A4.4 support/break-glass mechanism.**

`A1_20` itself flags this as "the migration-heaviest package in the whole roadmap" and "**highest [privacy risk] in the roadmap** — A4.3 is literally the first implementation of the suppression model anywhere in FHIP; a defect here is exactly the class of defect that produced the Recommendations Gap Review incident." This document's status calls are deliberately conservative for exactly that reason.

## 1. A4.1 — Canonical audit sink: IMPLEMENTED (schema only), NOT APPLIED, NOT TESTED

**What was built:** `supabase/migrations/0165_admin_a4_canonical_audit_and_security_event_sink.sql` creates `public.admin_audit_events` matching `docs/admin/A1_12_AUDIT_SECURITY_EVENT_STANDARD.md` §2.1's contract field-for-field (`event_id`, `occurred_at`, `domain`, `action`, `actor_id`, `actor_type`, `effective_capabilities`, `target_type`, `target_id`, `before_state`/`after_state`, `reason`, `result`, `correlation_id`, `jurisdiction`, `privacy_classification`, `pseudonymous_subject_ref`, `supersedes_event_id`/`reverses_event_id`, `metadata`), with:
- RLS enabled, zero policies, `REVOKE ALL` from `public`/`anon`/`authenticated`, `GRANT SELECT, INSERT` to `service_role` only (Standard §6: "never a bare view, never a directly-grantable table").
- An unconditional `BEFORE UPDATE OR DELETE` immutability trigger, copied from the proven `benchmark_update_runs_immutable()` / `ai_config_audit_immutable()` pattern (migrations `0125`/`0115`) — fires regardless of caller, including `service_role` and the table owner.
- Indexes on `(domain, occurred_at)`, `actor_id`, `correlation_id`, `(target_type, target_id)`.

**What was deliberately NOT built in this pass** (see the migration's own closing comment block for the full list): no write RPC, no read RPC (CAP-33 `canViewAdminAuditLog` is still "Proposed", zero holders), no dual-write from any existing domain table, no `correlation_id` threading through any real call site. Each of these is a distinct, reviewable piece of work in its own right — Standard §6 requires a privileged RPC's authorization, output-column allow-list, and `search_path` hardening to be reviewed as a unit, and building one under this dispatch's remaining time budget without live-DEV testing would risk exactly the kind of "code exists, never verified" outcome this repository's own history (see `MEMORY.md`'s repeated "self-reported FULL PASS downgraded on review" pattern) explicitly warns against.

**Status: schema IMPLEMENTED (unapplied, unreviewed-by-second-party). RPC layer NOT STARTED. Migration NOT applied to DEV or production — requires explicit Product Owner authorization, per this programme's own non-negotiable close.**

## 2. A4.2 — Canonical security-event stream: IMPLEMENTED (schema only), NOT APPLIED, NOT TESTED

Same migration file creates `public.admin_security_events` matching `A1_12` §5.2's contract (`severity`, `actor_id`/`actor_type`, `source`, `domain`, `event_type`, `target`, `result`, `correlation_id`, `safe_metadata`, `retention_classification`, `alerting_eligibility`), same RLS/grant/immutability posture as A4.1.

**Deliberately not built:** repeated-denial detection and privilege-escalation-attempt distinction — `A1_12` §5.1 confirms neither exists anywhere in this codebase today ("Does not exist — no repeated-denial detection anywhere in this codebase (confirmed by grep)"), and building genuinely new detection logic (a counter/window mechanism) untested against live traffic patterns is precisely the kind of work this dispatch should not fabricate confidence in. `event_type` is intentionally left as unconstrained `text` rather than a `check` enum, so this table can start recording once detection logic exists without needing a follow-up migration for every new event type.

**Status: schema IMPLEMENTED (unapplied). Detection logic NOT STARTED. Migration NOT applied.**

## 3. A4.3 — Canonical suppression engine: NOT STARTED (design boundary already existed, no engine code written)

`docs/admin/A1_15_ANALYTICS_SUPPRESSION_STANDARD.md` fully specifies the required model (minimum cell 5 / minimum distinct people 10 / minimum evaluation runs 20; complementary suppression; repeated-filter and differencing resistance; no individual drill-down; no exact pseudonymous financial profiles; rounding/banding; keyed-HMAC pseudonymization; identical protection across SQL/API/UI/export; privacy review before any new dimension/export). This dispatch did not write any suppression RPC or engine code, for three concrete reasons:

1. **No real cohort exists to test against.** Standard §7.2's own thresholds are explicitly "starting controls... require pre-production revalidation against real data distributions" — writing suppression logic with no live data to validate it against would produce code whose correctness cannot actually be demonstrated, only asserted.
2. **This is named as the single highest-privacy-risk item in the entire A2–A5 programme** (`A1_20`, verbatim). Standard §6's own completion bar for a privileged RPC includes "an explicit inference/reconstruction assessment before the RPC is considered complete" (§8) — that assessment requires the adversarial test vectors in `A1_15` §3 (repeated-filter reconstruction, cross-metric/cross-RPC reconstruction, differencing) to actually be run against real query paths, which needs a live database.
3. **Recommendations Gap Review's own history is the direct warning.** `A1_15` §1: "The one Admin feature that ever exposed individual-level data (Recommendations Gap Review) was withdrawn entirely rather than given a first, feature-specific suppression implementation." Shipping a first-draft, unverified suppression engine in this pass would repeat exactly the risk pattern that incident exists to warn against.

**Status: NOT STARTED.** Recommended next step for a follow-up pass with live-DEV access: build the RPC against `A1_15`'s already-approved contract, then run the full adversarial suite (`A1_15` §3 / this spec's ADV-06) before considering any part of it complete.

## 4. A4.4 — Support/break-glass mechanism: NOT STARTED (design already existed, no code written)

`docs/admin/A1_14_SUPPORT_BREAK_GLASS_ARCHITECTURE.md` fully specifies both mechanisms (12 PO-6-approved required properties, 60-minute default grant expiry, independent-approver requirement for sensitive access, no-reuse-across-users-or-incidents, break-glass emergency-only with immediate immutable logging + alert + auto-expiry + mandatory after-action review, structural DB-level separation from audit-editing capability). No table, RPC, route, or role exists yet anywhere in this repository for either mechanism (confirmed by `A1_14` §"Status" itself, and by direct code search finding no `support_access_grants`-shaped table).

This dispatch did not build it, for the same class of reason as A4.3: `A1_20` names A4.4's authorization risk as "High... a new access-grant mechanism is a new attack surface almost by definition", and Standard §6/§4's negative-test requirements (direct-URL test, direct-API test, database-bypass test for every capability) cannot be meaningfully executed without live-DEV credentials, which this environment does not have. Building an unverified access-grant mechanism — the exact class of feature ADV-09/ADV-10 (support grant reuse/expiry bypass; break-glass without alert or review) exist to adversarially probe — and leaving its own adversarial probes untested would be a worse outcome than leaving it explicitly NOT STARTED.

**Status: NOT STARTED.**

## 5. A4 cross-cutting topics not covered above

- **Export parity** (A4-WP topic) — no new export surface was built this pass (A4.3/4.4 are NOT STARTED, and no existing export route was touched), so there is nothing new to certify for export parity. The existing Standard §11 export requirements for whatever CSV/PDF export routes already exist in Resources/Benchmarks are unchanged by this dispatch.
- **Consent and approval evidence** — same: no new consent-capturing flow was built (A4.4 NOT STARTED), so there is no new evidence to produce.
- **Pseudonymization controls** — `A1_15`'s keyed-HMAC design is fully specified but has zero implementation anywhere in this codebase (confirmed by `REG-10`/`A1_13` §2 rule 6's own "reconfirms" language, which only reconfirms a *rule*, not an implementation). NOT STARTED.
- **Privacy review workflow** — no formal PIA/privacy-notice-review/legal-review process was run for A4.1/4.2's schema-only work (Standard §10 requires this specifically for telemetry/behavioural instrumentation, which A4.1/4.2 do not yet perform — they only define storage, not collection). A full privacy review is required before A4.3/4.4's actual implementation begins, per Standard §9/§10, and is correctly deferred alongside them.

## 6. Summary status table

| A4 sub-package | Schema/design | RPC/logic | Live-tested | Applied |
|---|---|---|---|---|
| A4.1 Canonical audit sink | IMPLEMENTED (migration `0165`) | NOT STARTED | NOT STARTED | NOT APPLIED |
| A4.2 Canonical security-event stream | IMPLEMENTED (migration `0165`) | NOT STARTED | NOT STARTED | NOT APPLIED |
| A4.3 Canonical suppression engine | Already existed (`A1_15`) | NOT STARTED | NOT STARTED | N/A |
| A4.4 Support/break-glass mechanism | Already existed (`A1_14`) | NOT STARTED | NOT STARTED | N/A |

**Overall A4 verdict: NOT STARTED (implementation), with A4.1/4.2's schema layer newly drafted and ready for a future pass to build the RPC layer against.** This is consistent with, not a shortfall against, this dispatch's own honesty mandate (Programme Charter 9) — A4 was always going to be the largest single package in the roadmap (`A1_20`'s own words), and building its two highest-risk pieces (A4.3/4.4) without live verification capability would have produced exactly the kind of unverified "FULL PASS" claim this repository's history explicitly warns against.
