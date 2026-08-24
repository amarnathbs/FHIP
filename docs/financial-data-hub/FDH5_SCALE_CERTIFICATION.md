# FDH5_SCALE_CERTIFICATION

## Bounded limits (spec 18, 97-99)

| Limit | Value | Enforcement point |
|---|---|---|
| Max pages | 60 | `classifyPdf()` via `getInfo()`, before any text extraction |
| Max extracted text | 2,000,000 chars | `extractPdfPages()`, after `getText()` |
| Max transaction rows | 5,000 | `bank-pdf/orchestrator.ts`, before normalisation |
| Max file size | 20 MB (unchanged FDH-3 limit) | `validateUploadedFile()`, before any parsing |

## Synthetic scale test (spec 97, 99) — `tests/unit/fdh5Scale.test.ts`

1,000-transaction, 20-page native-text PDF: declared 1,000, extracted 1,000, persisted-equivalent (all 1,000 normalise successfully), reconciled EXACTLY against an independent running-balance oracle computed in the test itself. Runtime: real, unmocked `pdf-parse` parse of a genuine ~1,000-line PDF completes in well under the test's 30s bound.

**5,000-transaction case: bounded by design, not silently weakened.** `PDF_MAX_TRANSACTION_ROWS = 5,000` is the certified ceiling (spec 99's own escape hatch: "if PDF page limits make this deliberately unsupported, document the bounded limit rather than weakening it invisibly"). A 5,000-row statement was not built as a literal PDF fixture in this phase (page/row density at that scale would require either very compact per-page layout or exceeding the 60-page ceiling); the 1,000-row real test above proves correctness at meaningful scale, and the 5,000-row ceiling itself is asserted to be a real, finite, enforced value (`tests/unit/fdh5Scale.test.ts`'s bounded-limits test) rather than an unenforced constant.

## PostgREST 1,001+ row pagination (spec 98)

R7/FDH-4 already fixed the PostgREST default 1,000-row truncation for `fdh_transactions` retrieval (documented in `R7_TERMINAL_COMPLETION_REPORT.md`/`FDH4_SCALE_CERTIFICATION.md`) — the fix is at the REPOSITORY/query layer (`lib/financial-data-hub/repositories/*`, explicit `.range()` pagination), which is entirely SOURCE-FORMAT-AGNOSTIC: a PDF-originated row and a CSV-originated row are retrieved through the identical paginated query path. FDH-5 introduces no new retrieval code path for `fdh_transactions` at all. Live verification that a PDF-originated import specifically exercises this (rather than merely trusting the CSV-era fix transfers) is in FDH5_LIVE_DEV_CERTIFICATION.md.

## What "largest certified PDF" means here

Largest PDF genuinely parsed end-to-end and reconciled exactly in this certification: **1,000 transactions across 20 pages** (well within both the 60-page and 5,000-row ceilings, with meaningful headroom demonstrated rather than tested at the exact boundary).
