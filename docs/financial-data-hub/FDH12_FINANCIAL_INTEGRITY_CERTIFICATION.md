# FDH-12 — Financial Integrity Certification

Spec sections 175 and 179. The nine mandatory negative controls, each with the
forbidden answer proven reachable by the naive computation first.

Harness: `tests/unit/fdh12FinancialIntegrity.test.ts` — **40 tests, all PASS**.

| # | Forbidden outcome | Required | Result |
| --- | --- | --- | --- |
| 1 | payslip employer super $1,000 + fund contribution $1,000 = **$2,000** | $1,000 | **PASS** |
| 2 | rollover $100,000 → **income $100,000** | income $0 | **PASS** |
| 3 | rollover $100,000 → **expense $100,000** | expense $0 | **PASS** |
| 4 | personal bank→super $5,000 → **household expense $5,000** | expense $0 | **PASS** |
| 5 | retained earnings $8,000 → **household cash income $8,000** | income $0 | **PASS** |
| 6 | internal super fee $100 → **duplicate household cash expense $100** | expense $0 | **PASS** |
| 7 | super $200,000 + same holdings $200,000 → **net worth $400,000** | $200,000 | **PASS** |
| 8 | Fund A rollover $100,000 + Fund B receipt $100,000 → **retirement $200,000** | $100,000 | **PASS** |
| 9 | current contribution $1,000 + YTD $8,000 → **$9,000** | $1,000 | **PASS** |

## How each is proven

**Controls 2-6 are proven STRUCTURALLY**, by reading the real source tree and
confirming that no FDH-12 file — Hub, bridge, API route or component — contains
a write to `income_sources`, any expense register, `fdh_transactions`,
`investments` or `insurance_policies`, and that migration 0112 inserts into
none of them. A rule enforced by the absence of code is stronger than one
enforced by an `if`, and a test that only exercised an `if` would not notice if
someone later added the missing write path.

They are *additionally* proven behaviourally: a perfectly matching bank
transaction exists in the fixture for a rollover, an earning and a fee, and
each still returns `not_expected` rather than matching.

**Control 1** is proven three ways — no additive function exists; the RPC
builds `col = value` and never `col = col + value`; and
`uq_fdh_retirement_activities_payroll_event` makes a second claim on one
payslip a DB error.

**Control 7** is proven by reading the positions table's own DDL and confirming
it carries no `apply_status`, no `canonical_*` column and no `applied_at` — so
a position has nowhere to go.

**Controls 8 and 9** are proven arithmetically, with the naive answer computed
first (`Number('100000') + Number('100000') === 200000`) so the correct answer
cannot pass vacuously.

## Additional financial controls

| Control | Spec | Result |
| --- | --- | --- |
| $0.01 change → VARIANCE (closing, opening, or one activity) | 48, 128 | **PASS** |
| Exact decimal arithmetic, no binary float | 142 | **PASS** — no float column; `bigint` minor units; float drift shown as a negative control |
| $0.01 still detected at 10,000 activities | 138 | **PASS** |
| Printed subtotal never counted alongside its lines | 116-118 | **PASS**, with the flag-cleared negative control |
| Employer contribution is not a household expense | 28 | **PASS** |
| Employer contribution is not a second salary receipt | 29 | **PASS** — FDH-9 semantics preserved; gross/tax never re-derived |
| Government co-contribution is not salary | 32 | **PASS** |
| Contributions tax preserved exactly, no rate inferred | 44-45 | **PASS** — no statutory rate constant anywhere |
| Insurance premium inside super does not touch canonical insurance | 43, 161 | **PASS** — no reference to `insurance_policies` |
| Withdrawal is not automatically ordinary income | 36, 76 | **PASS** — no economic classification assigned |
| Partial rollover totals $150,000, not $200,000 | 35 | **PASS** |
| Activity vocabulary is total and coherent | 21 | **PASS** — DB CHECK and TypeScript lists identical |
| `UNKNOWN` has no direction, so it cannot silently balance a statement | 143 | **PASS** |

## Expense Tracker regression (spec 75)

All five required outcomes hold, for one reason: **FDH-12 has no write path to
any expense register.**

| Scenario | Required | Result |
| --- | --- | --- |
| Employer super contribution | not a household expense | PASS |
| Personal bank→super contribution | transfer, not consumption | PASS |
| Super fee paid internally | not a household cash expense | PASS |
| Super insurance premium paid internally | not a duplicate cash expense | PASS |
| Rollover | not an expense | PASS |

## Income regression (spec 76)

| Scenario | Required | Result |
| --- | --- | --- |
| Rollover in | not income | PASS |
| Earnings retained internally | not ordinary household cash income | PASS |
| Withdrawal principal | not automatically ordinary income | PASS |
