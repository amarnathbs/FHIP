# FDH-4 — Reconciliation

Reused unmodified from R7 (`lib/financial-data-hub/bank-csv/reconciliation.ts`). Full methodology in `docs/r7-bank-csv-engine/R7_RECONCILIATION_METHODOLOGY.md`. No second reconciliation engine was built (spec section 20).

## Status model (unchanged)

`not_available | pending | reconciled | failed | user_accepted_exception`. `reconciled` requires `variance !== null && abs(variance) <= 0` (exact currency-minor-unit tolerance, spec section 58 — no unexplained slack). Cannot falsely report success (spec section 19): partial balance coverage → `pending`; a genuine break → `failed`; no balance column at all → `not_available`.

## New-adapter reconciliation cases (this session, hand-computed independently — spec section 83)

| Fixture | Expected result | Independently computed (not derived from running the parser) |
|---|---|---|
| ANZ (5 rows) | RECONCILED, variance 0 | Opening 2562.50 → −62.50 → +3200.00 → −15.99 → −200.00 → +1.50 → closing 5485.51 |
| Macquarie (5 rows) | **NOT_AVAILABLE** | No balance column in Macquarie's own documented export format — reconciliation must not fabricate one (spec 17/109) |
| Axis Bank (5 rows) | RECONCILED, variance 0 | Opening 72500.00 → −350.00 → +85000.00 → −2100.00 → −25000.00 → +320.00 → closing 130370.00 |
| Kotak Mahindra (5 rows) | RECONCILED, variance 0 | Opening 50000.00 → −5000.00 → +60000.00 → −1899.00 → −3200.00 → +410.00 → closing 100311.00 |

`tests/unit/fdh4AdapterCoverage.test.ts` (`FDH4-TC017`–`TC020`) asserts all four, **plus a mandatory negative control** (spec section 84): the Kotak case is re-run with the final reported balance deliberately altered by 0.01 (`100311.00` → `100311.01`); the test requires `status === 'failed'` and the exact break row (`firstBreakRowNumber === 5`) — proving the certification actually catches a genuine break rather than passing by construction.

## Live-DEV reconciliation (new evidence this session)

`scripts/fdh4_live_dev_certification.ts` (`FDH4-E2E-04`), real DEV, CBA fixture: `opening_balance: 2000, extracted_credits: 3501.2, extracted_debits: 261.19, expected_closing_balance: 5240.01, reported_closing_balance: 5240.01, variance: 0, status: "reconciled"` — the full arithmetic chain reproduced live, not inferred from a 200 response.

`scripts/fdh4_live_scale_certification.ts`: reconciliation remains exact (`variance: 0`, `status: "reconciled"`) at **10,000 rows**, live against real DEV — see `FDH4_SCALE_CERTIFICATION.md`.

## Independent oracle cross-check (unchanged harness, new fixtures)

`scripts/r7_oracle_compare.ts` includes reconciliation in its per-fixture comparison; all 10 fixtures (6 R7 + 4 FDH-4) agree with the independent Python oracle with 0 discrepancies (327 total field comparisons this session).
