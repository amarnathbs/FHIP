# II-PC3-C1 — Real CAMS Variant: Authoritative Structural Fingerprint

Status: AUTHORITATIVE — supersedes `II_PC3_CAMS_STRUCTURAL_FINGERPRINT.md` (the pre-real-sample, reverse-engineered "detailed_v1" fingerprint) as the spec driving fixture design for the REAL CAMS variant. Extends `II_PC3_GATE_A_REAL_STRUCTURAL_COMPARISON.md` (13-row property comparison, zero real values) with the one structural detail that pass did not fully characterize: the exact abstract grammar of Stamp Duty / STT rows.

Direction of truth for everything in this document: **REAL CAMS statement -> this fingerprint -> synthetic fixture -> parser**, never the reverse. Every fact below is an abstract structural property (a grammar shape, a boolean, a count, a redacted token pattern) — zero real names, PAN, folios, amounts, unit counts, NAV, balances, bank details, emails, or phone numbers appear anywhere in this document, consistent with the safety discipline the source task and the prior Gate A pass were both built under.

## 0. Source and method for this update

The real statement (already inspected once for Gate A) was re-opened for ONE narrow, additional confirmation: whether Stamp Duty / STT line items are (a) a standalone transaction-table row, (b) an attribute folded onto an adjacent purchase/redemption row, or (c) evidence-only text with no materialized transaction data. The file was decrypted in-memory via a one-off Python/`pypdf` script; the script never wrote the decrypted PDF, any extracted full text, or any real value to disk. Every line examined was passed through a whitelist-based redaction function before being read: digit runs were masked to `#`, and every word NOT already a known-safe structural/label token (from the vocabulary Gate A already disclosed — `Date`, `Amount`, `Stamp`, `Duty`, `STT`, `Purchase`, etc.) was masked to `<TOKEN>`. Only these redacted shapes were read. The script and its output were never committed; the script file was deleted immediately after this confirmation.

## 1. PDF layer

- **Encryption**: Standard security handler, `/V 2` / `/R 3` — RC4, 128-bit key. Same algorithm family as the existing Q02 fixture (RC4, Standard handler), differing only in key length — invisible above the extraction boundary.
- **Text-layer availability**: genuine embedded text layer (not scanned/image-only); extractable directly, no OCR needed.
- **Extraction ordering**: column-major table content extracts as left-to-right, top-to-bottom whitespace-joined lines, consistent with `pdf-parse`'s usual behavior for this table style — the same caveat Gate A disclosed (extraction engine differences between `pypdf` and `pdf-parse` could reorder whitespace, but the label vocabulary mismatches found are large and multi-axis, not whitespace noise).
- **Page-break behavior**: transaction tables continue raw across a page boundary with **zero header/label reprint of any kind** (confirmed at two of six page boundaries in the real document) — the opposite of the "detailed_v1" fixture assumption that a continued scheme reprints its full label block.

## 2. Statement header / title pattern

Two separate, non-adjacent lines: a system-generated tracking/version-stamp line (contains "CAMS" only as a substring of a longer product code), then a separate line reading only `Consolidated Account Statement`. The literal word "CAMS" never immediately precedes "Consolidated Account Statement" anywhere in the document.

## 3. Investor block labels/order

Only `Folio No:` and `PAN:` are present, as their own labelled lines, per folio. `Name:` and `Holding Mode:` never appear anywhere in the document (0 occurrences of either label across all pages examined).

## 4. AMC transition grammar

No `AMC Name:` label exists anywhere (0 occurrences). Fund-house identity is only recoverable from a page-1 portfolio-summary table (`<fund house> Mutual Fund <cost> <value>` rows), never from a labelled line immediately preceding a scheme block. This is a disclosed, out-of-scope gap for `amcName` attribution in the alt-layout parsing path (unchanged from the prior Gate A fix) — a real "AMC transition" in this grammar is observable only as an implicit change in the free-text scheme-heading line's content, never a nameable, labelled event.

## 5. Folio grammar

`Folio No: <value>` on its own line, label-recognisable. Some folio lines carry a `/ <digits>` suffix (a sub-account/scheme-code suffix) appended after the base folio value — captured verbatim as part of the folio string, not separately parsed, and does not break the label match.

## 6. Scheme/ISIN grammar (the folded free-text line)

One free-text line per scheme, not four labelled lines: scheme/plan/option text, then `- ISIN: <code-or-blank>(Advisor: <code>)`, then `Registrar : <name>`, all on a single line. The parenthetical is labelled `Advisor:` (a distributor/ARN-style field) — never `AMFI Code:`, which does not exist anywhere in this layout.

## 7. Transaction header/column order

Literal extracted header: `Date Amount PriceUnitsTransaction ... Unit[-Balance]` — column set/order is `Date, Amount, Price, Units, Transaction[-type], Unit[-Balance]`. No `Description` column exists anywhere in this layout's transaction tables.

## 8. Transaction row grammar (date/amount/price/units/type, sign convention)

Two distinct row shapes coexist in the same table, distinguished by field count, not by a different header:

- **Full economic row** (Purchase, SIP, Redemption, Switch In/Out, Dividend, Reinvestment, STP, SWP, Merger): `<Date> <Amount> <Price> <Units> <Transaction-type-text> <Unit-Balance> [optional Ref]` — 6 populated fields plus an optional trailing reference marker. Confirmed present for all of these vocabulary categories at least once in the real document.
- **Fee/tax row** (Stamp Duty; see section 9 for STT's caveat): a materially SHORTER row — `<Date> <Amount><attached-marker,no-space> <Type-label ("Stamp Duty")> <trailing-marker>` — confirmed via redacted-shape inspection as exactly 5 whitespace-separated tokens: Date, Amount(with a non-numeric marker glyph attached directly to the amount with no separating space — a footnote/disclosure-note reference symbol, not part of the numeric value itself), "Stamp", "Duty", a trailing marker token. **No Price field, no Units field, and no trailing Unit Balance field exist on this row shape at all** — confirmed by directly comparing token counts against the immediately adjacent full economic rows (10-11 tokens) sharing the same date. Sign convention: amount is a plain positive value (a cost/deduction, never expressed as negative or parenthesised in the observed occurrences); no unit or NAV impact is expressed on the row itself.
- Both row shapes appear interleaved within the SAME transaction table for the SAME scheme/date grouping — a fee/tax row is not a separate table or section.

## 9. Stamp Duty and STT structural representation (this section's primary new finding)

- **Stamp Duty**: materializes as 95 real standalone transaction-table rows in this statement, following the fee-row grammar in section 8 exactly — confirmed present, repeatedly, directly adjacent to (same-date as) "Investment Purchase"-type full economic rows. Classification: **STANDALONE_ROW, amount-only, zero units/price/balance fields**.
- **STT**: the literal token "STT" occurs exactly ONCE in the entire document, and that single occurrence is inside an explanatory/disclosure footer paragraph (describing the STT rate and when it is deducted, e.g. "at the date of redemption or switch"), **not** as an actual transaction-table row anywhere in this statement. Classification for THIS document: **EVIDENCE_ONLY / NOT_MATERIALIZED_IN_THIS_STATEMENT** — this specific real sample contains zero live STT transaction rows to confirm a row grammar against directly.
- **Inference, clearly labelled as inference, not observation**: because Indian mutual-fund STT and stamp duty are the same class of SEBI-mandated transaction-level charge, introduced under the same regulatory regime, and this statement's own disclosure text describes STT using the same "deducted at the date of transaction" framing as stamp duty, it is reasonable to expect that an STT row, if and when one is materialized in some other real statement, would follow the SAME standalone amount-only row grammar as Stamp Duty (section 8). This fingerprint records this explicitly as an inference so the qualification pack can build a representative fixture without overclaiming direct observation of a real STT row.
- **Structural conclusion driving the parser fix**: the currently-coded `ALT_TXN_ROW_RE` (added in the prior Gate A follow-up fix, commit `6a07bb3`) requires Amount, Price, AND Units fields plus a trailing Unit Balance field — it assumed every alt-layout row, including fee/tax rows, carries the full 6-field shape (that assumption was itself built defensively, before this confirmation, using `0.0000`/`0.000`/unchanged-balance placeholders that are NOT what the real document contains). This confirmation proves that assumption wrong for the real fee-row shape: a genuine Stamp Duty (or, by the inference above, STT) row will NOT match `ALT_TXN_ROW_RE` at all, because it structurally lacks the Price/Units/Balance fields that regex requires. This is the golden-fixture gap Phase 2 targets.

## 10. Balance/closing-line grammar

`Closing Unit Balance: <units> Total Cost Value: Rs. <value>` — no "as on `<date>`" clause, no "Valuation" word, no "NAV as on" clause. Zero of the closing-balance-looking lines found in the document (17 candidates checked) match the "detailed_v1" `CLOSING_RE`. Already handled by `ALT_CLOSING_RE` (falls back to statement period end as the as-of date, never fabricated).

## 11. Continuation behavior (no header reprint)

Covered in section 1 — confirmed at two real page boundaries: a transaction row on one page is followed immediately by another transaction row on the next page with no intervening header, label, or scheme-identity reprint of any kind. The already-coded alt-layout parsing path handles this correctly today (no explicit "continuation" logic is needed beyond `inTable` never being reset by anything that doesn't appear between the pages) — reconfirmed structurally sound for the fee-row fix too, since a fee row's shorter grammar does not touch `inTable`/state-reset logic at all.

## 12. Footer

Contains explanatory/disclosure prose (fee-rate methodology, STT/stamp-duty applicability notes, standard CAMS/AMFI boilerplate) — non-tabular, free text, never contributes transaction or holding data itself. The single real "STT" token in the whole document lives here (section 9).

## 13. "No activity this period" / placeholder folios

Unchanged from the prior Gate A finding: a literal placeholder sentence appears in place of a transaction table for folios/schemes with zero activity in the statement window (confirmed 7 times in this document). Already handled by `NO_ACTIVITY_RE`.

## Structural-match tracking (13 properties total, sections 1-13 above)

This table is the authoritative match matrix this task's final verdict cites (target: "x/13 materially complete, no unexplained mismatch"). "Handled" means the current parser (after this task's Phase 2 fix) correctly processes the real grammar; it does not mean every possible value shape within that grammar has been fixture-tested to exhaustion.

| # | Property | Handled by parser after this task's Phase 2 fix? |
|---|---|---|
| 1 | PDF layer (encryption/text-layer/extraction/page-break) | YES — encryption is invisible above the extraction boundary; page-break behavior is structurally correct by construction (no continuation logic needed) |
| 2 | Header/title grammar | YES (`TITLE_ALT_LINE_RE`, from the prior Gate A fix) |
| 3 | Investor block (Folio/PAN only) | YES (already worked; `parseAccounts` never required Name:/Holding Mode:) |
| 4 | AMC transition grammar | **NO — disclosed, out-of-scope gap.** `amcName` stays at its `''` default for this layout; a real AMC transition is not nameable in this grammar without cross-referencing the page-1 summary table, which no fixture in this pack attempts |
| 5 | Folio grammar | YES (`Folio No:` label match; the `/ <digits>` suffix nuance is captured verbatim, not separately parsed — a non-blocking value-shape nuance) |
| 6 | Scheme/ISIN folded line | YES (`ALT_SCHEME_LINE_RE`, from the prior Gate A fix) |
| 7 | Transaction header/column order | YES (`ALT_TXN_HEADER_RE`, from the prior Gate A fix) |
| 8 | Full economic transaction row grammar | YES (`ALT_TXN_ROW_RE`, from the prior Gate A fix) |
| 9 | Fee/tax (Stamp Duty/STT) row grammar | YES, after this task's Phase 2 fix (new `ALT_FEE_ROW_RE`) — see the golden-fixture RED/GREEN account below |
| 10 | Closing-balance grammar | YES (`ALT_CLOSING_RE`, from the prior Gate A fix) |
| 11 | Page-continuation, zero header reprint | YES (structurally correct by construction — no explicit "continuation" branch needed) |
| 12 | Footer/disclosure text | YES (non-tabular; correctly ignored — never mistaken for a data row, confirmed by construction since it does not match any table-entry regex) |
| 13 | "No activity this period" placeholder | YES (`NO_ACTIVITY_RE`, from the prior Gate A fix) |

**12/13 materially complete after this task's fix; property #4 (AMC-name attribution) remains the one honestly disclosed, deliberately out-of-scope structural gap** — carried forward unchanged from the prior Gate A pass's own disclosure, not newly discovered here, and not a parser defect (the parser correctly leaves `amcName` at its pre-existing default rather than guessing).
