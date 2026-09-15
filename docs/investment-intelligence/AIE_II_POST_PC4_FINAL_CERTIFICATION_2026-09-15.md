# FHIP Investment Intelligence + AIE Post-PC4 Final Certification

**Mission:** FHIP — Investment Intelligence + AIE-1 Convergence, Master End-to-End Execution
**Phase:** M11 (phase 10 of 10 executed; the mission's own M8/M9/M10 were closed as
`NO AUTHORITATIVE APPROVED SCOPE FOUND`) — Part Z, final integrated certification
**Date:** 2026-09-15
**Branch:** `mission/m11-final-certification-2026-09-15`, branched from `d1a95493f37d05cff83327966cfe172b02ba6552` (the M8–M10 tip)
**Carried forward:** all 13 prior mission documents, inherited by branching rather than copied, and
**SHA-256-verified byte-identical** against the Phase 9 worktree (§15.4). With this document,
`docs/investment-intelligence/` carries **14** mission documents.

**Authority exercised this phase:** repository and git inspection; test execution; read-only
PostgREST `GET` probes against DEV **and** PRODUCTION with paired negative controls; live-DEV
matrices that create synthetic data and independently re-verify its removal; one real OpenAI
call under an ephemeral in-memory key.
**Authority NOT exercised, per the binding override, and not exercised regardless of the verdict
reached:** no push to `main`, no merge, no deployment, no production database write, no
production configuration change, no production rollout activation, no migration applied
anywhere by this phase. Nothing is pushed. Everything is committed locally.

**No credential value, API key, PAN, folio number, holder name, scheme name belonging to a real
person, or raw statement text appears anywhere in this document.** Instrument and row ids are
truncated to an 8-character prefix.

---

## 1. Overall verdict

> # FHIP INVESTMENT INTELLIGENCE + AIE-1 POST-PC4 PROGRAMME — CONDITIONAL PASS.
>
> **This is not production-ready, and the reasons are named precisely rather than softened. It is
> also a substantially larger and better-evidenced body of work than the word "conditional"
> suggests, and that is stated just as plainly.**
>
> **What this mission genuinely built and genuinely proved.** Across ten executed phases it
> delivered the missing Investment Intelligence HTTP dispatch path, a governed PC5 resolution
> workflow that did not exist in any form, statement-owner matching that PC4's own regression
> contract recorded as *"there is no test, because there is no code"*, HUF as an India-gated
> business entity, a complete PC6 reference-market-data foundation proven against real AMFI files,
> and a complete PC7 look-through foundation whose defining net-worth-safety boundary is proved
> three independent ways including 19/19 live on the hosted DEV database with both a negative and
> a positive control. It found and fixed **eight real defects**, every one of them found by
> running the system rather than by reading it — including two that were live in shipped code and
> would have caused silent, material harm: an `amplify.yml` gap that meant **no `AIE_*` variable
> could ever reach the production runtime**, so the AIE kill switch and pilot-cohort allowlist
> were inoperable in production and a reasonable partial remediation would have turned an
> allowlisted pilot into a rollout to every user; and a NAV-precision truncation that would have
> silently rounded **3.1% of the real AMFI universe** (443 of 14,361 schemes measured). Two more
> were privacy defects caught by the system's own live proofs: a holder name being sent verbatim
> to OpenAI, and a folio number left in the clear on every transaction row of a "full extract"
> whose summary had just masked it.
>
> **What keeps it CONDITIONAL — eight named blockers, not one of them closable by more
> engineering in this environment:**
>
> 1. **There is no malware scanning anywhere in this system, and by construction there cannot be
>    one in the configuration a production activation would have to use.** The GuardDuty decision
>    gate is good code with zero production callers; there is no `aws-sdk` dependency, no S3 code
>    path, and no reachable bucket — 16 candidate names probed across phases, all provably
>    nonexistent against a controlled 403/404 discrimination on a globally unique namespace,
>    including both names the project's own runbook and IAM policy disagree about. The substitute
>    Supabase-Storage admission gate is genuine structural defence, but it must be run with
>    `AIE_ALLOW_MISSING_SIGNATURE_SCANNER` **on** for the product to admit any document at all.
> 2. **`AIE_MASK_TOKEN_ENCRYPTION_KEY` is unset** — re-confirmed fresh today, absent from a
>    9-key `.env.local` and from the process environment. It is now the *single* remaining blocker
>    on the AI path for the FDH-bank and Insurance adapters, whose AI fallback **this mission never
>    exercised and never built**, so supplying it is not a routine operator task.
> 3. **Migration `0157` (PC7) is unapplied everywhere**, and `0153`, `0154`, `0155` — applied to
>    DEV mid-phase by an operator, which this phase observed live and re-verified — remain
>    **unapplied on production**.
> 4. **AIE-1 requirement traceability is 16.3%** — re-measured fresh today across the Product
>    Owner's own 2,214 numbered requirements: 361 traced, **1,853 orphans**, and **zero AIE
>    requirement identifiers cited in any live-DEV suite at all**.
> 5. **Three Product-Owner licensing/methodology decisions are open and are commercial, not
>    technical**: NIFTY/SENSEX index licensing, the risk-free source and tenor (three defensible
>    candidates differing by 100–150 bp, which moves every Sharpe and Sortino), and AMC portfolio
>    disclosure licensing. Consequently PC6 has ingested **zero** benchmark points and **zero**
>    certified risk-free rates, and PC7 has ingested **zero** real fund disclosures.
> 6. **PC4's own certification objective was never met and still is not.** Re-verified live on
>    production today: **0 of 17** real positions certified, three blockers on all 17 including the
>    12 that reconcile to variance exactly `0.000`, and all five named reconciliation residuals
>    reproducing to the last decimal place.
> 7. **The FDH-bank and Insurance AIE adapters were never built, modified or certified by any
>    phase of this mission** — proved byte-identical by `git diff` to the pre-existing closure
>    branch — yet Part L.6 asked this programme to certify them. No accuracy corpus exists for
>    either.
> 8. **PC8, PC9 and PC10 have no approved scope at all**, demonstrated by eight independent
>    searches across 1,099 commits and 459 refs, so a third of the mission's own numbering
>    sequence describes phases that were never defined.
>
> **`UNCONDITIONAL FULL PASS` is therefore not available and this report does not award it.** The
> programme's own standing rule — *documentation and schema-level proof alone never earn a FULL
> PASS* — forbids it, and so does the mission's own clause that *a pure decision function with no
> production caller is not FULL PASS*.
>
> **`FAIL` would be equally dishonest.** Nothing verified across ten phases contradicts the
> correctness of what was built at the level it was built to. The PC4 19-invariant regression
> contract re-runs **84 passed / 1 skipped, 1,673 tests passed, 0 failed — byte-identical to the
> baseline M1 recorded**, on every phase that has re-run it. The pre-existing repository failure
> set is **17 files / 39 tests**, measured fresh and independently in a clean worktree install
> today and matching M7's corrected figure file-for-file and assertion-for-assertion. **This
> mission introduced zero new test failures and zero production writes.**

---

## 2. Current `origin/main` (SHA)

**`origin/main` = `23b49da1d63c9c20f980ea9042e176845b6f60e3`**
*"Merge remote-tracking branch 'origin/fix/app-review-live-defects-2026-09-14' into HEAD"*, 2026-09-15 00:07:20 +1000.

**Re-fetched at the end of this phase and confirmed unchanged from the value M0 recorded at the
start of the mission.** This is not a carried-forward number: `git fetch origin main` was run
today and returned the same SHA.

**This mission has never pushed anything.** `origin/main` is therefore unchanged *because of*
this mission, not merely coincidentally. The accumulated mission branch stands at **110 commits
ahead**, **325 files changed, 65,672 insertions, 32 deletions** relative to `origin/main` — all
of it local and unpushed.

One consequence worth stating: `origin/main` contains **zero** AIE source files under `lib/` or
`app/`, and `docs/aie-programme/` does not exist on it. Everything in this report that concerns
AIE describes code that reaches `main` only if a human-present follow-up merges it.

---

## 3. Production deployed revision

**Unchanged. Nothing this mission built has deployed, and nothing could have.**

| Check | Result |
|---|---|
| Production deploy source | Amplify auto-deploys `main`. `main` is unchanged (§2). |
| AIE source files on `origin/main` | **0** |
| PC5 / PC6 / PC7 source files on `origin/main` | **0** |
| Production database writes by this mission | **0**, across all ten phases |
| Production migrations applied by this mission | **0** |
| Production configuration changed | **none** |
| Production rollout activated | **none** |

Production enablement of AIE remains OFF at **four independent layers**: not merged to `main`;
not deployed; every one of the 27 `AIE_*` flags defaults OFF; and — until this mission's own
`amplify.yml` fix, which is itself committed only to this local branch — no `AIE_*` variable
could reach the production Next.js runtime at all even if set in the Amplify console.

**One observed change in production state, attributable to real user activity and explicitly not
to this mission.** Read-only probes today found `ii_document_parse_runs` at **35** where M1
recorded 34, and `ii_reconciliation_cases` at **127** where M1 recorded 126. The new run is
`70ab10ec`, started 2026-09-15T04:32:22Z, `run_status = failed`, parser `r2-orchestrator@pending`,
0 accounts / 0 schemes / 0 transactions; it opened the first-ever `unsupported_document`
reconciliation case on production (`9432b06d`). That is the **old, deployed Investment
Intelligence path** correctly refusing a document no certified parser claims, rather than
guessing at it — PC4-INV and I.3 behaviour working in production. It created **no economic
data**: `ii_transactions` remains at 952 with a newest `created_at` of **2026-09-07T12:29:44Z**,
and `ii_portfolio_truth_status` remains 17 rows with a newest `last_evaluated_at` of
**2026-09-07T13:07:02Z**. This mission performed no production write of any kind, and every AIE
table on production holds **zero** rows (§21).

---

## 4. Scope recovery

**The single most important structural finding of this mission, established at M0 and never
contradicted since: the authoritative approved scope for this programme has never been committed
to this repository.** It lives in Product-Owner files on the operator's own filesystem. The
repository contains implementation and certification reports written *against* those specs, plus
one-line roadmap labels. For PC4 through PC7 even the Product-Owner files do not contain a
requirement set — only this mission's own dispatch does.

| Phase | Original scope found | Additions | Final status |
|---|---|---|---|
| **PC4** — Controlled Production End-to-End Certification | **CONDITIONALLY FOUND.** A ≥48-section PO specification is referenced by section number across commits and reports (13/14/15/16/17/19/20/47/48) but exists **nowhere in git and was not found on the PO filesystem** (**OA-1**). Implementation is real, merged and deployed. | None. PC4's own §9 pushes three gaps *forward* as additive PC5/PC6/PC7 scope. | **CONDITIONAL PASS — terminal verdict still not issuable.** Implementation merged, deployed, stable, unchanged in code or data since 2026-09-07. Certification never issued and **cannot honestly be**, because the sections the closure gate names cannot be read. **0 of 17** production positions certified; 5 residuals reproduce exactly. |
| **PC5** — owner / reconciliation resolution workflow | **NOT FOUND.** One table cell (`II_PC4_STATUS_2026_09_07.md:138`), architectural constraint P7, one feature flag with zero consumers, and the **binding** AIE-1.0 boundary contracts (`AIE10-CTX-05`, `AIE10-EXC-08/09/10`). | **FOUND — this mission's Part K, K.1–K.22**, plus `AIE15-PC5-01..12`. Part K **is** PC5's scope; no fictitious prior set was invented. | **PASS on implementation and live proof; CONDITIONAL on production.** 14 modules / ~3,200 lines, 5 routes, 2 pages, migration `0153`. Live-DEV matrix now **54 PASS / 0 FAIL / 0 BLOCKED (FULL mode)** — see §7. 5 real defects found and fixed. `0153` still unapplied on **production**. |
| **PC6** — NAV / benchmark / risk-free reference data | **NOT FOUND.** Two label-level references and the binding AIE-1.0 *exclusion* contract (`AIE10-PC6-01..05`), which says what PC6 must not absorb rather than what it must build. | **FOUND — Part N, N.1–N.16.** | **CONDITIONAL PASS.** Buildable scope complete and proven against real AMFI data (14,361 records parsed, 17 genuine rejections, sha256-fingerprinted). Blocked by `PO-PC6-1` (index licensing) and `PO-PC6-2` (risk-free methodology); **0 benchmark points, 0 certified risk-free rates** ingested. `0155` applied to DEV mid-phase, still unapplied on production. |
| **PC7** — Underlying Fund Holdings look-through | **NOT FOUND.** One table cell (`:137`) plus one binding net-worth invariant. | **FOUND — Part O, O.1–O.10.** | **CONDITIONAL PASS.** Ingestion, analytics integration, data quality and safety machinery complete, reusing PC6's runner rather than growing a second stack. **O.7 proved three independent ways, 19/19 live on DEV.** One real defect found and fixed in previously-certified code. Blocked by `PO-PC7-1`/`PO-PC7-2` (disclosure licensing) — **0 real disclosures ingested** — and by `0157` being unapplied **everywhere**. |
| **PC8** | **NOT FOUND — zero occurrences anywhere.** 8 searches; 0 commits across 1,099 commits / 459 refs; 0 of 3,890 distinct paths ever created; 0 refs; 0 commit messages; 0 files on the PO filesystem. | None possible. | **NO AUTHORITATIVE APPROVED SCOPE FOUND — NOT EXECUTED.** |
| **PC9** | **NOT FOUND** — identical evidence. | None possible. | **NO AUTHORITATIVE APPROVED SCOPE FOUND — NOT EXECUTED.** |
| **PC10** | **NOT FOUND** — identical evidence. | None possible. | **NO AUTHORITATIVE APPROVED SCOPE FOUND — NOT EXECUTED.** |
| **AIE-1** (1.0 → 1.6) | **FOUND — outside version control.** 7 PO files, **2,214 numbered requirements** (250 `AIE10-*` plus ~1,964 across 1.1–1.6). | **FOUND** — the 54-section closure mission (2026-09-12) and this mission's Parts H, I, J, L, M. **Part J was never dispatched as its own phase**, which is why FDH-bank and Insurance had no owner. | **CONDITIONAL PASS — NOT production ready.** Reissued at M5 against current truth, superseding three stale consolidated reports. 4 named dependencies unresolved. |

> **The scope gap is the root cause, and it recurs.** Because no PC specification was ever
> committed, three separate phases had to state in their own certifications that the dispatch's
> Part K / N / O *is* the scope, rather than implying a fuller approved set was preserved. If a
> PC8 is ever defined, **committing its specification to `docs/` would prevent this entire class
> of problem from recurring.**

---

## 5. PC4 verification

PC4's implementation and PC4's certification are two different questions, and the honest answer
differs for each. Everything below was **re-probed live against production today**, not inherited.

### 5.1 Implementation — PASS

| Check | Result |
|---|---|
| All 11 PC4 fix commits are ancestors of `origin/main` | **PASS** (M1, `git merge-base --is-ancestor`) |
| The fixes are still present in the tree, not later reverted | **PASS — re-verified this phase by direct inspection.** `ALT_TXN_ROW_WRAPPED_START_RE` present in `camsParser.ts` (3 occurrences); `reclassifyNegativeSignedInflowRows` defined at `:514` and invoked at `:1146`; `{ code:'lateral_shift', test:/lateral shift/i, type:'transfer' }` at `transactionTypeMapping.ts:82`, still ordered **before** the `dividend` rule |
| Deployed and exercised against real data | **PASS** — 35 production parse runs, 10 succeeded |
| PC4 economic data unchanged since 2026-09-07 | **PASS — re-verified today.** Newest `ii_transactions.created_at` = `2026-09-07T12:29:44Z`; newest `last_evaluated_at` = `2026-09-07T13:07:02Z` |
| PC4 migration state | **NOT APPLICABLE** — PC4 created no migration |
| 19-invariant regression contract | **PASS — re-run fresh this phase: 85 files, 84 passed / 1 skipped, 1,673 passed / 5 skipped, 0 failed.** Byte-identical to M1's recorded baseline |

### 5.2 Certification — FAIL, and for three reasons, all re-confirmed today

**(a) The verdict instrument does not exist.** The closure gate's step 8 demands a *"Section
47/48 terminal verdict"*. Those sections belong to a specification not in this repository and not
on the Product Owner's filesystem. Writing a verdict labelled against criteria nobody can read
would be fabrication. **Unchanged, and not closable by anyone but the Product Owner (OA-1).**

**(b) The five residuals reproduce exactly — 5 of 5, to the last decimal place.** Fresh read-only
production probe today, with a passing negative control (`42703` on a nonexistent column, so the
method cannot return false positives):

| Instrument (8-char prefix) | Variance today | M1's recorded value | Match |
|---|---|---|---|
| `45773ec3` (Axis Large Cap) | **−156.618** | −156.618 | **EXACT** |
| `9a923d57` (Kotak Mid Cap) | **+111.505** | +111.505 | **EXACT** |
| `948fb23a` | **−12.932** | −12.932 | **EXACT** |
| `385feb70` | **−4.457** | −4.457 | **EXACT** |
| `76c30cb9` | **−2.678** | −2.678 | **EXACT** |

**No drift, no regression, no new arithmetic defect.** `unit_variance_within_tolerance` reads
**12 `true`, 5 `false`, 0 `null`** — PC4-INV-15's fail-closed rule still holds, and `null` has
never leaked as `true`. `history_completeness` is `complete_from_inception` on all 17.

**(c) The certification objective was never met, and the gap is larger than the five residuals.**
Fresh probe today: **`status = reconciliation_required` on all 17; `certified_at` null on all 17;
zero `certified`, zero `certified_with_warnings`; `warning_reasons` empty on all 17.** Blocking
reasons aggregate to `parser_fatal_error` ×17, `unresolved_owner` ×17,
`open_blocking_reconciliation_case` ×17, `unit_variance_exceeds_tolerance` ×5,
`material_unclassified_transaction` ×1. Open reconciliation cases now total **127**, all `open`,
none resolved — `owner_unmatched` ×120, `transaction_unclassified` ×4,
`document_password_required` ×2, `unsupported_document` ×1 (new today, §3).

**Even if all five residuals were closed tomorrow, all 17 positions would remain blocked.**

### 5.3 The three universal blockers, and who can clear each

| Blocker | On | Who clears it |
|---|---|---|
| `unresolved_owner` | 17/17 | **Product Owner, in the app** — map the CAMS statement to a household member. Not an engineering task. Also clears most of the 120 `owner_unmatched` cases. **`OA-8`.** |
| `open_blocking_reconciliation_case` | 17/17 | Mostly clears with the above; the 4 `transaction_unclassified` and 1 `unsupported_document` do not. |
| `parser_fatal_error` | 17/17 | **Engineering, but needs a PO severity decision first (`OA-9`).** 251 rows that PC4's own Section 3 accounting classified as benign — 77 boilerplate, 84 non-economic lifecycle markers, 90 regulatory footnotes — are emitted by the parser at severity `error`. The system and the report disagree about the same 251 rows. **The `certification.ts:65` wiring is correct and must be preserved (PC4-INV-19); the fix belongs at the parser's severity assignment.** |

### 5.4 One defect candidate with a reproduction, deliberately not fixed

**M3-F1 — a CAS opening balance is discarded.** On the CAS layout, `camsParser.ts:196`'s
`OPENING_BALANCE_RE` matches `Opening Unit Balance : NNN` and is used at `:842` **only** to set
the in-table flag; the value is silently consumed. The Folio Details parser does the opposite,
correctly. **The two certified parsers disagree about the same concept.** The arithmetic
consequence is unavoidable: the position reconciles from zero, so the unit variance equals the
discarded opening balance **exactly** — which is a concrete, testable hypothesis for a class of
residual that M1 recorded as having **no hypothesis at all**. A second, independent mechanism
compounds it: the pattern requires a colon, so a column-aligned `Opening Unit Balance   200.000`
does not match even if the discard were fixed. Both mechanisms are pinned as corpus fixture
**C4b** with executable assertions.

**This is recorded as a defect candidate with a reproduction and a named hypothesis, not as a
diagnosis.** It has never been verified against the Product Owner's real statement, because
doing so means reading and reporting their real personal financial transactions. Two facts argue
for caution: `history_completeness` is `complete_from_inception` on all 17, which is what you
would expect when no opening-balance marker exists — consistent with the defect, but equally
consistent with statements that genuinely print none; and 12 of 17 reconcile to `0.000`, so if
those statements print opening balances the defect would have to be absent there too.

---

## 6. AIE-1

**AIE-1 terminal verdict: CONDITIONAL PASS — NOT production ready.** Issued at M5, superseding
`AIE_1_CONSOLIDATED_REPORT.md`, `AIE_1_FINAL_CLOSURE_CERTIFICATION.md` and
`AIE_1_FULL_CONSOLIDATED_REPORT_2026_09_14.md`, which M0 found stale by three commits and two
environment changes. Nothing in this phase changes that verdict; several sub-items are
re-verified fresh below.

### 6.1 Shared gateway — **CONDITIONAL PASS**

Mapped in full: three state machines, not one (`aie_document_intake.status` 6 values,
`aie_extraction_run.status` 18, `aie_document_intake.purge_status` 5), plus two cross-field DB
invariants. **Four real defects found and fixed** (M2, `738f1c5`):

- **The intake state machine was declared, unit-tested, documented as enforced, and had zero
  production callers.** `updateIntakeStatus` took no `from` status, asserted nothing and did no
  compare-and-swap; only the DB CHECK applied, and a CHECK constrains the **vocabulary**, never
  the **transitions**. Live consequence: `ready -> rejected` is not in `AIE_INTAKE_TRANSITIONS`
  yet two production routes performed it on every extraction failure, silently. Now enforced
  under a CAS with typed failures.
- **A purge sweep writing false audit events in an unbounded loop.** `runPurgeAttempt` checked
  none of its three update results; the database refused the update, the error was discarded, and
  the code wrote a `document_purged` audit event and returned `{status:'purged'}` for a row it had
  not updated — then re-selected the same row forever, appending another false event each sweep.
- Declared FSM disagreed with the purge job (`received -> deleted`, `quarantined -> deleted` added).
- An unknown state threw a raw `TypeError`; now fails closed with a typed result.

**Disclosed, not fixed:** `M2-OPEN-1` (accept/reject CAS edges are absent from the
`aie_processing_transition` audit table), `M2-OPEN-2` (`purge_status` has no transition table or
validator), `M2-OPEN-3` (`computeUserFacingStateForIntakeWithoutRun` omits `'ready'` and throws).
Not FULL, because two required states — **malware pending** and **malware rejected** — do not
exist at all, which is inseparable from the next section.

### 6.2 AWS / GuardDuty — **FAIL (blocked), and the blocker is bigger than permissions**

Re-probed at M2, M3 and M5; all three agree.

| Probe | Result |
|---|---|
| `sts:GetCallerIdentity` | **OK** — it requires no policy at all |
| `s3:ListAllMyBuckets` | `AccessDenied` |
| `guardduty:ListDetectors` (ap-southeast-2 and us-east-1) | `AccessDeniedException` |
| `iam:ListAttachedUserPolicies` / `ListUserPolicies` / `ListRoles` | `AccessDenied` |
| `sqs:ListQueues`, `events:ListRules`, `cloudtrail:LookupEvents`, `amplify:ListApps` | `AccessDenied` |
| **16 candidate bucket names** probed directly with `s3api head-bucket` | **all 404 Not Found** |
| Control: `nyc-tlc`, `aws-roda-hcls-datalake`, `noaa-goes16` (exist, not ours) | **403 Forbidden** |
| Control: `zz-no-such-bucket-…` (cannot exist) | **404 Not Found** |

**Existing-but-unauthorised returns 403; nonexistent returns 404. S3 bucket names are globally
unique. The 16 names therefore genuinely do not exist anywhere in S3** — including the runbook's
own authoritative `aie-document-quarantine-dev` and the IAM policy's own
`fhip-aie-quarantine-dev`, **which still disagree with each other** (`OA-2b`).

**Even with perfect credentials the application could not use an S3 bucket today.**
`package.json` declares **no `aws-sdk`/`@aws-sdk` dependency at all**; `lib/aie/storage.ts` uses
**Supabase Storage**; no AWS environment variable is referenced by any AIE source file;
`decideScanResult` has **zero production callers** repository-wide.

**One correction the mission made to itself, and it matters.** M0 recorded
`guardduty:ListDetectors` returning `SubscriptionRequiredException` and concluded GuardDuty had
never been enabled. M2 found the same call now returns `AccessDeniedException` — a materially
different error. That change is equally consistent with GuardDuty having since been enabled and
with AWS simply hardening the service to evaluate authorization before service-state
preconditions. **An `AccessDeniedException` says nothing whatsoever about subscription state**;
M0's claim should have been recorded as *indeterminate, blocked by permissions*. That correction
stands regardless of which reading is true. **This does not mean the Product Owner is mistaken
about their infrastructure** — it may exist in a different AWS account, or under a name not among
the 16. It does mean whatever exists is not reachable from this environment, not wired to this
application, and not usable until the Product Owner supplies the specifics (`PO-BLOCKER-1`).

**What the codebase actually has is a genuine admission gate, and this report does not call it a
scanner.** `lib/aie/validation/fileValidation.ts` (18 tests) does magic-byte/MIME validation, size
bounding, embedded `/JavaScript` and `/Launch` detection **including inside deflate-compressed
streams**, polyglot detection via trailing content after `%%EOF`, a decompression-bomb budget and
`/Encrypt` detection. `scanForMalwareSignatures()` is an explicit disclosed stub whose policy is
that *"no scanner is configured" IS a scanner failure* — so it fails closed **unless** the caller
opts in via `AIE_ALLOW_MISSING_SIGNATURE_SCANNER`.

> **The consequence, stated once and plainly.** With that flag unset — the default, and the only
> fail-safe posture — **every document is rejected at admission and AIE intake does nothing at
> all.** Therefore *any* production activation of AIE document intake **necessarily requires
> explicitly opting into the "no signature scanner is configured" posture.** There is no
> configuration of this system, today, in which a real malware scan runs on an uploaded document.
> That is not a gap more testing can close; it is the current architecture.

### 6.3 OpenAI GPT-4o mini — **PASS**

**Server-only: PASS.** No `'use client'` and no `NEXT_PUBLIC_` anywhere in `lib/aie`,
`app/api/aie` or `components/aie`; the key is read in exactly two server modules; the three client
review components import only a type-only ARIA-label module. *Noted honestly as an emergent
property of the import graph rather than an enforced invariant* — there is no
`import 'server-only'` anywhere in `lib/aie` (`M2-OPEN-4`).

**Model centralisation: PASS.** Every `gpt-4o*` literal in non-test, non-doc code lives in
`lib/aie/config.ts`; zero occurrences in business logic.

**One real misconfiguration, proven against the live provider and fixed.** M0 flagged
`AIE_AI_MODEL` as a risk; M2 tested it rather than trusting the note — two real calls with
identical masked payloads:

| Model sent | Result |
|---|---|
| `gpt-4o-mini-2024-07-18` (the code's pinned default) | **HTTP 403**, `model_not_found` — the project has no access to that snapshot |
| `gpt-4o-mini` | **HTTP 200**, strict `json_schema` honoured |

So the pin was not suboptimal, it was **uncallable by the only OpenAI project this application is
configured to use** — every real AI fallback would have 403'd the moment
`AIE_AI_PROVIDER=openai` was set. Fixed in **code**, which closes `OA-5` without needing an
operator to set anything per-environment. Reproducibility is not lost: the 200 response's own
`model` field echoed back `gpt-4o-mini-2024-07-18`, so the alias resolves server-side to exactly
the snapshot that was pinned before. **Re-verified fresh this phase: the real-provider proof runs
4/4 PASS with a genuine OpenAI HTTP 200 and strict structured output**, under an ephemeral
in-memory masking key (§6.4).

Controls: retries **hard-capped at 2** via `Math.min(raw, 2)` and not operator-raisable; 20 s
timeout; 4,000 max input tokens; 512 max output; $10 pilot allowance separate from Module 11's
budget.

### 6.4 Masking / privacy — **CONDITIONAL PASS, with one Product-Owner decision implemented in full**

**Masking demonstrably precedes egress, with no bypass.** Two independent gates: the orchestrator
masks and passes only `masking.maskedText`; the gateway then **independently re-scans** and
returns `unmasked_pii_detected` *before* any reservation or provider call.
`requestFieldCompletion` has exactly one production caller, and all four intake routes construct
the provider only to inject it into the gateway — **no route holds a direct provider reference.**

**Four of nine D.6 categories had no rule at all** — person/holder name, nominee, Aadhaar (spaced
form), and folio/account identifier — plus India IFSC, which was not incidentally covered. All
fixed at M2; address closed at M3. This mattered most for the single most likely real document
class for this feature: an India CAS or folio statement, which could previously send holder name,
Aadhaar, folio and IFSC to the provider in clear text.

**The name leak was not found by inspection.** M2's own live provider proof **failed its
pre-egress sentinel assertion on its first run**, with a holder name present in the payload. The
nominal defence was dead code — `FORBIDDEN_LABEL_TERMS` is read only by `isBelowMaskingPolicy`,
whose sole caller passes `labelsSeenRaw: []`, so it can never fire. Three further defects came out
of building the fix, each caught by test: a folio charset that ran across whitespace and swallowed
the next field's label; a masking audit row that recorded `belowPolicy: false` **before** the
verdict was computed, so *every masking summary ever written claimed to be within policy*; and a
refusal test that passed without exercising the refusal path at all, because `MockAieProvider`
hardcodes `finishReason: 'stop'` and **cannot express a refusal**.

**The tokenisation decision, and what makes it real.** M2 disclosed that the implementation was
the opposite of what global invariant D.6 requires — opaque counter tokens plus an AES-256-GCM
escrow map that made originals recoverable — and escalated it rather than patching it
(`PO-BLOCKER-2`). **The Product Owner chose D.6**, accepting that a user will never see their own
original folio / account / PAN / holder-name value again, including during their own review. M3
implemented it, and **removed rather than disabled** the alternative: `tokenMapCrypto.ts`
**deleted** (re-verified absent this phase); `persistMaskTokenMap` and `findMaskTokenCiphertext`
**deleted**; `MaskingResult.reversibleTokenMap` removed from the type; `revealMaskedToken` now
always refuses with `not_revealable_one_way_masking` and audits the refusal; the Reveal control
**removed**, not shown-and-disabled, because an affordance that can only ever fail invites a user
to believe recovery is possible; the route answers **410 Gone**, not 404 or 403, because the
capability was removed and will not return.

The replacement (`lib/aie/masking/identifierToken.ts`, re-verified present this phase using
`createHmac` under an HKDF-style derived subkey) is **genuinely keyed** (a folio, a 10-character
PAN and a BSB+account are all small enough spaces to enumerate exhaustively, so an unkeyed digest
would be trivially reversible while still *looking* one-way), **tenant-bound** (so a provider
observing many documents cannot correlate users by identifier), **stable** per `(tenant, type,
value)` — which is a genuine improvement, not only a cost, since it is exactly the folio stable
token I.4 asks for and the old counter scheme could not express — **injective** by length-prefixing
rather than separator-delimiting, **structurally safe** (rendered in `a`–`p` so a hex MAC cannot be
re-matched and double-tokenised by the digit-run rules), and **fails closed**, throwing on a
missing key rather than degrading to an unkeyed hash.

**Answer to the Product Owner's own question (c): ZERO D.6 categories require a reversible map.**
The only category anyone would expect to need reversal — folio, because account identity depends
on it — does not, because the canonical write **re-fetches the original document bytes from
quarantine and re-parses them unmasked**. Masking exists solely on the AI-egress path. That
architectural fact is what makes the decision cost-free on the write path and confined entirely
to review UX.

**Still open:** `M2-OPEN-7` closed at M3, but `M3-OPEN-2` — the address rule masks only the
**first line** of a multi-line address, because there is no reliable end-of-address signal and
extending across newlines reproduces the over-capture failure the folio rule already hit once.
`PO-BLOCKER-3` — what `labelsSeenRaw` should mean — remains **deliberately inert rather than
guessed**: one reading would hard-block AI fallback on essentially every real financial document,
silently disabling the feature; the other needs label→value association the extractor does not
produce.

### 6.5 Cost — **PASS**

Two independent proofs. **Offline against real Postgres:** `aie_reserve_ai_cost` /
`aie_settle_ai_cost` exercised against a PGlite engine seeded from this repository's own full
migration chain — not a mock, not a JS re-implementation — 5/5. **Live DEV concurrency:** 12
genuinely parallel reservations of $0.25 against a $1 allowance admitted **exactly 4**, denied 8,
0 errors, `reserved_usd` exactly `1.000000`, idempotent replay did not re-reserve; **13 rows
created, 13 cleaned, residue CLEAN (0)**. A hard safety gate refused to proceed if the derived
project ref matched `PRODUCTION_SUPABASE_URL`.

Total real provider cost observed across the whole mission: **~$0.0003 USD**. The one instrumented
measurement is 261 prompt + 37 completion = 298 tokens = **$0.00006135** at the repo's own recorded
pricing. **Disclosed accounting gap (`M2-OPEN-5`):** one reservation covers up to 3 HTTP attempts
but settlement uses only the *final* attempt's usage, so tokens billed by an attempt that then
429/5xx'd are never settled. It **under-counts cost and never over-admits**.

Fresh production confirmation this phase: `aie_ai_cost_ledger` holds exactly **one** row on
production — `id='global'`, `allowance_usd=10`, `reserved_usd=0`, `settled_usd=0`,
`total_attempts=0`, `updated_at=2026-09-14T06:48:58Z`. That is migration `0150`'s own seed row,
created the day **before** this mission began, with zero usage. `aie_ai_cost_attempt` and
`aie_ai_completion_attempt` are both **empty** on production.

### 6.6 Encrypted PDFs — **CONDITIONAL PASS**

The extraction primitive was always correct — `extractPdfTextLocally(bytes, password?)` does
proper two-state disambiguation via the library's real `PasswordException` type, returning typed
`password_required` vs `wrong_password`, with `parser.destroy()` always in `finally`. **But at M2
nothing supplied a password**: no caller passed the second argument and no AIE route accepted one,
because AIE intake is a raw-body byte upload with the filename in the query string. M2 declined to
bolt a secret onto that request shape and said so, which is the mission's own "document why and
keep it disabled rather than claiming support" clause.

**M3 built the second endpoint M2 specified**, to the constraints M2 named and following the
repository's one existing rate-limited precedent (FDH-5): the password travels in the **JSON body
of a POST** — never a URL, query string or header, so it cannot land in an access log, a referrer
or an analytics event; it is read into one local, passed once to the decrypt attempt, and never
assigned anywhere that outlives the handler; it is **rate limited** by reusing FDH-5's certified
`checkPasswordAttemptRateLimit` **unchanged**, so the 8-per-document-per-hour bound stays defined
in exactly one place; the attempt is recorded **before** the decrypt is tried, so aborting a
request cannot buy a free guess; and the two failure cases stay distinguishable **by exception
type**, never by string-matching a message, preserving PC4-INV-17's discipline on a new surface.

> **`M2-OPEN-8` is only half closed, and the open half is a real exposure.** The *pre-existing*
> Investment Intelligence password endpoint
> (`app/api/investment-intelligence/source-documents/[id]/process/route.ts`) still has **no rate
> limiting at all**, and neither do the payslip, retirement, liability and investment services —
> only `bankPdfProcessingService.ts` calls the rate limiter. This is a genuine brute-force
> exposure on authenticated endpoints. It is **outside this mission's scope, disclosed, and not
> fixed.**

### 6.7 Investment Intelligence adapter — **PASS on the dispatch path**

**What was missing was not a piece — it was the thing that called the pieces together.** Every
component of AIE-1.2 existed and was unit-tested, but
`registerInvestmentIntelligenceAdapter()` had **zero production callers**, so `sniffDocument()`
could never match an investment document; `buildInvestmentReconciliationRule` had **zero
production callers**; and the generic intake route ran `noDomainAdapterReconciliationRule`, which
reports `not_applicable`, which `accept.ts` explicitly refuses as *"accepting a document nothing
ever actually checked"*. `source_module_hint=investment_intelligence` was metadata and nothing
else.

M3 built the real authenticated route and the orchestration service, plus the read-only canonical
context the reconciliation rule was always written to consume but which nothing had ever
assembled. **A dedicated route rather than a flag on the generic one**, because widening
`/api/aie/intake` to branch on `source_module_hint` would make a metadata field load-bearing for
routing — the same mistake in a new place. **Jurisdiction is not inferred from the document**: a
CAMS statement is Indian and "detect IN from the parser" would work for every fixture and still be
wrong, because an AU-resident user can legitimately hold an Indian folio; country comes from
`getUserHomeCountry` and **fails closed** with a `409` the user can act on.

**Two real defects found by running it rather than reading it:**

- **M3-F2 — brand-new positions were never reconciled. FIXED.** `rollForwardResults` skipped
  entirely whenever a position did not resolve to an *existing* canonical account and instrument.
  That conflates two different checks: roll-forward against **prior canonical state** does need a
  snapshot, but the **statement-internal** check needs nothing — a printed closing balance must
  equal the sum of the statement's own printed transactions, from zero, whether or not the
  platform has ever seen the folio. **Consequence: every position on a user's first upload was
  silently unreconciled**, `worstOutcome` read `pass`, the run reached `awaiting_acceptance`, and
  `accept.ts` — which re-checks recorded outcomes rather than re-deriving them — would have found
  nothing to object to. **A materially wrong first statement could be accepted on a
  reconciliation that never ran.** It survived review because every existing unit test seeded an
  existing account. Fixed using II's own `reconcilePosition`, grouped by the statement's own
  `(folio, scheme)` identity so two folios holding one scheme stay separate; **regression cover
  added in both directions**, so the coverage hole is closed, not just the defect. Re-verified
  present this phase at `reconciliationRule.ts:248`.
- **M3-F3 — reported state diverged from stored state. FIXED.** A document could pass arithmetic
  reconciliation, reach `awaiting_acceptance`, then acquire a blocking identity item — at which
  point the dispatch **reported** `unresolved` while the run row still **read**
  `awaiting_acceptance`. Safe in practice, but a stored state contradicting the reported one is a
  trap for the next reader. Fixed with one new FSM edge (`awaiting_acceptance -> reconciling`),
  re-verified present this phase in the transition table, so the FSM keeps saying that every
  arrival at `unresolved` came through reconciliation.

**PC4 semantics are preserved by construction, not by re-implementation** — and this is the
strongest structural answer available. `write.ts` re-downloads the **original document bytes**
and hands them to II's own certified `processSourceDocument`. **The AIE field candidates are not
the input to the canonical write; the document is.** There is no second parser, no second
classifier and no second reconciliation on the write path that could drift. A structural test
pins it, so a future refactor that started writing from candidates fails loudly.

**The AI half is built, unit-proved, and NOT exercised — and for Investment Intelligence
specifically it is *unreachable*, not merely blocked.** The I.4 whole-document facts schema (22
tests) and the I.7 disagreement engine (19 tests) are real. The schema's anti-invention rules are
enforced **by shape rather than by policy text**: no canonical-id field exists anywhere, so "AI
must never invent a canonical instrument" is a sentence the contract *cannot express*; no
confidence field exists, so a score has no channel by which to move a reconciliation outcome;
ISIN and opening-balance each require paired evidence via cross-field refinements; money and units
are exact decimal strings, never IEEE-754 doubles; and the transaction-type enum is deliberately
**narrower** than the canonical union, excluding the types that feed R6's tax-lot engine, because
a model that guessed one would not merely mislabel — it would seed a tax lot with an invented cost
base. The disagreement engine is a three-way classification, not a precedence table, and three
tests make "neither source wins" real rather than decorative: the same tie-breaker picks the **AI**
value when the AI is the one that closes the printed running balance; when neither closes, the
disagreement **stands** rather than the nearer one winning; and the tie-breaker is **not applied**
to amounts or NAVs where the identity does not hold.

Neither can run today, for two independent reasons: **`AIE_MASK_TOKEN_ENCRYPTION_KEY` is unset**
(operator-owned), **and** `parserAdapter.ts:194` returns `aiEligibleGaps: []` unconditionally
because no registered II parser has a concept of "this one field is missing, ask AI"
(`M3-OPEN-1`). Manufacturing a gap to exercise the path would mean inventing an AI-eligible field
corresponding to no real extraction gap.

### 6.8 FDH-bank adapter — **NOT BUILT, NOT MODIFIED, NOT CERTIFIED BY THIS MISSION**

This is Part L.6's question, and M5 answered it definitively with `git`:

```
git diff --stat 74b7a5e HEAD -- lib/aie/adapters/fdhBankStatement lib/aie/adapters/insurance \
                                app/api/aie/fdh-bank app/api/aie/insurance
  (no output — zero changed files, zero changed lines)
```

**Byte-identical to the pre-existing `feature/aie-1-final-closure` branch merged in at Phase 3.**
Broadening to the whole AIE/PC5 surface: 39 files at the closure tip, 67 at HEAD — 28 files added,
and **every one** is Investment Intelligence dispatch or PC5.

**Parts I and J were split, and J was never dispatched as its own phase, so no phase ever owned
FDH-bank or Insurance.** Their verdicts stand exactly as the closure branch recorded them —
**AIE-1.3 CONDITIONAL** — carried forward unexamined. Coverage is adapter-unit level only
(`aieFdhBankStatementParser` 8 tests, `aieFdhBankStatementReconciliation` 11); **no accuracy corpus
with sealed oracles exists**, so there is no measurable precision, recall, false-accept rate or
cost profile (`M5-OPEN-2`).

**One live inconsistency, escalated and deliberately not fixed (`M2-OPEN-6`).**
`app/api/aie/fdh-bank/intake/route.ts:236-239` performs a **canonical write inline at intake time,
bypassing `accept.ts` entirely** — no acceptance flag, no re-read of blocking count, no CAS, no
explicit user acceptance. The **Insurance route explicitly removed exactly this pattern**, citing
AIE-1.5's own non-negotiable prohibition against auto-writing the moment extraction reaches
`awaiting_acceptance`. The FDH route never received that fix. It is mitigated (the AI candidate on
that adapter is display-only and cannot flip a `fail` to a `pass`, and the adapter is behind its
own flag) but it contradicts a rule the codebase itself calls non-negotiable. **No phase of this
mission has touched that route.**

### 6.9 Insurance and other adapters — **NOT BUILT, NOT MODIFIED, NOT CERTIFIED BY THIS MISSION**

Same `git diff` evidence, same conclusion. AIE-1.4's verdict remains **FULL for Insurance only**.
**8 of the 9 candidate document classes were ruled DEFER and 1 PROHIBITED** (identity / medical /
legal / sensitive) by binding exclusion. **No ingestion path exists for any of them and none was
built**, which is what L.10 requires of deferred and prohibited classes. No accuracy corpus exists
for Insurance either.

> **The sharpest single argument in this report for not treating the masking key as routine.**
> M5 corrected a belief this mission had been carrying forward: "no parser declares an AI-eligible
> gap" is true **for Investment Intelligence only**. `adapters/fdhBankStatement/parser.ts:126`
> returns `[INSTITUTION_HINT_FIELD_NAME]` on an ambiguous layout, and
> `adapters/insurance/parser.ts:217` returns `['policyNameClarification']` when the product name is
> missing — both with `outcome: 'partial'`, both satisfying the orchestrator's masking gate. So
> supplying `AIE_MASK_TOKEN_ENCRYPTION_KEY` does **not** light up II's AI fallback (it stays
> structurally unreachable) but it **does** light up FDH-bank's and Insurance's — on two adapters
> this mission never exercised and whose privacy proof therefore reads **NOT EXERCISED**.

### 6.10 Review / PC5 integration — **PASS**

The AIE↔PC5 seam honours `AIE10-EXC-08/09/10` structurally rather than by convention: **one
`aie_unresolved_item` table, one status vocabulary, one lifecycle**. PC5 projects AIE exceptions
**live** and renders them **alongside** `ii_review_items`, never **into** it, and the type system
enforces the boundary — `recordGovernedResolutionForPc5` types `newStatus` to the **literal**
`'in_review'`, so PC5 **cannot** write `resolved`. Proven live: PC5 activity created **zero**
`ii_review_items` rows, and PC5's projected blocking count equalled the acceptance gate's own
count **for all 16 runs, zero mismatches**. Detail in §7.

**One real AIE inconsistency PC5 had to close:** `listOpenUnresolvedItemsForRun` filters to
`['open','in_review']` while `countItemsBlockingAcceptanceForRun` counts
`['open','in_review','deferred']` — so a **deferred item blocks the accept button while being
invisible in the run-detail response**. PC5's listing includes `'deferred'` precisely so that
cannot happen on its surface. Proven live (S-13).

**One genuine architectural friction, disclosed (`FC-7d`):** two decision routes now write the same
table — AIE-1.5's generic `POST /api/aie/review/items/{itemId}/decide` (`correct`/`not_present`/
`defer`) and PC5's `POST /api/pc5/resolutions/{itemId}/decide` (the PC5 set including
`choose_value`). EXC-09's single-system invariant holds at the **table** level but **not** at the
route level. A future phase adding an action must consciously choose which route owns it.

### 6.11 Purge — **PASS**

All six clauses re-proved fresh at M5 against the real DEV project, and the II dispatch live proof
re-run **6/6 PASS again this phase**.

| Clause | Evidence |
|---|---|
| Immediate purge after an accepted canonical write | `accept.ts` deletes immediately after the write succeeds |
| Abandoned / failed backstop | `enforceAieRawFileHardBackstop` selects on **age alone, with no status filter** — asserted by test, because that is the whole point: an upload that crashed while still `received` or `quarantined` is exactly the case the backstop exists for, and M2 fixed a real defect where such rows were unpurgeable and accumulated forever |
| Idempotency | 10 tests |
| **Delete, then independently verify absent, THEN record** | Order asserted **by position in the source**, so a reordering fails the test. Proved on a **real DEV storage object**: object existed, service reported `deleted`, an **independent re-listing** confirmed it gone, and only then did the row read `status=deleted`, `purge_status=purged`, `storage_key=null`, `purged_at` set |
| No orphan mask-token maps | 48-hour TTL fires on **age alone**, joined to nothing. A test **enumerates every filter the query applied** and asserts the lifecycle columns are absent from that list, so a future change that "helpfully" skipped rows mid-review would fail rather than quietly substitute a different policy. Proved live: a 72h-old row on a **non-terminal** run deleted; **negative control** — a row inside the TTL survived the same sweep |

**The Investment Intelligence route deliberately does NOT delete the binary at intake**, unlike
the generic and Insurance routes, because II's canonical write re-fetches the original bytes at
**accept** time. Deleting at intake would break acceptance outright. That is "retained only as
long as required" applied honestly rather than by deleting early and breaking the journey.

`aie_mask_token_map` holds **0 rows on DEV and 0 on production**, re-verified fresh this phase.

### 6.12 Accessibility — **CONDITIONAL**

**Screen-reader pass: NOT APPLICABLE — tooling genuinely unavailable.** No screen reader
(NVDA/JAWS/VoiceOver) exists in this headless environment. **No phase of this mission has ever run
one, and none has claimed to.** M5 corrected a carried-forward belief here too: `@axe-core/playwright`
is **not** absent — it is declared and installed, and the pre-existing closure mission used it
against two AIE review states. axe-core is a rule engine, not a screen reader; the distinction is
carried through rather than collapsed in either direction.

**One real defect found and fixed (M5-F1).** Neither of PC5's two new client components had a live
region for its **load transition** — both rendered a bare `<p>Loading…</p>` and swapped it for
content, so a screen-reader user following a deep link to a resolution heard **nothing at all**.
Fixed by making the loading placeholder itself the live region in both, following
`RunReviewPanel.tsx`'s existing pattern rather than inventing a second one. **Re-verified present
this phase**: `role="status" aria-live="polite"` at `ResolutionCentreClient.tsx:101` and
`ResolutionDetailClient.tsx:212`.

**The "not recoverable" copy requirement is verified directly and passes.** No component anywhere
in the AIE or PC5 surface says "original value" or "hidden value", or offers a control that could
imply recovery: `EvidenceReveal.tsx:77` reads *"masked {label} — not recoverable"*;
`ResolutionDetailClient.tsx:236` reads *"Masking here is one-way, so the original cannot be shown
again — not by you and not by us."*

**`M5-OPEN-1` remains open:** a *meaningful* automated axe pass over PC5's resolution states needs
the full app stood up with authentication and a seeded unresolved item. With `0153` now applied to
DEV (§13), the schema half of that blocker has cleared and the affordances worth auditing — the
`choose_value` radio groups and the ownership-allocation inputs — would now render. **It was not
attempted this phase and is not claimed.**

### 6.13 Production rollout — **CONDITIONAL PASS after a fix that had to be made first**

`lib/aie/featureFlags.ts` implements a deliberately narrow, AIE-scoped cohort gate rather than a
generic platform-wide percentage system, which is what L.9 asks for. **27 `AIE_*` variables**, all
defaulting OFF; `isAiePilotCohortEnforced()` requires an explicit `'true'`; an
**enforced-but-empty allowlist admits nobody** (fail-closed); all four intake routes check adapter
flag → intake flag → cohort **server-side, before admission**.

> **M5-F2 — the rollout gate could not take effect in production at all. FOUND AND FIXED.**
>
> **`amplify.yml` forwarded no `AIE_*` variable into the Next.js server runtime.** A Next.js route
> handler has no access to console-configured environment variables unless the build writes them
> into `.env.production`, and the grep list carried `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`,
> `APP_BASE_URL`, `RESEND_API_KEY`, `CONTACT_FROM_EMAIL`, the `G4`/`G5B`/`G2` flags and
> `ROLLOUT_` — **not one `AIE_` variable.** This is the identical defect class the G8 closure
> found and fixed for G4/G5B on 2026-09-13, where a feature was "enabled" in the console and
> provably OFF at runtime across multiple redeploys. It was found here by **auditing L.9**, not by
> an incident.
>
> **Why a partial fix would have been worse than none.** The current state is fail-*safe*: every
> AIE flag defaults OFF, so AIE is simply unreachable in production whatever the console says. The
> danger is partial remediation. `isUserInAiePilotCohort()` returns **true for everyone** when
> `AIE_PILOT_COHORT_ENFORCED` is unset — deliberate, and correct when both variables travel
> together. **An operator who added only `AIE_DOCUMENT_INTAKE_ENABLED` to the forwarding list
> would switch intake on while cohort enforcement stayed silently OFF, turning an allowlisted
> pilot into a rollout to every user.** That is a fail-**open** combination reached by an entirely
> reasonable partial fix.
>
> Fixed by forwarding **the whole `AIE_` prefix**, which keeps the kill switch and its allowlist
> inseparable, with the reasoning recorded inline so a later phase does not "tidy" it back.
> Re-verified present this phase at `amplify.yml:74`. **No AIE flag is set in any environment
> today**, so this changes nothing about what is enabled — it makes the gate *operable* for the
> first time, which L.9 requires **before** any production activation. **Committed to this local
> branch only; not deployed.**

**`M5-OPEN-3` remains open:** rollout configuration changes are **not audited**. Every gate is an
Amplify console environment variable; nothing records who changed a flag, when, or from what to
what, and `lib/aie/audit.ts` has no event type for it. Not fixable in application code alone — it
needs CloudTrail access to the Amplify configuration API (this identity has `amplify:ListApps`
denied) or a move to a database-backed flag store. **Not fixed, because inventing a flag store
inside a certification phase would be the wrong call.**

---

## 7. PC5 — governed resolution workflow

**Verdict: PASS on implementation, live proof and security. CONDITIONAL on production only.**

**This is an upgrade on M4's own CONDITIONAL PASS, and the reason is a live event this phase
observed rather than an argument this phase makes.** M4's nine conditional verdicts shared **one**
blocker — migration `0153` could not be applied from this environment — which left **13 of 54**
live-DEV scenarios honestly reported `BLOCKED_ON_0153`. **During this phase an operator applied
`0153` to DEV.** The first migration probe this phase ran (with passing controls) reported it
**NOT APPLIED**; a probe run roughly an hour later, with the same controls passing, reported it
**APPLIED**. Production remains unchanged.

**Re-running M4's own unmodified matrix therefore produced, for the first time:**

```
=== PC5 K.22 live-DEV matrix — mode FULL ===
Scenarios: 54
  PASS             54
  FAIL             0
  BLOCKED_ON_0153  0
  NOT_APPLICABLE   0
```

**All 13 previously-blocked scenarios pass**, with zero residue independently re-verified across
12 tables plus auth users. What that converts from "designed" to "proved live" includes the two
that matter most:

- **S-37 — the cross-tenant allocation trigger, refused at the database.** A decision naming a
  **real, existing** household-member uuid belonging to **another user** is rejected by `0153`'s
  own trigger: *"ii_ownership_allocation.owner_member_id does not belong to user_id …"*. This is
  the forged-valid-FK case, and it could not be proved at all until `0153` existed.
- **S-33 / S-34 — joint allocation storage and amendment.** A default 50/50 split is stored; a
  70/30 amendment **supersedes the whole active group** (2 active, 2 superseded, new group id)
  rather than editing it. Ordering is **supersede-then-insert**, deliberately: a crash after the
  supersede leaves the position with no active allocation (readable, and the item is still open
  about it), whereas insert-first would leave two active groups totalling 200% — a state no reader
  could interpret.

Plus S-29/S-30 (duplicate resolution), S-32 (correction overlay), S-26/S-27 (re-reconciliation),
S-24 (concurrent idempotency), and S-23's audit-actor half.

**The design decisions worth recording, because each refuses an easier wrong answer:**

- **`choose_value` was added to the SHARED action vocabulary, not a PC5-private one** — a private
  vocabulary would be the first brick of the second exception system K.3 forbids. And it is
  genuinely a different action from `'correct'`: `correct` takes free-form input validated against
  a static per-field spec; `choose_value` takes an id validated against **a closed set resolved
  server-side, per user, per item, from canonical data**. Collapsing them would have meant either
  validating a household-member uuid as "a string" (letting a browser post any id) or hard-coding
  a user's household into a process-wide static registry (a cross-tenant leak waiting for a cache
  to outlive a request).
- **Owner matching has no edit distance, no similarity score and no threshold anywhere in the
  module**, and adding one later would be a defect rather than an improvement: the cost of a false
  positive is attributing a stranger's portfolio to a household member, silently, inside net
  worth. Initials are **never** a match (`A B SHARMA` vs `Anil Bhaskar Sharma` yields
  `initials_consistent` → AMBIGUOUS, and is behind a policy flag defaulting **OFF**). Token order
  is normalised **by sorting**, because Indian registrars genuinely print both ways — reordering,
  not guessing. The module never returns or persists a raw holder name.
- **Basis points out of 10,000, not percent**, because "the total must equal 100%" is a hard
  requirement and a three-way split cannot satisfy it in two decimals (33.33 × 3 = 99.99).
  Integers make 3333 + 3333 + 3334 exact. The allocation carries **basis points and nothing
  else** — no amount, no currency — so there is **no arithmetic path** by which the owner
  breakdown could add a second contribution to net worth. Structural impossibility, not a rule
  someone must remember.
- **Acknowledge and dismiss cannot masquerade as resolution, structurally.** Both produce
  `'in_review'`, which the acceptance gate counts as **still blocking**. A user can acknowledge
  every exception on a document and it still cannot be accepted. **Dismissal is refused outright
  for a blocking item**, in `permittedPc5Actions` **and again** server-side.
- **No bulk action ships at all**, and K.17's "if" is a permission, not a requirement. The
  exception set PC5 can produce is irreducibly heterogeneous, and `acknowledge` — the one uniform
  action — is precisely the "seen it all, move on" gesture that must never be mistaken for
  resolution. A bulk control whose only effect is to make a blocked document *look* attended-to is
  worse than no control.
- **Amendment by supersession, and no "undo".** No PC5 operation at any lifecycle point removes a
  record so the system afterwards looks as though something never happened. A post-acceptance
  undo would be a second write path into canonical tables — arguably the most dangerous one, since
  it deletes rather than inserts — and "undo the statement" is a cascade across instruments,
  accounts, transactions, snapshots, FIFO tax lots, publications, goal allocations and forecast
  inputs whose correct shape is a domain question this phase had no authority to answer.
- **Re-reconciliation works from the immutable `aie_field_candidate` evidence, not a re-parsed
  PDF** — for four independent reasons, of which the sharpest is that **the bytes are often
  legitimately gone**: AIE deletes the quarantine object as soon as it is no longer required, with
  a 24-hour hard backstop, so a user returning the next day would find re-reconciliation
  impossible. K.21 wants the PDF gone; K.19 wants resolution to re-reconcile; **only
  candidate-based reconciliation satisfies both.**

**Five real defects found and fixed**, all by writing tests or running the live matrix rather than
by review — including two the live matrix caught that nothing else would have: the blocking count
was derived from what a re-reconciliation **intended** rather than what it **achieved**, so a
failed resolution left the item open while the run moved to `awaiting_acceptance`; and K.16's
"full extract" masked *account* folios while leaving `folioNumber` in the clear on **every
transaction and holding row**, leaking once per transaction the very identifier the summary had
just masked. Re-verified present this phase: all three record shapes masked at
`acceptanceSummary.ts:258-259`.

**PC5 closes two of PC4's own named gaps**: `CG-2` (*"owner mismatch is not implemented at all;
`holderName` is parsed and discarded"*) is now implemented, and **PC4-INV-12's unenforced half is
closed**.

**Still open:** `0153` is **unapplied on production**. `PO-PC5-3` — naming the PC5 consumer owner,
required by `AIE10-GOV-01` — remains open; PC5 now exists and still has no named owner.
`request_reprocessing` remains **implemented by nothing, repo-wide** (`FC-7c`), which PC5 reports
rather than papers over: K.8 deep-links to the real unlock route instead of to a vocabulary entry
that does not work. `ii_adapter:source_disagreement:*` has a registry entry but **is never
produced by any live run**, because the AI fallback is unreachable for II.

### 7.1 HUF — the one PC5 decision the Product Owner closed mid-mission

M4 raised `PO-PC5-1` and **deliberately refused to close it itself**, because offering HUF would
have meant either inventing a ninth `OWNER_VALUES` entry backed by no valuation, consolidation or
net-worth semantics — the mistake `'company'` and `'family_trust'` already represent, both since
retired into `LEGACY_ENTITY_OWNER_RESTRICTIONS` — or quietly mapping HUF onto `'other'`, recording
a Hindu Undivided Family's holdings under a label carrying none of its distinct tax treatment, in
the one jurisdiction where that distinction is legally operative.

The Product Owner chose option (a). M4B implemented it as an **India-gated `business_entities`
entity type**, reusing FHIP's established jurisdiction idiom at three layers rather than inventing
a new one: a **database trigger** copied near-verbatim from `0084`'s AU-only SMSF gate (including
the deliberate choice **not** to make it `security definer`, so its own SELECT is RLS-scoped and a
forged `user_id` fails closed), a route guard returning a readable 403 with a machine-readable
`errorCode`, and a UI affordance that simply **omits** the option for a non-India user rather than
showing a disabled one.

**The trigger is not optional**, and the reason is concrete: `business_entities` has `for all` RLS,
so an authenticated user can `POST /rest/v1/business_entities` **directly through PostgREST with
their own token**, never touching the Next.js route. The route guard alone would be bypassable by
anyone who can read a network tab.

**`0154` was also applied to DEV during this phase**, and re-running M4B's own unmodified matrix
converted its 4 blocked scenarios: **15 PASS / 1 NOT_APPLICABLE / 0 FAIL / 0 BLOCKED, FULL mode,
zero residue.** The `NOT_APPLICABLE` is GATE-2, which existed solely to prove `0154` had *not*
silently already run and is inherently moot once it has. Proven live for the first time on the
hosted database: an India user creates a real HUF row; an **AU user's direct PostgREST insert is
refused by the database itself** with `0154`'s own message; Family Trust and Company still create
for **both** IN and AU users, so the HUF gate did not make the jurisdiction-agnostic types
jurisdiction-dependent; the HUF's ownership-scaled share reaches Net Worth through the **same**
consolidation path (₹1,620,000 with the HUF, ₹120,000 without); and every owner role in the live
option set is one of the canonical **eight** — **no `'huf'` role was invented.**

**`PO-M4B-2` stands and is stated plainly so no later phase inherits a false assumption:** HUF tax
semantics are **not** implemented. Exactly as Family Trust ships with no trustee/beneficiary/
distribution-rule model, HUF ships with no karta, coparcener, deed or partition model, and is
**not** linked to `ii_tax_profiles.taxpayer_type = 'RESIDENT_HUF'`, which remains a separate
income-tax filing status.

---

## 8. PC6 — reference market data

**Verdict: CONDITIONAL PASS.** The buildable scope is complete and proven against real data. Three
things keep it conditional, none of them a code defect and none hidden behind a green tick.

**Evidence, re-run fresh this phase:**

| Suite | Result |
|---|---|
| `scripts/pc6_live_dev_matrix.ts` — real AMFI fetch + real DEV writes | **41 / 41 PASS** |
| `scripts/pc6_0155_pglite_verification.mjs` — full chain replayed into real Postgres | **30 / 30 PASS** (after a harness correction, §8.2) |
| `scripts/pc6_performance_activation_proof.ts` | **24 / 24 PASS** |
| `tests/unit/pc6ReferenceMarketData.test.ts` | **79 / 79 PASS** |
| **PC6 total** | **174 / 174 PASS** |

**Real data volumes**, measured on the live files: 14,361 data lines parsed from a 1,519,199-byte
`NAVAll.txt` (sha256 `b1a8be20…`), **14,344 accepted, 17 rejected** — and **all 17 rejections are
real**: every one is the literal NAV string `"10."`, published by AMFI for matured target-maturity
index funds. `Number("10.")` returns `10`, so a lenient parser would have **invented a fact**; the
strict decimal grammar rejects it with an exact reason and the source line number. Rejection rate
0.118%, well under the 5% format-change alert threshold. 103 distinct AMFI category headers and
350 distinct raw option strings are preserved **verbatim** behind 6 coarse filter values —
AMFI's own taxonomy contains near-duplicate spellings and PC6 keeps all 103 distinct, because
merging them would be PC6 inventing a taxonomy AMFI never published.

### 8.1 A real defect found by real data, and now confirmed fixed on the hosted database

`ii_prices_nav.price` was created by migration `0033` as `numeric(20,6)`. AMFI publishes NAVs with
up to **eight** decimal places: measured on the live file, **54 rows at 7 dp and 389 at 8 dp — 443
of 14,361, i.e. 3.1% of the real universe.** At scale 6 the importer must either reject 3.1% of
the real universe or **round it silently**. Migration `0155` widens the column to `numeric(24,10)`
— metadata-only in Postgres, no existing row rewritten, no value altered.

**PC6 could only prove the fix in PGlite, because `0155` was unapplied. That is no longer true.**
With `0155` now applied to DEV, the live matrix wrote a real 8-dp AMFI NAV
(`14.86269632`, from a real scheme) to the **hosted DEV database** and read back
**`14.86269632` — identical.** Under `numeric(20,6)` it would have come back `14.862696`.

> **This required a correction to the harness, disclosed rather than quietly made.** PC6-LD-18 was
> written as a *defect-demonstration* scenario and asserted the **defect** (`rounded === true`).
> Once `0155` was applied it reported a **FAILURE for a FIX** — the run came back 40 PASS / 1 FAIL
> with the evidence line *"wrote 14.86269632, DEV stored 14.86269632"*, i.e. the opposite of a
> problem. It has been re-stated as the two-sided proof it always should have been: whichever
> column scale DEV is running, the observed behaviour must **match** it — pre-`0155` a >6 dp value
> must round, post-`0155` it must survive intact — and a silent disagreement between the two now
> fails. The matrix reports **41/41** again, with a **stronger** claim than before.

### 8.2 A second harness correction, and the finding behind it

`scripts/pc6_0155_pglite_verification.mjs`'s PC6-PG-26 asserted `enabled.length === 2 && every
row disabled`. It came back **FAIL** with the evidence line
`pc6_amfi_daily_nav=false, pc6_amfi_scheme_master=false, pc7_fund_holdings_disclosure=false` —
i.e. **every row disabled, which is the safety property the check exists for**, but three rows
where the harness hard-coded two.

**The third row is PC7's, and it belongs there.** Migration `0157` extends the shared
`ii_reference_job_control` ledger rather than creating a parallel one — PC7's deliberate "reuse,
not a second stack" decision. **The finding is that PC7 extended a shared ledger and did not
re-run the sibling phase's verification harness**, so a stale row count sat undetected until this
phase re-ran everything together. Re-stated as the property it is actually about (PC6's own two
rows are present, and **nothing** in the ledger is enabled), so a future phase adding a row extends
it safely while a future phase shipping an **enabled** row still fails. **30/30 restored.**

### 8.3 The two Product-Owner blockers, represented in the system as first-class blocked states

**`PO-PC6-1` — benchmark index licensing.** NIFTY index values are the property of NSE Indices
Limited and SENSEX of BSE/Asia Index; neither is open data, and the legacy unauthenticated
`niftyindices.com/Backpage.aspx` endpoint was re-probed and now returns the HTML site shell rather
than data — **so there is not even a technical path, let alone a licensed one.** PC6 ships the
entire benchmark master, mapping, history, TRI/PRI discipline and correction machinery and ingests
**zero** index levels. `buildUrl('nse_index_tri')` **throws**;
`ii_benchmark_category_defaults` ships **deliberately empty**, because asserting that every
large-cap fund benchmarks to NIFTY 50 is precisely what N.8 forbids; and DEV's 14 benchmark rows
were checked — **zero** are named after a real licensed index; all are pre-PC6 R4/R5 fixtures.

**`PO-PC6-2` — risk-free source and methodology.** Three defensible candidates, documented with
arguments both ways — the RBI 91-day T-Bill cut-off (conventional, genuinely default-free, but
auction-driven so some weeks have no auction), the 10-year benchmark G-Sec yield (daily and
liquid, but carries duration risk so it is not risk-free over shorter horizons and understates
excess return on a steep curve), and the RBI policy repo rate (unambiguous and never revised, but
a policy instrument rather than a traded return — an investor cannot actually earn it). **They
differ by roughly 100–150 bp across 2024–2026, which visibly moves every Sharpe and Sortino
number. PC6 will not choose.** `ii_risk_free_methodology` ships **empty**; `is_certified` defaults
**false** on every rate; resolution returns `unavailable` rather than a default; and the 16
existing DEV rows still self-describe as *"DEV SEED — approximate … (not a certified feed)"* — PC6
neither promoted nor deleted them. The certified risk engine already handles the absence
correctly: Sharpe and Sortino report `MISSING_REFERENCE_DATA` while volatility still calculates.
**rf = 0 would have made every Sharpe look better than it is.**

### 8.4 Performance activation — no analytics were reimplemented

19 metrics activated from the already-certified R4/R5 engines against a **real 14-point AMFI NAV
series** assembled from 14 bounded real fetches. A static check scans all seven PC6 modules for
any metric implementation and finds **none** — and it reads the directory rather than a hard-coded
list, so a future module cannot slip past it. Rolling returns correctly report an honest
`unavailable`: a 14-month series cannot support a 1-year rolling *series*, and the engine says so
rather than producing one. **The benchmark series used is synthetic and labelled
`SEALED-ORACLE-SYNTHETIC` everywhere**; it is never written to any database and never given a real
index's name. It proves the engines *activate* once a benchmark exists; it does **not** mean FHIP
can show a user a real NIFTY comparison today.

**`0155` is applied on DEV and unapplied on production.**

---

## 9. PC7 — Underlying Fund Holdings look-through

**Verdict: CONDITIONAL PASS.**

| Suite | Result (re-run fresh this phase) |
|---|---|
| `tests/unit/pc7LookthroughFoundation.test.ts` | **74 / 74 PASS** |
| `scripts/pc7_0157_pglite_verification.mjs` — fresh 0001..0157 rebuild, 151 migrations | **44 / 44 PASS** |
| `scripts/pc7_networth_safety_live_dev.mjs` — live on DEV | **19 / 19 PASS, zero residue** |
| R5 X-Ray + PC6 + PC7 packs together | **334 / 334 PASS** |

**O.7 — wealth safety — is the strongest claim in this entire programme, and it is defended three
independent ways, because any one of them can hold while the system is still wrong.** A structural
check alone passes a system that double-counts inside the engine; an arithmetic check alone passes
a system whose engine is perfect and whose repository quietly inserts an extra asset row.

**(a) Structural, asserted by the database itself.** `0157` adds
`ii_pc7_networth_safety_violations()`, which returns **one row per structural leak** — a foreign
key from any net-worth input table into a look-through table, or a tenancy column on a look-through
table — **rows, not a boolean**, so a failure says what is wrong. **And it is proven not to be
vacuous:** the PGlite run injects each violation shape, confirms the assertion fires, removes it,
and confirms it stops (PC7-PG-28..33, all PASS).

**(b) Arithmetic, and closed.** `assertDecompositionIsClosed()` requires exposure + cash +
derivative + other + unresolved + undisclosed-remainder + no-snapshot ≤ 1 at a tolerance of
**1e-9** — far tighter than any currency rounding, so a double-count of even the smallest holding
fails while summing thousands of floats does not. A **shortfall is explicitly not a violation**:
that is honest under-disclosure, reported as coverage and **never rescaled**.

**(c) Observed live on DEV — 19/19, re-run this phase.** A disposable synthetic tenant holding
**one** fund position worth exactly ₹1,000,000; a full look-through decomposition ingested
(1 snapshot + **9 constituent lines**) summing to exactly 100%; and:

> **PC7-LD-07 — net worth changed by EXACTLY ZERO.** `{assets 0, investments 1000000, retirement 0,
> liabilities 0, netWorth 1000000}` before **and** after, compared **by exact equality with no
> tolerance**; zero fields moved.

With both controls that make that claim non-vacuous: **PC7-LD-14**, adding ₹1 of real wealth moves
the measurement to 1,000,001 (so the measurement is live, not frozen), and **PC7-LD-15**, removing
it restores 1,000,000. Plus **two RLS negative controls** — an ordinary authenticated user cannot
insert a look-through line (HTTP 403) or a snapshot (HTTP 403) — and **a positive control for the
negative controls**: the same user **can read** the same 9 rows, so those are genuinely write
denials and not broken requests. Cleanup independently re-queried: **zero residue.**

> **A false positive was found and fixed during PC7's own run, and is recorded because it
> matters.** The structural check first used a loose `/snapshot/i` match and flagged
> `investments.pre_publication_manual_snapshot` — an R3 publication-lifecycle column with nothing
> to do with look-through. **A safety check that cries wolf is one people learn to ignore.**

**One real defect found and fixed in previously-certified code (O.8).**
`r5Repository.ts:632` assigned `sourceKey: 'db'` to **every** holdings snapshot — true of
everything and informative about nothing — and the read did not even select `source_id`. Fixed:
`source_id` is now selected and resolved through `ii_sources` to a real key, and
`LookThroughResult` gains `sourcesUsed` so provenance reaches the surface alongside as-of date and
coverage. Where a snapshot genuinely carries no source — **the state of all 19 DEV fixture rows** —
it reads **`unattributed`**, which is a different and more useful answer than `'db'`: it tells the
operator the provenance is missing. Re-verified present this phase at `lookThrough.ts:246` and
`r5Repository.ts:656`.

**Three inherited assumptions were corrected against current state rather than repeated**,
including one that would have sent the phase down the wrong path entirely: `ii_fund_holdings` (R1,
migration `0031`) was described as "the exact look-through shape you're meant to populate", and it
**cannot express O.4 at all** — it has no asset type, sector, industry, market-cap class, credit
rating, maturity, duration, quantity, market value, coverage, versioning or supersession. The real
shape is `ii_fund_holdings_snapshots` / `ii_fund_holdings_lines` from `0044`.

**Two O.4 additions prevent specific, silent, large errors**, and are worth naming:
**`market_value_unit`** (closed domain: units / thousands / lakhs / millions / crores) — SEBI-layout
files state market value in **lakhs**, so a pipeline that assumes rupees is out by a factor of
100,000 **and the numbers still look like plausible money**; and **`resolved_weight_total_pct`
kept separate from `disclosed_weight_total_pct`**, because conflating them hides unresolved
exposure behind a healthy-looking disclosure total.

**Why not FULL PASS — two reasons, neither an engineering gap:**

1. **No source is licensed.** The investigation was done for real against primary sources. SEBI's
   Master Circular obliges AMCs to publish month-end portfolios with ISIN in downloadable
   spreadsheet form within 10 days (debt schemes fortnightly within 5); the files are genuinely
   **spreadsheets, not narrative PDFs**. But **AMFI publishes no constituent dataset at all** —
   there is no holdings equivalent of `NAVAll.txt` — and the terms are adverse and inconsistent:
   AMFI's Terms of Use licence the site *"for your personal and non-commercial use only"* and
   forbid storing *"electronically any significant portion"*; Nippon India prohibits aggregation;
   **SBI MF's `robots.txt` disallows `/*.xlsx?*` and its canonical file URLs carry a `?sfvrsn=`
   version parameter, so its actual download URLs are robots-disallowed**; HDFC returns 403 to
   non-browser clients; ICICI Prudential prohibits nothing — which is **absence of prohibition,
   not permission**. *A public disclosure obligation binding the publisher is not a redistribution
   licence for a consumer, and the two are routinely conflated.* Every source therefore ships
   `enabled: false`, `buildDisclosureUrl()` throws on a disabled source, both `ii_sources` rows
   ship `is_active = false`, and the job-control row ships disabled. **Zero real schemes ingested,
   zero real snapshots created.**
2. **`0157` is unapplied everywhere** — re-confirmed on **both** databases this phase with passing
   controls. Everything depending on it is proven at schema level against a real Postgres rebuild,
   which is real evidence about the schema and the constraints and is **not** evidence that any
   hosted database has them. **This is now PC7's sole remaining migration blocker**, since `0155`
   beneath it reached DEV during this phase.

---

## 10. PC8 — no scope found

> ### PC8 — NO AUTHORITATIVE APPROVED SCOPE FOUND — NOT EXECUTED

Recorded on **demonstrated** evidence, not assertion. Eight searches (S1–S8) run against 1,099
commits and 459 refs: `git grep` over the working tree returns **17 lines in exactly 2 files**,
both of which are this mission's own records *of the absence*; excluding those two, **zero lines**;
a content-level pickaxe over **every commit on every ref** returns **0 commits**; **0 of 3,890
distinct file paths ever created on any ref** carries a PC8 name — which also rules out a
deleted-and-hidden document, since `--diff-filter=A` enumerates every path ever added; **0** refs
and **0** commit messages besides M0's own; and the Product-Owner filesystem holds exactly one
matching file — **this mission's own dispatch prompt**, whose 21 mentions were read line by line
and are every one conditional (*"if authoritative approved scope exists"*) or procedural, with the
report-template bodies being literal placeholders.

**No `II_PC8_SCOPE_FREEZE.md` was created.** A scope-freeze document is created only when scope is
*found*; creating an empty one would misrepresent an absence as a phase.

> **A note for whoever searches next.** From the moment the Phase 9 document was committed there
> were **three** self-referential files, and with this one there are **four**. Anyone re-running
> these searches must exclude them, or they will find the record of the absence and mistake it for
> the thing it records the absence of. That is precisely the failure mode the anti-invention rule
> exists to prevent.

## 11. PC9 — no scope found

> ### PC9 — NO AUTHORITATIVE APPROVED SCOPE FOUND — NOT EXECUTED

Identical result, identical evidence. Zero commits for `-S"PC9"` across the entire history of all
459 refs.

## 12. PC10 — no scope found

> ### PC10 — NO AUTHORITATIVE APPROVED SCOPE FOUND — NOT EXECUTED

Identical result, identical evidence.

**Consequence: the highest genuinely approved phase is PC7**, and this document is therefore a
final integrated **post-PC7** certification, worded as such rather than as "post-PC10".
`RG-1` — whether to (1) confirm the sequence legitimately ends at PC7, (2) supply specifications
that exist somewhere unreachable, or (3) define PC8–PC10 fresh as new work explicitly **not**
under the label "previously approved scope" — **remains open and awaiting the Product Owner.**

---

## 13. Migration reconciliation

### 13.1 Repository state, re-verified fresh this phase

```
$ node scripts/check-migration-versions.mjs
OK: 151 active migrations, one file per version, next version is 0158.
Note: unused version numbers in the chain: 0079, 0080, 0081, 0103, 0128, 0156

$ node scripts/check-migration-versions-against-branch.mjs
OK: no cross-branch migration collisions between "HEAD" (151 files) and "origin/main" (136 files).
```

**`0158`, `0159` and `0160` were additionally confirmed free across every ref** —
`git log --all --diff-filter=A` returns zero commits for each. **This mission created no
migration this phase and consumed no number.**

### 13.2 The four migrations this mission owns, and where each actually is

Established fresh by a purpose-written read-only probe run against **both** databases, with two
negative controls (a nonexistent table → `PGRST205`, a nonexistent column → `42703`) and six
positive controls (`0033`, `0044`, `0140`, `0144`, `0149`, `0150` objects) — **all controls passed
on both environments**, so the method neither returns false positives nor false negatives.
Independently corroborated by a second, prior-phase-authored probe
(`scripts/pc5_migration_baseline_probe.mjs`).

| Migration | Owner | DEV | PRODUCTION | Method |
|---|---|---|---|---|
| `0153_pc5_governed_resolution.sql` | PC5 (M4) | **APPLIED** — changed state during this phase | **NOT APPLIED** | Structural — `ii_ownership_allocation` + 3 `aie_review_decision` columns, 4 objects, unanimous |
| `0154_huf_entity_type_india_gate.sql` | PC5/HUF (M4B) | **APPLIED** | **NOT APPLIED** (inferred, see below) | **Behavioural** — a CHECK widening plus a trigger is invisible to PostgREST's schema cache and cannot be probed read-only. Proved on DEV by M4B's own matrix: an India user creates a real `entity_type='huf'` row, and an AU user's **direct PostgREST** insert is refused by the database with `0154`'s own trigger message (SQLSTATE `42501`) |
| `0155_pc6_reference_market_data_foundation.sql` | PC6 (M6) | **APPLIED** — changed state during this phase | **NOT APPLIED** | Structural — 4 tables, unanimous. Independently corroborated behaviourally: an 8-dp NAV now stores intact on DEV (§8.1) |
| `0157_pc7_lookthrough_foundation.sql` | PC7 (M7) | **NOT APPLIED** | **NOT APPLIED** | Structural — 3 columns across 2 tables, unanimous |

> **A live event this phase observed and re-verified rather than assumed.** The first migration
> probe of this phase reported `0153` and `0155` **NOT APPLIED on DEV**, with all controls passing.
> A probe run roughly an hour later, same script, same controls passing, reported both **APPLIED**.
> An operator applied them — and `0154` with them — mid-phase. **Production is unchanged.** This is
> reported as an observation, not as a claim about who acted or why, and every downstream statement
> in this document reflects the *later* state, re-measured rather than inherited.

> **On `0154`'s production state.** A CHECK-plus-trigger migration cannot be confirmed read-only,
> and this phase performed **no write of any kind against production**, so no behavioural probe was
> run there. Its production state is stated as **NOT APPLIED on the strength of the other three**:
> `0153`, `0155` and `0157` are all unanimously absent on production, and `0154` is a member of the
> same unapplied operator batch. M5's own behavioural probe against production (which created
> nothing, using an all-zero `user_id` that cannot satisfy the FK in either branch) recorded the
> same. **This is an inference, clearly labelled as one, not a measurement.**

### 13.3 `0156` is NOT this mission's, and must not be treated as one

```
$ git log --all --oneline --diff-filter=A -- "supabase/migrations/0156*"
ea4c124 fix(migrations): renumber app-review Item-3 migration 0154 -> 0156
        supabase/migrations/0156_app_review_0915_clear_leaked_migration_notes.sql

$ git branch --all --contains ea4c124
+ fix/app-review-findings-2026-09-15
```

`git merge-base --is-ancestor ea4c124 HEAD` → **1 (not an ancestor)**;
`… ea4c124 origin/main` → **1 (not an ancestor)**. It exists on exactly one unrelated branch, is
absent from this mission's branch and from `origin/main`, and it originally claimed `0154` — the
number PC5/HUF also wanted — which is **why this mission's PC7 migration is `0157` rather than
`0156`.**

**It is queued for an operator like this mission's four, so the full "what is waiting to be
applied" picture is inaccurate without it — but it is NOT a deliverable of this mission and must
not be applied as part of this mission's sequence.**

### 13.4 The pre-existing eleven-migration skew, unchanged

**Eleven AIE migrations — `0140`–`0146` and `0149`–`0152` — are applied to BOTH DEV and PRODUCTION
while none of them exists on `main` and none of their application code is merged or deployed.**
Re-confirmed on both databases this phase (`0140`, `0144`, `0149`, `0150` objects all PRESENT on
production; `aie_ai_cost_ledger` carries `0150`'s own seed row).

They are inert — no deployed route references them — but they are real, they are in the production
security surface, and they are not represented in `main`'s migration chain. **A fresh database
rebuilt from `main` today would not match DEV or production.** Consequently the AIE block must be
merged onto `main` **without renumbering**; re-emitting effects forward is the only legal
correction if anything is wrong with any of them.

This is also why `main`'s own tooling under-reports: `check-migration-versions.mjs` run against
`main` alone says *"next version is 0149"*, and `0149`–`0152` are already applied to two shared
environments. **The next genuinely free number is `0158`.**

---

## 14. Test summary

All figures below were measured **in this phase**, in a worktree with its own clean `npm install`,
not carried forward.

### 14.1 The corrected regression baseline

> **Pre-existing failing baseline: 17 files / 39 tests.**
>
> **The figure "16 files / 22 tests" is STALE and appears in earlier mission documents, including
> M2's, M3's, M4's, M4B's and M5's AIE-1 terminal certification §13.** M7 established the correct
> figure properly — by **stashing** its own two edits to pre-existing files, re-running the same
> 17 files, and finding them failing **identically** — and Phase 9 instructed that the correction
> be made explicitly rather than silently. **This report cites 17/39 and states the correction
> here rather than swapping the number quietly.**

**Confirmed independently this phase**, on a clean install with no prior-phase edits stashed or
restored:

```
Test Files  17 failed | 348 passed | 2 skipped (367)
     Tests  39 failed | 7327 passed | 23 skipped (7389)
  Duration  152.75s
```

And the failing set matches M7's documented list **file-for-file and assertion-for-assertion**:

| Failing file | Failed assertions | Kind |
|---|---|---|
| `adminAnalyticsPhaseAMeRoute.test.ts` | 17 | pre-existing assertion failures |
| `lrFi2HouseholdDebtRatios.test.ts` | 9 | pre-existing, debt-ratio territory |
| `smsfHouseholdIsolation.test.ts` | 8 | pre-existing, SMSF isolation territory |
| `aiResidualClosureFailClosed.test.ts` | 1 | pre-existing |
| `countryGateAccessMatrix.test.ts` | 1 | pre-existing |
| `fdh1Isolation.test.ts` | 1 | pre-existing |
| `lr12rSmsfPropertyLoanLinkOverride.test.ts` | 1 | pre-existing |
| `lrFi2DebtServiceExactlyOnce.test.ts` | 1 | pre-existing |
| 9 × `resources*` | **0 each** | fail at **module-collection** time for missing DEV env vars — **environmental, not defects** |
| **Total** | **39** | **17 files** |

**None of the 17 is caused by this mission**, and none references AIE, PC5, PC6, PC7, `lookThrough`,
`r5Repository`, `xray` or `fund_holdings`.

> **One flake reproduced and chased down rather than counted.** A *second* confirmation run, made
> after this phase's two harness corrections, reported **18 files / 40 tests** — the extra being
> `paymentsCheckoutRoute.test.ts` with 1 failing test. **Run in isolation it passes 7/7.** This is
> the identical parallel-execution artifact M3 documented in its own §7 (and PC5 documented a
> sibling of, in `resources*` collection failures). It is recorded here rather than dropped from
> the count. **The baseline stands at 17 / 39**, which is what the clean, uncontended run measured.

### 14.2 Targeted suites, all re-run fresh this phase

| Suite | Result |
|---|---|
| **PC4's 19-invariant regression contract** (85 files: `tests/unit/ii*`, `reportsIIChapters`, `fdh11AuInvestmentIntelligence`) | **84 passed / 1 skipped; 1,673 passed / 5 skipped / 0 failed** — **byte-identical to M1's recorded baseline** |
| AIE + PC5 unit suites (`tests/unit/aie*`, `tests/unit/pc5*`) | **61 files / 877 tests — 877 pass, 0 fail** |
| PC6 + PC7 + R5 X-Ray + HUF (`pc6ReferenceMarketData`, `pc7LookthroughFoundation`, `iiR5Certification`, `iiR5MathIdentities`, `iiR5NoFabrication`, `businessEntity*`) | **7 files / 334 tests — 334 pass, 0 fail** |
| `npx tsc --noEmit`, whole project | **clean, zero errors** (run twice: before and after this phase's edits) |
| `scripts/check-migration-versions.mjs` | `OK: 151 active migrations, next version is 0158` |
| `scripts/check-migration-versions-against-branch.mjs` | `OK: no cross-branch collisions` |

### 14.3 Live-DEV matrices and proofs, all re-run fresh this phase

| Matrix / proof | Result |
|---|---|
| **PC5 K.22 live-DEV matrix** | **54 PASS / 0 FAIL / 0 BLOCKED — FULL mode** (was 41 PASS / 13 BLOCKED_ON_0153) |
| **M4B HUF live-DEV matrix** | **15 PASS / 1 NOT_APPLICABLE / 0 FAIL / 0 BLOCKED — FULL mode** (was 12 PASS / 4 BLOCKED_ON_0154) |
| **PC6 live-DEV matrix** (real AMFI fetch, real DEV writes) | **41 / 41 PASS** |
| **PC6 `0155` PGlite verification** (full chain into real Postgres) | **30 / 30 PASS** |
| **PC6 performance activation proof** | **24 / 24 PASS** |
| **PC7 `0157` PGlite verification** (fresh 0001..0157 rebuild, 151 migrations) | **44 / 44 PASS** |
| **PC7 net-worth safety live-DEV proof** | **19 / 19 PASS, zero residue** |
| **AIE M3 Investment Intelligence dispatch live-DEV proof** | **6 / 6 PASS, zero residue across 8 tables** |
| **Real OpenAI provider proof** (`OpenAiAieProvider` asserted `.not.toBeInstanceOf(MockAieProvider)`, real HTTP 200, strict `json_schema`, 7 PII sentinels asserted absent pre-egress) | **4 / 4 PASS**, under an ephemeral in-memory masking key |
| **AIE traceability matrix** | **361 / 2,214 traced (16.3%), 1,853 orphans** — re-measured over 2,991 repository files |

### 14.4 Read-only database probes run this phase

**5 purpose-written probe scripts** across DEV and PRODUCTION, plus 2 prior-phase probes re-run.
**2 negative controls and 6 positive controls per environment, all passing.**
**Writes: 0. RPCs: 0. DDL: 0. Rows created on production: 0.**

---

## 15. Live DEV

Aggregated across all ten phases. Every live-DEV suite in this mission runs against the **real**
DEV Supabase project, with a hard safety gate that derives the target project ref and **refuses to
proceed** if it matches `PRODUCTION_SUPABASE_URL`, and every one ends with an **independent
re-query** of the tables it wrote — a delete call returning success is never treated as proof.

### 15.1 What was exercised

| Phase | Scenario | Rows created / cleaned / residue |
|---|---|---|
| **M2** | AI cost admission under real concurrency — 12 genuinely parallel reservations of $0.25 against a $1 allowance | 13 / 13 / **0** |
| **M2** | Real masked OpenAI provider call through the application's own provider factory | n/a — **this is where the holder-name PII leak was caught** |
| **M3 / M5 / M11** | Investment Intelligence dispatch end to end — real PDF bytes, real `aie-document-quarantine` Supabase Storage object, real DEV database, real certified CAMS parser | 2 intakes, 2 runs, 4 candidates, 5 reconciliation runs, 2 unresolved items, 2 storage objects, 1 auth user / all / **0 across 8 tables** |
| **M3 / M5** | Binary purge — delete, **independently re-list to confirm absence**, then record | 1 real storage object / deleted / **0** |
| **M3 / M5** | Mask-token 48h TTL fires on age alone on a **non-terminal** run, plus a negative control where a row inside the TTL **survives** | 2 rows / 1 deleted, 1 correctly retained / **0** |
| **M4 / M11** | PC5 governed resolution — **54 scenarios**, driving PC5's own production services, with field candidates from the **real certified CAMS parser** | 2 auth users, 3 households, 7 members, 1 `ii_account`, 17 intakes, 16 runs, 15 unresolved items, 16 parser attempts, ~90 candidates, 1 storage object / all / **0 across 12 tables + auth users** |
| **M4B / M11** | HUF India gate — 4 real disposable users (IN, AU, GB-generic, unconfirmed) with real password sign-in, real service functions, **real direct-PostgREST bypass attempt** | 4 users + entities / all / **0** |
| **M6 / M11** | PC6 reference data — real AMFI fetch (1.5 MB daily + 3.5 MB history), real NAV writes to DEV, sealed-oracle read-back | 12 NAV rows / 12 / **0** (`ii_prices_nav` 258 before, 258 after) |
| **M7 / M11** | PC7 net-worth safety — synthetic tenant, 1 fund position, 1 snapshot + 9 constituent lines, 2 RLS write denials, 1 RLS read allowance, 1 sensitivity probe | 1 snapshot + 9 lines + tenant / all / **0** |

### 15.2 A discovery the live proofs made that inspection did not

**Four of the mission's eight fixed defects were found by *running* the system, not reading it**:
the holder-name PII leak (M2's own pre-egress sentinel failed on its first run); the first-upload
reconciliation skip (M3's dispatch test drove a deliberately-broken statement through the real path
with an empty canonical store); the reported-vs-stored state divergence (the first live run printed
`awaiting_acceptance` where `unresolved` was expected); and PC5's folio leak in the full extract
plus its intended-vs-achieved blocking count (both caught by the live matrix, S-44 and S-26).

### 15.3 Harness defects disclosed rather than quietly corrected

Four, across the mission, every one of which first produced a result that was **wrong in the
reassuring direction** — which is why they are named:

- **M5's traceability script** reported **100.0% coverage with zero orphans** on its second run,
  because it writes its output into `scripts/`, which is one of its own scanned roots, so it found
  all 2,161 orphan ids "cited" — by its own previous output. Caught because the *strict* column
  jumped 2.7% → 100.0%, which no citation-convention change could explain. A self-contamination
  guard was added, idempotency across consecutive runs verified, and the finding recorded.
- **M4B's PGlite harness** used `set local role authenticated`; PGlite autocommits each statement,
  so a transaction-local GUC is discarded and `auth.uid()` reads NULL — **silently disabling RLS**.
  The forged-`user_id` control reported *"NOT REFUSED — forgery succeeded"*, which was a harness
  failure, not a product one. Fixed with session-scoped `set_config(..., false)` plus a **hard
  assertion that `auth.uid()` really is the intended user before any claim is made**; the final run
  asserts `0 vacuous statement(s)` as its own reported line.
- **PC6's `0155` PGlite verifier** hard-coded a job-row count that PC7's legitimate shared-ledger
  extension made wrong (§8.2). **Corrected this phase.**
- **PC6's live NAV-precision scenario** asserted the defect rather than the behaviour, so applying
  the fix made it report a failure (§8.1). **Corrected this phase.**

### 15.4 Document integrity

All **13** prior-phase documents arrive by **inheritance** rather than by copying — this branch is
cut from the M8–M10 tip — which is stronger than a copy, because a copy can drift. **SHA-256
verified byte-identical** against the Phase 9 worktree, all 13 MATCH, and the first 12 additionally
match the prefixes Phase 9 recorded in its own §5 table.

---

## 16. Production certification

**Trivially N/A — nothing from this mission has been certified in production, because nothing from
this mission has reached production.**

This is not a limitation being reported reluctantly; it is the binding override working as
intended. There is no production certification to issue because there is no production deployment
to certify.

| Evidence | Result |
|---|---|
| `origin/main` SHA | unchanged, re-fetched today (§2) |
| Mission code merged to `main` | **none** — 110 commits, 325 files, all local and unpushed |
| Mission code deployed | **none** — zero AIE/PC5/PC6/PC7 files exist on `origin/main` |
| Production migrations applied by this mission | **0** of 4 |
| Production database writes by this mission | **0**, across all ten phases |
| Production configuration changed | **none** |
| Production rollout activated | **none** |
| DDL capability from this environment | **none** — re-proved fresh today: 8 candidate exec/DDL RPC names all return `PGRST202`; `SUPABASE_ACCESS_TOKEN`, `SUPABASE_MANAGEMENT_TOKEN`, `SUPABASE_PAT` all absent; `DATABASE_URL`/`POSTGRES_URL` absent. **There is no path by which this environment could have applied a migration to production even if authorised.** |

---

## 17. Security and privacy

### 17.1 Every new or changed boundary this mission introduced

| Boundary | Introduced by | How it is enforced | Proof |
|---|---|---|---|
| `ii_ownership_allocation` | PC5 / `0153` | **SELECT-only RLS** (deliberately unlike `ii_goal_allocations`'s `for all`) plus a **cross-tenant FK trigger** | **S-38** — even the owner's own JWT cannot insert one (HTTP 403, `42501`). **S-37** — a real, existing household-member uuid belonging to another user is refused **by the trigger**. **Both re-run fresh and PASSING this phase; S-37 had never run live before, because `0153` did not exist** |
| PC5 decision surface | PC5 | `checkCapability` — same-tenant only, `callerId === targetUserId`, with empty-id guards so "unauthenticated equals unauthenticated" can never be a match | **S-19** — an attacker cannot decide the owner's item even holding its real id (`not_found`). **S-15/S-16** — cross-user direct-ID access returns `null` and the attacker's own JWT reads **0 rows**. **S-18** — a decision naming another user's real member uuid is refused `invalid_choice`, because the option set is built by a query filtered on the caller's own user id, so the id is simply absent from it. **S-17** — even the owner's own JWT cannot mutate an item status; 0 rows affected, status re-read as still `open`. **S-20** — a direct `ii_transactions` insert is refused 403 |
| `business_entities` HUF gate | M4B / `0154` | Three layers: a **non-`security definer`** DB trigger (so its own SELECT is RLS-scoped and a forged `user_id` fails closed), a route guard, and a UI affordance that omits rather than disables | **H-05** — an AU user's **direct PostgREST insert**, bypassing the route entirely, is refused by the database. **H-04** — a body-supplied `country_code: 'IN'` cannot buy the gate off; the gate reads `user_profiles`, never the payload. **Both re-run fresh and PASSING this phase; neither had ever run live before** |
| PC6 reference tables | PC6 / `0155` | `is_pc6_reference_data_admin()` RLS predicate on every operational table, behind a **separately-named** capability | **PC6-PG-18..23** with a **vacuity guard** — an admin *without* the capability sees 0 import batches; an admin *with* it sees 1; an ordinary user sees 0 but can still read the public scheme master. The harness asserts `auth.uid()` really is the intended user before making any claim. **Structurally: no PC6 table carries a tenancy column at all** (PC6-PG-29) |
| PC7 snapshot tables | PC7 / `0044` + `0157` | Service-role write only; `is_pc7_lookthrough_data_admin()` for the admin surface, a **separate** capability from PC6's | **PC7-LD-11/12** — an ordinary authenticated user cannot insert a line or a snapshot (HTTP 403 each). **PC7-LD-13** — a positive control proving those are write denials, not broken requests. **Re-run fresh and PASSING this phase** |

**Part Z.3 asked that at least one still-holding boundary be re-proved fresh rather than cited.
Five were**: PC5's full 10-scenario K.20 block, the HUF direct-PostgREST bypass, PC7's RLS denials
with their positive control, and — for the first time in the mission's life — the two allocation
scenarios that required `0153` to exist at all.

### 17.2 Privacy

| Egress surface | Investment Intelligence | FDH-bank | Insurance |
|---|---|---|---|
| Provider request | **PASS** — 7 PII sentinels asserted absent from the pre-egress payload, live, re-run this phase | **NOT EXERCISED** | **NOT EXERCISED** |
| Provider logging wrapper | **PASS** — field *names* only | same | same |
| Application logs | **PASS** — errors sanitised before recording, so a signed URL or host detail cannot leak into the audit trail through a failure message | same | same |
| Analytics telemetry | **PASS** — none exists in `lib/aie` | same | same |
| Generated certification reports | **PASS** — this document and all 13 carried-forward documents contain no PAN, folio number, holder name or raw statement text |

**Two independent gates with no bypass**, re-verified structurally this phase: the orchestrator
masks and passes only `masking.maskedText`; the gateway **independently re-scans** and returns
`unmasked_pii_detected` *before* any reservation or provider call.

**Tokenisation is one-way HMAC only, re-confirmed structurally this phase:** `tokenMapCrypto.ts`
does not exist on disk; `persistMaskTokenMap` and `findMaskTokenCiphertext` are gone;
`revealMaskedToken` refuses with `not_revealable_one_way_masking`; `aie_mask_token_map` holds
**0 rows on DEV and 0 on production**, re-counted today.

**The FDH/Insurance columns read NOT EXERCISED for one reason: their AI path has never been run.**
Per §6.9 it is now *reachable*, so the moment the masking key is provisioned these two adapters
would begin egressing to a provider on a path this mission has never tested.

### 17.3 Prompt injection

**The controls genuinely hold**, and the coverage hole was found and closed. Document text goes in
the **user** message, never the system prompt, which explicitly frames it as untrusted data;
structured output uses `response_format: json_schema` with `strict: true`,
`additionalProperties: false` at every level, and a **closed `fieldName` enum** per adapter; the
schema registry **throws rather than guessing** for an unknown schema. **No external side effect is
reachable from model output**: the only `fetch` in all of `lib/aie/**` is a hardcoded module-level
constant, and **no tools or functions are ever sent to the model**, so there is no tool-call
channel at all.

**The repository had several tests named "adversarial", and every one targeted hostile PDF
*structure* or concurrency. Nothing anywhere fed a document whose *text* carried instructions at
the model.** The control everyone assumed was tested was not. M2 wrote it: 8 tests driving a
hostile document through the **real** masking → **real** gateway → **real** schema validation, and
asserting that a model which **fully obeys** the injection still produces `schema_rejected` with
no `data`; that an invented value which *does* satisfy the schema is still only a candidate; that
the attacker's exfiltration URL can never become a destination; and — deliberately — that the
injected instructions **survive as inert data**, because masking is a privacy control and not an
injection filter, and a future change that started silently deleting instruction-like text would
be a false sense of security worth failing on.

**Four independent guards stand between any AI output and a canonical write**: gateway Zod
re-validation (not trusting OpenAI's own strict mode) returning `schema_rejected` **with no `data`
field at all** → orchestrator calling the extractor only inside the `success` branch →
reconciliation turning any non-pass into a blocking item before `awaiting_acceptance` →
the acceptance gate re-checking server-side with a CAS.

---

## 18. Financial integrity

Every count below is **verified**, not pasted. Where a count is not zero it says so.

| Measure | Count | Evidence |
|---|---|---|
| Unexplained economic omissions | **0** | Net-units aggregate vs a sealed oracle, on all 8 clean corpus fixtures — an independent check from the per-row one, so a compensating pair of errors would have to cancel exactly to survive both |
| False economic transactions | **0** | Same, both directions |
| False canonical accounts | **0** | Position count vs oracle, per `(folio, scheme)` |
| False instruments | **0** | Same |
| **False tax lots** | **0** | The opening-balance marker must be an `adjustment` carrying **no NAV and no amount** to invent a cost base from. `ACQUISITION_TYPE_MAP` contains no `'adjustment'` key and `DISPOSAL_TYPES` excludes it — *structurally* unable to become a lot |
| **Duplicate net-worth contributions** | **0** | Two folios holding one scheme stay two positions (fixture C7's oracle is the second folio's balance **specifically**, so a summed figure fails). Plus PC4-INV-11's mutation test, which proves the suite actually **catches** a double-count regression. Plus PC7-LD-07/08/10 live: net worth changed by **exactly zero** on a full look-through decomposition, and is 1,000,000 rather than 2,000,000 |
| False-accept rate | **0** | `aieM3InvestmentCorpusAccuracy` — 57 tests |
| False-canonical-write rate | **0** | Same, plus the four independent guards (§17.3) |
| Economic transaction precision / recall | **100%** on all 8 clean fixtures | `(date, type, units)` triples compared **in both directions** — a count alone would let a wrong row substitute for a right one |
| Closing-unit variance on the corpus | **exactly `0`** | Not merely "within 0.0001", so a real rounding defect cannot hide inside the certified allowance |
| PC4 production positions reconciling to variance `0.000` | **12 of 17** | Re-verified live today |
| **PC4 production positions certified** | **0 of 17** | Re-verified live today — **this is the one non-zero-in-the-wrong-direction figure in this section, and §5 sets out exactly why** |
| `unit_variance_within_tolerance` reading `null` as `true` | **0** | 12 `true`, 5 `false`, **0 `null`** — PC4-INV-15 holding, re-verified live today |
| Look-through decomposition overrun (parts exceeding the whole) | **0** | `assertDecompositionIsClosed()` at 1e-9; live PC7-LD-09 read back `{security 97, cash 2.5, derivative 0, other 0.5}` = **exactly 100%** |
| PC6 NAV values silently rounded on DEV | **0** (was 443 of 14,361 at risk) | Confirmed live on the hosted database now that `0155` is applied (§8.1) |
| Ownership allocations deviating from exactly 100% | **0** | PC5 S-35 live, across every active group |

---

## 19. AI integrity

| Measure | Count | Evidence |
|---|---|---|
| Raw PII egress events | **0** currently; **1 found and fixed** | The one was the holder-name leak M2's own live pre-egress sentinel caught on its first run. 7 PII sentinels re-asserted absent this phase, live |
| Canonical writes from schema-rejected AI output | **0** | Gateway returns `schema_rejected` **with no `data` field at all**; orchestrator only extracts inside the `success` branch |
| Canonical writes from refused AI output | **0** | `refusal` is checked **before** content is read; mapped to typed `refused` with no `data`. Exercised with a purpose-built stub, because `MockAieProvider` hardcodes `finishReason: 'stop'` and **cannot express a refusal at all** — an earlier draft of that test passed without exercising the path, which was caught and fixed |
| **AI-invented canonical ids** | **0 — structurally impossible** | No canonical-id field exists anywhere in the schema, and `.strict()` at every level means naming one is a validation failure. "AI must never invent a canonical instrument" is a sentence the contract **cannot express** |
| **Confidence-driven reconciliation outcomes** | **0 — structurally impossible** | **No confidence field exists** in the facts contract. The cheapest guarantee that a score cannot move an outcome is to give the model no channel to report one. `compareFieldEvidence.length === 3` and the serialised result contains no `confidence`, both asserted |
| Cost overspend events | **0** | 12 parallel reservations admitted exactly 4; `reserved_usd` exactly `1.000000`, never above allowance. Fails closed (`admitted: false`) if the ledger RPC is unreachable |
| Unbounded retries | **0** | Hard-capped at 2 via `Math.min(raw, 2)` — **not operator-raisable** |
| Duplicate writes from timeout/retry | **0** | Idempotency at the gateway (in-memory) **and** at the DB (`UNIQUE` on `idempotency_key`, `for update` row lock in `0152`) |
| Tool-call channels available to the model | **0** | No tools or functions are ever sent |
| External side effects reachable from model output | **0** | The only `fetch` in `lib/aie/**` is a hardcoded module-level constant; no email, no filesystem write, no shell, no `eval`, no dynamic URL construction |
| Reversible mask-token map rows | **0 on DEV, 0 on production** | Re-counted today. The crypto module, its writer, its reader and the reveal capability are **deleted**, not disabled |
| Real OpenAI calls made by this mission, total | **~7**, total cost **~$0.0003 USD** | The one instrumented measurement: 261 prompt + 37 completion = 298 tokens = **$0.00006135** |
| **Production AI usage** | **0** | `aie_ai_cost_ledger` on production: `reserved_usd=0`, `settled_usd=0`, `total_attempts=0`. `aie_ai_cost_attempt` and `aie_ai_completion_attempt`: **empty** |
| AI-fallback proportion for Investment Intelligence | **0% — 100% deterministic**, structurally | `aiWasUsed === false` asserted on every clean fixture; `aiEligibleGaps: []` unconditionally |

---

## 20. Document lifecycle

| Measure | Count | Evidence |
|---|---|---|
| Documents retained beyond policy (DEV) | **0** | 24-hour hard backstop selects on **age alone with no status filter** — asserted by test, because an upload that crashed while still `received` or `quarantined` is exactly the case it exists for |
| Purges recorded without independent absence verification | **0** | Order — delete, **independently verify absent**, *then* mark — asserted **by position in the source**, so a reordering fails. Proved on a real DEV storage object at M3, M5 and again at M4/M11 (S-45) |
| **False `document_purged` audit events** | **0** currently; **an unbounded loop of them found and fixed** | M2's finding: the DB refused the update, the error was **discarded**, and the code wrote a `document_purged` event and returned `{status:'purged'}` for a row it had not updated — then re-selected the same row **forever**. All three update results are now checked, and the terminal status is decided in **one shared helper** so the two call sites (which previously listed *different* status sets — that is how the gap survived review) cannot drift apart again |
| Orphan mask-token maps | **0** | 48h TTL fires on age alone; proved deleting a 72h row on a **non-terminal** run, with a negative control where a row inside the TTL survives the same sweep |
| Passwords persisted, logged or echoed | **0** | Never a column on any table; `parse_error: null` set defensively; the response never echoes it; the new AIE unlock endpoint takes it in a POST **body**, never a URL, header or query string, and never assigns it anywhere outliving the handler |
| Password attempts not rate-limited, AIE surface | **0** | Reuses FDH-5's certified limiter **unchanged**, and records the attempt **before** the decrypt is tried, so aborting a request cannot buy a free guess |
| **Password attempts not rate-limited, pre-existing II surface** | **NOT ZERO — `M2-OPEN-8`, disclosed** | `app/api/investment-intelligence/source-documents/[id]/process/route.ts` and the payslip / retirement / liability / investment services have **no rate limiting at all**. A real brute-force exposure on authenticated endpoints, outside this mission's scope, **not fixed** |
| Documents scanned for malware | **0 — and this is architectural, not a gap** | §6.2 |

---

## 21. Synthetic residue

**Production: ZERO. Verified fresh today, not inherited.**

| Production table | Rows |
|---|---|
| `aie_document_intake`, `aie_extraction_run`, `aie_unresolved_item`, `aie_review_decision`, `aie_field_candidate`, `aie_reconciliation_run`, `aie_mask_token_map`, `aie_masking_summary`, `aie_parser_attempt`, `aie_processing_transition`, `aie_write_batch`, `aie_ii_adapter_link`, `aie_insurance_adapter_link`, `aie_audit_event`, `aie_ai_cost_attempt`, `aie_ai_completion_attempt` | **0 each** |
| `ii_fund_holdings_snapshots`, `ii_fund_holdings_lines` | **0 each** |
| `aie_ai_cost_ledger` | **1** — migration `0150`'s own seed row (`id='global'`, `reserved_usd=0`, `settled_usd=0`, `total_attempts=0`, `updated_at=2026-09-14T06:48:58Z`), created the day **before** this mission began. **Not residue; not this mission's.** |

**DEV: zero from every harness's own tracked rows, and TWO named non-zero exceptions. This section
does not claim zero, because it is not zero.**

| DEV table | Rows | Assessment |
|---|---|---|
| `aie_document_intake`, `aie_extraction_run`, `aie_field_candidate`, `aie_parser_attempt`, `aie_unresolved_item`, `aie_reconciliation_run`, `aie_review_decision`, `aie_mask_token_map`, `aie_masking_summary`, `aie_ai_completion_attempt`, `aie_ai_cost_attempt`, `ii_ownership_allocation` | **0 each** | Clean after every matrix re-run this phase, independently re-queried |
| `ii_fund_holdings_lines` | **0** | Clean |
| **`ii_fund_holdings_snapshots`** | **19** | **`OPS-PC7-2` — the named, deliberate exception.** All 19 are R5 fixture headers with **zero constituent lines** and `source_id` NULL — exactly the shape that makes the look-through engine compute a *measured-looking* zero. PC7 **detects** them (`coverage_gaps`, reason `no_lines`) rather than hiding them, and deliberately does **not** delete them, because removing data an operator may rely on is not a certification phase's call. **Still present. Still not cleaned. Recommended cleanup; blocking nothing.** |
| **`aie_audit_event`** | **48** | **`OPS-M11-1` — a NEW finding this phase, not previously reported by any mission document.** |

### 21.1 `OPS-M11-1` — 48 orphan AIE audit events on DEV

The per-phase residue claims are **true as stated** — each harness counts and clears *its own*
rows and reports zero — but the aggregate DEV picture is not zero, and Part Z asks that this not be
papered over. Probed read-only:

| Breakdown | Count |
|---|---|
| Total `aie_audit_event` rows on DEV | **48** |
| Rows with **no `user_id`** (system sweep events — `mask_token_map_ttl_purged`) | **7** — unattributable to any tenant **by construction**, so no per-user teardown could ever remove them |
| Rows **with** a `user_id` whose parent intake row is **gone** | **41** — genuine orphans; of the 13 distinct `intake_id`s referenced, **0** still exist in `aie_document_intake` |
| Created **before** 2026-09-15 (the pre-existing AIE closure mission era, 2026-09-12 → 09-14) | **45** |
| Created **by this mission's own live-DEV runs today** | **3** |

**Root cause: `aie_audit_event` does not cascade from `aie_document_intake`**, and the live-DEV
teardowns scope their deletion to their own synthetic users, which cannot reach either the system
rows or rows whose parent is already gone. **DEV-only, no production equivalent (production holds
zero), and it blocks nothing** — but it is real accumulation, this mission contributed **3 of 48**,
and it is named here rather than reported as zero.

### 21.2 Repository residue

`scripts/ii-r5-certification/comparison_report.json` and
`scripts/ii-r6p1-certification/comparison_report.json` are rewritten as a side effect of running
the II suite; as in M1, M2 and M3, the diff is the `generatedAt` timestamp only — **every
certification figure reproduces byte-identically** — and both were **reverted, not committed.**

---

## 22. Remaining backlog

### 22.1 Migrations awaiting an operator

**Order matters: `0153`, `0154`, `0155`, then `0157`.** `0157` requires `0155` beneath it.

| Migration | DEV | PRODUCTION | What it unblocks |
|---|---|---|---|
| `0153_pc5_governed_resolution.sql` | **APPLIED** (this phase) | **PENDING** | PC5's entire decision write path. Without it every PC5 decision fails `PGRST204` |
| `0154_huf_entity_type_india_gate.sql` | **APPLIED** (this phase) | **PENDING** | HUF as an India-gated entity type, and the DB-level bypass guard |
| `0155_pc6_reference_market_data_foundation.sql` | **APPLIED** (this phase) | **PENDING** | PC6's 8 tables, the NAV precision widening, the no-future-date triggers, the admin capability |
| `0157_pc7_lookthrough_foundation.sql` | **PENDING** | **PENDING** | PC7's 13 snapshot + 5 line columns, `scheme_master_id`, the shared batch-ledger extension, `ii_pc7_networth_safety_violations()`, the admin capability, the DISABLED job row |

**Also queued for an operator, and NOT this mission's:**
`0156_app_review_0915_clear_leaked_migration_notes.sql` on branch
`fix/app-review-findings-2026-09-15` (`ea4c124`). Listed so the full picture is accurate; **must
not be applied as part of this mission's sequence.**

**Also unmerged but already applied to both databases:** the eleven-migration AIE block
`0140`–`0146`, `0149`–`0152` (§13.4). **Merge without renumbering.**
**Next genuinely free number: `0158`.**

### 22.2 AWS, credential and environment gaps

| ID | Item | Owner |
|---|---|---|
| **`PO-BLOCKER-1` / `OA-2b`** | **AWS S3 + GuardDuty.** Zero permissions beyond the implicit STS call; 16 candidate bucket names provably nonexistent against a controlled 403/404 discrimination. Needed: the **exact bucket name**, the **AWS account id** it lives in (if not the one these credentials belong to, credentials for that account are required), and either the drafted IAM policy attached to the existing identity or a new purpose-scoped one. **The runbook (`aie-document-quarantine-dev`) and the IAM policy (`fhip-aie-quarantine-dev`) still disagree on the name and must be reconciled.** Separately: the application has **no S3 code path at all** (no `aws-sdk` dependency), so credentials alone are necessary but not sufficient | PO / operator + engineering |
| **`OA-6`** | **`AIE_MASK_TOKEN_ENCRYPTION_KEY` is unset** — re-confirmed fresh today, absent from a 9-key `.env.local` and from the process environment. **Read §6.9 before supplying it:** it is now the *single* blocker on the AI path for FDH-bank and Insurance, two adapters this mission never exercised | PO / operator |
| **`OA-3`** | No way to read the **applied-migration ledger** (names + checksums) on either database. `supabase_migrations.schema_migrations` is not exposed via PostgREST (and returned HTTP 406 to the header-based probe from M7 onward), and no SQL-execution RPC exists. Every migration-state finding in this mission rests on **object-level probes with controls** instead, which is sound but cannot produce checksums | operator |
| **`OA-4`** | Four **function/trigger/policy-only** migrations (`0146`, `0147`, `0148`, `0151`) cannot be confirmed read-only. Resolved automatically once `OA-3` is available | operator |
| **`HK-1`** | The `doclife` git remote points at a path that no longer exists, so `git fetch --all` exits non-zero and will break any script that checks it | operator |

### 22.3 Product-Owner decisions still open

**HUF (`PO-PC5-1`) is CLOSED** — decided and shipped at M4B, and proven live this phase. Listed
only so it is not re-raised.

| ID | Decision | State |
|---|---|---|
| **`PO-PC6-1`** | **Benchmark index licensing.** NIFTY belongs to NSE Indices Ltd, SENSEX to BSE/Asia Index; neither is open data and the legacy unauthenticated endpoint no longer returns data. Either licence one, or accept that FHIP shows **no benchmark comparison for Indian mutual funds** — which today correctly reports `unavailable` for active return, beta, alpha, tracking error, information ratio, capture and the SIP benchmark comparison | **OPEN** |
| **`PO-PC6-2`** | **Risk-free source, tenor and gap-handling rule.** Three defensible candidates differing by **100–150 bp**, which visibly moves **every Sharpe and Sortino**. Genuinely a methodology decision, not a default. Once chosen, the only work is a governed methodology row plus an importer for that one source | **OPEN** |
| **`PO-PC7-1`** | **Licensing of AMC portfolio disclosures.** Needs a per-AMC decision, ideally with Indian counsel — the terms differ materially between publishers and one (SBI) robots-disallows its own canonical download URLs | **OPEN** |
| **`PO-PC7-2`** | **Or: license a commercial vendor** — ICRA Analytics, Accord Fintech, LSEG Lipper, Morningstar, CRISIL Intelligence. The only path with clean redistribution rights | **OPEN** |
| **`PO-PC5-3`** | **Name the PC5 consumer owner**, required by `AIE10-GOV-01`. PC5 now exists and still has no named owner. A minor governance-documentation item | **OPEN** |
| **`PO-BLOCKER-3`** | **What `labelsSeenRaw` means.** One reading hard-blocks AI fallback on essentially every real financial document, silently disabling the feature; the other needs label→value association the extractor does not produce. Left **inert rather than guessed** | **OPEN** |
| **`OA-1`** | **Supply, or confirm the non-existence of, PC4–PC7 original scope.** The PC8/PC9/PC10 third is discharged by Phase 9's demonstrated absence; the PC4–PC7 portion remains open, and PC4's ≥48-section spec is the one that blocks a terminal PC4 verdict outright | **PARTIALLY DISCHARGED** |
| **`OA-7`** | **Decide PC4 closure step 6** — run the reduced synthetic P01–P10 pack or formally drop it. If run: decide **DEV or production**, and authorise building the cleanup + zero-residue verification step 7 needs, **which does not exist today** (PC4-INV-16 is `NOT ENFORCED`) | **OPEN since 2026-09-07** |
| **`OA-8`** | **Map the CAMS statement to a household member in the app.** Clears `unresolved_owner` on all 17 production positions and most of the 120 open `owner_unmatched` cases. A user action inside the product, not an engineering change | **OPEN** |
| **`OA-9`** | **Decide the severity taxonomy for the 251 `unparseable_transaction_row` findings.** Needs `OA-1` to adjudicate. **Do not fix by weakening `certification.ts:65`** — that wiring is correct and PC4-INV-19 requires preserving it; the fix belongs at the parser's severity assignment | **OPEN** |
| **`OA-10` / `M3-F1`** | **Are the five residuals defects to fix or accepted variances to document?** With the CAS opening-balance discard now on the table as a concrete, testable hypothesis for residuals that previously had none | **OPEN** |
| **`RG-1`** | **The PC8/PC9/PC10 roadmap gap.** Options: (1) confirm the sequence legitimately ends at PC7; (2) supply specifications that exist somewhere this mission could not reach; (3) define them fresh as new work, explicitly **not** under the label "previously approved scope" | **OPEN** |

### 22.4 The traceability gap

| ID | Item |
|---|---|
| **`M5-BLOCKER-1`** | **AIE-1 requirement traceability, re-measured fresh this phase over 2,991 repository files: 361 of 2,214 traced (16.3%), 1,853 orphans.** Per phase: AIE-1.0 19.4%, AIE-1.1 22.9%, AIE-1.2 **8.4%** (the adapter this mission worked hardest on), AIE-1.3 11.0%, AIE-1.4 14.3%, AIE-1.5 29.5%, **AIE-1.6 9.8% with a strict score of 0.3%** — and AIE-1.6 is the *production cost, security and accuracy certification* phase, the one a terminal verdict most needs to discharge. **`liveDev` is ZERO for every phase**: not one AIE requirement id is cited in any `tests/live-dev/` suite, so L.3's live-DEV evidence column cannot be populated from evidence at all (`M5-OPEN-4`). **What this is NOT:** citation-based traceability is a proxy, and 16.3% is **not** a claim that 83.7% of AIE-1 is unimplemented — the conformance evidence in §6 plainly contradicts that reading. **What it IS:** the honest answer to the only question this can be automated to answer — *is any requirement completely unaccounted for?* For 1,853 of them, yes. **Phase 9's own forward-compatibility review suggested closing this gap may be the single most valuable unit of work available, ahead of any new feature, and this report agrees.** Needs either a Product-Owner decision that citation-level traceability is not required, or a real mapping pass |

### 22.5 Disclosed pre-existing PC4 defects (carried forward, deliberately not fixed)

| Item | State |
|---|---|
| **Axis `45773ec3` −156.618** and **Kotak `9a923d57` +111.505** | Reproduce **exactly**, re-verified live today. The Axis standalone-SIP-rejection hypothesis **failed to confirm** on the next two rejection pairs; Kotak's pre-2022 history **has never been examined**. `M3-F1`'s discarded-opening-balance hypothesis is a **candidate for both**, untested against real data |
| **`948fb23a` −12.932, `385feb70` −4.457, `76c30cb9` −2.678** | Reproduce exactly. **No hypothesis exists for any of them** other than `M3-F1` |
| **0 of 17 production positions certified** | Re-verified live today. Three blockers on all 17, including the 12 at variance `0.000` |
| **251 benign rows emitted at severity `error`** | The system and PC4's own Section 3 accounting disagree about the same 251 rows (77 boilerplate, 84 lifecycle markers, 90 regulatory footnotes). `OA-9` |
| **`request_reprocessing`** | Offered in nearly every `permittedActionTypes` and `allowedActions` array **and implemented by nothing, repo-wide.** `VALID_ACTIONS` on the generic decide route is `['correct','not_present','defer']`. A future phase reading the registries would reasonably assume it works (`FC-7c`) |
| **`M2-OPEN-8`** | **No rate limiting** on the pre-existing II password endpoint, nor on the payslip, retirement, liability and investment services. A real brute-force exposure on authenticated endpoints |
| **`M3-OPEN-3`** | `.env.local` is **UTF-8 with a BOM and CRLF**; the 9 pre-existing live-dev suites parse it with `split('\n')` plus a `(.*)$` regex, and because JavaScript's `.` does not match `\r` that combination matches **ZERO keys** and produces an empty environment **with no error at all** |
| **`CG-10`** | Two parse runs sharing an identical `storage_path` cause a second document's "Process" button to hit the **first** document's run. Open on the **old** II path, unowned, untested. The new AIE path is keyed on an immutable intake UUID and does not have it |
| **`M1-F4`** | 964 transactions parsed vs 952 persisted. **Consistent with** the in-run fingerprint collision guard collapsing exact duplicates within a single import — correct behaviour — but **not independently verified**, because doing so requires reading the Product Owner's real transaction rows. An open observation, **not asserted as a defect** |

### 22.6 Disclosed engineering gaps (no PO decision needed)

`M2-OPEN-1` (accept/reject CAS edges missing from the `aie_processing_transition` audit table) ·
`M2-OPEN-2` (`purge_status` has no transition table or validator) ·
`M2-OPEN-3` (`computeUserFacingStateForIntakeWithoutRun` omits `'ready'` and throws on it) ·
`M2-OPEN-4` (no `import 'server-only'` guard in `lib/aie`; AIE secrets undocumented in
`.env.example` / `ENVIRONMENT_VARIABLES.md`) ·
`M2-OPEN-5` (retry-loop token usage under-settled — final attempt only; under-counts cost, never
over-admits) ·
**`M2-OPEN-6`** (`app/api/aie/fdh-bank/intake/route.ts` auto-commits a canonical write at intake,
bypassing `accept.ts` — the exact pattern the Insurance route explicitly removed as an AIE-1.5
violation; **no phase has touched this route**) ·
`M3-OPEN-1` (no II parser declares an AI-eligible gap, so masking and AI fallback are
*structurally unreachable* for Investment Intelligence) ·
`M3-OPEN-2` (the address rule masks only the first line of a multi-line address) ·
`M5-OPEN-1` (a meaningful axe pass over PC5's resolution states needs the app stood up; the `0153`
half of that blocker has now cleared) ·
`M5-OPEN-2` (**no accuracy corpus exists for FDH-bank or Insurance** — no measurable precision,
recall, false-accept rate or cost profile; their verdicts are inherited unexamined) ·
`M5-OPEN-3` (rollout configuration changes are **not audited**) ·
`M5-OPEN-4` (zero AIE requirement identifiers cited in any live-DEV suite) ·
`FC-7a` (`aie_unresolved_item.severity` is a closed two-value CHECK; a third severity needs a
migration, unlike `reason_code`, which is free) ·
`FC-7b` (`AieReviewActionType` is a closed union; a new affordance is a type change plus a
resolver plus UI) ·
`FC-7d` (two decision routes now write the same table) ·
`FC-7e` (migration numbering is a live collision hazard — **six** sibling-branch collisions
historically; re-verify against all refs at implementation time, never trust a carried-forward
number) ·
`FC-7f` (**no PC scope has ever been committed to this repository** — the root cause of the entire
PC8–PC10 problem; committing a future PC8 spec to `docs/` would prevent recurrence) ·
`OPS-PC7-2` (19 orphan snapshot headers on DEV) ·
**`OPS-M11-1`** (48 orphan `aie_audit_event` rows on DEV, §21.1) ·
Incidental PC6 findings: DEV fixture ISINs that fail their ISO 6166 check digit; cron-auth
documentation drift (`Authorization: Bearer` in the docs vs `x-cron-secret` in the code, which has
always been the code's behaviour); a stale `scripts/db-rebuild-check/README.md`; and the fact that
**no existing cron job in this repository has a kill switch or a job-run ledger** — PC6 introduced
the first, for its own jobs only.

---

## 23. Final production decision

> ## FHIP INVESTMENT INTELLIGENCE + AIE-1 POST-PC4 PROGRAMME — CONDITIONAL PASS. NOT PRODUCTION READY. NO PRODUCTION AUTHORITY EXERCISED OR REQUESTED.
>
> **The programme is not approved for production activation, and this report does not activate,
> deploy, merge, push or enable anything.** Per the binding override governing this phase, that
> decision is reserved for a human-present follow-up after this report reaches the Product Owner —
> and it would have been reserved even if the verdict had come out unconditional.
>
> **Eight named blockers stand between this work and production**, set out in §1 and detailed
> throughout: no malware scanning exists and cannot exist in the posture production would run in;
> `AIE_MASK_TOKEN_ENCRYPTION_KEY` is unset and supplying it lights up two adapters this mission
> never exercised; `0157` is unapplied everywhere and `0153`/`0154`/`0155` are unapplied on
> production; requirement traceability is 16.3% with 1,853 orphans; three PO licensing and
> methodology decisions are open and are commercial rather than technical; PC4's certification
> objective remains unmet with 0 of 17 positions certified; the FDH-bank and Insurance adapters
> were never built or certified by this mission despite being in its brief; and PC8–PC10 have no
> approved scope at all.
>
> **Deferred and prohibited classes are explicitly outside any certified enabled scope and are
> disabled**, as required: 8 AIE-1.4 document classes DEFERRED and 1 — identity / medical / legal
> / sensitive — **PROHIBITED** by binding exclusion. No ingestion path exists for any of them and
> none was built.
>
> **Production enablement state: everything OFF, at four independent layers** — not merged to
> `main`; not deployed; every one of the 27 `AIE_*` flags defaults OFF; and, until this mission's
> own `amplify.yml` fix (committed locally, **not deployed**), no `AIE_*` variable could reach the
> production runtime at all even if set in the console.
>
> **All work is committed to `mission/m11-final-certification-2026-09-15` and left unpushed.**

### 23.1 If you want to proceed to production — the exact order of operations

**Nothing below has been done, and none of it should be done autonomously.** Steps A and B are
decisions and provisioning; C is a review session; D is the first point at which anything reaches
`main`; E is the first point at which anything reaches production.

---

#### A. Decisions and credentials needed FIRST — nothing downstream is safe without these

| # | What | Why it must come first |
|---|---|---|
| **A1** | **Decide `RG-1`** — confirm the phase sequence legitimately ends at PC7, or supply PC8–PC10 scope, or define them fresh as new work. | Everything else assumes PC7 is terminal. |
| **A2** | **Answer the AWS question (`PO-BLOCKER-1`)**: the exact bucket name, the AWS account id it lives in, credentials or a purpose-scoped identity for **that** account, and a reconciliation of `aie-document-quarantine-dev` vs `fhip-aie-quarantine-dev`. | Without it there is no malware scanning at all, and §6.2's consequence is unavoidable: **any** AIE production activation requires explicitly opting into the no-scanner posture. **Decide consciously whether that is acceptable.** Note that even perfect credentials are not sufficient — the application has **no S3 code path**, which is engineering work nobody has scoped. |
| **A3** | **Decide `PO-PC6-1`** (index licensing) and **`PO-PC6-2`** (risk-free source, tenor, gap rule). | Until decided, every benchmark-relative metric and every Sharpe/Sortino correctly reports `unavailable`. `PO-PC6-2` in particular is a **methodology** choice worth 100–150 bp that moves every risk number a user will see. |
| **A4** | **Decide `PO-PC7-1` / `PO-PC7-2`** (per-AMC disclosure licensing, ideally with Indian counsel, **or** a commercial vendor). | Until decided, PC7 ingests zero real disclosures and the look-through surface has no data. |
| **A5** | **Decide `M5-BLOCKER-1`** — either that citation-level traceability is not required, or commission a real mapping pass. | A terminal certification cannot honestly discharge 2,214 requirements on evidence connected to 361. **This is also, on Phase 9's assessment and this report's, the single highest-value next unit of work available.** |
| **A6** | **Decide `OA-1`, `OA-7`, `OA-9`, `OA-10`** (PC4's spec, the P01–P10 pack, the 251-row severity taxonomy, and whether the five residuals are defects or accepted variances), and **do `OA-8`** — map the CAMS statement to a household member in the app. | `OA-8` alone clears `unresolved_owner` on all 17 production positions and most of the 120 open cases. The rest gate any terminal PC4 verdict. |
| **A7** | **Name the PC5 consumer owner (`PO-PC5-3`)** and **decide `PO-BLOCKER-3`** (`labelsSeenRaw` semantics). | Minor, but `AIE10-GOV-01` requires the first, and the second must not be guessed. |
| **A8** | **Provision `AIE_MASK_TOKEN_ENCRYPTION_KEY`** (64 hex chars / 32 bytes) in DEV and production — **but read §6.9 first.** | It is the *single* blocker on the AI path for **FDH-bank and Insurance**, whose AI fallback this mission never exercised and whose privacy proof reads **NOT EXERCISED**. Provisioning it while those adapters' flags are OFF is safe; provisioning it and then enabling them is not, until they have an accuracy corpus (`M5-OPEN-2`). |

---

#### B. Apply the remaining DEV migration and re-run what it unblocks

| # | Action |
|---|---|
| **B1** | **Apply `0157_pc7_lookthrough_foundation.sql` to DEV.** `0153`, `0154` and `0155` are already applied there. `0157` requires `0155`, which is present. |
| **B2** | Re-run `node scripts/pc7_0157_pglite_verification.mjs` (expect **44/44**) and then the currently-blocked PC7 live proofs: O.4's column set, O.5's `ii_scheme_master` read path, and O.9's admin surface end to end. These are the only PC7 items still proven at schema level only. |
| **B3** | Grant the two admin capabilities to the intended operator(s) — they are **deliberately separate**, so that someone may be trusted with fund-portfolio quality without the market-data feeds and vice versa: `update admin_users set can_view_reference_data_quality = true where user_id = '<id>'` and the same for `can_view_lookthrough_data_quality`. |
| **B4** | Re-run the full evidence set on DEV to confirm nothing regressed: PC5 matrix (expect **54/54 FULL**), HUF matrix (expect **15 PASS / 1 N/A**), PC6 live matrix (**41/41**), PC6 activation (**24/24**), PC7 net-worth safety (**19/19**), AIE M3 dispatch (**6/6**), and the PC4 19-invariant contract (**84 passed / 1 skipped / 1,673 passed / 0 failed**). |
| **B5** | Optionally clean `OPS-PC7-2` (19 orphan snapshot headers) and `OPS-M11-1` (48 orphan audit events) on DEV. **Both are DEV-only and block nothing**; the snapshot headers are the shape that makes the engine compute a measured-looking zero, so cleaning them improves signal. |

---

#### C. What a human-present merge/push session would need to do

**This is the first point at which anything leaves this local branch. None of it has been done.**

| # | Action |
|---|---|
| **C1** | **Re-fetch `origin/main` and re-measure.** It was `23b49da1d63c9c20f980ea9042e176845b6f60e3` at the end of this phase and has not moved since M0 — but M0 itself recorded it moving six commits mid-phase. **Never trust a carried-forward SHA.** |
| **C2** | **Re-verify the next free migration number against ALL refs**, not against `main`'s tooling, which under-reports because `0149`–`0152` are applied to two shared environments while absent from `main`. It is `0158` today. **Six sibling-branch collisions have occurred historically** (`FC-7e`). |
| **C3** | **Merge the eleven-migration AIE block (`0140`–`0146`, `0149`–`0152`) onto `main` WITHOUT RENUMBERING.** Every one is already applied to DEV **and** production. Re-emitting effects forward is the only legal correction if anything is wrong with any of them. |
| **C4** | **Review the 325 changed files / 65,672 insertions**, with particular attention to: `amplify.yml` (the whole-`AIE_`-prefix forwarding, and **why a partial list is a fail-open trap** — §6.13); `lib/aie/db/repository.ts` (`updateIntakeStatus`'s new CAS); `lib/aie/services/purge.ts` (the three checked update results); `lib/aie/masking/identifierToken.ts` (the one-way HMAC) and the **deletion** of `tokenMapCrypto.ts`; and `app/api/aie/fdh-bank/intake/route.ts`, which **no phase touched** and which still carries `M2-OPEN-6`'s intake-time canonical write. |
| **C5** | **Run the full suite on the merge result and require the pre-existing baseline exactly: 17 files / 39 tests.** `paymentsCheckoutRoute` and `g3RegistrationAlignment` are both documented parallel-execution flakes; **verify any extra failure in isolation before accepting it**, and verify any *reduction* too. |
| **C6** | **Run the 9 `tests/live-dev/*.test.ts` files explicitly.** `vitest.config.ts` includes only `tests/unit/**`, so `npm test` does **not** run them, and PC4-INV-06 (CAS↔Folio overlap), INV-10 (read-side immutability), INV-14 (cross-user/storage isolation) and INV-17 (wrong-password atomicity) are covered **only** there. M3 added `vitest.live-dev.config.ts` so this is one documented command. **A reviewer who runs `npm test`, sees green, and stops has not regression-tested those four.** |
| **C7** | **Do NOT cite PC4-INV-12 (owner mismatch) or PC4-INV-16 (production cleanup) as pre-existing guarantees.** INV-12's mismatch half was built for the first time by PC5; INV-16 **does not exist at all** — there is no PC4/production synthetic-data cleanup mechanism and no zero-residue verification anywhere in this repository. |
| **C8** | **Push and merge only after C1–C7.** This mission has pushed nothing; `origin/main` is unchanged *because of* that, and the merge is a deliberate human act, not a continuation. |

---

#### D. Production migrations — after the merge, in this exact order

**Apply `0153`, then `0154`, then `0155`, then `0157`.** `0157` requires `0155`.
**Do NOT apply `0156`** — it belongs to `fix/app-review-findings-2026-09-15` and is not this
mission's (§13.3). Take a backup first; note that `OA-3` means the applied-migration ledger cannot
be read back from this environment, so **verification must be done by the operator's own tooling**,
not by re-running this mission's probes alone.

`0155`'s one change worth spot-checking afterwards:

```sql
select numeric_precision, numeric_scale from information_schema.columns
where table_name = 'ii_prices_nav' and column_name = 'price';   -- expect 24, 10

select job_key, enabled from ii_reference_job_control;          -- expect ALL rows enabled = false
```

---

#### E. Production activation — the order that keeps the gate closed until you mean to open it

**Nothing here is authorised by this report, and every step is reversible only if taken in this
order.**

| # | Action |
|---|---|
| **E1** | **Deploy the merged `main`** (Amplify auto-deploys). **Verify the `amplify.yml` fix actually took effect** — that `AIE_*` variables now reach the server runtime — **before setting a single flag.** This is the exact defect class that made G4/G5B provably OFF at runtime across multiple redeploys while the console said otherwise. |
| **E2** | **Set the cohort variables TOGETHER, never one at a time**: `AIE_PILOT_COHORT_ENFORCED=true` **and** `AIE_PILOT_COHORT_USER_IDS` / `AIE_PILOT_COHORT_EMAILS`, **before** `AIE_DOCUMENT_INTAKE_ENABLED`. `isUserInAiePilotCohort()` returns **true for everyone** when `AIE_PILOT_COHORT_ENFORCED` is unset. **Enabling intake first turns an allowlisted pilot into a rollout to every user.** |
| **E3** | **Decide `AIE_ALLOW_MISSING_SIGNATURE_SCANNER` consciously and in writing.** With it unset, every document is rejected at admission and AIE intake does nothing at all. With it set, **no malware scan runs on any uploaded document.** There is no third option today. This is the decision `A2` exists to inform. |
| **E4** | **Enable one adapter at a time, starting with Investment Intelligence** — the only one this mission built, exercised and measured. **Do not enable FDH-bank or Insurance until they have an accuracy corpus** (`M5-OPEN-2`) and until `M2-OPEN-6` (the FDH intake-time canonical write that bypasses the acceptance gate) is resolved. |
| **E5** | **Leave AI fallback OFF.** `AIE_AI_FALLBACK_ENABLED` and `AIE_AI_PROVIDER` are separate switches from intake, deliberately. Investment Intelligence's deterministic path needs neither, and turning them on lights up the FDH-bank and Insurance AI paths whose privacy proof reads **NOT EXERCISED**. |
| **E6** | **PC6's scheduled ingest stays OFF.** `0155` deliberately registers **no** `cron.schedule` and both control rows ship `enabled = false`. The runbook §9 has the exact statements; run a `dryRun` first, watch it for a day, then flip the kill switch on. **PC7's job row ships disabled too**, and must stay disabled until `A4` is decided. |
| **E7** | **Rollout configuration changes are NOT audited (`M5-OPEN-3`).** Nothing records who changed a flag, when, or from what to what. **Until CloudTrail access or a database-backed flag store exists, keep a manual written record of every flag change**, or you will not be able to reconstruct what was enabled when. |

---

### 23.2 The honest summary, in one paragraph

This mission did a large amount of real work and found real problems that mattered — an
inoperable production kill switch with a fail-open partial-remediation trap behind it, a
reconciliation that silently never ran on a user's first upload, a purge sweep writing false audit
events in an unbounded loop, a holder name going verbatim to OpenAI, a folio number left in the
clear once per transaction in an extract whose summary had just masked it, a NAV column that would
have silently rounded 3.1% of the real Indian mutual-fund universe, an X-Ray source label that was
true of everything and informative about nothing, and a model pin that would have 403'd every real
AI call. It built PC5, HUF, PC6 and PC7 from nothing but a one-line label and this mission's own
dispatch, and proved the boundaries that matter most — net-worth safety, cross-tenant isolation,
one-way masking, purge ordering — live, with controls, against real databases. **It also could not
close a single one of the external blockers, because not one of them is an engineering problem:
they are an AWS account, a secret, four migrations needing an operator, three licensing and
methodology decisions, and a specification that was never written down.** That is why this is a
CONDITIONAL PASS, and why the next most valuable thing anyone could do with this codebase is
probably not a feature at all — it is closing the traceability gap, and committing the next PC
specification to the repository so this never happens again.

---

*Branch `mission/m11-final-certification-2026-09-15`, branched from
`d1a95493f37d05cff83327966cfe172b02ba6552`. Not pushed. Not merged. No production database,
configuration, migration, deployment or rollout was touched by this phase.*
