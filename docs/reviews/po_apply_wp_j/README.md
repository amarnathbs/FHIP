# WP-J PO-run SQL pack: statement processing as a background job (Document2 (4))

Nothing here has been run on DEV or production by an agent. DEV is project `vqycarelcoijzwlpkpcz`, production is `twwpnltizhtjxhamyoxt`. Run each file in the Supabase SQL editor, one block at a time where the file says so. Always DEV first.

## Order (release order: SQL first, then code, then schedule)

| Step | File | What it does | Changes data |
|---|---|---|---|
| 1 | `01_READ_ONLY_before_apply.sql` | what exists today, runs still marked running, statements by status | no |
| 2 | `02_APPLY_0312_parse_run_counters_columns_only.sql` | the three counter columns of `ii_document_parse_runs`, columns only, `add column if not exists` | no row changes (new columns default to 0). On production the columns were already added by hand on 22-10-2026: this is then a no-op |
| 3 | `03_APPLY_0313_statement_jobs.sql` | the two job tables and three lease functions | no row changes (new empty tables) |
| 4 | `04_READ_ONLY_verify_after_apply.sql` | proves the shape: columns, row level security, one policy, functions server-only, indexes | no |
| 5 | deploy the code (push to main, confirm the Amplify build) | | |
| 6 | `05_SCHEDULE_backstop_every_minute.sql` | ONE scheduler (pg_cron + pg_net + Vault CRON_SECRET) | registers a schedule. Production only, after the deploy. DEV has no public app origin |
| 7 | `07_READ_ONLY_watch_the_jobs.sql` | watch states, stuck jobs, running runs, staging | no |

Optional: `08_OPTIONAL_close_the_old_stuck_runs.sql` closes the three old production runs that stayed `running` (needs step 3 applied). It saves exactly those rows first (production has no managed backups) and `09_UNDO_close_the_old_stuck_runs.sql` puts them back. You do not have to run it: the new code closes a dead run on its own the next time the statement is processed, and the backstop sweeps them.

Rollback: `06_ROLLBACK_if_needed.sql` removes the schedule and the job objects (0313 only). 0312 is never rolled back (the columns are harmless).

## Why the order matters

- Deploy the code **after** 02 and 03. Until 03 is applied the process route simply behaves as it did before this change (one request), so a deployment that runs ahead of the database does not break uploads, but a large statement then still times out.
- Do **not** run 0159 itself on production: its first half rewrites a CHECK constraint with an older list of values. 0312 is the columns-only statement and is exactly idempotent.
- The schedule (step 6) is optional but recommended: without it a job advances only while the page is open.

## Production notes

- No manual table backup is needed for 02 and 03 (a column add with defaults and two new empty tables). 08 is the only data change and takes its own backup.
- The word list the SQL editor mishandles (the words into, from and join followed by a word, inside a comment or a string) is not used anywhere in these files; a test enforces it.
