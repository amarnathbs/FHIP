# WP-D step 2: apply migration 0304 on DEV

1. Open the DEV Supabase SQL editor (project vqycarelcoijzwlpkpcz). Confirm the reference in the address bar.
2. Run `01_readonly_checks_dev.sql` first. Expected: table_already_present = false, every ok column true.
3. Paste and run the whole file `supabase/migrations/0304_retirement_contributions.sql` from this branch. It is additive and safe to run twice. It changes no existing row.
4. Run `03_verify_dev.sql`. Expected results are in its comments.
5. Then, on the DEV app (a build of this branch against DEV), the walk-through in the report section "What the PO checks on DEV".

No backup is needed on DEV for step 3 (nothing existing is touched). When recording contributions on an account the app rewrites that account's two contribution columns from the history; if you want to be able to undo that on DEV, run `04_backup_before_testing.sql` first.
