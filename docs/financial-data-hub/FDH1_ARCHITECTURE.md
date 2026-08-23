# FDH-1 — Architecture

**Phase:** FDH-1, Standalone Architecture & Data Foundation
**Branch:** `feature/financial-data-hub-fdh-1-foundation` (from `main` @ `fe7a094`)
**Status:** schema + contracts only. No ingestion functionality exists.

---

## 1. The core principle

The Financial Data Hub begins life as a **standalone data-acquisition and
financial-activity domain**. It is not a second FHIP financial engine, and in
FDH-1 it is not connected to the first one at all.

```
documents → FDH → extraction → normalisation → classification
          → reconciliation → user review → user approval
```

That pipeline runs entirely inside FDH and stays inside FDH through FDH-14.
Only at **FDH-15** does an approved FDH result cross the boundary:

```
approved FDH data → Input Population Proposal → existing Input Data
                  → user confirmation → existing FHIP engines
```

FDH-1 implements the leftmost box's *schema* and nothing else. There is no
upload, no parser, no extraction, no classification engine, no review UI and no
bridge.

## 2. System diagram

```
┌───────────────────────────────────────────────────────────────────────────┐
│  EXISTING FHIP SYSTEM                                        [PROTECTED]  │
│                                                                           │
│   Input Data registers          Calculation engines        Surfaces       │
│   ┌─────────────────────┐       ┌──────────────────┐      ┌────────────┐  │
│   │ income_sources      │       │ dashboard.ts     │      │ Dashboard  │  │
│   │ expense_items       │──────▶│ healthScore.ts   │─────▶│ Score      │  │
│   │ assets              │       │ financialDna.ts  │      │ DNA        │  │
│   │ liabilities         │       │ resilience.ts    │      │ Resilience │  │
│   │ investments         │       │ goal*.ts         │      │ Goals      │  │
│   │ retirement_accounts │       │ forecast/*       │      │ Forecast   │  │
│   │ insurance_policies  │       │ twin/*           │      │ Twin       │  │
│   └─────────────────────┘       │ report*.ts       │      │ Reports    │  │
│            ▲                    └──────────────────┘      └────────────┘  │
│            │                                                              │
│            │  ✗ NO FDH-1 INTEGRATION OF ANY KIND ✗                        │
│            │     no write, no read, no import, no proposal                │
│            ┆     (this arrow is created at FDH-15, not before)            │
└────────────┆──────────────────────────────────────────────────────────────┘
             ┆
             ┆  ← FDH-15: FHIP Data Bridge (NOT IMPLEMENTED)
             ┆     approved FDH data → Input Population Proposal
             ┆     → user confirmation → existing Input Data
             ┆
┌────────────┸──────────────────────────────────────────────────────────────┐
│  FINANCIAL DATA HUB                                    [NEW — FDH-1]      │
│                                                                           │
│  ┌── MASTER DATA (shared, no user_id, read-only RLS, admin-write) ──────┐ │
│  │  fdh_source_types            fdh_categories       fdh_merchants      │ │
│  │  fdh_financial_institutions  fdh_subcategories    fdh_merchant_      │ │
│  │  fdh_parser_registry         fdh_classification_       aliases       │ │
│  │  fdh_parser_versions              rules                              │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                          │ referenced by                                  │
│                          ▼                                                │
│  ┌── USER DATA (user_id, owner-only RLS) ───────────────────────────────┐ │
│  │                                                                      │ │
│  │  fdh_financial_accounts ──┬── fdh_statement_uploads ── fdh_ingestion_│ │
│  │                           │            │                      jobs   │ │
│  │                           │            ▼                             │ │
│  │                           └──▶ fdh_transactions ──┬── fdh_transaction│ │
│  │                                     │  │  │       │      _allocations│ │
│  │                                     │  │  │       ├── fdh_transaction│ │
│  │                                     │  │  │       │      _links      │ │
│  │                                     │  │  │       ├── fdh_duplicate_ │ │
│  │                                     │  │  │       │      candidates  │ │
│  │                                     │  │  │       └── fdh_classifica-│ │
│  │                                     │  │  │            tion_history  │ │
│  │                                     │  │  └──▶ fdh_recurring_        │ │
│  │                                     │  │            transactions     │ │
│  │                                     │  └─────▶ fdh_user_classifica-  │ │
│  │                                     │              tion_rules        │ │
│  │                                     ▼                                │ │
│  │  fdh_review_items   fdh_reconciliation_results  fdh_data_quality_    │ │
│  │                                                        results       │ │
│  │  fdh_data_provenance ──▶ fdh_evidence_links                          │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────┘
             ┆
             ┆  ← FDH-11: approved investment extraction → II adapter
             ┆     (CONTRACT DOCUMENTED, NOT IMPLEMENTED)
             ┆
┌────────────┸──────────────────────────────────────────────────────────────┐
│  INVESTMENT INTELLIGENCE                        [EXTERNAL, II-OWNED]      │
│  The canonical investment domain. FDH never restates it.                  │
│                                                                           │
│   ii_instruments   ii_accounts     ii_transactions   ii_holding_snapshots │
│   ii_tax_lots      ii_prices_nav   ii_benchmarks     …                    │
│                                                                           │
│   Owns: canonical accounts, securities, holdings, investment transactions │
│         after acceptance, valuations, XIRR/CAGR/TWRR, benchmarks, risk    │
│         metrics, goal relationships, investment reporting.                │
└───────────────────────────────────────────────────────────────────────────┘

  Investment flow, end to end:
    investment statement → FINANCIAL DATA HUB [acquire / extract / review]
                         → INVESTMENT INTELLIGENCE [canonical ownership]
                         → FHIP aggregation / future bridge

  There is never more than one canonical investment portfolio.
```

## 3. Module namespace

The FDH-1 specification sketched `lib/financial-data/{domain,validation,
repositories,services,constants,types}/`. That conceptual split is honoured;
the physical location follows this repository's own conventions, which is what
the specification asked for where an established equivalent exists.

```
lib/financial-data-hub/
  constants/      enums.ts, tables.ts, adminBoundary.ts
  domain/         types.ts, documentLifecycle.ts, money.ts,
                  allocations.ts, privacy.ts
  validation/     primitives.ts, filename.ts, accounts.ts, documents.ts,
                  transactions.ts, review.ts, classification.ts, masterData.ts
  repositories/   base.ts, index.ts
  services/       index.ts

tests/unit/       fdh1SchemaContract.test.ts, fdh1Domain.test.ts,
                  fdh1Isolation.test.ts
supabase/migrations/  0045-0048
supabase/            seed_fdh_test_fixtures.sql   (dev/test only, not a migration)
docs/financial-data-hub/  FDH1_*.md
docs/architecture/        MIGRATION_REGISTRY.md
scripts/                  fdh1_live_dev_verification.mjs
```

**Why a `lib/` module root rather than layer-first?** `lib/` already contains
domain-named roots (`lib/advice-boundary/`, `lib/grid/`, `lib/utils/`) alongside
layer-named ones (`lib/engines/`, `lib/services/`, `lib/validation/`), so this
is an existing pattern, not a new one. A module root was chosen over
`lib/engines/financial-data-hub/` specifically because `lib/engines/**` means
*financial calculation* in this codebase, and FDH is emphatically not a
calculation engine — filing it there would blur the one boundary FDH-1 exists to
draw.

**Tests** live in `tests/unit/` with an `fdh1` prefix, matching the Investment
Intelligence precedent (`iiR2*.test.ts` etc.). This required **no change to
`vitest.config.ts`**, whose include glob is `tests/unit/**/*.test.ts`. No
existing file was modified anywhere in FDH-1.

**No empty directories were created.** Every directory above holds code.

## 4. Layering

| Layer | Responsibility | May import |
| --- | --- | --- |
| `constants/` | Closed vocabularies, table lists, the admin allowlist | nothing outside FDH |
| `domain/` | Types, state machines, money arithmetic, allocation integrity, purge contracts. **Pure — no Supabase, no I/O** | `constants/` |
| `validation/` | Zod schemas for every externally-created or DB-writeable input | `constants/`, `domain/` |
| `repositories/` | Typed Supabase access, scoped to FDH tables, session-client only | `constants/`, `domain/`, `validation/`, `@/lib/supabase/server` |
| `services/` | Decisions and orchestration | everything above |

`@/lib/supabase/server` is the **only** import from outside the module, and it
is the RLS-scoped session client. `@/lib/supabase/admin` (service role, bypasses
RLS) is never imported — see `FDH1_RLS_SECURITY.md` §5.

## 5. What FDH-1 deliberately does not build

Upload, S3, signed URLs, PDF/CSV processing, OCR, Textract, any parser, any
bank-specific support, password-protected PDFs, merchant research, AU/India
merchant seeds, MCC library import, AI classification, transfer detection,
duplicate detection, recurring detection, the review UI, the Expense Tracker,
payslip/loan/card/investment/super/EPF/NPS parsers, Open Banking/CDR, Account
Aggregator, and the FHIP Input Data Bridge. Each belongs to a named later phase
(FDH-2 … FDH-16).

## 6. Cross-references

* `FDH1_DATABASE_SCHEMA.md` — every table, field by field
* `FDH1_DOMAIN_MODEL.md` — TypeScript contracts and the taxonomy
* `FDH1_RLS_SECURITY.md` — RLS, the admin boundary, the security review
* `FDH1_STATE_MACHINES.md` — document, purge, review and job lifecycles
* `FDH1_PRIVACY_DATA_LIFECYCLE.md` — what is deleted, what is kept
* `FDH1_INVESTMENT_BOUNDARY.md` — Decision 2 in detail
* `FDH1_TEST_CERTIFICATION.md` — what was tested and what was not
* `FDH1_COMPLETION_REPORT.md` — the phase report
* `../architecture/MIGRATION_REGISTRY.md` — Decision 1 and the numbering evidence
