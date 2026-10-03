# Promo codes, extension cap and expiry reminders — implementation report

Branch: `feat/admin-premium-grant-20261001`. This work is a SEPARATE commit (or commits) on top of the first commit `2a7a36d` (admin grant / extend / revoke), which stands alone and does not depend on anything here. Sibling of `ADMIN_PREMIUM_GRANT_REPORT.md`. Not pushed, not merged.

Migration: `supabase/migrations/0237_admin_promo_codes_extension_cap_expiry_summary.sql` — **NEW migration on top of 0231; 0231 was not edited** (the PO may already have applied it on DEV; nothing here changes an applied migration's semantics in place). **NOT applied to DEV or production.**

## 0. Evidence labels

| Claim | Label |
|---|---|
| Promo codes, extension cap, expiry summary, in-app reminders | **code-complete** |
| Database rules (extension cap, promo capability separation, create/disable/redeem rules, max-redemption backstop, generic verdicts, rate limits, paid refusal, never-shorten, Stripe merge with a promo, summary buckets) | **verified on an isolated PGlite replay of the whole migration ledger** (see section 7 for counts) |
| Application layer (route guards, validation, redeem route abuse controls, extension pre-check, reminder rules, plan wording, summary route, nav) | **unit-tested** with hermetic fakes |
| Anything on DEV | **NOT DEV-verified**: the migration is not applied and no unattended DDL path exists. `scripts/admin_premium_grant_dev_proof.mjs` was extended (part 2) for the PO to run; it has **never been run**. |
| Production | **NOT touched, NOT verified.** |
| Screens in a browser (promo console, summary section, profile promo field, notice banner) | **not rendered**; `tsc` + `eslint` only |
| True concurrency of simultaneous redemptions | **not exercised**: PGlite is single-connection. Guaranteed by construction (row lock + independent CHECK, the CHECK is tested) and probed by the DEV script (8 parallel redeemers of a max-3 code). |

## 1. PO decisions recorded

1. `can_manage_premium_entitlements` goes only to people the PO names; default unchanged (nobody). The new `can_manage_promo_codes` has the same rule.
2. **Admin Standard §9 APPROVED by the Product Owner:** the admin console shows user emails (user search, grant lists, history actor emails, promo redemption audit actors) and the audit tables keep pseudonymous user ids (no foreign key) after account deletion. Recorded here and in `ADMIN_PREMIUM_GRANT_REPORT.md`.
3. Extension cap: max **5** extensions per grant (section 2).
4. APPROVED: keep **refusing** (no audited override) for users holding paid Premium and for self-grants. The promo flow follows the same rule for paid Premium.
5. Expiry reminders are in scope (section 5).
6. Production check query acknowledged (`select count(*) from user_entitlements where effective_to is not null;` before deploying).

## 2. Extension cap — exact semantics

- **One named constant on each side:** SQL `public.premium_grant_max_extensions()` (returns 5) and TypeScript `MAX_EXTENSIONS_PER_GRANT` in `lib/services/premiumGrantAdmin.ts`. A test asserts they agree.
- **Enforced twice:** authoritative in `admin_manage_premium_entitlement()` (under the row lock; error `ENTITLEMENT_EXTENSION_LIMIT_REACHED`), and in the route (`POST /api/admin/entitlements/grants`, `extend`): the route reads the user's extension count first and refuses with a 409 and a clear message before the write path. If that lookup fails the request proceeds and the database enforces the cap (a failed lookup is never read as "under the limit").
- **What counts as "a grant":** one allocation — an admin **Grant**, or a **promo redemption**. It starts at `extension_count = 0`.
- **What counts as "an extension":** one **successful** admin **Extend** on that grant, including re-activating a lapsed grant. Rejected attempts (not later, over 365 days, missing reason, at the limit, paid-protected) do not count.
- **When the counter resets:** when a **new grant starts** — an admin Grant after a Revoke (or after the previous grant lapsed), or a promo redemption. **Revoke** also clears it. **Revoke + re-Grant by an admin is allowed and is the sanctioned way past the cap; both actions are audited** (each audit row now carries `extension_count_after`).
- A paying subscription **keeps** the counter (the grant is held in reserve and restored with its count if the subscription lapses first).
- An admin extending a **promo-sourced** entitlement converts it to `admin_grant` (an admin now decides its length) and counts as extension 1.
- Rows created before 0237 start at 0 (column default); an in-flight 0231 grant therefore gets a fresh allowance of 5 on the day 0237 is applied.
- UI: the Extend button is disabled with an explanation when `extensions_remaining` is 0; lists show "Extensions left".

## 3. Promo codes — design

**Data (all RLS-enabled; users can read none of it):** `promo_codes` (code stored normalised, masked `code_hint`, `duration_days` 1..365 default **30** (changed by migration 0238; 0237 originally defaulted to 365), `max_redemptions` nullable, `redemption_count`, `expires_on`, note, status), `promo_code_redemptions` (unique per user per code), append-only `promo_code_events` (create / disable / redeem), `promo_redemption_attempts` (rate-limit ledger). `promo_codes` rows can never be deleted (trigger); events are append-only (trigger, also TRUNCATE).

**Capability:** `admin_users.can_manage_promo_codes` + `is_promo_code_admin()`, **separate from `can_manage_premium_entitlements`** (Standard §3): holding either never confers the other, not implied by Super Admin; nobody holds it by default. Nav: separate group "Promo Codes" (`promoCodeManagement`) at `/admin/entitlements/promo-codes`. Layers: DB (functions + RLS), API (`requirePromoCodeAdmin`), page (`requirePromoCodeAdminPage`), nav.

**Admin surface** (`/admin/entitlements/promo-codes`, `/api/admin/promo-codes*`): create (code admin-chosen or generated; access length <= 365, **default 30 days (one month)** per the later PO decision (see section 12); **max redemptions finite by default (100), unlimited only by an explicit "Unlimited" choice; expiry date default +90 days, no expiry only by an explicit choice**; optional note), list (state: active / disabled / expired / exhausted), disable (mandatory reason, audited, stops future redemptions only — Premium already granted is not revoked), audit trail view.

**Codes:** 31-character unambiguous alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no 0/O/1/I/L), 6–24 characters; admin-chosen codes obey the same alphabet; generated codes are 10 characters from the database CSPRNG (`gen_random_uuid`, rejection-sampled, no modulo bias). Case-insensitive; whitespace, hyphens and underscores ignored; TypeScript and SQL normalisers are tested to agree.

**User redemption** (`POST /api/payments/promo/redeem`, field on the Profile page's plan/billing panel):
- Only reachable through the authenticated route. The SQL function `redeem_promo_code_for_user(user, code, ip_hash)` is granted to **`service_role` only**; the user id is the session user, never the request body.
- **Atomic:** locks the user's entitlement row then the promo row (`FOR UPDATE`, always that order), so `max_redemptions` cannot be exceeded under concurrency; an independent `CHECK (redemption_count <= max_redemptions)` is a second guard.
- **One redemption per user per code** (unique constraint + explicit verdict "You have already used this code.").
- **Duration:** a redemption on date R ends on R + `duration_days` (inclusive) — the same convention as the 365-day admin cap; never more than 365 days.
- **Paid Premium: REFUSED** (`PROMO_PAID_ACTIVE`), independent of the code, never clobbered or stacked.
- **Existing admin grant / promo:** the later end date wins and an entitlement is **never shortened**. If the code would not extend it, the response is the same generic "This code cannot be used." and **no redemption is consumed**; a longer code extends it (keeping the start date). A lapsed grant does not block: the promo restarts from today.
- **Result:** the same kind of entitlement as an admin grant but `entitlement_source = 'promo_code'` and the code **id** on the row (`promo_code_id`); the honest plan text is **"Premium (promo code, ends <date>)"**; it expires back to Free through `effective_to` like a grant; audited as a `redeem` event.
- **Stripe/Razorpay:** exactly as for admin grants (payment wins, `effective_to` cleared on a paying customer, the promo kept in reserve and restored on cancellation **with its original source `promo_code`** — the webhook function now reads `reserve_source`).

**Abuse controls:**
- **Rate limit:** 10 attempts per user and 30 per IP-equivalent per 15 minutes. Attempts are recorded **even when they fail**: the function returns a verdict instead of raising, so the transaction commits (tested: the 10 failed attempts persist and the 11th is refused even with a valid code). IP-equivalent = HMAC-SHA256 of the first `X-Forwarded-For` hop keyed by `PROMO_IP_HASH_SECRET` (falling back to `CRON_SECRET`); the raw address is never stored. **With neither secret configured only the per-user limit applies** (see decisions).
- **No existence oracle:** non-existent, disabled, expired, exhausted and no-benefit codes all return the **identical** verdict through the same code path, with the same message "This code cannot be used." The only distinct user messages are "you already hold paid Premium" (independent of the code) and "you have already used this code" (only reachable by someone who already redeemed that code). Helper text on the form states the static rules ("will not shorten Premium you already have").
- **No code value** in logs, the attempts ledger, `promo_code_events` (id + masked hint only; the free-text note is not copied either), or error responses (tested by dumping the tables and spying on console).
- Input normalisation; bad shapes get the same generic refusal without touching the database.
- **Not built, per instruction:** any marketing/email distribution of codes.

## 4. Expiry summary (admin screen)

`GET /api/admin/entitlements/summary?source=` -> RPC `admin_entitlement_expiry_summary`: admin-grant and promo entitlements whose last day is in the **current UTC month**, as **expired this month** (end date before today) and **expiring in the rest of this month**, with counts overall and per source, filterable by source (all / admin grant / promo code). Each row has **History / Extend** (opens the user's panel; Extend is subject to the extension cap). Revoked entitlements and paying customers are not listed. The existing 30-day list is kept, with source and "Extensions left" columns.

**No export.** Standard §11 requires an approved operational purpose, explicit export roles, audited generation and download, and spreadsheet-injection handling before exporting personal data (this list carries emails); none has been specified or approved, so the list is **on-screen only** (a static test guards against accidental CSV/PDF generation).

## 5. User reminders

- **Mechanism:** the repository has **no existing notification/banner mechanism** (searched `components/`, the app shell and layouts; only a static admin status line exists). A small dismissible banner (`components/billing/PremiumAccessNotice.tsx`) is rendered by `app/(app)/layout.tsx`, and the same reminder is returned by `GET /api/payments/status` and shown in the Profile plan panel.
- **Pure, tested function** `computeEntitlementReminder(row, today)` (`lib/services/entitlementReminder.ts`): only for source `admin_grant` / `promo_code`; ends within 30 days -> `expiring_30`; within 7 days (including the last day) -> `expiring_7` (the urgent notice replaces the other; one notice at a time); after the end date -> `lapsed` for 30 days, then nothing. **Never for paid Premium, legacy/unknown source, free users, missing rows, or a window that has not started.**
- **A user never sees another user's notice:** the loader reads only the row whose `user_id` equals the authenticated session user (on the user's own session client, so RLS is a second guard), and the function takes that single row.
- **Wording:** names the source honestly ("granted by FHIP" / "from a promo code") and the real ways to continue: subscribe from the Plans section on the Profile page (where a plan exists for the user's region) or contact FHIP support and ask for access to be reviewed. No billing flow is invented. Dismissal is remembered per threshold in the browser (optional convenience).
- **E-mail reminders: superseded.** The first version of this report said they were not built; the PO then brought them into scope and they ARE built, disabled by default: see section 12.
- Limitation: a lapsed notice is shown for 30 days after the end date; a user who never opens the app in that window sees nothing.

## 6. Migration number and collision-scan evidence

New migration **0237**. Scanned immediately before writing it and again before the commit (both after a fresh `git fetch origin --prune`): every local and remote ref (793 refs at the final scan) with `git ls-tree`, plus the working directory of the main checkout and **every worktree under `D:\FHIP\.claude\worktrees`** and the temp worktrees. Claimed elsewhere: 0231 (this branch's first commit), **0232** (market index data, on a ref and in the `india-mf-report` worktree), **0236** (owner-before-upload, on a ref and in the `owner-before-upload` worktree); 0228–0230 earlier; nothing above 0236. 0237 is the next free number above everything found. (Sibling branches `owner-edit` etc. may claim 0233–0235/0238+ later: whoever merges second must renumber, nothing else references the number.) The final re-scan (refs: highest 0236; worktree directories: highest 0236 apart from this branch's own 0237) is recorded in the commit message.

CHECK-constraint trap: the migration drops and recreates two constraints that **0231 itself created** (`user_entitlements_entitlement_source_check`, and `..._admin_grant_shape_check` replaced by `..._managed_source_shape_check`). Predecessors were derived from the ledger: defined only by 0231 on any ref or worktree; the values they admitted (`payment`, `admin_grant`) are all retained. No constraint owned by another module is touched. Four 0231 read functions whose return type changes are dropped and recreated (create-or-replace cannot change a return type); the manage and webhook functions keep their signature and are replaced in place.

## 7. Tests

Run with `npx vitest run <file>` from the worktree.

**New / extended test files (all green):**

- `tests/unit/adminPromoCodesPglite.test.ts` — **49 tests** (real Postgres replay of the full ledger incl. 0237).
- `tests/unit/adminPromoCodesService.test.ts` — **45 tests** (hermetic fakes).
- `tests/unit/adminPremiumGrantPglite.test.ts` (first report's suite) — **40 tests**, re-pointed so its negative controls mutate and restore the CURRENT (0237) definitions of the manage and webhook functions (restoring the 0231 text would silently downgrade the function under test).
- `tests/unit/adminPremiumGrantService.test.ts` — **49 tests**; one assertion adjusted (an `extend` now performs a count lookup before the write); the static-inventory test timeout raised to 300 s because the machine was heavily loaded.
- Also adjusted: `tests/unit/adminAnalyticsPhaseA.test.ts` (capability literals gain `promoCodeManagement`).

**Regression run (18 files, 780 tests, all passed):** the four files above plus `migrationVersions`, `migrationVersionsCrossBranch`, `appReview0915MigrationTextLeakGuard`, `entitlementSync`, `adminAnalyticsPhaseA`, `adminAnalyticsPhaseARouteMatrix`, `forecastReportExportEntitlement`, `reportCanonicalSections`, `billingCountryConfirmRoute`, `accountDeletionAdminRoutes`, `countryGateAdminAndHousehold`, `aiEntitlementServiceAndCapabilities`, `aiEntitlementEnforcement`, `pc7LookthroughFoundation`.

**Toolchain caveat (honest):** while this work was being finished, the shared `D:\FHIP\node_modules` was being deleted and reinstalled by someone else's `npm ci`. The runs above used the `node_modules` of the temporary `baseline-main` worktree via a temporary junction (removed afterwards). Its package set is close to, but is not guaranteed identical to, origin/main's lockfile. `tsc` found **0 errors in any file of this change** (its other findings were inside a renamed node_modules link, not repo code); `eslint` (a newer react-hooks plugin than the repo may use, so stricter) reports **0 problems** on every touched/new file after restructuring the three components to avoid synchronous state updates in effects. **Re-run the suite, `tsc` and `eslint` once on a healthy `node_modules` before merging.**

**Negative controls (the NAMED assertion must go red; the SQL mutation is verified to change the text and the real function is restored):**

| Rule | Control (assertion that goes red) |
|---|---|
| Extension cap, database | cap removed -> `expected rejection with ENTITLEMENT_EXTENSION_LIMIT_REACHED` |
| Extension cap, route | pre-check removed -> `a refused extension never reaches the write path` |
| Counter resets on a new grant | grant stops resetting -> `a new grant starts with a fresh extension allowance` |
| Revoke + re-grant restarts the allowance; only successful extensions count; lapsed extend counts; promo extend converts to admin grant; payment keeps the counter | positive tests (the cap and reset controls above cover the mutation targets) |
| Promo capability separate from the entitlement capability (both directions) | capability check removed -> `expected rejection with PROMO_ADMIN_REQUIRED`; a bare `requireAdmin()` admits an entitlement-only admin -> `entitlement-only admin -> 403` |
| Promo duration <= 365 (database) | check removed -> `expected rejection with PROMO_DURATION_INVALID` (the table CHECK is then the only backstop) |
| Promo duration <= 365 (route parser) | cap weakened to 400 -> `366 days must be refused` |
| Unlimited / no-expiry only when explicit, finite default, alphabet, normalisation, duplicates, SQL-vs-TS normaliser parity | positive tests |
| Audit has id + hint only, never the code | create copies the code into the audit details -> `the code value must not appear anywhere in the audit row` |
| One redemption per user per code | check removed -> `second redemption by the same user must be refused` |
| max_redemptions never exceeded | function check removed -> `the third redemption of a max-2 code must be refused`; the CHECK backstop then fires by name (`promo_codes_redemptions_within_max`) and `redemption_count` never exceeds the max |
| No existence oracle (all unusable reasons identical) | distinct "expired" verdict added -> `all unusable verdicts must be identical`; route messages: leaky mapping -> `unusable reasons must read identically` |
| Paid Premium refused, never clobbered | paid check removed -> `paid user must be refused` |
| Never shortens an existing entitlement | no-benefit rule removed -> `a code must never shorten an existing entitlement` |
| Rate limit per user (attempts committed even when failing) and per IP-equivalent | limit removed -> `the 11th attempt must be rate limited even with a valid code`; the per-IP limit is positive-tested |
| Payment wins over a promo, reserve restored with source `promo_code` | restore as `admin_grant` -> `abandoned checkout must not drop the promo` |
| Redeem acts on the session user; code never logged | naive user-id source / a logging route -> `redeem must act on the session user`, `the code value must never appear in logs` (simulated broken implementations) |
| Reminders: never for paid Premium | source gate removed -> `paid Premium never gets a notice` |
| Reminders: never another user's notice | unfiltered loader -> `another user's notice must never be shown` |
| Reminder thresholds, wording, lapsed window, fail-soft | positive tests |
| Promo plan wording | pre-promo labelling -> `promo Premium must not read as plain Premium` |
| Summary buckets and source filter | source predicate removed -> `the promo-only list must not include admin grants` |
| Summary capability gate (promo-admin / plain / anon refused) | positive test |
| No export of the expiry list | static guard (no CSV/PDF generation in the new surface) |


## 8. Standard compliance (AGENTS.md requirements)

- **Capabilities affected:** new `can_manage_promo_codes` (nav field `promoCodeManagement`); `can_manage_premium_entitlements` gains extension-cap enforcement and the expiry summary (no new capability).
- **Clauses and proof:** §2/§3 (separate capability, no implication in either direction): route tests ("entitlement-only admin -> 403", "promo-only admin refused on entitlement routes"), `/api/admin/me` independence test, nav test, PGlite "each capability opens ONLY its own functions". §4 four layers: DB (PGlite database-bypass calls as authenticated / anon / service_role; RLS on every promo table), API (route tests), page (`requirePromoCodeAdminPage`), nav. §13 fail closed: guards deny on read error; reminder loader fails soft to "no notice" (advisory UX, never a grant). §11 exports: none built (static guard). §9: approved by the PO (section 1). §14 scope: only the promo/reminder/extension-cap surface plus the webhook `reserve_source` fix needed so a promo reserve is restored correctly. §15 docs: this report; rollback in the migration header; future-review owner: PO.
- **Exceptions requested (§16):** none.

## 9. PO apply steps (original, for 0237 alone — SUPERSEDED by the ordered list in section 13, which includes 0238)

Prerequisite: 0231 applied first (it is the base of this migration).

1. Apply `supabase/migrations/0237_admin_promo_codes_extension_cap_expiry_summary.sql` (idempotent; additive apart from the guarded constraint swap and the four return-type function recreations described in section 6).
2. Verify (read-only):
   ```sql
   select column_name from information_schema.columns where table_schema='public' and table_name='user_entitlements'
     and column_name in ('admin_grant_extension_count','reserve_source','promo_code_id');                                     -- 3 rows
   select column_name from information_schema.columns where table_schema='public' and table_name='admin_users' and column_name='can_manage_promo_codes';   -- 1 row
   select proname from pg_proc where pronamespace='public'::regnamespace and proname in
     ('premium_grant_max_extensions','admin_create_promo_code','admin_disable_promo_code','admin_list_promo_codes','admin_promo_code_events',
      'redeem_promo_code_for_user','admin_entitlement_expiry_summary','is_promo_code_admin');                                  -- 8 rows
   select has_function_privilege('authenticated','public.redeem_promo_code_for_user(uuid,text,text)','execute');               -- false
   select has_function_privilege('service_role','public.redeem_promo_code_for_user(uuid,text,text)','execute');                -- true
   ```
3. **Grant the promo capability** to the people the PO names (nobody has it by default; entitlement capability from the first report is separate):
   ```sql
   update admin_users set can_manage_promo_codes = true
    where user_id = (select id from auth.users where email = '<admin email>');
   ```
4. Optional but recommended: set an environment variable `PROMO_IP_HASH_SECRET` (any long random string, server-side only) so the per-IP rate limit is active; without it (and without `CRON_SECRET`) only the per-user limit applies.
5. Run `node scripts/admin_premium_grant_dev_proof.mjs` against DEV (part 1 = grant lifecycle, part 2 = extension cap + promo incl. 8-way parallel redemption). Never against production (it refuses).
6. Smoke by hand on DEV: create a code, redeem it as a test user on the Profile page, confirm "Premium (promo code, ends ...)", then set the user's `effective_to` to a date 5 days ahead and confirm the banner.
7. **Production later:** apply 0231, then 0237, then deploy (code is safe in either order for end users: the redeem route reports "unavailable" and grants nothing if the function is absent; the status route and the banner tolerate missing columns).
8. **Rollback:** code revert + the SQL in the migration header (drops the promo audit trail; export `promo_code_events` first).

## 10. Known limitations / decisions still needed

1. **Per-IP limit needs a secret** (`PROMO_IP_HASH_SECRET` or `CRON_SECRET` already set in production); confirm which to use.
2. (Answered by the PO: e-mail reminders are in scope; built disabled by default, see section 12.)
3. A user who has an active admin grant and enters a code that would not extend it gets the generic "cannot be used" (deliberate: a distinct message would be an enumeration oracle); the form's static helper text explains the rule.
4. Redemption by a user holding a not-yet-lapsed **manually SQL-set** Premium is refused as "paid" (indistinguishable from paid).
5. Reminder timing is UTC dates; a lapsed notice lasts 30 days.
6. Disabled promo codes and their audit rows are permanent by design.
7. Not exercised: true concurrent redemption (see section 0).


## 11. PO decisions (second round) — recorded

1. Per-IP secret: OK. Documented below (section 13) and `amplify.yml` now forwards `PROMO_IP_HASH_SECRET` and the `PREMIUM_REMINDER_` prefix.
2. **E-mail reminders are in scope** — built (section 12), disabled by default.
3. Allowance-reset semantics confirmed as described in section 2. **Promo access length now defaults to 1 month (30 days)** (section 12.1).
4. Confirmed: a user holding an active grant who enters a code that adds nothing gets the generic "This code cannot be used."
5. The PO applies migrations themselves: ordered list in section 13.

## 12. New work (migration 0238, a separate commit)

**Migration 0238 is NEW; 0237 (not yet applied anywhere) and 0231 (applied on DEV and production) are untouched.**

### 12.1 Promo access length defaults to 30 days

I read the PO's words as **access length** (what a redeemer receives) and ALSO kept the other reading as its own field, so both exist and are separate in the admin form:

| Admin field | Meaning | Default | Limit |
|---|---|---|---|
| **Access length** (`duration_days`) | how many days of Premium a redemption grants | **30** (was 365) | 1..365 |
| **Code can be redeemed until** (`expires_on`) | the code's own redemption window | +90 days in the form; "no expiry" only by explicit choice | any future date |

`admin_create_promo_code()` is replaced in place (same signature) and the column default moved to 30. The create confirmation now shows the end date: "Each redemption gives N day(s) of Premium; a user redeeming it today would have access until <date>" (the function returns `ends_if_redeemed_today`). Existing codes keep their stored duration. A 30-day promo redeemed today gets no "30 days left" e-mail (a window must be longer than the threshold to be reminded at it).

### 12.2 Expiry e-mail reminders (disabled by default)

- **Who / when:** admin-granted or promo Premium only (never paid), to the entitlement's own user only, **30 days before the end date** (default). The thresholds are ONE named list, `PREMIUM_EXPIRY_EMAIL_THRESHOLD_DAYS = [30]` in `lib/services/premiumExpiryReminderEmail.ts`; adding 7 (`[30, 7]`) enables the optional second e-mail with no other change. When several thresholds apply only the most urgent is sent, so enabling late never sends two at once. Plus the existing in-app banners (unchanged).
- **Mailer:** the repo's existing production path, Resend over HTTPS with `RESEND_API_KEY`, as the Contact form does (`app/api/contact/route.ts`). Sender: `PREMIUM_REMINDER_FROM_EMAIL`, else `CONTACT_FROM_EMAIL`, else the Contact route's default domain address. No new provider or dependency. The mailer is **injected** (`Mailer` interface); no test can send mail and **no real e-mail was sent**.
- **Copy:** plain text, observation style, transactional: "Your complimentary Premium access on FHIP ends on <date> (in N days)...", the real continuation paths (Plans section of the Profile page; contact FHIP support to ask for a review), a line that it is a service message not marketing. The date uses the repo's canonical formatter `formatDateShort` keyed by the user's country (AU `dd/mm/yyyy`, India `dd-mm-yyyy`; anything else falls back to the AU form). No promo code, no name, no user id, no amount, no tracking.
- **Send-once ledger** `premium_expiry_email_ledger` (user, source, end date, threshold, status, attempts, provider message id or short error; **no address, body or code**) with a UNIQUE key `(user_id, entitlement_source, ends_on, threshold_days)`. `premium_reminder_claim()` (service_role only) inserts new rows with `ON CONFLICT DO NOTHING` and returns only the rows that call inserted (plus failed rows it re-claims), so a rerun, retry or overlapping cron cannot claim the same reminder twice. An extension changes the end date, which opens a new window (a new reminder is legitimate); the same window never is.
- **Failures:** recorded (`failed`, short non-identifying error such as `resend_http_500`), retried **as the same ledger row** after a delay (attempt n waits n x 60 minutes), at most **3 attempts** (named constants), then `abandoned`. A failed row is voided, not retried, if the entitlement has since become paid or its end date changed. A row stuck `pending` (worker died mid-send, outcome unknown) becomes `unknown` after 30 minutes and is **never re-sent** (at-most-once beats a possible duplicate for an unknown outcome — a stated trade-off). `premium_reminder_record()` can only settle a pending row, so a late or duplicate result cannot flip a sent row. Resend's `Idempotency-Key` header (per ledger id) is sent as extra best-effort protection; the ledger is the real guarantee.
- **Schedule:** `pg_cron` + `net.http_post` hourly (`17 * * * *`) to `https://app.financialhealthplatform.com/api/premium/cron/expiry-reminders`, authenticated with `x-cron-secret` = the Vault secret `premium_reminder_cron_secret` (same convention as the purge/malware sweeps, migrations 0135/0149/0174/0228). **Registered only on a database that carries the operator marker row `platform_deployment_environment.environment = 'production'`** (table created `if not exists`, same definition as the sibling migrations); DEV/fresh/PGlite registers nothing, so a DEV database can never schedule a call to the production origin (tested both ways). The route (`POST /api/premium/cron/expiry-reminders`) checks the shared `CRON_SECRET`.
- **Kill switch / disabled by default:** `premium_reminder_job_control` row `expiry_email` ships `enabled = false`. The runner reads it on every run and treats a missing row, a read error, or anything but literal `true` as disabled: nothing is claimed and nothing is sent. It also claims nothing if the mailer is not configured (no ledger row is burned for an unsendable mail). The switch is a database row (no deploy to flip it).

### 12.3 Tests for 0238 (all green)

- `tests/unit/premiumExpiryReminderPglite.test.ts` — **24 tests** (real Postgres replay).
- `tests/unit/premiumExpiryReminderRunner.test.ts` — **17 tests** (fake DB, injected mailer, injected fetch).
- `tests/unit/adminPromoCodesPglite.test.ts` / `adminPromoCodesService.test.ts` updated for the 30-day default and for mutating the CURRENT `admin_create_promo_code` text (from 0238).
- Combined run of the five promo/reminder/grant suites on a healthy `node_modules`: **207 tests passed**.

| Rule (PO list) | Negative control — assertion that goes red |
|---|---|
| Not sent for paid Premium | source filter removed -> `paid Premium is never claimed` (the ledger's own CHECK on the source is the independent backstop that refuses the row); runner: a claim row that is not admin/promo or has no address is never mailed; no-check runner -> `a paid entitlement is never e-mailed` |
| Not sent twice (rerun / overlap) | duplicate checks removed -> `an immediate rerun / overlapping run must claim nothing` (the UNIQUE key then fires by name `uq_premium_expiry_email_window`) |
| Not sent for another user | claim joined to the wrong address -> `the address must belong to the entitlement's own user`; free users excluded (positive) |
| Threshold boundaries (31 no; 30, 15, 1, 0 yes; ended no; short window; most-urgent-only) | boundary made strict -> `exactly 30 days left must be claimed` |
| Disabled flag sends nothing | switch ignored -> `a disabled job must not send` (simulated broken runner); fail-closed on missing / error / `'true'` / `1` / throw (positive) |
| Mailer failure recorded and retried but not duplicated | `record()` allowed to settle any row -> `a settled row cannot be settled again`; bounded budget (3 -> abandoned), void-on-payment, unknown-after-30-min (positive) |
| DEV environment guard | schedule block without the marker check -> `DEV (no production marker row) must register no cron job`; with the marker: one hourly job at the production URL using the vault secret, idempotent |
| Mailer cannot send in tests | not configured -> never calls fetch; success / HTTP failure / network error map to short non-identifying results (positive) |
| Cron route auth | missing / wrong / empty secret -> 401 and nothing happens; enabled -> counts only, no address in the response (positive) |

Not exercised: true simultaneous cron runs (PGlite is single-connection; the UNIQUE key is the database guarantee), and a real Resend send (deliberately never done).

## 13. ORDERED PO APPLY LIST — DEV (then production)

Preconditions: 0231 is already applied on DEV and production. Apply on **DEV first**, in this order, each in the Supabase SQL editor. All three are idempotent.

**Step 1 — 0237** `supabase/migrations/0237_admin_promo_codes_extension_cap_expiry_summary.sql`
- Verify:
  ```sql
  select column_name from information_schema.columns where table_schema='public' and table_name='user_entitlements'
    and column_name in ('admin_grant_extension_count','reserve_source','promo_code_id');            -- 3 rows
  select column_name from information_schema.columns where table_schema='public' and table_name='admin_users' and column_name='can_manage_promo_codes';  -- 1 row
  select count(*) from pg_proc where pronamespace='public'::regnamespace and proname in
    ('premium_grant_max_extensions','admin_create_promo_code','admin_disable_promo_code','admin_list_promo_codes',
     'admin_promo_code_events','redeem_promo_code_for_user','admin_entitlement_expiry_summary','is_promo_code_admin');   -- 8
  select has_function_privilege('authenticated','public.redeem_promo_code_for_user(uuid,text,text)','execute');  -- false
  ```
- Rollback: the SQL in the 0237 header (drops the promo audit trail; export `promo_code_events` first) — and then also roll back step 2 first.

**Step 2 — 0238** `supabase/migrations/0238_premium_expiry_email_reminders.sql`
- Verify:
  ```sql
  select enabled from premium_reminder_job_control where job_key='expiry_email';                         -- false
  select count(*) from pg_proc where pronamespace='public'::regnamespace and proname in ('premium_reminder_claim','premium_reminder_record');  -- 2
  select column_default from information_schema.columns where table_name='promo_codes' and column_name='duration_days';   -- 30
  select has_function_privilege('authenticated','public.premium_reminder_claim(date,int[],int,int,int,uuid)','execute');   -- false
  select jobname from cron.job where jobname='premium-expiry-email-reminders';                           -- 0 rows on DEV (production-only)
  ```
- Rollback: the SQL in the 0238 header (unschedule the job, drop the two functions and the two tables, restore the 365 column default; re-run 0237's `admin_create_promo_code` to restore its default). Export `premium_expiry_email_ledger` first.

**Step 3 — capabilities** (nobody has them by default; the PO names the people):
```sql
update admin_users set can_manage_premium_entitlements = true where user_id = (select id from auth.users where email = '<admin email>');
update admin_users set can_manage_promo_codes          = true where user_id = (select id from auth.users where email = '<admin email>');
```

**Step 4 — DEV proof:** `node scripts/admin_premium_grant_dev_proof.mjs` — ONE script, parts 1–3 (grant lifecycle; extension cap + promo incl. 8-way parallel redemption; 30-day default + the reminder ledger via synthetic users). Refuses any project but DEV, never touches the kill switch, **sends no e-mail**, cleans up (append-only audit rows remain; ledger rows cascade with the synthetic users).

**Step 5 — production (later, after merge approval):** apply 0231 (done), 0237, 0238 in that order. Then:
1. **Environment variables on Amplify** (server-side; `amplify.yml` forwards them): `PROMO_IP_HASH_SECRET` (any long random string; without it AND without `CRON_SECRET` the per-IP rate limit is off, the per-user limit stays on), `RESEND_API_KEY` and `CONTACT_FROM_EMAIL` (already forwarded and used by the Contact page), `APP_BASE_URL` (already forwarded; used for the two links in the e-mail), optional `PREMIUM_REMINDER_FROM_EMAIL`. `CRON_SECRET` already exists.
2. **Production marker row** (once per project): `insert into platform_deployment_environment (environment) values ('production') on conflict (environment) do nothing;` then re-run the last `do $$ ... $$` block of 0238 (idempotent) to register the hourly job.
3. **Vault secret** (never committed): `select vault.create_secret('<the CRON_SECRET value>', 'premium_reminder_cron_secret');`
4. **Enable the e-mails only when ready** (default stays OFF): `update premium_reminder_job_control set enabled = true, disabled_reason = null, updated_at = now() where job_key = 'expiry_email';` — to stop: set `enabled = false`.
5. Verify the job: `select jobname, schedule, command from cron.job where jobname = 'premium-expiry-email-reminders';` (command must contain the production URL) and, after the first hourly run, `select jobname, status, return_message, start_time from cron.job_run_details jrd join cron.job j on j.jobid = jrd.jobid where j.jobname = 'premium-expiry-email-reminders' order by start_time desc limit 5;`

## 14. Migration numbers (0238) and collision-scan evidence

New migration **0238**, above everything found. Scanned immediately before the commit, after a fresh `git fetch origin --prune`: every local and remote ref (796 refs) with `git ls-tree`, plus the working directory of the main checkout, every worktree under `D:\FHIP\.claude\worktrees` and the temp worktrees. Claimed elsewhere: **0232** (market index data: on a ref and in the `india-mf-report` and `bench1-phase2` worktrees), **0236** (owner-before-upload, on a ref and in its worktree); this branch's own 0231 and 0237. Nothing above 0237 anywhere. Sibling branches (owner-edit etc.) may still claim 0233-0235 or 0238+ later: whoever merges second renumbers; nothing else references the number (the 0238 header names itself, and the tests locate the file by its name suffix, not its number).

The CHECK-constraint trap does not apply to 0238: it adds new tables and replaces two functions it needs; it drops and recreates **no** CHECK constraint on any existing table.

## 15. What was and was not verified (this round)

- **Code-complete; DB rules verified on isolated PGlite replays; app layer unit-tested** (above). **Not DEV-verified, not production-verified**; the DEV proof script's part 3 was added and has **never been run**.
- **Never sent:** no real e-mail was sent anywhere; the Resend path was exercised only with an injected `fetch`.
- Screens (promo form default and confirmation text) not rendered in a browser.
- **Healthy-tree re-run (supersedes the section 7 toolchain caveat):** on the repaired shared `node_modules`, `tsc --noEmit` reports **0 errors** across the whole repo, `eslint` reports **0 problems** on every touched/new file, and 20 test files (832 tests: the five promo/reminder/grant suites, the migration-version guards and the existing entitlement/admin/country/AI suites) passed, apart from two cold-import timeouts under heavy machine load that passed in isolation (94/94).

## 16. Decisions still needed from the PO

1. **Names for the two capabilities** (step 3) — and who receives `PROMO_IP_HASH_SECRET`/Amplify changes.
2. **When to enable the e-mails** (step 5.4) after a DEV rehearsal; whether to add the optional 7-day e-mail (`[30, 7]`).
3. **Sender address:** set `PREMIUM_REMINDER_FROM_EMAIL`, or accept the Contact sender (a "FHIP Contact Form" display name unless `CONTACT_FROM_EMAIL` is changed).
4. **Unknown-outcome policy:** a reminder whose send outcome is unknown (worker died mid-send) is never re-sent — accept, or prefer a possible duplicate over a possible miss.
5. A user with an unusual end date (window shorter than 30 days, e.g. the 30-day default promo) gets no 30-day e-mail by design; the 7-day option or the in-app banners cover them — confirm.


## 17. E-mailing a promo code from the admin console (migration 0242, branch `feat/promo-code-email-20261003`)

Built on a new branch from origin/main (4742d5c). Not pushed. **Migration 0242 is NEW; 0231, 0237 and 0238 (applied) are untouched.**

### 17.1 A correction to the premise (read this first)

The request describes the design as storing "only a hash/masked hint" and showing the code once. That is **not what 0237 built**: `promo_codes.code` stores the **plain normalised code**, `admin_list_promo_codes()` returns it, and the Promo Codes page's list renders it (so promo-code admins can always see and copy any code). Only the **audit trail** (`promo_code_events`) is hint-only. I did not change that. What the new feature guarantees is narrower and checkable: **the new e-mail subsystem never stores, logs, returns, or puts in a URL, audit row or error the plaintext code** — the send ledger holds a keyed hash of each recipient and a status; the create response omits the code when it was e-mailed. If the PO wants the plain code hidden from the list too, that is a separate design change (hash-only storage) with a real cost (an admin could no longer re-copy a code) — **decision needed (section 17.8)**.

### 17.2 What was built

- **Create form:** optional **"Email this code to"** (up to 20 addresses, commas or new lines) and the checkbox **"Only this email address can redeem"** (default OFF; ticking it with several addresses creates **one single-use code per address**). The server creates the code and sends the e-mail **from the same request**; the plaintext is returned to the admin **only if an e-mail was not (fully) sent** — the existing show-once copy flow, so a mailer failure never loses a code. A successfully e-mailed code is **not** returned.
- **Existing codes:** **"Generate a replacement code and email it"** (per active code): a NEW generated code with the old code's access length, redemption limit, redeem-by date and note, e-mailed once; the old code is neither retrieved nor changed (the admin may disable it separately). A bound replacement is single-use.
- **E-mail:** plain transactional text through the existing Resend path and the **injected** `Mailer` (same one the expiry reminders use; `RESEND_API_KEY`, sender `PREMIUM_REMINDER_FROM_EMAIL` -> `CONTACT_FROM_EMAIL` -> default address). Subject **"Your FHIP Premium access code"** (no code in the subject). Body: the code (`XXXXX-XXXXX`), what it grants ("complimentary Premium for N days from the day you redeem it"), the code's own redeem-by date via the canonical `formatDateShort` (AU `dd/mm/yyyy`; `dd-mm-yyyy` if the recipient's country is known to be India — admin-triggered mails do not look the recipient up, so they are AU), how to redeem (Profile > Plans > Promo code, real link from `APP_BASE_URL`), single-use / limited-use / unlimited, the binding sentence when bound, a "not marketing" line, attribution to FHIP. No PII beyond the recipient's own address.
- **Route:** `POST /api/admin/promo-codes` accepts `emailTo`, `bindToRecipient`, `idempotencyKey` (without `emailTo` it behaves exactly as before); `POST /api/admin/promo-codes/[id]/replace-and-email`. Capability: **`can_manage_promo_codes` only — no new capability**; non-capability admins (including entitlement-only admins) get 403.

### 17.3 Safety design

| Requirement | How |
|---|---|
| Plaintext never stored/logged/returned after creation | the ledger/request tables have no address, body or code columns; no `console.*` in the path; audit = recipient **count** + a bound flag + masked hint; the response omits an e-mailed code; errors carry codes/messages only (asserted by dumping tables, scanning RPC arguments, and spying on console) |
| Idempotent per request | `admin_promo_email_begin(request_key, count, bound)`: a unique `(admin, request key)` row; a duplicate returns "not new" and the server creates **nothing** and sends **nothing** (409 with a clear message). The UI mints a fresh key per submit attempt and keeps it across retries/double-clicks |
| Bounded retries, recorded, no re-creation | up to 3 attempts per recipient (400 ms, 1200 ms back-off, injectable), the outcome (`sent`, or `abandoned` after 3) and attempt count recorded in `promo_email_sends` by keyed recipient hash; the code is created once, before the sends |
| Per-admin rate limit | in the database: 10 requests and 100 recipients per rolling hour per admin (`PROMO_EMAIL_RATE_LIMITED`, HTTP 429) |
| Kill switch, fail closed | `PREMIUM_PROMO_EMAIL_ENABLED`: only the exact text `true` enables sending; unset / `false` / `TRUE` / `1` / blank = OFF. OFF => the code is still created and shown once with **"Email sending is switched off. Copy the code and send it yourself."** Also "not configured" (no secret / no `RESEND_API_KEY`) and "not available on this database yet" messages |
| Address binding | `promo_codes.bound_email_hash` = HMAC-SHA256 (server secret, domain-separated, normalised address) — **never the plain address**; CHECKs make a bound code single-use with a well-formed hash; redemption passes the session user's keyed hash and any other account (or no hash) gets the **same generic "This code cannot be used."** as a missing code (identical verdict, tested equal) and consumes nothing. Key: `PREMIUM_PROMO_EMAIL_BIND_SECRET`, else `PROMO_IP_HASH_SECRET`, else `CRON_SECRET`; **rotating it makes already-bound codes unusable (fail closed)** |
| Fail soft without the migration | create falls back to the legacy argument shape, nothing is sent, the admin sees the message and the code once; a binding request is refused (503) and creates **nothing** (never a silently unbound code); redemption falls back to the legacy 3-argument call |
| Date rule | e-mail dates go through `formatDateShort`; the day-first source-contract test now also scans `lib/services/promoCodeEmail.ts` and the admin component, and stays green |

### 17.4 Migration 0242

Adds `promo_codes.bound_email_hash` (+ two new CHECKs on that new column only), replaces `admin_create_promo_code` (new optional `p_bound_email_hash`, `p_recipient_count`), `redeem_promo_code_for_user` (new optional `p_email_hash`) and `admin_list_promo_codes` (extra `bound` flag) by **drop-and-recreate of objects 0237/0238 created** (the old call shapes still work because the new parameters default), and creates `promo_email_requests`, `promo_email_sends`, `admin_promo_email_begin`, `admin_promo_email_record`. **No CHECK constraint on any existing table is dropped or recreated** (the audit event-type list is untouched, so the known drop-and-recreate trap does not apply). Rollback is in the migration header (export the ledger first).

### 17.5 Migration number and collision scan

**0242**, above everything found. Scanned before writing and again before the commit: every local and remote ref (803 refs at the first scan) with `git ls-tree`, plus the working directory of the main checkout and every worktree under `D:\FHIP\.claude\worktrees` and the temp worktrees. Highest found anywhere: **0241** (BENCH-1 governance); 0240 (net-worth remark) and 0238 (this programme) also present; no 0239 exists on any ref or worktree. Final re-scan before the commit (807 refs after a fresh fetch, plus every worktree directory): **nothing at 0242 or above on any ref**; the only 0242 anywhere is this branch's file. One unrelated in-flight sibling worktree (`agent-aea66a359c09b98c7`, user-supplied investment dates) holds **0250**; 0243-0249 are unclaimed. 0242 is free and collides with nothing; whoever merges second renumbers (the tests locate the file by name suffix, not number).

### 17.6 Tests (run one file at a time; grouped runs hit the vitest temp-dir flake)

- `tests/unit/promoCodeEmailPglite.test.ts` — **18 tests**, real Postgres replay of the whole ledger.
- `tests/unit/promoCodeEmailService.test.ts` — **34 tests**, injected mailer / sleeper / fake database.
- `tests/unit/adminPromoCodesPglite.test.ts` (49) re-pointed so its mutation controls restore the CURRENT `admin_create_promo_code` / `redeem_promo_code_for_user` text (0242) — restoring the 0237/0238 text would silently revert the function under test.
- Date contract (`dateFormatsDayFirstSourceContract` 13, `dateFormatsDayFirstBehaviour` 14) green with the new file added.
- Also green, each run alone: `adminPromoCodesService` 45, `premiumFeaturesFailSoft` 14, `premiumExpiryReminderPglite` 24, `premiumExpiryReminderRunner` 17, `adminPremiumGrantPglite` 40, `adminPremiumGrantService` 49, `entitlementSync` 4, `adminAnalyticsPhaseA` 267, `appCapabilityManifest` 3, `appCapability` 34, `appNavCapability` 17, `migrationVersions` 5, `migrationVersionsCrossBranch` 7.
- `tsc --noEmit`: the only error is `tests/unit/canonicalCertResidueAllSql.test.ts` (main's, untouched). `eslint`: 0 problems on every touched file.

| Rule | Negative control — the NAMED assertion that goes red |
|---|---|
| Bound code only redeemable by the bound address; others get the generic verdict identical to a missing code | binding clause removed -> `a bound code must not be redeemable by any other account` |
| Idempotent request key | duplicate handling removed -> `a repeated request key must be reported as NOT new` (the UNIQUE key then fires by name, `uq_promo_email_request`); service: database wrongly says "new" -> `a repeated request key must create no second code` |
| Per-admin rate limit | limit removed -> `expected rejection with PROMO_EMAIL_RATE_LIMITED` |
| A sent ledger row is never downgraded | guard removed -> `a sent row must never be downgraded` |
| Kill switch fails closed (unset/false/TRUE/1/blank) | simulated broken variant that ignores the flag -> `a switched-off job must not send` |
| Code never in logs | a variant that logs the code on failure -> `the code value must never appear in logs` (same scanner used across success / failure / refusal runs) |
| Binding secret/keyed hash, domain separation, no plain address in arguments | positive (asserts on the exact arguments) |
| Code not in audit rows; ledger has no address/body/code columns; RLS | positive (dumps and column checks); capability refusals for plain user, entitlement-only admin, anon, service_role |
| Bounded retries (3), code created once, code returned only when not delivered | positive (asserts attempt count, sleeps 400/1200 ms, one create call) |
| Old call shapes and migration-absent fallbacks | positive |

### 17.7 What was and was not verified

- **Code-complete; database rules verified on an isolated PGlite replay; application layer unit-tested.** **Not DEV-verified, not production-verified. No real e-mail was sent anywhere** (the mailer is injected; the Resend path was already exercised only with an injected fetch). The new admin form was not rendered in a browser. True concurrent double-submission was not raced (PGlite is single-connection): the guarantee is the database's UNIQUE `(admin, request key)` row, which the suite exercises by name.
- Not done on purpose: no change to who can see plain codes in the list (17.1).

### 17.8 PO apply list, environment, DEV rehearsal, decisions

**Ordered apply list (0237 and 0238 are already applied):**
1. Apply `supabase/migrations/0242_promo_code_email_send.sql` on **DEV** (SQL editor; idempotent).
2. Verify (read-only):
   ```sql
   select column_name from information_schema.columns where table_name='promo_codes' and column_name='bound_email_hash';        -- 1 row
   select count(*) from pg_proc where pronamespace='public'::regnamespace and proname in ('admin_promo_email_begin','admin_promo_email_record');  -- 2
   select has_function_privilege('authenticated','public.redeem_promo_code_for_user(uuid,text,text,text)','execute');           -- false
   select has_function_privilege('service_role','public.redeem_promo_code_for_user(uuid,text,text,text)','execute');            -- true
   select count(*) from pg_proc where pronamespace='public'::regnamespace and proname='redeem_promo_code_for_user';             -- 1 (no stray old overload)
   select count(*) from pg_proc where pronamespace='public'::regnamespace and proname='admin_create_promo_code';                -- 1
   ```
3. Deploy the application (the code is safe in either order: without 0242 it creates unbound codes with the old call shape, sends nothing, and refuses bound requests).
4. **Production later:** the same, after the DEV rehearsal. **Rollback:** the SQL in the 0242 header (drops the send ledger; export `promo_email_sends` first), then redeploy.

**Amplify environment (server-side; `amplify.yml` now forwards the `PREMIUM_PROMO_EMAIL_` prefix, so these reach the runtime):**
- `PREMIUM_PROMO_EMAIL_ENABLED=true` — the switch; **leave unset (OFF) until the rehearsal passes.** Only the exact text `true` turns it on.
- `PREMIUM_PROMO_EMAIL_BIND_SECRET` — any long random string; needed for "Only this email address can redeem". Without it the binding is unavailable (create refuses, 503). Rotating it later invalidates existing bound codes.
- Already present and reused: `RESEND_API_KEY`, `CONTACT_FROM_EMAIL` (or `PREMIUM_REMINDER_FROM_EMAIL`), `APP_BASE_URL`, `CRON_SECRET`, `PROMO_IP_HASH_SECRET`.
- The `can_manage_promo_codes` capability is unchanged; no new capability.

**DEV rehearsal checklist** (DEV project, a test mailbox you control — do NOT use real users):
1. With the switch OFF: create a code with "Email this code to" filled in -> the page shows "Email sending is switched off. Copy the code and send it yourself." plus the code once; nothing is e-mailed.
2. Set `PREMIUM_PROMO_EMAIL_ENABLED=true` (+ the bind secret) on the DEV deployment. Create a code e-mailed to your test mailbox: the page says it was sent and does **not** show the code; the e-mail arrives with subject "Your FHIP Premium access code" and the code, the end date, the redeem-by date in dd/mm/yyyy, and the Profile link; redeem it on a test account.
3. Double-click "Create code and email it" (or resubmit) -> only one code and one e-mail.
4. Tick "Only this email address can redeem" with two addresses -> two codes, two e-mails; from an account with a different address enter one of the codes -> "This code cannot be used."; from the right account -> it works once.
5. "Generate a replacement code and email it" on an existing code -> a new code arrives; the old one is unchanged.
6. Break the mailer on purpose (blank `RESEND_API_KEY`) -> "not configured" message and the code is shown once. Send 11 requests in an hour -> the 11th is refused with the rate-limit message.
7. Query `promo_email_sends` / `promo_email_requests` / `promo_code_events`: no address, no code anywhere.

**Decisions still needed from the PO**
1. **Plain codes are visible in the admin list** (17.1) — keep (admins can re-copy codes) or move to hash-only storage?
2. **Binding forces single-use** (one recipient, one redemption) — confirm.
3. **A mailer failure after 3 attempts is final for that request** (the code is shown to the admin; resending means "Generate a replacement code and email it") — confirm there is no background retry.
4. Admin-triggered e-mails use AU date format because the recipient's country is not looked up — confirm, or ask for a lookup by e-mail.
5. When to set `PREMIUM_PROMO_EMAIL_ENABLED=true` on production.
