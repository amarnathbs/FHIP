# FDH-11 — Australia Broker Adapter Coverage (spec section 16)

## Honest coverage matrix

| Institution / format | Coverage state |
|---|---|
| Generic AU investment transaction CSV (columns: `Date, Type, Amount`, optional `Code, ISIN, Security Name, Quantity, Price, Brokerage, Settlement Date`) | **CERTIFIED** (`au_generic_investment_transaction_csv_v1`) |
| Generic AU portfolio/holdings CSV (columns: `Security Name, Quantity`, optional `Code, ISIN, Price, Market Value, Valuation Date`) | **CERTIFIED** (`au_generic_portfolio_csv_v1`) |
| CommSec | **UNSUPPORTED** — no sample export available this pass |
| CMC Invest | **UNSUPPORTED** |
| Selfwealth | **UNSUPPORTED** |
| Stake Australia | **UNSUPPORTED** |
| nabtrade | **UNSUPPORTED** |
| Westpac Share Trading | **UNSUPPORTED** |
| Macquarie (investment) | **UNSUPPORTED** |
| Any AU broker PDF statement | **UNSUPPORTED** — no PDF adapter built; resolves to `manual_mapping_required`/`pdf_manual_mapping_required`, never a fabricated "0 holdings" success |
| Any unrecognised CSV layout | **MANUAL_MAPPING_REQUIRED** — `detectAuInvestmentCsvFormat()` returns this status explicitly when no adapter clears the minimum confidence bar; the caller must never guess a column mapping |
| Two adapters scoring within the confidence gap of each other | **AMBIGUOUS** — never auto-picked |

This is a deliberate, disclosed scope reduction (mirroring FDH-10's own single-generic-CSV-adapter precedent for credit-card/loan statements) — not a claim of broad broker coverage. A future phase adding real sample statements from named brokers should add new entries to `lib/financial-data-hub/investment/adapters/registry.ts` (one new file per institution, following `AU_GENERIC_TRANSACTION_CSV`'s shape) without touching the two existing generic adapters or the detection pipeline.

## The certified generic transaction CSV contract

```
Date,Type,Code,ISIN,Security Name,Quantity,Price,Amount,Brokerage,Settlement Date
01/03/2026,BUY,BHP,AU000000BHP4,BHP Group Ltd,100,45.00,4500.00,19.95,03/03/2026
15/03/2026,DIVIDEND,BHP,AU000000BHP4,,,,120.00,,
```

`Type` must be one of the 14 `AU_STATEMENT_TRANSACTION_TYPES` values (case-insensitive) or a configured alias; an unrecognised value is surfaced as `row_N_unrecognised_activity_type_<value>` and excluded — never guessed, never silently dropped (spec section 25's UNKNOWN handling).

## The certified generic portfolio CSV contract

```
Security Name,Code,ISIN,Quantity,Price,Market Value,Valuation Date
BHP Group Ltd,BHP,AU000000BHP4,100,45.00,4500.00,2026-06-30
```

Zero rows extracted (every row unparseable, or a genuinely empty body) is always flagged with the `zero_positions_extracted` warning — never presented as a clean $0 portfolio (spec section 22).
