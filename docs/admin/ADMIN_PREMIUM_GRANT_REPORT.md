# Admin-allocated Premium (manual entitlement grants) — implementation report

Branch: `feat/admin-premium-grant-20261001` (from `origin/main` 35956a7). Not pushed, not merged.
Migration: `supabase/migrations/0231_admin_premium_entitlement_grants.sql` — **NOT applied to DEV or production.**

## 0. Evidence labels (read this first)

| Claim | Label |
|---|---|
| Feature (migration, RPCs, routes, page, nav, user-facing wording, webhook merge, window-aware consumers) | **code-complete** |
| Database rules (capability, 365-day cap, reason, paid protection, audit atomicity, webhook merge, AI-path expiry, RLS, isolation) | **verified on an isolated PGlite replay of the full migration ledger** (40 tests). Not DEV-verified. |
| Application layer (route guards 401/403, server-side validation, error mapping, window-aware tier, plan wording, webhook RPC path, nav capability) | **unit-tested** (49 tests, hermetic fakes) |
| Anything on DEV | **NOT DEV-verified.** Only read-only facts were measured (section 8). The DEV end-to-end proof script is written but **was not run**. |
| Anything on production | **NOT production-verified.** Production was not touched or queried. |
| The admin page in a browser | **not rendered or visually verified** (no authenticated session with the new capability exists anywhere, and the repo has no DOM test environment). `tsc` and `eslint` only. |

## 0b. PO decisions received after this report (2026-10-01)

Recorded in full in `ADMIN_PROMO_CODES_AND_REMINDERS_REPORT.md` (a separate commit on top of this one; this commit stands alone).

| Decision from section 11 | PO answer |
|---|---|
| 1. Who gets `can_manage_premium_entitlements` | Only people the PO names; default unchanged (nobody until the PO runs the update). |
| 2. Standard §9 (emails shown; pseudonymous ids retained after account deletion) | **APPROVED by the Product Owner.** The "Unapproved item" in section 5 is now approved. |
| 3. Lifetime cap on chained extensions | Max **5 extensions per grant** (implemented in the follow-up commit, migration 0237). |
| 4. Refuse (no override) on paid Premium; refuse self-grants | **APPROVED**: keep refusing. |
| 5. Expiry notifications | In scope: in-app reminders and an admin monthly summary built in the follow-up commit; email reminders not built (no existing scheduled mailer). |
| 6. Production `effective_to` check query | Acknowledged. |

## 1. What was asked, and what was built

PO request: let an admin allocate Premium to a user who has not paid online, for up to one year from the date of allocation, extendable by an admin.

Built:

- **Admin page** `/admin/entitlements` (nav group "Entitlements" -> "Premium Access"): list of admin grants (tabs: *Expiring within 30 days* (default), *All active*, *Lapsed*), user search by email fragment (3+ chars) or full user id, per-user Grant / Extend / Revoke forms (end-date picker capped at today+365, mandatory reason), and per-user history from the audit trail.
- **Routes** (all behind `requirePremiumEntitlementAdmin()`):
  - `GET  /api/admin/entitlements/users?q=`
  - `GET  /api/admin/entitlements/users/[id]/history`
  - `GET  /api/admin/entitlements/grants?filter=expiring|active|lapsed&withinDays=`
  - `POST /api/admin/entitlements/grants` `{action: grant|extend|revoke, userId, endsOn, reason}`
- **Migration 0231**: `user_entitlements.entitlement_source` (`payment` default | `admin_grant`) and `admin_grant_ends_on`; `admin_users.can_manage_premium_entitlements`; append-only `admin_entitlement_events`; SECURITY DEFINER RPCs `admin_manage_premium_entitlement` (the only write path), `admin_search_premium_entitlement_users`, `admin_list_premium_grants`, `admin_premium_entitlement_history`, `is_premium_entitlement_admin`; and `apply_subscription_entitlement_event` (webhook merge, service_role only).
- **Window-aware consumers** (new `lib/services/entitlementWindow.ts`): `getPlanTier` and everything behind it now honour `effective_from`/`effective_to`; admin Premium counts count Premium-today.
- **User-facing**: `GET /api/payments/status` + `BillingPanel` show "Premium (granted by FHIP admin, ends 12 Oct 2026)", and "Free (your Premium access granted by FHIP admin ended ...)" after lapse. No billing flow was invented; users with a grant can still subscribe (payment wins, see section 4).

## 2. Inventory: every consumer / writer of `user_entitlements` and `plan_tier`

(grep over `app`, `lib`, `components`, `tests`, `scripts`, `supabase/migrations`, run on origin/main)

### Writers

| Where | What it does | Status after this work |
|---|---|---|
| `supabase/migrations/0010` | creates table, `select-own` RLS policy only, signup trigger inserting a `free` row | unchanged; "users cannot write" boundary intact (PGlite test) |
| `supabase/migrations/0133` | adds provider/subscription columns, `payment_webhook_events` | unchanged |
| `lib/services/payments/entitlementSync.ts` `applySubscriptionEvent` (called by the Stripe **and** Razorpay webhook routes) | blind `UPDATE plan_tier` per event | **changed**: calls `apply_subscription_entitlement_event` RPC (merge), legacy write only if the function is absent |
| `lib/services/payments/stripeCheckout.ts` | writes `provider`, `provider_customer_id` | unchanged (does not touch tier) |
| `lib/services/payments/razorpaySubscription.ts` | writes `provider`, `provider_subscription_id`, `subscription_status='incomplete'` | unchanged (does not touch tier) |
| `admin_manage_premium_entitlement()` (0231) | grant / extend / revoke | new, the only admin write path |
| Test/cert fixtures: `scripts/r10_*`, `r11_*`, `r12_*`, `fdh16_*`, `module11_*_live_dev_*`, `db-rebuild-check/module11_1_entitlement_cert.mjs`, `tests/live-dev/*`, `tests/unit/support/pgliteInsightPackHarness.ts` | service-role/SQL `plan_tier` updates on synthetic users | unchanged |

### Readers

| Where | Honoured `effective_to` before? | After |
|---|---|---|
| `ai_entitlement_state()`, `ai_admit_request()` (0115, SQL) | yes | unchanged; lifecycle re-proved on PGlite |
| `lib/services/entitlements.ts` `getPlanTier`, `canExportReports`, `canViewPremiumReport` | **NO (bare flag)** | **fixed** (window-aware) |
| -> `app/(app)/recommendations/page.tsx` | via getPlanTier | fixed transitively |
| -> `app/api/forecast/report/export/route.ts` | via canExportReports | fixed transitively |
| -> `app/api/reports/[id]/exports/route.ts` | via canExportReports | fixed transitively |
| -> `lib/services/reportSnapshotResolver.ts` (report content, also run by the monthly cron) | via getPlanTier | fixed transitively |
| `app/api/reports/cron/monthly-generate/route.ts` | reads only the user list | n/a (tier comes from getPlanTier downstream) |
| `app/api/payments/status/route.ts` | **NO** | **fixed** + grant fields |
| `app/api/admin/ai/entitlements/route.ts`, `lib/ai/entitlement/platformControls.ts` (admin Premium counts) | **NO** (counted the flag) | **fixed** (`countEffectivePremium`) |
| `app/api/payments/invoices/route.ts` | reads provider ids only | n/a |
| `app/api/user/billing-country/confirm/route.ts` | reads `subscription_status` only | n/a (admin grants have no subscription) |
| `lib/ai/entitlement/aiEntitlementService.ts`, `entitlementService.ts` | via the two RPCs above | n/a |
| `lib/ai/entitlement/capabilities.ts` `resolveAICapabilities` | pure function of a tier it is handed; **no production caller** | n/a (callers should pass `getPlanTier`) |
| `scripts/mcc_production_readonly_audit.mjs` | reads the bare flag | not changed (operator script, read-only) |

A static test (`adminPremiumGrantService.test.ts`, "static inventory guard") now fails if any file under `app/`, `lib/` or `components/` reads `user_entitlements.plan_tier` without referencing the window, so a future reader cannot reintroduce the gap.

**Behaviour change, disclosed:** any existing row that is `premium` with an `effective_to` in the past previously kept report export/Premium report content (only the AI path denied it) and now correctly reads as Free there. On DEV this affects 0 rows (section 8). **Production was not queried**; before deploying, the PO should run `select count(*) from user_entitlements where effective_to is not null;` on production (read-only).

## 3. Design decisions and interpretations (where the request was silent)

1. **Cap.** A grant's end date must be `<= current_date + 365` days (UTC date, end date inclusive). UI default is the cap. 366 days is rejected, exactly 365 accepted. Enforced in the database function (authoritative) and again in the route (early, friendlier error); the date picker is only a convenience.
2. **Extension interpretation.** Each extension sets a new end date `<= date of the extension + 365`. While a grant is still active the new end date must be strictly later than the current one (a shortening is not an extension; use Revoke). Extending a lapsed grant re-activates it **from today**. Note: because the cap restarts at each extension, repeated extensions are unbounded in total — see PO decisions.
3. **Revoke** = back to `free`, source reset to `payment`, window and grant markers cleared. It never revokes a paid/manual Premium.
4. **Paid entitlement protection: REFUSE, no override.** If the target currently has active Premium that is not an admin grant (Stripe/Razorpay, *or a manually SQL-set Premium that pre-dates this migration — those are indistinguishable*), grant, extend and revoke all fail with `ENTITLEMENT_PAID_ACTIVE` (409) and change nothing. Chosen over an audited override because overriding a paying customer is a one-way mistake; the PO can resolve a legitimate case in SQL deliberately. A *lapsed* paid/other row is not active, so an admin may grant to it.
5. **No self-targeting**: an admin cannot grant/extend/revoke their own account (separation of duties).
6. **Mandatory reason**: trimmed, 10 to 1000 characters, for all three actions.
7. **Audit**: one append-only row per *successful* action (actor, target, reason, requested end date, before/after tier, source, from/to dates), written in the same transaction as the change. Rejected requests write no row. `UPDATE`/`DELETE`/`TRUNCATE` are refused by trigger even for the table owner. `actor_user_id`/`target_user_id` deliberately have **no foreign key** so account deletion neither breaks nor edits the trail (retention decision flagged below).
8. **Capability**: new `admin_users.can_manage_premium_entitlements` (default false), separately named, **not implied by Super Admin** (Standard §3 requires explicit PO approval for any implied inheritance) and not implied by any other capability. Consequence: **nobody holds it until the PO runs the SQL in section 9.**
9. **Expiry warning (d)**: the page's default tab is "Expiring within 30 days" (RPC `admin_list_premium_grants('expiring', 30)`), plus "All active" and "Lapsed". No email/notification to admins or users is sent (not built).
10. **Dates are UTC.** A grant ending on D works through the whole UTC day D, matching the database's `current_date` on Supabase. An AU/India user's last day therefore ends at 10:00/05:30 local time the next morning.
11. **Expiry behaviour**: when `effective_to` passes, nothing runs; the window predicate simply stops matching, so every consumer returns to Free. Historical AI usage is preserved (0115 design).
12. **Search privacy**: needs >= 3 characters (or a full user id), returns <= 20 rows, minimal columns (email + entitlement state), no financial data.

## 4. Stripe / Razorpay interaction analysis (requirement 4a)

Problems found in the **pre-existing** webhook path (`UPDATE plan_tier` per event, never touching `effective_to`):

- A successful payment would set `plan_tier='premium'` but leave the grant's `effective_to`, so **a paying customer would be cut off on the admin grant's expiry date.**
- A `customer.subscription.created` with status `incomplete` (checkout started, never finished) or any `canceled` event would set `plan_tier='free'`, **silently removing an unexpired admin grant.**

Fix: the merge runs atomically in the database (`apply_subscription_entitlement_event`, row-locked, so it cannot race an admin action). Whether a status confers Premium is still decided in one place in TypeScript (`PREMIUM_SUBSCRIPTION_STATUSES`) and passed in.

| Event on a user holding an admin grant ending G | Result |
|---|---|
| `incomplete` / abandoned checkout | unchanged: Premium, source `admin_grant`, ends G |
| payment succeeds (`active`/`trialing`/`past_due`) | **payment wins**: Premium, source `payment`, `effective_to = null` (governed by subscription status); `admin_grant_ends_on = G` kept as a reserve |
| subscription later cancelled, G still in the future | **grant restored** (Premium, source `admin_grant`, ends G) — not a downgrade |
| subscription cancelled after G has passed | Free (correct) |
| admin tries grant/extend on a user whose payment is active | refused 409 (protected) |
| admin Revoke while payment is active over a reserved grant | clears only the reserve; the paid entitlement is untouched |

Tests with negative controls: section 6. Deploy-order safety: if the code is live before the migration, `apply_subscription_entitlement_event` is absent (PGRST202/42883) and the webhook falls back to the legacy write — safe only because no grants can exist before 0231. Any other RPC error is thrown so the provider retries.

## 5. Standard compliance (AGENTS.md requirements)

- **Admin capability affected:** new `can_manage_premium_entitlements` (nav field `entitlementManagement`). No existing capability changed.
- **Clauses and the tests proving them:**
  - §2 capability-based access / §13 fail closed: guard reads its own column fresh every call; read error or missing column = 403. Tests: service "authorisation" x4 routes (401 / not admin / capability-less admin / role-lookup failure / positive control); PGlite "authorisation".
  - §3 multi-role: Super Admin and all other capabilities do not imply it. Tests: nav test; `/api/admin/me` test.
  - §4 navigation is not authorisation, four layers: DB (RPC predicate + RLS policy; PGlite), API (route guard; service tests = direct-API), page (`requirePremiumEntitlementAdminPage` redirects; service test = direct-URL), nav (hidden unless capability; nav test). Database-bypass test: PGlite calls the RPCs directly as `authenticated` non-admin, capability-less admin, `anon`, `service_role` (no `auth.uid()`).
  - §5 least privilege: capability is distinct; Analyst has none of it.
  - §6 privileged-RPC pattern: public-schema SECURITY DEFINER wrappers, internal `auth.uid()` + capability predicate, fixed `search_path`, fixed return shapes, no dynamic SQL, `EXECUTE` revoked from `PUBLIC`/`anon`. Note §6's "aggregate-only" rule targets analytics; these are operational mutation RPCs, and the search RPC returns identity rows by necessity (see §9 below).
  - §9 personal-data boundary: **see "Unapproved item" below.**
  - §14 no hidden scope expansion: changes outside the new feature are limited to what was necessary to keep the boundary: `getPlanTier` window (expiry), webhook merge (payment vs grant), status route + admin counts (plan_tier readers). Incidental finding not fixed: 3 pre-existing failures in `scripts/db-rebuild-check/module11_1_entitlement_cert.mjs` (identical on main without 0231: two task-limit set checks, and MATRIX 12 which already trips on 0133's constraints).
  - §15 docs: this report (capability map above, nav contract: group "Entitlements" -> `/admin/entitlements`, operating instructions in section 9, known limitations in section 10, rollback in the migration header, future-review owner: PO).
- **Exceptions requested (§16):** none.
- **Unapproved item (§9, second paragraph):** the surface displays user emails (search results, history actor emails) and retains pseudonymous user ids in an append-only table after account deletion. §9's prohibition is written for analytics, and the existing Account Deletion queue already shows emails, but a *proposed use of personal data in an Admin surface* needs PO approval. **Status: not yet approved.**

## 6. Tests

All run with `npx vitest run <file>` from the worktree.

New:

- `tests/unit/adminPremiumGrantPglite.test.ts` — **40 tests, all pass.** Replays the whole ledger (0001..0231) into PGlite and drives the real functions as the real roles.
- `tests/unit/adminPremiumGrantService.test.ts` — **49 tests, all pass.**

Modified existing: `tests/unit/entitlementSync.test.ts` (fake now models "0231 not applied", so the legacy mapping tests still run), `tests/unit/adminAnalyticsPhaseA.test.ts` (capability literals gain `entitlementManagement`).

Regression run of 14 existing suites (608 tests: 607 passed, 1 timed out at 5 s under parallel load and passed in isolation — the known repo hazard): `migrationVersions`, `migrationVersionsCrossBranch`, `appReview0915MigrationTextLeakGuard`, `entitlementSync`, `adminAnalyticsPhaseA`, `adminAnalyticsPhaseARouteMatrix`, `forecastReportExportEntitlement`, `reportCanonicalSections`, `billingCountryConfirmRoute`, `accountDeletionAdminRoutes`, `countryGateAdminAndHousehold`, `aiEntitlementServiceAndCapabilities`, `aiEntitlementEnforcement`, `pc7LookthroughFoundation` (the timed-out one was `forecastReportExportEntitlement`).

### Requirement 8 checklist and negative controls

A negative control runs the same assertion against a copy of the function/rule with exactly that rule removed; the test requires the **named assertion** to go red (a failure for any other reason does not count). In the PGlite suite the mutation is verified to have changed the SQL and the real function is restored afterwards.

| Rule | Positive test | Negative control (assertion that goes red) |
|---|---|---|
| 366 days rejected, exactly 365 accepted (grant) | PGlite "366 days is rejected, exactly 365 days is accepted"; service "grant: 366 days rejected, exactly 365 accepted" | PGlite: cap removed -> `expected rejection with ENTITLEMENT_END_DATE_EXCEEDS_MAX`; service: cap weakened to 400 -> `366 days must be rejected` |
| Extension cap (measured from the extension date) | PGlite "an extension is capped at 365 days from the DATE OF THE EXTENSION"; service "extend: 366 rejected" | PGlite: cap removed -> `expected rejection with ENTITLEMENT_END_DATE_EXCEEDS_MAX` (extension case) |
| Reason required | PGlite + service (empty / whitespace / <10 chars, all three actions) | PGlite: check removed -> `expected rejection with ENTITLEMENT_REASON_REQUIRED`; service: skipped rule -> `reason "" must be rejected` |
| Non-admin 403 / capability-less admin 403 / unauthenticated 401, every route | service (4 routes x 5 cases); PGlite RPCs (+ anon, service_role) | PGlite: capability check removed -> `expected rejection with ENTITLEMENT_ADMIN_REQUIRED`; service: a bare `requireAdmin()` admits the capability-less admin (shown), proving the dedicated capability is what the 403 tests discriminate |
| Expiry returns user to Free: AI path | PGlite lifecycle on real `ai_entitlement_state` + `ai_admit_request` (grant -> eligible; backdate -> `premium_required` / `entitlement_expired`; extend -> eligible; revoke -> `premium_required`) | AI function with `effective_to` check removed -> `expired -> not eligible` |
| Expiry returns user to Free: every other consumer | service `getPlanTier` / `canExportReports` / `canViewPremiumReport` / status route / `countEffectivePremium`; static inventory guard | the pre-0231 bare-flag reader keeps an expired grant premium -> `expired grant must read as free`; detector flags a synthetic bare-flag reader |
| Stripe payment does not shorten / silently downgrade an admin grant | PGlite "Stripe/Razorpay webhook merge" (incomplete, paid, cancel-restores, lapsed-then-free) | webhook without the reserve-restore -> `incomplete checkout must not downgrade an admin grant`; webhook leaving the grant end date on a payer -> `a paying customer must not be cut off at the admin grant expiry` |
| Paid entitlement not clobbered by a grant (grant/extend/revoke all refused, row byte-identical, no audit row) | PGlite "a genuine paid entitlement is never clobbered" (+ manual premium protected; lapsed paid grantable) | paid-protection removed -> `expected rejection with ENTITLEMENT_PAID_ACTIVE` |
| Audit row per action, none for a rejected one, append-only | PGlite "audit trail" (before/after values, UPDATE/DELETE/TRUNCATE refused, history RPC) | audit insert removed -> `grant writes exactly one audit row` |
| Cross-user isolation (granting A never changes B) | PGlite "cross-user isolation" | grant UPDATE without its `WHERE user_id` -> `B row must be byte-identical` |
| Users cannot write `user_entitlements` / `admin_users`; cannot call the RPC for themselves | PGlite "users cannot write user_entitlements or admin_users themselves"; service "a user cannot call the routes for themselves" | (covered by the capability control) |

Static checks: `npx tsc --noEmit` = 66 errors, identical to the stated baseline (all missing `pdf-parse`/`xlsx`/`stripe`/`razorpay` modules), **0 in touched files**. `npx eslint` on all touched/new files: clean.

## 7. Migration number and collision check

Highest on `origin/main`: 0227. Scanned (a) every local and remote ref's `supabase/migrations/` with `git ls-tree` over all ~790 refs and (b) the working directory of the main checkout and every worktree under `D:\FHIP\.claude\worktrees`, plus the three temp worktrees. Claimed elsewhere: 0175-0178, 0228, 0229 (aie1/cron branches and worktrees), 0230 (`module11_7`, worktrees `m117-*`/`agent-af49d...`). Highest found anywhere: **0230**, so this migration is **0231**. Re-scanned immediately before the final commit after a fresh `git fetch origin --prune` (790 refs + every worktree directory): highest claimed anywhere is still 0230; nothing else uses 0231 or higher. Both repo checker scripts are known to be blind to unmerged siblings, which is why this scan was done by hand. The migration only **adds** (columns, tables, functions, new constraints on new columns) — it does not drop or recreate any existing CHECK constraint, so it cannot revoke a sibling branch's values.

If a sibling takes 0231 first, rename this file to the next free number; nothing else references the number.

## 8. What was and was not verified on DEV

Read-only measurements only (GET requests with the existing DEV service key; project ref confirmed `vqycarelcoijzwlpkpcz` and different from production; nothing created, modified or deleted; no accounts created or signed in):

- Migration 0231 is **not applied** on DEV: `user_entitlements.entitlement_source` and `admin_users.can_manage_premium_entitlements` do not exist; the functions `admin_manage_premium_entitlement`, `apply_subscription_entitlement_event`, `is_premium_entitlement_admin` do not exist. `ai_entitlement_state` and `ai_admit_request` do exist.
- DEV `user_entitlements`: 416 rows, 50 premium; **0 premium rows have `effective_to` set, 0 have a provider**. So the window-aware `getPlanTier` changes nothing for any existing DEV row.

**Not done: the DEV end-to-end lifecycle** (grant -> eligible -> backdate -> `premium_required` -> extend -> eligible -> revoke -> `premium_required`). Reasons: (1) no sanctioned DDL path to DEV is available unattended (the environment holds REST keys only, no database URL or management token), so the migration cannot be applied; (2) the proof needs two synthetic accounts, and creating accounts was out of bounds. The same lifecycle **is** proven on the isolated PGlite replay against the real `ai_entitlement_state` / `ai_admit_request` SQL (section 6). `scripts/admin_premium_grant_dev_proof.mjs` performs the DEV version for the PO after applying the migration; it refuses any project except DEV, refuses to run if 0231 is absent, uses random never-printed passwords, and cleans up (the append-only audit rows for the deleted synthetic users remain, by design). It has been syntax-checked and linted but **never executed**.

## 9. PO apply steps (DEV first; production only after merge approval)

1. **Apply** `supabase/migrations/0231_admin_premium_entitlement_grants.sql` to DEV in the Supabase SQL editor. It is idempotent and additive (guarded `if not exists` / `create or replace`).
2. **Verify** (read-only):
   ```sql
   select column_name from information_schema.columns
    where table_schema='public' and table_name='user_entitlements' and column_name in ('entitlement_source','admin_grant_ends_on');          -- 2 rows
   select column_name from information_schema.columns
    where table_schema='public' and table_name='admin_users' and column_name='can_manage_premium_entitlements';                                -- 1 row
   select proname from pg_proc where pronamespace='public'::regnamespace
     and proname in ('admin_manage_premium_entitlement','admin_search_premium_entitlement_users','admin_list_premium_grants',
                     'admin_premium_entitlement_history','is_premium_entitlement_admin','apply_subscription_entitlement_event');             -- 6 rows
   select has_function_privilege('anon','public.admin_manage_premium_entitlement(text,uuid,date,text)','execute');                           -- false
   ```
3. **Grant the capability** to the admin(s) who should manage Premium (nobody has it by default):
   ```sql
   update admin_users set can_manage_premium_entitlements = true
    where user_id = (select id from auth.users where email = '<admin email>');
   ```
4. **Run** `node scripts/admin_premium_grant_dev_proof.mjs` against DEV (expects all checks PASS, exit 0), then open `/admin/entitlements` as that admin and try grant / extend / revoke on a *test* account.
5. **Production, later:** before deploying, run read-only `select count(*) from user_entitlements where effective_to is not null;` (behaviour-change check, section 2). Apply 0231 first, then deploy (code is safe in either order: routes fail closed 403, status route tolerates missing columns, webhook falls back to the legacy write; but the new page does nothing useful until the migration and capability exist). Never run the DEV proof script against production (it refuses).
6. **Rollback:** code revert, plus the SQL in the migration header (drops the audit trail and grant markers — export `admin_entitlement_events` first if any grants were made).

## 10. Known limitations

- No notification (email/in-app) to admins or users when a grant is about to expire; admins see the 30-day list only when they open the page.
- A manually SQL-set Premium (pre-0231) is indistinguishable from a paid one and is protected the same way.
- UI behaviour (date picker clamp, button states, confirm step) is type-checked and linted but not exercised in a browser.
- `resolveAICapabilities(planTier)` has no production caller; if one is added it must be passed the window-aware tier.
- The audit table has no FK to `auth.users` (intentional); retention after account deletion is a PO decision.

## 11. Decisions needed from the Product Owner

1. **Who gets `can_manage_premium_entitlements`** (step 3 above), and whether Super Admin should imply it (needs explicit approval under Standard §3; not assumed).
2. **§9 acknowledgement**: emails shown in user search and history; pseudonymous ids retained in the audit table after account deletion. Approve, or ask for masking/retention limits.
3. **Lifetime cap on chained extensions?** As specified ("each extension up to 1 year from the extension"), repeated extensions are unbounded.
4. **Confirm "refuse" (not an audited override)** for a user with active paid/manual Premium, and **refuse self-targeting**.
5. **Expiry notifications** (to admins and/or to the user) — not built.
6. Whether to schedule a fix for the 3 pre-existing failures in `module11_1_entitlement_cert.mjs` (out of scope here).
