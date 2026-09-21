# NAV 1 — Selective Historical NAV Retention: Progress Ledger

Governing document: `FHIP_NAV_Selective_History_Master_Prompt_250_Pages.docx` (Version 1,
21 September 2026), extracted to
`nav_selective_extract.txt` for this session. This ledger uses the exact
template the workbook specifies (line ~179 of the extraction): Package,
Revision and environment, Requirement/scenario ID, Implementation paths and
migration IDs, Execution command or manual procedure, Expected result,
Observed result and timestamp, Evidence reference, Status, Remaining risk
and next action, Authority needed only if genuinely missing.

**Branch**: `feature/nav1-selective-history-2026-09-21`, built off `origin/main`
at `a193583`, cherry-picking `237a2f8` (retry-with-backoff) and `059a900`
(RangeError fix) from `fix/pc6-backfill-retry-2026-09-20`.

**Session environment constraint, stated up front**: this session's sandbox
has no DEV or production Supabase credentials (`.env.local` does not exist;
only `.env.example` is present, and no `DATABASE_URL`/`SUPABASE_*` service
keys are set). Every requirement below that needs a live database query
against DEV or production is marked BLOCKED for that reason, consistent with
this repository's established pattern for this constraint (see 0155's own
"APPLICATION STATUS: NOT APPLIED" note — the same DDL/data access gap this
session independently re-confirmed). Everything markable as PASS below is
either (a) a fact discoverable from committed code/schema, (b) a unit test
or PGlite-replayed Postgres assertion actually executed in this session, or
(c) a live third-party HTTP call actually made from this session's own
sandbox (explicitly NOT the FHIP production runtime network path — see NAV
1.15/1.18).

---

## NAV 1.01 — Mandate and execution authority

- **Status**: PASS (discovery only; no code change)
- **Observed result**: Two explicit PO decisions confirmed from the dispatch
  brief: changeover date C = 2026-09-21; retroactive application of the new
  policy to already-loaded data is authorized for dry-run/candidate-manifest
  work, NOT for actual deletion (explicit stop point before NAV 1.43
  execution). This session has standing DEV-build authority and no
  production-write authority (consistent with every prior PC6 dispatch).
- **Authority needed only if genuinely missing**: production deletion
  execution (NAV 1.43) — explicitly out of scope for this dispatch by
  design, not a gap.

## NAV 1.02 — Repository and environment discovery

- **Status**: PASS
- **Implementation paths**: `lib/services/investment-intelligence/pc6/**`,
  `lib/config/investment-intelligence/pc6ReferenceSources.ts`,
  `scripts/pc6_historical_nav_backfill.mjs`,
  `supabase/migrations/0155_pc6_reference_market_data_foundation.sql`.
- **Observed result** (real findings, not assumed):
  - `origin/main` HEAD before this branch: `a193583` (migrations to `0164`).
  - `fix/pc6-backfill-retry-2026-09-20` (`origin/fix/pc6-backfill-retry-2026-09-20`)
    adds exactly 2 commits on top of `a193583`: `237a2f8` (retry-with-backoff
    + failed-chunk recovery) and `059a900` (fixes a V8 `RangeError: Set
    maximum size exceeded` from a flat `Set<"id|date">` at ~21.8M keys,
    replaced with `Map<instrumentId, Set<date>>`). Both cherry-picked onto
    this branch.
  - **Root cause of the over-fetch, confirmed from code, not guessed**:
    `scripts/pc6_historical_nav_backfill.mjs`'s own header claims it is
    "scoped ONLY to instruments this deployment already has resolved...
    importing NAV history for schemes nobody holds would be pointless." This
    was true when written, but `referenceIngestJob.ts`'s own comment records
    that "the full AMFI universe now has 14,358 resolvable instruments" —
    i.e. the PC6 scheme-master ingestion (commit `a193583`, "expanding to
    the full AMFI universe") deliberately creates an `ii_instruments` row
    for **every** AMFI scheme as global reference data (correct and cheap —
    it is dimension data, not a time series). The backfill script's
    "resolved instrument" filter therefore no longer selects "schemes
    someone holds" — it now selects "every AMFI scheme that exists" because
    the reference catalogue itself is complete. This is the actual mechanism
    that grew production to 6.26GB+: not a bug in the loop logic, but a
    filter whose selectivity assumption silently stopped holding once a
    separate, correct piece of work (full scheme-master coverage) shipped.
  - Migration-number freshness (scanned all 150+ remote branches via
    `scripts/check-migration-versions-against-branch.mjs`'s own listing
    approach): max is `0165` on
    `origin/feature/admin-a2-a5-master-execution`
    (`0165_admin_a4_canonical_audit_and_security_event_sink.sql`), not `0164`
    as `origin/main` alone would suggest. This migration is numbered `0166`
    accordingly. `check-migration-versions-against-branch.mjs --against=origin/main`
    and `--against=origin/feature/admin-a2-a5-master-execution` both report
    zero collisions for this branch.
  - Collision-guard tool confirmed at `scripts/check-migration-versions-against-branch.mjs`
    (and single-branch `scripts/check-migration-versions.mjs`).
  - `AGENTS.md` read in full: its only mandatory clause concerns
    `app/(app)/admin/**` and Admin RLS/RPC — not triggered by this dispatch
    (no admin surface changed).
- **Evidence reference**: `git log`, `git ls-tree` output this session; code
  comments cited above are verbatim from the repository.

## NAV 1.03 — Safe pause of the running backfill

- **Status**: PARTIAL / BLOCKED for live confirmation, PASS for the
  mechanism built
- **Implementation paths**: `scripts/pc6_historical_nav_backfill.mjs`
  (kill-switch pre-flight check added), `supabase/migrations/0166_nav1_selective_retention_foundation.sql`
  (new `pc6_full_universe_historical_backfill` job-control row, ships
  `enabled=false`).
- **What was built**: the script now refuses to run at all — for both a
  fresh invocation and `--retry-failed` — unless
  `ii_reference_job_control.pc6_full_universe_historical_backfill.enabled = true`.
  It previously had no kill switch of any kind (it is hand-run, not
  cron-run, so it never went through 0155's existing job-control check).
  Re-enabling it now requires an operator to deliberately flip that one row.
- **What could NOT be verified live**: whether the process the user was
  running in a separate terminal (`D:\fhip-fdh10-terminal`) actually stopped
  after the requested Ctrl+C, and whether `ii_prices_nav`'s row count is
  still climbing in production. This session has no production database
  credentials to check either fact.
- **Remaining risk and next action**: **the user must independently confirm,
  from that terminal or from Supabase's own dashboard, that no
  `pc6_historical_nav_backfill.mjs` process is still running against
  production** before relying on "it's paused" as a fact. This ledger does
  not claim that confirmation — it only reports that the script can no
  longer be *re-invoked* without an explicit re-arm, going forward.
- **Authority needed only if genuinely missing**: none for the code change
  (additive, disabled by default); live confirmation needs the user's own
  access to the other terminal/Supabase dashboard, which this session does
  not have.

## NAV 1.04 — Separate historical and daily scheduling

- **Status**: PASS (design + migration), BLOCKED (activation)
- **Implementation paths**: `supabase/migrations/0166_...sql` adds a new
  `pc6_selective_historical_hydration` job-control key, entirely separate
  from the existing `pc6_amfi_daily_nav` (0155) which this migration does
  not touch. The full-universe backfill's kill switch (NAV 1.03) is a third,
  independent key. Three genuinely separate switches now exist: daily
  (existing, untouched), selective historical (new, not yet built —
  NAV 1.26), full-universe brute force (new, disabled, superseded).
- **Remaining risk and next action**: `pc6_amfi_daily_nav` itself still
  ships disabled per 0155's binding override ("no production schedule may be
  activated by an autonomous agent"). Activating all-live daily collection
  from C onward (workbook requirement 2) is a deferred human-present step,
  unchanged by this dispatch — this migration does not flip it, by design.

## NAV 1.05 — Database space and cost baseline

- **Status**: BLOCKED — no DEV/production credentials in this sandbox.
- **Next action**: the user (or an agent with real credentials) should run,
  against production: `select pg_size_pretty(pg_total_relation_size('ii_prices_nav'))`
  and `select count(*) from ii_prices_nav`, plus Supabase's own dashboard
  disk-usage panel, and record the result in this ledger's evidence
  reference before Stage D/E proceeds.

## NAV 1.06 — Consumer and calculation inventory

- **Status**: PASS
- **Observed result**: grepped every `ii_prices_nav` consumer in the
  codebase (`grep -rl "ii_prices_nav"`, TypeScript only):
  `lib/services/investment-intelligence/analyticsRepository.ts` (XIRR/TWR/
  benchmark comparison — the primary performance-engine consumer),
  `lib/services/investment-intelligence/r5Repository.ts` (SIP/X-Ray),
  `lib/services/investment-intelligence/taxRepository.ts` (FIFO tax-lot
  cost basis), `lib/services/investment-intelligence/overviewSummary.ts`,
  plus the PC6 ingest job itself and the admin reference-data-quality route.
  `analyticsRepository.ts` reads `ii_portfolio_truth_status` (with `status`
  and `history_completeness`) and `ii_transactions` (excluding `status IN
  ('reversed','review_required')`) — this is the real schema binding used in
  the NAV 1.07 policy engine below.
- **Evidence reference**: grep output this session.

## NAV 1.07 — Retention policy and changeover date

- **Status**: PASS (policy engine built and unit/PGlite tested);
  PARTIAL (activation deferred)
- **Implementation paths**:
  `lib/services/investment-intelligence/pc6/navRetentionPolicy.ts` (pure TS
  policy engine), `tests/unit/pc6NavRetentionPolicy.test.ts` (9 tests),
  `supabase/migrations/0166_...sql` section 5
  (`pc6_nav_row_is_candidate()` SQL function, the same logic re-expressed
  for the database), `scripts/nav1_0166_pglite_verification.mjs` (proves the
  SQL function reproduces the same boundary examples as the TS tests, on a
  full 0001..0166 chain replay).
- **Execution command**: `npx vitest run tests/unit/pc6NavRetentionPolicy.test.ts`
  → 9/9 PASS. `node scripts/nav1_0166_pglite_verification.mjs` → 17/17 PASS.
- **Observed result and timestamp**: both run 2026-09-21, this session; full
  output captured in this dispatch's tool transcript and in
  `scripts/nav1-0166-pglite-results.json`.
- **Real schema bindings discovered** (see `navRetentionPolicy.ts` header for
  full detail):
  - `needed_by_accepted_statement_history`: `ii_portfolio_truth_status.status
    IN ('certified','certified_with_warnings')`, window driven by
    `history_completeness` (`complete_from_inception` /
    `complete_from_known_opening_balance` / `partial_history` /
    `holdings_only`), using `ii_transactions.transaction_date` (excluding
    `status='reversed'`) or `ii_holding_snapshots.as_of_date` as the lower
    bound.
  - `needed_by_benchmark_dependency`: `ii_instrument_benchmarks` (any row,
    current or historical).
  - `pinned_by_report_or_revision`: **genuine, disclosed gap** — `report_snapshots`
    (migration `0010`) stores `source_as_of_date` and a generic
    `payload_hash`, not NAV `(instrument_id, price_date)` identity. There is
    currently no mechanism in this repository that records which NAV rows a
    rendered investment report actually used. The policy engine and the SQL
    function both **fail closed** on this predicate (treat every row as
    report-pinned/protected) until this gap is closed for real — see
    NAV 1.35 below.
  - `protected_by_active_hold`: new `ii_nav_retention_holds` table
    (whole-instrument scope, documented as a deliberate choice).
- **Remaining risk and next action**: activating a real `ii_nav_retention_policy`
  row (`changeover_date = 2026-09-21`, `environment = 'production'`) is a
  separate, explicit closure step this migration deliberately does not do —
  the table ships empty.

## NAV 1.08 — Scheme catalogue and live universe

- **Status**: PASS (discovery)
- **Observed result**: `ii_scheme_master` (migration `0155`) is
  effective-dated, one open row per `(country_code, amfi_scheme_code)`,
  `lifecycle_status IN ('active','closed','merged','suspended','unknown')`.
  "Live" = `lifecycle_status='active'` AND an open (`effective_to IS NULL`)
  row. This is the binding NAV 1.27 (all-live daily ingestion) should use to
  decide which schemes the daily job must cover, independent of any
  holdings/dependency status.

## NAV 1.09 — Accepted statement scheme dependencies

- **Status**: PASS (discovery + implemented as part of NAV 1.07's policy
  engine — see above; not logged as a separate package since the binding
  itself IS the NAV 1.07 deliverable).

## NAV 1.10 – 1.13 — Scheme identity resolution / lifecycle / calculation-driven
history planning / dates and calendars

- **Status**: NOT STARTED this dispatch. `schemeMasterWriter.ts` and
  `amfiParser.ts` already implement identity resolution and lifecycle fields
  (existing PC6 work, not new). Calculation-driven history planning (how far
  back a rolling-return window must reach) needs `analyticsRepository.ts`'s
  actual rolling-window logic read in depth, which this dispatch did not
  reach.

## NAV 1.14 — Provider-neutral adapter contract

- **Status**: PASS
- **Implementation paths**: `lib/services/investment-intelligence/pc6/adapters/historicalNavAdapter.ts`
  (contract: `HistoricalNavAdapter`, `HistoricalNavRequest`,
  `HistoricalNavResult`/`HistoricalNavFailure`, `CoverageStatus`).
  Deliberately returns normalized candidate data only — canonical promotion
  stays in `referenceImportRunner.ts`'s existing `planImport`/quality-status
  machinery, not duplicated here.

## NAV 1.15 — TIGZIG historical adapter

- **Status**: PASS (adapter built and unit-tested); PARTIAL (qualification —
  sandbox-only, not production-runtime)
- **Implementation paths**: `lib/services/investment-intelligence/pc6/adapters/tigzigHistoricalAdapter.ts`,
  `lib/services/investment-intelligence/pc6/httpFetchWithRetry.ts` (retry
  utility extracted from the proven `237a2f8` backfill-script pattern —
  exponential backoff, HTML-block-page detection), config entries added to
  `lib/config/investment-intelligence/pc6ReferenceSources.ts`
  (`tigzig_nav_history`, `enabled: false`).
- **Execution command**: this session issued a live `GET` to
  `https://api.tigzig.com/mf/v1/nav?scheme=119551&since=2026-09-14&to=2026-09-18`
  (2026-09-21) and received a genuine 200 response: `scheme_name "Aditya
  Birla Sun Life Banking & PSU Debt Fund - DIRECT - IDCW"`, ISIN
  `INF209KA12Z1`, 4 observations (15–18 Sep 2026), consistent with the
  workbook's own prior-recorded result for the same request. The actual base
  API host is `api.tigzig.com` (the workbook's listed URL,
  `https://www.tigzig.com/apis/mf-nav`, is the documentation page, not the
  API host — a real discrepancy worth recording). Unit tests
  (`tests/unit/pc6HttpFetchWithRetry.test.ts`,
  `tests/unit/pc6TigzigHistoricalAdapter.test.ts`) use this exact observed
  response as a fixture: 13 tests, all PASS.
- **CAVEAT, stated plainly**: this request was issued from this session's
  own generic sandbox fetch tool, **not** from FHIP's actual deployed
  runtime (Vercel/Amplify/Supabase-edge network path), and did not carry
  FHIP's production egress IP or the adapter's own `User-Agent`. A
  network-layer restriction that only affects the real runtime (firewall,
  WAF allowlist) would not be visible from here. This is explicitly NOT a
  production qualification.
- **Remaining risk and next action**: NAV 1.18 must re-run this exact
  request from the deployed FHIP environment (e.g. a one-off Vercel/Amplify
  function invocation or a DEV-environment script run with real network
  egress) before TIGZIG is called qualified for production use.

## NAV 1.16 — mfnav fallback adapter

- **Status**: NOT QUALIFIED, by design — no adapter built.
- **Observed result**: the workbook's own prior record is HTTP 403 from a
  research environment. This session did not attempt a fresh request: an
  already-known-403 endpoint gains nothing from a repeat sandbox test (a 403
  there proves nothing about the real FHIP network path either, so no false
  qualification signal was manufactured). Registered in
  `pc6ReferenceSources.ts` as `mfnav_fallback_history`, `enabled: false`,
  with the honest status recorded in its `notes` field.
- **Next action**: test from the real FHIP network path per the workbook's
  own instruction ("test the real FHIP network path without bypassing
  access controls"), which this dispatch cannot do.

## NAV 1.17 — AMFI daily feed adapter

- **Status**: N/A for this dispatch — already exists and is unchanged
  (`amfi_nav_daily` in `pc6ReferenceSources.ts`, `referenceIngestJob.ts`).
  The workbook's requirement 6 says "preserve the existing daily source
  where valid"; nothing in this dispatch's findings suggests it is invalid.

## NAV 1.18 — Provider qualification and accuracy sampling

- **Status**: PARTIAL — see NAV 1.15/1.16. Full qualification (accuracy
  sampling against AMFI's own NAVHistoryReport for a statistically
  meaningful sample, from the real runtime) NOT STARTED.

## NAV 1.19 – 1.41 — remaining foundation/sourcing/analytics/rollout packages

- **Status**: NOT STARTED this dispatch, with the exception of the pieces
  folded into NAV 1.07/1.14/1.15 above. This is an honest scope
  acknowledgement: a 48-package, 250-page workbook is not completable with
  real evidence in a single dispatch, especially with no DEV/production
  database access available. The pieces above were chosen because they are
  (a) genuinely blocking for everything downstream (the policy contract) or
  (b) directly responsive to the two most urgent named risks (the running
  backfill, and provider qualification honesty).

## NAV 1.42 — Retention dry run and candidate manifest

- **Status**: PASS (tooling built), BLOCKED (not executed against real data)
- **Implementation paths**: `scripts/pc6_nav1_retention_dryrun_manifest.sql`
  — three read-only `SELECT` sections: headline sizing, per-instrument
  candidate manifest (joined to scheme identity for human review), and a
  zero-overlap proof against every protected condition.
- **Execution command**: not run — requires migration `0166` applied to a
  real database plus live credentials, neither of which exist in this
  sandbox. **Handed over for the user/operator to run against DEV first,
  then production, once `0166` is applied.**
- **Remaining risk and next action**: this file's `date '2026-09-21'` inline
  default must be double-checked against the real `ii_nav_retention_policy`
  row (NAV 1.07 activation) before trusting its output on production.

## NAV 1.43 — Controlled historical deletion

- **Status**: EXPLICITLY NOT ATTEMPTED — this is the dispatch's own named
  stop point.
- **Reason**: per the dispatch's explicit instruction, actual DELETE
  execution requires (a) migration `0166` applied, (b) NAV 1.42's manifest
  run for real against production and reviewed, (c) verified backup/restore
  recovery proof (NAV 1.45 — also not attempted, no production access), and
  (d) one further explicit go-ahead from the user with the concrete manifest
  in hand. None of (a)-(c) exist yet. No DELETE statement has been written,
  drafted, or executed anywhere in this dispatch.

## NAV 1.44 – 1.48 — Physical disk reclamation / disaster recovery /
certification / rollout / final handover

- **Status**: NOT STARTED — all depend on NAV 1.42/1.43/1.45, which are
  blocked or deliberately stopped above.

---

## Cross-cutting notes

- **npm dependencies**: this git worktree had no `node_modules` (a fresh
  worktree checkout); `npm install --no-audit --no-fund --prefer-offline`
  was run once this session to enable `vitest` and the PGlite verification
  scripts.
- **Files this dispatch left untouched but is aware of**: the huge
  `_tmp_*.sql` / `_tmp_check_*.sql` scratch-file list visible in a
  differently-branched worktree's `git status` (per the conversation's
  initial context) belongs to unrelated prior sessions on
  `feature/admin-a2-a5-master-execution`, not this branch or this dispatch.
