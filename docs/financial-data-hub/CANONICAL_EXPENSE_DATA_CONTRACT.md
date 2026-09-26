# CANONICAL_EXPENSE_DATA_CONTRACT

Status: in force from WP-02 (branch `feature/canonical-upload-foundation`). Implementation: `lib/read-models/expenses.ts` (`selectExpenses`, `computeExpenses`), with the shared rules in `lib/read-models/core/spendingRules.ts`, `core/ledger.ts`, `core/coverage.ts`, `core/window.ts`, `core/currency.ts` and `core/categoryGroups.ts`. Oracle tests: `tests/unit/readModels/expensesOracle.test.ts`.

PO decisions applied: D-01 (refunds), D-02 (planned vs actual), D-03 (cash), D-08 (card debt service), D-09 (loan cost of debt), D-10 (owners). They are recorded in the programme's `PO_DECISIONS.md` and summarised below.

## 1. The model in one paragraph

`expense_items` is the household's **planned** (recurring, assumed) spending, entered by hand. Approved `fdh_transactions`, with their allocations and links, are **actual** (historical, imported) spending. **Nothing is ever copied from one to the other.** One read model, `selectExpenses`, is the only definition of spending. It returns planned, actual and a **combined** figure, and every consumer chooses one basis on purpose. Planned and actual are never added together for the same category.

## 2. Vocabulary

| Term | Meaning | Where it comes from |
|---|---|---|
| **Planned** | A recurring expense the user expects. Normalised to a monthly amount with `toMonthly(amount, frequency)`. | `expense_items` (active rows). |
| **Recurring** | Same as planned. A detected recurring series (`fdh_recurring_transactions`) is evidence only and never becomes a planned row by itself; WP-15 proposes an update the user Applies. | `expense_items.frequency`. |
| **Actual** | Money that really left the household, as shown on an approved statement. | Approved `fdh_transactions` / allocations. |
| **Historical** | Actual activity in a *past, complete* month. Only complete months that an approved statement fully covers are averaged (section 4). | `fdh_transactions.transaction_date` + statement coverage. |
| **Pending** | An imported line not yet approved. Effect on every figure: **0**. It is counted in `actual.unknownPendingCount` so the user can see that it is waiting. | `fdh_transactions.approval_status = 'pending'`. |
| **Approved** | A line the user approved through the statement review. The only kind that counts. | `approval_status = 'approved'`. |
| **Refund** | Money returned for a purchase. It reduces spending **only** when a **confirmed** `refund_original` / `reversal_original` link names the purchase (D-01, the certified FDH-7 rule). Otherwise it is shown as an unlinked refund. It is never income. | `economic_transaction_type = 'refund'` + `fdh_transaction_links`. |
| **Transfer** | Money moving between the household's own accounts, including a credit-card or loan repayment from a bank account. Never spending, never income. A bank leg with a confirmed `credit_card_settlement` / `loan_payment` link to a card/loan facility line, or a confirmed `internal_transfer` link, is a transfer whatever it was typed. | `transfer` + links. |
| **Cost of debt** | Interest and fees charged on a card or loan **facility account**. Shown in the Expenses UI as "Cost of debt (interest and fees inside card/loan repayments)", and counted **once**, through liability debt service (D-09), never also as spending. Interest or fees on an ordinary bank account with no facility stay spending. | `debt_interest` / `fee` on an account whose `account_type` is a card/loan type or that has `liability_id` (0207). |
| **Debt principal** | Repayment of a loan's balance. Not an expense; part of debt service. | `debt_principal`. |
| **Investment transfer** | Money moved into an investment (`investment`), or asset purchases / sales. Spending 0, income 0. A bank leg that approved broker evidence corroborates is re-bucketed: BUY funding becomes `investment`, SELL proceeds become `asset_sale`. | `investment`, `asset_purchase`, `asset_sale`, broker activities. |
| **Cash withdrawal** | Cash taken out. What it was spent on is unknown, so it is not spending. Shown as "Cash — spending unknown" (D-03). | `cash_withdrawal`. |
| **Unknown** | A line (or split part) not classified yet. Never counted, never guessed. | `unknown`. |

Every `economic_transaction_type` value maps to exactly one bucket (`ECONOMIC_TYPE_BUCKET`, compile-time exhaustive). The mapping is also recorded in the field-disposition registry (`lib/canonical-data/disposition/economicTransactionType.ts`), and a test fails if the two disagree.

## 3. Inclusion rules for actuals

1. `approval_status = 'approved'` only.
2. `dedup_status` of `duplicate_confirmed` or `user_confirmed_duplicate` never counts (for a `removed_b` resolution, side b). The count is reported in `actual.excludedDuplicates`.
3. A split transaction counts only through its allocations. The allocations must add up to the parent exactly (to 4 decimal places); if they do not, the result is `unavailable` (reason `invalid_split`). An allocation typed `unknown` is never counted.
4. Card and loan facility rules: purchases on the card are spending; the card's payment credit is a transfer; interest and fees on the facility are cost of debt; a cash advance is cash. Card purchases of $200 and $20 with a $220 repayment give spending of **$220**.
5. Loan payment of $2,000 made up of principal $1,550, interest $430 and fee $20: spending 0, cost of debt **$450**, principal $1,550, debt service **$2,000**, cash outflow **$2,000**.
6. Owner (D-10): lines on an account whose `owner_role` is `smsf` belong to the fund and are left out of household spending (`actual.excludedNonHouseholdCount`). A joint account counts in full. An account with no owner recorded counts as household, which is the existing fail-safe.
7. Currency: every line keeps its own amount and currency, and is converted once with the single AUD/INR rate. A currency the app does not support (for example USD) is **never** added as if it were the reporting currency. It is left out and reported in `actual.unconverted`.
8. Categories: FDH-2 categories are mapped to a coarse group (`housing, utilities, food, transport, health, education, lifestyle, shopping, travel, fees, insurance, tax, family, charity, other`). `expense_items.master_item_key` is mapped to the same groups. A line is **essential** only when its subcategory, or else its category, is marked `essential`.

## 4. Time window and averaging (DC-01)

* The default window is the **three complete calendar months** before "today", in the household's timezone (AU is Australia/Sydney, IN is Asia/Kolkata). The current, unfinished month is never used on its own. The old Dashboard rule counted only the current UTC month, so a statement for last month counted $0.
* A month counts as **covered** for an account only when that account's approved statements, taken together, include every day of the month. The statement period comes from `fdh_statement_uploads.statement_period_*`. If a statement has no period, the earliest and latest approved transaction dates are used instead, which can only under-count coverage.
* **Averaging is per account.** For each account, spending in its covered months is divided by the number of months that account covers. The household figure is the sum across accounts. Lines in months that are only partly covered are still shown (`actual.partialLineCount`, `actual.totalInWindow`), but they are not averaged.

## 5. The three bases

| Basis | Definition | Field |
|---|---|---|
| planned | Sum of the monthly amounts of active `expense_items`. Rows marked `superseded_by_bank_import`, SMSF-owned rows, rows that duplicate a liability's own repayment (`isDuplicateDebtServiceExpense`) and rows in unsupported currencies are left out, and each carries its reason. | `planned.*` |
| actual | Average monthly spending over covered months (section 4), after refunds are netted. | `actual.*` |
| combined | For each group: the **actual** average if the group has actual lines in a covered month, otherwise the **plan**. Planned and actual are never added for the same group. The actual-minus-planned difference is returned for display as `varianceMonthly`. | `combined.*` |

`selected` is a shortcut to the basis the caller asked for. Planned rows only change when the user **Applies** the "update planned from actual averages" proposal (WP-15). The read model never writes.

Oracle, Household M vs Household I: planned groceries of $800 a month and covered actual groceries of $800 a month give the same combined total, $800.

## 6. Which consumer uses which basis

| Consumer | Basis | Owner WP |
|---|---|---|
| Expenses tab: planned grid | planned (unchanged) | — |
| Expenses tab: "Actual (imported)" section, provenance label, statement link, variance per group | actual, and combined `varianceMonthly` | WP-07 |
| Dashboard: monthly expenses, surplus, savings rate, `hasExpenses`, essential / lifestyle, top expenses, emergency-fund months | combined | WP-03 |
| Health Score, Financial DNA, Resilience, Goals affordability, Recommendations, AI context, section status | combined, from one `buildCanonicalFinancialSnapshot` per request | WP-04 |
| Financial Twin / benchmark: expense ratio, housing and remittance by group | combined | WP-05 |
| Forecast: forward projection | planned | WP-05 |
| Forecast: variance and calibration display | actual | WP-05 |
| Resilience / retirement essentials baseline | combined `essentialMonthly` | WP-05 |
| Reports: calculations | combined | WP-06 |
| Reports: appendix | planned **and** actual lines, each with provenance | WP-06 |
| FDH Activity, Category review | actual, using the same `spendingRules` (no mirrored constants) | WP-08 |
| `financial_snapshots.monthly_expenses` | combined, over complete covered months | WP-03 |
| Debt service (surplus, DSR, cash outflow) | `selectLiabilities`, never the expense figure (section 7) | WP-03 |

## 7. Coupling with debt service (`selectLiabilities`)

* A loan with facility-ledger events in covered months: debt service is the **actual** principal plus interest plus fee. This **replaces** the contractual `monthly_repayment` and is never added to it (D-09).
* A revolving facility (credit card, line of credit, BNPL): its purchases are already counted as spending, so its minimum payment or `monthly_repayment` is **not** counted again (D-08). The same rule applies to manual households (M) and imported households (I). Only actual interest and fees count, and only when they have been imported. The rule is a named parameter (`cardRepaymentRule: 'exclude_revolving' | 'include'`); `include` is the pre-programme rule.
* D-08's premise is "consumption counted as expense". When a household has **no** counted consumption at all (no ordinary planned expense line and no covered imported spending), the card repayment is the only record of that outflow, so it is counted once (`householdDebtServiceUnderD08`, WP-03). Without this, a card entered with an $800 repayment and no expenses would count $0 of outflow.
* Interest and fees on a facility account not yet linked to a liability are counted in `unlinkedFacility`, so they are never lost between the two figures.

Surplus = income − combined expenses − household debt service.

## 8. Failure contract

Any failed read, whether a query error, an unreconciled split or a missing FX context, returns `{ status: 'unavailable', reason, source }` and never zeros. A missing value is `null`, never 0. A database without migration 0207 still works: owner attribution is reported as unavailable (`actual.ownerAttributionAvailable = false`) instead of failing every read.
