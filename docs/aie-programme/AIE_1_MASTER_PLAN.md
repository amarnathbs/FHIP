# AIE-1 Programme Master Plan

**Status:** Planning document. Consolidates six source specifications found on the
local filesystem (not part of this repository) into one dependency-ordered execution
plan. Writing this document does not implement, certify, or authorize anything.

**AIE-1.1 (the only phase eligible to start on the plan below) has since been
implemented, unit-tested, typechecked and linted clean on
`feature/aie-1-1-document-gateway` — see [`AIE_1_1_IMPLEMENTATION.md`](./AIE_1_1_IMPLEMENTATION.md)
for exactly what was built, reused, deferred, and verified. That work is
NOT a certification and grants no production authority — this master plan's
phase ordering and scoping note below remain unchanged by it.

**Source documents** (`C:\Users\user\Downloads\`, read 2026-09-11, not committed to this repo):
- `AIE-1.1_Shared_Preprocessing_Masking_and_JSON-Schema_Gateway (1).md` (~3089 lines / 332 numbered requirements)
- `AIE-1.2_Investment_Intelligence_Adapter.md` (~3148 lines / 346 numbered requirements)
- `AIE-1.3_FDH_Bank-Statement_Adapter.md` (~3141 lines / 346 numbered requirements)
- `AIE-1.4_Other_PDF-Enabled_FHIP_Modules.md` (~2619 lines / 286 numbered requirements)
- `AIE-1.5_User_Exception_Review_and_Acceptance_Integration.md` (~3139 lines / 346 numbered requirements)
- `AIE-1.6_Production_Cost_Security_and_Accuracy_Certification.md` (~3264 lines / 360 numbered requirements)

Each file numbers well over a thousand words of near-identical boilerplate under most
headings ("Required engineering/investment/FDH/module/interaction/independent
treatment...", "Required verification..."). That repetition was deliberately skipped in
extraction; only headings, the front-matter (scope/prohibitions/method), and the closing
deliverables/exit-criteria sections carry unique information, and this plan is built from
those. Total combined "numbered requirement" count across all six documents is
**2,016** — none of it is invented or paraphrased away below; it is compressed to what a
human decision-maker needs to sequence the work.

---

## 1. What this programme is

AIE ("AI document Extraction") is a shared, privacy-first pipeline for turning uploaded
PDFs/documents (investment statements, bank statements, insurance/payslip/loan/valuation/
retirement/goal/bill/tax documents) into canonical FHIP data, built once and reused by
every domain module instead of each module inventing its own PDF/OCR/AI ingestion. Its
own framing (AIE-1.1, opening section):

> "This is not a generic 'send PDF to AI' feature. The default path is local/private and
> deterministic. External low-cost AI is a constrained fallback for approved, masked,
> explicitly missing fields. AI output is untrusted until strict schema validation and
> deterministic reconciliation. No AI response may directly write canonical financial
> data."

The pipeline route, defined once in AIE-1.1 and reused unmodified by every later phase:

```
authorised upload admission
  -> encrypted tenant-scoped quarantine
  -> malware / MIME+magic-byte / PDF-structural / resource-limit validation
  -> local/private text + table + selective OCR extraction
  -> document fingerprinting + controlled duplicate handling
  -> registered deterministic classifier/parser FIRST
  -> local/private PII detection + masking + privacy admission gate
  -> minimum-necessary MASKED low-cost AI fallback, ONLY for approved missing fields
  -> strict JSON parsing + published JSON Schema validation of AI output
  -> shared normalisation + adapter-owned deterministic reconciliation handoff
  -> clean-result / typed-unresolved-item outcome, exposed to the future AIE-1.5 review UI
  -> domain-owned canonical write (Investment Intelligence / FDH / other module's own
     service) -- the AIE core itself never writes canonical financial data
```

## 2. Binding principles that apply across all six phases

These recur near-verbatim in every document's own "non-negotiable prohibitions" or
"binding principles" section. They are not phase-specific; every phase from 1.1 through
1.6 restates and re-enforces the same rules rather than introducing new ones. Listed once
here; phase sections below reference these by short name instead of repeating them.

| # | Principle | Representative quote (verbatim, phase of origin) |
|---|---|---|
| P1 | **No unmasked PII to any AI provider** | "No raw/unmasked PDF, text, table or identifier may reach an external AI provider." (1.1) / "No raw statement, account/holder identifier or narration may reach an external AI provider." (1.3) |
| P2 | **Only the shared gateway may call a provider — no adapter/module/browser route selects one directly** | "No adapter or browser route may call/select an AI provider directly." (1.1) / "No independent provider client... in a module." (1.4) |
| P3 | **AI output is untrusted until strict JSON Schema validation passes** | "No provider output may bypass strict local schema validation." (1.1) |
| P4 | **A confidence score can never override deterministic reconciliation** | "No confidence score may bypass deterministic reconciliation." (1.1); restated per-phase as "Confidence score must never override reconciliation outcome" (1.2/1.3); "no 'accept anyway' for material failed/indeterminate reconciliation" (1.5); "a schema-valid material financial error can be marked clean" is an automatic NO-GO (1.6). |
| P5 | **No user-controlled authority over tenant, owner, processing state, provider, schema or destination** | "No user-controlled tenant, owner, processing state, provider, schema or canonical destination authority." (1.1) |
| P6 | **AIE core/adapters never write canonical financial tables directly — only the owning domain's own service does** | "No direct AIE core write to Investment Intelligence, FDH or other canonical financial tables." (1.1) / "No direct AIE/AI writes to canonical module tables." (1.4) |
| P7 | **PC5 single-source-of-truth for exceptions — no second exception/unresolved-item system anywhere** | "No second unresolved-item/exception system for PC5 or an adapter." (1.1) / "No second exception table/state machine/queue for PC5 or a module." (1.5) / certified end-to-end at 1.6 ("Treat indefinite dual-write or status drift as NO-GO.") |
| P8 | **PC6 (NAV/benchmark/price/reference-market-data) stays completely separate from document acceptance** | "No use of PC6 prices/NAV/benchmark ingestion inside document acceptance." (1.1) / "AIE must never rewrite the document fact, ingest PC6 feeds, or make document acceptance depend on current prices." (1.2) / certified independently at 1.6 with its own PC6 section ("Treat coupling of ingestion/failure/lineage as scope violation and NO-GO.") |
| P9 | **No production authority is granted by any of these documents** | "Production authority: none unless separately granted in writing by the Product Owner." (1.1, repeated near-verbatim by 1.2-1.5) / "Production activation authority: not granted by this prompt" (1.6) — 1.6 explicitly "does not itself apply production migrations, enable provider traffic, migrate users, process real documents or broaden cohorts. Those remain separate Product Owner release decisions." |
| P10 | **No raw provider error, document content, prompt, or PII in logs/traces/metrics/client-facing errors** | "No raw provider error, document content, prompt or PII in logs, traces, metrics or client errors." (1.1); certified via canary scans of "logs/traces/metrics/errors/queues/caches/temp files" at 1.6. |
| P11 | **Deterministic/local processing always comes before masked AI, and AI is used only for approved, explicitly-missing fields — never whole-document prompts** | "Registered deterministic classifier/parser first" (1.1 architecture step 6); "prohibit broad whole-document prompts" (1.4). |
| P12 | **Document evidence is hostile input, never an instruction** | "Delimit document evidence as hostile data, forbid following embedded instructions" (1.1); re-tested as a NO-GO-grade prompt-injection/structured-output-escape control at 1.6. |

Two additional cross-cutting facts worth surfacing explicitly because they change how this
plan is sequenced:

- **Every phase follows the identical meta-structure**: entry conditions -> discovery
  (inventory existing code, decide reuse/wrap/migrate/deprecate) -> ownership/architecture
  decisions -> implementation requirements (broken into the same kind of numbered
  sub-sections each time: catalogue/classification, schema, matching, reconciliation,
  writes, privacy, cost, testing) -> verification/live-DEV certification -> exit criteria
  (a "FULL PASS" bar, a "CONDITIONAL PASS" bar for named bounded debt only, and explicit
  automatic-FAIL/NO-GO triggers). This held with zero deviation across all six documents
  (confirmed by sampling requirement blocks throughout each file, not just the opening
  sections).
- **Each phase explicitly declares its upstream dependency in its own entry-conditions
  section** — this is not an inference, it's copied from each document: 1.2/1.3/1.4 each
  state "Depends on: AIE-1.0 [and] AIE-1.1 shared gateway"; 1.5 states "Depends on:
  AIE-1.0-AIE-1.4 contracts and certified adapter outputs"; 1.6 states it depends on "a
  completed AIE-1.0 through AIE-1.5 release candidate." None of the six documents describes
  an "AIE-1.0" deliverable location in this repository — it is referenced throughout as an
  already-approved architecture/privacy contract (ADRs, threat model, privacy
  classification, retention schedule, PC5 contract, PC6 exclusion). No such artifact was
  found in this repository (see discovery notes in the AIE-1.1 implementation report). This
  is flagged as an open dependency gap below, not silently assumed.

## 3. Phase order and boundaries

```
AIE-1.1 (shared gateway)
   |
   +--> AIE-1.2 (Investment Intelligence adapter)   --\
   +--> AIE-1.3 (FDH bank-statement adapter)          |--> AIE-1.5 (unified review/acceptance UX)
   +--> AIE-1.4 (other PDF-enabled modules)          --/         |
                                                                   v
                                                            AIE-1.6 (independent
                                                            production certification;
                                                            grants NO production authority)
```

1.2, 1.3 and 1.4 all depend only on 1.1 (not on each other) and can in principle proceed
in parallel once 1.1 is certified — but 1.2 and 1.3 are named first in the source
programme and are the priority, since Investment Intelligence and FDH bank statements are
FHIP's two most mature, highest-value canonical domains with the most existing
reconciliation infrastructure to build on. 1.4 (nine other document classes, several of
which its own eligibility framework is expected to mark DEFER or PROHIBIT rather than
IMPLEMENT_NOW) is lower priority and partly a scoping exercise in its own right. 1.5
cannot start in earnest until at least one of 1.2/1.3/1.4 has a real adapter contract to
render against (its own entry conditions require verifying "AIE-1.2/1.3 summary/reason
code/canonical-write interfaces" and "enabled AIE-1.4 module adapters"), though its shared
lifecycle/state-machine design can be scoped in parallel once 1.1's item/decision contract
exists. 1.6 requires a complete 1.0-1.5 release candidate and is explicitly the last
phase; it recommends GO/CONDITIONAL GO/NO-GO but never itself activates production.

| Phase | Depends on | Primary outcome | Owns | Must NOT do |
|---|---|---|---|---|
| **1.1** Shared gateway | AIE-1.0 (architecture/privacy contract — see gap note above) | Reusable, secure, deterministic-first document processing core: intake, quarantine, validation, extraction, classifier/parser registry, PII masking, gated AI fallback, schema validation, normalisation, reconciliation **handoff**, unresolved-item persistence | Core packages (intake/artifacts/runs/masking/schema-validation/orchestration/unresolved-items), the *only* AI provider gateway, the JSON Schema registry, the state machine | Any domain reconciliation logic, any canonical write, any review UI beyond diagnostic harness, any PC6 access |
| **1.2** Investment Intelligence adapter | 1.1 | Deterministic-first ingestion of investment statements into the existing Investment Intelligence canonical model (R1-R12) | Statement classification/extraction schema, account/owner/instrument matching, holding/cash/trade reconciliation rules, duplicate/overlap detection for this domain | Call a provider directly; invent instrument/owner/currency/cost-base; write before reconciliation+acceptance; build a second exception table; touch PC6 pricing |
| **1.3** FDH bank-statement adapter | 1.1 | Deterministic-first ingestion of PDF bank statements through the existing FDH bank CSV engine's canonical controls (R7/FDH-4) | Bank/layout catalogue, transaction-row/balance extraction schema, statement-balance and PDF/CSV-overlap reconciliation | AI merchant/MCC/category classification (stays a separate later concern); accept on failed/indeterminate balance reconciliation; duplicate transactions across PDF/CSV; touch PC6 |
| **1.4** Other PDF-enabled modules | 1.1 (reuses 1.2/1.3 patterns) | Governed adapter framework + an explicit eligibility ruling (IMPLEMENT_NOW / DESIGN_ONLY / DEFER / PROHIBIT) per document class: insurance, payslip/income, loans/liabilities, asset valuations, retirement/SMSF, goals, bills/expenses, tax-supporting evidence, cross-border docs, identity/sensitive docs | Adapter SDK/registration contract, per-class extraction+reconciliation rules for classes ruled IMPLEMENT_NOW | Promise generic "any PDF" support; implement identity/medical/legal document ingestion without separate PO+privacy+legal+security approval; give any class a parallel exception system |
| **1.5** Unified review/acceptance UX | 1.1 contracts; 1.2-1.4 adapter outputs | One shared, accessible, exception-only review/acceptance lifecycle over the exact AIE unresolved-item state from 1.1, with per-module rendering only | The single review inbox, evidence viewer, decision/correction/bulk-action model, PC5 integration, canonical-write **trigger** (still calling each domain's own write service) | Create any independent review/queue table; allow "accept anyway" over a failed/indeterminate reconciliation; let a module renderer alter lifecycle/authorization/audit |
| **1.6** Production certification | Complete 1.0-1.5 release candidate | Independent, evidence-grounded GO / CONDITIONAL GO / NO-GO recommendation, re-verifying every earlier phase's claims against a frozen RC rather than trusting them | The certification method, the false-clean-rate safety metric, the 5-stage rollout *design* | Apply any production migration, enable provider traffic, migrate real users, or activate any rollout stage — "No stage is executed by this prompt without explicit production authority" |

## 4. Honest scoping note

This programme is large. For calibration against this same codebase's own history:
Investment Intelligence took twelve phases (R0-R12) to reach its current state, and the
Financial Data Hub took roughly sixteen phases (FDH-1 through FDH-16-equivalent work,
including the R7 bank-CSV engine and FDH-4/9-12 sub-phases) across many work sessions.
Each of the six AIE documents is individually comparable in depth to one of those
module-level builds — AIE-1.1 alone specifies 332 numbered requirements across an 18-entity
data model, a 21-state processing state machine, and 24 mandatory adversarial scenarios;
1.2 and 1.3 each specify 346; 1.5 specifies 346; 1.6 specifies 360. The combined programme
(2,016 numbered requirements before accounting for the AIE-1.0 prerequisite this plan found
no evidence of in-repo) is not a task that lands in one session, or arguably even one
phase per session.

This master plan therefore explicitly sequences the programme as **at least six further
work sessions beyond this one** — one per remaining phase (1.2, 1.3, 1.4, 1.5, 1.6), plus
the AIE-1.0 gap needing an explicit Product Owner decision before 1.2-1.6 can honestly claim
their own stated entry conditions are met, since none of them can produce the ADRs/threat
model/privacy classification/PC5 contract/PC6 exclusion they say they depend on without it
existing somewhere. It also expects 1.2 and 1.3 in particular to each take multiple
sessions given their reconciliation-logic depth (holding roll-forward, cash-ledger, trade
arithmetic, and duplicate/overlap detection for 1.2; statement-balance, running-balance,
and PDF/CSV-overlap detection for 1.3), matching the multi-session pattern already
established by the Investment Intelligence and FDH programmes in this same repository.

**No AIE-1.7+ is invented.** The programme ends at AIE-1.6 exactly as specified; this plan
does not propose additional phases beyond what the six source documents define.

## 5. Open item requiring a Product Owner decision before 1.2 starts

AIE-1.0 ("architecture/privacy contract") is treated by all six documents as an existing,
already-approved prerequisite artifact (ADRs, threat model, data-privacy classification,
retention schedule, PC5 contract text, PC6 exclusion statement). No file matching that
description was found anywhere in this repository during AIE-1.1 discovery. AIE-1.1 was
implemented in this pass by treating the *equivalent* real content as living in this
repo's existing PC5/PC6 conventions (per project memory: PC5 exception single-source-of-
truth, PC6 market-data separation are established repo-wide principles already, not
invented for this pass) and by writing this document's own principles table (Section 2
above) as the working substitute for a formal AIE-1.0 ADR set. Before AIE-1.2 begins, the
Product Owner should confirm whether that substitution is acceptable or whether a
proper AIE-1.0 artifact must be authored and separately approved first.
