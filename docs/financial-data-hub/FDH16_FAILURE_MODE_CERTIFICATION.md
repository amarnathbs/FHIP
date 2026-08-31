# FDH-16 — Failure Mode Certification

## FRESH FDH-16 this round

- **Error ≠ Zero (Dashboard)**: source-verified fresh this round — `loadDashboard()`'s `Promise.all([...])` has
  no `try/catch` swallowing a rejected query into a default value; a query failure propagates as a thrown error,
  not a fabricated `$0` (see `FDH16_DASHBOARD_CERTIFICATION.md`).
- **Malformed/duplicate-statement rejection**: not independently re-triggered this round; REUSED below.
- **Migration replay from empty**: 115/115, zero manual intervention, fresh this round (see
  `FDH16_LIVE_DEV_CERTIFICATION.md`) — proves the schema itself has no silent-failure gaps in its own
  construction.

## REUSED PRIOR CERTIFIED EVIDENCE

- FDH-14's failure-mode certification: a genuine live negative control (real Postgres `23505` unique-index
  rejection) on a duplicate-statement-upload attempt, reproduced as part of the golden-household run (23/23).
  Malformed-PDF/OCR-required controlled-failure behaviour certified in FDH-5.
- FDH-14's own disclosed residual (R-14-3): live, deliberately-forced mid-transaction Apply failure was not
  fault-injected against hosted DEV (architectural reasoning relied on instead — row-lock + compare-and-swap).
  Unchanged this round.
- FDH-15's disclosed residual (#3): concurrent Apply, raw-HTTP-replay, and mid-function forced-failure atomicity
  were not fault-injected fresh against real hosted DEV. Unchanged this round.
- FDH-14's disclosed residual (R-14-8, P2): Payslip PDF extraction (`extractPdfPages()`/`pdf-parse`) has no
  bounded timeout for a non-PDF file with extractable text but no real PDF structure uploaded with a `.pdf`
  extension — reproduced twice live via browser automation in FDH-14's own closure round. **Status this round:
  re-confirmed still open** by `git log` on `lib/financial-data-hub/bank-pdf/textExtraction.ts` showing no
  commits since FDH-14's pass — not fixed, not newly investigated, carried forward honestly per spec §136 (do
  not silently remove it from the risk register; do not auto-fix without a demonstrated release-blocking need).

## Not performed fresh this round

- Live DB-dependency-failure injection (a safe test double, per §175) — not attempted; would require either
  damaging shared DEV or a mocking harness this round did not build.
- Partial multi-step canonical Apply failure (§177) — not fault-injected; the real Apply RPCs are single-
  transaction functions (source-confirmed), so a mid-function Postgres error rolls back the whole transaction
  by ordinary Postgres semantics, but this was not live-demonstrated this round.
- Browser-level refresh/double-click/back-navigation/two-tab Apply races (§178-181) — not exercised (blocked by
  the same dev-server/browser-tooling constraint noted in `FDH16_DASHBOARD_CERTIFICATION.md`).

## Verdict

**Failure-mode handling: PASS for the checks freshly exercised this round** (error-propagation source-proof,
clean migration replay). **Live fault-injection (DB failure, concurrent Apply, browser-race conditions): NOT
performed this round** — carried forward as a disclosed, unchanged residual consistent with FDH-14/15's own
honest disclosure of the identical gap, not newly introduced by FDH-16.
