# FDH-1 — Completion Report

**Status: CONDITIONAL-PASS**
**Branch:** `feature/financial-data-hub-fdh-1-foundation`
**Starting `main` commit:** `fe7a09413cccc44b6ba4cb790c53abab3dfa0187`
**Ending `main` commit:** `fe7a09413cccc44b6ba4cb790c53abab3dfa0187` *(unchanged — nothing was merged)*

**The single condition:** migrations `0045`–`0048` have **not** been applied to
any database, so no live RLS or cross-household isolation test has been run.
This environment has no `psql`, no Docker, no local Postgres and no
SQL-execution RPC, so DDL cannot be applied from here. Everything else is
complete and independently verified. See §14 and §7.

---

## 1. Baseline Verification

**Latest `main`.** Fetched and confirmed: local `main` and `origin/main` are
both at `fe7a094` — *"Remove internal build-phase copy from user-facing UI"*.
Migrations `0001`–`0030`.

**FDH-0 baseline compatibility.** FDH-0 (`cc4f981`) is documentation only —
`git diff --stat main feature/financial-data-hub-fdh-0-discovery` shows 11 files,
all under `docs/financial-data-hub/`, 2401 insertions, zero source or migration
changes. Branching FDH-1 from `main` is therefore equivalent to branching from
FDH-0, confirmed rather than assumed. **The FDH-0 documents are not present on
this branch**, because FDH-1 was branched from `main` as instructed; they merge
separately.

**Pre-existing test status — reproduced before writing any code.**

| Check | FDH-0 recorded | Reproduced at FDH-1 start | Match |
| --- | --- | --- | --- |
| `npx tsc --noEmit` | exit 0 | exit 0 | yes |
| `npx vitest run` | 14 files, 124/124 | 14 files, 124/124 | yes |
| `npx eslint .` | 6 errors, 6 warnings | 6 errors, 6 warnings | yes |
| `npx next build` | exit 0 with env vars | exit 0 (placeholder env) | yes |

**No discrepancy. Baseline clean. Implementation proceeded.**

**The Financial Twin / body-corporate fix: NOT MERGED TO `main`.** Checked
directly rather than assumed. `lib/services/twinData.ts:130` on `main` still
reads:

```ts
.filter((e) => e.master_item_key === 'mortgage' || e.master_item_key === 'rent'
             || e.master_item_key === 'council_rates' || e.master_item_key === 'strata_fees')
```

while the seeded key is `body_corporate`
(`supabase/seed_master_items.sql:37`). Per instruction, FDH-1 **did not**
incorporate the fix — it is out of scope. Recorded here honestly for the
Product Owner.

**Repository status at start.** Branch `worktree-agent-a2080969a26f4215f` @
`fe7a094`, clean working tree. Branch
`feature/financial-data-hub-fdh-1-foundation` created from `main` @ `fe7a094`.
Nothing was implemented on `main`; nothing was merged.

## 2. Product Owner Decisions Applied

### Decision 1 — Migration allocation

The live process was executed and produced **evidence**, not an assumption.

1. Highest on latest merged `main`: `0030`. Literal next number: `0031`.
2. `0031` is claimed **twice** by unmerged branches — `0031_ii_reference_foundation.sql`
   (Investment Intelligence R1) and `0031_financial_section_status.sql` (the
   design-system / Resources lineage). The double-claim runs `0031`–`0040`.
3. **A read-only probe of the DEV database settled it.** `ii_sources`,
   `ii_instruments`, `ii_accounts`, `ii_transactions`, `ii_holding_snapshots`,
   `ii_analytics_results`, `resource_categories`, `resource_posts` and
   `resource_settings` are all **PRESENT**; `financial_section_status` is
   **ABSENT**. Both unmerged streams are already applied to the shared DEV
   database, and the Resources stream lost the `0031`/`0032` collision there.
4. Rule 4 ("the branch merging second renumbers its own unmerged, unapplied
   migration") was applied. FDH renumbered **only its own four files** to
   **`0045`–`0048`** — the next numbers free across every stream and in DEV.

**No other stream's migration was renumbered. Nothing merged or applied was
touched.** This is not a reserved range: four specific numbers for four
migrations that exist today. FDH-2 will re-run the process from scratch.

`docs/architecture/MIGRATION_REGISTRY.md` was **created** (Migration / Module /
Purpose / Branch / Status, with the PLANNED / BRANCH / MERGED / APPLIED-DEV /
APPLIED-PROD vocabulary). It duplicates no existing system — `main` has no
`docs/` directory at all.

**Flagged for the Product Owner:** the `0031`–`0040` collision between
Investment Intelligence and Resources is **still unresolved** and is not FDH's
to fix. Whichever of those two merges second must renumber.

### Decision 2 — Investment ownership

FDH-1 created **zero** competing canonical investment tables. No
`fdh_holdings`, `fdh_securities`, `fdh_security_master`, `fdh_valuation_*`,
`fdh_portfolio_*` or `fdh_investment_*`, and no `units` / `nav` / `isin` /
`folio` / `quantity` / `ticker` / `cost_basis` / `market_value` column anywhere
across 335 column definitions. FDH touches no `ii_` object and imports no II
code. The `*_source` account types are document provenance, not holdings. Full
treatment, including the `fdh_transactions` ≠ `ii_transactions` distinction and
the `ii_source_documents` overlap flagged for FDH-11, in
`FDH1_INVESTMENT_BOUNDARY.md`.

### Decision 3 — Admin access to documents

**Zero standing admin access to raw financial documents.** No admin route, no
viewer, no download, no signed URL, no storage bucket, no storage policy. FDH
owns **no code path that can bypass RLS** — it never imports the service-role
client. The permitted operational-metadata projection is an **allowlist** of 20
columns plus a pseudonymous owner reference, with every excluded column's reason
recorded in code. Tested against a row seeded with a real user id, household id,
a name-bearing filename, a file hash and a storage path: none appears in the
output. Full treatment in `FDH1_RLS_SECURITY.md` §5.

## 3. Architecture Implemented

A standalone data-acquisition domain at `lib/financial-data-hub/`, layered
`constants → domain → validation → repositories → services`. Its only import
from outside the module is `@/lib/supabase/server`, the RLS-scoped session
client. Diagram, layering rules and namespace rationale in
`FDH1_ARCHITECTURE.md`.

## 4. Database Tables Added — 24

**Master data (9): no `user_id`, RLS on, read-only, no write policy.**

| Table | Purpose |
| --- | --- |
| `fdh_source_types` | Import mechanism, separate from institution. Fully seeded (9 rows) |
| `fdh_financial_institutions` | Banks, card issuers, lenders, brokers, super/retirement, payroll |
| `fdh_categories` | Category master (schema only) |
| `fdh_subcategories` | Subcategory master (schema only) |
| `fdh_merchants` | Canonical merchant master with a governance lifecycle |
| `fdh_merchant_aliases` | Many narratives → one merchant |
| `fdh_classification_rules` | Centrally governed global rules |
| `fdh_parser_registry` | Which parsers exist |
| `fdh_parser_versions` | Which version read which document |

**Household data (15): `user_id`, RLS on, owner-only.**

| Table | Purpose | RLS |
| --- | --- | --- |
| `fdh_financial_accounts` | Source accounts | owner, full CRUD |
| `fdh_statement_uploads` | Document metadata + purge state | owner, full CRUD |
| `fdh_ingestion_jobs` | Async job state | owner, full CRUD |
| `fdh_transactions` | The canonical cash transaction | owner, full CRUD |
| `fdh_transaction_allocations` | Splits | owner, full CRUD |
| `fdh_transaction_links` | Transfers, settlements, refunds, duplicates | owner, full CRUD |
| `fdh_duplicate_candidates` | Duplicate pairs | owner, full CRUD |
| `fdh_user_classification_rules` | A household's own rules | owner, full CRUD |
| `fdh_classification_history` | Classification audit | **owner select + insert only; no update, no delete** |
| `fdh_recurring_transactions` | Recurring/subscription patterns | owner, full CRUD |
| `fdh_review_items` | The review queue | owner, full CRUD |
| `fdh_reconciliation_results` | Did the statement balance? | owner, full CRUD |
| `fdh_data_quality_results` | Per-check import quality | owner, full CRUD |
| `fdh_data_provenance` | Where did this number come from? | owner, full CRUD |
| `fdh_evidence_links` | Many evidence sources → one fact | owner, full CRUD |

Totals: 24 tables, 335 column definitions, 85 foreign keys (all with an explicit
`ON DELETE`), 130 check constraints, 59 indexes, 25 policies.

## 5. Migrations

| File | Contents |
| --- | --- |
| `0045_fdh_reference_foundation.sql` | 9 master-data tables + the 9-row source-type seed |
| `0046_fdh_accounts_documents_jobs.sql` | accounts, statement uploads, ingestion jobs |
| `0047_fdh_transactions_and_classification.sql` | transactions, allocations, links, duplicates, user rules, classification history, recurring |
| `0048_fdh_review_quality_provenance.sql` | review items, reconciliation, data quality, provenance, evidence |

Four coherent migrations — not one per table, not one monolith. **Registry
updated. Collision check: performed live against both unmerged streams and the
DEV database (§2).** All four are additive: no `alter table` on any pre-existing
table, no `drop`, no `update`, no `delete from`, asserted by test.

`supabase/seed_fdh_test_fixtures.sql` holds the minimal dev/test fixtures — four
TEST FIXTURE institutions, two categories, one subcategory, one merchant, one
alias, one parser and one `development` parser version. It is **deliberately not
a migration**, so no fictitious institution can reach production.

## 6. TypeScript Domain Contracts

24 interfaces, one per table, field names matching the columns exactly, plus
`FdhOwnership`, the rule match/action discriminated unions, and the
`UnitInterval` / `IsoDate` / `IsoTimestamp` aliases. Closed vocabularies in
`constants/enums.ts`, kept in step with the SQL by test. Full list in
`FDH1_DOMAIN_MODEL.md` §1.

## 7. Validation

Zod — the library already established across `lib/validation/**`. No second
framework introduced. Eight schema modules covering enums, dates, amounts,
currencies, ownership identifiers, confidence ranges, **state transitions**,
category/subcategory relationships and **allocation integrity**. Notable:
`user_id` is never accepted from a caller; an amount with excess precision is
rejected rather than truncated; an FX rate with no date is rejected; rule
definitions admit no regex/expression/SQL member; a reconciliation cannot be
recorded as successful outside its stated tolerance.

## 8. RLS & Security

24/24 tables RLS-enabled. 15/15 user-owned tables owner-scoped with the
byte-identical house policy. 9/9 master tables read-only with no write policy.
Fourteen-point security review in `FDH1_RLS_SECURITY.md` §6 —
**zero critical unresolved FDH-created security issues.**

**Not live-verified.** Every security claim is about the migration SQL and the
application code as written, verified by parsing the real files. See §14.

## 9. Privacy / Purge Architecture

Four purgeable columns, all nullable and asserted so by test. Two database check
constraints make the purge contract real: a row cannot claim to be purged while
still pointing at a document, and `purged_at` is only settable in the purged
state. No `full_account_number` / `bsb` / `ifsc` / `iban` column exists;
`masked_identifier` is rejected by a database check if it carries seven or more
consecutive digits. `account_fingerprint` is reserved, documented and
**unpopulated** — no key-management infrastructure exists yet. Review-item
context is a closed `.strict()` shape with no free-text field, so raw narrative
cannot survive the purge by hiding there. Full treatment in
`FDH1_PRIVACY_DATA_LIFECYCLE.md`.

## 10. Investment Intelligence Boundary

**Explicit confirmation: NO duplicate canonical investment ledger was
introduced.** No holdings, securities, valuations, NAV, folio, units or
instrument table or column exists anywhere in FDH. FDH touches no `ii_` object
and imports no II code. Six tests enforce this, and the negative-control run
confirmed they fail when a competing holdings table is injected.

One honest open item: II's existing `ii_source_documents` overlaps FDH's
document-acquisition ownership. FDH-1 did not touch it and does not resolve the
overlap — flagged for **FDH-11** with two options in
`FDH1_INVESTMENT_BOUNDARY.md` §5.

## 11. Tests Added

120 tests across 3 files: `fdh1SchemaContract.test.ts` (40),
`fdh1Domain.test.ts` (58), `fdh1Isolation.test.ts` (22). Plus
`scripts/fdh1_live_dev_verification.mjs`, a 27-check live RLS attack suite ready
to run once the migrations are applied. Detail in `FDH1_TEST_CERTIFICATION.md`.

**Negative control: 10 mutations injected into the real files, 10/10 caught.**

## 12. Test Results

| Check | Result |
| --- | --- |
| TypeScript (`npx tsc --noEmit`) | **exit 0** |
| Lint (`npx eslint .`) | **6 errors, 6 warnings — identical to the FDH-0 baseline** |
| Lint (FDH surface only) | **clean, exit 0** |
| Unit tests (`npx vitest run`) | **17 files, 244/244 passed** (was 14 files, 124/124) |
| Existing FHIP regression | **124/124 pre-existing tests still pass** |
| Database tests | **static schema contract: 40/40. Live: NOT EXECUTED — see §14** |
| RLS tests | **static: 6/6. Live: NOT EXECUTED — see §14** |
| Production build (`npx next build`) | **exit 0** |
| Negative control | **10/10 mutations caught** |

## 13. What Was Modified

**Existing files modified: NONE.** `git status` shows only additions. In
particular `vitest.config.ts` was **not** touched — FDH tests live in
`tests/unit/`, matching the existing include glob and the Investment
Intelligence precedent.

**Existing database structures modified: NONE.** No `alter table`, no `drop`, no
index or policy change on any pre-existing object. FDH references `auth.users`,
`countries`, `currencies` and `households` by foreign key only.

**Existing calculation logic modified: NONE.** `lib/engines/**` is untouched;
124/124 pre-existing tests pass unchanged.

**Existing user financial data modified: NONE.** No migration contains an
`insert`, `update` or `delete` against any existing table. No database was
written to at all during this phase.

## 14. Known Limitations

1. **Migrations not applied anywhere.** 0 of 24 FDH tables exist in DEV,
   confirmed by probe. No `psql`, no Docker, no local Postgres, no
   SQL-execution RPC (`exec_sql`, `execute_sql`, `sql`, `run_sql` all probed,
   all `PGRST202`). Migrations must be applied via the Supabase SQL editor by
   someone with console access. **"Applies cleanly" is not claimed.**
2. **No live RLS or cross-household isolation test.** There is nothing to attack
   yet. `scripts/fdh1_live_dev_verification.mjs --rls` runs all 27 checks the
   moment the tables exist; run with no FDH table present it exits 2 rather than
   pretending.
3. **`account_fingerprint` unpopulated** — no key-management/HMAC infrastructure
   exists in this repository (FDH-3 at the earliest).
4. **Playwright E2E not run** — same reason as FDH-0: the specs create real
   users and write real rows, and FDH-1 adds no user-facing surface.
5. **FDH-0's documents are not on this branch** — FDH-1 branched from `main` as
   instructed. FDH-1 docs cross-reference them by path; both merge to `main`
   separately.
6. **Master-data reads are open to `anon`** (`for select using (true)`), matching
   the 22 existing world-readable reference tables. Deliberate, reasoned in
   `FDH1_RLS_SECURITY.md` §4; none of those tables holds personal data.
7. **The `0031`–`0040` collision between II and Resources is unresolved** and is
   not FDH's to fix.
8. **The Financial Twin `body_corporate` fix is not on `main`** and was not
   incorporated (out of scope, per instruction).

## 15. Security Findings

Fourteen-point review in `FDH1_RLS_SECURITY.md` §6. **Zero critical unresolved
FDH-created issues.**

One real defect was found and fixed *during* this phase: 16 foreign keys to
`countries`, `currencies` and `fdh_source_types` had no explicit `ON DELETE`
clause. All were set to `on delete restrict` — reference data in use must not be
deletable from under a financial record. Found by a test, not by inspection.

Pre-existing platform issues recorded honestly and neither worsened nor fixed:
`admin_users` is a single unscoped boolean; `adminRoute()` returns raw error
text; `audit_events` and `financial_records_audit` are never written.

## 16. Rollback Instructions

**FDH owns 24 tables, all prefixed `fdh_`, created by migrations `0045`–`0048`.
No pre-existing object was altered, so rollback touches nothing outside that
prefix.**

If the migrations have not been applied (the current state), rollback is simply
deleting the four files — no database action is required.

If they have been applied, drop in reverse dependency order:

```sql
-- 0048
drop table if exists fdh_evidence_links;
drop table if exists fdh_data_provenance;
drop table if exists fdh_data_quality_results;
drop table if exists fdh_reconciliation_results;
drop table if exists fdh_review_items;

-- 0047
drop table if exists fdh_recurring_transactions;
drop table if exists fdh_classification_history;
drop table if exists fdh_user_classification_rules;
drop table if exists fdh_duplicate_candidates;
drop table if exists fdh_transaction_links;
drop table if exists fdh_transaction_allocations;
drop table if exists fdh_transactions;

-- 0046
drop table if exists fdh_ingestion_jobs;
drop table if exists fdh_statement_uploads;
drop table if exists fdh_financial_accounts;

-- 0045
drop table if exists fdh_parser_versions;
drop table if exists fdh_parser_registry;
drop table if exists fdh_classification_rules;
drop table if exists fdh_merchant_aliases;
drop table if exists fdh_merchants;
drop table if exists fdh_subcategories;
drop table if exists fdh_categories;
drop table if exists fdh_financial_institutions;
drop table if exists fdh_source_types;
```

**Dependencies:** every FDH table depends only on other FDH tables plus
`auth.users`, `countries`, `currencies` and `households` — all by foreign key,
none altered. Dropping the 24 above leaves the pre-existing schema byte-identical.

**Code rollback:** delete `lib/financial-data-hub/`, `tests/unit/fdh1*.test.ts`,
`scripts/fdh1_live_dev_verification.mjs`, `supabase/seed_fdh_test_fixtures.sql`,
`supabase/migrations/0045`–`0048`, `docs/financial-data-hub/FDH1_*.md` and
`docs/architecture/MIGRATION_REGISTRY.md`. **No existing file needs reverting,
because none was modified.**

**Rollback was not performed** — it was not required.

## 17. Acceptance Checklist

| # | Criterion | Status |
| --- | --- | --- |
| 1 | Baseline verified before coding | **MET** — all four FDH-0 numbers reproduced |
| 2 | Latest `main` confirmed | **MET** — `fe7a094`, local = origin |
| 3 | body-corporate fix presence checked, not assumed | **MET** — NOT merged; not incorporated |
| 4 | Branch from latest clean `main`, not from FDH-0 | **MET** — equivalence confirmed by diff |
| 5 | Not implemented on `main`; not merged | **MET** |
| 6 | Migration numbering by live process | **MET** — §2, evidence in the registry |
| 7 | Registry created/updated | **MET** — `docs/architecture/MIGRATION_REGISTRY.md` |
| 8 | No collision with II or Resources | **MET** — `0045`–`0048` free on all branches and in DEV |
| 9 | Standalone domain isolation | **MET** — imported by nothing outside itself |
| 10 | Existing Input Data schema unchanged | **MET** — no `alter table` on any pre-existing table |
| 11 | Existing FHIP calculations unchanged | **MET** — `lib/engines/**` untouched, 124/124 pass |
| 12 | No Input Data write path | **MET** — no register named outside the guard list, none queried |
| 13 | No user-facing upload | **MET** — no route, page or component added |
| 14 | No bank parser | **MET** — registry rows only |
| 15 | No exhaustive merchant/category library | **MET** — schema only; fixtures are dev/test |
| 16 | Canonical financial-account model exists | **MET** |
| 17 | Canonical financial-transaction model exists | **MET** |
| 18 | Credit/debit separated from economic classification | **MET** — 26 combinations tested |
| 19 | Transaction-allocation structure | **MET** |
| 20 | Transaction-link structure | **MET** — nullable counterpart |
| 21 | Review-item structure | **MET** — persists across import sessions |
| 22 | Duplicate-candidate structure | **MET** |
| 23 | Reconciliation-result structure | **MET** — cannot record a failure as success |
| 24 | Data-quality structure | **MET** |
| 25 | Parser registry + version structure | **MET** |
| 26 | Classification master-data structures | **MET** |
| 27 | User-rule structure | **MET** |
| 28 | Classification-history structure | **MET** — append-only |
| 29 | Recurring-payment foundation | **MET** |
| 30 | Provenance structure | **MET** — standalone, plus evidence links |
| 31 | Privacy/purge metadata | **MET** |
| 32 | Raw sensitive fields later-deletable | **MET** — all nullable, asserted by test |
| 33 | Structural AU/India support | **MET** — one country convention, both tested |
| 34 | Original and reporting currency distinct | **MET** — plus rate, date and source |
| 35 | Safe decimal financial storage | **MET** — `numeric(20,4)`; no float anywhere |
| 36 | RLS on all user-owned tables | **MET** — 15/15 |
| 37 | Cross-household isolation tests pass | **NOT EXECUTED** — see §14.2 |
| 38 | Zero standing raw-document admin access | **MET** |
| 39 | Zero competing II canonical tables | **MET** |
| 40 | New FDH tests pass | **MET** — 120/120 |
| 41 | Existing FHIP tests pass | **MET** — 124/124 |
| 42 | TypeScript passes | **MET** — exit 0 |
| 43 | Lint passes | **MET** — baseline unchanged; FDH surface clean |
| 44 | Production build passes | **MET** — exit 0 |
| 45 | Documentation complete | **MET** — 9 FDH-1 docs + the registry |
| 46 | Rollback instructions documented | **MET** — §16 |

**44 MET, 1 NOT EXECUTED (#37), 0 FAILED.**

## 18. Deferred to FDH-2

Master Data & Merchant Intelligence: the exhaustive Australia/India category
library, the merchant master and its research, MCC mapping, the institution
master, alias libraries, and seeded classification rules. FDH-1 provides the
schema and the minimum fixtures its own tests need — nothing more.

## 19. Deferred to Later Phases

| Phase | Scope |
| --- | --- |
| FDH-3 | Secure Document Lifecycle / Upload — storage, signed URLs, validation, the purge worker, key management for `account_fingerprint` |
| FDH-4 | Bank CSV Engine |
| FDH-5 | Bank PDF Engine |
| FDH-6 | Classification / Duplicate / Transfer Intelligence |
| FDH-7 | Transaction Review & Reconciliation UX |
| FDH-8 | Standalone Expense Tracker |
| FDH-9 | Payslip & Income Intelligence — including the evidence-completeness scoring model |
| FDH-10 | Credit Cards & Loans — revisit taxonomy recommendation R-1 |
| FDH-11 | Investment Statement Intelligence — the II adapter and the `ii_source_documents` overlap |
| FDH-12 | Retirement Intelligence — revisit taxonomy recommendation R-2 |
| FDH-13 | Admin Intelligence Centre — consumes the operational-metadata allowlist |
| FDH-14 | Standalone Certification |
| FDH-15 | FHIP Input Data Bridge |
| FDH-16 | Integration Certification |

Also deferred: Open Banking / CDR, Account Aggregator, AI classification, the
legal-hold mechanism, and consent-gated temporary admin support access.

## 20. Final Verdict

**FDH-1: CONDITIONAL-PASS.**

Every deliverable is complete and independently verified against the real files:
24 tables across 4 correctly-allocated migrations, 24 TypeScript contracts, 8
validation modules, a repository/service boundary, 120 new tests with a 10/10
negative control, 9 documentation deliverables plus the migration registry, zero
existing files modified, zero existing schema changed, zero calculation logic
touched, zero user data touched, and a full regression matching the FDH-0
baseline exactly.

The single reason this is not an unconditional PASS is honest and mechanical:
**the migrations have not been applied to any database, so acceptance criterion
#37 — cross-household isolation tests pass — has not been executed.** This
environment cannot apply DDL. The verification script is written and ready.

**To convert to PASS:** apply `0045`–`0048` via the Supabase SQL editor, apply
`supabase/seed_fdh_test_fixtures.sql`, then run
`node scripts/fdh1_live_dev_verification.mjs --rls` and confirm 27/27.

**FDH-2 readiness: AMBER.** Not blocked by code. Two items should be settled
first:

1. **Apply the migrations and run the live RLS suite.** Building FDH-2's master
   data on an unapplied schema would compound risk.
2. **The `0031`–`0040` collision between Investment Intelligence and Resources.**
   FDH-2 will need another migration number, and the registry should reflect a
   resolved reality by then.

Neither is a code blocker, and both are Product Owner calls.

---

**STOP.** FDH-1 is complete. FDH-2 has not been started: no merchant research,
no category library, no upload, no parser, no Expense Tracker. Awaiting Product
Owner review.
