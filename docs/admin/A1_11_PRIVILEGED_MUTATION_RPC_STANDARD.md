# A1.3 — Privileged-Mutation and RPC Standard

**PO-4: APPROVED** — the Product Owner has approved this document's standard: authenticated invocation with authorization inside the RPC using trusted identity context is the preferred pattern (Pattern A, §1); a service-role-only RPC is an approved exception only when every one of the conditions in §3/§6 is met, including that the exception and its justification are recorded in an RPC register (§8, new). PO-4 also explicitly reconfirms, verbatim: "Do not pretend `auth.uid()` provides meaningful end-user authorization when the database sees only a service-role invocation" — restated here as a binding rule, not merely A1's own prior reasoning. **This resolves, permanently, the auth.uid()-vs-service-role tension this document's §6 previously flagged as an open brief question** — it is no longer open anywhere in the A1 document set.

This document names the patterns this codebase has **already established** (traced from actual migrations, not invented) and resolves the one open question the brief flags explicitly: whether internal `auth.uid()` checks are mandatory even for `service_role`-granted RPCs.

## 1. Pattern A — atomic mutation + mandatory audit

**Definition:** a single `SECURITY DEFINER` function that (a) derives the actor from `auth.uid()` internally, never a caller-supplied identity, (b) fails closed with an explicit exception on a null/unauthorized actor, (c) performs its business mutation and its audit-table insert(s) in the **same transaction**, so an audit-write failure rolls back the mutation, and (d) has `search_path` fixed and schema-qualified references throughout.

**Established exemplars (traced from source, exact SQL confirmed):**

- **`transition_resource_post_status`** (originally migration `0033`/`0049`, extended `0116`) — `v_actor := auth.uid()`, `raise exception` on null actor, then a role/compliance-matrix check, then the status UPDATE, then **two** audit inserts (`resource_workflow_history` + `resource_audit_log`) in the same function body.
- **`admin_reorder_related_content`** (migration `0116`) — `auth.uid()`-derived actor, `raise exception ... using errcode = '42501'` on null actor or missing `canManageDiscovery`, advisory lock + one atomic `UPDATE ... FROM unnest() WITH ORDINALITY`. **`service_role` is explicitly `REVOKE`d** for this one — its own migration comment states why: *"This RPC is not a service boundary: it takes its identity from auth.uid(), which a service_role connection does not carry, so a service_role call could only ever fail closed at the authentication guard above."* No audit-table write (a pure permutation has no separate "before/after" state worth a row).
- **`admin_transition_benchmark_source`** (migration `0125`, built specifically because Wave 4 Round 1's plain API-route implementation — mutate-then-audit-non-atomically, silently swallowing an audit-insert failure — was rejected by the Product Owner) — `auth.uid()`-derived actor, internal `admin_users` recheck, row-locked (`FOR UPDATE`) read of the prior status, idempotent no-op on same-status, then the status UPDATE and the `benchmark_update_runs` INSERT in the same function invocation with no exception handler between them. **Live-proven, not merely asserted**: a forced audit-INSERT constraint failure rolls back the already-executed status UPDATE (zero orphan state), then a retried identical transition succeeds with exactly one audit row.

**When to use:** any Admin mutation with meaningful before/after state that must never exist without its audit trail — this is the default pattern for every new privileged write.

## 2. Pattern B — read-only privileged aggregation

**Definition:** a `SECURITY DEFINER` function used purely to read data the caller cannot safely read directly (e.g. an aggregate across users), never to mutate. Per Standard §6, must still carry: internal `auth.uid()` authorization, a fixed return type, an output-column allow-list, a filter/grouping allow-list, no dynamic SQL from caller input, and suppression evaluated inside the function (Standard §7/§8), not the caller.

**Current state:** **no Pattern B aggregation RPC exists in this codebase today.** Every "B" label used informally in prior waves' registers (`admin_upsert_recommendation_atomic`, `admin_import_recommendation_conditions`) actually describes a **different** approved shape — see §3 below, renamed here to avoid confusion with the brief's own Pattern B definition (read-only aggregation). A1 reserves "Pattern B" strictly for the read-only aggregation shape going forward; the two Recommendations RPCs are reclassified as their own named exception (§3).

## 3. The Recommendations RPCs — a named, bounded service-boundary exception (not Pattern A, not Pattern B)

`admin_upsert_recommendation_atomic` and `admin_import_recommendation_conditions` (migrations `0107`/`0109`) are **mutating**, all-or-nothing RPCs **not directly callable by `authenticated`** — they exist behind a server-only API-route boundary, approved as an exception at the time (Wave 1/1B). They are atomic (single RPC call, all-or-nothing) and audited (`AUDITED_COMPLETE`, RPC-internal / `logResourceAudit`), but they do not fit Pattern A's shape (no direct `authenticated` EXECUTE grant) or Pattern B's (they mutate). **This exception is not reopened by A1** — recorded here, under its own name (**"Pattern S — server-boundary exception"**), rather than mislabelled as A or B, so a future implementer does not copy its access-grant shape for a new RPC that should actually be Pattern A.

## 4. Pattern C — controlled idempotent operational action

**Definition:** an operational control (e.g. a kill switch) that must be safely callable more than once with the same net effect, is logged with a mandatory reason, and does not require the broader configuration-management capability its domain otherwise uses.

**Current exemplar:** `ai/kill-switch` (Module 11.1) — already has a dedicated `ai_operational_events` log and a mandatory reason field, exceeding the baseline audit bar. **Known deviation, not fixed by A1:** it is gated by the same broad `requireAdmin()` as every other AI Admin route rather than a distinct `canOperateAiKillSwitch` capability — Standard §2 requires an emergency-stop capability to be independently named specifically so it doesn't require constructing a correct partial-update body under pressure to reach it (the route's own header comment already makes this argument for why it's a separate *capability* in spirit; it just isn't coded as one yet). Flagged for `A1_20` (A2/A3 candidate) and shared explicitly with the future `canOperateFdhKillSwitch` (CAP-24) design so both land on one real capability shape, not two bespoke ones.

## 5. Pattern D — consented, time-limited support access

**Definition:** purpose-bound, narrowly-scoped, named-operator, time-limited, auto-expiring, fully-audited access to otherwise-inaccessible sensitive data.

**Current state: does not exist anywhere in this codebase.** Full design: `A1_14`.

## 6. Resolved: is internal `auth.uid()` mandatory even for `service_role`-granted RPCs?

**Yes — resolved by this codebase's own existing precedent, not invented here.** All three Pattern A RPCs derive their actor from `auth.uid()` internally and fail closed regardless of whether `service_role` also holds an EXECUTE grant; `service_role` grants control *who may call the function*, never *whose identity the function acts as*. `admin_reorder_related_content`'s own migration comment states the corollary directly: because it takes its identity from `auth.uid()`, a `service_role` connection (which carries no `auth.uid()` context) "could only ever fail closed at the authentication guard" — which is exactly why that specific RPC revokes the `service_role` grant entirely, since granting it would be pointless, not because the auth.uid() check is optional for service-role callers. Pattern S (§3) is the only approved exception, and it is narrowly scoped to server-only bulk-import architecture by explicit Product Owner ruling — it is not a general license to skip the internal identity check, and no future RPC may be Pattern S "by default."

**Binding rule for every future privileged RPC (Pattern A, B, C, D, or any new pattern):** internal `auth.uid()` derivation and fail-closed behavior on a null/unauthorized actor is **mandatory**, independent of which database roles hold an EXECUTE grant. A Pattern S-style server-only exception requires the same explicit, scoped Product Owner approval Wave 1/1B originally received — it is never a default.

## 7. Application to future FDH-13 RPCs

`canApproveFdhMasterData`'s eventual RPC (ADM-33) is **Pattern A**, per REG-01's own resolved design: the `proposer_id != approver_id` segregation check must be evaluated inside the same `SECURITY DEFINER` transaction that performs the approval, using `auth.uid()`-derived identity, exactly matching `admin_transition_benchmark_source`'s shape (row-lock, before-state read, mutation, audit-insert, no exception handler between them). No new pattern is needed — Wave B inherits Pattern A wholesale.

## 8. The RPC register (PO-4's required exception record)

PO-4 requires that every Pattern S (service-role-only) exception be recorded, with its justification, in an RPC register. **This document is that register today** — no separate artifact exists yet, and none is required before A2; a future wave may split it into a standalone, queryable register once enough entries exist that a table format inside this document stops being adequate (an A2/A3-scale decision, not an A1 one).

| RPC | Pattern | Service-role granted? | Justification recorded | PO approval |
|---|---|---|---|---|
| `admin_upsert_recommendation_atomic` (migration `0107`) | S — server-boundary exception | Yes, exclusively (no `authenticated` EXECUTE grant) | Server-only bulk-authoring architecture predates a per-user Recommendations-authoring role; no end user or lower-privileged Admin caller should ever invoke it directly | Approved at the time (Wave 1/1B); **PO-4 reconfirms the exception model itself, not this specific grant a second time** |
| `admin_import_recommendation_conditions` (migration `0109`) | S — server-boundary exception | Yes, exclusively | Same server-only bulk-import architecture as above, same justification | Approved at the time (Wave 1/1B); reconfirmed by PO-4's model, not re-approved individually |
| `transition_resource_post_status`, `admin_reorder_related_content`, `admin_transition_benchmark_source` | A — atomic mutation + audit | No (or explicitly revoked, per `admin_reorder_related_content`'s migration comment) | N/A — these are the Pattern A default, not an exception; listed here only so the register is a complete inventory of every privileged RPC this codebase has, not only its exceptions | N/A |

**Binding going forward (PO-4):** any future Pattern S RPC (FDH-13's or otherwise) must have its own row added here — service-role grant, justification, and PO approval reference — before it ships, using the same 8 conditions PO-4 names (canonical capability check first in the API, service_role-only grant, no browser-supplied identity, allow-listed/validated inputs, mutation+audit in one transaction, `SECURITY DEFINER`/fixed `search_path`/least privilege/stable error contracts, and the denial/spoofing/rollback/idempotency/concurrency test suite). No RPC may be Pattern S "by default" — this was true before PO-4 and remains true now, restated as an explicit ruling rather than A1's own inference.
