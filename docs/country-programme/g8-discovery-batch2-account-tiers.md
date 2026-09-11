# G8 Discovery — Batch 2: Authenticated Account Tiers, AU/India/GB/US (G8.006–G8.010)

Repo: `D:\FHIP\.claude\worktrees\agent-a9fdb5d253f9b5fff` @ `838c542` at capture time.

## 1. Global visitor (anonymous)

"GLOBAL" is a fixed, closed presentation bucket (`LANDING_PRESENTATION_COUNTRIES = ['AU','IN','GLOBAL']`, `landingCountryContext.ts:60-62`), type-disjoint from the authoritative `CountryCode` union. `toAuthoritativeCountryCodeOrNull()` (`:79-84`) hard-codes GLOBAL → `null` — no code path turns it into a stored country; independently enforced at the schema level (`char(2)` FK columns, no `countries` row named `GLOBAL`, per `tests/unit/g2GlobalNotACountry.test.ts:55-99`). On signup, `handle_new_user()` inserts `country_of_residence = NULL` (not `'GLOBAL'`, not `'AU'`) — confirmed the landing cookie is never read by signup or by the write-path RPC. **Findings**: none outstanding on the mechanism itself; the one open item is the same CloudFront-header-unconfirmed infrastructure gap from Batch 1 §4.

## 2. AU account (authenticated, confirmed)

AU registry row: `experience_level='FULL'`, most capabilities `true`, but `DOMESTIC_TAX_OUTPUTS=false` and `APPROVED_BILLING`/`APPROVED_PRICING=false` (`0122_g1_country_foundation.sql:189-209`) — even FULL-experience AU has no certified tax-output engine or live billing surface claimed. SMSF creation is hard-gated `country_of_residence='AU'` at the **DB trigger level** (`0084_geo_jurisdiction_smsf.sql:115-146`), independent of and stricter than the app-layer capability manifest.

**Findings**: `components/grid/FinancialDataGrid.tsx:1026`'s currency-mismatch warning hardcodes `country_code === 'IN' ? "India's" : "Australia's"` — a "not IN becomes Australia" literal baked into shared UI copy, the same defect class already fixed elsewhere (`retirementMemberData.ts`, `resilienceStress.ts`, both "G5-D1 FIXED" per `appCapability.ts:389,459`) but **not swept up in that same remediation pass**, and it sits in an actively-rendered shared component. Also: `app/(app)/investments/page.tsx` shows an unconditional "India Investments" link to every user regardless of `country_of_residence` (no country check anywhere in that page).

## 3. India account (authenticated, confirmed)

IN registry row is the inverse of AU: `DOMESTIC_RETIREMENT=false`, `DOMESTIC_TAX_OUTPUTS=true`. EPF/PPF/NPS terminology is genuinely, deeply seeded (account types, goal catalogue items, a full EPFO benchmark dataset, three India-only recommendation scenarios, FDH taxonomy nodes).

**Findings**: confirms and sharpens a G7 finding one layer deeper — Investment Intelligence's "India-only" scoping is true **by data-shape coincidence**, not an explicit gate: `app/api/investment-intelligence/source-documents/route.ts` uses plain `requireCountryConfirmedUser()` with no `country_of_residence === 'IN'` check anywhere in the module's entry points. In practice inert for an AU user (no CAS documents exist for them to upload), but not defended by a check — a scripted caller could POST a CAS-shaped payload directly and have it run through India's tax-residency logic uncontested.

## 4. GB generic account (authenticated, confirmed)

**Production flag state independently confirmed** (not assumed): both `G4_APP_CAPABILITY_LAYER_ENABLED` and `G5B_GENERIC_WRITE_ENABLED` are off. `proxy.ts:137-143` middleware-redirects every GENERIC-confirmed user to `/global-setup` for every path except `global-setup|profile|confirm-country|onboarding`. `/global-setup` shows exactly one link ("Open your profile"). Reporting currency is locked to AUD/INR — GBP is never offered, disclosed explicitly in the page's own copy. Triple-layered defense confirmed: middleware allowlist, `requireCountryConfirmedUser()`'s `GENERIC_EXPERIENCE_RESTRICTED` refusal at the API-gate layer, and the DB-level `countries.is_supported=false` backstop.

**Findings**: with G4 off, a GB user's *only* reachable authenticated surface today is Profile + the static `/global-setup` explainer — more restrictive than the "G5B flag is off" framing alone implies, since the underlying G4 VIEW-layer resolver is also off. The forced AUD/INR currency choice for a GBP household is a genuine, disclosed-but-unresolved UX/data-fidelity gap. One narrow, explicitly-reasoned fail-open edge case: if the registry read fails, `proxy.ts` lets the request through to render (though API/DB layers still refuse actual data).

## 5. US generic account (authenticated, confirmed)

Byte-identical treatment to GB at every layer (registry seed, capability resolver, disclosure copy, middleware allowlist) — a targeted search for any `=== 'US'`/`'US':` branch anywhere in `lib/**`/`app/**` returned **zero matches**. **Findings**: none — the cleanest of the five topics; the only visible difference from GB is the interpolated country-label string.

## Cross-cutting: currency/locale/IP inference

No violation found. `countryGate.ts`'s own header and `getUserHomeCountry()`'s explicit "does NOT default to 'AU'" contrast against other display-only call sites that legitimately do. `resilienceStress.ts`'s currency-derived-country defect (G0-JA-1 Wave 1) is confirmed fixed and cited as its own precedent.
