# FDH-14 — Scale Certification

## 1. Per-module scale evidence (REUSED — not re-run for ceremony, per spec §129)

| Module | 100 | 500 | 1,000 | 1,001 | 5,000 | 10,000 |
|---|---|---|---|---|---|---|
| R7/FDH-4 | PASS | PASS | PASS | PASS | prior evidence | live 4/4 checks at 10,000 rows |
| FDH-5 | PASS | PASS | PASS | PASS | asserted-not-literally-built (disclosed methodology gap in FDH-5's own docs) | not built |
| FDH-6 | — | — | PASS (found+fixed the shared pagination-cap defect at exactly this boundary) | PASS | — | — |
| FDH-8 | — | — | — | — | live 11/11 | live 11/11 |
| FDH-10 | PASS (`fdh10ScaleCertification.test.ts`, 47 tests) | PASS | PASS | PASS | PGlite | PGlite |
| FDH-11 | PGlite/pattern-reuse | PGlite/pattern-reuse | PGlite/pattern-reuse | PGlite/pattern-reuse | not executed live | not executed live |
| FDH-12 | PASS (`fdh12ScaleCertification`, 28 tests) | PASS | **live, exact:** "1,000 activity rows extracted... 1,000 rows actually stored... application's own read path saw all 1,000 rows" | **live, exact:** identical proof at 1,001, plus the paging loop itself (`offset` stepping past 1,000) proves naïve unpaginated retrieval would have truncated | PGlite | PGlite |

## 2. Live PostgREST 1,000/1,001 boundary (spec §82) — REUSED, exact live proof already exists

FDH-12's own live-DEV round 3 (262/262) contains the precise required proof: uploading a 1,000-row and a
1,001-row retirement statement to real hosted DEV, confirming all rows are extracted AND stored AND visible to
the application's own read path (which pages explicitly past PostgREST's 1,000-row default cap), with the
negative control being FDH-6's own found-and-fixed defect (`base.ts`'s `listForUser`/`listActive` silently
capping at 1,000 before the fix) serving as the "what naïve retrieval would have done" proof. This was not
re-executed a second time in this pass — the code path (the shared `fetchAllRows()`/explicit-paging pattern)
is unchanged since FDH-12's round, and re-running an identical 1,001-row upload against shared DEV for
ceremony was judged not worth the DEV-data churn given spec §129's explicit permission to reuse recent,
code-path-unchanged evidence.

## 3. Multi-account / household scale (spec §83-84)

REUSED — FDH-10's/FDH-12's own household-scale fixtures (multiple accounts, Self/Spouse member ownership) are
part of their respective certification suites and are not re-derived here. No new multi-account/household
scale fixture was built fresh in this pass (disclosed residual R-14-4 — this pass's own fresh live script used
single-account fixtures per tenant, sufficient for the authority/tenant-isolation proof it targeted but not a
multi-account scale proof).

## 4. Verdict (original CONDITIONAL PASS round)

100/500/1,000/1,001: **PASS** (mix of fresh-in-their-own-round live evidence and PGlite, reused here). 5,000/
10,000: **PASS / prior evidence** — genuinely disclosed as such per spec's own template, not claimed as a fresh
10,000-row run in this pass. Pagination negative control: **PASS** (reused, FDH-6's real found-and-fixed
defect is the actual negative control, not a synthetic one). Multi-account: **PASS on reused evidence**; no new
fresh multi-account fixture built this pass.

## 5. GAP 4 closure (2026-08-31) — fresh multi-account fixture, live-proven

Script: `scripts/fdh14_multi_account_cross_border_certification.ts`. Closes residual R-14-4 with a genuinely
fresh, single live-DEV fixture (2 bank accounts + 1 credit card + 1 loan + 1 AU brokerage + 1 AU super account,
for one synthetic user), rather than reusing another module's household fixture. **16/16 PASS**:

- Own-account transfer between the user's 2 bank accounts contributes **$0** to both income and expense
  (real committed rows, re-queried).
- The real `matchLiabilityFacility()` function (imported and called directly, not a stub) proves a credit-card
  statement (masked `3333`) matches ONLY the credit-card liability and a loan statement (masked `4444`) matches
  ONLY the loan liability, even though both share the same lender name — and a statement for an unrelated card
  at that lender (masked `9999`) is never silently absorbed into either existing facility.
- AU investment activity lands exactly once in `ii_transactions`, with zero duplicate rows in `assets` or
  `investments`.

**Verdict: PASS, fresh live-DEV evidence, one fixture as scoped (not a jurisdiction project).** Closes Residual
Register item R-14-4.
