# Staff admin Premium: production runbook

**Only after the DEV steps in `README.md` are finished and the DEV checks were all `true`.** Production is `.../dashboard/project/twwpnltizhtjxhamyoxt`. Production has **no managed backups** (Free plan), so the B1 copy is the only restore point. The database is already above its free size limit; the copy adds one row per account (a few hundred rows), which is negligible.

## Order

| Step | Who | Run this | Expected | If it fails |
|---|---|---|---|---|
| P0 | you | Confirm that the earlier promo hardening migrations (0264 to 0268) are applied on production, or consciously that they are not: this pack needs only 0231 and 0237, and D1 section A tells you. | D1 section A all `true` | A `false` in section A: stop, send me the table. Nothing was changed. |
| P1 | you | `checks/D1_preview_before_migration_READONLY.sql` | Section A all `true`. Section B is the list of staff accounts. | Send me the table before anything else. |
| P2 | you | Read Section B. Decision D1: is every account in it supposed to get Premium? | yes / narrow it (see README section 4) | Do not continue until you are happy with the list. |
| P3 | you | `supabase/migrations/0283_staff_admin_premium.sql` as parts `0283a`, `0283b`, `0283c` | success for each | Stop and send me the message. Each part can be run again. The migration changes no row. |
| P4 | you | `checks/V0283_after_migration.sql` | 15 rows, all `true`, row 15 is `0` | Stop, send me the table. |
| P5 | you | Push the application (see the push lines in my report) and wait for the Amplify build to be **Deployed**. | build Deployed | Redeploy the previous build. The database objects do no harm to the old site. |
| P6 | you | `backfill/B2_preview_READONLY.sql` | the same accounts as P1 | If it differs from P1, send me both. |
| P7 | you | `backfill/B1_backup_user_entitlements.sql` | one row, `ok` `true`, equal counts | Do not run P8 without it. |
| P8 | you | `backfill/B3_run_backfill.sql` | `started` for each account (or `kept_paid`) | Stop. Run `rollback/R1_restore_from_backup.sql`, send me the error. |
| P9 | you | `checks/V_after_backfill.sql`, then `checks/V_compare_with_backup.sql` | all `true` | If V_compare row 3 is not `0`, run `checks/V_compare_list_changed_ids.sql` and send me the table: it normally means a customer paid or cancelled between P7 and P9. |
| P10 | you | Sign in as yourself on production and open Profile, billing: the plan says "Premium (included with your FHIP staff account)". Open Admin, Premium Access: your account is under "Staff Premium (automatic)". | as described | Send me a screenshot. |

## Behaviour to know

- **New staff after this day.** Assigning a Super Admin row or a Resources role (Admin screen, the service role, or a statement in the SQL editor) creates the entitlement by itself in the same moment. Removing the last staff role ends it. This cannot be bypassed.
- **A staff person who pays.** A live paid subscription wins and is untouched. If it ends, Staff Premium takes over again at once.
- **A staff person with a promo or admin grant.** Staff Premium replaces it (it is a superset: no end date). If they later leave staff they return to Free; the old grant is not restored. The preview names these accounts (`start_replacing_...`) so there are no surprises.
- **Emergency off switch** (stops new and repaired staff entitlements without removing data): `rollback/R1_restore_from_backup.sql` if you want the data back, or only `alter table public.user_entitlements disable trigger trg_staff_premium_guard` plus the two role triggers (`R3` re-enables them).
- **Cost.** Premium AI-assisted reading is chargeable per use. Staff are subject to the same monthly question allowance, rate limits and the platform spend cap as any Premium customer.
