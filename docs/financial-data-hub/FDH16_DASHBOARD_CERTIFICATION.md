# FDH-16 — Dashboard Certification

See `FDH16_NET_WORTH_INTEGRATION_CERTIFICATION.md` for the full fresh live-DEV proof (8/8 PASS,
`scripts/fdh16_dashboard_engine_live_proof.mjs`) of Net Worth/Assets/Investments/Retirement/Liabilities/Income/
Expenses reconciling exactly through the real `computeDashboard()` function fed real live-DEV rows.

## Error vs Zero (§104-105, §176)

**Source-verified, fresh this round.** `lib/services/dashboardData.ts`'s `loadDashboard()` issues all nine of
its queries inside a single `Promise.all([...])` with **no `try/catch` swallowing a failure into a default
value** — a rejected query propagates as a thrown error out of `loadDashboard()`, which the calling API route
(`app/api/dashboard/summary/route.ts`) would surface as a 5xx, not a fabricated `$0`/empty dashboard. This was
confirmed by reading the actual function body (reproduced in
`FDH16_FULL_INTEGRATION_ARCHITECTURE.md`'s citation) — not by triggering a live failure (a live fault-injection
test against hosted DEV was not performed this round; see `FDH16_FAILURE_MODE_CERTIFICATION.md`).

## Hosted browser UI smoke — CLOSED this targeted final-closure round (2026-09-01)

The original round's blocker is exactly as previously disclosed: the browser-preview tool's `preview_start`
reads `.claude/launch.json` from `D:/FHIP` (the outer session root), not from this worktree
(`D:/fhip-fdh16`) — confirmed again this round (a first `preview_start` call attached to an unrelated
worktree's own `fdh10-dev` config on port 3000; stopped immediately via `preview_stop`, no navigation
performed, exactly per the prior round's own precedent). **Fix**: added a second, additive entry
(`fdh16-candidate-dev`, `npm --prefix D:/fhip-fdh16 run dev -- -p 3917`) to `D:/FHIP/.claude/launch.json`
alongside the existing `fdh10-dev` entry — the existing entry was not modified or removed, only a new one
added, so no other workstream's tooling was touched. This started a genuinely dedicated dev-server instance
for this exact candidate worktree/commit, on its own port (3917), using this worktree's own `.env.local`.

A synthetic premium-tier AU household was created (income/expenses/assets/liabilities/investments/retirement/
insurance/goals) and used to log in and sweep all 14 required surfaces:

| Surface | Result |
|---|---|
| Dashboard | Loads; all figures (net worth $545,000, monthly surplus $3,200, cash flow, asset allocation, debt analytics, resilience/data-quality tiles) correctly reflect canonical data; 0 console errors; no horizontal overflow at 1440×900 |
| Income / Expenses / Assets / Liabilities / Investments / Retirement | All 6 load cleanly; grid renders every master-item row; 0 console errors |
| Goals | Correctly showed the legitimate empty "Create your first goal" state before a goal existed; after creating one (fixing a fixture bug — a missing required `goal_type` column, not an app defect), correctly rendered real progress figures |
| Scores | Correctly showed the legitimate GATED "not ready yet — 0 of 7 core sections reviewed" state (this synthetic user's data was seeded via API, bypassing the manual "I've reviewed this section" UI confirmation the eligibility gate requires — the underlying score engine itself was separately proven correct via direct loader calls, see `FDH16_DOWNSTREAM_MODULE_CERTIFICATION.md`) |
| DNA / Resilience | Both load with real computed content (DNA: "Property-Focused Investor", 68% confidence; Resilience: 43/100, 97% confidence); 0 console errors |
| Twin / Benchmark | Correctly showed the legitimate empty state, then the real "Generate Financial Twin" primary action was exercised end-to-end (`POST /api/financial-twin/generate` → 200) and rendered a full real comparison (50 metrics compared, strengths/opportunities, confidence 56%) |
| Forecasting | `/forecast` loads cleanly; no overflow |
| Reports | Correctly showed the legitimate empty state, then the real "Generate report" primary action was exercised end-to-end (`POST /api/reports/generate` → 200 in 36s) and produced a real, correctly-computed report, viewable at `/reports/[id]` with the exact same figures as Dashboard/DB |

Per-surface requirements from this round's mandate: route loads (14/14), no fatal runtime error (14/14), no
FDH-specific broken navigation (14/14 — the one 404 encountered was this tester's own incorrect `/twin` URL
guess before finding the real route `/financial-twin`, not an app defect), no error-state rendering as a
zero/empty state (confirmed — every "empty" state seen was a legitimate gated/no-data state, verified by
generating real content and watching it render correctly), no obvious horizontal overflow (checked via
`document.documentElement.scrollWidth` vs `window.innerWidth` at a real 1440×900 viewport on every surface —
0 found), critical primary action keyboard-reachable (spot-checked: Dashboard's "Continue my Financial Picture"
is a real `<a>` with `tabIndex=0`; every other primary action across all 14 surfaces is a semantic
`<button>`/`<a>` element, focusable by default).

One minor, non-blocking finding: the Reports list page's own client cache did not refresh immediately after a
successful "Generate report" — the new report appeared only after a manual page reload/navigation, even though
the underlying generation succeeded correctly (confirmed via the API response body). Not a data-integrity issue
(the report itself was correct once visible); disclosed as a new P3 UX-polish item in
`FDH16_RESIDUAL_RISK_REGISTER.md`.

All synthetic UI-smoke data (10 tables plus the auth user) independently re-verified at 0 residual after
teardown (auth-user re-fetch returned 404; every canonical/derived table returned 0 rows for this user id).

**REUSED, for context only, superseded by the above**: FDH-14's own Playwright-based UI/accessibility smoke
(`tests/e2e/fdh14-ui-accessibility-smoke.spec.ts`, 5/5 surfaces PASS) remains valid but is no longer the most
recent hosted-browser evidence for this candidate.

## Verdict

**Dashboard: PASS at the calculation-engine/data-integrity level** (fresh, live, real function, real rows).
**Hosted-browser rendering: PASS** — fresh, full 14-surface smoke on this exact candidate's own dedicated dev
server this closure round, closing the prior round's disclosed residual.
