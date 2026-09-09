# LR-11 Phase Report — Company / Family Trust Entity Architecture (Company first; Child Discovery Only)

**Status:** CONDITIONAL PASS — code complete, tsc/lint/unit tests/build clean; migration `0134` applied to DEV and production 2026-09-09, independently re-verified read-only (6/6 checks pass, including a live anon-write-blocked RLS proof). Pushed to `main` (`3c8476f`). Remaining gap before this is terminal: an authenticated cross-tenant round trip against hosted DEV (two real synthetic users) rather than only the anon-write proof below.

**Date:** 2026-09-09
**Scope decision (Product Owner, this phase):** Company built first and fully; Family Trust deferred as a fast-follow reusing the same schema/service/UI shape. Consolidation model: ownership % × entity net asset value is the only thing that reaches personal household Net Worth. Entity liabilities are excluded from personal DTI/DSR only (mirroring SMSF), not from Net Worth consolidation (they still reduce the entity's own net value).

---

## 1. Discovery findings this phase responds to

A dedicated discovery pass (not implementation) preceded any code change. Key findings, organised by the spec's own work packages:

- **WP-01 (reuse SMSF patterns):** SMSF's entity-context architecture (migration `0084`, `lib/services/smsfData.ts`, `lib/engines/smsf/*`) is real and reusable in shape (registry → line items → RLS with cross-referenced `WITH CHECK`), but **no certified ownership/valuation consolidation model exists to extract** — SMSF's own value flows unfiltered into household Net Worth (LR-FI-1 §28's "wealth stays whole, always"), which works only because an SMSF's sole member is the same household. Company/Trust needed a genuinely new consolidation mechanism.
- **WP-02 (entity registry):** `OWNER_VALUES` already offers `'company'`/`'family_trust'` on all 7 financial-data-grid registers (migration `0004`) — confirmed **cosmetic only**: a free-text label with zero backing entity, workspace, or valuation logic.
- **A previously-undisclosed finding surfaced by this discovery**: rows tagged `owner='company'`/`'family_trust'` in the personal `assets`/`investments`/`retirement_accounts`/`liabilities` tables already flow completely into personal Net Worth today — this was checked against `lib/engines/dashboard.ts`'s own explicit, already-certified LR-FI-1 §28 comment ("Net Worth... deliberately keep reading the WHOLE register") and confirmed to be **existing, certified, in-scope behaviour, not a live defect** — SMSF's own value is treated identically. This migration does **not** touch that certified code (see §3 below for the disclosed double-entry risk this creates and why it's a documented UX consideration, not a silent "fix").
- **WP-09 (jurisdiction):** the platform is genuinely NOT AU-only (6 authoritative countries, G1 registry) — SMSF's hardcoded AU-only trigger gate was confirmed **not** to transfer to Company/Trust without separate evidence. This build makes `country_code` nullable/informational only, with zero DB-level restriction.
- **WP-10 (Child discovery):** confirmed **absent** beyond a cosmetic owner-enum value and an unrelated aggregate `households.dependants_count` integer. No schema or UI built, per the phase's own lock.

Full discovery detail is in this phase's own working notes; the classifications above are what shaped every implementation decision below.

## 2. What was built

### Schema (migration `0134`, not yet applied — see §5)
- `business_entities` — registry: `entity_type` (constrained to `'company'` only for now — Family Trust is a forward migration widening this CHECK, not a redesign), `country_code` (nullable, no jurisdiction restriction — unlike SMSF), `currency_code` (AUD/INR, matching the existing 2-currency engine), `ownership_percentage` (0,100], `valuation_mode` (`summary`/`detailed`, mirroring SMSF's own dual-mode discipline), `summary_net_asset_value` (net, not gross — same semantics as `smsf_funds.summary_balance`).
- `business_entity_assets` / `business_entity_liabilities` — Detailed-mode line items.
- RLS: exact pattern reused from SMSF (migration `0084`) — owner-only on the parent, cross-referenced `WITH CHECK` subquery on every child table.
- **No DB-side NAV-compute function or mode-switch RPC**, unlike SMSF's `smsf_compute_detailed_net_value()`/`smsf_switch_to_detailed()`: these are brand-new, single-purpose tables with no other historical writer to race against (SMSF needed its $0-variance switch gate specifically because `retirement_accounts.current_balance` had other writers). NAV is computed read-time in the application layer instead — see below.

### Valuation / consolidation engine (`lib/engines/businessEntityValuation.ts`)
Pure, isolated functions: `computeBusinessEntityNetAssetValue()` (nets Summary or Detailed mode, currency-converted via the same `convertToReportingCurrency()` `dashboard.ts` already trusts) and `computeBusinessEntityOwnershipValue()` (applies each entity's own ownership % to its own NAV, summed across active entities). Wired into `lib/engines/dashboard.ts` as a new additive term: `netWorth` and `totalAssetsCombined` both now include `businessEntityOwnershipValue`, which is also exposed as its own transparent field — `totalAssetsCombined - totalLiabilities === netWorth` keeps holding for every household, with or without business entities.

### Service layer + API (`lib/services/businessEntityData.ts`, `app/api/business-entities/**`)
Full CRUD for entities and their Detailed-mode assets/liabilities, mirroring `smsfData.ts`'s shape. No jurisdiction gate on creation (WP-09's own lesson).

### UI (`app/(app)/companies/page.tsx`)
A new, dedicated nav destination (added to AppShell's "Your finances" group) — list/create companies, edit Summary-mode net value inline, add/remove Detailed-mode asset/liability line items, archive (soft-delete). Each card shows the entity's own net value alongside "your share" (the exact figure counted in Net Worth), so the consolidation math is never opaque to the user.

### Capability manifest
Added `BUSINESS_ENTITIES` as a genuine new `ModuleKey` (`requiredCapability: UNIVERSAL_MODULES`, `operationPolicy: OPERATIONS_FOLLOW_VIEW`) — deliberately NOT gated behind the G5B write-enablement flag (no pre-existing GENERIC-write history to re-certify, unlike Income/Expenses/Insurance) and genuinely universal (no country hardcode anywhere), unlike ASSETS/LIABILITIES (AU/IN-only) or SMSF (AU-only).

## 3. Disclosed gap: legacy `owner='company'`/`'family_trust'` tags, not touched

The personal-grid `owner='company'`/`'family_trust'` free-text tags found in discovery (§1) are **left exactly as they were** — LR-FI-1 §28's certified "wealth stays whole" philosophy governs the whole register and is out of this phase's locked scope to reverse. This creates a real, disclosed double-entry risk: a user could theoretically record the same company's assets both as a personal-grid row tagged `owner='company'` AND in the new Company workspace, double-counting it. This is a documented UX/product consideration for a future pass (e.g. relabelling or retiring those two owner-dropdown values now that a real Company entity exists), not something this migration silently "fixes" by touching certified code without a separate decision.

## 4. Negative controls (LR-11's own mandatory NEG-01 through NEG-08)

All except NEG-06/NEG-07 (N/A this phase — no Trust or Child schema exists to violate) are exercised as real tests in `tests/unit/businessEntityValuation.test.ts` / `businessEntityRoutes.test.ts`:

| # | Control | Result |
|---|---|---|
| NEG-01 | Entity income enters household | Tested: adding a business entity leaves every cash-flow figure (`grossMonthlyIncome`, `monthlySurplus`, `totalMonthlyExpenses`) byte-identical. No entity-income concept exists at all in this scoped delivery — confirmed absent, not merely filtered. |
| NEG-02 | Entity debt enters DTI | Tested: a business entity with a large liability leaves `totalLiabilities`, `householdLiabilityBalance`, `debtToIncome`, `debtServiceRatio` byte-identical — structural (a table the personal engine never reads), not a runtime filter. |
| NEG-03 | Underlying assets + ownership value double counted | Tested: `totalAssetsCombined - totalLiabilities === netWorth` holds with entities present; only the netted, ownership-scaled value is ever exposed/consolidated, never the entity's gross assets separately. |
| NEG-04 | Personal guarantee inferred | Confirmed absent by construction — no personal-guarantee concept exists anywhere in the schema, validation, or engine. |
| NEG-05 | SMSF rules copied blindly | Tested: the create schema accepts all 6 authoritative country codes (and null) — no AU-only literal anywhere in `businessEntityCreateSchema` or its API routes. |
| NEG-06 | Trust semantics invented | N/A — `entity_type` is hard-constrained to `'company'` only; no trust-specific field or logic exists anywhere. |
| NEG-07 | Child schema built without approval | Confirmed absent — no child table, column, or UI was created; discovery's own finding (nothing beyond a cosmetic label + unrelated aggregate counter) stands unchanged. |
| NEG-08 | Cross-entity data leak | Tested at the unit level (fake-Supabase-client cross-tenant requests denied) for entities, assets and liabilities. RLS policies mirror SMSF's already-certified shape exactly. **Live production proof (2026-09-09)**: an unauthenticated anon-key INSERT attempt into `business_entities` was rejected with `401`/`42501` (RLS, no anon policy) — genuine live confirmation the table is not openly writable. A full authenticated cross-tenant round trip (two real synthetic users, live DEV) remains a disclosed residual gap. |

## 5. Verification performed / outstanding

- `npx tsc --noEmit` — clean.
- `npx eslint` on every new/changed file — clean.
- **29 new unit tests** across 2 new files (`businessEntityValuation.test.ts`, `businessEntityRoutes.test.ts`), all passing.
- `tests/unit/appCapabilityManifest.test.ts` / `appCapability.test.ts` — extended for the new `BUSINESS_ENTITIES` ModuleKey and `companies`/`business-entities` folder mappings; both pass.
- `tests/unit/fdh1Isolation.test.ts` — unaffected (confirmed via standalone re-run after an initial contention-driven timeout under full-suite parallel load).
- **Not yet done**: migration `0134` application to DEV or production; live-DEV RLS cross-tenant proof (AC-05); a real end-to-end route→UI→reload journey (AC-07) against hosted DEV; production deployment proof (AC-10 is N/A — no jurisdiction/mobile-specific concern beyond the existing responsive `SectionCard`/grid layout already used elsewhere, not independently re-verified this pass); full repo test suite / production build (queued next).
- **Dashboard resilience note**: `loadBusinessEntitiesForValuation()` returns `{data, error}` rather than throwing (matching this codebase's own Supabase-client convention), and `dashboardData.ts` falls back to `[]` on any error — so if this code were ever deployed before migration `0134` exists in a given environment, the Dashboard would NOT break; it would simply show zero business-entity contribution (identical to today) until the migration lands. This was verified by inspection, not by an actual "deploy before migration" live test.

## 6. Explicitly deferred (disclosed, not silently dropped)

- **WP-07 (entity-tagged transaction/import ingestion)**: discovery found SMSF's own precedent is import-**blocking**, not import-tagging (FDH-12's deliberate boundary) — there is no existing tagging mechanism to reuse, and building one is a materially separate, larger capability. Deferred to a future continuation.
- **WP-08 (entity reports)**: Reports Hub infrastructure and SMSF's own CSV-export precedent (`smsfExport.ts`) are confirmed reusable, but no Company-specific export was built this pass, to keep this delivery bounded to registry + valuation + workspace + tests, per the Product Owner's own "Company first, fully verified" scoping choice.
- **Family Trust**: planned fast-follow reusing this exact schema/service/UI shape (`entity_type` already a real column, just constrained to `'company'` for now) — a forward migration widening the CHECK constraint plus a UI label change is expected to be materially smaller than this phase.

## 7. Closure status

Steps 1-3 (DEV migration, push, production migration) are complete as of 2026-09-09, each independently confirmed by the user and, for production, independently re-verified read-only by this agent (6/6 checks: negative controls sound, all 3 new tables genuinely live, anon writes blocked). The one remaining item — an authenticated two-user cross-tenant round trip against hosted DEV (create a company as user A, confirm user B cannot read/write it via a real session, confirm Net Worth reflects the ownership-scaled value end-to-end) — is deferred to whenever the Product Owner wants full terminal closure; it does not block starting LR-12.

---

*Continuing the LR-2..LR-12 programme: LR-12 (final phase) is next, followed by the deferred LR-1, then the consolidated final matrix report.*
