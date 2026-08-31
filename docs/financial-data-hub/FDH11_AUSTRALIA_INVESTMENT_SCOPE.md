# FDH-11 — Australia Investment Scope

## In scope (spec section 14)

Instrument classes limited to what canonical Investment Intelligence already certifies for direct securities (`R12_ASSET_CLASS_SCOPE_MATRIX.md`'s frozen list): `instrument_class IN ('equity', 'etf')` for ASX-listed shares/ETFs/LICs, plus `'mutual_fund'` for AU managed funds (schema-compatible, not separately certified this pass — see residuals). No new `instrument_class` value was added.

Deliberately **not** in scope, matching R12's own India-side deferral reasoning for the identical asset classes (bonds/REITs/gold have the same "distinct, non-reusable tax/valuation treatment" problem in AU as in India):

- Bonds, government securities, hybrids — no AU tax/valuation methodology exists in II.
- REITs/InvITs-equivalent (Australian REITs) — multi-component distribution tax treatment not modelled.
- Superannuation — owned by Retirement (`retirement_accounts`), confirmed by live code inspection; FDH-11 never touches it (spec section 136).
- SMSF — owned by Retirement's own `smsf_funds`/`smsf_holdings` (migration `0084`), confirmed AU-gated at the DB trigger level; FDH-11 does not route SMSF statement data into ordinary Investments (spec section 137).
- Physical property — owned by `assets`; FDH-11 never creates a property row from statement evidence (spec section 138).

## Statement types supported (spec section 15)

`AU_INVESTMENT_STATEMENT_TYPES` (see `lib/financial-data-hub/investment/types.ts`) enumerates all nine spec-named evidence types (`broker_portfolio_statement` through `trade_confirmation`), but only two have a working extraction path this pass: `investment_transaction_csv` and `portfolio_csv`, via the two certified generic CSV adapters. The other seven are recognised as valid statement-type *classifications* (a statement can be tagged as one) but have no adapter behind them yet — uploading one resolves to `manual_mapping_required`, never a silent zero-holdings result.

## Cross-border eligibility (spec section 7)

Investment jurisdiction, not residence, gates capability. Confirmed by inspection of `lib/services/jurisdiction.ts`'s existing `ApplicabilityClass` model (`GLOBAL | HOME_JURISDICTION | HOME_OR_CROSS_BORDER_COUNTRY | ...`, from the prior G0-Wave2 pass) — the same model already used for `australian_shares` in `app/api/investments/route.ts`. FDH-11's AU import panel and API routes carry no residence check at all; an Indian-resident user can upload an AU statement exactly as an Australian-resident user can, and the India module remains reachable from Investments regardless of the user's declared country (the "India Investments" button in `app/(app)/investments/page.tsx` has no country gate).
