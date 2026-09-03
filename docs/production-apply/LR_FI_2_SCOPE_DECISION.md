# LR-FI-2 — Scope Decision Document

**Status:** discovery complete, decisions recorded BEFORE implementation.
**Base:** `origin/main` @ `8e21835` (fetched and verified, not assumed).
**Branch:** `feature/lr-fi-2-smsf-dti-cashflow`.
**Predecessor:** LR-FI-1 (`3fa1400` + `bd45308`) — merged, closed, production-certified.

LR-FI-1 established `lib/engines/householdContext.ts` as the canonical
household/SMSF discriminator and applied it to household **operating cash
flow** only, deliberately leaving **wealth** (assets, investments, retirement
balances, liability balances, Net Worth) whole (LR-FI-1 §5, §28).

LR-FI-2 carries six items deferred from that work. This document records, for
each, **what the current behaviour actually is**, **whether it is a genuine
defect**, and **the intended correct behaviour** — decided from traced code,
before any fix was written.

The organising finding of this pass is stated once here because four of the six
items turn on it:

> LR-FI-1 correctly filtered household **cash flow** and correctly left
> **wealth** whole. Every genuine defect found in LR-FI-2 is a place where a
> *filtered cash-flow figure* and an *unfiltered wealth figure* are combined
> into a single ratio or projection. The fix is never "filter more" — it is
> "make both sides of the expression agree on which entity they describe."

---

## Item 1 — SMSF debt exclusion from personal DTI

### What the current behaviour actually is

`lib/engines/dashboard.ts:685`:

```ts
const debtToIncome = annualGrossIncome > 0 ? totalLiabilities / annualGrossIncome : null;
```

- `totalLiabilities` (line 637) sums `input.liabilities` — **unfiltered**, SMSF
  included. Correct for Net Worth, which is its primary purpose.
- `annualGrossIncome` (line 684) derives from `grossMonthlyIncome` (line 505),
  which LR-FI-1 made **household-only** — SMSF income excluded.

So today's DTI is:

```
(personal debt + SMSF debt) / (personal income only)
```

The only other DTI computation in the codebase is `lib/engines/whatIf.ts:34`,
which re-derives the identical expression after a scenario mutation.
`lib/engines/twin/metricDerivation.ts:132` and `lib/engines/reportSections.ts:111`
consume `d.debtToIncome` as a pass-through.

### Is it a genuine defect?

**Yes — confirmed, and the reasoning does not rest on the Product Owner's
ruling alone.**

The task correctly asked whether the PO's ruling — framed around debt
*service* — transfers cleanly to a *balance-based* ratio, and warned against
mechanically copying the DSR fix. It does transfer, for a reason that is
independent of and stronger than the analogy:

1. **The ratio is internally incoherent regardless of which convention you
   prefer.** A ratio whose numerator spans two economic entities and whose
   denominator spans one is not a definition anyone holds. It must be either
   `(personal+SMSF)/(personal+SMSF)` or `personal/personal`. Since LR-FI-1
   certified the denominator as personal-only, the numerator must follow.
   There is no third coherent option that leaves the code as it stands.

2. **LR-FI-1 made DTI actively worse for SMSF households, not merely
   unimproved.** Before LR-FI-1 the ratio was contaminated on both sides and
   partially self-cancelling. After LR-FI-1 the denominator shrank while the
   numerator did not, so a household with an SMSF now reports a *higher* DTI
   than before the P0 fix. This is a real regression-in-effect that LR-FI-1
   knowingly deferred here, not a pre-existing quirk.

3. **The economics agree.** An SMSF borrowing arrangement is limited-recourse:
   the lender's recourse is to the fund asset, not the member personally. It
   is not personal household debt. The PO's ruling anticipated the exception
   (a personal guarantee) and required it be **explicit, not inferred** — so
   the default must be exclusion, and no inference mechanism is added here.

**Measured effect** (from the existing `mixed` fixture in
`tests/unit/smsfHouseholdIsolation.test.ts:405`): liabilities 765,000 over
gross income 192,000/yr = **3.98x → "caution"**. Household-only:
400,000 / 192,000 = **2.08x → "good"**. A user-visible benchmark-band flip, not
a rounding difference.

### Intended correct behaviour

DTI numerator becomes household-scoped, using the **same** canonical filter
(`isHouseholdOperatingCashFlow`), never a parallel mechanism:

- Add `householdLiabilityBalance` to `DashboardSummary` — household-owned
  liability balances in reporting currency.
- `debtToIncome = householdLiabilityBalance / annualGrossIncome`.
- `totalLiabilities`, `netWorth`, `liabilityByType`, `goodDebt`, `badDebt`,
  `averageInterestRate`, `variableRateDebtRatio`, `creditUtilization` and
  `liabilitiesWithPayoff` are **left whole** — they are wealth/composition
  figures governed by LR-FI-1 §28.
- The **gross**-income basis is retained. DTI's gross basis is a separate,
  standing PO decision and is explicitly *not* being conflated with DSR's net
  basis.

Two consistency obligations follow, and are in scope because without them the
fix silently reverts:

- `lib/engines/whatIf.ts:34` must use the household figure, or every What-If
  scenario would recompute the old unfiltered DTI over the top of it.
  `pay_off_debt` must also maintain the new field. While there, its
  `debtMonthlyRepayments` scaling is corrected to use the **household**
  proportion — today it scales a household-only repayment by a proportion
  derived from unfiltered debt, another LR-FI-1-derived mismatch. Both changes
  are byte-identical for any household with no SMSF rows.
- `lib/engines/reportSections.ts:108` computes the *previous* period's DTI from
  `financial_snapshots`: `prev.total_liabilities / (prev.monthly_income * 12)`.
  `dashboard.ts` writes those columns as unfiltered `totalLiabilities` and
  household-only `grossMonthlyIncome` (`lib/services/dashboardData.ts:176-179`),
  so the stored history carries the same mixed basis. Comparing a corrected
  current DTI against a mixed-basis previous DTI would publish a fabricated
  "your debt improved" movement in a financial report. Storing a household
  figure would require a schema change, which is out of scope by instruction,
  so the honest resolution is to report the movement as **unavailable** for the
  only households affected — those actually holding SMSF liabilities. Every
  other household is unchanged.

---

## Item 2 — Loan principal vs interest vs fees treatment

### What the current behaviour actually is

The **full instalment** is the household cash-flow figure, everywhere, exactly
once. There is no principal/interest split anywhere in the household layer.

- `dashboard.ts:592` — `debtMonthlyRepayments` sums `monthly_repayment` whole.
- `dashboard.ts:584` — `totalMonthlyExpenses` deliberately **excludes** debt
  repayments (tracked separately), so the instalment cannot be counted in both.
- `dashboard.ts:595` — `monthlySurplus = income − totalMonthlyExpenses −
  debtMonthlyRepayments`; subtracted exactly once.
- `dashboard.ts:553-568` — the only de-duplication guard in the household
  layer, suppressing an `expense_items` debt-repayment row when a matching
  liability already carries the repayment.

**Consumers are consistent, not divergent:**

- **Reports** re-aggregate nothing. `reportSections.ts:144-156` and `:240-241`
  pass `d.totalMonthlyExpenses` / `d.debtMonthlyRepayments` through verbatim.
  `reportSectionsPremium.ts` never references them at all; its only liability
  contact is a raw appendix row listing.
- **Forecasting** splits principal from interest, but from a *rate* formula for
  *balance projection*, never for household cash flow
  (`forecast/monthlyPrimitives.ts:79-94`). Its output lands in
  `forecast_results`, not in any household expense figure.
- **FDH-10** has a genuine statement-disclosed decomposition engine,
  `lib/financial-data-hub/liability/repaymentDecomposition.ts:96`
  (`decomposeLoanPayment`), whose contract is `expenseTotal = interest + fees`,
  `liabilityReductionTotal = principal` — the textbook-correct treatment. I
  verified by repo-wide grep that it has **zero production consumers**: every
  reference outside its own file is a test or a comment. This matches the
  module's own disclosure in `docs/financial-data-hub/FDH10_COMPLETION_REPORT.md:40`.

### Is it a genuine defect?

**No. No change required.**

The accounting-purist position — that only interest and fees are consumption,
and principal is a balance-sheet transfer — is a real position, and FDH-10 has
already built the engine that implements it. But treating the full instalment
as a household outflow is **not** an error here, for three reasons:

1. **It is an explicit standing Product Owner decision**, recorded when the
   50-scenario test package proposed the opposite: *"Monthly_Surplus_or_Deficit:
   app = netIncome − totalMonthlyExpenses − debtMonthlyRepayments (debt
   repayments ARE subtracted as an outflow) ... Confirmed correct: include debt
   repayment."* Reversing it silently would overturn a PO ruling under cover of
   a bug fix.
2. **It is internally consistent**, which is what the item asked me to
   determine. There is no Dashboard-vs-Reports-vs-Forecasting divergence: one
   hub computes it, everyone else passes it through.
3. **It is not double-counted.** The instalment appears in
   `debtMonthlyRepayments` and is explicitly excluded from
   `totalMonthlyExpenses`; the guard at `:553-568` prevents the manual-expense
   variant for the covered item types.

Wiring FDH-10's decomposition into household cash flow would change Monthly
Surplus, Savings Rate and DSR for **every borrower in the product**, and would
require crossing the FDH-1 isolation boundary that forbids `lib/engines/**`
from importing FDH code. That is a product decision, not a defect fix.

**Disclosed, not fixed** (see Residual Findings R1).

---

## Item 3 — Personal DSR/DTI correctness beyond the SMSF question

### What the current behaviour actually is

- **DSR** (`dashboard.ts:691`) = `debtMonthlyRepayments / incomeForSurplus`.
  Both sides household-only post-LR-FI-1. **Already coherent.** Net-income
  basis is a deliberate, documented, PO-confirmed choice.
- **DTI** — incoherent until Item 1 lands.
- No double-count found between the two: DSR reads a flow, DTI reads a balance.

### Is it a genuine defect?

**No further defect beyond Item 1.** Verified by construction rather than
assertion: four representative archetypes (personal-only, joint, SMSF-holding,
mixed AU/India cross-currency) are each computed against an independently
hand-derived oracle, with the SMSF variants additionally proved equal to an
SMSF-free control and unequal to an SMSF-retagged-personal negative control.

---

## Item 4 — Imported loan-payment matching / double-counting

### What the current behaviour actually is

**The defect described cannot occur. It is architecturally impossible, not
merely absent.** I verified each link myself rather than relying on the module's
own documentation:

1. **No import path writes `expense_items`.** Repo-wide grep for
   `from('expense_items')` / `'expense_items'` across `lib/`, `app/`,
   `components/`, `scripts/` returns reads only, plus exactly two writers —
   `app/api/expenses/route.ts:5` and `app/api/expenses/[id]/route.ts:5`, both
   the generic user-facing CRUD grid — and one test-seed script.
2. **The FDH module is forbidden from touching it.** `expense_items` is listed
   in `FHIP_PROTECTED_INPUT_TABLES`
   (`lib/financial-data-hub/constants/tables.ts:182`).
3. **That prohibition is enforced, not merely documented** — by a test that
   greps the real source tree (`tests/unit/fdh1Isolation.test.ts:298-321`) and,
   independently, by database triggers (migration 0091).
4. **Imported transactions live only in `fdh_transactions`**, which
   `computeDashboard()` never reads. There is no promotion or materialisation
   path to `expense_items`.
5. **The one import path that does reach household cash flow** — the
   liability-statement import proposing a value for `liabilities.monthly_repayment`
   (`lib/import-bridge/adapters/liabilityAdapter.ts:300-308`) — **overwrites a
   single canonical column** after user confirmation. It updates the existing
   figure rather than adding a second one, so it cannot duplicate.

### Is it a genuine defect?

**No. No change required. The defect does not reproduce on current
`origin/main`.**

The historical memory entry that motivated this item ("debt double-counting in
Monthly Surplus/DSR") is best matched by the *manual-entry* double-count that
`dashboard.ts:515-548` documents at length and **already fixes** — a "Mortgage"
expense row coexisting with a home-loan liability. That is the same economic
symptom the Free-Report reviewer described, reached by a different route, and
it is closed.

Per the task's own instruction, I am reporting this plainly rather than
inventing a fix for a defect that is not there. The certified
exactly-one-valuation-source rule is left untouched.

**Disclosed, not fixed** (see Residual Findings R2 — a real but *manual-path*
double-count gap in the existing guard's coverage).

---

## Item 5 — Contribution/transfer semantics

### What the current behaviour actually is

Retirement and investment contributions live in their **own registers**
(`retirement_accounts`, `investments`), not in `expense_items`. They are
computed at `dashboard.ts:775-789` — **190 lines after** `monthlySurplus` is
finalised — and never appear in any of `totalMonthlyExpenses` (`:584`),
`monthlySurplus` (`:595`), `savingsRate` (`:596`) or `debtServiceRatio`
(`:691`).

The semantic position this produces is exactly the one LR-FI-1 §11 asked for: a
household that salary-sacrifices $2,000/month has that $2,000 counted as
**surplus (unconsumed)**, not as consumption.

The catalogue reinforces it: no `super`, `superannuation`, `nps`, `ppf`, `epf`,
`sip` or `*_contribution` item exists under the `expense` category anywhere in
`supabase/seed_master_items.sql`. Contribution flows are seeded under the
`retirement` category, labelled to disambiguate
(`'Employer Contributions (contribution amount, not a balance)'`).

The one place the distinction genuinely bites is guarded, correctly, in
`lib/engines/healthScore.ts:197-208`: only the **employer** portion is added to
`totalSavingsRate`, because personal and investment contributions are funded
from the same net income already inside `monthlySurplus`. Adding them again
would double-count the same dollars — and the code says so.

### Is it a genuine defect?

**No. No change required.** Contributions are not miscategorised as consumption
in any way that distorts surplus, savings rate or DSR — which is precisely the
question this item scoped.

Two adjacent findings surfaced and are **disclosed rather than fixed**, because
both change figures for *ordinary non-SMSF households*, neither involves the
household/SMSF separation that is LR-FI-2's subject, and the task explicitly
bounded this item ("do not redesign the entire contribution engine") and warned
against forcing fixes. See Residual Findings R3 and R4.

---

## Item 6 — `forecastData.ts` direct repayment paths

LR-FI-1 disclosed that `foreignLiabilityMonthlyRepayment` and the debt /
investment forecasts read `monthly_repayment` / `annual_contribution` directly,
bypassing the household-context hub, and asked whether this reproduces the
LR-FI-1 P0 in Forecasting. Investigated per path; the answer differs per path,
so they are decided separately rather than as a block.

### 6a. Cross-border forecast — **not a defect**

`lib/services/forecastData.ts:426-430` selects foreign-currency liabilities with
no `owner` filter; `:454` sums their full instalments into
`foreignLiabilityMonthlyRepayment`.

The determining question is what the figure is *used for*, and
`lib/engines/forecast/crossBorderCalculator.ts` answers it unambiguously: the
run is a **net foreign wealth** projection — *"Net foreign wealth (assets +
investments + retirement − liabilities, in {currency})"* (`:145`), emitting
`income: 0` and `expenses: 0` (`:113-114`). `monthlyForeignLoanRepayment`
enters only `projectLoanMonth` (`:80-84`) as the **amortisation input that
reduces a balance**.

That is the wealth path, where LR-FI-1 §5/§28 requires SMSF value to **remain**.
Filtering it would freeze the SMSF loan balance at its opening value forever,
overstating the liability and understating foreign net worth every month —
strictly worse than today. It is the same treatment `dashboard.ts:692-696`
already applies, correctly, to `liabilitiesWithPayoff`.

The AU-only concern the task raised is real but does not change the answer: an
India-resident member of an Australian SMSF (a core cross-border demographic for
this product) *would* have an AUD-denominated SMSF loan picked up here. On
investigation that inclusion is correct, not contaminating.

The same reasoning covers the unfiltered `annual_contribution` reads at `:420`
and `:789` — they grow wealth balances.

### 6b. Debt forecast — **not a defect**

`forecastData.ts:658-662` reads all liabilities without `owner`.
`debtCalculator.ts` emits **per-liability** rows (`entityType: 'liability'`),
each projecting a liability's own balance with that liability's own repayment.
Every row is internally self-consistent; there is no household aggregate to
contaminate. Whether an SMSF loan should *appear* in a personal debt-payoff
planner is a presentation-scope question the PO ruling does not reach, and
silently dropping a real liability from the user's payoff view would be its own
harm. Disclosed as R5.

### 6c. Net-worth and resilience forecasts — **DEFECT CONFIRMED**

This is the genuine Forecasting defect, and it is the mirror image of the one
that was being looked for. Not SMSF contaminating household cash flow — a
household-filtered cash flow being applied to unfiltered wealth:

| Input | Source | Scope |
|---|---|---|
| `openingLiabilities` | `dashboard.totalLiabilities` | **unfiltered** (incl. SMSF) |
| `monthlyLoanRepayment` | `dashboard.debtMonthlyRepayments` | **household-only** (post-LR-FI-1) |

- Net worth: `forecastData.ts:819` + `:829`
- Resilience: `forecastData.ts:400` + `:406`

In both calculators `monthlyLoanRepayment` feeds **only** `projectLoanMonth`
against `openingLiabilities` (`netWorthCalculator.ts:103-106`,
`resilienceCalculator.ts:90-93`). The household cash-flow leg is carried
separately by `monthlySurplus`, so this input is purely a balance-amortisation
term — and it is now too small for the balance it is amortising.

**This is a live regression introduced by LR-FI-1**, and it is severe rather
than marginal, because `projectLoanMonth` computes
`principalReduction = repayment − interest`. Worked example — personal mortgage
400,000 @ 3,000/month plus an SMSF loan 365,000 @ 2,000/month, at the default
6% blended liability rate:

- Opening balance 765,000 → monthly interest 3,825.
- Repayment supplied: **3,000** (household only).
- `principalReduction = 3,000 − 3,825 = −825` → **the balance grows every
  month, forever.**
- Correct total repayment 5,000 → `principalReduction = +1,175` → debt falls.

The household's Net Worth Forecast and Resilience projection therefore show
debt compounding upward and net worth eroding indefinitely, for a household
that is in fact servicing its loans normally.

### Intended correct behaviour

Pair like with like. `openingLiabilities` is a **whole-balance-sheet** figure by
LR-FI-1 §28 and must stay whole; therefore the repayment amortising it must
also be whole:

- Add `totalLiabilityMonthlyRepayments` to `DashboardSummary` — **all** owners,
  reporting-currency converted, sitting alongside the household-only
  `debtMonthlyRepayments` rather than replacing it.
- Use it for `monthlyLoanRepayment` in the net-worth and resilience forecast
  inputs only.
- `debtMonthlyRepayments` keeps its household-only meaning everywhere it
  expresses household cash flow (DSR, surplus, disposable income) — untouched.

This restores exactly the pre-LR-FI-1 behaviour of both forecasts and is
**byte-identical** for any household with no SMSF rows, since the two figures
are then equal by construction.

---

## Summary of decisions

| # | Item | Decision |
|---|---|---|
| 1 | SMSF debt in personal DTI | **Defect confirmed — fix** (+ What-If and report-movement consistency) |
| 2 | Principal / interest / fees | **No change required** — correct, consistent, PO-ratified |
| 3 | DSR/DTI correctness beyond SMSF | **No further defect** — proven by archetype oracles |
| 4 | Imported loan-payment double-count | **Does not reproduce** — architecturally impossible; no change |
| 5 | Contribution / transfer semantics | **No change required** — contributions are not consumption |
| 6 | `forecastData.ts` repayment paths | **6a/6b no change; 6c defect confirmed — fix** |

## Residual findings — disclosed, deliberately not fixed

Each is real, evidenced, and outside LR-FI-2's authorised scope. None is a
blocker for the items above; all are recorded for Product Owner decision.

- **R1 — Accounting treatment of loan principal (Item 2).** FDH-10's
  `decomposeLoanPayment` implements the purist treatment
  (`expenseTotal = interest + fees`) and is production-ready but unwired.
  Adopting it would change Monthly Surplus / Savings Rate / DSR for every
  borrower and would require crossing the FDH-1 isolation boundary. Product
  decision; reverses a standing PO ruling.

- **R2 — Debt-repayment de-duplication covered only two item types.**
  **REOPENED AND ADDRESSED by Product Owner direction — see the
  "R2 closure" section below.**

- **R3 — Two savings-shaped expense master items (Item 5).**
  `holiday_savings` (`supabase/seed_master_items.sql:72`) and
  `emergency_fund_saving` (`:101`) are transfers, not consumption. A user
  recording them as expense rows depresses Monthly Surplus and Savings Rate. No
  code special-cases them (grep across `lib/`, `app/`, `components/`: zero
  hits). Affects ordinary non-SMSF households; needs a PO ruling.

- **R4 — Net-worth forecast contribution overlap (Item 5). NOW TRACKED AS
  LR-FI-3 — "Contribution, Savings & Net-Worth Forecast Exactly-Once
  Integrity".** The Product Owner accepted this as correctly deferred and
  registered it as its own track, to be dispatched separately after LR-FI-2
  closes. It is **explicitly out of scope for this branch and is not fixed
  here** — recorded, not silently dropped. Detail retained below for that
  dispatch.
  `forecastData.ts:826-828` passes `monthlyAssetContribution =
  max(0, monthlySurplus)` *and* the investment and personal-retirement
  contributions. Because `monthlySurplus` never subtracts those contributions,
  the same dollars accrete twice in the net-worth projection. Only the
  *employer* portion is legitimately additive — the exact distinction
  `healthScore.ts:202-207` gets right. The adjacent comment
  (`forecastData.ts:820-825`) says "any *remaining* monthly surplus" but the
  code passes the whole surplus, so the comment describes an intent the code
  does not implement. Independent of SMSF; affects every contributing
  household. Explicitly outside this task's "do not redesign the contribution
  engine" bound.

- **R5 — SMSF loans appear in the personal debt-payoff planner (Item 6b).**
  Arithmetically correct per-liability; a presentation-scope question the PO
  ruling does not reach.

- **R6 — Historical DTI comparison basis.** `financial_snapshots` stores
  unfiltered `total_liabilities` alongside household-only `monthly_income`, so
  no stored history supports a household-scoped DTI. Correcting it needs a
  schema change, which is out of scope by instruction. Mitigated here by
  reporting the movement as unavailable for SMSF-holding households rather than
  publishing a wrong one.

## Appendix — verification record

*Added after implementation. Everything above this line was written and fixed
before any production file was edited.*

**Changed files (5), plus 2 new test files and this document.** Substantive
(non-comment) change is 2 new `DashboardSummary` fields, 1 re-pointed DTI
expression, 1 extracted report helper, the What-If consistency edit, and the 2
forecast wirings. No migration. No schema change.

| Check | Result |
|---|---|
| RED before GREEN (new unit suite) | 25 failed / 3 passed → **28/28 passed** |
| LR-FI-1 SMSF isolation suite | **40/40 passed** (see supersession note below) |
| Full unit regression, pristine `8e21835` baseline | 1 failed / 5747 passed / 18 skipped; 10 files failed |
| Full unit regression, after fix | 1 failed / 5776 passed / 18 skipped; 10 files failed |
| Net effect | **failure set byte-identical** — +29 passing tests, zero regressions |
| `tsc --noEmit` | clean |
| ESLint on changed files | clean (11 repo-wide errors are pre-existing, in files this task never touched) |
| `next build` | succeeded |
| Live-DEV certification | **6/6 passed** |
| DEV residue after cleanup | **0 rows, 0 auth users**, re-verified by an independent probe |

**The one pre-existing regression-baseline failure** is
`tests/unit/aiResidualClosureFailClosed.test.ts > A4`, present identically
before and after. The 9 failing `resources*` files fail only because
`.env.local` is absent (`Error: supabaseUrl is required.`) and are likewise
identical before and after.

**One LR-FI-1 assertion was deliberately superseded.**
`tests/unit/smsfHouseholdIsolation.test.ts:287` asserted
`fixed.debtToIncome === preFix.debtToIncome` inside "leaves every balance-sheet
total identical to the pre-fix behaviour". That assertion encoded LR-FI-1's
*deferral* of DTI, which is precisely what the Product Owner's ruling reopened.
It is **replaced, not deleted** — by a positive test asserting that DTI is now
household-scoped *and* that every genuine wealth total still matches — so the
coverage is inverted and kept rather than lost. No other LR-FI-1 assertion was
touched.

**Live-DEV method.** Three synthetic households were created in the DEV project
(hard-guarded on project ref `vqycarelcoijzwlpkpcz`, refusing to run against
anything else) and read back through `loadDashboard()` — the real production
read path, not a hand-built input. This is what proves the `owner` column
actually survives the SELECT: `computeDashboard()` treats a missing owner as
household context, so a SELECT that dropped it would leave every unit test
green while the live product silently reverted. Scenarios: A personal-only,
B personal + SMSF loan correctly tagged, C the identical rows retagged `self`.
B matched A exactly on DTI/DSR/surplus, differed from A on Net Worth, and
differed from C on DTI (4.17x "caution" vs 7.97x "risk" — a live benchmark-band
flip) while holding an identical balance sheet to C. The §6c defect was also
reproduced on the live figures: the pre-fix pairing projects the debt balance
*rising* over 12 months, the corrected pairing projects it falling.

## R2 closure — debt service counted exactly once

*Added on Product Owner direction after the first FULL PASS report, which
reopened R2 as a required gate. The SMSF DTI and forecast corrections above are
untouched by this section.*

### Why the guard was family-specific (the required trace, done first)

It was **not** an incomplete classification. `supabase/seed_master_items.sql`
seeds exactly two expense-category items that denote a debt REPAYMENT:

```
('expense', 'mortgage',            'Mortgage',            10)
('expense', 'car_loan_repayments', 'Car Loan Repayments', 460)
```

There is no `personal_loan_repayments`, no `credit_card_repayment`, and no
education/business/tax equivalent. The old guard already covered **100% of the
catalogue's repayment items**. It looked family-specific only because the
*catalogue* is. Adding `personal_loan` or `credit_card` as keys of the
expense→liability map would have mapped expense items no user can ever hold —
exactly the "adding category strings blindly" the direction warned against.

A keyword sweep of all 70 expense items confirms the only other debt-related
ones are `loan_interest`, `credit_card_fees` and `bank_fees` — which are debt
**cost**, not repayment, and must never be suppressed.

### What was actually built

`lib/engines/debtServiceContext.ts` — one canonical debt-service classification
for the household layer, replacing three ad-hoc `Set`s previously spread across
`dashboard.ts` and `twin/metricDerivation.ts`:

- **`DebtFamily`** — nine families covering all 25 catalogued liability items.
  Matching is now by family, so the guard can never let a car loan suppress a
  mortgage expense, and *does* now match families the old two-`Set` guard
  silently missed (`commercial_loan`, `mortgage_offset_facility`,
  `smsf_property_loan`). Those previously double-counted a genuine "Mortgage"
  expense row — a real fix, proven by test.
- **`DebtServiceClass`** — `instalment` vs `revolving`, mirroring the Financial
  Data Hub's Product-Owner-scrutinised FDH-10 economics (PURCHASE → expense,
  PAYMENT → transfer, never expense).
- **`DEBT_COST_EXPENSE_ITEMS`** — `loan_interest`, `credit_card_fees`,
  `bank_fees` are checked FIRST and can never be suppressed, with a test
  asserting they stay disjoint from the repayment map. This is a deliberate
  trap-guard: `credit_card_fees` is the nearest-looking item a future
  "extend the guard to credit cards" edit would reach for, and suppressing it
  would delete a real expense.

It is **mirrored, not imported**: `tests/unit/fdh1Isolation.test.ts` enforces a
bidirectional boundary and scans `lib/`, `app/`, `components/` for the Hub's
directory name as a plain substring. An import genuinely fails that certified
test — as did merely *naming the path in a comment*, which the isolation suite
caught during this work. Conformance is proven by source-level assertion.

### The control table, executed

`tests/unit/lrFi2DebtServiceExactlyOnce.test.ts` encodes the Product Owner's
nine required scenarios verbatim as `describe` blocks. 21 assertions, all
passing, each with a negative control.

| # | Scenario | Status |
|---|---|---|
| 1 | Personal-loan repayment only → debt service once | **PASS** |
| 2 | Same repayment also an Expense → no double count | **PASS** (declared rows); one reachable sub-case open, below |
| 3 | Card purchases in Expenses + balance repayment | **PASS** — purchases identical with and without the card |
| 4 | Credit-card interest → expense once | **PASS** |
| 5 | Credit-card fee → expense once | **PASS** |
| 6 | Card principal/balance repayment → not ordinary Expense | **PASS** |
| 7 | Personal-loan interest/fee → expense once | **PASS** |
| 8 | DSR → required debt service once | **PASS** |
| 9 | SMSF liability still out of personal DSR/DTI | **PASS** |

### The one reachable case that remains open, and why no code can close it

Row 2 has a sub-case that **no calculation-layer change can reach**, and it is
pinned by a deliberately-passing test rather than left undocumented:

A user clicking **"+ Add Custom Item"** in the Expenses grid and typing
"Personal loan repayment" produces a row with `master_item_key = null` **and**
`expense_category = 'other'` — the grid exposes no category field
(`lib/grid/configs.ts:36-41`), and the catalogue has no repayment item to tick.
The row therefore carries **no signal whatsoever** that it is debt service.
The existing `expense_category='debt_repayment'` fallback is real and works,
but is reachable only via the API or direct PostgREST — not through the live UI.

The only non-fragile fix is to **add the missing catalogue items** (e.g.
`personal_loan_repayments`, `credit_card_repayment`), which the new
family-keyed map would then pick up with a one-line addition each. That is a
seed/data change requiring a migration, which this task's own terms forbid
allocating without authorisation — so it is escalated rather than done.

The rejected alternative is name-matching the free-typed label, which would
silently delete genuine expenses on a substring coincidence.

### Deliberately NOT changed, and why

Excluding revolving-credit repayments from the household **cash-outflow** term
(as distinct from the debt-service term) was considered and rejected for this
branch. It would touch 15+ consumers — report narrative text, the cash-flow
waterfall chart, `financial_snapshots`, Twin metrics, Resilience obligations,
Health Score — reverse the standing "surplus includes debt repayment" ruling
for one debt class, and, critically, **cannot separate a card's interest from
its principal without the repayment decomposition this same direction accepted
as staying unused**. Excluding the whole payment would drop genuine interest
from expenses; including it counts principal twice. That trade-off is a product
ruling, not an engineering choice, and is recorded for LR-FI-3's consideration.

## Scope guards observed

No change is made to: LR-FI-1's SMSF cash-flow exclusion logic; R6/F1/F2
tax-lot/FIFO (Investment Intelligence); UI/UX/navigation (II-PC2);
Company/Family Trust entity semantics; tax law; the forecasting engine's
design; G3, Wave 5, or any Admin surface. No migration is created — every
change is calculation-layer.
