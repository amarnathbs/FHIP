# FDH-6 — Classification Architecture

## 1. One chain, not two

```
Bank activity
  -> CSV (R7/FDH-4) or PDF (FDH-5)
  -> Canonical Transaction (fdh_transactions, FDH-1)
  -> R8 Merchant + Category Engine (lib/financial-data-hub/classification/economicTypeEngine.ts)
  -> FDH-6 orchestration layer:
       - Economic-class gap closure (migration 0072: debt_principal/asset_purchase/asset_sale reachable)
       - Rule-conflict detection (economicTypeEngine.ts, gap G3)
       - Transfer confirmation -> economic-class write-back (classificationReviewService.ts, applyTransferClassOnConfirm)
       - Structured review-reason surfacing (reviewReasons.ts, gap G1)
       - Centralised thresholds (thresholds.ts, gap G4)
  -> Review (fdh_transactions.review_status + fdh_transaction_links + fdh_recurring_transactions + fdh_duplicate_candidates)
```

There is exactly one canonical transaction model (`fdh_transactions`, FDH-1), one merchant engine (R8's `merchantMatching.ts`), one category engine (R8's `economicTypeEngine.ts`), one ingestion-dedup engine (R7's `dedup.ts`/`fingerprint.ts`), one transfer-matching engine (R8's `transferMatching.ts`), one refund-matching engine (R8's `refundReversalMatching.ts`), one recurring-detection engine (R8's `recurringDetection.ts`). FDH-6 adds orchestration and gap closure around every one of them — it introduces zero competing engines.

## 2. What FDH-6 actually added

| File | Kind | Purpose |
|---|---|---|
| `lib/financial-data-hub/classification/thresholds.ts` | new, pure refactor | Centralises every magic number R8 had scattered across 4 files (spec section 84). Values unchanged. |
| `lib/financial-data-hub/classification/economicTypeEngine.ts` | modified | Adds same-priority rule-conflict detection (`pickTopTierOrConflict`) at the user-rule and global-rule tiers (spec section 57). |
| `lib/financial-data-hub/classification/types.ts` | modified | Adds `ClassificationSource.kind === 'rule_conflict'` + `conflictingRuleIds`. |
| `lib/financial-data-hub/classification/reviewReasons.ts` | new, pure | Derives a structured `FdhReviewReasonCode[]` from already-persisted signals — no schema change (spec section 64). |
| `lib/financial-data-hub/services/classificationReviewService.ts` | modified | Adds `explainTransactionReviewReasons()` (wires `reviewReasons.ts` to real repositories) and `applyTransferClassOnConfirm()` (closes the FDH-2-disclosed forward reference: confirming a transfer link now writes the transfer economic class back onto both transactions, via the EXISTING `correctTransaction()` correction path — spec sections 20-22). |
| `supabase/migrations/0072_fdh6_economic_class_gap_closure_rule_seed.sql` | new, additive data only | 14 new `fdh_classification_rules` rows closing the `debt_principal`/`asset_purchase`/`asset_sale` reachability gap (section 3 of the adoption audit). Zero new tables/columns. |

Everything else FDH-6 needed — merchant/category classification, transfer/refund/recurring matching, ingestion dedup, split allocations, classification history, user rules, global-learning governance domain contract, personal-payee PII screening — was already built by FDH-1, FDH-2, R7 or R8 and is reused unchanged.

## 3. Economic classification vs category vs transfer/duplicate/recurring

These stay cleanly separated exactly as spec sections 11 and 60 require:

- **Category** (`fdh_categories`/`fdh_subcategories`) is a taxonomy label ("Groceries", "Home Loan Principal").
- **Economic class** (`fdh_transactions.economic_transaction_type`) is the frozen 13-value enum — a category's `economic_type` column supplies a DEFAULT economic class when a merchant/rule resolves that category, but the two are stored separately and a rule may override the category's default (see `economicTypeEngine.ts`'s `categoryEconomicType()` fallback logic).
- **Transfer/duplicate/recurring** are RELATIONSHIPS between transactions (`fdh_transaction_links`, `fdh_duplicate_candidates`, `fdh_recurring_transactions`), never a transaction's own field alone — a transaction's economic class only becomes `transfer` once a proposed link is actually confirmed (`applyTransferClassOnConfirm`), never merely because a narrative pattern looked transfer-like.
- **Payment rail** (`annotate_payment_rail` action rows) is evidence about the MECHANISM (UPI/BPAY/NEFT/...), never an economic category — confirmed empirically in the certification pack (Section A/B, e.g. AU-05/06, IN-02/04-07).

## 4. Precedence

Unchanged from R8/FDH-2's existing 9-tier `domain/classificationPrecedence.ts` (`FDH6_CLASSIFICATION_PRECEDENCE.md` documents it in full) — FDH-6 adds tie-breaking WITHIN a tier (rule-conflict detection), never a competing precedence order.

## 5. Boundaries preserved

- **Input Data** (spec section 98): no FDH-6 code path writes to FHIP's Input Data tables. Verified by `grep -rn "input_data\|financial_input" lib/financial-data-hub/classification lib/financial-data-hub/services/classificationReviewService.ts` — zero matches outside comments.
- **Investment Intelligence** (spec section 99): `asset_purchase`/`asset_sale`/`investment` are economic-class LABELS on a bank/card transaction row; no FDH-6 code path writes a holding, tax lot, security or any Investment Intelligence table. `economicTypeEngine.ts`'s own module comment states this explicitly and the AU-12/AU-13 certification cases assert `EconomicTypeResult` carries no holding-shaped field at all.
- **Admin visibility** (spec section 91): FDH-6 adds no admin route and no transaction browser. `explainTransactionReviewReasons()` is user-RLS-scoped only.
