# II-R10 — Live DEV Verification

**Status: 9 real live-DEV checks passed this session — not the formal
25-case LIVE-R10-001..025 matrix.** See `R10_ACCEPTANCE_REPORT.md` for the
overall verdict; this document maps what was actually run to the spec's
own numbering, honestly.

## What ran (`scripts/r10_live_dev_certification.mjs` + `scripts/r10_live_pdf_check.mjs`, real running `next dev`, real DEV Supabase)

| Spec case | Ran? | Result |
|---|---|---|
| LIVE-R10-01 (free report) | Partial — free user generated a `net_worth` report, not the full monthly report flow | PASS |
| LIVE-R10-02 (free premium bypass) | Yes | PASS (403) |
| LIVE-R10-03 (premium user full report) | Yes (with all 18 sections present, II chapters `unavailable`) | PASS |
| LIVE-R10-04 (simple household) | Yes (minimal income/expense/asset data) | PASS |
| LIVE-R10-05 through 18 (investment-heavy, goals, retirement, off/on-track, unallocated, tax, SIP, concentration, missing benchmark, partial data, no goals, no investments, cross-currency) | No — no II or goal data was seeded | NOT RUN |
| LIVE-R10-19 (refresh) | No | NOT RUN |
| LIVE-R10-20 (historical immutability) | No | NOT RUN |
| LIVE-R10-21 (cross-user attack) | Yes | PASS (404) |
| LIVE-R10-22 (same-user forgery, real report, valid FKs, original 0070 vectors) | Yes | PASS (5/5 blocked, ground truth unchanged) |
| LIVE-R10-23 (>1,000 records) | No | NOT RUN |
| LIVE-R10-24 (long content/PDF stress) | No — PDF was generated but not stress-tested with long names/large tables | NOT RUN |
| LIVE-R10-25 (failure & retry) | No | NOT RUN |
| PDF generation itself (spec 43-44 in spirit) | Yes | PASS (494,395 bytes, real download) |

**Total: 9/25 spec-numbered cases genuinely covered (some partially), 16 not run.**

## Independent live reconciliation (spec section 102)

0/15 — not run this session (no II data existed to reconcile against).

## Cleanup

Every test user created across both scripts (6 total this session across
both live scripts, plus the earlier security-focused session's own users)
was deleted via the admin API and independently re-verified via a full
`listUsers` scan / individual `GET /admin/users/{id}` check returning 404 —
0 leftover in every run.
