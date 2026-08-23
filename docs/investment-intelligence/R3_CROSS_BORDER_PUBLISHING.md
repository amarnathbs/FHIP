# R3 — Cross-Border Publishing (Currency Treatment)

Status: FINAL (R3) — CRITICAL FINANCIAL GATE
Confirmed against live code: `lib/engines/fx.ts` (`convertToReportingCurrency`), `lib/engines/dashboard.ts` (`reportingValue()`, lines ~435-517), `lib/services/dashboardData.ts` (`getFxRateAudInr`).

## 1. The existing FX architecture (confirmed, not assumed)

`computeDashboard()` sums `investments`/`assets`/`retirement_accounts` rows by calling `reportingValue(rowCurrencyCode, amount)` **at read/aggregation time**, which calls `convertToReportingCurrency(localAmount, localCurrency, reportingCurrency, fxRateAudInr)` (`lib/engines/fx.ts`):

```ts
if (localCurrency === reportingCurrency) return localAmount;
return localCurrency === 'INR' ? localAmount / fxRateAudInr : localAmount * fxRateAudInr;
```

`fxRateAudInr` is a single, fixed, admin-configured rate (`forecast_global_assumptions` table, `fx_rate_aud_inr` key, read via `dashboardData.ts`'s `getFxRateAudInr()`, default `56` if the seed row is ever missing) — **not** a live market rate. This is the "existing certified FHIP FX architecture" the spec asks R3 to use if one exists; it does, and R3 uses it exactly as-is.

## 2. What R3 writes — and does not write

Publishing an Indian mutual fund position writes `investments.current_value = <snapshot.value>` (e.g. `500000`) and `investments.currency_code = 'INR'`, **unconverted**, exactly matching how a manually-entered INR investment row already works today. R3 introduces **zero new FX conversion logic into the write path** — `investmentPublicationService.ts`'s `publishPosition()` never calls `convertToReportingCurrency()` or any conversion function when writing the target row. The INR figure is the only figure ever persisted to `investments.current_value`.

## 3. The DISPLAY-ONLY derived figure

`ii_fhip_publications` (migration `0042`) additionally stores `base_currency_code`, `base_currency_amount`, `base_currency_rate_used`, `base_currency_computed_at` — computed once at preview/publish time by `computeBaseCurrencyPreview()` (`publicationLogic.ts`), which:

- Returns `{available: false}` for any currency pair other than AUD/INR (R3's only supported pair) — never silently treats an unsupported currency as 1:1.
- Returns `{available: false}` when the configured FX rate is missing, non-finite, zero, or negative — **never falls back to treating the raw INR number as an AUD number**.
- Otherwise calls the exact same `convertToReportingCurrency()` function `computeDashboard()` itself uses, so the preview figure is provably identical to what the live dashboard will show (`tests/unit/iiR3NetWorthCertification.test.ts`'s "independent base-currency calculation AGREES EXACTLY with the real dashboard engine" test asserts this directly, to 2 decimal places).

This column is explicitly commented in the migration as **never authoritative** — `computeDashboard()` never reads it; it always recomputes the live base-currency figure from the stored INR source value at read time, using whatever the FX rate is *at that moment*. The stored preview figure exists only so a publication's audit trail/preview screen can show "what this looked like in AUD when published" without a since-changed FX rate silently rewriting history in the UI.

## 4. Worked example (spec section 22 / `R0_CROSS_BORDER_CONTRACT.md` section 4)

INR mutual fund, `value=500000`, household base currency AUD, `fxRateAudInr=56`:

1. `ii_holding_snapshots.value = 500000`, `currency_code = 'INR'` — untouched.
2. `investments.current_value = 500000`, `investments.currency_code = 'INR'`, `investments.country_code = 'IN'` — identical to the snapshot.
3. `computeDashboard()` calls `reportingValue('INR', 500000)` → `500000 / 56 = 8928.571428...` → rounds/sums into `totalInvestments`/`netWorth` as an AUD-equivalent, **in-memory**, never written back over the INR figure.
4. `investmentByCountry` continues to show `₹500,000` — "as recorded," unconverted (confirmed directly against `dashboard.ts`'s `byCountry()` helper, which deliberately never calls `reportingValue()`).

Exact numbers reproduced in `tests/unit/iiR3NetWorthCertification.test.ts` (`DD-009 / CUR-002` suite) and `tests/unit/iiR3ManualReconciliation.test.ts` Case 5: `1,000,000 / 56 = 17,857.142857142859`.

## 5. CUR test pack results (CUR-001 to CUR-006)

| Test | Result | Evidence |
|---|---|---|
| CUR-001 same-currency (INR household + INR investment) | `available=true`, `rateUsed=1`, amount unchanged | `iiR3PublicationLogic.test.ts` |
| CUR-002 AUD household + INR investment, converted via the approved FX architecture | `500000/56 = 8928.57` exactly | `iiR3PublicationLogic.test.ts`, `iiR3NetWorthCertification.test.ts` |
| CUR-003 missing/invalid required FX (`null`, `0`, negative) | `available=false`, no incorrect inclusion | `iiR3PublicationLogic.test.ts` |
| CUR-004 FX refresh doesn't alter the source INR value | `computeDashboard()` never mutates `investments.current_value`; only the in-memory aggregate changes when `fxRateAudInr` changes — proven structurally: the same INR row produces different `totalInvestments` under different `fxRateAudInr` inputs, while the row itself is never touched | `dashboard.ts` unmodified; test asserts row-level immutability by construction (no write call exists in the read path) |
| CUR-005 currency metadata preserved through publication | `source_currency`/`source_country` retained on `ii_fhip_publications`; `investments.currency_code`/`country_code` retained on the target row | migration `0042`, `investmentPublicationService.ts` |
| CUR-006 no INR number treated as AUD by raw numeric insertion | unsupported-pair guard + missing-rate guard both refuse silently-wrong conversion | `iiR3PublicationLogic.test.ts` |

## 6. Scope

Matches `R0_CROSS_BORDER_CONTRACT.md` section 5 exactly: R3 does not extend currency support beyond the two already-seeded pairs (AU/AUD, IN/INR). No new country/currency reference rows are added.

## 7. Classification

**PASS — unconditional.** No path exists by which an INR figure enters an AUD total without going through the household's own, pre-existing, unmodified `convertToReportingCurrency()` function, and no path exists by which a missing/invalid FX rate silently substitutes a wrong number. This is the release's single most safety-critical property outside of double-counting itself, and it required zero new conversion logic to satisfy — only correct non-conversion at write time.
