# NAV 1 — the daily job re-creates pre-changeover rows (findings and fix, 2026-10-01)

## Root cause

`lib/services/investment-intelligence/pc6/referenceIngestJob.ts` (the daily `amfi_nav_daily` / `NAVAll.txt` path)
wrote **every** parsed record: `parseNavAll` → `planImport` → `ii_prices_nav` upsert
(`onConflict: instrument_id,price_date`, `ignoreDuplicates`). There was no date test.

`NAVAll.txt` has one row per scheme: that scheme's **latest** NAV. A dormant, matured or wound-up scheme keeps
its final NAV there for years (dates back to 2008; here 2014 onward is the bulk). So each such scheme's single
stale row is inserted whenever it is missing, i.e. **re-created after any delete**. The NAV 1 retention policy
says the opposite: the daily job owns data on/after the changeover date C (2026-09-21); pre-C history is the
selective-hydration job's, only for instruments with a real dependency.

The row count is bounded (~1.3k — one per dormant scheme), which is why it survived unnoticed, but deleting
without fixing the writer is futile.

## Numbers (read-only against production `twwpnltizhtjxhamyoxt`, 2026-10-01)

- `ii_prices_nav`: 152,079 rows. `ii_nav_retention_policy`: one row, `nav1-0189-user-held`,
  `changeover_date 2026-09-21`, `environment production` (DEV has its own identical row).
- Residue (`price_date < 2026-09-21` and `created_at >= 2026-09-30`): **1,276 rows, 1,276 distinct instruments**,
  all with `data_version like 'pc6-amfi-parser-v1:%'` (the daily parser). By date: 4 before 2015, 532 in
  2015–2019, 734 in 2020–2025, **1,270 before 2026-09-01, 6 in 2026-09-01..09-20**. Oldest 2008-10-02.
- Protected set as the TypeScript filter computes it (same GET reads the filter issues): 19 held instruments,
  0 benchmark mappings, 0 report dependencies, 1 open hold, 0 merge links → 19 protected instruments.
  **0 of the 1,276 residue instruments are in it** — consistent with the live SQL verdict (all candidates).
- Held instruments' rows: 85,485 (19 instruments) — the figure the delete must not change.

**The 6 rows dated 2026-09-01..09-20 have the same cause.** They are the same parser (`data_version`
`pc6-amfi-parser-v1:*`, created 2026-09-30 03:32–03:52 by daily-window runs), for schemes whose latest published
NAV fell in that window (recently stopped publishing). The filter is purely date-based (`navDate < C`), so it
covers them exactly like the years-old ones.

## Fix (no migration)

- `dailyPreChangeoverFilter.ts` (new). After scheme resolution and **before** the exact-pair lookup and
  `planImport`, the daily path drops records that are (a) dated before C, (b) resolved to an instrument, and
  (c) **not protected**. They are not looked up, not planned, not counted as inserts.
  - **C** comes from the real policy row: `ii_nav_retention_policy` ordered by `activated_at desc limit 1` (each
    Supabase project is its own database and holds exactly its own environment's row). The daily route receives
    no changeover date (unlike the hydration cron body), so the job reads it itself.
  - **Fail open.** No policy row (DEV, tests), unreadable, malformed date, or any protection-read failure ⇒ no
    record skipped; behaviour identical to before. The reason is written to the batch notes
    (`pre_changeover_filter: {applied:false, reason, detail}`), so a filter that is not working is visible.
  - **Scope.** Only `source.kind === 'daily_nav' && format === 'amfi_navall_txt'`. The `scheme_master` path (same
    file, read as scheme identity) and the `amfi_navhistory_txt` path (backfill / hydration) are untouched.
  - **Unresolved records are not filtered**: they never write, and skipping them would hide a real
    instrument-master mapping gap from the `unresolved` count and its alert.
- `referenceIngestJob.ts`: loads the filter context in parallel with the resolution reads, applies it, adds the
  counter `counts.skippedPreChangeover`, writes `notes.skipped_pre_changeover` and
  `notes.pre_changeover_filter {applied, changeover_date, policy_version, skipped, kept_protected,
  kept_unresolved, protected_instruments}` to the batch row, and appends a sentence to the result `detail`
  when anything was skipped. `parsedAccepted`/`rows_accepted` still describe the file, not the plan.

## Does dropping a pre-C daily row lose data a protected instrument needs? (verified in code)

Claim from the brief: hydration also covers held instruments. Checked in
`selectiveHistoricalHydrationJob.ts` / `navRetentionPolicy.ts`:

- **Held instruments**: `userHeldInstrumentsToDependencies` gives every held instrument `historyCompleteness:
  null` ⇒ `determineHydrationRequirement` ⇒ hydrate from inception (floor 2006-04-01 or the recorded history
  floor) to `C − 1` via AMFI history (TIGZIG fallback). AMFI's history includes a dormant scheme's final NAV, so
  that row is recovered by hydration itself. (If the instrument has no rows at all, `existingEarliest` is null
  and the gap is `[floor, C−1]`.)
- **Benchmark-only instruments are the exception.** Hydration fetches them only over
  `BENCHMARK_LOOKBACK_DAYS` (~5 years + margin) before C. A dormant benchmarked scheme whose final NAV is older
  lies **outside anything hydration refetches**, while retention (`pc6_nav_row_is_candidate`) keeps its whole
  history. Dropping that row would break what retention promises. Likewise report-dependent instruments,
  instruments under an open hold, and merge-family members are protected by retention but not necessarily
  hydrated.
- **Decision**: do not filter protected instruments. The protected set mirrors the **same terms** as
  `pc6_nav_row_is_candidate` (0200): the shared `pc6_user_held_instrument_ids()` RPC (paged), any
  `ii_instrument_benchmarks` row, any `ii_report_nav_dependencies` row (instrument-level, slightly broader than
  the date-ranged SQL: conservative), open unexpired `ii_nav_retention_holds`, and the merge family of any of
  those (both directions, transitively, depth 8, from `ii_instruments` and `ii_scheme_master`). The pure TS
  mirror is checked against the SQL on production data above (none of the 1,276 residue instruments is in it),
  and the PGlite check proves the SQL side. Protected instruments keep writing their stale row exactly as
  before; the deletion predicate keeps it too, so nothing flaps.
- Reads added per run (only on the daily path, only when a policy row exists): 1 policy read, 1 paged RPC,
  3 small paged selects, 2 merge-link selects, all overlapped with the batch open and parse.

## Evidence

- New `tests/unit/nav1DailyPreChangeoverFilter.test.ts`: **16 tests, all pass**. Drives the real
  `runReferenceIngest` against the in-memory PostgREST stand-in: (a) skip + count + never looked up/sent, run
  record notes; (b) on/after C inserted (C itself included); (c) no policy / malformed policy / unreadable
  protection set / policy read error all fail open with a recorded reason; (d) `amfi_navhistory_txt` inserts
  pre-C rows, never consults the policy, no notes; (e) same-day rerun is a no-op, next day re-skips the same
  rows and adds only new current rows, partial/continuation runs never write a skipped row; (f) held, benchmark,
  report-dependent, open-hold and merge-family-of-held keep their stale row, while released-hold, expired-hold
  and plain dormant twins are skipped; unresolved count stays truthful; dry run reports the count.
- **Negative controls with named failures.** (1) In-test: a policy changeover of 2000-01-01 skips nothing. (2)
  Mutation run: commenting out the single line that applies the partition (`recordsToPlan = part.records`)
  fails 5 tests by name ((a), (b), (f), both idempotence tests); making the protection test always false
  fails 7 by name, including (f) and the pure partition test. Both mutations were reverted.
- `tests/unit/support/pc6IngestFakeDb.ts`: `rpc('pc6_user_held_instrument_ids')` now returns the chainable
  builder (seeded via table `rpc:pc6_user_held_instrument_ids`); all other RPC behaviour unchanged.
- Existing suites: `tests/unit/pc6*` + `tests/unit/nav1*` + `iiNavMarkToMarketGoldenFixtures`: **28 files,
  372 tests, all pass** (includes the 16 new).
- `scripts/nav1_residue_sql_pglite_check.mjs`: **25 PASS / 0 FAIL** for the cleanup SQL (see the runbook).
- `tsc --noEmit -p .` (6 GB heap): the only remaining error is
  `tests/unit/canonicalCertResidueAllSql.test.ts(127,75) TS18046 's.preUpdates' is of type 'unknown'` in a
  file this change does not touch and whose import graph does not include any changed file; every error that
  the FakeDb change briefly introduced (9 in `pc6IngestExactPairLookup.test.ts`) was fixed. tsc's exit code is
  therefore 2 because of that one pre-existing error, not 0.

## Other writers checked

- `navReconciliationSweep.ts` ingests NAVAll too, but only records with `navDate === publicationDate` (today), so
  it cannot create pre-C dormant rows (a deliberate backfill via `amfi_nav_history` is a different, intended path).
- The admin reference-data route calls `runReferenceIngest`, so it gets the same filter.
- `scripts/pc6_run_ingest.mjs` (hand-run) also goes through `runReferenceIngest`.

## Residual risks / not verified

- **Not verified: the next live daily run.** Counter value, added run time from the extra reads (small,
  overlapped, but not measured against production latency), and `applied = true` are checked by the runbook's
  step 3, not by the agent. The 18 s write budget is unchanged; the skip actually removes ~1.3k pairs from the
  exact-pair lookup and inserts.
- A scheme that becomes **held after** the daily job skipped its stale row is hydrated from inception by the
  hydration job (its final NAV included). If the provider cannot serve that scheme the hydration ledger records
  it; before this change the daily job's stale row would have masked that gap for exactly one date. This is the
  same contract as all other pre-C history, not new exposure.
- The protected set is read once per run; an instrument that becomes protected between that read and the write
  is covered by the next hydration pass, and the deletion predicate itself is evaluated live.
- If the retention policy row is ever absent in production the job silently reverts to the old behaviour (fail
  open, by design, visible in `notes.pre_changeover_filter`). A policy with a **later** `activated_at` and a
  different `changeover_date` would be honoured as the new C.
- The cleanup SQL is validated on PGlite with the real 0200 predicate on synthetic rows; its production
  duration is an estimate.
- tsc exit code is 2 because of the one unrelated pre-existing error above.

## Recommended order

merge → Amplify deploy confirmed (note time **T**) → a daily run after **T** shows
`pre_changeover_filter.applied = true` and `skipped_pre_changeover > 0`, and no new pre-C candidate rows →
`01` → `02` → `03`. Details: `docs/nav1/po_run_2026-10-01_residue/README.md`.
