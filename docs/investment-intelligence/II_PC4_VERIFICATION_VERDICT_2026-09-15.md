# II-PC4 — Terminal Verification Verdict (M1)

**Mission:** FHIP — Investment Intelligence + AIE-1 Convergence, Master End-to-End Execution
**Phase:** M1 — PC4 terminal verification only (Part G of the master dispatch)
**Date:** 2026-09-15
**Branch:** `mission/m1-pc4-verification-2026-09-15` (local only, not pushed)
**Baseline commit:** `origin/main` = `23b49da1d63c9c20f980ea9042e176845b6f60e3` — **re-fetched 2026-09-15, unchanged since M0**
**Companion:** `II_PC4_POST_CLOSURE_REGRESSION_CONTRACT_2026-09-15.md` (Part G.2 deliverable)

**Authority used this phase:** repository and git inspection; test execution; **read-only**
PostgREST `GET` probes against DEV and PRODUCTION with paired negative controls.
**Authority NOT used:** no source file was modified; no migration was created or applied; no
write, RPC, DDL or DML was executed against any database; no OpenAI or AWS call was made;
nothing was pushed. No credential value, PAN, folio number, holder name, bank number or raw
statement text appears anywhere in this document.

---

## HEADLINE

> **PC4's IMPLEMENTATION is genuinely merged, deployed and stable — YES, proved.**
> **PC4's terminal CERTIFICATION verdict is NOT achievable right now — and the gap is larger
> than the five residuals the existing CONDITIONAL report names.**
>
> **M1 phase verdict: CONDITIONAL PASS.**
> Blockers, exactly: **(B1)** PC4's ≥48-section specification does not exist in the repository
> or on the Product Owner's filesystem, so the "Section 47/48 terminal verdict" the closure gate
> demands cannot be issued against criteria nobody can read (**OA-1**); **(B2)** closure-gate
> step 6 — the reduced synthetic P01–P10 pack — is an **open Product-Owner decision**, not an
> unexecuted task, and step 7 depends on it; **(B3)** a new finding this phase: **zero of the
> Product Owner's 17 real production positions are certified**, and three blockers sit on **all
> 17**, including the 12 that reconcile to variance `0.000`.
>
> **This does not halt the mission.** PC4's implementation is stable, its regression contract now
> exists, and M2 (AIE infrastructure) depends only on those two facts.

---

## 1. Part G.1 — the two questions, answered separately

The dispatch requires "implementation deployed" and "terminal certification issued" to be
answered as **different** questions. They are.

### 1.1 Is PC4's implementation genuinely merged and deployed? — **YES (PASS)**

| ID | Check | Result | Evidence |
|---|---|---|---|
| **M1-G1-01** | All PC4 fix commits are ancestors of current `origin/main` | **PASS** | `git merge-base --is-ancestor <c> 23b49da` returns 0 for **all 11**: `c22ea75`, `1ab6d40`, `a978382`, `8519148`, `77c059e`, `02b3754`, `e946557`, `b514e7c` (superseded), `d0a65f2`, `acbaec3`, `dd52476` |
| **M1-G1-02** | The fixes are **still present in the tree**, not later reverted | **PASS** | `ALT_TXN_ROW_WRAPPED_START_RE` at `camsParser.ts:291`; `reclassifyNegativeSignedInflowRows` at `:514` (invoked `:1146`); `{ code:'lateral_shift', … type:'transfer' }` at `transactionTypeMapping.ts:82`. Present at `23b49da`. |
| **M1-G1-03** | Certified SHA | **PASS (identified)** | The last PC4 code commit is `e946557` (2026-09-07). There is no separately "certified SHA" because no certification was ever issued (§1.2). |
| **M1-G1-04** | Production deployed ancestry | **PASS — proved by live data, not by inference** | The production database holds **34 `ii_document_parse_runs`** whose behaviour tracks the fix sequence exactly (§3). Fixes were pushed to `main`; Amplify auto-deploys `main`. |
| **M1-G1-05** | Migration state | **PASS / NOT APPLICABLE** | PC4 created **no migration** — it was a parser/reconciliation/classification pass. M0's `MG-1` (next free version is `0153`, not `0149`) is unaffected by this phase. |
| **M1-G1-06** | Has anything changed PC4's **code** since the verdict artifact was written? | **PASS — effectively no** | Only **4** commits touch II scope after 2026-09-07 (`20a7787`, `cbd338f`, `f86962a`, `7cbfa15` merge). See §2. The four core PC4 files (`camsParser.ts`, `reconciliation.ts`, `transactionTypeMapping.ts`, `documentProcessing.ts`) have **no commit after 2026-09-07**. |
| **M1-G1-07** | Has anything changed PC4's **data** since the verdict artifact was written? | **PASS — no** | Most recent `ii_transactions.created_at` in production = **`2026-09-07T12:29:44Z`**. Most recent `ii_portfolio_truth_status.last_evaluated_at` = **`2026-09-07T13:07:02Z`**. PC4's economic data has not moved. |
| **M1-G1-08** | Zero known unresolved P0/P1 within PC4 scope | **FAIL** | Five reconciliation residuals reproduce **exactly** (§3.1), plus the new §4 finding. |
| **M1-G1-09** | Regression suite green | **PASS** | **85 test files executed → 84 passed, 1 skipped, 0 failed; 1,673 tests passed, 5 skipped, 0 failed.** |

**Conclusion 1.1: PC4's implementation is merged into `origin/main`, present in the tree, deployed to production, exercised against real data, and covered by a fully green regression suite. It is stable. M2 may proceed on it.**

### 1.2 Was a terminal certification verdict ever issued? — **NO (FAIL)**

| ID | Check | Result | Evidence |
|---|---|---|---|
| **M1-G1-10** | A PC4 terminal/closure/acceptance report exists on any ref | **FAIL — none exists** | `git log --all --diff-filter=A --name-only` across all refs returns exactly **four** files whose path contains `PC4`: `II_PC4_STATUS_2026_09_07.md`, `II_PC4_SECTION20_DOCUMENT_LIFECYCLE_LIMITATION.md`, and this mission's own two M0 documents. **Zero deletions ever** — nothing was removed and hidden. |
| **M1-G1-11** | The only verdict artifact still says what M0 reported | **CONFIRMED, verbatim** | `II_PC4_STATUS_2026_09_07.md:3` — *"**Verdict: II-PC4 — CONDITIONAL PASS.** Not terminal."*; `:167` — *"Issue the Section 47/48 terminal verdict — **not issued.**"* |
| **M1-G1-12** | Closure-gate steps 6, 7, 8 | **FAIL — all three unstarted/unissued** | `:165` step 6 *"not started, awaiting PO go-ahead"*; `:166` step 7 *"not started (depends on #6)"*; `:167` step 8 *"not issued"*. |

**Conclusion 1.2: no PC4 terminal certification has ever been issued. M0's finding stands, re-verified against current `origin/main`, not carried over.**

> **On the Product Owner's statement that "PC4 has now been completed."** Both claims are true of
> *different things*. The **implementation** is complete, merged and deployed — the PO is right
> about that. The **certification** was never issued, and the system's own production state
> (§4) shows the certification objective was never met. The dispatch's Part B.1 instruction —
> treat PC4 as closed *subject to repository-grounded verification* — is discharged by reporting
> exactly this split, rather than by choosing one claim over the other.

---

## 2. Everything that touched PC4's surface after 2026-09-07 (Part W.3 — no hand-waving)

Four commits, all inspected in full. **None changes a PC4 invariant.**

| Commit | Date | What it does | Effect on PC4 |
|---|---|---|---|
| `20a7787` | 2026-09-14 | Zod validation-error sweep across 59 API routes; touched **12** II routes including `source-documents/[id]/process/route.ts` and `portfolio-truth/certify/route.ts` | **None.** The entire II diff is `bad(parsed.error.message, 422)` → `badValidation(parsed.error, 422)` plus the import. A 422 response body's wording only. |
| `cbd338f` | 2026-09-14 | CAMS password box now appears without a reload — `loadDocuments()` moved to run **unconditionally before** the failure throws | **Improves PC4-INV-17.** Fixes a real dead end where `password_required` flipped server-side but the input never rendered. Does not alter extraction, classification or reconciliation. |
| `f86962a` | 2026-09-14 | II back-to-Dashboard link (`InvestmentIntelligenceSubNav.tsx`) | **None.** Navigation only. |
| `7cbfa15` | 2026-09-14 | Merge commit for `20a7787` | **None.** |

**Exact counts:** commits touching `lib/services/investment-intelligence` ∪ `app/api/investment-intelligence` ∪ `components/investment-intelligence` after `2026-09-07T23:59` = **4**. Commits touching the four core PC4 source files after that date = **0**.

---

## 3. Part G.3 — are the five residuals closable by me right now?

### 3.1 First: do they still reproduce? — **YES, all five, exactly**

Read-only production probe of `ii_portfolio_truth_status` (the table
`documentProcessing.ts:1208-1230` writes reconciliation results into). Negative control
(`?select=zz_no_such_column_m1`) correctly returned `42703` — the method does not produce false
positives.

| Instrument (8-char prefix) | Variance now | Variance in `II_PC4_STATUS_2026_09_07.md:70-73` | Match |
|---|---|---|---|
| `45773ec3` (Axis Large Cap) | **−156.618** | −156.618 | **exact** |
| `9a923d57` (Kotak Mid Cap) | **+111.505** | +111.505 | **exact** |
| `948fb23a` | **−12.932** | −12.932 | **exact** |
| `385feb70` | **−4.457** | −4.457 | **exact** |
| `76c30cb9` | **−2.678** | −2.678 | **exact** |

`unit_variance_within_tolerance`: **12 `true`, 5 `false`, 0 `null`** — the report's 12/17 is
exactly right, and `null` never leaked as `true` (PC4-INV-15 holding).
`history_completeness`: `complete_from_inception` on all 17.

**Residuals reproduced: 5 of 5. Residuals not reproduced: 0.**

### 3.2 Second: can I close them? — **NO, and the reasons are structural, not effort**

| ID | Residual | Closable by me now? | Why not |
|---|---|---|---|
| **R-1** | Axis `45773ec3`, −156.618 | **NO** | `II_PC4_STATUS_2026_09_07.md:93` records that the standalone-SIP-rejection hypothesis **failed to confirm** on the next two rejection pairs, and that a fix needs the transactions' **true physical parse order**, which a date-sorted query cannot supply. Closing it means changing shipped production parser behaviour — a PC4 campaign re-run, which **Part G.1 explicitly forbids doing unnecessarily**. Shipping on partial evidence is precisely the mistake `b514e7c` already made once. |
| **R-2** | Kotak `9a923d57`, +111.505 | **NO** | `:97` — *"Kotak's pre-2022 transaction history has never actually been examined."* Same re-run objection as R-1, plus: investigating it means reading and reporting the Product Owner's **real personal financial transactions**, which Part A.1 forbids committing to the repository. |
| **R-3/4/5** | `948fb23a` −12.932, `385feb70` −4.457, `76c30cb9` −2.678 | **NO** | `:103` — *"No hypothesis exists for any of them."* Same two objections. |
| **R-6** | Closure step 6 — reduced synthetic P01–P10 pack | **NO — and this one is not mine to decide** | `:154` — *"Awaiting PO go-ahead before building it."* It is an **open Product-Owner scope decision**. I have no authority to substitute my judgment. |
| **R-7** | Closure step 7 — independently verify cleanup = 0 residue | **NO** | Depends on R-6. And **no PC4/production synthetic-data cleanup mechanism exists anywhere** (regression contract CG-3) — running the pack against production would create residue I could not prove I removed, breaching Part A.1's cleanup discipline. |
| **R-8** | Closure step 8 — issue the Section 47/48 terminal verdict | **NO — hard blocker** | Sections 47 and 48 belong to a specification that **does not exist in this repository and was not found on the Product Owner's filesystem** (M0 **OA-1**; re-confirmed this phase — the four `PC4`-named files in git are listed at M1-G1-10, and none is a spec). **Writing a verdict labelled "Section 47/48" against criteria nobody can read would be fabrication**, which Part C.4 and the Part W evidence standard forbid outright. |

**Conclusion 3: none of the five residuals, and none of the three open gate steps, is closable by me now. Two of the blockers (R-6, R-8) cannot be closed by *anyone* without Product-Owner input.**

---

## 4. **M1-F3 — new finding: PC4's production pilot certified nothing at all**

This was not in the PC4 status report and is not implied by it. It is the single most
consequential result of this phase.

**Read-only production probe of `ii_portfolio_truth_status` (17 rows):**

| Field | Value |
|---|---|
| `status` | **`reconciliation_required` on all 17** — **zero** `certified`, **zero** `certified_with_warnings` |
| `certified_at` | **`null` on all 17** |
| `blocking_reasons` | `parser_fatal_error` ×**17**, `unresolved_owner` ×**17**, `open_blocking_reconciliation_case` ×**17**, `unit_variance_exceeds_tolerance` ×**5**, `material_unclassified_transaction` ×**1** |
| `warning_reasons` | **empty on all 17** |

Corroborated by `ii_holding_snapshots`: **17 rows, `quality_status = 'warning'` on all 17, zero
`certified`** (`documentProcessing.ts:1233`/`:1236` only promote a snapshot to `certified` when
the position certifies — none did). And by `ii_reconciliation_cases`: **126 rows, all `status =
'open'`, zero resolved** — `owner_unmatched` ×120, `transaction_unclassified` ×4,
`document_password_required` ×2.

### 4.1 Why this matters

**PC4 is named "Controlled Production End-to-End Certification." Its production pilot produced
zero certified positions.** The existing CONDITIONAL report measures **reconciliation
arithmetic** (12/17 at variance 0.000) and reports it honestly — but it never reports the
**certification outcome**, which is 0/17. Even if all five reconciliation residuals were closed
tomorrow, **17 positions would still be blocked**, by two blockers the report never mentions.

### 4.2 The three universal blockers, diagnosed

| Blocker | On | Diagnosis | Who can clear it |
|---|---|---|---|
| **`unresolved_owner`** | 17/17 | `documentProcessing.ts:377` — `doc.owner_member_id` is null; `certification.ts:66` blocks. The statement was never mapped to a household member. **Not a code defect** — the app requires the user to pick an owner. | **Product Owner**, in the app. An operator action, not an engineering task. |
| **`open_blocking_reconciliation_case`** | 17/17 | `documentProcessing.ts:1198`. The open-case population is **120 `owner_unmatched`** (opened per account per evaluation at `:378-390`, across 12 accounts and 10 successful runs), plus 4 `transaction_unclassified` and 2 `document_password_required`. **Almost entirely downstream of `unresolved_owner`** and clears with it; the 4 `transaction_unclassified` cases do not. | **Product Owner** for the owner_unmatched majority; the 4 unclassified cases are separate. |
| **`parser_fatal_error`** | 17/17 | **The real engineering finding — see §4.3.** | Engineering, but it needs a Product-Owner severity decision first. |

### 4.3 `parser_fatal_error` — a genuine severity-classification gap

The final successful production run (`aa8d50fa`, 2026-09-07T13:06) recorded:

```
parser=cams_detailed_v1@1.0.0  detected=cams  confidence=0.9
accounts=12  schemes=17  transactions_found=964  holdings=17
warnings(259) = { unparseable_transaction_row/error: 251, unclassified_transaction/warning: 8 }
errors  (251) = { unparseable_transaction_row/error: 251 }
```

`documentProcessing.ts:885` sets `parserHasFatalError = parsed.errors.length > 0`, which
`certification.ts:65` turns into the `parser_fatal_error` blocker **for every position in the
document**.

**Those 251 rows are the very same 251 that PC4's own Section 3 accounting classified as benign:**
77 boilerplate, 84 non-economic lifecycle markers, 90 regulatory footnotes — *"Zero unexplained
economic omissions"* (`II_PC4_STATUS_2026_09_07.md:51-60`), on the strength of which closure-gate
step 5 was marked **satisfied** (`:164`).

So the system and the report disagree about the same 251 rows. **The analysis says benign; the
code says `error`.** The parser emits `unparseable_transaction_row` at severity `error` for any
line that fails the transaction-row grammar — with **no distinction between "a row that looked
like a transaction and would not parse" and "a page footer that is not a transaction at all."**
PC4 drew that distinction **by hand**; the code cannot.

**This is not an argument to weaken the blocker.** `documentProcessing.ts:869-884` documents why
the wiring exists (the PC3 Q10 finding: a document with genuine parse errors must never reach
`certified` on reconciliation math alone). The wiring is correct and must be preserved
(regression contract **PC4-INV-19**). The gap is **upstream**, in severity assignment.

**Why I did not fix it.** It requires classifying which of the 251 shapes are structurally
non-economic — exactly the taxonomy the missing ≥48-section spec would adjudicate (**OA-1**) —
and it changes shipped production parser behaviour, which is a PC4 campaign re-run (Part G.1).
It is named here as a **defect candidate with a reproduction**, not silently fixed.

### 4.4 One observation, deliberately not asserted as a defect

The run reports `transactions_found = 964`; `ii_transactions` holds **952** rows and
`ii_transaction_source_links` holds **952**. The 12-row difference is **consistent with** the
in-run fingerprint collision guard at `documentProcessing.ts:756`, which collapses exact
duplicates *within a single import* — correct behaviour, not a defect. **I did not independently
verify that this is the cause**, because doing so requires reading the Product Owner's real
transaction rows. Recorded as an open observation (**M1-F4**), not a finding.

---

## 5. Evidence register (Part W)

| ID | Item | Result |
|---|---|---|
| **M1-F1** | PC4 implementation merged, present in tree, deployed, data stable | **PASS** (§1.1) |
| **M1-F2** | PC4 terminal certification verdict issued | **FAIL — never issued, on any ref** (§1.2) |
| **M1-F3** | **Zero of 17 production positions certified; 3 blockers on all 17; 251 benign rows emitted at severity `error`** | **FAIL — new finding, reproduced live** (§4) |
| **M1-F4** | 964 parsed vs 952 persisted transactions | **OPEN OBSERVATION — not asserted as a defect** (§4.4) |
| **M1-F5** | Five reconciliation residuals reproduce exactly | **5 of 5 reproduced, 0 not reproduced** (§3.1) |
| **M1-F6** | Residuals closable by me now | **NO — 5 of 5 blocked; 2 gate steps need PO input** (§3.2) |
| **M1-F7** | PC4 code changed since the verdict artifact | **NO — 4 commits, none invariant-affecting; 0 on the core files** (§2) |
| **M1-F8** | PC4 regression contract created with real code citations | **PASS — 19 invariants, 16 source files line-verified** |
| **M1-F9** | II regression suite green at `23b49da` | **PASS — 84/85 files passed, 1 skipped, 0 failed; 1,673 tests passed** |
| **M1-F10** | `pdf-parse` missing from the shared install (5 files could not import) | **PRE-EXISTING ENVIRONMENT GAP, evidenced** — declared `^2.4.5` in `package.json` `dependencies`, absent from `D:\FHIP\node_modules`; corroborated by `20a7787`'s own commit message. Installed into an isolated worktree `node_modules`; all 5 then passed. **No repository change.** |
| **M1-F11** | R5 / R6-P1 certification comparison reports reproduce | **PASS — byte-identical apart from `generatedAt`**; both reverted, worktree clean |
| **M1-F12** | Read-only discipline held | **PASS — 4 negative controls run, all 4 correctly failed; zero writes** |
| **M1-F13** | PC4 migration state | **NOT APPLICABLE — PC4 created no migration** |

**Exact counts.** Test files inspected: **102 matched / 94 genuine**. Test files executed:
**85**. Tests run: **1,678** (1,673 passed, 5 skipped, 0 failed). Source files line-verified:
**16**. Commits ancestry-checked: **11**. Post-PC4 II commits inspected in full: **4**.
Live read-only production probes: **3 scripts**, **4 negative controls**, **0 writes**.
Residuals reproduced: **5**. Residuals not reproduced: **0**.

---

## 6. M1 verdict, in the exact wording Part W requires

> **II-PC4 TERMINAL VERIFICATION — CONDITIONAL PASS.**
>
> **PASS on implementation.** PC4's implementation is merged into `origin/main` (`23b49da`),
> present and unreverted in the tree, deployed to production, exercised against real
> Product-Owner data, unchanged in code or data since 2026-09-07, and covered by a regression
> suite that is **84/85 green, 1,673 tests passed, 0 failed**. A post-closure regression
> contract now exists with **19 invariants pinned to verified `file:line` citations**. **M2 may
> proceed.**
>
> **CONDITIONAL on certification, blocked on exactly three things:**
>
> **B1 — the verdict instrument does not exist.** PC4's ≥48-section specification is not in this
> repository and was not found on the Product Owner's filesystem (**OA-1**). The closure gate's
> step 8 demands a *"Section 47/48 terminal verdict"*. Certifying conformance to sections nobody
> can read would be fabrication. **Requires Product-Owner input.**
>
> **B2 — closure step 6 is an open Product-Owner decision, not an unexecuted task.** The reduced
> synthetic P01–P10 pack is *"awaiting PO go-ahead"*; step 7 depends on it; and no
> production synthetic-data cleanup mechanism exists to make step 7 safe to run.
> **Requires Product-Owner input.**
>
> **B3 — the certification objective was never met, beyond the five named residuals.** **Zero of
> 17** production positions are certified. `parser_fatal_error`, `unresolved_owner` and
> `open_blocking_reconciliation_case` block **all 17**, including the 12 at variance `0.000`.
> `unresolved_owner` is clearable by the Product Owner in the app. `parser_fatal_error` reflects
> a real severity-classification gap: **251 rows PC4's own accounting proved benign are emitted
> at severity `error`**. **Partly Product-Owner action, partly a scoped engineering task that
> needs B1 to adjudicate.**
>
> **NOT a FAIL.** Nothing verified this phase contradicts PC4's implementation being correct at
> the level it was fixed to. The five residuals reproduce **exactly** as reported — no drift, no
> regression, no new arithmetic defect. **NOT a FULL PASS**, because a terminal certification
> cannot be truthfully issued and the 0/17 certification state is a real, reproduced, previously
> unreported gap.

---

## 7. Consolidated Product-Owner action request from this phase

Additive to M0's OA-1…OA-6 / HK-1. **OA-1 is re-confirmed, not re-searched** — M0's search was
exhaustive and this phase found nothing new.

| ID | Action | Why it is blocked here |
|---|---|---|
| **OA-1** *(re-confirmed)* | Supply PC4's ≥48-section specification, **or** state that it no longer exists and authorise a terminal verdict against the invariant list in the regression contract instead. | Closure step 8 names sections 47/48 specifically. Without the text, no honest verdict can cite them. |
| **OA-7** | **Decide closure step 6**: run the reduced synthetic P01–P10 pack, or formally drop it. If run: decide **DEV or production**, and authorise building the cleanup + zero-residue verification that step 7 needs and that **does not exist today**. | An explicit open PO decision since 2026-09-07 (`II_PC4_STATUS_2026_09_07.md:154`). |
| **OA-8** | **Map the CAMS statement to a household member in the app.** This clears `unresolved_owner` on all 17 positions and most of the 120 open `owner_unmatched` cases. | A user action inside the product; not an engineering change, and not something this phase may perform on the PO's real account. |
| **OA-9** | **Decide the severity taxonomy for the 251 `unparseable_transaction_row` findings.** PC4's own Section 3 classified them as boilerplate / lifecycle markers / regulatory footnotes; the parser emits all of them at severity `error`, blocking certification of every position. | Needs OA-1 to adjudicate, and changes shipped production parser behaviour. **Do not fix by weakening `certification.ts:65`** — the fix belongs at the parser. |
| **OA-10** | Decide whether the five reconciliation residuals are **defects to fix** or **accepted variances to document**, given that R-1's hypothesis already failed confirmation once and R-3/4/5 have no hypothesis at all. | Investigating them means reading the PO's real personal transaction history and re-running PC4's campaign, which Part G.1 defers to an explicit decision. |
