# II-PC4 — Post-Closure Regression Contract

**Mission:** FHIP — Investment Intelligence + AIE-1 Convergence, Master End-to-End Execution
**Phase:** M1 — PC4 terminal verification (Part G.2 of the master dispatch)
**Date:** 2026-09-15
**Branch:** `mission/m1-pc4-verification-2026-09-15`
**Baseline commit (`origin/main`):** `23b49da1d63c9c20f980ea9042e176845b6f60e3` (re-fetched 2026-09-15; unchanged from M0)
**Companion documents:** `II_PC4_VERIFICATION_VERDICT_2026-09-15.md` (this phase's verdict),
`II_POST_PC4_MASTER_SCOPE_LEDGER_2026-09-15.md` and
`II_PC4_MIGRATION_AND_CONFIG_BASELINE_2026-09-15.md` (M0)

---

## 0. What this document is, and is not

**It is** the list of behaviours that PC4's implementation currently enforces in `origin/main`,
each pinned to the exact source line that enforces it and the exact test file(s) that currently
cover it. Later AIE-1 / PC5 / PC6 / PC7 work must not break any of them. Every citation below
was verified line-by-line against the working tree at `23b49da` on 2026-09-15 — no citation is
carried over from an older report.

**It is not** a restatement of PC4's requirements, and it is not a certification. PC4's own
≥48-section specification has never been committed to this repository and was not found on the
Product Owner's filesystem either (M0 operator item **OA-1**, re-confirmed this phase — see the
verdict document §2). This contract therefore describes **what the code does today**, which is
the only thing a later phase can actually regression-test against.

**Scope note.** Two invariants the dispatch names are, on the evidence, **not implemented**
(PC4-INV-12 owner *mismatch*, PC4-INV-16 production cleanup). They are recorded here as
`NOT ENFORCED` rather than omitted, so a later phase cannot mistake silence for coverage.

---

## 1. Execution baseline for this contract (Part W exact counts)

| Measure | Value |
|---|---|
| Test files inspected (II scope, path/name matching `/ii\|investment.?intelligence\|cams\|kfintech\|folio/i`) | **102 matched; 94 genuine II test files** (7 `aiInsightPack*` false positives on the `aiI` substring; 1 helper, `tests/support/buildEncryptedCamsPdf.ts`) |
| — of those, under `tests/unit/` | **85** |
| — of those, under `tests/live-dev/` | **9** |
| II e2e specs under `tests/e2e/` | **0** |
| Test files **executed** this phase | **85** (`tests/unit/ii*`, `tests/unit/reportsIIChapters`, `tests/unit/fdh11AuInvestmentIntelligence`) |
| Result | **84 passed, 1 skipped, 0 failed — 1,673 tests passed, 5 skipped, 0 failed** |
| Source files line-verified for this contract | 16 |
| Live read-only PRODUCTION probes run | 3 scripts, 4 negative controls, all 4 correctly failed |

> **Load-bearing execution fact — the live-dev tests are dormant.**
> `vitest.config.ts:5` sets `include: ['tests/unit/**/*.test.ts']`. **The 9
> `tests/live-dev/*.test.ts` files never run under `npm test`.** Several invariants below
> (PC4-INV-06 CAS↔Folio overlap, PC4-INV-10 read-side immutability, PC4-INV-14 cross-user
> isolation, PC4-INV-17 wrong-password atomicity) are covered **only** there. A later phase
> that runs `npm test` and sees green has **not** regression-tested those four.

> **Pre-existing environment gap, now closed locally (Part W.3 — no hand-waving).**
> `pdf-parse` is a declared runtime dependency (`package.json` → `dependencies`, `^2.4.5`) but
> was **absent** from the shared `D:\FHIP\node_modules` install, which made 5 test files fail to
> import (`iiPc3QualificationPack`, `iiPc3RealVariantQualificationPack`, `iiPc3GateAAltCamsLayout`,
> `iiR2PdfExtraction`, `iiManualImporter`). This is an incomplete install, not a defect — it is
> independently corroborated by commit `20a7787`'s own message (2026-09-14), which records the
> same pre-existing missing-package set. It was installed into an isolated worktree
> `node_modules` for this phase; **all 5 files then passed.** Nothing in the repository was
> changed to achieve this.

> **Certification-fixture reproducibility (incidental evidence).** Running the suite rewrote
> `scripts/ii-r5-certification/comparison_report.json` and
> `scripts/ii-r6p1-certification/comparison_report.json`. `git diff --stat` showed **1 changed
> line each — the `generatedAt` timestamp only**; every certification figure reproduced
> byte-identically. Both files were reverted; the worktree is clean.

---

## 2. The regression contract

Severity legend — **P0** = a break silently corrupts user financial truth or leaks across
tenants; **P1** = a break produces a wrong-but-detectable result or blocks a real journey;
**P2** = a break degrades quality signalling only.

All paths are relative to the repository root. All line numbers are against `23b49da`.

---

### PC4-INV-01 — CAMS CAS (consolidated account statement) ingestion — **P0**

A CAMS consolidated statement in the alt layout must parse to the same accounts, schemes,
transactions and holdings it parses to today, including the three grammar shapes PC4 fixed
(page-level header reprint, glued Price+Units, split fee rows) and the wrapped-row shape.

| Enforced by | |
|---|---|
| Parser object / code / version | `lib/services/investment-intelligence/parsers/camsParser.ts:523` (`camsParser`); code `CAMS_PARSER_CODE='cams_detailed_v1'` :88, version :89 |
| Detection | `camsParser.ts:529` (`canHandle`); title/registrar `:107` `TITLE_ALT_LINE_RE`, `:112` `ALT_REGISTRAR_RE` |
| Entry points | `:623` `parseAccounts`, `:663` `parseTransactions`, `:1151` `parseHoldings`, `:1356` `validateParsedOutput` |
| **Core transaction-row grammar** | **`:202` `ALT_TXN_ROW_RE`** (used `:956`) |
| Glued Price+Units (defect #2) | `:221` `ALT_TXN_ROW_GLUED_RE` (used `:963`); unique-candidate splitter `:236` `splitGluedPriceAndUnits` |
| **Wrapped-row recovery (defect #7b)** | **`:291` `ALT_TXN_ROW_WRAPPED_START_RE`** (used `:1010`); `:298` `BARE_BALANCE_LINE_RE` |
| Page-level header reprint (defect #1) | `:196` `OPENING_BALANCE_RE`, consumed at `:842` to turn `inTable` on |
| Split fee rows (defect #3) | `:397` `ALT_FEE_ROW_RE`, `:410` `ALT_FEE_ROW_SPLIT_DATE_AMOUNT_RE`, `:411` `ALT_FEE_ROW_LABEL_ONLY_RE` |
| Scheme header / closing / NAV | `:139` `ALT_SCHEME_LINE_RE`, `:168` `canContinueSchemeHeader`, `:352` `BARE_AMC_NAME_RE`, `:372` `bareAmcLineIsWrapStart`, `:320` `ALT_CLOSING_RE` (used `:1312`), `:335` `ALT_NAV_MARKET_VALUE_RE` (used `:866`, `:1266`) |

**Tests:** `tests/unit/iiPc3GateAAltCamsLayout.test.ts` (Gate A findings #2/#5/#6/#7/#9/#10/#12 — real PDF bytes → `pdf-parse` → detector → parser), `tests/unit/iiR2ParserFixtures.test.ts`, `tests/unit/iiCamsPageLevelHeaderGluedNumbersAndSplitFeeRows.test.ts`, `tests/unit/iiCamsAltLayoutNavMarketValueExtraction.test.ts`, `tests/unit/iiCamsBareAmcNameVsWrappedSchemeHeaderPriority.test.ts`, `tests/unit/iiCamsCurrencylessClosingBalanceAndBareAmcName.test.ts`, `tests/unit/iiCamsSinceInceptionUnlabelledStatementPeriod.test.ts`, `tests/unit/iiCamsWrappedSchemeHeaderAndKfintechRegistrar.test.ts`, `tests/unit/iiPc3QualificationPack.test.ts`, `tests/unit/iiPc3RealVariantQualificationPack.test.ts`; live-dev `tests/live-dev/iiPc3RealCamsQualificationLiveDev.test.ts`, `tests/live-dev/iiPc3RealVariantQualificationLiveDev.test.ts`.

**Coverage gap:** the CAS-layout `OPENING_BALANCE_RE` (`:196`/`:842`) has **no dedicated unit test**. The tested opening-balance path is the FS1 one (PC4-INV-08).

---

### PC4-INV-02 — CAMS Folio Details (FS1) statement ingestion — **P0**

The Folio Details statement variant must keep winning detection over CAS for a genuine folio
statement, and must stay **fail-closed**: it may not claim a document on a single weak signal.

| Enforced by | |
|---|---|
| Parser object / code | `lib/services/investment-intelligence/parsers/camsFolioStatementParser.ts:182` (`camsFolioStatementParser`); `CAMS_FOLIO_STATEMENT_PARSER_CODE='cams_folio_details_v1'` `:83` |
| **Fail-closed detection floor** | **`:188` `canHandle`**, floor at **`:230-234`** — requires `hasFolioIdentity && hasStructuralSection` |
| Detection signals | `:94` `FOLIO_NUMBER_LABEL_RE`, `:95` `FOLIO_DETAILS_HEADING_RE`, `:96` `SUMMARY_OF_HOLDINGS_RE`, `:97` `FINANCIAL_TRANSACTIONS_RE`, `:98` `ISIN_CODE_LABEL_RE`, `:99` `STATEMENT_DATE_LABEL_RE`, `:105` `CAS_TITLE_RE` (negative signal) |
| Grammar | `:107` `SECTION_HEADING_RE`, `:125` `SCHEME_ISIN_HEADER_RE`, `:127` `OPENING_BALANCE_ROW_RE`, `:133` `FULL_TXN_ROW_RE` |
| Entry points | `:286`, `:323`, `:506`, `:585` |
| Registry + threshold | `lib/services/investment-intelligence/parsers/registry.ts:19` `PARSER_REGISTRY`, `:21` `SOURCE_DETECTION_CONFIDENCE_THRESHOLD = 0.5`, `:37` `detectSource`, `:99` `parseExtractedDocument` |

**Tests:** `tests/unit/iiFs1FolioStatementFixtures.test.ts` (FS1-T01..T04b precedence + negative controls at `:167-231`; FS-Q01/03/04/08-12; T10/T11); live-dev `tests/live-dev/iiFs1CamsFolioStatementLiveDev.test.ts`.

**Stale reference to fix (housekeeping, not a defect):** `camsFolioStatementParser.ts:93` cites a test file `iiFs1SourceDetection.test.ts` that **does not exist**; those cases live in `iiFs1FolioStatementFixtures.test.ts:167-231`.

---

### PC4-INV-03 — KFintech ingestion, **to the extent certified** — **P1**

| Enforced by | |
|---|---|
| Parser object / code | `lib/services/investment-intelligence/parsers/kfintechParser.ts:74`; `KFINTECH_PARSER_CODE='kfintech_detailed_v1'` `:50` |
| Detection / grammar | `:80` `canHandle`; `:53` `TITLE_RE`, `:54` `RTA_RE`, `:56` `TXN_ROW_RE` (DD/MM/YYYY), `:59` `CLOSING_RE` |
| Entry points | `:128`, `:168`, `:271`, `:348` |

**Certification boundary — state this plainly in any later claim.** KFintech is certified
**against synthetic fixtures only**. The file header (`kfintechParser.ts:1-7`) says so itself
("synthetic-but-structurally-faithful"); fixtures live in
`lib/fixtures/investment-intelligence/r2-cas/kfintech/`. **No real-KFintech-document
qualification pack exists** — the PC3 qualification packs are CAMS-only.

**Tests:** `tests/unit/iiR2ParserFixtures.test.ts`, `tests/unit/iiCamsWrappedSchemeHeaderAndKfintechRegistrar.test.ts`, `tests/unit/iiR2PdfExtraction.test.ts` (KFIN-002 password cases).

---

### PC4-INV-04 — Account / folio identity and same-folio convergence — **P0**

Two statements describing the same real folio must converge onto **one** `ii_accounts` row; two
different AMCs sharing a folio *number* must not.

| Enforced by | |
|---|---|
| Folio normalisation | `lib/services/investment-intelligence/accountResolution.ts:10` `normaliseFolioNumber` |
| **Sentinel** | **`:54` `UNKNOWN_AMC_SENTINEL = 'Unknown AMC'`** |
| **Resolution** | **`:73` `resolveOrCreateAccount`** — exact `(institution, normalised folio)` match `:86`; **folio-only fallback `:88-116`** (sentinel-side single-candidate adopt `:100-101`; real-name-side sentinel upgrade `:108-115`) |
| Planning (PC1-D1) | `:176` `accountResolutionKey`, **`:187` `planFolioAccountResolution`** (`'Unknown AMC'` fallback `:226`) |
| Call site | `lib/services/investment-intelligence/documentProcessing.ts:360-375` (loop over `resolutionPlan.assignments`) |

**Tests:** `tests/unit/iiPc1AccountIdentity.test.ts` (D1-R1..R5 including the mandatory same-folio-number / different-AMC negative control at `:180`), `tests/unit/iiR12NegativeControlIdentityResolution.test.ts`, `tests/unit/iiPc3QualificationPack.test.ts:244` (Q03 two-folio plan).

**Coverage gap:** the `be9e36f` folio-only fallback branches (`:88-116`, the sentinel adopt/upgrade paths) have **no unit test** — they are proved only by `tests/live-dev/iiFs1CamsFolioStatementLiveDev.test.ts:335` (FS-Q05) and `:422` (FS-Q07), which `npm test` does not run.

---

### PC4-INV-05 — Exact reimport idempotency — **P0**

Re-uploading or reprocessing the identical document must create **zero** additional economic
rows.

| Layer | Enforced by |
|---|---|
| Transaction fingerprint | `lib/services/investment-intelligence/fingerprint.ts:50` `computeTransactionFingerprint` (SHA-256 over `sourceKey\|accountId\|instrumentId\|dateIso\|type\|amount\|units\|nav\|sourceReference`) |
| Bulk dedupe prefetch | `documentProcessing.ts:588` `existingFingerprints`; computed `:603`; hit → link-not-insert `:615-622` |
| **In-run collision guard** | **`documentProcessing.ts:756`** — the same map also absorbs a collision *within one import*, not only a pre-existing one |
| Document checksum dedupe | `app/api/investment-intelligence/source-documents/route.ts:49` (sha256) + `:56` lookup → `{deduplicated:true}` `:57` |
| DB uniqueness | `supabase/migrations/0032_ii_source_documents_accounts.sql:45-47` `uidx_ii_source_documents_user_checksum` |
| One-active-run constraint | `supabase/migrations/0039_ii_r2_audit_and_document_lifecycle.sql` `uidx_ii_document_parse_runs_one_active`; app check `documentProcessing.ts:176-182`; **stale-run rescue `:183-196`** (`STALE_RUN_MS` `:175` — PC4 defect #5) |
| Prior-succeeded short-circuit | `documentProcessing.ts:200-240` |
| Manual-import replay | `manualImporter.ts:95`, `:112-127`, `:153-161`, `:205-215` |

**Tests:** `tests/unit/iiR2Fingerprint.test.ts`, `tests/unit/iiR2Dedup.test.ts` (DEDUP-001..005; `:99` asserts migration `0039` really contains the index), `tests/unit/iiR3DedupScenarioMatrix.test.ts`, `tests/unit/iiPc3QualificationPack.test.ts:212` (Q05 exact reimport) and `:228` (Q04 monthly delta), `tests/unit/iiManualImporter.test.ts`. End-to-end DB-level reimport: live-dev only (`iiFs1CamsFolioStatementLiveDev.test.ts:382`, FS-Q06).

---

### PC4-INV-06 — Cross-source overlap with no economic duplication — **P0**

A transaction seen in both a CAS and a folio statement must be **linked**, never inserted twice,
and the outcome must be independent of import order.

| Enforced by | |
|---|---|
| Engine | `lib/services/investment-intelligence/crossSourceIdentity.ts:65` `CROSS_SOURCE_IDENTITY_ENGINE_VERSION='r11-cross-source-identity-v1'`; `:84` `compareCrossSourceTransactions`; **`:157` `resolveCrossSourceTransactionMatch`**; `:289` `resolvePrecedenceWinner` |
| Candidate load | `documentProcessing.ts:529` `loadCrossSourceCandidates`; match call `:632` |
| **Link-not-duplicate** | **`documentProcessing.ts:651-664`** — on `exact` / `high_confidence`, upsert `ii_transaction_source_links` with `is_originating: false`; comment at `:652-653` names it "spec section 5's core invariant" |
| Ambiguity fail-closed | `:685-707` — conflict/ambiguous rows are inserted with `status='review_required'`, **never silently merged** |
| Schema | `supabase/migrations/0082_ii_r11_cross_source_reconciliation.sql`, `0086_ii_r11_0082_completion.sql` |

**Tests:** `tests/unit/iiR11CrossSourceIdentity.test.ts` (CS-01..48, PP-01..10, including import-order independence).

**Coverage gap:** the specific **CAS ↔ Folio-statement** overlap is covered only by `tests/live-dev/iiFs1CamsFolioStatementLiveDev.test.ts:435` (folio-first) and `:459` (CAS-first) — **not runnable under `npm test`**.

---

### PC4-INV-07 — Account-scoped FIFO — **P0**

A disposal in account A must never consume a lot held in account B.

| Enforced by | |
|---|---|
| **Scope declaration** | **`lib/engines/investment-intelligence/tax/taxLotEngine.ts:18`** — `// LOT SCOPE — (user, ACCOUNT, instrument). II-PC1-F1, 2026-09-02.` |
| Required `accountKey` | `:70`, `:86`, `:100`, `:115` |
| **Build guard** | **`:135` `buildTaxLots`**, throw at **`:145`** if an acquisition event has no `accountKey` |
| **FIFO candidacy filter** | **`:176` `consumeLotsFifo`**, guard `:181-183`, filter **`:191`** — `l.accountKey === disposal.accountKey && l.instrumentKey === disposal.instrumentKey && l.unitsRemaining > EPSILON` |
| Over-disposal error | `:237` |
| Input scoping | `lib/services/investment-intelligence/taxRepository.ts:148` `const accountKey = r.account_id` (rationale `:142-147`); `accountIdsByInstrument` `:138`, `:162-164` |
| **Persistence fail-closed** | `taxRepository.ts:480` `account_id: l.accountKey \|\| null`; **`:493-496`** refuses to persist lots with no account |
| Decision record | `docs/investment-intelligence/II_PC1_F1_FIFO_SCOPE_DECISION.md` |

**Tests:** `tests/unit/iiPc1F1FifoAccountScope.test.ts` (F1-T01..T10 + NC-F2..F4, including the RED proof at `:350` that the old instrument-only rule picks the wrong lot), `tests/unit/iiR6FinalTaxLotPersistenceFix.test.ts`; live-dev `tests/live-dev/iiPc1F1FifoAccountScopeLiveDev.test.ts`.

---

### PC4-INV-08 — Opening-balance safety / no fabricated tax lots — **P0**

A printed opening balance is evidence of a position, **not** an acquisition. It must never
become a tax lot with an invented cost base.

| Enforced by | |
|---|---|
| **Marker** | **`lib/services/investment-intelligence/openingBalanceMarker.ts:17`** `OPENING_BALANCE_SOURCE_REFERENCE = 'OPENING_BALANCE'` — carried on an `'adjustment'`-typed row |
| Parser emit (FS1) | `camsFolioStatementParser.ts:127` `OPENING_BALANCE_ROW_RE` → `:367` → `:388` sets `sourceReference`; re-export `:164` |
| Parser detect (CAS) | `camsParser.ts:196` `OPENING_BALANCE_RE`, used `:842` |
| **Exclusion from lots** | `taxRepository.ts:49` `ACQUISITION_TYPE_MAP` contains **no `'adjustment'` key**; the `else` at `:165` `DISPOSAL_TYPES` also excludes it |
| Completeness wiring (`be9e36f`) | **`documentProcessing.ts:1158`** `hasExplicitOpeningBalanceTransaction`; **`reconciliation.ts:148`** returns `'complete_from_known_opening_balance'`; `:109` `canSumFromZero`; `:141` `determineHistoryCompleteness` |
| Consumers | `certification.ts:85`, `publicationLogic.ts:136`, `dataQuality.ts:33`, `analyticsRepository.ts:385`, `lib/engines/investment-intelligence/dataQuality.ts:39` |
| Enum | `supabase/migrations/0040_ii_r2_transaction_lineage_and_dedup.sql:104`, `0041_...:82` |

**Tests:** `tests/unit/iiFs1FolioStatementFixtures.test.ts:129` (FS-Q04 — Opening Balance is never a purchase/acquisition), `tests/unit/iiR2Reconciliation.test.ts:83` (REC-004 cannot-evaluate, never fabricated) and `:134`, `tests/unit/iiR2DataQualityAndConfig.test.ts:9`, `tests/unit/iiR4DataQualityAndFabrication.test.ts:39` (DQ-004), `tests/unit/iiR5NoFabrication.test.ts`, `tests/unit/iiR3PublicationLogic.test.ts:111`; live-dev `iiFs1CamsFolioStatementLiveDev.test.ts:297`.

---

### PC4-INV-09 — Current-result selection — **P1**

Exactly one capital-gains row per disposal is "current": the newest valid computation **for the
current engine version**. Stale-engine rows must never win.

| Enforced by | |
|---|---|
| **Selector** | **`lib/services/investment-intelligence/taxRepository.ts:706` `selectCurrentCapitalGainsRows`** — rule `LATEST_VALID_COMPUTATION_FOR_CURRENT_ENGINE`, documented `:617-673` |
| Clause 1 (engine) | **`:709`** `r.engine_version === TAX_ENGINE_VERSION` (constant imported `:41` from `lib/engines/investment-intelligence/tax/taxVersioning.ts` — **never a literal**) |
| Clause 2 (recency) | `:710-714` newest `computed_at` per `disposal_transaction_id` |
| Decision record | `docs/investment-intelligence/II_PC1_F2_CURRENT_RESULT_SELECTION_DECISION.md` |

**Tests:** `tests/unit/iiPc1F2CurrentResultSelection.test.ts` (F2-U01..U10, incl. U08 constant-not-literal and U09 1,200×3 scale); live-dev `tests/live-dev/iiPc1F2EngineVersionConsumersLiveDev.test.ts`.

---

### PC4-INV-10 — Read-side provenance immutability — **P1** — ⚠️ **DOCUMENT-ENFORCED ONLY**

A read must never mutate stored provenance. In particular `closed_at` on a tax lot must be the
lot's original close time, not "now" on every read-back.

| Enforced by | |
|---|---|
| **Only code-level enforcement** | **`lib/services/investment-intelligence/taxRepository.ts:436-453`** (rationale block), **`:458-466`** (read-back of the existing `closed_at`), **`:490`** `closed_at: isClosed ? (existingClosedAtById.get(id) ?? nowIso) : null` inside `persistTaxLots` (`:454`) |
| Decision record | `docs/investment-intelligence/II_PC2_F1_READ_SIDE_DECISION.md` |
| Static inventory of all 26 GET handlers | `docs/investment-intelligence/II_PC2_F1_GET_MUTATION_INVENTORY.md` |

> ⚠️ **There is no generic runtime or lint guard preventing a GET route from mutating.** The
> invariant is held by a **documented static inventory** plus live-dev tests. **A later phase
> that adds a GET route is not automatically covered.** Any AIE/PC5 read surface added over II
> data must be added to `II_PC2_F1_GET_MUTATION_INVENTORY.md` by hand.

**Tests:** live-dev **only** — `tests/live-dev/iiPc2F1ReadSideMutationLiveDev.test.ts`, `iiFs1CamsFolioStatementLiveDev.test.ts:542`, `iiPc3RealCamsQualificationLiveDev.test.ts:494`, `iiPc3RealVariantQualificationLiveDev.test.ts:529`. **No unit test exists.**

---

### PC4-INV-11 — Net worth counted exactly once — **P0**

One economic position contributes to net worth exactly once, across II publication, the manual
Investments register, and refresh/republish.

| Enforced by | |
|---|---|
| Single-target routing | `lib/services/investment-intelligence/publishing.ts:15` `computePublicationTarget`; structural publish `:32` `publishPositionStructural` (ADR-004 dedup lookup `:41-46`) |
| Duplicate detection / register action | `publicationLogic.ts:256` `detectDuplicateCandidates`, `:354` `classifyRegisterAction`, `:378` `decideRefreshSupersession` |
| **Idempotency key** | **`publicationLogic.ts:432` `computeIdempotencyKey`** (`accountId` + `instrumentId` + `canonicalPositionId` + `publicationTarget`) |
| Publish path | `investmentPublicationService.ts:430` `publishPosition` — idempotency short-circuit **`:463-464`**; manual-row supersession `:567`; `:673` `unpublishPosition`, `:711` `republishPosition`, `:816` `refreshPosition` (supersede-first ordering `:871-921`) |
| Contract | `docs/investment-intelligence/R0_NET_WORTH_DEDUP_CONTRACT.md` |
| Schema | `supabase/migrations/0042_ii_r3_fhip_publishing_bridge.sql` |

**Tests:** `tests/unit/iiR3NetWorthCertification.test.ts` (NW-001..008, FIN-001..010, DD-006/008/009 — plus a **mutation test at `:227` that proves the suite actually catches a double-count regression**), `tests/unit/iiR3PublicationLogic.test.ts`, `tests/unit/iiPublishing.test.ts`, `tests/unit/iiR3RepublishFieldRestoration.test.ts`, `tests/unit/iiR9GoalAllocationLifecycle.test.ts`.

---

### PC4-INV-12 — Owner mismatch safe blocking — **P0** — ⚠️ **PARTIALLY ENFORCED; the mismatch half does not exist**

**What IS enforced — owner *unresolved*.** A statement uploaded without a household member
mapped opens a **blocking** reconciliation case and blocks certification.

| Enforced by | |
|---|---|
| Detection | `documentProcessing.ts:377` `const ownerUnresolved = !doc.owner_member_id;` |
| Blocking case | `:378-390` — opens `discrepancy_type:'owner_unmatched'`, `severity:'blocking'`, per account |
| Certification blocker | `certification.ts:60` `evaluateCertification` → **`:66`** pushes `'unresolved_owner'` |
| Re-evaluated on recertify | `documentProcessing.ts:1066` |
| Type | `lib/services/investment-intelligence/types.ts:91` `'owner_unmatched'` |

> ⚠️ **What is NOT enforced.** There is **no comparison of the statement's printed holder name
> or PAN against household members.** `ParsedAccountRecord.holderName`
> (`parsers/types.ts:40`, populated at `camsParser.ts:651`, `camsFolioStatementParser.ts:314`,
> `kfintechParser.ts:156`) has **zero consumers outside tests**. A statement belonging to a
> *different person*, uploaded with any `ownerMemberId` set, is ingested with **no mismatch
> signal at all**. There is no test, because there is no code.
>
> **Consequence for later phases.** Do not cite "owner mismatch safe blocking" as an existing
> PC4 guarantee. AIE-1.5 / PC5 owner-matching work (SRC-MASTER K.4, K.7) is building this
> capability for the first time, not extending it — and it is the natural owner of
> `holderName`, which II already parses and discards.

**Tests (for the implemented half only):** `tests/unit/iiR2Certification.test.ts:51` ("an unresolved owner blocks certification"), `:114` (a blocker is never downgraded to a warning), `:120` (all blockers reported).

---

### PC4-INV-13 — Source-document identity correctness — **P1** — ⚠️ one named sub-case **OPEN**

| Enforced by | |
|---|---|
| **Server-generated object key** | **`lib/services/investment-intelligence/storage.ts:51` `generateObjectKey`** → `{user_id}/{uuid}.{ext}` — never a user-supplied filename |
| No silent overwrite | `storage.ts:56` `uploadSourceDocumentObject`, **`:64` `upsert: false`** (comment: "a re-upload is a new key") |
| Document checksum uniqueness | `supabase/migrations/0032_ii_source_documents_accounts.sql:45-47` |
| `storage_path` write scope | `0032_...:25` — `storage_path text not null`, service-role write only |

> ⚠️ **Known-open sub-case, carried forward unresolved.** Two parse runs sharing an *identical*
> `storage_path` caused a second document's "Process" button to hit the **first** document's run
> ("already being processed", `documentProcessing.ts:184`).
> `docs/investment-intelligence/II_PC4_STATUS_2026_09_07.md:115` records this verbatim as *"a
> separate, pre-existing frontend issue, not investigated further as out of scope here"*.
> **No enforcement, no owner, no test.** Recorded here so a later phase does not rediscover it
> as new.

**Tests:** `tests/unit/iiStorage.test.ts:47-67` (`generateObjectKey` is user-scoped, contains no raw filename, is distinct per call), `tests/unit/iiR2Dedup.test.ts` DEDUP-001/005.

---

### PC4-INV-14 — Cross-user / RLS / storage isolation — **P0**

| Enforced by | |
|---|---|
| Table RLS | `supabase/migrations/0032_...:50` `"own ii_source_documents"`, `:79` `"own ii_accounts"`; `0033`, `0034`–`0036`, `0044`, `0059`, `0067`, `0082`, `0083` |
| Authoritative-write / forgery guards | `0062_ii_r6_final_rls_forgery_fix.sql`, `0069_ii_r9_review_items_authoritative_write_hardening.sql`, `0070_ii_r10_reports_authoritative_write_hardening.sql`, `0087_ii_r11_authoritative_forgery_guard.sql`, `0094_ii_holding_snapshots_authoritative_forgery_hotfix.sql` |
| **Storage bucket policy** | **`supabase/migrations/0037_ii_storage_policy.sql:22-26`** — `"own investment source document objects"` SELECT policy, `(storage.foldername(name))[1] = auth.uid()::text`. **No INSERT policy for `authenticated`** — service-role upload only, by design |
| Read path | `storage.ts:71` `createSourceDocumentSignedUrl` (60 s TTL), `:93` `downloadSourceDocumentObject` (service-role; called only after an ownership check) |

> ⚠️ **Unit coverage is indirect only.** `tests/unit/iiStorage.test.ts` (path scoping),
> `tests/unit/iiR6SecurityFinalClosure.test.ts`, `tests/unit/fdh11Isolation.test.ts`. The real
> cross-user proofs are **live-dev + scripts**: `tests/live-dev/iiFs1CamsFolioStatementLiveDev.test.ts:488`
> (FS1-T23 RLS) and `:521` (FS1-T24 raw-PDF storage isolation);
> `scripts/ii_r1_live_dev_security_tests.mjs`, `scripts/ii_r4_live_dev_security_tests.mjs`,
> `scripts/ii_r4_analytics_rls_probe.mjs`, `scripts/ii_r5_live_dev_security_tests.mjs`,
> `scripts/ii_r6_final_security.mjs`, `scripts/ii_r6_security_final.mjs`.
> **A later phase adding an AIE→II read path must re-run these; `npm test` will not.**

---

### PC4-INV-15 — Fail-closed reconciliation — **P0**

A variance that cannot be computed must report `null`, never `true`. A variance outside
tolerance must block, never warn.

| Enforced by | |
|---|---|
| **Direction table** | **`lib/services/investment-intelligence/reconciliation.ts:24` `DIRECTION_TABLE: Record<IiTransactionType, UnitDirection>`**, applied `:65` inside `:63` `unitDeltaForTransaction` |
| **Reconcile** | **`:88` `reconcilePosition`** — `:109` `canSumFromZero`, `:124` variance, **`:125` `withinTolerance = compareScaled(absScaled(variance), config.unitToleranceScaled) <= 0`**; the field's type is `boolean \| null` (`:85`) — **`null` when it cannot be computed, never defaulted to `true`** |
| Completeness | `:141` `determineHistoryCompleteness`, `:148` |
| Tolerance config | `reconciliationConfig.ts:45` `DEFAULT_RECONCILIATION_CONFIG` — unit tolerance `0.0001` (rationale `:35`, "matches AMFI's 4-decimal-unit statement"), currency tolerance `1.00` (rationale `:40`); `:60` `loadActiveReconciliationConfig` |
| Blocking | `certification.ts:60` `evaluateCertification` → `unit_variance_exceeds_tolerance` |
| Persisted result | `documentProcessing.ts:1208-1230` upsert to `ii_portfolio_truth_status` — `:1220` `unit_variance`, `:1221` `unit_variance_within_tolerance` |

**Tests:** `tests/unit/iiR2Reconciliation.test.ts:12` (direction table incl. `:35` passthrough types), `:41` REC-001..004 — `:70` REC-003 *"never concealed by a wide tolerance"*, `:83` REC-004 null; `:128` completeness; `tests/unit/iiR2DataQualityAndConfig.test.ts`; `tests/unit/iiR2Certification.test.ts:45`; **`tests/unit/iiPc3QualificationPack.test.ts:275` (Q08 VALID_NEGATIVE — a deliberate closing-balance mismatch MUST be detected)**; `tests/unit/iiR3ManualReconciliation.test.ts`.

---

### PC4-INV-16 — Production cleanup discipline for synthetic data — **NOT ENFORCED**

There is **no PC4/production synthetic-data cleanup script anywhere in the repository, and no
zero-residue verification.** `II_PC4_STATUS_2026_09_07.md:166` states it verbatim:
*"Independently verify synthetic cleanup = 0 residue — **not started**."*

What exists is DEV-scoped only, and none of it covers PC4:

| Artifact | Scope |
|---|---|
| `scripts/ii_r5_purge_test_data.mjs` | R5 DEV teardown sweeper, FK-ordered |
| `scripts/r11_cleanup_test_fixtures.mjs` | deletes only users matching `['r11-live-','r11-prof-','r11-scale-']` (`:12` `PATTERNS`) |
| `scripts/ii_r11_production_readonly_schema_check.mjs` | read-only production probe (no deletion) |
| Per-test teardowns inside each live-dev file | e.g. `iiFs1CamsFolioStatementLiveDev.test.ts:219-222` removes storage objects by `storage_path` |
| Fixture PII guard | `tests/unit/iiPc3QualificationPack.test.ts:345` — no real 10-character PAN pattern in any fixture |

> **Binding consequence for later phases.** Any phase that writes synthetic data into
> **production** must build and run its own cleanup + independent zero-residue verification
> first. It cannot rely on a PC4 mechanism, because none exists.

---

### PC4-INV-17 — Password-protected document handling — **P1**

The two password cases must stay distinguishable by **exception type**, never by string-matching
an error message; and a password must never be persisted, logged or echoed.

| Enforced by | |
|---|---|
| **Classification** | **`lib/services/investment-intelligence/pdfExtraction.ts:72`** `if (err instanceof PasswordException)` → `'wrong_password'` when a password was supplied, else `'password_required'` (kinds enum `:19`) |
| Retryability | `:92-96` — `parser.destroy()` always in `finally` |
| Status mapping | **`documentProcessing.ts:968` `handleExtractionFailure`** — `:977-982` `statusByKind` (both kinds → `'password_required'`), `:984-989` → `'document_password_required'`, **`:1003` `parse_error: null` defensively (never echo a password)**, `:1010-1011` `password_required` / `password_supplied` flags |
| **Never downgrade a prior success** | `documentProcessing.ts:137-144` `priorSucceededRun` + **`:155-158` `updateDocumentStatusUnlessSucceeded`**; self-healing repair `:217-219` |
| Route | `app/api/investment-intelligence/source-documents/[id]/process/route.ts:73-77` (password never persisted; response never echoes it — `:96-98`) |
| Schema guarantee | `ii_document_parse_runs` comment: *"The password itself is NEVER a column on this table or any table"* |
| UI reachability (2026-09-14) | `components/investment-intelligence/InvestmentIntelligenceClient.tsx` — `loadDocuments()` now runs **unconditionally before** the failure throws (`cbd338f`), so the `password_required` input actually renders |

**Tests:** `tests/unit/iiR2PdfExtraction.test.ts:54-114` (CAMS-002 / KFIN-002; error text never contains the password; `destroy()` always called), `tests/unit/iiPc3QualificationPack.test.ts:130/:137/:144/:156` (real encrypted PDF: none→required, wrong→wrong, correct→**identical economic result**), `tests/unit/iiPc3RealVariantQualificationPack.test.ts`; helper `tests/support/buildEncryptedCamsPdf.ts`.

**Coverage gap:** wrong-password **DB atomicity** (no partial state left behind) is proved only by `tests/live-dev/iiFs1CamsFolioStatementLiveDev.test.ts:271` (FS-Q02).

---

### PC4-INV-18 — Transaction classification (PC4 defects #8 and #9) — **P0**

The two classification fixes that moved real money in PC4 must not regress.

| Enforced by | |
|---|---|
| Ordered rules | `lib/services/investment-intelligence/transactionTypeMapping.ts:30` `RULES`, evaluated `:101` inside `:99` `classifyTransactionType` |
| Reversal precedence | **`:54`** `{ code:'reversal', test:/\breversal\b\|\breversed\b\|\brejected\b\|\brejection\b/i, type:'reversal' }` — before purchase/redemption (rationale `:34-37`) |
| **Defect #8 — lateral shift** | **`:82`** `{ code:'lateral_shift', test:/lateral shift/i, type:'transfer' }` — **must be checked before `dividend` at `:85`** (`/\bidcw\b\|\bdividend\b/i`), because a Lateral Shift narrative names the *source* scheme and can contain "IDCW". Maps to `transfer`, deliberately **not** `switch_in`/`switch_out` (those feed R6's tax-lot engine, which needs cost-basis data this parser does not attach) |
| **Defect #9 — negative-signed inflow** | `camsParser.ts:511` `INFLOW_ONLY_TRANSACTION_TYPES`; **`:514` `reclassifyNegativeSignedInflowRows`** — `:515-521` rewrites an inflow-only row with `unitsScaled < 0` to `canonicalType:'reversal'`, `classificationConfidence:1`. Scoped to the CAMS parser, **not** the shared `DIRECTION_TABLE` — KFintech and every other source are unaffected |
| Paired reversals | `camsParser.ts:455` `reclassifyReversedPurchasePairs`; composition order `:1146` |

**Tests:** `tests/unit/iiR2TransactionTypeMapping.test.ts` — `:50`/`:54`/`:58`/`:62` precedence, `:79` "Systematic Investment Rejection"→reversal, `:83` bare "Rejected", **`:93`/`:101` lateral-shift→transfer (not dividend)**, `:109` a genuine dividend is still a dividend; `tests/unit/iiCamsNegativeSignedInflowReclassification.test.ts` (`:46`/`:53`/`:60`/`:68` paired; `:107`/`:114` standalone, no partner required); `tests/unit/iiCamsReversedPurchasePairReclassification.test.ts`; `tests/unit/iiSipRejectionExclusion.test.ts`.

---

### PC4-INV-19 — Parser-error fail-closed at certification — **P1**

A document with any `error`-severity parser finding must never reach `certified` or
`certified_with_warnings` on reconciliation arithmetic alone.

| Enforced by | |
|---|---|
| **Signal** | **`documentProcessing.ts:885` `const parserHasFatalError = parsed.errors.length > 0;`** (rationale block `:869-884` — the PC3 Q10 finding that `parsed.errors` was never wired to certification) |
| Propagation | `:889` → `evaluatePositionAndCertify(..., parserHasFatalError)`; signature `:1096`; `:1192` `parserFatalError` |
| **Blocker** | **`certification.ts:65`** `if (input.parserFatalError) blocking.push({ code: 'parser_fatal_error', ... })` |

> **Live production behaviour of this invariant — read the verdict document §4.** This blocker
> is currently set on **all 17** of the Product Owner's real production positions, including the
> 12 that reconcile to variance `0.000`, because the parser emits **251 `unparseable_transaction_row`
> findings at severity `error`** for rows that PC4's own Section 3 accounting classified as
> benign boilerplate, lifecycle markers and regulatory footnotes. The **wiring** is correct and
> must be preserved; the **severity assignment upstream of it** is the open question. Recorded
> as finding **M1-F3** in the verdict.

---

## 3. Consolidated coverage-gap register

A later phase inherits these. None is invented here; each is evidenced above.

| ID | Gap | Invariant |
|---|---|---|
| **CG-1** | `vitest.config.ts:5` restricts runs to `tests/unit/**`; **all 9 `tests/live-dev/*.test.ts` are dormant under `npm test`** | INV-06, 10, 14, 17 |
| **CG-2** | **Owner *mismatch* is not implemented at all**; `holderName` is parsed and discarded | INV-12 |
| **CG-3** | **No PC4/production synthetic-data cleanup script exists**; closure step 7 never started | INV-16 |
| **CG-4** | Read-side immutability has **no runtime guard and no unit test** — a documented static inventory only | INV-10 |
| **CG-5** | Cross-user RLS + storage-bucket isolation have **no unit test** — live-dev and `scripts/*` only | INV-14 |
| **CG-6** | CAS↔Folio overlap proof exists **only** in `tests/live-dev/` | INV-06 |
| **CG-7** | The `be9e36f` folio-only account-identity fallback branches have **no unit test** | INV-04 |
| **CG-8** | KFintech is certified against **synthetic fixtures only**; no real-document qualification pack | INV-03 |
| **CG-9** | CAS-layout `OPENING_BALANCE_RE` has **no dedicated unit test** | INV-01 |
| **CG-10** | The "two parse runs sharing an identical `storage_path`" defect is **open, unowned, untested** | INV-13 |
| **CG-11** | Wrong-password DB atomicity is proved **live-dev only** | INV-17 |
| **CG-12** | `camsFolioStatementParser.ts:93` cites a **nonexistent** test file `iiFs1SourceDetection.test.ts` | INV-02 |
| **CG-13** | **Zero II e2e specs** exist (`tests/e2e/` has 6 files, none II) | all |

---

## 4. How a later phase uses this contract

1. **Before** merging AIE-1, PC5, PC6 or PC7 work that touches `lib/services/investment-intelligence/`,
   `lib/engines/investment-intelligence/`, `app/api/investment-intelligence/` or any `ii_*` table:
   run the 85 unit files in §1 and require **84 passed / 1 skipped / 0 failed**.
2. **Also** run the 9 `tests/live-dev/*.test.ts` files explicitly — `npm test` will not (CG-1).
   Without them, INV-06, INV-10, INV-14 and INV-17 are unverified.
3. **Do not** cite INV-12 (owner mismatch) or INV-16 (production cleanup) as existing
   guarantees. They are not implemented. Building either is new work.
4. **Preserve** INV-19's wiring. If PC4's 251 `error`-severity findings are later reclassified,
   reclassify them **at the parser**, not by weakening `certification.ts:65`.
5. **Never renumber** migrations `0140`–`0146` or `0149`–`0152`; they are already applied to DEV
   **and** production (M0 finding **MG-1**). The next genuinely free version is **`0153`**.
