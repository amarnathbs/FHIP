# NAV 1 — `pc6_selective_historical_hydration` production incident (2026-09-28/29)

## What was actually wrong (read-only production diagnosis, live-verified)

The batch's own telemetry (`ii_reference_import_batches`, `batch_kind = 'nav_hydration'`,
`error_code = 'HYDRATION_NOTHING_SUCCEEDED'`) named one instrument failing every run. Traced it
concretely (joined through `ii_instruments` / `ii_instrument_identifiers`, not guessed from the
aggregate count):

- **Instrument** `5d826f98-d459-4c5a-82a6-74b2649ff2fa`, `instrument_name`:
  **"NAV1 P4 Unresolvable Test Scheme - Direct Plan - Growth"**, ISIN `INF999Z99ZZ9`, AMFI scheme
  code `999999`, `amc_name`: "Synthetic Unresolvable Mutual Fund" — a fake identifier that will
  **never** exist on AMFI or TIGZIG, by design.
- Created in **production** at `2026-09-28T05:59:49Z`. This is checkpoint 9 of the NAV1 P4 UI
  journey (`scripts/nav1_p4_ui_journey_fixture.ts` generates the fixture PDF
  `lib/fixtures/investment-intelligence/nav1-p4-ui-journey/nav1-p4-unresolved.pdf`; the docs
  status note `_status_2026_09_28/NAV1_Status_Against_2026-09-21_Prompt.md` explicitly says "The
  18-point browser walkthrough on the live production site: I can't sign in to production
  myself... ready for you to run" — this was the PO running that walkthrough on production,
  deliberately exercising the "deliberately unresolved row" scenario).
- The upload went through the real pipeline and was **certified** (`ii_portfolio_truth_status`,
  `history_completeness = 'complete_from_inception'`), which is exactly the
  `accepted_statement_history` dependency that makes selective hydration treat this instrument as
  permanently needing history back to 2006-04-01. Since scheme `999999` can never resolve, this
  fetch **fails every single 30-minute tick, forever**, and — because it is usually the *only*
  instrument in the run that needs an actual provider fetch (the 19 real held funds are already
  covered) — the **entire batch** is classified `HYDRATION_NOTHING_SUCCEEDED` (a hard job-level
  FAILED), driving `ii_reference_job_control.consecutive_failures` up every run (17 as of
  2026-09-28T14:00 UTC) even though every real fund is fine.
- This is a dedicated, self-contained **test user** (`196cadf7-3043-4b4f-9386-f7ec3a4a5767`,
  household member "Dinesh" / relationship `self`, created the same day at `04:34 UTC`) with
  exactly 3 mf_folio accounts: the two **real, legitimate** fixture funds (PPFAS `122639`, SBI
  `103504` — not part of this incident, working correctly) and this one dedicated, deliberately-
  fake folio (`dc5ee103-68e7-4e14-92ea-0e41e07ad013`, folio `927010000009`, institution name
  literally "Synthetic Unresolvable Mutual Fund"). Nothing here touches a real customer.

**This is not a genuine data-availability gap** (unlike the pre-existing, legitimate HSBC/L&T
merger-lineage gap in `ii_nav_source_coverage_gaps`, migration `0219`) and **not a code bug in the
fetch/parse logic**. It is test-fixture cleanup debt left behind after an authorized production
test. The correct fix is deleting this one dedicated test folio's rows, not recording a permanent
"coverage gap" for a fake ISIN/AMFI code that never should have been treated as real market data.

## The ledger-write bug, re-checked fresh (it is not what it first looked like)

The incident's original framing (`ii_nav_hydration_attempts` showing ZERO rows with
`consecutive_failures >= 3`) was **re-verified live and found to already be stale** by the time
this session queried production (2026-09-28T14:02 UTC): the ledger row for this instrument shows
`consecutive_failures: 12, attempts_total: 12, last_outcome: 'fetch_failed'` — the write path
**is** persisting failures correctly, most of the time. Reporting the original framing as still
true would have been rounding up a stale snapshot into a conclusion; it is not repeated here.

A **real, separate, smaller defect** was found and fixed instead: this instrument's fallback
provider (TIGZIG) retries up to 6 times with exponential backoff, each attempt allowed up to 60
seconds — worst case ~6.5 minutes for one instrument that will *never* succeed. One run (batch
started `2026-09-28T13:30:00Z`) took the full 30-minute stale-running window before the *next*
tick's own stale-batch reconciliation marked it `STALE_RUNNING_RECONCILED` — consistent with the
platform killing that invocation mid-fetch before it ever reached the ledger write, silently
losing that tick's attempt record (this matches `attempts_total: 12` lagging behind the ~16 ticks
that should have run since the instrument's creation). This is the same failure class already
named in this codebase's own history for the daily job ("Amplify's 28 s request limit... an 831
date lookup", `docs/nav1/NAV1_Production_Final_Certification_2026-09-25.md`) and for hydration
itself (`httpFetchWithRetry.ts`'s own comment: "the second real production hydration run vanished:
no history floor and no batch record in 20 minutes").

## What this branch fixes

`fix/nav1-hydration-incident-2026-09-29` (based on fresh `origin/main`):

- `lib/services/investment-intelligence/pc6/adapters/historicalNavAdapter.ts`: adds an optional
  `retryBudget` field to `HistoricalNavRequest` (`{ maxAttempts, timeoutMs }`), purely additive —
  an adapter that ignores it keeps its existing defaults.
- `lib/services/investment-intelligence/pc6/adapters/tigzigHistoricalAdapter.ts` and
  `amfiHistoricalAdapter.ts`: honour `retryBudget` when supplied, overriding the provider's usual
  6-attempt/60 s (TIGZIG) or 3-attempt/45 s (AMFI) defaults.
- `lib/services/investment-intelligence/pc6/selectiveHistoricalHydrationJob.ts`: once an
  instrument's own attempt ledger already shows `HYDRATION_PERSISTENT_FAILURE_THRESHOLD` (3+)
  consecutive failures, the job now asks with a single, 20-second-bounded attempt instead of the
  full retry cascade. A known-bad instrument does not need six retries to prove it again; one
  bounded check still notices if the provider starts answering, without risking the run or the
  ledger write. Covered by a new test,
  `tests/unit/nav1HydrationRetryBudgetShortCircuit.test.ts` (4 cases: fresh instrument keeps the
  full budget, below-threshold keeps the full budget, at-threshold gets the bounded budget, and
  the real production case — 12 consecutive failures — gets the bounded budget). All 106
  pre-existing hydration/adapter unit tests still pass unmodified.

This fix is independently valuable regardless of the test-fixture cleanup below: it applies to
*any* instrument that becomes persistently unresolvable in the future (a real merger-lineage gap,
a withdrawn scheme, etc.), not just this one.

**No migration is needed for this fix** — it is application code only.

## What this branch deliberately does NOT change

- **Job/batch-level status semantics** (whether "19/20 succeeded, 1 known-persistent failure"
  should be a batch PASS/`succeeded_with_exceptions` instead of hard FAILED). This is a real,
  named open question — see below — left alone because changing `classifyHydrationRun`'s
  contract touches test surface (`nav1HydrationFairOrdering.test.ts` has explicit negative
  controls on the current status rule) that deserves its own dedicated pass, not a
  same-session addition. Once the test folio below is deleted, this symptom disappears on its
  own for THIS incident regardless.
- Anything under `documentProcessing.ts`, `ensureSelfMember.ts`, `householdContext.ts`,
  `auAccountResolution.ts`, `ReviewCentreClient.tsx`, `InvestmentIntelligenceClient.tsx`,
  `lib/pc5/`, `reconciliationCases.ts`, `lib/read-models/income.ts` — untouched, per the mission's
  own constraint (other in-progress work in the same shared worktree).
- NAV1 historical-data deletion (the separate, still-frozen, PO-gated mission) — untouched. This
  is the recurring *collection* job's own test-data debt, not that.
- Migration `0202` — not touched, not referenced.

## OPEN QUESTION for the PO (named, not resolved here)

Should "every real held fund succeeded, only an already-known-persistently-failing instrument
failed" be a batch-level PASS (or a new `succeeded_with_exceptions`-style status) rather than hard
FAILED? Today it is hard FAILED every time, which is what has been driving
`ii_reference_job_control.consecutive_failures` to 17 even though nothing about the 19 real funds
is wrong. Leaving this alone for now, per the mission's own guidance to not force a change without
confidence — flagging it here instead.

---

## Recommended cleanup: delete the one dedicated test folio (NOT executed — read-only diagnosis only)

This was NOT run. It touches production data and this session cannot and should not write to
production directly. Everything below is for the PO (or an operator with production SQL access)
to review and run themselves, via the Supabase SQL editor for project `twwpnltizhtjxhamyoxt`.

**Scope, precisely:** only the one dedicated "Synthetic Unresolvable Mutual Fund" folio inside the
existing NAV1 P4 UI-journey test user. The other two accounts on the same test user (PPFAS,
SBI — real, resolvable schemes) are untouched; they are legitimate proof that the real-fund path
works and there is no reason to delete them.

1. Run `01_verify_before_delete.sql` first and read every row it returns. It exists to catch a
   *changed* situation (e.g. if this folio has since accumulated more transactions, or if
   `instrument_id`/`account_id` no longer match what this document names) before anything is
   deleted — if it returns anything unexpected, STOP and re-diagnose rather than running the
   delete.
2. Only if `01` looks exactly as expected, run `02_delete_test_folio.sql` — deletes child rows
   before parents, by explicit row id (not a broad `WHERE` on a shared column), so it cannot touch
   any other user's data even if IDs were somehow reused.
3. Optionally, `03_verify_after_delete.sql` confirms all rows are gone and that the recurring
   hydration job now sees 19 (not 20) instruments needing hydration on its next tick, all already
   covered.

After this cleanup, `pc6_selective_historical_hydration` should return to a clean `succeeded`
status on its very next tick (no instrument left needing a fetch that cannot resolve), and
`ii_reference_job_control.consecutive_failures` will reset to 0 the next time it runs
successfully — no code change is required for that to happen; deleting the test data removes the
condition entirely.
