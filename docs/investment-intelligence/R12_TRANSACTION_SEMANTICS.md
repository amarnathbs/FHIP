# R12 — Transaction Semantics

## New transaction type: `sale`

The only new `ii_transactions.transaction_type` value R12 adds (migration 0092, extending the
22-value constraint from migration 0059 — see the migration's own comment for the exact 0033→0040→0059
lineage this had to be based on, not assumed). `purchase` is reused unchanged for equity/ETF BUY.
`dividend` is reused unchanged for equity/ETF dividend income. No `interest`/`coupon`/`maturity`/
`bonus`/`split`/`rights` types are added this cycle — bonds/corporate-actions are deferred scope (see
`R12_ASSET_CLASS_SCOPE_MATRIX.md`, `R12_CORPORATE_ACTION_SCOPE.md`). `bonus`/`split` already existed
in the DB constraint (migration 0059, R6-P1) for mutual-fund bonus/split events — R12 reuses the
reconciliation direction-table entries for them (previously missing from the TS `IiTransactionType`
union and `reconciliation.ts`'s `DIRECTION_TABLE`, a pre-existing gap TypeScript surfaced the moment
`'sale'` was added alongside them; fixed as part of this round, not deferred).

## Reconciliation direction table (`reconciliation.ts`)

| Type | Direction | Notes |
|---|---|---|
| `sale` | outflow | Reduces units, same direction as `redemption` |
| `bonus` | inflow | Unit-count inflow with no cash consideration |
| `split` | passthrough | Pre-signed by the caller, same convention as `transfer`/`merger` |

Unit-tested in `tests/unit/iiR12WiderIndiaAssets.test.ts` (`unitDeltaForTransaction` for `sale`/`bonus`).

## No asset-specific parallel ledger (spec section 31)

An equity BUY is a real `ii_transactions` row with `transaction_type='purchase'`, `instrument_id`
pointing at an `instrument_class='equity'` row. There is no `ii_equity_transactions` table. R12
introduces zero new transaction tables.

## Fees / brokerage / costs (spec section 33)

`ii_transactions.fees` / `.taxes` columns **already existed** since migration 0040 (R2) but were never
populated by `manualImporter.ts`. R12 wires them through: `iiFixtureTransactionSchema` gained optional
`fees`/`taxes` fields, and the importer's transaction insert now sets them from the fixture
(`null` for any pre-R12 fixture that omits them — no behaviour change). `iiManualDirectPositionSchema`'s
`buy`/`sale` actions accept `fees`/`taxes` from the user.

## Validation (spec section 32)

`iiManualDirectPositionSchema` (Zod, discriminated union on `action`) rejects: non-positive
units/price for buy/sale, non-positive dividend amount, negative fees/taxes. `manualDirectPositionService.ts`
additionally rejects (business-rule, not schema-expressible): a `sale` for more units than are
currently held (checked against the latest real `ii_holding_snapshots` row for the ISIN), and any
`sale`/`dividend`/`reprice` action against an ISIN with no prior `buy`.

## Income from investments — the II/Income boundary (spec section 34)

A dividend recorded through R12's manual entry is an `ii_transactions` row (`transaction_type='dividend'`),
evidence inside Investment Intelligence. R12 does **not** write anything into the household `income_sources`
register — that boundary is unchanged from pre-R12 behaviour (II has never auto-populated Income; this
round does not introduce a new coupling). A `dividend` action leaves the position's `units`/`value`
unchanged (it is a cash event, not a unit-count event) — proven in `HLD-005` (independent oracle) and
`tests/unit/iiR12WiderIndiaAssets.test.ts`'s reconciliation-direction test.

## FDH bank-payment matching (spec section 35)

Unchanged. R12 does not touch FDH's `INVESTMENT_TRANSFER_CANDIDATE` bank-side matching logic, and does
not let bank evidence alone fabricate a security/units/price/tax-lot/holding — R12 introduces no new
coupling between FDH and II at all.
