# FHIP Migration Registry

**Purpose.** One place that records which migration number belongs to which
module, on which branch, and how far it has been applied. This exists because
three feature streams (Investment Intelligence, Resources CMS, Financial Data
Hub) develop in parallel off a `main` that ends at `0030`, and two of them have
already collided.

**Created by:** FDH-1, 2026-08-21. There was no pre-existing migration-governance
document on `main` (`main` has no `docs/` directory at all — see
`docs/financial-data-hub/FDH0_REPOSITORY_MAP.md` §9), so this does not duplicate
an existing system.

## The rules (Product Owner Decision 1)

1. **No arbitrary reserved ranges.** No stream may reserve `0050-0099` "for
   later". Numbers are allocated one at a time, by a live process.
2. **Every allocation runs the live process:** identify the highest migration
   already committed on the latest merged `main`, and allocate the next
   sequential number — *checking, at the same moment, what other unmerged
   branches and the shared DEV database already occupy* (see §3).
3. **Merged and applied migrations are immutable.** They are never renumbered.
4. **Where two unmerged branches collide, the branch that merges second
   renumbers — and only its own unmerged, unapplied migration.**

## 1. Merged on `main` (immutable)

`main` @ `fe7a094`. Migrations `0001`–`0030`, all **MERGED** and
**APPLIED-PROD**. They are listed in `supabase/migrations/` and are not
restated here; nothing in this registry may renumber any of them.

| Migration | Module | Purpose | Branch | Status |
| --- | --- | --- | --- | --- |
| `0001`–`0030` | FHIP core (modules 1–10, recommendations, reports, contact) | The shipped platform schema | `main` | MERGED / APPLIED-PROD |

## 2. Unmerged streams

| Migration | Module | Purpose | Branch | Status |
| --- | --- | --- | --- | --- |
| `0031` | Investment Intelligence R1 | `ii_` reference foundation | `feature/investment-intelligence-r1-data-foundation` | BRANCH / APPLIED-DEV |
| `0032` | Investment Intelligence R1 | `ii_` source documents + accounts | same | BRANCH / APPLIED-DEV |
| `0033` | Investment Intelligence R1 | `ii_` transactions + holdings | same | BRANCH / APPLIED-DEV |
| `0034` | Investment Intelligence R1 | `ii_` publishing + goal allocations | same | BRANCH / APPLIED-DEV |
| `0035` | Investment Intelligence R1 | `ii_` analytics, insights, reconciliation | same | BRANCH / APPLIED-DEV |
| `0036` | Investment Intelligence R1 | `ii_` audit events | same | BRANCH / APPLIED-DEV |
| `0037` | Investment Intelligence R1 | `ii_` storage policy | same | BRANCH / APPLIED-DEV |
| `0038` | Investment Intelligence R1 | India adapter seed | same | BRANCH / APPLIED-DEV |
| `0039` | Investment Intelligence R2 | audit + document lifecycle | `feature/investment-intelligence-r2-cas-portfolio-truth` | BRANCH |
| `0040` | Investment Intelligence R2 | transaction lineage + dedup | same | BRANCH |
| `0041` | Investment Intelligence R2 | scheme resolution + portfolio truth | same | BRANCH |
| `0042` | Investment Intelligence R3 | FHIP publishing bridge | `feature/investment-intelligence-r3-fhip-publishing` | BRANCH |
| `0043` | Investment Intelligence R4 | performance/benchmark reference data | `feature/investment-intelligence-r4-performance-benchmark` | BRANCH |
| `0044` | Investment Intelligence R5 | SIP X-ray holdings | `feature/investment-intelligence-r5-sip-xray` | BRANCH |
| `0031` **(collision)** | Design System / sections | `financial_section_status` | `feature/resources-r1-7d-…` lineage | BRANCH — **collides with II `0031`** |
| `0032` **(collision)** | Design System / sections | section status "reviewed with data" | same | BRANCH — **collides with II `0032`** |
| `0033`–`0038` **(collision)** | Resources CMS R1.1–R1.4 | resources foundation, seed, roles, editors, specialist content | same | BRANCH — **collide with II `0033`–`0038`** |
| `0039` **(collision)** | Resources CMS R1.5 | public settings read | `feature/resources-r1-5-public-frontend` | BRANCH — **collides with II `0039`** |
| `0040` **(collision)** | Resources CMS R1.6 | discovery/context support | `feature/resources-r1-6-discovery-context` | BRANCH — **collides with II `0040`** |
| `0045` | **Financial Data Hub FDH-1** | FDH reference / master-data foundation | `feature/financial-data-hub-fdh-1-foundation` | BRANCH |
| `0046` | **Financial Data Hub FDH-1** | FDH accounts, statement uploads, ingestion jobs | same | BRANCH |
| `0047` | **Financial Data Hub FDH-1** | FDH transactions, allocations, links, duplicates, classification | same | BRANCH |
| `0048` | **Financial Data Hub FDH-1** | FDH review, reconciliation, data quality, provenance, evidence | same | BRANCH |

**Status vocabulary:** PLANNED / BRANCH / MERGED / APPLIED-DEV / APPLIED-PROD.

## 3. FDH-1's allocation: how `0045` was chosen, and why not `0031`

The live process was run on 2026-08-21 and produced evidence, not an assumption.

**Step 1 — highest migration on latest merged `main`.**
`main` @ `fe7a094` ends at `0030_contact_submissions.sql`. The literal next
sequential number is therefore `0031`.

**Step 2 — check what `0031` actually is.** Running `git ls-tree` over the
unmerged branch tips shows `0031` is claimed **twice**, independently:

* `0031_ii_reference_foundation.sql` (Investment Intelligence R1)
* `0031_financial_section_status.sql` (the design-system / Resources lineage)

The same double-claim runs all the way from `0031` to `0040`. This collision
predates FDH and was already recorded by FDH-0 as RED item R1
(`docs/financial-data-hub/FDH0_IMPLEMENTATION_READINESS_REPORT.md` §2).

**Step 3 — check the shared DEV database.** This is the step that settles it.
A read-only probe of the DEV project (`vqycarelcoijzwlpkpcz`) on 2026-08-21
found that `ii_sources`, `ii_instruments`, `ii_accounts`, `ii_transactions`,
`ii_holding_snapshots` and `ii_analytics_results` are all **PRESENT**, as are
`resource_categories`, `resource_posts` and `resource_settings` — while
`financial_section_status` is **ABSENT**. In other words:

> Investment Intelligence's `0031`–`0037` **and** Resources' `0033`+ are already
> applied to the shared DEV database, and the Resources stream's own `0031`/`0032`
> lost that collision and were never applied there.

Numbers `0031`–`0044` are therefore not merely claimed on paper — they are
occupied in the environment FDH-1 must be applied to. A migration file named
`0031_fdh_reference_foundation.sql` would collide on merge with two branches at
once and could not be applied to DEV at all.

**Step 4 — apply rule 4.** FDH is the stream that will merge last of the three.
Rule 4 says the branch merging second renumbers *its own* unmerged, unapplied
migration. FDH-1 therefore renumbers **only its own four files**, to the next
numbers free across every stream and in DEV: **`0045`–`0048`**. No other
stream's migration is renumbered, and nothing merged or applied is touched.

**This is not a reserved range.** `0045`–`0048` are four specific, contiguous
numbers allocated for four specific migrations that exist today. FDH-2 will
re-run this same process from scratch and take whatever is then free — it has
no claim on `0049` or anything beyond.

**Open item for the Product Owner.** The `0031`–`0040` double-claim between
Investment Intelligence and Resources is still unresolved and is not FDH's to
fix. Whichever of those two merges second must renumber. FDH-1 records the
collision here; it does not renumber another stream's files.

## 4. FDH-1 migrations in detail

| File | Tables created | Existing tables altered |
| --- | --- | --- |
| `0045_fdh_reference_foundation.sql` | `fdh_source_types`, `fdh_financial_institutions`, `fdh_categories`, `fdh_subcategories`, `fdh_merchants`, `fdh_merchant_aliases`, `fdh_classification_rules`, `fdh_parser_registry`, `fdh_parser_versions` | **none** |
| `0046_fdh_accounts_documents_jobs.sql` | `fdh_financial_accounts`, `fdh_statement_uploads`, `fdh_ingestion_jobs` | **none** |
| `0047_fdh_transactions_and_classification.sql` | `fdh_transactions`, `fdh_transaction_allocations`, `fdh_transaction_links`, `fdh_duplicate_candidates`, `fdh_user_classification_rules`, `fdh_classification_history`, `fdh_recurring_transactions` | **none** |
| `0048_fdh_review_quality_provenance.sql` | `fdh_review_items`, `fdh_reconciliation_results`, `fdh_data_quality_results`, `fdh_data_provenance`, `fdh_evidence_links` | **none** |

All four are additive. They contain no `alter table` against any pre-existing
table, no `drop`, and no `update`/`delete` of any existing row. They reference
`auth.users`, `countries`, `currencies` and `households` by foreign key only.
