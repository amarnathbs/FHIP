# AIE-1.3 — FDH / Bank-Statement Adapter

**Status: IMPLEMENTED and TESTED on a feature branch, NOT certified, NOT
merged, NOT deployed.** This report describes what was built in this pass.
It is not a certification — real certification of the whole AIE-1
platform is explicitly AIE-1.6's job, not this one.

**Note on this report's own provenance.** This document did not exist when
AIE-1.3 was originally implemented (commits `7a80817`..`83eb0cd`) — every
sibling phase (1.1, 1.2, 1.4, 1.5) wrote its own `AIE_1_X_IMPLEMENTATION.md`
at the time; 1.3 did not. AIE-1.6's independent certification pass
(`AIE_1_6_CERTIFICATION_REPORT.md`, section 6) found this gap by direct
`git ls-tree` inspection and flagged it as a real, disclosed process
omission. This report is written retroactively, during AIE-1 production-
certification planning, from the actual committed code and a fresh,
independent re-run of this adapter's own test suite (not from memory or
from the commit messages' own claims alone) — it describes what IS in the
branch, not a reconstruction of intent.

Branch: `feature/aie-1-3-fdh-bank-adapter` (based on
`feature/aie-1-1-document-gateway` @ `cd2d4a2`), HEAD `83eb0cd`.

## 1. Entry-condition verification

AIE-1.1's admission/masking/schema/reconciliation-handoff/unresolved-item
contract is consumed directly and unmodified: `route.ts` imports
`validateUploadForAdmission`, `buildQuarantineStorageKey`/
`uploadToQuarantine`, `createIntake`/`updateIntakeStatus`/`recordFingerprint`/
`createRun`/`createUnresolvedItems`, `recordAieAuditEvent`,
`classifyDuplicate`, and `createDefaultDeps`/`runExtractionPipeline` from
`lib/aie/**` — the same core every other AIE adapter (1.2, 1.4) also calls
into, not a fork of it.

**One disclosed, additive change this phase made to AIE-1.1 core itself**:
`lib/aie/orchestrator.ts`'s `runExtractionPipeline()` gained an optional
`parserOverride` field on its params. Bank-statement transaction-row
extraction is not stateless (it needs an account-scoped `DedupIndex` and
prior statement date ranges resolved per-intake — see `types.ts`'s own
header), unlike AIE-1.1's global `sniffDocument()`/`aieParserRegistry`
lookup, which assumes a process-wide singleton parser. `parserOverride`
lets a caller hand the pipeline a request-scoped parser directly instead of
relying on the stateless global lookup — backward-compatible (optional,
defaults to the existing global-registry behaviour), and confirmed not to
break any of AIE-1.1's own 62 pre-existing tests.

## 2. Discovery — FDH bank-statement inventory

Confirmed via direct code reading (not assumed): FDH-5's bank-PDF engine
(`lib/financial-data-hub/bank-pdf/**`) already exists on `main` and on the
AIE-1.1 base, with 8 certified institution/layout adapters registered in
`bank-pdf/adapters/registry.ts` (AU: CBA, ANZ, NAB, Westpac; India: SBI,
HDFC, ICICI, Axis). `runBankPdfPipeline`'s deterministic stages
(`detectPdfBankAdapter`, `extractPdfStatementMetadata`, `flattenPdfLines`,
`reconstructRows`, `normalizePdfRow`) and R7's bank-CSV primitives
(`computeSourceRowHash`, `computeEconomicFingerprint`, `decideDedup`,
`reconcileBalances`, `computeDateCoverage`, `rangesOverlap`) are all pure
and synchronous once PDF byte-classification has already run — this
adapter reuses every one of them **unmodified**, adding zero new PDF
parsing, dedup, or reconciliation logic of its own (`parser.ts`'s own
header states this explicitly).

Also confirmed by direct grep, not assumed: `lib/financial-data-hub/
bank-pdf/ocr.ts` exports only an eligibility classifier
(`determineOcrEligibility`) — no OCR engine is wired into `classifyPdf`,
`runBankPdfPipeline`, or `bankPdfProcessingService.ts` anywhere in this
repository. FDH-5 already terminally rejects an image-only PDF
(`error_code: 'ocr_required'`) rather than guessing; this adapter inherits
that limitation unchanged.

## 3. Certified document catalogue

Exactly FDH-5's own already-certified 8 institution/layout adapters
(`CERTIFIED_PDF_BANK_ADAPTER_IDS`, generated directly from
`PDF_BANK_ADAPTER_REGISTRY` so this list cannot silently drift from what is
actually certified). No new institution/layout was added by this phase.
Explicitly NOT supported, by inheritance from FDH-5, not a new limitation
this phase introduces: any institution outside those 8, and any scanned/
image-only statement (no OCR engine exists).

## 4. What was built

- **Migration `0142_aie1_3_fdh_bank_statement_adapter.sql`** — two nullable
  columns on the existing `aie_write_batch` table
  (`canonical_reference_table`, `canonical_reference_id` referencing
  `fdh_statement_uploads(id)` on delete set null). No new table, no new RLS
  policy (the existing `aie_write_batch` policy is row-scoped, already
  covers the new columns). **Held locally — not applied to any DEV or
  production database.** Originally numbered `0141`; renumbered to `0142`
  after a genuine, caught-before-shipping collision with the concurrently
  developed `feature/aie-1-2-investment-adapter` branch (see the
  migration's own header comment for the full timeline) — the collision
  check was re-run immediately before finalising, per this repository's
  own documented discipline, and found the real collision rather than
  missing it.
- **`lib/aie/adapters/fdhBankStatement/`** (7 files):
  - `types.ts` — shared field-name vocabulary and the
    `FdhBankStatementParseContext`/`FdhBankStatementParseOutcome` shapes.
  - `parser.ts` — `createFdhBankStatementParser(ctx)`, a **factory**
    (not a singleton) producing one request-scoped `RegisteredParser`
    bound to one intake's account/dedup context — disclosed as a
    deliberate architectural deviation from AIE-1.1's assumption that
    every registered parser is stateless.
  - `reconciliation.ts` — `fdhBankStatementReconciliationRule`, translating
    FDH-5's own closed reconciliation-status enum
    (`not_available|pending|reconciled|failed|user_accepted_exception`)
    onto AIE-1.1's `pass|pass_with_tolerance|fail|indeterminate|
    not_applicable` vocabulary. Structurally cannot be influenced by AI: the
    rule's signature carries no `confidence` parameter, and the one
    AI-eligible candidate this adapter ever produces
    (`INSTITUTION_HINT_FIELD_NAME`) is read only for display/audit
    enrichment on an already-decided outcome.
  - `atomicImport.ts` — `commitFdhBankStatementImport()`, which writes
    NO canonical row itself; it calls FDH-5's own unmodified
    `uploadBankPdf()` → `processBankPdfDocument()` (the exact functions the
    existing `/api/financial-data-hub/bank-pdf/upload` route already
    calls). Records a `pending` `aie_write_batch` row before attempting the
    write and `committed`/`failed` after, so a mid-commit crash is never
    silently unrecorded.
  - `schema.ts` — two Zod schemas registered into AIE-1.1's
    `aieSchemaRegistry`: a closed institution-hint enum (only a real
    certified adapter id is ever accepted from an AI candidate — never a
    free-text institution name) and a documentation/test schema mirroring
    the parser's own deterministic candidate shape. **Disclosed limitation,
    stated directly in the file's own header**: AIE-1.1 core's
    `runExtractionPipeline` hardcodes every AI-fallback call to its own
    generic schema — no per-adapter schema-selection hook exists yet, so
    this registration does not (this pass) gate the live AI call itself.
  - `featureFlags.ts` — 3 flags, all default OFF (`AIE_FDH_BANK_ADAPTER_
    ENABLED`, `AIE_FDH_BANK_AI_FALLBACK_ENABLED`,
    `AIE_FDH_BANK_ATOMIC_IMPORT_ENABLED`). Independently re-confirmed none
    are set in any `.env*` file in this checkout.
  - `index.ts` — registers a genuinely stateless classification-only
    parser (institution/layout sniffing) into AIE-1.1's global
    `aieParserRegistry`; the request-scoped row-extraction parser is NOT
    globally registered (see `parser.ts`'s own rationale).
- **`app/api/aie/fdh-bank/intake/route.ts`** — the AIE-fronted intake route:
  admission → quarantine → FDH-5's own byte-level PDF classification
  (reused unchanged) → read-only account-identity resolution (reused
  unchanged) → this adapter's parser bridge via `parserOverride` →
  reconciliation → (gated, OFF by default) commit. **Additive only** — the
  existing `/api/financial-data-hub/bank-pdf/upload` route is completely
  unmodified and unaffected by this route's existence.

AI scope, precisely: the ONLY AI-eligible gap this adapter ever declares is
an institution-hint on an ambiguous (two-certified-candidates-too-close-to-
call) layout. Every transaction-level fact (date, amount, sign, currency,
balance, status) is permanently excluded from `aiEligibleGaps` by
construction, regardless of how many rows are rejected on an otherwise-
detected layout.

## 5. Non-negotiable prohibitions — self-check (not a certification)

- No raw statement/account/holder identifier reaches an external AI
  provider: the only AI-eligible candidate is the institution hint, itself
  validated against a closed enum of already-certified adapter ids before
  it can ever be displayed.
- No AI invention of a transaction fact: `aiEligibleGaps` is always empty
  once a layout is unambiguously detected; a rejected row stays rejected,
  never AI-repaired.
- No acceptance when balance reconciliation materially fails or is
  indeterminate: `reconciliation.ts` maps `failed`→`fail`, `pending`→
  `indeterminate`, an undetected/ambiguous/all-rejected layout→
  `indeterminate` — never silently `pass`. AIE-1.1 core's own
  `blockingItemsForReconciliation` (unchanged) turns any of these into a
  blocking unresolved item before the route ever reaches its commit step.
- No duplicate transaction import from PDF/PDF or PDF/CSV overlap: per-row
  economic-fingerprint dedup is the same shared index CSV imports already
  use (`bank-csv/dedup.ts`, unchanged); a statement-period overlap is
  additionally surfaced as its own, separate `indeterminate` reconciliation
  rule so an overlapping period is never invisible even when every
  individual row happens to dedup cleanly.
- No second exception table/state machine: reuses `aie_unresolved_item`
  as-is for both account-identity ambiguity and reconciliation failure —
  the migration adds no new exception table.
- No unsupported-institution certification: an undetected layout returns
  `outcome: 'failed'`, `failureReason: 'unsupported_layout'` — never
  coerced into a supported-looking result.
- No production migration/activation/backfill: migration held locally,
  every flag default OFF, confirmed unset in any environment.

**One real, disclosed architectural gap, found by AIE-1.6's certification
pass, not by this adapter's own original development**: `atomicImport.ts`'s
own header states it "does not re-check the AIE reconciliation-run rows
itself... trusts its caller" to have already gated on outcome — this is
the same shape AIE-1.4's Insurance route had BEFORE AIE-1.5 removed that
self-accept placeholder and centralized the gate in `accept.ts`. Because
this branch was never merged into 1.5, its commit path still lives
entirely inside its own intake route (`route.ts`'s own `if
(outcome.finalStatus === 'awaiting_acceptance')` check) rather than
AIE-1.5's independently-tested, centralized acceptance gate. This is a
real integration debt the eventual branch merge needs to resolve (adding a
branch to `accept.ts`, not rebuilding this gate) — not a defect in this
adapter considered in isolation, where the trust-the-caller shape is
internally consistent and its one caller (`route.ts`) does correctly gate
on `blockingItemsForReconciliation` before ever invoking it.

## 6. Verification evidence actually observed

Independently re-run for this report, not trusted from the original commit
messages alone:

```
npx vitest run tests/unit/aieFdhBankStatement*.test.ts
  -> Test Files  3 passed (3)
  -> Tests  23 passed (23)
```

This matches the original development commit's own claim exactly (unlike
the discrepancy AIE-1.6 found in AIE-1.5's own report) — 23 real tests
across `aieFdhBankStatementParser.test.ts`,
`aieFdhBankStatementReconciliation.test.ts`, and
`aieFdhBankStatementOrchestratorIntegration.test.ts`, covering: certified-
layout detection, ambiguous-layout AI-hint declaration, unsupported-layout
rejection, row normalisation/rejection, dedup decisioning, balance-
reconciliation status translation, date-range-overlap detection, and one
full orchestrator-integration run proving the pipeline reaches
`awaiting_acceptance` only when every reconciliation rule genuinely passes.
One real bug was found and fixed during the original development pass (per
commit `0b7a192`): an `ambiguous` vs `unsupported_layout` branch-ordering
defect in `parser.ts` that would have silently mis-filed an ambiguous
statement as unsupported, losing its AI-eligible-gap declaration.

`npx tsc --noEmit` and `npx eslint` were re-verified as part of AIE-1.6's
own certification pass against the 1.5-merged codebase (which does not
include this branch's code) — this report does not re-claim those numbers
for 1.3's own unmerged branch specifically, since re-running them here
would require the same node_modules-junction workaround every prior AIE
report discloses using, which was already performed once for this
specific test command above; a full independent tsc/eslint/build re-run of
this exact branch in isolation was not additionally repeated for this
retroactive report, to avoid re-doing verification the original commits
already report and this report's own test re-run already independently
corroborates for the test-count dimension specifically.

Migration collision-freedom was already independently re-verified by
AIE-1.6's certification pass (`AIE_1_6_CERTIFICATION_REPORT.md` section 1)
against `origin/main`, `feature/lr-1-upload-security-lifecycle`, and
`feature/aie-1-2-investment-adapter` — all clean.

## 7. Honest limitations / deferred work

- **Scanned/OCR statements are not supported** — inherited from FDH-5, not
  a new limitation.
- **No password-protected-PDF retry flow** — matches the generic
  `/api/aie/intake` route's own already-disclosed limitation.
- **Per-page fidelity is reduced through the AIE bridge**: `parser.ts`
  treats the entire extracted document as one page (`flattenPdfLines([fullText], adapter)`)
  rather than FDH-5's own genuine per-page array, so `sourcePage` numbers
  reported through this bridge are always `1`. The full-fidelity per-page
  path remains FDH-5's own existing, unmodified `runBankPdfPipeline`/upload
  route, which `atomicImport.ts` calls for the actual canonical write —
  this precision loss affects only AIE's own audit-trail display, not the
  actual imported transaction data.
- **The commit path is not yet migrated onto AIE-1.5's centralized
  `accept.ts` gate** — see section 5's own disclosure above. This is the
  single most material integration item for the planned branch merge.
- **No live-DEV/Supabase verification** — every test above runs against
  fully injected/faked dependencies (same disclosed constraint as every
  other AIE phase to date).
- **No AI fallback fixture ever exercises the institution-hint path** — the
  schema and reconciliation-read-path exist and are unit-tested in
  isolation, but no end-to-end fixture in this adapter's own test suite
  drives an actual ambiguous-layout-then-AI-hint-then-review scenario
  through the full pipeline.
- **This report itself is retroactive** — written during AIE-1 production-
  certification planning, not at the time of original implementation. It
  describes the branch as committed; it does not add, remove, or modify any
  code.

## 8. What this means for AIE-1.4/1.5/1.6

This branch was never merged into `feature/aie-1-5-exception-review-ux`,
so AIE-1.5's own centralized review UX has no live integration test against
this adapter — its module descriptor there is explicitly flagged
`integrationTested: false`. AIE-1.6's independent certification correctly
treated this branch as "paper-reviewed only, not runtime-verified" for
exactly this reason. The eventual AIE branch merge (separately planned,
not executed by this report) needs to: (1) migrate this adapter's commit
path onto `accept.ts`'s centralized gate per section 5's disclosure, (2)
resolve the `parserOverride` core change's interaction with any other
branch that may also touch `orchestrator.ts`, and (3) re-run this adapter's
own 23-test suite plus AIE-1.5's own suite together, on the merged result,
before any of this can move from "paper-reviewed" to "real, executed
evidence."
