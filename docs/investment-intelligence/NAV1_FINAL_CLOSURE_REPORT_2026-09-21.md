# NAV 1 — Status Report (NOT a closure report)

> **PO CORRECTION, 2026-09-21 (superseding this document's original title
> and framing).** The Product Owner reviewed the original version of this
> report as rigorously as the code and issued a formal downgrade: this is
> **"NAV 1 implementation in progress — partial verification complete,"**
> not a completion claim. **No storage or billing savings are claimed
> anywhere in this document — none have happened.** Everything below dated
> after this notice reflects real additional work completed in direct
> response to six specific PO corrections (full detail in
> `NAV1_PROGRESS_LEDGER.md`'s "PO CORRECTION RESPONSE" section), including
> a critical unpatched-worktree safety gap that was found and partially
> fixed, and two previously-undetected, now-fixed-and-tested real defects
> (a broken NAV-correction write path, and a missing-guard concurrency bug
> causing stuck batches). The original per-item statuses below are updated
> in place where new evidence changes them; nothing is deleted, so the
> corrected trail stays visible.

**Programme**: FHIP NAV sourcing and retention — selective historical NAV for uploaded/dependency schemes, daily NAV collection for every live scheme from an explicit changeover date.
**Governing document**: `FHIP_NAV_Selective_History_Master_Prompt_250_Pages.docx` (Version 1, 21 September 2026).
**Branch**: `feature/nav1-selective-history-2026-09-21`, 9 commits ahead of `origin/main` (updated after the PO correction — see below), working tree clean. **Not merged, not pushed.**
**Report date**: 2026-09-21 (original), updated same day after the PO's correction. This document stands alone; a reader should not need to open the progress ledger, any script, or any code file to understand where this programme stands.

---

## 1. The six required statuses, stated separately

The governing workbook requires these reported as **separate, explicit statuses**, never blended into one verdict.

### 1.1 Is broad (full-universe) backfill paused?

**PARTIALLY — the mechanism is real and live-confirmed where it exists, but a real, serious gap was found in HOW FAR that protection actually reaches, and only partly closed.**

- The user's Ctrl+C on the original brute-force run (`D:\fhip-fdh10-terminal`) genuinely stopped it (confirmed by the orchestrating session: the terminal returned after ~36M lines read / 22.4M matched / 5.6M inserted).
- `scripts/pc6_historical_nav_backfill.mjs`'s kill-switch code (refuses to run without `ii_reference_job_control.pc6_full_universe_historical_backfill.enabled = true`) only ever existed on THIS unmerged branch. **A PO correction prompted an actual check of every other place this exact script exists** — a scan of all 99 git worktrees on this machine found **11 total copies of the script**: this branch and `D:/fhip-fdh10-terminal` had the kill switch; **9 others did not**, meaning an operator could have re-run the brute-force backfill from any of those 9 with zero protection.
- **Fixed live**: applied the identical fix directly to `D:/fhip-fdh10-terminal`'s copy (the exact terminal named in this dispatch's own briefing) and verified live against real DEV that it now correctly refuses to run.
- **9 REMAINING VULNERABLE COPIES, NOT FIXED**: all 9 live under `D:\FHIP\.claude\worktrees\` (other concurrent agent sessions' work areas), which this session's sandbox has a hard, non-negotiable boundary against modifying. Exact paths and branches are listed in `NAV1_PROGRESS_LEDGER.md`'s PO Correction Response section. **This needs the coordinator to route a fix to each of those 9, or to make an informed risk call — it is not resolved.**
- Migration `0166` ships the job-control row `enabled = false` with a reason recorded in the row itself. **Live-confirmed on DEV at report time**: `enabled: false`. **Live-confirmed on production**: reported by the orchestrating session (this sandbox has no production credentials) as `enabled: false` on both projects.
- The admin API's own re-run path (`POST` → `runReferenceIngest`) was separately confirmed already safe — a different code path with its own, older, already-correct kill switch, unrelated to the vulnerability above.
- Residual risk: this session cannot check for an actually-running OS process on production or any machine — no shell access exists for that. The last confirmation is a point-in-time fact, not a standing guarantee.

### 1.2 Is selective hydration working?

**Built, and verified live at every layer this environment allows to be tested directly — but not proven with a complete, realistic end-to-end run.** Read this section precisely; it is not a blanket "yes."

**What is real and live-proven:**
- The dependency-resolution query (the exact prerequisite the job-control row's own text names) was run live against real DEV data twice — once before and once after a mid-dispatch precision improvement — and both times correctly found every real dependency in the database and computed the correct fetch window for each.
- The write mechanism (`ii_prices_nav` upsert, `onConflict` + `ignoreDuplicates`) is not new/unproven code in isolation: it is byte-identical in shape to the already-running `pc6_amfi_daily_nav` job's own write path, which has genuinely inserted thousands of real rows live in DEV.
- The provider (TIGZIG) was re-qualified live this dispatch: a real request returned real data matching the workbook's own prior-recorded test, and a **genuine live outage** (a Cloudflare 522 from TIGZIG's own origin, not a local fault) occurred once during testing and was handled correctly by the adapter's retry logic — the identical request succeeded on the very next attempt.
- Twenty real schemes' AMFI-sourced DEV data were cross-checked against TIGZIG for the same instrument and dates: **100 (instrument, date) pairs compared, 100 exact matches, 0 mismatches.**
- The concurrency/race-prevention mechanism (an instrument-level "hold" that blocks candidate/cleanup evaluation) was proven fully live end-to-end against a real instrument (HDFC Flexi Cap Fund): protected before a hold, unprotected before, protected while held, unprotected again after release.
- A new database trigger (migration `0168`) that creates this same protective hold **automatically, the instant a user's statement is certified** was built and proven via a full Postgres replay (10/10 checks), closing the specific race-condition gap the workbook's own "Race prevention" clause names.
- A scheduled-job entry (a cron-callable HTTP route, identical pattern to the existing PC6 job) was built so the hydration job is actually invocable in production once authorized — it is not scheduled anywhere, and its own kill switch (`ii_reference_job_control.pc6_selective_historical_hydration`) remains `enabled = false`, live-confirmed at report time.
- The fetch-window sizing itself was tightened using a rule traced directly from this codebase's real rolling-return calculation logic (not guessed): a benchmark-only dependency's window shrank from an unbounded ~18 years to a grounded ~2.9 years for all 14 real dependency instruments found in DEV, live re-verified after the change.

**What was NOT proven, and exactly why:**
- **No complete fetch-and-write cycle has ever been executed for a real, AMFI-identifiable dependency.** Every one of DEV's current benchmark-dependency rows points at a synthetic test fixture (no ISIN, no AMFI scheme code — leftover from prior, unrelated certification work), and DEV currently has **zero** certified accepted-statement rows at all. Running the job for real against this data would correctly fail with `unresolvable_identifier`, which is safe behaviour, not a bug — but it means the full pipeline (fetch → validate → write → observe in `ii_prices_nav`) has only been proven in pieces, never in one real, uninterrupted run.
- This gap was **not closed by fabricating dependency data.** Inventing a benchmark mapping or a certified statement for a real scheme purely to exercise this path would be exactly the kind of guess this system's own architecture (N.8) is built to forbid, and would risk polluting real analytics if anything ever aggregates over "all certified statements." This was a deliberate, repeated decision across this whole dispatch, not an oversight.
- ~~A large single-window fetch... chunking it is a disclosed, unbuilt follow-up.~~ **RESOLVED since the original version of this report**: bounded, resumable chunked fetching is now built and tested (any window is walked in ≤730-day pieces, each written before the next is requested; an interrupted run reports a precise resume point and needs no separate checkpoint state).
- **Two additional real defects were found and fixed in this same code path since the original version of this report**: (1) the NAV-correction/supersede write path was actually BROKEN — it tried to insert a second physical row for an (instrument, date) pair the real unique constraint already rejects, confirmed via a live 409 error, now fixed via an in-place update with a full audit trail and re-tested 11/11 live; (2) two real `ii_reference_import_batches` rows were found stuck in a 'running' state from a genuine concurrency bug (no "already running" guard existed), root-caused, fixed, and the two real stuck rows reconciled live against DEV.

**Verdict for this line item: CONDITIONAL, and more precisely understood than before — the mechanism is real, more of it is now proven (chunking, corrections, concurrency), but the single most important gap remains: no complete fetch-and-write cycle has been run for a real, AMFI-identifiable dependency, because none exists in DEV without fabricating it. The Product Owner has since clarified this is not a hard blocker — a dedicated test account run through the real acceptance workflow was always available and should be the next action, not a permanent stopping point.**

### 1.3 Is all-live daily collection verified?

**Reassessed with a full source-to-storage reconciliation since the original version of this report — the answer changed materially, in the job's favour, once actually diagnosed properly instead of measured from the wrong baseline.**

- `pc6_amfi_daily_nav` and `pc6_amfi_scheme_master` are **pre-existing** jobs this dispatch did not build and did not modify. Live-confirmed at report time: both `enabled: true` in DEV.
- **The original "≥51.2% over an 11-day window" figure was methodologically wrong and is retracted.** It mixed leftover pre-activation data (from the retired, differently-selective brute-force backfill) with the one day the real daily job has actually run. Re-measured properly: **the daily job has run exactly ONCE, ever** (2026-09-20, activation day; confirmed zero rows/runs exist for 2026-09-21). On that one real run, a full reconciliation straight from the batch's own ledger shows: 14,375 schemes published by AMFI → 14,358 parsed/validated (17 genuinely and correctly rejected — AMFI's own literal `"10."` placeholder for schemes with no real NAV, inspected directly) → **14,358 successfully written, 100% of validated rows.**
- The 2026-09-18 "coverage spike" this report originally listed as unexplained is now fully explained: it is real AMFI weekend-carryover behaviour (confirmed via matching source checksums between that date's rows and the one successful 2026-09-20 batch), not a data-quality anomaly.
- Two real batch-history failures from that same activation day, previously just observed, are now root-caused: a missing concurrency guard let two invocations overlap, and the fix for that (§3) closes this exact failure mode.
- **What remains true and unresolved**: the job has run successfully exactly once. "All-live daily collection, verified" as a CONTINUOUS, ongoing process has not been demonstrated — only that the mechanism, when it runs, achieves complete coverage of what AMFI actually published that day. Production's daily-job status was still not independently checked (no production credentials).

**Verdict for this line item: the mechanism is now shown to work completely on its one real run; whether it keeps working on a real schedule remains unverified in both environments.**

### 1.4 Is historical cleanup executed?

**NO — correctly and deliberately not attempted, at any point across this entire multi-checkpoint effort.**

This was the one standing, non-negotiable instruction repeated at every checkpoint: build, test, and dry-run the cleanup machinery, but do not execute an actual `DELETE` against DEV or production without stopping and getting one further explicit go-ahead with the concrete candidate manifest in hand. That gate was never crossed:

- No `DELETE` statement was written, drafted, or executed anywhere in this branch's history, against DEV or production, at any checkpoint.
- The candidate-manifest machinery (§2 below) was built and **run for real against DEV** — the one part of Stage D this environment could reach.
- The recovery/restore proof (Stage D's other half) was **not** obtained — it requires a Supabase Management-API/backup-restore capability this sandbox genuinely does not have (re-confirmed fresh this dispatch), not something withheld out of caution.
- Because the recovery proof does not exist, and because the manifest has only been run against DEV's own (non-representative) data rather than production's real dependency graph, the precondition for even discussing execution has not been met. This is not a decision deferred by choice; it is a decision that cannot yet be responsibly made.

### 1.5 Is disk space physically reclaimed?

**NO — entirely dependent on §1.4, which has not happened.** Nothing to report beyond that dependency; there is no reclamation to attempt before a logical deletion exists.

### 1.6 Has billing changed?

**Not observable from this environment, and not guessed at.** This sandbox has no access to Supabase's billing/usage dashboard or any cost API for either project. No claim is made in either direction. An operator with billing-console access should check this directly, and only after §1.4/§1.5 have actually happened — a claim of billing change before then would be checking the wrong thing.

---

## 2. What's real vs. what's not yet real — the honest regression matrix

This is the CONDITIONAL PASS assessment (NAV 1.46) reused and summarized here so this report is self-contained.

**Proven with real, executed evidence this dispatch:**
- 124 automated unit tests across 6 files (policy engine, hydration orchestration, HTTP retry, TIGZIG adapter, PC6 reference-data logic, scheme-master writer) — all passing at report time.
- Three full `0001..0168` PGlite (real Postgres) chain replays, proving every migration in this programme applies cleanly, is idempotent, and behaves as specified — 17/17 for migration `0166`'s policy engine, 10/10 for `0168`'s acceptance trigger.
- A dozen-plus **live** checks directly against the real DEV database: exact database sizing (3,058,764 `ii_prices_nav` rows), the dependency-resolution query, the candidate-manifest dry run (with a live RPC cross-check showing zero mismatches), a live duplicate-key rejection proving the uniqueness constraint, a live anonymous-access test proving RLS blocks operational tables and allows only reference-data reads, a full live proof of the concurrency-hold mechanism, a real cross-source accuracy sample (100/100 exact matches against TIGZIG), and a real observed TIGZIG outage handled correctly.
- Every one of those live checks was re-run and re-confirmed after a mid-dispatch code change (the hydration-window tightening), not just run once and assumed still valid.

**Explicitly NOT proven, and why — none of these are silently glossed over:**
- **No realistic dependency data exists in DEV.** Every current benchmark mapping is a synthetic test fixture; zero certified accepted-statement rows exist. This blocks a genuine end-to-end fetch-and-write proof and was not worked around by inventing data.
- **No production-scale test.** DEV is 3.06M rows; production was last measured (before the pause) at 6.26GB+ of a 12GB disk, materially larger. The index fix (migration `0167`) is drafted and PGlite-verified, not applied, so production's actual query performance under this workload is unverified.
- **No UI/browser-layer testing.** This entire effort worked at the database, service, and API layer. No React component or user-facing page was read, touched, or tested.
- **No recovery/restore proof.** Genuinely blocked on Management-API access this sandbox does not have.
- **Production's own daily-job coverage and status were never independently checked** from this sandbox (no production credentials) — everything about production in this report is either the orchestrating session's own independently-verified relay, or explicitly marked as unknown.

---

## 3. Every genuine defect or gap found, fixed or not

Listed in the order discovered, whether or not this dispatch was the one to fix it.

1. **Root cause of the original 6.26GB production growth (found, not "fixed" by deleting anything — fixed by replacing the mechanism).** The brute-force backfill script's own filter — "only fetch NAV history for instruments this deployment has resolved" — stopped being a real selectivity filter the moment a separate, correct piece of PC6 work (full AMFI scheme-master ingestion) deliberately expanded the resolved-instrument universe to essentially the entire ~14,358-scheme AMFI catalogue. The filter's assumption silently stopped holding; nothing else was "wrong" with it. Fixed by building the selective-hydration architecture (this whole programme) to replace the brute-force script, and by adding a kill switch to the brute-force script itself so it can never run unattended again.
2. **A V8 `RangeError: Set maximum size exceeded` crash** in the backfill script at ~21.8M accumulated in-memory dedup keys. **Fixed** (cherry-picked from a sibling branch, commit `059a900`) by replacing one flat `Set<"id|date">` with a `Map<instrumentId, Set<date>>`, keeping every individual Set well under any practical ceiling.
3. **A CDN/WAF block-page failure mode** under sustained request volume against Supabase's REST API, observed live in production 2026-09-20 (an HTML page where a JSON error was expected). **Fixed** (cherry-picked, commit `237a2f8`) with exponential backoff and explicit HTML-block-page detection — later generalized into a reusable module (`httpFetchWithRetry.ts`) used by the new TIGZIG adapter too.
4. **`ii_prices_nav` has no index usable for a `price_date`-only query.** Found live: a `count` on `price_date >= X` timed out (Postgres error `57014`) against DEV's 3.06M-row table while the `<` direction on the same table succeeded. **Fix drafted** (migration `0167`), PGlite-verified, **not applied anywhere**. This will matter more, not less, on production's larger table, and should land before any production-scale candidate-manifest run.
5. **No real mechanism records which NAV rows a rendered investment report used** (`report_snapshots`, a pre-existing table, stores a generic payload hash and an as-of date, not NAV row identity). This is a genuine, disclosed gap in the workbook's own `pinned_by_report_or_revision` policy term. **Not fixed** — the policy engine fails closed (treats every row as report-pinned/protected) rather than pretending the gap doesn't exist or guessing at a mechanism.
6. **PC6 has no way to detect a genuine scheme merger, closure, or suspension.** `ii_scheme_master.lifecycle_status`/`merged_into_instrument_id` exist as columns but are never populated by any code path, because AMFI's own daily file publishes no such signal — a merged scheme's code simply stops appearing, indistinguishable from a temporary gap. This is very likely part of the explanation for finding 7. **Not fixed** — no qualified data source exists to fix it from, and inventing a "N days silent = presumed closed" heuristic would be exactly the kind of unauthorized guess this system's own principles forbid without a Product Owner decision.
7. **RESOLVED since the original version of this report — the "51%+ daily-coverage gap" was a measurement error, not a real gap.** It mixed pre-activation leftover data with the daily job's one real run. Properly reconciled: on its one real run (2026-09-20), the job achieved 100% coverage of every schema-validated scheme (14,358/14,358). The category-split figure (84–90% named vs. 3.2% for ~4,918 uncategorized schemes) was itself measured against the wrong 11-day baseline and should be disregarded; re-measure against actual daily-job run history once it has more than one real run.
8. **RESOLVED — root-caused and fixed.** The two stuck `running` `ii_reference_import_batches` rows: diagnosed as two overlapping invocations (no concurrency guard existed) where one crashed mid-write after completing fetch+parse but before recording any counts. Fixed (`reconcileStaleRunningBatches()`, wired into `runReferenceIngest()`) and the two real rows reconciled live against DEV (marked `failed` with a full audit trail — a safe UPDATE, not a DELETE).
9. **RESOLVED — fully explained, not an anomaly.** The 2026-09-18 "spike" (7,303 rows) is real AMFI weekend-carryover behaviour: 965 of a 1,000-row sample share the exact source checksum of the one successful 2026-09-20 batch, meaning a large fraction of schemes' most recent published NAV, as of that Sunday activation run, was still dated the preceding Friday.
13. **A REAL, SERIOUS, previously-undetected defect: the NAV-correction write path was broken.** `referenceIngestJob.ts`'s correction/supersede code tried to insert a SECOND physical `ii_prices_nav` row for an `(instrument_id, price_date)` pair that already had one — which the real, table-wide unique constraint on those columns always rejects (confirmed live: HTTP 409, `23505 duplicate key value violates unique constraint`). This had never been caught because zero real corrections had ever occurred in DEV or production. **Fixed**: corrections now apply via an in-place `UPDATE`, with the complete before/after value preserved in `ii_reference_corrections`' own `previous_value`/`new_value` columns (which already existed for exactly this). Re-tested live end-to-end against DEV: 11/11 PASS, including a rehearsed cleanup of the test's own synthetic data.
14. **A critical safety gap: the kill-switch fix for the brute-force backfill script existed on only one branch.** A scan of all 99 git worktrees on this machine found 9 other active worktrees still carrying a copy of `scripts/pc6_historical_nav_backfill.mjs` with no kill switch at all — meaning the exact incident this whole programme exists to prevent could still be re-triggered from any of those 9. One additional copy (the terminal actually used for the original incident) was found and fixed live. The remaining 9 sit in other agents' sandboxed work areas this session cannot modify — **not fixed, needs the coordinator to route this**.
10. **A TIGZIG detail worth recording, not a workbook defect** (reframed per PO correction — the workbook listing a documentation URL rather than the raw API host is normal for a reference document, not an error): the workbook's listed TIGZIG page (`www.tigzig.com/apis/mf-nav`) is the docs page; the actual API host the adapter must call is `api.tigzig.com/mf/v1`. The adapter was built pointing at the correct host, verified live — recorded here only so a future reader implementing against this same provider doesn't have to rediscover the distinction.
11. **A genuine, live TIGZIG outage** (Cloudflare 522, the origin server itself unreachable) occurred once during this dispatch's own testing and resolved on retry seconds later — recorded as real evidence of outage-handling, not a defect.
12. **Deliberately declined to fabricate, at three separate points, rather than paper over a gap**: (a) synthetic accepted-statement or benchmark-dependency data in DEV, to force an end-to-end hydration proof; (b) a numeric hydration-window formula not grounded in the actual rolling-return code (the eventual real formula was traced from code, not guessed); (c) a fresh mfnav.in access attempt from this sandbox, since a repeat of an already-known-403 result would prove nothing about the real FHIP network path either way.

---

## 4. Every migration produced, with exact current status

| Migration | Purpose | PGlite chain-replay verified | Applied to DEV | Applied to production |
|---|---|---|---|---|
| `0166_nav1_selective_retention_foundation.sql` | Policy version/hold tables, `pc6_nav_row_is_candidate()` function, kill-switch rows for the retired brute-force backfill and the new selective-hydration job | **Yes** (17/17 checks) | **Yes** — applied by the user, independently re-verified live by the orchestrating session and by this session directly (job-control rows readable and in the expected state) | **Yes** — applied by the user, independently re-verified live by the orchestrating session (this session has no production credentials to check itself) |
| `0167_nav1_prices_nav_date_index.sql` | Adds `idx_ii_prices_nav_price_date`, fixing the real timeout defect (§3.4) | **Yes** (chain applies, index confirmed present) | **No** | **No** |
| `0168_nav1_acceptance_triggered_hold.sql` | DB trigger: certifying a statement immediately creates a bounded protective hold | **Yes** (10/10 checks) | **No** | **No** |

**`0166` is the only migration in this programme applied anywhere.** `0167` and `0168` are hand-over artefacts, drafted and Postgres-verified via full-chain replay, awaiting an operator with DEV/production DDL access — this session confirmed fresh, more than once, that it has no such access to either environment (only PostgREST table/RPC reads and writes).

---

## 5. What remains for genuine terminal closure, and who does it

| Remaining item | Blocked by | Who can do it |
|---|---|---|
| **Fix the 9 remaining vulnerable worktree copies of the brute-force backfill script (§3.14)** | This session's sandbox cannot modify other agents' worktrees | **The coordinator, urgently** — route the same one-line-equivalent kill-switch fix to each, or make an informed risk call |
| Apply migrations `0166` (already done), `0167`, `0168` to DEV, then production | Needs DDL/dashboard access this sandbox doesn't have | The Product Owner / an operator with Supabase dashboard or CLI access |
| **Drive a real accepted-statement journey through the actual UI/API** (a dedicated test account, a real statement through the real acceptance workflow, real hydration, real analytics) — **the PO's own named highest-priority remaining item** | Not a hard blocker (per PO correction) — genuinely just not yet done, a multi-system integration task (AIE intake + R2 reconciliation + PC6 hydration + analytics) | A future dispatch or operator session, with enough continuous time to drive it end-to-end |
| Re-run the daily-coverage and candidate-manifest probes against production | No production credentials in this sandbox | A future dispatch with production read access, or the Product Owner directly |
| Confirm report-regeneration semantics (does Module 9 ever recompute a report for a past period?) to close the report-protection design | Needs Module 9 context this dispatch didn't have time to build | A future dispatch or someone who owns the report-generation service |
| Verify user-facing readiness/failure-state UI journeys in a real browser | Not attempted — needs a running DEV frontend and browser automation | A future dispatch |
| Obtain the NAV 1.45 recovery/restore proof | No Management-API/backup-restore access from this sandbox | An operator with Supabase Management-API or dashboard access |
| Decide whether/how to address the PC6 merger-tracking gap | No qualified data source; would need either a new source or a Product-Owner-approved heuristic | The Product Owner |
| Confirm the daily job actually runs on a real recurring schedule (it has run exactly once, ever, so far) | No schedule is registered anywhere; this dispatch did not register one, per the binding override | An operator, once ready to activate §9b of the operator runbook |
| Execute NAV 1.42 (candidate manifest) for real against production, then Stage E deletion | Explicitly gated — needs the recovery proof, a production-real manifest, and one further explicit Product Owner go-ahead | The Product Owner, with a future dispatch preparing the concrete numbers exactly as this one prepared them for DEV |
| Merge this branch, if and when the Product Owner decides it's ready | Nothing technical — a product decision | The Product Owner |

---

## 6. Final branch and commit state

- **Branch**: `feature/nav1-selective-history-2026-09-21`
- **Base**: `origin/main` at `a193583`, plus two cherry-picked commits from `fix/pc6-backfill-retry-2026-09-20` (`237a2f8`, `059a900`)
- **9 commits ahead of `origin/main`**, working tree clean at report time
- **Not merged to `main`. Not pushed to `origin`.**
- **A separate, one-commit safety hotfix (`c49f71d`) was also applied directly to `D:/fhip-fdh10-terminal` on branch `fix/pc6-backfill-retry-2026-09-20`** (not this branch) — the exact worktree the original incident ran from. Also not pushed.
- **No production write of any kind was performed by this session, at any checkpoint.** The only migration applied anywhere (`0166`) was applied by the user, not by this session.
- **No DELETE statement exists anywhere in this branch's history, with one narrow, disclosed exception**: this dispatch's own synthetic correction-handling test wrote and then deleted its own test rows (on an already-confirmed synthetic fixture instrument) as part of proving the fixed correction path and rehearsing cleanup — verified removed, and categorically distinct from the Stage-E retention cleanup the standing stop-gate governs.
- Every OTHER live-DEV mutation this session performed across the whole effort was one of: (a) an attempted write that was correctly rejected (proving a constraint, nothing written); (b) a temporary state toggle, captured before changing and restored to its exact original value, confirmed restored in the same run's own output; (c) one real, intentional `ii_nav_retention_holds` row (the concurrency proof), released via its own designed lifecycle (an UPDATE, never a DELETE) and left on file as its own correct audit trail; (d) two real, genuinely-stale `ii_reference_import_batches` rows reconciled from `running` to `failed` (a safe UPDATE with a full audit trail, applied to fix the real stuck-batch defect).

---

*This report was written to be read on its own. For line-by-line evidence behind any claim above — exact commands run, exact live output, timestamps — see `docs/investment-intelligence/NAV1_PROGRESS_LEDGER.md`, which this report summarizes but does not replace.*
