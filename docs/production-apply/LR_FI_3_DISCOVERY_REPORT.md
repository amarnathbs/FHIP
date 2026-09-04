# LR-FI-3 (Phase 1 / LR-FI-3.1) — Discovery Report

**Status:** DISCOVERY ONLY. No source file under `lib/`, `app/`, `components/` or
`supabase/migrations/` was changed to produce this document. No live-DEV or
production test was run. Pure static tracing of `main` as checked out in this
worktree.

**Track:** LR-FI-3 — "Contribution, Savings & Net-Worth Forecast
Exactly-Once Integrity", opened by LR-FI-2 (`docs/production-apply/LR_FI_2_SCOPE_DECISION.md`,
Residual Finding R4) after LR-FI-2 fixed the SMSF-cash-flow/wealth-basis
mismatch but explicitly declined to touch contribution semantics ("do not
redesign the entire contribution engine").

**Instruction observed:** "Do not begin by changing the Net Worth forecast
formula." Every finding below states current behaviour, then a defect
yes/no judgement with reasoning, then (only for genuine defects) what the
correct behaviour should be — with the fix itself deferred to a later phase.

---

## 1. Where household cash surplus is computed

There is exactly one place `monthlySurplus` (or an equivalent) is computed in
the household layer: `lib/engines/dashboard.ts:599`.

```ts
// lib/engines/dashboard.ts:598-600
const incomeForSurplus = netMonthlyIncome || grossMonthlyIncome;
const monthlySurplus = incomeForSurplus - totalMonthlyExpenses - debtMonthlyRepayments;
const savingsRate = incomeForSurplus > 0 ? monthlySurplus / incomeForSurplus : null;
```

Its three terms, each independently traced:

- `incomeForSurplus` ← `netMonthlyIncome` (`dashboard.ts:510-513`) or
  `grossMonthlyIncome` (`dashboard.ts:509`) — both built from
  `householdIncome = householdOperatingCashFlowRows(input.income)`
  (`dashboard.ts:500`), i.e. already SMSF-filtered per LR-FI-1, but **not**
  contribution-filtered — income rows are `income_sources`, contributions
  are read from `investments`/`retirement_accounts` entirely separately (§2).
- `totalMonthlyExpenses` (`dashboard.ts:581`) = `essentialMonthlyExpenses +
  lifestyleMonthlyExpenses`, both built from `nonDebtExpenses`
  (`dashboard.ts:565`), which filters `expense_items` rows. No
  `investment`/`retirement`/`goal`/`smsf` contribution row is ever read from
  `expense_items` — confirmed independently by LR-FI-2 Item 5 (no `super`,
  `sip`, `*_contribution` master item exists under the `expense` category in
  `supabase/seed_master_items.sql`) and reconfirmed here by inspecting
  `dashboard.ts:565-581` directly: the only filter applied is the debt-service
  de-duplication guard (`isDuplicateDebtServiceExpense`), which has nothing to
  do with contributions.
- `debtMonthlyRepayments` (`dashboard.ts:589`) sums `householdLiabilities`'
  `monthly_repayment` — liability instalments, not contributions.

**Conclusion, stated plainly because it is the load-bearing fact for
everything below:** `monthlySurplus` is purely
`income − expenses − debt service`. It has never, at any point in its
computation, subtracted an investment contribution, a personal retirement
contribution, an SMSF contribution or a goal contribution. This matches
LR-FI-2 Item 5's own finding exactly and is reconfirmed here by direct
re-reading of the current line numbers, not assumed.

This is a **design fact, not itself a defect** — see §7/§8 for where it
becomes one only when a *second* place also adds one of those contributions
as if it were new money on top of an unmodified `monthlySurplus`.

---

## 2. Every place a contribution field is read and fed into a forecast/consumer

Grep across `lib/engines/`, `lib/services/`, `app/api/` for
`monthlyContribution|annualContribution|annual_contribution|monthly_contribution|sip|recurring_investment|salary_sacrifice|employer_contribution|personal_contribution|smsf.*contribution|contribution.*smsf|goal.*contribution|contribution.*goal|max\(0` produced the following real hits (test files and the FDH-9/FDH-12 payslip/statement-ingestion modules, which write source-document fields rather than feed a forecast, are excluded from the table but discussed in §4 where relevant):

| file:line | field read | feeds | also subtracted from the surplus/cash figure feeding the SAME consumer? |
|---|---|---|---|
| `lib/engines/dashboard.ts:824-827` | `retirement_accounts.employer_contribution` (all rows, unfiltered — see §5) | `dashboard.retirementEmployerMonthlyContribution` | N/A — employer money never passes through take-home pay; correctly never subtracted anywhere (see `healthScore.ts:202-207`) |
| `lib/engines/dashboard.ts:828-831` | `retirement_accounts.personal_contribution` (all rows, unfiltered) | `dashboard.retirementPersonalMonthlyContribution` | **No.** Funded from the same net income already inside `monthlySurplus`. Not subtracted. |
| `lib/engines/dashboard.ts:832` | `investments.annual_contribution` | `dashboard.investmentAnnualContribution`, `investmentContributionRate` | **No.** Same net income as `monthlySurplus`. Not subtracted. |
| `lib/engines/healthScore.ts:198-208` | `d.monthlySurplus`, `d.retirementEmployerContributionRate` | `totalSavingsRate` (Health Score "Savings Behaviour" component) | **Correct treatment** — only the employer portion is added on top; the comment at `:202-207` states the double-count reasoning explicitly and does not add investment/personal-retirement contribution rates. |
| `lib/services/forecastData.ts:832` | `dashboard.monthlySurplus` via `Math.max(0, …)` | `NetWorthCalculatorInput.monthlyAssetContribution` → `netWorthCalculator.ts:87` (general-assets bucket) | **No — this is the defect.** See §8. |
| `lib/services/forecastData.ts:833` | `dashboard.investmentAnnualContribution / 12` | `NetWorthCalculatorInput.monthlyInvestmentContribution` → `netWorthCalculator.ts:93` (investments bucket) | Same surplus feeds the assets bucket above with no netting — double-counted, see §8. |
| `lib/services/forecastData.ts:834` | `dashboard.retirementEmployerMonthlyContribution + dashboard.retirementPersonalMonthlyContribution` | `NetWorthCalculatorInput.monthlyRetirementContribution` → `netWorthCalculator.ts:99` (retirement bucket) | The **personal** half double-counts against the same surplus; the **employer** half is legitimately additive — see §8 (the two halves must be split, they are currently sighted only as a summed pair). |
| `lib/services/forecastData.ts:807` (`investment` forecast type) | `investments.annual_contribution / 12` | `InvestmentCalculatorInput.monthlyContribution` → grows that investment's own standalone balance | Never combined with `monthlySurplus` in this forecast type at all — no `openingAssets`/no household cash-flow term exists in `InvestmentCalculatorInput`. **Not a double-count risk on its own**, but see §9 for whether its OUTPUT is later summed with the net-worth forecast's output (it is not — confirmed disclosed-as-informational, `forecastData.ts:826-831`). |
| `lib/services/forecastData.ts:517-528, 604-627, 645` (`retirement` forecast type) | `retirement_accounts.employer_contribution + personal_contribution` (all rows, unfiltered — including any `owner='smsf'` row, see §5) | `RetirementCalculatorInput.monthlyContribution` → grows the standalone retirement projection (`retirementCalculator.ts`) | This calculator **never reads `investments` or `monthlySurplus` at all** (its own header comment, `retirementCalculator.ts:6-9`, states this is deliberate, "to avoid double counting"). Not a double-count risk standalone. |
| `lib/services/forecastData.ts:458, 462-465` (`cross_border` forecast type) | foreign-currency `investments.annual_contribution`, `retirement_accounts.employer/personal_contribution` | `CrossBorderCalculatorInput.monthlyForeignInvestmentContribution`, `monthlyForeignRetirementContribution`; `monthlyForeignAssetContribution` is explicitly hard-coded `0` (`:477`) | **No double-count** — no surplus is swept into the foreign-assets bucket at all (income:0/expenses:0 by design, per LR-FI-2 §6a); each bucket only grows by its own contribution field. |
| `lib/services/forecastData.ts:781` (`goal` forecast type) | `user_goals.planned_contribution_amount` + `computeAllocatedMonthlyContribution(...)` (an allocated % of a linked investment's/retirement account's own contribution, `lib/services/goalFundingAllocation.ts:98-120`) | `GoalCalculatorInputEntry.monthlyContribution` → grows that goal's own standalone balance (`goalCalculator.ts:59`) | Never combined with `monthlySurplus` inside this forecast type. The *allocated* portion re-reads the SAME `investments.annual_contribution` / `retirement_accounts.*_contribution` fields already feeding the net-worth forecast (§2 rows above) — this is a genuine cross-consumer duplication of the *same underlying dollars* across two different forecast outputs, but per `forecastData.ts:826-831`'s own comment those two outputs ("standalone goal/investment forecasts … informational projections … not summed into net worth") are never added together anywhere in the codebase (confirmed — see §6 and §9). **Not a defect today**, because nothing sums them; it becomes one only if a future feature adds a "total projected wealth = net worth forecast + sum of goal forecasts" figure without reconciling this. |
| `lib/engines/forecast/resilienceCalculator.ts:88-89` | — | `investments`/`retirement` buckets grow with `contributions: 0` (hard-coded) | **No double-count** — Resilience deliberately does NOT re-apply investment/retirement contributions; only `liquidAssets` grows, by the whole `currentSurplus` (`:83`). See §9. |
| `lib/engines/goalAffordability.ts:30-92` | `dashboard.monthlySurplus`, `totalPlannedGoalContributions` | `AffordabilityResult` (comparison only) | **No double-count** — this is a comparison ("does your surplus cover your planned goal contributions"), never adds the two together into a wealth or cash figure, and the file's own comment says "never recalculated here" (`goalAffordability.ts:9-13, 26-29`). |

---

## 3. Investments — which contribution fields exist and who consumes them

`lib/grid/configs.ts:106-121` (`investmentGridConfig`) shows the entire
user-editable field list for the `investments` table. There is exactly **one**
contribution-shaped field: `annual_contribution` (`configs.ts:121`). There is
no separate `monthly_contribution`, `recurring_investment` or `sip_amount`
column on `investments` at all — a repo-wide grep for `sip` in migrations and
`lib/investment-intelligence/` (the Investment Intelligence R5 "SIP
Intelligence & Portfolio X-Ray" module referenced in project memory) confirms
that engine **never reads or writes `investments.annual_contribution`** — SIP
detection is a separate read-only analytics layer over transaction history,
entirely disconnected from the dashboard/forecast contribution figures traced
here. It is not a contributor to the defect discussed below.

Consumers of `investments.annual_contribution`:

1. `lib/engines/dashboard.ts:832` → `investmentAnnualContribution`,
   `investmentContributionRate` (a ratio, read by `healthScore.ts:199` but
   never added to `totalSavingsRate`, and by `lib/ai/context/financialContextObject.ts:455` as a pass-through percentage).
2. `lib/services/forecastData.ts:833` → net-worth forecast's investment bucket
   (see §8, the defect).
3. `lib/services/forecastData.ts:807` → the standalone `investment` forecast
   type's own per-investment projection (`investmentCalculator.ts`, not
   traced further here — never combined with net worth, per `forecastData.ts:826-831`).
4. `lib/services/forecastData.ts:743` (via `goalFundingAllocation.ts:107-109`)
   → an allocated percentage of it feeds a linked goal's own contribution
   (see §6).

No other calculator (`debtCalculator.ts`, `crossBorderCalculator.ts` aside
from its own foreign-currency read at `forecastData.ts:427`,
`resilienceCalculator.ts`) reads `annual_contribution`.

---

## 4. Retirement — schema reality vs. what actually feeds a forecast

`supabase/migrations/0004_financial_data_grid.sql:74-75` is the origin of the
two contribution columns still in use today:

```sql
add column employer_contribution numeric(18,2) check (employer_contribution >= 0),
add column personal_contribution numeric(18,2) check (personal_contribution >= 0),
```

No other contribution column (no `voluntary_contribution`,
`concessional_contribution`, `non_concessional_contribution`,
`government_co_contribution` etc.) exists as a real column on
`retirement_accounts` — those labels appear only as **catalogue item keys**
inside the recommendations seed data (`supabase/migrations/0020_recommendations_data_import.sql`)
and as reclassification source-labels consumed once, at data-migration time,
by `supabase/migrations/0073_air_consolidation_data_reclassification.sql:265-274`,
which folds every one of those catalogue-labelled rows down into exactly the
two real columns (`employer_contribution` if `is_employer_side`, else
`personal_contribution`). So `employer_contribution` / `personal_contribution`
is the entire real, currently-queried schema — everything else is aspirational
labelling that has already been collapsed into these two columns by the time
any forecast code reads the table. `salary_sacrifice` as a distinct *stored*
column exists only in the unrelated FDH-9 payslip-intelligence staging tables
(`0091_fdh9_payslip_income_intelligence.sql:129`) and the FDH-12
retirement-statement staging table (`0112_fdh12_retirement_statement_intelligence.sql:301-303`)
— neither is `retirement_accounts` itself, and salary-sacrifice amounts
detected there are folded into `retirement_accounts.employer_contribution`
(`0073…:271`, since `salary_sacrifice` is in the `is_employer_side` list) once
applied, never kept as a fourth separate figure a forecast could read.

**Section 22 hard gate — is there a code path where a contribution leaks into
a CURRENT balance figure (not just a future-forecast figure)?**

Negative finding, confirmed by direct inspection of the one live write path
capable of moving statement-derived numbers into `retirement_accounts`:
`fdh12_apply_retirement_proposal()`
(`supabase/migrations/0112_fdh12_retirement_statement_intelligence.sql:1226-1400`).
Its allow-list (`:1240-1244`) treats `current_balance`, `employer_contribution`
and `personal_contribution` as three **independent** selectable/settable
columns — each is read, compared for staleness, and written as its own SQL
column (`:1379-1388` builds the staleness check per-field with no
cross-term; the same one-column-per-field pattern continues in the `UPDATE`
construction later in the function, not reproduced here for length). There is
no `current_balance = current_balance + employer_contribution` or similar
expression anywhere in this function or in the mirrored
`0119_fdh15_retirement_member_mismatch_guard.sql`. **No leak found — this is
a genuine negative result, not an assumption**, and it is the only live write
path examined that could plausibly have done this (retirement_accounts is
otherwise only written through the generic CRUD grid, which writes exactly the
column the user edited, one field at a time, with no derived arithmetic).

---

## 5. SMSF — contribution source discrimination

`supabase/migrations/0084_geo_jurisdiction_smsf.sql:155-278` is the complete
SMSF schema: `smsf_funds` (`summary_balance` / `detailed_net_value`,
`:171,180`), `smsf_fund_members` (`member_interest_amount`, explicitly
"informational attribution only… never itself feeds Net Worth", `:222-226`),
`smsf_holdings` (`value`, per-holding balance, `:258`). **None of these three
tables has any contribution column at all** — no employer/member/spouse/
rollover contribution field exists anywhere in the SMSF schema. This is a
plain negative finding, not an assumption from absence of a search hit: the
full `CREATE TABLE` bodies were read in this pass, not merely grepped.

An SMSF's `retirement_accounts` row (the fund's single canonical Net Worth
home per `master_item_key = 'smsf'`, enforced by
`smsf_funds_validate_retirement_link()` at `:197-212`) **does** carry the same
two generic columns as every other retirement row — `employer_contribution`
and `personal_contribution` — and nothing in `dashboard.ts:824-831` or
`forecastData.ts:489, 517-528` filters those reads by `owner`/`master_item_key`
before summing them. So today:

- If a user records a member's personal contribution paid into their own SMSF
  on that row, it is read identically to a non-SMSF personal retirement
  contribution — same column, same summing code, same downstream consumer.
  **The schema genuinely cannot distinguish employer-vs-member-vs-spouse-vs-
  rollover SOURCE within an SMSF** (there is no source-tagged contribution
  table), so "is it treated identically" is really "there is only one thing
  to treat" — say so plainly rather than assume a distinction the schema does
  not carry.
- Because this read is unfiltered by owner (consistent with LR-FI-1 §28's
  "wealth stays whole" rule — retirement forecasting is a wealth projection,
  not household cash flow), an SMSF row's `personal_contribution` also
  participates in the same defect traced in §8, if such a value is ever
  entered.

---

## 6. Goals — allocation attribution vs. manual contribution

Two genuinely distinct mechanisms exist, confirmed by reading both all the
way through:

**(a) Linked-investment/retirement allocation percentage — attribution of an
existing balance, never new wealth.**
`goal_funding_sources.allocation_percentage` against a `linked_investment_id`
/ `linked_retirement_id` is resolved by `resolveAllocatedAmount()`
(`lib/services/goalFundingAllocation.ts:139-185`) and
`computeLiveLinkedFundingValue()` (`:247-267`) purely by reading the linked
record's *current* `current_value`/`current_balance` and multiplying by a
percentage — **it never writes to the linked investment/retirement row**, and
the linked row's own balance is not reduced. `checkFundingAllocation()`
(`:37-64`) additionally prevents the same balance being over-allocated past
100% across multiple goals. This is exactly the attribution-only treatment
the dispatch asked to confirm, and it is correct: the underlying investment
still shows its full balance in Net Worth (`dashboard.ts:648-649`, unfiltered,
unaware `goal_funding_sources` exists at all — confirmed by grep,
`dashboard.ts` never references that table), and the goal's own
`currentAmount` display additionally credits the same dollars
(`goalsData.ts:236`, `toGoalRecord()`). This is a deliberate, disclosed
"informational" double-surfacing for *display* purposes (spec s.33's own
requirement, `goalFundingAllocation.ts:225-238`'s comment), not a wealth
double-count, because neither `dashboard.netWorth` nor
`goalsData.ts`'s `GoalSummary.totalCurrentAmount` is ever added to the other
anywhere in the codebase (§2 table, `totalCurrentAmount` grep — its only
consumer is `lib/engines/goalInsights.ts`, which never references `netWorth`).

**(b) Manual/standalone goal cash contribution — a separate ledger nobody
outside the Goals module reads.**
`app/api/goals/[id]/contributions/route.ts:19-50` is the entire write path.
A confirmed contribution moves `user_goals.current_amount` by the signed
amount (`:46-49`) and inserts an append-only `goal_contributions` row. This
touches **only** `user_goals` and `goal_contributions`. It never writes to
`expense_items`, `assets`, `investments`, or any table `dashboard.ts` reads.
Confirmed by direct reading of the route and by grep — `dashboard.ts` never
references `user_goals` or `goal_contributions` (its only "goal" reference,
`dashboard.ts:92-93, 442-443, 1047`, is a verbatim pass-through `GoalRow[]`
array used solely for UI display, not folded into any total).

**Consequence, stated as a finding rather than left implicit:** a manual goal
contribution is genuinely invisible to `monthlySurplus` and to Net Worth in
both directions — it is never subtracted from the household's surplus (so
recording one does not shrink `monthlySurplus`, even though real cash left
the household to fund it), and the resulting `user_goals.current_amount` is
never added into `dashboard.totalAssets`/`netWorth` (so money genuinely saved
toward a goal in, say, a dedicated savings account is invisible to Net
Worth). This is an **under-counting risk, not a double-counting risk** — the
opposite direction of defect from §8 — and it is disclosed here because the
dispatch asked the question directly, but it is **out of LR-FI-3's stated
scope** (the R4 hypothesis and the dispatch's own framing are about
double-counting; this is a separate, real gap for a future goal-linkage or
cash-flow-input redesign to close, not something this pass recommends fixing
now).

---

## 7. Required tables

### 7a. Canonical contribution contract

| Quantity | Current source | Current meaning | Intended meaning | In household cash flow? | In wealth growth? |
|---|---|---|---|---|---|
| Household income | `income_sources` via `householdOperatingCashFlowRows` (`dashboard.ts:500`) | Household-only gross/net income | Same | Yes (numerator of `monthlySurplus`) | No |
| Operating expenses | `expense_items` via `nonDebtExpenses` (`dashboard.ts:565`) | Household-only, debt-service-deduplicated | Same | Yes (subtracted) | No |
| Debt service | `liabilities.monthly_repayment`, household-only (`dashboard.ts:589`) | Instalment outflow | Same | Yes (subtracted) | No (balance amortisation uses the whole-portfolio figure per LR-FI-2 §6c, a separate field) |
| Cash surplus | `dashboard.ts:599` | `income − expenses − debt service`, **never nets any contribution** | Same, **provided every consumer that separately adds a contribution nets it out first (currently one does not — §8)** | Is the flow itself | Feeds general-assets bucket in net-worth forecast (`monthlyAssetContribution`) |
| Savings rate | `dashboard.ts:600` | `monthlySurplus / incomeForSurplus` | Same | Derived from cash flow | N/A |
| Investment contribution | `investments.annual_contribution` (`dashboard.ts:832`) | Recurring inflow into an investment, funded from the same net income as surplus | Same; must be netted against surplus wherever both are summed into one wealth total | **Not currently subtracted from surplus anywhere** | Grows the investments bucket directly (net-worth forecast, standalone investment forecast) |
| Retirement contribution (total) | `retirement_accounts.employer_contribution + personal_contribution` (`dashboard.ts:824-831`) | Sum of two economically different flows | Should stay split, not pre-summed, wherever it feeds a household-relative figure | Personal half funded from surplus; employer half is not | Grows the retirement bucket |
| Employer super contribution | `retirement_accounts.employer_contribution` | Never part of take-home pay | Same — genuinely additive | **Correctly never subtracted** (this is why it's additive) | Grows retirement bucket; correctly also added to `totalSavingsRate` (`healthScore.ts:208`) |
| Personal super contribution | `retirement_accounts.personal_contribution` | Funded from net income already in surplus | Same | **Not currently subtracted from surplus anywhere** | Grows retirement bucket (double-counted where surplus is also swept, §8) |
| SMSF contribution | Same two columns as above, on the SMSF's own `retirement_accounts` row; **no source-tagged (employer/member/spouse/rollover) table exists** | Indistinguishable from a non-SMSF personal/employer contribution — the schema has only one column pair, full stop | Would need new columns/tables to ever distinguish source; not assumed to be an oversight, genuinely absent | Personal-side is presumably surplus-funded like any other personal contribution, if entered | Grows the (unfiltered, per LR-FI-1 §28) retirement bucket |
| Goal contribution (manual) | `user_goals.planned_contribution_amount`, confirmed via `goal_contributions` → `user_goals.current_amount` | A separate, un-reconciled ledger — never subtracted from surplus, never added to Net Worth | Should eventually be reconciled against household cash flow (future scope, not this pass) | **No** (invisible both ways — §6) | **No** |
| Residual cash saving | `monthlySurplus` itself, once it *would* be netted of investment/personal-retirement contributions | The part of surplus with no already-declared destination | Same | Is the flow | Swept into general assets (net-worth forecast's `monthlyAssetContribution`) — **currently over-credited, §8** |

### 7b. Every forecast/consumer that adds contributions

| Consumer | Uses surplus? | Adds investment contribution? | Adds retirement contribution? | Adds goal contribution? | Double-count risk |
|---|---|---|---|---|---|
| Net Worth forecast (`netWorthCalculator.ts` via `forecastData.ts:816-863`) | Yes, whole, unmodified (`:832`) | Yes, separately (`:833`) | Yes, separately, employer+personal summed (`:834`) | No | **Yes — confirmed defect, §8** |
| Retirement forecast (`retirementCalculator.ts`) | No | No | Yes (its only input) | No | No (standalone, deliberately isolated, `retirementCalculator.ts:6-9`) |
| Investment forecast (`investmentCalculator.ts` via `forecastData.ts:789-814`) | No | Yes (its only input, per-investment) | No | No | No (standalone; never summed with net worth, `forecastData.ts:826-831`) |
| Goal forecast (`goalCalculator.ts` via `forecastData.ts:691-787`) | No | Indirectly, via allocated % (`goalFundingAllocation.ts`) | Indirectly, via allocated % | Yes (`planned_contribution_amount`) | No (never summed with net worth or investment forecast outputs anywhere in the codebase — confirmed by grep) |
| Debt forecast (`debtCalculator.ts`) | No | No | No | No | No — per-liability, no aggregate (LR-FI-2 §6b) |
| Resilience forecast (`resilienceCalculator.ts`) | Yes, whole (`:83`, liquid-assets bucket only) | **No** — `contributions: 0` hard-coded (`:88`) | **No** — `contributions: 0` hard-coded (`:89`) | No | **No** — deliberately does not re-add investment/retirement contributions, so it does not reproduce the Net Worth forecast's defect |
| Cross-border forecast (`crossBorderCalculator.ts` via `forecastData.ts:419-482`) | No — `monthlyForeignAssetContribution: 0` hard-coded (`:477`) | Yes, its own foreign-currency read (`:458`) | Yes, its own foreign-currency read (`:462-465`) | No | No (LR-FI-2 §6a; confirmed independently here — no surplus swept in at all) |
| Reports (`reportSections.ts`, `reportSectionsPremium.ts`) | Pass-through display of `d.monthlySurplus` (`reportSections.ts:123,184,270`) | Pass-through ratio | Pass-through ratio; retirement projection section explicitly reuses the persisted Retirement Forecast calculation rather than re-deriving (`reportSectionsPremium.ts:302`, "It reuses the same Retirement Forecast calculation available on the Forecasting pages — it is not a new or separate calculation") | Pass-through (`plannedContribution`, `requiredContribution`, `reportSectionsPremium.ts:519-520`) | No — pure pass-through/display, never re-sums |
| AI context (`lib/ai/context/financialContextObject.ts`) | Pass-through `dashboard.monthlySurplus` (`:373`) | Pass-through ratio (`:455`) | Pass-through ratios (`:469-470`) | Pass-through (`:496,499`) | No — reads `latestForecastRun` (persisted `forecast_runs`/`forecast_results`) and `dashboard`/`goalsData` figures verbatim; never independently re-derives or re-sums |

### 7c. Current balance vs future flow matrix

| Item | Current Net Worth? | Future forecast flow? | Both? | Rule |
|---|---|---|---|---|
| Investment current balance (`investments.current_value`) | Yes (`dashboard.ts:648`) | Opening value for net-worth & standalone investment forecasts | Both | Balance is wealth; unambiguous |
| Investment contribution (`investments.annual_contribution`) | No | Yes — grows the net-worth forecast's investment bucket AND (separately) the standalone investment forecast AND (attributed, not summed) a linked goal's allocated contribution | Forecast-only | Same dollars feed two forecast *outputs* (net-worth, investment) that are never added together — no defect there; but within the net-worth forecast alone it is double-counted against surplus, §8 |
| Retirement current balance (`retirement_accounts.current_balance`) | Yes (`dashboard.ts:649`) | Opening value for net-worth & standalone retirement forecasts | Both | Balance is wealth |
| Retirement contribution (employer + personal) | No | Yes — grows the net-worth forecast's retirement bucket AND the standalone retirement forecast | Forecast-only | Same "never summed across forecast types" reasoning; the personal half is separately double-counted against surplus inside the net-worth forecast, §8 |
| SMSF current value (`retirement_accounts.current_balance` where `master_item_key='smsf'`, or `smsf_funds.summary_balance`/`detailed_net_value` mirrored onto it via `trg_smsf_funds_sync_summary`) | Yes, unfiltered per LR-FI-1 §28 | Same as any other retirement row (no SMSF-specific forecast branch) | Both | Consistent with wealth-stays-whole rule |
| SMSF contribution | No | Yes, same generic columns, same code path, no source discrimination (§5) | Forecast-only | Genuinely indistinguishable from non-SMSF personal contribution |
| Goal target (`user_goals.target_amount`) | No | Yes — goal forecast's target line | Forecast-only | Never wealth |
| Goal linked allocation (attributed %) | No (attribution only, §6a) | Yes — goal forecast's `currentAmount` | Forecast-only (display) | Correctly never reduces or duplicates the linked investment/retirement's own Net Worth entry |
| Goal manual contribution | **No** (§6b — invisible to Net Worth) | Yes — goal forecast's `currentAmount`/contribution flow | Forecast-only, and under-counted on the wealth side | Real cash spent funding this is invisible to Net Worth; disclosed, not fixed, out of this pass's scope |
| Cash surplus (`monthlySurplus`) | No (not a balance) | Yes — net-worth forecast's general-assets bucket, resilience forecast's liquid-assets bucket | Forecast-only | This is precisely the figure over-credited in the net-worth forecast, §8 |

---

## 8. Reproducing (or ruling out) the LR-FI-2 R4 hypothesis

**Confirmed as a genuine defect**, using the actual current formula, not a
hypothetical, with every term cited.

The formula, read exactly as it stands today:

```ts
// lib/services/forecastData.ts:816-834
const dashboard = await loadDashboard(userId, supabase);
const netWorthInput: NetWorthCalculatorInput = {
  ...
  openingAssets: dashboard.totalAssets,
  openingInvestments: dashboard.totalInvestments,
  openingRetirement: dashboard.totalRetirement,
  openingLiabilities: dashboard.totalLiabilities,
  monthlyAssetContribution: Math.max(0, dashboard.monthlySurplus),
  monthlyInvestmentContribution: dashboard.investmentAnnualContribution / 12,
  monthlyRetirementContribution: dashboard.retirementEmployerMonthlyContribution + dashboard.retirementPersonalMonthlyContribution,
  ...
};
```

which is then consumed, bucket by independent bucket, with no cross-bucket
netting at all:

```ts
// lib/engines/forecast/netWorthCalculator.ts:80-102
const assetMonth = projectInvestmentMonth({ openingValue: assets, contributions: input.monthlyAssetContribution + eventAmountThisMonth, ... });
const investmentMonth = projectInvestmentMonth({ openingValue: investments, contributions: input.monthlyInvestmentContribution, ... });
const retirementMonth = projectInvestmentMonth({ openingValue: retirement, contributions: input.monthlyRetirementContribution, ... });
```

**Worked numeric example**, all terms sourced from the traced code above (not
invented): a household with

- `netMonthlyIncome` = $8,000 (`dashboard.ts:510-513`)
- `totalMonthlyExpenses` = $4,500 (`dashboard.ts:581`)
- `debtMonthlyRepayments` = $1,500 (`dashboard.ts:589`)
- an investment with `annual_contribution` = $12,000/yr (i.e. a $1,000/month
  SIP funded from the household's own take-home pay) (`dashboard.ts:832`)
- a retirement account with `employer_contribution` = $300/month and
  `personal_contribution` (salary-sacrifice/voluntary) = $500/month
  (`dashboard.ts:824-831`)

Step 1 — `monthlySurplus` (`dashboard.ts:599`):

```
monthlySurplus = 8,000 − 4,500 − 1,500 = 2,000
```

This $2,000 is the household's entire unconsumed cash **after** it has
already paid its $1,000 SIP and $500 personal-retirement contribution out of
its take-home pay — those two amounts are inside the $8,000 net income figure
and were never separately subtracted, exactly as §1 established. In other
words, real-world, the household actually had $2,000 + $1,000 + $500 = $3,500
of "discretionary" cash before deciding to route $1,500 of it into an
investment and a personal super top-up, leaving $2,000 genuinely uncommitted.

Step 2 — what the net-worth forecast does with that same $2,000
(`forecastData.ts:832-834`, `netWorthCalculator.ts:87,93,99`):

```
monthlyAssetContribution      = max(0, 2,000)      = 2,000   → swept into general assets
monthlyInvestmentContribution = 12,000 / 12         = 1,000   → swept into investments
monthlyRetirementContribution = 300 + 500           =   800   → swept into retirement
                                                     -------
Total new "wealth" created this month:                3,800
```

**The defect, stated numerically:** the household's real, fully-accounted-for
uncommitted surplus is $2,000 — the $1,000 SIP and $500 personal-retirement
contribution have already left the household's hands (they were paid out of
the $8,000 net income before the $2,000 was arrived at; §1 established that
`monthlySurplus` never subtracts them a second time, precisely because they
were never added back in either — they simply vanish from the surplus
calculation without a trace, having already been paid out of income upstream
of it). The net-worth forecast then credits **$3,800** of new balance growth
from that same household in the same month — $1,800 more than it actually has
available — because the $1,000 and $500 are each credited a second time,
explicitly, as `monthlyInvestmentContribution` and the personal half of
`monthlyRetirementContribution`, on top of the full, undiminished $2,000
already swept into `monthlyAssetContribution`. The only term that is
legitimately additional new money is the **employer** $300 — money that was
never part of take-home pay to begin with, so there was never anything to
subtract or double-add. That $300 is correctly additive. The other $1,500
($1,000 investment + $500 personal retirement) is invented: it inflates the
projected net worth growth by $1,500/month ($18,000/year before compounding)
relative to the household's true cash position, and the error compounds
forward every month of the forecast horizon since each bucket keeps growing
on its own inflated running balance.

This exactly matches — and fully confirms, via fresh arithmetic rather than
citation alone — the LR-FI-2 R4 hypothesis. The comment already in the code
(`forecastData.ts:826-828`, "any *remaining* monthly surplus is swept into
general assets") describes the *intended* behaviour; the code does not
implement it, because `monthlySurplus` was never reduced by the investment/
personal-retirement contributions in the first place (§1) — there is no
"remaining" surplus to speak of; the whole, undiminished surplus is used.

**Distinguishing the correct component:** exactly the treatment
`healthScore.ts:198-208` already applies (`totalSavingsRate = cashSavingsRate +
retirementEmployerContributionRate` — only the employer rate is added on top)
is the model this forecast input should follow, but does not.

### Intended correct behaviour (not implemented in this pass)

`monthlyAssetContribution` should be `monthlySurplus` net of the investment
and personal-retirement contributions that are already funded from that same
surplus — i.e. something on the shape of
`Math.max(0, dashboard.monthlySurplus − dashboard.investmentAnnualContribution/12 − dashboard.retirementPersonalMonthlyContribution)`
— while `monthlyInvestmentContribution` and `monthlyRetirementContribution`
(split so the employer half stays additive and the personal half does not
also inflate the general-assets bucket) continue to grow their own
bucket exactly as today, since that correctly reflects *where* the money
ends up even though it must stop being credited twice. This is stated as the
target shape for a later implementation phase; no code is changed here.

---

## 9. Every other place besides the Net Worth forecast that might independently re-add a contribution

Each was traced to a definite answer, not assumed:

- **Resilience forecast** (`resilienceCalculator.ts`) — does **not**
  independently re-add investment/retirement contributions
  (`contributions: 0` hard-coded at `:88-89`); only `liquidAssets` grows by
  the whole `currentSurplus`. It does **not** reproduce the net-worth
  forecast's defect. It shares one different, narrower risk: `liquidAssets`
  grows by the *whole* surplus including the part that funds investment/
  personal-retirement contributions, which slightly overstates how much cash
  would actually be sitting in liquid reserves under a stress scenario — but
  since investments/retirement don't ALSO grow from that same money here,
  there is no double-count of *wealth*, only a possible overstatement of how
  liquid vs. invested that wealth is. Disclosed, not investigated further —
  outside this pass's SMSF/forecast-formula-only mandate and not the R4
  hypothesis.
- **Financial Twin** (`lib/engines/twin/metricDerivation.ts`) — its
  `retirementBalanceAtTarget`/`netWorthIn5Years` projections (`:275-352`)
  independently compound `retirementEmployerMonthlyContribution +
  retirementPersonalMonthlyContribution` forward from the current retirement
  balance, but **never combines this with `monthlySurplus` or
  `investmentAnnualContribution`** — it is a separate, single-bucket
  extrapolation, not a whole-net-worth sweep. Its `netWorthIn5Years`
  (`:318-325`) is a pure historical-trend extrapolation from
  `snapshots12m`, not an additive contribution model at all. Twin
  re-derives independently rather than consuming `forecast_results`, but its
  particular re-derivation does not reproduce the net-worth forecast's
  defect.
- **Reports** (`reportSections.ts`, `reportSectionsPremium.ts`) — consume
  already-computed `dashboard`/`goalsData` figures and the persisted
  Retirement Forecast verbatim (`reportSectionsPremium.ts:302`, explicit
  comment: "It reuses the same Retirement Forecast calculation … not a new or
  separate calculation"). No independent re-derivation found.
- **AI / Module 11 context** (`lib/ai/context/financialContextObject.ts`) —
  reads `dashboard.monthlySurplus`, the contribution *rates* (percentages,
  never raw dollar sums), and `latestForecastRun` (the persisted
  `forecast_runs`/`forecast_results` row) verbatim. No independent
  re-derivation or re-summing found.
- **Goal forecast** — re-reads the same `investments.annual_contribution` /
  `retirement_accounts.*_contribution` fields (via the allocation mechanism,
  §6a) that the net-worth forecast also reads, but its output
  (`GoalCalculatorInputEntry.monthlyContribution` → a goal's own standalone
  balance) is never summed with the net-worth forecast's output anywhere in
  the codebase — confirmed by grep for any code that adds
  `goal.*current_amount`/`totalCurrentAmount` to `netWorth`/`totalAssets`;
  none exists.
- **Cross-border forecast** and **Debt forecast** — already ruled out by
  LR-FI-2 §6a/§6b and reconfirmed here independently (§2 table).

**Conclusion:** the Net Worth forecast (`netWorthCalculator.ts` via
`forecastData.ts:816-863`) is the **only** consumer in the codebase today that
reproduces the R4 double-count. Every other consumer either doesn't combine
surplus with investment/retirement contributions at all, or reuses a
persisted figure rather than re-deriving one.

---

## Summary of defect findings

| # | Item | Verdict |
|---|---|---|
| 1 | `monthlySurplus` never nets any contribution | Design fact, not itself a defect |
| 2 | Net Worth forecast double-counts personal investment + personal retirement contributions against surplus (LR-FI-2 R4) | **Genuine defect — confirmed, reproduced numerically** |
| 3 | Net Worth forecast's employer-contribution term | Correctly additive, no defect |
| 4 | Retirement forecast (standalone) | No defect — deliberately isolated from investments/surplus |
| 5 | Investment forecast (standalone) | No defect — never combined with net worth |
| 6 | Goal forecast / goal-linkage allocation attribution | No defect — attribution-only, never double-added to Net Worth |
| 7 | Goal manual contribution invisibility to surplus/Net Worth | Real gap, but **under**-counting, not double-counting; out of scope, disclosed only |
| 8 | Resilience forecast | No defect — contributions hard-coded to 0 for investments/retirement |
| 9 | Cross-border forecast | No defect (LR-FI-2 §6a reconfirmed) |
| 10 | SMSF contribution-source discrimination | Schema genuinely cannot distinguish source — plain negative finding, not a defect to fix here (nothing to discriminate) |
| 11 | FDH-12 retirement-statement-intelligence apply RPC leaking contribution into current balance (§22 hard gate) | No leak found — genuine negative result |
| 12 | Financial Twin / Reports / AI context independent re-derivation | None reproduce the net-worth forecast's defect; all either isolated single-bucket models or verbatim pass-through |

---

## Scope guards observed

No file under `lib/`, `app/`, `components/` or `supabase/migrations/` was
edited to produce this report. No live-DEV or production query was run. The
Net Worth forecast formula itself was read and quoted, not changed, per the
dispatch's explicit instruction. `lib/engines/householdContext.ts` and
`lib/engines/debtServiceContext.ts` were reused for citation of the
household/SMSF/debt-service classification already established by LR-FI-1/
LR-FI-2 and were not duplicated or re-implemented.
