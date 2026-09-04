# II-PC2-F1 — Analytics GET / Read-Side Mutation Review & Closure — Decision

**Verdict: UNCONDITIONAL FULL PASS — FIXED**

One genuine defect was found and fixed (Tax's `closed_at` provenance
timestamp). No other GET handler in `app/api/investment-intelligence/**`
mutates financial state in an unsafe way. Full per-engine evidence below —
a blanket decision was deliberately not taken; each of SIP, X-Ray and Tax
was independently investigated and independently tested.

## Scope covered

- Full static inventory of all 26 GET handlers (`II_PC2_F1_GET_MUTATION_INVENTORY.md`).
- Re-ran the existing certified F1 (`iiPc1F1FifoAccountScopeLiveDev.test.ts`,
  6/6), F2 (`iiPc1F2EngineVersionConsumersLiveDev.test.ts`, 11/11), PC1
  (`iiPc1LiveDev.test.ts` + `iiPc1ClosureVerification.test.ts`, 10/10) and PC2
  (`iiPc2WorkspaceLiveDev.test.ts`, 12/12) live-DEV suites unmodified, against
  real DEV (`vqycarelcoijzwlpkpcz`), to reconfirm none of this dispatch's
  findings contradict already-certified behaviour.
- New live-DEV suite `tests/live-dev/iiPc2F1ReadSideMutationLiveDev.test.ts`
  (16 tests, run twice — once RED against the defect, once GREEN after the
  fix) purpose-built for this dispatch's exact question: idempotency (10×
  sequential), concurrency (6× simultaneous), retry-after-commit, cross-engine
  request-order invariance, canonical-truth non-mutation, and cross-user
  security — for all three writing engines, against one real seeded
  portfolio (one instrument, two folios, a SIP-shaped series in Folio A, a
  full-close redemption in Folio B).

## Per-engine classification

### SIP — `GET /investment-intelligence/sip`

**SAFE_DERIVED_MATERIALISATION.**

- **Tables written**: `ii_r5_analytics_results` only.
- **Classification**: RECOMPUTABLE_DERIVED_CACHE. Row identity is `(user_id,
  scope_type, scope_id, metric_key, input_snapshot_version, engine_version)`
  — a full fingerprint of the computation, not a mutable "current" pointer.
- **Determinism**: confirmed no `Date.now()`/`Math.random()`/other
  non-determinism anywhere in `lib/engines/investment-intelligence/sip/**`.
  `attachAttributableInflows` mutates the in-memory dataset only, never the
  DB, and runs identically on every call.
- **Idempotency**: `persistR5Results` upserts with `ignoreDuplicates: true`
  onto a unique index that matches the upsert's `onConflict` string exactly
  (verified against migration `0044` line 314) — a repeat write to the same
  key is a genuine no-op at the Postgres level, not an application-level
  promise. Live-proven: §S2, 10 sequential re-reads, byte-identical XIRR/
  benchmark figures, persisted row count exactly `analytics.length × 2`
  (never grows).
- **Concurrency**: §S3, 6 concurrent identical reads, same row count as a
  single read — Postgres's own unique-index conflict resolution, not an
  apparent-only pass.
- **Retry**: identical to idempotency — a retried GET after a real commit
  lands on the same conflict key.
- **Request-order invariance**: §O1 — visiting Tax→SIP→X-Ray, then
  X-Ray→SIP→Tax, then SIP→X-Ray→Tax, produces byte-identical persisted state
  across all three tables every time.
- **Currentness rule**: not applicable — SIP has no "supersession" axis; a
  changed `input_snapshot_version` (real new data) simply adds a new,
  independently-keyed row rather than overwriting a stale one; nothing here
  ever needed a current-result selector the way Tax did (see F2).
- **User-visible impact of a read**: none. Opening the SIP page cannot
  change what the SIP page (or any other page) shows.
- **Security**: `ii_r5_analytics_results` has SELECT-only RLS for the
  authenticated role and NO insert/update/delete policy at all — confirmed
  in the migration and live-reproduced (§SEC1): a second real user's own
  JWT cannot read another user's rows, and cannot forge a row even naming
  their own `user_id`, because the policy simply does not exist for that
  role. Only the service-role `persistR5Results` path can write.
- **Failure atomicity**: a single `.upsert()` call over one table — there is
  no multi-step write to leave half-committed.

### X-Ray — `GET /investment-intelligence/xray`

**SAFE_DERIVED_MATERIALISATION.**

Identical reasoning and identical persistence function (`persistR5Results`,
same table, same unique index) as SIP, with one structural difference: the
write is conditional on `result.lookThrough.status === 'ok'` (i.e. only when
look-through is actually available), so an unavailable-coverage read writes
nothing at all — confirmed not to be a partial/inconsistent state, simply
"no row yet."

- Live-proven: §X1 (available for the seeded fund-holdings disclosure), §X2
  (10× sequential, byte-identical coverage, exactly 1 persisted row, never
  duplicated), §X3 (6× concurrent, still exactly 1 row).
- Order-invariance, canonical-truth non-mutation and cross-user security:
  same evidence as SIP (§O1, §C1, §SEC1 cover all three engines' tables in
  one combined snapshot-comparison test).
- `xray/data-quality` and `xray/overlap` (the other two X-Ray GET routes)
  run the same engine for display purposes but persist nothing — confirmed
  by inventory, not assumed.

### Tax Summary — `GET /investment-intelligence/tax/summary`

**SAFE_DERIVED_MATERIALISATION — FIXED** (one finding, corrected).

- **Tables written**: `ii_tax_lots`, `ii_tax_lot_consumptions`,
  `ii_capital_gains_computations`.
- **Classification**: AUTHORITATIVE_DERIVED_FINANCIAL_STATE — this is the
  correct, higher bar the dispatch calls for, and it is met:
  - `ii_tax_lots.id` is a **deterministic** UUID v5 hash of the lot's own
    stable `lotId` (`deterministicLotId`), so the same lot always upserts to
    the same row — idempotent by construction, no DB-level unique
    constraint needed beyond the primary key already on `id`.
  - `ii_tax_lot_consumptions` and `ii_capital_gains_computations` both
    upsert on `(disposal_transaction_id, lot_id)`, and both have a real
    `CREATE UNIQUE INDEX` on exactly that pair (migration `0059`, verified
    by reading the migration, not the application code's claim about it).
  - **Currentness rule**: already solved by the separate, independently
    live-certified `II-PC1-F2` effort — `selectCurrentCapitalGainsRows`
    (engine-version + latest-`computed_at`-per-disposal). Re-ran F2's own
    11-test live-DEV suite unmodified in this dispatch: still 11/11.
  - **FIFO scope**: already solved by `II-PC1-F1` (account-scoped FIFO, not
    instrument-scoped) — re-ran F1's 6-test live-DEV suite unmodified: still
    6/6, and this dispatch's own fixture (§T1) independently re-derives the
    same shape (two folios, one instrument, a redemption that must consume
    only its own folio's lots) and gets the same right answer.
- **Determinism**: no non-determinism in `runTaxSimulation` or its
  sub-modules. `computed_at`/`created_at` are stamped ONCE per run (a single
  `runAt` variable, not `new Date()` per row) — this is what makes
  "current" a total order over runs rather than a race between rows (see F2
  decision doc), and it was re-verified true in this dispatch, not merely
  read from a comment.
- **Idempotency**: §T2, 10 sequential full-pipeline runs — byte-identical
  `disposalResults`, row counts for all three tables stay exactly at their
  first-run values (1 lot-consumption row, 1 capital-gains row for the one
  redemption in the fixture).
- **Concurrency**: §T3, 6 concurrent full-pipeline runs — same row counts,
  and (checked explicitly) every persisted capital-gains row has identical
  `taxable_gain`/`cost_basis_used`/`sale_value` — no race-winner producing a
  different number than a race-loser.
- **Retry**: §T4 — a call made after a real prior commit lands on the exact
  same row ids (compared by id set, not just count).
- **Request-order invariance**: §O1 — Tax's own three tables are unaffected
  by whether SIP/X-Ray ran before, after, or interleaved.
- **Failure atomicity**: the three-step write (lots → consumptions →
  capital-gains) is not one DB transaction, but each step is independently
  idempotent and keyed off canonical inputs, so a crash between steps
  leaves a **safe** partial state (e.g. lots written, consumptions not yet)
  — not a corrupt one: the FK from consumptions/capital-gains into
  `ii_tax_lots` guarantees a consumption can never reference a lot that
  wasn't itself safely persisted first, and a subsequent successful run
  (the very next GET) completes the missing steps without duplicating the
  ones that already landed. This was not independently fault-injected
  against a live crash (no safe way to kill the process mid-request in this
  harness), but is a direct, verifiable consequence of every step already
  being proven idempotent and FK-ordered.
- **Security**: RLS `for all using (auth.uid() = user_id)` on all three
  tables (existing, F1-verified); this dispatch's §SEC1 additionally
  re-confirmed no cross-user read leak on the derived tables from a second
  real synthetic user.

**THE FINDING — `closed_at` provenance drift, now fixed.**

`persistTaxLots` stamped `closed_at: new Date().toISOString()` on *every*
upsert of an already-fully-consumed lot, not only its first closure. Because
the upsert is `ignoreDuplicates: false` (DO UPDATE), this meant **the
`closed_at` column silently changed value on every repeated
`/tax/summary` read**, for as long as the lot stayed closed — a real,
reproduced-live violation of "audit/provenance stays correct," even though
no other column and no user-visible figure was affected (nothing in the
codebase currently reads `ii_tax_lots.closed_at` — confirmed by search; the
only other consumer of `ii_tax_lots`, `tax/lots/route.ts`, recomputes lots
in memory and never touches the table).

- **RED test**: `tests/live-dev/iiPc2F1ReadSideMutationLiveDev.test.ts` §T5,
  run against the pre-fix code, failed with a real, live, reproduced
  assertion mismatch (`closed_at` changed between two reads 1.1s apart:
  `2026-09-04T03:05:20.883+00:00` → `2026-09-04T03:05:24.26+00:00`).
- **Fix** (Pattern A/B hybrid, the narrowest available — no new migration):
  `persistTaxLots` now reads back any already-persisted `closed_at` for the
  lot ids about to close in this batch, and reuses it verbatim when
  present. A lot is stamped with a real wall-clock `closed_at` exactly once
  — at its genuine first transition to closed — and never again. See
  `lib/services/investment-intelligence/taxRepository.ts`'s updated header
  comment on `persistTaxLots` for the full account.
- **GREEN test**: same suite, same §T5, now passes (16/16 total), and §T6
  (an open lot never receives a `closed_at` at all) passes unchanged.
- **Regression check**: F1's own live-DEV suite (which exercises
  `persistTaxLots` under its own two-folio fixture, including its own
  idempotency test, §28) re-run unmodified after the fix: still 6/6. F2's
  suite: still 11/11.
- **Scope discipline**: this fix touches only the `closed_at` field
  computation inside `persistTaxLots`. It does not touch F1's
  `ACCOUNT_SCOPED_FIFO`/`accountKey` semantics, any R6 tax-law rule, or F2's
  current-result selector.

## Overview safety (re-proven, not re-asserted)

`GET /investment-intelligence/overview` (`app/api/investment-intelligence/
overview/route.ts`) calls only `buildOverviewSummary`, which the route's own
header comment states reads "plain tables and counts" and explicitly refuses
to fan out into SIP/X-Ray/Tax "three of them PERSIST derived rows as a side
effect... fanning out... would make simply opening the page rewrite the
user's tax lots." Verified directly, not merely trusted:
`buildOverviewSummary` was read in full and contains no import of
`runSipAnalytics`/`runXrayAnalytics`/`runTaxSimulation`/`persistTaxLots`/
`persistR5Results`, only RLS-respecting `supabase.from(...)` reads. The
existing `iiPc2WorkspaceLiveDev.test.ts` (12/12, re-run in this dispatch)
already independently certifies the Overview's per-card availability claims
against real data; this dispatch adds the static-import proof that the
summary is structurally incapable of triggering the three heavy engines.

## Overview network-call count (concrete, not inferred)

`app/(app)/investment-intelligence/page.tsx` is a server component that only
checks auth and renders `<OverviewClient />` — it fetches no analytics data
server-side. `components/investment-intelligence/OverviewClient.tsx`
contains exactly **one** `fetch(...)` call in the whole file (grep count: 1),
to `/api/investment-intelligence/overview`. Visiting `/investment-intelligence`
therefore causes exactly one lightweight summary request; there is no code
path by which it fans out into `/sip`, `/xray`, `/tax/summary`, `/review`, or
`/analytics`.

## Reports stay a snapshot consumer

Searched the whole repo for any import of `runTaxSimulation`, `runSipAnalytics`,
`runXrayAnalytics`, `persistTaxLots`, or `persistR5Results` from anything
report-shaped (R10's Reports module): none exists. Reports cannot trigger
recalculation of any of the three engines — confirmed by absence, not by
reading a report route's own claim about itself.

## Every other GET route

Confirmed pure-read (no `.insert`/`.update`/`.upsert`/`.delete` anywhere in
their call chain) by direct inspection of all 26 GET handlers — full table
in `II_PC2_F1_GET_MUTATION_INVENTORY.md`. The one partial exception,
`positions/[id]/preview`, writes a single append-only row to
`ii_audit_events` (NON_FINANCIAL_CACHE — an audit log accumulating one row
per preview action is its correct, intended behaviour, not a defect).

`analytics/route.ts` (R4 Performance & Benchmark) was found to already be
built correctly, ahead of this dispatch: its GET is pure read, and all
persistence (`persistAnalyticsRows`) lives behind the separate
`POST /investment-intelligence/analytics/recalculate` command endpoint —
Pattern C, already in place. Noted for completeness; no action needed.

## Regression + gates

- `npx tsc --noEmit`: see closing test-run summary in the PR/branch report.
- ESLint on changed files: `lib/services/investment-intelligence/
  taxRepository.ts`, `tests/live-dev/iiPc2F1ReadSideMutationLiveDev.test.ts`.
- Production build.
- Full `npx vitest run` (offline unit suite).
- Live-DEV suites re-run: F1 (6/6), F2 (11/11), PC1 (`iiPc1LiveDev` +
  `iiPc1ClosureVerification`, 10/10), PC2 workspace (12/12), and this
  dispatch's own new suite (16/16) — 55/55 live-DEV tests passing across
  every II live-DEV suite that touches SIP/X-Ray/Tax/Overview.

**Exact final numbers** (all four gates run against a fully clean
`npm ci` reinstall — this session's node_modules had pre-existing,
reproducible extraction corruption for several unrelated transitive
packages (`pdf-parse`, `@electric-sql/pglite`, `dlv`, `util-deprecate`,
confirmed via `npm cache verify` finding 443 corrupted cache entries);
none of it was caused by or related to this dispatch's changes, and a clean
`npm ci` resolved all of it):

- `npx tsc --noEmit`: **0 errors.**
- ESLint on changed files (`taxRepository.ts`,
  `iiPc2F1ReadSideMutationLiveDev.test.ts`): **0 issues.**
- `npm run build`: **succeeds**, every `/investment-intelligence/*` route
  (including `/sip`, `/xray`, `/tax`, `/performance`, `/review`, `/data`)
  compiles as a dynamic server route.
- Full offline suite (`npx vitest run`): **5957 total, 5951 passed, 1
  failed, 5 pending/skipped.** The 1 failure is exactly
  `aiResidualClosureFailClosed.test.ts` A4 — re-run in isolation, confirms
  only A4 fails there (a transient A1 collection-time flake appeared once
  under heavy concurrent background load in this session and did not
  reproduce on a clean re-run). 8 test files show as "failed" at the
  file level: the 1 above, plus exactly the 7 known env-dependent Resources
  files (`resourcesAdminR1_2`, `resourcesAdminRoleCtaHotfixLiveDev`,
  `resourcesDiscoveryR1_6LiveDev`, `resourcesEditorR1_3`,
  `resourcesPublicR1_5`, `resourcesR1_1`, `resourcesR1_4LiveDev`), all
  failing identically with `supabaseUrl is required` at import time — this
  is the documented, unchanged baseline; no new failure was introduced.
- Live-DEV suites (`vitest.livedev.config.ts`, re-run twice: once
  immediately after the fix, once again after the clean `npm ci`): **55
  live-DEV tests total, 55 passed** — F1 (6/6), F2 (11/11), PC1 + PC1
  Closure (10/10), PC2 workspace (12/12), and this dispatch's own new
  `iiPc2F1ReadSideMutationLiveDev.test.ts` (16/16).

## Cleanup

All synthetic users, households, accounts, transactions, holdings,
NAV/fund-holdings-disclosure rows, tax lots/consumptions/capital-gains rows
and `ii_r5_analytics_results` rows created by
`iiPc2F1ReadSideMutationLiveDev.test.ts` are deleted in its own `afterAll`
and the zero-residue proof re-queries every table fresh (not inferred from
delete responses) before the suite completes — this ran as part of the
16/16 pass above. The one shared/reference row this suite created
(`ii_instruments` + its `ii_scheme_tax_classification` row) is deleted
explicitly by id in the same `afterAll`, matching F1/F2's own convention for
not blanket-deleting shared catalogue tables.

Independently re-verified after the suite's own `afterAll` completed, from a
fresh ad-hoc script against real DEV (not inferred from the suite's own
assertions): `auth.admin.listUsers()` shows **zero** remaining
`fhip-synthetic.test` users tagged `pc2f1-` (and zero of ANY prior II
live-DEV suite's synthetic users — the DEV project carries no leftover
synthetic accounts from this whole line of work), and zero
`ii_instruments` rows named `PC2F1%`.

## Verdict

**UNCONDITIONAL FULL PASS — FIXED.**

SIP: SAFE_DERIVED_MATERIALISATION (no change needed).
X-Ray: SAFE_DERIVED_MATERIALISATION (no change needed).
Tax: SAFE_DERIVED_MATERIALISATION (one finding — `closed_at` provenance
drift — found, RED-tested, fixed, GREEN-tested, regression-checked against
F1/F2 unmodified).

No GET handler anywhere in `app/api/investment-intelligence/**` can produce
an observable financial-state mutation from a read: no duplicate row, no
changed tax/SIP/X-Ray figure, no cross-user leak, no page-order dependency,
and (after the fix) no drifting provenance timestamp.
