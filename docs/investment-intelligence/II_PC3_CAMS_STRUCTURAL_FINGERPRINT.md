# II-PC3 — Real-CAMS Production Qualification Pack: Structural Fingerprint & Pipeline Trace

Status: PHASE 1 — DISCOVERY (no fixtures, no code changes)
Branch: `feature/ii-pc3-real-cams-qualification-pack`
Base: `origin/main` @ `8b89d87` (chain confirmed present: PC1 `b7b28ca`, PC1-F1 `0c11a5c`, PC1-F2 `88eee33`, PC2 `8e21835`, PC2-F1 `8b89d87`)

## 0. REAL-STATEMENT STRUCTURAL MATCH: NOT YET PROVEN

No genuine CAMS Consolidated Account Statement (real or de-identified) was supplied by the Product Owner for this pack, and none exists anywhere in this repository. This was checked before writing anything below: `docs/investment-intelligence/R2_SUPPORTED_CAS_FORMATS.md` section 4 already discloses, as of R2's own original build, "this codebase has no licensed sample of either [CAMS/KFintech] to reverse-engineer byte-for-byte."

Everything in this document and every fixture built under this pack is therefore built against **the CAMS grammar already certified in this codebase** (the R2 parser's regexes, the R2 golden-fixture catalog, and the R2/R11 architecture docs) — not against a real statement. This caps the final PC3 verdict at **CONDITIONAL PASS at best**, never UNCONDITIONAL FULL PASS, with "no real structural reference available" as the named, load-bearing blocker. This is stated plainly here, up front, per the task's own absolute rule, rather than being discovered or walked back later.

If the Product Owner can supply a genuine (or genuinely de-identified) CAMS PDF for structural comparison ONLY (never committed to the repo, inspected transiently), Phase 1 of this document should be revisited and the gap closed or reported with specifics.

## 1. Abstract structural properties of the certified CAMS grammar (zero real values)

These properties are what the current parser (`lib/services/investment-intelligence/parsers/camsParser.ts`) actually requires and tolerates — not a description of a real statement's PDF visual layout (columns, borders, print headers/footers), which this codebase has never seen.

### 1.1 Encryption behavior
- The extraction layer (`pdfExtraction.ts`) accepts an optional password and distinguishes exactly three encrypted-document outcomes by whether the caller supplied a password when `pdf-parse`'s `PasswordException` is thrown:
  - No password supplied → `password_required`.
  - Password supplied but wrong → `wrong_password`.
  - Password supplied and correct → normal extraction proceeds (no distinct "success" signal beyond text being returned).
- The password is a caller-supplied string used only in-memory for one `PDFParse` instantiation; the parser layer has no knowledge of whether the source document was ever encrypted (encryption is invisible above the extraction boundary) — a design property this pack must confirm, not assume.
- No password is ever written to `parse_error`, `ii_document_parse_runs.errors`, or audit-event metadata (`documentProcessing.ts`'s `handleExtractionFailure` — only the classified `kind`, deliberately never the raw exception message, which could theoretically echo attacker-supplied input in a future pdf-parse version).

### 1.2 Header / investor / AMC / folio / scheme grammar (label-line, not fixed-column)
Every structural field is recognised by a **case-insensitive `Label : value` line pattern** (`textUtils.ts`'s `extractLabelledField`), not by column position. The exact CAMS label set the parser recognises:

| Field | Label recognised | Cardinality |
|---|---|---|
| Statement title | `CAMS Consolidated Account Statement` (evidence line, not a labelled field) | once, document-level |
| Statement period | `Statement Period : <start> To <end>` | once, document-level |
| Folio | `Folio No: <value>` | repeats — starts a new folio/account block |
| PAN | `PAN: <value>` | one per folio block (redacted before retention — see 1.5) |
| Holder name | `Name: <value>` | one per folio block |
| Holding mode | `Holding Mode: <value>` | one per folio block (`SI`/`JO`/`AS`, not validated against a closed enum — passed through as `holdingModeRaw`) |
| AMC | `AMC Name: <value>` | repeats per scheme block — must appear on its OWN line, applied unconditionally to `lastKnownAmcName` (see 1.6 for the live-defect history this fixed) |
| Scheme | `Scheme Name: <value>` | repeats — starts a new scheme block under the current folio |
| ISIN | `ISIN: <value-or-blank>` | one per scheme block, optional |
| AMFI code | `AMFI Code: <value-or-blank>` | one per scheme block, optional |
| Registrar evidence | `Registrar: CAMS` (exact, own line) | one or more — each occurrence adds source-detection confidence |

Folio/AMC/scheme blocks are **whitespace/order-driven, not delimiter-driven**: the parser walks the flattened line stream keeping `currentFolio`/`currentScheme`/`lastKnownAmcName` as mutable state, re-set only when the corresponding label line is next seen. A folio has no explicit "end" marker — it ends when the next `Folio No:` line (or end of document) is reached.

### 1.3 Transaction-table grammar
Table entry is signalled by a header line matched loosely: `/^Date\s+Description\s+Amount/i` (only the first three words are load-bearing; anything after "Amount" — units/NAV/balance column labels — is not matched, so cosmetic header-label drift there is already tolerated). Each transaction row must match:

```
^(\d{1,2}-[A-Za-z]{3}-\d{4})\s+(.+?)\s+(\(?-?[\d,]+\.\d+\)?)\s+(\(?-?[\d,]+\.\d+\)?)\s+(\(?-?[\d,]+\.\d+\)?)\s+(\(?-?[\d,]+\.\d+\)?)(?:\s+\[Ref:\s*([^\]]+)\])?\s*$
```

i.e. `DD-MMM-YYYY  <description, non-greedy>  <amount>  <units>  <nav>  <balance>  [Ref: <ref>]?` — six whitespace-separated fields, description is free text (non-greedy, so it never swallows the numeric columns), numeric fields accept comma-grouped thousands and parenthesised negatives, the trailing `[Ref: ...]` bracket is optional. A row that does not match this shape (once inside a detected table) produces an `unparseable_transaction_row` **error**-severity warning — it is never silently dropped or silently coerced.

Table end is signalled either by the `Closing Unit Balance...` line (see 1.4) or implicitly by the next `Folio No:`/`AMC Name:`/`Scheme Name:` line, which resets `inTable = false`.

### 1.4 Closing-balance grammar
```
^Closing Unit Balance as on (\d{1,2}-[A-Za-z]{3}-\d{4})\s*:\s*(<units>)\s*Units\s+Valuation\s*:\s*(?:Rs\.?|₹)\s*(<value>)(?:\s+NAV as on (\d{1,2}-[A-Za-z]{3}-\d{4})\s*:\s*(?:Rs\.?|₹)\s*(<nav>))?\s*$
```
NAV-as-of clause is optional; `Rs.`, `Rs`, and `₹` are all accepted currency markers.

### 1.5 Date / numeric formats
- Dates: `DD-MMM-YYYY` only (e.g. `05-Jan-2025`), 3-letter English month abbreviations, case-insensitive parsing (`dateNormalisation.ts`). This is deliberately **not** the same format KFintech's parser expects (`DD/MM/YYYY`) — the two parsers are independently regexed, by design, not a shared date-format assumption.
- Numerics: Indian comma-grouped thousands (`1,23,456.78`) and plain decimal are both accepted; parenthesised values are treated as negative; up to 6 fractional digits are preserved exactly as scaled integers (`parseExactDecimal`), more than 6 triggers an informational rounding warning, never silent truncation.
- PAN: masked to `AAAAA****A` (first 5 + last 1 visible) at parse time (`maskPan`), and redacted out of any retained raw block text before it is ever stored (`redactPanFromLine`) — full PAN is never persisted or logged by the parser layer.

### 1.6 Page-continuation behavior
The parser has **no explicit concept of a PDF page boundary** — `pdfExtraction.ts` strips `pdf-parse`'s `-- N of M --` page-separator marker lines at the extraction boundary, before the parser ever sees the text, and the parser then processes one continuous, flattened line stream. This is a structural property worth stating precisely because it cuts both ways:
- **Tolerant by construction**: if a real statement reprints `Folio No:`/`AMC Name:`/`Scheme Name:` after a page break (common in real RTA output), the parser's state machine simply re-applies the same values — a no-op, not a bug. If the transaction-table header line reprints, `inTable` is simply re-set to `true` — also a no-op.
- **Unverified risk**: if a real page break splits a transaction table WITHOUT any header reprint and WITHOUT any blank-line/whitespace corruption, the flattened-stream design should carry `currentScheme`/`inTable` state across the boundary transparently — but this has only ever been exercised by one fixture (`cams-certified-multi-page`) that is, on inspection, **not actually a page-boundary test**: it is a single unbroken 12-transaction block with no page-break marker, no header reprint, and no `-- N of M --` stripping exercised at all (see `R2_GOLDEN_FIXTURE_CATALOG.md` row "Multiple transaction pages"). **A genuine page-break scenario, including a mid-table break with header reprint, has never been exercised end-to-end through real PDF bytes.** This is exactly the gap PC3's Q09 fixture (Phase 3) is built to close.

**UPDATE (Phase 3 result):** Q09 genuinely closed this gap, and it did not pass on the first attempt — it caught a real defect exactly here: an `AMC Name:` line (which every scheme block's header reprint necessarily starts with, before its own `Scheme Name:` line) did not reset `inTable`, so a header reprinted before its prior scheme's `Closing Unit Balance` line was wrongly fed to the transaction-row regex and raised a false parse error. Fixed in `camsParser.ts` — see `II_PC3_QUALIFICATION_PACK_MANIFEST.md`'s Finding #1 for the full account. The fix also covers the equivalent non-page-break case (a scheme with no closing-balance line at all, immediately followed by the next scheme's `AMC Name:` line).

### 1.7 Footer placement
No footer grammar exists in the parser at all — nothing resembling a page footer (page numbers, RTA disclaimers, print timestamps) is recognised, matched, or excluded. This is an implicit assumption that footer text either doesn't collide with the label/table regexes above, or — if it does — would currently be misparsed. Never tested against a real footer because no real sample exists.

## 2. Full pipeline trace (stage → file → function → input → output)

| # | Stage | File | Function(s) | Input | Output |
|---|---|---|---|---|---|
| 1 | Storage download | `lib/services/investment-intelligence/storage.ts` | `downloadSourceDocumentObject` | `storage_path` | raw `Uint8Array` bytes |
| 2 | Password/decryption + text extraction | `lib/services/investment-intelligence/pdfExtraction.ts` | `extractPdfText` | bytes, optional `password` | `{ok:true, text, pageCount}` or classified failure (`password_required`/`wrong_password`/`corrupt`/`insufficient_text`/`unknown_error`) |
| 3 | Source-type detection | `lib/services/investment-intelligence/parsers/registry.ts` | `detectSource` | extracted text | best-confidence parser + all-candidate audit trail; `null` parser if below 0.5 threshold |
| 4 | CAMS detector (one of the registered parsers) | `lib/services/investment-intelligence/parsers/camsParser.ts` | `canHandle` | text | `{sourceKey, confidence, evidenceMatched}` — title line (weight 0.55) + `Registrar: CAMS` line count (weight, capped) |
| 5 | Parser (metadata/accounts/transactions/holdings/validate) | `camsParser.ts`, orchestrated by `registry.ts`'s `parseDocumentWithParser` | `extractMetadata`, `parseAccounts`, `parseTransactions`, `parseHoldings`, `validateParsedOutput` | text + accounts | `ParsedDocumentOutput` (100% pure/in-memory, DB-free) |
| 6 | Normalisation (scheme name, plan/option, transaction type, fingerprint) | `textUtils.ts`, `transactionTypeMapping.ts`, `fingerprint.ts` | `normaliseSchemeName`, `detectPlanType`/`detectOptionType`, `classifyTransactionType`, `computeTransactionFingerprint` | raw scheme/description strings | normalised scheme identity, canonical transaction type + confidence, dedup fingerprint |
| 7 | Canonical parsed model | `parsers/types.ts` | (type contract only) | — | `ParsedDocumentOutput` — the DB-free boundary every downstream stage consumes |
| 8 | Account/folio resolution | `accountResolution.ts` | `planFolioAccountResolution`, `resolveOrCreateAccount` | parsed accounts/transactions/holdings | distinct (folio, AMC) → `ii_accounts` row assignments |
| 9 | Scheme/instrument resolution | `schemeResolution.ts` | `resolveScheme` | parsed scheme + existing `ii_instruments`/`ii_instrument_identifiers`/`ii_scheme_alias_map` (paginated, unbounded-safe per R6-P0 fix) | resolved / ambiguous / new-provisional instrument outcome |
| 10 | Transaction normalisation + same-source dedup + cross-source identity | `documentProcessing.ts`, `crossSourceIdentity.ts` | inline loop, `resolveCrossSourceTransactionMatch` | parsed transactions + existing `ii_transactions` | new `ii_transactions` rows, or dedup-linked `ii_transaction_source_links`, or `review_required` status on conflict |
| 11 | Holding snapshots | `documentProcessing.ts` | inline upsert | parsed holdings | `ii_holding_snapshots` rows (idempotent on `account_id,instrument_id,as_of_date`) |
| 12 | Reconciliation | `reconciliation.ts` | `reconcilePosition`, `determineHistoryCompleteness` | transaction history + opening/closing snapshots | reconciled units, variance, within-tolerance flag |
| 13 | Certification | `certification.ts` | `evaluateCertification` | reconciliation result + blocking/warning conditions | `certified` / `certified_with_warnings` / `failed` |
| 14 | Publication / exception queue | `documentProcessing.ts` | `openReconciliationCase`, `ii_portfolio_truth_status` upsert | certification result | published truth-status row, or an open `ii_reconciliation_cases` row |
| 15 | Finalisation | `documentProcessing.ts` | final `ii_source_documents`/`ii_document_parse_runs` updates + `emitAuditEvent` | — | terminal document status + audit trail |

This is the exact orchestration in `processSourceDocument()` (`lib/services/investment-intelligence/documentProcessing.ts`) — Phase 4 of this pack must exercise this real function via the real API route and real DEV Supabase, never call stages 4-7 in isolation and report that as production qualification.

## 3. What is explicitly NOT covered by this fingerprint

- Real visual layout (columns, print margins, page headers/footers, table borders) — this codebase's grammar is a labelled-line text grammar (see `R2_SUPPORTED_CAS_FORMATS.md` section 4), which is what `pdf-parse`'s linearised text output would hand the parser regardless of visual layout, but is NOT proof the parser handles every real-world column/spacing variant.
- Any CAMS statement generation era/template not represented in the certified grammar above.
- OCR / scanned statements (explicit non-goal, unchanged from R2).
