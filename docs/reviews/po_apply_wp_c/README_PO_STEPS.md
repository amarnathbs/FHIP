# WP-C: what the PO runs, in order (DEV first, backup first, read only first)

Nothing here has been run by the agent. No DEV access was used to apply anything and there was no production access.

Migrations 0289 and 0290 (entity phase 1) are applied first, from the entity phase 1 pack. They are not changed by this work.

## On DEV (project vqycarelcoijzwlpkpcz)

1. `00_readonly_checks.sql` in the Supabase SQL editor. Read only. Keep the output: it counts the legacy shapes (SMSF rows still in your personal pages, an entity holding both a typed net and lines, a property still tied to a personal income record).
2. `01_backup.sql`. Copies the tables the migrations sit next to into `backup_wpc_20261021_*` (row level security on, no policy). Safe to run twice.
3. Paste each migration file whole, in this order, and run it:
   - `supabase/migrations/0295_smsf_liability_canonical_fields_and_property_link.sql`
   - `supabase/migrations/0296_entity_income_expenses_and_change_log.sql`
   - `supabase/migrations/0297_business_entity_itemised_or_net_rule_and_line_detail.sql`

   They only add columns, tables and triggers, and they change no existing row. Each passes the editor safety lint used for the entity phase 1 files.
4. `03_verify_after.sql`. Every row must say `ok = true` (13 rows).
5. Deploy the code only after step 4 (the code reads `is_active` on the two entity line tables that 0297 adds).

## What to try on DEV with a test account (no password is ever typed for you)

| Finding | Try |
|---|---|
| F19, F20 | An itemised SMSF: its net is worked out, there is no second balance, the report and the CSV show one net and no Difference. A fund note written by a migration is not shown. |
| F21 | SMSF > Liabilities > Add: the form has lender, rate, rate type, fixed rate end, repayment, last 4 digits, due date and the property it funds. Nothing sends you to the personal Liabilities page. Personal Liabilities: the Owner list has no SMSF and the SMSF property loan item is not offered. |
| F22 | SMSF > Income and expenses > Add income > Rent: it asks for the amount and how often it is paid. A second rent for the same property is refused. |
| F23 | SMSF > Add expense. A loan repayment is not an expense type. SMSF > Bank statements > Upload (Premium): the owner is fixed to the fund. Approved lines appear under the SMSF report as actuals and never in your Expenses. |
| F23b | Companies, Trusts and HUF page: add an entity, record it itemised (assets and liabilities, net derived) or as a net value only, switch with the preview, add income and expenses, open the history. HUF only for an India account. |
| F28 | Dashboard > Net Worth: each entity row shows its own assets, liabilities and net economic value, then what is counted (Trust and HUF in full, Company by share). |

## Production (project twwpnltizhtjxhamyoxt), only after the DEV pass

Same four steps (00, 01, the three migrations, 03), then push main yourself. Production has no managed backups: do not skip step 2. Production document uploads stay gated by the malware and readiness programme: the SMSF bank statement entry reuses the same upload switches and does not enable anything by itself.

`90_rollback_notes.md` says how each migration is undone if it ever has to be.
