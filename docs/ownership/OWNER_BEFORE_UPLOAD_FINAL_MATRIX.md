# Owner-before-upload -- final matrix

## DEV CERTIFICATION MATRIX (updated 07-10-2026; supersedes the "DEV browser tested" and "Production" columns of the 02-10-2026 tables below)

Columns per flow: **Code** (unit / route tests, PGlite), **Migration** (0236 on DEV, applied twice, backfill committed: PO grids), **DEV** (database and API agree, live), **Browser** (headless Chromium on the localhost app against DEV; not the PO's browser), **Oracle** (hand-written financial figure), **Cross-tenant** (answer identical to a random id), **Cleanup**, **Prod code**, **Prod DB**, **Prod upload**. "n/r" = not run live.

| Flow | Code | Migration | DEV | Browser | Oracle | Cross-tenant | Cleanup | Prod code | Prod DB | Prod upload |
|---|---|---|---|---|---|---|---|---|---|---|
| India CAS, Self | unit-tested | applied | PASS | PASS (upload gate, "Filed under") | -- | PASS | ledger | not confirmed | unknown, not read | OFF |
| India CAS, Spouse (real member) | unit-tested | applied | PASS | gate and add-member form in bank panel; CAS select shows member | -- | PASS | ledger | not confirmed | unknown | OFF |
| India CAS, Joint 60 / 40 | unit-tested | applied | PASS | PASS (labelled boxes, 95.00% message, 60 + 40 valid) | **1,000,000 = 600,000 + 400,000, never 2,000,000** | PASS | ledger | not confirmed | unknown | OFF |
| India CAS, Company / Trust / HUF | unit-tested | applied | PASS (10000 bp, personal register unchanged, publication refused) | n/r | personal register +0 | PASS (HUF: AU refused) | ledger | not confirmed | unknown | OFF |
| Per-folio owner conflict | unit-tested (+1 test for D6) | applied | PASS | **PASS (mobile 375 px, one folio then Select all)** | -- | PASS | ledger | not confirmed | unknown | OFF |
| Printed joint vs sole owner | unit-tested | applied | PASS | n/r | -- | PASS | ledger | not confirmed | unknown | OFF |
| Same file, different owner | unit-tested | applied | PASS (409; no leak) | n/r | -- | PASS | ledger | not confirmed | unknown | OFF |
| Bank CSV, Self / Spouse / Joint | unit-tested | applied | PASS | **PASS (panel: gate, options, upload, add member)** | -- | PASS | ledger | not confirmed | unknown | OFF |
| Bank CSV / PDF, SMSF (AU) | unit-tested | applied | PASS (attribution) | CSV: PASS; PDF: n/r | personal Expenses +0 (control +1,000) | PASS | ledger | not confirmed | unknown | OFF |
| Bank PDF, Self / Spouse / Joint | unit-tested | applied | PASS | n/r | -- | PASS | ledger | not confirmed | unknown | OFF |
| Bank, Company / Trust / HUF (refused) | unit-tested | applied | PASS (422, nothing stored) | n/r | personal totals +0 | PASS | ledger | not confirmed | unknown | OFF |
| Bank account picker (CSV and PDF) | unit-tested | applied | PASS | **PASS (CSV picker)** | -- | PASS | ledger | not confirmed | unknown | OFF |
| Account reassignment, race, currency, closed | unit-tested | applied | PASS | n/r | -- | PASS | ledger | not confirmed | unknown | OFF |
| Owner-change conflict on an account | unit-tested | applied | PASS | **PASS (No stores nothing; Yes changes, audited)** | -- | PASS | ledger | not confirmed | unknown | OFF |
| Payslip | unit-tested | applied | PASS (409 at approve; one income source) | owner gate only | -- | PASS | ledger | not confirmed | unknown | OFF |
| Liability | unit-tested | applied | PASS (409 at apply; one liability) | owner gate only | -- | PASS | **60 rows: PO SQL** | not confirmed | unknown | OFF |
| Retirement | unit-tested | applied | PASS (409 at account-match) | owner gate only | -- | PASS | ledger | not confirmed | unknown | OFF |
| AU investment (Joint 50 / 50) | unit-tested | applied | PASS | owner gate only | -- | PASS | ledger | not confirmed | unknown | OFF |
| Generic upload sessions | unit-tested | applied | PASS | n/r | -- | PASS | ledger | not confirmed | unknown | OFF |
| AIE bank intake and Accept | unit-tested | applied (`aie_document_intake.owner_selection`) | PASS (stored owner re-validated) | n/r | -- | PASS | ledger | not confirmed | unknown | OFF |
| AIE Investment Intelligence intake and Accept | unit-tested | applied | PASS | n/r | -- | PASS | ledger | not confirmed | unknown | OFF |
| Raw-file purge keeps owner | unit-tested | applied | PASS | -- | -- | -- | ledger | not confirmed | unknown | OFF |
| Malware admission before the identity reader | unit-tested | -- | PASS | -- | -- | -- | ledger | not confirmed | unknown | OFF |
| Reload / Back / keyboard / mobile | -- | -- | -- | **PASS (headless; not a screen reader)** | -- | -- | -- | -- | -- | -- |

Entity-owned bank statements, SMSF bank-transaction cash-flow integration and `institution_id` general ingestion remain the deferred capabilities named in the report; the matrix does not claim them.

---

# Owner-before-upload -- code-complete matrix (2026-10-02, kept as written)

Branch `feat/owner-before-upload-phase1-20261001` (merged with `origin/main` `bf5068c`, which contains the owner-edit branch, premium grants and the Net Worth NAV change). Companion: `OWNER_BEFORE_UPLOAD_FINAL_REPORT.md`.

**How to read it.** Every cell states what the CODE does and what has been PROVEN. "Tested" = unit / route / service / PGlite tests in this repository (named in the report). **No cell below claims DEV or production verification**: the DEV-browser and production columns are, for every flow, "not done" until the PO runs the protocol in the report. "Refused" is a deliberate, tested outcome (an owner is still demanded first; the document type simply cannot carry that kind of owner yet), never a bypass.

Legend: **Y** yes, **N** no / refused with a stated reason, **--** not applicable.

| Flow | Owner required before upload | Member (Self / Spouse / other) | Joint | Entity (Trust / Company / HUF) | SMSF |
|---|---|---|---|---|---|
| India CAS (`source-documents`) | **Y** -- 422 `owner_required` before the file is read | Y -- any active household member (any relationship) | Y -- percentages required, exactly 100.00% (10000 bp), members and/or entities | Y -- Trust, Company; **HUF only for an India-confirmed user** (authoritative profile country, never the request body) | N -- AU concept; not offered for a CAS |
| AU investment statement | **Y** | Y -- Self / Spouse | Y -- percentages required (members only) | N -- refused: must stay out of personal holdings until entity investment records exist | N -- SMSF holdings live in the SMSF section |
| Bank CSV | **Y** | Y -- Self / Spouse / Partner (a real member; no role-only "Spouse") | Y -- **no percentages**; counts 100% to the household (decision 3 limitation) | **N -- refused (PO-OBU-02)**: bank cash flow would flow into household spending / income | Y -- AU only (authoritative country) |
| Bank PDF | **Y** | same as Bank CSV | same | **N -- refused** | Y -- AU only |
| Payslip (`upload-sessions` + `payslip/.../approve`) | **Y** -- required to open the session | Y -- Self / Spouse only (income model records `self` / `spouse`) | N | N -- no entity income isolation | N -- an SMSF has no payslips |
| Liability (card / loan) | **Y** | Y -- Self / Spouse | Y -- no percentages | N -- entity debt must stay out of personal DTI / DSR | Y |
| Retirement (super / EPF / NPS) | **Y** | Y -- Self / Spouse (Retirement model members) | N | N | N -- managed in the SMSF section |
| AIE bank intake (`/api/aie/fdh-bank/intake`) | **Y** -- required before the body is read; stored on the intake | as Bank | as Bank | **N -- refused** | as Bank |
| AIE Investment Intelligence intake (`.../investment-intelligence/intake`) | **Y** -- a bare `owner_member_id` is no longer an owner | as India CAS | as India CAS | as India CAS | N |
| SMSF (as an owner) | -- | -- | -- | -- | Bank + Liability only (see rows above); records `owner_role = 'smsf'`, excluded from household totals |
| Company (as an owner) | -- | -- | may be a share in a CAS joint split | **India CAS + AIE II only**; refused everywhere else | -- |
| Family Trust (as an owner) | -- | -- | may be a share in a CAS joint split | **India CAS + AIE II only**; refused everywhere else | -- |
| HUF (as an owner) | -- | -- | may be a share in a CAS joint split | **India CAS + AIE II only, India-confirmed users only** | -- |

| Flow | Validator | Stored on the document | Stored on the canonical account / record | Allocation |
|---|---|---|---|---|
| India CAS | `validateOwnerSelection` (flow `ii_cas`) -> delegates who-may-be-owner to the canonical `ownerModel.validateOwnerSelection` | `ii_source_documents.owner_member_id / owner_business_entity_id / owner_role / owner_selection_source='user_selected' / owner_allocation / owner_review` (0236) | `ii_accounts.owner_member_id` (sole member) + active `ii_ownership_allocation` group (0153) for entity / joint, through the ONE writer `applyAccountOwnerChange` | basis points, 10000; entity-involved never published to personal Net Worth |
| AU investment | same (flow `au_investment`) | `fdh_statement_uploads.owner_*` incl. `owner_allocation` | `ii_accounts` via `auDocumentOwner` -> `setAccountOwner` -> the same ONE writer | basis points, 10000 |
| Bank CSV / PDF | same (flow `bank`) | `fdh_statement_uploads.owner_member_id / owner_role / owner_selection_source` | `fdh_financial_accounts.owner_role` (0207): written only if the account has none; an existing different owner needs explicit confirmation (409 first) | none |
| Payslip | same (flow `payslip`) | `fdh_statement_uploads.owner_*` | `fdh_payroll_events.income_owner` / `income_sources.owner` via the 0210 approve RPC; an approve naming another owner is refused | none |
| Liability | same (flow `liability`) | `fdh_statement_uploads.owner_*` | `liabilities.owner` via the apply RPC (`self` / `spouse` / `joint` / `smsf`); an apply naming another owner is refused | none |
| Retirement | same (flow `retirement`) | `fdh_statement_uploads.owner_*` | the matching `retirement_members` row (`member_type` self / spouse); a different member is refused (409) | none |
| AIE bank | same (flow `bank`), at intake **and again at accept** | `aie_document_intake.owner_selection` (0236 section F) -> then as Bank | as Bank, through `uploadBankPdf` with the owner (same guards) | none |
| AIE Investment | same (flow `ii_cas`), at intake and again at accept | `aie_document_intake.owner_selection` -> `ii_source_documents` as `user_selected` | as India CAS | basis points |

| Flow | Amendable afterwards | Cross-tenant tested | DEV browser tested | Production code deployed | Production upload enabled | Outstanding blocker |
|---|---|---|---|---|---|---|
| India CAS | **Y** -- owner dialogs / Resolutions (owner-edit branch, same writer); per-folio conflict confirmation | **Y** (`ownerBeforeUploadCrossTenant`, DB trigger proven in PGlite) | **N** | **N** (branch not merged) | **N** (`isFdhDocumentUploadEnabled()` untouched, fail-closed) | 0236 not applied; PO DEV pass |
| AU investment | Y -- through the II owner dialogs | Y | N | N | N | same |
| Bank CSV | Account owner: only by explicit confirmation at upload; the document owner is fixed (delete and re-upload) | Y (+ identical-file dedupe user-scoped, negative control) | N | N | N | same |
| Bank PDF | as Bank CSV | Y | N | N | N | same |
| Payslip | No -- delete and re-upload with the right owner | Y | N | N | N | same |
| Liability | via the existing Liabilities edit | Y | N | N | N | same |
| Retirement | via the existing Retirement edit | Y | N | N | N | same |
| AIE bank | as Bank | Y (owner validated against the caller's own household) | N | N | N | AIE flags default off; same |
| AIE Investment | as India CAS | Y | N | N | N | same |
| SMSF / Company / Trust / HUF (as owners) | per the rows above | Y | N | N | N | **ENTITY BANK CASH-FLOW SEPARATION** (deferred, see report section 8) for entity banks |

## Flows deliberately outside this programme (so nothing is silently missing)

- **Insurance AIE intake** -- not a financial-document class here; it has its own required `ownerHouseholdRole` at accept (unchanged).
- **`/api/aie/intake` (generic, `source_module_hint`)** -- it registers no domain adapter, so a run from it can never reach a canonical bank / investment write (`accept` refuses `unsupported_adapter`); the hint is metadata, not routing.
- **`tax_document` / `other` upload sessions** -- no financial canonical effect, so no owner is asked (`OWNER_FLOW_FOR_DOCUMENT_TYPE` = null; asserted by test).
- **Legacy AIE intakes created before this change** carry no owner and are **refused at accept** with an actionable message (re-upload with an owner). No silent default.
