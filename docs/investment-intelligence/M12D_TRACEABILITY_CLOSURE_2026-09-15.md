# M12 Phase D — Traceability Closure

**Mission section:** 17 — "TRACEABILITY — MUST BE CLOSED"
**Branch:** `mission/m12d-traceability-2026-09-15`, from M12C's `c98a78fb8d840e33bafc6f1b6ee8392c147f2e31`
**Date:** 2026-09-15 (authored 2026-09-16)
**Scope:** documentation and citation only. No source logic changed, no migration,
no database touched, no external call, nothing pushed, nothing merged, no
production contact of any kind.

**Deliverable:** `docs/aie-programme/AIE_1_REQUIREMENT_TRACEABILITY_FINAL_2026-09-15.md`
(2,284 rows, ~1.1 MB).

---

## 1. Verdict

**Traceability is closed in the only sense that can honestly be claimed: every one
of the Product Owner's 2,284 numbered AIE requirements now has a row, a status, a
named basis and a stated reason. Orphans: zero.**

It is **not** closed in the sense of "2,284 requirements are implemented and
proven". 193 of them — 8.4% — are recorded as `UNVERIFIED`, meaning no artifact
was found and none was invented. Those 193 are the honest deficit, they are
enumerated by reason in section 3 of the matrix, and they are the most useful
output of this phase.

`M5-BLOCKER-1` ("AIE-1 requirement traceability is 16.3% with 1,853 orphans")
is **discharged**. `M5-OPEN-4` ("zero AIE requirement ids are cited in any
live-DEV suite") is **closed**.

---

## 2. The denominator was wrong, and this phase corrected it upward

Every prior phase reported **2,214**. The real number is **2,284**.

`scripts/m5_aie_traceability_matrix.mjs` extracts requirement ids with
`/\b[A-Z][A-Z0-9]{1,9}-[A-Z]{2,6}-[0-9]{2,3}\b/`. The middle segment is
letters-only, so every requirement whose family contains a digit was silently
dropped. Re-extracting from the Product Owner's own seven files in
`C:\Users\user\Downloads\` — by counting the `### <id> — <title>` headings the
documents themselves use, not by regex-guessing — recovers 70 requirements:

| Family | Count | What was being missed |
|---|---:|---|
| `AIE10-PC6-01..10` | 10 | The **binding PC6 exclusion contract**, which the M0 scope ledger itself quotes at `II_POST_PC4_MASTER_SCOPE_LEDGER_2026-09-15.md:72`. |
| `AIE12-PC5-01..12` | 12 | The II adapter's PC5 consumption block. |
| `AIE15-PC5-01..12` | 12 | The **binding PC5 boundary contract** — the implementation half of `AIE10-EXC-08/09/10`. |
| `AIE16-PC5-01..12` | 12 | PC5 single-exception-system certification. |
| `AIE16-PC6-01..12` | 12 | PC6 separation certification. |
| `AIE15-A11Y-01..12` | 12 | Accessibility — precisely the area M12C spent a whole section proving. |

The old count also included 18 `ADR-AIE-*` register entries, which are
deliverables rather than numbered requirements; they are retained and classified.

The reconciliation is exact: 2,214 = 2,196 (regex-visible AIE ids) + 18 ADRs;
2,284 = 2,266 (all AIE ids) + 18 ADRs; 2,266 − 2,196 = 70.

**Every percentage any earlier phase quoted was computed against a denominator
3.1% too small.** The correction makes this phase's job harder, not easier, which
is why it is reported rather than quietly adopted.

---

## 3. The TRUE final numbers

| | |
|---|---:|
| Requirements in the Product Owner's specifications | **2,284** |
| Classified with a real, named, checkable basis | **2,091 — 91.6%** |
| Honestly `UNVERIFIED` (no artifact exists; none invented) | **193 — 8.4%** |
| **Orphan / unaccounted for** | **0** |

### 3.1 By status

| Status | Count | Share |
|---|---:|---:|
| CODE | 612 | 26.8% |
| TEST | 1,152 | 50.4% |
| LIVE DEV | 167 | 7.3% |
| DECISION (named Product-Owner decision pending) | 29 | 1.3% |
| DEFERRED (named deferral, reason quoted) | 105 | 4.6% |
| PROHIBITED (binding spec exclusion) | 13 | 0.6% |
| NOT APPLICABLE (resolved by design, no subject) | 13 | 0.6% |
| **UNVERIFIED** | **193** | **8.4%** |
| **Total** | **2,284** | **100.0%** |

### 3.2 By evidence grade — the number that matters most

| Grade | Meaning | Count | Share |
|---|---|---:|---:|
| **A** | Requirement id cited at a specific `file:line`, and the artifact demonstrably addresses the subject | 239 | 10.5% |
| **B** | A named artifact was verified in this phase to implement/test the family's subject; this individual member was not separately re-proved | 1,681 | 73.6% |
| **C** | A governed decision, deferral, prohibition or exclusion resolves it, named and quoted | 171 | 7.5% |
| **D** | No artifact found — status `UNVERIFIED` | 193 | 8.4% |

**Grade B is the honest majority and should be read as what it says.** It means
"this requirement's subject is implemented and the implementing artifact is
named", not "this requirement was individually re-certified today". A reader who
wants the strongest-possible reading of this phase should read **239 (10.5%)** as
the requirement-level-proven figure and treat B as traceable-but-not-recertified.
Both numbers are stated so neither has to be inferred.

### 3.3 By phase

| Phase | Reqs | CODE | TEST | LIVE DEV | DECISION | DEFERRED | PROHIBITED | N/A | UNVERIFIED |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| AIE-1.0 | 268 | 200 | 17 | 5 | 9 | 1 | 0 | 0 | **36** |
| AIE-1.1 | 332 | 135 | 128 | 12 | 3 | 0 | 0 | 0 | **54** |
| AIE-1.2 | 346 | 47 | 286 | 12 | 0 | 0 | 0 | 0 | **1** |
| AIE-1.3 | 346 | 22 | 300 | 23 | 0 | 0 | 0 | 0 | **1** |
| AIE-1.4 | 286 | 59 | 85 | 34 | 0 | 84 | 12 | 12 | **0** |
| AIE-1.5 | 346 | 95 | 190 | 20 | 0 | 0 | 0 | 1 | **40** |
| AIE-1.6 | 360 | 54 | 146 | 61 | 17 | 20 | 1 | 0 | **61** |

AIE-1.6 carrying the largest unverified count is the expected and correct shape:
it is the **production** cost/security/accuracy certification phase, and this
programme has never held production authority.

### 3.4 Against the previous measurement

| | M5 | M12D |
|---|---|---|
| Denominator | 2,214 (regex-truncated) | **2,284** |
| Method | does this identifier appear anywhere in the repo? | does a named artifact discharge it, or is there a named reason it does not? |
| Traced | 344–361 (15.5–16.3%) | **2,091 (91.6%)** with a named basis |
| Orphans | 1,853–1,870 | **0** |
| Live-DEV requirement-id citations | **0** | **22** |

The jump is a change of question, not a change of arithmetic. M5 measured
citation presence, which for this codebase is mostly absent because it cites
requirements in prose and in short form. This phase adjudicates each requirement
against real artifacts. The cost of that method is grade B, and it is disclosed
rather than averaged away.

---

## 4. Requirement-id citations added to real files

**91 id citations across 27 files** — 19 unit suites, 2 live-DEV suites, 6
live-DEV scripts. Every id was checked against that file's actual assertions and
carries a one-line gloss of what it proves.

| Where | Files | Citations |
|---|---:|---:|
| `tests/unit/**` | 19 | 64 |
| `tests/live-dev/**` | 2 | 8 |
| `scripts/` live-DEV verification scripts | 6 | 19 |
| **Total** | **27** | **91** |

Six of the 91 are **negative** citations — an explicit note that the file does
*not* discharge a neighbouring requirement, so a future reader cannot assume it
does:

- `tests/unit/m12aFdhBankAccuracyCorpus.test.ts` → `AIE13-MET-10` **not**
  discharged (no coordinate model; the bridge reports `sourcePage: 1` for every row).
- `scripts/m12c_pc5_accessibility_live_dev.ts` → `AIE15-A11Y-08` **not**
  discharged (axe returned `color-contrast` INCOMPLETE on all seven states) and
  `AIE15-A11Y-12` **not** discharged (no screen reader is drivable here).
- `tests/unit/aieGuardDutyScanResultHandler.test.ts` → `AIE11-QUA-03` /
  `AIE16-PDF-08` proved for the **decision function only**, which has zero
  production callers and no scanner behind it.
- `tests/unit/m12cServerOnlySecretBoundary.test.ts` → `AIE16-CFG-04` conditional,
  because the canonical `server-only` package is not installed.

### 4.1 Disclosure: this phase grades its own citations

Adding those ids raises the matrix's own grade-A count, because grade A is partly
earned by an id appearing at a real `file:line`. The honest numbers:

| | Grade A rows |
|---|---:|
| Before this phase's annotations | 201 |
| After | **239** |
| Delta attributable to this phase's own citations | **+38** |

Each of the 38 is a citation this phase wrote and verified against the file's
assertions. A reader who regards a self-added citation as weaker evidence should
read the delta as grade B, giving 201 A / 1,719 B. The point of stating it is
that no one should have to reverse-engineer it.

All 27 edits are **comment-only**. No assertion, import or statement was changed.

---

## 5. The 193 unverified requirements — where they actually are

Grouped by cause rather than by id (the matrix enumerates every id individually
in its section 3):

Counts below are the real per-family tallies from the generated matrix, not
estimates.

| Cause | Requirements | Note |
|---|---:|---|
| **The 18 `ADR-AIE-*` deliverables were never authored** | 18 | Verified: zero `ADR-AIE-*` artifacts exist anywhere under `docs/`. Several of the decisions were genuinely made and implemented; the required artifacts do not exist. |
| **No table / layout extraction subsystem** — `AIE11-TAB-01..12` | 12 | AIE-1.1 core has no table, row, cell or reading-order model. The adapters consume already-certified domain parsers that do their own row reconstruction. |
| **No notifications or reminders** — `AIE15-NOTIF-01..12` | 12 | Re-entry works (the inbox is durable); reminders and notifications were never built. |
| **No responsive / mobile testing** — `AIE15-MOB-01..12` (+ `AIE15-A11Y-10`, `AIE16-REV-11`) | 14 | The components use the design system's responsive primitives; no mobile-viewport test or live-DEV mobile scenario exists for the AIE review surface. |
| **No performance, pagination or capacity measurement** — `AIE15-PERF-01..12` + `AIE16-LOAD-01..12` | 24 | No load test, latency measurement or capacity model exists anywhere for AIE. |
| **No alerting, dashboards or monitoring** — `AIE16-OBS-01..12`, `AIE11-OBS-*` (3), `AIE10-AUD-*` (3) | 18 | Audit events exist; nothing consumes them. |
| **No OCR subsystem** — `AIE11-OCR-*` (11 of 12) plus OCR-dependent `AIE16-COST-02`, `AIE16-OUT-03`, `AIE16-PDF-07` | 14 | Confirmed by search this phase and independently recorded as `M12A-O3` / `M12B-O6`. A scanned PDF is refused with `insufficient_text` — which is why `AIE11-OCR-11` ("handle OCR failure as a safe terminal outcome, not blank success") is the one member that *is* satisfied. |
| **No queue / worker / lease subsystem** — `AIE11-JOB-*` (11 of 12) plus `AIE16-IDEM-02/03`, `AIE16-OUT-05/06`, `AIE16-KILL-09` | 16 | Processing runs inline in the request path plus one cron purge sweep. `AIE11-JOB-04` (idempotency) *is* satisfied, in SQL, by migration `0152`. |
| **Local text extraction is thinner than its own header claims** — `AIE11-TXT-02/03/04/05/06/10/11` | 7 | Adjudicated against the 90-line module rather than its `"(TXT-01..12)"` header comment. |
| **No coordinate model, as a consequence** — `AIE12-MET-09`, `AIE13-MET-10`, `AIE15-A11Y-09`, `AIE16-REV-03` | 4 | Nothing to measure evidence-coordinate correctness against. |
| **Build/supply-chain artifacts never produced** — `AIE16-BUILD-06/07/09/10` | 4 | No SBOM, no advisory review, no upgrade-from-existing-state test, no executed rollback drill. |
| **Kill-switch and rollback drills never run** — `AIE16-KILL-08/11/12` (+`KILL-09` above) | 3 | Kill switches themselves are real and tested; the drills are not. |
| **Corpus governance gaps** — `AIE16-CORP-06/07/08` | 3 | No sealed holdout set, no independent annotator, no adjudication process. The oracles *are* sealed before results — a real and disclosed mitigation, not a substitute. |
| **Accessibility residue** — `AIE15-A11Y-08/09/12` (`A11Y-10` is counted in the mobile row above, not twice) | 3 | `color-contrast` INCOMPLETE on all seven states; no screen reader drivable; no coordinate description. |
| **Architecture-lint rules never written** — `AIE11-MOD-05/06/10` | 3 | Real per-file guards exist (`aieIiAdapterProhibitions.test.ts`); an architectural rule does not. |
| **Cost modelling never done** — `AIE16-COST-01/05/06/07/08` + `AIE10-COST-02/04/09` | 8 | Only token price was ever measured. |
| Remainder — individually named single items | 30 | e.g. `AIE10-GOV-04` (no RACI), `AIE10-PRIV-10/11` (no PIA, no DSAR), `AIE10-TRUST-07/09` (no egress allowlist, no break-glass), `AIE10-RET-08/09` (no backup window, no legal hold), `AIE10-SEC-12` (no supply-chain response), `AIE11-REG-08` (no parser time/memory limits), `AIE11-QUA-09/12` (no EICAR, no scanner-positive path), `AIE10-CONF-07` (no confidence calibration), `AIE16-PRIV-09/11`, `AIE16-RUN-11/12` (no drills), `AIE16-OTH-10`, `AIE16-AUTH-08`, `AIE16-CFG-08`, `AIE16-RET-10/11`. |

The pattern is worth naming plainly: **the unverified set is not scattered
randomly. It clusters on four subsystems that were never built (OCR, queue/worker,
coordinate model, observability) and on the governance and legal artifacts that no
engineering phase can produce.** That is a more actionable finding than a
percentage.

---

## 6. Categories that were structurally hard to trace, and why

1. **AIE-1.0's 250 requirements are architecture-*definition* obligations.** Each
   asks for a target rule plus an ADR/diagram/contract/matrix artifact. In most
   cases the *technical control* exists and is citable while the *documentary
   artifact* does not. The matrix credits the control and says so; it does not
   pretend the ADR exists. This is why AIE-1.0 shows 200 CODE and 36 UNVERIFIED
   rather than a clean split.

2. **Range citations in file headers are unreliable and had to be adjudicated
   against the source.** `lib/aie/extraction/textExtraction.ts` says
   `"(TXT-01..12)"`; reading all 90 lines shows it implements four of the twelve.
   The matrix credits `TXT-01/07/08/09` and marks seven UNVERIFIED, **against the
   file's own claim**. Honouring header ranges wholesale would have produced a
   green table that meant nothing — which is the exact failure mode the dispatch
   warned about.

3. **Short-form citations are ambiguous.** The codebase writes `GW-03`, `PII-06`,
   `COST-08`. `COST-01` is defined by four different phases. This phase counted a
   short form only where the family is unique to one phase across the whole
   inventory (1,224 of the ids qualify); the rest were discarded rather than
   credited four times.

4. **A citation inside a mission report is not implementation evidence.** The
   grader deliberately excludes `docs/` hits from grade A — otherwise the mission
   citing its own requirement ids would inflate the score. Those rows read
   *"id cited only in a mission report — not implementation evidence"*.

5. **Certification requirements that presuppose production.** Roughly a fifth of
   AIE-1.6 asks for drills, canaries, sign-offs and contractual verifications that
   no DEV-only phase can perform. These are `DEFERRED` with the production
   override quoted, not `UNVERIFIED` — the distinction is that the reason is
   governed, not missing.

6. **Self-contamination.** The M5 script's own output file lived under a scanned
   root and made a second run report 100% coverage with zero orphans. This phase
   excludes both the M5 JSON and its own output file by name, and re-derives the
   inventory from the specifications rather than from any prior artifact.

---

## 7. Governing decisions applied, as instructed

| Instruction | What was actually found |
|---|---|
| PC8/9/10 requirements → `DEFERRED` with that exact reason | **Zero of the 2,284 belong to PC8/9/10.** The seven AIE files define AIE-1.0–1.6 only. Nothing was forced into that bucket to make the instruction fit. |
| PC6 benchmark/risk-free → `DECISION`, citing the exact decision item | Applied where it genuinely bites: `AIE16-PC6-08` (benchmark half unrunnable — `PO-PC6-1`, NIFTY/SENSEX are licensed and not open data) and `AIE10-PC6-10`. The **separation** requirements (`AIE10-PC6-01..09`, `AIE16-PC6-01..07/09..12`) are genuinely evidenced and are **not** marked DECISION — marking a proven control as a pending decision would be its own inaccuracy. |
| PC7 disclosure-licensing → `DECISION` | **No AIE requirement depends on it.** `PO-PC7-1`/`PO-PC7-2` govern PC7's own Part O item set, not this requirement universe. Recorded rather than applied cosmetically. |
| `labelsSeenRaw` → classify per its own non-load-bearing status | Applied at `AIE10-MASK-09` and `AIE11-PII-10` as `DECISION` citing `PO-BLOCKER-3`, and noted in the `aiePiiMasking` test annotation that `isBelowMaskingPolicy` is tested but **inert** in production. Not recorded as a defect. |

---

## 8. Honest limits of this document

1. **73.6% of rows are grade B.** They name a verified artifact for the
   requirement's subject. They are not per-requirement conformance certificates.
2. **This is not a certification.** AIE-1 remains CONDITIONAL PASS and explicitly
   not production ready.
3. **No test was executed by this phase.** This worktree has no `node_modules`
   (the known `M1-F10` / `M12B-O7` environment gap), so `tsc` and `vitest` cannot
   run here. The 27 edits are comment-only and cannot alter behaviour — each file
   was checked to begin with exactly one correctly-terminated block comment — but
   **the regression baseline was not re-measured by this phase**, and no claim is
   made that it was. The next phase, which will have a working install, should
   re-confirm the 17 files / 39 tests baseline.
4. **The matrix reflects the branch, not production.** Migrations `0153`, `0154`,
   `0155` and `0157` remain unapplied on DEV and production, so several rows
   marked LIVE DEV were proven in DEV scenarios that a production reader cannot
   reproduce today.
5. **Migration numbering, re-verified fresh:** the in-branch guard reports
   "151 active migrations, next version is 0158", but `0156` and `0158` are held
   by `fix/app-review-findings-2026-09-15`, so the genuinely free repo-wide number
   remains **`0159`**, as the dispatch stated. **This phase created no migration.**

---

## 9. What changed on this branch

| | |
|---|---|
| New documents | 2 — the matrix and this report |
| New tooling | 8 files under `scripts/m12d-traceability/` (+ README), so the matrix is reproducible rather than asserted. Carries a self-contamination guard — the whole directory, the matrix and this report are excluded from the citation scan — and was verified idempotent across consecutive runs. |
| Files modified | 27 — **comment-only** requirement-id headers |
| Source logic changed | **none** |
| Migrations | **none** |
| Database / external calls | **none** |
| Pushed / merged / deployed | **none** |
| Prior mission documents carried forward | 18, unchanged (inherited by branching from `c98a78f`, verified byte-identical against the M12C worktree) |

---

## 10. Open items for the Product Owner

Nothing in this phase blocks the next one. For completeness, these remain exactly
as open as M12C left them, and the matrix now names which requirements each one
holds up:

| Id | Item | Requirements it blocks |
|---|---|---|
| `OA-11` | Rebuild II data from a clean re-import (deletes real production rows) | The 4 remaining PC4 residuals |
| `OA-8` / `M12C-O8` / `M12C-O9` | Owner mapping — no screen creates a household member; the two exception stores are unbridged | `AIE16-PC5-04`, `AIE16-PC5-11` |
| `OA-6` | `AIE_MASK_TOKEN_ENCRYPTION_KEY` unset | The sole cause of every M12A/M12B CONDITIONAL |
| `PO-BLOCKER-1` / `OA-2a` / `OA-2b` | AWS S3 + GuardDuty | `AIE11-QUA-03`, `AIE16-PDF-08`, `AIE16-OUT-04` |
| `PO-BLOCKER-3` | `labelsSeenRaw` semantics | `AIE10-MASK-09`, `AIE11-PII-10` |
| `PO-PC5-3` | Name the PC5 consumer owner (`AIE10-GOV-01`) | `AIE10-GOV-01`, `AIE16-GATE-11`, `AIE16-PRIV-12` |
| `PO-PC6-1` / `PO-PC6-2` | Benchmark licensing; risk-free source | `AIE16-PC6-08` |
| `OA-1` | PC4–PC7 original scope | Unchanged; does not affect the AIE universe, which **was** found |
| **new** | **Whether the 18 `ADR-AIE-*` artifacts are still wanted** | 18 requirements, plus `AIE10-GOV-07` and `AIE10-QA-12` |

The last row is the only genuinely new Product-Owner question this phase raises:
the AIE-1.0 contract requires 18 ADRs, none exists, and several of the decisions
they would record have since been made and implemented anyway. Writing them now
would be documentation of settled facts; formally retiring the obligation would be
equally defensible. It is a decision, not an engineering task, and this phase did
not make it.
