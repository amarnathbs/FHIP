# FDH-11 — Australia Transaction Intelligence (spec sections 25-38, 90, 98-107)

## The vocabulary and its financial treatment

`lib/financial-data-hub/investment/transactionClassification.ts`'s `classifyAuStatementLine()` maps every one of the 14 `AU_STATEMENT_TRANSACTION_TYPES` to an `InvestmentFinancialTreatment` — a type union that has **no `'expense'` or `'ordinary_income'` member at all**:

| Statement type | Treatment |
|---|---|
| BUY, TRANSFER_IN, DRP | `investment_acquisition` |
| SELL | `investment_disposal` |
| DIVIDEND, DISTRIBUTION, INTEREST | `investment_income` |
| TRANSFER_IN/OUT (cash), CASH_DEPOSIT, CASH_WITHDRAWAL | `cash_transfer` |
| BROKERAGE, FEE | `trade_cost` (canonical treatment decided by II, spec section 32 — FDH-11 only supplies evidence) |
| CORPORATE_ACTION_EVIDENCE | `corporate_action_evidence` (never auto-applied, spec section 38) |
| OTHER, UNKNOWN | `unclassified` (routed to review) |

Every outcome carries `excludedFromOrdinaryExpenseIncome: true` — a literal value a future edit would have to consciously delete to add an expense/income branch, not something that could regress silently. This is proven, not merely asserted, by `tests/unit/fdh11AuInvestmentIntelligence.test.ts`'s spec-98/99/100/101 tests.

## The highest-risk rules, and how each is structurally guaranteed

- **Buy is not expense (26, 98).** `ii_transactions` is a completely separate ledger from `fdh_transactions` (the household expense/income ledger) — a BUY can only ever become an `ii_transactions` row via `applyAuStatementActivity.ts`, which has no code path that writes `fdh_transactions` at all.
- **Sale is not ordinary income (27, 99).** Same separation; a SELL becomes `ii_transactions.transaction_type = 'sale'`, never an `fdh_transactions` credit.
- **Bank→broker / broker→bank is a transfer (28-29, 100-101).** `CASH_DEPOSIT`/`CASH_WITHDRAWAL`/cash `TRANSFER_IN`/`TRANSFER_OUT` classify as `cash_transfer`, never `expense`/`income` — and even if a bank-side leg exists in `fdh_transactions`, FDH-11 never creates or edits an `fdh_transactions` row; it only *matches* an existing one via `bankMatching.ts` and links it as evidence.
- **Dividend double-count (30, 102).** `reconcileDividendIncome(brokerAmount, bankMatchedAmount)` always returns the broker-statement amount as the single investment-income figure regardless of whether a bank credit was also matched — `evidenceCount` (1 or 2) is tracked separately from the amount, so two pieces of evidence for one event can never become two events. Proven with a literal negative control: `Number('400') + Number('400') === 800` is asserted true (to prove the naive approach really would double-count) immediately before asserting the correct function never does.
- **DRP (31).** Classified as `investment_acquisition`, same as any other unit acquisition — no fabricated external cash movement is created.
- **Brokerage (32).** Classified as `trade_cost` — FDH-11 makes no claim about whether it becomes a cost-basis addition or a separate expense; that decision belongs to canonical II (not implemented there either — see Residuals).
- **Corporate actions (37-38).** `CORPORATE_ACTION_EVIDENCE` never resolves to an applicable canonical type in `applyAuStatementActivity.ts`'s `ACTIVITY_TO_CANONICAL_TYPE` map — attempting to apply one returns `CANONICAL_TYPE_UNSUPPORTED` and marks the row `skipped` with a stated reason, never silently inferred (e.g. "quantity doubled → stock split" is not a code path that exists anywhere in this module).

## Mapping to canonical `ii_transactions.transaction_type`

| AU statement type | Canonical type | Note |
|---|---|---|
| BUY | `purchase` | |
| SELL | `sale` | The R12-added equity/ETF disposal type, not `redemption` (MF-specific) |
| DIVIDEND | `dividend` | |
| DISTRIBUTION | `dividend` | **Disclosed gap**: no distinct `distribution` value exists in `ii_transactions.transaction_type` — nearest existing fit used, not a fabricated new value |
| DRP | `reinvestment` | |
| TRANSFER_IN / TRANSFER_OUT | `transfer_in` / `transfer_out` | Unit-transfer semantics, matching II's existing usage |
| BROKERAGE / FEE | `fee` | |
| INTEREST, CASH_DEPOSIT, CASH_WITHDRAWAL | *(none)* | **Disclosed II schema gap**: `ii_transactions.instrument_id` is `NOT NULL` — a pure broker-cash event with no associated security has no canonical row shape today. Captured as evidence, never force-applied against a fabricated instrument |
| CORPORATE_ACTION_EVIDENCE, OTHER, UNKNOWN | *(none)* | Always routed to review |

These gaps are Investment Intelligence gaps (not India-specific, not AU-specific in cause) — recorded here and in the completion report's residuals, not worked around with a parallel table.
