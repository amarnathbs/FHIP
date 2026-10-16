# Staff admin Premium: report

Branch `feat/admin-users-premium-20261016`. Product Owner decision, 16-10-2026: "I want the admin user should also be a premium user, not the normal user."
Evidence labels used below: UNIT-TESTED (node tests), PGLITE-VERIFIED (real Postgres replay of the whole migration ledger), CODE-REVIEWED. **Nothing is DEV-verified or production-verified yet.**

## 1. The rule, and what it replaces

Staff accounts hold a REAL Premium entitlement row in `user_entitlements` (`entitlement_source = 'staff_admin'`), written by the database, visible and auditable in the same table and the same Admin screen as every other complimentary Premium.

This deliberately reverses the earlier rule "admin status alone must not grant consumer Premium". The new rule: admin status causes a genuine entitlement row to exist; it never causes Premium by itself. The consumer Premium checks (`lib/entitlements/financialDataImport.ts`, `lib/ai/access/premiumAiAccess.ts`, `effectivePlanTier` in `lib/services/entitlementWindow.ts`, `getPlanTier`, the SQL `ai_entitlement_state` and `ai_admit_request`) are unchanged in behaviour and still read only the row. `tests/unit/staffPremiumNoRoleShortcut.test.ts` fails if any of them, or any file that calls them, gains an admin-role reference. Only their header comments were edited (the old "never treats an Admin as Premium" wording was now false).

## 2. How Premium is stored and resolved (read from the current code)

- Table `user_entitlements` (one row per user): `plan_tier` (`free` or `premium`), `effective_from`, `effective_to` (inclusive, null means open ended), `entitlement_source` (`payment`, `admin_grant`, `promo_code`, and now `staff_admin`), `admin_grant_ends_on`, `reserve_source`, `admin_grant_extension_count`, `admin_lifetime_grant_units`, provider fields.
- Premium today = `plan_tier = 'premium'` and the window includes today (`effectivePlanTier`, mirrored by the SQL AI functions). Every consumer reads the row on every call. **Confirmed: no cache** (no `unstable_cache`, no memo; the guards document it and the code agrees), so a staff entitlement is usable on the next request and ends on the next request.
- Writers: Stripe or Razorpay webhook through `apply_subscription_entitlement_event`, the admin grant function `admin_manage_premium_entitlement`, promo redemption `redeem_promo_code_for_user`, and now the staff guard.

## 3. Why a new source, not the existing admin grant

The grant mechanism cannot express "no end date, lasts while the role lasts": a grant ends at most 364 days after today (365 inclusive days), may be extended 5 times, counts against a lifetime ceiling of 10 per person, creates expiry reminder e-mails and shows in the expiry summary, and the override capability that lifts those limits is held by nobody. Forcing staff through it would either break those PO-accepted consumer rules or make staff Premium expire and need a renewal job. A distinct source (`staff_admin`) keeps both rule sets intact: staff rows have no end date, are invisible to the ceilings, the extension cap, the expiry summary, the reminder claim and the promo counters, and the grant functions refuse to touch them.

## 4. DECISION D1: which accounts count (PO-decided 16-10-2026)

Found in the code: there is no single "admin user" table. Admin access comes from two places:
- `admin_users`: a row means Super Admin (full rights; optional named capability columns such as `can_manage_premium_entitlements`; written only by the service role or SQL).
- `resource_user_roles`: an ACTIVE row for one of six Resources roles (`resource_admin`, `author`, `editor`, `compliance_reviewer`, `publisher`, `analyst`), written by the Admin "Users and roles" screen. Every one of the six opens the Admin shell (`requireResourceAdminAccess`: any role, or Super Admin).

**Decision (Product Owner, 16-10-2026, after the recommendation was put to him: "use your recommendations"):** staff = a row in `admin_users` (Super Admin), or an active `resource_admin`, or an active `editor`. Author, Compliance Reviewer, Publisher and Analyst do NOT qualify. They can be added later by editing one function.

| Case | Treatment |
|---|---|
| Super Admin with no optional capability | Staff |
| Resource Administrator, Editor | Staff |
| Author, Compliance Reviewer, Publisher, Analyst | Not staff (open the Admin shell but get no Staff Premium; the pre-migration preview lists them in Section C) |
| Role row with `is_active = false` (removed) | Not staff |
| Account holding both a Super Admin row and a role | Staff; ends only when ALL qualifying rows are gone |
| Account that is staff AND has a paid subscription | Paid wins and is untouched; Staff Premium resumes if the subscription ends |
| Account that is staff AND has an active admin grant or promo | Staff Premium replaces it (no end date is a superset); on leaving staff the account returns to Free, the old grant is not restored (PO accepted this on 16-10-2026). The preview names these accounts first |
| Any other account | Never gets a staff row (the database refuses one) |

Changing the rule later is one function, `public.is_staff_premium_account`, plus the TypeScript list `STAFF_PREMIUM_RESOURCE_ROLES` (a test asserts they are equal, and that the six Resources roles are exactly the included plus the excluded lists). The reconcile preview (`staff_premium_reconcile(true)`, read only) then lists who would `start` and who would `end`; a test narrows the function and shows the `end` list.

## 5. Design

**Database trigger, not an application hook.** Admin roles are written from three places (the Admin screen through the service role, direct SQL by the PO, and `admin_users` rows that no screen writes at all). Only a trigger sees all of them and cannot be bypassed; it is also the easiest to test against a real Postgres.

Migration `0283_staff_admin_premium.sql` (3 hand-run parts; highest on main is 0280; NAV2, not on main, claims 0281 and 0282; checked on every ref and every worktree):
- Part A: widens the source constraint to add `staff_admin` (predecessor read off the ledger: 0237, and no other ref touches it), adds the staff shape rule (Premium, open ended, no reserve), and the append-only, RLS-protected audit table `staff_premium_events`.
- Part B: `is_staff_premium_account()` (the one definition); `staff_premium_guard()` before insert or update on `user_entitlements` (refuses a staff row for a non-staff account, refuses an admin grant or promo over a staff row, rewrites a Free staff account back to Staff Premium so a cancelled checkout or revoke cannot take it, leaves a live paid subscription alone, writes the audit event); `staff_premium_sync_user()`; triggers on `admin_users` and `resource_user_roles`; `staff_premium_reconcile(dry_run)` which is the preview (default, writes nothing, masked e-mail) and the backfill (idempotent).
- Part C: two read functions for the Premium Access screen under the existing capability `can_manage_premium_entitlements`: `admin_list_staff_premium()` and `admin_staff_premium_history()`.

Nothing is backfilled by the migration. Application changes: Premium Access shows a read-only "Staff Premium (automatic)" section and a note on a staff user (no grant, extend or revoke buttons); a refused grant or revoke on a staff row says so instead of "paid or set manually"; the billing page labels it "Premium (included with your FHIP staff account)", shows no end date, no expiry reminder, and replaces the promo box with an explanation (subscription and cancel flows are untouched); the promo redeem route answers a staff account before any code is consumed (the database refuses anyway); the admin AI entitlements count reports how many Premium subjects are staff.

## 6. Expiry and renewal

None needed: there is no end date. It ends when the last staff role goes (trigger) or an operator runs the reconcile. If a role change ever bypasses the triggers (a TRUNCATE, or a trigger switched off for maintenance), `checks/V_after_backfill.sql` and the preview show the drift and one call repairs it.

## 7. Admin Architecture Standard

- Capabilities affected: `can_manage_premium_entitlements` (existing, reused for the two read functions and the read-only route; nothing is granted to anyone; no new capability, no implied inheritance, section 3). Not touched: promo, override, resources, benchmarks.
- Clauses and the tests proving them: 2 and 4 (database layer: the two read functions re-check the capability on `auth.uid()`, PGLITE-VERIFIED including anon, customer and capability-less Super Admin refused; API layer: 401, 403 and 503 on a missing function, UNIT-TESTED; page layer: the existing page guard is unchanged; navigation unchanged); 6 (SECURITY DEFINER functions: fixed `search_path`, explicit return types, no dynamic SQL, execute revoked from public and anon, sync and reconcile granted to the service role only, PGLITE-VERIFIED); 9 (the screens show the e-mail the screen already showed to this capability, role names and state; no financial data; the preview masks the e-mail); 13 (a missing function is 503, never an empty list); 14 (no unrelated admin behaviour changed; the one existing test control that the staff guard now blocks was adjusted and is named in section 9).
- No exception to the standard is requested.

## 8. Verification (honest labels)

See section 9 for the numbers. PGLITE-VERIFIED: qualification (the two included roles qualify, the four excluded ones and an inactive role do not, a customer never does), new assignment and removal incl. the last-role rule, a statement typed in the SQL editor, account deletion, the preview writes nothing, the backfill is idempotent (table byte-identical after a second run), paid is left alone, an active grant or promo is replaced and recorded, payment webhook interplay (premium event, cancel, abandoned checkout), consumer counters untouched, the grant functions refuse a staff row, staff rows invisible to the grant list, expiry summary and reminder claim, no staff row for a non-staff account (guard, even as the service role), RLS and privileges, the AI entitlement state, rollback R1 and R2. Each rule has a named negative control that goes red when the rule is removed (guard rewrite, qualification test, `is_active` test, trigger on `admin_users`, ending branch, the preview). UNIT-TESTED: routes, wording, the no-role-shortcut guard with controls against the real guard sources.

NOT verified: DEV (the PO applies the SQL), production, real concurrency, the hosted Supabase role grants, a visual browser check (no DEV sign-in was available to this session; the component is only server-render smoke tested).

## 9. Tests versus baseline

Branch rebased on origin/main 4b5a60a (16-10-2026). Baseline = a clean checkout of exactly that commit, same machine.

- **New tests: 103, all passing** (staffAdminPremiumPglite 47, staffAdminPremiumPackPglite 21, staffAdminPremiumApp 20, staffPremiumNoRoleShortcut 15), with about 16 named negative controls that each go red against a deliberately broken rule (the named assertion must fail as a real AssertionError, not a SQL error).
- **Existing suites that touch this area still pass**: adminPremiumGrantPglite (40), adminPromoCodesPglite, premiumExpiryReminderPglite, premiumExpiryReminderSevenDayPglite, promoCodeEmailPglite, the promo hardening suites, premiumAiAccessGuard, premiumUploadInventoryContract, adminPremiumGrantService.
- **Two existing tests were changed, both necessarily, both minimal**:
  1. `adminPremiumGrantPglite.test.ts`, the control "grant UPDATE lost its WHERE clause": the fixture admins are staff accounts now, so the staff guard refuses the deliberately broken statement the moment it touches their rows (STAFF_PREMIUM_PROTECTED) and the control failed for a different reason than the one it is named after. The guard trigger is switched off for that one control and back on afterwards.
  2. `benchmarkEntitlementEditRevisionPglite.test.ts` (another workstream): it asserted that 0280 is the newest migration file, a tripwire from when 0280 was claimed. Any later migration (this one, NAV2 0281 and 0282) trips it. It now asserts the newest migration is not older than 0280. Line endings of that file are preserved.
- **Full suite** (13484 tests, 760 files, 812 s, parallel): 30 failed. All failures are either the known load and Windows temp-directory races or failures that also occur on a clean origin/main. In isolation (one worker, long timeouts) the union of the failing files gives **23 failing tests on the branch and the same 23 (identical names) on the clean baseline**; they are in adminAnalyticsPhaseAMeRoute (17), aiResidualClosureFailClosed, countryGateAccessMatrix, iiNetWorthNavRemarkPublishFlow, lr1UploadSecurityRawFileLifecycle, m12cServerOnlySecretBoundary, resourcesR1_1. The remaining "failed" files are file-level import errors from a missing temp file (ENOENT) or 5 second timeouts, different from run to run on both, and pass when re-run alone (for example heldSchemes and paymentProviderActivation failed once under load and passed twice alone).
- `tsc --noEmit`: one error (`tests/unit/canonicalCertResidueAllSql.test.ts(127,75)`), identical on the clean baseline. `eslint` on the 19 changed source and test files: clean. `next build` (Turbopack, dummy public Supabase variables): exit 0; the new route `/api/admin/entitlements/staff` is in the build.
- The full run rewrites checked-in `scripts/` artifacts; they were restored with `git checkout -- scripts/` and are not in the commit.

## 10. Open questions (all answered by the PO on 16-10-2026)

1. D1: decided, see section 4.
2. A staff member's replaced admin grant or promo is not restored when they leave staff: acceptable.
3. Pseudonymous user ids kept in the audit tables after an account is deleted: confirmed.
4. Staff may use chargeable AI-assisted reading under the normal allowance, rate limit and spend cap (including the per-user daily cap being built on another branch): confirmed.
