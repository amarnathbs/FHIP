# FDH-16 — Downstream Module Certification (Goals, Scores, DNA, Resilience, Twin, Insurance)

## FRESH FDH-16 (source-level, whole-codebase)

`grep -rln "fdh_" lib/engines` returned **zero matches**. This directory contains the Score, DNA, Resilience,
Twin/Benchmark, Goals, and Forecast engines. This is a fresh, whole-codebase, source-verified confirmation that
**none of these modules read any FDH staging table directly** — they can only consume canonical data
(`income_sources`, `assets`, `liabilities`, `investments`, `retirement_accounts`, `user_goals`, etc.), which
directly satisfies spec §84 ("Goals Cannot Read FDH Evidence Directly") and generalises the same guarantee to
Scores/DNA/Resilience/Twin (§89-96) and Forecasting (§85-88) in one pass.

## Goals ↔ Investment linkage (§82-83)

Not independently re-tested fresh this round. REUSED: Investment Intelligence's Education/Goal linkage
certification (migrations `0093`/`0095`, goal-funding-sources authoritative-forgery hotfix already applied) and
the Goal Linkage production closure (migration `0093` closed in production 2026-08-27, live API-level allocation-
cap test already run by the Product Owner). No FDH-16 activity touched investment-value-update or goal-funding-
recomputation code, so this evidence is unchanged and current.

## Financial Health Score, DNA, Resilience, Twin/Benchmark, Forecasting (§89-96) — CLOSED this targeted final-closure round (2026-09-01)

Live paired manual-vs-import numeric parity now performed fresh, closing the single largest disclosed gap from
the original round. `scripts/fdh16_downstream_parity_and_report_certification.mjs` built Household M (manual,
direct authenticated inserts) and Household I (FDH import, real Apply RPCs — `fdh9_apply_income_proposal`/
`fdh10_apply_liability_proposal`/`fdh12_apply_retirement_proposal`) with IDENTICAL economic facts, then called
each engine's REAL loader directly (never a reimplementation) for both households:

| Engine | Result |
|---|---|
| Financial Health Score (`loadHealthScore`) | M and I: `overallScore=67.86`, `roundedScore=68` — **identical** |
| Resilience (`loadResilience`) | M and I: `roundedScore=41` — **identical** |
| Financial DNA (`loadFinancialDna`) | M and I: `status=indicative`, `primaryScore=99.12`, `primaryProfileCode=future_ready_professional` — **identical**; both reached a scored (non-`insufficient_data`) status |
| Financial Twin (`generateFinancialTwin`) | M and I: both resolved `status:'ok'`; `gross_household_income` and `net_household_income` metric `userValue` both `96000` — **identical** |
| Forecasting (`runForecast('net_worth')` + `getForecastRunDetail`) | M and I: both produced a `completed` run with baseline (period-0 `opening_value`) net worth `180000` — **identical** |

**28/28 PASS** (this table's 12 checks plus the report-parity checks in the same script, all in one run). An
anti-vacuity check confirmed the two households really did take different code paths despite matching numbers:
`income_sources.source_type` legitimately differs (`manual` vs `payslip_import`) — the one and only legitimate
difference found, exactly as required ("provenance, confidence, or verification status" differences are
expected and explained, not silently accepted; every other field matched exactly). Synthetic data (both
households, all engine-derived rows) independently re-verified at 0 residual after cleanup.

This closes the risk this section previously assessed as "LOW but not eliminated by direct live proof" — it is
now eliminated by direct live proof, for all five engines named in this round's mandate.

## Insurance (§97)

Not exercised by any FDH-16 fixture (no insurance evidence path exists in FDH; insurance is manual-entry only,
confirmed by the same `lib/engines` grep showing 0 FDH references in any insurance-consuming code). No defect
risk identified; not independently re-verified live this round.

## Verdict

**Goals: PASS** (source-verified isolation from FDH evidence; linkage logic REUSED, unchanged).
**Financial Health Score/Resilience/DNA/Twin/Forecasting: PASS**, closed with fresh live numeric parity this
closure round (28/28 PASS, $0 unexplained variance, one legitimate provenance-only difference correctly
identified and explained) — no longer architectural-source-inspection-only. **Insurance: PASS by architectural
source-inspection only** (no FDH evidence path exists for this domain; not independently live-tested, low risk,
unchanged from the original round).
