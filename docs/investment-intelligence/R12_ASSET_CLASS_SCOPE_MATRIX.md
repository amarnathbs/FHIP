# R12 — Asset Class Decision Matrix (Scope Freeze)

Per spec sections 12–18. Format: Asset class | User demand | Existing schema compatibility |
Market-data need | Tax complexity | Existing owner | R12 decision.

| Asset class | User demand | Schema compatibility | Market-data need | Tax complexity | Existing owner | R12 decision |
|---|---|---|---|---|---|---|
| Direct listed equity (NSE/BSE) | High (Tier 1) | `instrument_class='equity'` already exists; `nse_symbol`/`bse_code`/`isin` identifiers already exist; `demat` account type already exists | Manual/statement price only (no live feed exists anywhere in repo) | Section 111A/112A — identical rule shape to equity-oriented MF, reusable | II (new) | **IN_SCOPE_R12** |
| Equity-oriented ETF (Nifty/Sensex/sectoral index ETFs) | High (Tier 1) | `instrument_class='etf'` already exists; same identifier support as equity | Manual/statement price only | Section 111A/112A via STT-paid equity-oriented fund unit rule — same as equity | II (new) | **IN_SCOPE_R12** |
| Non-equity ETF (gold ETF, debt ETF, international ETF) | Medium | `instrument_class='etf'` exists but is tax-**heterogeneous** — instrument itself does not disclose which sub-treatment applies | Manual/statement price only | Distinct per underlying (gold ETF ≈ debt-like since Finance Act 2023 gold-ETF-as-"specified"-treatment questions, international ETF has its own overseas-asset disclosure angle) — genuinely different rule per sub-type, not safely inferable from `instrument_class='etf'` alone (spec section 57 explicitly warns against this) | II (deferred) | **DEFER** — manual entry structurally accepted (still `instrument_class='etf'`) but R6 leaves it `unresolved`/"tax basis incomplete" rather than guessing; not R12-certified |
| Bonds / debentures / NCDs (listed, corporate) | High (Tier 1) | `instrument_class='bond'` already exists in `ii_instruments`, but `investments.investment_type` (legacy FHIP register, migration `0003`/`lib/validation/investment.ts`) has **no** `'bond'` value yet | Manual/statement price; par-vs-market valuation methodology genuinely undecided in this repo today (spec section 40) | Distinct holding-period/indexation rule since Finance Act 2023/2024 changes, **not** the same as equity and **not** the same as MF debt-specified Section 50AA rule — needs its own effective-dated `SchemeTaxClass` and rule-version research, not a same-day reuse | II (would be new) | **DEFER to R12.1** — real, good-faith reason: correctness-critical tax/valuation research not completed to certifiable rigor within this cycle; shipping the instrument without a trustworthy tax/valuation answer would violate spec section 140 ("fabricated cost basis"/"incorrect new-asset tax classification" are FULL-PASS-blocking, not conditional-pass-eligible) |
| Government securities / T-Bills | Medium (Tier 2) | Same `instrument_class='bond'` reuse question as corporate bonds, plus sovereign-specific quoting conventions (yield vs price) not modelled anywhere | Manual/statement price | Different-again rule shape (largely capital-gains-only, coupon taxed as income, no equity-style STT regime) | II (would be new) | **DEFER** — same reasoning as bonds, compounded by no existing quoting-convention support |
| Sovereign Gold Bonds (SGB) | Medium (Tier 2) | No instrument_class value; SGB has interest **and** maturity-redemption-capital-gain-exemption components that are legally distinct from every other candidate | Manual/statement price | Genuinely unique: RBI-administered, maturity-held capital gains are tax-exempt (Income Tax Act), premature-exit is not — cannot be safely approximated by reusing bond or equity treatment | II (would be new) | **DEFER** — explicitly excluded at P0, not silently dropped |
| Listed REITs | Medium (Tier 1 per spec, but see reasoning) | No distinct `instrument_class` value (`'other'`/`'bond'`-adjacent would misclassify per spec section 50); would need a genuine enum addition | Manual/statement price | Distribution is a **mixture** of dividend, interest, and amortisation-of-SPV-debt components with different tax treatment per component (spec section 58 explicitly flags this) — safe component-level treatment was judged not achievable to a trustworthy standard this cycle | II (would be new) | **DEFER** — spec section 58 itself explicitly sanctions deferring when component-level treatment "cannot be safely implemented" |
| Listed InvITs | Medium (Tier 1 per spec) | Same as REIT | Manual/statement price | Same multi-component distribution problem as REIT | II (would be new) | **DEFER**, same reasoning as REIT |
| PMS / AIF | Low-medium (Tier 3) | Not unitised the same way as MF/ETF; no schema today | N/A this cycle | Complex, category-dependent (AIF Cat I/II/III have different pass-through rules) | Would be II | **OUT_OF_SCOPE this release** (spec itself expects Tier 3 to stay deferred absent strong architectural pull) |
| Unlisted securities / ESOPs / private equity | Low-medium | No schema, no reliable valuation source at all | N/A | Highly bespoke (ESOP perquisite + capital gains, unlisted 24-month LTCG threshold) | Would be II | **OUT_OF_SCOPE** |
| Physical gold | Medium | `assets` register already has a generic `asset_class` — physical gold is not an investable, priced-security position in the II sense | N/A (no security identity) | Distinct from gold ETF/SGB (spec section 17 — never lump these together) | **HOUSEHOLD_ASSET_ONLY** (`assets` table) | **OUT_OF_SCOPE for II** — correct to keep it out of II per spec section 17 |
| Gold ETF / Gold mutual fund | Medium | `instrument_class` supports `'etf'`/`'mutual_fund'`; economically these ARE priced securities, unlike physical gold | Manual/statement price | Post-Finance-Act-2023 gold ETF/FoF taxation is now aligned with the debt-specified regime for many acquisitions — again a distinct rule from equity, not safely reused | II (structurally possible) | **DEFER** — falls under the "non-equity ETF" deferral above; not conflated with physical gold |
| PPF | Medium | Already modelled — see `RETIREMENT_OWNED` | N/A | Retirement's own domain | **RETIREMENT_OWNED** (`retirement_accounts.account_type='PPF'`, migration `0003`) | **OWNED_ELSEWHERE** — R12 does not touch |
| EPF | High | Already modelled — `RETIREMENT_OWNED` | N/A | Retirement's own domain | **RETIREMENT_OWNED** (`account_type='EPF'`) | **OWNED_ELSEWHERE** |
| NPS | High | Already modelled — `RETIREMENT_OWNED`, and `publishing.ts`'s own comment explains NPS is routed by `account_type='retirement'`, not by a distinct `instrument_class` | N/A | Retirement's own domain | **RETIREMENT_OWNED** | **OWNED_ELSEWHERE** |
| Bank Fixed Deposits | High | `computePublicationTarget` already routes `instrument_class ∈ {'fixed_deposit','cash'}` to `assets` — a second FD representation inside II would double-count net worth (spec section 16's exact concern) | N/A | N/A for II | **HOUSEHOLD_ASSET_ONLY** (`assets` table, or `instrument_class='fixed_deposit'` if ever CAS-sourced, still routes to `assets` not `investments`) | **OUT_OF_SCOPE for II net-worth duplication** — the existing routing rule already prevents this; R12 does not add a competing FD entry path |
| Index funds (open-ended, India) | High | Already representable as `instrument_class='mutual_fund'` — an index fund is a mutual fund structurally, not a distinct instrument class | Existing (CAS/manual) | Already governed by existing `ii_scheme_tax_classification`/`classifyScheme` (equity-oriented, since index funds track equity indices) | **FULLY_CANONICAL already** (pre-R12) | **N/A — already in scope pre-R12**, no R12 work needed |
| Residential/investment property, vehicles, household valuables, business ownership, loans receivable, liabilities | N/A | Owned by other household modules already | N/A | N/A | Household asset/liability modules | **OUT_OF_SCOPE** (spec section 4) |

## Frozen R12 asset classes (exact)

- **Direct listed Indian equity** (NSE and/or BSE, ISIN-identified)
- **Equity-oriented ETFs** (index/sectoral ETFs whose underlying is Indian listed equity)

Both publish into the same canonical Investment Intelligence ledger (`ii_instruments` /
`ii_transactions` / `ii_tax_lots` / `ii_holding_snapshots`) used by mutual funds today — no parallel
table, no parallel engine.

## Explicitly deferred (with reason, per spec section 141's "deferred asset class is not a defect if
clearly excluded at R12-P0")

| Deferred class | Reason |
|---|---|
| Non-equity ETFs (gold/debt/international) | Tax treatment is not uniform across `instrument_class='etf'` and was not researched to a certifiable standard this cycle (spec section 57) |
| Bonds/NCDs/Government securities/T-Bills | Distinct, non-reusable effective-dated tax rule + undecided valuation methodology (par vs market) — both correctness-critical (spec sections 40, 54, 140) |
| Sovereign Gold Bonds | Legally unique interest + maturity-exemption structure, no safe reuse of bond or equity rules |
| Listed REITs / InvITs | Multi-component distribution tax treatment (spec section 58) not implementable to a trustworthy standard this cycle; also requires a genuine `instrument_class` enum addition, deliberately not made until the tax side is ready |
| PMS / AIF / unlisted / ESOP / private equity / physical gold / crypto (as an II asset) | Tier 3 per spec's own guidance; no architectural pull found to justify pulling forward |

## Owned elsewhere (not R12's to move)

PPF, EPF, NPS → Retirement (`retirement_accounts`). Bank Fixed Deposits, cash → household `assets`
(existing `computePublicationTarget` routing). Property, vehicles, valuables, business ownership,
receivables, liabilities → their existing household modules.

## Required transaction types for frozen scope

`purchase` (BUY, reused), `sale` (**new** — SELL, distinct from mutual-fund `redemption`), `dividend`
(reused). No `interest`/`coupon`/`maturity`/`bonus`/`split`/`rights` are added this cycle — they
belong to the deferred bond/REIT/corporate-action scope (see `R12_CORPORATE_ACTION_SCOPE.md`).

## Required identifiers

`isin` (preferred canonical identity, reused unchanged), `nse_symbol`, `bse_code` (both reused
unchanged — already global-vs-country-scoped-unique per instrument, already correct for the "same
ISIN, two exchange symbols → one instrument" invariant).

## Required valuation

Manual entry only (spec section 20/37) — classified explicitly as `MANUAL_PRICE` in
`R12_MARKET_DATA_AND_PRICE_PROVENANCE.md`; no live market-data feed is invented.

## Required tax handling

Reuse of the existing `'equity_oriented'` `SchemeTaxClass` and the unmodified
`computeDisposalTax()` gains engine, fed by a new, non-look-through classifier for direct/ETF
positions (`R12_INDIA_TAX_AND_COST_INTEGRATION.md`).

## Required UI changes

One new manual "Add Investment" entry path (equity/ETF only), surfaced from the existing Investment
Intelligence area — no new top-level navigation items (spec section 70).

## Required reporting changes

None beyond consuming the same canonical position/report-data-contract path already used by mutual
funds (`investmentIntelligenceReportData.ts` is already instrument-class-agnostic — see
architecture discovery section 2.5).

## Required import methods

Manual entry only. NSDL/CDSL/broker-statement parsing remains deferred exactly as R11 left it (spec
section 19) — R12 does not pull those adapters forward.
