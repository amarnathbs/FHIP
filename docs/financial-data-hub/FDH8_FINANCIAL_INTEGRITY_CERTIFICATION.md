# FDH-8 — Financial Integrity Certification

Two independent certification instruments, both actually executed in this session (not simulated, not hand-summarised from a subagent's self-report):

1. `tests/unit/fdh8FinancialIntegrityCertification.test.ts` — pure-function oracle certification (vitest, same style/precedent as `tests/unit/fdh7ApprovedSummaryOracle.test.ts`), exercising `computeApprovedFinancialSummary` with fixtures hand-built from the spec's own worked examples.
2. `scripts/fdh8_certification.mjs` — PGlite (real Postgres, all 77 migrations replayed fresh) DB-level certification, exercising the exact SQL shape `financialActivityAnalytics.ts` issues, with real RLS enforcement via `set role authenticated` + JWT claims (same pattern as `scripts/fdh7_certification.mjs`/`scripts/r8_security_certification.mjs`).

## Instrument 1 — vitest oracle certification: 26/26 PASS

```
$ npx vitest run tests/unit/fdh8FinancialIntegrityCertification.test.ts
 Test Files  1 passed (1)
      Tests  26 passed (26)
   Duration  33.53s
```

Scenarios certified, each with the spec's own exact expected numbers AND a same-block negative control proving the assertion is not vacuous:

| Scenario | Spec worked example | Result |
|---|---|---|
| Transfer | Income 5000, Expense 2500, Net 2500, Transfer 1000 (not 6000/3500) | PASS — negative control reproduces the forbidden $3,500 if transfer were miscounted as expense |
| Duplicate | $100 not $200 | PASS — negative control shows naive summation gives $200 |
| Split | $300 = $220+$80, not $600 | PASS — negative control shows parent+children double-count gives $600 |
| Refund | Nets against expense only, never income | PASS |
| Cash withdrawal | ATM -$500 must not inflate expense | PASS |
| Loan proceeds | +$25,000 must not inflate income | PASS |
| Investment funding | -$5,000 must not inflate ordinary expense | PASS |
| **Pending review (PO's critical requirement)** | approved=$1,000 default, pending=$250 separate, never $1,250; spec-12 example $4,250+$180 never $4,430 | **PASS** — see `FDH8_APPROVED_ACTIVITY_MODEL.md` for the full negative-control writeup |
| Naive currency addition | AUD/INR must never be summed | PASS — negative control shows the meaningless "200" a naive sum would produce |
| Pagination >1000 truncation | 1,001 approved transactions must sum exactly, not truncate at 1,000 | PASS — negative control shows the wrong $1,000 a truncating caller would compute |
| Period comparison zero-denominator | previous=0/current=500 → null %, "New spending" label, never Infinity/NaN | PASS, 6 sub-cases incl. both-zero, equal, increase, decrease |
| Period resolution | leap year Feb 29, year boundary (Jan → prior Dec), custom-range from>to rejection, day-of-month clamping (Mar 31 − 1mo → Feb 28) | PASS |
| Timezone safety | period boundaries derived from ISO calendar dates only, no `Date`-object/timezone arithmetic | PASS |

## Instrument 2 — PGlite DB-level certification: 12/12 PASS

```
$ node scripts/fdh8_certification.mjs
=== SECTION 1: approved vs pending — the query FDH-8 actually issues ===
  PASS  approved-scoped query returns exactly the $4,250 approved row
  PASS  pending-scoped query returns exactly the $180 pending row
  PASS  the two scoped queries never share a row
  PASS  NEGATIVE CONTROL — dropping approval_status filter WOULD merge pending into the total ($4,430, the exact forbidden number, spec 12)
  PASS  the correctly-scoped approved total ($4,250) differs from the unscoped negative control ($4,430)

=== SECTION 2: tenant isolation (RLS) for FDH-8 activity queries ===
  PASS  Tenant A querying with a forged Tenant-B account_id gets zero rows (server derives user_id, RLS blocks the rest)
  PASS  RLS alone (no app-layer user_id filter) still blocks Tenant A from Tenant B's account
  PASS  Tenant A cannot read Tenant B's account row directly by forged id
  PASS  control: Tenant B genuinely can see their own account's transaction (RLS is not blocking everything)

=== SECTION 3: scale — 1,001 approved transactions ===
  PASS  exact count() at 1,001 rows is 1,001, not capped at 1,000
  PASS  keyset pagination walk across the 1,001-row set collects all 1,001 ids with zero duplicates/gaps (collected 1001 across 3 pages)
  PASS  exact sum at 1,001 rows is $1,001.00

=== FDH-8 DB Certification: 12 PASS, 0 FAIL ===
```

This is a genuine live-Postgres run (PGlite executes real Postgres SQL, including RLS policy evaluation) with every migration file in `supabase/migrations/` replayed from scratch — not a mock, not a hand-simulation.

## What is NOT certified by these two instruments (honest disclosure)

- **Real Supabase DEV project.** This worktree has no `.env.local` / DEV Supabase credentials (confirmed: `ls .env*` shows only `.env.example`). PGlite is a real-Postgres substitute for schema/RLS/query-shape correctness, but it is not the actual hosted DEV database FDH-7 was previously certified against. This exact same gap was disclosed for FDH-7 (`scripts/fdh7_certification.mjs`'s own header: "no live DEV DDL credential exists in this environment"). See `FDH8_LIVE_DEV_CERTIFICATION.md` for the honest ceiling this implies.
- **Category-percentage / merchant-ranking / trend bucketing** are certified by code-reading + the `tsc`/build pass (they are straightforward groupings over already-certified totals — see `FDH8_REUSE_AND_GAP_AUDIT.md`'s "NEW UX-ANALYTICS" rows) rather than by a dedicated oracle fixture set the way the headline totals are. This is a smaller-stakes surface than the approved/pending boundary (nothing here can silently promote an unapproved transaction into a total), and is disclosed as an Open Residual rather than claimed as fully oracle-certified.
- **100+ user / full scenario-matrix scale dataset** (spec 85) — the certification above proves correctness AT 1,001 rows (the specific class of bug spec 96/153 calls out — silent truncation past 1,000) and proves the four hardest financial scenarios individually; it does not run a combined 100-user, every-scenario-simultaneously synthetic dataset. Disclosed as an Open Residual.

## FAIL conditions checked (spec 154) — all clear

- ❌→cleared: pending/unapproved transactions silently enter approved totals — negative control proves the opposite.
- ❌→cleared: transfers inflate income/expense — negative control proves the opposite.
- ❌→cleared: duplicates double-count — negative control proves the opposite.
- ❌→cleared: splits double-count — negative control proves the opposite.
- ❌→cleared: refunds inconsistent with FDH-7 — same function, byte-identical semantics.
- ❌→cleared: loan proceeds become income — certified.
- ❌→cleared: investment funding becomes ordinary expense — certified.
- ❌→cleared: cash withdrawals automatically become consumer expense — certified.
- ❌→cleared: different currencies naively summed — certified, and structurally impossible (`CurrencyTotals[]` is always an array keyed by currency; nothing in the codebase adds across array entries).
- ❌→cleared: unsafe floating point for financial totals — `toMinorUnits`/`fromMinorUnits`/`sumMoney` used exclusively; zero `reduce((x,t)=>x+Number(t.amount),0)` occurrences in `financialActivityAnalytics.ts` (grep-verified).
- ❌→cleared: 1,000 rows silently truncate — certified at 1,001 rows via both count() and a real keyset pagination walk.
- ❌→cleared: Tenant B can access Tenant A analytics — certified via forged-filter negative control, including the case where the app-layer `user_id` predicate is entirely absent and RLS alone must hold the line.
