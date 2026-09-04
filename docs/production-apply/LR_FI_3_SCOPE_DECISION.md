# LR-FI-3 — Scope Decision Document

**Status:** discovery complete (`docs/production-apply/LR_FI_3_DISCOVERY_REPORT.md`), fix implemented, verification in progress.
**Base:** `main` as checked out in this worktree, immediately following LR-FI-2.
**Predecessor:** LR-FI-2 (`docs/production-apply/LR_FI_2_SCOPE_DECISION.md`) — merged, closed, opened this track as Residual Finding R4.

LR-FI-2 traced `dashboard.ts`, `forecastData.ts`, `whatIf.ts` and
`reportSections.ts` extensively for debt/DTI/DSR purposes and, while doing so,
found a related but distinct defect it deliberately declined to fix under its
own scope bound ("do not redesign the entire contribution engine"): the Net
Worth forecast appeared to sweep the whole household surplus into general
assets and separately add investment/retirement contributions on top,
without `monthlySurplus` ever subtracting those contributions first.

LR-FI-3's discovery phase (`LR_FI_3_DISCOVERY_REPORT.md`) re-traced the
hypothesis from scratch — not assumed true — against fresh line numbers and a
worked numeric example, and confirmed it as the **only** genuine defect out
of roughly a dozen suspected consumers examined. This document records the
fix decided from that trace.

The organising finding, stated once because it governs the whole fix: LR-FI-2
found every genuine defect it fixed was a place where a **filtered**
household figure and an **unfiltered** wealth figure were combined
incoherently. LR-FI-3's defect is a different shape — a single figure
(`monthlySurplus`) is coherent and correctly filtered on its own, but a
**second, independent** figure (the investment/personal-retirement
contribution) that is already implicitly inside it is added again on top,
inside one forecast input. The fix is never "filter `monthlySurplus`
differently" — it is "net out, at the one point that sweeps a residual into
a new bucket, exactly the contributions that are already inside it."

---

## Item 1 — Net Worth forecast double-counts household-funded contributions

### What the current behaviour actually is

`lib/services/forecastData.ts` (net_worth branch, pre-fix):

```ts
monthlyAssetContribution: Math.max(0, dashboard.monthlySurplus),
monthlyInvestmentContribution: dashboard.investmentAnnualContribution / 12,
monthlyRetirementContribution: dashboard.retirementEmployerMonthlyContribution + dashboard.retirementPersonalMonthlyContribution,
```

`dashboard.monthlySurplus` (`lib/engines/dashboard.ts:599`) is
`incomeForSurplus - totalMonthlyExpenses - debtMonthlyRepayments`. It has
never, at any point in its computation, subtracted an investment or
personal-retirement contribution — both are funded from the same net income
already inside it, by construction of the household registers (contributions
live in `investments`/`retirement_accounts`, never in `expense_items` —
reconfirmed in the discovery report §1, independently of LR-FI-2's own
finding on the same point).

`netWorthCalculator.ts` then grows three buckets independently, with no
netting between them:

```ts
contributions: input.monthlyAssetContribution + eventAmountThisMonth,   // general assets
contributions: input.monthlyInvestmentContribution,                    // investments
contributions: input.monthlyRetirementContribution,                    // retirement
```

So a household's own investment/personal-super contribution is credited to
projected wealth twice: once as still-uncommitted residual cash swept into
general assets (because the surplus figure never subtracted it), and again
as contribution principal growing its own bucket.

**Worked example** (full arithmetic in the discovery report §8): $8,000 net
income, $6,000 expenses+debt service → `monthlySurplus` = $2,000. A
$1,000/month investment contribution and a $500/month personal retirement
contribution (both already paid out of that $8,000, never subtracted from the
$2,000) were then credited again in full — $1,500/month of invented wealth
growth, compounding every month of the forecast horizon.

### Is it a genuine defect?

**Yes — confirmed by fresh trace and reproduced with a worked numeric
example, not assumed from LR-FI-2's hypothesis alone.** The invariant this
violates is unambiguous: one dollar of economic cash enters projected wealth
once. `healthScore.ts:197-208` already states and implements the correct
distinction for the Savings Behaviour score — only the **employer** portion
of a retirement contribution is genuinely additive, because it was never
part of take-home pay and therefore never inside `monthlySurplus` to begin
with; personal retirement and investment contributions are funded from
income already reflected in the surplus, so adding them again double-counts
the same dollars. The Net Worth forecast did not apply this same distinction.

Discovery report §9 confirmed this is the **only** consumer in the codebase
that reproduces the defect — Retirement/Investment/Cross-border/Resilience/
Goal forecasts, Financial Twin, Reports and the AI context builder were each
traced to a definite negative result, not assumed clean by association.

### Intended correct behaviour (as implemented)

`monthlyAssetContribution` must be `monthlySurplus` net of the
household-funded contributions that are already paid out of it —
investment contributions and the **personal** half of retirement
contributions — while `monthlyInvestmentContribution` and
`monthlyRetirementContribution` (employer + personal, unchanged) continue to
grow their own buckets exactly as before, since that correctly reflects
*where* the money ends up; it must simply stop also being counted as leftover
cash in the assets bucket.

```ts
const householdFundedMonthlyContribution =
  dashboard.investmentAnnualContribution / 12 + dashboard.retirementPersonalMonthlyContribution;
...
monthlyAssetContribution: Math.max(0, dashboard.monthlySurplus - householdFundedMonthlyContribution),
monthlyInvestmentContribution: dashboard.investmentAnnualContribution / 12,       // unchanged
monthlyRetirementContribution: dashboard.retirementEmployerMonthlyContribution + dashboard.retirementPersonalMonthlyContribution, // unchanged
```

**Byte-identical for any household with no investment/personal-retirement
contributions**, since `householdFundedMonthlyContribution` is then `0` and
`Math.max(0, monthlySurplus - 0) === Math.max(0, monthlySurplus)`.

### Why a local fix, not a new `DashboardSummary` field

LR-FI-2 added `householdLiabilityBalance` and
`totalLiabilityMonthlyRepayments` to `DashboardSummary` because the corrected
figure was genuinely needed by **more than one** consumer (DTI and What-If
for the first; the Net Worth **and** Resilience forecasts for the second).
Here, discovery report §2/§9 traced every consumer and found exactly **one**
— the Net Worth forecast — needs this netted figure; the Resilience forecast
deliberately hard-codes `contributions: 0` for its investment/retirement
buckets and therefore never needs it (and must not be touched, since
discovery already proved it does not reproduce the defect). Every value the
fix depends on (`monthlySurplus`, `investmentAnnualContribution`,
`retirementPersonalMonthlyContribution`) already exists on `DashboardSummary`
and was already being read at this exact call site. Adding a new canonical
field for a single-consumer, one-line arithmetic combination of fields
already in hand would grow the public dashboard surface without a second
reader to justify it — the smaller, more consistent change is a local
`const` at the point of use, mirroring how `netWorthCalculator.ts` itself
already treats `monthlyAssetContribution`/`monthlyInvestmentContribution`/
`monthlyRetirementContribution` as forecast-input-shaped concerns, not
dashboard-shaped ones.

### What was deliberately NOT touched

- `dashboard.ts:599`'s `monthlySurplus` formula itself — untouched. The fix
  never "changes what surplus means"; it changes what a *forecast input*
  built from surplus subtracts before use.
- `monthlyInvestmentContribution`, `monthlyRetirementContribution` — both
  unchanged; they correctly keep growing their own buckets.
- `openingLiabilities`/`monthlyLoanRepayment` (LR-FI-2 §6c) — untouched.
- Retirement, Investment, Cross-border, Resilience, Goal, Debt forecasts —
  untouched; discovery proved none of them reproduce this defect, and the
  dispatch's mandate was this defect only.
- SMSF entity separation (LR-FI-1) and the DTI/DSR/debt-service
  classification (LR-FI-2) — untouched; verified byte-identical by re-running
  both existing suites unchanged (see verification record).
- Goal-contribution under-counting (discovery report §6b) — a real, disclosed
  gap, but the opposite direction of defect (under-, not double-counting) and
  explicitly out of this track's mandate. See Residual Findings below.

---

## Summary of decisions

| # | Item | Decision |
|---|---|---|
| 1 | Net Worth forecast double-counts investment + personal-retirement contributions against surplus | **Defect confirmed — fixed** in `lib/services/forecastData.ts`'s net_worth branch only |

## Residual findings — disclosed, deliberately not fixed

- **R1 — Goal-contribution invisibility to surplus and Net Worth (discovery
  report §6b).** A manual goal contribution (`user_goals.current_amount`,
  moved only via `app/api/goals/[id]/contributions/route.ts:46-49`) is never
  subtracted from `monthlySurplus` and never added to `dashboard.totalAssets`/
  `netWorth`. This is an **under-counting** gap — real cash committed to a
  goal is invisible to Net Worth — the mirror image of the double-count this
  track was dispatched to fix. Registered for a future track (a goal-linkage
  or unified-cash-flow-input redesign); not fixed here per the dispatch's
  explicit "double-counting only" mandate.
- **R2 — SMSF contribution-source discrimination (discovery report §5).** The
  SMSF schema (`smsf_funds`/`smsf_fund_members`/`smsf_holdings`) has no
  contribution column of any kind; an SMSF's own `retirement_accounts` row
  uses the same generic `employer_contribution`/`personal_contribution`
  columns as any other retirement account, with no way to distinguish
  employer/member/spouse/rollover source. This is a schema gap, not a
  calculation defect — nothing to fix at the calculation layer until a future
  track adds source-tagged columns, if ever decided.

## Scope guards observed

Only `lib/services/forecastData.ts` was edited (the net_worth branch's input
construction). No change to: `lib/engines/dashboard.ts`, `lib/engines/whatIf.ts`,
`lib/engines/reportSections.ts`, `lib/engines/householdContext.ts`,
`lib/engines/debtServiceContext.ts`, `lib/engines/forecast/netWorthCalculator.ts`,
`lib/engines/forecast/resilienceCalculator.ts`, `lib/engines/forecast/retirementCalculator.ts`,
`lib/engines/forecast/investmentCalculator.ts`, `lib/engines/forecast/goalCalculator.ts`,
`lib/engines/forecast/crossBorderCalculator.ts`, `lib/engines/forecast/debtCalculator.ts`,
or any `supabase/migrations/**` file. No migration; no schema change. Not
merged, not pushed, not applied to production — committed on this worktree's
own branch only, per the dispatch's explicit instruction.

---

## Appendix — verification record

*Added after implementation. Everything above this line was written and the
fix implemented before this section.*

**Changed files:** 1 production file (`lib/services/forecastData.ts`,
net_worth branch only — 1 new `const`, 1 re-pointed field, 2 unchanged
fields left in place for clarity of diff), 2 new test files (1 unit, 1
live-DEV), 2 new docs (this file and the discovery report). No migration. No
schema change. No other file under `lib/`, `app/` or `components/` touched.

| Check | Result |
|---|---|
| New LR-FI-3 unit suite (`tests/unit/lrFi3NetWorthContributionExactlyOnce.test.ts`) | **12/12 passed** — zero-return oracle + negative control, whole-household invariant (investment-only and mixed employer/personal/investment), employer-additive case, floor-at-zero, byte-identical-with-no-contributions regression guard, 12-month compounding proof, source-level wiring guard |
| LR-FI-1 SMSF isolation suite (`tests/unit/smsfHouseholdIsolation.test.ts`) | **40/40 passed — byte-identical** (this fix touches no file that suite exercises) |
| LR-FI-2 household debt-ratio suite (`tests/unit/lrFi2HouseholdDebtRatios.test.ts`) | **28/28 passed — byte-identical** |
| LR-FI-2 debt-service-exactly-once suite (`tests/unit/lrFi2DebtServiceExactlyOnce.test.ts`) | **22/22 passed — byte-identical** |
| `npx tsc --noEmit` | clean, exit 0 |
| ESLint on changed files (`forecastData.ts` + both new test files) | clean, exit 0, no warnings |
| `npx vitest run` — full unit regression, this worktree, quiet machine | **241 files passed / 10 failed, 5934 tests passed / 1 failed / 23 skipped** |
| `npm run build` | succeeded — full route manifest emitted, exit 0, re-confirmed on a second run |
| Live-DEV certification (`tests/live-dev/lrFi3NetWorthContributionLiveDev.test.ts`) | **6/6 passed**, cleanup + independent zero-residue re-verification passed (no thrown residue error) |

**The full-regression failure set matches the documented pre-existing
baseline exactly, not approximately.** The 10 failed files are: 9 that fail
at module-import time with `Error: supabaseUrl is required.` (or the
equivalent DEV-project-mismatch guard) because this worktree's `.env.local`
is not wired the way those particular files' own `loadEnv()` helpers expect
— `resourcesR1_1`, `resourcesR1_4LiveDev`, `resourcesPublicR1_5`,
`resourcesEditorR1_3`, `resourcesAdminR1_2`, `resourcesImportR1_7LiveDev`,
`resourcesDiscoveryR1_6LiveDev`, `resourcesAdminRoleCtaHotfixLiveDev`,
`resourcesP0ContentR1_7CLiveDev` — plus `tests/unit/aiResidualClosureFailClosed.test.ts`,
whose single failing assertion (`A4`, `expect(canonicalWrites(h).length).toBeGreaterThan(0)`
evaluating `0 > 0`) is the same standing pre-existing failure LR-FI-2's own
appendix recorded ("the one pre-existing regression-baseline failure").
**None of these ten touch `lib/services/forecastData.ts`, `lib/engines/dashboard.ts`,
or any forecast calculator** — confirmed by inspection, not merely by name.

**One transient failure was investigated, not waved away.** The very first
full-suite run in this session additionally reported
`tests/unit/g3RegistrationAlignment.test.ts` failing one test
("only four route files opt out of the generic block...") with
`Error: Test timed out in 5000ms.` — this is unrelated to this track by
subject matter (it walks `app/api` route files for a registration-alignment
drift guard; this fix never touches `app/api` or route registration) and was
confirmed to be a resource-contention artefact, not a regression: (1) run in
isolation immediately afterward, it passed 70/70 in 2.75s — nowhere near its
5000ms per-test timeout; (2) the full suite was re-run in full a second time,
after the background `npm install`/ESLint processes from earlier in this
session had finished, and it passed cleanly as part of the 241-file/5934-test
pass count above, with the failure set landing on exactly the 10
pre-existing files and no others. Both checks were run before this fix was
considered verified, not skipped.

**Live-DEV method.** Two synthetic households were created in the DEV
project (hard-guarded on project ref `vqycarelcoijzwlpkpcz`, refusing to run
against anything else, identical guard to `tests/live-dev/lrFi2HouseholdDebtRatiosLiveDev.test.ts`)
via real `income_sources`/`investments`/`retirement_accounts` inserts shaped
exactly as the live grid writes them, then read back through the real
`loadDashboard()` and the real, unmodified `runForecast()` entry point (the
same function `app/api/forecast/**` calls) for `forecast_type='net_worth'`,
persisting to real `forecast_runs`/`forecast_results` rows which were then
read back and checked against a hand-derived oracle:

- **E (investment-contribution case)** — $10,000 salary, $6,000 essential
  expenses, $12,000/yr ($1,000/mo) investment contribution, no retirement.
  `loadDashboard()` returned `monthlySurplus=4000`,
  `investmentAnnualContribution=12000`, matching the oracle. The pre-fix
  formula, reconstructed against these SAME real figures (via the pure
  `runNetWorthForecast()` calculator, never by editing production code),
  produces a total credited contribution of **$5,000**. The real, currently
  deployed `runForecast()` persisted **$4,000** — `monthlySurplus` exactly,
  confirming the fix live, not merely in the unit suite.
- **F (mixed employer+personal retirement + investment case)** — $10,000
  salary, $6,000 essential expenses, $6,000/yr ($500/mo) investment
  contribution, $300/mo employer + $700/mo personal retirement contribution.
  `loadDashboard()` returned `monthlySurplus=4000`,
  `retirementEmployerMonthlyContribution=300`,
  `retirementPersonalMonthlyContribution=700`, matching the oracle. The
  reconstructed pre-fix formula produces **$5,500**. The real deployed
  `runForecast()` persisted **$4,300** — exactly `monthlySurplus` plus the
  employer contribution, proving on live data that the employer portion
  stays additive while the investment and personal-retirement portions are
  correctly netted out.

Both synthetic users and every row/run/result they produced
(`income_sources`, `investments`, `retirement_accounts`, `financial_snapshots`,
`forecast_profiles`, `forecast_scenarios`, `forecast_runs`,
`forecast_explanations`, `forecast_results`, `user_profiles`, the two
`auth.users` rows) were deleted in the suite's own `afterAll`, and an
independent zero-residue re-check (a `select count` against every written
table plus an `auth.admin.getUserById` check, each throwing on any nonzero
result) passed with no residue found.
