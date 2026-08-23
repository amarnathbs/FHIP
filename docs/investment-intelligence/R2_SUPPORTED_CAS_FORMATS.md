# R2 — Supported CAS Formats

Status: FINAL

## 1. What is actually production-supported in R2

Exactly two statement sources, matching spec section 7:

| Source | `ii_sources.source_key` | Parser | Version |
|---|---|---|---|
| CAMS detailed mutual-fund CAS | `cams` | `parsers/camsParser.ts` | `cams_detailed_v1` @ `1.0.0` |
| KFintech detailed mutual-fund CAS | `kfintech` | `parsers/kfintechParser.ts` | `kfintech_detailed_v1` @ `1.0.0` |

Migration `0039` flips `ii_sources.parser_available` to `true` for exactly these two rows (it was `false` for every row in R1, since no parser existed). Every other `ii_sources` row (`mfcentral`, `nsdl`, `cdsl`, `broker`, `manual`, `admin_correction`) stays `parser_available = false` — **R2 does not claim, and the architecture does not assume, that any of these is production-supported.** A document that evidence-detects as none of the two supported sources is marked `unsupported` or `reconciliation_required` (spec section 12), never silently accepted.

## 2. The exact CAMS layout the parser targets

```
CAMS Consolidated Account Statement
Statement Period : DD-MMM-YYYY To DD-MMM-YYYY

Folio No: <folio>
PAN: <pan>
Name: <holder name>
Holding Mode: <SI|JO|AS>

AMC Name: <amc>
Scheme Name: <scheme name, including plan/option, e.g. "... - Growth (Direct Plan)">
ISIN: <isin-or-blank>
AMFI Code: <code-or-blank>
Registrar: CAMS

Date          Description                    Amount(Rs.)   Units    NAV(Rs.)   Unit Balance
DD-MMM-YYYY   <description>                   <amount>      <units>  <nav>      <balance>   [Ref: <ref>]
...

Closing Unit Balance as on DD-MMM-YYYY : <units> Units   Valuation : Rs. <value>   NAV as on DD-MMM-YYYY : Rs. <nav>
```

Folio/AMC/Scheme blocks repeat for multi-folio, multi-AMC, multi-scheme statements. Detection evidence: the title line (`CAMS Consolidated Account Statement`, weight 0.55) plus one weighted point per `Registrar: CAMS` line found (capped).

## 3. The exact KFintech layout the parser targets

```
KFINTECH Consolidated Account Statement
Period : DD/MM/YYYY to DD/MM/YYYY

Folio No : <folio>
PAN : <pan>
Investor Name : <holder name>
Mode of Holding : <Single|Joint|...>

AMC Name : <amc>
Scheme : <scheme name>
ISIN : <isin-or-blank>
AMFI Code : <code-or-blank>
RTA : KFINTECH

Txn Date     Transaction Type            Amount        Units      Price(NAV)   Balance Units
DD/MM/YYYY   <description>                <amount>      <units>    <nav>        <balance>   [Ref: <ref>]
...

Closing Balance : <units> units as on DD/MM/YYYY   Market Value : Rs <value>   NAV : Rs <nav>
```

Deliberately **not identical** to the CAMS layout (spec sections 39-40's explicit requirement) — different field labels, different date format (DD/MM/YYYY vs DD-MMM-YYYY), different closing-balance line shape, different provider-evidence marker (`RTA : KFINTECH` vs `Registrar: CAMS`), separately regex'd in `kfintechParser.ts`.

## 4. This layout is a documented, synthetic-but-structurally-faithful representation, not a reverse-engineered exact copy of a real CAMS/KFintech PDF

Real CAMS/KFintech consolidated account statements are proprietary, visually laid out for print (multi-column, page headers/footers, sometimes table borders), and this codebase has no licensed sample of either to reverse-engineer byte-for-byte. R2's parsers are built against a **documented, labelled-line text grammar** that:

1. Captures every field category spec sections 15-23 require (folio, PAN, holder name, holding mode, AMC, scheme name, ISIN, AMFI code, transaction date/description/amount/units/NAV/balance/reference, closing units/value/NAV/as-of-date).
2. Is what the actual extraction layer (`pdf-parse` reading a real PDF's text layer) would hand the parser — plain, linearised text, not a rendered visual layout — so the parser's real input contract (already-extracted text, not PDF bytes) is exercised faithfully.
3. Uses whitespace-separated fields (not fixed-column alignment), which is materially more robust than assuming exact column positions — real CAS PDFs vary column widths across statement generations, RTAs, and even individual funds within the same statement.

This is documented honestly here, not represented as "these are the literal production CAMS/KFintech format specs." Extending the parser to a REAL sample statement, when one becomes available (e.g., a user-donated de-identified statement, or a licensed format spec), is expected future work and is exactly why the parser is structured as regex-per-labelled-field rather than a rigid fixed-offset table reader — the label-driven approach (`extractLabelledField()`) tolerates real-world column/spacing variation far better than a hypothetical byte-exact clone would.

## 5. Password-protected files

Supported at the extraction layer (`pdfExtraction.ts`), technically feasible via `pdf-parse`'s password parameter. See `R2_PARSER_ARCHITECTURE.md` section 3 and `R2_TESTING_AND_VERIFICATION.md` for exactly what was proven with real PDF bytes vs. a controlled exception-classification mock, and `R2_SECURITY_VERIFICATION.md` for the password-never-persisted guarantee.

## 6. Explicitly NOT supported (honestly listed, not silently ignored)

- MFCentral-compatible statements, NSDL CAS, CDSL CAS, any broker contract note/statement — the architecture (provider-adapter pattern, `ii_sources` reference rows) is extensible to these, but **no parser exists for any of them in R2**. A document evidencing one of these sources will not match either registered parser and will correctly resolve to `unsupported`/`reconciliation_required`, never silently treated as CAMS/KFintech.
- Scanned/image-only PDFs (no OCR in R2 — spec section 11 explicit non-goal).
- Any CAS layout variant materially different from the labelled-line grammar above (e.g., a genuinely different real-world CAMS/KFintech statement template not represented in the golden fixtures) may fail to detect or may partially parse with warnings — this is a known limitation of a first release with only synthetic fixtures, honestly disclosed, not claimed as "handles every real CAMS/KFintech PDF ever produced."
