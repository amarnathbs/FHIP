# Premium and promo code hardening: your hand-over pack (DEV first)

Branch `feat/promo-hardening-release-20261007`. Nothing in this pack has been applied anywhere. Nothing is pushed. Dates in this pack are written day first.

**What this changes for people using the app: nothing they can see, except that promo codes are no longer stored in plain text, a 30-day code now gives exactly 30 days (counting the day you redeem it), and the admin screens show a masked code (like AB******YZ) instead of the code.**

**Why the order matters.** The site that is live today keeps working while you do this. The database changes only ADD things beside the old ones (a test proves it on a copy of today's database, `tests/unit/promoHardeningDeploySafetyPglite.test.ts`). The old things are removed by a separate last step (0279) that you run only after everything is checked. If you stop half way, nothing is broken.

## 0. Which project am I on?

Every Supabase page shows the project in its address. DEV is `.../dashboard/project/vqycarelcoijzwlpkpcz`. **Production is `.../dashboard/project/twwpnltizhtjxhamyoxt`. This README is for DEV. Do not open any file of this pack on the production project until you have read `PRODUCTION_RUNBOOK.md`.**

## 1. How to run a file

1. Open the file in Notepad (or VS Code). Press Ctrl+A, then Ctrl+C.
2. In Supabase open **SQL Editor**, choose **New query**, press Ctrl+V, press **Run**.
3. Check files (`checks/`) show a table. The last column `ok` must say `true` on every row. Migration files show "Success. No rows returned". 
4. If the editor shows a red error: copy the error text and send it to me. Do not run anything else. Every file is safe to run again.
5. If a whole migration file is too long for the editor, run its **parts** (`parts/0265a.sql`, `0265b.sql`, ...) one after the other in letter order. Joined, the parts are exactly the file.

## 2. DEV steps, in this order

| Step | Run this | Then run this check | What you should see |
|---|---|---|---|
| 1 | `checks/D1_before_detect.sql` (read only) | none | every `ok` is `true` (section C says `false` in the `actual` column because nothing is applied yet). **Send me the table.** If any row in section A, B or E is not ok, STOP and send it to me. |
| 2 | `supabase/migrations/0264_promo_hardening_foundations.sql` (parts `0264a` to `0264d`) | `checks/V0264_after_0264.sql` | all `ok` true |
| 3 | `supabase/migrations/0265_promo_hardening_functions.sql` (parts `0265a` to `0265f`) | `checks/V0265_after_0265.sql` | all `ok` true |
| 4 | `supabase/migrations/0266_promo_email_abuse_controls.sql` (parts `0266a` to `0266d`) | `checks/V0266_after_0266.sql` | all `ok` true |
| 5 | `supabase/migrations/0267_promo_retention_and_cleanup.sql` (parts `0267a` to `0267d`) | `checks/V0267_after_0267.sql` | all `ok` true; both job switches say `false` |
| 6 | `supabase/migrations/0268_platform_marker_hardening_and_cron_verify.sql` (parts `0268a`, `0268b`) | `checks/V0268_after_0268.sql` | all `ok` true |

After step 6 tell me: **"applied on DEV"**. I then run the proof scripts, the browser checks and the real e-mail checks on DEV (you do nothing during that). I will come back with a report.

After my DEV proof passes I report back and ask you to continue. DEV has no deployed copy of the new application, so **steps 7 and 8 are done by me on my own local copy of the app that talks to DEV**. You run steps 9 and 10.

| Step | Who | What | Then run this check | What you should see |
|---|---|---|---|---|
| 7 | me | press **Prepare existing codes** in the Setup check box of the Admin Promo Codes page (safe to repeat) | `checks/V_after_prepare_existing_codes.sql` (you or me) | row 4 is `0`; all `ok` true |
| 8 | me | redeem an existing DEV test code with a test account: it must still work | none | the account shows Premium from a promo code |
| 9 | you | the finalise. It removes the stored code text for good (on production you make a backup first). Paste and run: `select public.promo_codes_finalise_hash_only(false);` | `checks/V_after_finalise.sql` | all `ok` true |
| 10 | you | `supabase/migrations/0279_promo_hardening_legacy_cleanup.sql` (parts `0279a`, `0279b`). It refuses with `PROMO_CLEANUP_BLOCKED` until step 9 is done. That refusal is correct, not a fault. | `checks/V0279_after_0279.sql` | all `ok` true |
| 11 | you, last, DEV only | `cleanup/DEV_ONLY_residue_cleanup.sql` removes the probe codes, alerts and audit rows my proofs left on DEV (they cannot be deleted by the application on purpose). It refuses on a database that looks like production. | its own result table | every count `0`, and the last row `2` |

## 3. What to paste back to me

- After step 1: the table (a screenshot is fine).
- After each migration: the check table, or a screenshot showing the `ok` column.
- If anything is red: the exact red message, copied as text.

## 4. Secrets (DEV is done by me, production is done by you)

- **DEV:** I generate four random values into my own test environment. They are never printed and never committed. If your DEV site on Amplify must run this code, it needs the same four variable names set to four DIFFERENT random values of at least 32 characters. Tell me and I will give you the PowerShell line.
- **Production:** `PRODUCTION_RUNBOOK.md` section 3 has the PowerShell line. It puts one random value at a time on your clipboard (nothing is shown on screen) and tells you which Amplify variable to paste it into.

The four names, each with its own value, none shared: `PROMO_CODE_DIGEST_SECRET`, `PREMIUM_PROMO_EMAIL_BIND_SECRET`, `PROMO_IP_HASH_SECRET`, `CRON_SECRET`. If one is missing, too short (under 32 characters) or the same as another, the feature that needs it refuses and the Promo Codes page says exactly which one in the "Setup check" box. Nothing falls back to another secret. Ordinary Premium use, billing and the other Admin pages never read these secrets (a test proves it).

## 5. What stays OFF

- `PREMIUM_PROMO_EMAIL_ENABLED`: you decided on 07-10-2026 to KEEP it on in production. On DEV it is off unless I am testing. If e-mails ever look wrong, run `emergency/STOP_promo_emails.sql` (stops sending within a second, no redeploy; codes are then shown once on screen). `emergency/RESUME_promo_emails.sql` resumes.
- The expiry reminder e-mail job and the 7-day reminder: off.
- The cleanup (retention) job: off. It is registered only on production and does nothing while its switch is off.
- The override capability `can_override_entitlement_limits`: granted to nobody.

## 6. If something goes wrong

- A migration part fails: stop, send me the message. Every part can be run again.
- You want the DEV database back as it was: `rollback/R2_undo_0264_to_0268.sql` (and `rollback/R1_after_0279_restore_old_function_shapes.sql` first if 0279 was applied). A test proves both on a copy. You normally do not need them: the new database objects do no harm to the old site.
- The application only: redeploy the previous Amplify build. This is safe up to step 9.

## 7. Files in this folder

| Path | What it is |
|---|---|
| `parts/` | the migrations in small pieces (source of truth; joined they are byte for byte the files in `supabase/migrations`) |
| `checks/` | one read only detection file (D1) and one verification file per step (V...) |
| `rollback/` | R1 and R2, generated from the original migrations |
| `emergency/` | STOP and RESUME for promo e-mails |
| `cleanup/` | the DEV only residue cleanup (step 11) |
| `PRODUCTION_RUNBOOK.md` | the production order, the failure behaviour of every step, the checks after the deploy |
| `resend_sample_body.txt` | the sample message of the e-mail test (a test keeps it equal to the real message) |

The long report with every evidence label and the 14 review items is `../PROMO_PREMIUM_HARDENING_CERTIFICATION.md`.
