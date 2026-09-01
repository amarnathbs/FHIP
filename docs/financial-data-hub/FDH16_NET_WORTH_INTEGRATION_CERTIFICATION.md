# FDH-16 — Net Worth Integration Certification

**FRESH FDH-16.** Script: `scripts/fdh16_dashboard_engine_live_proof.mjs` (paired with
`fdh16_dashboard_live_proof_setup.mjs`). Result: **8/8 PASS**, live hosted DEV.

## Method

One synthetic AU household created with known values across every domain the real Dashboard reads:
Asset $50,000 (cash), Investment $80,000 (legacy `investments` table), Retirement $200,000 (super),
Liability $30,000 (personal loan), Income $7,000/mo (salary), Expense $2,200/mo (groceries) — every row
inserted via a real authenticated JWT (not service-role), matching the real manual-entry write shape.

The rows were then **re-fetched live from DEV** using the exact same PostgREST queries
`lib/services/dashboardData.ts`'s `loadDashboard()` issues, and fed into the **real, unmodified, imported**
`computeDashboard()` function from `lib/engines/dashboard.ts` (not a hand-rolled reimplementation).

## Independent oracle

```
Net Worth = Assets + Investments + Retirement − Liabilities
          = 50,000 + 80,000 + 200,000 − 30,000
          = $300,000
```

## Result

| Check | Engine output | Oracle | Variance |
|---|---|---|---|
| Net Worth | $300,000 | $300,000 | **$0** |
| Total Assets | $50,000 | $50,000 | **$0** |
| Total Investments | $80,000 | $80,000 | **$0** |
| Total Retirement | $200,000 | $200,000 | **$0** |
| Total Liabilities | $30,000 | $30,000 | **$0** |
| Gross Monthly Income | $7,000 | $7,000 | **$0** |
| Total Monthly Expenses | $2,200 | $2,200 | **$0** |

## Evidence duplication (§55-58)

Zero `fdh_*` evidence rows were ever created for this synthetic user (the fixture is manual-entry-only by
design) — the real `computeDashboard()` output still matched the oracle exactly, confirming the calculation
engine has no implicit dependency on FDH staging tables and cannot double-count evidence that doesn't exist.
Combined with the fresh architecture grep (`FDH16_FULL_INTEGRATION_ARCHITECTURE.md` — 0 `fdh_*` references
anywhere in `lib/engines/**`), this closes §15/§55/§56/§57 for the Dashboard/Net-Worth consumer specifically.

## SMSF duplication (§58)

Not exercised by this fixture (no SMSF fund created). REUSED: FDH-12's SMSF boundary certification (SMSF-looking
statements never auto-apply; `smsf_funds` is a separate table from `retirement_accounts`, and the existing SMSF
module's own summary logic — unchanged by any FDH-16 activity — has not been re-tested fresh this round.

## Cleanup

Every synthetic row plus the `financial_snapshots` row `loadDashboard()`'s own upsert created, plus the auth
user, were deleted at the end; independently re-verified 0 residual `income_sources`/`financial_snapshots` rows
and a 404 on the deleted auth user.

## Verdict

**Net Worth integration: PASS** for the domains exercised (Assets/Investments-legacy-table/Retirement/
Liabilities). AU Investment's real ii_* → published `investments` bridge was not independently re-verified this
round (REUSED — Investment Intelligence R3's own "no double counting" certification).
