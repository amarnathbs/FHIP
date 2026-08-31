# Module 11.1 — Reuse & Gap Audit

Written **before** any implementation, per this project's standing architecture discipline
(same pattern as FDH-12's `REUSE_AND_GAP_AUDIT.md`). Every claim below was verified by
reading the actual file/migration named; nothing here is assumed from naming.

Base: worktree `D:/fhip-module11-1`, branch `feature/module-11-1-premium-entitlements`,
forked from `feature/module-11-0-ai-foundation` @ `a16cb5e`.

---

## 1. Plan tier / entitlement — REUSE, do not re-invent

| Thing | Where it really is | Verdict |
|---|---|---|
| `PlanTier` type | `lib/services/entitlements.ts` — `export type PlanTier = 'free' \| 'premium'` | **REUSE** |
| `getPlanTier(userId, client?)` | `lib/services/entitlements.ts` | **REUSE** (see gap G1) |
| Storage | `user_entitlements` (migration `0010_module9_reports.sql:13-41`): `user_id uuid unique`, `plan_tier text not null default 'free' check (plan_tier in ('free','premium'))`, `effective_from date`, `effective_to date` | **REUSE** |
| RLS on it | one policy only: `"own entitlement" ... for select using (auth.uid() = user_id)`. **No INSERT/UPDATE/DELETE policy** → a user can never write their own tier. | **REUSE as-is** — already correct for our threat model |
| Row creation | trigger `on_auth_user_created_entitlement` → `handle_new_user_entitlement()` inserts `('free')` for every new `auth.users` row | **REUSE** |

There is exactly **one** definition of "is this user Premium" in this codebase and Module 11.1
does not add a second. The only tier literals in the system are `'free'` and `'premium'`.

**Confusables deliberately NOT used as entitlements:** `ai_model_registry.internal_tier`
(`LOW_COST`/`STANDARD`/`ADVANCED` — an LLM cost tier), `action_recommendation_master.is_premium`
(editorial content metadata), `benchmark_cohorts.cohort_tier` (an int band).

### Gap G1 — `getPlanTier()` fails **open** to `'free'`
```ts
return (data?.plan_tier as PlanTier) ?? 'free';
```
The `error` is destructured away. A transport failure, an RLS surprise, or a missing row all
yield `'free'`. For report exports that is a safe default (deny). For Module 11.1 it is still
"deny custom AI", but it is **not** an explicit fail-closed decision, and it cannot distinguish
"genuinely free" from "could not determine". Module 11.1 therefore does **not** call
`getPlanTier()` on the enforcement path. It reads `user_entitlements` inside the enforcement
RPC and treats *no row / unreadable* as an explicit `entitlement_unknown` denial. `getPlanTier()`
is left untouched for its existing Module 9 callers.

---

## 2. Billing cycle / subscription period — DOES NOT EXIST

Verified absent across all 110 migrations and all of `lib/`, `app/`:
`current_period_start`, `current_period_end`, `billing_cycle_anchor`, `trial_end`,
`cancel_at`, `price_id`, `customer_id`, any `subscriptions` table, and any Stripe / Paddle /
Razorpay / LemonSqueezy integration. (The only `stripe`/`razorpay` string hits are FDH-2
*merchant reference data* — payment processors as merchant names.)
`user_entitlements.effective_from` / `effective_to` exist but are **written by nothing and read
by nothing** — inert columns.

### The one real monthly-boundary concept that DOES exist
`ai_usage_ledger.billing_period text not null -- 'YYYY-MM'` (migration `0110`), produced by
`currentBillingPeriod()` in `lib/ai/audit/aiRuns.ts:96` as **UTC calendar month**.

**Decision:** Module 11.1 reuses that exact concept rather than inventing a second one, and
isolates it behind a single DB function `ai_billing_period_for(user_id, at)` so that when a real
subscription anchor arrives, one function body changes and no call site does.
**Honest limitation, carried forward:** "billing month" is the UTC calendar month, not a
per-subscriber anniversary, because no subscriber anniversary exists to anchor to.

---

## 3. Module 11.0 AI infrastructure — REUSE

| Thing | Where | Verdict |
|---|---|---|
| `AIModelGateway` | `lib/ai/gateway/aiModelGateway.ts` — the only `provider.generateStructured()` call site in the codebase (line 79) | **REUSE — enforcement gate inserted at line 76**, after the free local certification gates, immediately before the provider call |
| Pre-provider gate idiom | three inline `if` blocks at `:67`, `:70`, `:73`, each returning `this.reject(...)` which writes an audited `ai_runs` row | **REUSE the idiom** — a 4th inline gate, not a new middleware concept |
| `AIProvider.estimateCost(in, out, model)` | `lib/ai/providers/types.ts:78`; real impl `lib/ai/providers/openaiProvider.ts:56` | **REUSE** (see gap G2) |
| `AIModelGateway.estimateUsage(sys, user, model)` | `:45` — pure, no network | **REUSE** as the pre-flight cost projection feeding the cost ceilings |
| `ai_usage_ledger` | `0110:156-179`, unique `(user_id, billing_period, task_type, provider, model)`, RLS SELECT-own only | **REUSE — becomes authoritative** (see gap G3) |
| `ai_answer_cache` | `0110:181-203`, lookup index `(user_id, intent_code, normalised_question_hash) where invalidated_at is null` | **REUSE the schema**; 11.1 adds only the server-side lookup helper needed to make "cache hit" a *derived* fact rather than a caller assertion |
| `recordAiRun()` | `lib/ai/audit/aiRuns.ts:45` | **REUSE** |
| `ExecutionStatus` union + DB CHECK | `aiRuns.ts:12` and `0110:146-148` | **EXTEND** by one value, `rejected_entitlement` (ADR-M11-001 decision #8 requires every gateway invocation, including a rejection, to write an `ai_runs` row — so a rejection needs a truthful status; reusing `blocked_safety` or `rejected_certification` would be a lie in the audit log) |
| Fail-closed idiom | `certificationService.ts` `cert(...)` ladders; `safety/policy.ts:41` unknown→deny | **MIRROR the style** |
| PGlite harness | `scripts/db-rebuild-check/module11_ai_foundation_cert.mjs` — full `0001..NNNN` rebuild, `shim.sql`, `asTenant/asAnon/asService` with a vacuity assertion on `auth.uid()` | **REUSE the harness pattern** for the 11.1 cert script |

### Gap G2 — cost estimation is a single hardcoded price, not registry-driven
`lib/ai/providers/openaiProvider.ts:20-22`:
```ts
const INDICATIVE_PRICING_PER_1K = { default: { input: 0.15, output: 0.6 } };
```
The map has exactly one key, so **every** model id falls through to `default`.
Meanwhile `ai_model_registry.cost_input_per_1k_usd` / `cost_output_per_1k_usd` exist
(`numeric(10,6)`) and are read by nobody.

**Decision:** 11.1 wires registry pricing into the cost path (`registryCostEstimate()`),
falling back to the provider's own estimator when the registry has no price. Cost figures are
therefore *as accurate as the price rows an admin has entered* — this is stated as a limitation,
not papered over. The mock provider's price is a genuine `0`, so the mock path's cost is
genuinely, not approximately, zero.

### Gap G3 — `upsertUsageLedger()` is a racy read-modify-write
`lib/ai/audit/aiRuns.ts:120-164` does `SELECT` → then `INSERT` or `UPDATE` with values computed
from the stale read. Two concurrent runs in the same billing period can (a) both miss and race
the `unique` constraint, or (b) lose a token/cost increment. In 11.0 that was a pure accounting
inaccuracy. In 11.1 the same table becomes the **quota and cost-ceiling source of truth**, so a
lost update becomes a correctness defect in enforcement.

**Decision:** fix it — replace the RMW with an atomic `insert … on conflict … do update set
col = table.col + excluded.col` RPC. This is a disclosed modification to Module 11.0 code,
made because it is genuinely necessary for the ledger to be authoritative.

---

## 4. Feature flag / kill switch — DOES NOT EXIST

No `feature_flags`, `app_config`, `app_settings`, `system_settings`, `admin_config` table exists
in any migration. There is **no Next.js `middleware.ts` in this project at all**.
The only precedent is env-var + compiled constant:
`lib/financial-data-hub/constants/featureFlags.ts` — `isFdhDocumentUploadEnabled()` =
`process.env.FDH_DOCUMENT_UPLOAD_ENABLED !== 'false'` **AND** a hardcoded Supabase project-ref
allowlist.

That precedent is explicitly **unsuitable** for this requirement: the brief requires a switch
that is "genuinely fast and independent of code deploy", and an env var on Amplify requires a
redeploy. The nearest DB-backed governance precedent is `ai_model_registry.active/approved`
(admin-flippable rows, RLS-enabled with zero policies, reachable only via `requireAdmin()` +
service role).

**Decision:** new singleton table `ai_platform_controls`, read fresh inside the enforcement RPC
on **every** request — no cache, no TTL, no compiled constant. Flipping one boolean stops all
custom-AI processing platform-wide with the latency of one row read.

---

## 5. Rate limiting — NO GENERAL MECHANISM EXISTS

No Upstash, no Redis, no `@upstash/ratelimit`, no middleware limiter, no rate-limit table.
Two hand-rolled FDH-local limiters exist and establish the house pattern — *count rows in a
rolling window over an existing table's `created_at`*:
- `lib/financial-data-hub/services/uploadLifecycle.ts:63-71` — `MAX_UPLOAD_SESSIONS_PER_HOUR = 20`
- `lib/financial-data-hub/bank-pdf/password.ts:50` — `MAX_PASSWORD_ATTEMPTS_PER_DOCUMENT_PER_HOUR = 8`

Both count **in application code after a `SELECT`**, i.e. check-then-act.

**Decision:** follow the *shape* (rolling window over `created_at`) but not the *placement* —
the count happens inside the same enforcement RPC, under the same per-user advisory lock as the
quota decision, so the limiter cannot race the quota consumer. Window size and ceiling are rows
in `ai_platform_controls`, not constants, so they are tunable without a deploy.

---

## 6. Server-side auth & admin — REUSE

- `requireUser()` → `lib/api.ts`; `createClient()` → `lib/supabase/server.ts`;
  `createAdminClient()` → `lib/supabase/admin.ts`.
- `requireAdmin()` / `adminClient()` / `adminRoute()` → `lib/services/adminAuth.ts`,
  gating on the `admin_users` table. Every `app/api/admin/ai/*` route already uses it.

**Decision:** the kill switch and the cost/limit configuration are exposed through
`app/api/admin/ai/controls` and `app/api/admin/ai/cost-limits`, built exactly like the existing
`app/api/admin/ai/models/route.ts`. No new auth concept.

---

## 7. Net new surface introduced by Module 11.1

Everything else above is reuse. Genuinely new:

| New thing | Why nothing existing could serve |
|---|---|
| `ai_platform_controls` (singleton) | §4 — no config/flag table exists anywhere |
| `ai_task_cost_limits` | no per-task or per-model cost ceiling concept exists |
| `ai_admission_events` | rate limiting needs per-attempt timestamps; `ai_usage_ledger` is aggregated (no timestamps) and `ai_runs` is written *after* the provider call, so neither can gate one |
| `ai_usage_ledger.custom_question_count` / `.refunded_question_count` | the ledger counts calls and tokens, but has no notion of a *quota-consuming user question* |
| `ai_admit_request()` RPC | §3/§5 — the check and the consume must be one transaction |
| `ai_refund_admission()` RPC | a provider outage must not silently eat a user's monthly allowance |
| `ai_usage_ledger_accumulate()` RPC | gap G3 |
| `ai_billing_period_for()` | §2 — one seam for a future subscription anchor |
| `execution_status = 'rejected_entitlement'` | ADR-M11-001 #8 requires a truthful audited status |

## 8. Explicitly NOT built in Module 11.1

No user-facing AI chat, no "Ask AI" page, no chat UI, no client component, no nav entry,
no Insight Pack, no insight/recommendation generator, no live provider activation
(`OpenAIProviderAdapter.generateStructured()` still throws unconditionally), no prompt
activation (all 12 seeded prompts stay `DRAFT`).

---

# Part 2 addendum — full-specification pass

Written when the Product Owner issued the fuller 89-section Module 11.1
specification. Every discovery finding above was **re-verified fresh against
current `origin/main` (`2ade18b`)** rather than carried forward on trust; the
results are unchanged, and the evidence is restated below so the claim is
checkable rather than asserted.

## Discovery re-verification (spec sections 4, 10, 11)

| Question the spec asks | Answer, and how it was re-checked |
|---|---|
| Canonical subscription table/service | `user_entitlements` (migration `0010_module9_reports.sql`), read via `lib/services/entitlements.ts`. `git grep -nE "plan_tier" origin/main -- lib app` returns **exactly two lines**, both in that one file. |
| How Premium is determined | `plan_tier = 'premium'`. The column is `CHECK`-constrained to `('free','premium')` — verified by reading the constraint on `origin/main`. |
| Billing provider | **None.** `git grep -lEi "current_period_end\|billing_cycle_anchor\|stripe_customer\|subscription_status\|trial_end" origin/main -- lib app supabase` returns **zero files**. No Stripe/Paddle/Razorpay/LemonSqueezy integration, no `subscriptions` table. |
| Billing-cycle dates | None exist. The only monthly boundary is `ai_usage_ledger.billing_period` (UTC calendar month), isolated behind `ai_billing_period_for()`. |
| Trial / grace / past-due state | **Not representable.** The `plan_tier` CHECK admits two values. The certification proves this by attempting to set all ten of the spec's named states and confirming every one is rejected — so no policy was invented for states that cannot occur. |
| Cancellation-at-period-end / expiry | `user_entitlements.effective_from` / `effective_to` (present since `0010`). Part 1 correctly reported these as **written by nothing and read by nothing**. Part 2 now **reads** them, which is what makes spec section 10's `EXPIRED` and `CANCEL_AT_PERIOD_END` cases genuinely enforceable rather than merely unrepresentable. Disclosed behaviour change: nothing writes `effective_to` today and it defaults to NULL, so no existing row changes behaviour. |
| Household or individual ownership | **Individual.** `user_entitlements.user_id` is `UNIQUE`. `households.user_id` means a household is owned by exactly one user, and `household_members` rows carry `full_name` / `relationship` / `date_of_birth` — they are **not** authenticated accounts. There is therefore no mechanism for two authenticated adults to share one household, and the "multiple adults share a household" case the spec raises does not arise in this schema. |
| Quota multiplication by switching household id | Impossible: the ledger, the rate-limit window and the concurrency lease are all keyed on `user_id`. `household_id` is recorded as a descriptive attribute and no decision reads it. Certified directly (a Free subject supplying a Premium household id is still refused, and the Premium subject's ledger is untouched). |
| Feature flags / admin configuration | Still none outside Module 11. `ai_platform_controls` (Part 1) plus `ai_provider_controls` (Part 2) remain the only DB-backed AI configuration. |

## Additional gaps found in the Part 2 pass

### Gap G4 — the model tier was a trusted input
Part 1 checked the task's tier cap against the caller's declared
`p_internal_tier`. Because Part 2 looks the model up anyway for the section 32
disable check, the registry's own `internal_tier` is now authoritative and the
parameter is used only where no registry row applies. Certified: declaring
`LOW_COST` for a model the registry holds as `ADVANCED` no longer bypasses the
cap.

### Gap G5 — no reservation state, so "in progress" was unanswerable
Part 1's consume-then-refund lifecycle was behaviourally correct but left the
in-flight state invisible, which is precisely what section 18's concurrency
limit needs. `execution_state` + a lease closes it, and the lease (rather than
an unbounded lock) means a server that dies mid-flight cannot bar a subject
from their own allowance forever.

### Gap G6 — `ai_safety_events` is the wrong home for commercial events
Its `event_type` CHECK is Module 11.0's **safety** vocabulary (prompt
injection, advice-boundary violation, privacy). Section 38 asks for severity
"appropriate to actual operational risk", which is a different scale, and
section 27's soft threshold fires on an **allowed** request with no denial row
to attach to. Hence `ai_operational_events` rather than widening the safety
table and blurring a security signal into a billing signal.

## Section 43 — shared dashboard summary optimisation: DEFERRED

Section 43 is explicit that "performance improvement is not a condition for
FULL PASS" and that the work should be **deferred** if safe reuse would require
touching stable Module 1-10 internals beyond a small backward-compatible
optional dependency injection.

It would. The Score, DNA and Resilience loaders each acquire their own
Dashboard data internally rather than accepting an already-derived summary, so
threading one canonical summary through would mean changing the signatures of
Module 1-10 service functions that Modules 1-10 also call. Section 77 forbids
that contamination, and section 87 makes a Modules 1-10 calculation regression
an automatic FAIL. The redundant fetch is a **read-side cost only** — it
changes no number anywhere — and Module 11.1 adds no new AI context
construction, so the situation is exactly as Module 11.0 disclosed it and no
worse. **Deferred, with the reason recorded, per section 43's own instruction.**
