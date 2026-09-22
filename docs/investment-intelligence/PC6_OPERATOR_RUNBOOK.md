# PC6 — Reference-Market-Data Operator Runbook

**Status:** DEV-only. Nothing in PC6 is scheduled or enabled in production.
**Covers:** N.15 (`operator runbook`, `kill switch`, `source outage handling`).
**Last updated:** 2026-09-15.

---

## 0. What PC6 is, and what it must never do

PC6 ingests **external reference market data** — Indian mutual-fund scheme
identity, daily NAV history, benchmark levels, risk-free rates. It is a
separate domain from AIE: PC6 never touches a user document, never uses AIE's
jobs, providers or confidence semantics, and never appears in a user-document
pipeline.

**The one rule that matters most (D.7):** a NAV, unit count or value printed on
a user's own statement is a *source fact*. A PC6 NAV is a *separate, later,
independently-dated fact*. PC6 may sit beside a statement fact and enable a
comparison. It may **never** overwrite one. If you are ever asked to "correct"
a user's statement figure using market data, the answer is no — raise it as a
product question instead.

---

## 1. Current state — read this before doing anything

| Thing | State |
|---|---|
| Migration `0155` | **Written, verified in PGlite, NOT APPLIED** to DEV or production |
| Migrations `0153`, `0154` | Also awaiting application (from M4/M4B) |
| pg_cron schedule for PC6 | **Does not exist.** `0155` deliberately registers none |
| `ii_reference_job_control` rows | Ship with `enabled = false` |
| Vault secret for PC6 | **Not created** |
| Benchmark index data | **Blocked** — BLOCKER PO-PC6-1 (licensing) |
| Risk-free source | **Blocked** — BLOCKER PO-PC6-2 (PO decision) |

A correctly-authenticated call to the ingest endpoint today returns
`skipped_kill_switch`. That is the intended state, not a fault.

---

## 2. Applying migration 0155

`0155` is additive and idempotent; re-running it is safe.

1. Apply `0153` and `0154` first if they are still outstanding — `0155` does
   not depend on them, but applying the chain in order keeps the ledger honest.
2. Apply `0155` through the Supabase dashboard SQL editor or the Supabase CLI.
3. Re-run `node scripts/pc6_0155_pglite_verification.mjs` (30 assertions) to
   confirm the chain is still clean, then spot-check on the real database:
   ```sql
   select numeric_precision, numeric_scale from information_schema.columns
   where table_name = 'ii_prices_nav' and column_name = 'price';
   -- expect 24, 10
   select job_key, enabled from ii_reference_job_control;
   -- expect both rows enabled = false
   ```

**The precision change is the one to check.** `0155` widens
`ii_prices_nav.price` from `numeric(20,6)` to `numeric(24,10)` because AMFI
publishes up to 8 decimal places. Widening scale is metadata-only in Postgres —
no existing row is rewritten and no value changes.

---

## 3. Granting the admin capability

The reference-data quality surface is gated on a **separately-named**
capability, not on general admin status:

```sql
update admin_users set can_view_reference_data_quality = true
where user_id = '<the admin user id>';
```

This gates all four layers: the RLS policies on every PC6 operational table
(via `is_pc6_reference_data_admin()`), the API route, the page, and the nav.
Revoking it is the same statement with `false`, and takes effect on the next
request — there is no cached capability.

---

## 4. Running an ingest by hand (DEV)

```bash
curl -X POST "$APP_ORIGIN/api/investment-intelligence/cron/pc6-reference-ingest" \
  -H "x-cron-secret: $CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"sourceConfigId":"amfi_nav_daily","jobKey":"pc6_amfi_daily_nav","dryRun":true}'
```

Start with `"dryRun": true`. It fetches, fingerprints, parses, resolves and
plans, then writes nothing and tells you exactly how many rows it *would*
insert, skip and supersede.

A backfill window (N.4) uses the history source:

```bash
-d '{"sourceConfigId":"amfi_nav_history","jobKey":"pc6_amfi_daily_nav",
     "fromDate":"2026-08-01","toDate":"2026-08-07"}'
```

**Keep backfill windows small.** A 3-day window is ~3.5 MB and ~26,000 rows; a
month is an order of magnitude more. Walk a long backfill week by week.

---

## 5. The kill switch

There was no kill switch for any scheduled job in this repository before PC6.
This one is a database row, so it can be flipped without a deploy:

```sql
-- Stop a job. A reason is REQUIRED — the CHECK refuses a silent kill.
update ii_reference_job_control
set enabled = false,
    disabled_reason = 'AMFI changed the NAVAll column order; rejection rate spiked',
    disabled_by_admin_id = '<your admin id>',
    disabled_at = now(),
    updated_at = now()
where job_key = 'pc6_amfi_daily_nav';

-- Start it again.
update ii_reference_job_control
set enabled = true, disabled_reason = null, disabled_by_admin_id = null,
    disabled_at = null, consecutive_failures = 0,
    next_attempt_not_before = null, updated_at = now()
where job_key = 'pc6_amfi_daily_nav';
```

It **fails closed**: if the control row is missing entirely, the job refuses to
run rather than running unconstrained. Deleting the row is therefore also a
valid (if blunt) way to stop it.

---

## 6. Reading a failure

Everything an attempt did is in `ii_reference_import_batches`:

```sql
select started_at, finished_at, status, attempt, rows_read, rows_accepted,
       rows_rejected, rows_inserted, rows_unchanged, rows_superseded,
       error_code, error_detail, source_sha256, source_byte_length
from ii_reference_import_batches
where job_key_like_source_key = 'amfi'   -- column is source_key
order by started_at desc limit 20;
```

| `status` / `error_code` | What happened | What to do |
|---|---|---|
| `skipped_kill_switch` | The switch is off, or the control row is missing | Expected today. Section 5 to enable |
| `SOURCE_NETWORK` | Could not reach AMFI at all | Usually transient. Backoff will retry |
| `SOURCE_HTTP_ERROR` | AMFI returned 4xx/5xx | Check the endpoint by hand; AMFI occasionally moves paths |
| `SOURCE_EMPTY_BODY` / `SOURCE_IMPLAUSIBLY_SMALL` | A truncated body or an error page | **Not** parsed as a small day. Wait, then retry |
| `PARSE_FAILED` | The file could not be parsed at all | Almost certainly a format change. Engage a developer |
| `PARTIAL_BATCH` | Some chunks committed, some did not | Re-run. Committed rows are content-idempotent no-ops; the tail completes |
| `HIGH_REJECTION_RATE` alert | >5% of records rejected | **Format change, not bad data.** Inspect `ii_reference_import_rejections` |

The individual refused records are in `ii_reference_import_rejections` with the
source line number and an exact reason. A steady trickle of `MALFORMED_NAV` is
normal — AMFI genuinely publishes a handful of malformed `10.` values for
matured target-maturity funds (17 rows on 2026-09-15, 0.118%).

---

## 7. Backoff

After a failure the job sets `next_attempt_not_before` and refuses to start
before it: 15, 30, 60, 120, 240, then 360 minutes, **capped at 6 hours**. The
cap is deliberate — an outage lasting a week must not push the next attempt
into next month, and a stale failure on the operator surface is worse than a
repeated one. A success clears `consecutive_failures` to zero.

---

## 8. Corrections

When AMFI republishes a *different* NAV for a date it already published, PC6
does **not** overwrite. It:

1. inserts the new value as a new row, with `correction_of_id` pointing back;
2. marks the prior row `quality_status = 'superseded'` with `superseded_by_id`;
3. writes an `ii_reference_corrections` row recording both values.

So `ii_reference_corrections` is the full answer to "what changed, and when did
the source change its mind". A **manual** correction by an admin additionally
requires an actor id and a reason of at least 20 characters — enforced by a
CHECK, so a direct service-role insert cannot bypass it either.

---

## 9. Activating the production schedule — DEFERRED, HUMAN-PRESENT

**This mission did not do this and was not permitted to.** An autonomous agent
may not activate a production job. When a human decides to:

1. Confirm `0155` is applied to production and the app is deployed.
2. Create the Vault secret (never commit it):
   ```sql
   select vault.create_secret('<the CRON_SECRET value>', 'pc6_reference_ingest_cron_secret');
   ```
3. Register the schedule, replacing the origin placeholder:
   ```sql
   create extension if not exists pg_cron;
   create extension if not exists pg_net;

   select cron.unschedule('pc6-reference-ingest')
   where exists (select 1 from cron.job where jobname = 'pc6-reference-ingest');

   select cron.schedule(
     'pc6-reference-ingest',
     '30 3 * * 2-6',  -- 03:30 UTC Tue-Sat = after AMFI's ~23:00 IST publication
     $$
     select net.http_post(
       url := '<REPLACE_WITH_REACHABLE_APP_ORIGIN>/api/investment-intelligence/cron/pc6-reference-ingest',
       headers := jsonb_build_object(
         'Content-Type', 'application/json',
         'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'pc6_reference_ingest_cron_secret')
       ),
       body := '{"sourceConfigId":"amfi_nav_daily","jobKey":"pc6_amfi_daily_nav"}'::jsonb
     );
     $$
   );
   ```
4. Leave `enabled = false` for the first day and watch a `dryRun` result.
5. Flip the switch on (section 5) and check the first real batch.

To stop it again, prefer the kill switch (section 5) over `cron.unschedule` —
it leaves the schedule intact and records *why*.

---

## 9b. NAV 1 selective-historical-hydration schedule — DEFERRED, HUMAN-PRESENT

**Added 2026-09-21 (NAV 1 programme, `feature/nav1-selective-history-2026-09-21`).**
Same deferred-activation discipline as section 9, for the NEW job this
programme adds: `pc6_selective_historical_hydration`
(`ii_reference_job_control`, migration `0166`), which replaces the retired
brute-force `scripts/pc6_historical_nav_backfill.mjs` path. **This mission
did not activate this and was not permitted to.**

Prerequisite, per the job-control row's own `disabled_reason`: the
dependency-resolution query must be live-proven first. It has been — see
`docs/investment-intelligence/NAV1_PROGRESS_LEDGER.md`, NAV 1.26 (live-DEV
dry run against the real database, 2026-09-21). That satisfies the STATED
prerequisite for enabling; it is still a human-present decision to actually
flip the switch, per this mission's binding override.

1. Confirm migrations `0166`, `0167`, `0168` are applied to the target
   environment and the app is deployed.
2. Create the Vault secret — **reuse the SAME `pc6_reference_ingest_cron_secret`
   secret from section 9** if it already exists; do not create a second
   secret for the same `CRON_SECRET` value.
3. Register the schedule:
   ```sql
   create extension if not exists pg_cron;
   create extension if not exists pg_net;

   select cron.unschedule('pc6-selective-hydration')
   where exists (select 1 from cron.job where jobname = 'pc6-selective-hydration');

   select cron.schedule(
     'pc6-selective-hydration',
     '0 5 * * 2-6',  -- 05:00 UTC Tue-Sat = after the daily NAV job (03:30 UTC) has settled
     $$
     select net.http_post(
       url := '<REPLACE_WITH_REACHABLE_APP_ORIGIN>/api/investment-intelligence/cron/pc6-selective-hydration',
       headers := jsonb_build_object(
         'Content-Type', 'application/json',
         'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'pc6_reference_ingest_cron_secret')
       ),
       body := jsonb_build_object('changeoverDate', '2026-09-21', 'dryRun', true, 'maxInstruments', 50)
     );
     $$
   );
   ```
4. Leave `dryRun: true` in the body (as shown above) for the first several
   runs and inspect `per_instrument` in each response — confirm the
   dependency set and computed windows look sane against real production
   dependency data before any real fetch happens.
5. Flip `dryRun` to `false` in the cron body AND flip
   `ii_reference_job_control.pc6_selective_historical_hydration.enabled` to
   `true` (both are required — the route runs in dry-run mode regardless of
   the kill switch, and the kill switch blocks it regardless of the dry-run
   flag) only once satisfied with the dry-run output.
6. **Known limitation to resolve before large-scale enable**: this job's
   fetch-window sizing for a benchmark-only dependency is now bounded (see
   NAV 1.12, `navRetentionPolicy.ts`'s `BENCHMARK_LOOKBACK_DAYS`), but an
   ACCEPTED-STATEMENT dependency needing `complete_from_inception` still
   requests an unbounded single window back to `HISTORICAL_FLOOR_DATE`
   (2006-04-01). For a scheme with 15-20 years of history this is a large
   single TIGZIG request untested at that size — chunk it before enabling
   against a real inception-requiring dependency (NAV 1.26's own disclosed
   follow-up).

To stop it, prefer the kill switch (`ii_reference_job_control`) over
`cron.unschedule` — same reasoning as section 9.

---

## 10. The two blockers

**PO-PC6-1 — benchmark index data is licensed.** NIFTY index values belong to
NSE Indices Limited and SENSEX to BSE/Asia Index; neither is open data. The
legacy unauthenticated `niftyindices.com/Backpage.aspx` endpoint was re-probed
on 2026-09-15 and no longer returns data, so there is not even a technical
path. PC6 ships the entire benchmark master, mapping, history, TRI/PRI
discipline and correction machinery, and ingests **no** index level. Until a
licence exists, benchmark-relative metrics (active return, beta, alpha,
tracking error, information ratio, capture, and the SIP benchmark comparison)
correctly report `unavailable` rather than showing a guessed comparison.
`buildUrl()` throws if anyone tries to fetch a blocked source.

**PO-PC6-2 — no approved risk-free source.** Three defensible candidates are
documented in `lib/services/investment-intelligence/pc6/riskFreeSeries.ts` with
the argument for and against each: the RBI 91-day T-Bill cut-off, the 10-year
benchmark G-Sec yield, and the RBI policy repo rate. They differ by roughly
100–150 bp, which visibly moves every Sharpe and Sortino number. PC6 will not
choose one. The 16 existing rows in DEV self-describe as
`"DEV SEED — approximate ... (not a certified feed)"` and are neither promoted
nor deleted; `ii_risk_free_rates.is_certified` is `false` on every one of them.

Neither blocker prevents PC6's scheme-master and NAV work from going live.
