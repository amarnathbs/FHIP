# FDH-16 — Scale and Pagination Certification

## REUSED PRIOR CERTIFIED EVIDENCE (not re-run fresh this round — time-boxed, disclosed)

- FDH-11's scale certification and FDH-14's scale certification both previously proved representative
  1,000/1,001-row boundary retrieval completeness for their respective domains.
- FDH-8's Transaction Explorer, R8's 200-case certification, and R10/R12's own pagination certifications
  (`scripts/r10_nc7_pagination.mjs`, `scripts/ii-r5-certification/*`) exist as permanent, re-runnable artefacts
  in this repository.

## FRESH FDH-16 (source-level only)

A grep for pagination helpers found: `lib/services/investment-intelligence/pagination.ts`,
`portfolioAttribution.ts`, `reviewCentreData.ts`, `lib/services/recommendationsData.ts`, and
`app/api/admin/recommendations/route.ts` — confirming dedicated pagination/`.range()` logic exists for
Investment Intelligence and Admin recommendation listings specifically. This round did not exhaustively audit
every list-returning query in the codebase for an unbounded default `.limit()`/1,000-row PostgREST cap (out of
time-box).

## Not performed fresh this round

- A fresh 1,000/1,001-row boundary retrieval test for Income/Liability/Retirement/Dashboard (this round's own
  fixtures used single-digit row counts per domain, not scale fixtures).
- 5,000/10,000-row reuse-and-relabel exercise (§167) was not attempted; no scale artefact from a directly
  comparable prior round was re-run and re-labelled this round.
- Investment position-list truncation re-check (§171).

## Verdict

**Scale and pagination: NOT INDEPENDENTLY RE-VERIFIED THIS ROUND.** Prior certified evidence (FDH-11/FDH-14)
is REUSED and not contradicted by anything found this round, but no fresh 1,000/1,001 boundary proof was
produced for FDH-16 itself. Disclosed as a residual in `FDH16_RESIDUAL_RISK_REGISTER.md` — this is one of the
gates §247 explicitly names as "must be fresh" that this round did not close; the technical verdict in
`FDH16_COMPLETION_REPORT.md` reflects this honestly rather than claiming an unearned PASS.
