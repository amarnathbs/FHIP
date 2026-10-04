# NAV2 Stage 2: hand-over for migrations 0260, 0261, 0262 (DEV first)

Status: **hand-over artefact. Nothing here has been applied to any database.** The SQL is in the migration files, which are the single source; this page only says in what order to apply them, what to check afterwards, how to grant access, how to do the first load of the RBI files, how to turn the pieces on and how to turn them off.

Evidence for the SQL: replayed in an in-process Postgres (PGlite) by `scripts/nav2_0260_0262_pglite_verification.mjs`, **80 checks, all pass** (the same checks from empty with the whole file, from empty with the five parts, and from a half-applied state: part a alone, then all parts) (capability boundaries, append-only ledgers, idempotence, retention predicate unchanged plus the new pin with a negative control, immutability, RLS, the correction listener, suppression). That is not DEV evidence.

Migration numbers: scanned 04-10-2026 across 825 local and remote refs and every worktree. The highest number taken by anyone else is 0252 (`feat/factsheet-benchmark-reader-20261003`); 0260 to 0262 are free. Re-scan before applying if time has passed.

## 1. Apply order (all idempotent, forward-only, additive)

**In the Supabase SQL editor, run 0260 as five parts, one at a time, in order a, b, c, d, e, then 0261, then 0262.** The parts are in `docs/nav2/po_apply_0260_0262/parts/` (`0260a.sql` to `0260e.sql`). Open one, paste the whole text, press Run, check the result, go to the next. A test proves that the five parts joined are byte-for-byte the migration file `supabase/migrations/0260_nav2_risk_free_governed_dataset.sql`, which is the single logical migration 0260 for the supabase CLI. Every statement can be run again, so a part that stopped halfway, or a database that already holds some of it, is simply run again from that part (see section 8 for why the parts exist).

| Order | File | What it adds | Expect afterwards (read-only query) |
|---|---|---|---|
| 1 | `parts/0260a.sql` | the two `admin_users` capability columns, the two predicate functions, `ii_risk_free_series` with its two seed rows, `ii_risk_free_batches` | `select count(*) from ii_risk_free_series;` gives 2, and `select to_regclass('public.ii_risk_free_batches');` is not null |
| 2 | `parts/0260b.sql` | the append-only function, the batch triggers, `ii_risk_free_observations` and its guard function and triggers | `select to_regclass('public.ii_risk_free_observations');` is not null, and `select count(*) from pg_trigger where tgrelid = 'ii_risk_free_observations'::regclass and not tgisinternal;` gives 2 or more |
| 3 | `parts/0260c.sql` | `ii_risk_free_review_items`, `ii_risk_free_corrections`, `ii_risk_free_series_state_log` and their triggers and policies | `select count(*) from information_schema.tables where table_name like 'ii_risk_free%';` gives 8 (your 2 existing PC6 tables, `ii_risk_free_rates` and `ii_risk_free_methodology`, plus the 6 new ones) |
| 4 | `parts/0260d.sql` | `commit_risk_free_upload` and `record_risk_free_refresh_results` | `select count(*) from pg_proc where proname in ('commit_risk_free_upload', 'record_risk_free_refresh_results');` gives 2 |
| 5 | `parts/0260e.sql` | `resolve_risk_free_review_item`, `correct_risk_free_observation`, `set_risk_free_series_state` and the four job-control rows (all disabled) | `select count(*) from ii_reference_job_control where job_key in ('nav2_risk_free_weekly_refresh', 'nav2_fund_analytics', 'nav2_trigger_planner', 'nav2_correction_worker') and enabled = false;` gives 4 |
| 6 | `supabase/migrations/0261_nav2_fund_analytics_reports_cache_and_pinning.sql` | `nav2_fund_analytics_reports` (immutable), `nav2_report_nav_dependencies`, `nav2_result_cache`, `nav2_report_render_tokens`, and a **redefinition** of `pc6_nav_row_is_candidate()` (the 0219 body plus the report pin) | section 2 checks |
| 7 | `supabase/migrations/0262_nav2_correction_events_and_monitoring.sql` | `nav2_correction_events`, two correction triggers, `nav2_monitoring_snapshot()` | section 2 checks |

0261 and 0262 are single pastes (each is one file, not split). 0262 must run after 0260 and 0261 (its monitoring function reads tables of both). No CHECK constraint is dropped or recreated by any of them. The one function redefinition (`pc6_nav_row_is_candidate`) keeps every 0219 protection and keeps EXECUTE for the service role only.

Note on what DEV already has: `ii_risk_free_rates` and `ii_risk_free_methodology` are older PC6 tables that match `%risk_free%`. A count of 2 such tables therefore means NONE of the new tables exist yet (it does not mean part of 0260 was applied).

## 2. Checks to run after applying (read-only)

```sql
-- the two capability columns exist and nobody has them yet
select column_name from information_schema.columns where table_name = 'admin_users' and column_name in ('can_upload_risk_free_data', 'can_switch_risk_free_series');
select count(*) filter (where can_upload_risk_free_data) as uploaders, count(*) filter (where can_switch_risk_free_series) as switchers from admin_users;

-- both series are seeded, enabled, terms accepted by the PO
select series_id, role, cadence, max_staleness_days, enabled, terms_review_status, verified_through_date from ii_risk_free_series order by series_id;

-- all four switches exist and are OFF
select job_key, enabled from ii_reference_job_control where job_key in ('nav2_risk_free_weekly_refresh', 'nav2_fund_analytics', 'nav2_trigger_planner', 'nav2_correction_worker') order by job_key;

-- the report table is protected (must list the immutability trigger) and the retention function mentions the pin
select tgname from pg_trigger where tgrelid = 'nav2_fund_analytics_reports'::regclass and not tgisinternal;
select position('nav2_report_nav_dependencies' in pg_get_functiondef('pc6_nav_row_is_candidate(uuid, date, date)'::regprocedure)) > 0 as retention_knows_the_pin;

-- EXECUTE on the retention function must stay service-role only (expect false, true)
select has_function_privilege('authenticated', 'pc6_nav_row_is_candidate(uuid, date, date)', 'execute') as authenticated_can, has_function_privilege('service_role', 'pc6_nav_row_is_candidate(uuid, date, date)', 'execute') as service_can;

-- the weekly job's write function must NOT be callable by a session (expect false)
select has_function_privilege('authenticated', 'record_risk_free_refresh_results(text, jsonb, jsonb, date)', 'execute') as session_can_write_refresh;
```

## 3. Grant access (separate people, separate columns)

The upload capability and the switch capability are different duties; give them to different admins if you can. Monitoring uses the capability you already have for Reference Data Quality.

```sql
update admin_users set can_upload_risk_free_data = true where user_id = '<the admin who will load and correct the rates>';
update admin_users set can_switch_risk_free_series = true where user_id = '<the admin who may switch a series on or off>';
```

## 4. First load of the RBI files (the PO does this, DEV first)

Files: `docs/nav2/risk_free_first_load/RBI_91DAY_TBILL_CUTOFF_YIELD_HISTORY.csv` and `RBI_POLICY_REPO_RATE_HISTORY.csv`. Both were parsed against the upload reader in this branch: 1,060 of 1,060 and 61 of 61 rows accepted, none rejected.

1. Sign in as the admin with the upload capability. Open **Admin, Risk-free Rates, Risk-free Rate Data** (`/admin/investment-intelligence/risk-free-data`).
2. Series `RBI_91D_TBILL_CUTOFF_YIELD`, choose the T-bill file, tick "first load", press **Preview**. Expect 1,060 usable rows from 05-04-2006 to 30-09-2026, 1,060 to write, no conflicts, no rejected rows, and two warnings: three week-on-week moves above 1.5 percentage points (first 01-08-2007) and three stretches longer than 14 days with no weekly observation (listed in section 6 below). Read the warnings, tick the attestation, press **Commit**.
3. **Gap rows (second upload to the same T-bill series).** Choose `docs/nav2/risk_free_first_load/RBI_91DAY_TBILL_GAP_ROWS.csv`, tick "first load", Preview. Expect 13 usable rows (no value, each with its reason), 13 to write, no conflicts, no rejected rows and no warnings: 5 with reason `no_accepted_bids` (27-01-2016, 24-02-2016, 29-03-2023, 20-02-2025, 25-03-2026) and 8 with `no_row_in_source` (05-01-2011, 17-07-2013, 01-04-2015, 30-09-2020, 18-09-2024, 25-09-2024, 31-12-2025, 01-04-2026). Attest and Commit. A gap row means "no cut-off exists for that date"; it is never used as a rate, and the file does not touch the 1,060 value rows. (The three no-auction stretches are made of these same dates, so there are 13 distinct dates, not 16.)
4. Series `RBI_POLICY_REPO_RATE`, choose the repo file, tick "first load", enter **verified through 02-10-2026 as 2026-10-02** (the NSDP page of 02-10-2026 still showed 5.25, and the August 2026 policy statement left it unchanged), Preview. Expect 61 rows from 26-10-2005 to 05-12-2025. Without a verified-through date the repo series supplies no rate after its last observation. Commit.
5. Check the screen: both series show their counts and freshness (the T-bill is "fresh" for 21 days after the last auction, the repo series for 90 days after its verified-through date).

Verification queries after the load (expect 1,060 values + 13 gap rows and 61 values, last dates 30-09-2026 and 05-12-2025, three batch rows):

```sql
select series_id, kind, count(*) as observations, min(observation_date) as first_date, max(observation_date) as last_date from ii_risk_free_observations group by series_id, kind order by series_id, kind;
select gap_reason, count(*) from ii_risk_free_observations where kind = 'gap' group by gap_reason order by gap_reason;   -- expect no_accepted_bids 5, no_row_in_source 8
select series_id, source_kind, rows_submitted, rows_inserted, date_from, date_to, attested from ii_risk_free_batches order by created_at;
select series_id, to_char(verified_through_date, 'DD-MM-YYYY') as verified_through from ii_risk_free_series order by series_id;
```

Re-submitting the same file is a no-op. A different value for a date that is already published is refused for the whole file: a published value changes only through the screen's "Correct one published value" control (reason of at least 20 characters, recorded with the old and new value).

## 5. Switching the pieces on (all ship OFF; all are deliberate human steps)

Only after the migrations are applied and the first load is checked. Each statement turns on exactly one thing.

```sql
-- the Fund analytics report (Premium users see it under Reports, Fund Analytics)
update ii_reference_job_control set enabled = true, disabled_reason = null, updated_at = now() where job_key = 'nav2_fund_analytics';
-- the NAV2 required-window planner for the existing user-scoped price fetch (off = exactly the previous behaviour)
update ii_reference_job_control set enabled = true, disabled_reason = null, updated_at = now() where job_key = 'nav2_trigger_planner';
-- the correction worker (needs the cron schedule below to run)
update ii_reference_job_control set enabled = true, disabled_reason = null, updated_at = now() where job_key = 'nav2_correction_worker';
-- the weekly RBI refresh (do a dry run first, section 5a)
update ii_reference_job_control set enabled = true, disabled_reason = null, updated_at = now() where job_key = 'nav2_risk_free_weekly_refresh';
```

**5a. Dry run of the weekly refresh.** With the switch on and the body empty (or `{}`), the job reads RBI, decides and reports what it WOULD do; it writes nothing. It writes only when the body says `"dryRun": false` explicitly.

```
POST /api/investment-intelligence/cron/nav2-risk-free-refresh      header  x-cron-secret: <CRON_SECRET>      body  {}
```

Compare the report's `tbill` and `repo` decisions with the RBI pages by eye. The readers were written from saved copies of the live pages and were **not run against the live site by this branch**; the archive-form request for another month's listing is inferred and equally unproven. If the report shows a fetch problem or a review reason, that is the readers needing a change, not a data problem. The AI second opinion additionally needs `AIE_AI_FALLBACK_ENABLED=true`; without it the job runs on the deterministic reader alone and a changed layout becomes a review item.

**5b. Schedules.** Registering the weekly refresh and the correction worker follows the pattern in `docs/investment-intelligence/PC6_OPERATOR_RUNBOOK.md` (a `cron.schedule` entry calling the route with the shared secret). It is not registered by this change. Suggested: refresh on Thursday and Friday (a late release is retried by the next run), correction worker every 15 minutes.

**Environment variables used:** `CRON_SECRET` (existing), `APP_BASE_URL` (existing; the PDF renderer opens the print route on it), `AIE_AI_FALLBACK_ENABLED` (existing, default off; only for the AI second opinion).

## 6. Things to know before the first load

- **Gaps and staleness (PO decision 04-10-2026).** The rate is in force for 21 days after an auction. A documented gap row lets the last published rate carry for up to 35 calendar days from the last value (never across an undocumented hole), labelled "carried across a documented RBI gap". A ratio is computed over the return observations that have a rate as long as at least 95% of the window's observations do, and the count left out is shown with the figure; below 95% it is "Risk-free data unavailable". Measured on your first-load T-bill file: **no weekday from 05-04-2006 to 30-09-2026 lacks a rate even under the plain 21-day rule** (the longest stretches between auctions are 22, 15 and 21 days: 11-09-2024 to 03-10-2024, 12-02-2025 to 27-02-2025, 18-03-2026 to 08-04-2026, and the later auction's own date has its own value). An earlier version of this README said 02-10-2024 and 03-10-2024 would be unavailable; that was wrong. Loading the gap rows therefore changes no number for this data; it documents why those Wednesdays are empty and protects longer analyses if a longer stretch ever occurs.
- Three of the file's yields (27-10-2010, 03-11-2010, 08-12-2010) were flagged by the preparer as the least certain values; they only matter to a report whose window reaches back to 2010.
- Beta and alpha need a declared, entitled, total-return benchmark series. None is loaded by this change; until one exists those two measures show "Benchmark mapping missing" or "Benchmark data unavailable" for every fund, and Sharpe and Sortino are unaffected.

## 7. Turning things off, and rolling back

Switching off never deletes data.

```sql
update ii_reference_job_control set enabled = false, disabled_reason = 'NAV2 switched off by the PO: <reason>', updated_at = now() where job_key in ('nav2_fund_analytics', 'nav2_trigger_planner', 'nav2_correction_worker', 'nav2_risk_free_weekly_refresh');
```

A risk-free series is switched off from the admin screen by the admin with the switch capability (reason recorded permanently); every Sharpe, Sortino and alpha then reports the risk-free rate as unavailable, nothing is deleted.

Rolling the migrations back (only if nothing depends on them): re-run the 0219 definition of `pc6_nav_row_is_candidate()` first, then drop in this order 0262's triggers, functions and `nav2_correction_events`; 0261's four tables and `nav2_reports_immutable()`; 0260's functions, tables (reverse dependency order), the two `admin_users` columns and the four job-control rows. Each migration's last lines carry the same note. Dropping the report tables discards issued reports; dropping the risk-free tables discards the loaded rates and their audit ledger. Do not do either without the PO.

## 8. The failed paste of 0260 on DEV (error 42P01, relation NAV2 does not exist) and what was changed

What is known. The Supabase SQL editor answered `relation "NAV2" does not exist` with no position. Nothing in the old 0260 refers to a relation called NAV2: the word appeared only in comments and in four text strings. The old file also ran cleanly through the migration chain in an in-process Postgres and in the same checks now run three ways, so the SQL itself is valid. DEV is also reported to hold exactly 2 tables matching `%risk_free%`, but two such tables exist anyway from older work (`ii_risk_free_rates`, `ii_risk_free_methodology`), so that count says the whole paste most likely rolled back (the editor sends a multi-statement paste as one request, and a failure in one rolls the rest back), not that it stopped halfway. If you query and find any of the six new tables, run the parts from the first one that is missing, everything is safe to repeat.

The cause is NOT established. I could not reproduce the editor error here (no access to it). The best guess is that the editor, or the layer in front of it, mis-reads the text around a comment or a string: the old file had semicolons and apostrophes inside comments, semicolons inside text strings (one of them in the string that opens with the word NAV2), double quotes inside comments, percent signs in messages, and an uppercase NAV2 in comments and strings. A statement splitter that does not honour comments and strings the way PostgreSQL does would cut the text at those points and could start a fragment with the word NAV2. This is a guess, not a finding. Two things that looked suspicious were checked against migrations already applied on DEV and are NOT the difference: a dotted custom setting name (an earlier migration, 0090, uses `fhip.smsf_balance_write`) and dollar-quoted function bodies, `%` in a raise message and `%rowtype` (0252, applied on DEV, uses all three). The one construct in 0260 with no applied precedent that I found is the uppercase NAV2 inside text together with semicolons and apostrophes in comments, which is why those are what was removed.

What was changed (all three of 0260, 0261, 0262, same hazards):
- every comment and every text string: no semicolon, no apostrophe in a comment, no double quote, no percent sign, ASCII only, and the uppercase word NAV2 is gone (lowercase nav2 remains only in object names and job keys);
- dollar-quoted bodies use the named tag `$fn$` instead of bare `$$`;
- messages that used `%` placeholders are built with `||` and `::text`;
- `%rowtype` declarations became plain `record` variables, so no function needs a table to exist when it is created;
- policy names are plain identifiers (for example `read_ii_risk_free_series`) instead of quoted names with spaces;
- the custom setting name is now `fhip.risk_free_correction` (same pattern as the applied 0090);
- 0260 is split into five idempotent parts at safe boundaries, with the append-only function moved to the start of part b, and the parts are exact slices of the migration file (tested).

A test (`tests/unit/nav2/nav2MigrationPartsAndEditorSafety.test.ts`) now fails if any of those hazards come back in 0260, 0261 or 0262, and if the parts stop reassembling to the migration. If the editor still fails on a part, the error will name that part and its statement range, and the part is small enough to run statement by statement; please paste the exact message back.
