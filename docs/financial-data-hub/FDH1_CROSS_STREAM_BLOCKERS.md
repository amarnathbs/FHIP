# FDH-1 — Cross-Stream Blockers

**Recorded:** 2026-08-21, during the FDH-1 Full-Pass Closure & Live DEV
Certification.

This document **records** a known cross-stream problem. It deliberately does
**not** solve it. Resolving it is a separate, explicitly-scoped task.

---

## 1. The issue: colliding migration lineages in the `0031`–`0044` range

Three workstreams numbered migrations independently off the same `main` tip.

| Stream | `main` tip | Numbers claimed | Merged to `main`? | Applied to DEV? |
| --- | --- | --- | --- | --- |
| `main` | `0030` | `0001`–`0030` | yes | yes |
| Investment Intelligence | `0030` | `0031`–`0043` | **no** | yes, ad hoc |
| Resources | `0030` | `0031`–`0040` | **no** | partially, ad hoc |
| **Financial Data Hub (FDH-1)** | `0030` | **`0045`–`0048`** | no | **yes, cleanly** |

Investment Intelligence and Resources both claim `0031`–`0040`. Two different
migrations therefore share each of ten numbers. Both lineages have been applied
ad hoc to the shared DEV project, so DEV holds an **inconsistent combination**:
neither lineage is fully present, and the migration numbering no longer
identifies a unique migration.

### Confirmed observations (live DEV `vqycarelcoijzwlpkpcz`, 2026-08-21)

* Investment Intelligence tables **are** present — `ii_accounts`,
  `ii_instruments`, `ii_transactions`, `ii_holding_snapshots`, `ii_prices_nav`,
  `ii_fhip_publications`, `ii_tax_lots`, `ii_analytics_results` and ~22 more all
  resolve.
* Resources tables are **incomplete**. `financial_section_status` — created by
  the Resources lineage's own `0031` — returns HTTP 404 / `PGRST205`: it does
  not exist in DEV. `user_financial_section_status` (a different, `main`-lineage
  table) does exist; the similar name is a trap, not the same object.
* Because neither lineage is merged, `main` still tops out at `0030`, so the
  repository's own history does not describe what DEV actually contains.

**Consequence:** the migration ledger is not a reliable description of DEV. Any
verification that trusts migration numbering alone is unsound for this project
until the lineages are reconciled.

## 2. FDH-1's dependency on the issue: **NONE**

FDH-1 deliberately skipped the contaminated range and numbered from `0045`.
This was verified rather than assumed during closure:

* **No number collision.** `0045`–`0048` are claimed by no other lineage. The
  repository contains exactly one file per number, and DEV contains exactly the
  24 tables those four files create.
* **No dependency on a missing object.** Every foreign key in `0045`–`0048`
  resolves to one of: another `fdh_*` table (same lineage), or `countries`,
  `currencies`, `households`, `auth.users` — all four of which are `main`-lineage
  (`0001`–`0030`) objects present in DEV. **No FDH foreign key, check
  constraint, index or policy references any `ii_*` object, any `resource_*`
  object, or `financial_section_status`.**
* **No dependency on an ambiguously-owned object.** Nothing FDH-1 creates or
  references falls in the `0031`–`0044` range.
* **No contact at all.** Across all four migration files, every `ii_*` and
  Resources mention is inside a `--` comment; every DDL statement targets an
  `fdh_` object.

FDH-1 was therefore able to be applied to DEV cleanly and certified on its own
merits, and its certification result is independent of this issue.

## 3. Explicitly NOT done here

Per the closure scope, this task did **not**:

* renumber any migration, in any lineage;
* rewrite migration history;
* delete or alter any `ii_*` or `resource_*` table;
* re-run any historical conflicting migration;
* create a reconciliation migration;
* create `financial_section_status`;
* repair either stream in any other way.

The drift was observed, recorded, and left exactly as found.

## 4. Required next action

A separate **"Investment Intelligence + Resources Migration Lineage
Reconciliation"** task must decide and execute a single coherent numbering, and
bring DEV to a state the repository actually describes. It needs a Product Owner
decision on which lineage renumbers, and must account for the fact that both are
already partially applied to a shared DEV project.

**This is a hard governance gate: it must complete before FDH-2 begins.** FDH-2
loads institution, merchant, MCC and category master data, which is exactly the
kind of bulk content work that a broken migration lineage turns into an
unrecoverable mess.

## 5. Status

| Field | Value |
| --- | --- |
| Status | **UNRESOLVED — INTENTIONALLY OUT OF SCOPE** |
| FDH-1 impact | **NONE** (verified live, §2) |
| Blocks FDH-1 certification | **No** |
| Blocks FDH-2 | **Yes** |
| Owner | Product Owner (sequencing decision required) |
