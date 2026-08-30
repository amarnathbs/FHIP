# FDH-12 — Investment Intelligence Boundary

Spec sections 12-13, 40, 71, 156, 158.

## The rule

Investments held INSIDE a retirement account must never be recreated as
ordinary personal Investments.

> Super statement shows BHP $20,000 + VAS $40,000 + Cash $5,000, but canonical
> Retirement stores Super balance = $65,000.
> Required net-worth contribution: **$65,000**. Forbidden: $130,000.

The spec's own headline version (section 13): super account $200,000 +
statement investment holdings $200,000 must contribute **$200,000**, never
$400,000.

## Why it holds structurally

`fdh_retirement_statement_positions` is **terminal by design**. Unlike FDH-11's
positions table, which carries `apply_status` and
`canonical_holding_snapshot_id`, FDH-12's carries:

* no `apply_status`
* no `canonical_*` column
* no `applied_at` / `applied_by`
* no `matched_instrument_id`

A status column would imply a destination. There is none. No apply function
accepts a position row — asserted by reading the real
`fdh12_apply_retirement_proposal()` and `fdh12_approve_retirement_statement()`
bodies and confirming neither mentions the positions table.

Additionally:

* The nine-column allow-list contains no holding, unit, market-value or option
  field.
* No FDH-12 file references `ii_instruments`, `ii_accounts`, `ii_transactions`,
  `ii_holding_snapshots` or `ii_instrument_identifiers`.
* Migration 0111 contains no `ii_` token at all.

All asserted mechanically over the real source tree by
`tests/unit/fdh12Isolation.test.ts` and
`tests/unit/fdh12FinancialIntegrity.test.ts`.

## Net worth (spec 13, 71, 158)

Net worth reads `Σ retirement_accounts.current_balance`
(`lib/engines/dashboard.ts:582`) and nothing else. FDH-12 changes that engine
not at all. A super balance therefore enters net worth exactly once, and its
underlying holdings enter it zero additional times — because they have no path
into any summed column.

Spec 71's regression (super $200,000 must not appear as Retirement $200,000 +
Ordinary Investments $200,000) holds for the same reason: FDH-12 creates no
`investments` row, ever.

## Internal distributions (spec 40)

A super fund's internally reported distributions are evidence only. They are
classified `DISTRIBUTION`, marked INTERNAL, and never bank-matched or
duplicated as personal ordinary investment income.

## What the user sees

The review screen shows the investment options with the note:

> Shown for information only. These are already part of your super balance, so
> they are not added to your investments as well.

## SMSF holdings

Untouched. `smsf_holdings` remains the SMSF module's own detailed-mode
representation. FDH-12 writes nothing there and creates no second
representation of an SMSF's assets.
