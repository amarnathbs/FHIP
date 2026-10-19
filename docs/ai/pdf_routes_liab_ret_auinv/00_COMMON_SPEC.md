# PDF routes for liability, retirement and Australian investment statements: common specification

Decision (Product Owner, 19/10/2026, final): build PDF upload routes for the three document classes whose screens accepted CSV only. This file holds the rules
that are the same for all three classes. The per-class files are `01_SPEC_LIABILITY.md`, `02_SPEC_RETIREMENT.md`, `03_SPEC_AU_INVESTMENT.md`.

Written BEFORE the code and the corpus (accuracy corpus first), and the readers were then built to this text, not the other way round.

## 1. What is reused (nothing here is a second copy)

| Need | Existing piece reused |
|---|---|
| Premium-only admission (single shared capability) | `lib/entitlements/financialDataImport.ts` (`refuseUnlessFinancialImportAllowed` at the route, `assertFinancialImportAllowed` inside `createUploadSession` and `completeUpload`) |
| Premium re-check at the moment of a chargeable AI step | `lib/ai/access/premiumAiAccess.ts` through `evaluateAiFallbackGate` |
| Real malware scan bound to the stored object | `completeUpload` -> `runFdhRealMalwareScanGate` (unchanged), `checkFdhDocumentMalwareAdmission` before any read |
| Local PDF text extraction | `lib/financial-data-hub/bank-pdf/textExtraction.ts` (`extractPdfPages`, pdf-parse, no network) |
| PII masking before any provider call | `lib/aie/masking/piiMasking.ts` through `evaluateAiFallbackGate` (fails closed) |
| AI fallback, schema validation, cost reserve and settle, per-user US$1/day cap, global ledger | `lib/aie/adapters/{liability,retirement,auInvestment}` -> `lib/aie/adapters/shared/gateway.ts` -> `lib/aie/cost/costAdmission.ts` (unchanged) |
| Durable review data, idempotent replay | `fdh_ai_fallback_drafts` (`aiFallbackDrafts.ts`), `findEarlierIdenticalUpload`, `singleFlight` |
| Deterministic reconciliation and the canonical evidence writers | `persistLiabilityStatementEvidence`, `persistRetirementEvidence`, `persistAuInvestmentEvidence` (the SAME functions the CSV routes call) |
| Verified deletion of the original | `lib/financial-data-hub/services/purge.ts` (`runPurgeAttempt`: delete, then verify absent, then mark purged) |
| Review and acceptance | the existing evidence review, approve, proposal and apply routes and screens of each class |

New code is only: the PDF text reader and the deterministic layout readers, a document-class check, the provenance guard for AI-drafted lines, the three
kill switches, the intake branch in each service and route, the screen wiring, tests, and this corpus.

## 2. Flow (identical for the three classes)

1. `POST .../upload` (existing route). Order of refusals, each BEFORE the next step is touched:
   1. not signed in -> 401;
   2. not Premium now (`refuseUnlessFinancialImportAllowed`) -> 403 `PREMIUM_REQUIRED`, nothing read, no row, no storage, no scan, no provider;
   3. the body is read (bounded by the size limit for its kind) and its first bytes are sniffed. A PDF with that class's PDF kill switch OFF -> 403 with day-first-safe plain words, no row, no storage;
   4. owner-before-upload rules of the CSV route (unchanged).
2. `createUploadSession` (`source_type: pdf_native`, `declared_mime_type: application/pdf`) and `completeUpload`: structural scan, store, real malware scan bound to the stored object. A scan still pending -> `pending_scan`, the screen polls and calls `.../process` (existing mechanism).
3. Resolve (shared by upload and `.../process`): identical-bytes rule, draft resume, malware admission, then download and `readStatementPdf`.
4. `readStatementPdf` outcomes and what each does:

| Outcome | Meaning | Action | AI? |
|---|---|---|---|
| `password_required` | encrypted | document stays queued with `password_required`; the person is told to upload an unprotected copy | no |
| `image_only` (no text layer) | scan or photo | refused, `ocr_required`; no OCR exists | no |
| `corrupt`, `timeout`, `page_limit` | unreadable or too large | refused with a controlled code | no |
| `not_this_class` | text exists but is not a statement of this class | refused, document `rejected`, nothing written | **no, nothing charged** |
| `multiple_accounts` | more than one account in one PDF | refused with the words "one account at a time"; nothing written | no |
| `layout_unsupported` | this class, no certified layout matched | AI fallback offered (gates below) | yes |
| `unread_lines` | layout matched but at least one line inside the table could not be read | AI fallback offered; a line is never silently dropped | yes |
| `ok` | layout matched and every line read | canonical evidence writer; reconciled = certified, else `review_required` | no |

5. AI fallback gates, in this order (all in `evaluateAiFallbackGate`): the class kill switch, the global `AIE_AI_FALLBACK_ENABLED`, the real-scan precondition, Premium now, enough text, masking (fails closed), the masking-policy check. Then the shared gateway: pre-egress PII re-scan, US$1/day per-user cap, global ledger, strict schema, no new provider (`AIE_AI_PROVIDER`, `AIE_AI_MODEL` unchanged).
6. The model's reading becomes a DRAFT. Provenance guard (new, PDF only): every drafted line whose amount is not printed in the text is dropped with a visible warning, and the balance anchors must be printed (existing rule). Nothing is written. The draft is saved durably (`fdh_ai_fallback_drafts`) before the person sees it.
7. The person reviews and confirms. Confirm claims the server-issued draft once (replay refused), recomputes every total and the reconciliation server-side with the same writer as the deterministic path, and always lands as review required (provenance warning).
8. Deletion: when the structured result is durable (AI confirm, or the deterministic evidence write) the original PDF is deleted and verified absent immediately (`purgeRawPdfAfterDurableEvidence` / `purgeRawDocumentAfterAiConfirm`); the 50 minute backstop remains the safety net. The temporary scan copy is removed by the existing scan-copy purge (finding F-4 of the earlier proof remains open for production, not changed here).

## 3. Units, signs, currency, dates (all classes)

* Money in the evidence tables is a positive magnitude plus a TYPE. The sign printed on the page (minus, brackets, `CR`, `DR`) is read to choose the type or direction; it is never stored as a sign on an activity.
* Summary movement figures of a retirement statement may legitimately be negative (a loss year's investment earnings); those are stored as signed decimal strings exactly as the existing reconciliation expects.
* Money arithmetic is exact integer minor units (existing `money.ts`), zero tolerance, except the explicitly named rounding rule `units x price = value` (section 4).
* Currency is the person's declared currency for the upload (AUD or INR). A printed currency code that disagrees is a warning and forces review.
* Dates are stored as ISO internally and shown day-first: dd/mm/yyyy for Australia, dd-mm-yyyy for India. Accepted on the page: `dd/mm/yyyy`, `dd-mm-yyyy`, `dd.mm.yyyy`, `dd Mon yyyy`, `dd Month yyyy`. A date with a two-digit year, no year, or a month above 12 in the second place is NOT read deterministically (it goes to the fallback). US month-first order is never assumed.
* Identifiers: only the last 4 characters of an account, card, member or holder number are kept (`****1234`); a run of 7 or more digits is never stored (existing database check).

## 4. Rounding rule (the only tolerance in the whole feature)

`quantity x price = value` for a holding is accepted when the absolute difference is at most 0.01 of the currency unit, because broker prices are printed to 4 decimal places and the value to 2. Everything else (opening plus movements equals closing, holdings plus cash equal the printed total, printed subtotals equal the sum of their parts) is exact.

## 5. Refusal and review conditions that apply to every class

* A reading is certified only when its reconciliation identity ties exactly AND no warning remains. Anything else is review required, never silently accepted.
* The model's own statement that it listed every line is recorded and shown, and is never the only completeness check; the arithmetic is.
* A dropped line makes the identity fail; an invented line is dropped by the provenance guard or fails the identity. Both are visible to the person.
* A summary line (total, subtotal, brought forward, carried forward, year to date) is never an activity.
* Two identical genuine lines (same date, text and amount) are both kept. Nothing de-duplicates inside one statement.
* Manual entry is untouched and stays available to Free and Premium.

## 6. Kill switches and rollback (default OFF in production)

| Class | Variable (literal `true` turns it on; unset, empty, `1`, `TRUE`, `yes` leave it off) |
|---|---|
| Liability PDF | `AIE_LIABILITY_PDF_ROUTE_ENABLED` |
| Retirement PDF | `AIE_RETIREMENT_PDF_ROUTE_ENABLED` |
| Australian investment PDF | `AIE_AU_INVESTMENT_PDF_ROUTE_ENABLED` |

The `AIE_` prefix is already forwarded to the server by `amplify.yml`, so no deployment-file change is needed. A switch that is off refuses a PDF at the route before anything is stored; CSV keeps working; the AI fallback of the CSV route has its own, separate switch. Turning a PDF switch off preserves the cap, the ledger, every saved statement and every draft.

## 7. As built: what the implementation adds to or settles beyond the text above

Recorded after the build so the specification and the code cannot drift silently. Each item is tested (see the report).

1. **Deletion of the original happens earlier than for the CSV AI fallback.** The original PDF is deleted and verified absent (a) right after the evidence is written (certified read), (b) right after an AI DRAFT is saved durably, before the person reviews it, and (c) right after any refusal. The 50 minute backstop remains the safety net. A resumed draft never needs the file.
2. **AI-read holdings are tied to the PRINTED total.** The text is searched by label for the portfolio total and the cash balance (no model involved); they are kept with the saved draft on the server and read back at confirm, so "holdings add up to the total" is checked for an AI-read statement. They are never taken from the model or from the browser.
3. **Retirement review policy for a PDF is stricter than for a CSV.** A PDF-sourced retirement statement is `review_required` unless its identity reconciles AND no warning remains; every AI-read PDF statement carries the visible warning `read_by_ai_fallback_from_pdf`. The CSV rule is unchanged.
4. **A line-level check failure stores an investment statement as `variance`** even when the printed lines still add up to the printed total.
5. **Identifiers are masked before the model sees the page**, so an AI-read statement usually has no card, member or HIN digits; the person types the last four at review. Three masking rules were added after the corpus showed names and numbers reaching the model: `Cardholder:`, a broker `Account: NAME   HIN:` line, and `UAN:` / `PRAN:`.
6. **Lakh-grouped figures (`3,45,210.00`) count as printed** in the existing "is this figure printed on the page" test, which previously judged every one of them unprinted and dropped it.
7. **Day-first dates on the touched screens.** The three panels showed ISO dates in places; they now use the shared day-first formatter. Existing tests that pinned the ISO text were updated.
8. **No migration.** Every error code, status, event type and statement type written already satisfies the existing database constraints (proved on a real engine, `tests/unit/pdfRoutesSchemaPglite.test.ts`).
9. **Upload limit.** The existing limit of 20 upload sessions per person per hour applies to PDFs too.
