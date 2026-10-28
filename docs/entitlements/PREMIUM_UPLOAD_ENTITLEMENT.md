# Premium Upload Entitlement -- developer reference

Status: implemented on branch `feat/premium-upload-entitlement-20261014` (not merged; the programme report states the verdict wording
actually earned). Decision owner: Product Owner, 14-10-2026.

## The rule

| Capability | Free | Premium |
|---|---|---|
| Manual Add / Edit / Delete of income, expenses, assets, liabilities, investments, retirement, insurance, goals | Yes | Yes |
| Customer financial **file upload**, **statement import**, **automated extraction**, **reprocess/retry of a file**, **data connectors** (future Open Banking / CDR / Account Aggregator) | **No** | Yes |
| Viewing, correcting, approving, applying, deleting data that was already imported (including after a downgrade) | Yes | Yes |
| Admin / staff uploads (Resources, Benchmarks, Recommendations, Market Index Data, Risk-free rate, Promo/Premium administration) and scheduled system jobs | Governed by Admin capabilities, **never** by the consumer plan | |

Premium means exactly what the rest of the product means: `user_entitlements.plan_tier = 'premium'` inside its
`effective_from..effective_to` window (`effectivePlanTier`, `lib/services/entitlementWindow.ts`). Active, trialing and past_due
subscriptions are Premium; canceled / unpaid / incomplete are Free; admin grants and promo codes write the same row. A missing row,
an unknown tier, or a malformed row is Free. The importer holds no second interpretation of provider status, never writes
`plan_tier`, never calls Stripe or Razorpay, never reads a plan from the browser.

## The one capability

`lib/entitlements/financialDataImport.ts` (capability name `financial_data_import`; client-safe constants in
`financialDataImportContract.ts`):

| Function | Use |
|---|---|
| `refuseUnlessFinancialImportAllowed(userId, surface)` | **Admission routes.** Returns a `Response` to send back, or `null`. Call straight after authentication and **before the body is read**, a row is created, a credential is issued, a byte is stored, a job is queued or a provider is called. |
| `refuseUnlessImportRunMayStart(userId, surface, position)` | **Process / retry / detect / map / confirm routes** for an already-admitted document (they take an id, not a file). Implements the downgrade policy below. |
| `assertFinancialImportAllowed(userId, surface)` | **Service-layer admission boundary** (throws `FinancialImportDeniedError`). Used in `createUploadSession`, `completeUpload` (every FDH pipeline) and AIE `admitIntake` (`lib/aie/intakeAdmission.ts`, the guarded `createIntake`; kept out of the repository because that module reaches a client bundle through `lib/pc5/discard.ts`). |
| `resolveFinancialImportAccess`, `financialImportAccessView` | The decision / the three-state view the UI is drawn from (`allowed`, `premium_required`, `unavailable`). |

`userId` is always the **authenticated session user's id**. There is no parameter through which a client could supply a plan,
a price, a country or another user's id. There is no cache: an upgrade is usable on the next request, a downgrade stops the next
admission.

### Response contract

* Free / no row / expired / malformed: **HTTP 403** `{ error, code: 'PREMIUM_REQUIRED', data: { allowed: false, reason: 'PREMIUM_REQUIRED', upgrade_available: true, upgrade_path: '/profile' } }`. Never 404.
* Entitlement could not be read (database error): **HTTP 503** `{ code: 'ENTITLEMENT_UNAVAILABLE', ... upgrade_available: false }`. An outage is not shown as "please pay", and no file data is accepted.
* No billing internals (provider, status, price ids) ever appear in the body.

### Downgrade / in-flight policy

1. **New admission needs Premium now**: a file's bytes, an upload session, a document row, an AIE intake. A session created while Premium is **not** honoured after a downgrade (the byte-receiving step re-checks).
2. **Premium is stamped at admission**: the `document_upload_created` audit event records `import_entitlement: 'premium'`; a document row can exist only because every creation path passed the check.
3. **An admitted document keeps its lifecycle**: review, correct, approve, apply, delete, reopen and every privacy action stay available on Free. Its **first** processing run (`queued`; for II `uploaded` or `password_required`; for AIE `quarantined`) and a PDF password it is waiting for may still complete, as may the user's confirmation of an AI draft that already exists.
4. **A Free user cannot start NEW work**: re-queue a `failed` document (retry), force a re-parse (`forceReparse`), or process a document that is not theirs / does not exist.
5. Imported canonical data is never filtered by plan; provenance stays "Imported".
6. Raw-document purge is unchanged and independent of plan.

AI cost is a **separate** control owned by the AI-access programme (Premium AI entitlement at the AI fallback gate). Both layers apply; neither replaces the other.

## UI

* `GET /api/financial-data-hub/upload-status` now also returns `import_access` (`allowed | premium_required | unavailable`), the server's own reading; `useFinancialImportAccess()` draws from it. It authorises nothing.
* Free: manual Add stays primary and untouched; **Import** is a locked Premium link (`ImportLockedLink`: visible text "Premium" pill, accessible name states the lock, leads to the existing plan section `/profile?from=import-<domain>`); inside each panel the form is replaced by `ImportLockedNotice` (no file input, no document-type chooser, no upload button). While the plan is unknown a neutral "Checking your plan" state is drawn -- never an active picker.
* Wording (PO): "Statement and document import is available on Premium. You can continue to add and edit your financial information manually on the Free plan."
* The violet `ai` token is the Premium accent; no amber/caution styling.

## Rule for future work

Any new customer financial file upload, statement import, extraction/reprocess route or **data connector** (Open Banking / CDR / Account Aggregator) must
call the central capability **before** it reads the body, stores a byte, issues a credential, queues a job or calls a provider, and must be added to
`lib/entitlements/financialImportInventory.ts`. `tests/unit/premiumUploadInventoryContract.test.ts` fails the build otherwise (it scans `app/api` for ingestion
signals: multipart bodies, raw request bytes, signed upload credentials, direct storage writes, upload sessions, intakes, the fixture importer). Connectors and
automated sync are Premium unless the Product Owner explicitly changes the policy. Admin/reference-data uploads must use the Admin capability model and must **not** call the consumer capability (the same test enforces that).

## Inventory

<!-- BEGIN GENERATED INVENTORY MATRIX -->

**Counts:** 30 gated routes (14 admission, 16 run-start); 13 review/apply/delete routes deliberately NOT gated; 7 Admin/system route families exempt; 14 manual-entry route families that must stay Free.

### Gated routes (Free: refused 403 PREMIUM_REQUIRED, or 503 ENTITLEMENT_UNAVAILABLE; Premium: unchanged)

| # | Surface id | Guard | Route (POST) | Domain | UI caller | Storage / job | Downstream canonical destination |
|---|---|---|---|---|---|---|---|
| 1 | `fdh.upload_session.create` | Admission | `/api/financial-data-hub/documents/upload-sessions` | income | `components/income/PayslipImportPanel.tsx` | fdh_statement_uploads + fdh_upload_sessions rows; no credential issued | Income proposal via payslip review/apply |
| 2 | `fdh.upload_session.complete` | Admission | `/api/financial-data-hub/documents/upload-sessions/[sessionId]/complete` | income | `components/income/PayslipImportPanel.tsx` | private bucket fdh-source-documents | Income proposal via payslip review/apply |
| 3 | `fdh.bank_csv.upload` | Admission | `/api/financial-data-hub/bank-csv/upload` | expenses | `components/expenses/BankStatementImportPanel.tsx` | private bucket fdh-source-documents + fdh_statement_uploads | fdh_transactions -> approved Expenses actuals |
| 4 | `fdh.bank_pdf.upload` | Admission | `/api/financial-data-hub/bank-pdf/upload` | expenses | `components/expenses/BankStatementImportPanel.tsx` | private bucket fdh-source-documents + fdh_statement_uploads | fdh_transactions -> approved Expenses actuals |
| 5 | `fdh.liability_statement.upload` | Admission | `/api/financial-data-hub/liability-statement/upload` | liabilities | `components/liabilities/LiabilityImportPanel.tsx` | private bucket fdh-source-documents + fdh_statement_uploads | liability statement evidence -> liability proposal -> Liabilities |
| 6 | `fdh.investment_statement.upload` | Admission | `/api/financial-data-hub/investment-statement/upload` | investments | `components/investments/AuInvestmentStatementImportPanel.tsx` | private bucket fdh-source-documents + fdh_statement_uploads | Investment Intelligence canonical positions (publish/apply) |
| 7 | `fdh.retirement_statement.upload` | Admission | `/api/financial-data-hub/retirement-statement/upload` | retirement | `components/retirement/RetirementStatementImportPanel.tsx` | private bucket fdh-source-documents + fdh_statement_uploads | retirement statement evidence -> retirement account summary (apply) |
| 8 | `aie.intake.upload` | Admission | `/api/aie/intake` | fdh | API only (no UI caller) | AIE quarantine storage + aie_document_intake | none (diagnostic) |
| 9 | `aie.insurance.intake` | Admission | `/api/aie/insurance/intake` | insurance | API only (no UI caller) | AIE quarantine storage + aie_document_intake | insurance proposal via AIE review |
| 10 | `aie.fdh_bank.intake` | Admission | `/api/aie/fdh-bank/intake` | expenses | API only (no UI caller) | AIE quarantine storage + aie_document_intake | fdh_transactions via AIE review |
| 11 | `aie.investment_intelligence.intake` | Admission | `/api/aie/investment-intelligence/intake` | investments | API only (no UI caller) | AIE quarantine storage + aie_document_intake | Investment Intelligence via AIE review |
| 12 | `ii.source_document.upload` | Admission | `/api/investment-intelligence/source-documents` | investments | `components/investment-intelligence/InvestmentIntelligenceClient.tsx` | private bucket for II source documents + ii_source_documents | ii_transactions / holdings (publish) |
| 13 | `ii.source_document.replacement` | Admission | `/api/investment-intelligence/source-documents/[id]/replacement` | investments | `components/investment-intelligence/ReplacementCopyControl.tsx` | private bucket for II source documents + ii_source_documents | ii_transactions / holdings (publish), via the idempotent process route |
| 14 | `ii.source_document.parse_fixture` | Admission | `/api/investment-intelligence/source-documents/[id]/parse` | investments | API only (no UI caller) | ii_source_documents + canonical II tables | ii_transactions / holdings |
| 15 | `fdh.bank_csv.detect` | Run start | `/api/financial-data-hub/bank-csv/[documentId]/detect` | expenses | `components/expenses/BankStatementImportPanel.tsx` | reads private storage | bank CSV mapping |
| 16 | `fdh.bank_csv.map` | Run start | `/api/financial-data-hub/bank-csv/[documentId]/map` | expenses | `components/expenses/BankStatementImportPanel.tsx` | mapping row | bank CSV processing |
| 17 | `fdh.bank_csv.remap` | Run start | `/api/financial-data-hub/bank-csv/[documentId]/remap` | expenses | `components/expenses/BankStatementImportPanel.tsx` | removes unapproved lines and the statement job; reads private storage | bank CSV mapping, then processing |
| 18 | `fdh.bank_csv.process` | Run start | `/api/financial-data-hub/bank-csv/[documentId]/process` | expenses | `components/expenses/BankStatementImportPanel.tsx` | reads private storage; writes fdh_transactions | approved Expenses actuals |
| 19 | `fdh.bank_pdf.process` | Run start | `/api/financial-data-hub/bank-pdf/[documentId]/process` | expenses | `components/expenses/BankStatementImportPanel.tsx` | reads private storage; writes fdh_transactions | approved Expenses actuals |
| 20 | `fdh.bank_pdf.ai_fallback_confirm` | Run start | `/api/financial-data-hub/bank-pdf/[documentId]/ai-fallback/confirm` | expenses | `components/expenses/BankStatementImportPanel.tsx` | writes fdh_transactions | approved Expenses actuals |
| 21 | `fdh.payslip.process` | Run start | `/api/financial-data-hub/payslip/[documentId]/process` | income | `components/income/PayslipImportPanel.tsx` | reads private storage; writes payroll evidence | Income proposal |
| 22 | `fdh.payslip.ai_fallback_confirm` | Run start | `/api/financial-data-hub/payslip/[documentId]/ai-fallback/confirm` | income | `components/income/PayslipImportPanel.tsx` | writes payroll evidence | Income proposal |
| 23 | `fdh.liability_statement.process` | Run start | `/api/financial-data-hub/liability-statement/[documentId]/process` | liabilities | `components/liabilities/LiabilityImportPanel.tsx` | reads private storage; writes statement evidence | liability proposal |
| 24 | `fdh.liability_statement.ai_fallback_confirm` | Run start | `/api/financial-data-hub/liability-statement/[documentId]/ai-fallback/confirm` | liabilities | `components/liabilities/LiabilityImportPanel.tsx` | writes statement evidence | liability proposal |
| 25 | `fdh.investment_statement.process` | Run start | `/api/financial-data-hub/investment-statement/[documentId]/process` | investments | `components/investments/AuInvestmentStatementImportPanel.tsx` | reads private storage; writes statement evidence | Investment Intelligence |
| 26 | `fdh.investment_statement.ai_fallback_confirm` | Run start | `/api/financial-data-hub/investment-statement/[documentId]/ai-fallback/confirm` | investments | `components/investments/AuInvestmentStatementImportPanel.tsx` | writes statement evidence | Investment Intelligence |
| 27 | `fdh.retirement_statement.process` | Run start | `/api/financial-data-hub/retirement-statement/[documentId]/process` | retirement | `components/retirement/RetirementStatementImportPanel.tsx` | reads private storage; writes statement evidence | retirement summary (apply) |
| 28 | `fdh.retirement_statement.ai_fallback_confirm` | Run start | `/api/financial-data-hub/retirement-statement/[documentId]/ai-fallback/confirm` | retirement | `components/retirement/RetirementStatementImportPanel.tsx` | writes statement evidence | retirement summary (apply) |
| 29 | `aie.investment_intelligence.process` | Run start | `/api/aie/investment-intelligence/intake/[intakeId]/process` | investments | API only (no UI caller) | reads AIE storage; writes extraction run | Investment Intelligence via AIE review |
| 30 | `ii.source_document.process` | Run start | `/api/investment-intelligence/source-documents/[id]/process` | investments | `components/investment-intelligence/InvestmentIntelligenceClient.tsx` | reads private storage; writes parse run + canonical II tables | ii_transactions / holdings (publish) |

### Deliberately NOT gated: review / correct / approve / apply / delete (downgrade must not strand data; privacy is never Premium)

| Route | Why |
|---|---|
| `/api/financial-data-hub/documents/[documentId]/approve` | approve an already-admitted document (review lifecycle) |
| `/api/financial-data-hub/documents/[documentId]/reopen` | reopen review of an already-admitted document |
| `/api/financial-data-hub/payslip/[documentId]/approve` | approve admitted payslip evidence |
| `/api/financial-data-hub/payslip/[documentId]/correct` | correct admitted payslip evidence |
| `/api/financial-data-hub/payslip/[documentId]/proposal` | derive the proposal from admitted evidence |
| `/api/financial-data-hub/income-proposals/[proposalId]/apply` | apply a proposal that only exists because an admitted run produced it |
| `/api/financial-data-hub/liability-proposals/[proposalId]/apply` | apply a proposal that only exists because an admitted run produced it |
| `/api/financial-data-hub/investment-statement/[documentId]/apply` | apply admitted evidence |
| `/api/financial-data-hub/retirement-statement/[documentId]/apply` | apply admitted evidence |
| `/api/financial-data-hub/bank-transactions/[transactionId]/approve` | approve admitted transactions |
| `/api/aie/review/runs/[runId]/accept` | accept an admitted AIE run after review |
| `/api/investment-intelligence/ai-extraction-reviews/[reviewId]/accept` | accept an admitted AI reading after review |
| `/api/investment-intelligence/source-documents/[id]/discard` | delete an admitted document (privacy / cleanup is never Premium) |

### Exempt: Admin staff and system jobs (governed by Admin capabilities / shared secrets, never by the consumer plan)

| Route family | Why |
|---|---|
| `/api/admin/` | Admin staff: governed by requireAdmin() and the per-capability guards (Resources, Benchmarks, Recommendations, Market Index Data, Risk-free rate, Promo/Premium administration). |
| `/api/aie/cron/` | Scheduled system job (shared-secret authenticated), not a customer. |
| `/api/financial-data-hub/documents/cron/` | Scheduled system job (shared-secret authenticated), not a customer. |
| `/api/investment-intelligence/cron/` | Scheduled system job (shared-secret authenticated), not a customer. |
| `/api/reports/cron/` | Scheduled system job (shared-secret authenticated), not a customer. |
| `/api/premium/cron/` | Scheduled system job (shared-secret authenticated), not a customer. |
| `/api/payments/` | Billing: checkout and verified provider webhooks. These WRITE entitlement state; they never read the import capability. |

### Manual entry (must stay Free; must never call the import capability)

`/api/income`, `/api/expenses`, `/api/assets`, `/api/liabilities`, `/api/investments`, `/api/retirement`, `/api/insurance`, `/api/goals`, `/api/smsf`, `/api/commitments`, `/api/business-entities`, `/api/household`, `/api/household-members`, `/api/investment-intelligence/positions/manual`

<!-- END GENERATED INVENTORY MATRIX -->

## Known limits (honest)

* A user can still create an empty `fdh_statement_uploads` / `aie_document_intake` / `ii_source_documents` **row** by calling PostgREST directly with their own JWT, because those tables carry a self-insert RLS policy. Such a row has **no stored bytes** (the storage bucket policies are SELECT-only for `authenticated`; every write goes through the service role after the route checks), so nothing can be parsed, queued or sent to a provider from it. Closing it at the database (an insert policy requiring Premium) is a possible follow-up and is **not** part of this change.
* Client-side lock-impression / upgrade-click analytics are **not** implemented: the codebase has no analytics sink. The server records privacy-safe decision events (`import_admission_denied_free`, `import_entitlement_unavailable`: surface and code only).
* Insurance has no customer upload UI on main (manual entry only); its AIE intake API is gated. Marked *not active* rather than a pass.
