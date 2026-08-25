# FDH-9 — Reuse & Gap Audit

Spec sections 8-9. Written **before** any code or UI change, against canonical
`main` at `100d854` (highest migration on main: `0085_fdh8_split_approval_gate_fix.sql`).

Every statement below was verified by reading the real source tree / real DEV
database, not by trusting a prior report.

---

## 1. Canonical Income domain — current state

### 1.1 The canonical table

`income_sources` (created `0003_module2.sql`, extended `0004_financial_data_grid.sql`,
`0008_module6_resilience.sql`). **Verified against the live DEV database** on
2026-08-25 — DEV returns exactly these 16 columns, so the migration chain and the
deployed schema agree:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `user_id` | uuid not null → `auth.users` | ownership is per-USER, not per-household |
| `source_name` | text not null | the grid's `nameField` |
| `income_type` | text not null | `salary\|business\|rental\|investment\|other` |
| `amount` | numeric(18,2) ≥ 0 | **GROSS** — labelled "Gross Amount" in the grid |
| `frequency` | text not null | `weekly\|fortnightly\|monthly\|quarterly\|annually\|one_off` |
| `currency_code` | char(3) → `currencies` | `AUD\|INR` per the Zod schema |
| `is_active` | boolean | soft-delete flag; DELETE archives rather than removes |
| `created_at` / `updated_at` | timestamptz | `updated_at` set in the APP layer, not by a trigger |
| `owner` | text not null default `self` | role enum, **not** a `household_members` FK |
| `master_item_key` | text | null = user-defined custom row; `unique(user_id, master_item_key)` |
| `net_amount` | numeric(18,2) ≥ 0 | optional |
| `is_taxable` | boolean not null default true | |
| `notes` | text | |
| `employer_name` | text | already exists — added by `0008` |

**There is NO `start_date`, NO `end_date`, and NO `household_member_id`.**
Spec section 23 explicitly forbids inventing fields the Income model lacks, so
the FDH-9 proposal maps **only** the columns above. "Start date / observed
period" from the spec's *possible* field list is deliberately **not** proposed —
the canonical model has nowhere to put it. Pay-period evidence stays on the
payroll event, where it belongs.

### 1.2 Income APIs

- `app/api/income/route.ts` — `GET` (list active), `POST` (create/upsert)
- `app/api/income/[id]/route.ts` — `PATCH` (partial update), `DELETE` (archive)

All four go through `makeRegistry('income_sources')`
(`lib/services/registry.ts`) and are validated by `incomeSchema`
(`lib/validation/income.ts`). Every call is scoped `.eq('user_id', userId)` on
top of RLS.

`registry.save()` upserts on `(user_id, master_item_key)` when a master key is
present — this is what stops a re-ticked master row from duplicating. Custom
rows (null master key) always INSERT, because Postgres never matches NULL to
NULL.

**Observation (not changed by FDH-9):** `registry.update()` sets `updated_at`
explicitly; `registry.save()` does not. Migration `0049`'s header records the
house convention — "No DB-level `updated_at` trigger convention exists; every
existing service sets `updated_at` explicitly in the application layer". FDH-9
therefore does **not** rely on `updated_at` as its staleness token (see §5.3);
it compares actual field values instead, which is correct regardless of write
path. Introducing an `updated_at` trigger was considered and rejected as
inconsistent with the rest of the schema.

### 1.3 Income UI / manual-entry workflow

`app/(app)/income/page.tsx` is eight lines: it renders
`<FinancialDataGrid config={incomeGridConfig} />`. The grid
(`components/grid/FinancialDataGrid.tsx`, 854 lines) is shared by all seven
Input Data registers. Income's config (`lib/grid/configs.ts`) declares fields
Gross Amount / Net Amount / Frequency / Taxable / Employer / Notes.

Manual entry = tick a master item (or add a custom row), fill the fields, save.
**FDH-9 does not alter this path in any way** (spec section 49, FAIL condition
"manual Income entry is removed").

### 1.4 Existing ownership / audit

Ownership: `income_sources.user_id` + RLS. There is no household-level income
sharing. `financial_records_audit` (0003) exists but is shaped for
data-change audit keyed by the data owner, with no before/after snapshot — it
is **not** reused for the bridge, for the same reason Resources R1.1 declined
to reuse it (migration `0049` header). FDH-9 records its own before/after apply
audit.

---

## 2. Existing precedent: canonical-register writes are NOT new

Investment Intelligence R3 (migration `0042_ii_r3_fhip_publishing_bridge.sql`)
already writes a canonical Input Data register (`investments`) from a
certified upstream engine, under an explicit publish action. It added:

```
alter table investments add column source_type text not null default 'manual'
  check (source_type in ('manual', 'investment_intelligence_published'));
alter table investments add column ii_publication_id uuid references ii_fhip_publications(id);
alter table investments add column pre_publication_manual_snapshot jsonb;
```

and `FinancialDataGrid.tsx` already renders a provenance badge plus
direct-edit protection for published rows
(`II_PUBLISHED_PROTECTED_FIELDS`).

**FDH-9 follows this established precedent rather than inventing a new one** —
`income_sources.source_type` mirrors `investments.source_type` exactly (spec
section 51). The difference is that FDH-9 generalises the *proposal* half,
which R3 hard-coded to investments (see §4).

---

## 3. FDH engine chain — what FDH-9 reuses unchanged

| Capability | Where it already lives | FDH-9 usage |
|---|---|---|
| Secure upload session + storage + purge | `services/uploadLifecycle.ts` (`createUploadSession`, `completeUpload`), `services/storage.ts`, `services/purge.ts` (FDH-3, migration `0058`) | **Reused verbatim.** No second uploader, bucket or lifecycle (spec section 12). |
| Document audit trail | `services/auditLog.ts` → `fdh_document_audit_events` | Reused; FDH-9 widens the event-type vocabulary additively. |
| PDF native text extraction, per page | `bank-pdf/textExtraction.ts` (`extractPdfPages`) (FDH-5) | **Reused verbatim** — no second PDF engine (spec section 14). |
| OCR boundary | `bank-pdf/ocr.ts`; error codes `ocr_required` / `ocr_failed` already allocated | Reused. FDH-9 claims **no** scanned-payslip support (spec section 15). |
| Exact money arithmetic | `domain/money.ts` (`toMinorUnits`, `sumMoney`, `moneyEquals`) | **Reused verbatim** — this is what makes a `0.01` discrepancy detectable (spec section 19). |
| Bank transactions | `fdh_transactions` (FDH-1 `0047`), classified by R8 | **Read-only.** FDH-9 parses no bank activity (spec section 20). |
| Review / approval workflow | `domain/approvalPolicy.ts`, `fdh_review_items`, FDH-7 `0076` | Reused; payroll uncertainty raises ordinary review items. |
| Same-tenant integrity triggers | migration `0058` `fdh3_assert_*_owner()` | **Pattern copied** for every new FDH-9 relationship (spec section 46). |
| Clean-rebuild + RLS harness | `scripts/db-rebuild-check/` (PGlite = real PostgreSQL 18) | Reused for FDH-9 certification. |

### 3.1 The schema already anticipated payslips

No new vocabulary was needed for any of these — they were shipped by FDH-1/FDH-2
and have been sitting unused:

- `FDH_DOCUMENT_TYPES` already contains **`payslip`**
- `FDH_EVIDENCE_TYPES` already contains **`payslip_document`**
- `FDH_REVIEW_TYPES` already contains **`income_evidence`**
- `FDH_TRANSACTION_TYPE_HINTS` already contains **`salary_candidate`**
- `FDH_INSTITUTION_TYPES` already contains **`payroll_source`**

FDH-9 uses each of these as-is.

---

## 4. THE GAP — there is no generic import-proposal architecture

This is the substantive finding of the audit.

Two engines now need to put structured evidence into a canonical register:
Investment Intelligence (R3, shipped) and FDH-9 (this phase). R3 solved it
**specifically for investments**: `ii_fhip_publications` carries
`instrument_id`, `risk_band`, `cost_base_status`, `published_annual_contribution`
— an investment-shaped record that Income, Expenses, Liabilities or Retirement
could never reuse.

Spec section 7 forbids FDH-9 repeating that mistake in the other direction
(`if payslip approved: update income table`), and FAIL condition 78 names
"the bridge becomes a one-off hard-coded payslip→Income hack" explicitly.

**Gap:** no `Structured evidence → Proposal → Compare → User decision → Apply`
primitive exists at platform level.

**Decision:** FDH-9 builds it, generic, in `lib/import-bridge/` and
`fhip_import_*` tables, with Income as the **first adapter**. Rationale:

1. `target_domain` is a column, not a table name. Adding Expenses later is a
   new adapter + a new enum value, not a new schema.
2. The compare/diff/selected-field/stale/idempotency machinery is
   domain-agnostic and lives once.
3. FDH-15 then becomes a governance certification over an existing pattern,
   exactly as spec section 7 requests.

### 4.1 Why the bridge lives OUTSIDE `lib/financial-data-hub/`

`tests/unit/fdh1Isolation.test.ts` mechanically enforces that **no file under
`lib/financial-data-hub/` may name `income_sources`** (`FHIP_PROTECTED_INPUT_TABLES`),
may call `makeRegistry`, or may query a protected register. Those guards are
scoped to `lib/financial-data-hub` and to migrations `0045`-`0048` (frozen).

Putting the bridge in `lib/import-bridge/` is therefore **both** the correct
architecture (it is a platform service serving five future domains, not an FDH
internal) **and** keeps every FDH-1 isolation guarantee mechanically intact and
untouched. FDH-9 changes none of those tests.

The split is:

```
lib/financial-data-hub/payslip/   payslip -> payroll evidence   (FDH domain, never names income_sources)
lib/import-bridge/                payroll evidence -> proposal -> Income  (platform bridge)
```

---

## 5. Gaps FDH-9 must close, and how

### 5.1 No payroll event exists
Nothing in the schema models a pay run. New: `fdh_payroll_events` (header +
totals + YTD kept **separately**, spec sections 16/35) and
`fdh_payroll_components` (per-line detail, so India's varied Basic/HRA/DA/
special-allowance layouts and AU's allowance lines do not require 40 bespoke
columns, spec section 18).

### 5.2 No payslip parser
New, and genuinely new work: `lib/financial-data-hub/payslip/`. Layout
intelligence is payslip-specific; the PDF *engine* underneath is FDH-5's,
unchanged.

### 5.3 No staleness concept
The canonical Income row has no version column and no reliable `updated_at`
(see §1.2). FDH-9 detects staleness by **value comparison**: the proposal
snapshots each field's existing value at generation time; apply re-reads the
row and refuses if any *selected* field has since changed. This is sound
regardless of which write path edited the row, and is what spec section 48
asks for.

### 5.4 No duplicate-apply guard
New: `fhip_import_applications` with `unique(proposal_id)` — re-applying the
same approved proposal is refused **by the database**, not only by code
(spec section 34).

### 5.5 No income provenance
New: `income_sources.source_type` (`manual` | `payslip_import`) mirroring
`investments.source_type`, plus a nullable link to the application record
(spec sections 41, 51).

---

## 6. Things FDH-9 deliberately does NOT do

- Does **not** rebuild bank-statement import (spec section 3) — the FDH-3 →
  R7/FDH-4 → FDH-5 → R8 → FDH-6 → FDH-7 → FDH-8 chain stays exactly where it is.
- Does **not** touch the India Investment module (spec section 4).
- Does **not** create/update retirement balances from super/PF/NPS lines
  (spec section 37) — extracted, held as evidence, never written.
- Does **not** calculate annual tax liability, and never puts tax withheld into
  an Income amount (spec section 36).
- Does **not** claim scanned-payslip/OCR support (spec section 15).
- Does **not** remove any existing route (spec section 55) — see
  `FDH_CONTEXTUAL_IMPORT_ARCHITECTURE.md` §5 for the audit of existing
  specialist routes.
- Does **not** modify FDH-8 headline income (spec section 53).

---

## 7. Migration number

Claimed numbers at time of writing, verified by scanning every local and remote
branch **and** every sibling worktree working directory:

`0079`-`0081` (App Review remainder), `0082`/`0083`/`0086`/`0087`/`0088`
(II-R11), `0084`+`0087` (SMSF — note `0087` is an **unresolved active collision**
between SMSF and II-R11 that a human must reconcile; FDH-9 does not touch it).

`main` itself is at `0078` + `0085`.

**FDH-9 therefore claims `0091`** — the first genuinely free number.
