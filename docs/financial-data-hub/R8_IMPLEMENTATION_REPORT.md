# R8 — Implementation Report

## 1. What was built

| Area | Files |
|---|---|
| Migration | `supabase/migrations/0067_r8_transaction_classification_engine.sql` |
| Pure engine | `lib/financial-data-hub/classification/{types,textMatch,merchantMatching,ruleMatching,economicTypeEngine,transferMatching,refundReversalMatching,recurringDetection}.ts` |
| Persistence orchestration | `lib/financial-data-hub/services/transactionClassificationService.ts`, `lib/financial-data-hub/services/classificationReviewService.ts` |
| API | `app/api/financial-data-hub/bank-transactions/categorise/route.ts`, `app/api/financial-data-hub/transaction-links/[linkId]/review/route.ts`, `app/api/financial-data-hub/recurring-transactions/[recurringId]/review/route.ts`, `app/api/financial-data-hub/user-rules/route.ts` |
| Type/schema fixes | `lib/financial-data-hub/domain/types.ts` (widened `FdhRuleMatchDefinition`/`FdhRuleActionDefinition`/`FdhMerchant`/`FdhTransaction`/`FdhTransactionLink` to match the already-shipped FDH-2 Zod schema and the two new migration columns), `lib/financial-data-hub/constants/enums.ts` (4 new audit event types), `lib/financial-data-hub/validation/transactions.ts` (2 new review-decision schemas) |
| Tests | `tests/unit/r8TextMatchAndMerchant.test.ts`, `tests/unit/r8RuleMatchingAndEconomicType.test.ts`, `tests/unit/r8TransferRefundRecurring.test.ts`, `tests/unit/r8SchemaContract.test.ts` |
| Certification tooling | `scripts/r8_security_certification.mjs`, `scripts/r8_independent_classification_oracle.py`, `scripts/r8_oracle_compare.ts`, `tests/fixtures/r8/independent_oracle_cases.json` |
| Fixes to existing tests | `tests/unit/fdh1Isolation.test.ts` (service-role allowlist widened to 5 files; consumer-scan timeout raised), `tests/unit/r7SchemaContract.test.ts` (event-type assertion re-scoped to its own frozen migration) |

## 2. What was deliberately NOT built (and why)

- **No new taxonomy/merchant-master/rule-seed tables** — R8-P0 found them
  already built by FDH-1/FDH-2. See `R8_ASSUMPTION_RECONCILIATION.md`.
- **No fuzzy merchant matching, no AI** — both precedence tiers remain
  structurally unreachable, matching the disclosed boundary every prior
  FDH phase carried (spec section 57 explicitly forbids AI as an
  authoritative source in this release).
- **No classification-review UI** — R8-P0 found ZERO existing FDH
  transaction-list/review UI anywhere (the only FDH page is the document-
  upload landing page). Building a full review-queue UI from nothing was
  judged out of this release's time budget; the API surface (`categorise`,
  link review, series review, user rules) is complete and independently
  usable by a future UI or by direct API integration. Disclosed as an open
  residual, not hidden.
- **No wiring into the R7 CSV-ingestion pipeline itself** —
  `bankCsvProcessingService.ts` (R7, terminally certified) is untouched.
  Classification is a separate, explicitly-triggered step
  (`POST .../categorise`) rather than an automatic post-ingestion hook —
  a deliberate choice to keep zero risk to R7's frozen, certified code
  path. A future release can wire an automatic trigger once this
  engine has live-DEV mileage.
- **No scheduled/cron re-evaluation of recurring-series status** —
  `refreshSeriesStatus()` is a pure function with no caller wiring it to a
  periodic job in this release.

## 3. Reused verbatim (not duplicated)

- `resolvePrecedence()` (FDH-2's precedence resolver)
- `fetchAllRows()` (R7's pagination helper)
- `fdh_transaction_corrections` + `correctTransaction()` (R7's correction
  service — untouched)
- FDH-2's full category/merchant/MCC/rule reference data (zero new seed
  rows)
- The `0064`/`0065` authoritative-field trigger pattern (widened via
  `create or replace function` on the same function/trigger name where
  one already existed, exactly as `0065` itself did for R7)

## 4. Genuine defects found and fixed during this release

1. **Type/schema drift** (pre-existing, not introduced by R8): `FdhRuleMatchDefinition`/`FdhRuleActionDefinition` in `domain/types.ts` were missing FDH-2's `narrative_pattern`/`payment_rail_narrative`/`flag_candidate`/`annotate_payment_rail` members even though the Zod validation schema already supported them. `FdhMerchant` was missing FDH-2's recurring-metadata columns. Both fixed additively.
2. **Migration trigger gap**: `candidate -> ended` was a valid transition in `classificationReviewService.ts`'s application logic that migration 0067's own trigger did not yet permit. Found by the security certification script during development, fixed in the same migration before this release closed (not left as a known-inconsistency).
3. **Test-harness bug**: a nested `asRole()` call inside another `asRole()` callback corrupted the `request.jwt.claims` session GUC on unwind, producing a false PASS on a cross-tenant security check. Found, root-caused, and fixed (see `R8_SECURITY_VERIFICATION.md` section 8) — the certification script would otherwise have silently certified a check it wasn't actually running correctly.
4. **Test regression** (caused by legitimate R8 growth, not a bug in R8's own logic): `fdh1Isolation.test.ts` timeout and `r7SchemaContract.test.ts`'s frozen-constant assumption — both root-caused and fixed, see `R8_TESTING_AND_VERIFICATION.md` section 2.

## 5. Migration allocation

Guard re-run confirmed `0067` was genuinely free at branch-creation time
and remained free through this release's own development (re-checked
after adding the migration file itself). No collision with any parallel
release (Investment Intelligence R9, running independently per this
dispatch's own briefing) was observed — R8 never inspected R9's branch or
files, per the dispatch's explicit instruction.
