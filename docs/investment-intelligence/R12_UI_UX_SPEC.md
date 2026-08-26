# R12 — UI/UX Spec

## Investments UI (spec section 70)

No new top-level menu item. `ManualDirectPositionForm` is added as a sub-section of the existing
`app/(app)/investment-intelligence/page.tsx`, immediately below the existing CAS-upload client
(`InvestmentIntelligenceClient`). "Investments → Portfolio → asset-class entry paths" is realised as:
existing Investment Intelligence page → new "Add a direct equity or ETF position" form.

## Add Investment flow (spec section 73)

A single form (`components/investment-intelligence/ManualDirectPositionForm.tsx`) with an action
selector (`Buy` / `Sell` / `Dividend received` / `Update current value`) and an instrument-class
selector restricted to `Direct equity` / `Equity-oriented ETF` — R12's exact frozen scope, enforced
both at the UI layer (dropdown options) and the API layer (`iiManualDirectPositionSchema`). An ETF
selection surfaces a required "this ETF is equity-oriented" checkbox (spec section 57's explicit
declaration requirement).

## Summary / detailed holdings view (spec sections 71-72)

**Not built this cycle.** `GET /api/investment-intelligence/positions` now returns `instrument_id`,
`units`, `value`, `price_source`, and `priceFreshness` for every position (equity/ETF/MF alike), which
is the data a summary/detail view would need, but no new UI page renders per-asset-class breakdowns
(Total Investments / Mutual Funds / Equities / ETFs) or a detailed equity holdings table (security,
quantity, cost basis, current price, gain/loss, portfolio %, goal allocation). This is a disclosed gap
— the API contract exists, the presentation layer does not.

## India default (spec section 74)

The manual-entry form is India-scoped by construction (`iiManualDirectPositionSchema` fixes
`countryCode='IN'`/`currencyCode='INR'` inside `manualDirectPositionService.ts`, not user-selectable) —
consistent with R12 being an India-specific expansion, not a global UI change. No cross-border equity
path exists or was attempted this cycle.
