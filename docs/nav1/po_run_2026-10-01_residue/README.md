# NAV 1 — daily-job pre-changeover residue: cleanup runbook (2026-10-01)

**What this is.** After the Stage E cleanup, 1,276 rows in production `ii_prices_nav` fail the live deletion
predicate `pc6_nav_row_is_candidate()` (migration 0200). All were re-created on/after 2026-09-30 by the
**daily AMFI job** from dormant schemes' years-old final NAVs in `NAVAll.txt` (1,270 dated before 2026-09-01,
6 dated 2026-09-01..09-20). The job now skips such records (branch
`fix/nav1-daily-skip-pre-changeover-20261001`); these files remove the rows already there.
Root cause and evidence: `docs/nav1/NAV1_Daily_Job_Pre_Changeover_Residue_2026-10-01.md`.

**The one rule: the delete (`02`) must run AFTER the fix is deployed — never before.** Before the fix, the
next daily run re-inserts every row you delete.

## Files (run in the Supabase SQL Editor, project `twwpnltizhtjxhamyoxt`)

| File | Writes? | Purpose |
|---|---|---|
| `01_verify_before_delete.sql` | no | Preconditions, the residue classified, the held-rows baseline. |
| `02_delete_residue.sql` | **yes** | One `DO` block = one transaction. Deletes only rows that are live `pc6_nav_row_is_candidate` AND `price_date < 2026-09-21` AND `created_at >= 2026-09-30 00:00 UTC`. Self-checks refuse/roll back on any anomaly. Idempotent. |
| `03_verify_after_delete.sql` | no | Proves 0 candidates remain, held rows untouched, and shows what the daily job reports. Also the recurring health check. |

`scripts/nav1_residue_sql_pglite_check.mjs` replays the whole migration chain in PGlite (real 0200 predicate) and
proves these three files on synthetic rows: 25 PASS / 0 FAIL, including negative controls (a date-only delete
would have removed held/open-hold rows; each self-check refuses and deletes nothing).

## Order of operations

1. **Merge** `fix/nav1-daily-skip-pre-changeover-20261001` to `main` (human decision; not done by the agent).
2. **Confirm the Amplify deployment** of that commit finished successfully. Note the UTC time it finished: **T**.
   No migration is part of this change (nothing to apply in Supabase).
3. **Wait for a daily run that ran the new code, and confirm it.** The daily window is 03:30–04:30 UTC
   every day (migrations 0205/0220). In the SQL Editor run `03_verify_after_delete.sql`, result set **5**:
   - the latest `daily_nav` batches started after **T** must show `pre_changeover_filter.applied = true`,
     `changeover_date = 2026-09-21`, and `skipped_pre_changeover` > 0 (expect roughly 1,276 plus any scheme that
     has gone dormant since; certainly not 0, and not many thousands);
   - result set **6** (set its timestamp to **T**) must be **0**: the daily parser wrote no new pre-changeover
     candidate row after the deploy.
   - If the deploy landed after that day's window had already completed, the remaining ticks that day answer
     `skipped_unchanged_source` (same file) and show no counter: wait for the next calendar day's first run.
   - `applied = false` means the filter failed **open** and the reason is in the same JSON
     (`no_policy`, `invalid_policy`, `policy_read_failed`, `protection_read_failed`). Do **not** delete;
     report it.
4. **Run `01_verify_before_delete.sql`.** Expect: `held_instruments_expect_19_or_more_and_never_0` ≥ 19,
   `running_batches_expect_0` = 0, `residue_rows` = `candidate_rows` ≈ 1276 (`protected_rows` = 0),
   `before_2026_09_01` ≈ 1270, `sep_01_to_20` ≈ 6. Record `total_nav_rows` (152,079 at time of writing,
   before any daily growth) and the held-rows baseline (85,485 for 19 instruments). Stop and report if
   `protected_rows` ≠ 0 or `candidate_rows` ≠ `residue_rows`.
5. **Run `02_delete_residue.sql`** outside 03:25–04:45 UTC (daily window) and outside the `:00`/`:30`
   hydration ticks if you can (it is a short, single transaction; a clash only makes the held-rows
   self-check trip, which rolls everything back harmlessly — just re-run). It prints a NOTICE
   `NAV1 residue delete OK: N rows matched, N deleted, held-instrument rows X -> X (unchanged)` (the Editor
   may not display notices; `03` is the proof either way).
6. **Run `03_verify_after_delete.sql`.** Expect result sets 1 and 2 = 0, held rows ≥ 85,485 and not lower
   than the baseline from step 4, total = previous total − rows deleted + any growth since.

## Why one transaction, not batches

1,276 rows is tiny (Stage E needed 500-row batches for ~22 million). Migration 0201's self-FK indexes exist in
production, so a delete costs an index probe per row, not a table scan; the slow part is the predicate itself
(a few ms per row), so roughly 5–20 s in total against a 120 s `statement_timeout`. A single transaction has a
real advantage here: every self-check inside it either passes or the whole thing rolls back, with nothing half
deleted to reason about. Batching would only matter for a far larger set — and the 1,500-row ceiling in `02`
refuses anything larger precisely because a larger set would mean something other than this residue.

## Safety properties (all exercised in the PGlite check)

- The predicate is evaluated **live inside the DELETE**; a row that became protected since `01` ran is skipped.
- `created_at >= 2026-09-30` confines the delete to the known residue window; older pre-changeover rows are not
  touched even if they are candidates (`01` result set 3 tells you if any exist — report, do not widen).
- No held instrument's row can be deleted: the predicate protects them, and `02` additionally aborts (rollback) if
  any deleted row belongs to a held instrument or the held-instruments' row count differs before/after.
- Refuses (raises, deletes nothing) when: the predicate cannot see holdings (held set empty, e.g. an
  RLS-restricted caller), the production policy row is not `changeover_date = 2026-09-21`, or more than 1,500
  rows match.
- No backup table is proposed: the rows are a pure copy of AMFI's published `NAVAll.txt` (re-creatable, and
  re-created automatically by any un-fixed daily run); the deletion is of rows the retention policy already
  classifies as deletable.

## Afterwards — a read-only count any time

```sql
-- expect 0 at any time after step 6 (the daily job no longer writes these)
select count(*) from ii_prices_nav p
where p.price_date < date '2026-09-21'
  and p.instrument_id not in (select instrument_id from pc6_user_held_instrument_ids())
  and pc6_nav_row_is_candidate(p.instrument_id, p.price_date, date '2026-09-21');
```

If this ever goes non-zero again: check `03` result set 5 for `applied = false` runs first (filter failed open),
then whether a new non-daily writer exists.

## Not verified by the agent (needs the live run)

- The effect of the next live daily run (counter value, run time with the extra reads, `applied = true`).
- That `02` runs to completion within the SQL Editor's own limits (verified only against PGlite and the real 0200
  predicate on synthetic rows; production timing is an estimate).
