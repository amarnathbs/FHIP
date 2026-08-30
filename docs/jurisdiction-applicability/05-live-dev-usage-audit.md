# Deliverable 5 — Live DEV Usage Audit (aggregate only, no PII)

**Baseline-refresh note, 2026-08-27 (G0-JA-1 closure, spec §3):** every figure below is **discovery-baseline evidence**, re-used as-is in this closure pass, **not re-queried against live DEV during closure**. Justification: the closure task's baseline-refresh check found zero diff between the discovery fork point and current `origin/main` for every schema/table this audit depends on (`user_profiles`, `households`, `assets`, `liabilities`, `investments`, `retirement_accounts`, `master_financial_items` — confirmed via `git diff <fork-point> origin/main` returning empty for the migrations and services that touch them), and this closure's own hard rules direct it to prefer already-documented figures over a fresh DEV query unless there is reason to believe they are stale (none was found). If a future wave (Wave 1 onward, `06-implementation-waves.md`) is the first to actually change any of these tables, that wave must re-run these exact queries fresh rather than citing these numbers, since they will no longer reflect current DEV state at that point.

**Method:** Read-only `SELECT`/`count` queries against the DEV Supabase project (`https://vqycarelcoijzwlpkpcz.supabase.co`), using the service-role key already present in `D:/FHIP/.claude/worktrees/agent-abf857c598d5a191b/.env.local` (per the dispatch's explicit instruction). No row was inserted, updated, or deleted. No individual user-identifying data (name, email, exact balances) is reproduced below — every number is an aggregate count. The script used is not committed (a throwaway analysis script, not a project deliverable) but every query it ran is reproduced inline below so the numbers are independently re-runnable by anyone with the same DEV credentials.

## 1. Users by home jurisdiction (`user_profiles.country_of_residence`)

| Value | Count | % of 344 |
|---|---|---|
| `AU` | 150 | 43.6% |
| `IN` | 96 | 27.9% |
| `NULL` (unresolved) | 98 | 28.5% |
| **Total** | **344** | 100% |

**This is the single largest live-data finding of this audit.** Just over a quarter of all DEV user profiles have no resolved home jurisdiction at all. This population is very likely dominated by test/seed fixtures (the project's own memory records a standing 50-user E2E regression fixture plus numerous certification scripts across ~30 concurrent worktrees, each potentially creating throwaway users in the same shared DEV project) rather than representing real onboarding drop-off — but this audit has no reliable way to distinguish "abandoned real onboarding" from "test fixture" from read-only aggregate queries alone, and does not guess (spec s.60). **This number should not be read as "28.5% of real users never finish onboarding"** without further investigation neither authorized nor time-boxed into this G0 pass.

## 2. `user_profiles.secondary_country` distribution

| Value | Count |
|---|---|
| `NULL` | 344 (100%) |

Confirms `01-canonical-architecture.md` §2: the cross-border secondary-country field is completely unused in live data, consistent with there being no UI write path for it.

## 3. `households.primary_country` vs. `user_profiles.country_of_residence` drift

| Result | Count |
|---|---|
| Matched | 244 |
| Drifted (different value) | **0** |
| Household with no matching profile | 0 |
| Total households | 244 |

**Zero drift across all 244 households** — directly confirms the "passive one-way copy" architecture claim in `01-canonical-architecture.md` §1 with live evidence, not just code reading.

## 4. Per-module record `country_code` distribution (the record's own tag, not the owner's home country)

| Table | AU | IN | NULL |
|---|---|---|---|
| `assets` | 465 | 379 | 4 |
| `liabilities` | 129 | 142 | 68 |
| `investments` | 371 | 411 | 16 |
| `retirement_accounts` | 178 | 188 | 1 |

Every module has substantial live data in both AU and IN — this is a genuinely bilingual/bi-jurisdictional dataset, not an AU-only product with token IN test rows. Liabilities has the highest `NULL` rate (68/339, ~20%) — worth a data-quality note but not itself a jurisdiction-architecture defect (liability `country_code` is a data-completeness question, separate from home-jurisdiction resolution).

## 5. SMSF live usage (`retirement_accounts.master_item_key='smsf'`)

| Owner's home country | Active rows |
|---|---|
| `AU` | 4 |
| `IN` | 4 |
| **Total** | **8** |

Half of all live SMSF rows in DEV belong to a user whose *current* `country_of_residence` is `IN`. Per the architecture (`01-canonical-architecture.md` §5, migration `0084`), this is exactly the expected shape **if** these represent genuine "created while AU-resident, later moved to IN, existing SMSF correctly preserved" scenarios — precisely the behaviour spec s.10/s.37 mandates and the SMSF DB trigger is designed to allow (it only blocks new creation/reactivation, never blocks continued visibility/editing of an already-active row). This audit found no way to distinguish that from "test fixture created with `country_of_residence` set to IN incidentally" using read-only aggregate queries. **RESOLVED — Decision PO-5 (2026-08-27):** all four cases are preserved as-is, not treated as invalid, and not investigated further without separate Product Owner authority beyond the read-only lineage check this closure was permitted (see `09-cross-border-model.md` §6 for the full future architecture). This was never a security finding — the DB trigger's own re-verification (73/73 PGlite + 8/8 live-DEV, per the prior SMSF closure report) already independently proved a *forged* non-AU creation is rejected; this data point is about historical record provenance, not a live gate failure.

## 6. Cross-border usage: record `country_code` differs from owner's home `country_of_residence`

| Table | Same as home | Cross-border | Owner has no/null home country | Cross-border pairs |
|---|---|---|---|---|
| `assets` | 840 | 4 | 0 | `AU→IN`: 4 |
| `liabilities` | 267 | 4 | 0 | `AU→IN`: 4 |
| `investments` | 759 | 12 | 11 | `AU→IN`: 9, `IN→AU`: 3 |
| `retirement_accounts` | 358 | 8 | 0 | `AU→IN`: 6, `IN→AU`: 2 |

**Genuine cross-border usage exists in both directions today** (an AU-resident holding IN-tagged assets/investments/retirement accounts, and — less commonly — an IN-resident holding AU-tagged ones). This is valuable evidence that the spec's Cross-Border class (s.6, s.31) is not a hypothetical future scenario but an already-occurring real pattern the architecture needs to keep supporting, not just tolerate. The 11 "owner has no/null home country" investment rows are a data-quality note: these are investment records whose owning `user_id` has no `NOT NULL` match in the users compared (either the profile row is genuinely missing, or the row predates a schema change) — flagged as ambiguous/legacy per spec s.60, not resolved further here.

## 7. `master_financial_items` rows with non-null `country_applicability`

```json
[{ "category": "retirement", "item_key": "smsf", "item_label": "SMSF", "country_applicability": ["AU"] }]
```

Confirms directly against live DEV (not just the migration file) that **SMSF is the only catalogue item with any jurisdiction restriction applied today** — everything else in the 216-row catalogue (`03-catalogue-matrix.csv`) is genuinely unrestricted in the live database, not merely unrestricted in the seed script that may since have been overridden.

## 8. Baseline module record counts (denominators for future risk sizing)

| Table | Row count |
|---|---|
| `user_profiles` | 344 |
| `income_sources` | 406 |
| `expense_items` | 2,104 |
| `assets` | 848 |
| `liabilities` | 339 |
| `investments` | 798 |
| `retirement_accounts` | 367 |
| `insurance_policies` | 635 |

These are the denominators any future wave's migration/reclassification blast-radius should be measured against (e.g. "restricting Industry Super to AU-only new-creation affects at most N of 367 retirement rows, M of which belong to IN-resident owners and must be preserved, not reclassified").

## 9. Explicit classification of ambiguous cases (spec s.60)

| Case | Classification | Basis |
|---|---|---|
| 98 users with `country_of_residence = NULL` | **Ambiguous — likely test data, not confirmed** | Cannot distinguish from read-only aggregates; recommend Product Owner or a follow-up task cross-reference against known test-fixture email domains/creation timestamps before treating as a real onboarding-completion metric |
| 4 SMSF rows owned by IN-resident users | **Ambiguous — plausibly valid cross-border/country-change history, not confirmed** | Matches the exact shape the architecture is designed to produce legitimately; no evidence of a gate bypass found (the DB trigger only blocks *creation*/reactivation, and these are active pre-existing rows) |
| 11 investment rows with no matching `user_profiles` row | **Likely legacy/orphaned data** | Genuine data-quality gap unrelated to jurisdiction logic; flagged, not investigated further (out of this task's scope) |
| Cross-border `AU→IN`/`IN→AU` record pairs (§6) | **Valid cross-border usage** | Directly matches the product's own designed Cross-Border class; no evidence suggesting test-data artefact (present across 4 different modules, both directions, non-trivial counts) |
