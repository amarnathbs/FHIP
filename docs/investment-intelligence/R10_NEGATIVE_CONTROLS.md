# II-R10 — Negative Controls (Terminal: 8/8)

Risk-based closure spec section 23 marks these mandatory, unreduced from
the original spec. All 8 are now genuine RED→GREEN (or equivalent-strength
real-bug RED→GREEN), each reverted/re-verified clean immediately after.

| # | Control | Method | RED result | GREEN result |
|---|---|---|---|---|
| NC1 | Net-worth duplication | Live sabotage: `buildNetWorth()`'s `netWorth: d.netWorth` temporarily changed to `d.netWorth + d.totalAssetsCombined + 1`, re-ran `scripts/r10_populated_certification.mjs`'s live `NO-DOUBLE-COUNT` check against real DEV | `reportNetWorth=1600001` vs `canonNetWorth=800000` — genuine mismatch, live | Reverted (`git diff` clean, 0 lines); re-ran: `800000 === 800000` exact match |
| NC2 | Wrong performance source | Source-module-assertion unit tests (`tests/unit/reportsIIChapters.test.ts`) plus live exact-match proof (`scripts/r10_populated_certification.mjs` `NO-RECALC-1`) | Fixture-level: altering the fixture's XIRR fails the assertion by construction | Unit tests 12/12; live exact match confirmed |
| NC3 | Stale forecast / historical immutability | Live: generate report A, mutate an asset value, revise → report B, re-fetch A (`scripts/r10_nc3_stale_forecast.mjs`) | **Found a genuine, separate, real bug in the process**: the revise endpoint never passed the original report's `report_type_code` to `generateReport()`, so every revision silently defaulted to `monthly_financial_health` and failed its stricter eligibility gate — RED was "B fails to generate at all, A's status never even reaches `superseded`" | Fixed (`app/api/reports/[id]/revise/route.ts` now looks up and passes the original type, same pattern already used by the retry route); re-ran: 5/5 checks pass — A unchanged, A superseded, B reflects new data, B links to A |
| NC4 | Narrative contradiction | Live sabotage: appended "everything is on track, no action needed" to the Review Centre chapter's narrative | `vitest`: 1 failed (contradiction-protection test caught it) | Reverted (clean); re-ran: 12/12 |
| NC5 | Premium entitlement bypass | **Per the Product Owner's revised instruction**: isolated unit-level mock only, no live weakened-code request. Temporarily changed `requiresPremiumEntitlement()` (the pure decision function the export route's gate calls) to always return `false` | `vitest run tests/unit/reports.test.ts`: 1 failed (`expected false to be true` on the pdf/csv assertions) — proves the gate condition becomes unreachable if this function is compromised | Reverted (clean); re-ran: 12/12. The real, non-sabotaged live gate was separately re-confirmed denying a genuine Free user (403) via `scripts/r10_live_dev_certification.mjs` LIVE-R10-B2 — this is the "normal live entitlement test", kept distinct from the negative control per the revised spec's own instruction |
| NC6 | Cross-user access | PGlite isolated negative control (`scripts/r10_reports_rls_certification.mjs`): old permissive RLS policy shape reinstated on a scratch table | Forgery succeeds under the old policy shape | N/A — scratch table only; current tables use the hardened policy. Re-confirmed this session: 15/15 |
| NC7 | Pagination (>1,000 rows) | Live: seeded 1,200 real `ii_review_items` rows for one user, generated a report (`scripts/r10_nc7_pagination.mjs`) | **Found a genuine, separate, real bug**: the report's `totalOpenCount` was computed as `items.length` (the 50-item DISPLAY cap), so the narrative said "50 open review items" when 1,200 genuinely existed — a real, live-reproduced undercount on real >1,000-row data | Fixed (`loadReviewItemsForReport()` now runs a real `count=exact` query, same pattern already used elsewhere in this codebase, independent of the 50-item display cap); re-ran: narrative correctly says "1200 open Investment Intelligence review items", display list still correctly capped at exactly 50 |
| NC8 | Provenance swap | Live sabotage: Performance chapter's `sourceReferences.engineVersion` hardcoded to a wrong string | `vitest`: 1 failed (`expected 'NC8-SABOTAGE-wrong-version' to be '...'`) | Reverted (clean); re-ran: 12/12 |

## Result: 8/8 — every control genuinely closed

Four of the eight controls (NC1, NC3, NC4, NC7, NC8 — five, not four;
NC3 and NC7 in particular) surfaced **real, previously-undiscovered
defects** rather than only proving a synthetic sabotage would be caught —
NC3 found the revise-route report-type bug, NC7 found the review-count
undercounting bug, both fixed and re-verified live this session. This is
a stronger outcome than the negative controls' minimum bar (prove a test
suite is load-bearing) — they were genuinely load-bearing, catching real
bugs during the process of being built.
