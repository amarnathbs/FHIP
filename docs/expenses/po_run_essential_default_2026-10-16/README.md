# Necessities are Essential - production back-fill for your account (16-10-2026)

Decision: new expense rows for the necessities start ticked **Essential** (you can untick). The code does that from migration-free
catalogue data (`ESSENTIAL_DEFAULT_EXPENSE_KEYS` in `lib/engines/dashboard.ts`). Rows that already exist are NOT rewritten by
the code. These files back-fill YOUR existing rows only, conservatively. Run each file on its own, in order, in the production SQL editor.

**Does the app record whether you chose Essential on purpose? No.** There is only the true/false flag and the created and last-edited
times. So the back-fill uses the only evidence available: a row is changed only when it is a manual row, Essential is off, and it
has never been edited since it was created (last-edited within 10 seconds of created). A row edited later is left alone, and listed
so you can tick it on the Expenses page yourself if you want. Step 1 shows every candidate by id before anything is written.

The necessity items: rent, mortgage, council rates, water rates, water, electricity, gas, groceries, health insurance, medical,
pharmacy, fuel, public transport, home insurance, body corporate, internet.

| Step | File | Writes? |
|---|---|---|
| 1 | `20_essential_preview.sql` | No. Lists your necessity rows, whether each would change, and why. |
| 2 | `21_essential_backup.sql` | Creates ONE backup table with a copy of the rows that would change (production has no managed backups). |
| 3 | `22_essential_apply.sql` | Sets Essential on exactly the backed-up rows that are still untouched. Safe to run twice. |
| 4 | `23_essential_verify.sql` | No. Essential and discretionary totals and emergency-fund months. Then regenerate the report. |
| 5 | `24_essential_rollback.sql` | Only if you want it undone. |
| - | `25_essential_prevalence_all_users.sql` | No. Counts only, to size a possible back-fill for other households (a separate decision). |

## What you should see for your household

If all ten of your necessity rows are untouched candidates: essential expenses 2,804.66 a month (was 0), discretionary 1,730.64
(was 4,535.30), emergency-fund months about 7.8 (was "Not available"). Net income, surplus or deficit, savings rate and the
debt-service ratio do not change; the Emergency Fund and Liquidity pillar, the resilience core-survival months and the Financial
DNA and Twin essential or discretionary ratios do.

Without SQL you can tick Essential on each row on the Expenses page.
