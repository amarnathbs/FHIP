# AR-0 / A0 — Discovery & Baseline

Combined discovery pass for the **FHIP APP REVIEW** spec ("Spec 1") and the
**FHIP — Assets, Investments & Retirement** spec ("Spec 2"). Read-only,
zero functional/schema/data changes. Branch: `feature/app-review-input-integrity-production`,
based on `main` @ `fe7a094` (worktree HEAD, clean tree, confirmed via
`git merge-base HEAD main` == `fe7a09413cccc44b6ba4cb790c53abab3dfa0187`).

Every finding below cites a concrete file path (and line numbers where the
detail matters) so it can be independently re-opened and re-verified.

---

## 1. Repository / environment baseline

- **Branch**: `feature/app-review-input-integrity-production`, created off `main` at commit `fe7a094` ("Remove internal build-phase copy from user-facing UI"). Working tree was clean at branch-creation time.
- **Migrations**: `supabase/migrations/` on `main` runs `0001_foundation.sql` through `0030_contact_submissions.sql` — **30 files**, contiguous, no gaps.
- **`scripts/check-migration-versions.mjs`**: does **not exist on `main`** (confirmed: `ls` returns "No such file or directory"). It exists only on the unmerged `fix/migration-lineage-ii-resources` / FDH branches per prior session memory — this app-review branch has no collision guard available and must not assume one.
- **Supabase project refs** (read from `D:\FHIP\.env.local`, never queried live for anything beyond the read-only PostgREST calls used in §5 below):
  - **DEV**: `vqycarelcoijzwlpkpcz` (`NEXT_PUBLIC_SUPABASE_URL=https://vqycarelcoijzwlpkpcz.supabase.co`) — matches every prior closure report in memory.
  - **Production**: `twwpnltizhtjxhamyoxt`, per the dispatch instructions and cross-referenced in `docs/phase1a_foundation_closure_completion_report.md` etc. **Not contacted in any way during this pass.**
- **Test baseline** (run from this worktree; a `node_modules` NTFS junction to the main checkout's `node_modules` was created to make `npx` work — this does not affect git state, `node_modules` is gitignored):
  - `npx tsc --noEmit` → **0 errors** (clean exit).
  - `npx vitest run` → **14 test files, 124 tests, 124 passed, 0 failed** (5.09s).
  - `npx eslint .` → **6 errors, 6 warnings (12 problems)**:
    - `components/grid/FinancialDataGrid.tsx:92` — `react-hooks/refs`: "Cannot access refs during render" on `rowsRef.current = rows;` (see §3.1 — relevant to the persistence-defect investigation, though it is a lint-level React-Compiler warning, not a live bug per the code-flow analysis below).
    - `components/recommendations/RecommendationsPanel.tsx:62` — `react-hooks/set-state-in-effect`.
    - `components/ui/AppShell.tsx:145` — `react-hooks/set-state-in-effect`.
    - 3× `@next/next/no-img-element` warnings (`LandingPage.tsx:261`, `ReportPreview.tsx:191`, `AppShell.tsx:168,329` — 2 of the 6 warnings are both in `AppShell.tsx`).
  - `npx next build` → **succeeds (exit 0)** once `.env.local` is present (a fresh worktree build fails at the static-export step with `@supabase/ssr: Your project's URL and API key are required` for `/admin/benchmarks` — not a code defect, just a missing local env file, resolved by copying `.env.local` from the main checkout). Build produced **103 total pages/routes** during static-page generation, prerendering a mix of `○` static and `ƒ` dynamic routes across the full route tree (income/expenses/assets/liabilities/investments/retirement/insurance/goals/dashboard/dna/financial-twin/forecast/reports/etc.).

---

## 2. Architecture map

### 2.1 Input Data (Income / Expense / Asset / Liability / Investment / Retirement / Insurance)

All seven of these modules share **one generic component and one generic API pattern** — there is no per-module bespoke input UI:

- **UI**: `components/grid/FinancialDataGrid.tsx` (single ~590-line component, driven entirely by a `GridConfig`).
- **Config/catalogue-shape**: `lib/grid/configs.ts` (7 exported configs: `incomeGridConfig`, `expenseGridConfig`, `assetGridConfig`, `liabilityGridConfig`, `investmentGridConfig`, `retirementGridConfig`, `insuranceGridConfig`) and `lib/grid/types.ts` (the `GridConfig`/`GridField` shape).
- **Pages**: `app/(app)/income`, `.../expenses`, `.../assets`, `.../liabilities`, `.../investments`, `.../retirement`, `.../insurance` — each is a thin page that renders `<FinancialDataGrid config={...} />`.
- **API routes**: `app/api/{income,expenses,assets,liabilities,investments,retirement,insurance}/route.ts` (GET/POST) + `.../[id]/route.ts` (PATCH/DELETE), all built on one shared factory: `lib/services/registry.ts`'s `makeRegistry(table)`.
- **Validation**: `lib/validation/{income,expense,asset,liability,investment,retirement,insurance}.ts` (Zod schemas).
- **DB tables**: `income_sources`, `expense_items`, `assets`, `liabilities`, `investments`, `retirement_accounts`, `insurance_policies` — each has a `unique(user_id, master_item_key)` constraint (added in `supabase/migrations/0004_financial_data_grid.sql:21-87`) that the registry's `save()` upserts against.
- **Master catalogue**: `supabase/seed_master_items.sql` (251 lines) → `master_financial_items` table, served via `app/api/master-items/route.ts` and `lib/services/masterItems.ts`, filtered by `?category=`.

Note for Spec 1 §4: this is **already** the "form → saved-table" pattern the spec asks for (search box, tick-to-include rows loaded from a catalogue, inline editable fields, a running total/completion strip) — it is not the old flat-form pattern. The redesign work still needed is narrower than "build this from scratch": see §3.1-§3.3 for the specific gaps that remain (dead `expense_category` field, non-metadata-driven field conditionality, missing catalogue items, country/currency decoupling).

### 2.2 Completion percentage

Computed **locally per grid instance**, not as a single global figure:
`components/grid/FinancialDataGrid.tsx:249-251`
```
const masterItemCount = (rows ?? []).filter((r) => !r.is_custom).length;
const includedMasterCount = included.filter((r) => !r.is_custom).length;
const completion = masterItemCount > 0 ? Math.round((includedMasterCount / masterItemCount) * 100) : 0;
```
There is no separate/global "data completeness %" engine anywhere in `lib/engines` or `lib/services` — the Dashboard's own completeness signals are simple booleans (`hasIncome`, `hasExpenses`, `hasAssets`, `hasLiabilities`, `hasInvestments`, `hasRetirement`, `hasInsurance` — `lib/engines/dashboard.ts:398-401`, `816-818`, `866-869`), not a percentage.

### 2.3 Dashboard Monthly Surplus and everywhere it's consumed

Single source of truth: `lib/engines/dashboard.ts`'s `computeDashboard()` (871 lines). Loaded by `lib/services/dashboardData.ts` → `app/(app)/dashboard/page.tsx` (server component, fresh query per request — no explicit caching layer).

`monthlySurplus` (`lib/engines/dashboard.ts:478`) flows into:
- **Scores**: `lib/engines/healthScore.ts:180,199,245` (`monthlyExpenses`, `cashSavingsRate`, `monthlySavedAmount`).
- **Financial DNA**: `lib/engines/financialDna.ts` via `lib/services/financialDnaData.ts` (uses `d.savingsRate`, `d.debtServiceRatio`, `d.discretionaryRatio` — all downstream of the same `computeDashboard()` output).
- **Forecasting**: `lib/services/forecastData.ts` (separate re-aggregation with its own FX handling — see §3.3).
- **Reports**: `lib/engines/reportSections.ts` / `reportSectionsPremium.ts` / `reportNarrative.ts`.
- **Financial Twin**: `lib/services/twinData.ts:106-112` calls `loadDashboardForTwin()`.

### 2.4 Insurance module premium fields

`lib/grid/configs.ts:139-165` (`insuranceGridConfig`): `provider`, `cover_amount`, `premium`, `premium_frequency`, `renewal_date`, `waiting_period_days`, `benefit_period`, `notes`. Table `insurance_policies`. Aggregated in `lib/engines/dashboard.ts:668-691` into `insuranceByType`/`totalAnnualPremium`, consumed by `computeInsuranceAdequacy()` (`dashboard.ts:888-903`) and `healthScore.ts:530-556`.

### 2.5 Liability module repayment fields

`lib/grid/configs.ts:57-83` (`liabilityGridConfig`): `lender`, `balance`, `interest_rate`, `interest_rate_type`, `fixed_rate_expiry`, `credit_limit`, `monthly_repayment`, `country_code`, `notes`. Table `liabilities`. `monthly_repayment` feeds `debtMonthlyRepayments` (`dashboard.ts:475`) — see §3.3 for the double-counting analysis against Expense-catalogue loan-repayment items.

### 2.6 Currency/country handling and FX architecture

- `lib/engines/fx.ts` — single canonical `convertToReportingCurrency()`, documented FX convention (`fx_rate_aud_inr` = INR per 1 AUD), used identically by `dashboard.ts`, `reportSectionsPremium.ts`, `forecastData.ts`, and `forecast/crossBorderCalculator.ts` (already consolidated from what a comment calls "3 previously-identical duplicate implementations" — no drift risk there).
- `lib/constants.ts:1-4` — `COUNTRY_OPTIONS` is a 2-value `AU`/`IN` list; `currency_code` is independently a 2-value `AUD`/`INR` enum in every validation schema (`lib/validation/asset.ts:8-9` etc.) — **the two fields are never linked** (no derivation, no Zod `.refine()` cross-check). See §3.2 for the resulting defect.
- `components/grid/FinancialDataGrid.tsx:88,108-109,431-433,545-547` — the currency `<select>` on every row is hardcoded to exactly `AUD`/`INR`, defaulted from the *household's* `preferred_currency` (`/api/user/profile`), not from that row's own `country_code`.

### 2.7 Onboarding/auth flow

`app/(onboarding)/onboarding/OnboardingWizard.tsx` (own route group, chrome-free layout per the `28d6b32` P0 pass). `date_of_birth` is collected but **optional** (`date_of_birth: form.date_of_birth || undefined`, line 139) with no blocking validation. Auth pages: `app/(auth)/{login,signup,forgot-password,reset-password}`.

### 2.8 Profile data model / Auth email-change

- **No dedicated Profile page exists.** `find app -iname "*profile*"` returns only `app/api/user/profile` and `app/api/forecast/profile` — API routes with no corresponding `app/(app)/profile` (or `/settings`, `/account`) page. The only writer of `PUT /api/user/profile` in the whole UI is the onboarding wizard itself (`grep` confirms `OnboardingWizard.tsx` and `FinancialDataGrid.tsx`'s "not applicable" toggle are the only two callers).
- `updateUser`/`auth.admin` usage exists in exactly one file, `app/(auth)/reset-password/page.tsx`, for password reset — **there is no email-change flow anywhere** (verified-or-otherwise).
- **Conclusion**: Spec 1's Profile-page requirement is 100% greenfield on this codebase — nothing to fix, only to build.

### 2.9 Financial Twin cohort-selection and DOB/age path

- `lib/services/twinData.ts:90-127` (`loadTwinSourceData`) — reads `user_profiles.date_of_birth` fresh per call, computes `age`/`ageBand` live via `lib/engines/twin/taxonomy.ts`'s `ageFromDateOfBirth`/`ageToAgeBand` (itself delegating to the shared, already-hardened `lib/engines/age.ts:ageFromDob`). No default/fallback age is ever substituted for a missing DOB (`ageBand` is simply `null`).
- `lib/services/twinCohortMatching.ts:54-142` (`matchCohort`) — 5-tier progressive fallback, each `.eq('country_code', ...)` scoped, correctly uses a fresh query builder per tier (a prior bug about builder-mutation is already fixed per the file's own comment).
- **But**: `app/api/financial-twin/current/route.ts:4-11` serves the **most recently generated stored run** (`financial_twin_runs`, ordered `created_at desc` in `lib/services/financialTwinService.ts:261-281`), not a fresh live recomputation. A Twin "run" is only created on demand via the `GenerateTwinButton` (`app/(app)/financial-twin/page.tsx:32`) — **nothing regenerates it automatically when the user's profile (e.g. DOB) changes.** See §3.4 for why this is the leading root-cause candidate for the age-mismatch defect.

### 2.10 Goals creation workflow

`app/(app)/goals/new/GoalCreationWizard.tsx`. Step 0 picks `goal_type` from catalogue cards; Step 1 asks for a free-text `goal_name` that starts as `''` (line 35) and is never prefilled. See §3.5.

### 2.11 Retirement input components and data model

`lib/grid/configs.ts:115-137` (`retirementGridConfig`): `current_balance`, `employer_contribution`, `personal_contribution`, `contribution_frequency`, `target_retirement_age`, `country_code`, `notes`. Table `retirement_accounts`. `lib/validation/retirement.ts` has no SMSF-specific fields, no `financial_holding_id`/stable-code concept, no property-linking, no Summary/Detailed mode flag — all of Spec 2's structured SMSF model is greenfield (see §3.6).

### 2.12 Financial DNA engine

`lib/engines/financialDna.ts` (611 lines) + `lib/services/financialDnaData.ts` (180 lines). See §4 for the full methodology map.

### 2.13 Assets/Investments/Retirement taxonomy source

Single file: `supabase/seed_master_items.sql`, categories `asset` (39 rows), `investment` (32 rows), `retirement` (17 rows) — full inventory and classification in §3.6.

### 2.14 SMSF handling

No structured handling beyond three flat catalogue rows that all mean roughly the same thing in three different places: `asset.smsf_balance`, `investment.smsf_investments`, `retirement.smsf`. No Summary/Detailed mode, no property-within-SMSF support, no rental-income linking. Greenfield.

---

## 3. Root-cause investigation

### 3.1 Input Data edit-persistence defect (Spec 1 §4.3)

**Confirmed: the specific "duplicate POST from React state" defect described in the spec's suspect list is already fixed on `main`, with in-code documentation of the fix.**

`components/grid/FinancialDataGrid.tsx:142-155` (`saveRow`) carries this comment, present since commit `2b52b80` (predates the branch point):
> "Reads the current row from a ref ..., not via a `setRows()` functional updater — React 18 Strict Mode intentionally double-invokes updater functions in dev to catch impure updaters, and the previous version fired `fetchJson()` from inside one, so every save POSTed twice and created a duplicate row..."

Verified the fix is structurally sound, not just commented:
- `saveRow()` reads from `rowsRef.current` (a plain ref kept in sync at line 92), not from inside a `setRows()` updater — so React Strict Mode's double-invoke cannot double-POST.
- `lib/services/registry.ts:27-41` (`save()`) — for any row with a `master_item_key`, it **upserts** on `onConflict: 'user_id,master_item_key'`; the underlying unique constraints exist (`supabase/migrations/0004_financial_data_grid.sql:21-87`, one per table). Custom rows (no `master_item_key`) always `insert`, but the grid only ever POSTs a custom row once (`usePatch = row.is_custom && row.id` at `FinancialDataGrid.tsx:162` switches to `PATCH .../[id]` for every subsequent edit once `id` is set).
- `handleFieldChange` → `scheduleSave` debounces 600ms per row `key`, clearing any pending timer for that key first (`FinancialDataGrid.tsx:137-140`) — no race between rapid edits.
- All inputs are controlled (`value=... onChange=...` throughout), row `key` is stable (`master_item_key` or a generated `custom-...` id) — no evidence of uncontrolled-input or key-thrashing issues.

**Residual, lower-severity findings** (not the reported defect, but worth carrying into implementation):
- ESLint flags `rowsRef.current = rows;` (`FinancialDataGrid.tsx:92`) as `react-hooks/refs` ("Cannot access refs during render") — this is the new React Compiler/eslint-plugin-react-hooks rule objecting to a ref write happening in the render body rather than an effect. It does not currently cause an observable bug (the ref is read only from event-handler-triggered async functions, never during another component's render), but it is exactly the "stale React state" *shape* of bug the spec's suspect list warns about, and is one of only 6 lint errors on the entire codebase — worth cleaning up (move the assignment into a `useEffect`) as a small, isolated hygiene fix.
- No `router.refresh()` or query/mutation-cache invalidation exists anywhere in this component (there is no React Query/SWR in this codebase) — the grid always self-fetches fresh via `useEffect` on mount, and the Dashboard is a server component re-queried on navigation. The one plausible remaining staleness vector is Next.js App Router's client-side **Router Cache** (segment-level RSC payload cache on back/forward or repeat `<Link>` navigation within its default window) serving a stale Dashboard after a grid edit — this was not reproduced live in this discovery pass (out of scope for a no-writes phase) and should be an explicit live-browser check early in implementation, not assumed fixed or broken.

### 3.2 Currency/country defect ("India asset totalled as AUD")

**Confirmed and root-caused.** The dashboard aggregation itself is *not* naive — `lib/engines/dashboard.ts:435-439` (`reportingValue()`) and `:513-516` do call `convertToReportingCurrency()` keyed on each row's own `currency_code`. The defect is upstream, in data entry:

1. `lib/grid/configs.ts:52` (`assetGridConfig`) exposes `country_code` as an independent `COUNTRY_OPTIONS` select field (same for liability/investment/retirement configs).
2. `components/grid/FinancialDataGrid.tsx:88,108-109` sets every row's `currency_code` from the **household's** `preferred_currency` (fetched once from `/api/user/profile`), completely independently of whatever `country_code` that row is given.
3. No Zod cross-field validation exists (`lib/validation/asset.ts:8-9`: `currency_code` and `country_code` are two unrelated optional/required enums with no `.refine()`), and the client never auto-syncs the currency dropdown when the country dropdown changes.

**Concrete failure mode**: a household with `preferred_currency = 'AUD'` records an India-based asset — they pick `country_code = 'IN'` (because that's what the field is for) but the currency `<select>` still shows/defaults to `AUD` unless the user separately, manually, remembers to also flip it to `INR`. If they don't, `reportingValue()` sees `currency_code = 'AUD'`, treats the value as already in the reporting currency, and adds the raw INR-magnitude number straight into `totalAssets`/`netWorth` with **no FX division at all** — i.e. an asset actually worth ₹50,00,000 is added as if it were $50,00,000 AUD. This exactly matches the spec's reported symptom, with a precise mechanism (missing country→currency linkage, not a conversion-math bug).

### 3.3 Monthly-surplus double-counting audit

**Loan repayments: CONFIRMED live defect, with a specific dead-code root cause.**

`lib/engines/dashboard.ts:450-455` clearly documents the *intended* dedup design:
```
// 'debt_repayment'-category expense rows and the liabilities table's
// monthly_repayment represent the same cash outflow when a user tracks a
// loan repayment as an expense line — excluded here...
const nonDebtExpenses = input.expenses.filter((r) => r.expense_category !== 'debt_repayment');
```
But `expense_category` is **never settable through the UI**:
- `lib/grid/configs.ts:24-39` (`expenseGridConfig.fields`) lists only `amount`, `frequency`, `is_essential`, `notes` — no `expense_category` field.
- `lib/validation/expense.ts:6-8` — `expense_category` is a real 7-value enum (`housing|transport|food|utilities|insurance|debt_repayment|other`) but **defaults to `'other'`**, and since the grid's save body only ever sends the fields listed in its config (`FinancialDataGrid.tsx:160`), every expense row saved through the live app is persisted with `expense_category = 'other'`, regardless of which catalogue item it is.
- `supabase/seed_master_items.sql:33-34,90` explicitly offers **`mortgage`**, **`rent`**, and **`car_loan_repayments`** as Expense catalogue items — i.e. the app invites a user to log the exact same cash outflow as *both* an Expense row (`mortgage`, essential, e.g. $2,500/mo) *and* a Liability's `monthly_repayment` (e.g. Home Loan, $2,500/mo).

Net effect: `nonDebtExpenses`'s filter is **dead code for every real user** — a household that fills in both the "Mortgage" expense item and its Home Loan's `monthly_repayment` field has that $2,500/month subtracted **twice** inside `monthlySurplus = incomeForSurplus - totalMonthlyExpenses - debtMonthlyRepayments` (`dashboard.ts:478`). This is the same "master_item_key is the reliable signal, the field itself is never collected" pattern the codebase's own comments already document for `asset_class`/`investment_type`/`debt_type` (`dashboard.ts:155-167,201-208,248-254`) — `expense_category` was simply never given the same master-item-key-driven derivation those three fields eventually received.

**Insurance premiums: refuted as a literal double-subtraction, confirmed as a real duplicate-representation risk.** `monthlySurplus` never subtracts `totalAnnualPremium` or anything from `insurance_policies` at all — Insurance-module premiums are only ever used for `computeInsuranceAdequacy()` (`dashboard.ts:888-903`) and the Health Score's insurance component (`healthScore.ts:530-556`), never folded into the cash-flow formula. So there is no mechanism by which an Insurance-module premium is subtracted from surplus twice. However, `supabase/seed_master_items.sql:40-41,61,77,81,83,85` offers near/exact-duplicate items in the **Expense** catalogue (`home_insurance`, `contents_insurance`, `health_insurance`, `vehicle_insurance`, `life_insurance`, `tpd_insurance`, `pet_insurance` — `life_insurance` and `pet_insurance` are *exact* key matches against the `insurance` category's `life_insurance`/`pet_insurance`, lines 224/244). If a user logs the same policy in both places, the premium **is** counted once (correctly) inside `totalMonthlyExpenses`/surplus, but is **also** shown as a separate, seemingly-additional cost inside the Insurance section/Health Score — a real UX/data-integrity risk (double representation, not double subtraction), worth fixing via the same catalogue-de-duplication work as §3.6, but distinct in severity from the mortgage finding above.

### 3.4 Financial Twin age-mismatch defect

**Root cause identified: stale, on-demand-only "run" snapshot, not a calculation bug.**

The age-band bucketing itself is correct and was directly checked: `lib/engines/twin/taxonomy.ts:82-97` — a 52-year-old maps unambiguously to `AGE_45_54` (`min: 45, max: 54`), never `AGE_25_34`. There is no default/fallback age anywhere in `twinData.ts:119-120` (missing DOB → `ageBand = null`, not a young default).

The actual mechanism: `app/api/financial-twin/current/route.ts:4-11` returns `runs[0]` from `listTwinRuns()` (`lib/services/financialTwinService.ts:261-273`, ordered `created_at desc`) — i.e. the **most recently generated stored run**, not a fresh computation. `financial_twin_runs` (`supabase/migrations/0011_module8_financial_twin.sql:191-213`) is explicitly documented as "**immutable** ... run history" and stores `primary_cohort_id`/`cohort_tier` as they were computed *at generation time*. A run is only created on demand by the `GenerateTwinButton` (`app/(app)/financial-twin/page.tsx:32`, label toggles "Generate"/"Regenerate") — **nothing automatically triggers a new run when the underlying profile changes**, including a DOB correction. A user who generated their Twin once (e.g. during early exploration, before entering or correcting their DOB) will keep seeing that stale cohort/age-band on every subsequent visit until they notice and manually click "Regenerate" — with no UI signal telling them their profile has since changed.

**Investigation-checklist status**: age math ✓ correct; cohort-matching filters ✓ correct; default/fallback age ✓ none exists; **the missing piece is a staleness/invalidation trigger** — this is the "stale server cache" suspect-cause category from Spec 1 §4.3, generalized to the Financial Twin module. Recommend confirming with a live repro (generate a Twin with a wrong/blank DOB, then correct the DOB and reload without clicking Regenerate) as the first implementation-phase step, since this discovery pass could not make live writes to prove it end-to-end.

### 3.5 Goals name-prefill gap

**Confirmed, single-line root cause.** `app/(app)/goals/new/GoalCreationWizard.tsx:139-145`:
```
onClick={() =>
  update({
    goal_type: t.type_key,
    user_priority: t.default_priority,
    importance_type: t.default_importance_type,
  })
}
```
`t.type_label` is right there (used for the button's own display text two lines later, line 150) but is never copied into `goal_name`, which starts and stays `''` (line 35) until the user manually types something in Step 1 (lines 163-168). A trivial, isolated fix (`goal_name: t.type_label` added to the same `update()` call, still user-editable afterward) — no schema change.

### 3.6 Assets/Investments/Retirement taxonomy overlap — full current-state inventory

Single source: `supabase/seed_master_items.sql`. **Asset: 39 items, Investment: 32 items, Retirement: 17 items** (counts independently verified via grep, not eyeballed). Full inventory with first-pass Spec 2 §7 classification (A=correct, B=exact duplicate, C=conceptual duplicate, D=wrong module, E=not-an-asset-type, F=structural/relationship modeling defect) follows.

#### Assets category (39 items)

| item_key | Class | Note / recommended canonical module |
|---|---|---|
| wallet_cash, savings_account, cheque_account, offset_account | A | Cash & banking — correct in Assets |
| term_deposits | **B** | Exact-key duplicate with `investment.term_deposits`. Spec 2 names this exact "Term-Deposit canonical-home rule" case explicitly. |
| foreign_currency | A | Cash-like — correct in Assets |
| gold, silver | **C** | Exact-key duplicates with `investment.gold`/`investment.silver`; needs the personal-vs-investment-purpose distinction Spec 2 calls for rather than two indistinguishable catalogue rows |
| cryptocurrency | **B** | Exact-key duplicate with `investment.cryptocurrency` |
| shares, etfs, managed_funds, bonds, private_equity | **B** | Exact-key duplicates with `investment.{shares,etfs,managed_funds,bonds,private_equity}` |
| business_ownership | **C** | Conceptual duplicate of `investment.business_investment` (different key, same real-world thing) |
| partnership_interest | **C** | Conceptual duplicate of `investment.partnership_investment` |
| smsf_balance | **D** | Wrong module — SMSF belongs in Retirement (`retirement.smsf`); also 3-way overlaps `investment.smsf_investments` |
| industry_super, retail_super, defined_benefit | **B** | Exact-key duplicates with `retirement.{industry_super,retail_super,defined_benefit}` — wrong module in Assets, Retirement is canonical |
| investment_property | **D** | Wrong module — overlaps `investment.property`; Spec 2 requires investment property to live in Investments with a liability link |
| principal_residence | A | Correct in Assets (personal property) per Spec 2's ownership model, but needs the home-loan link Spec 2 asks for (not a module move) |
| holiday_home, vacant_land, farm | needs review | Ambiguous — personal-use vs investment-purpose not currently distinguished; needs a purpose field, not necessarily a module move |
| commercial_property | **B** | Exact-key duplicate with `investment.commercial_property` — commercial property is virtually always investment-purpose, Investments should be canonical |
| motor_vehicle, motorcycle, boat, caravan, collectables, jewellery, art, watches, wine_collection | A | Vehicles/valuables — correct in Assets |
| intellectual_property | needs review | Ambiguous (business asset?) — low priority |
| loans_receivable | A | Correct — "Other" catch-all, money owed to the user |
| trust_assets | **C** | Conceptual duplicate of `investment.trust_investment` |
| other_assets | A | Catch-all, correct |

#### Investments category (32 items)

| item_key | Class | Note |
|---|---|---|
| australian_shares, international_shares, index_funds, government_bonds, corporate_bonds, reits, angel_investments, venture_capital, commodities, options, futures, forex, other_investments | A | Unique to Investments, no overlap found — correct |
| etfs, managed_funds, bonds, term_deposits, private_equity, cryptocurrency, gold, silver, commercial_property | **B** | See Assets table above — same exact-key duplicates, mirrored |
| cash_investments, high_interest_savings | **D** | Conceptually indistinguishable from `asset.savings_account`/cash & banking — Spec 2's model puts cash accounts in Assets, not Investments; these look like wrong-module entries |
| property | A (canonical) | Likely the intended canonical home for `asset.investment_property` (§ above) — the two should merge into one item, not stay as two |
| business_investment | **C** | Mirror of `asset.business_ownership` above; Investments likely canonical per Spec 2's business/private-market hierarchy |
| partnership_investment | **C** | Mirror of `asset.partnership_interest` |
| trust_investment | **C** | Mirror of `asset.trust_assets` |
| collectibles | **C** | Near-duplicate of `asset.collectables` — note the **spelling inconsistency itself** (collectABLES vs collectIBLES) is a separate small data-quality defect worth fixing regardless of the module decision |
| smsf_investments | **D** | 3-way overlap with `asset.smsf_balance` and `retirement.smsf` — the most severe single overlap found; must consolidate into Retirement's SMSF model |
| education_fund | **E** | Spec 2 explicitly calls this out: "Education-Fund/Children-Investment-is-a-goal-not-an-asset-class correction" — should be a Goal, not an investment catalogue item |
| children_investment | **E** | Same correction as `education_fund` |

#### Retirement category (17 items)

| item_key | Class | Note |
|---|---|---|
| smsf | A (canonical) | Correct home for the SMSF concept — see the 3-way overlap noted above |
| industry_super, retail_super, defined_benefit | A (canonical) | Correct here; the Assets-side duplicates (§ above) are the ones to fix |
| employer_contributions, salary_sacrifice, personal_concessional, non_concessional, government_co_contribution | **F** | Spec 2 explicitly separates "account types vs contribution types" — these are contribution *flows*, not standalone holdings, but are currently modeled as top-level catalogue rows a user ticks and enters a balance for, exactly like an account. Needs restructuring into contribution fields/sub-records on an actual account (matches Spec 2's 200,000-balance/1,000-contribution/still-200,000 worked example — the current model has no way to represent that distinction at all). |
| spouse_contribution | **F** | Spec 2 explicitly calls this out: "spouse-contribution relationship-not-asset-class correction". Currently modeled as its own tickable retirement holding, not a contribution-relationship attribute (who contributed, to whose account). |
| transition_to_retirement, allocated_pension, account_based_pension | **C** | Potential overlapping decumulation-product concepts (Spec 2's "retirement-income/decumulation product consolidation") — needs a consolidation review among these three |
| annuity | A | Distinct decumulation product, correct (complementary, not duplicate, with `income.annuity_income`) |
| overseas_pension, other_retirement_assets | A (catch-all) | Correct as generic catch-alls |
| retirement_savings | **C** | Vague, likely redundant against `other_retirement_assets` |
| **(gap)** | **Missing** | **Spec 2 explicitly requires India account types EPF/PPF/NPS as first-class Retirement items — none exist in the catalogue today.** The entire Retirement catalogue is AU-centric (`industry_super`/`retail_super`/`SMSF` are Australian terms); an India-resident user has nothing but `overseas_pension`/`other_retirement_assets`/a custom row to represent an EPF, PPF, or NPS account. This is a genuine taxonomy gap, not just an overlap, and is the single biggest open item for Spec 2's cross-border requirement. |

#### Summary counts

- **10 exact-key (Class B) duplicate concepts** between Assets and Investments (20 catalogue rows for 10 real-world concepts): `term_deposits, gold, silver, cryptocurrency, shares, etfs, managed_funds, bonds, private_equity, commercial_property`.
- **3 exact-key (Class B) duplicate concepts** between Assets and Retirement (6 rows): `industry_super, retail_super, defined_benefit`.
- **1 three-way overlap** (Assets + Investments + Retirement) on the SMSF concept: `smsf_balance` / `smsf_investments` / `smsf`.
- **~6 conceptual (Class C) duplicates** with different spellings/keys across modules: `business_ownership↔business_investment`, `partnership_interest↔partnership_investment`, `trust_assets↔trust_investment`, `collectables↔collectibles` (also a spelling bug), `investment_property↔property`, `high_interest_savings↔savings_account`.
- **2 items (Class E)** that are not an asset type at all and should become Goals: `education_fund`, `children_investment`.
- **6 items (Class F)** that conflate a contribution flow or relationship with a standalone holding: `employer_contributions, salary_sacrifice, personal_concessional, non_concessional, government_co_contribution, spouse_contribution`.
- **1 confirmed catalogue gap**: no India retirement account types (EPF/PPF/NPS).

---

## 4. Financial DNA current-methodology map (prerequisite for Spec 1 §26)

Files: `lib/engines/financialDna.ts` (611 lines), `lib/services/financialDnaData.ts` (180 lines).

- **Income basis**: `financialDna.ts:82` — `const income = d.netMonthlyIncome || d.grossMonthlyIncome;` — **net income, gross as fallback** (matches the standing memory note on this exact question; independently re-confirmed here).
- **Living-expense classification**: DNA does not reclassify expenses itself; it consumes `essentialMonthlyExpenses`/`discretionaryRatio`/`essentialExpenseRatio` straight from the Dashboard engine (`financialDna.ts:83` computes `essentialExpenseRatio` locally from `d.essentialMonthlyExpenses / income`), which in turn is driven by the grid's user-set `is_essential` checkbox per expense row (`lib/grid/configs.ts:36`) — there is no expense-category-level classification (e.g. housing vs discretionary bucket) feeding DNA today.
- **Debt-purpose fields**: **none exist in DNA's own model.** DNA consumes exactly two blended debt signals — `debtToIncome` (total liability balance ÷ annual gross income) and `debtServiceRatio` (total repayments ÷ net income) — both computed across **all** liabilities combined, with zero owner-occupied-vs-investment-property distinction. Notably, `dashboard.ts` already computes a `goodDebt`/`badDebt` split by purpose (`isGoodDebt()`/`GOOD_DEBT_MASTER_ITEMS`, `dashboard.ts:254-258`, driven by `master_item_key` — e.g. `home_loan`/`investment_loan`/`construction_loan` are "good", `credit_card` is not) — **but `financialDna.ts` never references `goodDebt`/`badDebt` at all** (confirmed via full-file grep). The `debt_wealth_builder` archetype (`financialDna.ts:560`) even infers "consistent with a leveraged property pattern" purely from a blended `debtToIncome` 3-10× band, with no actual purpose signal behind that inference. This is the concrete evidence the spec's redesign work needs to start from: the raw ingredients for an owner-occupied-vs-investment-property split already exist one layer down in `dashboard.ts`, they are simply never wired into DNA.
- **Mixed-purpose loans**: no handling exists — a single liability row has one `debt_type`/`master_item_key`, so a genuinely mixed-purpose loan (e.g. an offset-linked loan partly redrawn for investment) has no representation at all; out of scope to fix without a data-model change.
- **Rental income treatment**: already flows into `passiveIncomeRatio` via `dashboard.ts`'s `PASSIVE_INCOME_KEYS` (includes `rental_income`, `airbnb_income`) — but there is no link from a specific rental-income row to the specific investment-property liability that produced it, so a capacity-based calc like the spec's worked example (10,000/2,500/1.5×/6,250/5,500) cannot currently be derived from the data model as-is; it would need either a new relationship field or a heuristic same-owner/same-country match.
- **Age input**: `financialDnaData.ts` uses the same `ageFromDob(user_profiles.date_of_birth)` path as every other module (§3.4's shared `lib/engines/age.ts`). Age already directly affects archetype eligibility/scoring today (e.g. `debt_constrained_builder`'s `idealMin: 22, idealMax: 40` at `financialDna.ts:177`, and the `future_builder`-style archetype's age-40 threshold at `:580`) — so age is *not* currently ignored, contrary to a naive reading of "no age dimension"; the spec's requirement is narrower: don't *invent new, unapproved* thresholds beyond what's already there.
- **Income bands**: **not used.** All DNA thresholds are static raw-ratio cutoffs (0.15, 0.35, 3, 10, etc.) — none vary by an income bracket/band. (Income bands do exist elsewhere, in the Financial Twin's `lib/engines/twin/taxonomy.ts` — a different, unrelated module.)
- **What depends on DNA's output**: `lib/services/reportSnapshotResolver.ts` (Reports), `lib/services/twinData.ts` (Financial Twin uses `dnaProfileCode` as a `financial_dna_code` cohort-matching dimension — i.e. DNA output already feeds *into* Twin cohort selection, a cross-module dependency worth remembering when sequencing changes), `app/(app)/dna/page.tsx`, `app/api/intelligence/financial-dna/route.ts` and `.../recalculate-dna/route.ts`. **Not** consumed by `healthScore.ts` (confirmed via grep — Health Score and DNA are independent siblings, not a pipeline).

---

## 5. Duplicate-entry / migration risk assessment

Read-only PostgREST query against DEV (`vqycarelcoijzwlpkpcz`) via the service-role key, following the same pattern as `scripts/importRecommendationsData.mjs`. Script and full JSON evidence were written to the session scratchpad and deleted from the worktree after use (no temp files committed).

**Population**: 838 active `assets` rows, 717 active `investments` rows, 357 active `retirement_accounts` rows, across **206 distinct users** with data in at least one of the three tables.

**Cross-module exact-concept overlap** (the same `master_item_key` present in a "same real-world thing" pair across two modules, per the Class B list in §3.6): only **2 of 206 users** — one has `commercial_property` in both `assets` and `investments`, the other has `term_deposits` in both. **Zero users** show the 3-way SMSF overlap (`smsf_balance`/`smsf_investments`/`smsf`) anywhere in DEV today. A near-identical-value heuristic across `investments`↔`retirement_accounts` (same user, values within 1% of each other) found **1 candidate pair**.

**Important caveat on what this actually measures**: pulling the two flagged users' full rows shows generic, template-style names (`"Cash and Transaction Accounts"`, `"Bond and Cash Fund"`, `"Property"`, `"Other Assets"`) with `master_item_key` values that don't semantically match their own display names (e.g. an investment named "Bond and Cash Fund" tagged `master_item_key: 'commercial_property'`) — this is characteristic of the **50-user synthetic regression-harness fixture data**, not organic human data entry. DEV's 206-user population is overwhelmingly this seeded fixture set plus accumulated internal test/dev signups, not real end-user behaviour, so this scan should be read as **"the current DEV data shows very low duplicate-entry volume,"** not as **"real users rarely double-enter holdings"** — that second claim is simply unmeasured (there is no organic-user population in DEV to measure it against).

**Practical implication for migration risk**: the taxonomy-overlap *surface* (§3.6) is large and structural (16 duplicate/overlapping concepts across the three catalogues), but the *actual populated duplicate-row count* to reconcile during a real data migration is small today (2-3 known instances in the entire DEV database). This meaningfully de-risks the migration step of Spec 2's later phases — the bulk of the work is catalogue/taxonomy redesign and going forward duplicate-prevention, not a large backfill/merge operation on existing rows. This conclusion should be re-checked once the migration is closer, since DEV's population will keep growing and production (never queried here) may look different.

---

## 6. Proposed phase sequencing

Mapping the findings above onto both specs' phase lists (Spec 1: AR-1 through AR-9; Spec 2: A1 through A12), with an explicit split by change-type and a check against both specs' 4 stop conditions (genuine business-rule ambiguity / missing credentials-access / destructive-migration risk / unsafe-deployment blocker).

### Recommended next 3 dispatch-sized chunks

**Chunk 1 — Pure bug fixes, zero schema change (maps to early AR-1/AR-2 items; can start immediately, no stop condition applies)**
1. Goals name-prefill (§3.5) — one-line fix.
2. Loan-repayment double-counting (§3.3) — wire `expense_category` through the grid, or (simpler, no new field needed) derive the debt-repayment exclusion from `master_item_key` the same way `dashboard.ts` already does for `asset_class`/`investment_type`/`debt_type` (add `mortgage`, `rent`, `car_loan_repayments` etc. to a `master_item_key`-keyed exclusion set, mirroring `MASTER_ASSET_ITEM_TO_BUCKET`'s pattern). UI-only + one small `dashboard.ts` change; no migration.
3. `FinancialDataGrid.tsx:92` ref-in-render lint fix (§3.1) — move `rowsRef.current = rows` into a `useEffect`.
4. Rounding/display-precision — swap the grid's running-total `formatMoney()` for the already-existing `formatMoneyWhole()` (§ money.ts finding) on the summary strip.
5. Collectables/collectibles spelling fix (§3.6) — trivial catalogue label consistency (needs `is_active`/deprecate discipline per `seed_master_items.sql`'s own header comment: "only add/deprecate, never rename" — so this is a small additive migration, not a pure code fix; flag accordingly).

**Chunk 2 — Currency/country defect + Financial Twin staleness (UI + one small additive behavior change each; no destructive migration)**
1. Currency/country (§3.2): auto-derive/lock `currency_code` from `country_code` in the grid (still overridable, since `foreign_currency` and genuine multi-currency holdings need an escape hatch) — UI-only change plus a possible Zod `.refine()` warning; **stop-condition check**: none of the four conditions apply, this is unambiguous given the AU/IN-only 2-country model, but confirm with the Product Owner whether a hard block or a soft warning is wanted for a country/currency mismatch (a real, narrow business-rule question worth a quick confirm before implementation, not a full stop).
2. Financial Twin staleness (§3.4): either (a) auto-regenerate a Twin run when `date_of_birth`/other cohort-input fields change on profile save, or (b) surface a "your profile has changed since this comparison was generated" banner prompting Regenerate. Needs a live-browser repro first (this discovery pass made no writes) to confirm the mechanism before choosing (a) vs (b) — recommend that repro as the literal first step of this chunk.

**Chunk 3 — Assets/Investments/Retirement taxonomy consolidation, Phase A0's own deliverable already produced above (§3.6) — this is the largest chunk and should itself be split further once picked up**:
- Sub-chunk 3a (data-model, additive-only): design the canonical schema per Spec 2 (stable `financial_holding_id`, SMSF Summary/Detailed mode, property/liability linking, India EPF/PPF/NPS catalogue additions, contribution-vs-account separation) — additive migrations only, no destructive change, can run in parallel with Chunk 1/2.
- Sub-chunk 3b (catalogue de-duplication + migration): retire/merge the ~16 duplicate/overlapping catalogue items identified in §3.6, migrate the small number of real duplicate rows found in §5 (2-3 known today, re-check population before executing), reconcile Net Worth pre/post per Spec 2's zero-variance control. **This is the one sub-chunk that touches the "destructive-migration risk" stop condition** — even though current data volume is small, any row-merging operation is inherently higher-risk and should get its own dedicated pass with the zero-Net-Worth-variance check as a hard gate, not bundled into a larger dispatch.
- Sub-chunk 3c: Financial DNA debt-dependence redesign (§4) — depends on 3a's data model existing (needs the owner-occupied/investment-property purpose signal that already exists in `dashboard.ts`'s `isGoodDebt` to be wired through, plus whatever new fields 3a adds); should follow, not precede, 3a.

### Items not yet ready to sequence (flagged, not blocking Chunks 1-3)
- **Profile page build** (§2.8): 100% greenfield, no defect to diagnose — straightforward to schedule whenever, but needs a Product Owner decision on exactly which fields are editable post-onboarding and the DOB-change downstream-invalidation behavior (this connects directly to the Financial Twin staleness fix in Chunk 2 — a DOB *change* should very plausibly trigger the same invalidation Chunk 2 builds for the "generate once, never refreshed" problem, so these two should be designed together even if built in different dispatches).
- **Retirement structural review / SMSF model / spouse-contribution relationship** (§3.6's Class F items): genuine business-rule design work (how should a spousal contribution be represented, what does "Detailed Mode" require from a user) — recommend a short written design-confirmation pass with the Product Owner before implementation, not a stop condition per se but close to the "genuine business-rule ambiguity" category the specs both call out.
- **India retirement catalogue gap** (§3.6): straightforward additive catalogue seed once the canonical Retirement schema (3a) is settled — sequence after, not before, 3a.

No missing-credentials/access blocker and no unsafe-deployment blocker were found anywhere in this discovery pass; production was never contacted, and DEV read access worked cleanly throughout.
