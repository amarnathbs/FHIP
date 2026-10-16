# Per-user daily AI spend cap: design, numbers and limits

## 1. The design in one paragraph

The AIE cost admission is one atomic database call made before every provider call (`aie_reserve_ai_cost`, migration 0150/0195). It locks
the one global ledger row, checks `reserved + settled + this reservation <= allowance`, and records an attempt row keyed by an idempotency
key. Migration **0284** adds a second function, `aie_reserve_ai_cost_v2`, that does the same and **first** checks the user. A user's spend for
the day is not stored in a counter; it is **derived** from the attempt rows that already exist: for every attempt of that user created on the
UTC day, the settled amount if it has been settled, otherwise the amount still reserved. The check runs under the same ledger row lock, so
two simultaneous requests for one user are decided one after the other, and the second sees the first one's reservation.

Why derived rather than a counter table: settlement (lower or higher actual cost), the 0195 stale-reservation recovery, refused attempts and
replays all already update the attempt row. Deriving from it makes every one of them per-user-correct **without touching those functions**, and
there is no second number that could drift from the first. The database change is the smallest that works: 2 additive columns, 1 index, 1 new function.

| Piece | Where | Note |
|---|---|---|
| Per-user check, in the atomic admission | `supabase/migrations/0284_aie_per_user_daily_cost_cap.sql` | `user_id` on the attempt row, `user_daily_cap_usd` on the ledger row |
| Source of truth for the cap | `aie_ai_cost_ledger.user_daily_cap_usd` (default 1.00) | Change with one `update` (`10_change_the_cap_later.sql`), no deploy. Never client-supplied |
| Documented default | `AIE_USER_DAILY_CAP_USD_DEFAULT` in `lib/aie/config.ts` | A test keeps it equal to the column default |
| Emergency brake | optional env `AIE_USER_DAILY_COST_CAP_USD` | Can only **lower** the stored cap (the database takes the smaller). Leave unset |
| The user is the session user | `userId` is a required field of the gateway request, passed by each service from the authenticated session | No user, malformed id, missing function, database error: **refused** (fail closed), the provider is never called |
| Typed refusal | gateway outcome `user_daily_cap_reached` (the global one stays `budget_exhausted`) | |
| Plain-language text | `lib/ai/access/aiFallbackRefusal.ts` -> response field `ai_fallback_refusal = daily_limit_reached` -> `aiFallbackRefusalNote` in the five panels; II statement upload via `honestFailureMessage` | No amount, no cost word, no internal name |

### Order of checks (unchanged first, new one inserted)
Adapter kill switch -> global `AIE_AI_FALLBACK_ENABLED` -> malware precondition -> **Premium guard** -> masking -> (gateway) model contract, PII re-scan ->
**atomic admission: per-user daily cap, then global allowance** -> provider call -> settle. A Free user never reaches the cap; a refused request makes no provider call and settles nothing.

### Concurrency
- Same user, many simultaneous requests: one ledger-row lock serialises the decisions; the user total is read **after** the lock, so no request decides on a stale total. PGlite shows the arithmetic (20 requests of 0.1 against a 1.00 cap admit exactly 10) but is a single session; the true multi-connection race is `scripts/aie_user_cap_live_dev_check.ts` (P1), to be run on DEV after your apply.
- Same key twice (a retry/replay): the unchanged 0195 rule, the key is claimed by primary key, a replay is refused as `replay` and charged nothing.
- Settlement races: settle only lowers (or, if the real cost exceeded the reservation, raises) an attempt that was already counted at its reservation; a request that read the total just before is conservative. The reservation is the worst case (3 attempts, full output budget), so actual cost above it is not expected.

### Day boundary: the UTC calendar day
Chosen over Australia/Sydney because it is the definition this platform already uses for the same kind of limit (Module 11's platform daily limit in
migration 0115 and the entitlement windows via `utcToday`), it never moves with daylight saving, and one definition is easier to explain and to
query. Cost: for Australia the limit resets at 10:00 (AEST) or 11:00 (AEDT) in the morning, for India at 05:30. An attempt belongs to the day it
was made, even if it is settled after midnight. The user message therefore says "resets every day ... try again tomorrow" and shows **no date or time**,
so no date format is needed in the text (dates elsewhere stay day first). The monitor query prints the UTC day start so the numbers can be read.

## 2. Effective per-user numbers against real costs

Conservative **reservation** per call (what counts while the call is in flight; the gateway reserves for 1 + 2 transient retries, the full output budget, and the larger of 4,000 input tokens and an estimate from the prompt):

| Call | Reservation | Simultaneous in-flight calls that fill US$1 |
|---|---|---|
| Scalar document (payslip, 512 output tokens), 6,000 characters | US$0.00272 | 367 |
| Line-item statement (4,096 output tokens), 6,000 characters | US$0.00917 | 109 |
| Line-item statement, 20,000 characters | US$0.01064 | 93 |
| Line-item statement, 60,000 characters | US$0.01664 | 60 |

Once a call settles, only its **actual** cost counts. Typical actual cost per draft (your figures): bank PDF about US$0.00035, retirement about US$0.0007.

| | per user per UTC day at US$1.00 | for the whole platform at the US$10 global ledger |
|---|---|---|
| Bank PDF drafts at US$0.00035 | about **2,857** | about 28,571 in total |
| Retirement drafts at US$0.0007 | about **1,428** | about 14,285 in total |

A heavy honest user (say 20 drafts in a day) spends about US$0.007 to US$0.014, i.e. **under 2 percent of the cap**. So US$1 per day is almost never reached by a person.

## 3. Is it a meaningful abuse limit? And does the global US$10 stay sensible?

**What it does achieve.** One account can no longer drain the shared ledger: the worst a single Premium account can consume is US$1 a day, which is 10 percent
of the global allowance, so at least 10 separate accounts are needed to exhaust it in a day. That is the failure the decision was made to close.

**What it does not do.** At about US$0.0004 a draft, US$1 is roughly 2,900 documents a day for one account, i.e. a script, not a person. It is a **backstop against
runaway or abusive use**, not a tight per-person budget. If you want it tighter (for example US$0.25, about 700 bank drafts or 350 retirement drafts a day, still 10 to 20
times a heavy honest day) it is one `update` (`10_change_the_cap_later.sql`). Whether US$1 a day (up to about US$30 a month per account if someone sat at the cap every day) is acceptable against the
Premium subscription price is your call; I do not have the price in the repository.

**A limit to know: bursts.** Because in-flight work is counted at its worst-case reservation, a user firing more than about 90 to 110 statement reads at the same instant is
refused for the excess even though their real cost would be tiny. The refusal is the plain "daily limit" message. Nobody uploads that many at once; a bulk import script would see it.

**The global US$10 ledger is still sensible, but for a different reason than before.** It is a **lifetime** total (nothing ever resets `settled_usd`), not a daily one. At US$0.0004 to
US$0.0007 a draft, US$10 is about 14,000 to 28,000 drafts **in the whole life of the platform**; when it is spent AI reading stops for every user until you raise it. It is now a
hard backstop on total exposure while the per-user cap handles fairness. Two things worth deciding separately (not changed here): raise the allowance as Premium grows (the stored
column `allowance_usd` is the ceiling; `P03_aie_spend_ledger_READONLY.sql` in the premium-wide pack shows `remaining_usd`), and consider whether you want a **daily** global limit too.

## 4. Privacy and audit

- The user id is stored only on `aie_ai_cost_attempt` (service role only, row level security with no policy, `on delete set null` when the account is deleted). It is never returned to a browser; the monitor query shows 8 characters.
- No document text, no amount of the cap and no user id is in any message shown to a person. Refusals are logged as the typed outcome; the service audit rows (`*_ai_fallback_provider_outcome`) carry `outcome: user_daily_cap_reached` and the usual identifiers-only evidence.
- The AIE orchestrator path records a cap refusal under the **existing** audit event `ai_fallback_budget_exhausted` with `metadata.reason = user_daily_cap_reached`, so no constrained audit-event vocabulary is widened (the drop-and-recreate trap).

## 5. Migration number

`0284`. Checked on 16-10-2026 against `origin/main` (highest 0280), every local and remote branch (`git log --all`: 0281, 0282 NAV2; 0283 `admin-users-premium`), and every worktree directory
(untracked files included). Nothing at 0284 or above exists anywhere. It touches `aie_ai_cost_ledger` and `aie_ai_cost_attempt` only and does not drop or recreate any CHECK constraint, so it cannot
revoke a sibling branch's values.
