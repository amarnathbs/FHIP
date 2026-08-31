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

## Financial Health Score, DNA, Resilience, Twin/Benchmark (§89-96)

**Not independently re-run fresh this round** beyond the architectural source-grep above. No paired manual-vs-
import Score/DNA/Resilience/Twin comparison was executed live this round (would require running these engines
end-to-end for both of this round's synthetic households, which was time-boxed out per
`FDH16_SCOPE_AND_CERTIFICATION_PLAN.md`). Since all four engines are fed exclusively from the same canonical
tables `computeDashboard()` reads (confirmed by the same source grep — no separate FDH-aware code path exists
for any of them), and this round freshly proved those canonical tables reconcile exactly to the manual/import
oracle for Income/Liability/Retirement, the risk of an unexplained source-path-dependent Score/DNA/Resilience/
Twin difference (§90) is assessed as LOW but **not eliminated by direct live proof this round** — disclosed as a
residual, not asserted as PASS.

## Insurance (§97)

Not exercised by any FDH-16 fixture (no insurance evidence path exists in FDH; insurance is manual-entry only,
confirmed by the same `lib/engines` grep showing 0 FDH references in any insurance-consuming code). No defect
risk identified; not independently re-verified live this round.

## Verdict

**Goals: PASS** (source-verified isolation from FDH evidence; linkage logic REUSED, unchanged).
**Scores/DNA/Resilience/Twin/Insurance: PASS where currently implemented, by architectural source-inspection
only** — live numeric parity for a paired manual/import household was **not performed this round** for these
five modules specifically. This is the single largest disclosed scope gap in this certification round and is
carried into `FDH16_RESIDUAL_RISK_REGISTER.md` as a P2 (bounded — the shared canonical-table dependency and this
round's own canonical-accuracy proof make an undiscovered defect here unlikely, but "unlikely" is not "proven").
