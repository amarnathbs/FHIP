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
