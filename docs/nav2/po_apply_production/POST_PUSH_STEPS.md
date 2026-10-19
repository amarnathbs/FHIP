# NAV2 after the push: the Product Owner's numbered steps (production)

Written 18-10-2026. State at writing: every production migration is applied and `C_final_all.sql` was all true (twelve tables, seventeen functions, eight policies, four switches all OFF, nobody holds the new permissions, two series enabled, no rates loaded, no reports). This file is the short form of README sections 4 to 8. If the two disagree, the README wins. Nothing here is DEV evidence; every figure you paste back is the evidence.

Rules that stay: the address bar of the Supabase dashboard must contain `twwpnltizhtjxhamyoxt` for every SQL step. Never paste an e-mail address, key or password back to me. If a step differs from what it says, stop and send me what you saw.

## Step 3. Push (README section 4)

1. `git fetch origin`
2. Check the release commit descends from main (no output and exit code 0 means yes): `git merge-base --is-ancestor origin/main <RELEASE_SHA>`
3. `git push origin <RELEASE_SHA>:main` (plain fast-forward, never force). The exact two lines with the real SHA are in my report.
4. Wait until Amplify shows Deployed. If the build fails, nothing from it is live and the database changes are harmless with the old code.

## Step 4. Smoke tests with every NAV2 switch OFF (browser)

Three people, in this order. Paste back "A ok, B ok, C ok, D ok" or what differed.

A. Ordinary FREE user (a test account or a free person who agrees):
1. Reports menu shows Monthly Report, Net Worth Statement, Financial Activity, Consolidated Report, Forecast Variance. There is NO "Fund Analytics" entry.
2. Dashboard and the Monthly Report open as before.
3. Type `/reports/fund-analytics` in the address bar: a plain sentence that the report is for Premium people. Not an error page.

B. PREMIUM user (a Premium account that is not the administrator when you have one; otherwise your own Premium account):
1. Still NO "Fund Analytics" entry (the switch is OFF).
2. `/reports/fund-analytics` says the report is not available yet. Not an error page.
3. Monthly Report, Premium export and the rest work as before.

C. ADMINISTRATOR (you):
1. Admin menu: the item "Risk-free Rate Data" (in group "Market Data") is NOT shown yet (it needs the upload permission, step 5). "Reference Data" has a new entry "Fund Analytics Health".
2. Open "Fund Analytics Health": it loads with figures (price row counts are estimates and say so). No error banner.

D. One user who holds Indian funds: open the Monthly Report and one Investment Intelligence page. Unchanged. (A statement whose ISIN and AMFI code point at two different funds now opens a "needs your decision" item instead of picking the ISIN. If you see one, that is this rule.)

## Step 5. Permissions with ONE administrator (logical segregation, not dual control)

You are the only administrator, so you cannot give the two permissions to two different people. What you can do is never hold both at the same time. Do not describe it as dual control: there is no second person, no re-authentication for a switch and no preview of what a switch changes (`docs/nav2/CAPABILITY_SEGREGATION.md`). What stays in force even with one person: separate permissions, a written reason of 20 characters or more on every state change, an unchangeable audit trail, and a preview before any data is written.

The order, each file in `sql/grants/`:
1. Open `grant_upload.sql`, replace `REPLACE-WITH-UPLOADER-EMAIL` with your own sign-in address (keep the quotes), run it. Expect "Success. No rows returned".
2. Run `check_grants.sql`. Expect `uploaders` 1, `switchers` 0, `holders_of_both` 0. Paste the row back.
3. Do step 6 (load the data) now.
4. When the load is checked, run `revoke_upload.sql` (same address replaced). Run `check_grants.sql` again: `uploaders` 0, `switchers` 0.
5. Only later, if you ever need to switch a risk-free series off: run `grant_switch.sql` (address replaced), do the switch on the Admin screen with a reason of 20 characters or more, then run `revoke_switch.sql`. Do not grant the switch permission while the upload permission is on. The two series are already enabled at seed time, so the switch permission is not needed for the first load or the pilot.

## Step 6. Load the two RBI files through the Admin screen

Needs step 3 (push, deployed) and step 5, item 1 (upload permission). Sign in as yourself, open Admin, group "Market Data", **Risk-free Rate Data** (`/admin/investment-intelligence/risk-free-data`). The files are in the repository clone on your machine under `docs/nav2/risk_free_first_load/`:

| # | Series | File | Preview must show |
|---|---|---|---|
| 1 | `RBI_91D_TBILL_CUTOFF_YIELD` | `docs/nav2/risk_free_first_load/RBI_91DAY_TBILL_CUTOFF_YIELD_HISTORY.csv` | 1,060 usable rows, 05-04-2006 to 30-09-2026, 1,060 to write, no conflicts, no rejected rows, two warnings (three week-on-week moves above 1.5 points, first 01-08-2007; three stretches longer than 14 days without a weekly observation). Read them, then commit. |
| 2 | `RBI_91D_TBILL_CUTOFF_YIELD` | `docs/nav2/risk_free_first_load/RBI_91DAY_TBILL_GAP_ROWS.csv` | 13 usable rows (5 `no_accepted_bids`, 8 `no_row_in_source`), no conflicts, no warnings. Commit. A gap row means no cut-off exists for that date and is never used as a rate. |
| 3 | `RBI_POLICY_REPO_RATE` | `docs/nav2/risk_free_first_load/RBI_POLICY_REPO_RATE_HISTORY.csv`, **Verified through** `02-10-2026` (type it day first) | 61 rows, 26-10-2005 to 05-12-2025. Commit. |

Each load: choose the series, choose the file, tick "This is the first load of the historical file" (loads 1 and 3), press Preview, read it, tick the attestation, press Commit. Read the attestation text first: it records your decision of 03-10-2026 on RBI's terms (attribution kept, reuse risk accepted). Provenance is in `RISK_FREE_FIRST_LOAD_PROVENANCE.md` in the same folder.

After the three commits, run these two read-only queries and paste both results back (expect 1,060 values and 13 gap rows for the T-bill series, 61 values for the repo rate, three batches):

```sql
select series_id, kind, count(*) as observations, min(observation_date) as first_date, max(observation_date) as last_date from public.ii_risk_free_observations group by series_id, kind order by series_id, kind;
```

```sql
select series_id, source_kind, rows_submitted, rows_inserted, date_from, date_to, attested from public.ii_risk_free_batches order by created_at;
```

Then step 5, item 4 (take the upload permission away).

## Step 7. Pilot: switch Fund analytics ON, with your own Premium account

Before you switch anything on, read this. Production price history is 247,534 rows; your 17 funds with history hold 77,345 of them. Your household holds 19 funds on production. A report covers at most 10 funds, so:

- Generate will answer that you hold 19 and ask you to choose. Select at most 10 funds on the page (start with a small number). A second report covers the rest.
- Expect long preparation on the first runs. The report is built in one request that has a 22 second clock. The possible answers: the report is issued (done); "prepared in steps" (HTTP 202: the work that fitted was saved in the shared cache, press Generate again and it carries on, the retry is the same request so you still get ONE report); "timed out" (HTTP 503, retryable, nothing is lost, press Generate again). A DEV run on a slow link needed 1 call for 1 and 4 funds (about 15 s each) and 2 calls for 10 funds cold (14.7 s in steps, then 22.1 s). Production has not been measured: you are the first measurement.
- If a generation keeps ending in "timed out" after four or five presses with 10 funds, stop, switch OFF (below), and send me the timings; do not keep pressing for more than a few minutes.

Steps:
1. Check the earlier steps are done and the switch is OFF: run `sql/switches/read_switches.sql`. `nav2_fund_analytics` enabled false.
2. Be present. Run `sql/switches/switch_on_fund_analytics.sql`. Expect "Success. No rows returned". The menu entry appears for Premium people only.
3. With your own Premium account, Reports, **Fund Analytics**. Time each run with a clock (from pressing Generate to the report appearing), and note every "prepared in steps" or "timed out" answer:

| Run | Funds | What to write down |
|---|---|---|
| a | 1 fund, first time (cold) | seconds, number of presses, answers seen |
| b | 1 fund again | seconds (warm) |
| c | 4 funds, first time | seconds, presses |
| d | 4 funds again | seconds |
| e | 10 funds, first time | seconds, presses, answers (202 / 503) |
| f | 10 funds again | seconds |

4. For one finished report: press "Print / Save as PDF": it opens the print view in its own tab, the print dialog opens by itself, choose "Save as PDF" as the destination (about one page per fund and one comparison page), and the tab closes itself afterwards. This is the free browser flow, the same as the Monthly Report. There is no server PDF button because Amplify has no Chromium at runtime. Open Admin, Reference Data, **Fund Analytics Health**: it must load.
5. A free account: still no menu entry, the page says Premium only.
6. Run `sql/smoke/S1_after_first_reports.sql` and `sql/monitoring/M1_pilot_health.sql`. Paste both rows and the timing table back before you invite anyone else. `duplicate_idempotency_keys` must be 0 and `widest_report` must never exceed 10.

Switch OFF at once (`sql/switches/switch_off_fund_analytics.sql`; stored reports remain) if: a report never finishes (more than ten minutes of "being prepared"), `duplicate_idempotency_keys` is above 0, or a figure is wrong against something you can check by hand. The planner, the correction worker and the weekly refresh stay OFF for the pilot (README section 9).
