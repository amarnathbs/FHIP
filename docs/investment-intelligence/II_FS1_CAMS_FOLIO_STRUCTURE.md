# II-FS1 — CAMS-Serviced Individual Folio Statement: Structural Fingerprint

## Provenance and scope of this document

This document is a **privacy-safe structural reference only**. It was authored
directly from the FS1 dispatch's own structural description (dispatch sections
0 and 8), which the Product Owner has already sanitized of all real investor,
folio, bank, PAN and transaction values before handing it to this task.

This task (II-FS1 implementation) had **no access** to the genuine CAMS-serviced
individual folio statement PDF, its password, or any decrypted/extracted text
from it. Nothing in this document, in the synthetic fixtures built from it, or
in any commit on this branch originates from the real document's actual values.

Where the dispatch's structural description leaves nuance unspecified (exact
column widths, exact label punctuation/casing, exact page layout, whether a
given field is always present vs conditionally present), that gap is recorded
honestly below rather than guessed at with false confidence. Implementation and
fixtures target the structural concepts described, using representative
synthetic label text and formatting that a human operator separately confirmed
(outside this task) to be structurally consistent with the real document.

**Do not** add real values to this file. **Do not** attempt to locate, request,
or reconstruct the real PDF or its password from within this task.

---

## Document identity

```
FOLIO NUMBER : <value>
FOLIO DETAILS
```

- `FOLIO NUMBER` appears as a labeled field with a colon-delimited value.
- `FOLIO DETAILS` appears as a section/page heading string.
- Exact whitespace around the colon is not confirmed beyond "colon-delimited
  with a value following" — detector signals below tolerate optional
  whitespace variation (`FOLIO NUMBER\s*:`).

## Investor block

Labels present (values are investor PII in the real document — never
persisted or reproduced in fixtures):

- Name
- Address
- Mobile
- Email
- Second Holder
- Third Holder

Gap: exact block heading text (e.g. whether it is literally titled
"Investor Details" or unlabeled) is not confirmed by the dispatch text beyond
"investor details" being present conceptually. Detector/parser do not depend
on an exact investor-block heading.

## Bank / account metadata block

Labels present:

- Bank
- Branch
- Bank A/c.
- Account Type
- IFSC
- Payment Mode
- Mode of Holding
- Tax Status
- Nominee
- Distributor/RIA

Recorded as **labels only** per dispatch instruction. No real bank/account
values are known or stored anywhere in this task's artifacts.

## Compliance metadata

PAN/KYC/Aadhaar/FATCA/UBO-style fields may appear structurally. No real values
are known. Per dispatch sections 26–27, these are explicitly out of FS1 scope
for structured persistence — data minimisation applies.

## Summary of Holdings

Structural columns (concepts, not confirmed exact header text):

- Scheme Name
- Cost of Investment Amount
- Unit Balance
- NAV date
- NAV
- Market Value

Per dispatch section 16, "Cost of Investment" is treated as AMC-reported
informational/aggregate evidence only — never converted into a fabricated tax
lot or acquisition cost.

## SIP Registration

Structural columns:

- Scheme
- From Date
- To Date
- Frequency
- SIP Date
- Amount
- Debit Bank
- Distributor

Per dispatch section 25, this section is a **mandate/registration**, not a
cashflow record. It must never generate synthetic future or past transactions.

## Multiple Bank Details

Present structurally as a section listing more than one registered bank/payout
account. No real values known.

## Financial Transactions

Scheme header line structurally includes:

```
<scheme code/name> ... ISIN CODE : <value>
```

Transaction table column grammar (order per dispatch, not assumed to be a
fixed pixel layout — parsed from extracted-text token order, not visual
position):

```
DATE | TRANSACTION TYPE | Amount | NAV | PRICE | UNITS | BALANCE UNITS
```

Gap: the dispatch does not specify whether "NAV" and "PRICE" are always two
distinct populated columns or whether one is sometimes blank/derived; the
parser treats them as two independently-parsed optional numeric fields rather
than assuming a fixed relationship.

### Transaction details

- `Opening Balance` may appear as the first row of a scheme's transaction
  table. Per dispatch section 17, this is **never** treated as a purchase,
  acquisition, or tax lot.
- Transaction rows may include: Purchase, Systematic Instalment, Redemption,
  Dividend / Reinvestment, Switch (In/Out), and similar CAMS-standard wording.
- Supplemental lines may include: `Gross Amount`, `Stamp Duty Charges Levied`,
  `STT`, `Remarks`, and exit-load text embedded in Remarks.

Gap: the dispatch does not give the exact real-world wording CAMS uses for
every transaction-type string (e.g. exact capitalisation of "Systematic
Investment" vs "Systematic Instalment" vs "SIP"). Fixtures use CAMS-standard
wording consistent with the existing certified CAS parser's known type
vocabulary (extended, not replaced) and route anything not recognized to
`UNCLASSIFIED / REVIEW` rather than guessing a mapping.

## Non-financial pages

The same PDF may also contain:

- A **Financial Transaction (application) Form** page — containing labels
  such as "Purchase", "Redemption", "Switch", "Scheme Name", "Amount",
  "Units", "Date" as blank/form field labels, not populated transaction rows.
- **Terms & Conditions** pages — containing dates, percentages (e.g. exit-load
  rates), and transaction terminology in prose form.

Per dispatch sections 20–21, neither of these may be scoped into transaction
extraction. The parser must bound extraction strictly to the identified
Financial Transactions section per scheme, not to "any page containing
transaction-shaped words."

---

## Signals used for fail-closed detection (dispatch section 9)

Candidate multi-signal fingerprint (weighted, not single-marker):

- `FOLIO NUMBER\s*:` present
- `FOLIO DETAILS` present
- `SUMMARY OF HOLDINGS` present
- `FINANCIAL TRANSACTIONS` present
- `ISIN CODE\s*:` present (per-scheme header)
- `Statement Date\s*:` present
- Absence of CAS-only structural evidence (e.g. multi-folio/multi-AMC
  consolidated banner text, cross-AMC portfolio summary) that the existing
  certified CAS detector already keys on

No single marker (e.g. the bare string "FOLIO NUMBER") is sufficient — see
detector implementation and negative fixtures (FS-Q against generic PDFs
containing the word "folio").

## Known documentation gaps (honesty disclosure, dispatch section 3 compliance)

1. Exact section heading capitalisation/spacing beyond what is quoted in the
   dispatch is not independently confirmed.
2. Exact numeric formatting conventions (thousands separators, decimal
   places, currency symbol placement) are not confirmed beyond "Amount / NAV
   / PRICE / UNITS / BALANCE UNITS are numeric fields" — parser numeric
   parsing reuses the existing certified CAS numeric-parsing utilities rather
   than inventing new assumptions.
3. Exact date format (DD-Mon-YYYY vs DD/MM/YYYY vs other) is not separately
   confirmed for this document type — parser reuses the existing certified
   CAS date-parsing utility, which already tolerates the CAMS-standard
   `DD-Mon-YYYY` form; any format actually encountered outside that tolerance
   surfaces as a structured parse error rather than a silent guess.
4. No independent confirmation of whether Stamp Duty / STT lines are
   per-transaction attributes or separate supplemental rows — both are
   supported defensively (see FS-Q08), but only the form(s) that reconcile
   against known CAS supplemental-line handling are treated as certified.

This document will be revisited if the Product Owner supplies additional
sanitized structural detail in a future dispatch.
