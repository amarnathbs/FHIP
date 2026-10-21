# WP-G (Document2 (4) F15, PO-D24-03): PO-run pack for the background bank-statement import

Nothing in this pack was run by the agent. DEV first, then production. Nothing here shows a statement line, an amount, a description or a file name. No secret is written in any file.

## Why this exists

The Expenses bank-statement import ran the whole reading inside one web request. The platform ends a request after about 28 seconds, so a long statement (above all a real bank PDF read by the AI) failed with "We could not process this bank statement". The import is now a **background job** cut into short slices. Two new tables hold its state; one index makes "a statement never holds the same line twice" a database rule.

## Order (both environments: DEV first, then production after the app version is deployed there)

| Step | File | What it does | Changes data? |
|---|---|---|---|
| 1 | `01_READ_ONLY_before_apply.sql` | Shows the new objects are absent and that what they build on exists; lists statements stuck in processing | No |
| 2 | `02_APPLY_0310_bank_import_jobs.sql` | Creates the two job tables (row-level security on, a browser can only READ its own jobs, staging is server-only), the three lease functions (server role only), cross-tenant guards. Additive: no existing table, column, constraint or policy changes | New empty tables only |
| 3 | `03_APPLY_0311_unique_source_row_index.sql` | Creates the unique index on a statement's line numbers, but ONLY if no statement already has a duplicate (otherwise it says so and skips; the job still works) | Adds one index |
| 4 | `04_READ_ONLY_verify_after_apply.sql` | Confirms RLS, the single SELECT policy, who may run the lease functions, the index | No |
| 5 | `05_SCHEDULE_backstop_every_minute.sql` | **Production only, after the app is deployed.** Registers the once-a-minute backstop that finishes jobs nobody is watching. Same pg_cron + pg_net + Vault mechanism as the purge and malware sweeps | Adds a scheduler job |
| 6 | `06_ROLLBACK_if_needed.sql` | Removes everything above (job state only; no customer record) | Drops the job objects |
| 7 | `07_READ_ONLY_watch_the_jobs.sql` | After deployment: jobs by state, stuck jobs, failed jobs by reason, leftover staging, old-style stuck statements | No |

No manual table backup is needed for steps 2 and 3 (they add empty tables and one index and change no row). Take the usual backup of `fdh_transactions` and `fdh_statement_uploads` before step 3 on production only if you want one before any index build; the table is small.

## What you must configure (and nothing else)

1. **Apply 0310 and 0311 on DEV, then tell the agent.** The DEV certification run (`scripts/doc2_4_wp_g_dev_run.ts`) could not be performed because DEV does not have the tables and no agent has a way to run DDL on DEV. It is ready to run the moment step 2 is done.
2. **Production, after the Amplify deployment of this branch is confirmed:** steps 1 to 4 on production, then step 5. Step 5 needs the existing `CRON_SECRET` value to be in the Vault under the name in the file (the purge sweep already uses `lr1_purge_sweep_cron_secret`; if that is not the name on your project, create one and change the name in the file). The app itself needs **no new environment variable** and no Amplify setting: `CRON_SECRET` is already forwarded by `amplify.yml`.
3. Nothing to configure in AWS (no queue, no Lambda, no EventBridge). If you prefer EventBridge to pg_cron, the console steps in `DEPLOYMENT.md` section 6 apply unchanged to the URL `/api/financial-data-hub/bank-import-jobs/cron/advance` (POST, header `x-cron-secret`). Use one scheduler, not both.

## What happens if you skip step 5

The import still works while the person has the page open (the page drives the job). A person who closes the page mid-import finds the job where it stopped when they open the Expenses import again. A job nobody opens again is ended by the existing 50-minute raw-file safety backstop (the statement is rejected and the file deleted; the person uploads again). The scheduled backstop removes that last case.

## If the tables are not there yet

The process routes answer 503 "Background statement import is not available in this environment yet" instead of failing with SQL. The old synchronous reading is gone from the routes, so **do not deploy this branch to production before step 2 has been applied there.**
