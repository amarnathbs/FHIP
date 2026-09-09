# G6 Canonical Ownership Decisions (G6.029–G6.056)

Synthesized directly from the G6 discovery pass (`docs/country-programme/g6-discovery-batch1..6*.md`) — same repo state, `cd7b201`. These are **decisions, not implementation** — per this phase's own instruction, no code is written here. Each decision states: the canonical owner going forward, why (grounded in discovery), and whether it requires new schema/code or is already correctly owned.

Guiding rule carried through every decision below, per the discovery's own repeated finding: **country is never derived from currency, locale, or a client-supplied value** — the sole authoritative sources are `user_profiles.country_of_residence` (MCC), `primary_country`/`billing_country` (G1), and `cross_border_relationships` (G1/G3), all resolved through `lib/services/jurisdiction.ts`.

## G6.029 — Canonical country relationships
**Owner: unchanged.** `cross_border_relationships` (migration 0122/0127) + `resolveCountryContext()` remain canonical. Discovery found this table structurally sound (RLS, forgery-proof, live-DEV certified) but with zero consumers. **Decision: no new table.** G6's job is to give this table its first real consumers (G6.007 net worth, G6.017 FDH, etc.), not to replace it. The two competing signals found (`secondary_country`, NRI status) are **superseded, not merged** — `secondary_country`'s two live readers (`twinData.ts`, `financialContextObject.ts`) must be migrated to read `cross_border_relationships` instead as part of implementation; NRI status stays scoped to India tax (G6.030 below), not folded into this table.

## G6.030 — NRI eligibility
**Owner: unchanged, deliberately narrow.** `lib/engines/investment-intelligence/tax/residency.ts`/`taxProfile.ts` remain India-tax-scoped. **Decision: do NOT generalize NRI status into a household-wide flag.** Discovery found this is an explicit-only, never-inferred field by design — widening its scope without a dedicated legal/tax review would be exactly the "invent eligibility rules not approved" pattern the master spec forbids elsewhere (LR-11's own Family Trust lock is the direct precedent for this caution). Any G6 multi-country framework references NRI status as an *input*, never redefines what NRI means.

## G6.031 — Cross-border holdings
**Owner: `byCountry()` rollups remain canonical for "which countries does this household touch"; register `country_code` columns remain canonical for "which country does this specific row belong to."** **Decision: widen the 4 registers' `country_code` enum from `['AU','IN']` to all 6 `AUTHORITATIVE_COUNTRY_CODES`** (assets, investments, retirement_accounts, liabilities) — a schema change, but additive (widen a CHECK/enum, no data migration needed since existing rows are already AU/IN). This directly answers discovery's own disclosed gap ("a user can declare a GB relationship but never tag a holding with it").

## G6.032 — Source and reporting currencies
**Owner: unchanged.** `lib/engines/fx.ts`'s 2-currency (`AUD`/`INR`) model stays canonical. **Decision: do NOT widen currency support as part of G6.** Discovery confirmed zero exceptions to the 2-currency model anywhere, and country ≠ currency (a GB-resident can validly report in AUD or INR already, per the existing FULL/GENERIC split). Widening the FX engine to 6 currencies is out of scope for a "country relationships" phase and belongs to a dedicated FX-expansion decision, per `country_capabilities.FX_CONVERSION` staying false for GB/US/SG/AE (an explicit prior PO decision, migration 0122).

## G6.033 — Exchange-rate lineage
**New owner required.** No historical FX-rate lineage exists anywhere (confirmed absent on both `financial_snapshots` and `report_snapshots`). **Decision: add `fx_rate_aud_inr` and `fx_rate_date` columns to `financial_snapshots`**, populated at write-time from `getFxRateAudInr()`'s already-resolved value (no new resolution logic — just persist what's already computed). This is the minimal fix for the real, confirmed "silent overwrite" data-integrity gap discovery found (G6.019/G6.005).

## G6.034 — Domestic and overseas classification
**New owner required.** No general-purpose classifier exists — only two narrow, private call sites (`resilienceStress.ts`, `reportSectionsPremium.ts`). **Decision: extract a single shared helper, `isDomesticRecord(recordCountryCode, homeCountryCode)`, into `lib/services/jurisdiction.ts`** (the existing canonical country-context module), and have both existing call sites adopt it (a refactor, not new logic — the two sites already compute the same comparison independently). This becomes the canonical building block for any future domestic/overseas UI.

## G6.035 — Consolidated net worth
**Owner: `computeDashboard()`'s `netWorth` stays canonical for the single blended total; `byCountry()` stays canonical for the unconverted per-country view.** **Decision: add a third, new derived field — `netWorthByCountryConverted`** (each country's rollup, currency-converted into the reporting currency, computed alongside the existing unconverted `assetsByCountry`/etc.) — directly closing the gap the codebase's own report copy already admits ("a fully converted... view is not yet implemented"). This is additive: the existing `netWorth` and unconverted `byCountry()` fields are untouched, exactly matching AC-09's "never mixes incompatible entity populations" discipline already proven in LR-11.

## G6.036 — Cash-flow consolidation
**Owner: unchanged — no country dimension needed.** Discovery confirmed `income_sources`/`expense_items` have no `country_code` and GENERIC users cannot create rows in them at all (hard MCC trigger, not merely a soft gate). **Decision: no consolidation change.** If G6.041 (below) adds `country_code` to these registers, cash-flow consolidation by country becomes possible as a read-side addition later — explicitly deferred, not silently expanded here.

## G6.037 — Goal linkage
**New owner required for cross-currency safety.** `computeLiveLinkedFundingValue()` has zero currency awareness — a real, confirmed gap (raw INR added to an AUD goal target with no conversion). **Decision: `loadLinkedContributionSources()` must additionally select each linked row's `currency_code`, and `computeLiveLinkedFundingValue()` must convert via the existing `convertToReportingCurrency()` before comparing against the goal's own currency** — reusing the certified fx.ts function, not inventing a second one. `country_code` on `user_goals` remains display-only, as today (no calculation dependency proposed).

## G6.038 — Forecast consolidation
**Owner: `crossBorderCalculator.ts` stays canonical for the foreign-currency-slice forecast; the domestic calculators stay canonical for the blended trajectory.** **Decision: no forced integration.** Discovery found these are two deliberately separate, both-live views (blended-total forecast vs. isolated-foreign-slice forecast), matching the net-worth pattern in G6.035. Reconciling them into one "AU trajectory + IN trajectory converging" view is a materially larger forecasting-engine change than this phase's own boundary — **explicitly deferred to a future phase**, not attempted here.

## G6.039 — Retirement and pension boundaries
**Owner: `retirement_accounts.account_type` remains the schema field; no new consumer added in G6.** Discovery found `account_type` (EPF/PPF/NPS/super) is captured but functionally inert — genuinely modelling jurisdiction-specific pension rules (contribution caps, preservation age, tax treatment per product) is a large, dedicated undertaking on its own. **Decision: G6 does not attempt product-specific pension rules.** The one thing G6 legitimately touches here is confirming SMSF's isolation stays untouched (confirmed: zero dependency on anything G6 changes, per G6.016's own discovery) — no other ownership change.

## G6.040 — Investment holdings
**Owner: unchanged for AU/IN; Investment Intelligence (India) stays India-only by design.** **Decision: widen `investments.country_code` per G6.031's decision (all 6 codes), but do NOT extend Investment Intelligence's own India-only architecture** — that module's manifest entry already states "not evaluated for AU or GENERIC applicability... out of scope for any change here," and this phase inherits that boundary rather than reopening it.

## G6.041 — Property and liabilities
**Decision: widen `assets`/`liabilities.country_code` per G6.031.** Additionally: `property_liability_links` gets **no new country-matching CHECK constraint** — discovery found the auto-suggest heuristic already soft-matches by country and a manual cross-border link (e.g. an AU liability securing an overseas property) is a real, legitimate scenario, not a defect to block. No change to the link table.

## G6.042 — Income and expenses
**New schema required.** Discovery confirmed, at four independent layers (schema/validation/grid-config/dashboard-SELECT), that these two registers have no country attribution mechanism at all. **Decision: add a nullable `country_code char(2) references countries(country_code)` column to `income_sources` and `expense_items`**, following the exact existing pattern on assets/liabilities/investments/retirement (same FK, same nullability, no MCC-trigger change needed since these tables are already gated). This is the single largest schema decision in this batch — flagged here for explicit note, not silently bundled with the smaller widening decisions above.

## G6.043 — Insurance coverage
**Decision: add the same nullable `country_code` column to `insurance_policies`**, matching G6.042's reasoning. Separately: the `cover_type` enum's AU/UK-flavoured framing (`income_protection` etc.) is **not renamed or restructured** in G6 — that is a content/regulatory-wording decision belonging to G7 (Reports/Resources/Disclosures), not a schema-ownership one.

## G6.044 — SMSF preservation
**Owner: unchanged, explicitly reaffirmed.** Discovery's own conclusion stands as the decision: `retirement_accounts_smsf_au_gate()` and `householdContext.ts` are untouched by G6, confirmed zero dependency on anything this phase changes. **The one binding constraint G6 must honour**: any future change to `requireCountryConfirmedUser()`/`countryConfirmationBlockResponse()`/`user_profiles.country_of_residence`'s meaning (not `resolveCountryContext()`, which SMSF doesn't use) requires an SMSF regression pass, since that IS SMSF's real dependency.

## G6.045 — FDH ingestion and source provenance
**Owner: unchanged — `FDH_COUNTRY_CODES = ['AU','IN']` stays as-is.** **Decision: G6 does not widen FDH's bank-adapter country vocabulary.** Building GB/US/SG/AE bank-statement parsers is an entirely separate, large undertaking (new adapters, new certification) outside a "country relationships" phase's boundary — explicitly deferred. The existing generic CSV fallback and the PDF "no fallback, clear error" behavior are both already correct, safe defaults for an unsupported country and need no change.

## G6.046 — Capability resolution
**Owner: `lib/services/appCapability.ts` remains the single resolver — this is where G6's real integration work concentrates.** **Decision: wire `resolveModuleCapability('CROSS_BORDER', ...)` into the one live route that currently bypasses it** (`app/api/user/cross-border-relationships/route.ts`, which today gates via the legacy `requireCountryConfirmedUserAllowingGeneric` directly) — closing the "seeded but zero consumer" gap discovery found, without introducing a second resolver or duplicating the manifest.

## G6.047 — Historical snapshots
**Decision: covered by G6.033 above** (the same `financial_snapshots` fix — `fx_rate_aud_inr`/`fx_rate_date` columns — also closes this topic's own currency-drift concern, since both stem from the same missing-lineage root cause). No separate schema change needed beyond G6.033's.

## G6.048 — Audit events
**Owner: `audit_events` stays canonical for country/currency-change events specifically (its only established usage per discovery); no new general-purpose audit consumer is added.** **Decision: any new G6 write path that changes a country-relevant field (e.g., a new cross-border relationship becoming a consumer elsewhere) follows the existing `lib/services/countryAudit.ts` pattern** — same table, same service-role-write convention — rather than each new feature inventing its own audit table, which discovery found is otherwise this codebase's actual (if disclosed) precedent for other modules. G6 deliberately does not repeat that fragmentation.

## G6.049 — RLS and ownership
**Owner: the established owner-only + cross-referenced-child pattern (confirmed universal, six documented exceptions all legitimate) is reaffirmed as-is.** **Decision: every new/widened table or column in this batch (G6.033's snapshot columns, G6.042/G6.043's new country_code columns) uses the exact same pattern** — no new RLS design needed, this is a "conform to the existing standard" decision, not a "design a new one" decision.

## G6.050 — Country-change interaction
**New guard required, following the LR-10 WP-10 precedent.** Discovery found `confirm_primary_country_change()`'s preview route makes an **unverified** claim (`cross_border_relationships_retained: true`, hardcoded, never actually checked against the table). **Decision: the preview route must genuinely query `cross_border_relationships` and reflect its real state**, not a hardcoded literal — a correctness fix to existing code, not new architecture. Additionally, `forecast_profiles.country_code`'s confirmed staleness-on-country-change (flagged Medium risk in the pre-existing `09-cross-border-model.md`) is **not fixed in G6** — noted as a carried-forward, already-disclosed risk, explicitly not silently expanded into this phase's scope.

## G6.051 — API contracts
**Decision: standardize the three divergent country-code Zod validation strategies found in discovery onto one.** All future/touched routes (the ones actually modified by this phase: cross-border-relationships, income/expense/insurance validation, snapshot schema) use `z.enum(AUTHORITATIVE_COUNTRY_CODES)` — the strictest, closed-set form already used by `profile` PUT — rather than the looser `z.string().length(2)` pattern. Routes NOT touched by this phase (`country/confirm`'s own bespoke validation) are left exactly as they are; this is not a repo-wide validation-consistency refactor, only the routes this phase's own schema changes touch.

## G6.052 — Data migration safety
**Owner: the existing collision-guard practice and `MIGRATION_REGISTRY.md` convention, reaffirmed.** **Decision: every migration this phase produces runs the collision-guard script and gets a `MIGRATION_REGISTRY.md` entry**, per the already-established, actively-used practice discovery confirmed (6+ prior real collisions, all resolved the same way). No new tooling invented.

## G6.053 — Regulatory limitations
**Owner: `country_capabilities.DOMESTIC_TAX_OUTPUTS` (and siblings) stay the registry of record; still correctly all-false for GB/US/SG/AE.** **Decision: no regulatory claim is added for any GENERIC country in G6** (confirmed zero currently exist, and G6's own scope is relationships/consolidation, not tax-content). The one real gap discovery found — `DOMESTIC_TAX_OUTPUTS` being unenforced anywhere — is **not closed in G6**; enforcing it belongs with whichever phase first builds a feature that would need the enforcement (there is none yet), so adding an enforcement gate with nothing to gate would be scope invention.

## G6.054 — User disclosures
**Owner: `lib/engines/investment-intelligence/tax/disclaimer.ts` stays canonical for tax-specific disclaimer text; no new general disclosure mechanism is added.** **Decision: the one live, reachable gap found (NRI disclaimer suppression is never cross-checked against `country_of_residence`) gets a targeted fix** — `investmentIntelligenceReportData.ts`'s residency derivation additionally compares the self-declared `taxpayerType` against the household's actual `country_of_residence` and keeps the NRI caveat visible if they disagree, rather than trusting the self-declaration alone. This is a precision fix to existing logic, not new disclosure infrastructure.

## G6.055 — Calculation reconciliation
**Owner: no change — the "one oracle script per phase" convention is reaffirmed, not replaced.** **Decision: G6 does not build a general-purpose reconciliation harness.** Discovery correctly identified this as a real absence, but building shared oracle/diffing infrastructure is a tooling investment orthogonal to "country relationships" — any G6 calculation change (G6.033's snapshot fix, G6.037's goal-currency fix) gets its own dedicated test with hand-computed expected values, following the exact `lrFi2HouseholdDebtRatios.test.ts` pattern already established, not a new harness.

## G6.056 — Failure and rollback
**Decision: every migration in this phase carries the `-- ROLLBACK: <sql>` comment convention** (the 5-file pattern discovery found in the newest migrations), continuing that recent practice forward. **No retroactive rollback-documentation is added to any pre-existing migration** — that would be scope creep well outside G6's boundary.

---

## Summary: what G6 actually builds (carried into G6.057+ Data-contract specification)

Real schema/code changes decided above, all additive, all reusing certified patterns:
1. Widen `country_code` enum (assets/liabilities/investments/retirement_accounts) to all 6 `AUTHORITATIVE_COUNTRY_CODES` (G6.031/040/041).
2. Add nullable `country_code` to `income_sources`/`expense_items`/`insurance_policies` (G6.042/043).
3. Add `fx_rate_aud_inr`/`fx_rate_date` to `financial_snapshots` (G6.033/047).
4. Extract `isDomesticRecord()` helper into `jurisdiction.ts` (G6.034).
5. Add a converted, per-country net-worth breakdown field alongside the existing unconverted one (G6.035).
6. Fix goal-funding cross-currency conversion in `computeLiveLinkedFundingValue()` (G6.037).
7. Wire `CROSS_BORDER` capability into its one bypassing route (G6.046).
8. Fix the preview route's hardcoded `cross_border_relationships_retained` claim (G6.050).
9. Fix NRI-disclaimer/`country_of_residence` cross-check (G6.054).
10. Migrate `secondary_country`'s two live readers onto `cross_border_relationships` (G6.029).

Explicitly deferred/out of scope (named, not silently dropped): FX currency-set expansion (G6.032), forecast trajectory reconciliation (G6.038), jurisdiction-specific pension rules (G6.039), FDH bank-adapter expansion (G6.045), `DOMESTIC_TAX_OUTPUTS` enforcement (G6.053), a general reconciliation harness (G6.055), retroactive rollback docs (G6.056), `forecast_profiles.country_code` staleness (G6.050).
