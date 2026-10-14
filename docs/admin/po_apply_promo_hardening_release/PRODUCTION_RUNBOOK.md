# Premium and promo code hardening: PRODUCTION RUNBOOK

Branch `feat/promo-hardening-release-20261007`, merged with origin/main d7ccc2c on 08-10-2026 (no migration in that merge; 0279 stays free; the migration files 0264 to 0268 and 0279 are unchanged since the PO applied them on DEV). **Do not start this until the DEV certification (`../PROMO_PREMIUM_HARDENING_CERTIFICATION.md`) says PASS and you have read this page.** Dates are written day first. Nothing here has been run on production. Evidence labels: **PGlite-proven** (real Postgres on a copy of today's database), **unit-tested**, **DEV-verified** (filled in by the certification), **UNVERIFIED** (cannot be known from the repository).

You decided on 07-10-2026 to KEEP `PREMIUM_PROMO_EMAIL_ENABLED=true` in production. This runbook keeps it on and gives you an instant stop (section 7).

## 1. The idea in one paragraph

The site that is live today keeps working at every step. The database change only ADDS things next to the old ones (**PGlite-proven**, `tests/unit/promoHardeningDeploySafetyPglite.test.ts` phase A and `promoHardeningLineagePglite.test.ts`: every old function is byte for byte unchanged and every call the live site makes reaches exactly one function). The new site also works before and after the backfill (**PGlite-proven**, phases B and C) and refuses cleanly, never breaks, against a database that has not been updated (**unit-tested** and seen in a browser on DEV). The old things are removed only in the last step, after you have checked everything, and the stored code text is removed in the step before that. Those two last steps are the only ones that cannot be undone by redeploying the old site.

## 2. The order (one line each, details below)

| # | Step | Who | Point of no return? |
|---|---|---|---|
| 1 | Read-only detection on production (`checks/D1_before_detect.sql`) | you | no |
| 2 | Make sure a restore point exists | you | no |
| 3 | Set the four secrets in Amplify (no redeploy yet) | you | no |
| 4 | Apply 0264 to 0268 with a check after each | you | no (additive) |
| 5 | Push, Amplify builds and deploys | you | no (redeploy the previous build) |
| 6 | Post-deploy checks, including **Prepare existing codes** | you | no |
| 7 | Watch for a day (your choice of length) | you | no |
| 8 | Finalise: remove the stored code text (after a backup) | you | **yes for the old site** (the new site is unaffected) |
| 9 | Cleanup 0279 | you | **yes for the old site** |

Why this order and not "backfill, then deploy": the backfill runs inside the new site (the digest key must never leave the server), so the new site must be live first. This is safe because the new site finds a code with a stored plain text through the old lookup until it has been prepared (**PGlite-proven**, phase B, with a named negative control showing what would break without it).

## 3. Step 3 in detail: the four secrets

You need four DIFFERENT random values, each at least 32 characters. The site refuses a feature whose secret is missing, short, or equal to another one, and says which one on the Promo Codes page. Nothing falls back to another secret.

| Variable | Used for | Keep or generate? |
|---|---|---|
| `PROMO_CODE_DIGEST_SECRET` | identifies a promo code without storing it | **Generate (new)** |
| `PROMO_IP_HASH_SECRET` | limits repeated redemption attempts per network address | **Generate** (it used to be allowed to equal `CRON_SECRET`; changing it only resets the attempt counters) |
| `PREMIUM_PROMO_EMAIL_BIND_SECRET` | ties a code to one e-mail address, and every redemption | **Keep** if it is at least 32 characters and different from the other three. If you generate a new one, codes that were bound to an address stop working until replaced |
| `CRON_SECRET` | the scheduled jobs (also used by other jobs, with copies in the database Vault) | **Keep.** Do not rotate it in this release. If it is shorter than 32 characters or equals another of the four, tell me first: only the (switched off) Premium reminder job refuses, but the hourly call would then be logged as a failure |

**Generate without ever seeing the values** (Windows PowerShell). It puts one value on your clipboard at a time. Paste it into Amplify, save, press Enter for the next, and the clipboard is cleared at the end:

```powershell
foreach ($n in 'PROMO_CODE_DIGEST_SECRET','PROMO_IP_HASH_SECRET') { $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); Set-Clipboard -Value (($b | ForEach-Object { $_.ToString('x2') }) -join ''); Read-Host "$n is on your clipboard. In Amplify open App settings, Environment variables, create or replace $n, paste, save. Press Enter for the next" | Out-Null }; Set-Clipboard -Value ' '; 'Clipboard cleared.'
```

Add `'PREMIUM_PROMO_EMAIL_BIND_SECRET'` to the list in the quotes only if you decided to generate a new one. Each value is 64 hexadecimal characters.

**Optional:** `PROMO_TRUSTED_PROXY_HOPS` (default `1`). Leave it unset now; step 6c tells you whether to change it.

**What happens to the live site when you do this:** nothing. Amplify reads the variables when it BUILDS, not while a build is running, so the site that is live today does not change until step 5. Because they are read at build time, **set all of them before you push**: a push that starts building before they are saved will build without them (the site then shows the red Setup check and the actions refuse; fix the variables and redeploy).

## 4. Step 4 in detail: the migrations

Use `README.md` section 1 to run files. Order and checks:

1. Run `checks/D1_before_detect.sql` first (step 1). Section B compares the five old functions with the repository text after ignoring layout and comments (DEV was red with the first, byte-exact version of this check and green with this one, so a layout difference alone is normal). If section B is still not ok, run `checks/D2_old_function_definitions.sql` and **stop and send me both results**: the bodies then differ in wording, not only in layout.
2. `0264` then `checks/V0264_after_0264.sql`; `0265` then `V0265`; `0266` then `V0266`; `0267` then `V0267`; `0268` then `V0268`. All `ok` true after each.
3. Before `0268`: D1 section E must show at most one environment marker row. If it shows two, stop (the migration refuses by design, with `MARKER_MORE_THAN_ONE_ROW`, and changes nothing).

**What users see during this step:** nothing. **If a part fails:** nothing is half done that matters; send me the red message; every part can be run again. **Locks:** the migrations add columns with default values and small checks; on the current table sizes they finish in well under a second each (UNVERIFIED on production data; the biggest table touched is `user_entitlements`).

## 5. Step 5: the deploy

Push `feat/promo-hardening-release-20261007` as you decide (I do not push). Amplify auto-deploys on push to main. While it builds, the old site keeps serving. After it switches, the new site runs against the already-updated database.

If the build fails: the old site stays live, nothing changed for users; send me the build log.
If the new site misbehaves after it went live: in Amplify, redeploy the previous successful build (safe up to step 8, **PGlite-proven**; one caveat: codes created by the new site exist only as protected copies, so the old site cannot redeem them. Replace those codes with "Generate a replacement code and email it" after the old site is back, or fix forward instead).

## 6. Step 6: checks right after the deploy (about 15 minutes)

Sign in as an administrator who holds the promo capability.

a. **Admin, Promo Codes, "Setup check"**: all four secrets say `set`, the box says every secret is set. If a secret is red, set it in Amplify and redeploy. While red: creating, e-mailing or redeeming codes refuses with a clear message; nothing else is affected (ordinary Premium use, billing and the other Admin pages never read these secrets: **unit-tested**, `promoHardeningSetupAndBackfillRoutes.test.ts`).
b. **Premium Access** still opens and lists grants.
c. **Network address check** (same page): press it. It shows the address list your browser request carried and the entry it would use. If the chosen address is your own public address (search "what is my IP"), the setting is right. If it shows an internal address, or the wrong one, set `PROMO_TRUSTED_PROXY_HOPS` to `2` in Amplify and redeploy, then check again. Until this is right only the per-user limit (10 attempts per 15 minutes) applies: nothing breaks. (Whether Amplify adds one trusted hop or two is **UNVERIFIED** from the repository; this button settles it.)
d. **Prepare existing codes** (same page, "Codes created before hash-only storage"): press it. It is safe to repeat and removes nothing. Then run `checks/V_after_prepare_existing_codes.sql`: row 4 must be `0`.
e. **An existing code still works.** On a test account, enter one of your two existing test codes on the Profile page. It must still work (Premium from a promo code).
f. **A new code.** Create a code without e-mail. It is shown once. The list shows only a masked hint (`AB******YZ`). Redeem it with a second test account.
g. **A real e-mail** to your own mailbox (the switch is on): it arrives from "FHIP", the subject is "Your FHIP Premium access code" without the code, and the date reads like "4 January 2027". In Gmail choose "Show original" and read SPF, DKIM and DMARC. **Finding from DEV:** the sending domain currently has SPF and DKIM but no DMARC record. Mail still arrives, but you should add a `_dmarc` record (the certification report gives the exact text).
h. **A grant.** Grant a test user Premium with the last day set to 29 days after today: that is 30 days counting today and the last day. The latest last day the page accepts is 364 days after today (365 days counting today). Extend it, then revoke it. The page shows the extension and lifetime counters.
i. **Ordinary Premium use.** A normal user (or you) opens the dashboard and a report as a Premium user.

## 7. Instant stop for promo e-mails (no redeploy)

If anything about the e-mails looks wrong: run `emergency/STOP_promo_emails.sql` in the SQL editor. It pauses sending for 24 hours within a second; new codes are then created and shown once on screen. `emergency/RESUME_promo_emails.sql` resumes. (**PGlite-proven.**) This does not change `PREMIUM_PROMO_EMAIL_ENABLED`, which is read at build time. The e-mail path also pauses by itself after 5 provider failures in a row for 15 minutes, and refuses beyond 100 recipients per admin per day and 300 across all admins per day (**PGlite-proven**).

## 8. Step 8: finalise (the first point of no return for the OLD site)

Only after step 6 passed and you have watched for as long as you want.

1. **Make a restore point.** Supabase dashboard, Database, Backups. Note the time.
2. Dry run: `select public.promo_codes_finalise_hash_only(true);` It shows how many codes still hold their text and how many are unverified. If the unverified count is not `0`, go back to step 6d.
3. Real run: `select public.promo_codes_finalise_hash_only(false);` It refuses (`PROMO_FINALISE_BLOCKED`) if any code with stored text has no verified protected copy, and changes nothing in that case (**PGlite-proven**, with a negative control that shows what blanking an unverified row would destroy).
4. `checks/V_after_finalise.sql`: all `ok` true. Redeem an existing code once more (6e): it works, by its protected copy.

After this the old site cannot redeem existing codes (its lookup needs the stored text). The new site is unaffected. To go back past this point you restore the backup.

## 9. Step 9: cleanup 0279

Run `supabase/migrations/0279_promo_hardening_legacy_cleanup.sql`, then `checks/V0279_after_0279.sql`. It refuses (`PROMO_CLEANUP_BLOCKED`) while any code still holds its text or a new function is missing (**PGlite-proven**). It removes the five old function shapes and brings the lifetime counter up to the audit trail (grants made by the old site during the overlap are counted).

## 10. What each failure looks like, and what to do

| What failed | What a user sees | What an admin sees | What to do |
|---|---|---|---|
| A secret is missing, short or reused | on the Profile page a promo code answers "Promo codes are unavailable right now"; everything else works | red Setup check naming the variable; create, e-mail and redeem refuse with a clear message | set the variable, redeploy |
| New site deployed before the migrations | same as above for promo codes | "This feature is not available on this database yet" on the Promo Codes and Premium pages | run the migrations (the checks above) |
| A migration part fails | nothing | the editor error | send it to me, re-run the part |
| `PROMO_CLEANUP_BLOCKED` | nothing | the editor error | finish step 6d and step 8 first (this is the guard working) |
| The e-mail provider is down or slow | nothing | the code is shown once on screen with "could not be sent"; after 5 failures in a row sending pauses for 15 minutes | resend with "Generate a replacement code and email it", or wait |
| Wrong hop count | nothing | the Network address check shows an internal or wrong address | set `PROMO_TRUSTED_PROXY_HOPS`, redeploy |
| You need the old site back | normal | normal | redeploy the previous build (up to step 8) |

## 11. Rollback of the database (rarely needed)

Normally never: the additive migrations are harmless to the old site. If you must: `rollback/R2_undo_0264_to_0268.sql` (run `rollback/R1_after_0279_restore_old_function_shapes.sql` first if 0279 ran). R2 refuses when a code exists only as a protected copy, because dropping the columns would orphan it; then restore the backup instead. Both are **PGlite-proven**, including that the old site works again afterwards and that rolling forward again works.

## 12. What this runbook does not prove

- Nothing here was run on production. DEV runs are in the certification report.
- Amplify's real X-Forwarded-For hop count (step 6c settles it on the day).
- Real mail placement in your inbox, and SPF, DKIM and DMARC results as the receiving provider sees them (you read them in "Show original").
- Lock times on production table sizes.
- True simultaneous redemption by many users: PGlite has one connection; the DEV proof script races real connections (certification report).
