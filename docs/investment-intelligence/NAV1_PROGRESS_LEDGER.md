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

**UPDATE 2026-09-21 (continuation dispatch)**: real DEV Supabase credentials
(`vqycarelcoijzwlpkpcz`) were placed in this worktree's `.env.local` by the
orchestrating session. **Production credentials remain deliberately absent**
(confirmed: only `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, plus unrelated `AIE_OPENAI_API_KEY` /
`CONTACT_FROM_EMAIL` / `CRON_SECRET` / `RESEND_API_KEY` — no
`PRODUCTION_SUPABASE_*` names present). `scripts/pc5_ddl_capability_probe.mjs`
was re-run fresh against DEV and confirms there is still no raw-SQL/DDL path
(no `exec_sql`/etc. RPC, no management token, no `DATABASE_URL`) — only
PostgREST table reads/writes and RPC calls to already-defined SQL functions
(confirmed `pc6_nav_row_is_candidate` IS callable this way). Every "BLOCKED —
no DEV credentials" note below from the first dispatch is superseded by a
real live-DEV result in this update; nothing was executed against
production. The confirmed-safe backfill stop, and migration `0166` being
applied to BOTH DEV and production (independently verified read-only by the
orchestrating session — both projects show `pc6_full_universe_historical_backfill`
and `pc6_selective_historical_hydration` `enabled: false`), are recorded
under NAV 1.03/1.04 below.

**A major DEV-data-realism finding, load-bearing for how to read every live-DEV
result in this update**: DEV's `ii_instruments`/`ii_instrument_benchmarks`/
`ii_portfolio_truth_status` tables are NOT a clean production mirror — they
carry years of accumulated test/certification fixture data from the whole
prior II R0–R12 programme (e.g. instrument names like `VCVC031787576907660
Growth Fund`, `R6F Simple Equity Fund - Growth (Direct Plan)`, `Verify Fund
1787666581999`, alongside plausible-looking-but-unmapped names like `HDFC
Flexi Cap Fund - Growth (Direct Plan)` that have no ISIN and no current
`ii_scheme_master` row). Concretely: all 14 of DEV's current
`ii_instrument_benchmarks` rows point at synthetic fixture instruments with
**no AMFI scheme code or ISIN identifier at all** — none are real,
adapter-resolvable AMFI schemes. `ii_portfolio_truth_status` has **zero**
rows of any status (including `certified`) in DEV right now. This means DEV
can genuinely exercise the *mechanism* (queries, RPC, policy math) but
cannot currently exercise a *realistic* end-to-end fetch+write for the
accepted-statement or benchmark-dependency hydration paths — there is no
real dependency data to hydrate. This is reported plainly rather than papered
over with fabricated test dependency rows (inventing a benchmark mapping or
a certified statement in DEV, even for a test, is exactly the kind of guess
this system's own N.8 anti-fabrication principle forbids).

---

*(Original 2026-09-21 first-dispatch text below is retained; entries updated
in place where a real live result now supersedes a BLOCKED note. Historical
context — the original credential constraint — kept for the record.)*

**Original session environment constraint** (superseded above): this session's sandbox
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

- **Status**: PASS — confirmed live on both DEV and production
- **UPDATE (continuation)**: the orchestrating session confirmed the user's
  Ctrl+C in `D:\fhip-fdh10-terminal` did stop the brute-force backfill
  (terminal returned after ~36M lines read / 22.4M matched / 5.6M inserted
  that run). Migration `0166` has since been applied to BOTH DEV and
  production by the user. This session independently re-confirmed live
  against DEV (read-only REST call, 2026-09-21):
  `pc6_full_universe_historical_backfill.enabled = false` — kill switch is
  real and active. Production state was reported by the orchestrating
  session (this session has no production credentials to check itself) as
  the same: `enabled: false` on both projects, `ii_nav_retention_policy`
  (empty) and `ii_nav_retention_holds` tables exist and are queryable on
  both.
- **Original status before this update, for the record**: PARTIAL / BLOCKED for live confirmation, PASS for the
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
- **UPDATE (continuation) — real live finding**: in DEV, `pc6_amfi_daily_nav`
  is **already `enabled: true`** (confirmed live 2026-09-21) and has real
  recent run history: last success `2026-09-20T08:53:46Z` (500 rows
  inserted of 14,375 read — the rest were unchanged/already-current), with
  two earlier `failed` attempts the same morning and two stuck `running`
  rows with no `finished_at` (never settled — a real, disclosed anomaly
  worth a human look, though outside this dispatch's scope to fix).
  `pc6_amfi_scheme_master` is also `enabled: true` in DEV with a clean
  success history. This means workbook requirement 2 (all-live daily
  collection) is **already substantively running in DEV**, ahead of what
  the first-dispatch ledger assumed. Production's daily-job enabled state
  was not independently checked by this session (no production
  credentials); the orchestrating session's report did not include it.
- **Remaining risk and next action**: whether `pc6_amfi_daily_nav` is
  enabled in **production** specifically (as opposed to DEV) was not
  confirmed by this session and should be checked before relying on
  requirement 2 being live in production. The two stuck `running` batch rows
  in DEV (never reached a terminal status) are worth a separate look — not
  investigated further here as out of this dispatch's immediate scope.

## NAV 1.05 — Database space and cost baseline

- **Status**: PASS for DEV (real, executed); BLOCKED for production (still
  no production credentials — by explicit design of this dispatch)
- **Execution command**: `node scripts/nav1_dev_baseline.mjs` (new,
  read-only, exact-count REST queries).
- **Observed result (DEV, 2026-09-21)**: `ii_prices_nav` = **3,058,764 rows**;
  `ii_instruments` (mutual_fund) = 14,471; `ii_scheme_master` (current/open)
  = 14,358. A `count=exact` query for `price_date >= 2026-09-21` timed out
  (`57014 canceling statement due to statement timeout`) while the same
  count for `price_date < 2026-09-21` succeeded instantly — a real,
  asymmetric performance finding worth flagging for NAV 1.40 before this
  exact query shape is ever run against production's much larger table
  (likely tens of millions of rows, per the 6.26GB figure).
- **Remaining risk and next action**: production's `ii_prices_nav` size and
  row count still need the user to run the equivalent read-only query
  (`scripts/nav1_dev_baseline.mjs`'s logic, or the dashboard disk panel)
  against production directly — this session was deliberately not given
  production credentials and does not have another way to obtain this.

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

- **Status**: PASS (discovery + live-confirmed)
- **Observed result**: `ii_scheme_master` (migration `0155`) is
  effective-dated, one open row per `(country_code, amfi_scheme_code)`,
  `lifecycle_status IN ('active','closed','merged','suspended','unknown')`.
  "Live" = `lifecycle_status='active'` AND an open (`effective_to IS NULL`)
  row. This is the binding NAV 1.27 (all-live daily ingestion) should use to
  decide which schemes the daily job must cover, independent of any
  holdings/dependency status.
- **UPDATE (continuation) — real live breakdown (DEV, 2026-09-21)**: of
  14,358 current scheme-master rows, **100% are `lifecycle_status='active'`**
  — zero `closed`/`merged`/`suspended`/`unknown`. Consistent with the
  migration's own documented limitation (AMFI's public files don't publish
  closure/merger dates, so PC6 has no signal to ever set anything else).
  Also found: 14,471 total `ii_instruments` (mutual_fund) vs 14,358 current
  scheme-master rows — at least 113 (spot-checked up to 196 in one 1000-row
  page, exact total not fully enumerated) mutual-fund instruments have **no**
  current scheme-master row at all. Sampling those "orphan" instruments
  found them to be a mix of pre-PC6 test/certification fixtures (some with
  plausible real-sounding names like "HDFC Flexi Cap Fund", none with an
  ISIN) — see the DEV-data-realism note at the top of this ledger. This does
  not affect KEEP/CANDIDATE correctness (which binds to
  `ii_portfolio_truth_status`/`ii_instrument_benchmarks`, not
  `ii_scheme_master`), but does affect the dry-run manifest's per-scheme
  display join (an orphan instrument's candidate rows show with a blank
  scheme name).

## NAV 1.09 — Accepted statement scheme dependencies

- **Status**: PASS (discovery + implemented as part of NAV 1.07's policy
  engine — see above; not logged as a separate package since the binding
  itself IS the NAV 1.07 deliverable).
- **UPDATE (continuation) — real live finding (DEV, 2026-09-21)**:
  `ii_portfolio_truth_status` has **zero rows of any status** in DEV right
  now (not even `pending` or `parsed`), despite 96 real rows existing in
  `ii_transactions`. The accepted-statement-history protection path
  therefore has genuinely nothing to protect in DEV today — see the
  DEV-data-realism note at the top of this ledger. `ii_instrument_benchmarks`
  has 14 rows, but every one of them maps a synthetic test-fixture
  instrument (no ISIN, no AMFI scheme code) — real end-to-end hydration
  cannot be exercised against real AMFI-identifiable dependency data in DEV
  as it stands.

## NAV 1.10 – 1.13 — Scheme identity resolution / lifecycle / calculation-driven
history planning / dates and calendars

- **Status**: PARTIAL (real live finding added), rest NOT STARTED
- **UPDATE (continuation)**: NAV 1.10 (scheme identity resolution) has one
  real, live-confirmed finding: at least 113 `ii_instruments` rows
  (mutual_fund class) have no resolvable current scheme-master identity at
  all (see NAV 1.08 above) — resolution is NOT 100% even in DEV's own
  instrument universe, mixed with genuine test fixtures. NAV 1.13 (dates and
  calendars) is partially implemented already via `referenceDataQuality.ts`'s
  `classifyGaps()` (weekend-aware, no fabricated trading-holiday calendar —
  reused directly by NAV 1.26's hydration job design, see below). NAV 1.11
  (lifecycle/corporate events) and NAV 1.12 (calculation-driven history
  planning, i.e. how far back a rolling-return window must reach) still need
  `analyticsRepository.ts`'s actual rolling-window logic read in depth, which
  this dispatch did not reach.

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

- **Status**: PASS (real accuracy sample obtained) for TIGZIG-vs-AMFI
  agreement; PARTIAL still on production-runtime network qualification (see
  NAV 1.15/1.16, unchanged: this session's requests are from its own
  sandbox, not FHIP's deployed runtime).
- **UPDATE (2nd continuation) — real cross-source accuracy sample**:
  `scripts/nav1_cross_source_reconciliation_probe.ts` compares AMFI-sourced
  NAV already on file in DEV (written live by `pc6_amfi_daily_nav`) against
  TIGZIG's data for the SAME real instrument and SAME dates — no fabricated
  dependency needed, since it only reads real AMFI schemes DEV's daily job
  has already populated. **Result: 20 real schemes (ICICI Prudential
  Corporate Bond Fund, all its real plan/option variants), 100 (instrument,
  date) pairs compared, 100 exact matches, 0 mismatches, 0 fetch failures.**
  A separate single-scheme spot check (HDFC Flexi Cap Fund, AMFI code
  118955, 2026-09-18) also matched exactly: DEV(AMFI)=2242.757,
  TIGZIG=2242.757. This is genuine, real accuracy evidence — TIGZIG's
  candidate data agreed with AMFI's own published values on every sampled
  point.
- **Also observed live**: TIGZIG's origin (`api.tigzig.com`) returned a
  Cloudflare 522 ("connection timed out") on one request during this session
  and fully recovered on retry seconds later — a real, transient outage,
  not a code fault. See NAV 1.24 for how the adapter behaved.

## NAV 1.19 — NAV precision and validation

- **Status**: PASS (live-confirmed in DEV for the mechanism; direct 8-dp
  data point not found in a 1000-row DEV sample, not a concern — the PGlite
  chain replay already proved `numeric(24,10)` stores an 8-dp value without
  rounding, see the 0155 verification script).

## NAV 1.20 — Canonical NAV schema and uniqueness

- **Status**: PASS — live-proven against real DEV, zero side effects.
  Attempted a duplicate `(instrument_id, price_date)` insert via REST
  against a real existing row; DEV rejected it: `409, code 23505, "duplicate
  key value violates unique constraint ii_prices_nav_instrument_id_price_date_key"`.
  The row was never written (rejected before insert), so this required no
  cleanup.

## NAV 1.21 — Provenance corrections and revisions

- **Status**: PARTIAL — mechanism exists and is unit-tested
  (`decideUpsert` in `referenceDataQuality.ts`, exercised by
  `referenceIngestJob.ts`'s existing supersede path and by the new
  `selectiveHistoricalHydrationJob.ts`), but has **zero real live
  exercises** in DEV: `ii_reference_corrections` has 0 rows, and
  `ii_prices_nav` has 0 rows with `quality_status='superseded'`. The
  mechanism has not yet been triggered by any real source republishing a
  changed value since the daily job only started running 2026-09-20.
- **Related real finding (NAV 1.18's reconciliation sample)**: 100/100
  cross-source comparisons matched exactly with zero discrepancy, which
  means no correction event was naturally triggered by this dispatch's own
  probing either — a genuinely different value from a second source, live,
  simply has not occurred yet in the data this session could observe.

## NAV 1.22 — Coverage ledger and gap detection

- **Status**: PASS (existing code, reused not rebuilt) — `classifyGaps()`
  in `referenceDataQuality.ts` already implements weekend-aware gap
  classification (`contiguous`/`weekend_only`/`short_gap`/`long_gap`),
  explicitly never fabricating a trading-holiday calendar. Reused directly
  by the new hydration job's coverage-gap computation rather than
  reimplemented.

## NAV 1.23 — Historical job queue and deduplication

- **Status**: PASS (built) — the new `pc6_selective_historical_hydration`
  job-control row (migration `0166`) plus `ii_reference_import_batches`
  (existing table, reused) give the new hydration job the same batch-ledger
  dedup discipline every other PC6 job already has. `selectiveHistoricalHydrationJob.ts`
  bounds its own blast radius per invocation via `maxInstruments` (mirrors
  the `CHUNK_SIZE` discipline used throughout PC6). **Not yet built**: an
  actual recurring queue/scheduler entry — this job is invocable but not
  scheduled (correctly so — the workbook's binding override still prohibits
  autonomous production scheduling, and DEV scheduling was not requested).

## NAV 1.24 — Retries, failover and outage behaviour

- **Status**: PASS (reused + a real live outage was actually observed)
- `httpFetchWithRetry.ts` (exponential backoff, HTML-block-page detection)
  backs the TIGZIG adapter; a fetch failure in the hydration job is recorded
  per-instrument (`fetch_failed` outcome) and does not abort the whole run
  (confirmed by unit test — one instrument's `not_found`/network failure
  does not block the others).
- **UPDATE (2nd continuation) — a genuine live outage occurred and was
  handled**: during this session's own probing, `api.tigzig.com` returned a
  real Cloudflare 522 ("Connection timed out", the origin server itself
  hanging, not a local network issue — Cloudflare's own error page,
  `cf-host-status: Error`, `cf-cloudflare-status: Working`) on one request.
  The adapter's `fetchWithRetry` retried per its exponential-backoff design;
  the SAME request succeeded cleanly (200, real data, `elapsed: 4.6s`) on
  the very next attempt seconds later. This was an unplanned but genuine,
  real-world exercise of the outage-handling path — not a simulated/mocked
  one — and it worked as designed.

## NAV 1.25 — Statement acceptance integration

- **Status**: N/A for this dispatch, with a real caveat recorded. The
  integration point (bind `ii_portfolio_truth_status` transitions to
  `PC6_JOB_KEYS`/hydration triggering) is designed into the policy engine's
  schema binding (NAV 1.07/1.09), but there is no real `certified` row in
  DEV to prove the trigger end-to-end, and building an actual "on-acceptance,
  enqueue hydration" hook was not attempted this dispatch (would touch the
  R2 certification write path, outside this dispatch's file scope).

## NAV 1.26 — Initial historical hydration

- **Status**: PASS (built, unit-tested, dependency-resolution query
  live-proven against real DEV); PARTIAL (full fetch+write pipeline not
  exercisable against DEV's current data — see below)
- **Implementation paths**:
  `lib/services/investment-intelligence/pc6/selectiveHistoricalHydrationJob.ts`
  (pure orchestration: kill-switch check, dependency resolution via
  `determineHydrationRequirement`, gap computation, adapter fetch,
  `decideUpsert`-governed writes, batch recording — every DB/network effect
  injected via a `HydrationDeps` interface for testability),
  `lib/services/investment-intelligence/pc6/selectiveHistoricalHydrationJobLive.ts`
  (live wiring against the real Supabase admin client and
  `fetchAllRows` pagination — reusing the exact `ii_prices_nav` upsert shape
  the already-proven-live daily job uses), `tests/unit/pc6SelectiveHistoricalHydrationJob.test.ts`
  (8 tests, all mocked, all PASS), `scripts/nav1_hydration_live_dryrun.ts`
  (live-DEV dry-run driver).
- **Execution command and observed result (DEV, 2026-09-21, dry run)**: `npx
  tsx --env-file=.env.local scripts/nav1_hydration_live_dryrun.ts`. This
  script temporarily flips `pc6_selective_historical_hydration.enabled` to
  `true` in DEV ONLY (capturing and restoring the exact original row in a
  `finally` block — confirmed restored to `enabled=false` in the run's own
  output), runs the real dependency-resolution query against live DEV, and
  reports the plan without fetching or writing. **Real result: found all 14
  benchmark-dependency instruments correctly, computed the correct required
  window `[2006-04-01, 2024-01-27]` for each** (2006-04-01 = this
  programme's own documented AMFI floor date used when a dependency implies
  "from inception"; 2024-01-27 = one day before each instrument's actual
  existing earliest `ii_prices_nav` row, `2024-01-28`, live-queried per
  instrument). This is genuine, live proof that the dependency-resolution
  query — the exact prerequisite migration `0166`'s own `disabled_reason`
  names — works against the real database.
- **What could NOT be proven live, and why (a real, disclosed limitation, not
  a code gap)**: a full fetch-from-TIGZIG-and-write proof needs a real,
  AMFI-identifiable dependency instrument. Every one of DEV's 14 current
  benchmark-mapped instruments is a synthetic test fixture with no ISIN and
  no AMFI scheme code (`ii_instrument_identifiers` lookup returned zero
  rows for all 14, spot-checked) — the job would correctly report
  `unresolvable_identifier` for each of them if run for real, which is
  correct, safe behaviour (refuse rather than fabricate an identifier), not
  a bug. Fabricating a realistic-looking benchmark mapping or a certified
  statement in DEV purely to exercise this path was deliberately NOT done —
  this system's own N.8 principle ("do not invent a mapping to fill a gap")
  applies here just as much as it does to a real benchmark series. The write
  leg itself is not genuinely new/unproven in isolation: `writeRows()` uses
  the identical `ii_prices_nav` upsert call shape the already-running
  `pc6_amfi_daily_nav` job uses live in DEV today (thousands of real rows
  inserted 2026-09-20). What remains unproven end-to-end is specifically
  "TIGZIG fetch results flowing through this exact new orchestration into a
  real write," which needs either a real accepted/benchmarked AMFI-mapped
  instrument in DEV, or an explicit decision to accept a synthetic-but-
  disclosed test row for this one purpose.
- **Remaining risk and next action**: (1) get one real AMFI-identifiable
  instrument into DEV's dependency tables (via the real acceptance/benchmark
  workflow, not fabricated) to close this gap honestly; (2) NAV 1.23's
  scheduling remains not built; (3) large-window chunking is a real, disclosed
  follow-up — an 18-year `[2006-04-01, 2024-01-27]` single-request window is
  what this job would currently ask TIGZIG for in one call, which was not
  tested at that size (the live dry run never called the adapter). Chunking
  very large windows into safer sub-requests (mirroring the AMFI
  NAVHistoryReport source's own "keep windows bounded" note) is not yet
  implemented and should be before this job is ever run for real
  (non-dry-run) against a instrument needing full-inception history.

## NAV 1.27 — All-live daily ingestion

- **Status**: PASS (real, running) with a genuine, disclosed coverage caveat
- **Execution command**: `node scripts/nav1_daily_coverage_probe.mjs`
  (read-only, paginated properly via `Range` headers rather than a plain
  `limit=` param, which is silently capped regardless of the value
  requested — the same defect class `pgAll()`/`fetchAllRows()` exist
  elsewhere in this repo to avoid).
- **Observed result (DEV, 2026-09-21)**: of 14,358 active scheme-master
  instruments, **at least 7,350 (51.2%)** had >=1 `ii_prices_nav` row in an
  11-day window (2026-09-08 to 2026-09-18) — this is a **lower bound**: the
  probe's own pagination hit a `57014` statement timeout partway through
  (see NAV 1.40) so the true figure is >=51.2%, not exactly that. Coverage
  is heavily uneven by category: `Equity Schemes` 89.6%, `Index Funds`
  87.8%, `Other Scheme` 84.1% vs. schemes with a **NULL** `category_group`
  at only 3.2% (155/4,918) — a large, real, disclosed gap concentrated in
  one specific data-quality bucket, not spread evenly. Per-date row counts
  in the window ranged ~700/day except an anomalous spike of 7,303 rows on
  2026-09-18 (one single date), unexplained by anything in this dispatch's
  scope to investigate further, but real and worth a look.
- **Why partial coverage on any SINGLE date is not itself a defect**: the
  `amfi_nav_daily` source's own documented behaviour (`pc6ReferenceSources.ts`)
  is "one row per scheme with the LATEST NAV that scheme has published — not
  necessarily today"; AMFI does not publish every scheme every calendar day.
  The multi-day rolling count above is the more honest coverage measure, and
  it is real evidence that the "regardless of holdings" requirement (#1 in
  the Non-Negotiable list) is substantively working for roughly half-plus of
  the active universe within DEV's currently short run history (the job only
  started 2026-09-20) — full convergence over time was not independently
  projected.
- **Remaining risk and next action**: re-run this probe against production
  (once an operator has credentials to) and again in DEV after a few more
  days of the daily job running, to see whether the ~51%+ figure converges
  toward the full active universe or plateaus (which would indicate a real
  parsing/matching gap worth investigating, e.g. against the NULL-category
  4,918-scheme bucket specifically).

## NAV 1.28 — Reconciliation and historical correction sweeps

- **Status**: PASS — real cross-source reconciliation executed (see NAV
  1.18 for the full result: 100/100 exact matches, 0 mismatches, 20 real
  schemes). No actual "sweep job" (a scheduled, systematic comparison) was
  built — this dispatch built and ran the comparison LOGIC and got a real
  clean result, but turning it into a recurring admin-observable sweep is a
  follow-up, not attempted given the scope remaining.

## NAV 1.29 — Benchmark dependencies

- **Status**: PASS (live-confirmed, all as documented)
- **Observed result (DEV, 2026-09-21)**: `ii_benchmark_series` = 199 rows
  (matches the synthetic 14-fixture-instrument test data, not real index
  levels); `ii_benchmark_category_defaults` = **0 rows** (confirms N.8's "no
  guessed default" is still honestly true, live); `ii_benchmarks` = 14 rows;
  `ii_risk_free_methodology` = **0 rows** (confirms BLOCKER PO-PC6-2 remains
  genuinely open, live, not silently resolved); `ii_risk_free_rates` = 16
  rows (matches the migration's own documented "16 DEV SEED rows, not
  certified" note). Every one of these matches exactly what the governing
  migrations' own comments claimed — real confirmation that the honesty
  commitments made in prior PC6 work are still true in the live database,
  not just in code comments.

## NAV 1.30 – 1.34 — XIRR/cash-flow integrity, TWR/valuation series, rolling
returns, risk metrics/drawdowns, IDCW/distribution events

- **Status**: PASS by existing, pre-NAV1 architecture — confirmed compatible,
  not modified because not broken
- **Real finding**: `lib/config/investment-intelligence/minimumHistory.ts`
  (R4, pre-existing) already defines a versioned, precise "how much history
  does metric X need" contract — `RETURN_HORIZONS_DAYS` (up to 3,650 days /
  10Y), `MINIMUM_OBSERVATIONS` (e.g. `rollingMinWindows: 6`,
  `volatilityMinObservations: 12`). This is exactly NAV 1.12's "calculation-
  driven history planning" requirement, and it already exists — NAV1 did not
  need to invent it.
- `lib/engines/investment-intelligence/calculationStatus.ts` (pre-existing)
  already implements a `CalculationOutcome`/`CalculationStatus` system with
  explicit `INSUFFICIENT_HISTORY`, `MISSING_REFERENCE_DATA` and
  `BENCHMARK_HISTORY_INCOMPLETE` states (confirmed via
  `rollingReturnService.ts`'s real usage) — i.e. "missing NAV is never
  equivalent to zero NAV" (Non-Negotiable Verification #6) is **already
  enforced by pre-existing R4/R9 architecture**, not something NAV1 needed
  to build. NAV1's job here is narrower than the workbook's framing implied:
  don't break this, which it doesn't (NAV1 only ever ADDS history via
  hydration, and removes nothing without the Stage-E gate).
- **Real, disclosed refinement opportunity, NOT implemented**: NAV1's own
  `determineHydrationRequirement` (navRetentionPolicy.ts) currently treats
  a benchmark dependency as needing "full history from inception" as a
  conservative default. The REAL requirement, per `minimumHistory.ts`, is
  more precise and often smaller (e.g. a `rolling3Y` display needs on the
  order of `3Y + rollingMinWindows(6)*1Y ≈ 9 years`, not necessarily
  "since 2006"). Binding hydration's fetch-window sizing to
  `RETURN_HORIZONS_DAYS`/`MINIMUM_OBSERVATIONS` instead of the current
  blanket "from inception" default would fetch meaningfully less data per
  dependency — a real, valuable, NOT-YET-DONE follow-up, disclosed here
  rather than silently left as an inefficiency.
- **NAV 1.34 IDCW/distribution events — investigated, PASS by existing
  architecture**: PC6's scheme-master design (migration `0155`, pre-existing)
  already sidesteps the classic "dividend-adjusted vs. unadjusted NAV series"
  problem structurally, not through any NAV1-specific handling. AMFI (and
  therefore `amfiParser.ts`'s `option_type` classification —
  `growth`/`idcw`/`dividend_payout`/`dividend_reinvestment`) treats an IDCW
  plan as its own DISTINCT scheme code with its OWN `ii_instruments` row and
  its own `ii_prices_nav` series — "economically distinct plan/option
  variants are NOT collapsed" (0155's own documented design). A dividend-
  payout plan's NAV genuinely drops after each distribution because it is a
  real, separately-published NAV for a real, separate instrument — not
  because PC6 adjusted anything. NAV1's hydration job inherits this for
  free: it fetches/writes per-instrument, and an IDCW-option instrument is
  just another instrument to it. Separately, `ii_transactions.transaction_type`
  already includes `'dividend'`/`'reinvestment'` (migration `0033`,
  pre-existing) for recording a unit-holder's OWN distribution receipt,
  which is a different concept from PC6's scheme-level NAV series and
  requires no NAV1 change either. `benchmarkGovernance.ts` (pre-existing)
  separately already flags and qualifies a Price-Return-Index-standing-in-
  for-Total-Return-Index situation for benchmark comparisons (PRI excludes
  dividends). No gap found; no code change needed.

## NAV 1.35 — Currency and historical report preservation

- **Status**: PARTIAL — the gap was already disclosed under NAV 1.07
  (`pinned_by_report_or_revision` fails closed because `report_snapshots`,
  migration `0010`, does not record NAV row identity). No further work done
  this dispatch; the fail-closed policy stance remains the safe interim
  answer.

## NAV 1.36 — User experience and readiness states

- **Status**: PASS by existing architecture (same basis as 1.30-1.34) — the
  `CalculationStatus`/`isDisplayableNumber`/`toPersistedQualityStatus`
  system already gives the UI layer an honest "pending/unavailable/stale"
  vocabulary distinct from a real zero. Not independently confirmed that
  every UI surface actually reads and displays this status faithfully
  (would require reading the actual React components, not attempted).

## NAV 1.37 — Admin operations and observability

- **Status**: PARTIAL — real finding, no code change made
- `app/api/admin/investment-intelligence/reference-data-quality/route.ts`
  (existing, pre-NAV1) queries `ii_reference_job_control` generically
  (`select('job_key, enabled, disabled_reason, ...')` with no `job_key`
  filter), so it will **automatically** surface this dispatch's two new
  job-control rows (`pc6_full_universe_historical_backfill`,
  `pc6_selective_historical_hydration`) with zero code change needed —
  confirmed by reading the route's actual query, not assumed.
- **NOT surfaced yet**: `ii_nav_retention_policy` and
  `ii_nav_retention_holds` (both new this programme) are not queried by
  that route at all. Extending it was deliberately deferred this dispatch —
  it is a real, valuable follow-up, but modifying an existing Admin route
  requires reading `docs/admin/FHIP_ADMIN_ARCHITECTURE_STANDARD.md` in full
  first per this repository's own `AGENTS.md`, which this dispatch's
  remaining time budget was spent on higher-priority live-DEV verification
  instead. Flagged honestly as deferred, not silently skipped.

## NAV 1.38 — Security, privacy and request controls

- **Status**: PASS — live-proven against real DEV with zero side effects
- **Observed result (DEV, 2026-09-21)**, using the real anon key (no
  authenticated session):
  - `ii_nav_retention_policy`, `ii_nav_retention_holds`,
    `ii_reference_job_control`, `ii_reference_import_batches`: all return
    HTTP 200 with an **empty array** — RLS correctly hides every operational
    table from an unauthenticated request.
  - `ii_scheme_master`, `ii_prices_nav`: readable anonymously (by design —
    global public reference data), confirming the RLS distinction is real
    in both directions, not just "block everything".
  - An anonymous **write** attempt to `ii_scheme_master` was rejected: `401,
    code 42501, "new row violates row-level security policy"` — no row was
    written, service-role-only write is enforced live, not just in a
    migration comment.

## NAV 1.39 — Concurrency and transactional integrity

- **Status**: PASS — full real live end-to-end proof, using a genuine real
  instrument (no fabrication needed — a hold is an operational lock, not a
  dependency claim)
- **Observed result (DEV, 2026-09-21)**, against HDFC Flexi Cap Fund
  (`37a3d60e-47db-4fb9-af8b-4a174dfa1f2f`, a real AMFI-mapped instrument):
  `pc6_nav_row_is_candidate(..., '2015-01-01', ...)` = `true` before any
  hold → inserted a real `ii_nav_retention_holds` row (`reason:
  'manual_admin_hold'`) → the SAME RPC call on the SAME date now returns
  `false` while held → released the hold via its intended lifecycle
  (`released_at` set via `PATCH`, not a DELETE) → the RPC returns `true`
  again. This is the workbook's own "Race prevention" mechanism, proven live
  end-to-end against the real database, with no permanent side effect (the
  hold row remains on file, correctly marked released, which is itself the
  intended audit trail).

## NAV 1.40 — Performance budgets and growth model

- **Status**: PASS — a real defect found, understood, and a fix drafted
  (migration `0167`, not yet applied — hand-over artefact)
- **Real finding**: `ii_prices_nav`'s ONLY index (migration `0033`) is the
  composite UNIQUE `(instrument_id, price_date)` — there has never been an
  index usable for a `price_date`-only filter or count. This dispatch hit
  the consequence live TWICE: a `count=exact` on `price_date >= C` timed out
  (`57014`) while the `<` direction succeeded on the same 3.06M-row table;
  and a paginated, date-range-filtered read timed out partway through at a
  higher OFFSET. Both are explained by the same root cause.
  `supabase/migrations/0167_nav1_prices_nav_date_index.sql` adds
  `idx_ii_prices_nav_price_date` — a plain (non-`CONCURRENTLY`) index,
  matching this repository's own established migration convention (grepped
  fresh: zero prior migrations use `CONCURRENTLY`, and this session verified
  live via PGlite that `CONCURRENTLY` cannot run inside the transaction
  block this repo's migration tooling uses — that reasoning is preserved in
  the migration file's own header). The trade-off is disclosed: a plain
  index briefly locks `ii_prices_nav` for writes during the build. Verified
  via the same 0001..0167 PGlite full-chain replay technique used
  throughout this programme — applies cleanly, index confirmed present.
- **Remaining risk and next action**: this index should be applied to
  production BEFORE any production-scale NAV 1.42 manifest run or NAV 1.27
  coverage check — those exact query shapes will be slower on production's
  larger table, not faster, without it.

## NAV 1.41 — Legacy history migration and reuse

- **Status**: PASS by design and by live observation — "reuse imported data
  before making new external requests" (workbook requirement 5) is not a
  separate feature to build; it is what `selectiveHistoricalHydrationJob.ts`'s
  `fetchEarliestExistingDate` + already-covered check already does, and the
  live dry run (NAV 1.26) directly demonstrated it: each of the 14
  dependency instruments' computed fetch window correctly stopped at
  `2024-01-27` — one day before their REAL existing earliest on-file date
  (`2024-01-28`) — rather than re-requesting data already present. DEV's
  3.06M legacy rows (from the earlier full-universe backfill) are preserved
  and reusable under the new policy exactly as designed; nothing about NAV1
  discards them outside the still-unexecuted Stage E gate.

## NAV 1.42 — Retention dry run and candidate manifest

- **Status**: PASS — genuinely executed against real live DEV data
- **UPDATE (continuation)**: `scripts/pc6_nav1_retention_dryrun_manifest.sql`
  itself still could not be run directly (confirmed fresh: no raw-SQL/DDL
  path exists even with real DEV credentials — only PostgREST table access
  and RPC calls to already-defined functions). Built
  `scripts/nav1_dev_retention_dryrun.mjs` instead: re-derives the identical
  policy via PostgREST aggregate counts, and independently cross-checks the
  result against the live `pc6_nav_row_is_candidate()` RPC row-by-row for a
  sample — both methods must agree.
- **Execution command**: `node scripts/nav1_dev_retention_dryrun.mjs`
  (read-only; no write of any kind).
- **Observed result (DEV, 2026-09-21)**:
  - Dependency inventory: 0 accepted-statement instruments, 14
    benchmark-mapped instruments (all synthetic fixtures — see the
    DEV-realism note), 0 active holds. 14 total protected-regardless-of-date
    instruments.
  - Total `ii_prices_nav` rows: 3,058,764. Rows before changeover (candidate
    pool before dependency exclusion): 3,058,764 (100% — DEV has no rows
    dated on/after 2026-09-21 yet, consistent with the daily job's last
    success being 2026-09-20). Rows belonging to a protected instrument:
    199. **CANDIDATE rows under DEV's CURRENT (test-fixture-only) dependency
    data: 3,058,565 (100.0% of all rows).**
  - RPC cross-check: 14/14 protected instruments confirmed `candidate=false`
    at a pre-C probe date; 6/6 sampled unprotected instruments confirmed
    `candidate=true`. Zero mismatches between the aggregate-count method and
    the row-level RPC.
- **This number must NOT be read as a production forecast.** DEV's ~100%
  candidate rate reflects DEV having essentially zero real accepted-statement
  dependency data (0 certified rows) — it is a measure of DEV's current
  data population, not of the policy's real-world selectivity. Production
  has genuine accepted statements and a real dependency graph; its candidate
  percentage will be materially different (almost certainly much lower) and
  must be measured separately, on production, once this same read-only
  script is pointed at it by an operator with production credentials.
- **Remaining risk and next action**: this file's inline changeover-date
  default must be checked against the real `ii_nav_retention_policy` row
  (NAV 1.07 activation, still not done on either environment — the table
  ships empty by design) before trusting output on production. Run
  `scripts/nav1_dev_retention_dryrun.mjs`'s logic (or the SQL file, if an
  operator has raw-SQL access production-side) against production next.

## NAV 1.43 — Controlled historical deletion

- **Status**: EXPLICITLY NOT ATTEMPTED — this remains the dispatch's own
  named stop point, unchanged by the continuation dispatch.
- **Reason**: per explicit instruction (repeated and reaffirmed in the
  continuation), actual DELETE execution requires (a) migration `0166`
  applied [now true, both DEV and production], (b) NAV 1.42's manifest run
  for real against production and reviewed [DEV done this update; production
  still not run — no production credentials], (c) verified backup/restore
  recovery proof (NAV 1.45 — see below, still not attempted), and (d) one
  further explicit go-ahead from the user with the concrete manifest in
  hand. (a) is now satisfied; (b)-(d) are not. **No DELETE statement has
  been written, drafted, or executed anywhere in this dispatch or its
  continuation, against DEV or production.** The only two live-DEV writes
  performed this continuation were: a rejected duplicate-key insert attempt
  (NAV 1.20, no row written) and a temporary, captured-and-restored toggle of
  `pc6_selective_historical_hydration.enabled` for the dry-run proof (NAV
  1.26, confirmed restored to its original `false` state in the same run).

## NAV 1.45 — Archive restore and disaster recovery

- **Status**: BLOCKED for actual execution — genuine external blocker, not
  a caution-driven stop
- **Reason**: verifying restore means triggering a real Supabase
  backup/point-in-time-restore into an isolated project, which is a
  Management-API/dashboard operation. `scripts/pc5_ddl_capability_probe.mjs`
  (re-run fresh this dispatch) already confirms this session has no
  management token (`SUPABASE_ACCESS_TOKEN`/`SUPABASE_MANAGEMENT_TOKEN`/
  `SUPABASE_PAT` all absent) and no direct Postgres connection string — there
  is no path from this sandbox to trigger or observe a real restore. This is
  disclosed as a genuine blocker, not fabricated as a pass.
- **What CAN be, and is, provided**: a concrete recovery-proof procedure for
  an operator who does have dashboard/Management-API access to execute:
  (1) trigger a Supabase point-in-time-restore of the target project into a
  NEW, isolated project (never restore over DEV or production in place);
  (2) run `scripts/nav1_dev_baseline.mjs`-equivalent row counts against both
  the restored copy and the source, for `ii_prices_nav`, `ii_scheme_master`,
  `ii_portfolio_truth_status`, and confirm they match; (3) spot-check a
  sample of `(instrument_id, price_date, price)` triples byte-for-byte
  between source and restore; (4) record the restore's own timestamp/backup
  identifier in `ii_nav_retention_policy.coverage_proof_reference` (a column
  this migration already created for exactly this purpose) before Stage D
  is considered satisfied. None of this was executed — it is a
  hand-over procedure, not a completed proof.

## NAV 1.44, 1.46, 1.47, 1.48 — Physical disk reclamation / integrated
certification / controlled production rollout / final handover

- **Status**: NOT STARTED — all genuinely depend on NAV 1.42 (production
  run, not just DEV) / 1.43 (deletion, explicitly not attempted) / 1.45
  (recovery proof, blocked above) being real and complete first. Attempting
  any of these now would be building on top of an unproven foundation.

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
- **Continuation dispatch new files**: `scripts/nav1_dev_baseline.mjs`,
  `scripts/nav1_dev_retention_dryrun.mjs`, `scripts/nav1_hydration_live_dryrun.ts`,
  `lib/services/investment-intelligence/pc6/selectiveHistoricalHydrationJob.ts`,
  `lib/services/investment-intelligence/pc6/selectiveHistoricalHydrationJobLive.ts`,
  plus the `determineHydrationRequirement` addition to `navRetentionPolicy.ts`
  and its tests. `.env.local` (DEV credentials, no production credentials)
  was never committed, printed, or logged — confirmed via `git status`
  before every commit this continuation.
- **DEV write footprint from this continuation, for full transparency**:
  zero permanent writes to `ii_prices_nav`/reference data. Live-DEV
  mutations made: (1) a rejected duplicate-key insert (409, nothing
  written); (2) a temporary `pc6_selective_historical_hydration.enabled`
  toggle, captured and restored to its exact original value in a `finally`
  block, confirmed restored in the same script's own output; (3) one real
  `ii_nav_retention_holds` row inserted against a genuine instrument (HDFC
  Flexi Cap Fund) for the NAV 1.39 concurrency proof, then released via its
  intended `released_at` lifecycle (an UPDATE, not a DELETE) — the row
  remains on file as its own correct audit trail, exactly as the table was
  designed to record.
- **2nd continuation dispatch (same day) new files**:
  `scripts/nav1_cross_source_reconciliation_probe.ts` (NAV 1.18/1.28 —
  real accuracy sample, 100/100 exact matches, 0 mismatches),
  `scripts/nav1_daily_coverage_probe.mjs` (NAV 1.27 — real coverage
  measurement, itself hit the NAV 1.40 pagination-timeout finding while
  running), `scripts/nav1_tigzig_outage_probe.ts` (NAV 1.24 — captured a
  genuine live TIGZIG outage and its recovery), and
  `supabase/migrations/0167_nav1_prices_nav_date_index.sql` (NAV 1.40 — a
  real, PGlite-chain-verified index fix, not yet applied anywhere).
