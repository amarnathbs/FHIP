# Per-user daily AI spend cap: what you do, in order

Branch `feat/aie-per-user-daily-cap-20261016`, built on `origin/main` `4b5a60a`. Authority: Product Owner decision 16-10-2026.
Status: **READY FOR YOUR DEV APPLY**. Nothing is pushed, nothing is applied on DEV or production. I have no production access.

**What changes for people.** Each Premium user can have AI-read documents worth at most **US$1.00 per UTC day**. A request that would
take them over is refused **before** the AI provider is called (nothing sent, nothing charged), and the screen says, in plain words:
*"FHIP could not read this file automatically. You have reached the daily limit for AI-assisted reading, so it was not attempted. The limit
resets every day: please try again tomorrow, or enter this information manually."* The same words appear on all five import panels
(bank statement, payslip, liability statement, retirement statement, AU investment statement). The Investment Intelligence statement
upload shows the same message in its own failure line. Manual entry is unaffected. Free users never reach this (the Premium guard is first).

**What does not change.** The global US$10 ledger, the kill switches, quota, the Premium guard, masking, the malware precondition and
the model contract are untouched. The global ledger is still checked in the same step, after the per-user check.

**The day is the UTC day** (00:00 to 24:00 UTC). For Australia that resets at 10:00 or 11:00 in the morning, for India at 05:30. See `01_...` for why.

## The one thing that matters about order

The new application code calls a new database function (`aie_reserve_ai_cost_v2`). If the code is live before the migration is applied,
**every AI reading is refused** (fail closed, by design: it never falls back to the uncapped function). So: **apply the migration first,
verify, then push.** The reverse is safe: the migration alone changes nothing for the old code, which keeps calling the old function.

## UPDATE 16-10-2026 after the first DEV run: re-run `04_apply_migration_0284.sql` (corrected function)

The live check on DEV found a real defect in the first version of the function: it claimed its key (a foreign key insert that takes a shared lock on the
ledger row) and only then asked for the exclusive ledger lock, so simultaneous requests for different keys waited on each other. On DEV, 22 parallel requests
admitted 2 and timed out 20 at the statement timeout (nothing overshot, every failure refused, but real concurrent use would have been refused spuriously). The function now
takes the ledger lock first. The migration file is `create or replace`, so **DEV: paste the current `dev/04_apply_migration_0284.sql` again, then `05` and `06`, then tell me and I re-run the live check in parallel mode**.
**Production: if `04` was already applied there, paste the current file again too (same, safe to repeat), then `05` and `06`.** The same lock-order weakness exists in the older 0195 function
(`aie_reserve_ai_cost`), which the new code no longer calls; I left it unchanged.

## DEV (you apply; I then run the live proof)

Files are in `dev/`. Paste each into the Supabase **DEV** SQL editor (project `vqycarelcoijzwlpkpcz`) and press Run, one file at a time.

| # | File | What it does | Writes? |
|---|---|---|---|
| 1 | `01_precheck_READONLY.sql` | Every row of the first table must be `true` (0195 present, 0284 absent). | no |
| 2 | `04_apply_migration_0284.sql` | The migration. Safe to run twice. | yes: 2 columns, 1 index, 1 function |
| 3 | `05_verify_READONLY.sql` | Every row must be `true`; the second table shows ceilings 10 and 1. | no |
| 4 | `06_functional_probe_rolls_back.sql` | **The wanted result is an error whose text starts with `PROBE OK`.** It rolls itself back. | no (rolled back) |
| 5 | tell me "DEV applied" | I run `scripts/aie_user_cap_live_dev_check.ts` (parallel requests, rollover, anon refusal, then `--real` with gpt-4o-mini). It borrows two EXISTING `@fhip-test.invalid` fixture users, creates no user, types no password, prints no secret. | DEV probe rows (deleted afterwards) and one real fraction-of-a-cent call |

`08_optional_rollback.sql` removes the new objects again (redeploy the previous build first). `07_monitor_per_user_spend_READONLY.sql` shows who is near the cap today.

## PRODUCTION (production has NO managed backups: the table copies in step 2 are your restore point)

Files are in `production/`. Confirm the address bar is **not** the DEV project before each paste.

| # | File | What it does | Writes? |
|---|---|---|---|
| 1 | `01_precheck_READONLY.sql` | All `true`. Note `remaining_usd`, `unsettled_reservations`, `attempt_table_size`. | no |
| 2 | `02_manual_backup_before_apply.sql` | Copies `aie_ai_cost_attempt` and `aie_ai_cost_ledger` to the private schema (row level security on, API privileges revoked) and compares counts: every `ok` true. | copies only |
| 3 | `04_apply_migration_0284.sql` | The migration. Additive: no existing column, constraint, policy or function is changed or dropped. | yes |
| 4 | `05_verify_READONLY.sql` | All `true`. | no |
| 5 | `06_functional_probe_rolls_back.sql` | Wanted: an error starting `PROBE OK`. Nothing is kept. | no (rolled back) |
| 6 | **Push** (below), wait for Amplify to show Deployed for the commit you pushed | | |
| 7 | Try one real AI reading as a Premium user, then `07_monitor_per_user_spend_READONLY.sql` | The user appears with a small `counted_usd_today`. | no |
| 8 | When stable, `09_drop_backups.sql` | Removes the copies (the database is over its plan size, so do not keep them forever). | drops copies |

`10_change_the_cap_later.sql` is how you change the limit when you decide to: one `update`, no deploy.
`AIE_USER_DAILY_COST_CAP_USD` (optional Amplify variable, already forwarded by the `AIE_` prefix) can only **lower** the stored cap. Leave it unset.

## Rollback

- Code: redeploy the previous Amplify build. The old code calls the old function, which still exists. No SQL needed.
- Database: `08_optional_rollback.sql`, only after the previous build is live, and only if you want the objects gone (it discards which user each past reservation belonged to; take step 2 first on production).

## Push (PowerShell, two separate lines)

The exact line with the verified commit id is at the end of the final report. Never push before steps 1 to 5 of PRODUCTION are green.

## What is not claimed

Nothing here is DEV-verified or PRODUCTION-verified until you have run the files and I (DEV) or you (production) have pasted the results back.
Evidence labels and the test list: `02_TEST_AND_EVIDENCE.md`. Design, numbers and limits: `01_DESIGN_NUMBERS_AND_LIMITS.md`.
Admin Architecture Standard: no Admin surface, navigation, role, capability, RLS read or export is touched, so it is not triggered.
