# PC8 / PC9 / PC10 — Scope Closure Record

**Mission:** FHIP — Investment Intelligence + AIE-1 Convergence, Master End-to-End Execution
**Phase:** M8 / M9 / M10 (Part P of the master dispatch) — *PC8–PC10 without inventing scope*
**Date:** 2026-09-15
**Branch:** `mission/m8-m10-pc8-10-2026-09-15`
**Branched from:** `0576ba511bd8da57824af530e1e42054c2138856` (`chore(pc7): worktree-safe env resolution in the live O.7 proof`) — the accumulated M7 tip, **not** `origin/main`.

---

## 0. What this phase is, and what it deliberately is not

Part P instructs M8, M9 and M10 to **execute existing PC8, PC9 and PC10 scope**, and Part C.4
instructs that where such scope cannot be found it must be **recorded as absent rather than
invented**. M0 searched for it exhaustively and found nothing; M7 re-confirmed that finding.
This phase's job is therefore the *procedural closure* of that finding, not the manufacture of
three phases to satisfy a numbering sequence.

**This phase wrote no application code, created no migration, applied nothing to any database,
made no AWS or OpenAI call, touched no production system, pushed nothing and merged nothing.**
Its entire output is this document plus the carried-forward prior-phase documents listed in §5.

Two things in this document are explicitly **non-authoritative** and are labelled as such at the
point of use:

- **§4 (RG-1 roadmap-gap note)** — *suggestions* for a future Product-Owner planning
  conversation. They are not scope, they have no approval, and nothing in this mission has been
  built against them.
- **§6 (forward-compatibility notes)** — observations about where a hypothetical future phase
  *would* and *would not* plug in cleanly. They describe the code as it stands today; they are
  not a design and not a commitment.

---

## 1. The search — commands run, and their exact output

Part W's evidence standard applies to a "not found" finding as strictly as to a "found" one:
a negative result must be *demonstrated*, not asserted. M0 performed the exhaustive search;
Part P.1 asks this phase for a final, honest re-check rather than a repeat of it. Eight searches
were run on 2026-09-15 against this branch, this repository's full ref set, and the
Product-Owner filesystem locations M0 named. Every command and its verbatim result follows.

Scope of the ref set at the time of searching:

```
$ git rev-list --all --count
1099
$ git show-ref | wc -l
459
```

(M0 recorded 346 refs; the difference is worktree/branch refs this mission has created since,
including this phase's own branch. No ref has been deleted.)

---

### S1 — Working tree, all tracked files, all file types

```
$ git grep -n -I -E "PC-?(8|9|10)\b" -- .
```

**17 matching lines, in exactly 2 files — both of them this mission's own documents recording
the not-found finding:**

| File | Lines | What the match is |
|---|---|---|
| `docs/investment-intelligence/II_PC4_MIGRATION_AND_CONFIG_BASELINE_2026-09-15.md` | 88, 362 | M0's own statement that no branch is named for PC4–PC10, and operator item **OA-1** asking the PO to supply or confirm the non-existence of PC8/PC9/PC10 scope. |
| `docs/investment-intelligence/II_POST_PC4_MASTER_SCOPE_LEDGER_2026-09-15.md` | 80, 82, 185, 190, 191, 193, 195, 196, 199, 201, 202, 254, 262, 266, 313, 314, 315 | M0's ledger §3.5/§3.6/§3.7 (the three `NO AUTHORITATIVE APPROVED SCOPE FOUND` records), its RG-1 roadmap-gap entry, and its summary rows SL-PC8 / SL-PC9 / SL-PC10. |

**Zero of these 17 lines contain a requirement.** Every one is a record *of the absence*.

---

### S2 — The same search with this mission's own two records excluded

```
$ git grep -n -I -E "PC-?(8|9|10)\b" -- . \
    ':(exclude)docs/investment-intelligence/II_POST_PC4_MASTER_SCOPE_LEDGER_2026-09-15.md' \
    ':(exclude)docs/investment-intelligence/II_PC4_MIGRATION_AND_CONFIG_BASELINE_2026-09-15.md'
EXIT=1
```

**Zero lines of output. Exit code 1 (`git grep`'s "no matches").**

Every file in the working tree of the most advanced branch this mission has produced — every
`.ts`, `.tsx`, `.sql`, `.md`, `.json`, config file and script — mentions PC8, PC9 and PC10
**nowhere at all** once the two documents that exist to record their absence are set aside.

---

### S3–S5 — Full history, all 459 refs

**Pickaxe (content-level) search over every commit on every ref**, excluding the two
self-referential documents, restricted to text file types (an unrelated fixture,
`invalid-pdf.pdf`, makes an unrestricted pickaxe abort with
`E: unsupported filetype ... fatal: unable to read files to diff`, so the pathspec is scoped to
the types a specification could plausibly live in):

```
$ git log --all --oneline -S"PC8" -- "*.md" "*.ts" "*.tsx" "*.sql" "*.json" "*.txt" \
    "*.yml" "*.yaml" "*.js" "*.jsx" "*.csv" \
    ':(exclude)docs/investment-intelligence/II_POST_PC4_MASTER_SCOPE_LEDGER_2026-09-15.md' \
    ':(exclude)docs/investment-intelligence/II_PC4_MIGRATION_AND_CONFIG_BASELINE_2026-09-15.md'
EXIT=0    [zero lines above = zero commits]

$ ... same command with -S"PC9"
EXIT=0    [zero lines above = zero commits]

$ ... same command with -S"PC10"
EXIT=0    [zero lines above = zero commits]
```

**Zero commits, for all three tokens, across the entire history of all 459 refs.** No commit in
this repository's life has ever added, removed or modified a line containing `PC8`, `PC9` or
`PC10` outside this mission's own two ledger documents.

**Filename search over every path ever added on any ref:**

```
$ git log --all --pretty=format: --name-only --diff-filter=A | sort -u > allpaths_uniq.txt
$ wc -l < allpaths_uniq.txt
3890
$ grep -i -E "pc-?(8|9|10)" allpaths_uniq.txt
EXIT=1
```

**Zero of the 3,890 distinct file paths ever created on any ref has a PC8/PC9/PC10 name.**

---

### S6 — Ref names (branches, tags, remotes, worktrees)

```
$ git for-each-ref --format='%(refname)' | grep -i -E "pc-?(8|9|10)"
refs/heads/mission/m8-m10-pc8-10-2026-09-15
```

**One hit: this phase's own branch, created today.** No pre-existing branch, tag or remote ref
in this repository is named for PC8, PC9 or PC10.

---

### S7 — Commit messages, all refs

```
$ git log --all --oneline --grep="PC8" --grep="PC9" --grep="PC10" -i
5fd7267 docs(m0): post-PC4 master scope ledger + migration/config baseline
```

**One hit: M0's own commit, which introduced the not-found record.** No other commit subject or
body in this repository's history mentions any of the three.

---

### S8 — The Product Owner's own filesystem

M0 established that the authoritative scope for this programme has *never* been committed to
this repository and lives instead in Product-Owner files under `C:\Users\user\Downloads\`. That
is the one place a PC8–PC10 specification could plausibly exist without leaving a git trace, so
it was re-checked directly.

```
PS> Get-ChildItem -Recurse -File 'D:\FHIP\docs' | Where-Object { $_.Name -imatch 'pc-?(8|9|10)' }
=== D:\FHIP\docs : 0 filename matches ===

PS> Get-ChildItem -Recurse -File 'D:\FHIP\User tests' | Where-Object { $_.Name -imatch 'pc-?(8|9|10)' }
=== D:\FHIP\User tests : 0 filename matches ===

PS> Get-ChildItem -Recurse -File 'C:\Users\user\Downloads' | Where-Object { $_.Name -imatch 'pc-?(8|9|10)' }
=== C:\Users\user\Downloads : 1 filename matches ===
C:\Users\user\Downloads\FHIP_II_PC4_to_Terminal_AIE1_PC5_PC10_Master_Execution_Prompt.md

PS> Get-ChildItem -File 'D:\FHIP\*.md' | Where-Object { $_.Name -imatch 'pc-?(8|9|10)' }
   (none — 9 root .md files scanned, 0 matches)
```

Content search of the two committed documentation trees (ripgrep, recursive, all file types):

```
rg "PC-?(8|9|10)\b" "D:\FHIP\docs"         -> No matches found
rg "PC-?(8|9|10)\b" "D:\FHIP\User tests"   -> No matches found
```

#### S8a — The single filesystem hit, examined line by line

The one file matched is **this mission's own dispatch prompt** (M0's `SRC-MASTER`, 68,120 B,
2,281 lines). It is not a PC8–PC10 specification. Every one of its 21 mentions of the three
tokens was read:

```
$ grep -n -E "PC-?(8|9|10)" FHIP_II_PC4_to_Terminal_AIE1_PC5_PC10_Master_Execution_Prompt.md
3:    Covers: ... -> existing PC8/PC9/PC10 (if authoritative scope exists) -> ...
9:    ... preserve every previously approved PC5-PC10 requirement ...
42:    - inventing old PC5-PC10 scope where no authoritative approved scope exists.
126:   11. Existing PC5-PC10 scope, where it exists, must be preserved in full.
134:   Do not infer PC5-PC10 scope from names or from this prompt alone.
153:  For PC4, PC5, PC6, PC7, PC8, PC9, PC10 and AIE-1 record: ...
179:  ## C.4 PC8-PC10 anti-invention rule
181:  If authoritative PC8, PC9 and/or PC10 scope cannot be found, do not invent them ...
190:  If authoritative PC8-PC10 scope is found, preserve and execute it exactly ...
298:  **M8 - PC8, if authoritative approved scope exists**
300:  **M9 - PC9, if authoritative approved scope exists**
302:  **M10 - PC10, if authoritative approved scope exists**
304:  **M11 - Final integrated post-PC10-or-highest-phase production certification**
1644: # PART P - M8/M9/M10: EXECUTE EXISTING PC8-PC10 WITHOUT INVENTING SCOPE
1648: For PC8, then PC9, then PC10:
1966: - PC8/9/10 reports when applicable;
2045: - every existing PC8-PC10 phase;
2069: - PC8-PC10 terminal where authoritative scopes exist;
2199: ## 10. PC8
2202: ## 11. PC9
2205: ## 12. PC10
```

Lines 2199–2206 are the **report template**, and their bodies are placeholders, not requirements:

```
## 10. PC8
<scope/status or no-authoritative-scope finding>

## 11. PC9
<scope/status or no-authoritative-scope finding>

## 12. PC10
<scope/status or no-authoritative-scope finding>
```

Every mention is conditional (*"if authoritative approved scope exists"*, *"where it exists"*,
*"when applicable"*) or procedural (the anti-invention rule itself). **The dispatch prompt
contains zero PC8, PC9 or PC10 requirements.** It names the numbers; it does not define them.

---

### 1.1 What the searches collectively rule out

| Hiding place | Search | Result |
|---|---|---|
| Current code or docs on the most advanced mission branch | S1 / S2 | Nothing but the absence-records themselves |
| Any commit content, ever, on any of 459 refs | S3–S4 | **0 commits**, all three tokens |
| Any file *name*, ever, on any ref (3,890 distinct paths) | S5 | **0 paths** |
| A branch, tag or remote named for the phase | S6 | Only this phase's own branch, created today |
| A commit message referencing the phase | S7 | Only M0's own not-found record |
| A deleted-and-hidden document | S3–S5 (`--diff-filter=A` enumerates *every* path ever added, deleted or not) | **0 paths** |
| The Product Owner's own filesystem, where this programme's real specs actually live | S8 | Only this mission's dispatch, which defines none of them |

There is no remaining plausible location. The finding is not an inability to search; it is a
demonstrated absence.

> **A note for whoever searches next.** From the moment this document is committed there are
> **three** self-referential files, not two. Anyone re-running S1/S2/S3 must exclude
> `PC8_PC9_PC10_SCOPE_CLOSURE_2026-09-15.md` as well as M0's two, or they will find this record
> of the absence and mistake it for the thing it records the absence of. That is precisely the
> failure mode Part C.4 exists to prevent, so it is worth saying out loud.

---

## 2. The formal records (Part P.1 step 3 / Part P.2)

> ### PC8 — NO AUTHORITATIVE APPROVED SCOPE FOUND — NOT EXECUTED

> ### PC9 — NO AUTHORITATIVE APPROVED SCOPE FOUND — NOT EXECUTED

> ### PC10 — NO AUTHORITATIVE APPROVED SCOPE FOUND — NOT EXECUTED

**Evidence:** §1, searches S1–S8, run 2026-09-15 on branch
`mission/m8-m10-pc8-10-2026-09-15` @ `0576ba5`.

**Consequence per Part C.4:** the programme *continues through the highest genuinely approved
phase*, which is **PC7** — certified by M7 as a **CONDITIONAL PASS**
(`docs/investment-intelligence/PC7_LOOKTHROUGH_CERTIFICATION_2026-09-15.md`). Phase 10 (M11)
is therefore a *"final integrated post-**PC7** production certification"*, and should say so in
those words rather than "post-PC10".

**No `II_PC8_SCOPE_FREEZE.md`, `II_PC9_SCOPE_FREEZE.md` or `II_PC10_SCOPE_FREEZE.md` has been
created.** Part P.1 step 2 creates a scope-freeze document only when scope is *found*. Creating
an empty one would misrepresent an absence as a phase.

---

## 3. Consistency with the prior phases' own records

This finding is not new, and it is recorded identically everywhere it has been made. That
consistency is itself part of the evidence — no phase has quietly changed its mind.

| Where | What it says |
|---|---|
| M0 ledger §3.5 / §3.6 / §3.7 | `PC8 / PC9 / PC10 — NO AUTHORITATIVE APPROVED SCOPE FOUND`, with the same pickaxe evidence |
| M0 ledger summary rows SL-PC8 / SL-PC9 / SL-PC10 | **NOT FOUND — NOT EXECUTED** |
| M0 ledger RG-1 | The roadmap-gap item this document now discharges |
| M0 baseline OA-1 | Asks the PO to *supply, or confirm the non-existence of*, PC8/PC9/PC10 scope — still the correct operator ask |
| M7 (PC7 certification) | Re-confirmed the finding before this phase began |
| M8/M9/M10 (this document) | Re-confirmed a third time, with the search evidence above |

**One false positive is disclosed, not swept away.** M0 recorded a binary hit in
`docs/resources/r1-7-source/FHIP_R0-A_Resources_Content_Master_Specification.docx` — a Resources
content specification whose compressed bytes coincidentally contain the character sequence. It
has nothing to do with the Investment Intelligence PC stream. This phase's searches use
`git grep -I` and text-scoped pathspecs, which is why it does not reappear above; it is named
here so the two phases' evidence reconciles rather than appearing to disagree.

---

## 4. RG-1 — Roadmap-gap note for Product-Owner review

> ## ⚠ NON-AUTHORITATIVE. THIS IS A SUGGESTION, NOT SCOPE.
>
> **Nothing in this section has been approved, specified, estimated, designed, built or tested.
> No code in this repository implements any of it. No prior phase depends on it. It exists only
> so that a future Product-Owner planning conversation starts from what the architecture
> actually looks like today rather than from a blank page. If the Product Owner defines PC8,
> PC9 or PC10 later, that definition — not this section — is the scope.**

Part P.2 asks for **one** note covering all three numbers, because they are one finding.

### 4.1 The decision actually in front of the Product Owner

The mission's Part E reserves M8/M9/M10 for PC8/PC9/PC10, and its Part Z expects a terminal
report structured through PC10. Neither exists. There are exactly three honest ways to resolve
that, and **this is the decision RG-1 asks for**:

1. **Confirm PC8–PC10 were never defined.** The Investment Intelligence phase sequence ends at
   PC7. M11 becomes the terminal certification of a PC0–PC7 programme, the numbering gap is
   closed by declaration, and no further work follows. *This is the outcome all evidence points
   to.*
2. **Supply the specifications**, if they exist somewhere this mission could not reach (a
   different machine, an email thread, a document store). M0's operator item **OA-1** is exactly
   this ask, and it has been open since the start of the mission.
3. **Define them fresh**, as new work, in a new planning conversation, with a new dispatch — and
   explicitly *not* under the label "previously approved scope", which Part C.4 forbids.

### 4.2 If, and only if, the Product Owner chooses option 3

The following are **plausible candidates a future conversation might consider**, derived by
looking at what the *existing* architecture leaves unfinished. They are ordered by how directly
the current codebase already reaches toward them. **Each one is a question, not a plan.**

| # | Candidate area | Why the current architecture suggests it | What it is *not* |
|---|---|---|---|
| A | **Turn the PC6/PC7 foundations on.** PC6 built a scheme master, price/NAV, benchmark and risk-free skeleton; PC7 built the look-through schema and engine. **Both currently ingest zero real rows**, blocked on `PO-PC6-1` (index licensing), `PO-PC6-2` (risk-free source) and `PO-PC7-1`/`PO-PC7-2` (disclosure licensing). | The single highest-value follow-on is not new schema — it is *data*, and the blockers are commercial, not technical. | Not a build phase. Mostly a licensing and procurement decision, then a small importer per approved source. |
| B | **Australian market data and look-through.** PC6 and PC7 are India/CAMS-shaped end to end (AMFI codes, NIFTY, SEBI disclosure cadence). FHIP is a two-country product. | `ii_instruments.country_of_domicile` and `ii_scheme_master.country_code` already exist and are already keyed on; `ii_benchmark_category_defaults` is already country-scoped. The schema anticipates it; nothing populates it. | Not "a bit more PC6". ASX/managed-fund identifiers are a *different identifier namespace* — see FC-3 in §6, which is a real migration, not a config change. |
| C | **Look-through consumption.** PC7 produces resolved constituent exposure and a coverage gap; nothing in FHIP's reports, goals or X-Ray yet *reads* it. | PC7's own certification records that its net-worth safety function exists precisely so a consumer cannot double-count — i.e. it was built expecting a consumer that does not yet exist. | Not a data phase. A reporting/UX phase, and one with a real "what do we show when coverage is 60%?" design question. |
| D | **A wider asset class through the AIE pipeline.** AIE-1 has adapters for Investment Intelligence, FDH bank statements and Insurance. Retirement/superannuation statements are handled by FDH-12 on a *separate*, non-AIE path. | The two ingestion architectures have converged everywhere else in this mission; retirement is the visible remainder. | Not a small job. FDH-12 is a 179-section specification in its own right, and merging two ingestion paths is a migration and a reconciliation problem, not a refactor. |
| E | **Close the AIE traceability gap.** M5 raised `M5-BLOCKER-1`: 2,214 AIE requirements, 15.5% traceability, 1,870 orphans, AIE-1.6 at 0.0% strict. | A terminal certification of AIE-1 cannot honestly discharge requirements it cannot connect to evidence. This is already blocking, today. | Not new functionality at all. A mapping and evidence exercise — possibly the single most useful non-feature phase available. |

**A caution that belongs with the list.** Every one of A–E is a *guess about what would be
useful*, made by an assistant reading the code. None is a guess about what was previously
approved, because nothing was previously approved. The distinction is the entire point of Part
C.4, and it should survive into whatever conversation picks this up: **if one of these becomes
PC8, it is PC8 because the Product Owner decided so on that day — not because this document
listed it.**

---

## 5. Prior-phase documents carried forward (deliverable 2)

This branch is cut from `0576ba5`, the accumulated M7 tip, so every prior-phase document arrives
**by inheritance rather than by copying** — which is stronger than a copy, since a copy could
drift. Byte-identity against the M7 worktree
(`D:\FHIP\.claude\worktrees\agent-af5ade7b56192b7dc`) was verified by SHA-256 for all twelve:

| # | Document | Phase | SHA-256 (first 16) | vs M7 worktree |
|---|---|---|---|---|
| 1 | `II_POST_PC4_MASTER_SCOPE_LEDGER_2026-09-15.md` | M0 | `b61199dcfc7d8843` | MATCH |
| 2 | `II_PC4_MIGRATION_AND_CONFIG_BASELINE_2026-09-15.md` | M0 | `7d9d7d0745a9e970` | MATCH |
| 3 | `II_PC4_VERIFICATION_VERDICT_2026-09-15.md` | M1 | `d6d0c833297caa6a` | MATCH |
| 4 | `II_PC4_POST_CLOSURE_REGRESSION_CONTRACT_2026-09-15.md` | M1 | `0ac70292d29b4099` | MATCH |
| 5 | `AIE_INFRA_CLOSURE_REPORT_2026-09-15.md` | M2 | `cf580ee448371932` | MATCH |
| 6 | `AIE_II_DISPATCH_CLOSURE_REPORT_2026-09-15.md` | M3 | `775872f43d4b3afe` | MATCH |
| 7 | `PC5_IMPLEMENTATION_CERTIFICATION_2026-09-15.md` | M4 | `8193fcf899a4be1f` | MATCH |
| 8 | `PC5_HUF_ADDENDUM_2026-09-15.md` | M4b | `6e083dd23bc523a4` | MATCH |
| 9 | `AIE1_TERMINAL_CERTIFICATION_2026-09-15.md` | M5 | `f30c76a5b397cc12` | MATCH |
| 10 | `PC6_MARKET_DATA_CERTIFICATION_2026-09-15.md` | M6 | `e2da273e9261709d` | MATCH |
| 11 | `PC6_OPERATOR_RUNBOOK.md` | M6 | `c741a82450a7fe71` | MATCH |
| 12 | `PC7_LOOKTHROUGH_CERTIFICATION_2026-09-15.md` | M7 | `b73d32a48114fdeb` | MATCH |

All twelve live in `docs/investment-intelligence/`. With this document, thirteen.

> **A count discrepancy, disclosed rather than smoothed over.** This phase's dispatch says
> *"11 prior phase documents (12 files total)"*. The repository actually carries **twelve**.
> The twelfth is `PC6_OPERATOR_RUNBOOK.md`, which M6 committed in its *implementation* commit
> (`d44ad64`) rather than its *certification* commit (`9bbee1d`) — so a count taken from the
> certification commits alone returns eleven. Nothing is missing and nothing is extra; the
> runbook is a real M6 deliverable and is carried forward like the rest. Phase 10 should expect
> **thirteen** documents in this directory from this mission, not twelve.

---

## 6. Forward-compatibility review (Part P.3)

Part P.3 asks, since no later phase exists to review for AIE compatibility, that the mission's
own accumulated work (M2–M7) instead be reviewed for **where a future PC8/9/10 would plug in
cleanly, and where it would not**. These are observations about code that exists today. They
are **not new work, not a design, and not scope.**

The headline is genuinely good news, and it comes from a single consistent architectural choice.

### FC-1 — The AIE unresolved-item taxonomy has room for new reason codes with *zero* breaking change

`aie_unresolved_item.reason_code` (migration `0140`, the AIE-1.1 shared gateway) is declared:

```sql
reason_code text not null,
```

**No `CHECK` constraint. No Postgres `ENUM`. No foreign key to a registry table.** A new phase
may emit a new reason code with **no migration at all**.

The read side is equally tolerant. `lib/aie/review/reasonCodes.ts` resolves a code through a
static registry keyed on the module's own rule id, and an *unregistered* code does not crash and
does not leak an internal string to the user — it falls through to
`GENERIC_FALLBACK_REASON_META`, which renders truthfully and conservatively:

> *"This document needs a decision before it can be accepted."* — severity `blocking`, allowed
> actions `reject_document` / `request_reprocessing` / `defer`, and **no** correction offered,
> because the registry does not know which field would be safe to edit.

`stripCoreReconciliationPrefix()` handles AIE-1.1's generic `reconciliation_fail:` /
`reconciliation_indeterminate:` wrapper, so an adapter's own rule ids and the core's wrapped
ones resolve through one path. The naming convention is already namespaced by module
(`ii_adapter:*`, `fdh_bank_*`, `insurance_*`), so a new phase claiming a new prefix collides
with nothing.

**Verdict: clean. A future PC8 adding reason codes needs a code change and no schema change.**

### FC-2 — `text` + `CHECK`, never `ENUM`, is the repo-wide pattern — and PC7 already proved the extension path

Every classification column across PC5, PC6 and PC7 is `text not null check (col in (...))`.
Not one is a Postgres enum type. That is the difference between a one-line additive migration and
a genuinely awkward one (`ALTER TYPE … ADD VALUE` historically could not run inside a transaction
block, and an enum value can never be removed).

**PC7 did not merely inherit this pattern — it exercised it.** Migration `0157` §1 and §2 extend
two of PC6's constraints in place:

```sql
alter table ii_reference_import_batches drop constraint if exists ii_reference_import_batches_batch_kind_check;
alter table ii_reference_import_batches
  add constraint ii_reference_import_batches_batch_kind_check
  check (batch_kind in ('scheme_master','daily_nav','nav_history','benchmark_level',
                        'risk_free_rate','fund_holdings_disclosure'));
```

…with the accompanying comment recording *why* it reused PC6's ledger — *"reuse, not a second
stack"* (O.3). The same swap admits `ii_fund_holdings_snapshots` / `ii_fund_holdings_lines` to
`ii_reference_corrections.target_table`.

No existing row's value is removed, so the constraint validates immediately against existing data.

**Verdict: clean, with a worked precedent. A future phase ingesting a new reference dataset
should extend `batch_kind` and `target_table` exactly this way rather than building a parallel
ledger.**

### FC-3 — The reference-data architecture generalizes to a new asset class, with **one** named friction point

Generalizes cleanly:

- `ii_instruments.instrument_class` already admits `equity, mutual_fund, etf, bond,
  fixed_deposit, gold, crypto, cash, other` — most plausible new classes are already covered,
  and `other` is an honest escape hatch rather than a silent default.
- `ii_instruments` is already country- and currency-keyed
  (`country_of_domicile → countries`, `base_currency → currencies`), so a non-India asset class
  needs no new dimension.
- `ii_scheme_master` carries `country_code` and a lifecycle model (`active/closed/merged/
  suspended/unknown`) with a constraint that a `merged` row must name its target — a
  generalizable pattern, not an India-specific one.
- `ii_benchmark_category_defaults` is country-scoped and requires a ≥20-character rationale on
  every row, so a new market's defaults cannot be added without a stated reason.

**Does not generalize without a migration — and this is the one to flag:**

```sql
identifier_scheme text not null check (identifier_scheme in
  ('isin','amfi_scheme_code','nse_symbol','bse_code','sedol','internal_provisional'))
```

`ii_instrument_identifiers.identifier_scheme` is a **closed India/UK-shaped list**. An Australian
or US asset class (ASX code, APIR code, CUSIP) needs a constraint swap **and** a decision about
uniqueness scope, because `ii_instrument_identifiers` deliberately uses *two different* partial
unique indexes — ISIN/SEDOL are globally unique, AMFI/NSE/BSE codes are country-scoped
(ADR-002). A new scheme must be classified into one of those regimes; there is no default, and
picking the wrong one silently permits or forbids legitimate duplicates.

**Verdict: mostly clean. `identifier_scheme` + its uniqueness regime is the single real
forward-compatibility cost of a new market, and a future phase should budget for it explicitly.**

### FC-4 — PC5's ownership model generalizes, and HUF is the worked example

`ii_ownership_allocation` (migration `0153`) is written as a general allocation model, not an
India model: `owner_role in ('self','spouse','joint','child','family_trust','company','smsf',
'other')`, `allocation_basis_points` constrained to `(0, 10000]`, an effective-range check, a
`superseded` lifecycle and a one-owner-column check. It carries no country coupling at all.

The extension precedent already exists: **M4b added HUF** as an India-gated entity type
(migration `0154`), closing `PO-PC5-1`. A future phase adding another jurisdiction-specific
ownership concept has a pattern to copy — including the part that matters, which is gating it to
the jurisdiction where it is legally meaningful rather than offering it globally.

**Verdict: clean, with a worked precedent.**

### FC-5 — PC7's coverage semantics are an invariant a future consumer must not break

PC7 keeps `disclosed_weight_total_pct` and `resolved_weight_total_pct` as *separate* columns, and
its own column comment states the invariant plainly:

> *"the share of the fund that resolved to a canonical security. `disclosed_weight_total_pct`
> minus this is exposure we can see but cannot name — retained and displayed, never dropped and
> never rescaled away."*

`ii_fund_holdings_lines.industry_or_rating_raw` likewise preserves the publisher's literal cell
alongside the normalised `credit_rating_band`, so a mis-mapped band is correctable without
re-fetching the source. `ii_pc7_networth_safety_violations()` makes the no-double-count assertion
**runnable** rather than merely commented.

**Verdict: clean, but load-bearing.** Any future phase that *consumes* look-through data (RG-1
candidate C) inherits a hard rule: it may not normalise the unresolved remainder away to make a
chart add to 100%. The guard function is the place to assert that it hasn't.

### FC-6 — The AIE review module registry accepts a new module by addition

`lib/aie/review/moduleRegistry.ts` resolves a descriptor by adapter id
(`resolveModuleDescriptorByAdapterId`) and a reason-code meta through it
(`resolveReasonCodeMeta`). A new module plugs in by adding one descriptor and one reason-code
record — no change to the resolution logic.

The registry also carries an `integrationTested` flag, and it is currently **`true` only for
Insurance**; `investment_intelligence` and `fdh_bank` are **`false`**, with a source comment
saying so explicitly:

> *"DO NOT read their presence here as 'AIE-1.5 tested Investment/FDH review' — it did not."*

**Verdict: clean to extend. But a future phase must read that flag, not the mere existence of a
descriptor, as evidence of testing.**

### FC-7 — Where a future phase would **not** plug in cleanly (the honest list)

These are real, and they are named so a future planning conversation is not surprised by them.

| ID | Friction | Why it matters |
|---|---|---|
| FC-7a | **`aie_unresolved_item.severity` is a closed two-value check** (`'blocking','warning'`). | A future phase wanting a third severity (e.g. purely informational) needs a migration. Contrast FC-1: the *reason code* is free, the *severity* is not. Similarly `status` is a closed six-value list (`open, in_review, resolved, rejected, deferred, superseded`). |
| FC-7b | **`AieReviewActionType` is a closed TypeScript union**, and its `optionSource` values are a closed set of five (`household_owner`, `account_match_candidates`, `instrument_match_candidates`, `duplicate_resolution`, `summary_mismatch_resolution`). | Adding a genuinely new resolution affordance is a type change *plus* a resolver *plus* UI, not a registry entry. |
| FC-7c | **`'request_reprocessing'` is declared throughout but implemented nowhere.** The generic route's `VALID_ACTIONS` is `['correct','not_present','defer']`. | It appears in almost every `permittedActionTypes` and `allowedActions` array, so a future phase reading the registries would reasonably assume it works. The source comment in `lib/aie/review/types.ts` already warns about this; it is repeated here because it is exactly the kind of thing a new phase builds on by mistake. |
| FC-7d | **Two decision routes now write the same table.** AIE-1.5's generic `POST /api/aie/review/items/{itemId}/decide` accepts `correct/not_present/defer`; PC5's `POST /api/pc5/resolutions/{itemId}/decide` accepts the PC5 action set including `choose_value`. | EXC-09's *"single unresolved-item system"* invariant holds at the **table** level — there is exactly one `aie_unresolved_item` — but **not** at the route level. A future phase adding an action must consciously choose which route owns it, and must not assume the generic route accepts the full union. |
| FC-7e | **Migration numbering is a live collision hazard in this repository.** `0156` is already taken by an unrelated branch (`ea4c124`, `fix(migrations): renumber app-review Item-3 migration 0154 -> 0156`), which is why this mission's PC7 migration is `0157`. Six sibling-branch collisions have occurred historically. | A future phase must **re-verify the next free number against all refs at implementation time**, never trust a number carried forward in a document. (Verified today: `0158`, `0159`, `0160` are all free — `git log --all --diff-filter=A` returns zero commits for each.) |
| FC-7f | **No PC scope has ever been committed to this repository.** M0's headline finding. | This is the root cause of the PC8–PC10 problem itself. If a PC8 is ever defined, **committing its specification to `docs/` would prevent a recurrence** of exactly the situation this document exists to close. |

---

## 7. What this phase did not do, stated explicitly

| | |
|---|---|
| Application code changed | **None.** |
| Migrations created or applied | **None.** No migration number was consumed; `0158` remains free. |
| Databases touched | **None.** No DEV read, no DEV write, no production contact of any kind. |
| External calls | **None.** No AWS, no OpenAI, no market-data or AMC source. |
| Tests run | **None.** No code changed, so the regression baseline is untouched by construction (see §8). |
| Pushed / merged | **Neither.** The branch is local. |
| Prior-phase blockers closed | **None** — and none was attempted. AWS/GuardDuty, the masking key, migrations `0153/0154/0155/0157`, `PO-PC6-1`, `PO-PC6-2`, `PO-PC7-1`, `PO-PC7-2` all remain exactly as M2–M7 left them. |
| DEV's 19 orphan snapshot headers | **Not deleted.** M7 left them deliberately as `OPS-PC7-2`; this phase did not second-guess that call. |

---

## 8. Roll-up of every still-open item, for Phase 10 (M11)

Phase 10's final integrated certification must enumerate all of the following. This is the
complete list as of the end of this phase, gathered from M0–M7's own records. **This phase added
nothing to it and closed nothing on it.**

### 8.1 Unapplied migrations

| Migration | Owner phase | State |
|---|---|---|
| `0153_pc5_governed_resolution.sql` | PC5 (M4) | **Unapplied on DEV and production.** Blocks 13 live PC5 scenarios; both matrices auto-detect and switch to FULL mode once applied. (`PO-PC5-2` / `OPS-PC7-1`) |
| `0154_huf_entity_type_india_gate.sql` | PC5/HUF (M4b) | **Unapplied on DEV and production.** Blocks 4 further live scenarios. |
| `0155_pc6_reference_market_data_foundation.sql` | PC6 (M6) | **Unapplied on DEV and production.** |
| `0157_pc7_lookthrough_foundation.sql` | PC7 (M7) | **Unapplied on DEV and production.** Until applied, `scheme_master_id`, the batch-ledger extension, the O.7 function, the admin capability and the job-control row exist in no database. |

**Order matters: `0153`, `0154`, `0155`, then `0157`.** No DDL path exists from the assistant's
environment; this is an operator action throughout.

> **`0156` is NOT this mission's.** `0156_app_review_0915_clear_leaked_migration_notes.sql`
> belongs to an unrelated app-review branch (added by `ea4c124`). Phase 10 must not list it as a
> mission deliverable and must not apply it as part of this mission's sequence.

**Next genuinely free migration number: `0158`** (re-verified today — see FC-7e).

### 8.2 AWS / credential / environment gaps

| ID | Item | Owner |
|---|---|---|
| `PO-BLOCKER-1` / `OA-2b` | **AWS S3 + GuardDuty.** Zero permissions beyond the implicit STS call; 6 candidate bucket names provably nonexistent against a 403/404 control. Needed: exact bucket name, the AWS account id, and credentials or a purpose-scoped identity. The runbook (`aie-document-quarantine-dev`) and the IAM policy (`fhip-aie-quarantine-dev`) still disagree on the name. | Product Owner / operator |
| `OA-6` | **`AIE_MASK_TOKEN_ENCRYPTION_KEY` is unset** — absent from `.env.local` (9 keys parsed) and from the process environment. It is the *single* remaining blocker on the AI path for the FDH-bank and Insurance adapters, whose AI fallback this mission has never exercised and whose privacy proof therefore reads **NOT EXERCISED**. M5 §1.1 and §7 must be read before supplying it. | Product Owner / operator |

### 8.3 Product-Owner decisions still pending

| ID | Decision | State |
|---|---|---|
| `PO-PC6-1` | **Benchmark index licensing.** NIFTY belongs to NSE Indices Ltd, SENSEX to BSE/Asia Index; neither is open data and the legacy unauthenticated endpoint no longer works. Either licence one, or accept that FHIP shows no benchmark comparison for Indian mutual funds. | **OPEN** |
| `PO-PC6-2` | **Risk-free source and methodology.** Three defensible candidates differing by 100–150 bp, which visibly moves every Sharpe and Sortino. Choose source, tenor and a gap-handling rule. | **OPEN** |
| `PO-PC7-1` | **Licensing of AMC portfolio disclosures.** SEBI obliges AMCs to publish, but AMFI's terms bar commercial use and bulk electronic storage; Nippon India bars aggregation; SBI's `robots.txt` disallows its own `.xlsx` URLs; HDFC edge-blocks non-browser clients; ICICI Prudential prohibits nothing (absence of prohibition, not permission). Needs a per-AMC decision, ideally with Indian counsel. | **OPEN** |
| `PO-PC7-2` | **Or: license a commercial vendor** (ICRA Analytics, Accord Fintech, LSEG Lipper, Morningstar, CRISIL Intelligence) — the only path with clean redistribution rights. | **OPEN** |
| `PO-PC5-3` | **Name the PC5 consumer owner.** Required by `AIE10-GOV-01`; M0 recorded it as unnamed and it still is. | **OPEN** |
| `M5-BLOCKER-1` | **AIE-1 requirement traceability is 15.5%** — 2,214 requirements, evidence connected to 344, 1,870 orphans, AIE-1.6 at 0.0% strict. Needs either a decision that citation-level traceability is not required, or a real mapping pass. | **OPEN** |
| `OA-1` | **Supply, or confirm the non-existence of, PC4–PC10 original scope.** This document discharges the PC8/PC9/PC10 third of it; the PC4–PC7 portion remains open. | **PARTIALLY DISCHARGED** |
| `RG-1` | **The PC8/PC9/PC10 roadmap gap** — §4 above. Options 1/2/3. | **OPEN — awaiting PO** |
| `PO-PC5-1` (HUF) | — | **CLOSED** by M4b (migration `0154`). Listed only so Phase 10 does not re-raise it. |

### 8.4 Regression baseline — use the corrected figure

> **Pre-existing failing baseline: 17 files / 39 tests.**

M7 established this properly: PC7's edits (`xray/lookThrough.ts`, `r5Repository.ts`) were
**stashed**, the same 17 files re-run, and they failed **identically** — 17 files / 39 tests.
With the edits restored, the full suite reports the same 17 files / 39 tests.

**The figure "16 files / 22 tests" is stale and appears in earlier mission documents (including
M5's AIE-1 terminal certification §13). Phase 10 must cite 17/39 and should note the correction
rather than silently swapping the number.** The failures are environmental and pre-existing: 9
`resources*` suites failing at *collection* time for missing DEV env vars (0 failing assertions),
plus `aiResidualClosureFailClosed`, `countryGateAccessMatrix`, `fdh1Isolation`,
`lr12rSmsfPropertyLoanLinkOverride`, `lrFi2DebtServiceExactlyOnce`, `lrFi2HouseholdDebtRatios`
and `smsfHouseholdIsolation` in SMSF / debt-ratio / isolation territory. None is caused by this
mission.

### 8.5 DEV data hygiene

| ID | Item |
|---|---|
| `OPS-PC7-2` | **19 orphan snapshot headers on DEV** (`source_document_version='vc-doc-1'`, 0 lines, `source_id` NULL). They are R5 fixtures, but they are exactly the shape that makes the look-through engine compute a *measured-looking* zero. PC7 detects them (`coverage_gaps`, reason `no_lines`) rather than hiding them, and deliberately does **not** delete them — removing data an operator may rely on is not a certification phase's call. **Still present. Not cleaned up. Recommended cleanup, blocking nothing.** This phase did not delete them either. |

### 8.6 Carried engineering open items (no decision needed)

`M2-OPEN-1` (`transitionRunStatusCas` does not write `aie_processing_transition`; accept/reject
edges missing from the FSM audit table) · `M2-OPEN-2` (`purge_status` has no transition table or
validator) · `M2-OPEN-3` (`computeUserFacingStateForIntakeWithoutRun` omits `'ready'` and throws
on it) · `M2-OPEN-4` (no `import 'server-only'` guard in `lib/aie`; AIE secrets undocumented in
`.env.example` / `ENVIRONMENT_VARIABLES.md`) · `M2-OPEN-5` (retry-loop token usage under-settled,
final attempt only) · `M2-OPEN-6` (`app/api/aie/fdh-bank/intake/route.ts` auto-commits at intake,
bypassing `accept.ts`'s acceptance gate — **no phase has touched this route**) · `M2-OPEN-7` (no
address masking rule) · `M2-OPEN-8` (**outside AIE:** Investment Intelligence and
payslip/retirement/liability password endpoints have no rate limiting, unlike FDH-5 — a real
brute-force exposure on an authenticated endpoint) · `M3-OPEN-1` (no II parser declares an
AI-eligible gap, so masking and the AI fallback are structurally unreachable for Investment
Intelligence) · `M3-OPEN-2` (the address rule masks only the first line of a multi-line address)
· `M3-OPEN-3` (`.env.local` is UTF-8-with-BOM + CRLF; 9 live-dev suites parse it with
`split('\n')` and `(.*)$`, which matches **zero** keys and produces an empty environment *with no
error* — a latent silent-failure hazard) · `CG-10` (two parse runs sharing an identical
`storage_path`, still open on the **old** II path; the new AIE path is keyed on an immutable
intake UUID and does not have it) · `OA-10` / `M3-F1` (the CAS opening-balance discard) ·
`M5-OPEN-1..4` (axe pass needs the app up *and* `0153` applied; no accuracy corpus exists for
FDH-bank or Insurance; rollout configuration changes are not audited; zero AIE requirement
identifiers are cited in any live-DEV suite).

**Also still open from PC4 itself**, and Phase 10 should not let it fall off the end: two named
reconciliation blockers (Axis Large Cap −156.618 units; Kotak Mid Cap +111.505 units) and three
never-investigated residual variances (`948fb23a` −12.932, `385feb70` −4.457, `76c30cb9` −2.678).

---

## 9. Verdict

> ## PC8 — NO AUTHORITATIVE APPROVED SCOPE FOUND — NOT EXECUTED
> ## PC9 — NO AUTHORITATIVE APPROVED SCOPE FOUND — NOT EXECUTED
> ## PC10 — NO AUTHORITATIVE APPROVED SCOPE FOUND — NOT EXECUTED
>
> Recorded per Part C.4 and Part P.2 on demonstrated evidence (§1, searches S1–S8), not on
> assertion. Nothing was invented. No scope-freeze document was created for a phase that does
> not exist. The roadmap gap is raised as **RG-1** (§4) for Product-Owner review, explicitly
> labelled non-authoritative.
>
> **The highest genuinely approved phase remains PC7 (CONDITIONAL PASS, M7).** Phase 10's final
> integrated certification is a *post-PC7* certification and should be worded as such.
>
> **This phase raises no blocker for Phase 10.** It changed no code, consumed no migration
> number, touched no database and altered no test result. Every open item Phase 10 must
> enumerate is listed in §8, unchanged from how M2–M7 left it.

---

*Branch `mission/m8-m10-pc8-10-2026-09-15`, branched from `0576ba511bd8da57824af530e1e42054c2138856`.
Not pushed. Not merged. No production system was contacted by this phase.*
