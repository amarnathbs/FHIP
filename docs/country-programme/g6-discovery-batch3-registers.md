# G6 Discovery Batch 3 — Registers (Investments, Property/Liabilities, Income/Expenses, Insurance, SMSF)

Repo state verified: `D:\FHIP\.claude\worktrees\agent-a9fdb5d253f9b5fff`, HEAD `cd7b201`.

## G6.012 — Investment holdings

**Schema** (`supabase/migrations/0003_module2.sql:59-68`, extended by `0004_financial_data_grid.sql:59-68`): `investments` has `currency_code char(3) not null` and `country_code char(2)` (nullable FK to `countries`).

**Validation** (`lib/validation/investment.ts:11-12`): `currency_code: z.enum(['AUD','INR'])`, `country_code: z.enum(['AU','IN']).optional()`.

**Grid UI** (`lib/grid/configs.ts:144`): `investmentGridConfig` has a `country_code` select populated from `COUNTRY_OPTIONS` (`lib/constants.ts`, built off `FULL_EXPERIENCE_COUNTRY_CODES` = AU/IN only).

**API route** `app/api/investments/route.ts:1-2` imports `requireCountryConfirmedUser as requireUser` — the **legacy hard MCC gate**, not `requireModuleCapability`. Confirmed via `grep` that no `assets`/`liabilities`/`investments`/`retirement` route calls `requireModuleCapability` anywhere; only Income/Expenses/Insurance/Health-Score/DNA/Resilience do. So a GB/US/SG/AE user is refused at this route today regardless of the G4/G5B flag state.

**Capability manifest** (`lib/services/appCapability.ts:373-381`): `INVESTMENTS` → `requiredCapability: DOMESTIC_CALCULATIONS`, `operationPolicy: OPERATIONS_FOLLOW_VIEW` (no G5B carve-out). Note quotes: *"the single most explicit AU/IN split found in the app — a dedicated AU-only broker-statement import panel/copy, and a hardcoded IN-only routing decision to /investment-intelligence. Assigned to G5."* This manifest entry is **not actually consulted** by the live route (backend-only/aspirational until G4 is on and the route is migrated), and `DOMESTIC_CALCULATIONS` is only `true` for AU/IN in `country_capabilities` (migration 0122) regardless.

**UI hub** `app/(app)/investments/page.tsx:1-61`: hardcodes exactly two entry points — "Import Australian Investment Statement" and a "India Investments" link to `/investment-intelligence`. Zero UI affordance for any third country.

**Dashboard aggregation** `lib/engines/dashboard.ts`: `totalInvestments` (line 753), allocation (766) and cross-border rollups `investmentByCountry`/`countriesInUse` (895-905) key off raw `country_code`; `toSupportedCurrency()` (523-524) recognizes only `'AUD'|'INR'` and silently treats anything else as already-in-reporting-currency (531-533) — dead code path today since the enum blocks any other value from ever being persisted.

**Investment Intelligence (India)**: `lib/services/investment-intelligence/documentProcessing.ts:347-348` — `const countryCode = doc.country_code as string; const currencyCode = countryCode === 'IN' ? 'INR' : 'AUD';` — a "not-IN-becomes-AU" pattern, and `manualDirectPositionService.ts:263/279/281` hardcode `countryCode: 'IN'` for manually-entered II holdings too. Manifest entry `INVESTMENT_INTELLIGENCE` (416-424): *"India-only by design across R1-R6 … not evaluated for AU or GENERIC applicability at all; out of scope for any change here."* Both CAS-parsed and manual II paths are India-only end-to-end.

**Classification**: live and connected for AU/IN; **structurally absent** (not merely unreachable) for GB/US/SG/AE — blocked at the API gate before `country_code` is even considered. Canonical multi-country ownership for this dimension does not exist — **new requirement**.

## G6.013 — Property and liabilities

**Schema**: `assets` (`0003_module2.sql:28-38`) and `liabilities` (`0003_module2.sql:41-52`) both carry `currency_code char(3) not null` + `country_code char(2)` nullable.

**Validation**: `lib/validation/asset.ts:9-10`, `lib/validation/liability.ts:22-23` — identical `AUD|INR` / `AU|IN` enums.

**Manifest**: `ASSETS` (`appCapability.ts:346-354`) — *"country_code field hardcoded to lib/constants.ts COUNTRY_OPTIONS (AU/IN only) … unlike Income/Liabilities, POST has NO assertItemCreationAllowedForUser call at all — a real gap."* `LIABILITIES` (355-363) flags that `FinancialDataGrid.tsx`'s shared currency-mismatch copy literally branches `row.country_code === 'IN' ? India's : Australia's` — a live "not-IN-becomes-AU" labelling defect, currently inert only because no other value can be stored.

**API routes** `app/api/assets/route.ts:1`, `app/api/liabilities/route.ts:1`: both use `requireCountryConfirmedUser` — same hard block as Investments.

**property_liability_links** (`supabase/migrations/0078_property_liability_linking.sql:92-135`): the link table has **no country_code column of its own** and **no CHECK constraint** tying a linked property's country to its liability's country. The auto-suggest/backfill heuristic (same file, lines ~301, 321, 341) *does* require `coalesce(l.country_code,'') = coalesce(a/i.country_code,'')` as a match signal — so a genuinely cross-border pairing (e.g. AU liability securing an overseas property) is never auto-suggested — but nothing in `app/api/property-liability-links/route.ts` (confirmed via grep — zero country references) blocks a user from manually creating such a cross-border link. `smsf_property_loan` (`lib/validation/propertyLiabilityLink.ts:4-11`) reuses this same country-agnostic mechanism.

**Dashboard**: `byCountry()` helper (`dashboard.ts:780-793`) rolls up assets/liabilities/retirement by raw `country_code`, shown "as recorded, in each country's own currency" (no FX conversion, per comment 536-538) — the only existing cross-border handling, and it is read-only reporting, not validation.

**Classification**: same hard block as Investments for GB/US/SG/AE. The specific "AU-resident owning an overseas property" scenario is **neither blocked nor specially validated** today — genuine gap, **new requirement** for G6, not a pre-existing model.

## G6.014 — Income and expenses

**Confirmed directly at the schema**: `income_sources` (`0003_module2.sql:3-13`) and `expense_items` (`0003_module2.sql:15-25`) both have `currency_code char(3) not null` and **no `country_code` column at all**. Verified by grepping every subsequent `alter table income_sources`/`alter table expense_items` statement (0004, 0008, 0091, 0131 for income; 0004, 0131 for expenses) — none ever add one.

**Explicit authoritative confirmation**: `supabase/migrations/0097_currency_override.sql:1-16` header states: *"Adds an explicit, user-set currency_override flag to the four registers that carry both a country_code and a currency_code (assets, liabilities, investments, retirement_accounts — income/expense/insurance have no country_code field and are unaffected)."*

**Validation**: `lib/validation/income.ts:26`, `lib/validation/expense.ts:17` — `currency_code: z.enum(['AUD','INR'])` only, no country field.

**Grid config**: `incomeGridConfig` (`lib/grid/configs.ts:6-28`) and `expenseGridConfig` (31-53) have no `country_code` field (contrast with asset/liability/investment/retirement configs at lines 67/111/144/175).

**Dashboard SELECT** (`lib/services/dashboardData.ts:128, 132-136`): income_sources/expense_items SELECT lists carry no `country_code`/`currency_code` at all — confirms the topic's hypothesis exactly.

**Manifest**: `INCOME` (289-297) and `EXPENSES` (298-306) both cite "no country_code/currency_code field" as the basis for `UNIVERSAL_MODULES` classification, and both ARE migrated onto `requireModuleCapability('INCOME'|'EXPENSES', …)` in the live routes (`app/api/income/route.ts`, `app/api/expenses/route.ts:1-26`).

**Critical caveat — flags default OFF**: `lib/services/appCapabilityFlag.ts` and `lib/services/g5bWriteFlag.ts` both default to `false` (`process.env[...] === 'true'`, unset/empty/misconfigured → off), `.env.example:38` ships `G4_APP_CAPABILITY_LAYER_ENABLED=` empty, and both files' own comments state "no production activation" / "MUST default to false." With G4 off, `requireModuleCapability()` "falls back to EXACTLY the pre-existing `requireCountryConfirmedUser()` behaviour" (`appCapability.ts:21-25`) — so **today, in the shipped configuration, GENERIC users are refused Income/Expenses exactly as they are refused Assets/Liabilities/Investments**, despite the correct manifest classification. **Classification: implemented but unreachable** (code path + manifest + unit tests — `tests/unit/appCapability.test.ts`, `appCapabilityManifest.test.ts`, `requireModuleCapability.test.ts` — all exist, but production behaviour is byte-identical to pre-G4 until the flags are flipped after DEV verification).

**Disclosed pre-existing gap** (manifest's own note): `lib/validation/income.ts`/`expense.ts` hardcode `currency_code` to `['AUD','INR']` with no default — so even a fully-enabled GENERIC user could not submit a GBP/USD/SGD/AED row.

**Conclusion**: Income/expense genuinely have **no country attribution mechanism** — confirmed at schema, validation, grid-config, and dashboard-SELECT layers. This is a concrete, load-bearing finding: any G6 "attribute income/expense to a country" work requires new schema/validation, not a wiring fix.

## G6.015 — Insurance coverage

**Schema** (`0003_module2.sql:82-93`): `insurance_policies` has `currency_code char(3) not null`, **no `country_code`** — never added by any later migration; grouped explicitly with income/expense in migration 0097's header quoted above.

**Validation** (`lib/validation/insurance.ts:13,17`): `cover_type: z.enum(['life','income_protection','health','home','vehicle','other'])`; `currency_code: z.enum(['AUD','INR'])`; no country field.

**AU-centric framing**: `income_protection` is a distinctly Australian/UK insurance product category with its own regulatory and tax treatment; the fixed six-value enum bakes this in with no per-country disambiguation or disclaimer.

**Grid config** (`lib/grid/configs.ts:191-224`): `insuranceGridConfig` has no `country_code` field (matches manifest note verbatim), but it **does** carry `restrictedOwnerValues: [{ value: 'smsf', requiredCountry: 'AU' }]` (type in `lib/grid/types.ts:119`) — a working, existing pattern for "restrict one owner value in one register to one country," entirely independent of any `country_code` column, that G6 will need to account for/could reuse.

**API route** `app/api/insurance/route.ts:1-26`: migrated onto `requireModuleCapability('INSURANCE', …)` — same G4/G5B flag-off caveat as Income/Expenses applies (**implemented but unreachable** in production today).

**Dashboard SELECT** (`dashboardData.ts:167-168`): selects `policy_name, cover_amount, premium, premium_frequency, cover_type, renewal_date, waiting_period_days, owner` — omits `currency_code` too (even though the column exists), so insurance premiums are never currency-converted in dashboard aggregation at all.

**Conclusion**: Same "no country_code column" gap as Income/Expenses, plus a distinct **new-requirement** question the topic specifically flags: AU/UK-flavoured `cover_type` vocabulary would read as misleading regulatory framing for GB/US/SG/AE users once/if this module opens to them.

## G6.016 — SMSF preservation

**AU-only gate intact and unmodified**: `supabase/migrations/0084_geo_jurisdiction_smsf.sql:115-146` — `retirement_accounts_smsf_au_gate()` / `trg_retirement_accounts_smsf_au_gate` (BEFORE INSERT OR UPDATE OF `master_item_key`, `is_active`). The function reads `p.country_of_residence = 'AU'` **directly** from `user_profiles` (lines 126-128) — it does **not** call `resolveCountryContext()` or any G1/G4 service. `git log --follow` on this file shows exactly **one commit** (`fb7c716`, original authoring) — untouched by LR-6 through LR-13.

**SMSF's live route gates** (`app/api/smsf/route.ts:1` and siblings) use `requireCountryConfirmedUser` — the legacy MCC gate — **not** `requireModuleCapability`. Confirmed by grep: only Income/Expenses/Insurance/Health-Score/DNA/Resilience routes call `requireModuleCapability`; SMSF is not among them. `resolveCountryContext()`'s only callers repo-wide are `appCapability.ts:698` (the G4 resolver, currently flag-off and never invoked by any SMSF route) and `landingCountryContextServer.ts:60` (unrelated landing-page concern).

**Household isolation has zero country dependency**: `lib/engines/householdContext.ts` (104 lines, read in full) contains **no reference whatsoever** to `country_of_residence`, `resolveCountryContext`, or `country_code`. Its entire discriminator is `owner`: `isHouseholdOperatingCashFlow(row) { return row.owner !== 'smsf'; }` (lines 69-71), consumed by `computeDashboard()`. **A G6 change to `resolveCountryContext()`/`appCapability.ts` would have zero blast radius on this specific mechanism as written.**

**The real cross-cutting risk** (more precise than the hypothesised one): SMSF's actual live gates depend on (a) `user_profiles.country_of_residence` and MCC's `is_country_confirmed()`/`countries.is_supported` semantics (migrations 0104/0105/0111), and (b) `lib/api.ts`'s `requireCountryConfirmedUser()` / `countryGate.ts`'s `countryConfirmationBlockResponse()`. Any G6 work that changes the **meaning** of `country_of_residence`, `is_supported`, or refactors `requireCountryConfirmedUser()` itself (rather than adding a parallel `resolveCountryContext()`-based path) **would** have direct blast radius on SMSF. The appCapability.ts `SMSF` manifest entry (391-399) is otherwise inert prose today — it keys a hypothetical future classification on `resolveCountryContext()`'s `DOMESTIC_RETIREMENT` output (`country_capabilities`: `AU→true`, `IN→false`, migration 0122 lines 199/221), but no live route consults it.

**Controls inventory** (`scripts/db-rebuild-check/smsf_jurisdiction_cert.mjs`, live-DB cert script): positive controls (AU resident can create/re-create SMSF after moving to AU), negative controls (forged direct INSERT from IN resident rejected; IN resident owning an AU property still can't create SMSF; reactivating an archived SMSF while non-AU rejected; `smsf_create_fund()` RPC can't bypass the gate), cross-tenant/RLS controls (user B can't forge rows into user A's fund, each paired with an "RLS off → leak occurs" proof the denial is real), and a raw-PATCH balance-forgery guard (migration 0090). Unit coverage: `tests/unit/smsfHouseholdIsolation.test.ts` (44 cases), `fdh12SmsfBoundary.test.ts`, `smsfForecastContributionGuard.test.ts`, `smsfPnlCashFlowExport.test.ts`, `smsfValidation.test.ts` (16 cases) — **none currently exercise a GB/US/SG/AE-resident SMSF scenario**.

**Conclusion**: SMSF's gate and isolation logic are confirmed **live and connected**, unmodified, well-covered. The specific risk framed in the task brief doesn't materialize as stated; the real, narrower risk (touching `country_of_residence`/MCC semantics directly) should be the one G6 tracks.

---

### Cross-cutting observations for all five topics

- **No G6/multi-country plan doc exists yet** anywhere under `docs/` (checked all `*.md` for "G6"/"multi-country"/"NRI") — this is genuinely greenfield discovery, not a re-read of prior work.
- `cross_border_relationships` (`app/api/user/cross-border-relationships/route.ts:1-13`) is an explicit **declaration-only** table, disconnected from any financial register row — its own code comment states *"no cross-border CALCULATION is performed anywhere in G3 (that is G6)."* Confirms canonical multi-country ownership for the financial registers is a **genuine new requirement**, not something to re-wire.
- `financial_records_audit` (`0003_module2.sql:99-106`) is a dead/unused audit table — grepped, zero application-code references (only migration files mention it). The only live, working audit trail for country-related changes is the reused generic `audit_events` table (`0001_foundation.sql:70`), via `lib/services/countryAudit.ts` — but that covers country **confirmation/change events only**, not financial-register row history.
- `confirm_primary_country_change()` (`0122_g1_country_foundation.sql:441-530`) only ever updates `user_profiles` (+ `audit_events`) — it never retroactively touches any register row's `country_code`/`currency_code`, confirming existing per-row values are preserved/frozen at entry time, never rewritten on a later residence change.
