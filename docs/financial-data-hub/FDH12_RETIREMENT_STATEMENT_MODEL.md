# FDH-12 — Retirement Statement Evidence Model

Spec section 20. Migration `0111_fdh12_retirement_statement_intelligence.sql`.

## Three tables

### `fdh_retirement_statements` — statement-level evidence
Header, period, balances, printed movement totals, YTD figures, parser
provenance, extraction/reconciliation/match/review/approval state, SMSF
classification, duplicate/supersession provenance.

`canonical_account_id` and `retirement_member_id` are **plain uuids, not FKs**.
A nullable FK would imply this row co-owns the canonical record; it does not.
Ownership is proven instead by `fdh12_assert_retirement_statement_owner()`,
which is stricter than an FK because it checks the OWNER, not merely existence.

### `fdh_retirement_statement_activities` — line-level evidence
The spec-section-21 vocabulary in full (17 types). `amount` is a **positive
magnitude**; direction lives in `RETIREMENT_ACTIVITY_DIRECTION`. Carries
payslip-match, bank-match and rollover-pair state, plus `is_summary_total` and
`is_year_to_date`.

**These rows have no canonical destination.** Canonical Retirement has no event
ledger, so an activity is reconciled, matched and displayed — never posted.

### `fdh_retirement_statement_positions` — holdings inside the fund
Terminal by design. It deliberately carries **no** `apply_status`, **no**
`canonical_*` column and **no** `applied_at`/`applied_by`, because a status
column would imply a destination. This is what makes spec section 13's
$200,000-not-$400,000 rule structural.

## Field selection (spec section 20's "do not blindly add every listed field")

Two fields from the spec's illustrative list are deliberately **absent**:

* **`distributions`** — on a super member statement, internal distributions are
  reported within investment earnings. A second column would invite exactly the
  subtotal double-count spec section 117 forbids. `DISTRIBUTION` survives as an
  activity type, where it belongs.
* **`interest`** — same reasoning; India EPF interest is an `INTEREST` activity
  and rolls into `investment_earnings`.

Added beyond the list, because the spec's own rules require them:

* `ytd_employer_contributions` / `ytd_personal_contributions` — spec 114-116.
* `is_summary_total` / `is_year_to_date` on activities — spec 116-118.
* `smsf_classification` / `smsf_evidence` — spec 10-11.
* `activity_fingerprint` / `duplicate_of_activity_id` — spec 52-53.
* `rollover_counterpart_activity_id` — spec 33-35.

## Money

Every money column is `numeric(20,4)`. There is **no** `float`, `real` or
`double precision` column anywhere in the migration — asserted by
`scripts/fdh12_certification.mjs` section 2 against `pg_attribute`.

## Statement period (spec section 50)

`statement_start_date`, `statement_end_date` and `statement_date` are preserved
separately, and activities additionally carry `effective_period_start` /
`effective_period_end` — the pay period the fund says a contribution relates
to, which is distinct from the date the fund credited it. Keeping both is what
lets the payslip reconciliation window be bounded and defensible instead of
requiring same-day equality.

## Privacy (spec sections 87-90)

Not persisted anywhere: TFN, PAN, full member number, address, date of birth,
beneficiary details, bank account details. Asserted mechanically by
`tests/unit/fdh12Isolation.test.ts`.

`masked_account_identifier` carries a masked fragment only, with a CHECK
constraint (`!~ '[0-9]{7,}'`) as a mechanical backstop against a parser
regression, and a matching refusal in the upload route's Zod schema.
