# R0 — Forecasting Integration Contract

Status: FINAL (R0)
Depends on: `R0_CURRENT_STATE_DISCOVERY.md` (section 7 — exact Forecasting interface verified against `lib/engines/forecast/*.ts`), `R0_CANONICAL_DATA_CONTRACT.md`

## 1. FHIP Forecasting remains the sole household forecasting engine

Per design principles 11/12, Investment Intelligence supplies **inputs**, never a second forecast. Concretely: `lib/engines/forecast/netWorthCalculator.ts`'s `runNetWorthForecast()` and `lib/engines/forecast/investmentCalculator.ts`'s `runInvestmentForecast()` (`R0_CURRENT_STATE_DISCOVERY.md` section 7) are the only functions that ever project a balance forward in time anywhere in FHIP. Investment Intelligence does not implement a parallel projection function — it only ever improves what feeds `InvestmentCalculatorInputEntry`/`NetWorthCalculatorInput`.

## 2. Exact interface Investment Intelligence must supply into

Verified field-for-field against `lib/engines/forecast/investmentCalculator.ts` and `lib/engines/forecast/types.ts`:

```ts
interface InvestmentCalculatorInputEntry {
  id: string;              // -> published investments.id (R0_FHIP_PUBLISHING_CONTRACT.md)
  name: string;             // -> investments.investment_name
  currentValue: number;      // -> ii_holding_snapshots latest certified value, via investments.current_value
  monthlyContribution: number; // -> investments.annual_contribution / 12 (planned, not historical — see publishing contract)
  investmentType: string;     // -> investments.investment_type (secondary signal only, per existing code comment)
  masterItemKey: string | null; // -> investments.master_item_key — THE reliable asset-class signal (FHIP-FC-INV-001/002)
  currency: string;           // -> investments.currency_code
}
```

Because publishing (`R0_FHIP_PUBLISHING_CONTRACT.md`) writes exactly these columns on the existing `investments` table, **Investment Intelligence requires zero changes to `investmentCalculator.ts` or `MASTER_ITEM_TO_ASSET_CLASS`** to forecast a published position — it only needs to publish into the correct `master_item_key` from the existing catalogue (the ITEM mapping already frozen in `R0_FHIP_PUBLISHING_CONTRACT.md`). This is deliberate: `resolveAssetClass()`'s existing fallback chain (`master_item_key` → `investment_type` → `other_asset` with an `isLowConfidence` flag) already gives a published-but-unclassified position a safe, clearly-flagged-as-uncertain forecast rather than an error — no new "what if Investment Intelligence supplies a class the calculator doesn't understand" case needs to be designed.

Similarly, `NetWorthCalculatorInput`'s `openingInvestments`/`monthlyInvestmentContribution` are populated from the same summed `investments` table `computeDashboard()` already sums (`R0_CURRENT_STATE_DISCOVERY.md` section 8) — published positions flow in automatically once they're counted in `totalInvestments`, with no separate Investment-Intelligence-specific wiring into the net-worth forecast at all.

## 3. What Investment Intelligence may supply (per spec Section 11), and where it lands

| Spec-listed input | Landing point | Notes |
|---|---|---|
| Current investment value | `investments.current_value` (via publishing) | No new Forecasting field |
| Planned contribution | `investments.annual_contribution` (via publishing) | Explicitly the forward *plan*, not historical flow — `R0_FHIP_PUBLISHING_CONTRACT.md` |
| Asset class | `investments.master_item_key` (via publishing) | The signal `investmentCalculator.ts` already trusts |
| Risk characteristics | `investments.risk_profile` | Not currently consumed by any forecast calculator found in discovery — available for a future calculator enhancement, not required by R0/R1 |
| Historical performance characteristics | `ii_analytics_results` (future; not built in R0/R1) | No current Forecasting input exists for this; explicitly out of scope until an analytics engine exists |
| Local currency | `investments.currency_code` (via publishing) | Matches `InvestmentCalculatorInputEntry.currency` exactly |
| Country | `investments.country_code` (via publishing) | Consumed by cross-border forecasting (`crossBorderCalculator.ts`), unchanged |
| Cost assumptions | `ii_tax_lots`-derived `investments.cost_base` (via publishing) | No current forecast calculator consumes cost base directly (confirmed: `investmentCalculator.ts` projects `currentValue` forward, not cost) — available for future gain/loss-aware forecasting, not required now |
| Tax assumptions | Not supplied — **no tax analytics built in R0/R1** | Explicitly out of scope per spec non-goals |
| Liquidity characteristics | Not currently consumed by any forecast calculator found | No landing point exists yet; not required by R0/R1 |
| Goal allocation | `goal_funding_sources` (via `ii_goal_allocations` sync, `R0_GOAL_INTEGRATION_CONTRACT.md`) | Already consumed by `goalFundingAllocation.ts`'s `computeAllocatedMonthlyContribution()` |

## 4. What Forecasting keeps doing, unchanged

Per spec Section 11, restated against actual code:

- **Household net-worth forecasts** — `runNetWorthForecast()`, unchanged.
- **Goal probability / funding gap** — `goalForecast.ts`/`goal_forecasts` table, unchanged; consumes allocations per section 3 above.
- **Debt interactions** — `debtCalculator.ts`, entirely outside Investment Intelligence's scope; unchanged.
- **Retirement forecast** — `retirementCalculator.ts` plus the retirement-timing-hierarchy fix (`R0_CURRENT_STATE_DISCOVERY.md` mentions migration `0028`), unchanged; an NPS/PPF position published to `retirement_accounts` (per the routing decision in `R0_NET_WORTH_DEDUP_CONTRACT.md` scenario 6) flows into this calculator exactly as a manually-entered retirement row does today.
- **5/10/15+ year household scenarios** — `forecast_scenarios`/`forecast_runs`, unchanged.
- **Actual vs. forecast variance** — `scenarioDiff.ts`, unchanged; a published position's improving data quality over time (an early `warning`-status snapshot later reconciled to `certified`) is a legitimate source of forecast/actual variance, handled by the existing variance machinery, not a new concept.

## 5. Explicit non-goal

R0/R1 does not implement any new forecast calculator, does not modify `investmentCalculator.ts`/`netWorthCalculator.ts`/`goalCalculator.ts`/`retirementCalculator.ts`, and does not add new columns to `forecast_results`/`forecast_explanations`/`forecast_assumptions`. Everything in section 3 above lands on **existing** `investments`/`retirement_accounts`/`goal_funding_sources` columns that Forecasting already reads.
