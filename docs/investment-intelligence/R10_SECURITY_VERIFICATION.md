# II-R10 — Security Verification (Continuation Session)

Cross-reference: `R10_REPORT_SECURITY_MODEL.md` (the original finding/fix)
and `R10_ACCEPTANCE_REPORT.md` (overall verdict). This document is the
"what was actually re-verified this continuation session" record.

## 0070 status — confirmed independently, three separate ways

1. **Coordinator's own re-verification** (reported, not independently
   re-derived by me beyond what follows): migration applied live to DEV,
   5/5 original attacks blocked, ground truth unchanged.
2. **My own live-DEV re-run** (`scripts/r10_repro_reports_forgery.mjs`,
   corrected to seed via service-role matching the real post-fix app code):
   11/11 checks matched expected — sanity read, 5 attacks blocked, 5
   ground-truth checks confirming nothing actually changed. Disposable test
   user created and deleted; independently re-verified 0 leftover.
3. **PGlite certification** (`scripts/r10_reports_rls_certification.mjs`,
   fresh 70/70 replay): 15/15 PASS, including the negative control.

## Full-stack re-run through the real reporting implementation (spec section 104)

`scripts/r10_live_dev_certification.mjs` LIVE-R10-C/E: generated a REAL
report through the REAL `/api/reports/generate` route (not a hand-seeded
row), then re-ran all 5 original attacks against that real report's real
id/section id, plus a live cross-user isolation check (LIVE-R10-D) and a
live entitlement-bypass check (LIVE-R10-B2) — all through the real running
app, real DEV. All passed. This is the "did the reporting implementation
(chapter builders, ReportPreview additions) accidentally reopen the gap"
proof the spec's own section 104 asks for.

## Entitlement forgery (spec section 42, 163)

LIVE-R10-B1/B2: a free user's real generated report contained zero
premium-only sections (not just the II ones), and a free user's direct
`POST /exports {format:'pdf'}` attempt returned 403. No client-supplied
premium flag exists anywhere in the request surface for a client to forge.

## What was NOT re-verified this continuation session

- Storage-object-level cross-user access (spec section 106/162) — not
  live-attack-tested this session (unchanged code from the prior session,
  where it was also not independently attacked; the `report-exports`
  bucket policy from migration `0022` was read-reviewed only).
- A live report-status forgery attempt using PATCH with values OTHER than
  the 5 original attack vectors (e.g. attempting `financial_snapshot_id`
  pointing at a DIFFERENT real user's snapshot as a valid-FK variant) —
  not attempted this session.
- A "premium user's entitlement expires mid-session" live test — not run.
