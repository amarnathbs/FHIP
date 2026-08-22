# R6-FINAL — Calculation Trace (Section 48)

One real, live-DEV result (LIVE-R6-005, the grandfathering case), traced
from the rendered figure all the way down to its source rows. Every id and
value below is a direct query against DEV `vqycarelcoijzwlpkpcz`
(`user_id=922d1025-a658-4d23-8729-fee0d9f75001`), not reconstructed from
memory.

## 1. Rendered figure

`/investment-intelligence/tax` → Realised gains table → row for
"R6F Grandfathered Equity Fund - Growth (Direct Plan)": **estimated taxable
gain ₹4,000, LTCG**.

`GET /api/investment-intelligence/tax/summary` response (relevant slice):

```json
{
  "instrumentId": "88b6cfe2-86eb-45b5-a308-a7a36c912acf",
  "acquisitionDate": "2016-05-10",
  "disposalDate": "2024-03-01",
  "unitsConsumed": 800,
  "classification": "equity_oriented",
  "gainType": "ltcg",
  "taxableGain": 4000,
  "grandfathering": { "eligible": true, "basisSource": "fmv_grandfathered", "costBasisPerUnit": 25 }
}
```

## 2. Source documents (the two real `ii_transactions` rows)

| | Acquisition (`74deed88…`) | Disposal (`0cb40f77…`) |
|---|---|---|
| `transaction_type` | `purchase` | `redemption` |
| `transaction_date` | `2016-05-10` | `2024-03-01` |
| `units` | 800 | 800 |
| `price_per_unit` | ₹10 | ₹30 |
| `gross_amount` | ₹8,000 | ₹24,000 |
| `source_reference` | `LIVE-R6-005 pre-2018 purchase` | `LIVE-R6-005 redemption` |

## 3. Reference data consulted

- **Classification** (`ii_scheme_tax_classification`, id `2a823619…`):
  `equity_oriented`, `domestic_equity_pct=95`, `basis=computed_from_holdings`.
  Feeds the "is this eligible for Section 112A / grandfathering at all?"
  gate — `isEquityOriented = true`.
- **31-Jan-2018 FMV** (`ii_prices_nav`, id `bf6d8e7c…`): `price_date=2018-01-31`,
  `price=25`. This is the exact NAV data point
  `grandfathering.ts`'s `applyGrandfathering()` requires — a real historical
  series row, never estimated.
- **Rule version** (`ii_tax_rule_versions`, in-code
  `ALL_RULE_VERSIONS['1961_act_pre_20240723']`, resolved by disposal date
  `2024-03-01` falling in `[2023-04-01, 2024-07-22]`): equity-oriented
  STCG 15%/LTCG 10%, 12-month holding threshold, ₹100,000/FY exemption.

## 4. Derived state: `ii_tax_lots` (this dispatch's own fix)

```json
{
  "id": "07a503a7-b6ff-5c02-b2d6-fe170489f80a",
  "opening_transaction_id": "74deed88-a005-41a0-8671-2c3a28d9df45",
  "acquisition_date": "2016-05-10",
  "units_acquired": 800, "units_remaining": 0, "status": "closed",
  "cost_per_unit": 10
}
```

`id` is `deterministicLotId('lot:74deed88-a005-41a0-8671-2c3a28d9df45')` — a
pure function of the acquisition transaction's own id, reproducible by
anyone re-running `deterministicLotId()` with that string.

## 5. Derived state: `ii_tax_lot_consumptions`

```json
{
  "disposal_transaction_id": "0cb40f77-6fe4-4815-a5b6-92417a5e9cbc",
  "lot_id": "07a503a7-b6ff-5c02-b2d6-fe170489f80a",
  "units_consumed": 800,
  "cost_basis_pre_grandfathering": 8000,
  "sale_value_apportioned": 24000
}
```

`cost_basis_pre_grandfathering = 800 units × ₹10/unit = 8,000` — this is
the RAW cost, before any FMV step-up.

## 6. The grandfathering computation itself

`applyGrandfathering({ acquisitionDate: '2016-05-10', actualCostPerUnit: 10,
salePricePerUnit: 30, fmvPerUnit: 25, isEquityOriented: true })`:

1. `isEquityOriented` → true, don't short-circuit.
2. `acquisitionDate (2016-05-10) < GRANDFATHERING_CUTOFF_DATE (2018-02-01)`
   → eligible.
3. `fmvPerUnit = 25`, not null → proceed to the three-way comparison.
4. `lowerOfFmvAndSale = min(fmv=25, salePrice=30) = 25`.
5. `costBasisPerUnit = max(actualCost=10, lowerOfFmvAndSale=25) = 25`.
6. `basisSource = 'fmv_grandfathered'` (since `25 > actualCost 10`).

## 7. Holding period → gain type

`computeHoldingPeriod('2016-05-10', '2024-03-01', 12)`: 12-month
anniversary of `2016-05-10` is `2017-05-10`; `2024-03-01 > 2017-05-10` →
**LTCG**. (`holdingDays = 2852`, informational only — the LTCG/STCG
decision itself uses the anniversary-date comparison, not a day-count
threshold.)

## 8. Final arithmetic

```
costBasisUsed  = costBasisPerUnit × unitsConsumed = 25 × 800 = 20,000
saleValue      = unitsConsumed × salePricePerUnit  = 800 × 30 = 24,000
taxableGain    = saleValue − costBasisUsed          = 24,000 − 20,000 = 4,000
```

Matches the persisted `ii_capital_gains_computations` row
(`cost_basis_used: 20000, sale_value: 24000, taxable_gain: 4000`) and the
API response exactly. This exact chain — real transaction rows → real NAV
row → real classification row → deterministic lot → deterministic
consumption → the certified grandfathering/holding-period/rate-resolution
functions → the persisted computation → the rendered UI figure — is fully
reproducible by re-running `node
scripts/ii_r6_final_live_dev_cases.mjs` and querying the ids above.
