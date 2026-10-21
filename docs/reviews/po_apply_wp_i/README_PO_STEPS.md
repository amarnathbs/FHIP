# WP-I PO steps (DEV first, production only after DEV is accepted)

Two additive migrations, no table, no column, no data change, so no data backup is needed. Production has no managed backups, so confirm that before any production step anyway.

- `supabase/migrations/0298_retirement_no_savings_declaration_guard.sql` (database guard for the retirement declaration, PO-D24-02)
- `supabase/migrations/0299_business_entity_undo_last_switch.sql` (Undo for the Company, Trust and HUF itemised or net value only switch)

Already applied on DEV before this pack (do not re-run): 0289, 0290, 0295, 0296, 0297, 0304. 0298 and 0299 need nothing but those.

## Steps on DEV (project vqycarelcoijzwlpkpcz, check the address bar)
1. Run `00_readonly_checks_dev.sql`. Expected: 1a all true, 1b all false. 1c is information only (existing contradictions are left as they are).
2. Paste and run `0298_...sql` from the migrations folder, then `0299_...sql`. Each is safe to run twice.
3. Run `02_verify_after_dev.sql`. Expected: every value true, two enabled triggers, authenticated true and anon false.
4. Deploy the branch to DEV (the application guard works without the SQL, the SQL makes it unbypassable).

## What to check on DEV in the application
Retirement declaration (PO-D24-02): with an active retirement account or an SMSF, try to tick "I don't have any retirement savings" (it is disabled with the reason). A direct call that tries to save it anyway is refused with a readable 409 naming what you hold. Deactivate or remove every account and the SMSF and the declaration saves.
Family retirement (PO-D24-01): Forecast > Retirement. With an SMSF, Generate forecast shows the personal forecast unchanged and, below it, "Family retirement position (Personal + SMSF)" with the Personal row, the SMSF row and the Family row. The family starting balance is personal plus the SMSF net shown on the Dashboard (not the fund account row on top), and the monthly figure is personal contributions plus SMSF contributions. Without an SMSF the card never appears.
Entity Undo: Companies and Trusts > an entity > change how it is recorded (check the effect, confirm), then "Undo the last change", read the preview and confirm. The entity returns to how it was, nothing is deleted, the history shows both lines, and only one way is counted.
Monthly Report: generate a report for a household with an SMSF, a Trust, a HUF and a Company. The entity table in the report (and its PDF) must match the Dashboard entity section cell for cell.

## Rollback
See the rollback comment at the bottom of each migration (drop the triggers and functions named there). No row is changed by either migration.
