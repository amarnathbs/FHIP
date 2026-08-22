# FDH-1 — Domain Model

---

## 1. Canonical TypeScript contracts

All in `lib/financial-data-hub/domain/types.ts`. Field names match the database
columns exactly, so a row read through Supabase is already a valid domain object
and there is no mapping layer to drift out of step.

| Interface | Table |
| --- | --- |
| `FdhSourceTypeRow` | `fdh_source_types` |
| `FdhFinancialInstitution` | `fdh_financial_institutions` |
| `FdhCategory` | `fdh_categories` |
| `FdhSubcategory` | `fdh_subcategories` |
| `FdhMerchant` | `fdh_merchants` |
| `FdhMerchantAlias` | `fdh_merchant_aliases` |
| `FdhClassificationRule` | `fdh_classification_rules` |
| `FdhParserRegistry` | `fdh_parser_registry` |
| `FdhParserVersion` | `fdh_parser_versions` |
| `FdhFinancialAccount` | `fdh_financial_accounts` |
| `FdhStatementUpload` | `fdh_statement_uploads` |
| `FdhIngestionJob` | `fdh_ingestion_jobs` |
| `FdhTransaction` | `fdh_transactions` |
| `FdhTransactionAllocation` | `fdh_transaction_allocations` |
| `FdhTransactionLink` | `fdh_transaction_links` |
| `FdhDuplicateCandidate` | `fdh_duplicate_candidates` |
| `FdhUserClassificationRule` | `fdh_user_classification_rules` |
| `FdhClassificationHistory` | `fdh_classification_history` |
| `FdhRecurringTransaction` | `fdh_recurring_transactions` |
| `FdhReviewItem` (+ `FdhReviewItemContext`) | `fdh_review_items` |
| `FdhReconciliationResult` | `fdh_reconciliation_results` |
| `FdhDataQualityResult` | `fdh_data_quality_results` |
| `FdhDataProvenance` | `fdh_data_provenance` |
| `FdhEvidenceLink` | `fdh_evidence_links` |

Supporting types: `FdhOwnership`, `FdhRuleMatchDefinition`,
`FdhRuleActionDefinition`, `CurrencyCode`, `IsoDate`, `IsoTimestamp`,
`UnitInterval`.

## 2. Specification `UPPER_CASE` → stored `snake_case`

The FDH-1 specification names enum values in `UPPER_CASE`. The database and
TypeScript store lowercase `snake_case`, matching all 77 pre-existing tables —
there is no uppercase enum value anywhere in migrations `0001`–`0030`, and no
`create type … as enum` either. The mapping is mechanical and 1:1:

| Spec form | Stored form |
| --- | --- |
| `BANK`, `CREDIT_CARD_ISSUER`, `LENDER`, `BROKER`, `INVESTMENT_PLATFORM`, `DEPOSITORY`, `MUTUAL_FUND_PLATFORM`, `SUPER_FUND`, `RETIREMENT_PROVIDER`, `PAYROLL_SOURCE`, `OTHER` | `bank`, `credit_card_issuer`, `lender`, `broker`, `investment_platform`, `depository`, `mutual_fund_platform`, `super_fund`, `retirement_provider`, `payroll_source`, `other` |
| `CSV`, `PDF_NATIVE`, `PDF_SCANNED`, `XLSX`, `MANUAL_MAPPING`, `CDR`, `ACCOUNT_AGGREGATOR`, `API`, `OTHER` | `csv`, `pdf_native`, `pdf_scanned`, `xlsx`, `manual_mapping`, `cdr`, `account_aggregator`, `api`, `other` |
| `TRANSACTION`, `SAVINGS`, `TERM_DEPOSIT`, `CREDIT_CARD`, `HOME_LOAN`, `PERSONAL_LOAN`, `VEHICLE_LOAN`, `BROKERAGE_SOURCE`, `SUPER_SOURCE`, `EPF_SOURCE`, `NPS_SOURCE`, `OTHER` | `transaction`, `savings`, `term_deposit`, `credit_card`, `home_loan`, `personal_loan`, `vehicle_loan`, `brokerage_source`, `super_source`, `epf_source`, `nps_source`, `other` |
| `CREATED` → `PURGED` (13 document states) | `created` … `purged` |
| `DOCUMENT_VALIDATE` … `PRIVACY_PURGE` (9 job types) | `document_validate` … `privacy_purge` |
| `INCOME`, `EXPENSE`, `TRANSFER`, `INVESTMENT`, `DEBT_PRINCIPAL`, `DEBT_INTEREST`, `REFUND`, `ASSET_PURCHASE`, `ASSET_SALE`, `TAX`, `FEE`, `CASH_WITHDRAWAL`, `UNKNOWN` | `income` … `unknown` |
| `INTERNAL_TRANSFER` … `OTHER` (8 link types) | `internal_transfer` … `other` |
| `PENDING`, `CONFIRMED_DUPLICATE`, `NOT_DUPLICATE`, `AUTO_CONFIRMED` | `pending`, `confirmed_duplicate`, `not_duplicate`, `auto_confirmed` |
| `LOW_EXTRACTION_CONFIDENCE` … `OTHER` (10 review types) | `low_extraction_confidence` … `other` |
| `NOT_AVAILABLE`, `PENDING`, `RECONCILED`, `FAILED`, `USER_ACCEPTED_EXCEPTION` | `not_available`, `pending`, `reconciled`, `failed`, `user_accepted_exception` |
| `STATEMENT_PERIOD_FOUND` … `CURRENCY_AMBIGUITY` (9 quality checks) | `statement_period_found` … `currency_ambiguity` |
| `DEVELOPMENT`, `CERTIFIED`, `DEPRECATED`, `DISABLED` | `development`, `certified`, `deprecated`, `disabled` |
| `UNSUPPORTED_FILE_TYPE` … `INTERNAL_ERROR` (14 error codes) | `unsupported_file_type` … `internal_error` |
| `NOT_REQUIRED`, `PENDING`, `IN_PROGRESS`, `PURGED`, `FAILED`, `LEGAL_HOLD` | `not_required`, `pending`, `in_progress`, `purged`, `failed`, `legal_hold` |
| `WEEKLY`, `FORTNIGHTLY`, `MONTHLY`, `QUARTERLY`, `ANNUAL`, `IRREGULAR` | `weekly`, `fortnightly`, `monthly`, `quarterly`, `annual`, `irregular` |
| `PROPOSED`, `ADMIN_REVIEW`, `APPROVED`, `REJECTED`, `MERGED` | `proposed`, `admin_review`, `approved`, `rejected`, `merged` |
| `SOURCE`, `MERCHANT_MASTER`, `GLOBAL_RULE`, `USER_RULE`, `AI`, `USER_MANUAL`, `ADMIN_MASTER_DATA` | `source`, `merchant_master`, `global_rule`, `user_rule`, `ai`, `user_manual`, `admin_master_data` |

`tests/unit/fdh1SchemaContract.test.ts` asserts the TypeScript arrays and the
SQL check constraints hold identical sets, and that every stored value is
lowercase snake_case.

## 3. Direction is not meaning

The single most important modelling rule in FDH.

```ts
credit_debit:               'credit' | 'debit'          // where the money went
economic_transaction_type:  'income' | 'expense' | ...  // what it meant
```

These are **two independent columns**. Nothing in the schema, the validation
layer, the domain layer or the repository layer derives one from the other, and
`tests/unit/fdh1Domain.test.ts` asserts every one of the 13 economic types is
accepted in **both** directions.

The reason is not theoretical. On real statements:

| Direction | Economic meaning it can carry |
| --- | --- |
| credit | `income` (salary), `refund` (returned purchase), `transfer` (money in from another own account), `asset_sale`, `debt_principal` (loan drawdown), `fee` (a fee reversal) |
| debit | `expense`, `transfer` (money out), `investment` (SIP instalment), `debt_principal` + `debt_interest` (loan repayment), `tax`, `cash_withdrawal`, `asset_purchase` |

Any code that assumes `CREDIT = income` would misclassify a credit-card
settlement, an internal transfer, a refund and a loan drawdown on day one.

### Sign convention

`amount_original` is a **strictly positive magnitude** (`check > 0`). The signed
economic value is derived in exactly one place:

```ts
toSignedAmount(180.50, 'debit')  // -180.50
toSignedAmount(180.50, 'credit') //  180.50
```

Storing a signed amount *and* a direction column would permit two contradictory
encodings of the same fact, and the reconciliation engine would eventually meet
both.

## 4. Taxonomy recommendations — documented, NOT applied

The specification asks that any candidate addition to the economic taxonomy be
raised as a recommendation with rationale rather than silently added.
Architectural review surfaced two. **Neither has been added.** The approved
13-value taxonomy is retained unchanged in FDH-1.

### R-1 — `liability_settlement`

*Observation.* A credit-card statement's monthly settlement debit on the linked
transaction account is currently modelled as `transfer` plus a
`credit_card_settlement` row in `fdh_transaction_links`. That works, but it
means the same value carries "transfer" semantics while economically closing a
liability.

*Why it was not added.* The link type already carries the distinction, so
adding the enum value would be redundant modelling rather than new information —
and it would create genuine ambiguity for a classifier deciding between
`transfer`, `debt_principal` and `liability_settlement` for the same row.

*Recommendation.* Revisit at **FDH-10 (Credit Cards & Loans)**, when there is
real settlement data to test against. If adopted then, it is a semantic change
and needs Product Owner approval, not a technical decomposition.

### R-2 — `retirement_contribution`

*Observation.* An Australian salary-sacrifice debit or an Indian EPF/NPS
contribution is currently `investment`. That loses the tax-treatment
distinction, which matters for both countries.

*Why it was not added.* `fdh_categories.tax_reporting_flag` plus a category key
already carry the distinction without touching the taxonomy, and FDH-2 owns the
category library where this properly belongs.

*Recommendation.* Revisit at **FDH-12 (Retirement Intelligence)**. Prefer
solving it in the category master unless FDH-12 finds a case the category layer
genuinely cannot express.

## 5. Confidence: three structurally distinct dimensions

There is deliberately **no single universal confidence number**.

| Dimension | Column | Question it answers |
| --- | --- | --- |
| Extraction confidence | `fdh_transactions.extraction_confidence` | Did we read the document correctly? |
| Classification confidence | `fdh_transactions.classification_confidence` | Did we categorise it correctly? |
| Evidence completeness | `fdh_data_provenance.evidence_completeness` | How completely is this derived fact supported? |

**Reconciliation is a STATE, not a fourth confidence.** It lives in
`fdh_reconciliation_results.status` and `fdh_statement_uploads.reconciliation_status`,
because "the statement balanced" is a yes/no/exception fact, not a degree of
belief.

All three confidences are `numeric(5,4)` over the closed range `[0.0000, 1.0000]`,
in the database and in the domain. UI rendering as a percentage is a
presentation concern. **FDH-1 implements no scoring algorithm for any of them.**

### Evidence completeness and payslips

The specification's worked example — a bank salary credit alone being roughly
half the evidence of a payslip plus a reconciled bank credit — is representable
**without any of those numbers being hardcoded**:

```
fdh_data_provenance (entity = the derived "monthly salary" fact,
                     evidence_completeness = <stored, not computed>)
   ├── fdh_evidence_links (evidence_type = 'bank_transaction',
   │                       evidence_transaction_id = …)
   └── fdh_evidence_links (evidence_type = 'payslip_document',
                           evidence_statement_upload_id = …)
```

FDH-1 provides the structure and stores whatever number a later phase computes.
There is no `0.5`, no `1.0` and no scoring rule anywhere in the code. Payslip
extraction is **FDH-9**.

## 6. Runtime validation

Zod, the library already established across `lib/validation/**` (17 schema
files). No second validation framework was introduced.

| Module | Covers |
| --- | --- |
| `validation/primitives.ts` | country, currency, date, timestamp, uuid, unit interval, money magnitude, FX rate, masked identifier, machine key, MCC, country applicability, date ordering |
| `validation/filename.ts` | original filename — rejects path separators, traversal and control characters |
| `validation/accounts.ts` | institutions, financial accounts |
| `validation/documents.ts` | statement uploads, patches, **document and purge state transitions**, ingestion jobs |
| `validation/transactions.ts` | transactions, allocations, links, duplicates, recurring patterns |
| `validation/review.ts` | review items (closed context shape), reconciliation, data quality, provenance, evidence |
| `validation/classification.ts` | global rules, user rules, classification history |
| `validation/masterData.ts` | categories, subcategories, merchants, aliases, parsers, parser versions |

Notable properties, each covered by a test:

* **`user_id` is never accepted from a caller.** Repositories inject it from the
  authenticated session, as `makeRegistry` does. Accepting it would create the
  tenant-spoofing hole RLS `with check` exists to close.
* **State transitions are validated, not just vocabularies.** `fdhDocumentTransitionSchema`
  rejects `queued → approved` and requires a controlled error code on any move
  to `failed`.
* **Amounts carrying more than four decimal places are rejected**, not silently
  truncated.
* **An FX rate with no date is rejected** — this is the exact gap FDH-0 recorded
  in the existing platform (one global rate, no date). FDH does not repeat it.
* **Rule definitions are a discriminated union over a closed vocabulary** with
  no `regex`, `expression` or `sql` member.
* **A `user_manual` classification change cannot be attributed to the system**,
  and a `user_rule` change must name the rule that caused it.
* **A reconciliation cannot be recorded as `reconciled` outside its stated
  tolerance.**

## 7. Repository / service boundary

`repositories/base.ts` provides two factories:

* `makeUserOwnedRepository<TRow, TInsert>(table)` — list / get / create /
  update / remove, all scoped to `user_id`, which is injected from the session
  and **stripped from any update patch** so a row can never be re-parented.
* `makeMasterDataRepository<TRow>(table)` — read only. **There is no write
  method**, so no user request path can reach for one.

`fdh_source_types` and `fdh_parser_versions` get bespoke readers because their
shapes genuinely differ (a text primary key; a four-state `status` rather than
an `active` flag) — bending them into the generic factory would have been the
premature abstraction.

`fdh_classification_history` is exported as `{ listForUser, getForUser, append }`.
The generic `update` and `remove` are removed from the surface because the
database would refuse them anyway; no caller can even reach for them.

`services/index.ts` is deliberately small — FDH-1 has few decisions to make —
and is split by bounded context rather than collected into one
`financialDataService.ts`.
