# FDH-6 — R8 Adoption & Gap Audit

Written BEFORE any FDH-6 runtime code, per the spec's own mandate (section
7-10): "the first task is therefore an R8 adoption and gap analysis." Every
claim below is backed by reading real source files and real tests in this
repository as of `origin/main` `4b93682` — no capability is inferred from a
file name alone.

## 1. What was actually found

R8 (`feature/r8-transaction-categorisation-merchant-intelligence`, merged to
`main` at `e143d6d`, migration `0068`) is **not** a merchant/category engine
alone. Reading `lib/financial-data-hub/classification/*` and
`lib/financial-data-hub/services/{transactionClassificationService,
classificationReviewService}.ts` shows R8 already implements, as pure,
tested, deterministic engines:

- `economicTypeEngine.ts` — the full 13-class economic classification engine
  (`classifyTransaction()`), consuming the precedence resolver
  (`domain/classificationPrecedence.ts`, built in FDH-2) and merchant/rule
  matchers.
- `merchantMatching.ts` — verified-alias/canonical-name merchant matching.
- `ruleMatching.ts` — global/user rule evaluation against a closed,
  structured `match_definition` vocabulary.
- `transferMatching.ts` — own-account transfer / credit-card-settlement /
  loan-payment candidate pairing, cross-bank, tenant-scoped, exact-money,
  narrow date window, never amount-alone.
- `refundReversalMatching.ts` — refund/reversal linkage back to an original
  transaction, partial-refund aware.
- `recurringDetection.ts` — cadence-bucketed recurring/subscription series
  detection with false-recurrence protection and variable-amount support.

These correspond almost one-for-one to FDH-6 spec sections 20 (Transfer
Intelligence), 35-38 (Refund Intelligence) and 39-46 (Recurring
Intelligence) — capabilities the original FDH-6 brief describes as if they
did not yet exist. **They already exist, are already tested, and are
already live on `main`.**

The economic-class taxonomy the spec's section 4 asks FDH-6 to establish
(`INCOME, EXPENSE, TRANSFER, INVESTMENT, DEBT_PRINCIPAL, DEBT_INTEREST,
REFUND, ASSET_PURCHASE, ASSET_SALE, TAX, FEE, CASH_WITHDRAWAL, UNKNOWN`) is
**already the exact, frozen `FDH_ECONOMIC_TRANSACTION_TYPES` enum**
(`lib/financial-data-hub/constants/enums.ts:315-329`), in place since FDH-1
migration `0047` and enforced by a `check` constraint on
`fdh_transactions.economic_transaction_type` and three other tables. There
is no second taxonomy to reconcile.

The full schema FDH-6 would otherwise need to invent —
`fdh_transaction_links`, `fdh_transaction_allocations` (splits),
`fdh_duplicate_candidates`, `fdh_user_classification_rules`,
`fdh_classification_history`, `fdh_recurring_transactions` — was **already
created in FDH-1 migration `0047`**, explicitly as forward references
("NO MATCHING ALGORITHM IS IMPLEMENTED IN FDH-1 (FDH-6)"). R8 (for
transfer/refund/recurring) and R7 (for duplicates, see section 4 below) have
since filled in almost every one of those forward references. Only two of
FDH-1's six forward-referenced tables/capabilities remain genuinely
unimplemented at the code layer today — see section 5.

## 2. Capability-by-capability audit (spec section 8)

| Capability | Verdict | Evidence |
|---|---|---|
| Merchant normalization | **FULLY SATISFIED BY R8** | `merchantMatching.ts`; verified alias / approved canonical name only |
| Merchant alias resolution | **FULLY SATISFIED BY R8** | `fdh_merchant_aliases`, `alias.verified` gate |
| Exact merchant matching | **FULLY SATISFIED BY R8** | same |
| Fuzzy merchant matching | **NOT SATISFIED — disclosed, deliberate** | R8's own header comment: "NOT IMPLEMENTED anywhere in this codebase"; precedence tier 7 structurally unreachable. FDH-6 does not add this either (spec section 62: deterministic first; fuzzy matching was never mandatory) |
| MCC classification | **NOT SATISFIED — disclosed, deliberate, correct** | `ruleMatching.ts` returns `false` for `mcc`/`source_provided_category` match kinds because no CSV-sourced transaction ever carries an MCC (R7's canonical contract has no such column). Not a bug — MCC evidence genuinely does not exist yet for the only ingestion sources in production |
| Category/subcategory output | **FULLY SATISFIED BY R8** | `economicTypeEngine.ts` |
| Categorisation confidence | **FULLY SATISFIED BY R8** | `ClassificationConfidenceState` (`HIGH/MEDIUM/LOW/UNRESOLVED`), separate from `extraction_confidence` (FDH-1) |
| Rule precedence | **FULLY SATISFIED BY R8** (built by FDH-2, consumed by R8) | `domain/classificationPrecedence.ts`, `resolvePrecedence()` |
| User corrections | **FULLY SATISFIED** (R7 correction API + R8 evidenced-write trigger) | `fdh_transaction_corrections`, migration `0068` section 2-3 |
| User-specific rules | **FULLY SATISFIED BY R8** | `fdh_user_classification_rules`, tier 1 precedence |
| Global rules | **FULLY SATISFIED BY FDH-2, consumed by R8** | `fdh_classification_rules`, 60 seeded rows |
| Review states | **FULLY SATISFIED (schema) / PARTIALLY SATISFIED (surfaced reason)** | `review_status` exists; no structured "why" reason taxonomy exists yet — see gap G1 |
| Merchant master integration | **FULLY SATISFIED BY R8** | direct `fdh_merchants`/`fdh_merchant_aliases` reads |
| Category master integration | **FULLY SATISFIED BY R8** | direct `fdh_categories`/`fdh_subcategories` reads |
| Classification history | **FULLY SATISFIED BY R8** | `fdh_classification_history`, append-only RLS, written every changed classification |
| Explanation/evidence | **PARTIALLY SATISFIED** | `EconomicTypeResult.explanation` is computed but never persisted — recomputable on demand since the engine is pure/deterministic, but no stored/API surface exists today — see gap G1 |
| Recurring transaction signals | **FULLY SATISFIED BY R8** | `recurringDetection.ts` |
| Transfer signals | **FULLY SATISFIED BY R8** | `transferMatching.ts` |
| Refund signals | **FULLY SATISFIED BY R8** | `refundReversalMatching.ts` |
| Cash withdrawal handling | **FULLY SATISFIED BY FDH-2 seed, consumed by R8** | 3 seeded `cash_withdrawal` narrative rules (AU+IN) |
| Fee/interest handling | **FULLY SATISFIED BY FDH-2 seed** | 8 seeded `fee` rules + 4 seeded `debt_interest` rules (AU+IN) |
| Duplicate handling | **FULLY SATISFIED BY R7** (not R8) | see section 4 |
| Learning/governance workflow | **PARTIALLY SATISFIED** | domain contract complete (FDH-2's `globalLearningGovernance.ts` + `personalPayeeGuard.ts`); intake wiring/admin UI explicitly deferred to a later phase by FDH-2's own code comments — see section 6 |

## 3. Economic-class reachability audit (new finding, not disclosed by R8)

Reading the FDH-2 taxonomy seed (`0053`) and rule seed (`0056`) against the
frozen 13-class enum shows **10 of 13 classes are reachable today; 3 are
schema-complete but have zero reachable path**:

| Economic class | Reachable via merchant/category master? | Reachable via a global narrative rule? | Verdict |
|---|---|---|---|
| income | yes (`income` category) | yes (11 rules) | reachable |
| expense | yes (default path for ordinary categories) | n/a (implicit) | reachable |
| transfer | yes (`transfer_flag`/structural hint path) | n/a (handled by `transferMatching.ts`, not a classify rule) | reachable |
| investment | yes (`retirement_contribution` category) | yes (2 rules — EPF/NPS) | reachable |
| **debt_principal** | **category `loan_principal` exists (economic_type=`debt_principal`, 4 AU/IN subcategories) but zero merchants and zero rules ever select it** | **0 rules** | **schema-complete, UNREACHABLE — gap G2** |
| debt_interest | yes (`loan_interest` category) | yes (4 rules) | reachable |
| refund | yes (`refund_reversal` category) | yes (6 rules) | reachable |
| **asset_purchase** | **category `investment_purchase` exists (4 AU/IN subcategories) but zero merchants and zero rules ever select it** | **0 rules** | **schema-complete, UNREACHABLE — gap G2** |
| **asset_sale** | **category `investment_sale` exists (4 AU/IN subcategories) but zero merchants and zero rules ever select it** | **0 rules** | **schema-complete, UNREACHABLE — gap G2** |
| tax | yes (`government_tax` category) | yes (1 rule) | reachable |
| fee | yes (`financial_fees` category) | yes (8 rules) | reachable |
| cash_withdrawal | yes (`cash_withdrawal` category) | yes (3 rules) | reachable |
| unknown | always reachable (default/fallback) | n/a | reachable |

This was independently verified against **live DEV** via REST
(`fdh_classification_rules?action_definition->>economic_transaction_type=eq.debt_principal`
etc., all three returned `[]`; total rule count on DEV = 60, exactly
matching the migration-file count — confirming no other concurrent stream
has touched this table).

Gap G2 is real, narrowly scoped, and squarely spec section 50/55's territory
("distinguish DEBT_PRINCIPAL... where evidence permits", "Use \[asset]
classes cautiously... primarily for identifiable financial/property/major
asset events where supported") — the schema was clearly designed to support
these three classes; nothing ever populated the last mile. FDH-6 closes this
gap with a small, additive rule-seed migration (see
`FDH6_ECONOMIC_CLASSES.md`) rather than inventing new schema.

## 4. Duplicate intelligence — already fully owned by R7, not a gap at all

FDH-1's own schema comment on `fdh_duplicate_candidates` ("NO
DUPLICATE-DETECTION ENGINE IS IMPLEMENTED IN FDH-1 (FDH-6)") is **stale**.
Reading `lib/financial-data-hub/bank-csv/{fingerprint,dedup}.ts` and
`bankCsvProcessingService.ts` (R7, merged before R8) shows R7 already:

- Computes a Layer-3 economic fingerprint (account + dates + amount +
  currency + normalised description + reference + balance) that
  deliberately excludes the import-batch ID, so the same transaction
  re-imported from a different statement/format still collides (spec
  section 34, cross-format duplicates).
- Classifies a fingerprint collision as `duplicate_confirmed` /
  `matchMethod: 'exact_hash'` only when **both** sides carry a
  distinguishing reference/balance ("strong evidence"); otherwise downgrades
  to `duplicate_candidate` / `matchMethod: 'fuzzy_amount_date'` — **never
  auto-discards**, which is the exact, correct answer to the mandatory
  negative control in spec section 33/74 ("10:01 Coffee Shop $5.00, 14:22
  Coffee Shop $5.00 — both are genuine, must remain two transactions"): the
  schema stores `transaction_date` as `date`, not `timestamptz` (no
  time-of-day), so nothing downstream could distinguish those two rows by
  time even if it wanted to — which is exactly why R7 refuses to
  auto-discard a weak-evidence fingerprint match rather than attempting a
  false, over-confident distinction the data cannot support.
- Writes real `fdh_duplicate_candidates` rows (`match_method`,
  `confidence`, `status: 'pending'`), resolvable through an existing
  user-facing duplicate-resolution path.

**Verdict: duplicate intelligence (spec sections 31-34, acceptance section
129) is FULLY SATISFIED BY R7. FDH-6 introduces zero new duplicate-detection
code.** Building a second, fuzzy amount+date-only economic-duplicate layer
on top of this — the shape spec section 31 explicitly asks FDH-6 to
consider — was evaluated and **rejected**: given the schema's date-only
granularity, any matcher weaker than R7's existing fingerprint+evidence
design would systematically violate the mandatory negative control (spec
136's own FAIL condition: "legitimate transactions are destroyed as
duplicates").

## 5. Genuine gaps FDH-6 closes (all additive, all reuse existing schema)

- **G1 — Review reason surfacing (spec section 64).** `review_status`
  exists; a structured "why" taxonomy
  (`UNKNOWN_CLASSIFICATION/POSSIBLE_TRANSFER/MISSING_COUNTERPART_ACCOUNT/
  POSSIBLE_DUPLICATE/RULE_CONFLICT/LOW_CLASSIFICATION_CONFIDENCE/
  POSSIBLE_REFUND`) does not. Closed with a pure, read-time-computed
  `deriveReviewReasons()` function (no schema change — the engine is
  deterministic, so a reason is always reproducible from already-persisted
  signals).
- **G2 — Unreachable economic classes (`debt_principal`, `asset_purchase`,
  `asset_sale`)**, see section 3. Closed with migration `0075`: additive
  `fdh_classification_rules` rows only, reusing FDH-2's existing
  `loan_principal`/`investment_purchase`/`investment_sale` categories —
  zero new tables, zero new columns.
- **G3 — Rule-conflict detection (spec section 57).** `economicTypeEngine.ts`
  currently takes "the first user-rule match" / "the first classify-action
  global-rule match" after a priority sort; two rules that genuinely tie on
  priority with **different** classify actions are resolved by array order,
  not detected. Closed with a same-priority-conflict check inside the
  existing tier loops, routing a genuine tie to `unknown` /
  `RULE_CONFLICT` instead of an arbitrary silent pick.
- **G4 — Threshold governance (spec section 84).** Date windows, lookback
  days, frequency-bucket tolerances and confidence cut-offs are each a local
  `const` inside `transferMatching.ts`/`refundReversalMatching.ts`/
  `recurringDetection.ts`. Closed with a single
  `lib/financial-data-hub/classification/thresholds.ts` the three modules
  import from — a pure refactor, identical default values, verified by
  re-running R8's existing unit suite unchanged (same pass count before and
  after).
- **G5 — Certification depth (spec sections 77-82, 118-119).** R8's own
  `R8_200_CASE_CERTIFICATION.md` already discloses its case counts are
  materially below the spec's target in several categories (merchant 9/30,
  transfer 18/35, recurring 15/25, ambiguous/conflict 1/15). FDH-6 does not
  duplicate R8's suite; it adds a much larger, genuinely **independent**
  (separately hand-computed, no shared code with the production engine)
  AU+India scenario pack meeting spec section 78's 200+ target, covering
  every economic class and the specific mandatory scenario/negative-control
  lists in sections 73-82.

## 6. Explicitly out of scope / deliberately not built

- **Global-candidate intake wiring / admin review UI (spec section 14's
  full pipeline).** FDH-2's `globalLearningGovernance.ts` and
  `personalPayeeGuard.ts` already implement the complete, tested **domain
  contract** for this workflow (status-transition rules, PII/personal-payee
  screening heuristic) and say so explicitly in their own header comments:
  "NOT the admin review screen — a future phase builds that UI"; "no
  automatic promotion, ever." FDH-6 needs to *preserve* this boundary (spec
  acceptance section 132: "no automatic global promotion"), which it does
  by construction (no FDH-6 code path writes `fdh_merchants` or
  `fdh_classification_rules`). Building the actual candidate-intake
  route/admin UI is out of FDH-6's own scope per spec section 91 ("do not
  build an admin transaction browser") and the existing code's own stated
  ownership boundary — reported as **N/A**, matching the completion
  report's own explicit allowance (section 125).
- **Fuzzy merchant matching, MCC-based classification, AI classification.**
  All three are explicitly non-goals per spec sections 12/59/62 unless
  separately authorised; none are separately authorised here.
- **A second duplicate-detection engine.** See section 4 — would violate
  spec's own negative control given the schema's date granularity.
- **OCR work.** Per the Product Owner's explicit note accompanying this
  task, FDH-5's disclosed OCR gap stays out of FDH-6 entirely.

## 7. Required reuse metric (spec section 9)

- Original FDH-6 capability areas audited: **22** (the list in spec section
  8, plus review-reason surfacing, economic-class reachability, and
  duplicate intelligence as separately audited areas).
- Fully satisfied by R8 (or R7/FDH-2, already live on `main`): **17**.
- Partially satisfied (schema/domain contract exists, wiring/depth added by
  FDH-6): **4** (review-reason surfacing, economic-class reachability,
  certification depth, threshold centralisation).
- New FDH-6 capability areas implemented from scratch: **1** (rule-conflict
  detection — genuinely new decision logic, though it reuses the existing
  precedence/tier structure rather than replacing it).
- Duplicate classification engines introduced: **0**.
- Duplicate merchant engines introduced: **0**.
- Duplicate transaction models introduced: **0**.
- Duplicate ingestion-dedup engines introduced: **0**.

This is the outcome spec section 141 calls "the correct result" when a
prior phase already solves a substantial part of a new one.
