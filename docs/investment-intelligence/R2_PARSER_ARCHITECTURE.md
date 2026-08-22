# R2 — Parser Architecture

Status: FINAL

## 1. The interface

`lib/services/investment-intelligence/parsers/types.ts` defines `InvestmentDocumentParser` — the project-convention-named equivalent of the spec's `InvestmentDocumentParser` concept (spec section 8), matching this codebase's existing camelCase/`Ii`-prefixed style rather than the spec's verbatim casing, per the task's own instruction to follow project conventions:

```ts
interface InvestmentDocumentParser {
  readonly parserCode: IiParserCode;       // 'cams_detailed_v1' | 'kfintech_detailed_v1'
  readonly parserVersion: string;          // '1.0.0'
  readonly supportedSource: string;        // ii_sources.source_key
  readonly supportedDocumentType: string;  // 'cas_statement'

  canHandle(text: string): SourceDetectionResult;
  extractMetadata(text: string): ParseMetadata;
  parseAccounts(text: string): ParsedAccountRecord[];
  parseTransactions(text: string, accounts: ParsedAccountRecord[]): { transactions: ParsedTransactionRecord[]; warnings: ParsedWarning[] };
  parseHoldings(text: string, accounts: ParsedAccountRecord[]): { holdings: ParsedHoldingRecord[]; warnings: ParsedWarning[] };
  validateParsedOutput(output: ParsedDocumentOutput): ValidationOutcome;
}
```

Two provider adapters implement it: `parsers/camsParser.ts` and `parsers/kfintechParser.ts`. **There is no shared "one giant parser" with provider conditionals** (spec section 8's explicit anti-pattern) — the only code shared between the two adapters is genuinely provider-neutral: `parsers/textUtils.ts` (line splitting, scheme-name normalisation, plan/option detection, PAN masking/redaction), `decimal.ts` (exact numeric parsing), `dateNormalisation.ts` (CAS date parsing), and `transactionTypeMapping.ts` (the canonical taxonomy classifier). Every regex and label string that is actually provider-specific (`"Registrar: CAMS"` vs `"RTA : KFINTECH"`, `"Folio No:"` vs `"Folio No :"`, `DD-MMM-YYYY` vs `DD/MM/YYYY`) lives only in that provider's own file.

## 2. The registry

`parsers/registry.ts`:

- `PARSER_REGISTRY: InvestmentDocumentParser[]` — currently `[camsParser, kfintechParser]`. Adding a future provider (MFCentral, NSDL, CDSL, a broker) is one new array entry, not a change to any existing file.
- `detectSource(text)` — runs every registered parser's `canHandle()`, picks the highest-confidence match at or above `SOURCE_DETECTION_CONFIDENCE_THRESHOLD` (0.5), never guesses below threshold (spec section 12).
- `parseDocumentWithParser(parser, text)` — runs one parser's full pipeline (metadata → accounts → transactions → holdings → confidence), assembling the `ParsedDocumentOutput` every downstream stage consumes.
- `parseExtractedDocument(text)` — the **DB-free** entry point combining detection + parsing. This is what every golden-fixture test calls directly, and what `documentProcessing.ts`'s real pipeline calls before doing anything DB-related.
- `computeParserConfidence(warnings, classificationConfidences)` — the documented, deterministic overall-confidence formula (see `R2_DATA_QUALITY_AND_CERTIFICATION.md` for the exact formula and rationale).

## 3. Extraction method

`pdfExtraction.ts` wraps `pdf-parse` (a new, pure-TypeScript, `pdf.js`-based dependency — the only one added for R2). Given raw bytes (`data:`, never a `url:`), it performs 100% local, in-process text extraction — no network call, no third-party AI/OCR API (spec section 11's hard requirement). It classifies every failure mode into one of `password_required | wrong_password | corrupt | insufficient_text | unknown_error`, never fabricating text for a document it cannot read. See `R2_SUPPORTED_CAS_FORMATS.md` section "Password-protected files" and `R2_TESTING_AND_VERIFICATION.md` for exactly how this was verified (real binary PDFs for the non-password paths, a controlled `PasswordException` mock for the password paths — honestly distinguished, not conflated).

CSV documents (still an R1-supported upload MIME type) are read as plain UTF-8 text directly, with `extractionMethod = 'csv_text'`.

## 4. Versioning and lineage (spec section 9)

Every parse **run** (an attempt, not just a result) is recorded in the new `ii_document_parse_runs` table (migration `0039`) — `parser_code`, `parser_version`, `run_status`, timestamps, detection outcome, and per-run counts/warnings/errors. `ii_transactions` and `ii_holding_snapshots` each gained `parse_run_id` (FK), `parser_code`, `parser_version_used` (migration `0040`), so "which parser version produced this canonical transaction" is answerable with a direct column read, not an inference. A future parser upgrade never overwrites this lineage: reprocessing creates a **new** `ii_document_parse_runs` row (retry/upgrade history is fully preserved), and canonical rows always carry the parser identity that actually produced them.

## 5. Orchestration

`documentProcessing.ts`'s `processSourceDocument()` is the single DB-touching orchestrator implementing the full pipeline spec section 1 describes:

```
SOURCE DOCUMENT
  -> download bytes (storage.ts, service-role, only after ownership already verified)
  -> SAFE DOCUMENT EXTRACTION (pdfExtraction.ts)
  -> SOURCE IDENTIFICATION (parsers/registry.ts detectSource)
  -> SOURCE-SPECIFIC PARSER (parseDocumentWithParser)
  -> NORMALISED PARSED RECORDS (ParsedDocumentOutput)
  -> FOLIO/ACCOUNT RESOLUTION (accountResolution.ts)
  -> SCHEME/INSTRUMENT RESOLUTION (schemeResolution.ts, ii_instruments/ii_instrument_identifiers/ii_scheme_alias_map)
  -> TRANSACTION NORMALISATION + FINGERPRINT DEDUP (fingerprint.ts, ii_transactions, ii_transaction_source_links)
  -> HOLDING RECONCILIATION (reconciliation.ts, per account+instrument position)
  -> EXCEPTION/RECONCILIATION QUEUE (ii_reconciliation_cases)
  -> CERTIFIED CANONICAL PORTFOLIO (certification.ts -> ii_portfolio_truth_status)
```

Idempotency (spec section 52) is enforced at two levels: a partial unique DB index (`uidx_ii_document_parse_runs_one_active`) prevents a second concurrent in-flight run, and the service function itself returns a cached summary for a repeat call after a prior `succeeded` run with the same `parser_version`, unless `forceReparse` is explicitly requested.
