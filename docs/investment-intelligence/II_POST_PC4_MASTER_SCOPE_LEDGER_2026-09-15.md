# II Post-PC4 — Master Scope Ledger

**Mission:** FHIP — Investment Intelligence + AIE-1 Convergence, Master End-to-End Execution
**Phase:** M0 — Baseline and scope freeze (Part C + Part F of the master dispatch)
**Date:** 2026-09-15
**Branch:** `mission/m0-baseline-2026-09-15`
**Baseline commit (`origin/main` at time of writing):** `23b49da1d63c9c20f980ea9042e176845b6f60e3` (2026-09-15 00:07:20 +1000)

**This document is discovery and documentation only.** No application code was modified, no
migration was applied, no OpenAI or AWS call was made, nothing was pushed. Every claim below
is backed by a repository path, a commit SHA, a live read-only database probe recorded in the
companion document, or a named Product-Owner file on the operator's own filesystem.

---

## 0. Scope of the search (Part C.1 / Part W.2 — exact counts)

| What | Count |
|---|---|
| Local branches enumerated | 295 |
| Remote (`origin`) branches enumerated | 51 |
| Git worktrees enumerated | 89 |
| AIE-named branches (local) | 11 |
| AIE-named branches confirmed on the real remote via `git ls-remote` | 11 |
| Migration files on `origin/main` | 136 |
| Migration files on the AIE closure tip | 143 |
| Migration numbers probed live against DEV and PRODUCTION | 11 (+2 negative controls each) |
| Docs in `docs/investment-intelligence/` on `origin/main` | 185 |
| `docs/aie-programme/` docs on the AIE closure tip | 25 |
| `docs/aie-programme/` docs on `origin/main` | 0 (directory does not exist on `main`) |
| AIE source files under `lib/` or `app/` on `origin/main` | 0 |
| Product-Owner specification files located outside version control | 9 (`C:\Users\user\Downloads\`) |

Search methods used: `git log --all --grep`, `git log --all -S` (pickaxe over full history, all
refs), `git log --all --diff-filter=A/--diff-filter=D --name-only`, `git grep` on named refs,
`git ls-tree -r`, `git merge-base --is-ancestor`, `git branch --all --contains`, recursive
filesystem grep across `D:\FHIP\docs`, `D:\FHIP\User tests` and root `*.md` including untracked
files, and `find` by filename across the whole repository tree.

---

## 1. Headline finding — where authoritative scope actually lives

**The authoritative approved scope for this programme has never been committed to this
repository.** It lives in Product-Owner-held specification files on the operator's own
filesystem (`C:\Users\user\Downloads\`). The repository contains only *implementation and
certification reports written against* those specs, plus one-line roadmap labels.

This is not an inference. `docs/aie-programme/AIE_1_MASTER_PLAN.md` (ref
`feature/aie-1-final-closure`, introduced by `cde9151f76433d2da03d1cac9369f8511b16a61b`,
2026-09-11) states it in its own line 55:

> **Source documents** (`C:\Users\user\Downloads\`, read 2026-09-11, not committed to this repo)

and lists six files by name. The same pattern holds for PC4, whose spec is referenced by
section number (13, 14, 15, 16, 17, 19, 20, 47, 48) across commit subjects and reports but
whose text exists nowhere in git.

**Consequence for this programme:** any later phase that claims to "preserve original approved
scope" must load it from the Product-Owner files named in §2 below, because git cannot supply
it. This is recorded as operator-action item **OA-1** in the companion baseline document.

---

## 2. Product-Owner specification files located (outside version control)

Located by direct filesystem listing of `C:\Users\user\Downloads\` on 2026-09-15. Content was
read only where needed to classify scope; nothing was copied into the repository.

| ID | File | Size | Last modified | Role |
|---|---|---|---|---|
| SRC-AIE10 | `AIE-1.0_Architecture_&_Privacy_Contract.md` | 239,564 B | 2026-09-07 23:45 | **250 numbered `AIE10-*` requirements.** The upstream architecture/privacy contract that every AIE-1.x spec declares as its dependency. Contains the *binding boundary contracts* for PC5 (§ "Binding boundary with PC5", `AIE10-CTX-05`, `AIE10-EXC-08/09/10`) and PC6 (§ "Binding boundary with PC6", `AIE10-CTX-06`, `AIE10-PC6-01..05`). |
| SRC-AIE11 | `AIE-1.1_Shared_Preprocessing_Masking_and_JSON-Schema_Gateway (1).md` | 328,540 B | 2026-09-11 19:32 | ~332 numbered requirements. Shared gateway. (An earlier 104,544 B copy dated 2026-09-07 also exists; the 2026-09-11 "(1)" copy is the one the master plan cites.) |
| SRC-AIE12 | `AIE-1.2_Investment_Intelligence_Adapter.md` | 418,155 B | 2026-09-11 19:32 | ~346 numbered requirements. |
| SRC-AIE13 | `AIE-1.3_FDH_Bank-Statement_Adapter.md` | 399,307 B | 2026-09-11 19:32 | ~346 numbered requirements. |
| SRC-AIE14 | `AIE-1.4_Other_PDF-Enabled_FHIP_Modules.md` | 321,243 B | 2026-09-11 19:31 | ~286 numbered requirements. |
| SRC-AIE15 | `AIE-1.5_User_Exception_Review_and_Acceptance_Integration.md` | 392,431 B | 2026-09-11 19:31 | ~346 numbered requirements. Includes the `AIE15-PC5-01..12` PC5-integration block. |
| SRC-AIE16 | `AIE-1.6_Production_Cost_Security_and_Accuracy_Certification.md` | 353,450 B | 2026-09-11 19:31 | ~360 numbered requirements. |
| SRC-AIECL | `AIE-1_1-to-1_6_All-Pending-Tasks_Closure-Mission.md` | 493,546 B | 2026-09-12 23:59 | 54 top-level sections. The closure mission the 37 post-release-candidate commits were executed against. |
| SRC-MASTER | `FHIP_II_PC4_to_Terminal_AIE1_PC5_PC10_Master_Execution_Prompt.md` | 68,120 B | 2026-09-14 23:03 | **This mission's own dispatch.** Parts A–Z. Supplies the *additive* PC5 (Part K, 22 sections), PC6 (Part N, 16 sections) and PC7 (Part O, 10 sections) requirements, and Part P's PC8–PC10 anti-invention rule. |

**No file defining original PC4, PC5, PC6, PC7, PC8, PC9 or PC10 scope was found** — not in
this directory, not in the repository, not in any commit on any ref.

---

## 3. The ledger (Part C.2)

Requirement IDs below follow the Part W evidence standard: every row carries
**FOUND / NOT FOUND / CONDITIONALLY FOUND (named gap) / NOT APPLICABLE (reason)**.

### 3.1 PC4 — Controlled Production End-to-End Certification

| Field | Finding |
|---|---|
| **Authoritative phase name** | II-PC4 — Controlled Production End-to-End Certification |
| **Original approved scope source** | **CONDITIONALLY FOUND.** A Product-Owner specification with **at least 48 numbered sections** is referenced throughout the repository but exists nowhere in git and was **not found** in `C:\Users\user\Downloads\`. Evidence of its existence: `docs/investment-intelligence/II_PC4_SECTION20_DOCUMENT_LIFECYCLE_LIMITATION.md:3` ("per PC4 section 20's explicit instruction"); `II_PC4_STATUS_2026_09_07.md` §11 step 8 ("Issue the Section 47/48 terminal verdict"); commit subjects naming sections 13/14/15/16/17/19/20. |
| **Date/version of scope source** | Unknown — artifact not located. Implementation activity against it runs 2026-09-05 → 2026-09-07. |
| **Original mandatory requirements** | Not recoverable verbatim. The load-bearing invariants restated by the master dispatch (Part B.1) and corroborated by the repository's own PC4 reports are: correct CAMS CAS and CAMS Folio Details ingestion; account/folio identity and same-folio convergence; exact reimport idempotency; CAS/Folio overlap with no economic duplication; account-scoped FIFO; opening-balance safety and no fabricated tax lots; current-result selection; read-side provenance immutability; net worth counted exactly once; source-document identity correctness; fail-closed reconciliation; cross-user/RLS/storage isolation; production cleanup discipline for synthetic data. |
| **Original explicit exclusions** | `II_PC4_SECTION20_DOCUMENT_LIFECYCLE_LIMITATION.md` (SHA `dd5247653beff6851258f68f61decb4059d52461`, 2026-09-07) records a documented-only document-lifecycle limitation accepted under PC4 §20. |
| **Later additive requirements** | None. PC4's own §9 pushes three confirmed gaps forward as **additive** PC5/PC6/PC7 scope (see §3.2–3.4). |
| **AIE dependency** | **None.** PC4 predates AIE-1 integration; it is a pure Investment Intelligence phase. AIE-1.2 later targets the same domain but is not a PC4 dependency. |
| **Current implementation status** | **CONDITIONALLY FOUND — real work landed; terminal verdict never issued.** Nine real production defects found and fixed (`c22ea75`, `1ab6d40`, `a978382`, `8519148`, `77c059e`, `02b3754`, `e946557`; `b514e7c` explicitly superseded and marked "do not use as reference"). Live-verified state as of 2026-09-07: **12 of 17 real schemes reconciled to variance 0.000; 5 still flagged**. |
| **Current merge status** | **MERGED to `origin/main`.** `git merge-base --is-ancestor` returns 0 for all of `d0a65f2`, `acbaec3`, `dd52476`, `e946557`, `c22ea75`, `02b3754` against `origin/main` (`23b49da`). |
| **Current DEV status** | Applied; PC4 shipped through `main` → Amplify, so DEV and production share the code path. |
| **Current production status** | **Deployed and exercised against real Product-Owner data.** PC4's own report states every fix was "committed and pushed directly to `main`; Amplify auto-deployed each one." |
| **Migration ownership** | None new. PC4 was a parser/reconciliation/classification certification pass, not a schema phase. |
| **Open decisions** | (a) **Blocker 1** — Axis Large Cap Fund −156.618 units; candidate cause identified (standalone SIP-rejection with an unchanged printed balance) but deliberately **not fixed** because the same pattern failed to confirm on the next two rejection pairs. (b) **Blocker 2** — Kotak Mid Cap Fund +111.505 units; residual root cause not located; Kotak's pre-2022 history has never actually been examined. (c) Three residual variances never investigated at all: `948fb23a` (−12.932), `385feb70` (−4.457), `76c30cb9` (−2.678). (d) **PO decision open** — the reduced synthetic P01–P10 pack (§10) is recommended but not scoped or executed. (e) Closure-gate steps 6, 7 and 8 are all unstarted/unissued. |
| **Terminal artifact** | **NOT FOUND.** No PC4 closure/certification/acceptance report exists on any ref. `git log --all --diff-filter=A -- "docs/investment-intelligence/II_*"` shows 14 `II_*` docs ever created (PC1×2, PC2×3, PC3×6, PC4×2, FS1×1) and **zero deletions ever** — nothing was removed and hidden. The nearest artifact, `II_PC4_STATUS_2026_09_07.md`, states verbatim: *"**Verdict: II-PC4 — CONDITIONAL PASS.** Not terminal."* and *"Issue the Section 47/48 terminal verdict — **not issued.**"* |
| **Superseded documents** | An earlier same-day PC4 status report was replaced in place by `II_PC4_STATUS_2026_09_07.md` (current text from `d0a65f23a4cb67f73afbc475acaf041411d74815`, 2026-09-07), which explicitly supersedes it after the Product Owner corrected the claim that "17/17 schemes present" evidenced reconciliation. Defect row 7a (`b514e7c`) is superseded by 7b (`77c059e`) within the same report. |

> **Conflict recorded (Part C.3).** The master dispatch's Part B.1 states *"PC4 has now been
> completed."* The repository's only PC4 verdict artifact states the opposite. Per C.3 rule 1,
> an explicit later Product-Owner decision outranks an earlier assistant draft — but per C.3
> rule 2, a terminal release report outranks a provisional note **and no terminal PC4 report
> exists**. The dispatch itself resolves this by routing PC4 to **M1 (Part G) terminal
> verification**, and Part G.3 anticipates the case where the terminal artifact cannot be
> verified. **Chosen authority: neither claim is accepted at M0.** PC4 is recorded as
> `CONDITIONAL PASS, terminal verdict not issued, five named reconciliation residuals open`,
> and M1 must either produce the terminal artifact or invoke G.3.

### 3.2 PC5 — Owner / reconciliation resolution workflow

| Field | Finding |
|---|---|
| **Authoritative phase name** | PC5 — owner/reconciliation resolution workflow (II programme numbering) |
| **Original approved scope source** | **NOT FOUND.** Exhaustive search (see §0) recovered only *labels* and *constraints*, never a requirement set. The four references that exist: (1) `docs/investment-intelligence/II_PC4_STATUS_2026_09_07.md:138` — the single table cell `**PC5** — owner/reconciliation resolution workflow`; (2) `docs/aie-programme/AIE_1_MASTER_PLAN.md:121` (ref `feature/aie-1-final-closure`, `cde9151`) — architectural constraint P7, *"PC5 single-source-of-truth for exceptions — no second exception/unresolved-item system anywhere for PC5 or an adapter"*; (3) `lib/services/investment-intelligence/transactionTypeMapping.ts:81` on `origin/main` (`02b3754`) — an inline deferral comment; (4) `lib/aie/review/featureFlags.ts` (`56588de`) — `isAieReviewPc5ProjectionEnabled()` / `AIE_REVIEW_PC5_PROJECTION_ENABLED`, a flag with zero consumers. |
| **Date/version of scope source** | Label: 2026-09-07. Binding boundary contract: SRC-AIE10, 2026-09-07. Additive mission: SRC-MASTER Part K, 2026-09-14. |
| **Original mandatory requirements** | **NOT RECOVERABLE.** No approved PC5 requirement set exists in or out of version control. |
| **Original explicit exclusions** | **FOUND (binding, from SRC-AIE10).** PC5 must not build a parallel exception database, status model, queue, evidence store, correction API or independent review experience. A PC5 view may provide contextual presentation only; AIE remains the single source of truth. Reinforced by `AIE10-CTX-05`, `AIE10-EXC-08` (governed read/query API or DB view), `AIE10-EXC-09` (PC5 cannot mutate statuses directly), `AIE10-EXC-10` (no separate PC5 exception tables/counters/review UI unless projections over AIE truth). |
| **Later additive requirements** | **FOUND.** SRC-MASTER Part K, sections K.1–K.22 (2026-09-14): governed user-resolution workflow (K.2); one exception truth (K.3); statement owner matching (K.4); ownership choices (K.5); joint ownership (K.6); owner-mismatch behaviour (K.7); password-required case (K.8); summary mismatch (K.9); duplicate-candidate resolution (K.10); wrong-statement handling (K.11); user correction overlay (K.12); Review Centre semantics (K.13); actionable deep links (K.14); user acceptance (K.15); exception-only review (K.16); bulk decisions (K.17); undo/amendment policy (K.18); resolution triggers re-reconciliation (K.19); PC5 security (K.20); PC5 lifecycle + PDF purge (K.21); PC5 live-DEV proof (K.22). Also SRC-AIE15's `AIE15-PC5-01..12` block. |
| **AIE dependency** | **YES — hard dependency, both directions.** PC5 consumes AIE unresolved ownership/reconciliation items. The AIE-side half already exists and is real-DEV verified: `lib/aie/pc5/pc5ExceptionInterface.ts` on `feature/aie-1-final-closure` (`2394377`, 2026-09-13), two capability-gated wrappers over existing `repo.listOpenUnresolvedItemsForUser` and `decideOnItem`, with **no new table, status vocabulary or lifecycle**. It is **not on `origin/main`** (`git branch --all --contains 2394377` returns only `feature/aie-1-final-closure` and its origin copy). |
| **Current implementation status** | **NOT FOUND — PC5 does not exist.** No PC5 table, route, service, module or migration anywhere in the repository, on any ref, in any commit. Independently confirmed twice: by `docs/aie-programme/AIE_1_CLOSURE_PC5_INTERFACE_REPORT.md` (`2394377`) and by this M0 pass's own search. |
| **Current merge status** | N/A — nothing to merge. The AIE-side interface is unmerged (on `feature/aie-1-final-closure` only). |
| **Current DEV status** | N/A for PC5 itself. The AIE unresolved-item substrate it would consume **is live in DEV** (migrations 0140/0144 probed PRESENT — see companion doc). |
| **Current production status** | N/A for PC5 itself. The AIE substrate **is live in production** (same probes) while the AIE application code is undeployed — see the skew finding in the companion doc. |
| **Migration ownership** | None yet. Any PC5 migration must be allocated after the AIE block (0140–0146, 0149–0152) is reconciled onto `main` — see companion doc §4. |
| **Open decisions** | (a) Whether a prior approved PC5 requirement set exists in a Product-Owner file not yet supplied (operator item **OA-1**). (b) `AIE10-GOV-01` requires the **PC5 consumer owner** to be named; no such naming exists in the repository. |
| **Superseded documents** | None. |

> **Conflict recorded (Part C.3).** `II_PC4_STATUS_2026_09_07.md:132` asserts that the three
> PC4 gaps *"map into **additive** scope on PC5/PC6/PC7 — they do **not** replace or redefine
> whatever those phases were already scoped to cover."* This presupposes prior approved scope.
> **No such prior scope exists on any ref, in any commit, or in the Product-Owner file set
> located in §2.** Per C.3 rule 3 the assertion is not deleted; it is recorded here as an
> unverified premise. **Chosen authority:** the statement stands as a Product-Owner
> *instruction* (if prior scope is later produced, preserve it in full) but is recorded as
> `CONDITIONALLY FOUND — named gap: the prior scope artifact it refers to has never been
> located`. This applies identically to PC6 and PC7 and is not repeated in their rows.

### 3.3 PC6 — NAV / benchmark / reference-market-data ingestion

| Field | Finding |
|---|---|
| **Authoritative phase name** | PC6 — NAV/benchmark/risk-free/reference-market-data ingestion and governance |
| **Original approved scope source** | **NOT FOUND.** Two label-level references only: `II_PC4_STATUS_2026_09_07.md:136` (`**PC6** — NAV/benchmark/risk-free data`, mapped from the gap *"NAV/price history (`ii_prices_nav`) — zero rows, no ingestion code"*, itself citing migration `0033`'s own comment *"No AMFI NAV feed populated by R1 (non-goal)"*); and `AIE_1_MASTER_PLAN.md:122` constraint P8. |
| **Date/version of scope source** | Label: 2026-09-07. Binding exclusion contract: SRC-AIE10, 2026-09-07. Additive mission: SRC-MASTER Part N, 2026-09-14. |
| **Original mandatory requirements** | **NOT RECOVERABLE.** |
| **Original explicit exclusions** | **FOUND (binding, from SRC-AIE10 §19 and `AIE10-PC6-01..05`).** PC6 NAV/benchmark/security-master/pricing/reference-market-data ingestion stays completely separate from AIE. AIE must not absorb PC6 jobs, providers, credentials, schemas, lineage, quality metrics or incident model. Provider feeds used as authoritative market data are not document interpretation. AIE document confidence must never be used as PC6 data-quality confidence. Adapters may reference PC6 data only through a separately governed read interface, after the document fact is preserved. |
| **Later additive requirements** | **FOUND.** SRC-MASTER Part N, N.1–N.16 (2026-09-14): mutual-fund scheme master (N.3); authoritative source acquisition (N.4); daily NAV history (N.5); statement NAV vs market NAV (N.6); benchmark master (N.7); scheme→benchmark mapping (N.8); benchmark history (N.9); risk-free series (N.10); data-quality/admin surface (N.11); performance activation (N.12); same-contribution benchmark (N.13); incomplete-history behaviour (N.14); PC6 production jobs (N.15); PC6 certification (N.16). |
| **AIE dependency** | **NO — explicitly excluded in both directions** (Part D.7 of the dispatch; SRC-AIE10 §19). The dispatch further states AIE-1 terminal certification *"must remain independent of PC6 reference-market-data ingestion."* |
| **Current implementation status** | **NOT FOUND.** `ii_prices_nav` exists as a table with zero rows and no ingestion code. |
| **Current merge/DEV/production status** | N/A — not started. |
| **Migration ownership** | None yet. |
| **Open decisions** | Whether a prior approved PC6 requirement set exists (operator item **OA-1**). |
| **Superseded documents** | None. |

### 3.4 PC7 — Underlying mutual-fund holdings / look-through

| Field | Finding |
|---|---|
| **Authoritative phase name** | PC7 — underlying mutual-fund portfolio / look-through data and analytics |
| **Original approved scope source** | **NOT FOUND.** One label-level reference: `II_PC4_STATUS_2026_09_07.md:137` (`**PC7** — underlying MF holdings / X-Ray`, mapped from the gap *"Fund holdings disclosures (`ii_fund_holdings_snapshots`) — zero rows, no ingestion code"*, citing migration `0044`'s own comment *"write-restricted to trusted server/admin processes"*). That cell is the entire definition. |
| **Date/version of scope source** | Label: 2026-09-07. Additive mission: SRC-MASTER Part O, 2026-09-14. |
| **Original mandatory requirements** | **NOT RECOVERABLE.** |
| **Original explicit exclusions** | None found beyond the general D.2 net-worth invariant (look-through holdings never independently contribute to net worth). |
| **Later additive requirements** | **FOUND.** SRC-MASTER Part O, O.1–O.10 (2026-09-14): terminology — *Underlying Fund Holdings*, never ambiguous "Fund Holdings", user-owned fund positions stay separate (O.2); source ingestion (O.3); snapshot model (O.4); security-master integration (O.5); look-through analytics (O.6); wealth safety (O.7); freshness UX (O.8); PC7 admin/data quality (O.9); PC7 certification (O.10). |
| **AIE dependency** | **Conditional.** Not an AIE consumer today. Part P.3 requires an AIE-compatibility review: if PC7 introduces a PDF upload surface it must use the shared AIE standard rather than a separate parser/provider stack. Depends on PC6's security master (O.5). |
| **Current implementation status** | **NOT FOUND.** `ii_fund_holdings_snapshots` exists with zero rows and no ingestion code. R5's X-Ray (`12ccaa6`) and R12's X-Ray multi-asset integration are *adjacent, already-certified* features and are **not** PC7 — PC7 is the look-through *data* foundation beneath them. |
| **Current merge/DEV/production status** | N/A — not started. |
| **Migration ownership** | None yet. |
| **Open decisions** | Whether a prior approved PC7 requirement set exists (operator item **OA-1**). |
| **Superseded documents** | None. |

### 3.5 PC8 — `NO AUTHORITATIVE APPROVED SCOPE FOUND`

| Field | Finding |
|---|---|
| **Result** | **NOT FOUND — zero occurrences anywhere.** |
| **Evidence** | `git log --all -S"PC8"` over `*.md *.ts *.tsx *.sql *.json *.txt` across the entire history of all 346 refs returned **zero commits**. `git grep` on `origin/main` and on `feature/aie-1-final-closure` (all file types) returned zero. Recursive filesystem grep of `D:\FHIP\docs`, `D:\FHIP\User tests`, root `*.md` (including untracked files) returned zero. `find` by filename returned zero. No file in `C:\Users\user\Downloads\` defines it. One binary false positive exists (`docs/resources/r1-7-source/FHIP_R0-A_Resources_Content_Master_Specification.docx`) — a Resources content spec, coincidental text, unrelated to the II PC stream. |
| **Action per Part C.4 / P.2** | Record `PC8 — NO AUTHORITATIVE APPROVED SCOPE FOUND — NOT EXECUTED`. **Do not fabricate.** Raised as roadmap-gap item **RG-1** for Product-Owner review. |

### 3.6 PC9 — `NO AUTHORITATIVE APPROVED SCOPE FOUND`

Identical result and identical evidence to §3.5 (`-S"PC9"`: zero commits; all other searches
zero). Record `PC9 — NO AUTHORITATIVE APPROVED SCOPE FOUND — NOT EXECUTED`. Roadmap-gap item
**RG-1**.

### 3.7 PC10 — `NO AUTHORITATIVE APPROVED SCOPE FOUND`

Identical result and identical evidence to §3.5 (`-S"PC10"`: zero commits; all other searches
zero). Record `PC10 — NO AUTHORITATIVE APPROVED SCOPE FOUND — NOT EXECUTED`. Roadmap-gap item
**RG-1**.

> **Part P.2 consequence.** Phase execution stops at the highest genuinely approved phase.
> On the evidence above, **PC7 is the highest phase number with any approved definition at
> all**, and even PC5/PC6/PC7 have only a label plus this dispatch's additive requirements.
> After PC7 the mission proceeds directly to final integrated certification (Part Z).

### 3.8 AIE-1 — AI Extraction Engine, phases 1.0 through 1.6

| Field | Finding |
|---|---|
| **Authoritative phase name** | AIE-1 — shared AI Extraction Engine (AIE-1.0 architecture/privacy contract; AIE-1.1 shared gateway; AIE-1.2 Investment Intelligence adapter; AIE-1.3 FDH bank-statement adapter; AIE-1.4 other PDF-enabled modules; AIE-1.5 user exception review and acceptance; AIE-1.6 production cost/security/accuracy certification) |
| **Original approved scope source** | **FOUND — outside version control.** SRC-AIE10 through SRC-AIE16 (§2). **2,016 numbered requirements** across the six 1.1–1.6 documents, plus **250 `AIE10-*` requirements** in the 1.0 contract. |
| **Date/version of scope source** | AIE-1.0: 2026-09-07. AIE-1.1–1.6: 2026-09-11 (the AIE-1.1 file has an earlier 2026-09-07 revision superseded by the 2026-09-11 "(1)" copy). Closure mission SRC-AIECL: 2026-09-12. |
| **Original mandatory requirements** | Per-phase, in the source files. Repository-side transcriptions live in `docs/aie-programme/AIE_1_1..1_5_IMPLEMENTATION.md` and `AIE_1_6_CERTIFICATION_REPORT.md` on `feature/aie-1-final-closure`. |
| **Original explicit exclusions** | PC6 reference-market-data ingestion (SRC-AIE10 §19). Eight of the nine AIE-1.4 candidate document classes were ruled DEFER and one PROHIBITED — see `docs/aie-programme/AIE_1_CLOSURE_DEFERRED_CLASS_REGISTER.md` (`7331c19`). |
| **Later additive requirements** | **FOUND.** SRC-AIECL (2026-09-12, 54 sections) drove the 37 post-release-candidate commits. SRC-MASTER Parts H, I, J, L, M (2026-09-14) add: AWS S3 quarantine (H.2), GuardDuty Malware Protection (H.3), event wiring (H.4), real OpenAI provider proof (H.5/H.6), cost admission and settlement (H.7), prompt-injection controls (H.8), masking/tokenisation and mask-token lifecycle (H.9/H.10), **generic PDF password/decryption capability (H.11)**, **the missing real Investment Intelligence HTTP dispatch path (I.1)**, binary lifecycle under the no-retention policy (I.10), abandoned-document retention backstop (I.11), and the controlled merge/push/production-activation sequence (Part M). |
| **AIE dependency** | Self. AIE-1.1 depends on AIE-1.0 (SRC-AIE10); 1.2/1.3/1.4 depend on 1.0 + 1.1; 1.5 on 1.0–1.4; 1.6 on a completed 1.0–1.5 release candidate. |
| **Current implementation status** | **FOUND — implemented, not unconditionally certified.** Tip `feature/aie-1-final-closure` @ **`74b7a5e72eac0ceb91615b18d6b4e0027c8f616b`** (2026-09-14 16:54:08 +1000). ~60 files under `lib/aie/`, 13 API/page routes under `app/`, 4 review components, 19 scripts, 42 test files, 25 docs under `docs/aie-programme/`. Per-phase verdicts from `AIE_1_FULL_CONSOLIDATED_REPORT_2026_09_14.md` (`bc63273`): 1.1 CONDITIONAL, 1.2 CONDITIONAL (narrow), 1.3 CONDITIONAL, 1.4 FULL **for Insurance only** (8 classes deferred, 1 prohibited), 1.5 CONDITIONAL, 1.6 supersedes prior certifications. Report's own headline: *"No phase of AIE-1 has reached an unconditional FULL PASS."* |
| **Current merge status** | **NOT MERGED to `main`.** 84 commits ahead / 75 behind `origin/main` (`23b49da`); merge-base `9793949b17164f5f50747b73040972fcd5c1a58b` (2026-09-11 18:02:47 +1000). Zero AIE source files exist under `lib/` or `app/` on `origin/main`; `docs/aie-programme/` does not exist on `origin/main`. |
| **Current push status** | **PUSHED — all 11 AIE branches exist on the real remote.** Confirmed by `git ls-remote origin "refs/heads/*aie*"`: `refs/heads/feature/aie-1-final-closure` = `74b7a5e72eac0ceb91615b18d6b4e0027c8f616b`, matching the local tip exactly. **This corrects the closure report's own repeated claim of "Not pushed."** |
| **Current DEV status** | AIE migrations **0140, 0141, 0142, 0143, 0144, 0145, 0149, 0150, 0152 probed PRESENT in DEV** by live read-only schema probe with passing negative controls (companion doc §3). |
| **Current production status** | **The same nine migrations are PRESENT in PRODUCTION** — while the AIE application code is unmerged and undeployed. This is a genuine schema/code skew and is the single most important operational finding of M0. See companion doc §3.3. |
| **Migration ownership** | 0140, 0141, 0142, 0143, 0144, 0145, 0146 (block 1) and 0149, 0150, 0151, 0152 (closure block). Eleven migrations, all AIE-owned, none on `main`. |
| **Open decisions / blocked items** | (1) AWS S3 quarantine bucket — not provisioned. (2) GuardDuty Malware Protection for S3 — **the AWS account is not subscribed at all** (`SubscriptionRequiredException`), an ongoing-cost decision, not a permissions gap. (3) EventBridge→SQS→consumer wiring — depends on (1)+(2). (4) The missing real **Investment Intelligence HTTP dispatch route** — `app/api/aie/` has no investment route; `source_module_hint` on the generic intake is metadata only. (5) II/FDH **binary-retention-at-acceptance** semantics need a cross-module architectural decision. (6) **PC5 end-to-end integration** — PC5 does not exist. (7) **Generic password-protected-PDF decryption path** — not built (SRC-MASTER H.11). (8) Manual screen-reader accessibility pass. (9) `AIE_AI_MODEL` override: the OpenAI project allowlist rejects the pinned snapshot `gpt-4o-mini-2024-07-18`; `AIE_AI_MODEL=gpt-4o-mini` was set in a local `.env.local` **only** and is **not** carried into DEV or production configuration. |
| **Superseded documents** | `AIE_1_CONSOLIDATED_REPORT.md` (`6c66be1`, 2026-09-12) superseded by `AIE_1_FINAL_CLOSURE_CERTIFICATION.md` (`c27b21d`, 2026-09-13), itself superseded by `AIE_1_FULL_CONSOLIDATED_REPORT_2026_09_14.md` (`bc63273`, 2026-09-14). **All three are stale.** `AIE_1_6_CERTIFICATION_REPORT.md` (`b22fc42`) was an interim certification, superseded by `c27b21d`. AIE-1.1's 2026-09-07 spec copy is superseded by the 2026-09-11 "(1)" copy. |

> **Conflict recorded (Part C.3) — the latest AIE report is stale by three commits.**
> `AIE_1_FULL_CONSOLIDATED_REPORT_2026_09_14.md` (`bc63273`, 2026-09-14 08:45) is contradicted
> by later commits on its own branch:
> 1. It says *"No real OpenAI call was ever made"* — superseded by `c674832` (2026-09-14
>    15:54), the first real live-DEV GPT-4o mini call, 214 input / 37 output tokens,
>    $0.0000543.
> 2. It says *"No production authority exercised"* — superseded by `74b7a5e` (2026-09-14
>    16:54), which ran read-only schema checks **and real functional RPC calls against
>    PRODUCTION** to confirm migrations 0149–0152 had been applied there.
> 3. It predates `5958545` (2026-09-14 08:55), the live-DEV HTTP cross-tenant proof for the
>    AIE review routes (12/12 PASS).
> 4. Its and the dependency register's claim that `AIE_OPENAI_API_KEY` is *"absent from this
>    environment"* is **no longer true** — it is present (companion doc §5).
> 5. Its claim *"Not pushed"* is **no longer true** — all 11 branches are on `origin`.
>
> **Chosen authority: the git tree and the live probes, not the report text.** Per C.3 rule 1,
> the later evidence wins. M5 (Part L.10) must reissue the AIE terminal verdict against
> current truth rather than amending a stale report.

---

## 4. Highest genuinely approved phase

**PC7.** And that only in the weak sense of a one-line roadmap label plus this dispatch's own
additive Part O requirements. PC8, PC9 and PC10 are recorded as
`NO AUTHORITATIVE APPROVED SCOPE FOUND — NOT EXECUTED` under Part C.4 / P.2 and must not be
invented.

---

## 5. Roadmap gap note for Product-Owner review (Part C.4)

**RG-1 — PC8 / PC9 / PC10 do not exist.** The mission title and Part E sequence reserve M8/M9/M10
for them, but no approved scope exists in the repository, in git history, in any branch, or in
the Product-Owner file set located on the operator's filesystem. Under Part P.2 the mission
stops phase execution at the highest approved phase and proceeds to Part Z final integrated
certification. **The Product Owner should confirm either (a) that PC8–PC10 were never defined
and the sequence legitimately ends at PC7, or (b) supply the approved scope documents.**

**RG-2 — PC5/PC6/PC7 "original approved scope" may not exist either.** `II_PC4_STATUS_2026_09_07.md`
§9 presupposes prior scope for all three. None was found. If the Product Owner holds such
documents, they must be supplied before M4/M6/M7 can honestly claim scope preservation;
otherwise those phases execute **this dispatch's Part K/N/O requirements only**, which should
be stated plainly in each phase's `II_PC<n>_SCOPE_FREEZE.md` rather than implying a fuller
approved scope was preserved.

**RG-3 — AIE-1.0 is the missing upstream dependency the AIE programme already flagged, and it
exists.** `AIE_1_MASTER_PLAN.md` records AIE-1.0 as an *"open dependency gap"* with "no such
artifact found in this repository". It was located during this M0 pass at
`C:\Users\user\Downloads\AIE-1.0_Architecture_&_Privacy_Contract.md` (2026-09-07, 250 numbered
requirements), and it carries the **binding PC5 and PC6 boundary contracts** that Parts D.1 and
K.3 depend on. Later phases should load it rather than re-deriving those boundaries.
`AIE10-GOV-01` additionally requires named owners (Product Owner, architecture owner,
privacy/security reviewer, II and FDH domain owners, **PC5 consumer owner**, production-release
authority) — none of which is recorded anywhere in this repository.

---

## 6. Superseded-document register (consolidated)

| Superseded | By | Why |
|---|---|---|
| Earlier same-day PC4 status report | `docs/investment-intelligence/II_PC4_STATUS_2026_09_07.md` (`d0a65f2`) | Product Owner corrected the claim that "17/17 schemes present" evidenced reconciliation; replaced in place. |
| PC4 defect 7a, commit `b514e7c` | PC4 defect 7b, commit `77c059e` | 7a was diagnosed against a locally-saved statement copy that had lost its tab characters; the report marks `b514e7c` "do not use as reference". |
| `AIE-1.1_Shared_Preprocessing_...md` (2026-09-07, 104,544 B) | `AIE-1.1_...(1).md` (2026-09-11, 328,540 B) | The 2026-09-11 copy is the one the master plan cites and the one with ~332 numbered requirements. |
| `docs/aie-programme/AIE_1_CONSOLIDATED_REPORT.md` (`6c66be1`) | `AIE_1_FINAL_CLOSURE_CERTIFICATION.md` (`c27b21d`) | Predates the entire closure mission. |
| `docs/aie-programme/AIE_1_6_CERTIFICATION_REPORT.md` (`b22fc42`) | `AIE_1_FINAL_CLOSURE_CERTIFICATION.md` (`c27b21d`) | Explicitly an *interim* certification. |
| `docs/aie-programme/AIE_1_FINAL_CLOSURE_CERTIFICATION.md` (`c27b21d`) | `AIE_1_FULL_CONSOLIDATED_REPORT_2026_09_14.md` (`bc63273`) | Superseded by the full consolidated report. |
| `AIE_1_FULL_CONSOLIDATED_REPORT_2026_09_14.md` (`bc63273`) | **Nothing yet — stale by 3 commits and 2 environment changes.** | See the §3.8 conflict block. M5 must reissue. |
| `AIE_1_EXTERNAL_DEPENDENCIES_REGISTER.md` item 2 (`252b5db`) | Live environment fact | Records `AIE_OPENAI_API_KEY` as absent; it is present. |
| AIE closure migrations at 0147/0148 | Renumbered to 0149/0150 by `121cfd4` | Collision with `main`'s `0147_g8_generic_archive_bypass_fix.sql`. |
| AIE-1.3 migration at 0141 | Renumbered to 0142 by `83eb0cd` | Collision with concurrent AIE-1.2's `0141_aie1_2_investment_adapter_link.sql`. |

---

## 7. M0 scope-ledger verdict

| ID | Item | Result |
|---|---|---|
| SL-PC4 | PC4 authoritative scope + terminal artifact | **CONDITIONALLY FOUND** — implementation merged and in production; spec artifact not located; terminal verdict never issued; 5 reconciliation residuals and 3 gate steps open. |
| SL-PC5 | PC5 original approved scope | **NOT FOUND** (label + binding AIE-1.0 boundary contract + this dispatch's additive Part K only). |
| SL-PC6 | PC6 original approved scope | **NOT FOUND** (label + binding AIE-1.0 exclusion contract + additive Part N only). |
| SL-PC7 | PC7 original approved scope | **NOT FOUND** (label + additive Part O only). |
| SL-PC8 | PC8 authoritative scope | **NOT FOUND — NO AUTHORITATIVE APPROVED SCOPE FOUND — NOT EXECUTED.** |
| SL-PC9 | PC9 authoritative scope | **NOT FOUND — NO AUTHORITATIVE APPROVED SCOPE FOUND — NOT EXECUTED.** |
| SL-PC10 | PC10 authoritative scope | **NOT FOUND — NO AUTHORITATIVE APPROVED SCOPE FOUND — NOT EXECUTED.** |
| SL-AIE1 | AIE-1 scope, tip, status | **FOUND** — tip `74b7a5e`, pushed, unmerged, no unconditional FULL PASS, 9 open items. |
| SL-CONF | Scope conflicts resolved per C.3 | **FOUND** — 3 conflicts recorded with chosen authority (§3.1, §3.2, §3.8). |
| SL-SUP | Superseded-document register | **FOUND** — 10 entries (§6). |

**M0 Part C verdict: COMPLETE.** The ledger is honest about what does not exist rather than
inventing scope to satisfy numbering, as Part C.4 requires.
