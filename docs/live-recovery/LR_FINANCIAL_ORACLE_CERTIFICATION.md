# LR Financial Oracle Certification

**Date:** 2026-09-14 · **Baseline:** `origin/main` @ `ff35f54`
**Method:** every oracle below was executed against the **real DEV Supabase database** using the **real production engines** (`lib/services/dashboardData.ts` → `lib/engines/dashboard.ts`, `lib/services/forecastData.ts`, `lib/services/twinData.ts`) imported directly, not mocked. Every synthetic user was deleted afterwards.

Scripts: `scripts/audit-lr/oracle1_smsf_dsr_networth.ts`, `oracle2_smsf_networth_double_subtraction.ts`, `oracle3_twin_vs_dashboard.ts`, `oracle4_forecast_exactly_once.ts`, `oracle5_smsf_0137_regression.ts`, `oracle8_insurance_and_janitor.ts`.

---

## 1. §7.3 — The Product Owner's mandatory DSR oracle

**Fixture:** monthly personal income 10,000 (gross = net); personal debt service 1,000/mo on a 20,000 balance; SMSF-linked loan service 2,000/mo on a 365,000 balance.

### S1 — the loan is linked via `property_liability_links` only (owner is `self`, NOT tagged `smsf`)

| Assertion | Expected | Actual | Result |
|---|---|---|---|
| `debtServiceRatio` | 0.10 | **0.10** | **PASS** |
| `debtMonthlyRepayments` | 1,000 | 1,000 | PASS |
| `debtToIncome` | 20,000 / 120,000 = 0.1667 | **0.1667** | **PASS** |
| `householdLiabilityBalance` | 20,000 | 20,000 | PASS |
| `totalLiabilities` (whole balance sheet, deliberately unfiltered) | 385,000 | 385,000 | PASS |
| `monthlySurplus` | 9,000 | 9,000 | **PASS** |

**The 30% → 10% correction is real and holds on `origin/main`.** The canonical path applies the override at `lib/services/dashboardData.ts:286-287` via `applySmsfPropertyLoanLinkOverride()`, then the single filter `row.owner !== 'smsf'` (`lib/engines/householdContext.ts:69-71`) does the rest.

### S2 — the loan carries `owner='smsf'` directly, with no property link

| Assertion | Expected | Actual | Result |
|---|---|---|---|
| `debtServiceRatio` | 0.10 | **0.10** | **PASS** |

The two discriminators combine as **OR**, which is correct. Both paths independently produce 10%.

### S4 — control household, no SMSF at all

| Assertion | Expected | Actual | Result |
|---|---|---|---|
| `debtServiceRatio` | 0.10 | 0.10 | PASS |
| `householdLiabilityBalance === totalLiabilities` | true | true | PASS |

The control proves the SMSF filter is not silently discarding ordinary rows.

### Net Worth invariance under a cash-flow-context-only change

`totalLiabilities` is 385,000 in both S1 and S2 and is the value Net Worth subtracts. Net Worth is therefore unchanged by the DTI/DSR context change, as §7.3 requires.

---

## 2. §7.1 — Consolidated financial taxonomy

| Invariant | Result | Evidence |
|---|---|---|
| Gross Assets = personal assets + investments + retirement + ownership-scaled entity value, once | **PASS** | `dashboard.ts:771-781`; T2 verified 100,000 + 50% × (400,000 − 100,000) = **250,000** |
| Goals do not add to Net Worth | PASS | `user_goals` never enters `netWorth` |
| Insurance cover does not add to Net Worth | PASS | insurance contributes only `totalAnnualPremium` |
| Future contributions do not add to current Net Worth | PASS | contributions enter only the forecast input |
| SMSF member balances non-additive on top of holdings | PASS | `smsf_fund_members` never read by any Net Worth path; `0084:221-226` |
| Company/Trust underlying assets do not add on top of ownership-scaled NAV | **PASS (structural)** | `business_entity_assets`/`_liabilities` are read only by `businessEntityData.ts` and netted inside `businessEntityValuation.ts:52-63` |
| **SMSF liabilities are not double-subtracted** | **FAIL — P0-1** | See §3 |
| Legacy Company/Trust owner tags cannot double-count entity value | **FAIL — P2-5** | `owner='company'` rows remain in personal cash flow and DTI/DSR by explicit deferral (`householdContext.ts:60-65`) while entity liabilities do not; a user recording the same company both ways double-counts asymmetrically |
| Net Worth breakdown reconciles with the total shown beside it | **FAIL — P2-4** | allocation sums to 100,000 against `totalAssetsCombined` 250,000 |

---

## 3. P0-1 — SMSF property loan subtracted twice

**Fixture (the real user journey, not a synthetic shortcut):** one SMSF fund; one Detailed Holding "SMSF residential property" worth 500,000; one `liabilities` row "SMSF LRBA property loan" of 365,000 linked by `property_liability_links.link_type='smsf_property_loan'`. Nothing else in the household.

**Ground truth Net Worth = 500,000 − 365,000 = 135,000.**

| Stage | `retirement_accounts.current_balance` | `totalRetirement` | `totalLiabilities` | Reported Net Worth | Error |
|---|---|---|---|---|---|
| A — Summary mode, user enters the fund's net value (as `0084`'s own column comment instructs) | 135,000 | 135,000 | 365,000 | **−230,000** | **−365,000** |
| B — Detailed mode, value computed by the system after the $0-variance gate passed | 135,000 | 135,000 | 365,000 | **−230,000** | **−365,000** |

The $0-variance gate worked correctly (it refused the switch at a 135,000 variance and allowed it once Summary matched Detailed) — the gate is not the problem. The problem is that the netted figure and the raw liability row are both subtracted.

In Detailed mode the user cannot avoid this: `smsf_compute_detailed_net_value()` subtracts the linked loans itself, and the linked loan **must** exist as a `liabilities` row for that function to find it.

**Status: FAIL. Requires a Product Owner ruling on which of the two figures is canonical.**

---

## 4. §7.2 — Household operating cash flow

| Invariant | Result | Evidence |
|---|---|---|
| SMSF operating income/expense/debt service excluded from personal surplus | **PASS** | S1: surplus 9,000 not 7,000 |
| Company/Trust operating cash flow excluded from personal surplus | **PASS for the entity workspace** (no entity cash-flow concept exists at all) / **FAIL for legacy owner tags** (P2-5) | `householdContext.ts:60-65` |
| SMSF cash counted as household liquidity | **FAIL (P2, disclosed)** | `liquidAssets` (`dashboard.ts:852`) is unfiltered while `essentialMonthlyExpenses` is filtered, so SMSF cash inflates `emergencyFundMonths`, `liquidityRatio` and Resilience |

---

## 5. §7.4 — Loan economics

| Invariant | Result | Evidence |
|---|---|---|
| Principal reduces liability and is a cash outflow, not an ordinary expense | PASS | `lib/engines/debtServiceContext.ts`; `isDuplicateDebtServiceExpense` removes a manual repayment row that duplicates a liability's own repayment |
| Interest and fees are expense | PASS | same |
| Full repayment is debt-service cash outflow | PASS | `debtMonthlyRepayments` feeds `monthlySurplus`, `disposableIncome`, DSR |
| Credit-card repayments do not duplicate classified purchases | PASS | `economic_transaction_type` exclusions in `dashboardData.ts:200-224`; `debt_principal` and `transfer` are excluded from bank expense totals |
| No fuzzy matching | PASS | `0131`'s explicit user-declared `superseded_by_bank_import` flag; the migration header states the rule |
| Wealth-side amortisation uses the whole balance sheet | PASS | `forecastData.ts` uses `totalLiabilityMonthlyRepayments`, not the household-only figure — with the reasoning documented in full |

---

## 6. §7.5 / LR-FI-3 — Exactly once

Every scenario Section 11 requires. Base household: net income 10,000/mo, essential expenses 4,000/mo, no debt → residual cash 6,000/mo.

| # | Scenario | asset | investment | retirement | Total into projected wealth | Expected | Result |
|---|---|---|---|---|---|---|---|
| F1 | no contributions | 6,000 | 0 | 0 | 6,000 | 6,000 | **PASS** |
| F2 | investment 1,000/mo | 5,000 | 1,000 | 0 | 6,000 | 6,000 | **PASS** |
| F3 | personal retirement 1,000/mo | 5,000 | 0 | 1,000 | 6,000 | 6,000 | **PASS** |
| F4 | employer retirement 1,000/mo | 6,000 | 0 | 1,000 | **7,000** | 7,000 | **PASS** |
| F5 | investment + personal retirement | 4,000 | 1,000 | 1,000 | 6,000 | 6,000 | **PASS** |
| F6 | all three | 4,000 | 1,000 | 2,000 | **7,000** | 7,000 | **PASS** |
| F7 | SMSF personal contribution 1,000/mo | 5,000 | 0 | 1,000 | 6,000 | 6,000 | **PASS on arithmetic, FAIL on classification** |
| F8 | negative surplus (−1,000) | 0 | 0 | 0 | 0 | 0 | **PASS** |

**The invariant holds.** Only the employer contribution is additive; household-funded investment and personal-retirement contributions are netted out of residual cash before the remainder is swept into assets (`forecastData.ts:886-897`). No dollar is counted twice.

**F7 classification finding (P2-3).** The contribution was recorded on a `master_item_key='smsf'` retirement account belonging to an active SMSF fund. It still appeared in `retirementPersonalMonthlyContribution` and was netted out of the household's residual cash. `lib/engines/forecast/smsfContributionGuard.ts` exists precisely to prevent this, but is applied **only** in `forecastData.ts`'s retirement-forecast branch — `computeDashboard` sums the columns unfiltered (`dashboard.ts:986-993`). The guard's own header says it was added "before any future feature could populate them and silently leak an SMSF operating flow into the household forecast". That leak is live on the Dashboard's `retirementContributionRate` and on the Net Worth forecast.

**F8 note (disclosed, not a defect):** `Math.max(0, surplus − householdFunded)` floors the asset sweep at zero, so a household whose contributions exceed its surplus has that excess projected as wealth its own cash flow cannot fund. This is a deliberate floor, but it is worth a PO ruling on whether an over-committed household should be shown a shortfall instead.

---

## 7. §7.6 — Goals

| Invariant | Result | Evidence |
|---|---|---|
| Goal progress does not become Net Worth by itself | PASS | `user_goals` never enters `netWorth` |
| `manualCurrentAmount` and live linked funding stay distinct | PASS | `goal_funding_sources` vs `user_goals.current_amount` |
| Linked Investment/Asset/Retirement value not duplicated | PASS | linkage is a reference, not a second balance |
| Forecast / variance / detail pages use the same basis | PASS | LR-7's own P1 fix is intact |
| Debt-payoff goal reads an SMSF loan's repayment unfiltered | **FAIL (P2)** | `goalsData.ts:203-209` selects the linked liability with no owner test, so an SMSF instalment counts as household goal progress while being excluded from `debtMonthlyRepayments` |

---

## 8. Insurance detection (P2-2) — live-proven

Fixture: exactly what the grid submits for the catalogue item "Income Protection" — `master_item_key='income_protection'`, `waiting_period_days=90`, and `cover_type` left at the validator default because **the grid has no `cover_type` field**.

| Metric | Expected | Actual |
|---|---|---|
| `incomeProtectionWaitingPeriodDays` | 90 | **null** |
| income-protection detected | true | **false** |
| `totalAnnualPremium` | 3,000 | 3,000 (correct) |

Every sibling register was hardened with a `master_item_key`-first precedence for exactly this reason — `dashboard.ts:228-238` documents it for assets ("`asset_class` … the real grid UI never actually collects … Without this, `liquidAssets` was silently 0 for every real user"). Insurance was missed.

---

## 9. Summary

| Oracle | Result |
|---|---|
| §7.3 DSR / DTI (S1, S2, S4) | **PASS 6/6** |
| §7.1 Net Worth taxonomy | **FAIL** — P0-1, plus P2-4, P2-5 |
| §7.2 household operating cash flow | **PASS** with a disclosed liquidity asymmetry |
| §7.4 loan economics | **PASS** |
| §7.5 / LR-FI-3 exactly once | **PASS 8/8**, with an SMSF classification leak (P2-3) |
| §7.6 goals | **PASS** with one unfiltered read (P2) |
| Cross-module consistency (Twin) | **FAIL** — P1-4 |
| Insurance detection | **FAIL** — P2-2 |

**Overall: the Live Recovery programme's core financial arithmetic is sound — the DSR correction and the exactly-once rule both hold under real execution. Net Worth does not: an SMSF property loan is subtracted twice, and three consuming surfaces (Financial Twin, Net Worth allocation, insurance detection) diverge from the engine that was certified.**
