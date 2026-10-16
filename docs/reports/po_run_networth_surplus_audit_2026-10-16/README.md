# Monthly Report net worth and surplus audit - PO production queries (16-10-2026)

Part 1 (files 01-06) is READ ONLY and you have already run it. Part 2 (files 10-16) repairs and measures the salary record.
Run each file on its own in the Supabase SQL editor of the PRODUCTION project, one statement at a time. Output carries record
ids, names you see on the screens, amounts and groups only, never an email or an address.

## Part 1 - what the first results showed (already run)

| File | Result |
|---|---|
| `02_cashflow_reproduction.sql` | 19,782 gross / 3,574 net / 4,535 discretionary / 8,362 debt / -9,324. Matches the report. No blank take-home. |
| `01_income_records.sql` | The Employment Salary record (payslip import, `annually`) has gross 196,994.48 a year but net 3,975.43: the net of ONE fortnightly payslip. |
| `05_networth_reproduction.sql`, `04_asset_and_liability_records.sql` | Net worth reconciles exactly. The 565,000 Investment Property sits in the investments register as property. |
| `06_imported_not_in_net_worth.sql` | 17 imported INR fund holdings (statement dated 04/09/2026), about 14,406, not yet added to Net Worth (rule D-05). |

The first reading of the report (a blank take-home on the salary) was wrong for this household: the cause is a record whose gross
and take-home are on different pay periods.

## Part 2 - repair the salary record (do the steps in order)

You confirmed: pay is FORTNIGHTLY and 3,975.43 is the take-home of ONE payslip, so the take-home for the year is
3,975.43 x 26 = 103,361.18 (8,613.43 a month). Expected report afterwards: net income about 11,856 a month and a deficit of about
1,041 a month instead of 9,324.

| Step | File | Writes? |
|---|---|---|
| 1 | `10_repair_preview.sql` | No. Shows the record, which fields the last payslip apply wrote, and the payslip. Every `ok_` column must say yes. |
| 2 | `11_repair_backup.sql` | Creates ONE backup table with a copy of the row (production has no managed backups). |
| 3 | `12_repair_apply.sql` | Changes ONE value in ONE row (net_amount 3,975.43 to 103,361.18). Only fires when the row still holds the confirmed values; running it twice changes nothing. |
| 4 | `13_repair_verify.sql` | No. Net income and surplus rebuilt from the four income records. Then regenerate the report. |
| 5 | `14_repair_rollback.sql` | Only if you want it undone: restores the saved value. |

The same repair without SQL: open the Income page, edit Employment Salary and set **Net Amount (take-home pay)** to 103,361.18
(frequency stays annually). The new **Tax per period** box is an alternative once migration 0285 is applied: enter the tax for a
whole year because this record is annual.

## Part 3 - how many other records look like this (read only, counts only)

| File | Answers |
|---|---|
| `15_prevalence_net_to_gross.sql` | Wage records by take-home share of gross (under 10%, 10-30%, plausible, over 100%) and how many have a blank take-home. |
| `16_prevalence_payslip_frequency_mismatch.sql` | Records written by a payslip apply whose frequency differs from the payslip's pay frequency. |

If a query reports a missing column, send the exact error text.
