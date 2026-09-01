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

## CLOSED this targeted final-closure round (2026-09-01)

- **Genuine concurrent Apply, live hosted DEV** (`scripts/fdh16_concurrent_apply_certification.mjs`, 10/10
  PASS): a real synthetic user, a real `'ready'` income proposal, and two literally-simultaneous
  (`Promise.all`, same tick, identical parameters) authenticated `fdh9_apply_income_proposal` RPC calls against
  real hosted DEV. Result: exactly one call succeeded (`ok:true`), the other was rejected `ALREADY_APPLIED` by
  the row-lock + compare-and-swap mechanism (not silently duplicated) — ground truth re-query confirms exactly
  1 `fhip_import_applications` row and exactly 1 canonical `income_sources` row at the correct amount. This is
  the first FDH round to fault-inject a genuine two-in-flight race against real hosted DEV rather than relying
  on architectural reasoning alone; FDH-15's own `FDH15_IDEMPOTENCY_AND_CONCURRENCY_CERTIFICATION.md` explicitly
  disclosed this had never been done. Cleanup independently re-verified at 0 residual rows.
- **DB fault injection — isolated deterministic test double, run fresh** (`tests/unit/aiResidualClosureFailClosed.test.ts`):
  this Module 11.0 test exercises the real `buildFinancialContextObject()` -> real Module 1-10 loaders ->
  real `AIContextCertificationService` -> real `AIModelGateway` path above a controllable in-memory
  database-failure double (`tests/unit/support/fakeSupabaseClient.ts`, total outage / partial outage / fail-open
  negative control). Running it fresh against this candidate found a genuine regression (not fail-open — see
  below) introduced by FDH16-DEF-001's own fix; fixed in the same pass; 17/18 now pass (1 disclosed benign
  residual, a stale write-count assumption in the negative-control test, explained below and in
  `FDH16_RESIDUAL_RISK_REGISTER.md`). No evidence of fail-open behaviour was found anywhere in this sweep — the
  regression this round found and fixed made the system MORE conservative (an uncaught crash, still fail-closed
  end-to-end via both real callers' own try/catch), not less. Per this round's own instructions: "Shared-DEV
  destructive DB outage: NOT ATTEMPTED — BY DESIGN. Controlled DB failure behaviour: covered by isolated/prior
  certified evidence" — now literally true, freshly re-run rather than merely asserted.

### The regression found and fixed this round (not FDH16-DEF-001, a second, smaller defect)

`lib/ai/context/financialContextObject.ts`'s `buildFinancialContextObject()` calls `loadDashboard()` at one
point completely unguarded (unlike its sibling calls to `loadHealthScore`/`loadFinancialDna`/`loadResilience`/
`computeGoalsPagePayload`, each wrapped in its own `try/catch`). FDH16-DEF-001's `fetchAllRows()` fix made
`loadDashboard()`'s register queries **throw** on a PostgREST read error (the correct behaviour — no more silent
truncation), where the pre-fix unpaginated queries never threw at all (they coalesced a failed read to `data ??
[]`). Once thrown here, `buildFinancialContextObject()` rejected uncaught, well before its own
`integrity.readFailures`-driven fail-closed gate (`buildSourceFailureContext()`) ever got a chance to run —
bypassing Module 11.0's designed INVALID/PARTIAL/CERTIFIED contract entirely. Confirmed live: 10-11 of 18 tests
in `tests/unit/aiResidualClosureFailClosed.test.ts` failed with an uncaught `"terminating connection due to
administrator command"` error instead of the expected structured `INVALID` context object; a fresh baseline run
on `origin/main` (pre-FDH16-DEF-001) passed all 18/18, confirming this was newly introduced by FDH-16's own
Dashboard/Report pagination fix, not pre-existing. **Not previously a live fail-open** — the two real callers of
this function (`app/api/internal/ai/context/{validate,preview}/route.ts`) both already wrap it in their own
try/catch and return a 500 either way, so no fabricated data or unauthorised provider call was ever reachable —
but the internal per-domain-INVALID contract this file exists to provide was broken for this specific failure
class. **Fix**: wrapped the `loadDashboard()` call in the same try/catch pattern as its siblings, falling back
to an explicit, well-typed all-empty `DashboardSummary` (via `computeDashboard()` over empty registers — never a
hand-rolled literal) on failure; the pre-existing `integrity.readFailures.length > 0` gate (populated
independently by `certifiedSourceClient`'s read-observing wrapper, regardless of whether `loadDashboard()`
itself throws) still fires correctly and returns the fail-closed `buildSourceFailureContext()` before the
fallback dashboard is ever used for anything a provider could see. Regression: `tsc` 0 errors;
`tests/unit/aiResidualClosureFailClosed.test.ts` 17/18 (up from a pre-fix low of 7-8/18, non-deterministic
partial failure depending on module-cache/test-order).

One residual assertion remains disclosed, not fixed: test `A4` (negative control) also asserts
`canonicalWrites(h).length > 0` — this specific incidental assertion no longer holds, because
`loadDashboard()`'s own end-of-function `financial_snapshots` upsert is now unreachable one step earlier
(the `Promise.all` housing its register queries rejects before reaching the upsert) even with the
certification gate deliberately bypassed for this negative control. The negative control's actual purpose —
proving an ungated database outage still reaches the provider and returns `PARTIAL` — is unaffected and still
passes (`ctx.meta.certification_status === 'PARTIAL'` and the provider-call spy assertion both pass); only the
incidental "…and it also wrote data" appendix assertion is now stale, because the real-world behaviour it
checks for is now **strictly safer** than when that test was written (one more failure mode — the stray
snapshot write — is now unreachable one layer earlier, not less safe). This is a Module 11.0-owned test file;
per this round's scope boundary (do not reopen another completed module's certification), the test itself was
not edited — disclosed here and in `FDH16_RESIDUAL_RISK_REGISTER.md` as a known, narrow, non-blocking test-
fixture staleness, not a live defect.

## Not performed fresh this round

- Partial multi-step canonical Apply failure (§177) — not fault-injected; the real Apply RPCs are single-
  transaction functions (source-confirmed), so a mid-function Postgres error rolls back the whole transaction
  by ordinary Postgres semantics, but this was not live-demonstrated this round.
- Browser-level refresh/double-click/back-navigation/two-tab Apply races (§178-181) — not exercised. A genuine
  two-in-flight-simultaneous concurrent Apply WAS exercised this closure round (see above) — this residual is
  narrowed to specifically browser-driven multi-tab/double-click races, not concurrency in general.
- Live destructive shared-DEV DB-outage injection: **NOT ATTEMPTED — BY DESIGN** (would require damaging shared
  DEV infrastructure, out of scope per §61/§74 and this closure round's own explicit instruction). Controlled
  DB-failure behaviour is covered instead by the isolated test double above, run fresh this round.

## Verdict

**Failure-mode handling: PASS.** Error-propagation source-proof and clean migration replay (unchanged from the
original round); genuine concurrent-Apply race-condition fault injection against real hosted DEV (fresh, closed
this round, 10/10 PASS); isolated deterministic DB-fault-injection test double re-run fresh (17/18, one
regression found+fixed, one disclosed benign residual, zero fail-open evidence found). Only browser-driven
multi-tab races and live destructive shared-DEV outage injection remain un-exercised, both by deliberate design
consistent with every prior FDH round's own disclosed scope boundary.
