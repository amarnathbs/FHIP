# FDH-8 — Multi-Currency Policy

## Rule

Every FDH-8 aggregate is grouped by `currency_original` (the transaction's own currency, unmodified — FDH-8 performs no FX conversion) before any arithmetic happens. `groupByCurrency()` in `financialActivityAnalytics.ts` is the single point this grouping occurs; `computeTotalsByCurrency()` then calls the oracle once per currency group and returns `CurrencyTotals[]` — an array, never a single blended number. A household with an AUD everyday account and an INR NRE account gets two entries in `approved: CurrencyTotals[]`, never one.

## What FDH-8 explicitly does not do (spec 64-69)

- No ad hoc live FX rate lookup — `financialActivityAnalytics.ts` never calls an external rate provider and never reads `fdh_transactions.fx_rate`/`amount_reporting_currency` for any total (those columns exist for a future reporting-currency feature FDH-8 does not implement).
- No naive cross-currency summation — proven with an explicit negative control in `tests/unit/fdh8FinancialIntegrityCertification.test.ts` ("naive currency addition" describe block): 100 AUD + 100 INR is shown to naively equal "200" only as a demonstration of the trap, and is asserted to never be what the certified functions produce.
- No inferred tax/cross-border consequence — FDH-8 renders currency-separated totals and nothing else; it draws no conclusion about what a multi-currency household "owes" anywhere.

## Display formatting

`formatMoney(amount, currency)` (`lib/engines/money.ts`) — a display-only, `Intl.NumberFormat`-based formatter — is used for on-screen rendering of every already-exact total. It is never used to accumulate; accumulation is exclusively `lib/financial-data-hub/domain/money.ts`'s minor-unit-exact functions, called from inside `computeApprovedFinancialSummary`/`sumMoney`. This mirrors the existing repo-wide convention (`components/dashboard/charts.tsx` already takes a `currency: 'AUD' | 'INR'` prop for the same reason).

## Locale / country extensibility

FDH-8 introduces no hard-coded assumption that only AUD/INR exist: `groupByCurrency()` groups by whatever `currency_original` values are actually present in the data, and `minorUnitExponent()`/`smallestUnit()` (reused from `money.ts`) already default unknown currency codes to a 2-decimal exponent rather than throwing — a future third country's currency would be summed correctly (2-decimal default) even before an explicit exponent entry is added for it, matching the existing FDH-1 money.ts design intent documented in that file.
