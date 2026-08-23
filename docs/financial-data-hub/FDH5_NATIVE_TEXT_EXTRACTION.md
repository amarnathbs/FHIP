# FDH5_NATIVE_TEXT_EXTRACTION

## Classification thresholds

`MIN_CHARS_PER_PAGE = 40`, `MIN_TOTAL_CHARS = 80` — carried over unchanged from Investment Intelligence R2's own certified heuristic (`lib/services/investment-intelligence/pdfExtraction.ts`). **Known limitation, disclosed honestly**: these thresholds were tuned against R2's CAS-statement fixtures, not re-derived from bank-statement-specific samples. They are deliberately conservative (low) so a genuine but sparse real page is not wrongly routed to `IMAGE_ONLY`/OCR-required. No bank-statement-specific recalibration was performed in this phase.

## Row reconstruction — certification cases (spec 91)

All cases below are exercised by `tests/unit/fdh5AdapterCertification.test.ts` and `tests/unit/fdh5FinancialIntegrity.test.ts` against real, unmocked `pdf-parse` output (via `tests/support/buildBankPdfFixture.ts`, itself built on the pre-existing, proven `buildMinimalTextPdf`):

| Case | Result |
|---|---|
| One page, single transaction | PASS (8/8 adapters) |
| Multi-page (3 pages, 1 txn/page) | PASS — `source_page` correctly 1/2/3 |
| Multi-line description (2 continuation lines) | PASS — one transaction, description merged, not 3 rows |
| Repeated column headers (2 pages) | PASS — header line never becomes a transaction |
| Debit/credit columns (`dr_cr_indicator` convention) | PASS (CBA, NAB, SBI, ICICI) |
| Signed amount (`single_signed` convention) | PASS (ANZ, Westpac, HDFC, Axis) |
| Running balance present | PASS — reconciled exactly, independent-oracle-verified |
| No running balance | Reconciliation correctly reports `not_available` (bank-csv/reconciliation.ts's existing, unmodified behaviour) |
| Statement metadata (opening/closing balance, masked account) | PASS — extracted only where the adapter's declared pattern explicitly matches; never inferred |
| Unicode | `normalizeDescription`'s existing NFKC normalisation (bank-csv, unmodified) applies identically |
| Malformed row (no locatable numeric tail) | Reported as `unparseableBlocks`, never fabricated; statement fails safely rather than silently dropping the row |
| Malformed/truncated PDF | Classified `corrupt`, zero rows extracted |
| 1,000-transaction, 20-page statement | PASS — declared 1000, extracted 1000, reconciled exactly (`tests/unit/fdh5Scale.test.ts`) |

**Result: PASS, 8/8 adapters, all listed cases.**

## Deliberate non-goal in this phase

`pdf-parse`'s vector-geometry `getTable()` (ruled-line table detection) was evaluated (dependency review, spec 123) but not built into certification — see FDH5_PDF_ARCHITECTURE.md's "Row reconstruction strategy" section for the full reasoning. All 8 adapters are certified against the line-stream reconstruction strategy only.
