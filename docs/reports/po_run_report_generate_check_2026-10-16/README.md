# Generate report: read-only checks for the Product Owner (16-10-2026)

Nothing here changes anything. No SQL has been applied anywhere by the developer.

## 1. Browser check (about 2 minutes), no SQL

1. Open production `/reports`. Press F12, open the **Network** tab, tick **Preserve log**.
2. Press **Generate report**.
3. In the list, click the request named `generate` (method POST). Read three things:
   - **Status**: `200` = the server answered; `202` = "still being prepared"; `502`/`503`/`504` = the platform cut the request.
   - **Time**: about 28 s with 502/504 means the platform timeout. About 1 s with 200 means the report was NOT slow, it was saved incompletely (the case seen on 16-10-2026).
   - **Response** tab: before this fix it showed the whole report (several MB). Empty means a cut-off.
4. After the page opens the report, click the request ending `/exports` if you pressed Export PDF. Open **Response**: the words after `"error"` and `"detail"` say why the PDF failed. Please send that line (it contains no personal data).
5. Open the **Console** tab and send the first red line.

## 2. SQL in the production SQL editor (read only; run each statement on its own)

| File | Answers |
| --- | --- |
| `01_the_report_0b9a5749.sql` | Is report `0b9a5749-64a5-4268-9f00-c55228424836` complete? Statement 2 returns one row per saved section; **no rows = an empty shell**. |
| `02_all_versions_and_runs_for_this_user.sql` | Every report version (with section count and stored bytes), every generation attempt with its duration and outcome, and the export attempts. |
| `03_price_history_rows_per_held_fund.sql` | How many price-history rows each held fund has (the report reads all of them twice). |

How to read the results

- A `ready` report with `section_count` 0 is the empty-shell defect. After this fix, pressing **Generate report** rebuilds it as the next version and keeps the empty one in the history.
- A run whose `output_status` is `started`, with no `completed_at`, and a start time more than a couple of minutes old, was cut off.
- A run with `seconds` close to 28 and `failed` or `started` supports the timeout theory; `seconds` of 1 to 3 with `succeeded` and no sections supports the incomplete-save theory.

## 3. Operational switches (only if ever needed; both are environment variables)

- `REPORT_GENERATE_DEADLINE_MS` (default 22000, allowed 1000 to 26000): how long the generate route works before it answers "still being prepared".
- `REPORT_REQUEST_MEMO=off`: turns the per-request sharing of the dashboard/snapshot reads off (restores the old behaviour exactly).
- `REPORT_NAV_SHARED_READ=off`: restores the previous price-history read (one ordered query per loader). Same figures either way.
