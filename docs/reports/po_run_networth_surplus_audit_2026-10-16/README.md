# Monthly Report net worth and surplus audit - PO production queries (16-10-2026)

All six files are READ ONLY (line 1 says so). They change nothing. Run each one on its own in the Supabase SQL editor of the
PRODUCTION project, one statement at a time, and send back the result grid (copy as text or screenshot). Output carries record
ids, the names you see on the screens, amounts and groups only. No email, no address, no document content.

Every file looks the user up from the sign-in email inside the query, so nothing needs editing.

| Order | File | What it answers |
|---|---|---|
| 1 | `02_cashflow_reproduction.sql` | One row. Rebuilds gross income, net income, deductions, expenses, debt and the deficit from the raw records. Compare with the report: 19,782 / 3,574 / 0 / 4,535 / 8,362 / -9,324. |
| 2 | `01_income_records.sql` | Every income record: gross, take-home, frequency, currency, manual or imported, and `net_known` / `counted_in_report`. Shows which record causes the gap between gross and net. |
| 3 | `03_expense_and_debt_records.sql` | Every expense and loan repayment behind the 12,897 monthly outflow. |
| 4 | `05_networth_reproduction.sql` | One row. Rebuilds assets by register (Property cash and other / Investments / Retirement), liabilities, net worth and the wealth-chart groups. Compare with 1,670,298 / 590,000 / 636,000 / 1,385,857 / 1,510,441 and chart 1,960,000 / 21,798 / 25,000 / 636,000 / 253,500. |
| 5 | `04_asset_and_liability_records.sql` | Every asset, investment, retirement and loan record with its register and chart group. Look for one real property recorded twice (assets and investments). |
| 6 | `06_imported_not_in_net_worth.sql` | The 17 imported holdings worth 14,406 that the report lists as not in net worth. |

## How to read the first result

- `income_sources_with_blank_take_home` above 0: those sources are in gross income but their take-home pay was never entered, so
  they are left out of net income (rule GAP-09, kept on purpose: a missing take-home is never replaced by the gross). The gap
  `deductions_gross_less_net_known` is then mostly not tax. Enter the take-home pay on the Income page and the net income, the
  deficit, the savings rate, the debt-service ratio and the Cash Flow and Debt pillar scores all move together.
- `surplus_or_deficit_if_all_gross_were_take_home` is the best case if nothing were taken out. Reality sits between the two.
- `essential_expenses` 0 means no expense row is marked essential. That is why the report shows essential expenses 0 and the
  emergency-fund months as not available.

## Why the report still shows 17 imported items as "not in net worth"

Rule D-05 (PO decision): a holding read from an uploaded statement is shown on the Investments tab as "Imported, not yet in Net
Worth" and is added to net worth only when you choose "Add to Net Worth". File 6 lists them. If you want them counted, add them
there; the report then moves them from the disclosure line into Investments.

If a query reports a missing column, send the exact error text and nothing else is needed.
