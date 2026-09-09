# G6 Discovery Batch 1 — Currency Mechanics (G6.002–G6.006)

Ground truth as of worktree `D:\FHIP\.claude\worktrees\agent-a9fdb5d253f9b5fff`, commit `cd7b201`.

## G6.002 — NRI eligibility

**Owner**: Two disconnected concepts, both scoped entirely inside Investment Intelligence (India tax), never elsewhere:
1. `lib/engines/investment-intelligence/tax/residency.ts` — `checkResidency()`, fails safe to `'unknown'`.
2. `lib/engines/investment-intelligence/tax/taxProfile.ts` — `resolveTaxpayerContext()`, explicit-only (never inferred), `TaxpayerType` includes `NON_RESIDENT_INDIVIDUAL`.

Both run side-by-side, unmerged, in `taxOrchestrator.ts:124-125` (`runTaxSimulation`), feeding `residency.nriRulesMayApply` into `withTaxDisclaimer()`. Persisted in `ii_tax_profiles` (migration `0061_ii_r6_final_tax_profile.sql:34-44`), confirmed **applied to DEV** per `docs/architecture/MIGRATION_REGISTRY.md:277-287`, RLS `auth.uid()=user_id`. Read/write via `lib/services/investment-intelligence/taxRepository.ts:767-799`. Callers: `tax/profile`, `tax/summary` (query override), `investmentIntelligenceReportData.ts:109-114` (maps persisted `taxpayerType` → `residencyStatus`); two other `runTaxSimulation` callers pass `residencyProfile: {}` literally (always `'unknown'`). `countryOfTaxResidence` fallback field exists in the type but no caller ever populates it — **implemented but unreachable**.

**UI surface — yes**: `components/investment-intelligence/TaxIntelligenceClient.tsx:92-96` has a taxpayer-type select with `'NON_RESIDENT_INDIVIDUAL' → "Non-resident individual (NRI)"`, explicitly "never inferred." This is the *only* NRI-declaration surface in the app.

**Used outside India tax?** No — confirmed by grep: zero hits for `\bNRI\b`/`checkResidency`/`ResidencyStatus` outside the II tax files. Not read by dashboard, capability resolver, or goal/forecast engines.

**`cross_border_relationships` and NRI**: table (migration `0122:398-414`) has no eligibility field at all — `relationship_type` enum is `ASSET|INVESTMENT|PROPERTY|INCOME|LIABILITY|RETIREMENT|TAX|OTHER`. The migration's own comment states outright: "no G6 cross-border calculations — `cross_border_relationships` is a declaration store only; nothing reads it to change a total, gate a product, or run a calculation." Purely declarative, zero eligibility semantics.

**Classification**: NRI mechanism = **live and connected** (scoped to II only); NRI outside II = **stale/dead** (genuinely never built); `countryOfTaxResidence` fallback = **implemented but unreachable**; NRI via `cross_border_relationships` = **new requirement** (no canonical ownership, explicitly disclaimed by the table's own design comment).

## G6.003 — Cross-border holdings

**Mechanism**: `lib/engines/dashboard.ts:780-793` (`byCountry()`) produces `assetsByCountry`/`liabilitiesByCountry`/`retirementByCountry`; a hand-rolled loop (lines 893-898) produces `investmentByCountry`. `countriesInUse` (899-905) is the `Set` union — confirmed to be exactly "every distinct `country_code` recorded anywhere." Income/expenses have **no `country_code` column** at all (confirmed absent from `lib/validation/income.ts`), so only 4 registers participate.

**Consumers (genuinely wired)**: `ForecastReportContent.tsx:166` (`hasCrossBorder = countriesInUse.length > 1`), `reportEligibility.ts:67,132-133`, `reportSectionsPremium.ts:463-503` (`buildCrossBorderFull` — the real Cross-Border report section; explicitly discloses "a fully converted single-reporting-currency consolidated view is not yet implemented," line 501), `ReportPreview.tsx:1205`. A separate, narrower home-vs-foreign filter exists only in `resilienceStress.ts:99-106` (`applyCurrencyShock`) and `reportSectionsPremium.ts:520-524`, both operating on `investmentByCountry` only, gated on a resolved `country_of_residence`.

**Is this the only mechanism?** For holdings, yes. Investment Intelligence has **zero** cross-border concept of its own (grep for cross-border keywords in that module returns nothing — it assumes India-domiciled instruments only).

**Real gap found**: register `country_code` is capped `z.enum(['AU','IN'])` in `asset.ts:10`, `investment.ts:12`, `retirement.ts:10`, `liability.ts:23` — while `cross_border_relationships.country_code` accepts all six `AUTHORITATIVE_COUNTRY_CODES`. A user can *declare* a GB/US/SG/AE relationship but can never tag an actual holding with that country. `appCapability.ts:353` independently confirms this as a disclosed, assigned-to-G5 gap.

**Classification**: `byCountry()`/`countriesInUse` rollups = **live and connected**; `applyCurrencyShock` home/foreign filter = **partially wired** (real but narrow, single-scenario); II's own cross-border handling = **stale/dead** (confirmed absent); widening register `country_code` to all six codes = **new requirement**.

## G6.004 — Source and reporting currencies

**Model**: Source `currency_code` is `z.enum(['AUD','INR'])` (or `.default('AUD')`) consistently across **every** validation schema checked — `asset`, `businessEntity`, `commitment`, `expense`, `goal`, `goalContribution`, `goalFundingSource`, `income`, `insurance`, `investment`, `liability`, `retirement`, `smsf`, `profile`. **No exceptions found anywhere.** Cross-field coupling via `lib/validation/currencyCountry.ts` (`expectedCurrencyForCountry`, `lib/constants.ts:56-65`, `COUNTRY_TO_CURRENCY = {AU:'AUD', IN:'INR'}`, typed to `FullExperienceCountryCode` — structurally cannot include a third currency), with an explicit non-defaulted `currency_override` escape hatch that still only ever yields AUD or INR.

Reporting currency = `user_profiles.preferred_currency`, same `AUD|INR` enum, read across `dashboardData.ts`, `goalsData.ts`, `forecastData.ts`, `reportSnapshotResolver.ts`, `twinData.ts`. `lib/engines/fx.ts:14-22` (`convertToReportingCurrency`) is the sole conversion function, `SupportedCurrency = 'AUD'|'INR'`. Applied to totals in `dashboard.ts:537-541` (`reportingValue()`) but **deliberately not** applied to the per-country rollups (comment at 534-536: "the cross-border report section shows those 'as recorded, in each country's own currency' by design") — this directly explains the G6.003 disclosed gap.

`country_capabilities.FX_CONVERSION` seeded `true` only for AU/IN (migration `0122`); migration's own header states "No FX expansion... the existing 2-currency engine ... is untouched."

**Audit lineage — real asymmetry found**: Reporting-currency *changes* ARE audited — `lib/services/countryAudit.ts:38-79` (`recordReportingCurrencyAuditEvent`) writes to `audit_events`, called live from `app/api/user/profile/route.ts:95-101`, deliberately kept separate from country-change audit events (explicit design comment). But per-row source `currency_code` changes are **not audited at all** — no `audit_events` insert exists in the generic register save path; a field edit just overwrites the value.

**Classification**: 2-currency model = **live and connected**, confirmed no exceptions; totals FX conversion = **live and connected**; per-country-rollup non-conversion = **partially wired by design** (disclosed gap); reporting-currency audit = **live and connected**; per-row currency-change audit = **new requirement**; GB/US/SG/AE as source/reporting currency = **new requirement**.

## G6.005 — Exchange-rate lineage

`lib/services/dashboardData.ts:41-50` (`getFxRateAudInr`) always reads the **current** `forecast_global_assumptions.fx_rate_aud_inr` (`is_active=true`, no date parameter), fallback `56`. Every other consumer (`twinData.ts:262`, `reportSnapshotResolver.ts:330`, `investmentPublicationService.ts:355`, `forecastData.ts:522,1466`, `crossBorderCalculator.ts:60`) does the same — current value only, never historical.

**Confirmed absent**: `financial_snapshots` (migration `0005:7-21`) has `currency_code` but **no `fx_rate`/`fx_rate_date` column**; written via upsert keyed on `(user_id, snapshot_month)` (`dashboardData.ts:274-288`), so a later same-month load silently overwrites earlier totals computed at a different rate, with no trace. `report_snapshots` (migration `0010:115-126`) has no FX field either; traced both actual insert sites (`reportsData.ts:239-246,298`) — `snapshot_metadata_json` only ever holds `{reportMonth}` or `{openItemCount}`, never the rate.

**Classification**: current-rate resolution = **live and connected** (working as designed, just current-only); historical FX-rate lineage on any table = **new requirement**, confirmed genuinely absent, not merely unreachable — both candidate tables were inspected directly.

## G6.006 — Domestic and overseas classification

No general-purpose classifier exists. Only two narrow, inline, non-reusable call sites do a home-vs-foreign split, both filtering `investmentByCountry` on `countryCode !== homeCountry` where `homeCountry` is the caller's already-resolved `country_of_residence` (never re-derived from currency): `resilienceStress.ts:99-106` (`applyCurrencyShock`, one stress scenario) and `reportSectionsPremium.ts:520-524` (`applicabilityNote`, one report note). Both fail closed (skip the split) when `homeCountry` is null.

`countriesInUse` (`dashboard.ts:899-905`) and its only consumers (`ForecastReportContent.tsx:166`, `reportEligibility.ts:132-133`, `reportSectionsPremium.ts:465`) confirmed to be purely a distinct-country-count/presence test — none of them label any row/country "domestic" vs "overseas." The Cross-Border Full report section lists every country's totals side by side with no home-country highlighting.

**Classification**: `countriesInUse` distinct-list mechanism = **live and connected**, confirmed to be exactly "list every country, no domestic/overseas split" as suspected; `applyCurrencyShock`'s home/foreign filter = **partially wired** (real, working, but private to one scenario/note, `investments` only); a general-purpose reusable domestic/overseas classification (field, helper, or UI) = **new requirement**, no canonical ownership exists.

## Cross-cutting controls already in place (inventory only)
- `cross_border_relationships` has real, passing live-DEV RLS/forgery certification: `scripts/g1_country_foundation_live_dev_certification.mjs:223-252,301-329` — cross-tenant SELECT/UPDATE/DELETE all correctly blocked with service-role ground-truth verification, forged `user_id` rejected, duplicate-active-relationship rejected, cleanup confirmed.
- `ii_tax_profiles` has an RLS policy plus a documented forgery-fix migration (`0062`), per the migration registry (not independently re-verified this pass).
- Hermetic unit coverage exists for `resolveCountryContext()` (`g1CountryFoundation.test.ts`) and `resolveTaxpayerContext()` (`iiR6FinalTaxpayerContext.test.ts`, 9 cases) — both mock-based.
- **No coverage found** for: FX-rate staleness/regeneration drift (G6.005), source-currency field-level audit (G6.004 — mechanism doesn't exist to test), or domestic/overseas classification beyond the two narrow call sites (G6.006).
