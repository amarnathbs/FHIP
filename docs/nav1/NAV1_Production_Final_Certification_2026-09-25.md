# NAV 1: Production Final Certification (Phases P0 to P9)

**Date:** 25 September 2026 (UTC)
**Scope:** Phases P0 to P9 of the PO master prompt `NAV1_Production_Completion_Master_Prompt_2026-09-24.md`. This dispatch **stops at STOP GATE 1**. P10 (Stage E deletion), P11 (space reclamation) and P12 (post-cleanup certification) were **not** executed.

**Evidence labels** used on every claim:

- **Verified**: observed in this session through a live read-only production query, a live DEV operation, or a re-run test.
- **Operator-confirmed**: the PO did it; not independently observed here.
- **Repository evidence**: true in the named commit, but not live-proven.
- **Blocked**: cannot be tested with this session's access or authority.
- **Not tested**.

---

## 0. Session identity, access and boundaries

**Repository and branch**

| Item | Value |
|---|---|
| Repository | `D:\FHIP` (worktree `D:\FHIP\.claude\worktrees\agent-abe3f35a64ccb4f84`) |
| Branch | `fix/nav1-production-completion-2026-09-25` |
| Base | `origin/main` at `713561d` (starvation fix merge) when the session started |
| `origin/main` at the end of the session | `8b6692c`. `feat/aie1-final-production-completion` was merged by someone else during this session. |
| Branch HEAD | Merged `8b6692c` in cleanly. All NAV 1 tests and PGlite scripts were re-run afterwards (§1.3). The final HEAD is the last commit listed in §12. |
| Pushed? | **No.** The permission system denied `git push`. The branch exists locally only (see F). |
| Merged to `main`? | **No.** Merging deploys to production, so the merge is a PO request. |

**Access used**

- **Production** (`twwpnltizhtjxhamyoxt`): PostgREST, **GET only**.
  - Every production read went through a guarded client that throws on any non-GET method, refuses a request body, and asserts the host before each request.
- **DEV** (`vqycarelcoijzwlpkpcz`): PostgREST read and write, for synthetic data only. The host was asserted before each write.
- **AMFI** public endpoints: sequential GETs with pauses between them.
- Credentials were compared only by sha256 prefix and length:
  - production key: `sha256:aaf942bc7c6f`, length 41;
  - DEV key: `sha256:1bb1241e6aa0`, length 219.
- **Not available:**
  - SQL or DDL on either database;
  - the Supabase Management API or backups;
  - Amplify;
  - the `cron` and `net` schemas;
  - `pg_class`.

**Prohibited throughout, and not done**

- In production: any `DELETE`, `INSERT`, `UPDATE` or RPC `POST`; any migration; any cron or kill-switch change; creating users.
- Any NAV deletion in production.
- Merging or pushing to `main`, force-pushing, `reset --hard`, or a bare `git stash`.

**Production mutations by this session: zero** (§D).

---

## A. Executive verdict

# CONDITIONAL PASS

**What is working in production:**

- **Selective hydration (Verified).** It runs every 30 minutes and covers all 17 held funds. The 7fe349e starvation fix is live: from 22:30 UTC on 24 Sep every run examines 17 funds, not 10.
- **Full-universe backfill (Verified).** It is locked off.
- **Protection of held funds (Verified).** Their history matches AMFI exactly: 720 of 720 values across 51 independently fetched windows, from 2006 to 2026.

**Stage E (historical cleanup) is NOT ready to authorize.** This dispatch found three new blockers. Each is fixed or mitigated on the branch, but none is live yet:

1. **Deleting any NAV row costs two full-table scans.**
   - Cause: two self-referencing foreign keys on the NAV table are not indexed.
   - Evidence: on DEV, even a single-row delete exceeded the statement timeout.
   - Impact in production (22.4M rows): the canary alone would be about 13,000 full scans. Migration **0201** fixes this.
2. **Source rehydration cannot recover every fund.**
   - Of 5 canary funds, 4 were fully recoverable from AMFI.
   - The fifth, HSBC Short Term Fund, had only 925 of 3,199 rows recoverable. Its pre-2022 history is published by AMFI under its former fund house (L&T), and the hydration adapter only asks the current one.
   - Deleting such history is currently **unrecoverable except from backup**, and backup restore is Blocked.
   - Mitigation: the canary was narrowed to the 4 proven-recoverable funds. Full expansion needs the adapter fixed, or a PO decision.
3. **Unprivileged callers are told held funds are deletable.**
   - The retention predicate is executable by `anon` and `authenticated`. Under row-level security such a caller sees no holdings and gets "deletable" for a held fund. **Verified live on DEV.**
   - Migration **0200** restricts it to the service role. The same migration also closes two more fail-open paths: a NULL input, and scheme mergers.

**Why not FULL PASS:**

- The fairness fix and migrations 0199–0201 are not merged or applied.
- The first scheduled daily NAV tick: see §3.1.
- The first scheme-master tick (30 Sep) is pending.
- The 18-point UI journey is **Blocked** for this agent.
- The backup/PITR restore proof is **Blocked**.
- No production deletion has occurred, so P10 to P12 are not assessed.

---

## B. Status table

| Item | Required evidence | Status | Evidence |
|---|---|---|---|
| Full-universe backfill disabled | Live switch query | **Verified** | `pc6_full_universe_historical_backfill.enabled = false` (00:0x UTC 25 Sep) |
| Selective hydration | Covered and uncovered scheduled runs | **Covered: Verified. Uncovered: Blocked** | 22 consecutive scheduled no-op runs, 14:00 24 Sep to 00:30 25 Sep, each 0.7–1.2 s. No uncovered held fund exists in production, and the session cannot create one. |
| Starvation fixed | Negative control + production proof | **Budget fix: Verified live. Fairness fix: Repository evidence** | Production `perInstrument` went from 10 to 17 at 22:30. The fairness fix has 18 tests; 15 fail on `713561d` and 15 on the pre-fix loop. It is not deployed. |
| Daily NAV | Genuine scheduled tick | **See §3.1** | First tick 25 Sep 03:30 UTC |
| Scheme master | Genuine scheduled tick | **Pending, not passed** | First tick Tue 30 Sep 03:00 UTC |
| UI journey | 18/18 real browser checkpoints | **Blocked (0/18)** | The agent may not enter a password or token to sign in, and the Browser pane cannot upload a file. Runbook in §4. |
| Report pinning | Real finalization write + independent query | **Production: Not testable. Repository and PGlite: Verified** | Production has 1 report (5 Aug, before the writer existed) and 0 premium users, so no pin could have been written. Idempotent upsert proven in PGlite (0200 P5-7). |
| Statement holds | Real certification behaviour | **DEV: Verified live. Production: Blocked (SQL proposed)** | DEV 7/7, full cleanup, zero residue. Production proof is Q7, a rolled-back transaction. |
| Retention completeness | Protection traceability and anti-joins | **Verified, with 3 fail-open paths fixed in 0200 (not applied)** | §5 matrix; PGlite 39/39; manifest anti-joins 15/15 |
| Provider accuracy | AMFI reconciliation and fallback governance | **Verified for held funds. Recoverability gap found** | 720/720 exact; 0 TIGZIG rows in production; canary fidelity 4 of 5 funds |
| Migrations | DEV/production behavioural verification | **Partial** | Objects present in production (OpenAPI). Cron is not visible (SQL proposed). 0199–0201 are not applied anywhere. |
| Manifest | ID, checksum and zero protected intersections | **Verified (aggregate). Full primary-key checksum: Blocked (SQL for PO)** | `NAV1-D10-production-2026-09-25-ffdff57ed75a`: two runs identical; 15/15 assertions |
| Recovery | DEV rehydration and backup restoration | **Source fidelity: Verified. Delete/rehydrate cycle: Blocked until 0201 is on DEV. Backup: Blocked** | §8 |
| Deletion | Exact PO authorization and reconciliation | **Not started (STOP GATE 1)** | Zero production NAV rows deleted |
| Space | Before/after logical and physical measurements | **Not measured** | `pg_class` is not readable. SQL proposed (Q6). |
| Billing | Actual provider evidence or "not demonstrated" | **Not demonstrated** | No deletion has happened |
| Git/deployment | Branch, SHAs, merge and deployed version | **See §0 and §12** | Branch not pushed and not merged. Deployed-SHA evidence in §1.1. |

---

## 1. P0: Baseline and reconciliation

### 1.1 Deployed code

**Operator-confirmed:**

- `origin/main` `713561d` was deployed by Amplify job 232 (SUCCEED, 22:08 UTC on 24 Sep).

**Verified (behaviourally):**

- Production hydration batches show `perInstrument` 10 on every run from 14:00 to 22:00, and 17 on every run from **22:30** onward.
  - Code containing 7fe349e is live.
  - `rows_read` was already 17 before the fix, because it counts instruments considered, not instruments examined. The change is visible only in `notes.perInstrument`.

**Not verified:**

- Whether `8b6692c` (the AIE-1 merge during this session) has deployed. It changes no NAV 1 file.
- No application version endpoint exists.

### 1.2 Production baseline (Verified, read-only, 00:05–00:35 UTC 25 Sep)

**NAV row counts**

| Measure | Value |
|---|---|
| `ii_prices_nav` exact total | **22,426,471**. This is the sum of 14,359 per-instrument exact counts plus post-changeover rows, cross-checked against a per-month partition. The PostgREST estimate is 22,426,522. |
| Pre-changeover (< 2026-09-21) | 22,400,379 |
| Post-changeover | 26,092 |

**Per-date NAV coverage (exact)**

| Date | Rows | Note |
|---|---|---|
| 17 Sep | 5,849 | |
| 18 Sep | 8,558 | |
| 19 Sep (Sat) | 88 | Weekend publications |
| 20 Sep (Sun) | 706 | Weekend publications |
| 21 Sep | 8,718 | |
| 22 Sep | 8,712 | |
| 23 Sep | 8,662 | |
| 24 Sep | 0 before the 03:30 tick | See §3.1 |

**Schemes and instruments**

- Instruments: 14,359, all `is_active`.
- Scheme master: 14,358 rows, **all `lifecycle_status = 'active'`**. This includes funds that matured years ago, such as a fixed-horizon fund whose last NAV is 16 Jul 2018. `lifecycle_status` is not maintained, so "live schemes" cannot be derived from it (finding F-7).

**Protected instruments**

- 17 held funds (the 0189 definition), matching the claim of 17 in the brief.
- They are held via `ii_transactions` (2,836 rows), `ii_holding_snapshots` (51) and `ii_portfolio_truth_status` (51).
- The other four user-scoped sources, benchmarks, report dependencies, holds and merge links all have 0 rows.
- The independent union of the source tables matches `pc6_user_held_instrument_ids()` exactly.

**Protected NAV rows**

- 77,090 in total, of which 77,039 are before the changeover. The difference is 17 funds × 3 post-changeover dates.

**Other reference tables**

- History floors: 17, covering every held fund.
- AMFI fund houses: 53.
- Retention policy: one production row: `nav1-0189-user-held`, changeover 2026-09-21, activated 24 Sep 08:58.

**Job control**

| Job | Enabled | Last success | Consecutive failures |
|---|---|---|---|
| Daily NAV | true | 24 Sep 04:22 (manual gap run) | 0 |
| Scheme master | true | 20 Sep 11:23 | 0 |
| Full-universe backfill | **false** | never | 0 |
| Selective hydration | **true** | null (by design: the batch table is authoritative) | 0 |

**Cron**

- **Blocked:** the `cron` schema is not exposed. SQL Q2/Q2b is proposed.
- Indirectly **Verified:** `pc6-selective-hydration` has fired on every :00 and :30 since 14:00 on 24 Sep.

### 1.3 Migrations 0166 to 0201

**What was checked**

- **Verified present in production:**
  - tables `ii_nav_retention_policy`, `ii_nav_retention_holds`, `ii_report_nav_dependencies`, `ii_nav_history_floors`, `ii_amfi_fund_houses`;
  - RPCs `pc6_nav_row_is_candidate`, `pc6_instrument_is_user_held`, `pc6_user_held_instrument_ids`.
- **Verified:** the deployed predicate's own description names 0189.
- **Not observable here:**
  - trigger `trg_pc6_hold_on_statement_acceptance` (proposed SQL Q7 checks it, rolled back);
  - cron rows (Q2);
  - `ii_ai_extraction_reviews`, from 0160. It is absent in **both** production and DEV (PGRST205).

**PGlite, re-run after merging `8b6692c` (Verified)**

| Script | Result |
|---|---|
| 0166 | 17/17 |
| 0168 | 10/10 |
| 0171 | 14/14 |
| 0172 | 17/17 |
| 0189 | 18/18 |
| 0190 | 15/15 |
| 0193 | 14/14 |
| 0194 | 9/9 |
| **0199** | **14/14** |
| **0200** | **39/39** |
| **0201** | **8/8** |
| Stage E canary SQL | **9/9** |

**Migration numbering:**

- 0195–0197 now belong to AIE-1 on `main`.
- **0198 is taken by the unpushed local branch `fix/fdh10-liability-zero-amount-atomic`** (`24281b8`). It was found by scanning every local and remote branch.
- So this dispatch uses **0199, 0200 and 0201**, not 0198.
- None drops or recreates a shared constraint. The 0199 script asserts that no other table's constraints change.

---

## 2. P1: Hydration fairness (the brief's required gap)

### 2.1 What was wrong (Verified in code and by negative control)

- 7fe349e made the fetch budget apply only to instruments that need a fetch.
- But those instruments were still taken in a **fixed** order.
- Ten funds that fail every run would take the whole budget every run, and an eleventh fund would never be reached.
- Meanwhile the batch said `succeeded`: `buildHydrationBatchRow` counted already-covered funds as success, and since 7fe349e every run examines every held fund.

### 2.2 The fix (commit `c1f395e`, plus migration 0199)

**Two passes**

1. Pass 1 checks coverage for every candidate, with no provider calls.
2. Pass 2 fetches in **fair order**:
   - never attempted first, then least recently attempted, using the new per-fund attempt ledger `ii_nav_hydration_attempts` (0199);
   - every attempt, success or failure, moves the fund to the back of the queue, so N funds with budget B are all attempted within ceil(N/B) runs.

**Safe to deploy before 0199:**

- If the ledger cannot be read (for example, 0199 is not yet applied), the job uses a rotating order seeded by the 30-minute tick. This still reaches every fund within ceil(N/B) runs.
- It says so in the batch detail and in `telemetry.ordering = 'rotation_fallback'`.

**Telemetry in `notes.telemetry` and the route response**

- examined
- required
- already covered
- no gap to fetch
- needing fetch
- attempted
- succeeded
- partially hydrated
- failed
- deferred
- remaining
- persistently failing (3+ consecutive failed attempts)
- ordering
- ledger error
- ledger write errors

Deferred funds are listed in `perInstrument` too, so every held fund is accounted for.

**Honest status**

| Run outcome | Batch `status` | `error_code` |
|---|---|---|
| Fetches were attempted and none gained anything | `failed` | `HYDRATION_NOTHING_SUCCEEDED` |
| Some fetches failed or partly failed | `succeeded` | `HYDRATION_SOME_FETCHES_FAILED` |
| All fetches succeeded but work was deferred | `succeeded` | `HYDRATION_WORK_REMAINING` |
| Everything needed is covered | `succeeded` | null |

- The table has no `partial` status.
- Widening that shared CHECK was rejected: code deployed before the migration would then lose every batch record. That was the D.6 defect class.
- A partial run is therefore `succeeded` with an `error_code`, which the table allows. `notes.outcome` carries `partial`.
- `rows_rejected` now carries the count of failed fetches.

**Unchanged:**

- the per-provider timeouts (45 s × 3 attempts for AMFI);
- the run claim (0192);
- the history floor (0190);
- idempotency (`decideUpsert` plus `on conflict do nothing`).

### 2.3 Tests (Verified)

Command: `NODE_OPTIONS=--max-old-space-size=8192 npx vitest run tests/unit/nav1 tests/unit/pc6` gives **17 files, 249 tests, all passing** (before and after merging `8b6692c`).

New file `tests/unit/nav1HydrationFairOrdering.test.ts` has 18 tests. They run the real job against a stateful simulation that uses the real batch-row builder and the real stale-run reconciliation, across repeated runs.

**Coverage of the brief's P1 tests**

| # | Brief's required test | Test | Against old code |
|---|---|---|---|
| 1 | 25 held, 10 covered, max 10 → exactly 10 uncovered fetched | "1. 25 held…" | **7fe349e^: FAILS**, fetches 0 |
| 2 | Negative control | Whole file run against `713561d` and against 7fe349e^ | 15/18 fail on each |
| 3 | Repeated-run fairness | "3. repeated-run fairness…" | fails (no telemetry) |
| 4 | Covered funds use no budget | "4. covered instruments…" (40 covered) | fails on 7fe349e^ |
| 5 | Failure or timeout does not starve later funds | "5." (HTTP error), "5b." (timeout), "5c." (no ledger: rotation) | **713561d: FAILS.** Funds 11–12 are never reached; for 5b, the first calls go to `inst-01`/`inst-02` |
| 6 | Run claim prevents overlap | "6." (true concurrency with a gated adapter) and "6b." (stale run reconciled) | 6 and 6b pass on old code: the claim predates this fix |
| 7 | New fund eventually hydrated | "7." (new fund goes first, ahead of 10 always-failing) | **713561d: FAILS** |
| 8 | Full coverage: no provider call, fast | "8." (under 200 ms, 0 calls, 0 ledger writes) | fails (telemetry) |
| 9 | Floor keeps the earliest date | "9." (plus the existing 0190 suite) | passes: pre-existing behaviour |
| 10 | Block page never becomes a floor | "10." (plus `nav1HydrationServerRobustness` block-page tests) | status assertion **FAILS** on old code (the run said succeeded) |

Plus five batch-status tests. The key negative control: every fetch failed while 14 funds were covered.

- On `713561d`: `succeeded`.
- Now: `failed` with `HYDRATION_NOTHING_SUCCEEDED`.

Negative-control outputs are saved in `nav1_completion/negctl_713561d.txt` and `negctl_7fe349e_parent.txt`.

**Two existing tests changed deliberately:**

- The starvation test's dependency helper now supplies an empty ledger.
- `pc6SelectiveHistoricalHydrationJob` now expects the deferred fund to be listed as `deferred`.

**Type check and lint**

- `npx tsc --noEmit`: exit 0, before and after the merge.
- `eslint` on the changed source and new tests: clean.
- The 7 problems in `pc6SelectiveHistoricalHydrationJob.test.ts` are pre-existing: a copy of `origin/main`'s file gives the same 7.

**Full unit suite** (`npx vitest run tests/unit`, branch before the merge)

- 434 files passed, 8 failed; 8,689 tests passed, 22 failed.
- In isolation:
  - `m12aFdhBankAccuracyCorpus` and `m12bInsuranceAccuracyCorpus` pass. They were load timeouts.
  - `resources*LiveDev` fail on DEV environment loading (0 tests).
- The remaining 4 files still fail: `adminAnalyticsPhaseAMeRoute` (17), `aiResidualClosureFailClosed` (1), `countryGateAccessMatrix` (1), `resourcesR1_1` (1). Total 20.
- **The same 20 fail on `origin/main` (`8b6692c`) itself**, run in the same worktree detached at `origin/main`. They are pre-existing.
- `git checkout -- scripts/` was run after the suite.

### 2.4 Production proof of an uncovered fund

**Blocked.** Production writes are forbidden to this session, and no real uncovered held fund exists. A proposed action is in §G.

---

## 3. P2 and P3: Environment isolation and scheduled operation

### 3.0 Migration 0194

- **Repository evidence:** merged in `0939ecf`.
- **Verified:** PGlite 9/9, re-run in this session, covering:
  - anti-vacuity: the jobs exist just before 0194;
  - fresh replay removes both jobs;
  - DEV removes both jobs;
  - production keeps both jobs;
  - re-apply is idempotent;
  - pre-existing jobs are removed.
- **Operator-confirmed:** applied to production (a no-op there) and to DEV on 24 Sep.
- **Blocked:** DEV and production `cron.job` rows are not visible. Use SQL Q2 (DEV: no job calls the production URL) and Q2b (production: each job exactly once).
- **Indirect check** at the 03:30 tick: if a DEV job were still calling the production URL with a matching secret, production would record a second daily batch at 03:30 (§3.1).

### 3.1 Daily NAV, first scheduled tick (25 Sep 03:30 UTC)

<!-- DAILY_TICK_SECTION -->

### 3.2 Scheme master

- **Pending, not passed.** The first scheduled tick is Tue 30 Sep 03:00 UTC.
- `last_success_at` is still 20 Sep 11:23.
- Separate finding F-7: `lifecycle_status` is `active` for all 14,358 schemes, including funds that matured years ago. The brief's "active/inactive transitions handled safely" cannot be true while no transition is ever recorded.

### 3.3 Hydration monitoring

| Condition | Status | Evidence |
|---|---|---|
| Fully covered no-op run | **Verified** | 22 ticks, 17/17 `already_covered`, 0.66–1.15 s |
| No overlapping active runs | **Verified** | 0 `running` batches at every observation |
| Uncovered fund after the fix | **Blocked** | No uncovered held fund exists; no production writes |
| Provider timeout or error in production | **Not observed** | No error occurred; covered by unit tests only |
| Truthful telemetry | **Repository evidence only** | Not deployed |

---

## 4. P4: The 18-point UI journey. BLOCKED (0/18 UI-verified)

**Why it is blocked for this agent**

1. **Sign-in.** Checkpoint 1 needs a password (or a session token or magic link) entered in the browser. Agent safety rules forbid entering passwords or tokens to authenticate, even for a synthetic DEV user. Every other checkpoint sits behind sign-in.
2. **Upload.** The statement-upload control is a native file input. The in-app Browser pane has no file-upload action.

**No checkpoint is labelled "UI verified."** What was verified, without the UI:

- **Checkpoint 12/13, DEV hold behaviour, live** (`scripts/nav1_0168_dev_hold_behaviour_proof.mjs`, 7/7 PASS). It uses a new synthetic instrument on an existing DEV fixture account:
  - a non-certifying status creates no hold;
  - certifying creates exactly one open hold (`statement_reconciliation_in_progress`, 30 days);
  - unchanged-status and unrelated-column updates create no second hold;
  - re-certification extends the same hold, without adding one or shortening it;
  - everything created was deleted, with **residue 0** by count.
- **Checkpoints 12, 16 and 17 (protection and history for a redeemed fund).** PGlite 0200: P5-2a/b/c.

**Runbook for the PO: DEV first, then production.** Record screenshots with personal data blurred.

| # | Step | Pass evidence |
|---|---|---|
| 1 | Sign in as a synthetic user. DEV: created with `scripts/nav1_r2_ui_journey_setup.ts`, which sets country IN and completes onboarding. | Dashboard loads |
| 2 | Open `/investment-intelligence/data` | Upload panel visible |
| 3 | Upload a genuine-format CAS PDF with synthetic identity, e.g. `lib/fixtures/investment-intelligence/pc3-cams/q07` (transaction-rich). Source = CAMS. | Upload accepted |
| 4 | Upload a malformed or polyglot PDF (fixture q10) | Rejected with `upload_admission_rejected`, no stored object. With 8b6692c deployed, the real scan path applies. |
| 5 | Click Process | "Source identified (NN%)". Then DB: `ii_document_parse_runs.parser_code` is a production parser, not `.../parse`. |
| 6 | Performance page, transaction modal | Scheme and ISIN resolved to the real instrument |
| 7 | Same modal | Dates, units, amount and NAV exactly as in the fixture |
| 8 | Upload the same file again | "Already uploaded" notice; transaction count unchanged |
| 9 | Upload q08 (deliberate unit mismatch) | A reconciliation case appears; resolve it or leave it open |
| 10 | Re-evaluate, then Publish to FHIP | Truth badge shows certified |
| 11 | DB | Transactions written exactly once (count by document) |
| 12 | DB | One open hold for each certified instrument |
| 13 | DB | No hold for a non-certified instrument |
| 14 | `/dashboard`, `/reports` (premium entitlement needed for II chapters) | Net worth reflects the published position; report generated |
| 15 | Choose an instrument whose early history is missing, then wait for the next :00/:30 tick (production) or POST the cron route (DEV) | Batch `perInstrument` shows `hydrated` for it; floor recorded |
| 16 | Performance page | XIRR and TWRR shown, not "Not enough history" |
| 17 | Rolling panel and report | 1Y rolling return shown when more than a year of history exists; `ii_report_nav_dependencies` rows for the report |
| 18 | Sign in as a second synthetic user; paste the first user's document URL and API paths | 404/empty for the statement, holdings and report; no job data exposed |

Also run a fully redeemed fund, and a statement whose oldest transaction predates the changeover. The hydration window must start at the fund's history floor, or its inception if earlier, not at a global date.

---

## 5. P5: Retention protection

### 5.1 Traceability matrix

| Dependency | Protected by | Where | Test | Status |
|---|---|---|---|---|
| Current holdings | `ii_holding_snapshots`, `ii_portfolio_truth_status`, `ii_transactions` → `pc6_instrument_is_user_held` | 0189:60-70 | 0189 PGlite; 0200 P5-1 | **Verified** |
| Historical or fully redeemed holdings | Same, with **no** units, status or date filter | 0189 | 0200 P5-2a redemption-only, P5-2b zero-unit snapshot, P5-2c closed lot | **Verified** (lost only if the user or account is deleted: cascade) |
| Accepted statement transactions | `ii_transactions`, any status, written at parse time | 0189 | 0189 (reversed transaction) | **Verified** |
| Open or resumable imports | Protected once parse writes transactions. Before that: not protected; relies on re-hydration. | — | — | **Gap (disclosed).** `ii_ai_extraction_reviews` is absent in production, so nothing can be pending there. |
| Certified-statement holds | `ii_nav_retention_holds`, open and unexpired | 0168/0171 trigger; predicate | DEV live 7/7; 0200 P5-4 | **Verified** |
| Released or expired hold | Stops protecting at release or at `expires_at`. The certified instrument stays protected through its truth row. | predicate | 0200 P5-5a/b | **Verified** (documented policy) |
| Finalized-report NAV dependencies | `ii_report_nav_dependencies`, date-ranged | 0172; `reportsData.ts:394` | 0200 P5-3a/b/c; 0172 PGlite | **Verified.** Gap F-6: a failed write leaves a ready report unpinned. |
| Preview reports | No preview path exists; non-eligible and free reports never reach the writer | `reportsData.ts:176-200` | `pc6ReportNavDependencyWriter` unit test | **Repository evidence** |
| Re-finalization | Upsert on (report, instrument, basis) | 0172 unique index | 0200 P5-7 | **Verified** |
| Goal-linked investments | `ii_goal_allocations` → snapshot or publication (user-held); `investments.ii_canonical_instrument_id` | 0034/0042 | Manifest anti-join | **Verified** (0 links in production) |
| Portfolio snapshots | `ii_holding_snapshots` | 0189 | 0189 | **Verified** |
| Unresolved exceptions | No instrument column (`ii_reconciliation_cases`, `ii_review_items`). Rows reach `ii_transactions` with an instrument (provisional if needed). | — | — | **Gap (disclosed).** Protected only after transactions are written. |
| Manual corrections | User corrections are new `ii_transactions` rows (protected). NAV-side `ii_reference_corrections.target_row_id` has no FK. | 0155 | — | **Partial.** The self-FKs `superseded_by_id`/`correction_of_id` fail closed: they block deleting a referenced row (0201 test). |
| Cross-border, duplicate, merged or renamed schemes | **Now:** merge family (both directions, transitive) | **0200** | 0200 P5-10a–e (negative controls reproduce stranding under 0189) | **Fixed on branch.** Production has 0 merge links today. |
| Seven user-scoped `ii_*` sources | `pc6_instrument_is_user_held` / `pc6_user_held_instrument_ids` | 0189 | 0189 derived-set check; manifest independent union = RPC | **Verified.** Note: `ii_ownership_allocation` (0153, DEV only) is not included, and its column name escapes the derived check. Extend before 0153 reaches production. |
| Tax and legal | `ii_tax_lots`, `ii_capital_gains_computations` | 0189 | 0189 | **Verified** |
| Fail-closed: missing table or function | The SQL function raises an error | predicate | 0200 P5-8c/d | **Verified** |
| Fail-closed: NULL changeover or date | Returned NULL | — | 0200 negative control | **Defect, fixed in 0200:** now returns false (keep), P5-8a/b |
| Fail-closed: wrong caller | `anon`/`authenticated` could execute and got TRUE for held funds (**Verified live on DEV**) | — | 0200 negative controls 05/06 | **Defect, fixed in 0200:** service role only, P5-9a–e |
| Cross-user leak | The predicate returns a boolean only. RLS keeps user B away from user A's rows. | — | 0200 P5-9f | **Verified.** No leak, and after 0200 not even callable. |

"User-held" is **not** current positive balance: redemption-only, zero-unit and closed-lot funds are all KEEP (P5-2).

---

## 6. P6: Provider accuracy and fallback governance

- **Provenance (Verified)** of all 77,090 NAV rows of the 17 held funds:
  - 77,022 from `amfi-historical-backfill-2026-09-20`;
  - 68 from `pc6-amfi-parser-v1` (daily);
  - **0 from TIGZIG**;
  - 0 non-positive NAVs;
  - 0 duplicate dates.
- **Independent AMFI reconciliation (Verified).** `scripts/nav1_p6_provider_accuracy_probe.mjs`: a separate parser, locating AMFI columns by header name, over fresh AMFI downloads.
  - 17 funds × 3 windows (51 requests) spanning 2006–2026.
  - **720/720 values exact.** 0 dates on file missing from AMFI; 0 AMFI dates missing on file.
  - My first run reported 0/720 because its parser read the wrong AMFI column. AMFI's layout is `Scheme Code;NAV Name;Plan;Option;ISIN;ISIN;Net Asset Value;Date`. The probe now reads columns by name. This was a probe defect, not a data defect.
- **Plan and option mix of the held set:** 16 regular/growth and 1 direct/growth. No IDCW and no merged scheme is held, so those cases are covered by PGlite and fixtures only.
- **Fallback governance (Repository evidence + tests).**
  - TIGZIG is used only after AMFI fails.
  - `not_found` requires both sources to agree.
  - Each row carries its real provider in `data_version`.
  - A block page is `schema_unexpected`, never a floor (existing suites plus new fairness test 10).
  - TIGZIG has not been used in production (0 rows).
  - **Not built:** comparing overlapping TIGZIG observations with AMFI and quarantining conflicts. `decideUpsert` never overwrites an existing value; a different value is skipped, not flagged. Recorded as F-8.
- **Recoverability gap F-3 (Verified live).**
  - AMFI serves pre-merger history under the **former** fund house's code.
  - The adapter resolves the fund house from the scheme's **current** AMC name.
  - HSBC Short Term Fund (AMFI 151069, formerly L&T): 2,274 of 3,199 stored rows are unreachable. AMFI fund house 37 and TIGZIG both return nothing before Sep 2022.

---

## 7. P7: D.10 read-only production manifest

- **Generator:** `scripts/nav1_d10_readonly_manifest.mjs`, rebuilt against 0189.
- **Why the old generators were retired:**
  - they used the certified-only protected set;
  - they ignored hold expiry;
  - they were silently capped at 1,000 rows.
- **Command:** `node scripts/nav1_d10_readonly_manifest.mjs prod <outDir> 10000`

**Manifest identity**

| Field | Value |
|---|---|
| Manifest ID | **`NAV1-D10-production-2026-09-25-ffdff57ed75a`** |
| Generated | run 1 at 00:05:05Z (generator commit `54879f9`); run 2 at 00:19:15Z (commit `770ca1c`). The generator file was byte-identical in both. |
| Database | production `twwpnltizhtjxhamyoxt` |
| Deployed app | see §1.1 |
| Migration set (repository, at the generator commit) | 183 files, sha256 `68ce58b9…`. The applied set is not readable. |
| Retention policy | `nav1-0189-user-held`, changeover **2026-09-21** |
| Predicate | 0189 `pc6_nav_row_is_candidate` (repository source sha256 recorded in `manifest.json`). **The manifest rule is stricter:** any report dependency and any hold row protects the whole instrument; merge families and core `investments` links are included. |
| Boundaries | `price_date` ≥ 2006-04-01 (the table minimum) and < 2026-09-21. Latest candidate date 2026-09-20. |
| **Candidate rows** | **22,323,340** across **14,336** instruments |
| Protected before the changeover | 77,039 rows, 17 instruments. Reasons: `user_held:ii_transactions`, `ii_holding_snapshots` and `ii_portfolio_truth_status` (17 each). Every other reason: 0. |
| By year | 2006: 138,856 … 2020: 1,788,817 … 2026: 1,086,204. By month: 246 months, in `manifest.json`. |
| Estimated bytes | about 6.7 GB (22.3M × ~300 B). **An estimate only**: `pg_class` is not readable. Measure with Q6. |
| **Aggregate checksum** | sha256 **`ffdff57ed75a8cd1b4075c8f8b78ca4c1534a99548705fd3344b00f29e1178be`** |
| Per-instrument md5 (reproducible by the PO with SQL Q3) | **`0f3c2e095b915ad3406d106869d717d6`** |
| Full primary-key checksum | **Blocked** via PostgREST (~22.3M ids). SQL Q4 computes it in chunks. |
| No-mutation evidence | 14,866 requests, all GET, 0 refused. The client has no way to issue another method. Protected-state snapshot before and after: identical. |

**Assertions (15/15 true in both runs):** zero candidates intersect any of the following:

- the independent user-held union;
- the RPC user-held set;
- any hold row;
- report dependencies;
- benchmarks;
- merge families;
- core investment links;
- rows on or after the changeover.

Also:

- no running batch at generation;
- the per-instrument and per-month partitions agree exactly;
- 30/30 candidate samples are candidates under the deployed predicate;
- 17/17 protected samples are KEEP;
- 7/7 post-changeover samples are KEEP.

**Determinism:** runs 1 and 2 have identical aggregate checksum, per-instrument md5, counts and canary (Verified).

---

## 8. P8: D.11 recovery

### 8.A Source rehydration

**Delete, rehydrate and compare on DEV (`scripts/nav1_d11_dev_rehydration_proof.ts`): Blocked by F-1.**

- Instrument: DSP Corporate Bond Fund (AMFI 144650), not held; DEV history 2018-09-11 to 2026-09-18, all from AMFI.
- Attempt 1: the bounded delete of the oldest 600 rows hit the statement timeout, and nothing was deleted.
- Attempt 2: adaptive batches down to one row. Five rows were deleted, then a **single-row delete** timed out.
- In both attempts the script restored the originals (same ids, same metadata). The instrument is **byte-identical to its before-image**: full sha256 `893861588d28…`, 1,948 rows.
- Residue: 0 batch rows, 0 floors.
- The script is ready to rerun unchanged once 0201 is on DEV:
  `npx tsx --env-file=D:/FHIP/.env.local scripts/nav1_d11_dev_rehydration_proof.ts 028be273-9d60-4d81-9945-334723f5d4d0 2020-09-15 <outDir>`
- It covers:
  - an interrupted run (fails the 2nd provider call);
  - a resume run with exact comparison;
  - an idempotent third run;
  - an exact restore;
  - cleanup.

**Non-destructive fidelity for the whole proposed canary (`scripts/nav1_d11_source_fidelity_check.ts`): Verified.**

This runs the production hydration fetch path (730-day chunks, AMFI then TIGZIG) over each fund's full stored pre-changeover range, writes nothing, and compares every date and value.

| Canary fund | AMFI | Rows | Range | Result |
|---|---|---|---|---|
| HDFC NIFTY 50 ETF | 135853 | 2,661 | 2015-12-09 → 2026-09-18 | **2,661/2,661 exact**, all AMFI |
| Baroda BNP Paribas Money Market | 147377 | 1,758 | 2019-06-20 → 2026-09-18 | **1,758/1,758 exact** |
| Reliance Fixed Horizon XXVI-9 (matured 2018) | 128841 | 1,027 | 2014-04-10 → 2018-07-16 | **1,027/1,027 exact** |
| Tata Floating Interest Rates | 149002 | 1,259 | 2021-07-12 → 2026-09-18 | **1,259/1,259 exact** |
| HSBC Short Term Fund | 151069 | 3,199 | 2013-01-28 → 2026-09-18 | **925 only.** 2,274 unrecoverable: 5 chunks `not_found` from both sources (F-3) |

- A separately authorized TIGZIG-only exercise was **not run** (not authorized).

### 8.B Backup / PITR restore: BLOCKED

The PO must provide:

1. Plan tier and PITR status, with the retention window (Dashboard → Database → Backups).
2. A restore of a recent backup or PITR point into an **isolated** project (a branch or a new project), never over production.
3. On the restored copy:
   - `select count(*) from ii_prices_nav`;
   - SQL Q3 and Q4.
   The checksums must match the source at the chosen point.
4. Measured recovery time (start to queryable) and recovery point (restore timestamp versus source).
5. Operator name, timestamp and evidence reference (screenshot or ticket).

Until then: no FULL PASS, and no production deletion.

---

## 9. P9: Pre-deletion certification and authorization package

1. **Deployed SHA and migrations.**
   - `713561d` (operator-confirmed) is behaviourally live (§1.1). `8b6692c` has been merged since; its deployment is unverified.
   - 0166–0194 are on `main`; production objects are present (§1.3).
   - **0199, 0200 and 0201 are not applied anywhere.**
2. **Starvation evidence.** §2: the budget fix is live; the fairness fix is on the branch, not deployed.
3. **0194 isolation.** §3.0: PGlite 9/9; cron rows Blocked (Q2/Q2b).
4. **Scheduled proofs.**
   - Hydration: Verified (no-op).
   - Daily NAV: §3.1.
   - Scheme master: pending (30 Sep).
5. **UI journey.** Blocked, 0/18 (§4).
6. **Traceability.** §5.
7. **Provider accuracy.** §6: 720/720; gap F-3.
8. **Manifest.** `NAV1-D10-production-2026-09-25-ffdff57ed75a`, aggregate sha256 `ffdff57e…78be`, per-instrument md5 `0f3c2e09…17d6`, 22,323,340 candidate rows.
9. **Recovery.**
   - Source fidelity: 4 of 5 canary funds exact.
   - Delete/rehydrate cycle: Blocked until 0201 is on DEV.
   - Backup restore: **Blocked**.
10. **Size baseline.**
    - Logical: 22,426,471 rows (exact).
    - Physical: **not measured**; SQL Q6.
11. **Proposed canary.**
    - **6,705 rows** = the whole pre-changeover history of the 4 funds proven recoverable (table above).
    - Primary-key md5 **`ec137c8b2bb59bcc93342b0f94f63086`**, sha256 `0eecd689…6d15`, id list `canary_revised_ids.txt`.
    - All 6,705 ids lie inside the manifest's original canary (9,904 ids, md5 `0fe5a154…1ee2`) and match the manifest's per-instrument counts.
    - Predicate: `id ∈ list AND price_date < 2026-09-21 AND pc6_nav_row_is_candidate(instrument_id, price_date, 2026-09-21)`, the last evaluated **live, inside the DELETE**.
12. **Controls** (`docs/nav1/NAV1_StageE_canary_PROPOSAL_do_not_run.sql`, PGlite 9/9):
    - batches of 500 ids, each its own transaction;
    - `lock_timeout 2s`, `statement_timeout 30s`;
    - a queue-consuming loop, so each id is visited exactly once;
    - a stop on any batch where deleted ≠ taken;
    - pause between batches at operator discretion;
    - **preconditions: 0200 and 0201 applied; 0 running batches; 17 held funds**.
    - This validation caught and fixed a bug in the first draft: a stalled loop at 496 of 994 rows.
13. **Rollback or restore triggers.** Stop, and restore if needed, on any of:
    - any error;
    - deleted ≠ taken;
    - any change in the held-fund row count;
    - any held fund becoming a candidate;
    - hydration or daily NAV failure;
    - a user-visible calculation change.
    Restore paths:
    - re-hydrate the 4 canary funds from AMFI (fidelity proven exact);
    - or PITR (Blocked, not yet evidenced).
14. **Monitoring and abort thresholds.**
    - Watch: batch timing; 0 lock timeouts; the next two hydration ticks `succeeded`; the next daily tick `succeeded` with about 8,600 rows for the latest date; held-fund row count unchanged.
    - Abort on the first deviation.
15. **Zero production NAV rows have been deleted.**
    - Manifest runs 1 and 2 have identical pre-changeover per-instrument counts, and this session made no production writes (Verified).
    - The earlier history is operator-confirmed.

### STOP GATE 1

> Authorize Stage E canary deletion only against manifest `NAV1-D10-production-2026-09-25-ffdff57ed75a` with checksum `ffdff57ed75a8cd1b4075c8f8b78ca4c1534a99548705fd3344b00f29e1178be`, limited to `6705` rows and the exact predicate/boundaries documented in this package?

**Recommendation: do not authorize yet.** The brief itself forbids deletion while backup restore is Blocked (P8.B). The package's own preconditions are also unmet: 0200 and 0201 must be applied to production and verified first. When they are, re-run the manifest. It must reproduce the same aggregate checksum and canary md5 `ec137c8b…3086`, or a new approval is needed. Silence or earlier approvals are not authorization.

---

## C. Defect register

| ID | Severity | Discovery | Root cause | Fix | Tests | Deployment | Residual risk |
|---|---|---|---|---|---|---|---|
| F-1 | **P1 for Stage E** (no production harm yet) | Live DEV: a 600-row delete, then a 1-row delete, timed out | Self-FKs `superseded_by_id` and `correction_of_id` have no index, so every deleted row costs two full-table scans | Migration **0201** (partial indexes) | PGlite 8/8: sequential scan before, index after, FK still enforced | Not applied | Plain `CREATE INDEX` briefly blocks writes while it builds. The file gives the `CONCURRENTLY` form. |
| F-2 | **P1** | Live DEV: `anon` got TRUE (deletable) for a held fund | Supabase default EXECUTE plus SECURITY INVOKER under RLS | **0200**: revoke from public/anon/authenticated; grant to `service_role` | PGlite P5-9a–f with negative controls | Not applied | None known. Nothing else calls these functions (grep). |
| F-3 | **P1 for Stage E scope** | Live: canary fidelity check (HSBC Short Term Fund, 925 of 3,199) | AMFI publishes pre-merger history under the former fund house's code; the adapter asks the current one | **Not fixed.** Canary narrowed to 4 proven-recoverable funds. Options: adapter fallback to former fund-house codes, or a code-free query; or a pre-expansion recoverability scan. | Fidelity script | — | Deleting history of fund-house-merged schemes is unrecoverable except by backup (Blocked) |
| F-4 | Medium | Brief P1 gap; negative control on `713561d` | Fixed fetch order | `c1f395e` + 0199 (ledger); rotation fallback when 0199 is absent | 18 tests | Branch only | Until deployed, 10+ persistently failing funds could starve others (0 today) |
| F-5 | Medium | Code review; negative control | The batch counted already-covered funds as success | `c1f395e` (`classifyHydrationRun`) | Batch-status tests | Branch only | — |
| F-6 | Medium | Code review (P5) | A dependency-write failure leaves a `ready` report unpinned, and retry refuses a non-failed report | **Not fixed** (changes user-visible report status; PO decision). Stage E precondition: every ready report with II content has pins. | — | — | Production today: 1 pre-writer report, 0 premium users, so nothing is affected |
| F-7 | Low | Production baseline | `ii_scheme_master.lifecycle_status` is never updated (14,358 `active`, including funds matured in 2018) | Not fixed | — | — | "Live schemes" cannot be derived; scheme-master "transitions" are not demonstrable |
| F-8 | Low | P6 review | Fallback-vs-AMFI conflict quarantine is not implemented (a different value is skipped silently) | Not fixed | — | — | TIGZIG unused in production (0 rows) |
| F-9 | Low | P5 | NULL changeover returned NULL, not false | 0200 | P5-8a/b | Not applied | — |
| F-10 | Low | P5 | Scheme-merger stranding | 0200 merge family | P5-10a–e | Not applied | 0 merge links in production |
| F-11 | Low | Research | Retired manifest generators were stale (certified-only rule, 1,000-row cap) | Replaced by `nav1_d10_readonly_manifest.mjs` | Ran twice, deterministic | — | — |

Dispatch-context corrections:

- `rows_read` was already 17 before 7fe349e (it counts instruments considered). The 10→17 change is visible only in `notes.perInstrument`.
- 0198 was not free.

---

## D. Mutation ledger

**Production: none.** Every production request was a GET through the guarded client. There were no writes, deletes, RPC POSTs, migrations, cron or kill-switch changes, or users created.

**DEV** (host asserted before each write; synthetic data only):

| UTC (25 Sep) | Action | Object | Rows | Cleanup |
|---|---|---|---|---|
| 00:1x (approx.) | D.11 attempt 1: bounded delete | `ii_prices_nav`, instrument 028be273 | **0** (statement timeout, rolled back) | Verified identical (full sha256) |
| 00:2x (approx.) | D.11 attempt 2: batched delete | same | 5 deleted, then a timeout | 5 re-inserted with original ids and metadata; full sha256 identical to the before-image; 0 batches and 0 floors created |
| 00:2x–00:3x (approx.) | 0168 proof, run 1 | synthetic instrument, 1 truth row, 1 hold | 3 | Deleted; residue 0 |
| 00:2x–00:3x (approx.) | 0168 proof, run 2 | same shape, new instrument | 3 | Deleted; residue 0 |

No DEV user was created, and the DEV kill switch was not touched: the D.11 script satisfies the switch in-process.

---

## E. Limitations and blockers

- **Blocked:**
  - production cron rows and `net._http_response` (Q2);
  - `pg_class` sizes (Q6);
  - the full primary-key checksum (Q4);
  - the 0168 production proof (Q7);
  - the backup/PITR restore;
  - the 18-point UI journey;
  - the production uncovered-fund proof;
  - pushing the branch (permission denied).
- **Pending:** the scheme-master tick (30 Sep). The daily tick: see §3.1.
- **Deployed SHA:** there is no version endpoint. Evidence is behavioural and operator-confirmed.
- **The manifest's migration-set hash** is the repository set at the generator commit (it includes the unapplied 0199–0201). It is not the applied set.
- **Rotation fallback** gives eventual reach only while the set of funds needing a fetch is stable. The ledger ordering has no such limit.
- **The report dependency-write gap (F-6)** and **fallback conflict quarantine (F-8)** are open by design decision, not fixed here.

---

## F. Product Owner decisions

1. **Merge** `fix/nav1-production-completion-2026-09-25` to `main` (this deploys). **Not authorized in this dispatch.** The branch also needs pushing; push was denied to this session.
2. **Apply 0199, 0200 and 0201** to DEV, then production (§H). Suggested order: 0201 outside the 03:30 and :00/:30 windows, then 0200, then 0199. Each is independent. The code tolerates 0199's absence.
3. **Stage E scope decision on F-3.**
   - (a) Fix the adapter for fund-house changes, then run a recoverability scan before expansion; or
   - (b) exclude schemes whose fund house changed; or
   - (c) accept backup-only recovery for them, once backup restore is evidenced.
4. **F-6:** should a manifest-write failure mark the report failed so retry can pin it?
5. **Backup/PITR evidence** (§8.B).
6. **STOP GATE 1** (§9). Not recommended until items 2 and 5 are complete.

Authorization status for this dispatch:

| Action | Authorized? |
|---|---|
| Push | No (denied) |
| Merge | No |
| Deploy | No |
| Cleanup | No |
| Maintenance | No |
| Broader activation | No |

---

## G. Proposed production actions (for the PO; none performed)

All SQL is in `docs/nav1/NAV1_D10_manifest_sql_for_PO.sql` and is read-only unless stated.

| # | Action | Purpose |
|---|---|---|
| Q1 | Identity check in each project | Guards against running SQL in the wrong project |
| Q2 / Q2b / Q2c | `cron.job` on DEV and production; `job_run_details`; `net._http_response` | 0194 isolation; the 03:30 tick at the pg_cron and HTTP layers |
| Q3 | Reproduce per-instrument candidate counts and md5 | Independent confirmation of the manifest |
| Q4 | Full candidate primary-key checksum (chunked) | Manifest identity (Blocked here) |
| Q5 | Canary count and md5 from the database | Confirms the 6,705-row canary |
| Q6 | Table, index and database sizes; dead tuples | P9 item 10 / P11 baseline |
| **Q7** | **0168 hold proof in a transaction that ends in ROLLBACK** (synthetic user, account and instrument created inside it) | P0.3. Expected: 0 → 1 → 1 holds; residue 0 after rollback. |
| Q8 | After 0200: EXECUTE grants on the three functions | Proves the F-2 fix is live |
| P-1 | After merge and deploy: watch the next hydration batch for `notes.telemetry.ordering` (`rotation_fallback` until 0199, then `least_recently_attempted`) | Fairness fix live |
| P-2 | Optional uncovered-fund proof, **only after 0201**: attach a synthetic user's truth row (inside a scoped script) to one non-held fund with a verified AMFI source. Wait for the next tick and check it is hydrated even though 17 covered funds sort around it. Remove the synthetic rows afterwards. | The brief's P1 post-deploy proof. Needs a production write, so it needs the PO. |

---

## H. Migrations to apply (separate files)

| File | Purpose | Verification |
|---|---|---|
| `supabase/migrations/0199_nav1_hydration_attempt_ledger.sql` | Attempt ledger for fair hydration ordering | `node scripts/nav1_0199_pglite_verification.mjs` → 14/14 |
| `supabase/migrations/0200_nav1_retention_predicate_fail_closed.sql` | Service-role-only predicate; never NULL; merge families | `node scripts/nav1_0200_pglite_verification.mjs` → 39/39 |
| `supabase/migrations/0201_nav1_prices_nav_self_fk_indexes.sql` | Stage E prerequisite: index the self-FKs | `node scripts/nav1_0201_pglite_verification.mjs` → 8/8 |

Copies of all three are in the scratchpad `nav1_completion/` folder.

---

## 12. Commits on the branch (this dispatch)

| Commit | Content |
|---|---|
| `c1f395e` | Fair ordering, honest status, telemetry, tests |
| `e2e19bc` | 0199, 0200, PGlite scripts, D.10 generator |
| `c00398c` | Canary rule; SQL for the PO |
| `54879f9` | 0201 and its PGlite script; D.11 proof script |
| `770ca1c` | DEV 0168 proof; fidelity check; P6 probe |
| `50e5e19` | Stage E canary proposal SQL and its PGlite check |
| `6660d68` | Merge of `origin/main` (`8b6692c`) |
| final | This report |
