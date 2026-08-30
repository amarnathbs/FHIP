# Module 11.1 — Premium Entitlement, Monthly Quotas, Rate Limits, Cost Controls & AI Kill Switches
## Completion Report

**Worktree** `D:/fhip-module11-1` · **Branch** `feature/module-11-1-premium-entitlements`
(forked from `feature/module-11-0-ai-foundation` @ `a16cb5e`, **not** from `origin/main`)
**Migration** `0115_module11_1_ai_entitlements_quotas_cost_controls.sql` — **NOT applied anywhere.**
**Not merged, not pushed, no DEV or production access used.**

---

## A. What was built

Module 11.0 shipped ten AI governance tables and enforced nothing:
`ai_usage_ledger` accumulated counts and, in its own completion report's words,
"nothing reads it to block or allow a request". ADR-M11-001 decision #15 deferred
"enforcement, an allowance, and a kill switch" to Module 11.1. That is exactly and only
what this phase closes.

| Requirement | How it is enforced |
|---|---|
| Premium-only access | The RPC reads the **existing** `user_entitlements.plan_tier`. No second definition of "Premium" was created. |
| 10 custom questions / billing month, no rollover | `ai_usage_ledger.custom_question_count`, counted per `billing_period`. No rollover is structural: period N's unused allowance is simply not visible when counting period N+1. |
| Cached answers don't consume quota | `cache_hit = true` suppresses consumption and increments `cached_answer_count` instead (a counter Module 11.0 declared but never incremented). |
| Standard personalised questions don't consume quota | Two request classes, `'custom'` (metered) and `'standard'` (not metered), declared by the caller with **no default**. |
| Ledger is authoritative | Quota is read as `sum(custom_question_count)` **from `ai_usage_ledger` itself** — there is no independent counter that could drift from it. |
| Rate limiting | Rolling window over `ai_admission_events.created_at`, independent of the monthly quota, configurable without a deploy. |
| Per-user cost ceiling | `sum(estimated_cost_usd)` for the user this period, checked independently of the question count. |
| Platform-wide cost ceiling | The same sum across **all** users. Exact, not approximate (see the platform lock, §C). |
| Custom-chat kill switch | `ai_platform_controls.custom_ai_enabled`, read **fresh inside the request transaction** — no cache, no TTL, no deploy. Plus a broader `ai_globally_enabled`. |
| Model/task cost limits | `ai_task_cost_limits`: a per-request money cap **and** a `max_internal_tier` cap, so a cheap task cannot run on an ADVANCED model without an admin explicitly raising that row. |
| Server-side only | Every check is inside a `SECURITY DEFINER` RPC whose EXECUTE is granted to `service_role` alone. No client input is trusted anywhere in the decision. |

### Architecture

One RPC makes the whole decision, in one transaction:

```
AIModelGateway.generateExplanation()
  1. no model?  no ACTIVE prompt?  context UNAVAILABLE/INVALID?   -> reject (free, local, no quota burned)
  2. project cost from the model registry's own per-model prices
  3. ai_admit_request(...)                                        <-- THE gate
       advisory lock: platform key, then user key (fixed order, no deadlock)
       0 input validation   1 global switch   2 kill switch   3 plan tier
       4 rate limit         5 per-request cost cap             6 model tier vs task cap
       7 task monthly cap   8 per-user monthly cap              9 platform monthly cap
      10 monthly question allowance    -> then, and only then, CONSUME
  4. provider.generateStructured()                               <-- only reachable if admitted
  5. on any failure: ai_refund_admission() returns the question (never the cost)
```

**Insertion point:** `lib/ai/gateway/aiModelGateway.ts`, immediately before the codebase's
only `provider.generateStructured()` call — so no provider call and no spend can happen
without a decision — and immediately *after* the free certification gates, so a request
that was never going to reach a provider never burns a user's allowance.

---

## B. Exact schema (migration `0115`)

### Migration-number collision scan — full evidence

Per this project's standing process (8+ historical collisions), scanned **fresh**, not assumed:

1. `git fetch origin` (completed, exit 0).
2. `git ls-tree -r` over **every** `refs/heads` **and** `refs/remotes` ref.
3. Working-tree scan of **all 47 worktrees** on disk for uncommitted/untracked `0*.sql`.

Numbers found in use anywhere: `0100 0101 0102 0103 0104 0105 0106 0107 0108 0109 0110 0111 0112 0113 0114`.
**Highest in existence anywhere = `0114`** (`0114_fdh12_retirement_provenance_guards.sql`, worktree `D:/fhip-fdh12`).
**No `0115` exists** on any branch, in any worktree, or on `origin`. → this migration is `0115`.

> Note: the repo's own `scripts/check-migration-versions.mjs` reports "next version is 0111"
> because it only sees the current branch's 101 files. That single-branch view is exactly how
> this project hit collisions before; the cross-ref scan above is the authoritative one.

### Objects created

| Object | Purpose | RLS |
|---|---|---|
| `ai_platform_controls` | Singleton (`id = 'global'`, CHECK-enforced). Both kill switches, the allowance, rate-limit window/ceiling, per-user + platform cost ceilings, global per-request cap, `standard_requires_premium`. | Enabled, **zero policies** (governance-only, matching `ai_model_registry` / `benchmark_update_runs`) |
| `ai_task_cost_limits` | Per-task, optionally per-model: `max_cost_per_request_usd`, `max_internal_tier`, `max_monthly_cost_usd`. Seeded for all 12 `AITaskType` values. Most-specific-wins, with two **partial** unique indexes (a plain `unique` would allow unlimited task-level rows, since two NULLs are distinct). | Enabled, **zero policies** |
| `ai_admission_events` | One row per decision. Supplies the rate-limit window and the enforcement audit trail. Two CHECK constraints make an incoherent row impossible. | Enabled, **SELECT-own only** |
| `ai_usage_ledger.custom_question_count` / `.refunded_question_count` | New columns, `not null default 0`, non-negative CHECKs. | Inherits 11.0's SELECT-own-only policy set, **unchanged** |
| `ai_billing_period_for(uuid, timestamptz)` | The single seam defining "this billing month". | — |
| `ai_admit_request(...)` | The atomic check-and-consume decision. | `service_role` only |
| `ai_refund_admission(uuid)` | Returns a consumed question; idempotent. | `service_role` only |
| `ai_usage_ledger_accumulate(...)` | Atomic replacement for 11.0's racy ledger writer. | `service_role` only |
| `ai_runs.execution_status` | Widened by **one** value: `'rejected_entitlement'`. The specific reason travels in the existing `error_code`, so granularity is preserved without more statuses. The old constraint is dropped **by discovered name** (0110 declared it inline, so its name is server-generated) and the migration **raises** rather than proceeding if it is not found. | — |

Additive apart from that one widened CHECK. No Module 1–10 table, column, index, policy or
row is altered. `user_entitlements` is **read** and never written or altered.

---

## C. Atomicity — and exactly what was and was not proven

**Design.** Check and consume are not two statements from application code. The whole decision
is one RPC invocation (one transaction), serialised by two transaction-scoped advisory locks
taken in a **fixed order** (platform key, then user key — so no lock-order inversion, so no
deadlock). The per-user lock is held from before the quota is read until after it is written
and committed, so a second concurrent request blocks and then re-reads a ledger that already
reflects the first. The platform lock additionally makes the platform-wide cost ceiling exact
rather than approximate.

**Proven (PGlite, real Postgres):**

- **Negative control first.** A deliberately naive two-statement implementation — a `SELECT`
  round trip then an `INSERT` round trip, dispatched concurrently exactly as application code
  would — **overspent a 10-question allowance 25/25, leaving a ledger of 25.** The harness can
  therefore genuinely detect this bug; the result below is not vacuous.
- **The real path, same fixture, same concurrency:** 25 concurrent `ai_admit_request` calls
  against a 10-question allowance admitted **exactly 10**, refused **exactly 15** for
  `quota_exhausted`, and left a ledger of **exactly 10**.
- The 10 admitted requests were issued the **10 distinct sequence numbers 1…10** — no two ever
  saw the same remaining count.
- 30 concurrent `ai_usage_ledger_accumulate` calls lost **nothing** (30 calls, 300 input tokens,
  600 output tokens, $0.030000).

**Honest limitation.** PGlite is a single-connection engine. What is proven above is that
folding the check and the consume into **one statement / one transaction** eliminates the
interleaving that demonstrably breaks the two-statement version. It does **not** exercise the
`pg_advisory_xact_lock` blocking behaviour across genuinely simultaneous backends, which needs
a multi-connection Postgres. **That specific proof is owed at live-DEV certification** and is
listed in §H.

**Known trade-off, recorded not hidden.** The platform lock serialises all AI admissions
platform-wide. At this feature's designed volume (Premium-only, 10 custom questions per user
per month) that is a deliberate trade of throughput for an exact ceiling, and it is documented
in the migration as a scaling consideration for a future high-volume phase.

---

## D. Defects found and fixed

### D1 — `revoke ... from public` does **not** secure a function on Supabase (found by this module's own privilege probe)

**Reproduction.** The PGlite privilege probe asserted `has_function_privilege('authenticated', …, 'EXECUTE') = false`
for all three new SECURITY DEFINER functions. It returned **`true`** for all six role/function pairs.

**Root cause.** A Supabase project (faithfully reproduced by `scripts/db-rebuild-check/shim.sql:28`)
carries `alter default privileges in schema public grant execute on functions to anon, authenticated, service_role`.
That grants those roles EXECUTE **directly**, and `revoke … from public` does not touch a
direct role grant. My original migration only revoked from `public`.

**Impact had it shipped.** All three functions would have been callable by any logged-in user
straight through PostgREST's `/rpc/` endpoint:
- `ai_usage_ledger_accumulate()` has no identity guard **by design** (it is an internal
  accounting primitive) — a user could have called it with **any** `user_id` and **any** cost,
  poisoning another user's cost ceiling or inflating the platform total until every user was refused;
- `ai_refund_admission()` is guarded to self, which is precisely the problem — a user could
  have refunded their **own** consumed questions and minted unlimited allowance.

**Fix.** `revoke all on function … from public, anon, authenticated;` on all three.
**Post-fix proof.** All 6 role/function probes now return `false`; `service_role` still returns `true`.
**Negative control:** an explicit `GRANT` makes the probe report `true` again (so the probe is
not vacuous), and the in-body identity guard then still blocks a cross-user call with `42501` —
proving the second layer works. EXECUTE is revoked again and re-verified before the test ends.

### D2 — PostgreSQL `numeric` NaN is **equal** to itself, so the `v <> v` NaN idiom never fires

**Reproduction.** `ai_admit_request(..., p_estimated_cost_usd => 'NaN'::numeric, ...)` returned
`deny_reason = 'request_cost_limit'` instead of the expected `'cost_estimate_unavailable'`.

**Root cause.** Unlike IEEE floats, PostgreSQL defines `numeric` NaN as *equal* to NaN (so it
can be indexed and sorted) and sorts it as *greater than* every number. My guard
`v_est <> v_est` was therefore always false, and the NaN fell through to the per-request cost cap.

**Impact.** Fail-closed behaviour was preserved by luck (NaN > any cap, so it was still denied),
but with a **false explanation** in both the API response and the permanent audit trail — and a
NaN would have been at risk of reaching `sum()` over the cost column had any later path stored it.

**Fix.** Test NaN **first** and with `=`: `if v_est is null or v_est = 'NaN'::numeric or v_est < 0`.
Same fix applied to the audit-row cost sanitiser, so a NaN can never be stored and poison later sums.
**Post-fix proof.** NaN now denies with `cost_estimate_unavailable`.
**Negative controls retained:** `NULL` and negative estimates deny with the same reason; a valid
estimate is still admitted.

### D3 — Module 11.0's ledger writer was a racy read-modify-write (disclosed fix to already-certified code)

`lib/ai/audit/aiRuns.ts` `upsertUsageLedger()` did `SELECT` → then `INSERT`/`UPDATE` computed
from that already-stale read. Two concurrent runs in the same period could race the unique
constraint or lose one run's token/cost increments. In Module 11.0 that was an accounting
inaccuracy with **no** consequence, because nothing read the ledger. Module 11.1 makes the same
table the source of truth for the cost ceilings, so a lost cost increment becomes a ceiling that
under-counts real spend — a correctness defect in enforcement. Replaced with a single atomic
`insert … on conflict … do update set col = table.col + excluded.col` RPC that touches only the
accumulation columns. Proven by the 30-way concurrent test above.

---

## E. Certification results (exact counts, no rounding)

| Suite | Result |
|---|---|
| **PGlite security/enforcement certification** — `scripts/db-rebuild-check/module11_1_entitlement_cert.mjs`, full `0001…0115` rebuild from empty (101 migrations) | **131 passed, 0 failed** |
| **New Module 11.1 unit tests** — `tests/unit/aiEntitlementEnforcement.test.ts` | **48 passed, 0 failed** |
| **All AI unit tests** (Module 11.0 + 11.1), `npx vitest run tests/unit/ai` | **167 passed, 0 failed** (10 files) — 11.0's 119 all still pass |
| **`tsc --noEmit`** | **Clean, 0 errors** |
| **`npm run lint` (eslint)** | **65 problems — 19 errors, 46 warnings.** Baseline at `a16cb5e`: **65 problems — 19 errors, 46 warnings.** Exact parity; all 19 errors are in pre-existing files (`goalArchivedLinkedFunding.test.ts`, `AppShell.tsx`, `profile/page.tsx`, …) that Module 11.1 never touches. |
| **`npm run build`** | see §E.1 |

PGlite certification covers, each with a genuine negative control:
schema/RLS coverage (12) · tenant isolation + the same-tenant quota-reset forgery (23) ·
function privileges + cross-user identity guard (13) · Premium entitlement and fail-closed
tier resolution (9) · monthly quota, no rollover, cross-tenant independence (7) ·
what does **not** consume quota (5) · kill switches incl. immediacy and controls-missing (9) ·
rate limiting incl. no-self-lockout and rolling window (6) · all five cost ceilings and
fail-closed cost inputs (19) · atomicity with its naive-implementation negative control (6) ·
refunds incl. idempotency and anti-minting (11) · atomic ledger accumulation (5) ·
audit completeness (5).

**The specific attack the brief named** — *can a user PATCH their own `ai_usage_ledger` row to
reset their quota?* — **No.** UPDATE affects 0 rows, DELETE affects 0 rows, a forged INSERT is
blocked by RLS, a forged "allowed" admission event is blocked, and deleting their own admission
events (which would clear their rate-limit window) affects 0 rows. Ground truth re-read after
every attempt: consumed quota unchanged. **Negative control:** temporarily adding an UPDATE
policy makes the attack **succeed** (1 row affected), proving those zero-row results are real
policy enforcement and not silently-failing statements; the policy is dropped and the block
re-verified.

### E.1 Regression — zero Module 1–10 / 11.0 impact

| | This branch | Baseline `a16cb5e` |
|---|---|---|
| Test files | 178 | 177 (+1 = the new 11.1 file) |
| Tests | 3783 | 3735 (+48 = the new 11.1 tests) |
| Failing files | 9 | 9 — **identical set** |

Every failure in both runs is one of the nine `resources*` suites that talk to live DEV
Supabase over the network. They fail identically at baseline, they are flaky run-to-run
(3 failed tests on one run of this branch, 2 on another, 5 at baseline, same files throughout),
and none of them touches AI, entitlements, the ledger, or anything Module 11.1 changed.
**No `ai*` test fails on either tree.**

---

## F. Module 11.0 files modified — full disclosure

| File | Change | Why it was genuinely necessary |
|---|---|---|
| `lib/ai/gateway/aiModelGateway.ts` | Added the entitlement gate before the provider call; `requestClass` (required) and `cacheHit` on the request; refund on every post-admission failure; registry-driven costing; an `errorCode` parameter on `reject()`. | The gateway is the only path to a provider; the brief requires the check to happen before any provider call. |
| `lib/ai/audit/aiRuns.ts` | `ExecutionStatus` +1 value; `currentBillingPeriod()` extracted to `lib/ai/billingPeriod.ts` (three consumers now need to agree on it); `upsertUsageLedger()` → atomic RPC. | ADR-M11-001 #8 requires a truthful audited status for every rejection; defect D3. |
| `tests/unit/aiMockProviderAndGateway.test.ts` | 11 gateway constructions now inject an explicit `allowAllGate()`; `baseRequest()` declares `requestClass`. | The gate **defaults to enforcing** — an enforcement layer that is off unless someone remembers to switch it on is not enforcement. Tests therefore state their bypass explicitly, so it is visible at every construction site. |
| `tests/unit/aiResidualClosureFailClosed.test.ts` | Same, 5 constructions. | Same. |
| `tests/live-dev/module11ResidualLiveDev.test.ts` | Same, 1 construction. | Same. |

`supabase/migrations/0110_module11_ai_foundation.sql` was **not** edited — the `execution_status`
CHECK is widened forward-only by `0115`, so the migration chain stays replayable from empty.
No Module 11.0 behaviour changed other than the three items above.

---

## G. Explicitly NOT built

- **No user-facing AI chat.** No "Ask AI" page, no chat UI, no client component, no nav entry,
  no user-facing route of any kind. The only new routes are two **admin** endpoints
  (`/api/admin/ai/controls`, `/api/admin/ai/cost-limits/[id]`) behind the existing
  `requireAdmin()`, and they expose no AI capability — only the switches that govern one.
- **No Insight Pack**, not even partially. No insight or recommendation generator.
- **No live provider activation** — `OpenAIProviderAdapter.generateStructured()` still throws
  unconditionally. **No prompt activation** — all 12 seeded prompts remain `DRAFT`, so
  `getActivePrompt()` still returns null for every one and the gateway still refuses.
- **No semantic answer-cache matching.** `lib/ai/cache/answerCache.ts` implements only textual
  normalisation and the exact-key lookup the 11.0 schema already implied. It exists for one
  enforcement reason: "a cache hit must not consume quota" hinges on a boolean, and a boolean
  the caller merely *asserts* is a quota-bypass switch, not a fact. It is not wired into any
  answer-serving flow, because no such flow exists in this phase.
- **Nothing applied to DEV or production.** No SQL executed against any hosted environment.

---

## H. Honest limitations carried forward

1. **"Billing month" is the UTC calendar month, not a subscriber anniversary.** This codebase
   has no billing system: no Stripe/Paddle integration, no subscriptions table, no period
   columns, and `user_entitlements.effective_from`/`effective_to` are written by nothing and
   read by nothing. The only monthly boundary that genuinely exists is Module 11.0's
   `ai_usage_ledger.billing_period`. That concept is reused rather than a second one invented,
   and isolated in `ai_billing_period_for()` so a real anniversary later changes one function body.
2. **Cost figures are estimates, and the estimator's limits are real.** Input tokens use Module
   11.0's `ceil(chars/4)` heuristic, not a tokenizer. Pre-flight output tokens are the full
   budget, so pre-flight cost is an **upper bound** (the correct direction for a ceiling).
   Registry prices are whatever an admin typed; nothing verifies them against an invoice.
   `actual_cost_usd` stays NULL until a real provider reconciliation exists — every ceiling
   operates on **estimated** cost. Module 11.1 does close 11.0's gap where one hardcoded price
   applied to every model, which would have made a per-model ceiling meaningless.
3. **Advisory-lock behaviour under true multi-connection concurrency is not yet proven** (§C).
   Owed at live-DEV certification.
4. **The platform lock serialises all AI admissions.** Fine at designed volume; a scaling
   consideration for a future high-volume phase.
5. **`standard_requires_premium` defaults to `true`** — today no AI of any class is served to a
   free user. That is the conservative reading of "personalised/custom AI functionality gated
   to Premium"; it is a column rather than a constant so the Product Owner can open standard
   personalised content to free users later as an explicit, audited decision without a deploy.
   Flagged as a **product decision the PO may want to revisit**, not a technical constraint.
6. **Refunds return the question, never the cost.** If the provider was invoked, real money may
   have been spent and the ceilings must keep seeing it. Refunding it would turn a spend ceiling
   into a fiction.
7. **`getPlanTier()` in `lib/services/entitlements.ts` still fails open to `'free'`** and was
   deliberately left alone — changing it would alter Module 9 report behaviour, which is out of
   scope. Module 11.1 does not use it on the enforcement path; the RPC reads `user_entitlements`
   itself and treats a missing row as an explicit `entitlement_unknown` denial.
8. **`rollout_percentage` in `ai_model_registry` is still read by nobody** (a Module 11.0 gap,
   unchanged here and not in scope).

---

## I. Hand-off — what the Product Owner needs to do

1. **Apply `supabase/migrations/0115_module11_1_ai_entitlements_quotas_cost_controls.sql`**
   manually via the Supabase Dashboard SQL Editor, DEV first. It has not been applied anywhere;
   no DDL was attempted against any hosted environment.
   *Prerequisite:* `0110` must already be applied (it creates every table this migration extends).
   *Note for sequencing:* `0111`–`0114` are unrelated in-flight migrations from other branches;
   `0115` does not depend on them and does not touch anything they touch.
2. **Review the defaults** seeded into `ai_platform_controls` — allowance 10, rate limit 12/hour,
   per-user ceiling $5.00/month, platform ceiling $500.00/month, per-request cap $0.50,
   `standard_requires_premium = true` (see §H.5). All are editable without a deploy.
3. **Authorise (or not) a live-DEV certification round**, which should add: the multi-connection
   concurrency proof (§H.3), a real end-to-end admission through the deployed admin routes, and
   a live kill-switch flip.

---

## J. Terminal verdict

> ### MODULE 11.1 — DEV-READY, PGLITE CERTIFIED (131/131) — MIGRATION `0115` PENDING MANUAL APPLICATION; LIVE-DEV CERTIFICATION AND MERGE AUTHORISATION PENDING

Enforcement is complete and certified (131/131) against a real Postgres rebuilt from empty, with genuine
negative controls behind every claim, including a non-vacuous demonstration that the naive
implementation of this feature **does** overspend the allowance while this one does not.
Two real defects were found by this module's own tests and fixed before any deployment (D1, D2),
and one pre-existing Module 11.0 defect was fixed because enforcement depends on it (D3).
Regression is at exact parity with baseline. No chat UI and no Insight Pack were built.
Nothing has been merged, pushed, applied, or deployed.
