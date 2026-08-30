# FDH-12 — Bank Matching

Spec sections 38, 77-81, 126.

## Which activities even have a bank side

Most retirement activity never touches household cash.
`RETIREMENT_ACTIVITY_IS_INTERNAL` (`retirement/types.ts`) is the single
definition, and this module refuses to even look for a bank match for an
internal activity.

| Has a bank side | Direction expected |
| --- | --- |
| `PERSONAL_CONTRIBUTION` | bank **debit** (bank → super) |
| `WITHDRAWAL`, `PENSION_PAYMENT` | bank **credit** (super → bank) |

Everything else — employer contributions, salary sacrifice, government
contributions, earnings, interest, distributions, fees, insurance premiums,
tax, both rollover legs, adjustments, `UNKNOWN` — returns **`not_expected`**.

That is spec section 81 implemented as a hard gate rather than a lenient
default. `not_expected` is a distinct state from `no_match` and never raises a
review item, so the UI never asks a user to find a bank transaction that cannot
exist.

## The match key (spec 77)

`(amount, date ±10 days, direction, narrative)` — never amount alone.

**Spec 79 — wrong fund.** When the fund's name is known, the bank narrative
must corroborate it. Amount + date + direction alone are not enough to assert
that this particular $5,000 went to THIS fund rather than another one. A
transaction whose narrative does not name the fund is positively excluded, not
merely deprioritised. Generic words (super, fund, pension, retirement,
australia, …) are stripped so "super" alone can never corroborate anything.

**Spec 80 — ambiguity.** More than one corroborated candidate becomes
`multiple_candidates`, never the first.

**Tolerance: zero.** $5,000 and $5,000 are the same event; $4,950 is not.

**Settlement window: 10 days** — much tighter than the payslip window, because
no quarterly statutory cycle is involved.

## One economic event, not two (spec 38, 78, 126)

A confident match LINKS the two records so the UI shows one transfer. Neither
record is created, deleted or reclassified — FDH-12 has no write path to
`fdh_transactions`. `uq_fdh_retirement_activities_bank_txn` enforces that one
bank transaction corroborates at most one retirement activity.

**Spec 36 is respected absolutely**: a matched withdrawal is NOT thereby
classified as ordinary income. This module assigns no tax treatment, no income
type and no economic class. It links, and stops. Capital vs taxable vs tax-free
components are not invented.

## No bank evidence is fine (spec 81)

`bank_evidence_not_available` when the user has no bank transactions on file. A
super statement remains completely valid without bank data.

## A real defect found here

The first implementation typed the bank row as carrying `currency_code` and
`description_original`. `fdh_transactions` has neither — the real columns are
`currency_original` and `description_clean`/`description_raw` (migration 0047).
Caught by `scripts/fdh12_certification.mjs` when its fixture insert failed, and
independently confirmed against the real hosted DEV database via PostgREST
introspection. Fixed; every bank match would otherwise have errored at runtime.
