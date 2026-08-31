# FDH-16 — Scale and Pagination Certification

## FRESH FDH-16 this round — and a real defect found + fixed

`scripts/fdh16_scale_1000_1001_certification.mjs`, live DEV, real authenticated JWT for all reads.

A raw, unpaginated PostgREST request against this DEV project is confirmed to silently cap results at 1,000 rows
(`content-range: 0-999/1001` at 1,001 total rows — the header proves the server-side truth; the body only
returns 1,000). **`lib/services/dashboardData.ts`'s `loadDashboard()` had no `.range()` on any of its 8 register
queries**, so it inherited this cap silently — a household with more than 1,000 active rows in any one register
would have its Dashboard/Net-Worth/Cashflow totals computed from an incomplete set with no error surfaced. See
`FDH16_RESIDUAL_RISK_REGISTER.md` (FDH16-DEF-001) for the full reproduce → root-cause → fix → regression →
re-proof record.

**Fixed this round.** Live re-proof after the fix: **6/6 PASS** — the real, imported (not reimplemented)
`loadDashboard()`, called with a service-role-backed client for the exact synthetic user, correctly returns
`totalMonthlyExpenses = 1000` at the boundary and `= 1001` one row past it, while the permanent negative control
(`SCALE-1001-NEGATIVE-CONTROL`) continues to demonstrate the raw platform cap exists (proving the test isn't
vacuous — the underlying risk is real, and the fix, not the platform, is what changed).

## REUSED PRIOR CERTIFIED EVIDENCE (other domains, not re-run fresh this round)

- FDH-11's and FDH-14's own prior 1,000/1,001 scale certifications for their respective domains (Investment
  Intelligence repositories, which already had explicit `.range()` pagination via
  `lib/services/investment-intelligence/pagination.ts` — confirmed present, unaffected by this round's fix).
- FDH-8's Transaction Explorer, R8's 200-case certification, R10/R12's own pagination certifications.

## Not performed fresh this round

- 5,000/10,000-row reuse-and-relabel exercise (§167) — not attempted.
- Investment position-list truncation re-check (§171) beyond the REUSED evidence above.
- An exhaustive audit of every remaining list-returning query in the codebase for the same unpaginated-default
  pattern FDH16-DEF-001 exposed in `dashboardData.ts` specifically — `lib/services/reportSnapshotResolver.ts`'s
  queries (read during this round's report-integration check) were **not** re-checked for the identical
  `.range()` gap; this is flagged as a follow-up recommendation, not asserted as safe.

## Verdict

**Scale and pagination: PASS for the boundary freshly tested this round** (Dashboard's 8 register queries, now
fixed and live-re-proven). **Not exhaustively audited across every other list-returning query in the codebase**
— disclosed as a residual/follow-up recommendation in `FDH16_RESIDUAL_RISK_REGISTER.md`, not asserted as a
whole-codebase guarantee.
