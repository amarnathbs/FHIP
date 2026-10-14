# Module 11 (AI Coach, Insight Pack, Next Best Action, contextual Explain): notes for AFTER its merge

Read-only inspection. I did not touch `integration/module11-0-to-11-7-20261014` or `m11-7-ai-coach-beta-20261001`; I read
their committed files with `git show` / `git grep` only (integration branch at 57b9c5f, 20 commits ahead of `main`).
Nothing here duplicates that agent's work; it is what to check once it lands, and the one patch that will then be needed.

## What is on `main` today (nothing for me to change)

Standard questions (`/ai-insights`) and contextual Explain/Why? exist and are already Premium-only through
`ai_entitlement_state` (window-aware). They never call a provider and had no pilot list. The Insight Pack service has
only an admin trigger on mock data. There is **no** AI Coach route, **no** Next Best Action, **no** scheduler and no
live Module 11 provider on `main`. So for these, the correct report is: **not on `main`, blocked on the Module 11 merge**.

## What I read on the Module 11 branches (so you know what the merge brings)

| Item | Finding | Action after merge |
|---|---|---|
| `app/api/ai/coach/questions` | Premium decided by `AIEntitlementService` (`ai_entitlement_state`), then `ai_admit_request` (quota, rate limit, budgets, kill switches) before any provider call. No pilot or e-mail list anywhere in `lib/ai` or `app/api/ai` (git grep). | Nothing to remove. Verify with `git grep -n -i "cohort\|pilot\|allowlist.*email" -- lib/ai app/api/ai` after merge |
| `app/api/ai/next-best-actions` | Deterministic, structurally cannot call a provider; scope from `resolveHouseholdContext` | Not a paid feature; confirm the Premium rule you want for it (it has no Premium check in the file I read) |
| `app/api/ai/cron/insight-pack-monthly` + `lib/ai/insightPack/scheduler` | Cron-secret authenticated. Shipped OFF (`scheduler_enabled` ships false, migration 0176; nothing schedules it). Eligibility: `listPremiumSubjects` then `isPremiumEligible` (the DB entitlement) per subject, so pilot users get no special treatment | See the two scheduler findings below |
| Environment | `MODULE11_AI_PROVIDER`, `MODULE11_AI_MODEL`, `OPENAI_API_KEY` | **`amplify.yml` forwards neither `MODULE11_` nor `OPENAI_API_KEY` on either branch.** They would be absent at runtime in production: the same defect class this repository has hit before (Stripe, AIE). Add `-e MODULE11_ -e OPENAI_API_KEY` to the build's grep list as part of that merge |

## Scheduler findings (real, for the Module 11 owner; I did not change them)

1. `schedulerDbClient.listPremiumSubjects(limit)` selects `plan_tier = 'premium'` with **no validity-window filter** and
   `order by user_id limit maxHouseholds * 4`. Access is still correct because each subject is re-checked through
   `isPremiumEligible` (window aware), but expired grants occupy universe slots.
2. The same query has **no cursor and no "already has this month's pack" exclusion**. Once Premium users exceed
   `maxHouseholds * 4`, the highest user ids are never reached if the lowest ones keep filling the universe. Wide Premium
   access makes this real. Suggested fix: keyset pagination on `user_id` persisted between runs, or exclude subjects that
   already hold a pack for the billing period in the query itself, plus the window predicate:
   `.or('effective_from.is.null,effective_from.lte.<today>').or('effective_to.is.null,effective_to.gte.<today>')`.
3. Acceptance for the scheduler under this instruction: "prove actual eligible-user selection through the real worker path"
   needs a run with `dryRun: true` on DEV against at least three synthetic users (Premium outside any list, Free, lapsed) and
   the result showing `not_premium` skips for the last two. The branch has the dry-run switch already.

## The one patch this change will need after the merge

`tests/unit/premiumAiGuardCoverage.test.ts` scans for provider-reaching call shapes and fails for any file that is neither
guarded nor listed. The merged Module 11 files (for example `lib/ai/coach/coachDependencies.ts`, the insight-pack provider
wiring) will be reported until they are added to `MUST_GUARD` (with the guard token they really use, for example
`/getAIPlanEntitlement\(/` or `/ai_admit_request/`) or to `BUILDING_BLOCKS` with a reason. That is intended: a new
provider path must be consciously classified.

## Who may activate what (reminder)

The Coach's live provider, the scheduler flag and the Admin AI console are operational decisions that this change does not
make. Premium eligibility is already the only "who" rule in that code.
