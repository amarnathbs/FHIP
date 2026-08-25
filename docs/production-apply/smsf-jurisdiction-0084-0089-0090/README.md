# Production apply package: SMSF Summary/Detailed Holdings + Jurisdiction Applicability (0084/0089/0090)

Prepared by an agent with **no ability to execute SQL against production** and
**no authorization to push to `origin/main`**. Everything in this folder is
for a human to run. Nothing here has been applied to production.

## Ledger (confirmed 2026-08-26 via read-only anon-key REST probes with negative controls against `app.financialhealthplatform.com`'s live production Supabase, `scripts/smsf_production_readonly_schema_check.mjs`)

| Migration | DEV status | Production status | Action needed |
|---|---|---|---|
| `0084_geo_jurisdiction_smsf.sql` | Applied, live-verified (73/73 cert) | **NOT applied** (tables/column/functions absent, confirmed via PGRST205/42703/PGRST202 against negative controls) | Apply `01_0084_geo_jurisdiction_smsf.sql` |
| `0089_smsf_switch_to_summary.sql` (formerly `0087`, renumbered — see file header) | Applied, live-verified | **NOT applied** (`smsf_switch_to_summary` RPC absent) | Apply `02_0089_smsf_switch_to_summary.sql` after 0084 |
| `0090_smsf_current_balance_integrity_guard.sql` | Applied, live-verified (8/8 live-DEV) | **NOT applied** (`retirement_accounts_smsf_balance_guard` absent) | Apply `03_0090_smsf_current_balance_integrity_guard.sql` after 0089 |

Prerequisite `0078_property_liability_linking.sql` **is already present** in
production (confirmed: `property_liability_links` table returns HTTP 200),
so 0084 has no missing dependency and can be applied as-is.

## How to apply

1. Open the production Supabase project's SQL Editor.
2. Run `01_0084_geo_jurisdiction_smsf.sql` in full. It is self-contained
   (`begin; ... commit;`) and idempotent (`IF NOT EXISTS` / `OR REPLACE` /
   `ON CONFLICT DO NOTHING` throughout, per its own header).
3. Run `02_0089_smsf_switch_to_summary.sql`.
4. Run `03_0090_smsf_current_balance_integrity_guard.sql`.
5. Run `04_production_verification.sql` (Part A first — read-only; Part B
   second — self-cleaning, wrapped in a transaction that always rolls back).
   Paste the full output back.
6. Optionally also run `node scripts/smsf_production_readonly_schema_check.mjs`
   from the `smsf-ui-completion` branch as an independent cross-check —
   every line should flip from FAIL (absent) to PASS (present) except the
   negative-control lines, which should stay PASS either way.

## What was and was not verified by the agent

- **Verified (read-only, anon-key REST, negative-controlled):** current
  absence of all three migrations' schema objects in production; presence
  of the 0078 prerequisite.
- **NOT performed by the agent — requires human execution:**
  - Actually applying `01`/`02`/`03`.
  - The live behavioural checks in `04_production_verification.sql` Part B
    (the 0090 guard's rejection behaviour under a real INSERT/UPDATE, and
    the AU/IN jurisdiction gate under a real INSERT) — these require
    mutating statements against production, which is outside the agent's
    authorization and technical ability in this environment. The script
    is self-cleaning (rolls back its own transaction) but must be run by a
    human.
