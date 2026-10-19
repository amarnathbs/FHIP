# 2. Document classes, active routes, formats, and the implementation gaps

Read from the code on `origin/main` (22db19b) and its upload screens. "Active route" means: a screen a customer can reach, calling a route
that runs the AI step. "Deferred" means the code exists but no customer screen uses it and its flags stay unset.

## 1. The matrix

| # | Class (what the person calls it) | Screen | File types the screen accepts | Active AI route | What triggers the AI step | Evidence format for the proof |
|---|---|---|---|---|---|---|
| 1 | **Bank statement** | Expenses, Import | PDF **and** CSV | **PDF only**: `bank-pdf/upload`, then `bank-pdf/[id]/process`, review, `bank-pdf/[id]/ai-fallback/confirm`. The bank **CSV** route (`bank-csv/*`) has **no AI step at all** | the PDF text was extracted but no certified layout matched (`unsupported_layout`, `ambiguous_layout`, `extraction_low_confidence`) | **PDF** (document scan) |
| 2 | **Payslip** | Income, payslip import | PDF only | `documents/upload-sessions` (+ `complete`), then `payslip/[id]/process`, review, `payslip/[id]/ai-fallback/confirm` | the parser found neither gross nor net pay (`layout_unsupported`, `country_not_identified`) | **PDF** |
| 3 | **Liability (card, loan) statement** | Liabilities | **CSV only** | `liability-statement/upload`, `.../[id]/process`, review, confirm | no known CSV layout (`manual_mapping_required`, `ambiguous_format`, `layout_unsupported`) | **CSV** (structured file). Cannot stand in for PDF evidence |
| 4 | **Retirement statement** | Retirement | **CSV only** | `retirement-statement/upload`, `.../process`, review, confirm | same three kinds | **CSV** |
| 5 | **Australian investment statement** | Investments | **CSV only** | `investment-statement/upload`, `.../process`, review, confirm | `layout_unsupported` | **CSV** |
| 6 | **Investment Intelligence statement** (India CAS and other fund or broker statements) | Investment Intelligence | **PDF only** | `investment-intelligence/source-documents`, parse, `ai-extraction-reviews/[id]` accept or reject | the parser registry cannot identify the document (`format_unrecognized`) or its own validation rejects the result (`parse_failed`) | **PDF**. The II route also accepts CSV text server-side, but no screen sends it |

Every upload, retry and re-process of every row is Premium-only through the one shared capability (`financial_data_import`), and the AI step then
re-checks Premium (`premium_ai_access`), so a plan that ends between upload and first processing run is refused at the AI step.

## 2. Formats: which evidence proves what

* **PDF rows (1, 2, 6)** exercise the document-scanning path: upload, a copy of the exact bytes sent to the scan bucket, the real malware verdict
  bound to that stored object, PDF text extraction, masking, the model. **A CSV run is never evidence for any of this.**
* **CSV rows (3, 4, 5)** exercise the structured-file path with the same scan and the same AI machinery on decoded text. Their evidence stays in
  its own column of the report.
* The bank CSV route has no AI step; a bank CSV test would prove only the deterministic importer and is not part of this proof.
* **Scanned images and image-only PDFs have no AI route.** A PDF with no text layer ends `image_only`: no OCR exists, the AI step is deliberately
  not attempted (it would only invite invention). That is a documented limitation, not a defect.

## 3. IMPLEMENTATION GAPS (required class, no active route)

| Gap | Detail | Decision |
|---|---|---|
| **G-1: PDF statements for liability, retirement and Australian investment** | A person's card, super or broker statement is normally a PDF. The three screens accept CSV only, and the services refuse a PDF with `pdf_manual_mapping_required` and the on-screen words "PDF broker statements are not yet supported for automatic reading ... try a CSV export". So for these three classes there is **no active route that scans and AI-reads a PDF**, and PDF malware-scan evidence for them cannot exist | **REPORTED, NOT IMPLEMENTED.** Implementing it would reverse an explicit product statement shown to users, add PDF intake to three screens and three services, and needs an accuracy corpus for real PDF layouts that does not exist. It is also new extraction behaviour for member numbers and tax identifiers, not a wiring fix. It needs your product decision first. The adapters already take masked text, so the work is intake and screens, not the model step |
| **G-2: image or scanned statements (any class)** | no OCR | Documented limitation, see section 2 |
| **G-3: bank CSV** | no AI step by design | Not a gap: the deterministic importer reads supported bank CSVs |

## 4. Present in the repository but deferred (kept off on purpose)

| Item | Status |
|---|---|
| `POST /api/aie/intake`, `.../fdh-bank/intake`, `.../insurance/intake`, `.../investment-intelligence/intake` (+ `.../process`) and the `/aie-review` inbox | No screen calls them (`lib/canonical-data/disposition/insurance.ts` lists them `not_active`). They carry the Premium check instead of the old cohort, but also need `AIE_DOCUMENT_INTAKE_ENABLED` and adapter flags that must stay **unset** |
| Insurance AI adapter | No customer screen |
| `aiFallbackReconciliation.ts` (II reconciliation by AI) | Inert: its provider resolver returns nothing |
| Factsheet benchmark reader AI | Admin data ingestion with its own flag `FACTSHEET_READER_AI_ENABLED`, not forwarded, not metered by the cost ledger; not a customer feature |
| Insight Pack batch, AI Coach, Next Best Action, Module 11 scheduler | Module 11, see `module11/README.md` |
| Admin AI operations, market-data ingestion crons | Own permissions, untouched |

## 5. Boundaries that still hold on current `main` (UNIT-TESTED, 427 tests in the Premium suites pass)

* Customer financial upload, import, retry and re-process automation: **Premium only**, through the single shared capability. No competing check was added.
* **Manual entry stays available to Free and Premium** (the contract test scans the manual-entry route directories and fails if one calls the capability).
* **Admin operations and market-data ingestion keep their own permissions** (`app/api/admin/**` is exempt by prefix and never calls the consumer capability).
* No role shortcut: Admin or Super Admin status alone grants no consumer Premium (`staffPremiumNoRoleShortcut`).
* Unrelated internal AI jobs are not started by the document-AI switches (section 2 of `01_...`, test in `premiumAiProductionConfig`).
* Reviewing, correcting, accepting and deleting an already-admitted document keeps working after a plan ends (nothing new is charged).
