# Staff admin Premium: your hand-over pack (DEV first)

Branch `feat/admin-users-premium-20261016`. Nothing in this pack has been applied anywhere. Nothing is pushed. Dates in this pack are written day first.

**What this changes for people using the app.** Accounts that hold a Super Admin row or an active Resource Administrator or Editor role get Premium as consumers, automatically, with no end date. Premium here is a real record in the same table as every other Premium (`user_entitlements`), labelled `staff_admin`. It starts when the role is given and ends when the last staff role is removed. It is not a paid subscription, it is not a grant or a promo, and it never counts against the grant limits (365 days, 5 extensions, 10 per person) or the promo limits. Nobody else is affected.

**Why the order below.** The new database objects only ADD things; the website that is live today keeps working if you apply them first (old pages show a staff person as plain "Premium"). Nothing is changed for any existing account until you run the backfill (step 6), and you read the exact list of accounts first (steps 1 and 4).

## 0. Which project am I on?

Every Supabase page shows the project in its address. DEV is `.../dashboard/project/vqycarelcoijzwlpkpcz`. **Production is `.../dashboard/project/twwpnltizhtjxhamyoxt`. This README is for DEV. Do not open any file of this pack on the production project until you have read `PRODUCTION_RUNBOOK.md`.**

## 1. How to run a file

1. Open the file in Notepad (or VS Code). Press Ctrl+A, then Ctrl+C.
2. In Supabase open **SQL Editor**, choose **New query**, press Ctrl+V, press **Run**.
3. Check files (`checks/`) and previews show a table. On a check, the last column `ok` must say `true` on every row.
4. If the editor shows a red error: copy the error text and send it to me. Do not run anything else. Every file in this pack is safe to run again, except `B1` (see below), which refuses on purpose.

## 2. DEV steps, in this order

| Step | Run this | What you should see |
|---|---|---|
| 1 | `checks/D1_preview_before_migration_READONLY.sql` (read only) | Section A: every `ok` is `true`. Section B: the list of staff accounts (e-mail shown as two letters and the domain only) and what would happen to each. Section C: people with another active Resources role, who stay as they are. **Send me the table.** If any Section A row is not `true`, STOP. |
| 2 | `supabase/migrations/0283_staff_admin_premium.sql`, as its three parts `parts/0283a.sql`, `0283b.sql`, `0283c.sql`, in letter order | "Success. No rows returned" for each part. Joined, the parts are exactly the migration file (a test proves it). |
| 3 | `checks/V0283_after_migration.sql` (read only) | 15 rows, every `ok` `true`. Row 15 (staff entitlements so far) says `0`: correct, nothing is backfilled yet. |
| 4 | `backfill/B2_preview_READONLY.sql` (read only) | The same list as step 1, in the database's own words. Read the `planned` column: `start`, `start_replacing_admin_grant`, `start_replacing_promo_code`, `keep_paid`. **If it names anyone who should not get Premium, stop and tell me.** |
| 5 | `backfill/B1_backup_user_entitlements.sql` | One row, `ok` `true`. A private copy of the table (no website user can read it). If you run it twice it says "already exists": that is correct, do not drop the copy to run it again. |
| 6 | `backfill/B3_run_backfill.sql` | Each staff account shows `started` (or `kept_paid`). Running it again shows `kept`: nothing changes. |
| 7 | `checks/V_after_backfill.sql`, then `checks/V_compare_with_backup.sql` (both read only) | every `ok` `true`. |

After step 7 tell me **"applied on DEV"**. Then I (or the DEV proof session) check on DEV, with an existing DEV fixture account and no password typed by anyone: a Super Admin sees "Premium (included with your FHIP staff account)" on their Profile billing page; a Premium-only feature works for them; giving an existing fixture user an editor role makes them Premium and removing it ends it. I will restore any fixture I touch.

## 3. What stays the same

- The Premium checks in the app (statement import, AI-assisted reading, report export) still read only the Premium record. They do not look at roles. A test fails if anyone ever adds that.
- Nobody gets any new Admin capability. Staff Premium is viewed in **Admin, Premium Access, "Staff Premium (automatic)"** with the existing `can_manage_premium_entitlements` capability, and cannot be granted, extended or revoked there.
- The grant limits and the promo rules are untouched. The override capability is still held by nobody.

## 4. Who counts as staff (decision D1, decided by the PO on 16-10-2026)

An account is staff while it has a row in `admin_users` (Super Admin), or an ACTIVE row in `resource_user_roles` for `resource_admin` (Resource Administrator) or `editor`. Author, Compliance Reviewer, Publisher and Analyst open the Admin area but do **not** get Staff Premium. The preview in step 1 lists them in Section C so you can see who is deliberately left out.

It is one function (`is_staff_premium_account`) with one matching list in the application (`STAFF_PREMIUM_RESOURCE_ROLES`). **To add a role later** (or to remove one), change both lists in a new migration, then run `select * from public.staff_premium_reconcile(true)` first: it is read only and shows `start` for everyone who would gain Staff Premium and `end` for everyone who would lose it (an account that no longer qualifies is returned to Free). Then run `select * from public.staff_premium_reconcile(false)`.

## 5. If something goes wrong

- A migration part fails: stop, send me the message. Every part can be run again.
- You want the DATA back as it was (before the backfill): run `rollback/R1_restore_from_backup.sql`. It switches the three triggers off, puts every staff row back to exactly the values in the B1 copy (a replaced admin grant or promo returns as it was) and returns any staff row made after B1 to Free. Rows that are not staff rows are never touched. The check at its end must say `ok` `true`.
- You want the feature OFF but the structure kept: R1, and leave the triggers off. To switch it back on: `rollback/R3_switch_triggers_on.sql`, then steps 4 to 7.
- You want the structure gone as well: after R1 run `rollback/R2_undo_0283.sql`. It refuses while any staff row exists. It restores the earlier rule that only allowed payment, admin grant and promo code.
- The application only: redeploy the previous Amplify build. This is safe at any point: the old site shows a staff person as plain Premium and never writes the staff value.
- The B1 copy is the only restore point on production (there are no managed backups). Keep it until the PO is satisfied, then drop it: `drop table private.bk_user_entitlements_before_staff_premium`.

## 6. Files in this folder

| Path | What it is |
|---|---|
| `parts/` | the migration in three pieces (source of truth; joined they are byte for byte `supabase/migrations/0283_staff_admin_premium.sql`) |
| `checks/` | `D1` (before the migration), `V0283` (after it), `V_after_backfill`, `V_compare_with_backup`, `V_compare_list_changed_ids` |
| `backfill/` | `B1` backup, `B2` preview, `B3` backfill |
| `rollback/` | `R1` data, `R2` structure, `R3` triggers back on |
| `PRODUCTION_RUNBOOK.md` | the production order |
