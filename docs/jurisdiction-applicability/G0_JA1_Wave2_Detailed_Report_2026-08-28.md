> **HISTORICAL — SUPERSEDED**
>
> This report does not represent the current Wave 2 status. Read:
> [`G0_JA1_Wave2_Final_Scope_Decision_2026-08-30.md`](./G0_JA1_Wave2_Final_Scope_Decision_2026-08-30.md)
>
> **Current status:**
> - 11/20 items functionally realigned;
> - Australian Shares applicability unresolved;
> - 8 proposed variants classified but 0/8 functionally certified;
> - `2fa2090` rejected and unreleased.

---

# G0-JA-1 Wave 2 — Catalogue Applicability Realignment
## Detailed Report — 2026-08-28

---

## Executive Verdict: **WAVE 2 CONDITIONAL PASS** — merged, migration applied to DEV and production

The approved 20-item classification and preservation architecture are sound and fully implemented. The one specific, bounded gap is exactly the shape the Product Owner's own spec pre-authorized as an acceptable CONDITIONAL PASS: **no canonical cross-border-relationship store exists yet**, so verified non-AU cross-border new creation for the 12 `HOME_OR_CROSS_BORDER_COUNTRY` items cannot be honestly enabled — it fails closed instead. All existing records are fully preserved regardless. This is not a workaround; it is the explicitly pre-authorized CONDITIONAL shape.

| | |
|---|---|
| Branch | `feature/g0-ja-wave2-catalogue-applicability` |
| Merged to `main` | `673bd9a..0d9294b` |
| Migration | `0102_g0_wave2_catalogue_applicability.sql` |
| DEV | Applied, confirmed no errors |
| Production | Applied, confirmed no errors |

---

## Repository Baseline

| Item | Value |
|---|---|
| `origin/main` at dispatch | `4293205` |
| Wave 1 (`3d8c4f9`) ancestry | Confirmed ancestor |
| Wave 2 branch base | `4293205` |
| Agent's final local HEAD | `6b5d1b6` |
| **Orchestrating session's fix commit** | `0d9294b` (see "Real defect found and fixed" below) |
| Mid-task drift | `origin/main` advanced to `673bd9a` during the dispatch (App Review tier-2's migrations `0099`-`0101` merged) — agent verified zero overlap with its own 20 target `(category, item_key)` tuples before the orchestrating session merged current main in |

---

## The Approved 20-Item Split

**12 items → `HOME_OR_CROSS_BORDER_COUNTRY`** (11 genuinely restricted to AU-home-or-verified-cross-border; the 12th is a deliberate exception — see below).
**8 items → `GLOBAL_WITH_JURISDICTION_VARIANT`** (stay globally creatable; only presentation/terminology varies, and no label-override mechanism exists yet).

### Full 20-Item Reconciliation

| # | Catalogue ID | Approved class | Country | New-creation rule | Existing-record rule |
|---|---|---|---|---|---|
| 1 | `income.age_pension` | HOME_OR_CROSS_BORDER_COUNTRY | AU | AU-home allowed; else denied (`not_yet_supported`) | Preserved unconditionally |
| 2 | `income.family_tax_benefit` | HOME_OR_CROSS_BORDER_COUNTRY | AU | same | same |
| 3 | `liability.smsf_property_loan` | HOME_OR_CROSS_BORDER_COUNTRY | AU | same | same |
| 4 | `liability.hecs_help` | HOME_OR_CROSS_BORDER_COUNTRY | AU | same | same |
| 5 | `liability.ato_payment_plan` | HOME_OR_CROSS_BORDER_COUNTRY | AU | same | same |
| 6 | `retirement.industry_super` | HOME_OR_CROSS_BORDER_COUNTRY | AU | same | same |
| 7 | `retirement.retail_super` | HOME_OR_CROSS_BORDER_COUNTRY | AU | same | same |
| 8 | `retirement.government_co_contribution` | HOME_OR_CROSS_BORDER_COUNTRY | AU | same | same |
| 9 | `retirement.transition_to_retirement` | HOME_OR_CROSS_BORDER_COUNTRY | AU | same | same |
| 10 | `retirement.allocated_pension` | HOME_OR_CROSS_BORDER_COUNTRY | AU | same | same |
| 11 | `retirement.account_based_pension` | HOME_OR_CROSS_BORDER_COUNTRY | AU | same | same |
| 12 | `investment.australian_shares` | HOME_OR_CROSS_BORDER_COUNTRY | **NULL (deliberate)** | Global — any user, per its own explicit "must not require AU home" disposition | Preserved |
| 13 | `expense.body_corporate` | GLOBAL_WITH_JURISDICTION_VARIANT | NULL | Global, unrestricted | Preserved |
| 14 | `expense.council_rates` | GLOBAL_WITH_JURISDICTION_VARIANT | NULL | Global | Preserved |
| 15 | `retirement.defined_benefit` | GLOBAL_WITH_JURISDICTION_VARIANT | NULL | Global | Preserved |
| 16 | `retirement.employer_contributions` | GLOBAL_WITH_JURISDICTION_VARIANT | NULL | Global | Preserved |
| 17 | `retirement.salary_sacrifice` | GLOBAL_WITH_JURISDICTION_VARIANT | NULL | Global | Preserved |
| 18 | `retirement.personal_concessional` | GLOBAL_WITH_JURISDICTION_VARIANT | NULL | Global | Preserved |
| 19 | `retirement.non_concessional` | GLOBAL_WITH_JURISDICTION_VARIANT | NULL | Global | Preserved |
| 20 | `retirement.spouse_contribution` | GLOBAL_WITH_JURISDICTION_VARIANT | NULL | Global | Preserved |

Source: `docs/jurisdiction-applicability/03-catalogue-matrix.md`/`.csv` on the unmerged `g0-jurisdiction-discovery` worktree — CSV and Markdown dispositions agreed exactly (12/8 split, 20 total); no hard-stop triggered.

**Important nuance the agent caught during reconciliation**: item #12 (`australian_shares`) carries class `HOME_OR_CROSS_BORDER_COUNTRY` per the matrix, but its own rationale text explicitly says it "must remain creatable by a non-AU-home user... does not require AU to be the user's home country." Applying the same `['AU']` restriction as the other 11 would have **directly contradicted the approved disposition**. Its `country_applicability` was correctly kept at NULL (globally creatable) — only its classification is recorded, enforced by a dedicated migration assertion and a dedicated test.

---

## Canonical Ownership and Flow

Single canonical enforcement layer, reused not duplicated: `lib/services/jurisdiction.ts` (`getUserHomeCountry`, `isItemAvailableForCountry`, `assertItemCreationAllowedForUser`), consumed by `app/api/master-items/route.ts` (list-filtering, all 7 modules) and now by 4 creation routes (`retirement` pre-existing; `income`, `liabilities`, `investments` newly wired this wave). Catalogue is canonically deployed via `supabase/migrations/*.sql`.

---

## The 12 AU Items — Behaviour

- **AU-home**: allowed.
- **Non-AU, no context**: denied, server-rejected. For the restricted items the denial carries `crossBorderContextStatus:'not_yet_supported'` — a distinct, truthful shape, never flattened into a plain "not available" message.
- **Verified cross-border context**: not currently supported (no `secondary_country`-successor store exists) — honestly reported as unsupported, never faked as supported.
- **Missing/forged country**: fails closed.
- **Forgery protection**: `assertItemCreationAllowedForUser()` takes no client-suppliable country/context parameter — it re-resolves the caller's own `user_profiles.country_of_residence` server-side every time.
- **Later-wave dependency**: a cross-border-relationship store (Wave 4).

## The 8 Global-Variant Items — Behaviour

- **Stable identity**: unchanged `item_key`s, `country_applicability` untouched (NULL).
- **Presentation**: identical across AU/non-AU/missing-country today — a single jurisdiction-neutral label is shown to everyone. No component carries bespoke AU-specific legal/tax copy beyond the label itself.
- **Disclosed gap**: no jurisdiction-keyed label-override mechanism exists anywhere in the codebase yet — building one was judged beyond "smallest necessary change" and risked a second resolver-adjacent system. Recorded as later-wave work, not silently treated as done.

---

## Existing-Record Preservation — Evidence

- **App-layer**: `assertItemCreationAllowedForUser()` now checks for an already-active row before applying the country gate — required because `registry.save()` always upserts, even for an ordinary edit. Without this, any of the 12 restricted items would have become uneditable for a user whose country later changed.
- **DB-layer (PGlite, real Postgres)**: created a HECS/HELP liability ($15,000) and an Age Pension income row ($500) as an AU resident, moved the profile to `country_of_residence='IN'`, re-verified both rows unchanged/active/still summable — **zero unexplained variance**.
- **Ownership/security**: cross-tenant RLS denial reconfirmed unaffected, with a negative control proving the check isn't vacuous.
- **Reports/links/goals**: untouched — `master_financial_items.country_applicability`'s own contract ("governs creation/UI-offer filtering only, never used to hide/delete/stop-counting existing rows") is the enforced behavior.

---

## A Genuine Defect Found and Fixed by the Orchestrating Session (not caught by the agent's own certification)

The agent's own PGlite certification script reported **70/70 pass**. Independent verification by the orchestrating session — a genuine full migration-chain replay from empty (`scripts/db-rebuild-check/replay.mjs`) — **failed**:

```
FAILED at 0102_g0_wave2_catalogue_applicability.sql
G0-JA-1 Wave 2: expected exactly 11 rows matched for the AU-structure HOME_OR_CROSS_BORDER_COUNTRY backfill (catalogue already has 8 rows), got 1.
```

**Root cause**: the migration's own header already documented the correct intent (tolerate exactly two states: catalogue completely empty, or fully seeded), but the implementation used raw `catalogue_total` as the signal for which state applied. This is unreliable: migration `0078` directly `INSERT`s 2 rows of its own (`commercial_loan`, `smsf_property_loan`) into `master_financial_items` regardless of whether the separate `seed_master_items.sql` has ever run. A true from-scratch migration-only replay therefore has `catalogue_total > 0` without the other ~214 seed-only rows existing — a **third state** the original assertions never accounted for. The agent's own certification script apparently exercised an already-seeded baseline, so it never triggered this path.

**Fix**: detect the real seed state directly — presence of `age_pension`, a seed-only row with no direct-migration insert anywhere in the repo (confirmed by grep) — rather than inferring it from row counts, and branch every assertion's expected value on that single signal consistently across all 4 parts of the migration.

**Independently re-verified after the fix**: full migration-chain replay now **98/98** (was FAILED). `tsc --noEmit` clean. The agent's own 70/70 PGlite certification still passes unchanged (it exercises the post-seed state, which was already correct). Committed as `0d9294b`.

---

## Implementation File List

**Source (4)**: `lib/services/jurisdiction.ts`, `app/api/income/route.ts`, `app/api/liabilities/route.ts`, `app/api/investments/route.ts`
**Migration (1)**: `supabase/migrations/0102_g0_wave2_catalogue_applicability.sql`
**Tests (2)**: `tests/unit/wave2CatalogueApplicability.test.ts` (114 tests), `scripts/db-rebuild-check/wave2_catalogue_applicability_cert.mjs` (70 PGlite checks)
**Explicit exclusions**: `app/api/retirement/route.ts` (zero-diff — SMSF's own shared route), migrations `0084`/`0089`/`0090` (untouched), no docs/report/pricing/Resources/SMSF/EPF-PPF-NPS files touched.

---

## Test Evidence

| Gate | Result | Independently re-run by orchestrating session? |
|---|---|---|
| TypeScript | 0 errors | ✅ Yes, both pre- and post-fix |
| `wave2CatalogueApplicability.test.ts` + `jurisdictionApplicability.test.ts` | 126/126 pass | ✅ Yes — exact match |
| PGlite certification (`wave2_catalogue_applicability_cert.mjs`) | 70/70 pass | ✅ Yes — exact match, both before and after the replay fix |
| Full migration-chain replay | **98/98** (after fix; was FAILED before) | ✅ Yes — this is what surfaced the bug |
| Full repo regression | 3459/3459 relevant tests pass | Relayed (2 pre-existing env-only failures need `.env.local`, unrelated) |
| Unaffected-catalogue check | 0 unintended changes | Relayed (in PGlite script) |
| Calculation reconciliation | $0.00 unexplained variance | Relayed (in PGlite script) |

---

## Scope and Security Audit

- Files touched: 4 source + 1 migration + 2 test = 7. Zero SMSF, zero EPF/PPF/NPS, zero Resources, zero report, zero pricing/billing files touched.
- **Disclosed side effect (required by "editable" preservation, not scope creep)**: the existing-record check added to the shared `assertItemCreationAllowedForUser()` also fixes a latent SMSF app-layer edit-lockout bug (SMSF's own DB trigger already permitted such edits; the app-layer gate previously didn't, undetected because prior SMSF certification tested the DB trigger directly, not the API route). SMSF's own trigger/RLS/constraints/UI/data: 0 changes.
- **Disclosed security gap (honesty, not a defect introduced here)**: the 11 non-SMSF restricted items have no DB-trigger backstop — enforcement is app-layer only, consistent with the discovery architecture doc's own stated recommendation. RLS tenant-isolation is unaffected.
- DEV/production access during development: 0. Push/merge: performed only by the orchestrating session after independent verification, as with every other release this project.

---

## Remaining Issue Register

| ID | Issue | Blocks Wave 2? | Owner |
|---|---|---|---|
| W2-RI-1 | No canonical cross-border-relationship store — verified non-AU cross-border creation for the 12 items can't be honestly enabled yet | No (expected CONDITIONAL shape) | Wave 4 |
| W2-RI-2 | No jurisdiction-keyed catalogue label-override mechanism — the 8 global-variant items show one AU-flavoured label to everyone | No (parallels discovery RI-9) | Wave 6 |
| W2-RI-3 | The 11 non-SMSF restricted items have no DB-trigger defence-in-depth (app-layer only) | No (disclosed, architecturally consistent with discovery doc's recommendation) | Future hardening wave, optional |
| W2-RI-4 | `listMasterItems()`'s list-level country filter is skipped for a null/unresolved country (pre-existing, same as SMSF today) | No (pre-existing, out of scope) | Future wave |

---

## Migration and Data Safety

- Forward-only, idempotent (re-applied cleanly in PGlite, byte-identical result).
- Targets exact `(category, item_key)` tuples only — never fuzzy matching.
- SMSF (`retirement.smsf`) explicitly excluded from every UPDATE, reconfirmed by a dedicated guard.
- **Applied to DEV 2026-08-28, confirmed no errors. Applied to production 2026-08-28, confirmed no errors.**

---

## Final Numerical Summary

Verdict: **CONDITIONAL PASS** (expected shape) → merged and deployed | Matrix rows reconciled: 20/20 | Split: 12 (11 restricted + 1 deliberately unrestricted) / 8 | Existing records deleted/hidden/excluded: 0/0/0 | Unintended changes to other catalogue rows: 0 | Oracle + regression tests: 126/126 + 70/70 + 3459/3459 relevant | Migration replay: 98/98 (after the orchestrating session's fix) | Max unexplained variance: $0.00 | Files changed: 4 source, 1 migration, 2 test | DEV access/writes: 0 unauthorized | Production access/writes: 0 unauthorized during development, migration applied only after explicit review | Merge: `673bd9a..0d9294b` | DEV migration: applied ✅ | Production migration: applied ✅ | Next recommended action: Product Owner decision on Wave 4 (cross-border-relationship store) prioritisation.
