# FDH-12 — Australian Superannuation Statement Coverage

Spec sections 8, 82-85. **Release-1 coverage honesty (spec section 83).**

## What is actually certified

FDH-12 ships **four fund-neutral CSV layouts**. Each is a documented,
explicit column-name contract, exercised against real fixtures by
`tests/unit/fdh12AuSuperStatements.test.ts` (66 tests).

| Adapter id | Kind | Required headers | State |
| --- | --- | --- | --- |
| `fdh12_generic_retirement_transaction_csv_v1` | transaction | `Date`, `Description`, `Amount` | **CERTIFIED** |
| `fdh12_generic_retirement_summary_csv_v1` | summary | `Item`, `Amount`, `Period` | **CERTIFIED** |
| `fdh12_generic_retirement_holdings_csv_v1` | holdings | `Investment Option`, `Market Value` | **CERTIFIED** |
| `fdh12_generic_epf_passbook_csv_v1` | transaction (IN) | `Date`, `Particulars`, `Amount` | **CERTIFIED** |

Optional columns are tolerated in any order: `Type`, `Employer`,
`Period Start`, `Period End`, `Balance`, `Asset Class`, `Units`, `Unit Price`,
`Valuation Date`.

## Named Australian super funds — the honest matrix

Spec section 82 lists candidate providers to research. **FDH-12 Release 1
certifies none of them**, because certifying a named fund requires a real
fixture of that fund's real export, which this phase did not have. No adapter
in the registry carries an `institutionCode`.

| Fund | Coverage state |
| --- | --- |
| AustralianSuper | MANUAL_MAPPING_REQUIRED |
| Australian Retirement Trust | MANUAL_MAPPING_REQUIRED |
| Hostplus | MANUAL_MAPPING_REQUIRED |
| Aware Super | MANUAL_MAPPING_REQUIRED |
| UniSuper | MANUAL_MAPPING_REQUIRED |
| REST | MANUAL_MAPPING_REQUIRED |
| HESTA | MANUAL_MAPPING_REQUIRED |
| CBUS | MANUAL_MAPPING_REQUIRED |
| Colonial First State super | MANUAL_MAPPING_REQUIRED |
| AMP super | MANUAL_MAPPING_REQUIRED |
| Mercer | MANUAL_MAPPING_REQUIRED |
| Any other provider | MANUAL_MAPPING_REQUIRED |

A file matching one of the four generic contracts is read regardless of which
fund produced it. A file that does not is MANUAL_MAPPING_REQUIRED — never a
confident wrong extraction.

## What the UI says

The upload form states: *"CSV exports only in this release. PDF statements and
scanned documents cannot be read automatically yet — you can still add or
update the account manually."* It does not say "all Australian super funds
supported", because that is not true.

## CSV and PDF (spec section 84)

* **CSV** — supported, via the shared FDH intake (`bank-csv/csv.ts`): encoding
  detection, delimiter detection, header location, safety limits.
* **PDF** — **not supported**. A PDF upload fails with
  `pdf_manual_mapping_required` and a message naming the alternative. It never
  produces a $0 balance.
* **OCR** — **not claimed anywhere.** The `ocr_required` extraction status
  exists in the vocabulary for a future phase; nothing sets it today, which is
  disclosed rather than presented as coverage.

## A documented platform constraint

The summary layout requires **three** columns (`Item`, `Amount`, `Period`)
rather than the obvious two. The shared `findHeaderRowIndex` requires at least
two delimiters before accepting a line as a header — a heuristic that protects
every other importer from mistaking a preamble line such as
`Statement for, John Smith` for a header. FDH-12 adapts to it rather than
weakening it, and the third column is independently useful: it states
period-vs-YTD outright instead of inferring it from label text.

## Fail-safe behaviour (spec sections 85, 94, 143, 145)

| Input | Result |
| --- | --- |
| Unrecognised header | `MANUAL_MAPPING_REQUIRED` |
| Two layouts within the confidence gap | `AMBIGUOUS` |
| Malformed amount on a row | Row SKIPPED + warning. Never `0.00`. |
| Malformed date on a row | Row kept, date null. Never fingerprinted or matched. |
| No row parsed at all | FAILURE, never an empty success |
| Ragged column counts | Delimiter detection refuses the file |
| Absent figure | `undefined` → UI renders "Not shown on statement", never `$0` |
