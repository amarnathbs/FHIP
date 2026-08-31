# Deliverable 3 — Catalogue Applicability Matrix (narrative summary)

> **STATUS NOTE (added 2026-08-30).** This document records the **proposed classification** for the 20 items, as it stood on 2026-08-27 — **before** Wave 2 was implemented. Its statements that `country_applicability` is "still NULL/unrestricted for all 20" describe that pre-implementation moment and are **no longer current**: migration `0102` has since been deployed.
>
> For the actual current state, read the authoritative [`G0_JA1_Wave2_Final_Scope_Decision_2026-08-30.md`](./G0_JA1_Wave2_Final_Scope_Decision_2026-08-30.md). In short: **11/20 items functionally realigned**; `investment.australian_shares` carries an unresolved class/data/runtime contradiction; the 8 `GLOBAL_WITH_JURISDICTION_VARIANT` items are **classified only, 0/8 functionally certified** — no label resolver or rendering mechanism exists. A disposition recorded here being "approved" means it was **classified**, never that it is functionally implemented or semantically certified.

**Updated 2026-08-27 (G0-JA-1 closure pass)** — the 20 Australia-flavoured items below have been given an individual, Product-Owner-approved disposition (Decision PO-2). This is a documentation/classification update only: the CSV's `Proposed Scope` and `Cross-Border New Creation` columns changed for exactly these 20 rows; no row was added, removed, or renumbered; the underlying `country_applicability` column in DEV/production `master_financial_items` was **not** touched (still NULL/unrestricted for all 20, exactly as before — see `00-README.md` §closure verification). Original discovery baseline evidence (row counts, seed-file provenance, SMSF-only live restriction) is unchanged and re-confirmed valid against current `origin/main` (no diff in `supabase/seed_master_items.sql` between the discovery fork point and current `origin/main`, confirmed fresh in this closure pass).

Full machine-readable matrix: `03-catalogue-matrix.csv` (216 rows, generated programmatically from the real, live `supabase/seed_master_items.sql` — every row transcribed exactly, no invented catalogue entries per spec s.38). **Row count re-verified 2026-08-27: still 216 (216 data rows + header = 217 lines), zero duplicate `Master Key` identifiers, zero malformed rows** (Python `csv` parse, every row exactly 12 columns).

Regeneration: the CSV was produced by a one-off parser script (not committed — trivial to reproduce) that reads `insert into master_financial_items (...) values (...)` tuples directly out of the seed file and classifies each by: (1) the one live, migration-0084-confirmed restriction (SMSF), (2) a curated list of AU-specific product/regulatory terminology markers found by inspection, (3) two items whose names are explicitly cross-border by design (`overseas_income`, `overseas_pension`), (4) everything else defaults to GLOBAL. The 20 AU-flavoured items' classification was a *starting point* for Product Owner review in the discovery baseline; **Decision PO-2 has now resolved that review** — see below. This still is not an implementation: no code, migration, or DEV/production data changed.

## Summary counts (from the real 216-row catalogue, re-verified 2026-08-27)

| Category | Item count |
|---|---|
| income | 27 |
| expense | 68 |
| asset | 22 |
| liability | 25 |
| investment | 31 |
| retirement | 17 |
| insurance | 26 |
| **Total** | **216** |

| Proposed scope | Count | Status |
|---|---|---|
| GLOBAL | 193 | Unchanged — no jurisdiction dimension found |
| GLOBAL (cross-border-signalling by name, e.g. `overseas_income`, `overseas_pension`) | 2 | Unchanged |
| **GLOBAL_WITH_JURISDICTION_VARIANT** (universal concept, AU-flavoured label today) | **8** | **NEW 2026-08-27 — PRODUCT OWNER APPROVED, Decision PO-2b** |
| **HOME_OR_CROSS_BORDER_COUNTRY(AU)** (AU financial structure / cross-border holding) | **12** | **NEW 2026-08-27 — PRODUCT OWNER APPROVED, Decision PO-2a/c** |
| HOME_JURISDICTION (enforced today — SMSF) | 1 | Unchanged (enforcement itself untouched — see `09-cross-border-model.md` §5 for the future SMSF/cross-border reconciliation architecture) |
| **Total** | **216** | Row count unchanged — reclassification only, zero rows added/removed |

None of these 20 rows' `country_applicability` values have actually been changed in the seed file, DEV, or production — the columns above describe the **approved future target class**, not a live enforcement state. Enforcing any of these 20 classifications requires a future migration (Wave 2/3, see `06-implementation-waves.md`) that this task does not create.

## The 20 Australian items — individual disposition (Decision PO-2, approved 2026-08-27)

Per PO-2, no blanket "Australia-home-only" rule was applied. Each item was assigned individually to one of the five canonical classes (`01-canonical-architecture.md` §7), following the Product Owner's own three-part rule: (a) genuine Australian financial structures → `HOME_OR_CROSS_BORDER_COUNTRY(AU)`; (b) universal concepts wearing Australian terminology → `GLOBAL_WITH_JURISDICTION_VARIANT`; (c) cross-border holdings (e.g. a foreign-listed share) → `HOME_OR_CROSS_BORDER_COUNTRY(AU)`, explicitly *not* home-locked. Full per-item rationale is also carried in the CSV's `Cross-Border New Creation` column.

### Class: HOME_OR_CROSS_BORDER_COUNTRY(AU) — 12 items (PO-2a/c)

| Item | Category | Rationale | PO-2 clause |
|---|---|---|---|
| `age_pension` | income | AU government benefit scheme; same family as PO-2's named "government co-contribution" | (a), by direct analogy |
| `family_tax_benefit` | income | AU government benefit scheme; same family as PO-2's named "government co-contribution" | (a), by direct analogy |
| `smsf_property_loan` | liability | SMSF-related — explicitly named | (a) |
| `hecs_help` | liability | HECS/HELP — explicitly named | (a) |
| `ato_payment_plan` | liability | ATO payment plan — explicitly named | (a) |
| `australian_shares` | investment | Cross-border holding — explicitly named; must remain creatable by a non-AU-home user who holds Australian shares as a cross-border asset (does not require AU to be the user's home country) | (c) |
| `industry_super` | retirement | Australian super product — explicitly named | (a) |
| `retail_super` | retirement | Australian super product — explicitly named | (a) |
| `government_co_contribution` | retirement | Government co-contribution — explicitly named | (a) |
| `transition_to_retirement` | retirement | Transition-to-Retirement — explicitly named | (a) |
| `allocated_pension` | retirement | AU superannuation pension-phase product, same family as `account_based_pension` | (a), by direct analogy |
| `account_based_pension` | retirement | Account-based pension — explicitly named | (a) |

### Class: GLOBAL_WITH_JURISDICTION_VARIANT — 8 items (PO-2b)

| Item | Category | Global concept | Australian label today | PO-2 clause |
|---|---|---|---|---|
| `body_corporate` | expense | Shared-building maintenance levy | "Body Corporate" (→ strata/owners corporation in other jurisdictions) | (b), explicitly named |
| `council_rates` | expense | Local-government property charge | "Council Rates" (→ property tax elsewhere) | (b), explicitly named |
| `defined_benefit` | retirement | Defined-benefit pension arrangement | "Defined Benefit" | (b), explicitly named |
| `employer_contributions` | retirement | Employer retirement contribution | "Employer Contributions" | (b), explicitly named |
| `salary_sacrifice` | retirement | Voluntary pre-tax retirement contribution | "Salary Sacrifice" | (b), explicitly named |
| `personal_concessional` | retirement | Pre-tax personal retirement contribution | "Personal Concessional" | (b), by direct analogy to salary-sacrifice |
| `non_concessional` | retirement | After-tax personal retirement contribution | "Non-Concessional" | (b), by direct analogy |
| `spouse_contribution` | retirement | Contribution to a spouse's retirement account | "Spouse Contribution" | (b), explicitly named |

(12 + 8 = 20, matching the CSV exactly — every one of the 20 originally-flagged items now has an explicit, individual disposition. Zero items were left as an undifferentiated "HOME_JURISDICTION blanket".)

**For every one of these 20 items, per PO-2's own preservation requirements:** existing records remain fully visible; existing records remain included in all totals; historical reports are unaffected; the disposition above governs only *new creation/UI-offer* eligibility in a future wave (Wave 2, `06-implementation-waves.md`) — nothing in this task rewrote an existing record or catalogue ID, and no catalogue/DEV/production change occurred (`country_applicability` remains NULL on all 20 rows in the live seed file, exactly as the discovery baseline found it).

## What this matrix deliberately does NOT contain

- No India-equivalent retirement rows (EPF/PPF/NPS) — because none currently exist in the real seed data, and spec s.38 forbids inventing catalogue rows. **Decision PO-1 (approved 2026-08-27) authorises their creation in a future implementation wave** (Wave 3, `06-implementation-waves.md`) — they are documented as approved future additions in `02-module-matrix.md` §Retirement and `01-canonical-architecture.md`, but are explicitly **not** added as rows here; doing so would still be inventing catalogue data ahead of the actual migration. This absence remains factually correct today.
- No re-litigation of the Assets/Investments/Retirement consolidation (migrations `0072`-`0074`) — that taxonomy is out of scope per spec s.16's explicit instruction not to reopen it without a genuine jurisdiction defect (none was found).
- No classification of `goal_types` or `fdh_categories`/`fdh_subcategories` rows — these are separate catalogues with their own dormant `country_applicability` columns (documented in `01-canonical-architecture.md` §3 and `02-module-matrix.md` Goals/FDH sections) but were not enumerated row-by-row here since spec s.38's required columns (Cross-Border New Creation, Calculation Dependency, etc.) are specific to `master_financial_items`' actual usage pattern; a future task extending this matrix to those two catalogues would follow the identical method.
