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


---
---

# PART 2 — FULL-SPECIFICATION COMPLETION REPORT

Written against the Product Owner's 89-section Module 11.1 specification. This
was an **audit-and-extend** pass over the implementation reported above, not a
rebuild: each of the 89 sections was checked against the actual code, and only
genuine gaps were closed. Where a section was already satisfied, the existing
artefact is cited rather than re-implemented.

---

## A. VERDICT

> ### MODULE 11.1 — CONDITIONAL PASS
>
> Every safety-critical and commercial-control requirement is implemented and
> independently reproducible on a real Postgres rebuilt from empty (379/379).
> The single outstanding condition is **external and non-code**: migration
> `0115` has not been applied to DEV, because this environment has no DEV
> database access and project convention forbids applying migrations directly.
> Live-DEV verification is therefore owed once the Product Owner applies it.
>
> Per spec section 87, a CONDITIONAL PASS is permitted only for "a genuinely
> external/non-code prerequisite that does not undermine entitlement, quota,
> rate-limit, cost-control or kill-switch correctness". Manual migration
> application is exactly that: the enforcement logic is complete and certified
> against real Postgres semantics; what is missing is a deployment step this
> role is not permitted to perform.
>
> No section 87 FAIL condition is met. Specifically: a Free user cannot trigger
> paid personalised AI; quota cannot exceed its limit under concurrency; a
> client cannot alter quota; the cost hard stop cannot reach a provider; the
> kill switch stops provider execution at runtime; a DB outage admits no paid
> AI; user and household isolation hold; a provider failure does not
> permanently consume a credit; and Modules 1-10 do not regress.

---

## B. GIT

| | |
|---|---|
| Worktree | `D:/fhip-module11-1` |
| Branch | `feature/module-11-1-premium-entitlements` |
| Base SHA | `a16cb5e` (Module 11.0, `feature/module-11-0-ai-foundation`) — **not** `origin/main` |
| Part 1 SHA | `7ed02ed` |
| Part 2 commits | `895900e` migration Part 2 · `8e00295` application layer · `daed27c` certification · `9fd7d09` unit tests · `e8226e0` ESLint parity · plus this documentation commit |
| Pushed | **No** |
| Merged | **No** |
| Migration applied | **No** — not to DEV, not to production, no SQL executed against any hosted environment |

**Scope (spec section 77).** `git diff --name-only a16cb5e..HEAD` lists 34
files: 11 API routes (all under `app/api/*/ai/`), 13 `lib/ai/*` modules, the
migration, the certification script, 5 test files, and 2 documents. **Zero
Module 1-10 files.** Two `scripts/ii-*/comparison_report.json` timestamp
artefacts were regenerated by running the full suite and were deliberately
reverted rather than committed.

---

## C. DISCOVERY (spec sections 4, 9, 10, 11)

Re-verified fresh against `origin/main` @ `2ade18b` for this pass. Full
evidence in `MODULE_11_1_REUSE_AND_GAP_AUDIT.md` Part 2 addendum.

| Question | Finding |
|---|---|
| Subscription truth source | `user_entitlements` (migration `0010`). `git grep -nE "plan_tier" origin/main -- lib app` returns **exactly two lines**, both in `lib/services/entitlements.ts`. Module 11.1 creates **no second definition of Premium**. |
| Premium entitlement source | `plan_tier = 'premium'`; the column is CHECK-constrained to `('free','premium')`. |
| Billing provider | **None exists.** Zero files match `current_period_end\|billing_cycle_anchor\|stripe_customer\|subscription_status\|trial_end` across `lib`, `app`, `supabase` on `origin/main`. |
| Billing-period source | UTC calendar month, matching Module 11.0's `ai_usage_ledger.billing_period`, isolated behind the DB function `ai_billing_period_for()` so a future subscriber anniversary changes one function body and no call site. **This is the "minimum safe interim rule" section 9 asks for when no reliable cycle boundary exists — declared, not silently invented.** |
| Household vs user ownership | **User.** `user_entitlements.user_id` is UNIQUE; `households.user_id` means one owner; `household_members` are name/relationship records, not authenticated accounts. Two adults cannot share one household as separate subjects in this schema. |
| Subscription-state mapping | ACTIVE and EXPIRED are the only states this codebase can express, plus CANCEL_AT_PERIOD_END via `effective_to`. TRIAL, PAST_DUE, GRACE, REFUNDED and SUSPENDED are **not representable** — proven, not assumed (section W of the certification attempts all ten and confirms every one is rejected by the CHECK constraint). Section 10 forbids inventing unsupported policy, so none was invented. |

**One disclosed behaviour change.** `user_entitlements.effective_from` /
`effective_to` have existed since migration `0010` and were read by nothing.
Part 2 now reads them, which is what makes section 10's minimum
(`ACTIVE -> eligible`, `CANCEL_AT_PERIOD_END inside the paid period ->
eligible until expiry`, `EXPIRED -> not eligible`) genuinely enforced rather
than merely unrepresentable. Nothing writes `effective_to` today and it
defaults to NULL, so **no existing row changes behaviour**.

---

## D. ARCHITECTURE

| Component | Where | Note |
|---|---|---|
| `AIEntitlementService` (section 5) | `lib/ai/entitlement/aiEntitlementService.ts` | The five named read methods, all derived from **one** DB round trip so they cannot disagree about the same subject. `canConsumeCustomQuestion()` is documented as **advisory only** — it is a check-then-act read and the authority remains the atomic RPC. |
| Feature entitlement (section 6) | `lib/ai/entitlement/capabilities.ts` | `AI_COACH_PREMIUM` + all seven sub-capabilities. Resolves from the one real plan tier in one place; capabilities whose features are deferred resolve to **false**, so an entitlement can never read as permission to invoke something nobody built. |
| Quota architecture | `ai_usage_ledger.custom_question_count` per `billing_period` | The ledger itself is authoritative — no independent counter that could drift. No-rollover is **structural**: period N's unused allowance is simply not visible when counting period N+1. |
| Usage ledger | `ai_usage_ledger` (11.0), extended | Plus `ai_admission_events` (one row per decision) and `ai_operational_events` (severity-bearing ops events). |
| Reservation lifecycle (section 14) | `execution_state` in reserved/finalised/released + `lease_expires_at` | `ai_finalise_admission()` on a validated answer; `ai_refund_admission()` releases and refunds. A **lease**, not an unbounded lock, so a crashed server cannot bar a subject from their own allowance forever. |
| Idempotency (section 15) | `idempotency_key` + `request_hash`, unique per subject | A retry replays the original verdict; a key reused with a different body is a recorded conflict. The gateway **refuses to execute** on a replayed allow. |
| Rate limiter (section 17) | Rolling window over `ai_admission_events.created_at` | Configurable without a deploy; keyed to the entitlement subject, not IP. A rate-limit denial does not count toward its own window, so a retry loop cannot extend its own lockout. |
| Concurrency limiter (section 18) | Active-lease count per subject | Default 1. Applies only to outcomes that reach a provider synchronously. |
| Cost service (section 22) | `lib/ai/cost/registryCost.ts` | Registry-driven per-model pricing with a provider fallback, and honest about which was used. |
| Kill switches (section 29) | `ai_platform_controls` (5 switches) + `ai_provider_controls` | Read **fresh inside the request transaction**. No cache, no TTL, no memoisation anywhere — which is also why section 64's cache-failure requirement is satisfied vacuously and correctly. |
| Reusable guard (section 41) | `lib/ai/entitlement/requireAIEntitlement.ts` | Same shape as the existing `requireUser()` / `requireAdmin()`. Performs the cheap half of section 42's ordering; **not** the admission decision, and cannot switch the gateway gate off. |
| Observability (section 60) | `lib/ai/observability/aiMetrics.ts` | Label **allowlist**, not denylist. A user id is not an accepted label. |

**Order of controls (section 42) — one disclosed deviation.** Rate limit and
the cost ceilings are checked before the quota, and quota availability
immediately before concurrency. Two reasons, both making the stricter
guarantees easier to prove: (1) section 57 ("no denial consumes quota") becomes
**structural** rather than a property of ordering, because consumption is the
last action after every gate passes; and (2) section 81 requires a subject on
their last credit to see a *limit* response, which this ordering produces,
while a subject with allowance to spare correctly sees the section 18
concurrency refusal. Both are certified. The interface does not prevent
section 42's future ordering: Module 11.2's deterministic router sits
**upstream** of this function entirely — it decides the usage outcome, and an
outcome needing no provider never reaches a cost or quota gate here.

---

## E. DATABASE

**Migration `0115_module11_1_ai_entitlements_quotas_cost_controls.sql`.**
Part 2 is **appended to `0115` rather than taking a new number**, because
`0115` has never been applied to any environment — it exists only on this
branch. Taking `0117` would have burned a number for no operational benefit.

**Migration-number scan (re-run fresh for this pass, per standing convention):**
`git fetch origin`, then `git ls-tree` over every `refs/heads` and
`refs/remotes` ref, plus an on-disk scan of every worktree for untracked
`*.sql`. Numbers above `0114` found anywhere: **`0115`** (this file, this
branch only) and **`0116`** (Admin A0.2 Wave 2, branch
`fix/admin-a02-wave2-workflow-ordering-integrity`). **No collision.**

| New in Part 2 | Purpose | RLS |
|---|---|---|
| `ai_provider_controls` | Per-provider kill switch + monthly spend limit (§31, §26) | Enabled, zero policies |
| `ai_config_audit` | Append-only, trigger-fed, one row per changed field (§33, §59) | Enabled, zero policies |
| `ai_operational_events` | Ops events with risk-appropriate severity (§27, §38, §60) | Enabled, zero policies |
| `ai_platform_controls` +14 columns | 3 more switches, concurrency, 3 token budgets, 2 soft thresholds, daily cost cap | unchanged |
| `ai_admission_events` +6 columns | `usage_outcome`, `execution_state`, `lease_expires_at`, `finalised_at`, `idempotency_key`, `request_hash` | unchanged |
| `ai_model_registry` +5 columns | Cached-input price, batch multiplier, currency, source note, last-verified (§23) | unchanged |
| `ai_finalise_admission()` | Closes a reservation on success (§14) | `service_role` only |
| `ai_entitlement_state()` | The user-safe read model (§5, §8, §39) | `service_role` only |
| `ai_admit_request()` | Recreated with 15 parameters | `service_role` only |

**Constraints (section 49).** All enforced in the database, not only in
TypeScript, and each proven by an attempted violation: non-negative allowance
and counters; positive rate limit, window, concurrency and token budgets;
non-negative costs; soft threshold <= hard ceiling; a singleton controls row;
batch multiplier in (0, 1]; ISO-3 currency; and three CHECKs that make the
accounting rules structural — a `reserved` state requires an `allowed`
decision, `BATCH_AI` can never carry `quota_consumed`, and **only** `LIVE_AI`
can.

**Privileges.** `revoke all ... from public, anon, authenticated` on every
SECURITY DEFINER function (the Part 1 defect D1 lesson — on Supabase,
`revoke from public` alone does nothing against the project's default
`grant execute ... to anon, authenticated`), plus in-body identity guards as a
second layer. The recreated `ai_admit_request` has a **new signature**, so the
Part 1 grants no longer applied to it and were reissued.

---

## F. PREMIUM / FREE PROOF

| Claim | Evidence |
|---|---|
| Premium allowed | Cert §W matrix 2, §Y 80.3 |
| Free denied | Cert §W matrix 1, §AC 84.1 — `not_premium`, before any quota or provider work |
| Client plan spoofing fails | Cert §AC 84.2 — there is **no** plan/premium/entitlement/allowance/remaining/quota/ceiling parameter to forge. The one tier parameter that exists is overridden by the registry (§I proves declaring a cheaper tier than the registry holds is still refused). |
| Household tampering fails | Cert §AC 84.3 — a Free subject supplying the Premium household id is still refused, and the Premium subject's ledger is untouched |
| Fabricated `remaining` fails | Cert §AC 84.4 — a forged ledger INSERT is blocked by RLS; an UPDATE affects **0 rows** |
| Cross-user execution fails | Cert §AC — EXECUTE is revoked, and the in-body identity guard backs it up (`42501`) |
| Admin != consumer entitlement | Cert §W — an `admin_users` member on a free plan is refused `not_premium` |
| No financial context disclosed | Cert §AC — the denial payload is scanned for 8 financial terms; none present |

---

## G. QUOTA PROOF

- **0/10 -> admitted**; **9/10 -> the tenth admitted**; **10/10 -> `quota_exhausted`** (cert §W matrix 3-5).
- **Reset**: period 1 consumes 10 and refuses the eleventh; a new period admits again at 1/10 with 9 remaining; **period 1's history is unchanged at 10** (cert §X).
- **No rollover**, in the direction that matters: an entirely unused previous period grants exactly **10** this period, not 20 (cert §X).
- **2 simultaneous requests, 1 credit -> exactly 1 success** (cert §Z, spec section 81), with exactly one reservation existing afterwards so only one request can reach a provider.
- **Section 51 A/B/C**: 25 concurrent requests against a 10-question allowance admit **exactly 10**, refuse **exactly 15** for `quota_exhausted`, and leave a ledger of **exactly 10**; the 10 admitted were issued the 10 **distinct** sequence numbers 1...10.
  **Negative control retained from Part 1:** a deliberately naive two-statement implementation, dispatched identically, **overspends 25/25** — so the harness genuinely detects the bug and the result above is not vacuous.
- **Section 51.D**: 8 concurrent retries of **one** idempotency key consume **one** credit and create **one** admission event (cert §O).

---

## H. FAILURE / RELEASE PROOF (sections 55, 56)

Provider outcomes are exercised against the **real `MockAIProvider`** in
`tests/unit/aiEntitlementEnforcement.test.ts`: provider outage, timeout,
malformed JSON, schema-invalid, and a response citing an unknown source. Every
one releases the credit. The DB-side lifecycle is certified in cert §AE.

| | Reservation created | Credit consumed | Credit released | `ai_runs` status | Cost recorded |
|---|---|---|---|---|---|
| Success | yes | yes | no — **finalised** | `success` | yes |
| Provider timeout | yes | yes | **yes** | `timeout` | if incurred |
| Provider 5xx / outage | yes | yes | **yes** | `provider_error` | if incurred |
| Malformed JSON | yes | yes | **yes** | `rejected_schema` | if incurred |
| Schema invalid | yes | yes | **yes** | `rejected_schema` | if incurred |
| Unknown source ref | yes | yes | **yes** | `rejected_source_ref` | if incurred |
| Certification failure (pre-provider) | **no** | **no** | n/a | `rejected_certification` | no |
| Entitlement/cost/kill-switch denial | **no** | **no** | n/a | `rejected_entitlement` | no |

**Section 56 proven directly** (cert §Y 80.12, §AE): after a release, the
ledger's `custom_question_count` is back to 0 while `estimated_cost_usd`
remains **> 0**. User quota and provider cost are separate accounts.

**Anti-minting.** A second refund is a no-op (`already_refunded`) and mints
nothing. A **finalised** admission can no longer be refunded
(`already_finalised`) — a delivered answer stays paid for. A released
admission cannot then be finalised. The two terminal states are mutually
exclusive in both directions.

---

## I. RATE-LIMIT PROOF (sections 17, 52)

The limit binds after 3 requests in the window, and **none** of these resets
it: a different household id, task type, model, request class, usage outcome,
fresh idempotency key, or cost estimate (cert §AD). **Negative control:** a
*different subject* is genuinely unaffected, proving the limit is per-subject
rather than a global stop that would pass the test vacuously. A user cannot
DELETE their own admission events to clear their window (0 rows affected), and
the limit still binds afterwards.

---

## J. CONCURRENCY PROOF (section 18)

A second live request while one is in flight is refused
`request_in_progress`, consumes nothing, and leaves the ledger at exactly the
one admitted request. Finalising or releasing the first frees the subject
**immediately**, not at lease expiry. An **expired** lease no longer blocks —
a crashed server cannot bar a subject from their own allowance forever. A
cached answer is not blocked by an in-flight live request, because it reaches
no provider (cert §N).

---

## K. COST PROOF

| Section | Result |
|---|---|
| 53.A below user ceiling | allowed |
| 53.B breaching user hard ceiling | `user_cost_ceiling`, **no reservation**, provider unreachable |
| 53.C platform **soft** threshold | request **still admitted**, `MEDIUM` warning event recorded, verdict reports which thresholds were crossed. **Negative control:** with no soft threshold configured, nothing warns — NULL is not zero |
| 53.D platform **hard** threshold | `platform_cost_ceiling`, `CRITICAL` event, **no reservation**. Cached and deterministic answers **keep being served** during the stop (section 27) |
| 53.E batch switch disabled | `batch_disabled` |
| 53.F provider disabled | `provider_disabled`, and **zero** admitted executions anywhere — a refusal, never a silent reroute |
| 53.G model disabled | `model_disabled` (inactive, unapproved, or past `effective_to`); an **unregistered** model is `model_unknown` — fail-closed |
| 53.H global AI disabled | `ai_disabled` |
| §26 per-provider monthly | `provider_cost_limit` |
| §26 platform daily | `daily_cost_limit`; cached answers still served |
| §24 pre-execution ordering | Every ceiling is checked **before** any reservation, so a blocked request never reaches a provider |

**Provider call count.** The admitted-decision count is the invocation counter:
across every hard-stop case above it does **not** increase, and no reservation
exists for the refused request.

---

## L. KILL-SWITCH PROOF (sections 54, 82) — before/after invocation counts

Section 54 demands **runtime** behaviour, not config inspection.

1. Switch enabled -> request succeeds -> **counter n -> n+1**.
2. Admin disables the switch.
3. The **same** request -> blocked `ai_disabled` -> **counter unchanged at n+1**.
4. The subject is **still Premium**; quota remains at 1 used / 9 remaining; the blocked request consumed **nothing**.
5. The block is audited as a `HIGH`-severity operational event.
6. Re-enable -> calls resume -> **counter n+2**. No deploy, no cache invalidation.

Repeated for the custom-question switch (custom AI stops; **system-generated
standard content and cached answers keep running** — section 30), the
live-provider switch (cached answers survive), batch generation, scenario, and
provider/model disable.

---

## M. ADMIN SECURITY

Eleven routes, every one behind the existing `requireAdmin()` + `adminRoute()`
(section 34: integrate with the existing Admin architecture, do not build a
parallel admin-security model). The governance tables are RLS-enabled with
**zero policies**, so `anon` and `authenticated` get zero rows regardless of
route behaviour — certified directly for `ai_provider_controls`,
`ai_config_audit` and `ai_operational_events`.

**Section 36 — no API keys.** Structural, not a filter that could be
forgotten: **no provider API key is stored in the database at all.** Keys live
only in server environment variables. The costs endpoint nonetheless uses an
explicit column allowlist rather than `select('*')`, so a future
secret-bearing column could not begin leaking by default. Certified: no
audited configuration table has any column matching
`api_key|secret|token_value|password`.

**Section 58 validation** rejects a negative allowance, a zero rate limit
(an unsafe state that *looks* like a working one), a soft threshold above its
hard ceiling, a per-user ceiling above the platform ceiling, and a user-input
budget larger than the whole context budget. It validates the **merged**
configuration, so *lowering* a hard ceiling under a stored soft threshold is
caught too — and the same soft-below-hard rule is a database CHECK, so no
write path can bypass it.

---

## N. PRIVACY / SECURITY REGRESSION

- Module 11.0's privacy and tenant-isolation suites re-run **green** (all `ai*` unit tests pass, 224/224).
- Section 3 precondition check: **29/29 present**, zero regressions — all ten `0110` tables, the context contract, certification service, gateway, mock provider, model/prompt registries, audit writer, structured-output validation, safety policy, privacy allowlist, certified source client, household isolation, admin integration, and the ADR. RLS is enabled on **every** `ai_*` table. All 12 seeded prompts remain `DRAFT`.
- The entitlement payload is scanned for `cost`, `ceiling`, `platform`, `threshold`, `provider`, `model`, `rate_limit`, `kill_switch`, `spend`, `budget` — **none present** (cert §V, and again in the unit tests).
- The kill-switch **reason** is never disclosed to a user.
- `ai_operational_events` is not user-readable **even for a user's own rows**, because its metadata carries spend figures and ceiling values.
- Metrics labels are an **allowlist**; a user id or a financial value cannot become a metric dimension (unit-tested).
- The gateway sends a request **hash**, not prompts, so no financial context reaches the gate as text (unit-tested with a value that must not appear).

---

## O. PERFORMANCE (section 74)

The architecturally meaningful figure is the **query count**: the entire
pre-provider decision — entitlement, quota, rate limit, concurrency and six
cost gates — is **one database round trip**, inside one transaction. The
entitlement read is likewise one round trip. Measured latency on PGlite/WASM
is well under the certification's 250 ms assertion and is negligible beside a
provider call measured in seconds, so the gate is not the bottleneck.

Section 43's shared-summary optimisation was **deferred**, per section 43's own
instruction — see the Part 2 addendum in `MODULE_11_1_REUSE_AND_GAP_AUDIT.md`.
Section 75's before/after therefore does not apply. Section 43 states
explicitly that this is not a condition for FULL PASS.

---

## P. REGRESSION

| Check | Result |
|---|---|
| **PGlite certification** (real Postgres, full `0001...0115` rebuild from empty, 101 migrations) | **379 passed, 0 failed** across 34 sections |
| **AI unit tests** (`tests/unit/ai*`) | **224 passed, 0 failed** (11 files) |
| **Full existing suite** (`npx vitest run`) | 3,796 passed, 37 skipped, **7 failed in 6 files** |
| **`tsc --noEmit`** | **Clean, 0 errors** |
| **`npm run lint`** | **65 problems (19 errors, 46 warnings)** — exact parity with the `a16cb5e` baseline. **Zero findings in any Module 11.1 file.** |
| **`npm run build`** | **Succeeds.** All 11 new routes registered |

**On the 7 failures.** All 6 files are `resources*` suites that talk to live
DEV Supabase over the network — the same set Part 1 documented as failing at
baseline and as flaky run-to-run. Verified directly for this pass: each
contains **zero** references to `lib/ai`, `entitlement`, `ai_admit`,
`ai_usage_ledger` or `plan_tier`, and 3-5 references to Supabase network
clients. Every file this branch changes lives under `lib/ai/` or
`app/api/**/ai/`. **No `ai*` test fails.**

**Build note.** `npm run build` initially failed prerendering
`/admin/benchmarks` with "Your project's URL and API key are required". This
is environmental — the worktree has no `.env.local`. With placeholder Supabase
values the build completes cleanly. No `.env.local` was committed.

---

## Q. WRITE BOUNDARY

| | |
|---|---|
| Canonical financial writes | **0** |
| Modules 1-10 business-data mutations | **0** |
| AI-initiated financial writes | **0** |
| Money movement capability | **none** |
| `user_entitlements` writes | **0** — it is read, never written or altered |
| Module 11 operational/governance writes | permitted as designed: `ai_admission_events`, `ai_usage_ledger` counters, `ai_operational_events`, `ai_config_audit`, `ai_runs`, and admin-initiated configuration |

---

## R. DEFERRED ITEMS — explicitly confirmed NOT built

- **No open AI Coach chat.** No prompt box, no chat history page, no "Ask AI Coach" button, no free-form question interface, no client component, no nav entry. The single user-facing route added is `GET /api/ai/entitlement`, which is a **read** that consumes nothing, reserves nothing and reaches no provider.
- **No 20-25 standard personalised question library** (phase 11.3).
- **No Monthly AI Insight Pack**, not even partially (phase 11.4).
- **No semantic caching** (phase 11.8). `SEMANTIC_CACHE` exists only as an accounting outcome type, so the quota-exemption contract is fixed now; no embedding or similarity matching is implemented.
- **No Scenario Coach.** Its switch defaults to **false**.
- **No AI writes to financial data.** No money movement.
- **No live external web access.** No search, browser or retrieval tool.
- **No live provider activation** — `OpenAIProviderAdapter.generateStructured()` still throws unconditionally. **No prompt activation** — all 12 seeded prompts remain `DRAFT`, so `getActivePrompt()` returns null for every one and the gateway still refuses.
- **Module 11.2 not started.**

---

## S. NEXT-PHASE RECOMMENDATION

> ### NOT READY FOR MODULE 11.2

Not because of a defect, but because migration `0115` has not been applied to
DEV and section 78's live verification is therefore outstanding. Module 11.2's
deterministic answer router sits directly on top of this entitlement and
usage-accounting layer; building on a schema that has never run in a real
environment would compound an unverified foundation. Once the Product Owner
applies `0115` to DEV and the live round confirms it, this becomes READY.

---

## T. HAND-OFF — what the Product Owner needs to do

1. **Apply `supabase/migrations/0115_module11_1_ai_entitlements_quotas_cost_controls.sql`** manually via the Supabase Dashboard SQL Editor, **DEV first**. *Prerequisite:* `0110` must already be applied. `0111`-`0114` and `0116` are unrelated in-flight migrations; `0115` does not depend on them and touches nothing they touch.
2. **Review the DEV-safe defaults** (section 79): allowance 10/period, no rollover, rate limit 12/hour, concurrency 1, per-user ceiling $5.00/month, platform ceiling $500.00/month, platform soft threshold $400.00, per-user soft threshold $4.00, daily live cap $50.00, per-request cap $0.50, token budgets 12,000 context / 2,000 user input / 800 output, `scenario_ai_enabled = false`, `standard_requires_premium = true`. All editable without a deploy.
3. **Two product decisions are genuinely yours, not technical constraints:**
   - `standard_requires_premium = true` means **no** AI of any class is served to a free user today. That is the conservative reading of "personalised AI is Premium-only"; opening standard personalised content to free users later is one audited column change.
   - The **abusive-request policy** section 14 asks to be documented. Current behaviour: a request rejected by a **platform-caused** safety failure releases the credit. A deliberately prohibited or abusive request that the provider was nonetheless paid for is **not** specially handled, because no safety-rejection path exists to trigger it in this phase. The section 14 loophole it warns about (unlimited always-refunded expensive executions) is closed from a different direction — the rate limit, the concurrency limit and the per-user cost ceiling all bound abuse independently of the question count, and none of them is refunded.
4. **Authorise (or not) a live-DEV certification round**, which should add: the multi-connection advisory-lock proof (see Part 1 §H.3 — PGlite is single-connection, so lock *blocking* across genuinely simultaneous backends is still owed), a real end-to-end admission through the deployed admin routes, and a live kill-switch flip.

---

## U. LIMITATIONS CARRIED FORWARD

Part 1's eight limitations stand, with these updates:

1. **"Billing month" is the UTC calendar month, not a subscriber anniversary** — unchanged, because no billing system exists to anchor to. Isolated in one function.
2. **Cost figures are estimates.** Input tokens use `ceil(chars/4)`, not a tokenizer. Pre-flight output tokens are the full budget, so pre-flight cost is an **upper bound** — the correct direction for a ceiling. Registry prices are whatever an admin typed; `price_last_verified_at` now exists precisely so a stale price is visibly stale. `actual_cost_usd` stays NULL until a real provider reconciliation exists, so **every ceiling operates on estimated cost**, and the admin dashboard reports actual cost as **null rather than $0.00** — reporting an unmeasured cost as zero would read as "AI is free".
3. **Advisory-lock behaviour under true multi-connection concurrency is still not proven.** PGlite is single-connection. What *is* proven is that folding check and consume into one transaction eliminates the interleaving that demonstrably breaks the two-statement version. Owed at live-DEV.
4. **The platform lock serialises all AI admissions.** Deliberate at this feature's designed volume; a scaling consideration for a future high-volume phase.
5. **`standard_requires_premium` defaults to true** — a product decision for the PO (see hand-off).
6. **Refunds return the question, never the cost** — otherwise a spend ceiling becomes a fiction.
7. **`getPlanTier()` still fails open to `'free'`** and is deliberately untouched; changing it would alter Module 9 report behaviour. Module 11.1 does not use it on the enforcement path.
8. **`rollout_percentage` in `ai_model_registry` is still read by nobody** — a Module 11.0 gap, unchanged and out of scope.
9. **New:** the `AI_SCENARIO_ENABLED` switch gates the surface that *would* be Scenario Coach (a user-initiated **custom** forecast question), because Scenario Coach itself does not exist. System-generated forecast explanations are deliberately unaffected. This is a precise, testable rule rather than a vacuous switch, but it is a proxy and is recorded as one.
10. **New:** section 43's shared-summary optimisation is **deferred** per its own instruction. The redundant fetch is read-side only and changes no number; Module 11.1 adds no new AI context construction, so the position is exactly as Module 11.0 disclosed it.

---

## V. DEFECTS FOUND AND FIXED IN THE PART 2 PASS

Beyond Part 1's D1-D3, this pass's own tests found two more real defects before
any deployment, plus one hardening change.

### D4 — an invalid `usage_outcome` aborted the RPC instead of denying cleanly
The audit INSERT wrote the caller's unrecognised outcome string, violating
`ai_admission_events`' own `usage_outcome` CHECK and throwing out of the whole
function. Fail-closed by luck (the TypeScript layer maps a throw to a denial),
but with the **wrong reason**, and the audit row was lost. Same class as defect
D2. Fixed by sanitising the outcome at the insert site; the denial now returns
`invalid_usage_outcome` and is audited.

### D5 — a **finalised** admission could still be refunded (anti-minting hole)
`ai_refund_admission()` checked `refunded_at`, the decision and
`quota_consumed`, but not `execution_state`. A delivered, validated answer's
credit could therefore be clawed back — any path able to call refund could
mint unlimited allowance out of successful answers. The gateway never does
this, but the RPC must not permit it. Fixed: refused with `already_finalised`,
making the two terminal states mutually exclusive in **both** directions.

### G4 — the model tier was a trusted input (hardening)
The tier cap was checked against the caller's declared `p_internal_tier`.
Because Part 2 looks the model up anyway for the section 32 disable check, the
registry's `internal_tier` is now authoritative. Certified: declaring
`LOW_COST` for a model the registry holds as `ADVANCED` no longer bypasses the
cap.

Also found and fixed during development, by the migration's own smoke test:
`ai_entitlement_state()` returned `upgrade_available: NULL` rather than
`false` for an eligible Premium subject, because `NULL = 'premium_required'` is
NULL in SQL — a null-valued boolean would have shipped straight out of the
public entitlement API.
