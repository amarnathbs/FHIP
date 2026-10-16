# NAV2 (Fund Analytics) PRODUCTION hand-over

Written 07-10-2026, updated 16-10-2026 (STOP GATE 1 package: DEV-proven 0281 and 0282, manual backup step, pilot limit of 10 funds, monitoring queries) for the Product Owner. **Nothing in this folder has been run on production.** Every SQL file here was replayed on an isolated in-memory Postgres (PGlite) on top of the whole migration ledger up to 0278, in the order below, with its check, its rollback and a second run (`scripts/nav2_production_deploy_order_proof.mjs`, results in section 12). That is not production evidence: your pasted answers are.

**Do NOT push the NAV2 code before the production migrations (steps 2.1 to 2.14) are applied and all checks are true.** With the code live and migration 0281 missing, every retry after a "prepared in steps" or "timed out" answer can issue another report (DEV journey 7 without 0281: 15 reports stored for 6 intended), and the held-back-lines and attempt panels say unavailable. The database comes first, always.

Release in one sentence: you take a manual backup of the few existing things the release alters (production has NO managed backups), you apply nine small database files (all new tables and functions, nothing existing is changed except two columns on `admin_users`, four rows in the switch table, one hook on the price correction ledger and one retention function that gets one more protection), then you push the code, then you check, then you switch the report on for Premium people when you are ready. All four NAV2 job switches stay OFF at release.

## 0. Rules for every step

1. **Project check, every time.** The address bar of the Supabase dashboard must contain `twwpnltizhtjxhamyoxt` (production). It must NOT contain `vqycarelcoijzwlpkpcz` (that is DEV). The first pre-check (P1) is also a wrong-database alarm: on DEV it answers false.
2. One file or one part at a time. Paste the whole text of the file, press Run. A migration file answers "Success. No rows returned". A check file answers ONE row of true or false values.
3. Every file can be run twice safely. If a paste stops halfway, run the same file again from its start.
4. If the editor shows an error, stop and send me the error text exactly as shown, and the name of the file. Do not edit the SQL by hand. (If you ever write SQL yourself for this release: never write the words into, from or join followed by a word inside a comment or a string. The editor mistook such words for statements on DEV. The files here are checked for that by a test.)
5. Never paste an e-mail address, key or password back to me. The only values I ask for are the check rows.
6. The migration files here are byte-identical copies of `supabase/migrations/0260` to `0263`, `0269` to `0271` and `0281` to `0282` (a test proves it). The five parts of 0260 are exact slices of the 0260 file.

## 1. The order, and why

| Step | What | Where it runs | Needs the new code? |
|---|---|---|---|
| 1 | Read-only pre-checks P1 to P7, then the manual backup B1 and its check B2 | SQL editor, production | no |
| 2 | Migrations: 0260 parts a to e, 0261, 0262, 0263, 0269, 0270, 0271, 0281, 0282, final check | SQL editor, production | no |
| 3 | Push the code and wait for the deploy | your machine, then Amplify | n/a |
| 4 | Smoke checks with every NAV2 switch OFF | browser | yes |
| 5 | Permissions: upload and series switch to DIFFERENT people | SQL editor | yes (to use them) |
| 6 | Load the two RBI files through the Admin screen | browser | yes |
| 7 | Pilot: switch Fund analytics ON, smoke checks with a Premium account | SQL editor, browser | yes |
| 8 | Later, one at a time: planner, correction worker, weekly refresh | see section 9 | yes |

**Why the database first, then the code** (full reasoning in `docs/nav2/NAV2_PRODUCTION_RELEASE_PLAN.md` section 4):

- The new database objects are additive and nothing the old code calls changes behaviour (proved on PGlite: section 12, group D). So applying them while the OLD code is live is safe. Migrations 0272 to 0274, 0283 to 0286 on main belong to other workstreams and have their own packs; this pack does not depend on them and they do not depend on it.
- The new code on an OLD database is also safe (every NAV2 page and route answers a plain "not available yet" or "not found" and never a 500 to an ordinary user), but it shows nothing useful and the admin screens say "unavailable". So there is no benefit in deploying first, and doing the database first lets you check the shape with the old code still serving.
- **Do not push first.** The new code on an old database does not break the application, but it shows nothing useful, and without 0281 a retried request can issue extra reports. If you pushed first by mistake: switch `nav2_fund_analytics` OFF (it is OFF unless you switched it on), carry on with step 2, and check with M1 (section 8) that `duplicate_idempotency_keys` is 0 and `reports_total` is 0 before switching it on.

## 2. Step 1: read-only pre-checks (nothing is written)

Run each file from `sql/prechecks/`.

| File | Expect | Paste back |
|---|---|---|
| `P1_nav2_not_yet_applied.sql` | one row, four values, all `true` | the row |
| `P2_foundations_exist.sql` | one row, six values, all `true` | the row |
| `P3_retention_function_fingerprint.sql` | one row: `body_is_0219` true and `service_only` true | the row (including `body_md5`) |
| `P3b_retention_function_text.sql` | only if `body_is_0219` is false: the live function text | the text |
| `P3c_retention_function_identity.sql` | one row: the function's arguments, result type, owner, execute rights and the NORMALIZED checksum (comments and white space ignored). `is_0219` or `is_0261` must be true | the row |
| `P3d_retention_function_behaviour.sql` | one row: the function's answers on real rows (held, held by a hold, report pinned, gap protected, after the changeover, unprotected, null). Every answer present must equal its expected value | the row |
| `P4_size.sql` | one row: database size, price table size, price rows (estimate), held funds | the row |
| `P5_ledger.sql` | the ledger rows from 0250 up, or an error that the table does not exist (acceptable: hand applied migrations are often not recorded) | whatever it shows |
| `P6a_admin_and_premium_counts.sql` | one row: number of administrators, number of Premium people today | the row |
| `P6b_administrator_list.sql` | the administrators with their addresses (for your choice of who gets which permission) | **nothing, keep it to yourself** |
| `P7_switch_state.sql` | the existing switch rows (including the price fetch switch) | the rows |

**What each pre-check proves (the list a release reviewer asks for).**

| Question | File |
|---|---|
| Is this the production database, and is there NO partial NAV2 attempt (tables, columns, functions, switch rows)? | P1 (all four true) |
| Is the migration lineage the one this release builds on (the price correction ledger, the retention function, the NAV 1 tables, the reference data admin function, the Premium function)? | P2 (all six true) and P5 (the ledger rows, when the ledger is kept) |
| Which text does the retention function `pc6_nav_row_is_candidate` hold: production likely has the 0219 text, not the 0261 text; 0261's own first statement accepts either and refuses anything else? | P3, P3c (`is_0219` or `is_0261` true), P3d (behaviour on real rows), P3b only if both are false |
| Which switch rows exist today (including the existing price fetch switch)? | P7, and P1 for the four NAV2 rows (must be absent) |
| Are the two admin permission columns absent, and who are the administrators and the Premium people? | P1 (columns absent), P6a, P6b |
| How big is the database and the price table (no write touches the price table)? | P4 |

**Stop rules.** P1 not all true: wrong database or NAV2 partly there, stop. P2 any false: a migration NAV2 depends on is missing, stop. **P3 `body_is_0219` false, and P3c `is_0219` false: stop.** Migration 0261 redefines the retention function `pc6_nav_row_is_candidate` and was written against the 0219 text. 0261 now carries its own guard: its first statement compares the live function (normalized checksum, so formatting does not matter) with the 0219 text and the 0261 text and STOPS the whole file with nothing changed if it is neither. A raw-text difference alone (P3 false, P3c `is_0219` true) is a formatting difference and is not a stop. Send me the P3, P3c and P3b output and I will compare.

### 2.1 The manual backup (production has NO managed backups)

After P1 to P7 are all as expected and BEFORE any migration: paste `sql/backup/B1_backup_altered_tables.sql`, then `sql/backup/B2_backup_check.sql` and paste the row back (expect equal counts, `function_text_saved` true, `backups_locked_to_service_role` true). B1 copies the three things the release alters (the administrator permissions table, the switch table, the retention function text) and records the size of the price correction ledger (a trigger is added to it, no row is changed). It writes four small tables named `nav2_backup_20261016_*`, locked to the service role, safe to run twice. Nothing else is copied because nothing else existing is altered; the NAV2 tables are new and empty. Remove the copies with `sql/backup/B3_drop_backups_after_release.sql` after the pilot has run a week. The price tables are NOT copied: no file here writes, updates or deletes a price row.

Disk space: NAV2 adds twelve small empty tables and seventeen functions. It adds no price rows. A report is stored as one row of about 0.09 MB per fund (0.35 MB for four funds, 2.1 MB for 25). The free space is read in the Supabase dashboard (Reports, Database), not by SQL; the P4 sizes are for the record.

## 3. Step 2: the migrations (database first)

For each line: paste the file, Run, expect "Success. No rows returned", then run the check file and expect one row of all `true`. Paste the check row back.

| # | Paste | Check | What it adds |
|---|---|---|---|
| 2.1 | `sql/parts/0260a.sql` | `sql/checks/C0260a.sql` | two permission columns on `admin_users` (both default false), two permission functions, the series table with its two seed rows (enabled, terms accepted by you on 03-10-2026), the batch ledger |
| 2.2 | `sql/parts/0260b.sql` | `sql/checks/C0260b.sql` | the rates table (append only) and its guards |
| 2.3 | `sql/parts/0260c.sql` | `sql/checks/C0260c.sql` | review items, corrections ledger, series state log |
| 2.4 | `sql/parts/0260d.sql` | `sql/checks/C0260d.sql` | the upload function and the weekly job write function (service role only) |
| 2.5 | `sql/parts/0260e.sql` | `sql/checks/C0260e.sql` | review, correct and switch functions, and the **four switch rows, all OFF** |
| 2.6 | `sql/migrations/0261_nav2_fund_analytics_reports_cache_and_pinning.sql` | `sql/checks/C0261.sql` | the report table (cannot be edited once written), the NAV pin table, the cache, the PDF tokens, and the **one change to an existing function**: the retention function gains the report pin (everything it protected before, it still protects) |
| 2.7 | `sql/migrations/0262_nav2_correction_events_and_monitoring.sql` | `sql/checks/C0262.sql` | the correction event table, **a hook on the price correction ledger** (records one inert event row per price or benchmark correction, never changes the correction), the monitoring functions |
| 2.8 | `sql/migrations/0263_nav2_risk_free_refresh_attempts.sql` | `sql/checks/C0263.sql` | the weekly refresh attempt log and its summary |
| 2.9 | `sql/migrations/0269_nav2_reports_premium_only_read.sql` | `sql/checks/C0269.sql` | a report can be read only while its owner is Premium (found in Stage 3) |
| 2.10 | `sql/migrations/0270_nav2_monitoring_snapshot_bounded_cost.sql` | (checked together with 0271) | monitoring function, first speed fix |
| 2.11 | `sql/migrations/0271_nav2_monitoring_snapshot_row_estimate.sql` | `sql/checks/C0270_0271.sql` | monitoring function, final form (reads the price table row estimate, never a full count) |
| 2.12 | `sql/migrations/0281_nav2_report_idempotency_key.sql` | `sql/checks/C0281.sql` | an idempotency key on a generated report (two empty columns and one unique index): a repeated click or a retried request issues ONE report |
| 2.13 | `sql/migrations/0282_nav2_ambiguity_case_summary.sql` | `sql/checks/C0282.sql` | one read-only function: how many statement lines were held back for review because their ISIN and AMFI code point at two different funds (shown on Fund Analytics Health) |
| 2.14 | | `sql/checks/C_final_all.sql` | final check: 12 tables, 17 functions, 8 policies, 4 switches all OFF, nobody holds the new permissions, two series enabled, no rates, no reports. **Expect all eight values true.** |

Notes:

- 0260 can be pasted as the whole file (`sql/migrations/0260_nav2_risk_free_governed_dataset.sql`) instead of five parts. The parts exist because the editor failed on a whole paste on DEV (cause in `docs/nav2/po_apply_0260_0262/README.md` section 8). Use the parts.
- 0270 and 0271 are both applied: they replace the same function and 0271 is the final form. Applying only 0270 is not enough (it did not cure the timeout on DEV: C0270_0271 stays false until 0271).
- The check for a step is also its own negative control: run before its step it does not return all true (the proof script shows each one).
- Lock note: part a changes `admin_users` (adds two boolean columns with a default: a brief lock on a tiny table). 0262 adds a trigger to `ii_reference_corrections` (a brief lock on a small ledger). 0261 replaces one function. Nothing here rewrites or scans the price table.

**Rollback per step** (reverse order, each file only touches NAV2 objects; section 10 has the table):
2.13: `sql/rollback/rollback_0282.sql`. 2.12: `sql/rollback/rollback_0281.sql`. 2.11 and 2.10: paste `sql/migrations/0262_...sql` again (restores the first monitoring function). 2.9: `sql/rollback/rollback_0269.sql`. 2.8: `rollback_0263.sql`. 2.7: `rollback_0262.sql`. 2.6: `rollback_0261_restore_0219_function.sql` FIRST, then `rollback_0261_drop_tables.sql` (this discards issued reports). 2.1 to 2.5: `rollback_0260.sql` (this discards loaded RBI rates).

### 3.1 Schema reconciliation against the expected shape (recommended, read-only)

`sql/migrations` gives the files; `inventory/nav2_catalog_inventory.sql` returns ONE jsonb value describing every NAV2 column, constraint, index, policy, grant, trigger and function as the database really holds it. Run it on production after 2.12, save the value as `actual.json` and give it to me; I run `node scripts/nav2_schema_inventory.mjs compare actual.json` against `inventory/expected_inventory.json` (derived by replaying the migrations, never typed by hand). Differences in function body comments only are reported separately and are not failures.

The same query runs on DEV (`docs/nav2/po_apply_dev_release_candidate/`, step C1). Running it on DEV and on production gives a direct DEV-versus-production comparison of the two answers; both are compared with the expected inventory, which now includes 0281 and 0282 (136 columns, 154 constraints, 29 indexes, 18 functions).

## 4. Step 3: the push

After step 2.14 is all true.

1. In your own clone: `git fetch origin`
2. `git rev-parse origin/main` must still be the base recorded in the release plan (or a later commit that only touches files outside this release). If it moved, tell me before pushing: I re-verify.
3. Check that the release commit descends from main: `git merge-base --is-ancestor origin/main <RELEASE_SHA>` (no output and exit code 0 means yes).
4. `git push origin <RELEASE_SHA>:main` (a plain fast-forward; never force). The exact `<RELEASE_SHA>` is in the release plan, section 1.
5. Amplify builds and deploys on its own. Wait for the build to show Deployed. The build is the same `next build` that was run offline (section 3 of the plan).

If the build fails, nothing is live from it (Amplify keeps the previous deploy). The database from step 2 is harmless with the old code.

## 5. Step 4: smoke checks with all NAV2 switches OFF

Do these in the browser right after the deploy.

1. Sign in as a **free** user. The Reports menu shows Monthly Report, Financial Activity, Consolidated Report and Forecast Variance. **There is no Fund Analytics entry.** Dashboard, Reports and the Monthly Report open as before. Opening `/reports/fund-analytics` by typing the address shows the plain sentence that the report is for Premium people (not an error page).
2. Sign in as a **Premium** user. There is still no Fund Analytics entry (the switch is OFF), and `/reports/fund-analytics` says the report is not available yet. The Monthly Report, Premium export and everything else work as before.
3. Sign in as the administrator. Admin menu: the group "Risk-free Rates" is not shown until step 5; "Reference Data" has a new entry "Fund Analytics Health". Open it: the page loads with figures (the price row counts are approximate and say so). It must not show an error.
4. Open the Monthly Report and one Investment Intelligence page for a user who holds Indian funds: unchanged. (This release also changes how a statement is matched to a fund when its ISIN and its AMFI code point at two different funds: it now opens a question for review instead of picking the ISIN. If an upload shows a new "needs your decision" item, that is this rule, see the plan section 5.)

Paste back: "1 ok, 2 ok, 3 ok, 4 ok" or what differed.

## 6. Step 5: permissions (different people)

Two separate permissions, so the person who loads rates is not the person who can switch a series off.

1. Choose people from P6b. Edit the placeholder in `sql/grants/grant_upload.sql` (the address inside the quotes) and run it. Then, if a second administrator exists, do the same with `sql/grants/grant_switch.sql` for a different person.
2. Run `sql/grants/check_grants.sql`. Expect `uploaders` 1, `switchers` 1 (or 0 if only one administrator exists), `holders_of_both` 0.
3. **Single operator limitation.** If you are the only administrator, you can hold both permissions. That is logical segregation only (separate permissions, a written reason of at least 20 characters on every state change, an immutable audit trail, a preview before any data is written). It is not dual control, there is no re-authentication step for a series switch and no preview of what a switch changes (`docs/nav2/CAPABILITY_SEGREGATION.md`). Do not describe it as dual control. Recommended with one administrator: grant only the upload permission, load the data, then take it away again with `sql/grants/revoke_upload.sql`. The series are already enabled at seed time, so the switch permission is needed only when you want to turn a series off.

## 7. Step 6: load the RBI data through the Admin screen

The code from step 3 is needed. Files are in `docs/nav2/risk_free_first_load/` (provenance in `RISK_FREE_FIRST_LOAD_PROVENANCE.md`): `RBI_91DAY_TBILL_CUTOFF_YIELD_HISTORY.csv` (1,060 values, 05-04-2006 to 30-09-2026), `RBI_91DAY_TBILL_GAP_ROWS.csv` (13 documented gap rows) and `RBI_POLICY_REPO_RATE_HISTORY.csv` (61 rows, 26-10-2005 to 05-12-2025).

Sign in as the person who holds the upload permission. Open Admin, Risk-free Rates, **Risk-free Rate Data** (`/admin/investment-intelligence/risk-free-data`). Each load is: choose series, choose the file, tick "This is the first load of the historical file", press Preview, read the result, tick the attestation, press Commit.

1. Series `RBI_91D_TBILL_CUTOFF_YIELD`, file `RBI_91DAY_TBILL_CUTOFF_YIELD_HISTORY.csv`. Preview expects 1,060 usable rows, 05-04-2006 to 30-09-2026, 1,060 to write, no conflicts, no rejected rows, and two warnings (three week-on-week moves above 1.5 points, first 01-08-2007; three stretches longer than 14 days without a weekly observation). Read them. Commit.
2. Same series, file `RBI_91DAY_TBILL_GAP_ROWS.csv`. Preview expects 13 usable rows (5 `no_accepted_bids`, 8 `no_row_in_source`), no conflicts, no warnings. Commit. (A gap row means "no cut-off exists for that date". It is never used as a rate.)
3. Series `RBI_POLICY_REPO_RATE`, file `RBI_POLICY_REPO_RATE_HISTORY.csv`, **Verified through** `02-10-2026` (type it day first), Preview expects 61 rows, 26-10-2005 to 05-12-2025. Commit.

**The attestation text** shown beside the tick box (the screen stores it verbatim in the ledger; read it before ticking): "I confirm that these values were read from the Reserve Bank of India publication named in each row and have not been altered, and that the Product Owner's decision of 03-10-2026 on RBI's terms (attribution kept, reuse risk accepted) covers storing them in FHIP." The decision it names is yours: RBI states "All Rights Reserved" and published no reuse licence; you accepted that risk and the terms status of both series is `po_accepted_2026-10-03`, never "confirmed in writing". Written confirmation from RBI is not required by Product Owner decision.

**Activation.** The two series are seeded **enabled** with that terms status (check C0260a). There is no separate activation step: once rates are loaded, Sharpe and Sortino use the primary series (the 91-day T-bill cut-off yield, described in words in the report: "Sharpe and Sortino compare each fund with the RBI 91-day Treasury bill rate (source: Reserve Bank of India)"). A series is switched off (reason of 20 characters or more, logged) on the same screen by the person with the switch permission.

Check after the load (read only, expect 1,060 values and 13 gap rows, 61 values, three batches):

```sql
select series_id, kind, count(*) as observations, min(observation_date) as first_date, max(observation_date) as last_date from public.ii_risk_free_observations group by series_id, kind order by series_id, kind;
```

```sql
select series_id, source_kind, rows_submitted, rows_inserted, date_from, date_to, attested from public.ii_risk_free_batches order by created_at;
```

Paste both results back. After the load, if you are the only administrator, run `sql/grants/revoke_upload.sql`.

## 8. Step 7: the pilot (switching Fund analytics on)

**What controls it.** (`sql/switches/read_switches.sql` shows every switch.) One switch row, `nav2_fund_analytics` in `ii_reference_job_control` (`sql/switches/switch_on_fund_analytics.sql` / `switch_off_fund_analytics.sql`). It is global: there is **no per-user allowlist in the code**. Who can see the report is decided by Premium plus that switch. Premium is held only by people you or a promo or payment route have made Premium, so the audience is already a small controlled group (P6a tells you how many today).

**Pilot limit (Product Owner decision 15-10-2026): one report covers at most 10 funds.** This is in the code (`FUND_ANALYTICS_MAX_FUNDS`), not a setting, so every Premium person is under it from the first report. A person who holds more funds picks up to 10 on the page and makes a second report for the rest. It stays 10 until a production timing run supports more and you decide.

**Recommendation.**
1. Release with the switch OFF (it is OFF after step 2).
2. After steps 4 to 6 pass, turn it ON during a time you are present (`switch_on_fund_analytics.sql`) and test with your own Premium account first: Reports, **Fund Analytics**, generate a report from the funds you hold (it uses the price history already stored; see section 9 for what happens with funds that have none), open the PDF, open Admin, Reference Data, Fund Analytics Health.
3. If all is well, leave it ON: the audience is only Premium people. If anything looks wrong, `switch_off_fund_analytics.sql` removes the page, the menu entry and generation at once; stored reports remain.
4. A per-person pilot (allowlist) would need a code change; I recommend against it for this release because the Premium group is already small.

**Monitoring during the pilot (read only, aggregate only).** `sql/monitoring/M1_pilot_health.sql`: one row, run after the first reports and once a day. `duplicate_idempotency_keys` must stay 0, `widest_report` must never exceed 10, `unprocessed_correction_events` is harmless while the worker is OFF. `sql/monitoring/M2_reports_per_day.sql`: reports, people and largest report per day for 30 days. In the browser: Admin, Reference Data, Fund Analytics Health shows the held-back statement lines (0282), correction lag and refresh attempts. **Stop and switch OFF** (`switch_off_fund_analytics.sql`) if a Premium person reports a report that never finishes (the page keeps saying it is being prepared for more than ten minutes), if `duplicate_idempotency_keys` is above 0, or if a report is wrong against a figure you can check by hand.

**Smoke checks after switching ON** (Premium account): the menu shows Reports, Fund Analytics. Generate report: it finishes within the 28 second platform limit (section 11), or says it is prepared in steps and shows one entry per fund with figures or plain "not available" labels. "View PDF" opens a PDF (about one page per fund, one comparison page). A free account: still no menu entry; the page says Premium only. Direct API call by a free account answers 403 with a sentence. Admin Fund Analytics Health loads. Then run `sql/smoke/S1_after_first_reports.sql` and paste the row.

## 9. What the four switches mean (all OFF at release) and the later stages

| Switch | Off means | If on later |
|---|---|---|
| `nav2_fund_analytics` | the page says "not available yet" and generation answers 404 (turned ON in step 7) | Premium people can generate the report |
| `nav2_trigger_planner` | the existing price history fetch for a person's own funds runs exactly as it does today | the fetch window per fund is sized by the NAV2 plan (analysis period plus buffers) |
| `nav2_correction_worker` | corrections still leave an inert event row, nothing recomputes. Safe: a corrected price or rate changes the content-addressed cache key (it contains the price series checksum and the rate dataset version), so a new report never reuses a stale bundle | the worker marks the affected cache entries as invalid and records counts |
| `nav2_risk_free_weekly_refresh` | no request to RBI is ever made by the app | the weekly job reads RBI (dry run by default) |

**What this means for users at release.** The Premium report works for funds that already have price history stored (the existing daily and on-demand history of the platform). **No new price fetching is started by NAV2.** For a fund with no or short history: if the existing price fetch switch `pc6_selective_historical_hydration` (shown in P7) is OFF, the report does not wait: it shows that fund with plain "not enough price history" labels and a reason. If that existing switch is ON, today's behaviour continues: the platform fetches the history of the person's funds and the report says "preparing" until it is there; NAV2 does not change that fetch while its planner is OFF. Beta and alpha are not shown (no licensed benchmark index): the report prints one line, "Beta and alpha: not available yet (no benchmark index is linked to this fund)." Sharpe and Sortino show once the RBI T-bill series is loaded.

**Staged plan to turn each on later (each needs its own go-ahead and checks; not part of this release):**

- **Stage A, nothing to do:** leave `nav2_trigger_planner`, `nav2_correction_worker` and the weekly refresh OFF for at least one week of pilot use. Read `Fund Analytics Health` daily: held funds without any price, stale prices, reports in the last 30 days, correction lag.
- **Stage B, planner:** only if pilot users hit "not enough history" for funds the platform could fetch. Turn on `nav2_trigger_planner` (`switch_on_trigger_planner.sql`) with the existing fetch switch ON, then have one Premium account upload a statement and check that exactly the held funds are fetched (monitoring: price rows total should move by one fund only). Off again if more is fetched. DEV proof of this path: Stage 3 journey 2b (19 checks).
- **Stage C, correction worker:** only when you plan price or rate corrections. Needs a cron schedule (pattern in `docs/investment-intelligence/PC6_OPERATOR_RUNBOOK.md`). Switch on (`switch_on_correction_worker.sql`), run once with a corrected price on a non-held fund, read the monitoring lag figure.
- **Stage D, weekly RBI refresh:** Written RBI confirmation is not required by Product Owner decision. Historical manual loading and automated refresh are permitted subject to technical validation, attribution, monitoring and the documented accepted reuse risk. The switch stays OFF until the final-build dry run has passed (a technical activation gate, not a permission gate): dry run first (body `{}` writes nothing), compare with the RBI pages by eye, check the cron configuration, failure alerting and idempotency, then switch on (`switch_on_weekly_refresh.sql`) and watch the first run (`"dryRun": false`).

## 10. Rollback table

| Situation | Do | Effect |
|---|---|---|
| The report looks wrong or slow | `switch_off_fund_analytics.sql` | page, menu entry and generation off at once; stored reports kept |
| Anything NAV2 related misbehaves | `switch_off_all_nav2.sql` | all four off; the rest of the application is unchanged |
| A series is wrong | Admin screen, series state (reason 20 characters or more) | Sharpe, Sortino, alpha report the rate as unavailable; nothing deleted |
| A rate was loaded wrongly | Admin screen, "Correct one published value" | audited correction with old and new value; never a delete |
| Code deploy must go back | revert the commit and push, or Amplify redeploy of the previous build | the database stays; old code ignores NAV2 objects (proved, group D) |
| Backup copies | `sql/backup/B3_drop_backups_after_release.sql` (only after the release is confirmed) | the four `nav2_backup_20261016_*` tables are removed |
| Step 2.13 | `sql/rollback/rollback_0282.sql` | the held-back count is gone from Fund Analytics Health (it then says not available) |
| Step 2.12 | `sql/rollback/rollback_0281.sql` | no idempotency key: a repeated click can issue a second report again; issued reports untouched |
| Step 2.11/2.10 | paste the 0262 migration file again | first monitoring function back |
| Step 2.9 | `sql/rollback/rollback_0269.sql` | reports readable by owner regardless of Premium again |
| Step 2.8 | `rollback_0263.sql` | attempt log gone |
| Step 2.7 | `rollback_0262.sql` | correction hook, events, monitoring gone |
| Step 2.6 | `rollback_0261_restore_0219_function.sql` then `rollback_0261_drop_tables.sql` | retention function is the 0219 text again (P3 true again); **issued reports discarded** |
| Steps 2.1 to 2.5 | `rollback_0260.sql` | **loaded RBI rates and audit ledger discarded**, the two permission columns and four switch rows removed |

The rollbacks were run on PGlite in reverse order after a full apply and returned the database to its pre-NAV2 shape (P1 true again, retention function equal to 0219, old paths unchanged), and the pack applied again afterwards (section 12, group E).

## 11. Limits, cost and size

- **Generation is synchronous** and runs inside one web request. The platform (Amplify) ends a request at 28 seconds, so the generation route declares 28 seconds. Engine time measured offline: about 3.4 s for 4 funds and about 18 s for 20 funds, plus database reads; 25 funds took about 14.5 s of engine time on a loaded development machine in Stage 3. A report covers at most **10 funds** (Product Owner decision 15-10-2026, the pilot limit; it was 20 on 07-10-2026): a person who holds more is told in plain words ("A report covers up to 10 funds. You hold N, so generate it in two reports."; the API answers 409 with the list of funds to choose from, 422 for an invalid choice), picks the funds on the page, and can make a second report for the rest. The price-history check and the NAV2 planner look only at the funds the report covers (release candidate, B2): a person who holds 30 funds and chooses 20 waits for the history of those 20 only, nothing is fetched for the other 10, and the chosen ids are pinned in the report manifest. One clock runs from the moment the request arrives: at 22 seconds the route answers a typed 503 timed_out (retryable, nothing lost) instead of waiting for the platform page, and a generation never starts engine work that would not finish inside its 18 second budget: it prepares what fits (kept in the shared cache), answers 202 prepared in steps and carries on when the person generates again, always with the same Idempotency-Key so that one intended report issues exactly one report (needs migration 0281). **Measured on DEV from a development machine on a home link (170 ms round trip, not the production network): 1 and 4 funds issue in one call (about 15 s), 10 funds in two calls cold and one warm, 20 funds did NOT finish reliably (cold: three prepared-in-steps answers, then repeated 22 second timeouts; warm: issued on the fifth call at 21.8 s). Most of that time is reads over the slow link, not engine time (engine: about 3 s cold for 18 funds on the same machine). The Product Owner therefore set the pilot limit to 10 funds per report (FUND_ANALYTICS_MAX_FUNDS in lib/config/nav2/reportLimits.ts); raising it again needs a production timing run and a Product Owner decision. A person who holds many funds is asked to choose.** The largest real report is 20 funds: a 23 page PDF. The PDF export is a second request (declared 60 seconds, in practice about 3 s).
- **Size:** a stored report is about 0.09 MB per fund (0.35 MB for four funds); a PDF about 0.1 to 0.6 MB, never stored. No price rows are added. Twelve new tables are empty at release; the RBI load adds 1,134 small rows.
- **Cost:** no external paid service is called. The weekly RBI reader and the AI second opinion are off. The headless PDF render runs inside the existing PDF path used by the Monthly Report.
- **Timing on production is not yet measured.** All timings above are from a development machine on a slow link. The first production measurement is part of the pilot: with your own Premium account generate a report for 1, 4 and 10 funds (cold, then again) and note how long each takes and whether any answers "prepared in steps"; paste the times back before inviting anyone else.
- **Premium count today** (P6a) is the number of people who can see the report once switched on.

## 12. What the proof script showed (PGlite)

`node scripts/nav2_production_deploy_order_proof.mjs` (about 5 minutes). Groups: A old paths recorded; B what the new code sees on the old schema; C every pack step with its check and its negative control; D the old paths after the migrations; E reverse rollbacks and a re-apply; F second run of everything. The final line and the counts are in `docs/nav2/NAV2_PRODUCTION_RELEASE_PLAN.md` section 4.

## 13. What stays NOT activated

- **Beta, alpha, benchmark returns:** licensed index data is not available. They show as typed "unavailable" states, never as zero.
- **Weekly RBI refresh:** OFF until its final-build dry run has passed (stage D; a technical gate, RBI's written confirmation is not required by Product Owner decision).
- **Planner and correction worker:** off until staged (B, C).
- **Dual control and re-authentication for series switches:** not built (`CAPABILITY_SEGREGATION.md`).

## 14. What to paste back, in short

P1 to P4, P6a, P7 (and P5 if it answers), the B2 backup check row, the check row of each of steps 2.1 to 2.13 and the final check, the two load verification results, "smoke 1 to 4 ok" after the push, `check_grants.sql`, and after the pilot the `S1_after_first_reports.sql` row. Any error text exactly as shown.
