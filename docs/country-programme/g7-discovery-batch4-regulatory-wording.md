# G7 Discovery Batch 4 — Regulatory Wording/Disclosures (G7.014–G7.018)

Repo: `D:\FHIP\.claude\worktrees\agent-a9fdb5d253f9b5fff` @ `cd7b201`. Builds on `g6-discovery-batch5-cross-cutting-a.md` (G6.025), `g6-discovery-batch6-disclosures-reconciliation-rollback.md` (G6.026/027), `g6-ownership-decisions.md` (G6.030/033/047/053/054), `g6-data-contracts.md` (Contracts 3/9), and `g7-discovery-batch1-report-geography-currency.md` (G7.001-004).

## G7.014 — AU regulatory wording

**In-app Reports/Dashboard engines: zero AU-regulator naming found.** Full-text search across `app/`, `components/`, `lib/engines/` for `ATO`, `Australian Taxation Office`, `Australian Government`, `superannuation guarantee`, `ASIC`, `APRA`, `Services Australia`, `Centrelink` returns no hits in `app/`, one incidental hit in an admin-CMS-editor example-placeholder string, and only internal classification-term hits in `lib/financial-data-hub/**` (payslip/retirement parsing labels used to recognise import line items, never rendered to a user). `reportCopy.ts:77,138` uses the neutral label "Superannuation" with no rate or regulator citation. **Classification: stale/dead** — this risk does not exist in the app engines today.

**The real AU-regulator content lives in the Resources CMS, and IS reachable by non-AU users today.** Seeded content (`artifacts/resources/r1-7d/*.json`) contains user-facing prose naming "Australian Taxation Office" and citing a specific rate: *"As at 20 August 2026, the Australian Taxation Office states the general super guarantee percentage is 12%..."* — dated, regulator-attributed, numeric.
- `resource_posts.jurisdiction` (`0049...sql:483`) is real: `check (jurisdiction in ('global','australia','india','australia_india_cross_border'))`.
- **Serving path traced:** `app/(marketing)/resources/[slug]/page.tsx:63-64` fetches by slug only — no comparison against the viewer's `country_of_residence`/`primary_country` anywhere. `jurisdiction` is used only to (1) bias related-article recommendations, (2) render a small badge (`JurisdictionLabel`). The browse-filter `jurisdiction` param defaults to `'all'` — never a viewer-country restriction.
- Disclaimer is generic, not jurisdiction-scoped: `DEFAULT_RESOURCE_DISCLAIMER` — "general financial education, not personal financial advice" — no "applies to Australian residents only" caveat anywhere.
- No test exercises jurisdiction-vs-viewer-country.

**Classification: partially wired** — a real, correctly-modelled, honestly-populated jurisdiction field exists, but functions purely as a browse filter/badge, not a display gate or country-aware warning. Closing that gap is a new requirement (no enforcement exists to extend).

**Adjacent finding — `REGULATORY_GUIDANCE` capability.** Seeded `true` for AU and IN (migration `0122`, lines 207/229), `false` for GB/US/SG/AE. Defined in `appCapability.ts`/`jurisdiction.ts`/`g5bWriteManifest.ts`, but a search for any actual `requireModuleCapability`/`hasCapability` call site referencing it returns **zero results** — same unenforced pattern G6.025 found for `DOMESTIC_TAX_OUTPUTS`. **Classification: backend-only** — Resources' `jurisdiction` field is a wholly separate, uncoordinated mechanism, never cross-referenced with this capability flag.

## G7.015 — India regulatory wording

**Live, user-facing India regulatory wording exists in Investment Intelligence's tax module, more literal than G6.026 characterised.** `components/investment-intelligence/TaxIntelligenceClient.tsx:198-201` renders verbatim, to the logged-in user: *"...Sections 111A/112A apply identically to residents, NRIs, and HUFs for these figures..."* — actual Income-tax Act section numbers shown in-product (G6.026's claim that only the disclaimer module names jurisdictions, not section numbers, is incomplete). `lib/engines/investment-intelligence/tax/disclaimer.ts:14-42` additionally names "Indian capital-gains tax rules," "Income-tax Act, 2025," and "Section 195."

**Scoping is correct in practice but NOT correct by construction.** The route gate (`requireCountryConfirmedUser` → `FULL_EXPERIENCE_COUNTRY_CODES = ['AU','IN']`) admits AU users equally with IN users — no `country_of_residence === 'IN'` check anywhere in `taxRepository.ts`, `taxOrchestrator.ts`, or the route. Same true for the report's `tax_and_cost` chapter (per G7.002): its inline comment claims "India-only" but the code filters on "does this household have any disposal rows," not on country. Today this is true only because the upstream CAMS/mutual-fund import pipeline is itself India-specific, not because of an explicit gate. **Classification: partially wired** — scoping correct as an emergent property of what data can exist, not as a designed/enforced boundary; an explicit country-of-residence check would be a new requirement, not a fix to broken code (nothing is currently broken in production).

**No SEBI/RBI/EPFO naming found anywhere reachable by a user** — only in unrelated docs/institution master-data. **Classification: stale/dead** for these specifically.

## G7.016 — NRI disclosures

Extends G6.026/G6.054's finding (`residencyProfile` derived solely from self-declared `taxpayerType`, never cross-checked against `country_of_residence`) into the report surface.

**Finding 1 — the report DOES carry the disclaimer, structurally, via the shared engine.** `withTaxDisclaimer()` always attaches the base disclaimer, and conditionally attaches `NRI_SCOPE_DISCLAIMER` when `nriFlagged`. `reportSectionsPremium.ts:740-748` (`buildTaxAndCost`) reads this output — `limitationText` becomes the NRI caveat when the flag fires, confirmed actually rendered (`ReportPreview.tsx:1427`). This part is genuinely **live and connected**.

**Finding 2 — report generation independently re-derives `residencyProfile`, byte-for-byte duplicating the same flawed logic, not via a shared function.** Identical inline ternary exists in two places: `app/api/investment-intelligence/tax/summary/route.ts:87-92` (live UI) and `lib/services/investmentIntelligenceReportData.ts:109-114` (report generation). Both read only `taxProfile.taxpayerType`; **neither reads `country_of_residence`.** Only difference: the live route also accepts a `?taxpayerType=` query override the report loader has no equivalent of. **This confirms the report doesn't independently fix or diverge from the flaw — it re-implements the same flaw via copy-paste.** G6's remediation (Contract 9 / G6.054) proposes patching only `investmentIntelligenceReportData.ts`'s copy — based on this discovery, the live route's copy would need the identical fix or the two surfaces would newly diverge (report cross-checked, live UI not).

**Finding 3 — no test covers this for either surface.** No test asserts what happens when `taxpayerType === 'RESIDENT_INDIVIDUAL'` but `country_of_residence !== 'IN'`.

**Classification: partially wired** — disclaimer propagation is live and connected end-to-end; the input to whether the NRI caveat fires is duplicated, uncross-checked, and untested in both the live UI and the report — a doubly-instanced gap.

## G7.017 — Calculation explanations

**A repeated, unenforced `explanation: string` convention exists across ~13 engine modules and IS rendered live — not a pure black box.** 13 independent declarations (`goalForecast.ts`, `healthScore.ts`, `financialDna.ts`, `resilience.ts`, `reportInsights.ts`, `metricCatalogue.ts`, `financialTwinService.ts`, `twinBenchmarkRetrieval.ts`, AI insight-pack modules, `storedPersonalisedResolver.ts`, FDH classification modules) — no shared `Explainable` interface ties them together (same "repeated but never shared as a library" pattern G6.027 found for reconciliation oracles). Rendered examples: `goalForecast.ts:301,372` (return-rate assumption, FX-conversion-rate explanation); `analyticsOrchestrator.ts:125`/`reportSectionsPremium.ts:679` (deliberate refusal to blend multi-currency returns). Rendered in `components/dna/sections.tsx`, `TwinDetailView.tsx`, `ActionPlan`/`ComponentGrid`, `ReportPreview.tsx`/`ReportV2Charts.tsx` (10+ call sites).

**A second, more structured but only half-rendered mechanism exists in Reports specifically.** Every `BuiltSection` carries `narrativeText`, `limitationText`, `confidenceLevel`, `sourceReferences`. `narrativeText`/`limitationText` ARE rendered (30+ call sites). `sourceReferences` is **not** rendered — confirmed by grep and by the module's own docs (`docs/investment-intelligence/R10_REPORT_PROVENANCE.md:31-35`: "The in-app preview does not currently render this block... present in the data contract... but no new UI copy was added").

**No "this uses the ATO's X rate" or named-source citation pattern exists anywhere** — the one FX-explanation example names an "assumed FX rate" value but never a source/date/provenance for it (matches G7.018).

**Classification: partially wired.** A real, live, per-item "show your work" convention exists and is genuinely rendered across Dashboard-adjacent UI and Reports; a second structured provenance layer exists in the data model but is confirmed backend-only/unrendered by the feature's own documentation. Neither is a single canonical, enforced mechanism — no shared type, no lint/test enforcing presence. A general-purpose explanation infrastructure would be a new requirement; the informal per-section practice is not new.

## G7.018 — FX lineage display

Two structurally different "FX rate" concepts exist, and only one is ever displayed.

**1. The dashboard/net-worth conversion rate** (`getFxRateAudInr()`, `dashboardData.ts:41-50`): reads a single **current** row from `forecast_global_assumptions`, falling back to hardcoded `56` if missing — no date/history dimension queried at all (matches G6.033). Feeds `computeDashboard()` and `reportSectionsPremium.ts:224`'s currency conversion — but is **never attached to `DashboardSummary`'s returned object** (no `fxRateAudInr`/`fxRateDate` field on the interface, no API route re-exports it). The Free-tier `cross_border` section doesn't even attempt a converted figure — its own `limitationText` states outright it isn't implemented yet. `ReportPreview.tsx:809-814` renders only the country list and limitation text — no rate, no converted amount. **This answers the core question for net-worth/dashboard/cross-border figures: a rate is used internally, silently, with zero indication of what rate or date was applied — and the app doesn't even attempt a converted number here today, so there's nothing to attach a rate display to.**

**2. The forecast module's assumed/drifted rate**: `crossBorderCalculator.ts` computes a forward-projected `fxRate` and **does** display it — `CrossBorderForecastPanel.tsx:90`: "FX rate used: {inputs.fxRateAudInr} INR per AUD." `goalForecast.ts:372` similarly renders an explanation naming "the assumed FX rate of X" for goal conversions. This IS a real, live, rendered FX-rate display — but it's a forward-looking planning assumption (configurable drift, no real-world date attached), not the lineage of a rate that produced a historical/current converted figure. No "as of" date is shown alongside it either.

**Classification:**
- Net-worth/dashboard/cross-border conversion rate: **stale/dead as a display concern** — never surfaced to any UI/report at all (not merely unstored per G6.033); the one report chapter that could show it explicitly documents that it doesn't attempt the converted view yet. New requirement, blocked on G6.033's schema fix plus net-new UI (none exists to extend).
- Forecast-assumption FX rate: **live and connected** as a display, but answers a different question and itself lacks a displayed as-of date — a narrower, adjacent gap distinct from G6.033's.
- No test asserts presence or absence of FX-rate display anywhere.
