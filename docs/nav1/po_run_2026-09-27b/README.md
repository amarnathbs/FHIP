# NAV 1 — PO decision #1 (27 Sep 2026): daily reconciliation. PO-run pack.

**Brief implemented:** the PO's exact decision recorded 27 Sep 2026 — keep the
existing bounded/resumable daily-collection window, run it every day
(including Sunday and Monday), and add a second, shorter reconciliation
window that fetches only missing/incomplete scheme/date pairs for the current
publication date. See the branch's commit messages and
`lib/services/investment-intelligence/pc6/navReconciliationSweep.ts` for the
full design rationale.

**This session's access:** production read-only (GET only). Nothing in this
pack has been applied anywhere by this session. Everything below is for the
PO to run, in the stated order.

## What changed vs the certified 27 Sep baseline (`origin/main` = `d7e0ae7`)

| # | File | What it does |
|---|---|---|
| 1 | `supabase/migrations/0220_nav1_daily_window_all_days.sql` | Changes the daily-NAV cron's day-of-week from `2-6` (Tue–Sat) to `*` (every day). Same times, URL, secret, timeout. |
| 2 | `supabase/migrations/0221_nav1_reconciliation_sweep_foundation.sql` | New tables `ii_reference_publication_coverage` (the "complete" flag) and `ii_reference_coverage_alerts` (the queryable coverage_alert row); adds `nav_reconciliation` to the batch_kind CHECK; inserts a new job-control row `pc6_amfi_daily_nav_reconciliation` (ships **enabled**, since this migration IS the PO's authorization). |
| 3 | `supabase/migrations/0222_nav1_schedule_reconciliation_window.sql` | Schedules `pc6-nav-reconciliation`, 10:00–10:16 UTC every 2 minutes, every day (9 calls/day). |
| 4 | `app/api/investment-intelligence/cron/pc6-nav-reconciliation/route.ts` (code, deployed by merge, not by SQL) | The new route the schedule calls. |

All three migrations are **production-only guarded** exactly like 0193/0194/0202/0205/0220 itself: applying any of them to DEV or a fresh database is a documented no-op (a `NOTICE`, nothing scheduled). They are also **idempotent**: re-running any of them is a clean no-op (PGlite-proven — see `scripts/nav1_022{0,1,2}_pglite_verification.mjs`, 78/78 PASS combined).

## Deploy order (this is the safe order — do not reorder)

1. **Merge this branch to `main`** (adds the new route + service code; no migration is bundled into the merge — migrations are separate, PO-run files, as everywhere else in this programme).
2. **Wait for the Amplify deploy to reach SUCCEED** (the new route must exist before its cron job can call it).
3. **Apply `0220` to production** (safe at any point — it only changes which days the EXISTING, already-deployed daily-NAV route is called on; nothing about it depends on the new route).
4. **Apply `0221` to production** (creates the tables and the job-control row the new route depends on).
5. **Apply `0222` to production LAST** (schedules the new route) — only once steps 2 and 4 are both done, so the very first scheduled call at 10:00 UTC finds a deployed route and an existing job-control row.

If `0222` is somehow applied before the code is deployed, the 10:00 UTC tick would get a 404/500 from Amplify; this self-heals via the job's own backoff (no data risk — the schedule only adds a URL call, it runs no query itself), but there is no reason to take that risk when the order above avoids it entirely.

**Combined convenience file:** `PROD_APPLY_0220_0221_0222.sql` in this folder concatenates all three in the correct order with section markers, for pasting into the Supabase SQL editor in one go, run only after step 2 (Amplify SUCCEED) above.

## After applying: verify

Run `PROD_VERIFY_readonly.sql` in this folder (SELECT-only). Check for:
- both daily-NAV jobs' `schedule` column reads `... * * *` (not `2-6`);
- `pc6-nav-reconciliation` exists, `schedule = '0-16/2 10 * * *'`;
- `ii_reference_job_control` has a row for `pc6_amfi_daily_nav_reconciliation`, `enabled = true`;
- `ii_reference_publication_coverage` and `ii_reference_coverage_alerts` exist and are empty (correct — nothing has run yet).

Then, at or after 10:05 UTC the next day this schedule is live, check:
```sql
select * from ii_reference_publication_coverage order by publication_date desc limit 5;
select * from ii_reference_coverage_alerts where resolved_at is null;
```
A `complete = true` row for the prior day with no open alert is the expected steady state.

## The one-off backfill (run ONLY after the migration and code are both deployed)

`scripts/nav1_backfill_weekend_and_late_2026_09_27.mjs` — see that file's own header for
full usage. It re-uses the reconciliation mechanism itself (calls the
deployed `pc6-nav-reconciliation` route with `sourceConfigId: 'amfi_nav_history'`,
which serves a genuine single-day report for any past date, unlike
NAVAll.txt) against three fixed historical dates:

- `2026-09-25` — the ~67 schemes that published after the old 04:30 UTC cutoff that day;
- `2026-09-26` (Saturday) and `2026-09-27` (Sunday) — the ~600–700 liquid/overnight
  schemes AMFI publishes on weekends, never collected before 0220.

It is **idempotent** (safe to re-run: a date already fully covered costs one
cheap "nothing missing" check and writes nothing) and it is a thin CLI wrapper
around the exact same `runNavReconciliationSweep` job the schedule calls — not
a bespoke one-off script. Run it with `--confirm` after both the code deploy
and migrations 0220–0222 are live; it refuses to run without that flag and
without `CRON_SECRET`/`NAV1_PROD_URL` in the environment.

## The abandoned migration `0202`

**Never apply `0202` under any name, on any branch, to any database.** It is
permanently superseded by `0204`+`0205` (see 0205's own header). `origin/main`
does not contain it. A loose copy still exists at
`supabase/migrations/0202_nav1_nav_schedules_http_timeout.sql` on the
**unmerged** branch `fix/nav1-production-completion-2026-09-25` (tip
`6199281` at the time of this check, 27 Sep 2026) — that branch's own history
was never rewritten when its OTHER commits were cherry-picked into `main` as
`bc47a9f`. This session did not touch that branch (per the no-broad-resets,
other-branches-are-off-limits rule). See
`docs/nav1/NAV1_0202_ABANDONED_STATUS_2026-09-27.md` for the full note; the PO
or that branch's owner should delete the file there or mark it abandoned in
a commit on that branch.
