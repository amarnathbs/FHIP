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
- **What counts as "an extension":** one **successful** admin **Extend** on that grant, including re-activating a lapsed grant. Rejected attempts (not later, over 365 days, missing reason, at the limit, paid-protected) do not count. **[Extended by section 18, item 3: a revoke and re-grant no longer resets the lifetime ceiling.]**
- **When the counter resets:** when a **new grant starts** — an admin Grant after a Revoke (or after the previous grant lapsed), or a promo redemption. **Revoke** also clears it. **Revoke + re-Grant by an admin is allowed and is the sanctioned way past the cap; both actions are audited** (each audit row now carries `extension_count_after`).
- A paying subscription **keeps** the counter (the grant is held in reserve and restored with its count if the subscription lapses first).
- An admin extending a **promo-sourced** entitlement converts it to `admin_grant` (an admin now decides its length) and counts as extension 1.
- Rows created before 0237 start at 0 (column default); an in-flight 0231 grant therefore gets a fresh allowance of 5 on the day 0237 is applied.
- UI: the Extend button is disabled with an explanation when `extensions_remaining` is 0; lists show "Extensions left".

## 3. Promo codes — design

**Data (all RLS-enabled; users can read none of it):** `promo_codes` (code stored normalised, masked `code_hint`, `duration_days` 1..365 default **30** (changed by migration 0238; 0237 originally defaulted to 365), `max_redemptions` nullable, `redemption_count`, `expires_on`, note, status), `promo_code_redemptions` (unique per user per code), append-only `promo_code_events` (create / disable / redeem), `promo_redemption_attempts` (rate-limit ledger). `promo_codes` rows can never be deleted (trigger); events are append-only (trigger, also TRUNCATE). **[SUPERSEDED by section 18, item 1: since migration 0264 to 0268 no new code is stored in plain text, and after the backfill none is.]**

**Capability:** `admin_users.can_manage_promo_codes` + `is_promo_code_admin()`, **separate from `can_manage_premium_entitlements`** (Standard §3): holding either never confers the other, not implied by Super Admin; nobody holds it by default. Nav: separate group "Promo Codes" (`promoCodeManagement`) at `/admin/entitlements/promo-codes`. Layers: DB (functions + RLS), API (`requirePromoCodeAdmin`), page (`requirePromoCodeAdminPage`), nav.

**Admin surface** (`/admin/entitlements/promo-codes`, `/api/admin/promo-codes*`): create (code admin-chosen or generated; access length <= 365, **default 30 days (one month)** per the later PO decision (see section 12); **max redemptions finite by default (100), unlimited only by an explicit "Unlimited" choice; expiry date default +90 days, no expiry only by an explicit choice**; optional note), list (state: active / disabled / expired / exhausted), disable (mandatory reason, audited, stops future redemptions only — Premium already granted is not revoked), audit trail view.

**Codes:** 31-character unambiguous alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no 0/O/1/I/L), 6–24 characters; admin-chosen codes obey the same alphabet; generated codes are 10 characters from the database CSPRNG (`gen_random_uuid`, rejection-sampled, no modulo bias). Case-insensitive; whitespace, hyphens and underscores ignored; TypeScript and SQL normalisers are tested to agree.

**User redemption** (`POST /api/payments/promo/redeem`, field on the Profile page's plan/billing panel):
- Only reachable through the authenticated route. The SQL function `redeem_promo_code_for_user(user, code, ip_hash)` is granted to **`service_role` only**; the user id is the session user, never the request body.
- **Atomic:** locks the user's entitlement row then the promo row (`FOR UPDATE`, always that order), so `max_redemptions` cannot be exceeded under concurrency; an independent `CHECK (redemption_count <= max_redemptions)` is a second guard.
- **One redemption per user per code** (unique constraint + explicit verdict "You have already used this code.").
- **Duration:** a redemption on date R ends on R + `duration_days` (inclusive) — the same convention as the 365-day admin cap; never more than 365 days. **[SUPERSEDED by section 18, item 2: both ends are inclusive, so a redemption on R ends on R + `duration_days` - 1.]**
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
4. Optional but recommended: set an environment variable `PROMO_IP_HASH_SECRET` (any long random string, server-side only) so the per-IP rate limit is active; without it (and without `CRON_SECRET`) only the per-user limit applies. **[SUPERSEDED by section 18, items 4 and 6: mandatory, at least 32 characters, different from CRON_SECRET; the address is taken from the right of X-Forwarded-For.]**
5. Run `node scripts/admin_premium_grant_dev_proof.mjs` against DEV (part 1 = grant lifecycle, part 2 = extension cap + promo incl. 8-way parallel redemption). Never against production (it refuses).
6. Smoke by hand on DEV: create a code, redeem it as a test user on the Profile page, confirm "Premium (promo code, ends ...)", then set the user's `effective_to` to a date 5 days ahead and confirm the banner.
7. **Production later:** apply 0231, then 0237, then deploy (code is safe in either order for end users: the redeem route reports "unavailable" and grants nothing if the function is absent; the status route and the banner tolerate missing columns).
8. **Rollback:** code revert + the SQL in the migration header (drops the promo audit trail; export `promo_code_events` first).

## 10. Known limitations / decisions still needed

1. **Per-IP limit needs a secret** (`PROMO_IP_HASH_SECRET` or `CRON_SECRET` already set in production); confirm which to use. **[SUPERSEDED by section 18, item 4: no fallback to CRON_SECRET; PROMO_IP_HASH_SECRET must be its own value.]**
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

The request describes the design as storing "only a hash/masked hint" and showing the code once. That is **not what 0237 built**: `promo_codes.code` stores the **plain normalised code**, `admin_list_promo_codes()` returns it, and the Promo Codes page's list renders it (so promo-code admins can always see and copy any code). Only the **audit trail** (`promo_code_events`) is hint-only. I did not change that. What the new feature guarantees is narrower and checkable: **the new e-mail subsystem never stores, logs, returns, or puts in a URL, audit row or error the plaintext code** — the send ledger holds a keyed hash of each recipient and a status; the create response omits the code when it was e-mailed. If the PO wants the plain code hidden from the list too, that is a separate design change (hash-only storage) with a real cost (an admin could no longer re-copy a code) — **decision needed (section 17.8)**. **[SUPERSEDED by section 18, item 1: the premise is now true, because of migrations 0264 and 0265 plus the backfill.]**

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
| Fail soft without the migration | create falls back to the legacy argument shape, nothing is sent, the admin sees the message and the code once; a binding request is refused (503) and creates **nothing** (never a silently unbound code); redemption falls back to the legacy 3-argument call | **[SUPERSEDED by section 18, item 1: the legacy create shape no longer exists; without the migration create refuses with a 503.]**
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
- Not done on purpose: no change to who can see plain codes in the list (17.1). **[SUPERSEDED by section 18, item 1.]**

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
- `PREMIUM_PROMO_EMAIL_FROM_NAME` — **optional**; the sender DISPLAY NAME of the promo-code and Premium expiry-reminder e-mails. Default `FHIP` (see 17.9). Already forwarded by the `PREMIUM_PROMO_EMAIL_` prefix in `amplify.yml` (verified: `env | grep -e PREMIUM_PROMO_EMAIL_` matches it); leave unset to get `FHIP`.
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
1. **Plain codes are visible in the admin list** (17.1) — keep (admins can re-copy codes) or move to hash-only storage? **[SUPERSEDED by section 18, item 1: the PO ruled hash only; the list shows only a masked hint.]**
2. **Binding forces single-use** (one recipient, one redemption) — confirm.
3. **A mailer failure after 3 attempts is final for that request** (the code is shown to the admin; resending means "Generate a replacement code and email it") — confirm there is no background retry.
4. Admin-triggered e-mails use AU date format because the recipient's country is not looked up — confirm, or ask for a lookup by e-mail.
5. When to set `PREMIUM_PROMO_EMAIL_ENABLED=true` on production.


### 17.9 Sender display name (fix `fix/promo-email-sender-name-20261003`)

After the production test the promo e-mail arrived from "FHIP Contact Form <no-reply@auth.financialhealthplatform.com>" because the Premium mailer passed the Contact form's configured sender through unchanged. Fixed for the Premium e-mails only:

- **New helper** `lib/services/mailFromHeader.ts`: the From header is `Name <address>`. The **address** is exactly what is configured today (the address part of `PREMIUM_REMINDER_FROM_EMAIL`, else `CONTACT_FROM_EMAIL`, else the default `no-reply@auth.financialhealthplatform.com`); any display name inside that configured value (e.g. "FHIP Contact Form") is discarded. The **name** is `PREMIUM_PROMO_EMAIL_FROM_NAME`, default **`FHIP`**. The domain and the address are unchanged; nothing is invented.
- **Header-injection safety:** the name is reduced to letters, digits, spaces and `. & _ -` (so no angle brackets, quotes, backslashes, commas, colons, semicolons, `@`, parentheses, CR, LF, NUL or Unicode line separators), whitespace is collapsed, length is capped at 60, and an empty/blank/all-invalid/non-string value falls back to `FHIP`. A configured address that is not a single plain address (spaces, control characters, two bracketed parts, no `@`) falls back to the default address; it is never merged into the header.
- **Scope:** the promo-code e-mails and the Premium expiry-reminder e-mails both use the same `createResendMailer().from()`, so both are fixed by the one change (the shared path is natural, so they are not split). **The Contact form route is untouched** and still sends exactly "FHIP Contact Form <...>" (source-guarded and tested).
- **Tests** (`tests/unit/mailFromHeader.test.ts`, 12, plus the adjusted `premiumExpiryReminderRunner` expectations): default name is `FHIP` (control: the old pass-through fails "the default name must be FHIP"); the address part is unchanged (control: a rebuilt address fails "the address part must be unchanged"); header-injection attempts (CR/LF, quotes, brackets, NUL, Unicode separators, commas) are neutralised (control: naive concatenation fails "header injection must be neutralised"); the Contact form's From is unchanged by the setting (control: routing it through the new builder fails "contact-form From is unchanged"); the header actually sent to Resend is the built header.
- **PO action:** none required (the default reads "FHIP"). To use a different name set `PREMIUM_PROMO_EMAIL_FROM_NAME` on Amplify (e.g. `FHIP Premium`). No database change, no migration.

## 18. Hardening mission (2026-10-05): independent review, 14 items

Branch `feat/promo-premium-hardening-20261005`, cut from `origin/main` b105cf4. Migrations **0264 to 0268** (NAV2 owns 0260 to 0263; the highest number found on every ref and every worktree was 0263). Nothing is pushed, merged or applied. Nothing is switched on. The PO hand-over (apply order, verify queries, secrets, decisions, reversal) is `docs/admin/po_apply_hardening/README.md`.

Evidence labels used below: **PGlite** = proven on an isolated real-Postgres replay of the whole ledger with named negative controls; **unit** = hermetic application tests with injected mailer, clock and random source; **source contract** = tests that read the source; **DEV** = needs a run against the DEV project (not done, listed in item 14); **UNVERIFIED** = cannot be proven from this repository.

Where an earlier section of this report says something that this section contradicts, the earlier text is marked SUPERSEDED.

### 18.1 Item 1 PLAIN CODES (hash only storage)

**Finding.** `promo_codes.code` stored the plain normalised code, `admin_list_promo_codes()` returned it, the admin list rendered it, and a promo admin could also `select code from promo_codes` through the table grant. The PO ruled hash only.

**Change.** A code is identified by a keyed digest `HMAC-SHA256(PROMO_CODE_DIGEST_SECRET, "promo-code:v<version>:" + normalised code)`. The application (not the database) generates the code with a CSPRNG, computes the digest and a masked hint, and sends the database only those. The database never sees a new plain code. `admin_create_promo_code` now takes the digest, the hint and the key version (the old 9 argument form is dropped). `admin_list_promo_codes()` has no code column. API roles lose column access to `code`, `code_digest`, `code_digest_version` and `bound_email_hash` (column grants). The plain code is returned once in the create response and once in the e-mail, and in the show-once fallback after a failed send; never from a list, history or status route. A replacement is always a new code. **Key rotation:** the digest carries its key version; lookup accepts the current and the previous key; `docs/admin/PROMO_CODE_DIGEST_KEY_ROTATION_RUNBOOK.md` has the procedure, the dual verify window and what to do after a leak. **Migration of existing codes:** `scripts/promo_code_digest_backfill.mjs` (dry run by default) reads the pending rows, stores each digest and has the database verify the copy; the plain value is blanked only by `promo_codes_finalise_hash_only(false)`, which refuses while any plain row is unverified (all or nothing) and needs `--i-have-a-backup`. Until then redemption falls back to the legacy plain lookup for rows that have no digest, so every existing code keeps working at every step. Reversal is in the README section 6.

**Evidence.** PGlite: a created code stores no plain value, only digest, version and hint; the audit row has neither; API roles get `permission denied` on the four columns; the list has no code column; normalised redemption; wrong, empty and over-long digest lists give the generic refusal; duplicate digest refused; key rotation finds a version 1 code through the previous key candidate and NOT without it; legacy row redeemable before the backfill; backfill functions are service role only; apply, verify and finalise end to end; finalise refuses while one row is unverified. Named controls NC-H1 (finalise without the verified predicate blanks an unverified row) and NC-H2 (verify without the digest comparison marks any digest verified). Unit: the database receives only the digest and hint (`promoCodeEmailService.test.ts`), the code is not in any ledger argument, log, subject, sender or idempotency key. Source contract: the list never renders `r.code`.

**Residual risk.** (a) The backfill and finalise are not run (PO step, DEV first). (b) The hint format: the mission example `ABCD...WXYZ` would reveal 8 of the 10 generated characters, so the existing two plus two (4 of 10) was kept. **PO decision.** (c) A short admin-typed code is weak against an offline attack if the digest key leaks. The runbook has the query to find them. (d) The legacy plain lookup is left in place until the PO has finalised, then it is inert (no row has a plain value). Removing the parameter is a follow-up release. **Status: DONE-with-residual.**

### 18.2 Item 2 DURATION (one inclusive definition)

**Finding.** `effective_to` is inclusive (migration 0115) and `effective_from` is inclusive, but a promo of D days ended on R + D, giving D + 1 calendar days; the admin cap (end date at most today + 365) allowed 366.

**Change.** One definition: a window of N days that starts on R ends on R + N - 1; its length is end minus start plus 1. SQL: `access_end_date()` and `access_window_days()` (0264). TypeScript: `accessEndDate()` and `accessWindowDays()` in `lib/services/entitlementWindow.ts`. Used by promo create (`ends_if_redeemed_today`), promo redeem, the admin grant ceiling (a 365 day grant ends at most today + 364, so the latest end date is one day earlier than before), the list and summary functions (they already used `effective_to` inclusively), the reminder claim (a threshold of t days applies to a window longer than t days, measured with `access_window_days`) and the e-mail wording ("counting the day you redeem it"). Banners count days to the last day (`days = end - today`, 0 on the last day) and are unchanged.

**Evidence.** Unit (`accessWindowDuration.test.ts`): 1, 30, 365 day grants walked day by day give exactly that many days of Premium; leap year (redeemed 28 February 2024: 30 days end 28 March 2024, 365 days end 26 February 2025); named control NC-D1 reproduces the old off by one (end = R + N) and goes red on "day grant gives exactly". PGlite: SQL agrees with TypeScript for the same vectors; a 30 day promo redeemed today ends today + 29 (control NC-D2 with the old rule); the grant ceiling today + 364 allowed and today + 365 refused (control NC-D3); the reminder claim treats a 30 day window as not longer than 30 and a 31 day window as longer (control with the old measure). The existing admin grant, promo and reminder suites were updated for the new semantics and pass.

**Residual risk.** Entitlements already redeemed under the old rule keep their old end dates (one day longer). They are not rewritten. The grant ceiling is one day shorter than before. **PO decision (acknowledge).** **Status: DONE-with-residual.**

### 18.3 Item 3 EXTENSION CAP (lifetime ceiling and the override path)

**Finding.** The cap of 5 extensions reset on revoke and re-grant, so a loop of revoke and grant was unbounded.

**Change.** `user_entitlements.admin_lifetime_grant_units` counts every successful admin grant and extend per user and is never reset by a revoke (backfilled from the append-only audit trail). The ceiling is `premium_grant_lifetime_ceiling()` = 10 (mirrored by `PREMIUM_GRANT_LIFETIME_CEILING`; a test asserts they agree). An ordinary grant or extend after exhaustion is refused with `ENTITLEMENT_LIFETIME_LIMIT_REACHED`. The exceptional override is a **separate capability** `admin_users.can_override_entitlement_limits` (`is_entitlement_override_admin()`), granted to nobody, never implied by Super Admin, by the two ordinary capabilities or by membership, and used only together with `can_manage_premium_entitlements`. It needs `override: true`, a reason of at least 20 characters, and a limit that was really reached (otherwise `ENTITLEMENT_OVERRIDE_NOT_NEEDED`). Each override writes the ordinary audit event, an append-only `premium_entitlement_overrides` row and a high severity `admin_monitoring_events` alert. The second person approval alternative was not built: the mission allowed either, and a separate capability is simpler to audit.

**Evidence.** PGlite: counter backfill never lowers; ten grants and revokes exhaust it and the eleventh grant is refused and changes nothing; extensions count (five hit the per grant cap first); override refused for an entitlement admin, for an admin holding promo plus entitlement, for the override capability alone, with a short reason, on a revoke and when not needed; success writes the three records, none changeable; predicates are separate in both directions. Controls NC-L1 (no lifetime check) and NC-L2 (no capability check). Source contract: the guard order (ordinary first), `/api/admin/me` independent reads, nav shows no entry for the override alone. UI: the override panel renders only when `/api/admin/me` reports the capability (fail closed).

**Residual risk.** Promo redemptions are not counted toward the ceiling (each code is bounded and a user can use a code once; an admin able to create unlimited codes is a separate control). **PO decision.** The ceiling of 10 is a proposal. **Status: DONE-with-residual.**

### 18.4 Item 4 SECRETS (dedicated, mandatory, no fallbacks)

**Finding.** `PREMIUM_PROMO_EMAIL_BIND_SECRET` fell back to `PROMO_IP_HASH_SECRET` then `CRON_SECRET`, and the IP hash to `CRON_SECRET`. One leaked value opened several doors and a missing one silently weakened a control.

**Change.** `lib/services/promoSecrets.ts` is the only reader. Four dedicated secrets, each with one purpose: `PROMO_CODE_DIGEST_SECRET` (new), `PREMIUM_PROMO_EMAIL_BIND_SECRET`, `PROMO_IP_HASH_SECRET`, `CRON_SECRET`. A feature refuses (explicit 503, or the e-mail "not configured" message) if a secret it needs is missing, shorter than 32 characters or equal to another dedicated secret: create needs the digest secret, e-mail and binding also the bind secret, redemption all three, the cron route the cron secret (compared in constant time). Names only are ever logged. `amplify.yml` forwards `PROMO_CODE_DIGEST_`, `PROMO_TRUSTED_PROXY_HOPS` and the existing names; `ENVIRONMENT_VARIABLES.md` documents every name (the mission named `docs/ENVIRONMENT_VARIABLES.md`; the file in this repository is the root `ENVIRONMENT_VARIABLES.md`). **The PO must generate:** `PROMO_CODE_DIGEST_SECRET` (new); `PREMIUM_PROMO_EMAIL_BIND_SECRET` and `PROMO_IP_HASH_SECRET` if production relied on the fallbacks; and rotate `CRON_SECRET` only if it is under 32 characters or equals another (then update the Vault secret too). All different, at least 32 characters.

**Evidence.** Unit: each feature refuses without each of its secrets and names only the variable; a missing bind secret is not rescued by another secret (control NC-S1 reproduces the old chain); reuse detection; digest key set rules; routes refuse before touching the database (create 503, redeem 503 with no database call, cron 503); source contract: no promo source ORs two secrets, only the secrets module and the cron authenticator read them, the libraries never log, amplify forwards and the document describes every name the code reads.

**Residual risk.** Whether the Amplify console values are forwarded at runtime is checked only by the text of `amplify.yml` (DEV). The 32 character minimum would make a shorter existing `CRON_SECRET` refuse the reminder route until rotated (that job is disabled). **Status: DONE-with-residual.**

### 18.5 Item 5 BOUND REDEMPTION

**Finding.** Binding used the session address but did not require it to be verified; the normalisation lived only in TypeScript.

**Change.** Redemption uses the authenticated session user only and passes an address hash only when the account's `email_confirmed_at` is set; the database also requires `auth.users.email_confirmed_at` for a bound code. A browser supplied address or hash is never read. One normalisation contract: trim space, tab, CR and LF, lower case ASCII A to Z only; no Gmail dot or plus rewriting, no unicode folding. TypeScript `normaliseEmailAddress` and SQL `promo_normalise_email` are both checked against `tests/fixtures/email-normalisation-vectors.json`. Behaviour on an address change between issue and redemption: the new address hashes differently, so the bound code stays unusable (the same generic message) until an admin issues a new one. There is no silent rebind, and no way to rebind.

**Evidence.** Unit: hash is the keyed hash of the normalised verified address; unverified, absent and browser claimed addresses give a null hash; address change gives a different hash; Gmail variants differ. PGlite: SQL normaliser equals the vectors; matching verified address redeems while an unverified account, another address, no hash and a changed address all get the identical generic refusal (control NC-B1 without the verified clause). Validation of typed recipients (header injection, control characters, reserved domains) is in item 9.

**Residual risk.** The database never sees an address, so the SQL normaliser is for operators, tests and parity; the runtime path hashes in the application. That Supabase sets `email_confirmed_at` only after the user confirms is the authentication provider's behaviour (assumed). **Status: DONE.**

### 18.6 Item 6 X-FORWARDED-FOR

**Finding.** The per-network limit keyed on the first X-Forwarded-For hop, which the client chooses: a forged header gave a fresh bucket per request.

**Change.** `lib/services/promoCodeIp.ts` takes the address from the **right** of the list with a configurable trusted hop count (`PROMO_TRUSTED_PROXY_HOPS`, default 1). It never reads `X-Real-IP` or any other client settable header. It returns "no trustworthy address" (so only the authoritative per-user limit applies) when the header is absent, shorter than the hop count, malformed, a private, loopback, link local, CGNAT or multicast address (so a wrong hop count cannot put everyone in one bucket) or the setting is invalid. The address is hashed with the dedicated IP secret.

**Evidence.** Unit: a forged left entry cannot change the hash (control NC-I1 with the old first hop reader), two hop counts, every downgrade case, ports and IPv6. The route test sends `9.9.9.9, 203.0.113.9` and checks that neither the forged nor the real address reaches the database.

**What can be proven from the repository.** AWS Amplify Hosting serves through CloudFront, and CloudFront appends the connecting address to the X-Forwarded-For it receives, so the right end is trustworthy and the left end is not. The repository contains evidence only for the `CloudFront-Viewer-Country` header (`lib/services/landingCountryContext.ts`), not for X-Forwarded-For. **UNVERIFIED:** whether Amplify adds a second internal hop (hop count 2), and whether the value reaches the Next.js route unmodified. **DEV proof:** send redemption requests with and without a forged `X-Forwarded-For` and compare the stored `promo_redemption_attempts.ip_hash` values: the hash must not change with the forgery and must equal the hash of your real address; if it equals an internal address the hop count is wrong. **Residual risk:** until the probe is run the per-network limit may be inactive (downgraded) in production; the per-user limit (10 attempts per 15 minutes) is unaffected. **Status: DONE-with-residual.**

### 18.7 Item 7 RETENTION AND CLEANUP

**Finding.** Only the attempts table was pruned (inline, 2 days). The send ledger, request table, reminder ledger, disabled codes and audit events grew without bound, with no legal hold and no run evidence.

**Change.** Migration 0267: `promo_retention_policy` (one named period per data set, a row not a migration), `promo_retention_holds` (a hold on a data set or on one user), `promo_retention_runs` (append-only evidence of every run, dry runs included), and `promo_retention_run(dry_run)` (service role only). The job control row `promo_retention` ships **disabled**; a real run refuses while it is off and leaves a `skipped_disabled` evidence row; a dry run only counts. The pg_cron job `promo-retention-cleanup` is registered only where the production marker row exists and pg_cron is installed; it calls the SQL function directly (no web call, no secret). Anonymise instead of delete where an audit needs the row. The audit table stays append-only for everyone; the only exception is a narrow, transaction local update that marks a row anonymised and leaves its identity columns unchanged.

| Data set | Class | Proposed period | Action |
|---|---|---|---|
| `promo_redemption_attempts` | security telemetry: user id and keyed network hash | 30 days (the redeem function prunes with the same named constant) | delete |
| `promo_email_requests` | operational audit: admin, purpose, counts | 180 days | delete |
| `promo_email_sends` | pseudonymous: keyed recipient hash | 180 days | anonymise (hash replaced, provider id and error cleared) |
| `premium_expiry_email_ledger` | user id, no address | 400 days, settled rows only | delete |
| `promo_codes` | possible free text note | 365 days after disable or after the redeem by date | anonymise (note, digest cleared) |
| `promo_code_events` | audit; the actor of a redeem is an end user | 7 years | anonymise (actor replaced by a zero id) |
| `admin_monitoring_events`, `premium_entitlement_overrides`, `admin_entitlement_events` | append-only audit | not purged | none (small; PO to decide) |

Account deletion: redemption rows and reminder ledger rows follow the user by cascade; rows with no foreign key (attempts, event actors, e-mail request admins) are cleaned on every pass by the orphan step without waiting for the age limit, unless an open hold on everything exists.

**Evidence.** PGlite: ships disabled and the policy rows equal the table above; a real run while off changes nothing and records evidence; enabled run deletes and anonymises exactly the proposed sets, leaves an active code and pending ledger rows alone, and a second run does nothing; the audit trail stays append-only (update, delete and truncate refused even for the service role, even with the switch set but the row not marked anonymised); a user hold and a data set hold pause cleanup and releasing resumes it; orphan step after deleting an account; the job is registered only with the marker, idempotently, with no URL or secret in it. Controls NC-R1 (cleanup that ignores holds).

**Residual risk.** The periods are proposals for PO approval. The job and the account deletion flow were not run together end to end (DEV). `admin_monitoring_events` is not purged. **Status: DONE-with-residual.**

### 18.8 Item 8 MULTI-RECIPIENT PARTIAL FAILURE

**Finding.** With up to 20 recipients, partial failure, a retried request, a browser refresh and a lost response had no documented behaviour and no tests, and a repeated key returned only an error with no way to see who had been reached.

**Change.** A repeated request key now returns the per recipient STATUS from the ledger (new function `admin_promo_email_request_status` and route `POST /api/admin/promo-codes/email-requests/status`, both readable only by the initiating admin and returning no code, address or hash). The plaintext code is returned only for a code that at least one recipient did not receive, once, to the initiating admin; a bound code has one recipient so a failed recipient's code is shown only for that recipient. Every recipient who is not reached gets a ledger row with the reason (`email_switched_off`, `not_configured`, `circuit_open`, or the provider failure). The only way to re-send is an explicit replacement (a new code).

**Evidence.** Cases tested (unit, in `promoCodeEmailService.test.ts` "item 8"), each with the assertion that a delivered recipient's code never appears:
- shared code, some failed: the one shared code is returned once with a status per recipient; exactly one occurrence in the response;
- bound codes, middle one failed: only the failed recipient's code is returned; the other two are absent from the response; each mailer call carried only its own recipient's code;
- the ledger records only keyed hashes, one record per recipient with its own status, no address or code in any argument;
- retry with the same key: no new code, nothing re-sent (not even to the failed one), the response is the per recipient status from the ledger (HTTP 409, no code);
- browser refresh after partial delivery: the status route (new, `POST /api/admin/promo-codes/email-requests/status`) reads the ledger from the key and the addresses typed again and never returns a code; another admin or another key reads "unknown";
- lost response: the ledger still says which recipients were reached; a recipient with no row is "unknown", never assumed delivered;
- recovery is an explicit replacement: a NEW code (different digest), sent only to the recipients supplied, the old code untouched, kind `replace` and the replaced id recorded.
PGlite: the status function returns sent, failed and unknown per hashed recipient, only for the admin who started the request, and a late failure never downgrades a sent row. Named controls: an orchestrator that returned every code is caught ("a delivered recipient's code is not returned").

**Residual risk.** A recipient reconcilable "without storing the address or the code" means unknown when the outcome was never recorded (the process died between sending and recording): the ledger has no pending row before the send. At most once beats a duplicate, so such a recipient is shown as unknown and recovered by replacement. **Status: DONE-with-residual.**

### 18.9 Item 9 E-MAIL ABUSE CONTROLS

**Finding.** The only control was 10 requests and 100 recipients per admin per hour. There was no purpose, no daily or platform wide limit, no alert for unusual volume, no circuit breaker for a failing provider, no limit on repeatedly replacing one code, a loose address pattern, and no timeout on the provider call.

**Change (migration 0266 and `lib/services/promoEmailAbuse.ts`).** A purpose of 10 to 200 characters without control characters is mandatory and recorded with the initiating admin, the kind (create or replace), the replaced code and the recipient count. Limits in one SQL function `promo_email_limits()` mirrored in TypeScript (a test asserts they agree): 100 recipients per admin per rolling day, 300 across all admins per day, 3 replacements per code per day, a volume alert at 80 percent, circuit breaker after 5 consecutive provider failures for 15 minutes; the existing hourly limit (10 requests, 100 recipients) stays. The begin step takes an advisory lock so two simultaneous requests cannot both slip under a limit. A refusal is **returned** (not raised) so its alert row is committed with the call. Alert rows (`admin_monitoring_events`) hold counts, ids and flags only, one per admin per day, never an address or a code. A provider circuit breaker (service role only) counts only provider level failures (network, timeout, 5xx, 429, 401, 403), not a refusal of one address; while open nothing is sent and each new code is shown once. Recipient validation (`lib/services/emailAddressContract.ts`): control characters refused before any trimming, angle brackets, commas, quotes, brackets, backslash, colon and spaces refused, internationalised addresses refused, a real domain with a real top level label, reserved top level labels (test, example, invalid, localhost, local, internal) refused; the message names the position, never the address. The mailer now aborts a provider call after 10 seconds (`resend_timeout`).

**Evidence.** PGlite: purpose required (all bad shapes), duplicate key counts nothing again, no old overload, daily limit per admin and platform wide, alert rows survive the refusal, one volume alert per admin per day, replacement limit, status function, circuit breaker open, close and pause end, service role only (control NC-A1 without the daily check). Unit: injection and malformed addresses refused; breaker open sends nothing; five failing recipients open it and the rest are not attempted with `circuit_open` recorded; a 422 is not a provider failure; mailer timeout and payload keys (`from`, `to`, `subject`, `text` only, no code in the subject, sender or idempotency key).

**Residual risk.** True concurrency of the advisory lock is not provable in PGlite (DEV probe P3). There is no screen that lists the alert rows: they are read with `admin_list_monitoring_events()` (promo or entitlement capability) or SQL. **Status: DONE-with-residual.**

### 18.10 Item 10 PRODUCTION MARKER AND CRON

**Finding.** The authoritative definition of `platform_deployment_environment` is migration 0228. 0229 reads it and 0238 repeats an idempotent create. Production is the row with `environment = 'production'`, inserted by the operator. Four problems: (1) the table had no row level security and no revoke, so on a Supabase project API roles could read it and, with the default table grants, write to it: anyone able to add a `production` row to DEV would make a later replay register production jobs there; (2) the value was free text; (3) two marker rows were possible; (4) there was no single report that shows the marker, the registered jobs, the Vault secret and the kill switches together.

**Change.** Migration 0268. RLS on and every API role privilege revoked. A check constraint (production, development, staging), added NOT VALID so an unexpected existing value is reported rather than hidden (validate it after reading the pre-check output). A unique index on a constant expression allows at most one row, and the migration stops with `MARKER_MORE_THAN_ONE_ROW` if two exist now. Job creation is idempotent (unschedule then schedule) in 0238 and in the new retention job; every kill switch ships off. `premium_cron_verify(sha256)` (service role) reports: single marker row, allowed value, the reminder job registered only in production, no production URL job outside production, the exact production route, the Vault secret present, whether its SHA-256 equals the digest of the application `CRON_SECRET` (the operator passes the digest, the secret never leaves their machine), and that every kill switch is off during a deployment.

**Evidence.** PGlite: API roles denied (select and insert), a second row and a bad value refused, part A refuses over two rows, the verify report in the DEV shape (a production URL job on a database without the marker is a failure), the production shape (job, exact route, Vault secret, digest match and mismatch), a kill switch left on is flagged, the report never returns the secret; the retention job is registered only with the marker, idempotently; every job control switch ships off (source contract and PGlite).

**Residual risk (what cannot be proven).** That the single marker row is truthful for the project it sits in (the operator inserts it). That a disaster recovery replay targets the right origin: the registered URL is the production origin hard coded in 0228 and 0238, correct only if recovery serves the same origin. That the Vault secret and `CRON_SECRET` agree is checked by `premium_cron_verify` on the real database, not here. **Status: DONE-with-residual.**

### 18.11 Item 11 REAL RESEND (DEV certification, plan only)

**Finding.** The e-mail path was tested only with fakes. Sender authentication, placement, the real provider's idempotency behaviour and a hung provider call were unproven, and the mailer had no timeout.

**Change.** `docs/admin/PROMO_EMAIL_RESEND_DEV_CERTIFICATION_RUNBOOK.md` and `scripts/promo_email_resend_dev_certification.mjs` (a skeleton that prints the plan by default, does read only SPF, DKIM and DMARC lookups, and sends only with `--send --confirm-owned-mailboxes`, only against the DEV project, with a sample code that cannot be redeemed). Nothing was sent. The sample body is a file that a test keeps equal to the real message. The mailer now aborts a provider call after 10 seconds (`resend_timeout`, a provider failure for the breaker). **Evidence.** Unit: payload keys (`from`, `to`, `subject`, `text`; headers `Authorization`, `Content-Type`, `Idempotency-Key`; no code outside the body), timeout and abort mapping, the sample equals the real message. Covered in the runbook: SPF, DKIM, DMARC, sender name, delivery placement, links, date wording, no code in the subject, logs or provider metadata beyond the body, Resend idempotency behaviour (UNVERIFIED: the runbook defines the test), failure and timeout handling (a unit test injects a timeout). **Residual risk.** Nothing was sent: the certification itself, the provider idempotency result and the placement are DEV steps. **Status: DONE (plan and skeleton; the certification itself is a DEV step).**

### 18.12 Item 12 BROWSER TESTING (plan and readiness)

**Finding.** No certified list of Admin and Profile states, the two Admin pages used their own paragraphs for outcomes instead of the shared Admin component, and some user visible text named ISO date forms.

**Change.** `docs/admin/PROMO_HARDENING_BROWSER_TEST_PLAN.md` lists every Admin and Profile state with operators for the positive and negative capability cases. The two Admin screens now use the shared `AdminActionStatus` live region, day-first dates through the shared formatters, and the new states (masked list, purpose, status check, override panel). **Evidence.** A source contract test pins labels, the shared component, no native date picker, the masked hint and the responsive wrappers; the existing date format contract tests still pass. The `AdminTaskHelp` registry was not extended: it is a closed set of 18 entries whose manual coverage tests assert the count. **Residual risk.** No browser run was done (no operator session tokens, credentials are never minted); every row of the plan that needs eyes is a DEV step. **Status: DONE-with-residual.**

### 18.13 Item 13 LINEAGE AND MIGRATION CORRECTNESS

**Finding.** The new migrations drop and recreate functions, which can silently lose an owner, a grant, a comment, a security mode or leave an old overload callable; and an edit to an applied migration would go unnoticed.

**Change.** The checks below were added as tests, and the one defect they found (a lost function comment) was fixed.

**Evidence.**
- Applied ancestors 0231, 0237, 0238, 0242 (and 0250 to 0252) are pinned by SHA-256 (line endings ignored); a test fails on any edit; they sort before the new files in the order they were applied.
- Numbers 0264 to 0268 are unique and above every number found on every ref and worktree (0263). No collision with NAV2 (0260 to 0263) or PC7 (0253).
- Every function dropped is recreated, was created by an earlier migration, and no overload remains (PGlite overload counts, the check 0261 added for `pc6_nav_row_is_candidate`).
- Owner, security mode, volatility, language, search_path and the set of roles that may execute are the same before and after for all seven replaced functions (a snapshot before and after on the real replay); redeem is not executable by users; a comment survives (the manage function's comment was lost by the drop and is restored with updated text); the audit triggers are still attached; thirteen sibling functions are byte for byte unchanged; re-applying all five migrations is harmless.
- Every table altered exists earlier; every grant is preceded by a revoke from public; every new function sets a search_path.
- DEV apply order and verify queries after each part: README sections 1 and 2.
- Controls NC-P1 (a flipped security mode is detected), NC-P2 (an extra overload is detected), NC-L1 (an edited applied migration is detected), NC-L2 (numbering).

**Residual risk.** The state of hand applied migrations on databases other than the replay is read from the PO apply lists, not from the databases (the verify queries in the README do that on DEV). **Status: DONE.**

### 18.14 Item 14 CLEAN VERIFICATION PLAN AND TESTS

**Finding.** The earlier suites used the migration text of the original files for their negative controls, which would restore an OLD function after a mutation, and none raced anything.

**Change.** Every negative control now mutates and restores the newest live definition (`latestFunctionSql`); a DEV script covers true concurrency.

**Evidence.** **Replay from empty:** every PGlite suite replays the whole ledger from the shim. **True concurrency** (what PGlite cannot prove): the row lock and CHECK backstop for maximum redemptions, the advisory lock around the e-mail begin step, simultaneous e-mail requests with one key, the real pg_cron, pg_net and Vault. The exact DEV script is `scripts/promo_hardening_dev_proof.mjs` (refuses unless `--confirm-dev` and the DEV project; probes P1 eight users racing for a one use code, P2 ten simultaneous begins with one key, P3 twelve simultaneous begins against the hourly limit, P4 retention dry run, P5 `premium_cron_verify`; cleans up after itself; mints no credentials).

**Tests added or updated** (run one file at a time):
`tests/unit/promoHardeningMigrations.test.ts`, `promoHardeningLineagePglite.test.ts`, `promoHardeningPglite.test.ts`, `premiumExpiryReminderSevenDayPglite.test.ts`, `promoHardeningSourceContract.test.ts`, `promoHardening/emailAddressContract.test.ts`, `promoHardening/promoSecretsDigestAndIp.test.ts`, `promoHardening/accessWindowDuration.test.ts`, `promoHardening/mailerTimeoutAndSample.test.ts`, `promoHardening/operatorScripts.test.ts`; updated for the new semantics: `adminPromoCodesPglite`, `promoCodeEmailPglite`, `adminPremiumGrantPglite`, `premiumExpiryReminderPglite`, `adminPromoCodesService`, `promoCodeEmailService`, `adminPremiumGrantService`, `premiumExpiryReminderRunner`, `premiumFeaturesFailSoft`, `adminAnalyticsPhaseA`. **Results (final state of the branch):** 22 test files run one at a time, 797 tests, all passing (the new and updated promo and Premium suites above, plus the neighbours that read the changed code: the date format contract tests, the mail sender header test and the admin analytics capability tests). `tsc --noEmit` with 8 GB of heap: clean, no errors. ESLint on all 54 new and changed TypeScript and script files: no errors and no warnings. The PGlite replays took about 45 seconds each on the loaded workstation; the grouped vitest runs hit the known temp directory flake, so every file was run alone.

**The seven day reminder** is built OFF (`PREMIUM_REMINDER_SEVEN_DAY_ENABLED`, exact text `true`). Its deduplication against the thirty day reminder is proven before it can be enabled: one ledger row per window and threshold; a long window gets exactly two e-mails (30 days and 7 days) with every rerun between claiming nothing; enabling late sends only the most urgent threshold (control NC-7A); an extension opens a new window; a failed or abandoned thirty day row does not block the seven day one. **This proof found a real gap:** after a seven day e-mail, turning the switch back off would have let the shipped list send a late thirty day e-mail about the same expiry. The claim function now never claims a less urgent threshold once a more urgent one exists for the window (control NC-7C).

**Residual risk. What remains for the DEV proof script and the PO:** apply 0264 to 0268 in order with the verify queries; set the secrets; the digest backfill and finalise; the probes P1 to P5; the X-Forwarded-For probe (item 6); a key rotation rehearsal (runbook); the real Resend certification (item 11); the browser pass (item 12). **Status: DONE-with-residual.**
