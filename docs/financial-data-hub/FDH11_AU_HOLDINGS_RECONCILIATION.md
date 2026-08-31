# FDH-11 — Australia Holdings & Cash Reconciliation (spec sections 47-52, 59-62, 93, 96-97, 103)

## Holdings (`holdingsReconciliation.ts`)

`reconcileAuHoldings()`: opening quantity + Σ(signed transaction quantities) compared to the statement's own closing quantity, using `quantity.ts`'s exact bigint-scaled arithmetic (6dp, matching `ii_holding_snapshots.units`' own persisted scale) — never a JS `number` comparison.

States: `RECONCILED` (exact match, within an explicitly-opted-in tolerance that defaults to zero), `VARIANCE` (evidence complete but doesn't add up), `INSUFFICIENT_DATA` (opening quantity unknown, or the caller has not asserted the transaction history is complete for the period). Spec section 50's "do not force reconciliation where evidence is incomplete" is the *default* behaviour, not an opt-in.

**Never overwrites a canonical holding.** This module has no database access at all — it is pure, and its output is a comparison result, never a write instruction. The actual current-vs-statement comparison the review UX shows (spec section 61 — "+20 BHP explained by BUY" vs "unexplained → REVIEW_REQUIRED") is composed by `lib/investment-import-bridge/currentVsStatement.ts`, which is also read-only.

**No arbitrary quantity override (62, 103).** There is no code path anywhere in this codebase that does `holding.quantity = statement.quantity`. The only way a quantity-affecting canonical write happens is `applyAuStatementActivity.ts` inserting an individual, matched, approved BUY/SELL/transfer transaction — one real event at a time, each independently fingerprint-deduplicated. `applyAuStatementPosition.ts` upserts an `ii_holding_snapshots` *evidence* row (which the project's own architecture already treats as non-authoritative — see `R0_CANONICAL_DATA_CONTRACT.md`), never a canonical holding total.

## Cash (`cashReconciliation.ts`)

`reconcileAuBrokerCash()`: opening cash + deposits + sale settlements + dividends/distributions + interest − purchases − withdrawals − fees, compared to the statement's own closing cash figure, using `money.ts`'s exact minor-unit integer arithmetic (this genuinely is money, unlike holdings — spec section 96). Default tolerance is zero minor units; a $0.01 variance is detected, not rounded away (spec section 52's explicit negative control — reproduced in `tests/unit/fdh11AuInvestmentIntelligence.test.ts`).

## Fractional units / precision (spec sections 48-49, 97)

`quantity.ts` never casts to integer and never reuses `money.ts`'s 4dp scale — a managed-fund unit or a DRP fractional-share allocation can carry up to 6 decimal places, matching the persisted column scale exactly. `parseExactQuantity('1.1234567')` is rejected outright (exceeds the persisted scale) rather than silently rounded, so a caller can never lose precision without knowing it. The mandated negative control — expected `120.0000`, statement `120.0001` — is proven to report `VARIANCE`, not a false `RECONCILED` from float rounding.
