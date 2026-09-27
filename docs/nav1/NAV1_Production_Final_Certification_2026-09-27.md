# NAV 1: Production Final Certification (Phases P0 to P9), 27 September 2026

**Brief:** `NAV1_Production_Completion_Master_Prompt_2026-09-24 (1).md`, updated 27 Sep 2026 (Australia/Sydney). It is authoritative.
**Session window:** 26 Sep 2026 22:47 to 23:5x UTC (27 Sep morning in Sydney).
**Scope:** P0 to P9. The session stops at the P9 package. The PO's deletion decision is **NO**. P10 (Stage E deletion), P11 (reclamation) and P12 (post-cleanup certification) were not executed and are not authorized.
**Companion:** `NAV1_Production_Final_Certification_2026-09-25.md` holds the earlier detail. Where it and this report disagree, this report is current.

**Evidence classes** (used on every row below):

- **Verified**: observed in this session through a live read-only production GET, a live DEV operation, or a re-run test.
- **Operator-confirmed**: the PO or the orchestrating session did it; not independently observed here.
- **Repository evidence**: true in the named commit, but not live-proven.
- **Blocked**: cannot be done with this session's access or authority.
- **Not tested**.

---

## 0. Identity, access and boundaries

**Repository**

| Item | Value | Class |
|---|---|---|
| `origin/main` | `bc47a9f` (merge of `fix/nav1-production-completion-2026-09-25` @ `6199281`, **without** 0202) | Verified (`git fetch`, 26 Sep 23:4x UTC) |
| Deployed production SHA | `bc47a9f`. Amplify app `d3iiacugdm5tup`, job 244, SUCCEED, 22:39:06–22:44:28 UTC 26 Sep (`list-jobs`) | Verified |
| Deployed code is live, not just built | The first hydration tick after job 244 (23:00:00 UTC) carries `notes.telemetry` with `ordering = least_recently_attempted`. The 22:30 tick, before job 244, had no telemetry. | Verified |
| This session's branch | `fix/nav1-completion-2026-09-27`, based on `bc47a9f`, 0 behind / 5 ahead of `origin/main`, pushed. HEAD is in §12. | Verified |
| Merged to `main` by this session | No. Not authorized. | — |

**Access used**

- **Production** (`twwpnltizhtjxhamyoxt`): PostgREST, **GET only**.
  - Every production read went through a client that asserts the host and throws on any other method or on a request body.
  - The scheduled-proof checker has no code path that can send any other method.
- **DEV** (`vqycarelcoijzwlpkpcz`): PostgREST read and write. There was one write sequence on the DEV hydration job-control row; it was restored exactly (§D).
- **AMFI** public endpoints: a few sequential GETs.
- **Amplify**: `list-jobs` only. `get-job` is denied to IAM user Amar.

**Not available:**

- SQL or DDL on either database;
- the `cron`, `net` and `pg_catalog` schemas;
- the Supabase Management API or backups;
- a production anon key;
- sign-in to the deployed UI. The agent may not enter passwords on a non-localhost site.

**Prohibited throughout, and not done:**

- any production write, migration, RPC POST, cron or kill-switch change;
- any production `DELETE`;
- merging or pushing to `main`;
- force-push, `reset --hard`, or a bare `git stash`.

**Production mutations by this session: zero** (§D).

---

## A. Executive verdicts

The PO has deliberately deferred deletion. The brief (§18) therefore requires two separate verdicts.

### NAV1 FUNCTIONAL PRODUCTION STATUS: **CONDITIONAL PASS**

**What works in production now (Verified)**

- **Daily NAV collection.**
  - The first genuine scheduled window after the 28-second fix (26 Sep, 03:30–04:30 UTC) passes all 13 pre-written criteria (§3.1).
  - It stored 8,456 NAVs dated 25 Sep over 11 calls.
  - **7,900 of 7,900** comparable values equal AMFI's own file.
  - All 17 held funds have a 25 Sep NAV.
- **Selective hydration.**
  - It runs every 30 minutes and covers all 17 held funds.
  - The fair-ordering code merged in `bc47a9f` is live from 23:00 UTC 26 Sep.
- **Retention protection.**
  - 17 held instruments. The independent union of the seven user-scoped sources equals the RPC exactly.
  - Every held fund has a history floor.
  - The hardened 0200 predicate is the deployed definition (its comment reads "hardened 0200").
- **Full-universe backfill.** It stays locked off (`enabled = false`).
- **AMFI accuracy.**
  - **720 of 720** held-fund values across 2006–2026 are exact (re-run today).
  - **46 of 46** Saturday (26 Sep) rows are exact.
  - 0 TIGZIG rows exist in production.

**Why it is not FULL PASS.** Each item below is required by the brief's §18.

1. **Monitoring defect F-14 is live** (the brief says "fix before terminal FULL PASS").
   - Hydration never writes `ii_reference_job_control`, so `last_success_at` is NULL after 46 successful runs.
   - The fix is `ae3312d` on this branch. It is not merged or deployed.
2. **Scheme-master proof is pending.** No genuine scheduled scheme-master tick has run yet.
   - The first window is **Tuesday 29 Sep, 03:00–03:28 UTC**, not "Tue 30 Sep" (contradiction C-4).
3. **Daily NAV after the completion deploy is not yet observed.** The next window is Tue 29 Sep, 03:30–04:30 UTC.
4. **UI journey: 0/18 in production** (Blocked: sign-in). A complete PO-run pack is prepared (§4).
5. **Recovery.**
   - Backup/PITR restore proof: **Blocked** (no Management API).
   - D.11 delete-and-rehydrate on DEV: **Blocked**, because DEV lacks 0201 (§8).
6. **Environment drift.** 0199 and 0200 are **not on DEV** (Verified). 0201 is not verifiable there.
7. **Starvation fix in production.** The uncovered-fund production proof needs a PO-run write (§2.4). It is optional; a script is prepared.

### NAV1 CLEANUP / STORAGE-RECLAMATION STATUS: **BLOCKED (deliberately deferred)**

- **The PO decision is NO.** Zero production NAV rows have been deleted, by this session or, as far as any evidence shows, by anyone.
- **All deletion controls stay disabled.**
  - No cleanup job, schedule or switch exists.
  - `NAV1_StageE_canary_PROPOSAL_do_not_run.sql` is an unexecuted proposal.
- **No claim of reclaimed space or billing saving is made**, and none could be.
- Independently of the NO, Stage E would still be blocked by:
  - the backup-restore proof (P8.B);
  - the F-3 recoverability gap for merged fund houses;
  - 0201 absent on DEV, so the D.11 delete cycle cannot run.

---

## B. Status table

| Item | Required evidence | Status | Class | Evidence |
|---|---|---|---|---|
| Full-universe backfill disabled | Live switch query | Disabled | **Verified** | `pc6_full_universe_historical_backfill.enabled = false` (22:5x UTC 26 Sep) |
| Selective hydration | Covered and uncovered scheduled runs | Covered: pass. Uncovered: not observed in production | Covered **Verified**; uncovered **Blocked** (needs PO write, §2.4) | 46 scheduled batches on 26 Sep, all `succeeded`, ≤1.2 s, 17/17 covered. The 23:00 batch shows `examined 17, alreadyCovered 17, attempted 0, ordering least_recently_attempted` |
| Starvation fixed | Negative control + production proof | Fixed in code. Budget fix live since 24 Sep; fair ordering live since 23:00 26 Sep; thrown-error hole fixed on the branch | Negative controls **Verified** (§2.3); production **Verified** (telemetry live); uncovered-fund proof **Blocked** | 15/18 of the merged fairness tests fail on `a115ee5`. My independent S3/S4 fail on `a115ee5`, S1–S4 on `0939ecf`, T1/T2 on `bc47a9f` |
| Daily NAV | Genuine scheduled tick | 26 Sep window passes 13/13 criteria. The post-deploy window (Tue 29 Sep) is pending | **Verified** (26 Sep); **Not tested** (29 Sep) | §3.1; `scripts/nav1_scheduled_proof_check.mjs daily 2026-09-26` → OVERALL PASS |
| Scheme master | Genuine scheduled tick | Pending. First window Tue **29** Sep 03:00 UTC. `last_success_at` is still 20 Sep | **Not tested** | §3.2; checker prepared, baseline taken |
| UI journey | 18/18 real browser checkpoints | 0/18 in production | **Blocked** | §4: checklist, statement pack (production parser 3/3), and read-only SQL for every checkpoint |
| Report pinning | Real finalization write + independent query | The write path is in deployed code. Production has 0 pins and 0 eligible finalizations | Code **Repository evidence**; production **Not tested** (no eligible report) | `ii_report_nav_dependencies` = 0 rows (Verified); checkpoint 17 of the PO journey exercises it |
| Statement holds | Real certification behaviour | Trigger present in production (operator-confirmed 22 Sep). Behaviour proven on DEV 7/7 (25 Sep) | DEV **Verified** (25 Sep); production behaviour **Blocked** (Q7 rolled-back SQL for PO) | Production holds = 0 (Verified) |
| Retention completeness | Protection traceability and anti-joins | Held set 17 = independent union; 15/15 manifest anti-join assertions | **Verified** | §5; 0200 is deployed (comment Verified); grants **Blocked** (PROD_01 P3) |
| Provider accuracy | AMFI reconciliation and fallback governance | 720/720, 46/46, 7,900/7,900 exact; 0 TIGZIG rows | **Verified**; fallback governance **Repository evidence** | §6; F-3, F-8 open |
| Migrations | DEV/production behavioural verification | Production: 0199 table, 0200 predicate and 0204 RPC present. DEV: 0199 absent, 0200 absent | **Verified** (objects); 0201 production **Operator-confirmed**; cron **Blocked** | §1.3 |
| Manifest | ID, checksum and zero protected intersections | `NAV1-D10-production-2026-09-26-ffdff57ed75a`, deterministic across 4 runs, 15/15 assertions | **Verified**; full PK checksum **Blocked** (Q4 for PO) | §7 |
| Recovery | DEV rehydration and backup restoration | Source fidelity 4 of 5 funds (25 Sep). Delete/rehydrate cycle blocked by DEV 0201. Backup blocked | Fidelity **Verified** (25 Sep); cycle **Blocked**; backup **Blocked** | §8 |
| Deletion | Exact PO authorization and reconciliation | **None. PO decision NO** | **Verified** (no production write by this session; pre-changeover counts unchanged across 4 manifest runs, 25–26 Sep) | §9 |
| Space | Before/after logical and physical measurements | Logical: 22,443,743 rows (exact). Physical: not measured | Logical **Verified**; physical **Blocked** (PROD_01 P6) | §9 item 10 |
| Billing | Actual provider evidence or "not demonstrated" | **Not demonstrated** | — | No deletion |
| Git/deployment | Branch, SHAs, merge and deployed version | `main` = deployed = `bc47a9f`. Fix branch pushed, not merged | **Verified** | §0, §12 |

---

## 1. P0: Baseline and reconciliation

### 1.1 Contradictions with the brief's starting checkpoint (recorded, not rewritten)

| # | Brief said | Live evidence | Class |
|---|---|---|---|
| C-1 | `main` was `fd1c9f6`; establish it fresh | `origin/main` = deployed = `bc47a9f` (Amplify 244) | Verified |
| C-2 | 0194 unmerged on `fix/nav1-production-only-nav-schedules` @ `d1ed60b`; DEV not confirmed | Merged to `main` as `0939ecf` on 24 Sep; applied to production and DEV (DEV: operator-confirmed) | Repository evidence + Operator-confirmed |
| C-3 | The completion branch holding 0199–0201 is unmerged | Merged by PO instruction as `bc47a9f` **without 0202**. 0202 must never be applied (superseded by 0204+0205). The PO applied 0199–0201 to production about 22:40 UTC 26 Sep (0201 via CONCURRENTLY; indexes `indisvalid = true` per screenshot) | Operator-confirmed. Partly Verified: the 0199 table exists; the predicate comment reads "hardened 0200" |
| C-4 | First scheme-master window "Tuesday 30 September" | **30 Sep 2026 is a Wednesday.** 0205's cron is `0-28/2 3 * * 2` (Tuesday), so the first window is **Tue 29 Sep, 03:00–03:28 UTC**, 30 minutes before that day's daily window. The same error runs through the 24–26 Sep reports, the session memory and the dispatch brief | Repository evidence (0205 text) + calendar |
| C-5 | 46 rows dated 26 Sep "reportedly from early-publishing funds" | Confirmed and quantified. All 46 come from UTI (28), PPFAS (8) and Quantum (10): liquid, overnight and one debt ETF, collected by the 26 Sep 03:30 run. **46/46 equal AMFI's NAV history for 26 Sep.** But AMFI's full 26 Sep publication is **602 schemes**; the other **556 were never collected** (F-17) | Verified |
| C-6 | About 22.4M NAV rows | 22,443,743 exact. Pre-changeover rows are unchanged at 22,400,379; post-changeover rows are 43,364 | Verified |
| C-7 | "D.10 manifest and D.11 recovery proof had not started" | D.10 was generated twice on 25 Sep (`ffdff57ed75a`) and twice again on 26 Sep. D.11 source fidelity ran on 25 Sep; the delete cycle was blocked | Verified |
| C-8 | Hydration: 45 runs, all succeeded, 0 rows | 46 batches dated 26 Sep UTC up to 22:30, all `succeeded`, 0 inserted. The brief's 45 was counted at 22:23 | Verified |
| C-9 | `last_success_at` null for hydration | Confirmed. Root cause: the job never writes job control (F-14). Fixed on the branch | Verified |
| C-10 | 0199–0201 on DEV unknown | **0199 absent** (`ii_nav_hydration_attempts` PGRST205). **0200 absent** (predicate comment still "NAV 1 (0189)"). 0201 cannot be seen over PostgREST | Verified |
| C-11 | P4: "history window derived from analytical need, not an arbitrary global start date" | The implementation fetches held funds **from inception**, bounded per fund by its confirmed history floor (its first AMFI NAV). That follows the PO's 24 Sep decision ("held instruments keep ENTIRE history"). It is per-instrument, not a global date, but it is not derived from transaction dates. PO decision F-4 in §F | Repository evidence |

### 1.2 Production baseline (Verified, read-only, 22:5x UTC 26 Sep)

**NAV rows**

| Measure | Value |
|---|---|
| `ii_prices_nav` exact | **22,443,743**, from the manifest's exact per-instrument sum. The PostgREST estimate is 22,443,744 |
| Pre-changeover (< 2026-09-21) | 22,400,379 |
| Post-changeover | 43,364 |

**Per-date coverage (exact)**

| Date | Rows | Note |
|---|---|---|
| 21 Sep | 8,718 | |
| 22 Sep | 8,712 | |
| 23 Sep | 8,713 | |
| 24 Sep | 8,719 | |
| 25 Sep | 8,456 | Includes 108 legitimate AMFI 0.0000 NAVs of segregated portfolios; each matches AMFI |
| 26 Sep (Sat) | 46 | See C-5 |
| 27 Sep | 0 | |

**Schemes and instruments**

- 14,359 instruments; 14,358 scheme-master rows.
- `lifecycle_status` is `active` for **all 14,358** (F-7, unchanged).

**Protected set (0189 definition)**

- **17 instruments.** Sources:
  - `ii_transactions`: 2,836 rows;
  - `ii_holding_snapshots`: 51;
  - `ii_portfolio_truth_status`: 51.
- Tax lots, SIP series, capital-gains computations, publications, benchmarks, report dependencies, holds and merge links: **0 each**.
- The independent union equals `pc6_user_held_instrument_ids()`.
- History floors: 17 of 17.
- Protected NAV rows: 77,124 in total, of which 77,039 are pre-changeover.

**Job control**

| Job | Enabled | Last success | Consecutive failures |
|---|---|---|---|
| Daily NAV | true | 26 Sep 04:28:05 (batch `7ca6c437`) | 0 |
| Scheme master | true | 20 Sep 11:23 | 0 |
| Full-universe backfill | **false** | — | — |
| Selective hydration | true | **null** (F-14) | — |

- Running batches: **0**.

**Batches since 25 Sep**

| Day | Job | Runs | Outcome |
|---|---|---|---|
| 25 Sep | Hydration | 48 | all succeeded |
| 26 Sep | Hydration | 46 | all succeeded |
| 25 Sep | Daily | 4 | 2 `STALE_RUNNING_RECONCILED` (the pre-fix 03:30 failure), then 2 succeeded (manual gap runs) |
| 26 Sep | Daily | 11 | 1 `PARTIAL_BATCH_CONTINUING`, then 10 succeeded |

### 1.3 Migrations 0166 to 0206

| Migration | Production | DEV | Class |
|---|---|---|---|
| 0166, 0167, 0171, 0172 | Objects present (tables, RPCs) | Present | Verified (OpenAPI) |
| 0168 trigger | Present per 22 Sep repair | Proven 7/7 on 25 Sep | Production: Operator-confirmed. PROD_01 P5 and Q7 re-prove it |
| 0187, 0188, 0193, 0194, 0205 (cron) | Behaviour visible: daily window 26 Sep; hydration every :00/:30 | No DEV daily batches since 25 Sep 10:03 (consistent with 0194) | Behaviour Verified; `cron.job` rows **Blocked** (PROD_01 P2, DEV_04 V5) |
| 0189, 0190, 0191, 0192 | Present; 17 floors; 53 fund houses; `nav_hydration` batches | Present; DEV has 0 floors | Verified |
| **0199** | Table present, 0 rows (correct: nothing needed a fetch) | **Absent** | Verified |
| **0200** | Deployed predicate comment "NAV 1 (0189, hardened 0200)…". Grants not visible | **Absent** (comment "NAV 1 (0189)") | Verified; grants Blocked (PROD_01 P3) |
| **0201** | 2 indexes, `indisvalid` (PO screenshot) | Unknown; D.11 needs it | Operator-confirmed / Blocked |
| 0202 | **Not merged; never apply** | — | Repository evidence |
| 0204 | `ii_prices_nav_existing_pairs` in OpenAPI | Present | Verified |

**Migration numbering.** This session adds **no migration**. 0207–0214 belong to the canonical-upload programme and 0215–0218 are reserved. None were used or touched.

---

## 2. P1: Starvation, fairness and monitoring truthfulness

### 2.1 Completion-branch audit (`6199281` → `bc47a9f`)

- **Fair ordering** (least recently attempted first) from the 0199 ledger, with a rotation fallback when the ledger cannot be read.
- **Honest batch status.** `failed` when nothing succeeded; `succeeded` + `HYDRATION_SOME_FETCHES_FAILED` or `HYDRATION_WORK_REMAINING` for a partial run.
- **Telemetry**, as described in the 25 Sep report §2.2.
- **Safety.** No migration in the merge enables cleanup, schedules deletion or weakens a guard.
  - 0200 *tightens* the predicate: service role only, never NULL, merge families protected.
  - 0201 adds indexes only.
- **Code review (Verified).** Reading the merged job, the budget counts only instruments that need a fetch. Coverage checks cost no budget. Per-provider timeouts (45 s × 3), the run claim (0192) and the floor rule (0190) are untouched.

### 2.2 Defects this session found in the merged code

**F-14: monitoring truthfulness (Medium, live).**

- The hydration job writes batch rows but never `ii_reference_job_control`.
- So `last_success_at`, `last_failure_at` and `consecutive_failures` never move, and the admin page (`ReferenceDataQualityClient`) prints "Last success never" for a job that succeeds 48 times a day.

**F-15: permanent starvation by a thrown error (Medium, latent).**

- The adapters return errors as values. But the live fund-house resolver and the paged reads **throw** on a database error.
- A throw aborted the run before the fund's attempt was recorded.
- The fund therefore stayed "never attempted", went first on every later run, threw again, and **starved every fund behind it for good**. No batch outcome was recorded either.
- The 2026-09-25 fairness tests only simulate returned errors, so they could not catch this.

### 2.3 The fix (`ae3312d`) and its evidence

**Code changes**

- **`planHydrationJobControlUpdate()`** (pure, tested) decides the update for each outcome:
  - **succeeded**, including the no-op fully-covered run: `last_success_at`, `last_success_batch_id` and streak 0;
  - **failed**: `last_failure_at` and streak + 1;
  - **partial**: no write, because it is neither success nor failure. It stays visible via the batch `error_code`.
- **Idempotent write.** The live write applies only while the stored timestamp is older than the run's `finished_at`. Recording the same run twice never double-counts, and a late older run never moves a timestamp backwards.
- **Stale-reconciled (killed) runs** count as one failure, and only when that call actually moved the row out of `running`.
- **A thrown per-instrument error** becomes that instrument's `fetch_failed` (or `partially_hydrated` if chunks had committed). It is recorded in the attempt ledger, so fairness holds.
- The route returns `job_control_error`; the admin panel shows the last failure.

**Tests** (`tests/unit/nav1HydrationMonitoringTruth.test.ts`, 14 tests; written independently of the 25 Sep suite, with UUID-shaped ids and selection-only assertions):

| Test | Current code | `bc47a9f` (deployed) | `a115ee5` (pre-merge) | `0939ecf` (= 7fe349e^) |
|---|---|---|---|---|
| M1 no-op success sets `last_success_at` | pass | **FAIL** | — | — |
| M2 real-write success | pass | **FAIL** | — | — |
| M3 failure: `last_failure_at` and streak; success resets | pass | **FAIL** | — | — |
| M4 partial writes nothing | pass | **FAIL** (the API does not exist) | — | — |
| M5/M6 deferred = partial; dry run, kill switch and overlap never write | pass | pass (trivially: old code never writes) | — | — |
| M7 no double count; no backwards move | pass | **FAIL** | — | — |
| M8 unsaved batch never referenced; job-control error surfaced | pass | **FAIL** | — | — |
| T1 a fund whose fetch always throws does not starve the next (max 1) | pass | **FAIL**: the run **rejects** with the thrown error | — | — |
| T2 the run still closes its batch when one fetch throws | pass | **FAIL** | — | — |
| S1 25 held, 10 covered, max 10 → exactly the first 10 uncovered | pass | pass | pass | **FAIL** |
| S2 next run reaches the remaining 5; third makes no provider call | pass | pass | pass | **FAIL** |
| S3 10 always-failing funds do not starve funds 11–12 | pass | pass | **FAIL** | **FAIL** |
| S4 a fund added later goes first | pass | pass | **FAIL** | **FAIL** |

**Independent re-verification of the merged fairness suite.** Negative control: `tests/unit/nav1HydrationFairOrdering.test.ts` run against `a115ee5` gives **15 of 18 failing**, which matches the claim.

- **Precision note.** On `a115ee5`, test "1." fails **only on its telemetry assertion** (line 152). Its selection assertion passes, because the budget fix `7fe349e` predates `a115ee5`.
- The selection-level negative control for brief test 1 is therefore `0939ecf` (the parent of 7fe349e), where S1 fails.

**Live DEV proof of the real writer.** `scripts/nav1_monitoring_dev_proof.ts` exercises the production `recordJobControlOutcome` code against DEV's real job-control row, then restores it exactly. Result: **7/7 PASS**.

1. success recorded;
2. the same success twice is a no-op (`updated_at` unchanged);
3. failure gives streak 1;
4. the same failure twice keeps streak 1;
5. an older success does not move `last_success_at` backwards;
6. partial writes nothing;
7. row restored byte-identical.

The `enabled` and `disabled_reason` columns were never touched.

**Suites**

| Command | Result |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `eslint` on every changed file | 0 errors, 0 warnings |
| `npx vitest run tests/unit/nav1 tests/unit/pc6 tests/unit/migration` | **22 files, 297/297** (283 before plus 14 new) |
| `tests/unit/nav1P4UiJourneyFixture.test.ts` | 3/3 |
| Full unit suite | §2.5 |

### 2.4 Production proof of an uncovered fund: Blocked (prepared, optional)

- **Current production evidence (Verified).** The deployed fair ordering is live: the 23:00 batch has `ordering = least_recently_attempted`, `examined 17`. But every held fund is covered, so no fund needed a fetch.
- **Why it is blocked.** Proving the uncovered path needs a production write. The session may not make one.
- **Prepared, PO-run, no DELETE:**
  - `docs/nav1/po_run_2026-09-27/PROD_02a_OPTIONAL_uncovered_fund_proof_open.sql`
    - One guarded `UPDATE` moves the floor of the **last** held fund in `instrument_id` order (AMFI 103174; 16 covered funds sort ahead of it) from 2006-04-03 back to 2006-04-01.
    - The next tick must then attempt it: `needingFetch 1, attempted 1, succeeded 1`, one attempt-ledger row, 0 NAV rows.
  - `PROD_02b_..._restore.sql` restores the original row, with values read on 26 Sep.
  - Check the result with `scripts/nav1_scheduled_proof_check.mjs hydration <since> 17`.
- Run it after the monitoring fix is deployed, outside 03:00–04:30 UTC.

### 2.5 Full unit suite (Verified)

Command: `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run tests/unit`, on this branch. `git checkout -- scripts/` was run afterwards.

| Result | Count |
|---|---|
| Files | 459 passed, 10 failed, 2 skipped (471) |
| Tests | 8,922 passed, 24 failed, 18 skipped |

**Every failure is outside NAV 1:**

- **The same 20 as the 25 Sep baseline on `origin/main`.** They are pre-existing:
  - `adminAnalyticsPhaseAMeRoute`: 17;
  - `aiResidualClosureFailClosed`: 1;
  - `countryGateAccessMatrix`: 1;
  - `resourcesR1_1`: 1.
- **Two `resources*LiveDev` files** fail on DEV environment loading.
- **Four are 5-second timeouts under parallel load**, the known repository hazard: `fdh1Isolation`, `m12cServerOnlySecretBoundary`, `paymentsCheckoutRoute` and `m12bInsuranceAccuracyCorpus`.
  - In isolation `fdh1Isolation` and `paymentsCheckoutRoute` pass.
  - `m12c` and `m12b` pass 28/28 with `--testTimeout=60000`.
- No file this branch changes is involved.

---

## 3. P2 and P3: Environment isolation and scheduled operation

### 3.0 Migration 0194 (P2)

- **Repository evidence:** merged in `0939ecf`. Its PGlite script passes 9/9 (anti-vacuity, fresh replay, DEV removal, production keep, idempotent re-apply).
- **Operator-confirmed:** applied to DEV and production.
- **Indirect evidence (Verified):**
  - every daily window shows exactly **one** batch per call;
  - DEV has recorded no daily or scheme-master batch since its own manual runs on 25 Sep.
- **Blocked:** the `cron.job` rows themselves. Use DEV_04 V5 (no DEV job targets production) and PROD_01 P2 (each production job exactly once).

### 3.1 Daily NAV: the 26 Sep genuine window, independently reconciled (Verified)

Command: `node scripts/nav1_scheduled_proof_check.mjs daily 2026-09-26` gives **13 PASS, 0 FAIL, 1 INFO**.

| # | Criterion (written before the check) | Observed |
|---|---|---|
| D1 | First batch within 90 s of the 03:30 tick | 03:30:04.85 (+4.9 s) |
| D2 | None left running | 0 |
| D3 | A batch succeeded with nothing remaining | 10 succeeded |
| D4 | Every failure is `PARTIAL_BATCH_CONTINUING` | 1, and it is |
| D5 | No duplicate-key or correction failure | 10 corrections superseded cleanly |
| D6 | `last_success_at` in the window, pointing at a succeeded batch; streak 0 | 04:28:05, batch `7ca6c437` |
| D7 | Idempotent re-runs: later batches only for a changed AMFI file | 9 later batches, each a new file (+2 … +44 late publications) |
| D8 | ≥ 8,000 rows and ≥ 95% of the median weekday | 8,456 vs 8,713 |
| D10 | Every held fund has one 25 Sep NAV | 17/17 |
| D11 | No duplicates; provider and timestamp present; zeros only where AMFI publishes 0 | 0 duplicates; 108 zero NAVs, all equal to AMFI's segregated-portfolio zeros |
| D12 | Independent AMFI NAVAll.txt values identical | **7,900/7,900** |
| D13 | Mapped-but-absent ≤ 1% | 67 (published after the window) + 19 unmapped |
| D14 | Calendar is Tue–Sat | Not applicable for a Saturday window; asserted on Tuesdays |

- **Cron calendar.** 0205 text: `30-58/2 3 * * 2-6` and `0-30/2 4 * * 2-6` (Repository evidence). The live text is **Blocked** (PROD_01 P2).
  - There is no Sunday or Monday run.
  - **The next window is Tue 29 Sep, 03:30–04:30 UTC**, collecting Mon 28 Sep.
- **The 46 Saturday rows (C-5).** They are legitimate calendar-day NAVs of liquid and overnight schemes, published early.
- **Weekend and late-publication gap (F-17 / F-18).**
  - AMFI publishes Saturday and Sunday NAVs for about 600–700 liquid and overnight schemes. The 20 Sep precedent is 706 rows on Sunday, and today's NAVAll.txt already carries 708 schemes dated 27 Sep.
  - NAVAll.txt only carries each scheme's latest NAV, and there is no Sunday or Monday tick. So from the changeover onward those weekend NAVs, and any NAV published after 04:30 UTC, are never stored.
  - The loss is small for analytics, since valuation uses the latest prior NAV. But it is a gap against "daily NAV for all live schemes". PO decision F-1.

### 3.2 Scheme master: pending (first genuine window Tue 29 Sep, 03:00–03:28 UTC)

- **Pre-window baseline taken (Verified):** `held_identity_baseline_2026-09-27.json` (scratchpad). It holds 17 held instruments, their scheme-master identity and 34 identifiers. Totals: 14,358 scheme-master rows and 14,359 instruments.
- **Checker:** `node scripts/nav1_scheduled_proof_check.mjs scheme-master 2026-09-29 <baseline>`. Criteria S1–S11:
  - tick proximity;
  - none left running;
  - succeeded, and failures only continuations;
  - `last_success_at` advanced past 20 Sep and names the batch;
  - totals not reduced;
  - lifecycle (INFO, F-7);
  - held AMFI code, ISINs and merge link unchanged;
  - identifiers unchanged;
  - fund house unchanged;
  - the next hydration tick still examines 17;
  - batch counts.
- **Not observed yet. No terminal FULL PASS is possible before it.**

### 3.3 Hydration monitoring

| Condition | Status | Class |
|---|---|---|
| Fully covered no-op run | 46 on 26 Sep, each ≤ 1.2 s; 23:00 with telemetry | Verified |
| No overlapping runs; none left running | 0 running | Verified |
| Uncovered fund after the fix | §2.4 | Blocked |
| Provider timeout or error | Unit tests only; none occurred in production | Repository evidence |
| Truthful job control | **FAILS on `bc47a9f`**: checker H7 FAIL (`last_success_at` null after the 23:00 success). This is the production negative control for F-14 | Verified (defect) |

---

## 4. P4: The 18-point UI journey. Production 0/18 (Blocked); pack prepared

**Why it is blocked.**

- The agent may not create accounts or enter passwords on the deployed site.
- A **DEV localhost** run was **Not tested**, for three reasons:
  - DEV lacks 0199 and 0200, so checkpoint 15 would exercise the rotation fallback, not the production code path;
  - the in-app Browser pane has no file-upload primitive;
  - the prepared production pack gives the PO a stronger, production-labelled result.
- **No checkpoint is labelled "UI verified".**

**Statement pack (Verified: parsed by the production extraction library and parser, 3/3).** Location: `lib/fixtures/investment-intelligence/nav1-p4-ui-journey/`; generator `scripts/nav1_p4_ui_journey_fixture.ts`.

- `nav1-p4-main.pdf`: a genuine CAMS layout.
  - **Genuine identifiers**, checked against production's scheme master:
    - PPFAS Parag Parikh Flexi Cap Direct Growth, AMFI **122639**, ISIN INF879O01027: 5 SIPs from 2023-04 and one partial redemption on 2026-03-02, giving a **current holding**;
    - SBI Large Cap Regular Growth, AMFI **103504**, ISIN INF200K01180: two purchases in 2023 and a **full redemption** on 2025-04-01, **closing 0.000**.
  - Every NAV is AMFI's published NAV on that date.
  - **Synthetic:** the investor (PAN prefix `PCQAL`, which is never real), the folios and the transactions.
  - **Oldest transaction 2023-04-03**, before the changeover.
- `nav1-p4-unresolved.pdf`: AMFI 999999 / ISIN INF999Z99ZZ9, which exists nowhere. This is checkpoint 9.
- **Finding F-19.** The existing PC3 fixtures pair real AMFI codes with the wrong names and ISINs (for example, 118834 is Mirae Asset Large & Midcap, not "HDFC Flexi Cap"). They are unsuitable for checkpoint 6.

**PO runbook.**

- Evidence: a screenshot per step, with personal data blurred.
- SQL: `docs/nav1/po_run_2026-09-27/PROD_03_ui_journey_verification_readonly.sql`. Its V-numbers match the checkpoints below.

| # | Step (deployed UI) | Pass evidence |
|---|---|---|
| 1 | Register or sign in as synthetic user A (e.g. `nav1-p4-user-a@fhip-synthetic.test`); country IN, onboarding complete | Dashboard loads |
| 2 | Open Investment Intelligence, then the data/upload page | Upload panel visible |
| 3 | Upload `nav1-p4-main.pdf` | Accepted. SQL V3: 1 document |
| 4 | Upload `pc3-q10-controlled-malformed.pdf` | Rejected at admission or scan with no stored object. V3/V4 scan columns |
| 5 | Process | "Source identified". V5: `parser_code` is the production CAMS parser |
| 6 | Transaction view | V6: 9 transactions resolved to 122639/INF879O01027 and 103504/INF200K01180 |
| 7 | Same | V6: dates, units, NAV and amounts exactly as in `.expected.json` |
| 8 | Upload `nav1-p4-main.pdf` again | "Already uploaded"; V8/V11 returns zero rows |
| 9 | Upload `nav1-p4-unresolved.pdf` | V9: a reconciliation case or provisional instrument, never resolved to a real scheme |
| 10 | Review, certify, and publish to FHIP | V10: truth status certified |
| 11 | — | V8/V11: each transaction exactly once |
| 12 | — | V10: one open hold per certified instrument, `statement_reconciliation_in_progress`, about 30 days |
| 13 | — | V10: no hold for the unresolved or non-certified instrument |
| 14 | `/dashboard` | Net worth reflects PPFAS only (SBI is 0). V14 publications |
| 15 | Wait for the next :00/:30 tick | V15: floors 122639 → 2013-05-28 and 103504 → 2006-04-03; attempt rows; 0 NAV rows written. Checker H-rows: `examined` becomes 19 |
| 16 | Performance page | XIRR/TWRR shown. V16: NAV rows cover 2023-04-03 to today for both, including the redeemed SBI |
| 17 | Rolling returns and a finalized report (premium entitlement) | V17: `ii_report_nav_dependencies` rows for 122639 and 103504 |
| 18 | Sign in as synthetic user B; paste A's document, holding and report URLs and API paths | 404 or empty. V18 (rolled back): every count 0 under B's JWT |

**Consequences to know before running it.**

- After checkpoint 10, 122639 and 103504 become **user-held**, so they are protected, and the D.10 manifest will change. That is correct behaviour: regenerate it afterwards (§7).
- Remove the synthetic users afterwards **only** through the product's own account-deletion flow (the scoped, documented path). Never with ad-hoc SQL.

---

## 5. P5: Retention protection

The traceability matrix of the 25 Sep report §5.1 stands.

**Updated this session**

| Dependency | Protected by | Status | Class |
|---|---|---|---|
| Current, historical and fully redeemed holdings; accepted transactions; tax lots | `pc6_instrument_is_user_held` over the 7 user-scoped `ii_*` tables (no units, status or date filter) | Held set 17 = independent union = RPC | Verified |
| Fail-closed: wrong caller, NULL input, merge family | **0200 live in production** (comment Verified); PGlite 39/39 (25 Sep) | Deployed. Grants to be read with PROD_01 P3 | Verified / Blocked (grants) |
| Certified-statement holds | 0168/0171 trigger | 0 holds in production; DEV 7/7 | Verified (DEV) |
| Report pins | `ii_report_nav_dependencies` | 0 rows | Verified (empty) |
| Manifest anti-joins (independently written, not via the predicate) | Seven sources, benchmarks, any report dependency, any hold row, merge families, `investments` links, pending AI reviews | 15/15 true in 4 runs | Verified |
| Open imports and unresolved exceptions before transactions are written | — | **Gap (disclosed 25 Sep).** Protected once parse writes transactions | Repository evidence |
| `ii_ownership_allocation` (0153, DEV only) | Not in the held definition | Extend before 0153 reaches production | Repository evidence |

"User-held" is **not** current positive balance: fully redeemed, zero-unit and closed-lot funds are all KEEP (0200 P5-2).

---

## 6. P6: Provider accuracy and fallback governance (Verified unless stated)

- **Held-fund history.**
  - `scripts/nav1_p6_provider_accuracy_probe.mjs prod`, re-run 23:17 UTC 26 Sep: **720/720 exact** across 51 AMFI windows, 2006–2026.
  - 0 non-positive values, 0 duplicate dates.
  - Provenance: 77,022 `amfi-historical-backfill-2026-09-20` and 102 `pc6-amfi-parser-v1`; **0 TIGZIG**.
- **Daily feed.**
  - 25 Sep: 7,900/7,900 equal to NAVAll.txt.
  - 26 Sep: 46/46 equal to AMFI's NAV history report.
- **Zero NAVs.** 108 segregated-portfolio schemes publish 0.0000, and the stored zeros equal AMFI's. This is not a defect. The brief's "positive numeric NAV" rule is a *fallback* validation rule.
- **Fallback governance (Repository evidence and tests):**
  - TIGZIG is used only after AMFI fails;
  - `not_found` requires both providers to agree;
  - each row is stamped with its real provider;
  - a block page is `schema_unexpected` and never a floor (fairness test 10 and T-suite).
- **Open:**
  - **F-8:** conflict quarantine is not built.
  - **F-3:** pre-merger history of fund-house-changed schemes. HSBC ex-L&T is 925 of 3,199 recoverable from AMFI.

---

## 7. P7: D.10 read-only production manifest (Verified)

| Field | Value |
|---|---|
| Manifest ID | **`NAV1-D10-production-2026-09-26-ffdff57ed75a`**. The date in the ID is the UTC generation date; the checksum is the identity |
| Runs | 22:47:29Z (caller, generator at `bc47a9f`) and 23:08:29Z (this session, generator label fixed in `ae3312d`; generator file byte-identical at `363543f`; the `dirty` flag refers to untracked docs only) |
| Database | production `twwpnltizhtjxhamyoxt` |
| Deployed app | `bc47a9f` (§0) |
| Migration set (repository) | 190 files, sha256 `e0abf7e5…`. The applied set is not readable |
| Retention policy | `nav1-0189-user-held`, changeover **2026-09-21** |
| Predicate | **0200** (`pc6_nav_row_is_candidate`, `0200_nav1_retention_predicate_fail_closed.sql`), repository source sha256 `f40d4112…`. The first run's label "0189" was stale; that was defect F-16, now fixed. The manifest rule itself is stricter than the predicate |
| Boundaries | `price_date` ≥ 2006-04-01 and < 2026-09-21. Latest candidate date 2026-09-20 |
| Candidate rows | **22,323,340** in **14,336** instruments |
| Protected, pre-changeover | 77,039 rows, 17 instruments (reasons: user_held via `ii_transactions`, `ii_holding_snapshots` and `ii_portfolio_truth_status`) |
| By year / month | In `manifest.json` (2006: 138,856 … 2026: 1,086,204) |
| Estimated bytes | About 6.7 GB. **Estimate only** |
| Aggregate checksum | sha256 **`ffdff57ed75a8cd1b4075c8f8b78ca4c1534a99548705fd3344b00f29e1178be`** |
| Per-instrument md5 | **`0f3c2e095b915ad3406d106869d717d6`** |
| Full primary-key checksum | **Blocked** over PostgREST. Q4 in `NAV1_D10_manifest_sql_for_PO.sql` for the PO |
| Assertions | **15/15 true**, both runs |
| No-mutation evidence | 14,866 GETs per run, 0 refused; protected-state snapshot identical before and after |

**Determinism (Verified).** The two runs on 26 Sep are identical in:

- counts;
- aggregate sha256;
- per-instrument md5;
- by-month partition;
- per-instrument CSV (byte-identical);
- canary id list (byte-identical, sha256 `b8b170e4…`).

They are also identical to both 25 Sep runs. The pre-changeover data did not change across 25–26 Sep.

**Drift warning.** Running the P4 journey in production adds 2 held funds, which removes 122639 and 103504 from the candidate set. The manifest must then be regenerated, and any authorization must name the new ID and checksum.

---

## 8. P8: D.11 recovery

**A. Source rehydration**

- **Non-destructive fidelity (Verified 25 Sep).** Four of the five proposed canary funds are exact. HSBC Short Term is 925 of 3,199 (F-3).
- **Delete-rehydrate-compare cycle on DEV: Blocked.**
  - On 25 Sep, even a single-row DEV delete timed out without 0201.
  - This session verified that DEV lacks 0199 and 0200. 0201 is not verifiable over PostgREST and is presumed absent.
- **Ready to run** once the PO applies `DEV_03_apply_0201_guarded.sql` (and DEV_01/02):
  `npx tsx --env-file=D:/FHIP/.env.local scripts/nav1_d11_dev_rehydration_proof.ts 028be273-9d60-4d81-9945-334723f5d4d0 2020-09-15 <outDir>`
  The script covers interruption, resume, an idempotent third run, exact restore and zero residue.

**B. Backup / PITR restore: BLOCKED.** No Management API or backup access exists in this session.

The PO must provide:

1. Plan tier, PITR status and retention window (Dashboard → Database → Backups).
2. A restore into an **isolated** project or branch, never over production.
3. On the restored copy:
   - `select count(*) from ii_prices_nav`;
   - Q3 and Q4 checksums matching the source at the restore point.
4. Measured RTO and RPO.
5. Operator name, timestamp and evidence reference.

---

## 9. P9: Pre-deletion certification and authorization package

1. **Deployed SHA and migrations.**
   - Production runs `bc47a9f` (Verified).
   - 0166–0201 and 0204–0205 are applied in production (objects Verified; 0201 and cron Operator-confirmed).
   - 0202 is never to be applied.
   - DEV lacks 0199 and 0200 (Verified) and probably 0201.
2. **Starvation fix.**
   - Budget and fairness are live (Verified).
   - The thrown-error hole (F-15) is fixed on the branch, not deployed.
   - The uncovered-fund production proof is prepared but not run.
3. **0194 environment isolation.** Repository evidence and operator-confirmed. Behaviourally consistent (Verified). Cron rows are Blocked.
4. **Scheduled proofs.**
   - Daily NAV: 26 Sep, 13/13 (Verified). 29 Sep is pending.
   - Scheme master: **pending, Tue 29 Sep**.
   - Hydration: no-op runs Verified; monitoring truthfulness FAILS on `bc47a9f`, with the fix pending.
5. **UI journey.** 0/18 in production (Blocked); pack ready (§4).
6. **Traceability matrix.** §5, and the 25 Sep report §5.1.
7. **Provider accuracy.** §6. Open: F-3 and F-8.
8. **Manifest.** `NAV1-D10-production-2026-09-26-ffdff57ed75a`:
   - aggregate sha256 `ffdff57ed75a8cd1b4075c8f8b78ca4c1534a99548705fd3344b00f29e1178be`;
   - per-instrument md5 `0f3c2e095b915ad3406d106869d717d6`;
   - 22,323,340 candidate rows in 14,336 instruments;
   - 0 protected intersections (15/15).
9. **Recovery.**
   - Source fidelity: 4 of 5 (Verified 25 Sep).
   - DEV delete cycle: Blocked (DEV 0201).
   - Backup restore: **Blocked**.
10. **Size baseline.**
    - Logical: 22,443,743 rows (exact).
    - Physical: **not measured**; PROD_01 P6.
11. **Proposed canary (unchanged from 25 Sep, still valid because the canary id list is byte-identical).**
    - **6,705 rows**: the whole pre-changeover history of the 4 funds proven recoverable.
    - Primary-key md5 `ec137c8b2bb59bcc93342b0f94f63086`.
    - Predicate: `id ∈ list AND price_date < 2026-09-21 AND pc6_nav_row_is_candidate(instrument_id, price_date, 2026-09-21)`, evaluated live inside the DELETE.
12. **Controls** (`NAV1_StageE_canary_PROPOSAL_do_not_run.sql`, PGlite 9/9, **not run**):
    - batches of 500 ids, one transaction each;
    - `lock_timeout 2s`, `statement_timeout 30s`;
    - a queue-consuming loop;
    - stop when deleted ≠ taken;
    - operator pause between batches.
13. **Rollback or restore triggers.**
    - Triggers: any error; deleted ≠ taken; any change in held-fund rows; any held fund becoming a candidate; a hydration or daily failure; a user-visible calculation change.
    - Restore paths: AMFI re-hydration (exact for the 4 canary funds), or PITR (Blocked).
14. **Monitoring and abort thresholds.**
    - Watch: batch timing; 0 lock timeouts; the next 2 hydration ticks `succeeded`; the next daily window 13/13 on the checker; held-fund rows unchanged.
    - Abort at the first deviation.
15. **Zero production NAV rows have been deleted.**
    - Pre-changeover rows are unchanged at 22,400,379 across four manifest runs, 25–26 Sep (Verified).
    - This session made no production write (Verified).
    - Earlier history is operator-confirmed.

### STOP GATE 1: the PO's binary decision

> Authorize Stage E canary deletion only against manifest `NAV1-D10-production-2026-09-26-ffdff57ed75a` with checksum `ffdff57ed75a8cd1b4075c8f8b78ca4c1534a99548705fd3344b00f29e1178be`, limited to `6705` rows and the exact predicate/boundaries documented in this package?

**Recorded answer: NO** (PO decision, updated master prompt, 27 Sep 2026).

- Cleanup is deferred. All deletion controls stay disabled.
- No deletion was executed, scheduled or enabled.
- Silence, merge authority, this prompt or earlier broad approvals are not authorization.
- A future authorization must name a **freshly regenerated** manifest ID and checksum, especially after the P4 journey changes the held set, along with the ceiling and the canary.

---

## C. Defect register

| ID | Severity | Discovery | Root cause | Fix | Tests | Deployment | Residual risk |
|---|---|---|---|---|---|---|---|
| **F-14** | **Medium (monitoring truthfulness; live)** | Production job control: `last_success_at` null after 46 successes; checker H7 FAIL (Verified) | The hydration job never wrote `ii_reference_job_control` | `ae3312d`: `planHydrationJobControlUpdate` plus a guarded live write; stale-reconcile counts a failure; admin shows last failure; runbook 9d | M1–M8 (fail on `bc47a9f`); DEV live 7/7 | **Branch only** | The admin page shows "never" until deploy |
| **F-15** | **Medium (latent starvation)** | Code review; T1 negative control (the run rejects on `bc47a9f`) | A thrown per-instrument error aborted the run before the attempt was recorded | `ae3312d`: catch per instrument, record `fetch_failed` or `partially_hydrated` plus the attempt | T1, T2 | Branch only | None known |
| **F-16** | Low | Manifest run 1 labelled the predicate "0189" | The generator hard-coded 0189's source | `ae3312d`: latest defining migration | Run 2 shows 0200 | Branch (script) | — |
| **F-17** | Low–Medium (coverage) | 26 Sep: 46 of AMFI's 602 stored (Verified) | Tue–Sat cron plus NAVAll.txt carrying only the latest NAV → Saturday and Sunday NAVs of about 600–700 liquid and overnight schemes are never stored after the changeover | **Not fixed.** PO decision F-1 | — | — | Weekend NAV gaps for about 4–5% of schemes. Valuation uses the prior NAV |
| **F-18** | Low | 25 Sep: 67 mapped schemes published after 04:30 UTC, never stored | Window closes at 04:30; the next file carries the next day | Same decision as F-17 (a later window or a history top-up) | — | — | Under 1% per day |
| **F-19** | Low (test data) | P4 prep | PC3 fixtures mismatch AMFI code, name and ISIN | New P4 pack with verified identifiers | 3/3 | Branch | PC3 tests still pass; they test grammar only |
| F-3 | P1 for Stage E scope | 25 Sep | Pre-merger history sits under the former fund house | Not fixed | — | — | Unrecoverable except from backup (Blocked) |
| F-6 | Medium | 25 Sep | A failed dependency write leaves a ready report unpinned | Not fixed (PO) | — | — | 0 eligible reports today |
| F-7 | Low | 25 Sep; re-verified | `lifecycle_status` never maintained (14,358 `active`) | Not fixed | — | — | Scheme-master "transitions" are not demonstrable (S6 INFO) |
| F-8 | Low | 25 Sep | No fallback-versus-AMFI conflict quarantine | Not fixed | — | — | 0 TIGZIG rows |
| F-13 | Low | 25 Sep | The ingest AMFI fetch has no per-request timeout | Not fixed | — | — | Reduced by 0205: the fetch happens **before** the batch opens, so a hang leaves no stuck batch and the next 2-minute call retries |
| DEV drift | Medium (process) | Verified: 0199 and 0200 absent on DEV | Migrations applied to production only | `DEV_01..03` guarded files | DEV_04 | PO | D.11 blocked until applied |

Earlier defects F-1, F-2, F-4, F-5, F-9, F-10, F-11 and F-12 (0202) are closed by `bc47a9f`, 0204 and 0205. F-12's remedy was 0204+0205, not 0202.

---

## D. Mutation ledger

**Production: none by this session.**

- Every request was a GET through a host-asserting, GET-only client.
- There were no writes, deletes, RPC POSTs, migrations, cron or switch changes, and no users created.
- Operator mutations reported to this session:

| UTC | Operator | Purpose | Object | Rows | Authorization |
|---|---|---|---|---|---|
| 26 Sep ~22:39 | Orchestrating session (PO-instructed) | Merge and deploy `bc47a9f` | `main` / Amplify 244 | — | PO instruction (per dispatch) |
| 26 Sep ~22:40 | PO | Apply 0199, 0200, 0201 (CONCURRENTLY) | DDL | 0 data rows | PO |

- **Deletion batches: none.** Stage E did not occur.

**DEV** (host asserted before every write):

| UTC | Action | Object | Rows | Cleanup |
|---|---|---|---|---|
| 26 Sep ~23:1x | Monitoring proof: 6 guarded updates, then restore | `ii_reference_job_control` row `pc6_selective_historical_hydration` (timestamps and streak only; `enabled` untouched) | 1 row | Restored byte-identical (P7 PASS). Before and after snapshots in scratchpad `nav1_0927/monitoring_dev/` |

---

## E. Limitations and blockers

- **Blocked:**
  - `cron.job` and `net._http_response` rows (PROD_01 P2/P7, DEV_04 V5);
  - 0200 grants (P3);
  - 0201 index validity in text (P4);
  - physical sizes (P6);
  - the 0168 production behaviour proof (Q7);
  - the full primary-key checksum (Q4);
  - backup/PITR restore;
  - the production UI journey;
  - the production uncovered-fund proof;
  - the DEV D.11 delete cycle.
- **Pending by the calendar:**
  - the scheme-master window, **Tue 29 Sep 03:00 UTC**;
  - the daily window after the completion deploy, **Tue 29 Sep 03:30 UTC**.
- **Not tested:** DEV localhost 18-point journey (reasons in §4); provider timeout or error behaviour in production (none occurred).
- **Deployed-SHA evidence:** Amplify `list-jobs` plus behaviour. There is no version endpoint.
- **Manifest migration hash** is the repository set, not the applied set.
- **F-3, F-6, F-7, F-8, F-13, F-17 and F-18** are open by design or pending PO decision.

---

## F. Product Owner decisions still required

1. **F-17/F-18: weekend and late-publication NAVs.** Options:
   - (a) extend the daily window's day-of-week to `*` (Sun and Mon ticks collect Sat and Sun calendar NAVs; unchanged-file calls cost about 3–5 s and write nothing);
   - (b) add a weekly history-endpoint top-up of the previous 7 days;
   - (c) accept the gap.
   - Recommendation: (a) plus a later-window call. It needs a new migration (0219+) and a production schedule change. Not built.
2. **Merge `fix/nav1-completion-2026-09-27`** (SHA in §12).
   - Code only; no migration.
   - Recommended **before Tue 29 Sep 03:00 UTC**, outside 03:00–04:30 UTC, so the hydration monitoring proof runs on genuine ticks.
   - Rollback: revert the merge commit.
3. **Apply DEV_01, DEV_02, DEV_03, then run DEV_04** on DEV. This unblocks D.11 and closes the DEV drift.
4. **C-11: hydration window.** Keep "held = from inception, floor-bounded" (current PO rule; favours accuracy), or narrow it to transaction-derived need plus a documented buffer.
5. **Backup/PITR restore evidence** (§8.B).
6. **Run the P4 production journey** (§4) and PROD_01; optionally PROD_02a/b.
7. **F-3** Stage E scope, and **F-6** report-pin failure policy (unchanged from 25 Sep).
8. **STOP GATE 1:** answered **NO**. Nothing further to decide unless the PO reverses it with a manifest-specific written authorization.

**Authorization status**

| Action | Authorized in this session? |
|---|---|
| Push own branch | Yes (per dispatch). Done |
| Merge to `main` | **No** |
| Deploy | **No** (only by merge) |
| Cleanup / deletion | **No (PO decision NO)** |
| Maintenance (VACUUM, repack) | **No** |
| Broader activation (schedules, switches) | **No** |

---

## G. Files for the PO (none executed by this session)

All are in `docs/nav1/po_run_2026-09-27/`.

| File | Target | Kind | Purpose |
|---|---|---|---|
| `DEV_01_apply_0199_guarded.sql` | DEV | DDL, refuses unless DEV | 0199 attempt ledger |
| `DEV_02_apply_0200_guarded.sql` | DEV | DDL, refuses unless DEV | 0200 hardened predicate |
| `DEV_03_apply_0201_guarded.sql` | DEV | DDL, refuses unless DEV | 0201 self-FK indexes (plain form; DEV only) |
| `DEV_04_verify_readonly.sql` | DEV | SELECT | 0199/0200/0201 present; 0194: no DEV cron targets production |
| `PROD_01_verify_readonly.sql` | Production | SELECT | Cron exactly once (0205 names), 0200 grants, 0201 validity, 0168 trigger, sizes, pg_net |
| `PROD_02a_OPTIONAL_uncovered_fund_proof_open.sql` | Production | 1 guarded UPDATE (no DELETE) | Uncovered-fund proof |
| `PROD_02b_OPTIONAL_uncovered_fund_proof_restore.sql` | Production | 1 guarded UPDATE | Restore |
| `PROD_03_ui_journey_verification_readonly.sql` | Production | SELECT (V18 rolled back) | 18-point checkpoints |

Also:

- `docs/nav1/NAV1_D10_manifest_sql_for_PO.sql`: Q3, Q4 (full primary-key checksum) and Q7 (0168, rolled back) still apply. Its Q2b expectations are superseded by PROD_01 P2.

## H. Scheduled-proof scripts: when to run them

All run read-only from the repository: `node scripts/nav1_scheduled_proof_check.mjs …`. Each prints a PASS/FAIL table.

| Proof | Command | Run at (UTC) |
|---|---|---|
| Scheme master, first genuine window | `scheme-master 2026-09-29 <scratchpad>/nav1_0927/held_identity_baseline_2026-09-27.json` | **Tue 29 Sep, after 04:05** (S10 needs the 04:00 hydration tick) |
| Daily NAV after the completion deploy | `daily 2026-09-29` | **Tue 29 Sep, after 04:40** (the script refuses earlier) |
| Hydration monitoring after the F-14 fix deploys | `hydration <Amplify job end time> 17` | At least **65 min after the deploy** (2 or more ticks). Expected H7 PASS; today's H7 FAIL is the negative control |
| Uncovered-fund proof (optional) | `hydration <PROD_02a run time> 17`; look for `attempted 1` | 2 minutes after the first :00/:30 tick following PROD_02a |

---

## 12. Commits on `fix/nav1-completion-2026-09-27`

| Commit | Content |
|---|---|
| `ae3312d` | F-14 monitoring truthfulness; F-15 thrown-error starvation; F-16 manifest label; tests; DEV proof script |
| `363543f` | Read-only scheduled-proof checker |
| `7b9d4fe` | PO-run pack, P4 statement pack and test, runbook 9d |
| (lint) | Unused variable |
| (this report) | This file and the full-suite result |
