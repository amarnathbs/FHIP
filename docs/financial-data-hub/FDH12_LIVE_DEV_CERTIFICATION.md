# FDH-12 — Live DEV Certification

Spec sections 119-134, 166-167, 171.

## STATUS: BLOCKED — migration 0111 is not applied to DEV

This is the expected state, not a failure. This project's standing convention
is explicit:

> Never apply any migration to DEV or production yourself. Certify fully in
> PGlite first, then hand the exact migration file to the Product Owner to
> apply manually via the Supabase SQL Editor. Only after they confirm
> application should you do live-DEV verification.

`supabase/migrations/0111_fdh12_retirement_statement_intelligence.sql` is ready
and fully certified in PGlite. It has **not** been applied.

## What WAS verified live, today

Against the real hosted DEV Supabase, via PostgREST OpenAPI introspection and
authenticated REST probing.

### 1. Baseline — 0111 is genuinely not applied

| Table | Live DEV |
| --- | --- |
| `fdh_retirement_statements` | **ABSENT** |
| `fdh_retirement_statement_activities` | **ABSENT** |
| `fdh_retirement_statement_positions` | **ABSENT** |

207 tables are exposed; none of FDH-12's three. This is stated as evidence that
no migration was applied by the implementer.

### 2. Every canonical assumption FDH-12 depends on, confirmed against reality

| Table | Live | Note |
| --- | --- | --- |
| `retirement_accounts` | present | Columns confirmed exactly as the audit assumed, including `current_balance`, `employer_contribution`, `personal_contribution`, `contribution_frequency`, `master_item_key`, `retirement_member_id`, `owner`, `source_type`, `target_retirement_age`. |
| `retirement_members` | present | |
| `smsf_funds` | present | |
| `fhip_import_proposals` | present | Confirmed to carry `source_payroll_event_id` and `source_liability_statement_id` but **not** `source_retirement_statement_id` — consistent with 0111 being unapplied. |
| `fdh_payroll_events` | present | |
| `fdh_transactions` | present | **`currency_original` = true, `currency_code` = false, `description_clean` = true.** |

That last row is significant: it **independently confirms against real hosted
Postgres** the defect the PGlite harness caught, where FDH-12's bank-matching
layer had originally typed the columns as `currency_code` and
`description_original`. The fix is verified against the live schema, not only
against a local rebuild.

`retirement_accounts` live also lacks `last_import_application_id` and
`last_imported_at`, which 0111 adds — again consistent.

### 3. Live RLS behavioural probes on the canonical tables FDH-12 reads

| Probe | Expected | Actual |
| --- | --- | --- |
| ANON read `retirement_accounts` | no rows | `200 []` |
| ANON read `retirement_members` | no rows | `200 []` |
| ANON read `smsf_funds` | no rows | `200 []` |
| ANON read `fhip_import_proposals` | no rows | `200 []` |
| ANON write `retirement_accounts` | refused | `401` / `42501` |
| **POSITIVE CONTROL:** service-role read `retirement_accounts` | rows | `200` with a real row id |

The positive control matters: it proves the empty anon results are genuine RLS
filtering rather than a wrong URL or an empty table.

## What is PENDING the migration (spec 119-134)

Every item below is written, tested against real Postgres in PGlite, and
waiting only on 0111 reaching DEV. None is claimed as passed.

| Spec | Scenario | Status |
| --- | --- | --- |
| 119 | Full AU journey on hosted DEV with a synthetic user | **PENDING** |
| 120 | Live employer contribution $1,000 + $1,000 = $1,000 | **PENDING** (PGlite + unit: PASS) |
| 121 | Live personal contribution, expense $0 | **PENDING** (structural: PASS) |
| 122 | Live rollover, income $0 / expense $0 / net worth +$0 | **PENDING** (structural + unit: PASS) |
| 123 | Live fee $100 reduces balance, no cash expense | **PENDING** (structural: PASS) |
| 124 | Live insurance premium $75, no duplicate expense | **PENDING** (structural: PASS) |
| 125 | Live earnings $5,000, no bank income event | **PENDING** (unit: PASS) |
| 126 | Live withdrawal matched as one event | **PENDING** (unit: PASS) |
| 127 | Live reconciliation to $113,500 → RECONCILED | **PENDING** (unit: PASS) |
| 128 | Live $113,500.01 → VARIANCE | **PENDING** (unit: PASS) |
| 129 | Canonical unchanged until Apply | **PENDING** (PGlite: PASS) |
| 130 | Live duplicate statement, 0 duplicates | **PENDING** (unit + PGlite index: PASS) |
| 131 | Live overlapping periods, 0 duplicates | **PENDING** (unit: PASS) |
| 132 | Live wrong-account control | **PENDING** (unit: PASS) |
| 133 | Live cross-tenant A/B | **PENDING** (PGlite: PASS, 8 controls) |
| 134 | Live same-tenant forgery | **PENDING** (PGlite: PASS, 6 controls + 2 positive) |
| 139 | Live 1000/1001 pagination boundary | **PENDING** (fake-pager + PGlite: PASS) |
| 137 | Live SMSF routing | **PENDING** (unit + PGlite: PASS) |

## DEV cleanup (spec 171)

**Nothing to clean.** No synthetic user, document, retirement statement,
activity, match record, proposal, application, retirement account, bank fixture
or payslip fixture was created in DEV, because no FDH-12 table exists there
and no live journey was run. Re-verified by the introspection above: FDH-12's
three tables are ABSENT.

No pre-existing shared DEV data was touched. The only DEV interactions in this
phase were read-only introspection and the RLS probes listed above — the single
write attempt was the ANON insert, which was correctly refused by the database.

## To unblock

1. Product Owner applies
   `supabase/migrations/0111_fdh12_retirement_statement_intelligence.sql`
   via the Supabase SQL Editor (DEV only).
2. Confirm application.
3. Live-DEV certification then runs: schema verification (spec 167), the full
   AU journey (119-132), cross-tenant and forgery probing (133-134), the
   1000/1001 boundary (139), and DEV cleanup with independent re-query (171).
