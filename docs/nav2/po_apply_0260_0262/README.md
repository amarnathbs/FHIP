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

## 8. The failed pastes of 0260 on DEV (error 42P01) and what was changed

**Cause (identified, with evidence).** The Supabase SQL editor pre-parses the pasted text and reads the word that follows `into` INSIDE A TEXT STRING as the target of an INSERT. Two failures, one cause:
- First paste of the whole 0260: `relation "NAV2" does not exist`. The job-control row for the correction worker has the description text `processes ii_reference_corrections events into NAV2 cache invalidation`. The editor took `NAV2` as an insert target. The first screenshot showed that statement at lines 590 to 592.
- After the first rewording (NAV2 became fund analytics), part e failed with `relation "fund" does not exist`: the same string now read `events into fund analytics cache invalidation`, so the editor took `fund`.
- Parts a to d applied cleanly on DEV, and they contain comments with `from PUBLIC` and `INSERT, UPDATE or DELETE`. So the confirmed hazard is specifically `into <word>` inside a string. `from <word>` and `join <word>` inside strings and comments are treated as the same family as a precaution (not confirmed).
- My earlier guesses (semicolons, apostrophes, double quotes, percent signs, uppercase NAV2) were wrong as the cause. They are still removed, they do no harm, and the lint below keeps them out.

**Text changes made for this** (the PO applied them to his DEV copies first, the same text is now in the repository):
- 0260 part e and the 0260 file: `events into fund analytics` became `events for fund analytics`, and `Accepted from the review queue` became `Accepted via the review queue`. Parts a to d are unchanged, they are already applied on DEV.
- 0261: `the update trigger refuses` became `the change guard refuses`, `(update blocked)` became `(change blocked)`.
- 0262: `in-place UPDATE of` became `in-place edit of`, `AFTER INSERT trigger` became `a hook that fires after each new row`, `derived from user holdings` became `based on user holdings`.

**Earlier hardening that stays** (all of 0260, 0261, 0262): no semicolons, apostrophes, double quotes or percent signs in comments or strings, ASCII only, no uppercase NAV2, named dollar tags `$fn$`, messages built with `||`, `record` instead of `%rowtype`, plain policy names, the setting name `fhip.risk_free_correction`, and 0260 split into five idempotent parts that are exact slices of the migration file.

**Guard.** `tests/unit/nav2/nav2MigrationPartsAndEditorSafety.test.ts` now fails if ANY comment or string in any migration numbered 0260 or higher, or in a part, contains `into`, `from` or `join` followed by a word. The single allowed text is the comment `from PUBLIC` in the part a header, which is frozen and applied. 0252 (applied on DEV) passes the same lint, and is used as the example of text that is fine. Rule for anyone writing a hand-applied migration: in comments and strings, do not write into, from or join followed by a word. Say for, via, to, out of, or reword.

## 9. Migration 0263: weekly refresh attempts and the robots.txt decision (added 05-10-2026)

Status: **hand-over artefact, not applied.** One paste of `supabase/migrations/0263_nav2_risk_free_refresh_attempts.sql`, after 0260, 0261 and 0262. It adds the table `ii_risk_free_refresh_attempts` (one row per LIVE weekly refresh run) and the read-only function `nav2_refresh_attempt_summary()` for the Fund analytics health page.

The decision it supports (PO, Stage 3): RBI answers the robots.txt address with an HTML "Unauthorised Access" page. A robots.txt that is not a real robots file, or that answers 401, 403 or 404, means no rules are published, so the weekly refresh continues and records `robots_unavailable_continued`. A 5xx, a 429, a timeout, a network failure or a redirect on robots.txt still stops the run. A real robots file that disallows the page is honoured. A refusal of a content page (403, 429, a verification page or an "Unauthorised Access" page) stops the whole run as `blocked_by_source`, queues one review item (reason blocked_by_source, no candidate) and the freshness figures keep ageing. Nothing is retried or worked around.

Check afterwards: `select count(*) from ii_risk_free_refresh_attempts;` gives 0, and `select has_function_privilege('authenticated', 'nav2_refresh_attempt_summary()', 'execute');` gives true. Until it is applied the monitoring page says "Not available" for this panel (never a zero) and the cron route logs that it could not record the attempt. Rollback: the last line of the migration.
