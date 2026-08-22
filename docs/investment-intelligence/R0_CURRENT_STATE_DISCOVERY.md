# R0 — Current-State Discovery Report

Status: FINAL (R0)
Date: 2026-08-19
Scope: Read-only inspection of the existing FHIP repository, as it stands at `main` tip `fe7a094`. No production code, schema or migrations were changed to produce this report. All findings below are taken directly from the source files cited — no hypothetical or assumed behaviour is described.

---

## 1. Existing repository structure relevant to Investment Intelligence

Confirmed top-level layout (Next.js App Router):

```
app/
  (app)/            -- authenticated app shell: dashboard, income, expenses, assets,
                       investments, liabilities, retirement, insurance, goals, score,
                       dna, resilience, forecast, reports, recommendations, financial-twin, admin
  (auth)/           -- login/signup/reset
  (marketing)/       -- public marketing pages
  (onboarding)/      -- onboarding flow
  (print)/           -- print-only report renderer routes
  api/                -- Next.js API routes, one folder per resource
  auth/callback/
components/
  admin/ auth/ dashboard/ dna/ financial-twin/ forecast/ goals/ grid/ investments/
  marketing/ providers/ recommendations/ reports/ resilience/ score/ ui/
lib/
  advice-boundary/   -- existing gating helper (see section 9 below)
  api.ts             -- requireUser()/ok()/bad() response helpers
  constants.ts        -- OWNER_VALUES and other shared enums
  engines/            -- pure calculation modules (no I/O) — dashboard.ts, forecast/*,
                         goalMath.ts, healthScore.ts, resilience.ts, reportSections.ts, etc.
  grid/                -- lib/grid/configs.ts + types.ts: declarative field configs that
                         drive the spreadsheet-style capture grid used by every register
  services/            -- I/O layer (Supabase reads/writes) — registry.ts, dashboardData.ts,
                         forecastData.ts, goalsData.ts, goalFundingAllocation.ts, masterItems.ts, etc.
  supabase/            -- client.ts (browser), server.ts (@supabase/ssr), admin.ts (service-role)
  validation/          -- Zod schemas per register (asset.ts, investment.ts, retirement.ts, ...)
supabase/
  migrations/          -- 30 numbered SQL migration files, 0001 through 0030
  seed.sql, seed_master_items.sql, combined_setup.sql, production_bootstrap_part*.sql
```

There is currently **no** `investments/` (plural, Investment-Intelligence-specific) directory anywhere in `lib/`, `app/api/`, or `supabase/migrations/`. Everything investment-related today lives inside the general-purpose financial-register system described below.

## 2. Existing database tables involved

From `supabase/migrations/0001_foundation.sql`, `0003_module2.sql`, `0004_financial_data_grid.sql`, `0008_module6_resilience.sql`, `0009_module7_goals.sql`, `0013_module10_forecasting_foundation.sql`:

| Table | Migration | Role |
|---|---|---|
| `countries`, `currencies` | 0001 | Reference data. Seeded with exactly `AU`/`AUD` and `IN`/`INR` (`supabase/seed.sql`) — no other country/currency is currently supported anywhere in the app. |
| `user_profiles`, `households` | 0001 | 1:1 with `auth.users`; `households` is a single-owner metadata row (marital status, dependants, primary country), not a multi-member access-control entity. |
| `user_goals` | 0001, expanded in 0009 | The canonical goal table (see section 6). |
| `consents`, `audit_events` | 0001 | Scaffolded early. **Not written to by any current application code** — confirmed by repository-wide search; no `.ts` file references `audit_events`. Genuinely dead/unused today. |
| `assets` | 0003, columns added in 0004, 0008 | See section 3. |
| `liabilities` | 0003, extended in 0004, 0008 | Debt register. |
| `investments` | 0003, columns added in 0004 | See section 4. |
| `retirement_accounts` | 0003, columns added in 0004 | See section 5. |
| `income_sources`, `expense_items`, `insurance_policies` | 0003, 0004 | Other registers, out of scope for Investment Intelligence but share the identical pattern below. |
| `financial_records_audit` | 0003 | A second, register-scoped audit table. **Also confirmed unused by application code** (no `.ts` references). |
| `master_financial_items` | 0004 | Admin-curated catalogue table (see section 2.1). |
| `household_members` | 0009 | Reference rows for tagging a goal's owner/beneficiary by name — **not** a second authenticated party; still owned and RLS-scoped by the single `user_id`. Confirmed by `app/api/household-members/route.ts`, which is a normal owner-scoped CRUD route, not an auth/invite flow. |
| `goal_types`, `goal_planning_config` | 0009 | Config-driven catalogues (admin-editable via Module 12), same pattern as `master_financial_items`. |
| `goal_funding_sources`, `goal_contributions`, `goal_milestones`, `goal_forecasts`, `goal_snapshots` | 0009 | See section 6. |
| `forecast_profiles`, `forecast_scenarios`, `forecast_assumptions`, `forecast_global_assumptions`, `forecast_runs`, `forecast_results`, `forecast_explanations` | 0013 | See section 7. |
| `admin_users` | 0011 | RLS-scoped admin flag table — a user can read only their own row; no self-service admin grant path exists. |
| `benchmark_sources`, `benchmark_datasets`, `benchmark_update_runs` | 0011 | Existing precedent for versioned, sourced reference data (see section 10 — closest existing analogue to `ii_sources`/`ii_source_documents`). |

### 2.1 `master_financial_items` — the existing "catalogue" pattern

`master_financial_items(category, item_key, item_label, sort_order, is_active)` is a single admin-curated, world-readable table that seeds the pre-populated grid rows for every register (`category` ∈ `income|expense|asset|liability|investment|retirement|insurance`). Each register table has a nullable `master_item_key text` column plus `unique(user_id, master_item_key)`. This is the existing mechanism the platform already uses to give a free-text/enum-poor row a reliable semantic tag — and it is the tag multiple engines (`dashboard.ts`, `investmentCalculator.ts`) actually rely on in preference to the Zod enum fields, because the grid UI never collects `investment_type`/`asset_class`/`debt_type` directly (see section 4). This is directly relevant precedent for Investment Intelligence's own instrument/asset-class classification — see `R0_DOMAIN_ARCHITECTURE.md` section H (reference data) and `ADR-005`.

## 3. Current Assets schema

`assets` table (`0003_module2.sql` + `0004_financial_data_grid.sql` + `0008_module6_resilience.sql`):

```
id, user_id, asset_name, asset_class (enum: cash|property|vehicle|business|other, default 'other'),
current_value, currency_code, country_code, valuation_date, is_active,
owner (enum: self|spouse|joint|child|family_trust|company|smsf|other, default 'self'),
master_item_key, purchase_price, purchase_date, notes,
created_at, updated_at
```

Zod validation: `lib/validation/asset.ts` (`assetSchema`). Grid UI config: `lib/grid/configs.ts` `assetGridConfig` — collects `institution`-less rows keyed on `master_item_key` (39 catalogue items, per `dashboard.ts`'s own comment), never populates `asset_class` beyond the Zod default. RLS: owner-only (`auth.uid() = user_id`), same pattern as every register (see section 9).

Investment-type items (shares, ETFs, managed funds, gold, cryptocurrency) **can** be entered here through the "asset" grid's own catalogue (`MASTER_ASSET_ITEM_TO_BUCKET` in `lib/engines/dashboard.ts` explicitly maps `gold`, `shares`, `etfs`, `managed_funds`, `cryptocurrency`, `silver` master-item keys to allocation buckets) — this is the first concrete confirmation of the overlap the spec asks R0 to resolve (see `R0_NET_WORTH_DEDUP_CONTRACT.md`).

## 4. Current Investments schema

`investments` table (`0003_module2.sql` + `0004_financial_data_grid.sql`):

```
id, user_id, investment_name, investment_type (enum: shares|managed_fund|etf|crypto|business_equity|other, default 'other'),
current_value, currency_code, country_code, is_active,
owner (enum, same 8 values as assets), master_item_key,
institution, cost_base, annual_contribution,
risk_profile (enum: conservative|balanced|growth|high_growth|unknown),
notes, created_at, updated_at
```

Zod validation: `lib/validation/investment.ts`. Grid UI config: `lib/grid/configs.ts` `investmentGridConfig` — fields exposed: `institution`, `current_value`, `cost_base`, `annual_contribution`, `risk_profile`, `country_code`, `notes` (Item/name comes from the master-item catalogue row itself, Owner from the shared owner field). **This exactly matches every field the spec's Section 8 (FHIP Publishing Contract) lists as the current Investments-screen concepts** — Item, Owner, Institution, Current Value, Cost Base, Annual Contribution, Risk Profile — confirmed field-for-field against live code, not assumed.

API route: `app/api/investments/route.ts` (GET/POST) + `app/api/investments/[id]/route.ts` (PATCH/DELETE), both built on the generic `makeRegistry('investments')` factory in `lib/services/registry.ts`. `save()` upserts on `(user_id, master_item_key)` when a master item is checked, or plain-inserts a custom row when it is not — Postgres treats every `NULL` `master_item_key` as distinct, so any number of custom rows coexist safely. `archive()` sets `is_active = false` (soft delete) rather than deleting the row.

There is **no** `source`, `provenance`, `import_id`, or `document_id` column anywhere on `investments` today. Every row is asserted true by direct user entry; there is no concept of "this row came from an uploaded statement" in the current schema.

## 5. Current Retirement schema

`retirement_accounts` table (`0003_module2.sql` + `0004_financial_data_grid.sql`):

```
id, user_id, account_name, account_type (enum: super|EPF|PPF|NPS|other, default 'other'),
current_balance, currency_code, country_code, is_active,
owner, master_item_key,
employer_contribution, personal_contribution, contribution_frequency, target_retirement_age,
notes, created_at, updated_at
```

Grid UI config: `retirementGridConfig` in `lib/grid/configs.ts` exposes `current_balance`, `employer_contribution`, `personal_contribution`, `contribution_frequency`, `target_retirement_age`, `country_code`, `notes`. Industry Super / Retail Super / SMSF / Defined Benefit (AU) and EPF/PPF/NPS (IN) are represented as **master-item catalogue rows** within `account_type='other'` plus a distinguishing `master_item_key`, not as distinct enum values — `account_type` itself only has 4 values (`super|EPF|PPF|NPS|other`) and, like `investment_type`/`asset_class`, is largely left at its Zod default by the live grid. RLS and soft-delete behaviour identical to `investments`.

## 6. Current Goals schema

`user_goals` (base table `0001_foundation.sql`, expanded in place by `0009_module7_goals.sql` rather than replaced — the migration comment explicitly notes this is done "to avoid disrupting onboarding's existing simple goal-creation call and the Module 3 dashboard's existing GoalRow read path").

Ownership/linkage model: `household_id`, `owner_member_id` and `beneficiary_member_id` (both FK to `household_members`), `linked_liability_id`. Status lifecycle: `draft → active → paused/on_hold → achieved/partially_achieved/missed/cancelled → archived`, enforced by a `check` constraint, not a separate state machine table.

**Goal-to-investment linkage already exists and is production code**, in `goal_funding_sources`:

```
goal_id, user_id, source_type (asset|investment|retirement|cash|manual|expected),
linked_asset_id, linked_investment_id, linked_retirement_id,
allocated_amount, allocation_percentage (0–100), currency_code,
availability_date, restricted_flag, is_active
```

Double-counting across goals sharing one balance is already prevented today by `lib/services/goalFundingAllocation.ts`'s `checkFundingAllocation()` / `evaluateAllocation()`: it sums `allocation_percentage` across every **other** active funding source pointing at the same `linked_asset_id`/`linked_investment_id` for that user, and rejects any candidate allocation that would push the total over 100%. `computeAllocatedMonthlyContribution()` and `resolveAllocatedAmount()` then derive forecast-usable numbers from the live linked balance rather than a stale snapshot. **This is the direct precedent Investment Intelligence's own goal-allocation contract must integrate with, not duplicate** — see `R0_GOAL_INTEGRATION_CONTRACT.md`.

`goal_forecasts` and `goal_snapshots` are both append-only/immutable-per-period tables (never updated once a month closes), matching the platform-wide "every calculation run is a new row" convention also seen in `forecast_results` and `financial_health_scores`.

## 7. Current Forecasting interface

Forecasting (Module 10) lives in `lib/engines/forecast/*.ts` (pure calculators, no I/O) plus `lib/services/forecastData.ts` (I/O). Core shared types, `lib/engines/forecast/types.ts`:

- `ForecastType` = `'net_worth' | 'retirement' | 'goal' | 'debt' | 'investment' | 'cross_border' | 'resilience'` — `'investment'` is already a first-class forecast type.
- `ForecastResultRow` — one monthly period's movement for one entity: `entityType`, `entityId`, `periodDate`, `openingValue`, `contributions`, `withdrawals`, `investmentReturn`, `fees`, `fxGainLoss`, `closingValue`, `currency`, `baseCurrencyValue`, `metadata`. This is the canonical shape any forecast input/output must map onto.
- `ResolvedAssumption` — every calculation input carries `sourceType` (`user_override | scenario_default | country_default | global_default`) and `sourceReference`, so the calculator can always cite where a rate came from. This is the existing precedent for the "assumptions must be user-adjustable/visible" principle Investment Intelligence must also honour, not reinvent.

`lib/engines/forecast/investmentCalculator.ts` (`runInvestmentForecast`) is the concrete per-investment-account calculator. Its input, `InvestmentCalculatorInputEntry`, is exactly: `id, name, currentValue, monthlyContribution, investmentType, masterItemKey, currency`. Critically, its own code comments record two already-fixed production bugs (FHIP-FC-INV-001/002): `investment_type` is unreliable because the grid never collects it, so `masterItemKey` — resolved through `MASTER_ITEM_TO_ASSET_CLASS`, itself keyed off the same `master_financial_items` catalogue used by the grid — is "the reliable asset-class signal in practice." Any Investment Intelligence instrument/asset-class taxonomy must be capable of resolving to these same six `forecast_global_assumptions` return keys (`equity`, `fixed_interest`, `cash`, `property`, `other_asset`, `superannuation`/`retirement`) for a published position to forecast correctly — see `R0_FORECASTING_CONTRACT.md`.

`lib/engines/forecast/netWorthCalculator.ts` (`runNetWorthForecast`) takes explicit opening balances split as `openingAssets` (non-investment, non-retirement), `openingInvestments`, `openingRetirement`, `openingLiabilities` plus matching monthly contributions — i.e. Forecasting **already assumes** the three buckets are pre-separated and non-overlapping before they reach it, reinforcing that deduplication must happen upstream of Forecasting, at the publishing boundary, not inside the forecast engine itself.

There is no forecasting input today for cost, tax, or liquidity characteristics, nor for goal-confirmed-mapping consumption beyond what `goalFundingAllocation.ts` already resolves.

## 8. Current Dashboard/net-worth calculation path

Traced exactly, not inferred. `lib/services/dashboardData.ts` loads rows from `assets`, `investments`, `retirement_accounts`, `liabilities` (plus income/expenses/insurance/goals/snapshots) via the same owner-scoped Supabase reads as every register, and passes them into `computeDashboard()` in `lib/engines/dashboard.ts`.

`computeDashboard()` (line ~513–517 of `lib/engines/dashboard.ts`):

```ts
const totalAssets = input.assets.reduce((sum, r) => sum + reportingValue(r.currency_code, r.current_value), 0);
const totalInvestments = input.investments.reduce((sum, r) => sum + reportingValue(r.currency_code, r.current_value), 0);
const totalRetirement = input.retirement.reduce((sum, r) => sum + reportingValue(r.currency_code, r.current_balance), 0);
const totalLiabilities = input.liabilities.reduce((sum, r) => sum + reportingValue(r.currency_code, r.balance), 0);
const netWorth = totalAssets + totalInvestments + totalRetirement - totalLiabilities;
```

This is the **single, exact, canonical** net-worth formula in the codebase: `netWorth = totalAssets + totalInvestments + totalRetirement − totalLiabilities`, each term summed straight off the four register tables with an FX conversion (`reportingValue()`, backed by `convertToReportingCurrency()` in `lib/engines/fx.ts`) applied per-row before summing. `DashboardSummary.totalAssetsCombined` is deliberately the sum of all three so the "total assets" figure shown anywhere reconciles with net worth — the function's own comment states this explicitly.

`computeDashboard()` is called from exactly one place that matters for household net worth: `dashboardData.ts`. `reportSections.ts` (Reports/Module 9) consumes the same `DashboardSummary` object rather than re-querying or re-summing the registers itself (confirmed: `totalInvestments: d.totalInvestments` is read straight off the dashboard summary in `reportSections.ts`). This means **there is currently exactly one place net worth is computed**, and every downstream consumer (Dashboard UI, Reports, and — via `forecastData.ts` feeding `netWorthCalculator.ts`'s `openingInvestments` etc. — Forecasting) is fed from it. This single-computation-path fact is the load-bearing finding for `R0_NET_WORTH_DEDUP_CONTRACT.md`: Investment Intelligence must publish its canonical positions into the `investments`/`assets`/`retirement_accounts` rows this one function already sums, not create a second net-worth path.

Allocation bucketing (`bucketAssetClass`/`bucketInvestmentType`) resolves via `master_item_key` first (falling back to the near-useless enum fields), keyed against two literal lookup tables in `dashboard.ts` — `MASTER_ASSET_ITEM_TO_BUCKET` and `MASTER_INVESTMENT_ITEM_TO_BUCKET` — that already assign catalogue items like `gold`, `shares`, `etfs`, `managed_funds`, `cryptocurrency` to buckets from **both** the `asset` and `investment` categories. This is the concrete, already-live evidence that the same economic instrument type (e.g. "gold") is currently reachable through two different registers with two different catalogues, and nothing in the current code prevents a user recording the same real-world holding in both.

## 9. Current reporting dependency

`lib/engines/reportSections.ts` and `lib/engines/reportInsights.ts`/`reportNarrative.ts` (Module 9 — Reports) read the same `DashboardSummary` produced by `computeDashboard()` (see section 8) rather than re-deriving totals. Report generation is orchestrated by `lib/services/reportsData.ts` / `reportContentData.ts`, with content pulled from the `report_content_library` table (migration `0025`) and pillar-triggered recommendation matching (`lib/engines/recommendations/matcher.ts`). Report PDF export uses a genuine Supabase Storage bucket (`report-exports`), written by the service-role admin client (`lib/supabase/admin.ts`) and read back via a **signed URL**, never a public URL — this is the existing, closest precedent for how Investment Intelligence source-document storage should be modelled (service-role-only writes, signed-URL reads, never client-side bucket access). See `app/api/report-exports/[exportId]/download/route.ts`.

## 10. Existing RLS/security model

Confirmed uniform pattern across every migration inspected (`0001`, `0003`, `0004`, `0008`, `0009`, `0013`):

- Every user-owned table has RLS enabled and exactly one policy: `for all using (auth.uid() = user_id) with check (auth.uid() = user_id)`. There is no separate `select`/`insert`/`update`/`delete` policy split anywhere in the registers inspected.
- Reference/catalogue tables (`countries`, `currencies`, `master_financial_items`, `goal_types`, `goal_planning_config`) are `for select using (true)` — world-readable, writable only via the service-role admin path (`lib/services/adminAuth.ts`'s `requireAdmin()` + `adminClient()`), which itself gates on a **separate, RLS-scoped** `admin_users` table a normal user cannot self-grant.
- No client-side-only filtering is relied on anywhere inspected — every list/read in `lib/services/registry.ts` and the module-specific services still issues the query through the RLS-respecting `createClient()` (from `lib/supabase/server.ts`, `@supabase/ssr`-backed), never the service-role client, for any user-facing read.
- `household_members` (section 6) confirms the platform currently has **no real multi-person household access model** — it is reference data for tagging within one owning `user_id`'s RLS boundary, not a second authenticated principal. There is no "spouse logs in and sees the same household" capability today. This is a material gap R0's security design (`R0_SECURITY_RLS_ARCHITECTURE.md`) must flag rather than assume away, since the spec's own "family-member access" and "adviser/CA future access" requirements have no existing analogue to extend.
- Storage: exactly one bucket usage found (`report-exports`), private, service-role write + signed-URL read (section 9).

## 11. Identified duplication risks

1. **Asset/Investment catalogue overlap** (section 3, 8): `gold`, `silver`, `cryptocurrency`, `shares`, `etfs`, `managed_funds` all exist as valid `master_item_key`s in **both** the `asset` and `investment` catalogue categories, and both feed `computeDashboard()`'s single netWorth sum with no cross-register uniqueness constraint. Nothing today stops the same real holding being recorded twice, once per register.
2. **Retirement vs. Investment**: NPS is presently only reachable as a `retirement_accounts` row (`account_type='NPS'`); nothing in the discovered schema would stop a future import path also creating an `investments` row for the same NPS account unless explicitly guarded.
3. **`master_item_key` uniqueness is per-table, not cross-table**: the `unique(user_id, master_item_key)` constraints on `assets`, `investments`, `retirement_accounts`, `liabilities` are each scoped to their own table — they prevent duplicate *catalogue* rows within one register but do nothing to prevent the same *economic position* existing as a row in two different registers.
4. **No source/provenance column exists anywhere** on `assets`, `investments`, or `retirement_accounts` today (section 4) — so there is currently no way to distinguish a manually-typed row from a hypothetical future imported one, which is precisely the gap Investment Intelligence's publishing layer must close without breaking the existing manual-entry path.
5. **Goal funding double-counting is already solved once** (section 6) but only within `goal_funding_sources`' own percentage-allocation model — Investment Intelligence must reuse this exact mechanism for its own published positions rather than inventing a second allocation model that could disagree with it.

## 12. Identified migration risks

1. `investments`, `assets`, `retirement_accounts` are live, actively-read/written tables feeding Dashboard, Reports and Forecasting today. Any future R1 migration that adds Investment-Intelligence-owned columns or a `source`/`ii_position_id` link to these tables must be additive (nullable, defaulted) — none of the existing INSERT/UPSERT paths in `lib/services/registry.ts` set such a column today, so a `not null` addition without a default would break every existing POST.
2. `unique(user_id, master_item_key)` on `investments` is relied on by the upsert-on-save behaviour in `registry.ts` — any schema change must preserve this constraint's semantics or explicitly migrate the upsert logic in step.
3. `computeDashboard()`'s net-worth formula (section 8) is a single pure function with no schema coupling beyond its `InvestmentRow`/`AssetRow`/`RetirementRow` input shapes — extending those input shapes (e.g. to add a `published_from_ii: boolean` or `canonical_position_id`) is low-risk *if* additive, but any change to which rows are summed (e.g. filtering out rows that also exist in an Investment Intelligence table) must be done deliberately and tested against the existing 124-test baseline (`R0_TESTING_AND_VERIFICATION.md`).
4. `goal_funding_sources.linked_investment_id` is a live FK into `investments.id` — any future model where an Investment Intelligence position is a *different* row/table than the `investments` row a goal is linked to would break this FK relationship unless the publishing/dedup design (see `R0_NET_WORTH_DEDUP_CONTRACT.md`) explicitly keeps `investments.id` as the stable, goal-linkable identity.
5. No existing migration in `supabase/migrations/` touches Investment Intelligence concepts at all — R1's first migration will be additive-only against a completely untouched surface, which is the lowest-risk starting position R0 could hand off.

## 13. Existing functionality that must not be broken

- The manual Investments/Assets/Retirement grids (`lib/grid/configs.ts`, `app/(app)/investments/page.tsx` and siblings) and their API routes (`app/api/investments`, `app/api/assets`, `app/api/retirement`) must continue to work unmodified — R0 changes nothing here (no code was touched).
- `computeDashboard()`'s net-worth, allocation and ratio calculations (124 passing unit tests today, see `R0_TESTING_AND_VERIFICATION.md`) must remain byte-for-byte correct.
- Forecasting's `runInvestmentForecast()`/`runNetWorthForecast()` and their `MASTER_ITEM_TO_ASSET_CLASS` mapping must keep resolving asset classes exactly as today.
- `goal_funding_sources`/`checkFundingAllocation()`'s existing double-counting prevention for manually-entered assets/investments must be preserved and extended, not replaced.
- Report generation (`reportSections.ts`, `report_content_library`) must keep reading from the same `DashboardSummary`.
- RLS owner-only isolation (section 10) must not be weakened by any future Investment Intelligence table.

---

*This document reflects only what was found in the repository at the time of inspection. No Investment Intelligence code, schema, or migration was created to produce it.*
