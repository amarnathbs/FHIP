# AIE-1.2 — Investment Intelligence Adapter

**Status: IMPLEMENTED and TESTED on a feature branch, NOT certified, NOT
merged, NOT deployed.** This report describes what was built in this pass.
It is not a certification — AIE-1.2's own source document requires
independent verification and traceability across all 346 numbered
requirements for a FULL PASS, and real certification of the whole AIE-1
platform is explicitly AIE-1.6's job, not this one. Nothing here should be
read as "AIE-1.2 complete" — see "What remains" below.

Branch: `feature/aie-1-2-investment-adapter`, based on
`feature/aie-1-1-document-gateway` (confirmed: `lib/aie/**` and migration
`0140` are present in this branch's history — `git log` shows
`cd2d4a2` as the common ancestor commit).

## 1. Entry-condition verification (execution sequence step 2)

Read AIE-1.1's real code (not just its own report) before designing
anything:

- `lib/aie/classifier/registry.ts` — `RegisteredParser`/`aieParserRegistry`/
  `sniffDocument` genuinely exist and are usable from an adapter (a
  `sniff`/`parse` pair, registered once). Used directly by `parserAdapter.ts`.
- `lib/aie/schema/schemaRegistry.ts` — `aieSchemaRegistry`/`validateAiOutput`
  genuinely exist, Zod-based, `.strict()` by default. Used directly by
  `schema.ts`.
- `lib/aie/reconciliation/types.ts` — `ReconciliationRule`/
  `blockingItemsForReconciliation`/`worstOutcome` genuinely exist, and
  critically carry **no `confidence` field anywhere** (P4 verified by
  reading the type, not assumed). Used directly by `reconciliationRule.ts`.
- `lib/aie/db/repository.ts` — `createUnresolvedItems`/
  `listOpenUnresolvedItemsForUser`/`recordReviewDecision` genuinely exist
  and are the ONLY way `aie_unresolved_item.status` changes. Reused via
  `unresolvedItems.ts`'s shaped inputs — no second exception system built.
- `lib/aie/orchestrator.ts` — `runExtractionPipeline` genuinely drives
  sniff -> parse -> mask -> (gated AI) -> reconcile -> unresolved/accept,
  and accepts an injected `ReconciliationRule` exactly as AIE-1.2 needs.
  Verified end-to-end in `tests/unit/aieIiAdapterParser.test.ts`'s own
  "END-TO-END" test, which calls the REAL `runExtractionPipeline` with this
  adapter's real parser (registered) and real reconciliation rule.

All five contracts are genuinely usable from an adapter, not just present.

## 2. Discovery — Investment Intelligence inventory (execution sequence step 3)

Read before designing anything new. Cited by file:line:

| Capability | Existing file | Reused how |
|---|---|---|
| Source detection + full parse | `lib/services/investment-intelligence/parsers/registry.ts` `detectSource()`/`parseDocumentWithParser()` (lines 37-53, 106-130) | Called directly, unmodified, from `parserAdapter.ts`'s `sniff`/`parse` |
| CAS/KFintech/Folio-statement parsers | `lib/services/investment-intelligence/parsers/{camsParser,kfintechParser,camsFolioStatementParser}.ts` | Reached only through the registry above — never touched directly |
| Account/folio resolution (pure) | `lib/services/investment-intelligence/accountResolution.ts` `planFolioAccountResolution`/`accountResolutionKey`/`normaliseFolioNumber`/`UNKNOWN_AMC_SENTINEL` (lines 10-13, 54, 169-186) | Imported unmodified into `accountMatching.ts`; only `resolveOrCreateAccount`'s (lines 73-138) own READ logic is mirrored (never its writes) |
| Instrument/scheme resolution (pure) | `lib/services/investment-intelligence/schemeResolution.ts` `resolveScheme()` (lines 61-149) | Called directly, unmodified, from `instrumentMatching.ts` |
| Transaction fingerprinting | `lib/services/investment-intelligence/fingerprint.ts` `computeTransactionFingerprint()` (lines 50-63) | Called directly, unmodified, from `reconciliationRule.ts` |
| Roll-forward reconciliation (pure) | `lib/services/investment-intelligence/reconciliation.ts` `reconcilePosition()`/`determineHistoryCompleteness()` (lines 88-152) | Called directly, unmodified, from `reconciliationRule.ts` — the SAME formula `documentProcessing.ts`'s `evaluatePositionAndCertify` (lines 1087-1241) already uses in production |
| Known-opening-balance marker | `lib/services/investment-intelligence/openingBalanceMarker.ts` `OPENING_BALANCE_SOURCE_REFERENCE` | Imported unmodified into `reconciliationRule.ts` |
| Decimal arithmetic | `lib/services/investment-intelligence/decimal.ts` (`parseExactDecimal`/`scaledToDecimalString`/`scaledToNumber`/`ZERO`) | Used throughout — no float arithmetic introduced |
| Reconciliation tolerances | `lib/services/investment-intelligence/reconciliationConfig.ts` `ReconciliationConfig`/`DEFAULT_RECONCILIATION_CONFIG` | Consumed as-is by `reconciliationRule.ts`'s context |
| Canonical write, end to end | `lib/services/investment-intelligence/documentProcessing.ts` `processSourceDocument()` (lines 116-958) | Called directly, unmodified, from `write.ts` — the ENTIRE canonical write (accounts, instruments, transactions, holdings, reconciliation cases, certification) is delegated here, not reimplemented |
| Upload/storage contract | `app/api/investment-intelligence/source-documents/route.ts` (POST handler, lines 24-103), `lib/services/investment-intelligence/storage.ts` (`generateObjectKey`/`uploadSourceDocumentObject`) | `write.ts`'s `ii_source_documents` insert mirrors this route's own insert shape exactly; storage functions called directly, unmodified |

**Net-new code** (no existing equivalent): `documentCatalogue.ts` (the
catalogue itself), `statementMatching.ts` (statement-period structural
validation — Investment Intelligence has no equivalent pure check),
`unresolvedItems.ts` (shapes typed inputs for AIE-1.1's existing lifecycle),
`reconciliationRule.ts`'s own AIE-candidate-parsing/joining glue,
`write.ts`'s own gating/idempotency glue, `aie_ii_adapter_link` (migration
`0141`).

## 3. Certified document catalogue (execution sequence step 4)

See `lib/aie/adapters/investment-intelligence/documentCatalogue.ts` for the
full, machine-readable list with rationale per entry. Summary:

**Certified** (real parser + real prior certification + re-verified through
the AIE wrapper this pass): CAMS Consolidated Account Statement
(`cams_detailed_v1`), KFintech Consolidated Account Statement
(`kfintech_detailed_v1`), CAMS individual Folio Details statement
(`cams_folio_details_v1`, II-FS1).

**Deferred, explicitly** (no parser exists, not attempted): any broker/
demat contract note or holding statement (Zerodha, ICICI Direct, CDSL/NSDL,
etc.), any non-Indian-jurisdiction investment statement, PMS/NPS statements.

## 4. What was built

- **`supabase/migrations/0141_aie1_2_investment_adapter_link.sql`** — one
  table, `aie_ii_adapter_link`, RLS SELECT-only + two cross-tenant integrity
  triggers (reuses AIE-1.1's own `aie_assert_child_owner()` plus one new,
  narrowly-scoped `aie_ii_adapter_link_assert_ii_owner()`). Unique
  constraints on both `aie_run_id` and `ii_source_document_id` (one AIE run
  produces at most one `ii_source_documents` row, and vice versa). **HELD
  LOCALLY. Not applied to any DEV or production database.** Numbered
  `0141` — confirmed clean against `origin/main` (0137) and
  `origin/feature/lr-1-upload-security-lifecycle` (0138/0139) via
  `scripts/check-migration-versions-against-branch.mjs`.
- **`lib/aie/adapters/investment-intelligence/`** (10 files):
  `documentCatalogue.ts`, `parserAdapter.ts`, `schema.ts`,
  `accountMatching.ts`, `instrumentMatching.ts`, `statementMatching.ts`,
  `unresolvedItems.ts`, `reconciliationRule.ts`, `featureFlags.ts`,
  `write.ts`, `index.ts`.
- **`AIE_II_ADAPTER_CANONICAL_WRITE_ENABLED`** feature flag — default OFF
  (unset/anything-but-`'true'` leaves the canonical write path fully
  inert). This is the ONLY new flag this phase introduces; AIE-1.1's own
  `AIE_DOCUMENT_INTAKE_ENABLED`/`AIE_AI_FALLBACK_ENABLED` are unchanged.
- **42 new unit tests** across 6 files (`tests/unit/aieIiAdapter*.test.ts`)
  plus one shared fixture builder (`tests/support/buildAieIiCasFixtureText.ts`).
  See the corresponding commit message for the exact breakdown.
- **One fix to an existing test**: `tests/unit/fdh1Isolation.test.ts` — a
  new documented exception in `FDH_APPROVED_CONSUMER_FILES` for
  `lib/aie/adapters/investment-intelligence/featureFlags.ts` (a prose
  mention of `lib/financial-data-hub/constants/featureFlags.ts` as prior
  art, not a real import — the identical false-positive class AIE-1.1
  already fixed for 10 of its own files).

## 5. Non-negotiable prohibitions — self-check (not a certification)

| Prohibition | Where enforced |
|---|---|
| No direct adapter call to an AI provider | No file under `lib/aie/adapters/investment-intelligence/` imports `lib/ai/providers` or `lib/aie/provider` — verified by `tests/unit/aieIiAdapterProhibitions.test.ts` |
| No unmasked data in a provider payload | This adapter never constructs a provider payload itself — it registers a schema (`schema.ts`) and a parser (`parserAdapter.ts`); AIE-1.1's own orchestrator/gateway remains the only masking/provider-calling code path |
| No AI-created identity/instrument/owner/currency/FX/cost-base | `schema.ts`'s `ALLOWED_AI_COMPLETABLE_FIELDS` enum structurally excludes every such field name — a schema-validation rejection, not a policy check (tested in `aieIiAdapterSchema.test.ts`) |
| No live/reference-price replacement of statement values; PC6 untouched | Zero imports of `lib/engines/investment-intelligence/{benchmarkEngine,benchmarkService,navReturn}` or any market-data module anywhere in the adapter — verified by `aieIiAdapterProhibitions.test.ts` |
| No canonical write before reconciliation + acceptance | `write.ts`'s three ordered gates (feature flag, reconciliation outcome, open blocking items) — tested individually and in combination in `aieIiAdapterWriteGate.test.ts` |
| No partial multi-table import | The canonical write is 100% delegated to `processSourceDocument`, which already provides this atomicity/idempotency guarantee (its own header) — not reimplemented or weakened here |
| No second exception-tracking system | `unresolvedItems.ts` only ever shapes `AieUnresolvedItemInput` for AIE-1.1's existing `aie_unresolved_item`; `aie_ii_adapter_link` (migration 0141) carries no status/lifecycle semantics — verified by `aieIiAdapterProhibitions.test.ts` |
| No claiming certification for an unsupported broker | `documentCatalogue.ts` names exactly three certified classes, all with pre-existing real parsers and prior certification; everything else explicitly `deferred` |
| No production migration/feature activation/backfill | Migration held locally; canonical-write flag defaults OFF; no bucket/table created in any live environment this pass |

## 6. Verification evidence actually observed

- `npx tsc --noEmit` — zero new errors (only the same pre-existing
  razorpay/stripe/xlsx/`@electric-sql/pglite` missing-optional-package
  errors AIE-1.1's own report already disclosed).
- `npx eslint lib/aie/adapters/investment-intelligence tests/unit/aieIiAdapter*.test.ts tests/support/buildAieIiCasFixtureText.ts` —
  zero errors, zero warnings.
- `npx vitest run tests/unit/aieIiAdapter*.test.ts` — **42/42 passed**, 6/6
  files.
- `npx vitest run tests/unit/aie*.test.ts tests/unit/ii*.test.ts` — **1728
  passed, 5 skipped, 0 failed** — zero regression in AIE-1.1's own suite or
  Investment Intelligence's own existing suites.
- `npx vitest run` (full suite) — **6416 passed, 18 skipped, 18 failed** —
  the exact same 18 pre-existing failures AIE-1.1's own report already
  disclosed (missing razorpay/stripe/xlsx/pglite packages, `resources*
  LiveDev` tests needing real Supabase credentials, one unrelated
  pre-existing `countryGateAccessMatrix` failure). 6416 = 6374 + 42 exactly.
- `npx node scripts/check-migration-versions.mjs` — OK, 134 active
  migrations, next version 0142.
- `npx node scripts/check-migration-versions-against-branch.mjs --against=origin/main` —
  OK, no collisions.
- `npx node scripts/check-migration-versions-against-branch.mjs --against=origin/feature/lr-1-upload-security-lifecycle` —
  OK, no collisions.
- **`next build`** — NOT attempted this pass. AIE-1.1's own report already
  disclosed this worktree's Turbopack/symlinked-`node_modules` limitation
  as a genuine environment issue, not a code defect; not re-attempted here
  since nothing about that constraint changed.

## 7. Honest limitations / deferred work

- **Masked-AI fallback for this adapter is architected but UNEXERCISED.**
  `schema.ts` registers a real schema; `parserAdapter.ts` always returns
  `aiEligibleGaps: []` because no existing II parser reports a gap this
  schema could legitimately fill. No real document in this pass's fixture
  corpus reaches the AI-fallback branch of `runExtractionPipeline`.
- **`write.ts` is unit-tested with dependency injection only** — it has
  never been run against a live Supabase instance (no bucket exists for
  AIE's own quarantine storage yet either, per AIE-1.1's own disclosed
  gap). The bytes-move-between-buckets step (AIE quarantine ->
  `investment-source-documents`) is implemented for real but UNVERIFIED
  against live storage.
- **Owner/household-member resolution is out of scope for matching this
  pass** — `accountMatching.ts` reports whether ANY account matched, and
  `unresolvedItems.ts` raises an owner-unresolved item when
  `ownerMemberId` is absent, but the actual "which household member" UI/
  decision flow is AIE-1.5's job, not built here.
- **No fixture exercises the KFintech or Folio-statement parsers
  specifically through this adapter** — only CAMS CAS fixtures were built
  this pass (`tests/support/buildAieIiCasFixtureText.ts`). The wrapper
  itself is parser-agnostic (calls whichever parser `detectSource` picks),
  so this is a fixture-coverage gap, not an architecture gap — but it is
  disclosed rather than implied covered.
- **No golden/adversarial corpus beyond what commit messages/this report
  describe** — a small, real corpus (positive CAS, unsupported document,
  malformed-transaction-row, ambiguous-account, ambiguous-instrument,
  duplicate-transaction, roll-forward-mismatch, currency-conflict) exists
  across the 6 test files, but it is narrower than a full "golden +
  adversarial corpus" a later certification pass would want.
- **AIE-1.0 gap unchanged.** As `AIE_1_MASTER_PLAN.md` section 5 already
  states, no formal AIE-1.0 architecture/privacy-contract artifact exists
  in this repository; this pass continued treating AIE-1.1's own
  substitution (this repo's established PC5/PC6 conventions + the master
  plan's own principles table) as the working equivalent. Still an open PO
  decision, unchanged by this phase.
- **No production migration, feature activation, or real-user backfill.**
  Unchanged — this phase grants none of that authority.

## 8. What this means for AIE-1.3/1.4/1.5

`lib/aie/adapters/investment-intelligence/` is a self-contained example of
"how a domain adapter plugs into AIE-1.1" a future AIE-1.3 (FDH bank-
statement adapter) can follow structurally (parser wrap, schema
registration, read-only matching, DI'd reconciliation rule, gated write
through the domain's own existing write service) — though FDH's own
canonical write path (the R7 bank-CSV engine) has a different shape and
would need its own equivalent of `write.ts`, not a copy of this one.
