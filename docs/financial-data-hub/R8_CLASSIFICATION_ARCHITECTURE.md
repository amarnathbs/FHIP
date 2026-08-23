# R8 — Classification Architecture

## 1. Layering

```
FDH-1 (0047)     canonical schema: fdh_transactions classification columns,
                 fdh_transaction_links, fdh_recurring_transactions,
                 fdh_classification_history, fdh_transaction_corrections,
                 fdh_user_classification_rules — all pre-existing, unused
                    │
FDH-2 (0050-0057) reference/governance layer: category taxonomy, MCC map,
                 merchant master, 60 classification rule seeds, the
                 classificationPrecedence.ts pure resolver — data + a pure
                 resolution-semantics function, no execution
                    │
R7/FDH-4         canonical bank transactions, always inserted UNCLASSIFIED
                 (economic_transaction_type='unknown',
                 classification_method='unclassified')
                    │
R8 (0067 + this  the EXECUTION ENGINE: reads real transactions + FDH-2
   release)      reference data, computes and PERSISTS real classification,
                 transfer/settlement/refund links, recurring series;
                 hardens the newly-authoritative columns
```

R8 built no new reference-data tables, no new taxonomy, no new merchant
master, and no new transfer/recurring schema — R8-P0
(`R8_ASSUMPTION_RECONCILIATION.md`) found all of it already present. R8's
code is entirely in `lib/financial-data-hub/classification/*` (pure
functions) and `lib/financial-data-hub/services/transactionClassificationService.ts`
+ `classificationReviewService.ts` (persistence).

## 2. Pure engine modules

| Module | Responsibility | Inputs | Outputs |
|---|---|---|---|
| `textMatch.ts` | Bounded literal substring matching, never a regex over user input | strings | boolean |
| `merchantMatching.ts` | Verified-alias / canonical-name lookup | description, merchant/alias master | `MerchantMatch \| null` |
| `ruleMatching.ts` | Evaluates one rule's `match_definition` against one transaction | transaction slice, rule | boolean; `evaluateRules` ranks by priority |
| `economicTypeEngine.ts` | Orchestrates merchant + user rules + global rules through `resolvePrecedence()` | transaction, reference data | `EconomicTypeResult` |
| `transferMatching.ts` | Cross-account pairing (internal transfer / credit-card settlement / loan payment) | candidate transactions, account-type map | `ProposedTransferLink[]` |
| `refundReversalMatching.ts` | Same-account refund/reversal linkage | candidate transactions | `ProposedRefundLink[]` |
| `recurringDetection.ts` | Frequency-bucket clustering with false-recurrence protection | candidate transactions | `DetectedSeries[]` |

Every module above is a pure function: no Supabase client, no `fetch`, no
`Date.now()` (dates are always caller-supplied), deterministic given its
inputs. This is what makes the independent oracle comparison
(`scripts/r8_oracle_compare.ts`) and the unit test suite meaningful — the
exact same call, given the exact same input, always produces the exact same
output.

## 3. Persistence orchestration

`transactionClassificationService.ts#classifyUserTransactions(userId)`:

1. Reads the user's full transaction history via `fetchAllRows()` (R7's
   existing pagination helper — reused verbatim, not duplicated).
2. Reads FDH-2 reference data (categories, subcategories, merchants,
   aliases, global rules) via the ordinary RLS-scoped master-data
   repositories, and the user's own personal rules.
3. Excludes every `user_override = true` row before the engine ever sees it
   — a human's confirmed correction is never reprocessed.
4. Calls `classifyTransaction()` per row; writes a changed result via the
   service-role client (bypassing the migration-0067 trigger that blocks
   the *authenticated* role, not service-role).
5. Runs `matchInternalTransfers()`/`openCandidateLink()` and
   `matchRefundsToOriginals()` once across the whole batch (cross-account
   matching cannot be done per-row).
6. Runs `detectRecurringSeries()` once across the whole batch, creates new
   `fdh_recurring_transactions` rows, and back-fills member transactions'
   `recurring_transaction_id`.
7. Appends `fdh_classification_history` for every real change, and one
   `transaction_classification_run` audit event summarising the whole run.

Idempotent: an unchanged result writes nothing; existing links are
detected via `fdh_transaction_links`' own unique indexes
(`uq_fdh_links_pair`/`uq_fdh_links_open`) and the service's own
pre-fetch, so re-running after a new statement import only processes the
genuinely new/changed rows.

## 4. Where R8 deliberately stops

- **No `ii_*` row, ever.** `economic_transaction_type = 'investment'` is a
  bank-side classification only (spec section 34); the funding candidate
  either pairs with a same-user transaction (`investment_funding` link
  type) or stays an *open* link with no counterpart — R8 never reaches into
  Investment Intelligence's own tables.
- **No manual register write.** R8 never writes `income_sources`,
  `expense_items`, or any other `FHIP_PROTECTED_INPUT_TABLES` row — the
  manual Input Data taxonomy (`master_financial_items`) and FDH's own
  taxonomy (`fdh_categories`) are and remain two separate systems (spec
  section 15/55; see `R8_ASSUMPTION_RECONCILIATION.md` section 4).
- **No new correction system.** `fdh_transaction_corrections` +
  `correctTransaction()` (shipped in R7) already covers R8's own target
  fields; R8 only added the trigger-side "evidenced write" gate so that
  existing feature keeps working safely once the fields it corrects become
  authoritative.
- **No fuzzy merchant matching, no AI.** Precedence tiers `fuzzy_merchant_
  match` and `ai` are structurally unreachable — `resolvePrecedence()`
  accepts them as valid enum values (for a future release) but nothing in
  this codebase ever produces a candidate tagged with either.
