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

## CLOSED this targeted final-closure round (2026-09-01): report resolver's own 1,001-row boundary, directly

The report resolver follow-up flagged above is now closed by direct reproduction, not source-inspection.
`scripts/fdh16_report_resolver_scale_certification.mjs`, live hosted DEV: created a premium-tier synthetic user
with 1,000 then 1,001 `expense_items` rows; reproduced the same permanent negative control (raw PostgREST
capped at 1,000 of 1,001, `content-range` proves it); then called the REAL `resolveReportSourceData()` directly
(imported, never reimplemented) at both boundaries. `premium.expenseItems.length`/economic total correctly read
`1000` then `1001` — not silently truncated. The same boundary was also reproduced for a second register,
`investments` -> `premium.investments`, in the same run. **12/13 PASS** (the one non-decisive failure was a
transient auth-admin-API eventual-consistency artifact in cleanup verification, independently resolved and
re-confirmed — see `FDH16_RESIDUAL_RISK_REGISTER.md`). Full detail in `FDH16_REPORT_INTEGRATION_CERTIFICATION.md`.

## 5,000/10,000-row scale — REUSED PRIOR CERTIFIED EVIDENCE (this label applied per this round's own instruction)

Not re-run this closure round, per explicit instruction: reuse unless code affecting those paths changed since
the evidence was produced. The only files this branch has touched, across both rounds, are
`lib/services/dashboardData.ts` and `lib/services/reportSnapshotResolver.ts` (confirmed via `git diff
origin/main..HEAD --stat` — exactly these two files, nothing else). The 5,000/10,000-row evidence cited in
`FDH16_SCALE_AND_PAGINATION_CERTIFICATION.md`'s original pass (FDH-11/FDH-14's Investment Intelligence
repositories via `lib/services/investment-intelligence/pagination.ts`, and FDH-8/R8/R10/R12's own pagination
certifications) lives entirely outside those two touched files — confirmed unaffected. **REUSED PRIOR CERTIFIED
EVIDENCE.** The 1,000→1,001 boundary (both Dashboard and, as of this closure round, the Report resolver) remains
the decisive live pagination proof for the one defect class this branch actually changed.

## Not performed fresh this round

- Investment position-list truncation re-check (§171) beyond the REUSED evidence above.
- An exhaustive audit of every remaining list-returning query in the codebase for the same unpaginated-default
  pattern FDH16-DEF-001 exposed — beyond the two files this branch actually touched (`dashboardData.ts`,
  `reportSnapshotResolver.ts`, both now fixed and live-proven), no whole-codebase sweep for a THIRD unrelated
  instance of the same pattern was performed; flagged as a standing follow-up recommendation, not asserted as
  safe beyond these two files.

## Verdict

**Scale and pagination: PASS.** Both files this branch actually modified (Dashboard's 8 register queries, and
the Report resolver's 6 Premium queries) are now fixed and live-re-proven at the decisive 1,000→1,001 boundary —
the report resolver by direct reproduction this closure round, no longer by source-inspection alone.
5,000/10,000-row scale REUSED and confirmed unaffected by this branch's diff. **Not exhaustively audited across
every OTHER list-returning query in the codebase** beyond the two files this branch touched — disclosed as a
standing residual/follow-up recommendation, not asserted as a whole-codebase guarantee.
