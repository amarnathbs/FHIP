# AIE-1.4 — Other PDF-Enabled FHIP Modules

**Status: IMPLEMENTED and TESTED on a feature branch, NOT certified, NOT
merged, NOT deployed.** This report describes what was built in this pass.
It is not a certification — AIE-1.4's own source document requires
independent verification and traceability across all 286 numbered
requirements for a FULL PASS, and real certification of the whole AIE-1
platform is explicitly AIE-1.6's job, not this one. Nothing here should be
read as "AIE-1.4 complete" — see "What remains" below.

Branch: `feature/aie-1-4-other-modules` (off
`feature/aie-1-1-document-gateway` at `cd2d4a2`, NOT `main` directly, per
this phase's own entry conditions).

## 1. Repository/migration baseline (execution sequence step 1)

Confirmed by fetching all four relevant refs directly (not guesswork):

| Ref | Highest/claimed migration |
|---|---|
| `origin/main` | 0137 |
| `origin/feature/aie-1-1-document-gateway` (this branch's base) | 0140 (`aie1_1_shared_document_gateway`) |
| `origin/feature/aie-1-2-investment-adapter` | 0141 (`aie1_2_investment_adapter_link`) |
| `origin/feature/aie-1-3-fdh-bank-adapter` | 0142 (`aie1_3_fdh_bank_statement_adapter`, itself renumbered once after a real collision with 0141) |

This pass's new migration is numbered **0143** — verified collision-free
against all four refs with both `scripts/check-migration-versions.mjs`
(local: 134 active migrations, next version 0144) and
`scripts/check-migration-versions-against-branch.mjs` run against
`origin/main`, `origin/feature/aie-1-1-document-gateway`,
`origin/feature/aie-1-2-investment-adapter` and
`origin/feature/aie-1-3-fdh-bank-adapter` in turn — all four report "OK: no
cross-branch migration collisions". This pass did NOT read 1.2/1.3's actual
adapter code changes beyond what was needed to confirm their migration
numbers and observe their established file-layout convention (see section
4 below) — per this phase's own entry condition AIE14-ENTRY-02 ("reused
where applicable without importing their domain accounting").

Confirmed `lib/aie/**` (18 files: types, state machine, admission/
structural validation, fingerprinting, PII masking, the Zod schema
registry, the AI provider abstraction/mock/gateway, the classifier
registry, the reconciliation handoff contract, the DB repository, audit,
feature flags, PDF text extraction, storage, orchestrator) and migration
`0140` are present and unmodified on the base branch.

## 2. Verifying AIE-1.1 provides a usable contract (execution sequence step... entry conditions)

Read the actual code (not just AIE_1_1_IMPLEMENTATION.md's prose) for:
`lib/aie/classifier/registry.ts` (the `aieParserRegistry`/`RegisteredParser`/
`sniffDocument` contract), `lib/aie/reconciliation/types.ts` (the
`ReconciliationRule` shape, `worstOutcome`, `blockingItemsForReconciliation`
— confirmed NO `confidence` parameter exists anywhere in these signatures,
by construction, P4), `lib/aie/schema/schemaRegistry.ts` (the Zod-based
registry AIE-1.2 already registers against — same mechanism reused here,
no second one), `lib/aie/orchestrator.ts`'s `runExtractionPipeline` (the
single entry point every adapter's parser+reconcile rule is injected into),
and `lib/aie/types.ts` (confirmed `AieSourceModuleHint` is a closed union —
`'investment_intelligence' | 'fdh_bank' | 'other' | null` — matching
migration 0140's own CHECK constraint; AIE-1.4 uses `'other'`, which this
union already anticipates, rather than needing a schema change). All of
this is real, working, exercised-by-tests code, not just a report's claim —
confirmed usable for a new adapter without any AIE-1.1 change.

## 3. Cross-module document discovery (execution sequence step 2)

The spec's own "Cross-module document discovery" section (AIE14-DISC-01
through DISC-09) names exactly **nine** candidate document classes (DISC-10
is a cross-cutting instruction to locate existing independent parsers/
exception tables, not a tenth class). For each, this pass searched the
actual repository for its current canonical data model and write service
before any design work:

| # | Candidate (DISC-xx) | Current repo state found |
|---|---|---|
| 1 | Insurance policy/coverage/premium/insured/beneficiary | `insurance_policies` table (migrations 0003/0004/0008), `lib/validation/insurance.ts` (`insuranceSchema`), write service `makeRegistry('insurance_policies')` (`lib/services/registry.ts`), reached today ONLY via manual entry (`app/api/insurance/route.ts`). **No existing PDF ingestion path of any kind.** |
| 2 | Income/employment/payslip/recurring-income | `income_sources` table AND a full, mature, already-merged-to-`main` deterministic pipeline: `lib/financial-data-hub/payslip/{parser,labels,normalise,reconciliation,privacy,bankMatch,frequency,types}.ts` (FDH-9, confirmed present on `origin/main` via `git cat-file -e`). |
| 3 | Liabilities/loans/credit facilities | `liabilities` table AND a full, mature adapter framework: `lib/financial-data-hub/liability/adapters/{auCreditCard,auLoan,inCreditCard,inLoanEmi,registry}.ts` plus `bankMatching.ts`, `creditCardEconomics.ts`, `repaymentDecomposition.ts`, `statementIntake.ts`, `statementReconciliation.ts` (FDH-10). |
| 4 | Asset/property/vehicle/business valuation | `assets` table (`asset_name`, `asset_class`, `current_value`, `currency_code`, `country_code`, `valuation_date`) — simple, flat, no separate valuation-HISTORY entity distinct from "current value". |
| 5 | Retirement/superannuation/SMSF | `retirement_accounts` table AND an even larger, still-DEV-only pipeline: `lib/financial-data-hub/retirement/{accountMatching,activityClassification,adapters/*,bankMatching,dedup,detection,extraction,money,payslipReconciliation,reconciliation,rolloverIntelligence,smsfDetection,types}.ts` (FDH-12; per project memory this is DEV-only with "a hard stop before merge/production/FDH-13"). |
| 6 | Goals/target/contribution/linkage | `app/api/goals`, `app/api/investment-intelligence/goals` — a linkage/contribution record, not itself the target of a standalone "goal document" upload; existing goal-linkage work (project memory) treats goals as something OTHER documents' evidence gets attached to, not a document class of its own. |
| 7 | Bills/invoices/recurring expenses/FDH transaction-linkage | `expense_items` table (same flat `makeRegistry` shape as insurance) exists, but the DISC-07 "FDH transaction-linkage" half (matching a bill to an existing bank transaction to avoid a duplicate expense — spec scenario 7) has no existing dedup/matching engine anywhere in this repo; FDH's own dedup machinery is scoped to bank-statement-to-bank-statement overlap, not bill-to-transaction matching. |
| 8 | Tax-supporting evidence/exports | No canonical "tax evidence document" table anywhere. `lib/engines/investment-intelligence/tax/**` computes tax-lot/CGT figures FROM already-canonical Investment Intelligence data — it is not a document-evidence store, and creating one is exactly the "no stable canonical destination" case AIE14-ELIG-06 says to refuse. |
| 9 | Cross-border/jurisdiction/currency document gates | Not a standalone document class — a cross-cutting concern layered onto whichever class is actually implemented. Country/currency gating for Insurance is already provided by this repo's existing G0/G1/MCC country-confirmation infrastructure (reused via `requireModuleCapability('INSURANCE', ...)`, unchanged), not reinvented. |

Additionally, per AIE14-ELIG-07 / the master plan's own table, **identity/
medical/legal/highly sensitive documents** (spec section 19) are covered:
this pass never considered them a candidate for IMPLEMENT_NOW/DESIGN_ONLY/
DEFER at all — they are explicitly PROHIBITED by AIE-1.4's own non-
negotiable prohibitions, full stop, and nothing in this pass touches them.

## 4. Eligibility gate — the decision, per class (execution sequence step 3)

| Class | Decision | Rationale |
|---|---|---|
| **Insurance** | **IMPLEMENT_NOW** | Real, mature, RLS-protected canonical table + live write service reached only by manual entry today — exactly the ingestion gap AIE-1.4 exists to fill, with no competing pipeline to duplicate or collide with. |
| Payslip/income | DEFER | A mature, separate, ALREADY-MERGED-TO-MAIN deterministic pipeline (FDH-9) already exists. Wrapping it behind AIE properly (matching the depth AIE-1.3 gave the FDH bank-PDF wrap) is its own multi-session effort, not a shallow addition this pass — building a second, thinner path here risks exactly the "second parser" duplication AIE-1.4's own prohibitions warn against. |
| Loans/liabilities | DEFER | Same reasoning as payslip/income — FDH-10's adapter framework (AU/IN credit card + loan, statement reconciliation, repayment decomposition) is mature and pre-existing; a proper AIE wrap deserves its own pass. |
| Asset/property/valuation | DEFER (design note, not DESIGN_ONLY-documented in code this pass) | The canonical model is simple enough to look tempting, but "dated valuation retained as history, not live price" (the spec's own scenario 4) is exactly the kind of correctness-critical distinction `assets.current_value` does not model today (no separate valuation-history entity), and this class sits closest to the PC6 boundary AIE-1.4 must never cross. Picking a SECOND class this pass (the spec permits "at most two, if genuinely both mature enough") was considered and rejected in favour of doing Insurance properly rather than two classes shallowly — matching the master plan's own explicit expectation ("rather than shallowly touching many"). |
| Retirement/SMSF | DEFER | FDH-12 is an even larger, still-DEV-only, not-yet-merged pipeline (project memory: "hard stop before merge/production/FDH-13") with the highest jurisdiction complexity of any candidate (SMSF). Building a competing AIE path here would risk exactly the kind of drift the FDH-12 hard-stop is protecting against. |
| Goals | DEFER | Not a standalone document class in this codebase's own model — goals are a linkage TARGET for other documents' evidence (spec scenario 6: "Goal fee schedule linked only after user confirmation"), not something with its own canonical document-ingestion destination. |
| Bills/expenses/FDH linkage | DEFER | `expense_items`'s canonical destination is mature (same registry pattern as Insurance), but the DISC-07-required "FDH transaction-linkage" (matching a bill to an existing bank transaction to avoid double-counting an expense) has no existing matching/dedup engine to build on — AIE14-ELIG-06 territory until that engine exists. |
| Tax-supporting evidence | DEFER | No canonical "tax evidence document" table exists anywhere in this repo — AIE14-ELIG-06 ("prohibit certification where no stable canonical destination exists") applies directly. |
| Cross-border/jurisdiction documents | N/A as an independent class | Not a document class of its own; satisfied for the one implemented class (Insurance) by reusing this repo's existing country/currency-confirmation gate, unchanged. |
| Identity/medical/legal/sensitive | **PROHIBITED** | Explicit non-negotiable prohibition (spec section 4 / AIE14-ELIG-07 / section 19) — never a candidate for any status other than PROHIBIT. |

Named owners for the one IMPLEMENT_NOW class (AIE14-ELIG-04): product/
domain owner = the existing Insurance module's own established ownership
(the manual-entry route/schema this adapter delegates to, unchanged);
privacy owner = this pass's own masking/evidence-only-field discipline
(section 6 below), consistent with AIE-1.1's existing masking engine.

## 5. Adapter SDK / registration (execution sequence step 4)

No new registration mechanism was built. `lib/aie/adapters/insurance/`
registers against the SAME two AIE-1.1 registries AIE-1.2 already
registers against:

- `aieParserRegistry.register(insuranceRegisteredParser)`
  (`lib/aie/classifier/registry.ts`) — a normal global `RegisteredParser`
  (adapterId `insurance_generic_schedule_v1`, moduleHint `'other'`). Unlike
  AIE-1.3 (which needed an additive `parserOverride` field on
  `runExtractionPipeline` because its parser is per-request/account-aware),
  Insurance's parser is stateless, so **zero changes to
  `lib/aie/orchestrator.ts` were needed**.
- `aieSchemaRegistry.register({ name: 'aie_insurance_adapter_field_completion', ... })`
  (`lib/aie/schema/schemaRegistry.ts`) — the adapter's one AI-fallback
  field (`policyNameClarification`).

`registerInsuranceAdapter()` (`lib/aie/adapters/insurance/index.ts`) is
idempotent and is called once at module-load time by
`app/api/aie/insurance/intake/route.ts` (a side-effecting import), matching
AIE-1.2/1.3's own established pattern exactly.

## 6. What was built, per class

### Insurance (the one IMPLEMENT_NOW class)

- **`lib/aie/adapters/insurance/`** — `types.ts` (field vocabulary),
  `documentCatalogue.ts` (the honest certified/deferred sub-class list —
  see its own header for the FULL disclosed schema-gap analysis),
  `labels.ts` (the bounded generic `Label: Value` layout's normalised-
  substring label taxonomy, most-specific-first, `unless`-veto design —
  reuses FDH-9's `payslip/labels.ts` DESIGN in substance, not by import),
  `parser.ts` (sniff/parse — `sniffInsuranceDocument` requires >=2 strong
  domain signals before claiming a document; `parseInsuranceDocument`
  extracts 10 canonical fields + 9 evidence-only fields, detects
  multi-component policies, masks any policy number BEFORE it ever becomes
  a candidate value), `schema.ts` (the one narrow AI-fallback field,
  `.strict()` Zod schema), `reconciliation.ts` (5 rules: document-class
  support, required-field completeness, currency support,
  multi-component-not-supported, premium-totals-arithmetic against the
  DOCUMENT'S OWN printed annual total — no statutory rate invented
  anywhere), `featureFlags.ts` (two kill switches, both default OFF),
  `write.ts` (the gated canonical write — see below), `index.ts` (public
  surface + `registerInsuranceAdapter()`).
- **`app/api/aie/insurance/intake/route.ts`** — the same admission ->
  quarantine -> local extraction -> deterministic parser -> masked AI
  fallback -> schema validation -> reconciliation -> gated write pipeline
  shape AIE-1.1's generic route and AIE-1.3's `fdh-bank/intake` route
  already establish, wired to this adapter's parser/rule/write functions.
  Gated by its own `AIE_INSURANCE_ADAPTER_ENABLED` flag (checked first,
  before AIE-1.1's global intake flag), and authorised via
  `requireModuleCapability('INSURANCE', ...)` — the SAME gate the existing
  manual-entry `app/api/insurance/route.ts` already uses, not a new one.
- **Migration `supabase/migrations/0143_aie1_4_insurance_adapter_link.sql`**
  — one table, `aie_insurance_adapter_link` (provenance/amendment-lineage
  only — no financial data of its own, no reconciliation decision).
  Deliberately has NO `unique(insurance_policy_id)` constraint (unlike
  AIE-1.2's `aie_ii_adapter_link`), because a single `insurance_policies`
  row is legitimately amended over time by successive documents (a policy
  schedule, then a later renewal notice) sharing a caller-supplied
  `master_item_key` — see the migration's own header for the full
  reasoning. **HELD LOCALLY. Not applied to any DEV or production
  database.**
- **The canonical write itself is NOT new.** `write.ts`'s
  `acceptAndWriteInsuranceCandidates()` performs the IDENTICAL write
  `app/api/insurance/route.ts`'s existing manual-entry POST handler already
  performs: `insuranceSchema.safeParse(...)` then
  `makeRegistry('insurance_policies').save(userId, row)`. Gated behind
  `AIE_INSURANCE_ADAPTER_CANONICAL_WRITE_ENABLED` (default OFF), the
  reconciliation-outcome check (never `fail`/`indeterminate`/
  `not_applicable`), and an open-blocking-unresolved-items check —
  identical gate ORDER to AIE-1.2's `write.ts`.
- **`owner` (the household-role enum column) is NEVER derived from
  document text.** This is the single most important design decision in
  this adapter, disclosed at length in `write.ts`'s header: the document's
  own "Policy Owner"/"Insured Person"/"Beneficiary" NAME fields are
  captured as evidence-only candidates for display/audit, and the
  canonical `owner` column is always an explicit caller-supplied value
  (mirroring exactly how the real manual-entry UI already works) —
  inventing that name-to-household-role mapping would be the "ownership
  invention" AIE14 section 4 explicitly forbids. Verified by a dedicated
  test (`aieInsuranceAdapterWriteGate.test.ts`).

### Everything else (payslip/loans/assets/retirement/goals/bills/tax/
cross-border/identity)

Zero code. Explicitly marked DEFERRED or PROHIBITED in section 4's table
above, with a repository-grounded reason for each — never silently
skipped.

## 7. Fixture corpus (execution sequence step 8)

`tests/support/buildAieInsuranceFixtureText.ts` — synthetic, invented
values only, in the ONE bounded generic layout this pass certifies (see
`documentCatalogue.ts`'s header on why no real insurer's exact layout was
sourced). Covers: a clean single-component policy schedule (the baseline,
with premium/frequency/printed-annual-total reconciling exactly), renewal/
premium-notice header variants, a multi-component variant, a Product
Disclosure Statement (deferred sub-class), a claim document (deferred
sub-class), and a genuinely unrelated (bank-statement) document.

## 8. Verification evidence actually run and observed

- `npx vitest run tests/unit/aieInsuranceAdapter*.test.ts` — **42/42
  passed**, 4/4 files (parser: 14 tests; reconciliation: 9 tests;
  write-gate: 13 tests + row-shape test; orchestrator integration: 4
  tests).
- `npx tsc --noEmit` — **zero new errors**. One pre-existing-category error
  surfaced in a file this pass wrote (`tests/support/
  buildAieInsuranceFixtureText.ts`'s options-spread cast) and was fixed
  immediately (`as unknown as Record<string,string>`); final run shows
  only the SAME pre-existing razorpay/stripe/xlsx/`@electric-sql/pglite`
  module-not-found errors AIE-1.1's own report already discloses
  (confirmed identical, same files, same count).
- `npx eslint lib/aie/adapters/insurance app/api/aie/insurance` — **zero
  errors, zero warnings** (one unused-import warning found and fixed
  during this pass — `normaliseInsuranceLabel` was exported but unused in
  `parser.ts`).
- `npx node scripts/check-migration-versions.mjs` — OK, 134 active
  migrations, one file per version, next version 0144.
- `npx node scripts/check-migration-versions-against-branch.mjs
  --against=<ref>` — OK, no collision, run against all four of
  `origin/main`, `origin/feature/aie-1-1-document-gateway`,
  `origin/feature/aie-1-2-investment-adapter`,
  `origin/feature/aie-1-3-fdh-bank-adapter`.
- `npx vitest run` (full suite) — **6416 passed** (6374 baseline + 42 new),
  18 skipped, **18 failed — all 18 confirmed pre-existing**, identical in
  kind and count to AIE-1.1's own disclosed baseline (missing razorpay/
  stripe/xlsx/pglite optional packages; `resources*LiveDev` tests requiring
  real Supabase credentials; the pre-existing `countryGateAccessMatrix`
  failure; the pre-existing `aiResidualClosureFailClosed` A4 negative-
  control failure — this last one independently re-confirmed present on
  THIS branch's own base commit via `git stash` + re-run, exactly the same
  failure, before any of this pass's changes).
- **A real regression risk was found and fixed**, not swept under the rug:
  `tests/unit/fdh1Isolation.test.ts`'s naive whole-repo substring search
  for the literal text `"financial-data-hub"` flagged two new files
  (`documentCatalogue.ts`, `labels.ts`) whose header comments cite FDH-9/
  FDH-10/FDH-12 files by name as DEFER rationale and design prior art.
  Confirmed by `grep -rn "from '@/lib/financial-data-hub"
  lib/aie/adapters/insurance app/api/aie/insurance` (zero matches — no real
  import). Added to `FDH_APPROVED_CONSUMER_FILES` with the same documented
  per-file exception pattern AIE-1.1 already used for its own 10 identical
  false positives.
- **A real bug was found and fixed during fixture testing**, not swept
  under the rug: `labels.ts`'s bare `'insured'` catch-all term (meant to
  catch labels like "Insured:"/"Life Insured:") was silently swallowing
  "Sum Insured" — a MONEY field — into `insuredPersonName` before the
  `coverAmount` rule ever got to see it, because `"sum insured".includes
  ("insured")` is true and the `insuredPersonName` rule was ordered before
  `coverAmount`. Fixed with an explicit `unless: ['sum insured', 'sum
  assured', 'benefit amount']` veto. Caught by this pass's own positive-
  path parser test asserting `coverAmount` extraction, not by an external
  reviewer — disclosed here for transparency about how it was found.
- **`next build`** — NOT attempted this pass. AIE-1.1's own report already
  discloses this worktree's structural inability to run a Turbopack build
  against a symlinked/junctioned `node_modules` (confirmed unrelated to
  code, an environment limitation) — not re-attempted since nothing in
  this pass's own findings would change that outcome.

## 9. Non-negotiable prohibitions — self-check (not a certification)

| Prohibition | Where enforced |
|---|---|
| No generic "upload any unsupported PDF" promise | `documentCatalogue.ts`'s catalogue explicitly names exactly 3 certified sub-classes and 3 deferred ones; `parser.ts` fails safely (outcome `'failed'`) rather than coercing an uncertified sub-class |
| No adapter without stable canonical destination + domain owner | Insurance's destination (`insurance_policies`) and write service (`makeRegistry`) pre-date this pass and are already live; every DEFERRED class was deferred specifically because it lacked one half of this pair |
| No raw PII/high-risk data to external AI | Masking runs before any AI payload is built (AIE-1.1 core, unchanged); the ONE AI-eligible field this adapter declares (`policyNameClarification`) is narrative-only, never identity/value |
| No AI advice/ownership invention/tax classification/live valuation/balancing value | `owner` is never derived from document text (section 6 above); `ALLOWED_AI_COMPLETABLE_FIELDS` structurally excludes every identity/value/currency field via a closed Zod enum |
| No independent provider client / second exception state machine | Zero imports of any AI-provider code outside `lib/aie/provider/gateway.ts`; `aie_unresolved_item` (AIE-1.1 core) is the only exception table touched — this pass's every adapter-specific exception is expressed as a `ReconciliationRule` result, not a new table |
| No direct AIE/AI write to canonical module tables | `write.ts` calls `makeRegistry('insurance_policies').save()` — the SAME function the real manual-entry route calls; no new direct-to-table SQL anywhere in this adapter |
| No PC6 values rewriting a document fact | Zero imports of any PC6/pricing/NAV/benchmark module anywhere in `lib/aie/adapters/insurance/**` |
| No identity/medical/legal documents under ordinary adapter approval | Never implemented, never a candidate for anything but PROHIBIT (section 4) |
| No production migration/activation/backfill without separate authority | Migration 0143 held locally, not applied anywhere; both feature flags default OFF; no bucket/infra provisioning script was run |

## 10. What remains deferred / unverified

- **8 of 9 candidate document classes remain entirely unimplemented**
  (payslip/income, loans/liabilities, asset valuation, retirement/SMSF,
  goals, bills/expenses, tax-supporting evidence, cross-border-as-its-own-
  class) — see section 4's table for the specific reason per class. None
  of this is a promise that a future pass will pick them up in this order;
  it is this pass's honest accounting of what it did NOT do and why.
- **No real insurer's exact PDF layout was sourced or tested.** The
  bounded generic `Label: Value` layout is this pass's own disclosed
  choice (AIE14-ELIG-05's "bounded generic structure" option), not a claim
  that any specific real insurance provider's document will parse
  correctly.
- **Excess, exclusions/endorsements-as-structured-text, distinct policy-
  owner/insured/beneficiary ROLES, and multi-coverage-component
  reconciliation (AIE14-INS-03/06/07/08/09) are DESIGN_ONLY**, not
  IMPLEMENT_NOW — captured as evidence-only candidates where extractable,
  never written to canonical storage, because `insurance_policies` has no
  column for any of them. Extending that schema needs separate Product
  Owner sign-off (this pass has no migration-application authority
  regardless).
- **No live-DEV run.** Nothing in this pass touched a real Supabase
  database, a real storage bucket, or a real AI provider — this is unit-
  test-level verification only, exactly like AIE-1.1/1.2/1.3's own
  disclosed scope.
- **No AIE-1.5 review/acceptance UI exists yet** — this adapter's intake
  route self-accepts as the uploading user (same disclosed placeholder
  AIE-1.2/1.3 already use), not a real reviewer decision.
- **AIE-1.4's own 286 numbered requirements were not individually
  traced** one-by-one against evidence in an Appendix-D-style table this
  pass — the eligibility framework, adapter SDK reuse, and the one
  implemented class's schema/masking/reconciliation/exceptions/writes/
  corpus were addressed directly and are traceable from this report's own
  section references, but a literal 286-row traceability matrix was not
  produced. That level of exhaustive per-requirement sign-off is
  explicitly AIE-1.6's job, not claimed as done here.
- **Section 4 of this report's own scorecard is this pass's judgement
  call, not a Product-Owner-ratified decision.** In particular, "at most
  two" classes were permitted by the spec if genuinely both mature enough;
  this pass chose to do Insurance properly rather than split effort across
  Insurance and Assets — a defensible but not unique reading of the
  spec's own eligibility framework, and the Product Owner may reasonably
  disagree.

## 11. What this means for AIE-1.5/AIE-1.6

The one adapter this pass builds emits exactly the same shape of
`AieReconciliationRunResult[]` / `AieUnresolvedItemInput[]` AIE-1.2/1.3
already emit, through the same unmodified AIE-1.1 core — a future AIE-1.5
review UI needs no Insurance-specific lifecycle work, only a renderer for
this adapter's 5 reconciliation reason codes and its evidence-only field
set. AIE-1.6 inherits: one migration (0143) awaiting production authority,
two feature flags both defaulted OFF, and this report's own honest
"what remains" list as the starting point for whatever independent
verification it chooses to run.

## 12. Branch / commit / push status

- Branch: `feature/aie-1-4-other-modules`
- Based on: `feature/aie-1-1-document-gateway` @ `cd2d4a2`
- Latest commit at time of writing: `8e464b16461f830a17c7683ac5c5895ac927349e`
  (`feat(aie-1-4): Insurance adapter — schema, deterministic parser,
  reconciliation, gated write`)
- Pushed to `origin/feature/aie-1-4-other-modules`: **yes**
- Merged to `main`: **no**
- Migration `0143` applied to DEV or production: **no, held locally**
- Production authority granted: **none** (no feature flag enabled anywhere
  outside test code)
